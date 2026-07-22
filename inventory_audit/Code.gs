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
 *   `_Config` sheet holding that property's admins, users, and display
 *   settings as plain, human-readable rows. There are NO "Items to Review"
 *   tabs and NO spreadsheet formulas driving the app — all review logic
 *   (categorisation, colour status, progress) is computed here in code and
 *   surfaced through the web app. Managers never touch the sheet.
 *
 *   Category rules below are the exact logic the old SORTN/FILTER formulas
 *   encoded, re-implemented server-side:
 *     Price Changes (top 25) — Qty>0 & valid variance; by |ΔCost/PrevCost| desc
 *     Decreases (top 10)     — all rows by Adjustment ascending (most negative)
 *     Increases (top 10)     — all rows by Adjustment descending
 *     New Items (top 10)     — PrevCost=0 & Qty>0 & CurCost>0
 *     $0 Cost (top 10)       — Qty>0 & CurCost=0
 *     Uncounted (all)        — Qty=0
 *
 *   A single item can qualify for several categories (by design). It is one row
 *   in the data store, so a note saved against it shows on every category at
 *   once. Writes are keyed by row number (exact) with an item-name safety check.
 *
 *   The client (Index.html) holds the full data set in memory once loaded. Edits
 *   are instant and client-side; they are written back to the sheet in batches
 *   (saveNotesBatch), either on demand ("Sync now") or on a periodic auto-sync
 *   timer, instead of one network round trip per keystroke/row.
 *
 * ACCESS MODEL (three tiers)
 *   1. Global admin  — Script Properties list on this project. Admin on every
 *      property, always. Managed via getGlobalAdmins/saveGlobalAdmins.
 *   2. Property admin — per property, stored in that property's `_Config`
 *      sheet. Can upload/replace/remove data and edit settings for that one
 *      property only.
 *   3. Property user  — per property, also in `_Config`. View-only access to
 *      that one property.
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

// All optional report columns the web view can show, in display order. "Item"
// and "Notes" are core UI and are not part of this toggle list. Admins choose
// which of these are visible via Settings ("adjust visible columns").
const ALL_COLUMN_DEFS = [
  { key: 'uom',           label: 'UofM' },
  { key: 'currentQty',    label: 'Current Qty' },
  { key: 'currentCost',   label: 'Current $ Cost' },
  { key: 'currentTotal',  label: 'Current $ Total' },
  { key: 'previousQty',   label: 'Previous Qty' },
  { key: 'prevCost',      label: 'Prev $ Cost' },
  { key: 'prevTotal',     label: 'Prev $ Total' },
  { key: 'adjustment',    label: 'Adjustment' },
  { key: 'costAcct',      label: 'Cost Acct' },
  { key: 'inventoryAcct', label: 'Inventory Acct' },
  { key: 'flag',          label: 'Flag' },
  { key: 'variance',      label: 'Price Variance' }
];

const CONFIG = {
  // The data-store tables and how they surface as tabs, within every property.
  DATASTORES: [
    { key: 'beverage', label: 'Beverage', sheet: 'Beverage Count Details' },
    { key: 'food',     label: 'Food',     sheet: 'Food Count Details'     }
  ],

  // How many rows each computed category shows (Uncounted = all).
  CATEGORY_LIMITS: {
    priceChanges: 25, decreases: 10, increases: 10, newItems: 10, zeroCost: 10
  },

  // Fixed display order + labels for the computed categories.
  CATEGORY_ORDER: [
    { key: 'priceChanges', label: 'PRICE CHANGES ( TOP 25 )' },
    { key: 'decreases',    label: 'DECREASES ( TOP 10 )' },
    { key: 'increases',    label: 'INCREASES ( TOP 10 )' },
    { key: 'newItems',     label: 'NEW ITEMS ( PREV $0 COST )' },
    { key: 'zeroCost',     label: '$0 COST ITEMS' },
    { key: 'uncounted',    label: 'UNCOUNTED ITEMS' }
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
const DEFAULT_GLOBAL_ADMINS = ['rstevenson1237@gmail.com'];
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
 * Sheets without touching code or the Apps Script editor.
 */
const CONFIG_SHEET_NAME = '_Config';
const CONFIG_ROWS = [
  { key: 'propertyAdmins', label: 'Property Admins' },
  { key: 'propertyUsers',  label: 'Property Users'  },
  { key: 'visibleColumns', label: 'Visible Columns' },
  { key: 'noteCategories', label: 'Note Categories'  }
];

const DEFAULT_PROPERTY_SETTINGS = {
  propertyAdmins: [],
  propertyUsers: [],
  visibleColumns: ALL_COLUMN_DEFS.map(function(c){ return c.key; }),
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
  if (key === 'visibleColumns') {
    const valid = ALL_COLUMN_DEFS.map(function(c){ return c.key; });
    const filtered = list.filter(function(k){ return valid.indexOf(k) !== -1; });
    return filtered.length ? filtered : DEFAULT_PROPERTY_SETTINGS.visibleColumns.slice();
  }
  if (key === 'noteCategories') {
    const upper = list.map(function(c){ return c.toUpperCase(); });
    return upper.length ? upper : DEFAULT_PROPERTY_SETTINGS.noteCategories.slice();
  }
  return list; // propertyAdmins / propertyUsers — empty is valid, not a fallback case
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
    settings[r.key] = parseListCell_(byLabel[r.label], r.key);
  });
  return settings;
}

function writeConfigSheet_(ss, settings) {
  const sheet = ensureConfigSheet_(ss);
  const rows = CONFIG_ROWS.map(function(r){
    const val = settings[r.key] || [];
    return [r.label, val.join(', ')];
  });
  sheet.getRange(2, 1, rows.length, 2).setValues(rows);
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
    .setTitle('Inventory Audit — Items to Review')
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
  ['Item','Current Qty','Current $ Cost','Prev $ Cost','Adjustment'].forEach(function(req){
    if (!cols[req]) {
      throw new Error('Sheet "' + sheet.getName() + '" is missing the "' + req +
        '" column. Run addProperty/addExistingProperty first.');
    }
  });
  return cols;
}

function num_(v) {
  if (v === '' || v == null) return NaN;
  const n = Number(v);
  return isNaN(n) ? NaN : n;
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

/** Read the whole table into row objects (with the sheet row number). */
function readRows_(sheet, cols) {
  const lastRow = sheet.getLastRow();
  const rows = [];
  if (lastRow < FIRST_DATA_ROW) return rows;
  const n = lastRow - FIRST_DATA_ROW + 1;
  const width = Math.max(sheet.getLastColumn(), DATASTORE_HEADERS.length);
  const vals = sheet.getRange(FIRST_DATA_ROW, 1, n, width).getValues();
  const g = function(r, label){ return cols[label] ? r[cols[label] - 1] : ''; };
  vals.forEach(function(r, i){
    const item = g(r, 'Item');
    if (item === '' || item == null) return; // skip blank rows
    rows.push({
      row: FIRST_DATA_ROW + i,
      item: String(item).trim(),
      uom: g(r, 'UofM'),
      currentQty: num_(g(r, 'Current Qty')),
      currentCost: num_(g(r, 'Current $ Cost')),
      currentTotal: num_(g(r, 'Current $ Total')),
      previousQty: num_(g(r, 'Previous Qty')),
      prevCost: num_(g(r, 'Prev $ Cost')),
      prevTotal: num_(g(r, 'Prev $ Total')),
      adjustment: num_(g(r, 'Adjustment')),
      costAcct: str_(g(r, 'Cost Acct')),
      inventoryAcct: str_(g(r, 'Inventory Acct')),
      flag: str_(g(r, 'Flag')),
      note: str_(g(r, 'Notes')),
      reviewedBy: str_(g(r, 'Reviewed By')),
      reviewedAt: str_(g(r, 'Reviewed At'))
    });
  });
  return rows;
}

/** Variance = |ΔCost / PrevCost|; -1 when CurCost=0; invalid when PrevCost=0. */
function variance_(row) {
  if (row.currentCost === 0) return { valid: true, value: -1 };
  if (!isFinite(row.prevCost) || row.prevCost === 0) return { valid: false, value: null };
  if (!isFinite(row.currentCost)) return { valid: false, value: null };
  return { valid: true, value: Math.abs((row.currentCost - row.prevCost) / row.prevCost) };
}

/** Compute the six categories from the raw rows (matches the old formulas). */
function computeCategories_(rows) {
  const L = CONFIG.CATEGORY_LIMITS;
  const byItemAsc = function(a, b){ return a.item.localeCompare(b.item); };

  // Price changes: Qty>0 & valid variance; by variance desc; top 25.
  const priceChanges = rows
    .map(function(r){ return { r: r, v: variance_(r) }; })
    .filter(function(x){ return x.r.currentQty > 0 && x.v.valid; })
    .sort(function(a, b){ return b.v.value - a.v.value; })
    .slice(0, L.priceChanges)
    .map(function(x){ return decorate_(x.r); });

  // Decreases: all rows by Adjustment ascending; top 10.
  const decreases = rows.slice()
    .filter(function(r){ return isFinite(r.adjustment); })
    .sort(function(a, b){ return a.adjustment - b.adjustment; })
    .slice(0, L.decreases)
    .map(function(r){ return decorate_(r); });

  // Increases: all rows by Adjustment descending; top 10.
  const increases = rows.slice()
    .filter(function(r){ return isFinite(r.adjustment); })
    .sort(function(a, b){ return b.adjustment - a.adjustment; })
    .slice(0, L.increases)
    .map(function(r){ return decorate_(r); });

  // New items: PrevCost=0 & Qty>0 & CurCost>0; by item; top 10.
  const newItems = rows
    .filter(function(r){ return r.prevCost === 0 && r.currentQty > 0 && r.currentCost > 0; })
    .sort(byItemAsc).slice(0, L.newItems).map(function(r){ return decorate_(r); });

  // $0 cost: Qty>0 & CurCost=0; by item; top 10.
  const zeroCost = rows
    .filter(function(r){ return r.currentQty > 0 && r.currentCost === 0; })
    .sort(byItemAsc).slice(0, L.zeroCost).map(function(r){ return decorate_(r); });

  // Uncounted: Qty=0; by item; all.
  const uncounted = rows
    .filter(function(r){ return r.currentQty === 0; })
    .sort(byItemAsc).map(function(r){ return decorate_(r); });

  return { priceChanges: priceChanges, decreases: decreases, increases: increases,
           newItems: newItems, zeroCost: zeroCost, uncounted: uncounted };
}

/** Shape a raw row for the client: full report columns + computed variance. */
function decorate_(r) {
  const v = variance_(r);
  return {
    type: 'item',
    row: r.row,
    item: r.item,
    uom: r.uom == null ? '' : String(r.uom),
    currentQty: isFinite(r.currentQty) ? r.currentQty : '',
    currentCost: isFinite(r.currentCost) ? r.currentCost : '',
    currentTotal: isFinite(r.currentTotal) ? r.currentTotal : '',
    previousQty: isFinite(r.previousQty) ? r.previousQty : '',
    prevCost: isFinite(r.prevCost) ? r.prevCost : '',
    prevTotal: isFinite(r.prevTotal) ? r.prevTotal : '',
    adjustment: isFinite(r.adjustment) ? r.adjustment : '',
    costAcct: r.costAcct || '',
    inventoryAcct: r.inventoryAcct || '',
    flag: r.flag || '',
    variance: (v.valid ? v.value : ''),
    note: r.note || '',
    status: statusForNote_(r.note),
    reviewedBy: r.reviewedBy || '',
    reviewedAt: r.reviewedAt || ''
  };
}

/** ------------------------------------------------------------------ READ */
/**
 * Returns, per datastore tab:
 *   { key, label, sheet, sections:[{ label, items:[...] }], counts:{ total, reviewed } }
 * counts are DISTINCT items across all categories (an item spanning several
 * categories is one unit of work). Also includes the current settings (visible
 * columns, note categories, property admins/users) and session, so the client
 * needs one round trip to render everything.
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
    settings: {
      visibleColumns: settings.visibleColumns,
      noteCategories: settings.noteCategories,
      allColumns: ALL_COLUMN_DEFS,
      propertyAdmins: settings.propertyAdmins,
      propertyUsers: settings.propertyUsers
    }
  };

  CONFIG.DATASTORES.forEach(function(d){
    const sheet = ss.getSheetByName(d.sheet);
    // Before the first monthly upload the sheet may not exist yet — show the
    // tab empty rather than erroring.
    if (!sheet || sheet.getLastRow() < FIRST_DATA_ROW) {
      const emptySections = CONFIG.CATEGORY_ORDER.map(function(c){
        return { label: c.label, key: c.key, items: [] };
      });
      result.tabs.push({ key: d.key, label: d.label, sheet: d.sheet,
        sections: emptySections, counts: { total: 0, reviewed: 0 } });
      return;
    }
    const cols = resolveColumns_(sheet);
    const rows = readRows_(sheet, cols);
    const cats = computeCategories_(rows);

    const sections = CONFIG.CATEGORY_ORDER.map(function(c){
      return { label: c.label, key: c.key, items: cats[c.key] };
    });

    // Distinct items (by row) that appear in any category = the review workload.
    const seen = {}, reviewedSeen = {};
    CONFIG.CATEGORY_ORDER.forEach(function(c){
      cats[c.key].forEach(function(it){
        seen[it.row] = true;
        if (it.note !== '' && it.note != null) reviewedSeen[it.row] = true;
      });
    });
    const total = Object.keys(seen).length;
    const reviewed = Object.keys(reviewedSeen).length;

    result.tabs.push({
      key: d.key, label: d.label, sheet: d.sheet,
      sections: sections, counts: { total: total, reviewed: reviewed }
    });
  });

  return result;
}

/** ----------------------------------------------------------------- WRITE */
/**
 * Save a note to a data-store row.
 * @param {string} propertyId
 * @param {Object} payload { datastore, row, note, expectedItem }
 * @return {Object} { success, row, status, reviewed, total }
 */
function saveNote(propertyId, payload) {
  if (!propertyId) throw new Error('saveNote: missing propertyId.');
  const dsKey = payload && payload.datastore;
  const row = payload && Number(payload.row);
  const note = payload && payload.note != null ? String(payload.note) : '';
  const expectedItem = payload && payload.expectedItem;
  if (!dsKey || !row) throw new Error('saveNote: missing datastore or row.');
  requireAccess_(propertyId);

  const d = datastoreByKey_(dsKey);
  const lock = LockService.getScriptLock();
  try { lock.waitLock(15000); }
  catch (e) { throw new Error('The data store is busy — another update is in progress. Try again.'); }

  try {
    const ss = getSpreadsheetForProperty_(propertyId);
    const sheet = ss.getSheetByName(d.sheet);
    if (!sheet) throw new Error('Data-store sheet "' + d.sheet + '" not found.');
    const cols = resolveColumns_(sheet);

    if (row < FIRST_DATA_ROW || row > sheet.getLastRow()) {
      throw new Error('Row ' + row + ' is out of range. Please refresh.');
    }
    if (expectedItem != null) {
      const actual = sheet.getRange(row, cols['Item']).getValue();
      if (String(actual).trim() !== String(expectedItem).trim()) {
        throw new Error('This item moved since you loaded the page. Please refresh.');
      }
    }

    sheet.getRange(row, cols['Notes']).setValue(note);
    if (CONFIG.ENABLE_AUDIT && cols['Reviewed By'] && cols['Reviewed At']) {
      const who = Session.getActiveUser().getEmail() || 'unknown';
      sheet.getRange(row, cols['Reviewed By']).setValue(who);
      sheet.getRange(row, cols['Reviewed At']).setValue(
        Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm'));
    }
    SpreadsheetApp.flush();

    const prog = computeProgress_(ss, d);
    return { success: true, row: row, status: statusForNote_(note),
             reviewed: prog.reviewed, total: prog.total };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Batch save — the primary write path used by the client's in-memory sync
 * queue (manual "Sync now" or the auto-sync timer). entries:
 *   [{ datastore, row, note, expectedItem }]
 * Returns one result per entry, IN THE SAME ORDER, so the client can reconcile
 * its pending queue precisely: a row whose entry comes back { ok:false } stays
 * pending (and marked as an error) instead of being silently dropped, which is
 * what caused notes to appear to "not save" under the old per-row Save flow.
 */
function saveNotesBatch(propertyId, entries) {
  if (!propertyId) throw new Error('saveNotesBatch: missing propertyId.');
  if (!Array.isArray(entries)) throw new Error('saveNotesBatch expects an array.');
  requireAccess_(propertyId);
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); }
  catch (e) { throw new Error('The data store is busy — another sync is in progress. Try again shortly.'); }
  try {
    const ss = getSpreadsheetForProperty_(propertyId);
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
        if (r < FIRST_DATA_ROW || r > sheet.getLastRow()) {
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
          const who = Session.getActiveUser().getEmail() || 'unknown';
          sheet.getRange(r, cols['Reviewed By']).setValue(who);
          sheet.getRange(r, cols['Reviewed At']).setValue(
            Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm'));
        }
        results.push({ row: r, ok: true, status: statusForNote_(e.note) });
      } catch (err) {
        results.push({ row: e.row, ok: false, error: String(err.message || err) });
      }
    });
    SpreadsheetApp.flush();

    // Progress per datastore touched, so the client can refresh tab counters
    // without a full reload.
    const progress = {};
    Object.keys(sheetCache).forEach(function(key){
      const d = datastoreByKey_(key);
      progress[key] = computeProgress_(ss, d);
    });
    return { results: results, progress: progress };
  } finally {
    lock.releaseLock();
  }
}

function computeProgress_(ss, d) {
  const sheet = ss.getSheetByName(d.sheet);
  const cols = resolveColumns_(sheet);
  const rows = readRows_(sheet, cols);
  const cats = computeCategories_(rows);
  const seen = {}, reviewedSeen = {};
  CONFIG.CATEGORY_ORDER.forEach(function(c){
    (cats[c.key] || []).forEach(function(it){
      seen[it.row] = true;
      if (it.note !== '' && it.note != null) reviewedSeen[it.row] = true;
    });
  });
  return { total: Object.keys(seen).length, reviewed: Object.keys(reviewedSeen).length };
}

/** --------------------------------------------------------------- SETTINGS */
/** Admin-only (this property). Current settings + column catalogue. */
function getSettings(propertyId) {
  requireAdmin_(propertyId);
  const ss = getSpreadsheetForProperty_(propertyId);
  const s = readConfigSheet_(ss);
  return {
    propertyAdmins: s.propertyAdmins,
    propertyUsers: s.propertyUsers,
    visibleColumns: s.visibleColumns,
    noteCategories: s.noteCategories,
    allColumns: ALL_COLUMN_DEFS
  };
}

/**
 * Admin-only (this property). Replace this property's settings wholesale.
 * Validated: at least one note category, every note category must start with
 * a status prefix (CORRECT/REVIEW/ADJUST) so row colouring and the two-stage
 * dropdown keep working, and visible columns must be known keys. Property
 * admins/users have no minimum — global admins remain a fallback, so a
 * property is never orphaned by clearing these lists.
 */
function saveSettings(propertyId, payload) {
  requireAdmin_(propertyId);
  if (!payload || typeof payload !== 'object') throw new Error('saveSettings: invalid payload.');

  const propertyAdmins = Array.isArray(payload.propertyAdmins)
    ? payload.propertyAdmins.map(function(e){ return String(e).trim(); }).filter(Boolean) : [];
  const propertyUsers = Array.isArray(payload.propertyUsers)
    ? payload.propertyUsers.map(function(e){ return String(e).trim(); }).filter(Boolean) : [];

  const validKeys = ALL_COLUMN_DEFS.map(function(c){ return c.key; });
  const visibleColumns = Array.isArray(payload.visibleColumns)
    ? payload.visibleColumns.filter(function(k){ return validKeys.indexOf(k) !== -1; }) : [];

  const noteCategories = Array.isArray(payload.noteCategories)
    ? payload.noteCategories.map(function(c){ return String(c).trim().toUpperCase(); }).filter(Boolean) : [];
  if (!noteCategories.length) throw new Error('At least one note category is required.');
  noteCategories.forEach(function(c){
    const ok = CONFIG.STATUS_RULES.some(function(rule){ return c.indexOf(rule.prefix) === 0; });
    if (!ok) throw new Error('"' + c + '" must start with CORRECT, REVIEW, or ADJUST.');
  });

  const settings = { propertyAdmins: propertyAdmins, propertyUsers: propertyUsers,
    visibleColumns: visibleColumns, noteCategories: noteCategories };
  const ss = getSpreadsheetForProperty_(propertyId);
  writeConfigSheet_(ss, settings);
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
function addProperty(name) {
  name = String(name || '').trim();
  if (!name) throw new Error('addProperty: name is required.');
  const ss = SpreadsheetApp.create(name);
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
