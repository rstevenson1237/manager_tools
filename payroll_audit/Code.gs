/*******************************************************************************
 * Code.gs — Payroll Audit Web App (backend)
 *
 * ARCHITECTURE
 *   This is a STANDALONE script (not bound to any single Sheet), modeled
 *   directly on the sibling `inventory_audit` app in this repo. One workbook
 *   = one property. A central registry (Script Properties, on this project)
 *   lists every property and where its workbook lives; the script opens each
 *   property's workbook by ID on demand.
 *
 *   Each property workbook is a pure DATA STORE with three raw import sheets
 *   — PDP, Toast, Payments — one row per uploaded CSV line, plus a hidden
 *   `_Config` sheet holding that property's admins, users, company code, and
 *   the manual-entry figures (PDP daily totals, sales summary, pooled
 *   withholding config) as plain, human-readable/JSON rows. There are NO
 *   "Hours"/"Audit" tabs and NO spreadsheet formulas driving the app — every
 *   reconciliation the legacy spreadsheet computed with SUMIFS/QUERY/VLOOKUP
 *   formulas is re-implemented here in code (see the COMPUTE section) and
 *   surfaced through the web app. Managers never touch the sheet.
 *
 *   The compute functions below were validated against the legacy
 *   `Maximon_Payroll_Audit.xlsx` sample data (Node harness, not part of this
 *   deploy) and reproduce its cached totals exactly, including the exact same
 *   5 unmatched employees the legacy sheet flagged for that pay period.
 *
 * ACCESS MODEL (three tiers) — identical to inventory_audit
 *   1. Global admin  — Script Properties list on this project. Admin on every
 *      property, always. Managed via getGlobalAdmins/saveGlobalAdmins.
 *   2. Property admin — per property, stored in that property's `_Config`
 *      sheet. Can upload/replace/remove data, edit manual-entry figures, and
 *      edit settings for that one property only.
 *   3. Property user  — per property, also in `_Config`. View-only access to
 *      that one property.
 ******************************************************************************/

/** ------------------------------------------------------------------ CONFIG */
// The three raw CSV import stores and their column order (also used by
// Import.gs to validate + write uploads). Order matches the source exports.
const CONFIG = {
  DATASTORES: [
    { key: 'pdp',      label: 'PDP',      sheet: 'PDP',
      headers: ['Co Code', 'Employee', 'Hours', 'Amount'] },
    { key: 'toast',    label: 'Toast',    sheet: 'Toast',
      headers: ['Employee', 'Job Title', 'Regular Hours', 'Overtime Hours'] },
    { key: 'payments', label: 'Payments', sheet: 'Payments',
      headers: ['Order Date', 'Server', 'Tip', 'Gratuity', 'Status', 'Type'] }
  ],
  PAY_PERIOD_DAYS: 14,
  POOL_COUNT: 3 // number of independent pooled-withholding calculators
};

const HEADER_ROW = 1;
const FIRST_DATA_ROW = 2;

/** --------------------------------------------------------- GLOBAL STORE
 * Identical model to inventory_audit: the global admin list and property
 * registry live in this standalone project's Script Properties.
 */
const GLOBAL_ADMIN_KEY = 'GLOBAL_ADMIN_EMAILS';
const DEFAULT_GLOBAL_ADMINS = ['robert.stevenson@atlasrestaurantgroup.com'];
const REGISTRY_KEY = 'PROPERTY_REGISTRY_V1';

function scriptProps_() {
  return PropertiesService.getScriptProperties();
}

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

function saveGlobalAdmins_(emails) {
  scriptProps_().setProperty(GLOBAL_ADMIN_KEY, JSON.stringify(emails));
}

function loadRegistry_() {
  let raw = null;
  try { raw = scriptProps_().getProperty(REGISTRY_KEY); } catch (e) { raw = null; }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function saveRegistry_(list) {
  scriptProps_().setProperty(REGISTRY_KEY, JSON.stringify(list));
}

function propertyById_(id) {
  const p = loadRegistry_().filter(function(x){ return x.id === id; })[0];
  if (!p) throw new Error('Unknown property: "' + id + '".');
  return p;
}

function newPropertyId_(name) {
  const base = String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '') || 'property';
  const existing = loadRegistry_().map(function(p){ return p.id; });
  let id = base, i = 2;
  while (existing.indexOf(id) !== -1) { id = base + '-' + i; i++; }
  return id;
}

/** --------------------------------------------------------- PROPERTY CONFIG
 * Per-property admins/users/settings live in a hidden `_Config` sheet inside
 * that property's own workbook, as plain "Setting | Value" rows — same
 * philosophy as inventory_audit. Simple lists are comma-separated; structured
 * values (pooled withholding config, PDP manual totals, sales summary) are
 * JSON in the Value cell, which keeps the sheet hand-fixable in an emergency
 * while still round-tripping cleanly for values a human wouldn't want to
 * hand-edit as a comma list.
 */
const CONFIG_SHEET_NAME = '_Config';
const CONFIG_ROWS = [
  { key: 'propertyAdmins',    label: 'Property Admins',    type: 'list' },
  { key: 'propertyUsers',     label: 'Property Users',     type: 'list' },
  { key: 'companyCode',       label: 'Company Code',       type: 'scalar' },
  { key: 'pooledWithholding', label: 'Pooled Withholding', type: 'json' },
  { key: 'pdpManualTotals',   label: 'PDP Manual Totals',  type: 'json' },
  { key: 'salesSummary',      label: 'Sales Summary',      type: 'json' }
];

function defaultPooledWithholding_() {
  const out = [];
  for (let i = 1; i <= CONFIG.POOL_COUNT; i++) {
    out.push({ label: 'Pool ' + i, poolServers: [], jobClass: '' });
  }
  return out;
}

const DEFAULT_PROPERTY_SETTINGS = {
  propertyAdmins: [],
  propertyUsers: [],
  companyCode: '',
  pooledWithholding: null,   // filled via defaultPooledWithholding_() below
  pdpManualTotals: {},       // { 'YYYY-MM-DD': { addlTips, cashSvc, ccFee, ccSvc, declared } }
  salesSummary: []           // [{ label, value }, ...] up to 10 free-form rows
};
DEFAULT_PROPERTY_SETTINGS.pooledWithholding = defaultPooledWithholding_();

function cloneDefaultPropertySettings_() {
  const d = JSON.parse(JSON.stringify(DEFAULT_PROPERTY_SETTINGS));
  d.pooledWithholding = defaultPooledWithholding_();
  return d;
}

/** Get-or-create the `_Config` sheet, seeded with default rows, hidden. */
function ensureConfigSheet_(ss) {
  let sheet = ss.getSheetByName(CONFIG_SHEET_NAME);
  if (sheet) return sheet;
  sheet = ss.insertSheet(CONFIG_SHEET_NAME);
  sheet.getRange(1, 1, 1, 2).setValues([['Setting', 'Value']]);
  sheet.getRange(1, 1, 1, 2).setFontWeight('bold');
  sheet.setFrozenRows(1);
  const defaults = cloneDefaultPropertySettings_();
  const rows = CONFIG_ROWS.map(function(r){ return [r.label, serializeConfigValue_(r, defaults[r.key])]; });
  sheet.getRange(2, 1, rows.length, 2).setValues(rows);
  sheet.hideSheet();
  return sheet;
}

function serializeConfigValue_(rowDef, value) {
  if (rowDef.type === 'list') return (value || []).join(', ');
  if (rowDef.type === 'json') return JSON.stringify(value == null ? null : value);
  return value == null ? '' : String(value);
}

function parseConfigValue_(rowDef, raw) {
  const defaults = cloneDefaultPropertySettings_();
  if (rowDef.type === 'list') {
    if (raw == null || String(raw).trim() === '') return defaults[rowDef.key].slice();
    return String(raw).split(',').map(function(s){ return s.trim(); }).filter(Boolean);
  }
  if (rowDef.type === 'json') {
    if (raw == null || String(raw).trim() === '') return defaults[rowDef.key];
    try {
      const parsed = JSON.parse(raw);
      return parsed == null ? defaults[rowDef.key] : parsed;
    } catch (e) {
      return defaults[rowDef.key];
    }
  }
  // scalar
  return raw == null ? '' : String(raw);
}

/** Read this property's settings from its `_Config` sheet. */
function readConfigSheet_(ss) {
  const sheet = ensureConfigSheet_(ss);
  const lastRow = sheet.getLastRow();
  const vals = sheet.getRange(2, 1, Math.max(lastRow - 1, 0), 2).getValues();
  const byLabel = {};
  vals.forEach(function(r){
    const label = String(r[0] || '').trim();
    if (label) byLabel[label] = r[1];
  });
  const settings = {};
  CONFIG_ROWS.forEach(function(r){
    settings[r.key] = parseConfigValue_(r, byLabel[r.label]);
  });
  return settings;
}

function writeConfigSheet_(ss, settings) {
  const sheet = ensureConfigSheet_(ss);
  const rows = CONFIG_ROWS.map(function(r){
    return [r.label, serializeConfigValue_(r, settings[r.key])];
  });
  sheet.getRange(2, 1, rows.length, 2).setValues(rows);
}

/** ---------------------------------------------------------- SHEET SHAPING */
function formatHeaderRow_(sheet, headers) {
  if (sheet.getMaxColumns() < headers.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
  }
  sheet.getRange(HEADER_ROW, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(HEADER_ROW, 1, 1, headers.length).setFontWeight('bold');
  sheet.setFrozenRows(1);
}

/**
 * Delete a data-store sheet if present and recreate it pristine with headers.
 * Sequenced so the workbook is never momentarily sheet-less: the replacement
 * is inserted before the old one is removed. Used by Import.gs on each CSV
 * upload — the monthly/period model is a clean slate, not a merge.
 */
function recreateDatastoreSheet_(ss, d) {
  const old = ss.getSheetByName(d.sheet);
  let sheet;
  if (old) {
    sheet = ss.insertSheet(d.sheet + '__tmp');
    ss.deleteSheet(old);
    sheet.setName(d.sheet);
  } else {
    sheet = ss.insertSheet(d.sheet);
  }
  formatHeaderRow_(sheet, d.headers);
  return sheet;
}

/** ---------------------------------------------------------- WEB APP ENTRY */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Payroll Audit')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** ------------------------------------------------------------ ADMIN / AUTH
 * Identical three-tier model to inventory_audit.
 */
function currentUserEmail_() {
  try { return Session.getActiveUser().getEmail() || ''; } catch (e) { return ''; }
}

function isGlobalAdmin_() {
  const email = currentUserEmail_().toLowerCase();
  if (!email) return false;
  return loadGlobalAdmins_().map(function(e){ return String(e).toLowerCase(); }).indexOf(email) !== -1;
}

function getSpreadsheetForProperty_(id) {
  return SpreadsheetApp.openById(propertyById_(id).spreadsheetId);
}

/** This user's role ('admin' | 'user' | null) on a property, per-property
 * lists only — does NOT consider global admin (callers combine both). */
function roleForProperty_(id) {
  const email = currentUserEmail_().toLowerCase();
  if (!email) return null;
  let ss;
  try { ss = getSpreadsheetForProperty_(id); } catch (e) { return null; }
  const settings = readConfigSheet_(ss);
  const admins = settings.propertyAdmins.map(function(e){ return String(e).toLowerCase(); });
  if (admins.indexOf(email) !== -1) return 'admin';
  const users = settings.propertyUsers.map(function(e){ return String(e).toLowerCase(); });
  if (users.indexOf(email) !== -1) return 'user';
  return null;
}

/** This user's effective role on a property, folding in global admin. */
function effectiveRole_(id) {
  return isGlobalAdmin_() ? 'admin' : roleForProperty_(id);
}

/** Throw unless the accessing user has any access to this property. Returns
 * the resolved role ('admin' | 'user') so callers needn't re-check. */
function requireAccess_(id) {
  const role = effectiveRole_(id);
  if (!role) {
    const who = currentUserEmail_();
    throw new Error(who
      ? ('You do not have access to this property. You are signed in as ' + who + '.')
      : ('Access denied — your account could not be identified.'));
  }
  return role;
}

/** Throw unless the accessing user is an admin (global or for this property).
 * Guards every destructive/config/manual-entry call. */
function requireAdmin_(id) {
  const role = requireAccess_(id);
  if (role !== 'admin') {
    const who = currentUserEmail_();
    throw new Error('Administrator access required for this property. You are signed in as ' +
      who + ', which is not an admin for it.');
  }
}

function requireGlobalAdmin_() {
  if (isGlobalAdmin_()) return;
  const who = currentUserEmail_();
  throw new Error(who
    ? ('Global administrator access required. You are signed in as ' + who + '.')
    : ('Global administrator access required, but your account could not be identified.'));
}

/** Client-callable: the properties this user can access, with their role on
 * each, plus whether they're a global admin. Drives the property picker. */
function getBootstrap() {
  const email = currentUserEmail_();
  const globalAdmin = isGlobalAdmin_();
  const registry = loadRegistry_();
  const properties = registry.map(function(p){
    const role = globalAdmin ? 'admin' : roleForProperty_(p.id);
    return role ? { id: p.id, name: p.name, role: role } : null;
  }).filter(Boolean);
  return { email: email, isGlobalAdmin: globalAdmin, properties: properties };
}

/** Admin-only (global). Current global admin list. */
function getGlobalAdmins() {
  requireGlobalAdmin_();
  return loadGlobalAdmins_();
}

/** Admin-only (global). Replace the global admin list wholesale. */
function saveGlobalAdmins(emails) {
  requireGlobalAdmin_();
  const list = Array.isArray(emails)
    ? emails.map(function(e){ return String(e).trim(); }).filter(Boolean) : [];
  if (!list.length) throw new Error('At least one global admin is required.');
  saveGlobalAdmins_(list);
  return list;
}

function datastoreByKey_(key) {
  const d = CONFIG.DATASTORES.filter(function(x){ return x.key === key; })[0];
  if (!d) throw new Error('Unknown datastore: "' + key + '".');
  return d;
}

/** ------------------------------------------------------------ RAW READS
 * The three import sheets are pure data stores this app itself writes (via
 * Import.gs), always with the fixed header order in CONFIG.DATASTORES — so,
 * unlike inventory_audit's user-facing report tabs, columns are read
 * positionally rather than resolved by header label.
 */
function readSheetRows_(ss, datastoreKey) {
  const d = datastoreByKey_(datastoreKey);
  const sheet = ss.getSheetByName(d.sheet);
  if (!sheet || sheet.getLastRow() < FIRST_DATA_ROW) return [];
  const n = sheet.getLastRow() - FIRST_DATA_ROW + 1;
  return sheet.getRange(FIRST_DATA_ROW, 1, n, d.headers.length).getValues()
    .filter(function(r){ return r.some(function(v){ return v !== '' && v != null; }); });
}

function readPdpRows_(ss) {
  return readSheetRows_(ss, 'pdp').map(function(r){
    return { coCode: str_(r[0]), employee: str_(r[1]), hours: num_(r[2]), amount: num_(r[3]) };
  });
}

function readToastRows_(ss) {
  return readSheetRows_(ss, 'toast').map(function(r){
    return { employee: str_(r[0]), jobTitle: str_(r[1]), regularHours: num_(r[2]), overtimeHours: num_(r[3]) };
  });
}

function readPaymentsRows_(ss) {
  return readSheetRows_(ss, 'payments').map(function(r){
    return { orderDate: r[0], server: str_(r[1]), tip: num_(r[2]), gratuity: num_(r[3]),
             status: str_(r[4]), type: str_(r[5]) };
  });
}

function str_(v) { return v == null ? '' : String(v); }
function num_(v) {
  if (v === '' || v == null) return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

/** ============================================================== COMPUTE ==
 * Pure reconciliation/audit logic — no SpreadsheetApp calls in this section.
 * Ported from (and validated against) the legacy `Maximon_Payroll_Audit.xlsx`
 * SUMIFS/QUERY/VLOOKUP formulas. See payroll_audit/README.md for the mapping
 * from each function back to its legacy Audit-sheet row/formula.
 * ========================================================================= */

/** ---------------------------------------------------------- NAME MATCHING
 * The legacy sheet matched PDP and Toast names via a single SUBSTITUTE call
 * (newline->space for PDP, comma-removal for Toast) plus an outer TRIM, which
 * does not collapse internal double-spaces — an occasional source of false
 * "Missing" mismatches when source data had irregular spacing. This port
 * normalizes internal whitespace as well, which only helps equality and can
 * never break a legitimate match.
 */
function standardizePdpName_(name) {
  return String(name == null ? '' : name).replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
}
function standardizeToastName_(name) {
  // "Last, First" -> "Last First"
  return String(name == null ? '' : name).replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
}

/** ------------------------------------------------------------ DATE MATH
 * Business Date buckets a sale into the prior calendar day until 5:00am, so a
 * 1am closing sale reports against the day the shift started, not the
 * calendar day it technically posted on. Matches the legacy
 * `INT(OrderDate - TIME(5,0,0))` formula.
 */
function businessDate_(orderDate) {
  const d = (orderDate instanceof Date) ? orderDate : new Date(orderDate);
  const shifted = new Date(d.getTime() - 5 * 60 * 60 * 1000);
  return new Date(shifted.getFullYear(), shifted.getMonth(), shifted.getDate());
}
function dateKey_(d) {
  return d.getFullYear() + '-' + pad2_(d.getMonth() + 1) + '-' + pad2_(d.getDate());
}
function pad2_(n) { return n < 10 ? '0' + n : String(n); }
function addDays_(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** ------------------------------------------------------------ HOURS VIEW
 * Reconciles PDP payroll hours against Toast labor hours per employee.
 * Mirrors the legacy `Hours` sheet.
 */
function computeHours_(pdpRows, toastRows, companyCode) {
  const pdpByName = {};   // standardized name -> { hours, coCode }
  pdpRows.forEach(function (r) {
    const name = standardizePdpName_(r.employee);
    if (!name) return;
    if (!pdpByName[name]) pdpByName[name] = { hours: 0, coCode: r.coCode || '' };
    pdpByName[name].hours += num_(r.hours);
  });

  const toastByName = {}; // standardized name -> hours
  toastRows.forEach(function (r) {
    const name = standardizeToastName_(r.employee);
    if (!name) return;
    toastByName[name] = (toastByName[name] || 0) + num_(r.regularHours) + num_(r.overtimeHours);
  });

  const names = {};
  Object.keys(pdpByName).forEach(function (n) { names[n] = true; });
  Object.keys(toastByName).forEach(function (n) { names[n] = true; });

  return Object.keys(names).sort().map(function (name) {
    const pdp = pdpByName[name] || { hours: 0, coCode: '' };
    const toastHours = toastByName[name] || 0;
    const pdpHours = pdp.hours;
    let status;
    if (pdpHours === 0) status = 'Missing from PDP';
    else if (toastHours === 0) status = 'Missing from Toast';
    else if (Math.abs(pdpHours - toastHours) > 1) {
      status = 'Hours Mismatch T: ' + toastHours + ' P: ' + pdpHours;
    } else if (companyCode && pdp.coCode && pdp.coCode !== companyCode) {
      status = 'Wrong Company Code (' + pdp.coCode + ')';
    } else {
      status = 'Match';
    }
    return { name: name, pdpHours: pdpHours, toastHours: toastHours, coCode: pdp.coCode, status: status };
  });
}

/** ------------------------------------------------------- UNMATCHED VIEW
 * Feeds the Error Reporting tab's "Unmatched Employees" list — every Hours
 * row that isn't a clean Match.
 */
function computeUnmatched_(hoursRows) {
  return hoursRows.filter(function (r) { return r.status !== 'Match'; })
    .map(function (r) { return { name: r.name, error: r.status }; });
}

/** First business date across all Payments rows -> the pay-period window. */
function payPeriodStart_(paymentRows) {
  let min = null;
  paymentRows.forEach(function (r) {
    const bd = businessDate_(r.orderDate);
    if (min === null || bd.getTime() < min.getTime()) min = bd;
  });
  return min;
}

function payPeriodDays_(start) {
  const days = [];
  for (let i = 0; i < CONFIG.PAY_PERIOD_DAYS; i++) days.push(addDays_(start, i));
  return days;
}

/** ------------------------------------------------------ DAY-BY-DAY AUDIT
 * Returns { start, days:[dateKey...], perDay:[{...}], totals:{...} } — the
 * Day-by-Day Audit view, and (via `totals`) the Totals Audit view. Mirrors
 * the legacy Audit sheet rows 2-12 (Credit/Cash/Other Tips & Grat,
 * Withholding, Voids, Denied, Refunds, Toast Total).
 */
function computeDaily_(paymentRows) {
  const start = payPeriodStart_(paymentRows);
  const days = start ? payPeriodDays_(start) : [];

  const byDay = {};
  paymentRows.forEach(function (r) {
    const key = dateKey_(businessDate_(r.orderDate));
    (byDay[key] = byDay[key] || []).push(r);
  });

  function sumWhere(rows, amountKeys, pred) {
    let total = 0;
    rows.forEach(function (r) {
      if (!pred(r)) return;
      amountKeys.forEach(function (k) { total += num_(r[k]); });
    });
    return total;
  }

  const perDay = days.map(function (day) {
    const key = dateKey_(day);
    const rows = byDay[key] || [];

    const creditTips = sumWhere(rows, ['tip'], function (r) { return r.type === 'Credit'; });
    const creditGrat = sumWhere(rows, ['gratuity'], function (r) { return r.type === 'Credit'; });
    const cashTips = sumWhere(rows, ['tip'], function (r) { return r.type === 'Cash'; });
    const cashGrat = sumWhere(rows, ['gratuity'], function (r) { return r.type === 'Cash'; });
    const otherTips = sumWhere(rows, ['tip'], function (r) { return r.type === 'Other' || r.type === 'House Account'; });
    const otherGrat = sumWhere(rows, ['gratuity'], function (r) { return r.type === 'Other' || r.type === 'House Account'; });
    const voids = sumWhere(rows, ['tip', 'gratuity'], function (r) { return r.status === 'VOIDED' || r.status === 'DENIED'; });
    const denied = sumWhere(rows, ['tip', 'gratuity'], function (r) { return r.status === 'DENIED'; });
    const refunds = sumWhere(rows, ['tip', 'gratuity'], function (r) { return r.status === 'REFUNDED'; });

    const grossTipsGrat = creditTips + creditGrat + cashTips + cashGrat + otherTips + otherGrat;
    const withholding = (grossTipsGrat - voids) * 0.02;
    const toastTotal = grossTipsGrat - (withholding + voids);

    return {
      date: key, creditTips: creditTips, creditGrat: creditGrat,
      cashTips: cashTips, cashGrat: cashGrat, otherTips: otherTips, otherGrat: otherGrat,
      withholding: withholding, voids: voids, denied: denied, refunds: refunds, toastTotal: toastTotal
    };
  });

  const totals = { creditTips: 0, creditGrat: 0, cashTips: 0, cashGrat: 0, otherTips: 0, otherGrat: 0,
    withholding: 0, voids: 0, denied: 0, refunds: 0, toastTotal: 0 };
  perDay.forEach(function (d) {
    Object.keys(totals).forEach(function (k) { totals[k] += d[k]; });
  });

  return { start: start, days: days.map(dateKey_), perDay: perDay, totals: totals };
}

/** ------------------------------------------------------- WITHHOLDING VIEW
 * Per-server 2% withholding: sum (Tip+Gratuity)*0.02 over Type in
 * {Other,Cash}. Mirrors the legacy per-server QUERY table (Audit!E22:F199).
 */
function computePerServerWithholding_(paymentRows) {
  const byServer = {};
  paymentRows.forEach(function (r) {
    if (r.type !== 'Other' && r.type !== 'Cash') return;
    const name = String(r.server || '').trim();
    if (!name) return;
    const amt = (num_(r.tip) + num_(r.gratuity)) * 0.02;
    byServer[name] = (byServer[name] || 0) + amt;
  });
  const rows = Object.keys(byServer).sort().map(function (name) {
    return { server: name, amount: byServer[name] };
  });
  const total = rows.reduce(function (s, r) { return s + r.amount; }, 0);
  return { rows: rows, total: total };
}

/** Pooled withholding: sum of per-server amounts for the pool's server list,
 * divided by the count of unique Toast employees in the pool's job class.
 * Mirrors one of the legacy H/I, K/L, N/O pooled-withholding blocks. */
function computePooled_(perServerRows, toastRows, config) {
  const byServer = {};
  perServerRows.forEach(function (r) { byServer[r.server] = r.amount; });

  const poolServers = (config.poolServers || []).map(function (s) { return String(s).trim(); }).filter(Boolean);
  const poolTotal = poolServers.reduce(function (s, name) { return s + (byServer[name] || 0); }, 0);

  const jobClass = String(config.jobClass || '').trim();
  const employees = {};
  toastRows.forEach(function (r) {
    if (String(r.jobTitle || '').trim() === jobClass) {
      employees[standardizeToastName_(r.employee)] = true;
    }
  });
  const employeeCount = Object.keys(employees).length;
  const perEmployee = employeeCount > 0 ? poolTotal / employeeCount : null;

  return { label: config.label || '', poolServers: poolServers, jobClass: jobClass, poolTotal: poolTotal,
    employeeCount: employeeCount, perEmployee: perEmployee };
}

/** PDP-Total for a manual-entry day = Addl Tips + Cash SVC + CC SVC (CC Fee
 * and Declared are informational only, matching legacy Audit!row19). */
function pdpManualTotal_(entry) {
  if (!entry) return 0;
  return num_(entry.addlTips) + num_(entry.cashSvc) + num_(entry.ccSvc);
}

/** ============================================================ WEB APP API
 * Client-callable entry points. Everything the four views need comes back in
 * one round trip from getPayrollData; manual-entry saves are small explicit
 * calls (no batch sync queue — unlike inventory_audit's per-row notes, these
 * are a handful of admin-edited figures per property).
 * ========================================================================= */

/**
 * Returns everything the four views need for one property in a single call:
 * Hours reconciliation, day-by-day + totals audit, per-server + pooled
 * withholding, unmatched employees, and the current settings/manual entries.
 */
function getPayrollData(propertyId) {
  if (!propertyId) throw new Error('getPayrollData: missing propertyId.');
  const role = requireAccess_(propertyId);
  const ss = getSpreadsheetForProperty_(propertyId);
  const settings = readConfigSheet_(ss);

  const pdpRows = readPdpRows_(ss);
  const toastRows = readToastRows_(ss);
  const paymentRows = readPaymentsRows_(ss);

  const hours = computeHours_(pdpRows, toastRows, settings.companyCode);
  const unmatched = computeUnmatched_(hours);
  const daily = computeDaily_(paymentRows);
  const perServer = computePerServerWithholding_(paymentRows);
  const pooled = (settings.pooledWithholding || []).map(function (cfg) {
    return computePooled_(perServer.rows, toastRows, cfg);
  });

  const pdpManualTotals = settings.pdpManualTotals || {};
  const pdpManualByDay = daily.days.map(function (dateStr) {
    const entry = pdpManualTotals[dateStr] || {};
    return { date: dateStr, addlTips: num_(entry.addlTips), cashSvc: num_(entry.cashSvc),
      ccFee: num_(entry.ccFee), ccSvc: num_(entry.ccSvc), declared: num_(entry.declared),
      total: pdpManualTotal_(entry) };
  });
  const pdpManualTotal = pdpManualByDay.reduce(function (s, d) { return s + d.total; }, 0);

  return {
    generatedAt: new Date().toISOString(),
    session: { email: currentUserEmail_(), isAdmin: role === 'admin' },
    settings: {
      companyCode: settings.companyCode,
      propertyAdmins: settings.propertyAdmins,
      propertyUsers: settings.propertyUsers,
      pooledWithholding: settings.pooledWithholding,
      salesSummary: settings.salesSummary
    },
    hours: hours,
    unmatched: unmatched,
    daily: daily,
    withholding: { perServer: perServer, pooled: pooled },
    pdpManual: { byDay: pdpManualByDay, total: pdpManualTotal }
  };
}

/** --------------------------------------------------------------- SETTINGS */
/** Admin-only (this property). Current settings for the Settings panel. */
function getSettings(propertyId) {
  requireAdmin_(propertyId);
  const ss = getSpreadsheetForProperty_(propertyId);
  return readConfigSheet_(ss);
}

/** Admin-only (this property). Property admins/users lists. */
function saveSettings(propertyId, payload) {
  requireAdmin_(propertyId);
  if (!payload || typeof payload !== 'object') throw new Error('saveSettings: invalid payload.');
  const ss = getSpreadsheetForProperty_(propertyId);
  const settings = readConfigSheet_(ss);
  settings.propertyAdmins = Array.isArray(payload.propertyAdmins)
    ? payload.propertyAdmins.map(function(e){ return String(e).trim(); }).filter(Boolean) : settings.propertyAdmins;
  settings.propertyUsers = Array.isArray(payload.propertyUsers)
    ? payload.propertyUsers.map(function(e){ return String(e).trim(); }).filter(Boolean) : settings.propertyUsers;
  writeConfigSheet_(ss, settings);
  return readConfigSheet_(ss);
}

/** Admin-only (this property). The Company Code the Hours view checks each
 * PDP row's Co Code against ("Wrong Company Code" status). */
function saveCompanyCode(propertyId, code) {
  requireAdmin_(propertyId);
  const ss = getSpreadsheetForProperty_(propertyId);
  const settings = readConfigSheet_(ss);
  settings.companyCode = String(code || '').trim();
  writeConfigSheet_(ss, settings);
  return settings.companyCode;
}

/** Admin-only (this property). Replace the 3 pooled-withholding configs. */
function savePooledConfig(propertyId, pooledArray) {
  requireAdmin_(propertyId);
  if (!Array.isArray(pooledArray) || pooledArray.length !== CONFIG.POOL_COUNT) {
    throw new Error('savePooledConfig: expected an array of ' + CONFIG.POOL_COUNT + ' pool configs.');
  }
  const clean = pooledArray.map(function (cfg, i) {
    return {
      label: String((cfg && cfg.label) || ('Pool ' + (i + 1))).trim(),
      poolServers: Array.isArray(cfg && cfg.poolServers)
        ? cfg.poolServers.map(function(s){ return String(s).trim(); }).filter(Boolean) : [],
      jobClass: String((cfg && cfg.jobClass) || '').trim()
    };
  });
  const ss = getSpreadsheetForProperty_(propertyId);
  const settings = readConfigSheet_(ss);
  settings.pooledWithholding = clean;
  writeConfigSheet_(ss, settings);
  return clean;
}

/** Admin-only (this property). Replace the PDP daily manual-entry totals.
 * @param {Object} totalsByDate { 'YYYY-MM-DD': {addlTips,cashSvc,ccFee,ccSvc,declared} } */
function savePdpManualTotals(propertyId, totalsByDate) {
  requireAdmin_(propertyId);
  if (!totalsByDate || typeof totalsByDate !== 'object') throw new Error('savePdpManualTotals: invalid payload.');
  const clean = {};
  Object.keys(totalsByDate).forEach(function (dateStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return; // ignore malformed keys
    const e = totalsByDate[dateStr] || {};
    clean[dateStr] = {
      addlTips: num_(e.addlTips), cashSvc: num_(e.cashSvc), ccFee: num_(e.ccFee),
      ccSvc: num_(e.ccSvc), declared: num_(e.declared)
    };
  });
  const ss = getSpreadsheetForProperty_(propertyId);
  const settings = readConfigSheet_(ss);
  settings.pdpManualTotals = clean;
  writeConfigSheet_(ss, settings);
  return clean;
}

/** Admin-only (this property). Replace the free-form Sales Summary rows
 * (up to 10 label/value pairs, matching the legacy Audit!Q1:Q11 block). */
function saveSalesSummary(propertyId, rows) {
  requireAdmin_(propertyId);
  if (!Array.isArray(rows)) throw new Error('saveSalesSummary: expected an array.');
  const clean = rows.slice(0, 10).map(function (r) {
    return { label: String((r && r.label) || '').trim(), value: num_(r && r.value) };
  }).filter(function (r) { return r.label !== '' || r.value !== 0; });
  const ss = getSpreadsheetForProperty_(propertyId);
  const settings = readConfigSheet_(ss);
  settings.salesSummary = clean;
  writeConfigSheet_(ss, settings);
  return clean;
}

/** Admin-only (this property). Restore this property's settings to the
 * hardcoded defaults — the "corruption recovery" reset. */
function resetSettings(propertyId) {
  requireAdmin_(propertyId);
  const ss = getSpreadsheetForProperty_(propertyId);
  writeConfigSheet_(ss, cloneDefaultPropertySettings_());
  return readConfigSheet_(ss);
}

/** ---------------------------------------------------- PROPERTY MANAGEMENT
 * Ordinary top-level functions with no UI — run them from the Apps Script
 * editor's Run menu to add, adopt, or remove a property. Identical pattern
 * to inventory_audit.
 */

/** Build (or complete) a property's workbook: PDP/Toast/Payments plus the
 * `_Config` sheet. Non-destructive — existing sheets are left alone. */
function buildPropertyWorkbook_(ss) {
  CONFIG.DATASTORES.forEach(function(d){
    if (!ss.getSheetByName(d.sheet)) formatHeaderRow_(ss.insertSheet(d.sheet), d.headers);
  });
  ensureConfigSheet_(ss);
  const stray = ss.getSheetByName('Sheet1');
  if (stray && ss.getSheets().length > 1) ss.deleteSheet(stray);
}

/** Create a brand-new workbook for a property, fully initialized, and
 * register it. Run from Editor → Run → addProperty (edit the name first). */
function addProperty(name="Maximon") {
  name = String(name || '').trim();
  if (!name) throw new Error('addProperty: name is required.');
  
  // 1. Create the spreadsheet (this defaults to the root directory)
  const ss = SpreadsheetApp.create(name);
  
  // 2. Move the new spreadsheet to the same folder as this script
  const scriptId = ScriptApp.getScriptId();
  const scriptFile = DriveApp.getFileById(scriptId);
  const parents = scriptFile.getParents();
  
  if (parents.hasNext()) {
    const scriptFolder = parents.next();
    const ssFile = DriveApp.getFileById(ss.getId());
    ssFile.moveTo(scriptFolder);
  }
  
  // 3. Continue with the rest of your original logic
  buildPropertyWorkbook_(ss);
  
  const id = newPropertyId_(name);
  const registry = loadRegistry_();
  registry.push({ id: id, name: name, spreadsheetId: ss.getId() });
  saveRegistry_(registry);
  
  const result = { id: id, name: name, spreadsheetId: ss.getId(), url: ss.getUrl() };
  Logger.log('Property added: ' + JSON.stringify(result));
  return result;
}

/** Adopt an existing spreadsheet as a property (initializing any missing
 * sheets) and register it. Run from Editor → Run → addExistingProperty. */
function addExistingProperty(name, spreadsheetId) {
  name = String(name || '').trim();
  spreadsheetId = String(spreadsheetId || '').trim();
  if (!name) throw new Error('addExistingProperty: name is required.');
  if (!spreadsheetId) throw new Error('addExistingProperty: spreadsheetId is required.');
  const ss = SpreadsheetApp.openById(spreadsheetId);
  buildPropertyWorkbook_(ss);
  const id = newPropertyId_(name);
  const registry = loadRegistry_();
  registry.push({ id: id, name: name, spreadsheetId: spreadsheetId });
  saveRegistry_(registry);
  const result = { id: id, name: name, spreadsheetId: spreadsheetId, url: ss.getUrl() };
  Logger.log('Property registered: ' + JSON.stringify(result));
  return result;
}

/** Unregister a property. Does NOT delete or trash the workbook — it's left
 * fully intact and can be re-adopted later with addExistingProperty. Run
 * from Editor → Run → removeProperty (edit the id first; see listProperties). */
function removeProperty(id) {
  const registry = loadRegistry_();
  const next = registry.filter(function(p){ return p.id !== id; });
  if (next.length === registry.length) throw new Error('Unknown property: "' + id + '".');
  saveRegistry_(next);
  const msg = 'Removed "' + id + '" from the registry. The workbook itself was not ' +
    'deleted or trashed — only unregistered. Re-add it later with addExistingProperty if needed.';
  Logger.log(msg);
  return { removed: id, note: msg };
}

/** List every registered property. Run from Editor → Run → listProperties
 * (view results via View → Logs, or the Executions panel). */
function listProperties() {
  const list = loadRegistry_();
  Logger.log(JSON.stringify(list, null, 2));
  return list;
}
