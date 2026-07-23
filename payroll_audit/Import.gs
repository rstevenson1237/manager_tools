/*******************************************************************************
 * Import.gs — CSV upload, driven ENTIRELY from the web app.
 *
 * There is no spreadsheet menu and no container dialog: these functions are
 * called by Index.html via google.script.run, so admins never open the sheet.
 * Every destructive call is guarded by requireAdmin_(propertyId) (defined in
 * Code.gs) so a non-admin viewer — and an admin of a *different* property —
 * cannot wipe data even by invoking the function directly.
 *
 * PERIOD MODEL: each upload is a clean slate for that one datastore (PDP,
 * Toast, or Payments) — the prior period's rows are replaced, not merged,
 * matching the legacy "Payroll Data" spreadsheet menu's per-file uploads. The
 * CSV is validated BEFORE anything is deleted, so a bad file never destroys
 * existing data. Uploading one file does not touch the other two sheets.
 ******************************************************************************/

/** Admin-only (this property). How many data rows each import sheet
 * currently holds. */
function getExistingDataSummary(propertyId) {
  requireAdmin_(propertyId);
  const ss = getSpreadsheetForProperty_(propertyId);
  const sheets = CONFIG.DATASTORES.map(function(d){
    const s = ss.getSheetByName(d.sheet);
    const rows = (s && s.getLastRow() >= FIRST_DATA_ROW) ? (s.getLastRow() - FIRST_DATA_ROW + 1) : 0;
    return { key: d.key, name: d.sheet, label: d.label, rows: rows };
  });
  return { hasData: sheets.some(function(x){ return x.rows > 0; }), sheets: sheets };
}

/** Parse a CSV date/time string the way V8's Date constructor understands
 * (handles Toast's "7/6/2026 7:17 AM" export format and ISO strings alike).
 * Returns null if unparseable so the caller can report which row failed. */
function parseOrderDate_(raw) {
  if (raw instanceof Date) return raw;
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Shared validate-then-replace path for a single CSV upload into one
 * datastore sheet. `rowMapper(csvRow, colIndexByHeader)` returns the array of
 * values to write (in the datastore's own header order), or throws to abort
 * the whole import (nothing is deleted until every row maps cleanly).
 */
function importCsvIntoDatastore_(propertyId, csvContent, datastoreKey, rowMapper) {
  requireAdmin_(propertyId);
  const d = datastoreByKey_(datastoreKey);

  // --- validate first (non-destructive) ---
  const csvRows = Utilities.parseCsv(csvContent);
  if (!csvRows.length) throw new Error('CSV is empty.');

  const csvHeaders = csvRows[0].map(function(h){ return String(h).trim(); });
  const colIndex = {};
  d.headers.forEach(function(h){
    const idx = csvHeaders.findIndex(function(c){ return c.toLowerCase() === h.toLowerCase(); });
    if (idx === -1) {
      throw new Error('Required column "' + h + '" not found in the CSV.\n\nFound columns: ' + csvHeaders.join(', '));
    }
    colIndex[h] = idx;
  });

  const dataRows = [];
  csvRows.slice(1).forEach(function(r, i){
    if (r.every(function(v){ return String(v).trim() === ''; })) return; // skip blank lines
    try {
      dataRows.push(rowMapper(r, colIndex));
    } catch (e) {
      throw new Error('Row ' + (i + 2) + ': ' + (e.message || e));
    }
  });

  if (!dataRows.length) throw new Error('No data rows found in CSV (only headers present).');

  // --- serialize the destructive rebuild ---
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); }
  catch (e) { throw new Error('The data store is busy — another upload is in progress. Try again shortly.'); }
  try {
    const ss = getSpreadsheetForProperty_(propertyId);
    const sheet = recreateDatastoreSheet_(ss, d);
    sheet.getRange(FIRST_DATA_ROW, 1, dataRows.length, d.headers.length).setValues(dataRows);
    SpreadsheetApp.flush();
    return { rows: dataRows.length };
  } finally {
    lock.releaseLock();
  }
}

/** Admin-only. Upload the PDP Payroll Export CSV: Co Code, Employee, Hours, Amount. */
function processPdpCsv(propertyId, csvContent) {
  return importCsvIntoDatastore_(propertyId, csvContent, 'pdp', function(r, col){
    return [
      String(r[col['Co Code']]).trim(),
      String(r[col['Employee']]).trim(),
      Number(r[col['Hours']]) || 0,
      Number(r[col['Amount']]) || 0
    ];
  });
}

/** Admin-only. Upload the Toast Labor Summary CSV: Employee, Job Title,
 * Regular Hours, Overtime Hours. */
function processToastCsv(propertyId, csvContent) {
  return importCsvIntoDatastore_(propertyId, csvContent, 'toast', function(r, col){
    return [
      String(r[col['Employee']]).trim(),
      String(r[col['Job Title']]).trim(),
      Number(r[col['Regular Hours']]) || 0,
      Number(r[col['Overtime Hours']]) || 0
    ];
  });
}

/** Admin-only. Upload the Toast Payments CSV: Order Date, Server, Tip,
 * Gratuity, Status, Type. Order Date is parsed into a real Date so the
 * Business Date bucketing (§ Code.gs businessDate_) is exact. */
function processPaymentsCsv(propertyId, csvContent) {
  return importCsvIntoDatastore_(propertyId, csvContent, 'payments', function(r, col){
    const rawDate = r[col['Order Date']];
    const orderDate = parseOrderDate_(rawDate);
    if (!orderDate) throw new Error('Could not parse Order Date "' + rawDate + '".');
    return [
      orderDate,
      String(r[col['Server']]).trim(),
      Number(r[col['Tip']]) || 0,
      Number(r[col['Gratuity']]) || 0,
      String(r[col['Status']]).trim(),
      String(r[col['Type']]).trim()
    ];
  });
}

/** Admin-only (this property). Remove all three import sheets entirely. They
 * are recreated pristine (with headers) on the next upload — same teardown
 * semantics as inventory_audit's removeAllCountData. */
function removeAllPayrollData(propertyId) {
  requireAdmin_(propertyId);
  const ss = getSpreadsheetForProperty_(propertyId);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    let removed = 0;
    CONFIG.DATASTORES.forEach(function(d){
      const s = ss.getSheetByName(d.sheet);
      if (!s) return;
      ss.deleteSheet(s);
      removed++;
    });
    return { removed: removed };
  } finally {
    lock.releaseLock();
  }
}
