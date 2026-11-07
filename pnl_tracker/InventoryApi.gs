/*******************************************************************************
 * InventoryApi.gs — the inventory review's endpoints. The logic is in
 * Inventory.gs; this file reads and writes the four inventory sheets
 * (Store.gs SHEETS.invCounts / invItems / invNotes / invReports).
 *
 * WHO CAN DO WHAT (Code.gs roleOf_ / canEditInventory_)
 *   read      admins, viewers, inventory reviewers
 *   edit      admins and inventory reviewers: upload counts, write notes,
 *             save reports
 *   remove    admins only (a count, or a saved report)
 *   P&L figures in the report (days on hand) are left out for the
 *   inventory-only role.
 *
 * UPLOADS replace the count in the same slot (property + count name). For
 * the same month (a recount) notes are kept for items still under review;
 * for a new month the old count and its notes go, and only its saved report
 * (if any) stays.
 ******************************************************************************/

/** ------------------------------------------------------------- access */
function inventoryAccess_(ss) {
  const role = roleOf_(ss);
  if (!role) throw noAccessError_();
  return { role: role, canEdit: canEditInventory_(ss, role), seesPnl: role === 'admin' || role === 'viewer' };
}
function requireInventoryAdmin_(ss) {
  if (inventoryAccess_(ss).role !== 'admin') throw new Error('Only an administrator can remove inventory data. You are signed in as ' + currentUserEmail_() + '.');
}
function requireInventoryEditor_(ss) {
  const a = inventoryAccess_(ss);
  if (!a.canEdit) throw new Error('Only an administrator or an inventory reviewer can do this. You are signed in as ' + currentUserEmail_() + '.');
  return a;
}

/**
 * Properties an inventory count can belong to: configured ones (every P&L
 * upload registers its properties there) plus any with a count on file.
 */
function inventoryProperties_(ss, config) {
  const list = (config.properties || []).map(function (p) { return { code: p.code, name: p.name, active: p.active !== false }; });
  const known = {};
  list.forEach(function (p) { known[p.code] = true; });
  readDataRows_(ss, 'invCounts').forEach(function (r) {
    const code = String(r[1]);
    if (!known[code]) { list.push({ code: code, name: code, active: true }); known[code] = true; }
  });
  return list.sort(function (a, b) { return a.name.localeCompare(b.name); });
}

/** ------------------------------------------------------------- reading */
function readInventoryCounts_(ss) {
  return readDataRows_(ss, 'invCounts').map(inventoryCountFromRow_);
}

/** One count's items: one range read, checked against the count ID; a full scan if the layout moved. */
function readInventoryItems_(ss, count) {
  const def = SHEETS.invItems;
  const sheet = ss.getSheetByName(def.name);
  if (!sheet || sheet.getLastRow() < 2) return [];
  if (count.firstRow >= 2 && count.rowCount > 0 && count.firstRow + count.rowCount - 1 <= sheet.getLastRow()) {
    const rows = sheet.getRange(count.firstRow, 1, count.rowCount, def.headers.length).getValues();
    if (rows.every(function (r) { return String(r[0]) === count.id; })) return rows.map(inventoryItemFromRow_);
  }
  return readDataRows_(ss, 'invItems').filter(function (r) { return String(r[0]) === count.id; }).map(inventoryItemFromRow_);
}

function findInventoryCount_(ss, countId) {
  const c = readInventoryCounts_(ss).filter(function (x) { return x.id === String(countId); })[0];
  if (!c) throw new Error('That count is no longer on file. It may have been replaced by a newer upload. Refresh the page.');
  return c;
}

function readInventoryNotes_(ss) { return inventoryNotesByCount_(readDataRows_(ss, 'invNotes')); }

/** P&L month for the report's days on hand: { stage, asOf, lines: {key: amount} } or null. */
function inventoryPnlMonth_(ss, property, period) {
  const store = loadStore_(ss);
  const m = store.actuals[property] && store.actuals[property][period];
  if (!m) return null;
  const lines = {};
  Object.keys(m.lines).forEach(function (k) { lines[k] = m.lines[k].amount; });
  return { stage: m.stage, asOf: m.asOf, lines: lines };
}

/** ------------------------------------------------------------- dashboard */

/** Every count on file with its review progress, the open action items, and the saved reports. */
function getInventoryDashboard() {
  const ss = dataSpreadsheet_();
  const access = inventoryAccess_(ss);
  const config = readConfig_(ss);
  const counts = readInventoryCounts_(ss);
  const notes = readInventoryNotes_(ss);
  const reports = inventoryReportsFromRows_(readInventoryReportMeta_(ss), false);
  const actions = [];
  const rows = counts.map(function (c) {
    const n = notes[c.id] || {};
    const st = { noted: 0, correct: 0, review: 0, adjust: 0, other: 0, openImpact: 0, lastNoteAt: '' };
    Object.keys(n).forEach(function (k) {
      const s = n[k].status || inventoryStatus_(n[k].note);
      st.noted++;
      if (st[s] != null) st[s]++;
      if (n[k].at > st.lastNoteAt) st.lastNoteAt = n[k].at;
      if (s === 'review' || s === 'adjust') {
        st.openImpact += n[k].impact;
        actions.push({ countId: c.id, property: c.property, period: c.period, label: c.label, key: k, note: n[k].note,
          status: s, impact: n[k].impact, by: n[k].by, at: n[k].at });
      }
    });
    const rep = reports[inventoryReportId_(c.property, c.period)];
    const lastChange = [c.uploadedAt, st.lastNoteAt].sort().pop();
    return Object.assign({}, c, { review: st, report: rep ? { savedAt: rep.savedAt, savedBy: rep.savedBy,
      stale: rep.savedAt < lastChange } : null });
  });
  actions.sort(function (a, b) { return (a.status === b.status ? 0 : a.status === 'adjust' ? -1 : 1) || b.impact - a.impact; });
  return safe_({
    canEdit: access.canEdit, isAdmin: access.role === 'admin',
    properties: inventoryProperties_(ss, config),
    noteCategories: config.inventory.noteCategories,
    counts: rows,
    actions: actions,
    reports: Object.keys(reports).map(function (k) { return reports[k]; })
      .sort(function (a, b) { return b.period.localeCompare(a.period) || a.property.localeCompare(b.property); })
  });
}

/** Report metadata only: the first nine columns (the JSON column can be large). */
function readInventoryReportMeta_(ss) {
  const def = SHEETS.invReports;
  const sheet = ss.getSheetByName(def.name);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, def.headers.length - 1).getValues()
    .filter(function (r) { return String(r[0]) && Number(r[8]) === 0; });
}

/** ------------------------------------------------------------- review */

/** One count to review: the items picked for review, their notes, and the note list. */
function getInventoryCount(countId) {
  const ss = dataSpreadsheet_();
  const access = inventoryAccess_(ss);
  const config = readConfig_(ss);
  const count = findInventoryCount_(ss, countId);
  const items = readInventoryItems_(ss, count);
  const tri = triageInventory_(items);
  return safe_({
    count: count, canEdit: access.canEdit,
    totals: inventoryTotals_(items),
    sections: tri.sections, items: tri.items, total: tri.total,
    notes: readInventoryNotes_(ss)[count.id] || {},
    noteCategories: config.inventory.noteCategories
  });
}

/**
 * Save review notes for one count. entries: [{ key, note }] (an empty note
 * removes it). Returns one result per entry, in order, so the page's sync
 * queue keeps any entry that failed instead of dropping it.
 */
function saveInventoryNotes(countId, entries) {
  const ss = dataSpreadsheet_();
  requireInventoryEditor_(ss);
  if (!Array.isArray(entries)) throw new Error('saveInventoryNotes expects a list.');
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); }
  catch (e) { throw new Error('Another save is in progress. Try again in a moment.'); }
  try {
    const count = findInventoryCount_(ss, countId);
    const tri = triageInventory_(readInventoryItems_(ss, count));
    const who = currentUserEmail_() || 'unknown';
    const at = new Date().toISOString();
    const rows = readDataRows_(ss, 'invNotes');
    const index = {};
    rows.forEach(function (r, i) { if (String(r[0]) === count.id) index[String(r[1])] = i; });
    const drop = {};
    const results = entries.map(function (e) {
      const key = String(e && e.key || '');
      const note = String(e && e.note || '').trim();
      if (!tri.items[key]) return { key: key, ok: false, error: 'not under review in the count on file — refresh' };
      const i = index[key];
      if (!note) {
        if (i != null) drop[i] = true;
        return { key: key, ok: true, status: '' };
      }
      const row = [count.id, key, note, inventoryStatus_(note), tri.items[key].impact, who, at];
      if (i != null) { rows[i] = row; delete drop[i]; }
      else { index[key] = rows.length; rows.push(row); }
      return { key: key, ok: true, status: inventoryStatus_(note), by: who, at: at };
    });
    writeDataRows_(ss, 'invNotes', rows.filter(function (r, i) { return !drop[i]; }));
    SpreadsheetApp.flush();
    const mine = rows.filter(function (r, i) { return !drop[i] && String(r[0]) === count.id; });
    return safe_({ results: results, noted: mine.length, total: tri.total });
  } finally {
    lock.releaseLock();
  }
}

/** ------------------------------------------------------------- upload */

function checkInventoryUpload_(property, period, label) {
  property = String(property || '').trim();
  period = String(period || '').slice(0, 7);
  label = normalizeInventoryLabel_(label);
  if (!property) throw new Error('Choose the property this count belongs to.');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error('Choose the month this count closes.');
  if (!label) throw new Error('Give the count a name, for example Food or Beverage.');
  if (label.length > 40) throw new Error('Keep the count name under 40 characters.');
  return { property: property, period: period, label: label };
}

/** Read an upload and work out what it would replace. Writes nothing. */
function inventoryUploadPlan_(ss, csvText, fileName, property, period, label) {
  const parsed = parseInventoryCsv_(Utilities.parseCsv(String(csvText || '')));
  const tri = triageInventory_(parsed.items);
  const totals = inventoryTotals_(parsed.items);
  const counts = readInventoryCounts_(ss);
  const target = checkInventoryUpload_(property, period, label || suggestInventoryLabel_(parsed.items));
  const existing = counts.filter(function (c) { return c.property === target.property && sameInventoryLabel_(c.label, target.label); })[0] || null;
  const plan = { parsed: parsed, triage: tri, totals: totals, target: target, existing: existing, counts: counts,
    keptNotes: {}, droppedNotes: [], continuity: null, duplicateOf: null, reportSaved: false };
  if (existing) {
    const notes = readInventoryNotes_(ss)[existing.id] || {};
    if (existing.period === target.period) {
      const carry = carryInventoryNotes_(notes, tri);
      plan.keptNotes = carry.kept; plan.droppedNotes = carry.dropped;
    } else {
      plan.droppedNotes = Object.keys(notes);
    }
    if (existing.period < target.period) plan.continuity = inventoryContinuity_(readInventoryItems_(ss, existing), parsed.items);
    plan.reportSaved = !!inventoryReportsFromRows_(readInventoryReportMeta_(ss), false)[inventoryReportId_(existing.property, existing.period)];
  }
  // The same file under a second name for the same property and month.
  plan.duplicateOf = counts.filter(function (c) {
    return c !== existing && c.property === target.property && c.period === target.period &&
      c.items === parsed.items.length && Math.abs(c.current - totals.current) < 0.01 && Math.abs(c.previous - totals.previous) < 0.01;
  })[0] || null;
  return plan;
}

/** Inventory editors. What an Inventory Count Item Details CSV holds, and what saving it would replace. */
function previewInventoryUpload(csvText, fileName, property, period, label) {
  const ss = dataSpreadsheet_();
  requireInventoryEditor_(ss);
  const plan = inventoryUploadPlan_(ss, csvText, fileName, property, period, label);
  const e = plan.existing;
  return safe_({
    fileName: String(fileName || ''),
    rows: plan.parsed.rows, warnings: plan.parsed.warnings, tieOuts: plan.parsed.tieOuts,
    totals: plan.totals,
    suggestedLabel: suggestInventoryLabel_(plan.parsed.items),
    target: plan.target,
    accounts: inventoryAccountMix_(plan.parsed.items),
    review: { total: plan.triage.total, sections: plan.triage.sections.map(function (s) { return { key: s.key, label: s.label, items: s.keys.length }; }) },
    existing: e ? { id: e.id, period: e.period, label: e.label, uploadedAt: e.uploadedAt, uploadedBy: e.uploadedBy, current: e.current,
      sameMonth: e.period === plan.target.period, olderThanUpload: e.period > plan.target.period } : null,
    keptNotes: Object.keys(plan.keptNotes).length, droppedNotes: plan.droppedNotes.slice(0, 20), droppedCount: plan.droppedNotes.length,
    reportSaved: plan.reportSaved,
    continuity: plan.continuity,
    duplicateOf: plan.duplicateOf ? { label: plan.duplicateOf.label, period: plan.duplicateOf.period } : null
  });
}

function inventoryAccountMix_(items) {
  const by = {};
  items.forEach(function (it) {
    const k = it.inventoryAcct || 'No inventory account';
    const a = by[k] = by[k] || { name: k, items: 0, value: 0 };
    a.items++; a.value += it.curTotal;
  });
  return Object.keys(by).map(function (k) { by[k].value = round2Inv_(by[k].value); return by[k]; })
    .sort(function (a, b) { return b.value - a.value; });
}

/** Inventory editors. Save the count, replacing the one in the same slot. */
function commitInventoryUpload(csvText, fileName, property, period, label) {
  const ss = dataSpreadsheet_();
  requireInventoryEditor_(ss);
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); }
  catch (e) { throw new Error('Another upload is being saved. Try again in a moment.'); }
  try {
    const plan = inventoryUploadPlan_(ss, csvText, fileName, property, period, label);
    if (plan.duplicateOf) {
      throw new Error('Not saved: this file is identical to the ' + plan.duplicateOf.label + ' count already on file for ' +
        plan.target.property + ' ' + plan.target.period + '.');
    }
    if (plan.existing && plan.existing.period > plan.target.period) {
      throw new Error('Not saved: the ' + plan.existing.label + ' count on file is for ' + plan.existing.period +
        ', later than ' + plan.target.period + '. Remove it first if this older count should replace it.');
    }
    const at = new Date().toISOString(), who = currentUserEmail_();
    const count = { id: Utilities.getUuid().slice(0, 8), property: plan.target.property, period: plan.target.period,
      label: plan.target.label, file: String(fileName || ''), uploadedAt: at, uploadedBy: who, items: plan.parsed.rows,
      current: plan.totals.current, previous: plan.totals.previous, reviewItems: plan.triage.total };
    const replaced = plan.existing ? plan.existing.id : null;
    writeInventoryLayout_(ss, plan.counts.filter(function (c) { return c.id !== replaced; }), count, plan.parsed.items);

    const noteRows = readDataRows_(ss, 'invNotes').filter(function (r) { return String(r[0]) !== replaced; });
    Object.keys(plan.keptNotes).forEach(function (k) {
      const n = plan.keptNotes[k];
      noteRows.push([count.id, k, n.note, inventoryStatus_(n.note), plan.triage.items[k].impact, n.by, n.at]);
    });
    writeDataRows_(ss, 'invNotes', noteRows);
    appendDataRow_(ss, 'uploads', [count.id, at, who, count.file, 'inventory', '', count.period, count.property,
      count.items, count.label + (replaced ? ' (replaced ' + plan.existing.period + ')' : '')]);
    SpreadsheetApp.flush();
    return safe_({ countId: count.id, property: count.property, period: count.period, label: count.label,
      items: count.items, reviewItems: count.reviewItems, keptNotes: Object.keys(plan.keptNotes).length });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Rewrite Inventory Items with each count's rows together, then Inventory
 * Counts with where each count now starts. `add` / `addItems` is the new
 * count (or null to only drop counts).
 */
function writeInventoryLayout_(ss, keep, add, addItems) {
  const allRows = readDataRows_(ss, 'invItems');
  const byCount = {};
  allRows.forEach(function (r) { (byCount[String(r[0])] = byCount[String(r[0])] || []).push(r); });
  const groups = keep.map(function (c) { return { count: c, rows: byCount[c.id] || [] }; });
  if (add) groups.push({ count: add, rows: addItems.map(function (it) { return inventoryItemRow_(add.id, it); }) });
  writeDataRows_(ss, 'invItems', layoutInventoryItems_(groups));
  writeDataRows_(ss, 'invCounts', groups.map(function (g) { return inventoryCountRow_(g.count); }));
}

/** Admin. Remove a count and its notes. Its saved report, if any, stays. */
function removeInventoryCount(countId) {
  const ss = dataSpreadsheet_();
  requireInventoryAdmin_(ss);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const counts = readInventoryCounts_(ss);
    if (!counts.some(function (c) { return c.id === String(countId); })) return { removed: false };
    writeInventoryLayout_(ss, counts.filter(function (c) { return c.id !== String(countId); }), null, null);
    writeDataRows_(ss, 'invNotes', readDataRows_(ss, 'invNotes').filter(function (r) { return String(r[0]) !== String(countId); }));
    return { removed: true };
  } finally {
    lock.releaseLock();
  }
}

/** ------------------------------------------------------------- report */

/**
 * The inventory report for a property and month. Built from the counts on
 * file when there are any; otherwise the saved copy. Both are returned when
 * both exist, so the page can show when the saved copy was made.
 */
function getInventoryReport(property, period) {
  const ss = dataSpreadsheet_();
  const access = inventoryAccess_(ss);
  property = String(property); period = String(period).slice(0, 7);
  const saved = inventorySavedReport_(ss, property, period);
  const live = buildLiveInventoryReport_(ss, access, property, period, saved && saved.report ? saved.report.summary : '');
  return safe_({
    canEdit: access.canEdit, isAdmin: access.role === 'admin',
    report: live || (saved && saved.report) || null,
    live: !!live,
    saved: saved ? { savedAt: saved.savedAt, savedBy: saved.savedBy, summary: saved.report ? saved.report.summary : '' } : null
  });
}

function buildLiveInventoryReport_(ss, access, property, period, summary) {
  const counts = readInventoryCounts_(ss).filter(function (c) { return c.property === property && c.period === period; })
    .sort(function (a, b) { return a.label.localeCompare(b.label); });
  if (!counts.length) return null;
  const notes = readInventoryNotes_(ss);
  const report = buildInventoryReport_({
    property: property, period: period, summary: summary || '',
    counts: counts.map(function (c) {
      return { id: c.id, label: c.label, period: c.period, file: c.file, uploadedAt: c.uploadedAt, uploadedBy: c.uploadedBy,
        items: readInventoryItems_(ss, c), notes: notes[c.id] || {} };
    }),
    pnl: access.seesPnl ? inventoryPnlMonth_(ss, property, period) : null
  });
  report.generatedAt = new Date().toISOString();
  return report;
}

function inventorySavedReport_(ss, property, period) {
  const id = inventoryReportId_(property, period);
  const rows = readDataRows_(ss, 'invReports').filter(function (r) { return String(r[0]) === id; });
  if (!rows.length) return null;
  return inventoryReportsFromRows_(rows, true)[id] || null;
}

/** Inventory editors. Save the report for a property and month, with the manager's summary. Replaces an earlier save. */
function saveInventoryReport(property, period, summary) {
  const ss = dataSpreadsheet_();
  const access = requireInventoryEditor_(ss);
  property = String(property); period = String(period).slice(0, 7);
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); }
  catch (e) { throw new Error('Another save is in progress. Try again in a moment.'); }
  try {
    // Saved reports carry the P&L comparison when whoever saves may see it.
    const report = buildLiveInventoryReport_(ss, access, property, period, String(summary || '').slice(0, 5000));
    if (!report) throw new Error('No counts are on file for this property and month.');
    const meta = { at: new Date().toISOString(), by: currentUserEmail_() };
    report.savedAt = meta.at; report.savedBy = meta.by;
    const id = inventoryReportId_(property, period);
    const rows = readDataRows_(ss, 'invReports').filter(function (r) { return String(r[0]) !== id; });
    writeDataRows_(ss, 'invReports', rows.concat(inventoryReportRows_(id, report, meta)));
    SpreadsheetApp.flush();
    return safe_({ savedAt: meta.at, savedBy: meta.by });
  } finally {
    lock.releaseLock();
  }
}

/** Admin. Delete a saved report. */
function removeInventoryReport(property, period) {
  const ss = dataSpreadsheet_();
  requireInventoryAdmin_(ss);
  const id = inventoryReportId_(String(property), String(period).slice(0, 7));
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    writeDataRows_(ss, 'invReports', readDataRows_(ss, 'invReports').filter(function (r) { return String(r[0]) !== id; }));
    return { removed: true };
  } finally {
    lock.releaseLock();
  }
}
