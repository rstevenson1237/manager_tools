/*******************************************************************************
 * Import.gs — monthly count upload, driven ENTIRELY from the web app.
 *
 * There is no spreadsheet menu and no container dialog: these functions are
 * called by Index.html via google.script.run, so admins never open the sheet.
 * Every destructive call is guarded by requireAdmin_() (defined in Code.gs) so
 * a non-admin viewer cannot wipe data even by invoking the function directly.
 *
 * MONTHLY MODEL: each upload is a clean slate — last month's data and notes are
 * replaced, not merged. The CSV is validated BEFORE anything is deleted, so a
 * bad file never destroys the existing month.
 ******************************************************************************/

// CSV → data-store columns (the first 12 DATASTORE_HEADERS, defined in Code.gs).
const IMPORT_SOURCE_HEADERS = [
  'Item', 'UofM', 'Current Qty', 'Current $ Cost', 'Current $ Total',
  'Previous Qty', 'Prev $ Cost', 'Prev $ Total', 'Adjustment',
  'Cost Acct', 'Inventory Acct', 'Flag'
];

/** Admin-only. How many data rows each Count Details sheet currently holds. */
function getExistingDataSummary() {
  requireAdmin_();
  const ss = getSpreadsheet_();
  const sheets = CONFIG.DATASTORES.map(function(d){
    const s = ss.getSheetByName(d.sheet);
    const rows = (s && s.getLastRow() >= FIRST_DATA_ROW) ? (s.getLastRow() - FIRST_DATA_ROW + 1) : 0;
    return { name: d.sheet, label: d.label, rows: rows };
  });
  return { hasData: sheets.some(function(x){ return x.rows > 0; }), sheets: sheets };
}

/**
 * Admin-only. Parse + validate the CSV, then wipe and rebuild both sheets with
 * the new data. Validation happens first — a malformed CSV deletes nothing.
 * @return {Object} { beverage, food } row counts written.
 */
function processCSVData(csvContent) {
  requireAdmin_();

  // --- validate first (non-destructive) ---
  const rows = Utilities.parseCsv(csvContent);
  if (!rows.length) throw new Error('CSV is empty.');

  const csvHeaders = rows[0].map(function(h){ return String(h).trim(); });
  const map = IMPORT_SOURCE_HEADERS.map(function(h){
    const idx = csvHeaders.findIndex(function(c){ return c.toLowerCase() === h.toLowerCase(); });
    if (idx === -1) throw new Error('Required column "' + h + '" not found in the CSV.');
    return idx;
  });
  const invAcctPos = IMPORT_SOURCE_HEADERS.indexOf('Inventory Acct');

  const food = [], bev = [];
  rows.slice(1).forEach(function(r){
    if (r.every(function(v){ return String(v).trim() === ''; })) return; // skip blank lines
    const mapped = map.map(function(i){ const v = r[i]; return typeof v === 'string' ? v.trim() : v; });
    if (String(mapped[invAcctPos]).trim() === 'Food Inventory') food.push(mapped);
    else bev.push(mapped);
  });

  // --- serialize the destructive rebuild ---
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const bevSheet  = recreateDatastoreSheet_('Beverage Count Details');
    const foodSheet = recreateDatastoreSheet_('Food Count Details');
    if (bev.length)  bevSheet.getRange(FIRST_DATA_ROW, 1, bev.length, IMPORT_SOURCE_HEADERS.length).setValues(bev);
    if (food.length) foodSheet.getRange(FIRST_DATA_ROW, 1, food.length, IMPORT_SOURCE_HEADERS.length).setValues(food);
    SpreadsheetApp.flush();
    return { beverage: bev.length, food: food.length };
  } finally {
    lock.releaseLock();
  }
}

/** Admin-only. Remove both Count Details sheets entirely. */
function removeAllCountData() {
  requireAdmin_();
  const ss = getSpreadsheet_();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    let removed = 0;
    CONFIG.DATASTORES.forEach(function(d){
      const s = ss.getSheetByName(d.sheet);
      if (!s) return;
      if (ss.getSheets().length === 1) ss.insertSheet('Sheet1'); // never leave zero sheets
      ss.deleteSheet(s);
      removed++;
    });
    return { removed: removed };
  } finally {
    lock.releaseLock();
  }
}
