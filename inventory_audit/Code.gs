/*******************************************************************************
 * Code.gs — Inventory Audit Web App (backend)
 *
 * ARCHITECTURE
 *   The spreadsheet is a pure DATA STORE. The two Count Details sheets are the
 *   only tables; each is one row per unique item. There are NO "Items to Review"
 *   tabs and NO spreadsheet formulas driving the app — all review logic
 *   (categorisation, colour status, progress) is computed here in code and
 *   surfaced through the Google Sites web app. Managers never touch the sheet.
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
  // The data-store tables and how they surface as tabs.
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

/** --------------------------------------------------------- SETTINGS STORE
 * Admin-editable settings (admin emails, visible columns, note categories) are
 * persisted in the spreadsheet's Document Properties — shared by everyone who
 * opens the web app, but not visible in the sheet UI itself. This lets admins
 * change them from inside the app (Settings panel) with no code redeploy.
 */
const SETTINGS_KEY = 'INVENTORY_AUDIT_SETTINGS_V1';

const DEFAULT_SETTINGS = {
  // Seed admin(s). Editable afterwards from the Settings panel. Kept non-empty
  // here so the person installing the app is never locked out on first run.
  adminEmails: ['rstevenson1237@gmail.com'],
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

function cloneDefaultSettings_() {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

/** Read settings from Document Properties, filling in defaults if unset/corrupt. */
function loadSettings_() {
  let raw = null;
  try { raw = PropertiesService.getDocumentProperties().getProperty(SETTINGS_KEY); }
  catch (e) { raw = null; }
  if (!raw) return cloneDefaultSettings_();
  try {
    const parsed = JSON.parse(raw);
    const d = cloneDefaultSettings_();
    return {
      adminEmails: (Array.isArray(parsed.adminEmails) && parsed.adminEmails.length)
        ? parsed.adminEmails.map(String) : d.adminEmails,
      visibleColumns: Array.isArray(parsed.visibleColumns)
        ? parsed.visibleColumns.filter(function(k){ return ALL_COLUMN_DEFS.some(function(c){ return c.key === k; }); })
        : d.visibleColumns,
      noteCategories: (Array.isArray(parsed.noteCategories) && parsed.noteCategories.length)
        ? parsed.noteCategories.map(String) : d.noteCategories
    };
  } catch (e) {
    return cloneDefaultSettings_();
  }
}

function persistSettings_(settings) {
  PropertiesService.getDocumentProperties().setProperty(SETTINGS_KEY, JSON.stringify(settings));
}

/** Client-callable: current settings + column catalogue + this user's session. */
function getSettings() {
  const s = loadSettings_();
  return {
    adminEmails: s.adminEmails,
    visibleColumns: s.visibleColumns,
    noteCategories: s.noteCategories,
    allColumns: ALL_COLUMN_DEFS,
    isAdmin: isAdmin_(),
    email: currentUserEmail_()
  };
}

/**
 * Admin-only. Replace settings wholesale. Validated: at least one admin email,
 * at least one note category, every note category must start with a status
 * prefix (CORRECT/REVIEW/ADJUST) so row colouring and the two-stage dropdown
 * keep working, and visible columns must be known keys.
 */
function saveSettings(payload) {
  requireAdmin_();
  if (!payload || typeof payload !== 'object') throw new Error('saveSettings: invalid payload.');

  const adminEmails = Array.isArray(payload.adminEmails)
    ? payload.adminEmails.map(function(e){ return String(e).trim(); }).filter(Boolean) : [];
  if (!adminEmails.length) throw new Error('At least one admin email is required.');

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

  const settings = {
    adminEmails: adminEmails,
    visibleColumns: visibleColumns,
    noteCategories: noteCategories
  };
  persistSettings_(settings);
  return getSettings();
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
 * Sequenced so the spreadsheet is never momentarily sheet-less: the replacement
 * is inserted before the old one is removed.
 */
function recreateDatastoreSheet_(name) {
  const ss = getSpreadsheet_();
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

/** --------------------------------------------------------------- HELPERS */
function getSpreadsheet_() {
  return SpreadsheetApp.getActiveSpreadsheet();
  // Standalone alternative: return SpreadsheetApp.openById('YOUR_SPREADSHEET_ID');
}

/** ------------------------------------------------------------ ADMIN / AUTH */
function currentUserEmail_() {
  try { return Session.getActiveUser().getEmail() || ''; } catch (e) { return ''; }
}

function isAdmin_() {
  const email = currentUserEmail_().toLowerCase();
  if (!email) return false;
  const settings = loadSettings_();
  return settings.adminEmails.map(function(e){ return String(e).toLowerCase(); }).indexOf(email) !== -1;
}

/** Throw unless the accessing user is an admin. Guards every destructive call. */
function requireAdmin_() {
  if (isAdmin_()) return;
  const who = currentUserEmail_();
  throw new Error(who
    ? ('Administrator access required. You are signed in as ' + who +
       ', which is not on the admin list.')
    : ('Administrator access required, but your account could not be identified.'));
}

/** Client-callable: lets the web app decide whether to show the admin panel. */
function getSessionInfo() {
  return { email: currentUserEmail_(), isAdmin: isAdmin_() };
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
        '" column. Run setupDatastore first.');
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
 * columns, note categories) and session, so the client needs one round trip to
 * render everything.
 */
function getInventoryData() {
  const ss = getSpreadsheet_();
  const settings = loadSettings_();
  const result = {
    tabs: [],
    generatedAt: new Date().toISOString(),
    session: { email: currentUserEmail_(), isAdmin: isAdmin_() },
    settings: {
      visibleColumns: settings.visibleColumns,
      noteCategories: settings.noteCategories,
      allColumns: ALL_COLUMN_DEFS,
      adminEmails: settings.adminEmails
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
 * @param {Object} payload { datastore, row, note, expectedItem }
 * @return {Object} { success, row, status, reviewed, total }
 */
function saveNote(payload) {
  const dsKey = payload && payload.datastore;
  const row = payload && Number(payload.row);
  const note = payload && payload.note != null ? String(payload.note) : '';
  const expectedItem = payload && payload.expectedItem;
  if (!dsKey || !row) throw new Error('saveNote: missing datastore or row.');

  const d = datastoreByKey_(dsKey);
  const lock = LockService.getScriptLock();
  try { lock.waitLock(15000); }
  catch (e) { throw new Error('The data store is busy — another update is in progress. Try again.'); }

  try {
    const ss = getSpreadsheet_();
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
function saveNotesBatch(entries) {
  if (!Array.isArray(entries)) throw new Error('saveNotesBatch expects an array.');
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); }
  catch (e) { throw new Error('The data store is busy — another sync is in progress. Try again shortly.'); }
  try {
    const ss = getSpreadsheet_();
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

/** ---------------------------------------------------------------- SETUP */
/**
 * OPTIONAL. Pre-creates empty data-store sheets with headers so the web app has
 * a structure to show before the first monthly upload. Non-destructive: if a
 * sheet already exists it is left untouched. The monthly upload creates and
 * formats the sheets on its own, so this is only for previewing the structure.
 */
function setupDatastore() {
  const ss = getSpreadsheet_();
  const log = [];
  CONFIG.DATASTORES.forEach(function(d){
    if (ss.getSheetByName(d.sheet)) { log.push('"' + d.sheet + '" already exists — left as is.'); return; }
    const sheet = ss.insertSheet(d.sheet);
    formatHeaderRow_(sheet);
    log.push('Created "' + d.sheet + '" with headers.');
  });
  const msg = 'Setup complete.\n' + log.join('\n') +
    '\n\nUse the Admin panel in the web app to upload a month of counts.';
  Logger.log(msg);
  return msg;
}
