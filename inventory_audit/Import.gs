/*******************************************************************************
 * Import.gs — monthly count upload, driven ENTIRELY from the web app.
 *
 * There is no spreadsheet menu and no container dialog: these functions are
 * called by Index.html via google.script.run, so admins never open the sheet.
 * Every call is guarded by requireAdmin_(propertyId) (defined in Code.gs) so
 * a non-admin — and an admin of a *different* property — cannot replace or
 * wipe data even by invoking the function directly.
 *
 * ONE FILE, ONE TABLE. R365's Inventory Count Item Details export is read with
 * InventoryRules.gs. A Beverage count goes to the Beverage table whole, food-
 * coded ingredients included (accounts are company-wide, so a bar's cocktail
 * ingredients are coded to food). Likewise a Food count. Only a full count
 * (no clear majority) is split, by inventory account. Tables the file does
 * not cover are left alone.
 *
 * WHAT HAPPENS TO NOTES depends on how the file relates to the count on file
 * (inventoryRelation_):
 *   next       last month's count: replaced, notes and all (a clean slate)
 *   recount    the same count again (fixed in R365 and re-exported): notes
 *              carry over for items still picked for review
 *   unrelated  neither: the preview warns (files out of order, the wrong
 *              property, a count changed after it was reviewed). Saving
 *              replaces the table and its notes.
 * Nothing is written by the preview, and a file that cannot be read never
 * touches the existing data.
 ******************************************************************************/

/** Which tables a parsed export fills: { datastoreKey: items[] }. */
function splitUpload_(items) {
  const kind = suggestInventoryLabel_(items);
  if (kind === 'Beverage') return { kind: kind, parts: { beverage: items } };
  if (kind === 'Food') return { kind: kind, parts: { food: items } };
  const parts = { beverage: [], food: [] };
  items.forEach(function(it){ (/food/i.test(it.inventoryAcct) ? parts.food : parts.beverage).push(it); });
  if (!parts.food.length) delete parts.food;
  if (!parts.beverage.length) delete parts.beverage;
  return { kind: kind, parts: parts };
}

/** Read an upload and work out, per table, what it replaces. Writes nothing. */
function uploadPlan_(ss, csvContent) {
  const parsed = parseInventoryCsv_(Utilities.parseCsv(String(csvContent || '')));
  const split = splitUpload_(parsed.items);
  const tables = Object.keys(split.parts).map(function(key){
    const d = datastoreByKey_(key);
    const items = split.parts[key];
    const tri = triageInventory_(items);
    const existing = readItems_(ss.getSheetByName(d.sheet));
    const t = { key: key, label: d.label, sheet: d.sheet, items: items, triage: tri, totals: inventoryTotals_(items),
      existing: existing.length ? { items: existing.length, totals: inventoryTotals_(existing), upload: readUploadInfo_(ss, d),
        notes: existing.filter(function(it){ return it.note; }).length } : null,
      relation: null, keptNotes: {}, lostNotes: 0 };
    if (existing.length) {
      t.relation = inventoryRelation_(existing, items);
      existing.forEach(function(it){
        if (!it.note) return;
        if (t.relation.relation === 'recount' && tri.items[it.key]) t.keptNotes[it.key] = it;
        else t.lostNotes++;
      });
    }
    return t;
  });
  return { parsed: parsed, kind: split.kind, tables: tables };
}

/**
 * Admin-only (this property). What an export holds and what saving it would
 * replace: checks, totals, the review list's size, and what happens to notes.
 */
function previewUpload(propertyId, csvContent, fileName) {
  requireAdmin_(propertyId);
  const ss = getSpreadsheetForProperty_(propertyId);
  const plan = uploadPlan_(ss, csvContent);
  return JSON.parse(JSON.stringify({
    fileName: String(fileName || ''),
    rows: plan.parsed.rows, tieOuts: plan.parsed.tieOuts, warnings: plan.parsed.warnings, kind: plan.kind,
    tables: plan.tables.map(function(t){
      return {
        key: t.key, label: t.label, items: t.items.length, totals: t.totals,
        review: { total: t.triage.total, highImpact: highImpactItems_(t.triage).length,
          sections: t.triage.sections.map(function(s){ return { key: s.key, label: s.label, items: s.keys.length }; }) },
        existing: t.existing, relation: t.relation,
        keptNotes: Object.keys(t.keptNotes).length, lostNotes: t.lostNotes
      };
    })
  }));
}

/** Admin-only (this property). Save the export, replacing the tables it covers. */
function commitUpload(propertyId, csvContent, fileName) {
  requireAdmin_(propertyId);
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); }
  catch (e) { throw new Error('Another upload is being saved. Try again in a moment.'); }
  try {
    const ss = getSpreadsheetForProperty_(propertyId);
    const plan = uploadPlan_(ss, csvContent);
    const info = { file: String(fileName || ''), at: new Date().toISOString(), by: currentUserEmail_() };
    const out = { tables: [] };
    plan.tables.forEach(function(t){
      const sheet = recreateDatastoreSheet_(ss, t.sheet);
      const rows = t.items.map(function(it){
        const kept = t.keptNotes[it.key];
        return [it.item, it.uom, it.curQty, it.curCost, it.curTotal, it.prevQty, it.prevCost, it.prevTotal, it.adjustment,
          it.costAcct, it.inventoryAcct, it.flag, kept ? kept.note : '', kept ? kept.reviewedBy : '', kept ? kept.reviewedAt : ''];
      });
      if (rows.length) sheet.getRange(FIRST_DATA_ROW, 1, rows.length, DATASTORE_HEADERS.length).setValues(rows);
      writeUploadInfo_(ss, datastoreByKey_(t.key), info);
      out.tables.push({ key: t.key, label: t.label, items: rows.length, review: t.triage.total, keptNotes: Object.keys(t.keptNotes).length });
    });
    SpreadsheetApp.flush();
    return out;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Admin-only (this property). Empty both Count Details sheets (header only).
 * The sheets are recreated rather than deleted: a workbook cannot be left
 * with only the hidden `_Config` sheet.
 */
function removeAllCountData(propertyId) {
  requireAdmin_(propertyId);
  const ss = getSpreadsheetForProperty_(propertyId);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    let removed = 0;
    CONFIG.DATASTORES.forEach(function(d){
      const s = ss.getSheetByName(d.sheet);
      if (s && s.getLastRow() >= FIRST_DATA_ROW) removed++;
      recreateDatastoreSheet_(ss, d.sheet);
      writeUploadInfo_(ss, d, null);
    });
    return { removed: removed };
  } finally {
    lock.releaseLock();
  }
}
