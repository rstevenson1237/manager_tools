/*******************************************************************************
 * Code.gs — Inventory Audit Web App (backend)
 *
 * ARCHITECTURE
 *   This is a STANDALONE script (not bound to any single Sheet). One workbook
 *   = one property. A central registry (Script Properties, on this project)
 *   lists every property and where its workbook lives; the script opens each
 *   property's workbook by ID on demand.
 *
 *   Each property workbook is a pure DATA STORE with three sheets: two Count
 *   Details tables (Beverage / Food — one row per unique item) plus a hidden
 *   `_Config` sheet holding that property's admins, users, note list and the
 *   last upload of each table, as plain, human-readable rows. Managers never
 *   touch the sheet.
 *
 *   WHAT TO REVIEW comes from InventoryRules.gs, the same file the P&L
 *   Tracker uses for the regional manager's blind check: the store team
 *   reviews with exactly the rules it will be checked with. Every item's
 *   change splits into a price effect and a quantity effect; items are picked
 *   and ranked by dollar impact (see that file for the sections).
 *
 *   A single item can qualify for several sections (by design). It is one row
 *   in the data store, so a note saved against it shows in every section at
 *   once. Writes are keyed by row number (exact) with an item-name safety check.
 *
 *   The client (Index.html) holds the data set in memory once loaded. Edits
 *   are instant and client-side; they are written back to the sheet in batches
 *   (saveNotesBatch), either on demand ("Save now") or every 20 seconds.
 *
 * ACCESS MODEL (three tiers)
 *   1. Global admin  — Script Properties list on this project. Admin on every
 *      property, always. Managed via getGlobalAdmins/saveGlobalAdmins.
 *   2. Property admin — per property, stored in that property's `_Config`
 *      sheet. Can upload/replace/remove data and edit settings for that one
 *      property only.
 *   3. Property user  — per property, also in `_Config`. Can read the review
 *      and write notes for that one property.
 ******************************************************************************/

/** ------------------------------------------------------------------ CONFIG */
const DATASTORE_HEADERS = [
  'Item', 'UofM', 'Current Qty', 'Current $ Cost', 'Current $ Total',
  'Previous Qty', 'Prev $ Cost', 'Prev $ Total', 'Adjustment',
  'Cost Acct', 'Inventory Acct', 'Flag',
  'Notes', 'Reviewed By', 'Reviewed At'   // app-managed columns
];
const HEADER_ROW = 1;
const FIRST_DATA_ROW = 2;

const CONFIG = {
  // The data-store tables and how they surface as tabs, within every property.
  DATASTORES: [
    { key: 'beverage', label: 'Beverage', sheet: 'Beverage Count Details' },
    { key: 'food',     label: 'Food',     sheet: 'Food Count Details'     }
  ],

  ENABLE_AUDIT: true,   // stamp Reviewed By / Reviewed At on save

  STATUS_RULES: [
    { prefix: 'CORRECT', status: 'correct' },
    { prefix: 'REVIEW',  status: 'review'  },
    { prefix: 'ADJUST',  status: 'adjust'  }
  ]
};

/** --------------------------------------------------------- GLOBAL STORE
 * The global admin list and the property registry live in this standalone
 * project's Script Properties — the only storage available to a script not
 * bound to a single Sheet, and the natural home for data that spans every
 * property rather than belonging to one of them.
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
 * that property's own workbook, as plain "Setting | Value" rows (list values
 * comma-separated) rather than an opaque properties blob. End users only ever
 * reach the app through the web-app URL, never the sheet itself, so this is
 * exactly as safe from accidental edits as the Count Details tabs — and it
 * means the workbook owner can hand-fix a corrupted setting directly in
 * Sheets without touching code or the Apps Script editor. Rows are found by
 * their label, so their order does not matter, and rows from older versions
 * (such as "Visible Columns") are dropped the next time settings are saved.
 */
const CONFIG_SHEET_NAME = '_Config';
const CONFIG_ROWS = [
  { key: 'propertyAdmins', label: 'Property Admins' },
  { key: 'propertyUsers',  label: 'Property Users'  },
  { key: 'noteCategories', label: 'Note Categories'  }
];
/** The last upload of each table: "<file> | <ISO time> | <email>". */
const UPLOAD_ROW_PREFIX = 'Last Upload: ';

const DEFAULT_PROPERTY_SETTINGS = {
  propertyAdmins: [],
  propertyUsers: [],
  noteCategories: [
    'CORRECT',
    'CORRECT - ISSUE HAS BEEN RESOLVED',
    'CORRECT - FIXED FROM LAST MONTH',
    'REVIEW',
    'REVIEW - DOUBLE CHECK COUNT',
    'ADJUST',
    'ADJUST - CASE AS BOTTLE PRICE',
    'ADJUST - INCORRECT ITEM COUNTED',
    'ADJUST - BOTTLE AS CASE PRICE',
    'ADJUST - INCORRECT PRICE IN SYSTEM',
    'ADJUST - PRODUCT NEEDS TO BE RECOSTED'
  ]
};

function cloneDefaultPropertySettings_() {
  return JSON.parse(JSON.stringify(DEFAULT_PROPERTY_SETTINGS));
}

/** Get-or-create the `_Config` sheet, seeded with default rows, hidden. */
function ensureConfigSheet_(ss) {
  let sheet = ss.getSheetByName(CONFIG_SHEET_NAME);
  if (sheet) return sheet;
  sheet = ss.insertSheet(CONFIG_SHEET_NAME);
  sheet.getRange(1, 1, 1, 2).setValues([['Setting', 'Value']]);
  sheet.getRange(1, 1, 1, 2).setFontWeight('bold');
  sheet.setFrozenRows(1);
  const rows = CONFIG_ROWS.map(function(r){
    const d = DEFAULT_PROPERTY_SETTINGS[r.key];
    return [r.label, Array.isArray(d) ? d.join(', ') : ''];
  });
  sheet.getRange(2, 1, rows.length, 2).setValues(rows);
  sheet.hideSheet();
  return sheet;
}

function parseListCell_(raw, key) {
  if (raw == null || String(raw).trim() === '') return DEFAULT_PROPERTY_SETTINGS[key].slice();
  const list = String(raw).split(',').map(function(s){ return s.trim(); }).filter(Boolean);
  if (key === 'noteCategories') {
    const upper = list.map(function(c){ return c.toUpperCase(); });
    return upper.length ? upper : DEFAULT_PROPERTY_SETTINGS.noteCategories.slice();
  }
  return list; // propertyAdmins / propertyUsers — empty is valid, not a fallback case
}

/** Every "Setting | Value" row of the `_Config` sheet, by label. */
function readConfigRows_(ss) {
  const sheet = ensureConfigSheet_(ss);
  const lastRow = sheet.getLastRow();
  const vals = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, 2).getValues() : [];
  const byLabel = {};
  vals.forEach(function(r){
    const label = String(r[0] || '').trim();
    if (label) byLabel[label] = r[1];
  });
  return byLabel;
}

/** Rewrite the `_Config` sheet from a label → value map (settings first, then upload rows). */
function writeConfigRows_(ss, byLabel) {
  const sheet = ensureConfigSheet_(ss);
  const last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, 2).clearContent();
  const rows = CONFIG_ROWS.map(function(r){ return [r.label, byLabel[r.label] == null ? '' : byLabel[r.label]]; });
  CONFIG.DATASTORES.forEach(function(d){
    const label = UPLOAD_ROW_PREFIX + d.label;
    if (byLabel[label]) rows.push([label, byLabel[label]]);
  });
  sheet.getRange(2, 1, rows.length, 2).setValues(rows);
}

/** Read this property's settings from its `_Config` sheet. */
function readConfigSheet_(ss) {
  const byLabel = readConfigRows_(ss);
  const settings = {};
  CONFIG_ROWS.forEach(function(r){
    settings[r.key] = parseListCell_(byLabel[r.label], r.key);
  });
  return settings;
}

function writeConfigSheet_(ss, settings) {
  const byLabel = readConfigRows_(ss);
  CONFIG_ROWS.forEach(function(r){ byLabel[r.label] = (settings[r.key] || []).join(', '); });
  writeConfigRows_(ss, byLabel);
}

/** The last upload of a table: { file, at, by } or null. */
function readUploadInfo_(ss, d) {
  const raw = readConfigRows_(ss)[UPLOAD_ROW_PREFIX + d.label];
  if (!raw) return null;
  const p = String(raw).split(' | ');
  return { file: p[0] || '', at: p[1] || '', by: p[2] || '' };
}

function writeUploadInfo_(ss, d, info) {
  const byLabel = readConfigRows_(ss);
  const label = UPLOAD_ROW_PREFIX + d.label;
  if (info) byLabel[label] = [info.file || '', info.at || '', info.by || ''].join(' | ');
  else delete byLabel[label];
  writeConfigRows_(ss, byLabel);
}

/** ---------------------------------------------------------- SHEET SHAPING */
/** Write the bold, frozen header row that defines the table. */
function formatHeaderRow_(sheet) {
  if (sheet.getMaxColumns() < DATASTORE_HEADERS.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), DATASTORE_HEADERS.length - sheet.getMaxColumns());
  }
  sheet.getRange(HEADER_ROW, 1, 1, DATASTORE_HEADERS.length).setValues([DATASTORE_HEADERS]);
  sheet.getRange(HEADER_ROW, 1, 1, DATASTORE_HEADERS.length).setFontWeight('bold');
  sheet.setFrozenRows(1);
}

/**
 * Delete a data-store sheet if present and recreate it pristine with headers.
 * Sequenced so the workbook is never momentarily sheet-less: the replacement
 * is inserted before the old one is removed.
 */
function recreateDatastoreSheet_(ss, name) {
  const old = ss.getSheetByName(name);
  let sheet;
  if (old) {
    sheet = ss.insertSheet(name + '__tmp');
    ss.deleteSheet(old);
    sheet.setName(name);
  } else {
    sheet = ss.insertSheet(name);
  }
  formatHeaderRow_(sheet);
  return sheet;
}

/** ---------------------------------------------------------- WEB APP ENTRY */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Inventory Audit')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** ------------------------------------------------------------ ADMIN / AUTH */
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
 * Guards every destructive/config call. */
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

/** Resolve column numbers from the header row (robust to re-ordering). */
function resolveColumns_(sheet) {
  const lastCol = Math.max(sheet.getLastColumn(), DATASTORE_HEADERS.length);
  const hdr = sheet.getRange(HEADER_ROW, 1, 1, lastCol).getValues()[0];
  const byLabel = {};
  hdr.forEach(function(label, i){
    if (label !== '' && label != null) byLabel[String(label).trim().toLowerCase()] = i + 1;
  });
  const cols = {};
  DATASTORE_HEADERS.forEach(function(label){
    const c = byLabel[label.toLowerCase()];
    if (c) cols[label] = c;
  });
  // Required inputs must exist; app-managed columns are created by setup.
  ['Item','Current Qty','Current $ Cost','Previous Qty','Prev $ Cost'].forEach(function(req){
    if (!cols[req]) {
      throw new Error('Sheet "' + sheet.getName() + '" is missing the "' + req +
        '" column. Run addProperty/addExistingProperty first.');
    }
  });
  return cols;
}

function str_(v) { return v == null ? '' : String(v); }

function statusForNote_(note) {
  if (!note) return '';
  const n = String(note).trim().toUpperCase();
  for (let i = 0; i < CONFIG.STATUS_RULES.length; i++) {
    if (n.indexOf(CONFIG.STATUS_RULES[i].prefix) === 0) return CONFIG.STATUS_RULES[i].status;
  }
  return 'other';
}

/**
 * Read a Count Details sheet into items in InventoryRules.gs's shape, each
 * with its sheet row number and its note. Values may be numbers or the
 * export's text ("$1,799.88"), as older uploads stored them.
 */
function readItems_(sheet) {
  if (!sheet || sheet.getLastRow() < FIRST_DATA_ROW) return [];
  const cols = resolveColumns_(sheet);
  const n = sheet.getLastRow() - FIRST_DATA_ROW + 1;
  const width = Math.max(sheet.getLastColumn(), DATASTORE_HEADERS.length);
  const vals = sheet.getRange(FIRST_DATA_ROW, 1, n, width).getValues();
  const g = function(r, label){ return cols[label] ? r[cols[label] - 1] : undefined; };
  const items = [], seen = {};
  vals.forEach(function(r, i){
    const raw = {};
    INV_COLUMNS.forEach(function(c){ raw[c.field] = g(r, c.header); });
    const it = inventoryItem_(raw);
    if (!it) return; // blank row
    delete it._bad;
    it.key = uniqueInvKey_(it, seen);
    it.row = FIRST_DATA_ROW + i;
    it.note = str_(g(r, 'Notes'));
    it.reviewedBy = str_(g(r, 'Reviewed By'));
    it.reviewedAt = str_(g(r, 'Reviewed At'));
    items.push(it);
  });
  return items;
}

/** How many picked items there are, and how many have a note. */
function reviewProgress_(triage, items) {
  const byKey = {};
  items.forEach(function(it){ byKey[it.key] = it; });
  let reviewed = 0;
  Object.keys(triage.items).forEach(function(k){ if (byKey[k] && byKey[k].note) reviewed++; });
  return { total: triage.total, reviewed: reviewed };
}

/** ------------------------------------------------------------------ READ */
/**
 * Everything the page needs for one property, in one round trip. Per table:
 *   { key, label, sheet, upload: {file, at, by} | null, totals, items: count,
 *     sections: [{key, label, hint, keys}], review: {key: item}, counts }
 * `review` holds only the picked items (with their reasons, effects, dollar
 * size, sheet row and note); counts are distinct items, since an item in
 * several sections is one unit of work.
 */
function getInventoryData(propertyId) {
  if (!propertyId) throw new Error('getInventoryData: missing propertyId.');
  const role = requireAccess_(propertyId);
  const ss = getSpreadsheetForProperty_(propertyId);
  const settings = readConfigSheet_(ss);
  const result = {
    tabs: [],
    generatedAt: new Date().toISOString(),
    session: { email: currentUserEmail_(), isAdmin: role === 'admin' },
    rules: { highImpact: INV_RULES.highImpact },
    settings: {
      noteCategories: settings.noteCategories,
      propertyAdmins: settings.propertyAdmins,
      propertyUsers: settings.propertyUsers
    }
  };
  CONFIG.DATASTORES.forEach(function(d){
    const items = readItems_(ss.getSheetByName(d.sheet));
    const tri = triageInventory_(items);
    const notes = {};
    items.forEach(function(it){ notes[it.key] = it; });
    const review = {};
    Object.keys(tri.items).forEach(function(k){
      const t = tri.items[k], src = notes[k];
      review[k] = Object.assign({}, t, { row: src.row, note: src.note, status: statusForNote_(src.note),
        reviewedBy: src.reviewedBy, reviewedAt: src.reviewedAt });
    });
    result.tabs.push({
      key: d.key, label: d.label, sheet: d.sheet,
      upload: readUploadInfo_(ss, d),
      items: items.length,
      stocked: items.filter(function(it){ return it.curQty > 0 || it.prevQty > 0; }).length,
      totals: inventoryTotals_(items),
      sections: tri.sections,
      review: review,
      counts: reviewProgress_(tri, items)
    });
  });
  return JSON.parse(JSON.stringify(result));
}

/** ----------------------------------------------------------------- WRITE */
/**
 * Batch save — the write path used by the page's in-memory sync queue
 * ("Save now" or the 20-second timer). entries:
 *   [{ datastore, row, note, expectedItem }]
 * Returns one result per entry, IN THE SAME ORDER, so the page can reconcile
 * its queue precisely: an entry that comes back { ok:false } stays queued
 * (and marked retry) instead of being silently dropped.
 */
function saveNotesBatch(propertyId, entries) {
  if (!propertyId) throw new Error('saveNotesBatch: missing propertyId.');
  if (!Array.isArray(entries)) throw new Error('saveNotesBatch expects an array.');
  requireAccess_(propertyId);
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); }
  catch (e) { throw new Error('The data store is busy — another save is in progress. Try again shortly.'); }
  try {
    const ss = getSpreadsheetForProperty_(propertyId);
    const who = currentUserEmail_() || 'unknown';
    const at = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm');
    const sheetCache = {}, colsCache = {};
    const results = [];
    entries.forEach(function(e){
      try {
        const d = datastoreByKey_(e.datastore);
        if (!sheetCache[d.key]) {
          sheetCache[d.key] = ss.getSheetByName(d.sheet);
          if (!sheetCache[d.key]) throw new Error('Data-store sheet "' + d.sheet + '" not found.');
          colsCache[d.key] = resolveColumns_(sheetCache[d.key]);
        }
        const sheet = sheetCache[d.key], cols = colsCache[d.key];
        const r = Number(e.row);
        if (!(r >= FIRST_DATA_ROW) || r > sheet.getLastRow()) {
          results.push({ row: r, ok: false, error: 'row out of range — refresh' }); return;
        }
        if (e.expectedItem != null) {
          const actual = sheet.getRange(r, cols['Item']).getValue();
          if (String(actual).trim() !== String(e.expectedItem).trim()) {
            results.push({ row: r, ok: false, error: 'row moved — refresh' }); return;
          }
        }
        sheet.getRange(r, cols['Notes']).setValue(e.note == null ? '' : String(e.note));
        if (CONFIG.ENABLE_AUDIT && cols['Reviewed By'] && cols['Reviewed At']) {
          sheet.getRange(r, cols['Reviewed By']).setValue(e.note ? who : '');
          sheet.getRange(r, cols['Reviewed At']).setValue(e.note ? at : '');
        }
        results.push({ row: r, ok: true, status: statusForNote_(e.note), by: e.note ? who : '', at: e.note ? at : '' });
      } catch (err) {
        results.push({ row: e.row, ok: false, error: String(err.message || err) });
      }
    });
    SpreadsheetApp.flush();
    return { results: results };
  } finally {
    lock.releaseLock();
  }
}

/** --------------------------------------------------------------- SETTINGS */
/** Admin-only (this property). Current settings. */
function getSettings(propertyId) {
  requireAdmin_(propertyId);
  const ss = getSpreadsheetForProperty_(propertyId);
  const s = readConfigSheet_(ss);
  return {
    propertyAdmins: s.propertyAdmins,
    propertyUsers: s.propertyUsers,
    noteCategories: s.noteCategories
  };
}

/**
 * Admin-only (this property). Replace this property's settings wholesale.
 * Validated: at least one note, and every note must start with a status
 * prefix (CORRECT/REVIEW/ADJUST) so row colouring and the note buttons keep
 * working. Property admins/users have no minimum — global admins remain a
 * fallback, so a property is never orphaned by clearing these lists.
 */
function saveSettings(propertyId, payload) {
  requireAdmin_(propertyId);
  if (!payload || typeof payload !== 'object') throw new Error('saveSettings: invalid payload.');
  const clean = function(list){
    return Array.isArray(list) ? list.map(function(e){ return String(e).trim(); }).filter(Boolean) : [];
  };
  const noteCategories = clean(payload.noteCategories).map(function(c){ return c.toUpperCase(); })
    .filter(function(c, i, a){ return a.indexOf(c) === i; });
  if (!noteCategories.length) throw new Error('At least one note is required.');
  noteCategories.forEach(function(c){
    const ok = CONFIG.STATUS_RULES.some(function(rule){ return c.indexOf(rule.prefix) === 0; });
    if (!ok) throw new Error('"' + c + '" must start with CORRECT, REVIEW, or ADJUST.');
  });
  const ss = getSpreadsheetForProperty_(propertyId);
  writeConfigSheet_(ss, { propertyAdmins: clean(payload.propertyAdmins), propertyUsers: clean(payload.propertyUsers),
    noteCategories: noteCategories });
  return getSettings(propertyId);
}

/** Admin-only (this property). Restore this property's settings to the
 * hardcoded defaults — the "corruption recovery" reset. */
function resetSettings(propertyId) {
  requireAdmin_(propertyId);
  const ss = getSpreadsheetForProperty_(propertyId);
  writeConfigSheet_(ss, cloneDefaultPropertySettings_());
  return getSettings(propertyId);
}

/** ---------------------------------------------------- PROPERTY MANAGEMENT
 * Ordinary top-level functions with no UI — run them from the Apps Script
 * editor's Run menu to add, adopt, or remove a property.
 */

/** Build (or complete) a property's workbook: both Count Details tabs plus
 * the `_Config` sheet. Non-destructive — existing sheets are left alone. */
function buildPropertyWorkbook_(ss) {
  CONFIG.DATASTORES.forEach(function(d){
    if (!ss.getSheetByName(d.sheet)) formatHeaderRow_(ss.insertSheet(d.sheet));
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
