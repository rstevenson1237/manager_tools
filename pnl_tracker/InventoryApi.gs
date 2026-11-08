/*******************************************************************************
 * InventoryApi.gs — the regional inventory check's endpoints. The logic is in
 * InventoryRules.gs (shared with inventory_audit) and InventoryCheck.gs; this
 * file reads and writes the two inventory sheets (Store.gs SHEETS.invChecks /
 * invFlags).
 *
 * WHO CAN DO WHAT (Code.gs roleOf_ / canEditInventory_)
 *   read      admins, viewers, inventory reviewers
 *   upload    admins and inventory reviewers
 *   remove    admins only
 *   P&L figures in the report (days on hand) are left out for the
 *   inventory-only role.
 *
 * UPLOADS. Property + count name + month is one check; uploading it again
 * replaces it (the store fixed things in R365 and the count was exported
 * again). Writes add rows at the end; only a replacement rewrites the sheets.
 ******************************************************************************/

/** ------------------------------------------------------------- access */
function inventoryAccess_(ss) {
  const role = roleOf_(ss);
  if (!role) throw noAccessError_();
  return { role: role, canEdit: canEditInventory_(ss, role), seesPnl: role === 'admin' || role === 'viewer' };
}
function requireInventoryAdmin_(ss) {
  if (inventoryAccess_(ss).role !== 'admin') throw new Error('Only an administrator can remove inventory checks. You are signed in as ' + currentUserEmail_() + '.');
}
function requireInventoryEditor_(ss) {
  const a = inventoryAccess_(ss);
  if (!a.canEdit) throw new Error('Only an administrator or an inventory reviewer can upload counts. You are signed in as ' + currentUserEmail_() + '.');
  return a;
}

/**
 * Properties a count can belong to: configured ones (every P&L upload
 * registers its properties there) plus any with a check on file.
 */
function inventoryProperties_(ss, config) {
  const list = (config.properties || []).map(function (p) { return { code: p.code, name: p.name, active: p.active !== false }; });
  const known = {};
  list.forEach(function (p) { known[p.code] = true; });
  readInventoryChecks_(ss).forEach(function (c) {
    if (!known[c.property]) { list.push({ code: c.property, name: c.property, active: true }); known[c.property] = true; }
  });
  return list.sort(function (a, b) { return a.name.localeCompare(b.name); });
}

/** ------------------------------------------------------------- reading */
function readInventoryChecks_(ss) {
  return readDataRows_(ss, 'invChecks').map(inventoryCheckFromRow_);
}

/** Flags of the given counts: { countId: flags[] }. */
function readInventoryFlags_(ss, countIds) {
  const want = {};
  countIds.forEach(function (id) { want[id] = []; });
  readDataRows_(ss, 'invFlags').forEach(function (r) {
    const id = String(r[0]);
    if (want[id]) want[id].push(inventoryFlagFromRow_(r));
  });
  return want;
}

/** The latest check before `period` in the same slot, or null. */
function checkBefore_(checks, property, label, period) {
  return checks.filter(function (c) { return c.property === property && sameInventoryLabel_(c.label, label) && c.period < period; })
    .sort(function (a, b) { return b.period.localeCompare(a.period); })[0] || null;
}

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

/** Every check on file, newest month first, with what it found. */
function getInventoryDashboard() {
  const ss = dataSpreadsheet_();
  const access = inventoryAccess_(ss);
  const config = readConfig_(ss);
  const checks = readInventoryChecks_(ss).map(function (c) {
    const out = Object.assign({}, c);
    delete out.summary;
    out.notCounted = c.summary.notCounted ? c.summary.notCounted.items : 0;
    return out;
  });
  return safe_({
    canEdit: access.canEdit, isAdmin: access.role === 'admin',
    highImpact: INV_RULES.highImpact,
    properties: inventoryProperties_(ss, config),
    checks: checks.sort(function (a, b) { return b.period.localeCompare(a.period) || a.property.localeCompare(b.property) || a.label.localeCompare(b.label); })
  });
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

/** Read an upload and work out what it would replace and how it compares with the month before. Writes nothing. */
function inventoryUploadPlan_(ss, csvText, fileName, property, period, label) {
  const parsed = parseInventoryCsv_(Utilities.parseCsv(String(csvText || '')));
  const target = checkInventoryUpload_(property, period, label || suggestInventoryLabel_(parsed.items));
  const checks = readInventoryChecks_(ss);
  const existing = checks.filter(function (c) {
    return c.property === target.property && c.period === target.period && sameInventoryLabel_(c.label, target.label);
  })[0] || null;
  const built = buildInventoryCheck_(parsed, { id: '', property: target.property, period: target.period, label: target.label,
    file: String(fileName || '') });
  const now = { check: built.check, flags: built.flags.map(function (f) { return inventoryFlagFromRow_(inventoryFlagRow_('', f)); }) };
  const prev = checkBefore_(checks, target.property, target.label, target.period);
  const before = prev ? { check: prev, flags: readInventoryFlags_(ss, [prev.id])[prev.id] } : null;
  // The same export filed under a second name, or for a second property.
  const duplicateOf = checks.filter(function (c) {
    return c !== existing && c.period === target.period && c.items === parsed.items.length &&
      Math.abs(c.current - built.check.current) < 0.01 && Math.abs(c.previous - built.check.previous) < 0.01;
  })[0] || null;
  return { parsed: parsed, target: target, existing: existing, built: built, now: now,
    compare: compareInventoryChecks_(now, before), duplicateOf: duplicateOf };
}

/**
 * Inventory editors. What an export holds, what it would replace, and what
 * the check finds: the high-impact items, the follow-on check against last
 * month, and the tie-out.
 */
function previewInventoryUpload(csvText, fileName, property, period, label) {
  const ss = dataSpreadsheet_();
  requireInventoryEditor_(ss);
  const plan = inventoryUploadPlan_(ss, csvText, fileName, property, period, label);
  const c = plan.built.check;
  return safe_({
    fileName: String(fileName || ''),
    rows: plan.parsed.rows, warnings: plan.parsed.warnings, tieOuts: plan.parsed.tieOuts,
    suggestedLabel: suggestInventoryLabel_(plan.parsed.items),
    target: plan.target,
    totals: { current: c.current, previous: c.previous, change: round2Inv_(c.current - c.previous), priceEffect: c.priceEffect, qtyEffect: c.qtyEffect },
    picked: c.picked, highImpact: c.highImpact, highImpactValue: c.highImpactValue,
    top: plan.now.flags.filter(function (f) { return f.impact >= INV_RULES.highImpact; }).slice(0, 5)
      .map(function (f) { return { item: f.item, impact: f.impact, reason: f.reasons[0] || '' }; }),
    follows: plan.compare.follows,
    existing: plan.existing ? { id: plan.existing.id, uploadedAt: plan.existing.uploadedAt, uploadedBy: plan.existing.uploadedBy,
      highImpact: plan.existing.highImpact } : null,
    duplicateOf: plan.duplicateOf ? { property: plan.duplicateOf.property, period: plan.duplicateOf.period, label: plan.duplicateOf.label } : null
  });
}

/** Inventory editors. Save the check, replacing one for the same property, count name and month. */
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
        plan.duplicateOf.property + ' ' + plan.duplicateOf.period + '.');
    }
    const at = new Date().toISOString(), who = currentUserEmail_();
    const check = Object.assign({}, plan.built.check, { id: Utilities.getUuid().slice(0, 8), uploadedAt: at, uploadedBy: who });
    const flagRows = plan.built.flags.map(function (f) { return inventoryFlagRow_(check.id, f); });
    if (plan.existing) {
      const id = plan.existing.id;
      writeDataRows_(ss, 'invChecks', readDataRows_(ss, 'invChecks').filter(function (r) { return String(r[0]) !== id; }).concat([inventoryCheckRow_(check)]));
      writeDataRows_(ss, 'invFlags', readDataRows_(ss, 'invFlags').filter(function (r) { return String(r[0]) !== id; }).concat(flagRows));
    } else {
      appendDataRows_(ss, 'invChecks', [inventoryCheckRow_(check)]);
      appendDataRows_(ss, 'invFlags', flagRows);
    }
    appendDataRow_(ss, 'uploads', [check.id, at, who, check.file, 'inventory', '', check.period, check.property,
      check.items, check.label + (plan.existing ? ' (replaced ' + plan.existing.uploadedAt.slice(0, 10) + ')' : '')]);
    SpreadsheetApp.flush();
    return safe_({ countId: check.id, property: check.property, period: check.period, label: check.label,
      items: check.items, picked: check.picked, highImpact: check.highImpact, replaced: !!plan.existing });
  } finally {
    lock.releaseLock();
  }
}

/** Admin. Remove a check and its flags. */
function removeInventoryCount(countId) {
  const ss = dataSpreadsheet_();
  requireInventoryAdmin_(ss);
  const id = String(countId);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const rows = readDataRows_(ss, 'invChecks');
    if (!rows.some(function (r) { return String(r[0]) === id; })) return { removed: false };
    writeDataRows_(ss, 'invChecks', rows.filter(function (r) { return String(r[0]) !== id; }));
    writeDataRows_(ss, 'invFlags', readDataRows_(ss, 'invFlags').filter(function (r) { return String(r[0]) !== id; }));
    return { removed: true };
  } finally {
    lock.releaseLock();
  }
}

/** ------------------------------------------------------------- report */

/** The check report for a property and month: every count on file for it, compared with the month before. */
function getInventoryReport(property, period) {
  const ss = dataSpreadsheet_();
  const access = inventoryAccess_(ss);
  property = String(property); period = String(period).slice(0, 7);
  const checks = readInventoryChecks_(ss);
  const mine = checks.filter(function (c) { return c.property === property && c.period === period; })
    .sort(function (a, b) { return a.label.localeCompare(b.label); });
  if (!mine.length) return safe_({ report: null, canEdit: access.canEdit, isAdmin: access.role === 'admin' });
  const befores = mine.map(function (c) { return checkBefore_(checks, c.property, c.label, c.period); });
  const ids = mine.map(function (c) { return c.id; }).concat(befores.filter(Boolean).map(function (c) { return c.id; }));
  const flags = readInventoryFlags_(ss, ids);
  const report = buildInventoryCheckReport_({
    property: property, period: period,
    counts: mine.map(function (c, i) {
      const now = { check: c, flags: flags[c.id] };
      const b = befores[i];
      return { check: c, flags: flags[c.id], compare: compareInventoryChecks_(now, b ? { check: b, flags: flags[b.id] } : null) };
    }),
    pnl: access.seesPnl ? inventoryPnlMonth_(ss, property, period) : null
  });
  return safe_({ report: report, canEdit: access.canEdit, isAdmin: access.role === 'admin' });
}
