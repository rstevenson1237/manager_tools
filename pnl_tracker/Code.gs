/*******************************************************************************
 * Code.gs — P&L Tracker web app (backend)
 *
 * ARCHITECTURE
 *   A STANDALONE Apps Script project, like inventory_audit and payroll_audit,
 *   served through HtmlService so it can be embedded in Google Sites. Unlike
 *   those two apps there is ONE data workbook for the whole portfolio, because
 *   one manager looks at every property side by side and a single R365 export
 *   covers all of them. Its ID is kept in Script Properties (run setup() once).
 *
 *   Files:
 *     Parse.gs     reads R365 P&L CSV exports (monthly side-by-side, trailing 12)
 *     Budget.gs    reads the annual budget workbook (Google Sheet or .xlsx)
 *     Store.gs     sheet layouts; parsed upload ⇄ sheet rows ⇄ in-memory store
 *     Analysis.gs  period report, flags, portfolio, trends
 *     Import.gs    upload endpoints (preview, then save)
 *     Code.gs      this file: setup, access, settings, read endpoints
 *   Parse/Budget/Store/Analysis use no Apps Script services, so tests/ runs
 *   them in Node against sample exports.
 *
 * ACCESS
 *   Global admins (Script Properties, same list mechanism as the sibling
 *   apps) can upload, tag, write notes and change settings. Viewers (listed
 *   in the data workbook's _Config sheet) can see everything read-only.
 ******************************************************************************/

const DATA_SS_KEY = 'PNL_DATA_SPREADSHEET_ID';
const GLOBAL_ADMIN_KEY = 'GLOBAL_ADMIN_EMAILS';
const DEFAULT_GLOBAL_ADMINS = ['robert.stevenson@atlasrestaurantgroup.com'];

/** Columns kept as plain text so Sheets never turns '2026-10' or '7312.1' into a date or number. */
const TEXT_COLUMNS = { actuals: [1, 2, 3, 10], detail: [1, 2, 3, 4], budget: [2, 4], tags: [1, 2, 3], uploads: [1] };

const CONFIG_SHEET_NAME = '_Config';
const CONFIG_ROWS = [
  { key: 'viewers', label: 'Viewers', type: 'list' },
  { key: 'properties', label: 'Properties', type: 'json' },
  { key: 'rules', label: 'Flag Rules', type: 'json' }
];

/** ------------------------------------------------------------ WEB APP ENTRY */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('P&L Tracker')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** ------------------------------------------------------------------ SETUP
 * Run once from the Apps Script editor (Run → setup). Creates the data
 * workbook next to this script and remembers its ID. Safe to re-run: if a
 * workbook is already configured it is only checked for missing sheets.
 */
function setup() {
  const existing = scriptProps_().getProperty(DATA_SS_KEY);
  if (existing) {
    const ss = SpreadsheetApp.openById(existing);
    buildDataWorkbook_(ss);
    Logger.log('Already set up: ' + ss.getUrl());
    return { spreadsheetId: existing, url: ss.getUrl() };
  }
  const ss = SpreadsheetApp.create('P&L Tracker Data');
  try {
    const parents = DriveApp.getFileById(ScriptApp.getScriptId()).getParents();
    if (parents.hasNext()) DriveApp.getFileById(ss.getId()).moveTo(parents.next());
  } catch (e) { /* the script may not live in a folder; leave the workbook in My Drive */ }
  buildDataWorkbook_(ss);
  scriptProps_().setProperty(DATA_SS_KEY, ss.getId());
  Logger.log('Created data workbook: ' + ss.getUrl());
  return { spreadsheetId: ss.getId(), url: ss.getUrl() };
}

/** Use an existing workbook as the data store (Run → useExistingWorkbook after editing the ID). */
function useExistingWorkbook(spreadsheetId) {
  spreadsheetId = String(spreadsheetId || '').trim();
  if (!spreadsheetId) throw new Error('useExistingWorkbook: spreadsheetId is required.');
  const ss = SpreadsheetApp.openById(spreadsheetId);
  buildDataWorkbook_(ss);
  scriptProps_().setProperty(DATA_SS_KEY, spreadsheetId);
  Logger.log('Using data workbook: ' + ss.getUrl());
  return { spreadsheetId: spreadsheetId, url: ss.getUrl() };
}

function buildDataWorkbook_(ss) {
  Object.keys(SHEETS).forEach(function (k) { ensureDataSheet_(ss, k); });
  ensureConfigSheet_(ss);
  const stray = ss.getSheetByName('Sheet1');
  if (stray && ss.getSheets().length > 1) ss.deleteSheet(stray);
}

/** ---------------------------------------------------------- GLOBAL STORE */
function scriptProps_() { return PropertiesService.getScriptProperties(); }

function loadGlobalAdmins_() {
  let raw = null;
  try { raw = scriptProps_().getProperty(GLOBAL_ADMIN_KEY); } catch (e) { raw = null; }
  if (!raw) return DEFAULT_GLOBAL_ADMINS.slice();
  try {
    const parsed = JSON.parse(raw);
    return (Array.isArray(parsed) && parsed.length) ? parsed.map(String) : DEFAULT_GLOBAL_ADMINS.slice();
  } catch (e) {
    return DEFAULT_GLOBAL_ADMINS.slice();
  }
}

function dataSpreadsheet_() {
  const id = scriptProps_().getProperty(DATA_SS_KEY);
  if (!id) throw new Error('The P&L Tracker has not been set up yet. In the Apps Script editor, run setup() once.');
  return SpreadsheetApp.openById(id);
}

/** ------------------------------------------------------------ DATA SHEETS */
function ensureDataSheet_(ss, key) {
  const def = SHEETS[key];
  let sheet = ss.getSheetByName(def.name);
  if (!sheet) {
    sheet = ss.insertSheet(def.name);
    sheet.getRange(1, 1, 1, def.headers.length).setValues([def.headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  (TEXT_COLUMNS[key] || []).forEach(function (c) {
    sheet.getRange(1, c, sheet.getMaxRows(), 1).setNumberFormat('@');
  });
  return sheet;
}

function readDataRows_(ss, key) {
  const def = SHEETS[key];
  const sheet = ss.getSheetByName(def.name);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, def.headers.length).getValues()
    .filter(function (r) { return r.some(function (v) { return v !== '' && v != null; }); });
}

/** Replace every data row of a sheet (header kept). */
function writeDataRows_(ss, key, rows) {
  const def = SHEETS[key];
  const sheet = ensureDataSheet_(ss, key);
  const last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, def.headers.length).clearContent();
  if (!rows.length) return;
  if (sheet.getMaxRows() < rows.length + 1) sheet.insertRowsAfter(sheet.getMaxRows(), rows.length + 1 - sheet.getMaxRows());
  (TEXT_COLUMNS[key] || []).forEach(function (c) {
    sheet.getRange(1, c, sheet.getMaxRows(), 1).setNumberFormat('@');
  });
  sheet.getRange(2, 1, rows.length, def.headers.length).setValues(rows.map(function (r) {
    return r.map(function (v) { return v == null ? '' : v; });
  }));
}

function appendDataRow_(ss, key, row) {
  const sheet = ensureDataSheet_(ss, key);
  sheet.appendRow(row);
}

/** --------------------------------------------------------------- _CONFIG */
function defaultConfig_() {
  return { viewers: [], properties: [], rules: JSON.parse(JSON.stringify(DEFAULT_RULES)) };
}

function ensureConfigSheet_(ss) {
  let sheet = ss.getSheetByName(CONFIG_SHEET_NAME);
  if (sheet) return sheet;
  sheet = ss.insertSheet(CONFIG_SHEET_NAME);
  sheet.getRange(1, 1, 1, 2).setValues([['Setting', 'Value']]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  const d = defaultConfig_();
  sheet.getRange(2, 1, CONFIG_ROWS.length, 2).setValues(CONFIG_ROWS.map(function (r) {
    return [r.label, serializeConfig_(r, d[r.key])];
  }));
  sheet.hideSheet();
  return sheet;
}

function serializeConfig_(rowDef, value) {
  if (rowDef.type === 'list') return (value || []).join(', ');
  return JSON.stringify(value == null ? null : value);
}

function readConfig_(ss) {
  const sheet = ensureConfigSheet_(ss);
  const vals = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), 2).getValues();
  const byLabel = {};
  vals.forEach(function (r) { if (String(r[0]).trim()) byLabel[String(r[0]).trim()] = r[1]; });
  const d = defaultConfig_();
  const out = {};
  CONFIG_ROWS.forEach(function (r) {
    const raw = byLabel[r.label];
    if (r.type === 'list') {
      out[r.key] = raw == null || String(raw).trim() === '' ? d[r.key]
        : String(raw).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    } else {
      try { out[r.key] = raw == null || raw === '' ? d[r.key] : (JSON.parse(raw) || d[r.key]); }
      catch (e) { out[r.key] = d[r.key]; }
    }
  });
  out.rules = Object.assign({}, DEFAULT_RULES, out.rules || {});
  return out;
}

function writeConfig_(ss, config) {
  const sheet = ensureConfigSheet_(ss);
  sheet.getRange(2, 1, CONFIG_ROWS.length, 2).setValues(CONFIG_ROWS.map(function (r) {
    return [r.label, serializeConfig_(r, config[r.key])];
  }));
}

/** ------------------------------------------------------------ ACCESS */
function currentUserEmail_() {
  try { return Session.getActiveUser().getEmail() || ''; } catch (e) { return ''; }
}
function isGlobalAdmin_() {
  const email = currentUserEmail_().toLowerCase();
  if (!email) return false;
  return loadGlobalAdmins_().map(function (e) { return String(e).toLowerCase(); }).indexOf(email) !== -1;
}
/** 'admin' | 'viewer' | null */
function roleOf_(ss) {
  if (isGlobalAdmin_()) return 'admin';
  const email = currentUserEmail_().toLowerCase();
  if (!email) return null;
  const viewers = readConfig_(ss).viewers.map(function (e) { return String(e).toLowerCase(); });
  return viewers.indexOf(email) !== -1 ? 'viewer' : null;
}
function requireViewer_(ss) {
  const role = roleOf_(ss);
  if (!role) {
    const who = currentUserEmail_();
    throw new Error(who ? 'You do not have access to the P&L Tracker. You are signed in as ' + who + '.'
      : 'Access denied — your account could not be identified.');
  }
  return role;
}
function requireAdmin_(ss) {
  if (requireViewer_(ss) !== 'admin') {
    throw new Error('Only an administrator can do this. You are signed in as ' + currentUserEmail_() + '.');
  }
}

/** ---------------------------------------------------------- STORE LOADING */
function loadStore_(ss, options) {
  options = options || {};
  const config = readConfig_(ss);
  return rowsToStore_({
    actuals: readDataRows_(ss, 'actuals'),
    detail: options.skipDetail ? [] : readDataRows_(ss, 'detail'),
    budget: readDataRows_(ss, 'budget'),
    tags: readDataRows_(ss, 'tags')
  }, JSON.parse(JSON.stringify(config.properties || [])), config.rules);
}

/** google.script.run cannot carry Dates, NaN or Infinity; send plain JSON. */
function safe_(obj) {
  return JSON.parse(JSON.stringify(obj, function (k, v) {
    if (typeof v === 'number' && !isFinite(v)) return null;
    return v;
  }));
}

/** ------------------------------------------------------- READ ENDPOINTS */

/** Who is signed in, what is on file, and the newest month to open on. */
function getBootstrap() {
  const email = currentUserEmail_();
  let ss;
  try { ss = dataSpreadsheet_(); }
  catch (e) { return safe_({ email: email, configured: false, role: isGlobalAdmin_() ? 'admin' : null, error: e.message }); }
  const role = roleOf_(ss);
  if (!role) return safe_({ email: email, configured: true, role: null });
  const config = readConfig_(ss);
  const store = loadStore_(ss, { skipDetail: true });

  const months = {};
  let latest = null;
  Object.keys(store.actuals).forEach(function (code) {
    months[code] = Object.keys(store.actuals[code]).sort().map(function (p) {
      if (!latest || p > latest) latest = p;
      return { period: p, stage: store.actuals[code][p].stage, asOf: store.actuals[code][p].asOf };
    });
  });
  const budgets = [];
  Object.keys(store.budgets).forEach(function (code) {
    Object.keys(store.budgets[code]).forEach(function (y) { budgets.push({ property: code, year: Number(y) }); });
  });
  return safe_({
    email: email, configured: true, role: role, isAdmin: role === 'admin',
    properties: store.properties, months: months, latestPeriod: latest, budgets: budgets,
    rules: config.rules, spreadsheetUrl: role === 'admin' ? ss.getUrl() : null
  });
}

/** All properties for one month. */
function getPortfolio(period) {
  const ss = dataSpreadsheet_();
  requireViewer_(ss);
  return safe_(buildPortfolio_(loadStore_(ss), String(period)));
}

/** The period report for one property and month. */
function getPeriodReport(property, period) {
  const ss = dataSpreadsheet_();
  requireViewer_(ss);
  return safe_(buildPeriodReport_(loadStore_(ss), String(property), String(period)));
}

/** Monthly series for a property (or 'ALL') and several lines or ratios. */
function getTrends(property, keys, endPeriod, months) {
  const ss = dataSpreadsheet_();
  requireViewer_(ss);
  const store = loadStore_(ss, { skipDetail: true });
  const list = Array.isArray(keys) ? keys : [keys];
  return safe_(list.map(function (k) { return buildTrend_(store, String(property), String(k), String(endPeriod), Number(months) || 24); }));
}

/** ------------------------------------------------------ ADMIN WRITES */

/** Save the manager's note for a property-month (empty text removes it). */
function saveNote(property, period, text) {
  const ss = dataSpreadsheet_();
  requireAdmin_(ss);
  return upsertTag_(ss, String(period), String(property), NOTE_KEY, '', String(text || ''));
}

/** Tag (or untag) a line in a month as timing / accrual, with an optional note. */
function saveTag(property, period, key, isTiming, note) {
  const ss = dataSpreadsheet_();
  requireAdmin_(ss);
  return upsertTag_(ss, String(period), String(property), String(key), isTiming ? 'timing' : '', String(note || ''));
}

function upsertTag_(ss, period, property, key, tag, note) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const rows = readDataRows_(ss, 'tags').filter(function (r) {
      return !(periodText_(r[0]) === period && String(r[1]) === property && String(r[2]) === key);
    });
    if (tag || note) rows.push([period, property, key, tag, note, currentUserEmail_(), new Date().toISOString()]);
    writeDataRows_(ss, 'tags', rows);
    return { saved: true };
  } finally {
    lock.releaseLock();
  }
}

/** Delete one property-month from Actuals and Detail. */
function removeMonth(property, period) {
  const ss = dataSpreadsheet_();
  requireAdmin_(ss);
  const months = [{ property: String(property), period: String(period) }];
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    writeDataRows_(ss, 'actuals', withoutMonths_(readDataRows_(ss, 'actuals'), months));
    writeDataRows_(ss, 'detail', withoutMonths_(readDataRows_(ss, 'detail'), months));
    return { removed: true };
  } finally {
    lock.releaseLock();
  }
}

/** Delete one property's budget for a year. */
function removeBudget(property, year) {
  const ss = dataSpreadsheet_();
  requireAdmin_(ss);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    writeDataRows_(ss, 'budget', readDataRows_(ss, 'budget').filter(function (r) {
      return !(Number(r[0]) === Number(year) && String(r[1]) === String(property));
    }));
    return { removed: true };
  } finally {
    lock.releaseLock();
  }
}

/** ------------------------------------------------------------- SETTINGS */
function getSettings() {
  const ss = dataSpreadsheet_();
  requireAdmin_(ss);
  const config = readConfig_(ss);
  const store = loadStore_(ss, { skipDetail: true });
  config.properties = store.properties; // includes properties seen only in data
  return safe_(config);
}

/** Replace viewers, property names/active flags, and the flag rule numbers. */
function saveSettings(payload) {
  const ss = dataSpreadsheet_();
  requireAdmin_(ss);
  if (!payload || typeof payload !== 'object') throw new Error('saveSettings: invalid payload.');
  const config = readConfig_(ss);
  if (Array.isArray(payload.viewers)) {
    config.viewers = payload.viewers.map(function (e) { return String(e).trim(); }).filter(Boolean);
  }
  if (Array.isArray(payload.properties)) {
    config.properties = payload.properties.map(function (p) {
      return { code: String(p.code).trim(), name: String(p.name || p.code).trim(), active: p.active !== false };
    }).filter(function (p) { return p.code; });
  }
  if (payload.rules && typeof payload.rules === 'object') {
    const r = payload.rules;
    const num = function (v, min, max, dflt) { const n = Number(v); return isFinite(n) && n >= min && n <= max ? n : dflt; };
    config.rules = Object.assign({}, config.rules, {
      minDollar: num(r.minDollar, 0, 1e7, config.rules.minDollar),
      minPct: num(r.minPct, 0, 10, config.rules.minPct),
      driverMin: num(r.driverMin, 0, 1e7, config.rules.driverMin),
      mtdPctPoints: num(r.mtdPctPoints, 0, 100, config.rules.mtdPctPoints),
      settleDays: Math.round(num(r.settleDays, 0, 60, config.rules.settleDays))
    });
  }
  writeConfig_(ss, config);
  return getSettings();
}

/** Registers properties found in an upload that are not configured yet. */
function registerProperties_(ss, found) {
  const config = readConfig_(ss);
  const known = {};
  config.properties.forEach(function (p) { known[p.code] = p; });
  let changed = false;
  found.forEach(function (f) {
    if (!known[f.code]) { config.properties.push({ code: f.code, name: f.name, active: true }); known[f.code] = true; changed = true; }
  });
  if (changed) {
    config.properties.sort(function (a, b) { return a.name.localeCompare(b.name); });
    writeConfig_(ss, config);
  }
}

function getGlobalAdmins() {
  if (!isGlobalAdmin_()) throw new Error('Only a global administrator can see this list.');
  return loadGlobalAdmins_();
}

function saveGlobalAdmins(emails) {
  if (!isGlobalAdmin_()) throw new Error('Only a global administrator can change this list.');
  const list = Array.isArray(emails) ? emails.map(function (e) { return String(e).trim(); }).filter(Boolean) : [];
  if (!list.length) throw new Error('At least one global admin is required.');
  scriptProps_().setProperty(GLOBAL_ADMIN_KEY, JSON.stringify(list));
  return list;
}
