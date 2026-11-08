/*******************************************************************************
 * InventoryCheck.gs — the regional manager's blind check of a property's
 * inventory count. Plain JavaScript with no Apps Script services, so the Node
 * tests run it. InventoryApi.gs holds the endpoints.
 *
 * THE WORKFLOW. Each store team reviews its count in inventory_audit and
 * fixes what is wrong in R365. The regional manager then exports the same
 * Inventory Count Item Details and uploads it here, without the store's
 * notes. The same rules (InventoryRules.gs) pick the items again; anything
 * still worth $1,000 or more (INV_RULES.highImpact) is a question for the
 * store manager. On a properly audited count that list is short (under 10).
 *
 * WHAT IS KEPT per count: one row in Inventory Checks (totals, the price /
 * quantity split, the checks, value by account and by P&L line) and the
 * items the rules picked (about 50) in Inventory Flags. The other items of
 * the export are read and dropped. Last month's flags are what the report
 * compares with: an item picked again, a swing that reverses last month's,
 * a count that does not follow last month's.
 *
 * A COUNT is one export: one property, one month, one count name ("Food",
 * "Beverage", "Full count" …). Property + count name + month is unique:
 * uploading it again replaces it (a recount after fixes).
 ******************************************************************************/

/** Inventory account → the P&L cost of sales line it feeds. Tested on the inventory account, then the cost account. */
/** How far this file's previous total may be from last month's count and still follow it: the larger of the two. */
const INV_CHECK_RULES = { followTolerance: 50, followTolerancePct: 0.005 };

const INV_PNL_LINES = [
  { key: '5002', name: 'Food', test: /food/i },
  { key: '5300', name: 'Liquor', test: /liquor|spirit/i, parent: '5185' },
  { key: '5500', name: 'Wine', test: /wine/i, parent: '5185' },
  { key: '5400', name: 'Beer', test: /beer/i, parent: '5185' },
  { key: '5190', name: 'NA beverage', test: /soft|n\.?a\.? bev|non.?alc/i }
];

/* ---------------------------------------------------------------- one count */

/**
 * Check one parsed export.
 * @param {Object} parsed  parseInventoryCsv_ result
 * @param {Object} meta    { id, property, period, label, file, uploadedAt, uploadedBy }
 * @return {{ check: Object, flags: Object[] }}  check is one Inventory Checks row's worth;
 *   flags are the picked items (sections, reasons, effects, impact)
 */
function buildInventoryCheck_(parsed, meta, rules) {
  rules = Object.assign({}, INV_RULES, rules || {});
  const items = parsed.items;
  const tri = triageInventory_(items, rules);
  const totals = inventoryTotals_(items);
  const accounts = {}, pnl = {};
  let stocked = 0, counted = 0, zeroCost = 0;
  const notCounted = { items: 0, value: 0 }, wentToZero = { items: 0, value: 0 };
  items.forEach(function (it) {
    const e = inventoryEffects_(it);
    if (it.curQty > 0 || it.prevQty > 0) stocked++;
    if (it.curQty > 0) counted++;
    if (it.curQty > 0 && it.curCost === 0) zeroCost++;
    if (/assumed\s*0/i.test(it.flag)) { notCounted.items++; notCounted.value += it.prevTotal; }
    else if (it.curQty === 0 && it.prevQty > 0) { wentToZero.items++; wentToZero.value += it.prevTotal; }
    const a = accounts[it.inventoryAcct || 'No inventory account'] = accounts[it.inventoryAcct || 'No inventory account'] || {};
    const l = a[it.costAcct || 'No cost account'] = a[it.costAcct || 'No cost account'] || [0, 0, 0, 0];
    l[0] += it.curTotal; l[1] += it.prevTotal; l[2] += e.priceEffect; if (it.curQty > 0 || it.prevQty > 0) l[3]++;
    const line = inventoryPnlLine_(it);
    const g = pnl[line ? line.key : ''] = pnl[line ? line.key : ''] || [0, 0];
    g[0] += it.curTotal; g[1] += it.prevTotal;
  });
  const r2 = function (list) { return list.map(round2Inv_); };
  Object.keys(accounts).forEach(function (a) { Object.keys(accounts[a]).forEach(function (c) { accounts[a][c] = r2(accounts[a][c]); }); });
  Object.keys(pnl).forEach(function (k) { pnl[k] = r2(pnl[k]); });
  const sections = {};
  tri.sections.forEach(function (s) { sections[s.key] = s.keys.length; });
  const flags = Object.keys(tri.items).map(function (k) { return tri.items[k]; })
    .sort(function (a, b) { return b.impact - a.impact || a.key.localeCompare(b.key); });
  const high = flags.filter(function (f) { return f.impact >= rules.highImpact; });
  const check = Object.assign({}, meta, {
    items: items.length, stocked: stocked, current: totals.current, previous: totals.previous,
    priceEffect: totals.priceEffect, qtyEffect: totals.qtyEffect, tieOuts: parsed.tieOuts || 0,
    picked: flags.length, highImpact: high.length,
    highImpactValue: round2Inv_(high.reduce(function (s, f) { return s + f.impact; }, 0)),
    summary: { counted: counted, zeroCost: zeroCost,
      notCounted: { items: notCounted.items, value: round2Inv_(notCounted.value) },
      wentToZero: { items: wentToZero.items, value: round2Inv_(wentToZero.value) },
      sections: sections, accounts: accounts, pnl: pnl }
  });
  return { check: check, flags: flags };
}

/** The P&L line an item's account feeds, or null (supplies and the like). */
function inventoryPnlLine_(it) {
  const a = String(it.inventoryAcct || ''), c = String(it.costAcct || '');
  for (let i = 0; i < INV_PNL_LINES.length; i++) if (INV_PNL_LINES[i].test.test(a)) return INV_PNL_LINES[i];
  for (let i = 0; i < INV_PNL_LINES.length; i++) if (INV_PNL_LINES[i].test.test(c)) return INV_PNL_LINES[i];
  return null;
}

/* ------------------------------------------------------- against last month */

/**
 * Compare a count with the one before it in the same slot (property + count
 * name): does it follow on, and what do last month's flags say about this
 * month's? `before` is { check, flags } or null.
 * @return {{ follows: { status: 'follows'|'differs'|'gap'|'first', … }, history: { key: text } }}
 *   follows.status  follows: this file's previous total is last month's current total, give
 *                            or take a small edit since (changedBy, items, examples say what)
 *                   differs: far from it (files out of order, the wrong property or month)
 *                   gap:     the count before is older than the month before
 *                   first:   nothing on file before this count
 */
function compareInventoryChecks_(now, before, rules) {
  rules = Object.assign({}, INV_RULES, INV_CHECK_RULES, rules || {});
  if (!before) return { follows: { status: 'first' }, history: {} };
  const prevMonth = shiftPeriod_(now.check.period, -1);
  const out = { follows: { status: before.check.period === prevMonth ? 'follows' : 'gap', period: before.check.period,
    expected: before.check.current, found: now.check.previous, changedBy: 0, items: 0, examples: [] }, history: {} };
  const old = {};
  before.flags.forEach(function (f) { old[f.key] = f; });
  if (out.follows.status === 'follows') {
    const diff = round2Inv_(now.check.previous - before.check.current);
    // A few items edited in R365 after last month's check move the total a little; files out of order move it a lot.
    if (Math.abs(diff) > Math.max(rules.followTolerance, Math.abs(before.check.current) * rules.followTolerancePct)) out.follows.status = 'differs';
    else if (Math.abs(diff) > 1) out.follows.changedBy = diff;
    now.flags.forEach(function (f) {
      const o = old[f.key];
      if (o && Math.abs(o.curQty - f.prevQty) > 0.005) {
        out.follows.items++;
        if (out.follows.examples.length < 3) out.follows.examples.push(f.item + ' (' + invQty_(o.curQty) + ' last month, ' + invQty_(f.prevQty) + ' in this file)');
      }
    });
  }
  now.flags.forEach(function (f) {
    const o = old[f.key];
    if (!o) return;
    const reversal = o.qtyEffect * f.qtyEffect < 0 && Math.abs(o.qtyEffect) >= rules.moveMin && Math.abs(f.qtyEffect) >= 0.5 * Math.abs(o.qtyEffect);
    const costTwice = o.cats.indexOf('costErrors') !== -1 && f.cats.indexOf('costErrors') !== -1;
    const when = invMonthName_(before.check.period);
    if (reversal) out.history[f.key] = 'Reverses ' + when + '\'s move (' + invSignedMoney_(o.qtyEffect) + '). Was one of the two counts wrong?';
    else if (costTwice) out.history[f.key] = 'A cost problem in ' + when + ' too.';
    else out.history[f.key] = 'Also picked in ' + when + ': ' + (o.reasons[0] || '').replace(/\s+[A-Z][^.?]*\?$/, '');
  });
  return out;
}

/** '2026-10' → '2026-09' (n = −1). */
function shiftPeriod_(period, n) {
  const y = Number(period.slice(0, 4)), m = Number(period.slice(5, 7)) - 1 + n;
  const d = new Date(y, m, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function invMonthName_(period) {
  const m = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return m[Number(String(period).slice(5, 7)) - 1] || String(period);
}

/* ------------------------------------------------------------------ report */

/**
 * The check report for one property and month: every count on file for it.
 * @param {Object} input {
 *   property, period,
 *   counts: [{ check, flags, compare }],   // compare: compareInventoryChecks_ result
 *   pnl: { stage, asOf, lines: {key: amount} } | null,
 *   rules
 * }
 */
function buildInventoryCheckReport_(input) {
  const rules = Object.assign({}, INV_RULES, input.rules || {});
  const counts = input.counts || [];
  const accounts = {}, pnlGroups = {};
  const questions = [], others = [], issues = [];
  const h = { value: 0, prevValue: 0, priceEffect: 0 };
  let counted = 0, stocked = 0, zeroCost = 0, picked = 0;
  const notCounted = { items: 0, value: 0 }, wentToZero = { items: 0, value: 0 };

  const countRows = counts.map(function (c) {
    const k = c.check, s = k.summary || {};
    const compare = c.compare || { follows: { status: 'first' }, history: {} };
    h.value += k.current; h.prevValue += k.previous; h.priceEffect += k.priceEffect;
    counted += s.counted || 0; stocked += k.stocked; zeroCost += s.zeroCost || 0; picked += k.picked;
    if (s.notCounted) { notCounted.items += s.notCounted.items; notCounted.value += s.notCounted.value; }
    if (s.wentToZero) { wentToZero.items += s.wentToZero.items; wentToZero.value += s.wentToZero.value; }
    Object.keys(s.accounts || {}).forEach(function (a) {
      const acc = accounts[a] = accounts[a] || {};
      Object.keys(s.accounts[a]).forEach(function (cAcct) {
        const v = s.accounts[a][cAcct];
        const l = acc[cAcct] = acc[cAcct] || { name: cAcct, value: 0, prev: 0, priceEffect: 0, items: 0, flagged: 0, highImpact: 0 };
        l.value += v[0]; l.prev += v[1]; l.priceEffect += v[2]; l.items += v[3];
      });
    });
    Object.keys(s.pnl || {}).forEach(function (key) {
      const g = pnlGroups[key] = pnlGroups[key] || { key: key, value: 0, prev: 0 };
      g.value += s.pnl[key][0]; g.prev += s.pnl[key][1];
    });
    c.flags.forEach(function (f) {
      const l = accounts[f.inventoryAcct || 'No inventory account'] && accounts[f.inventoryAcct || 'No inventory account'][f.costAcct || 'No cost account'];
      if (l) { l.flagged++; if (f.impact >= rules.highImpact) l.highImpact++; }
      const q = Object.assign({ countId: k.id, countLabel: k.label, history: compare.history[f.key] || '' }, f);
      (f.impact >= rules.highImpact ? questions : others).push(q);
    });
    if (k.tieOuts) issues.push(k.label + ': ' + k.tieOuts + ' item' + (k.tieOuts === 1 ? ' does' : 's do') + ' not add up (previous value + adjustment ≠ current value). Check the export.');
    const f = compare.follows;
    if (f.status === 'differs') {
      issues.push(k.label + ': the previous total in this file (' + invMoney_(f.found) + ') is not ' + invMonthName_(f.period) + '\'s count on file (' +
        invMoney_(f.expected) + '). Either the files are out of order, or ' + invMonthName_(f.period) + '\'s count was changed in R365 after it was checked.');
    } else if (f.status === 'follows' && (f.changedBy || f.items)) {
      issues.push(k.label + ': ' + invMonthName_(f.period) + '\'s count was changed in R365 after it was checked' +
        (f.changedBy ? ' (' + invSignedMoney_(f.changedBy) + ' on its total)' : '') +
        (f.items ? ', including ' + f.examples.join(', ') : '') + '.');
    }
    return { id: k.id, label: k.label, file: k.file, uploadedAt: k.uploadedAt, uploadedBy: k.uploadedBy,
      items: k.items, stocked: k.stocked, value: k.current, prevValue: k.previous, change: round2Inv_(k.current - k.previous),
      priceEffect: k.priceEffect, qtyEffect: k.qtyEffect, tieOuts: k.tieOuts, picked: k.picked,
      highImpact: k.highImpact, highImpactValue: k.highImpactValue, follows: f };
  });
  const byImpact = function (a, b) { return b.impact - a.impact || a.item.localeCompare(b.item); };
  questions.sort(byImpact); others.sort(byImpact);

  const accountRows = Object.keys(accounts).map(function (a) {
    const lines = Object.keys(accounts[a]).map(function (c) { return finishInvLine_(accounts[a][c]); })
      .sort(function (x, y) { return y.value - x.value || x.name.localeCompare(y.name); });
    const t = { name: a, value: 0, prev: 0, priceEffect: 0, items: 0, flagged: 0, highImpact: 0 };
    lines.forEach(function (l) { ['value', 'prev', 'priceEffect', 'items', 'flagged', 'highImpact'].forEach(function (f) { t[f] += l[f]; }); });
    return Object.assign(finishInvLine_(t), { lines: lines });
  }).sort(function (a, b) { return b.value - a.value; });

  const change = h.value - h.prevValue;
  const pnl = input.pnl ? inventoryPnl_(pnlGroups, input.pnl, input.period) : null;
  const highValue = questions.reduce(function (s, q) { return s + q.impact; }, 0);
  const kpis = [
    { key: 'high', label: 'High-impact items', kind: 'count', value: questions.length, sub: invMoney_(highValue) + ' in dollar impact', bad: questions.length > 0 },
    { key: 'picked', label: 'Picked by the rules', kind: 'count', value: picked, sub: 'of ' + stocked + ' stocked items' },
    { key: 'notCounted', label: 'Not counted (assumed 0)', kind: 'count', value: notCounted.items, sub: invMoney_(notCounted.value) + ' at the last count', bad: notCounted.items > 0 },
    { key: 'zero', label: 'Gone to zero', kind: 'count', value: wentToZero.items, sub: invMoney_(wentToZero.value) + ' at the last count' },
    { key: 'zeroCost', label: 'Counted with no cost', kind: 'count', value: zeroCost, sub: zeroCost ? 'value understated' : 'every counted item has a cost', bad: zeroCost > 0 }
  ];
  if (pnl && pnl.total && pnl.total.days != null) {
    kpis.push({ key: 'days', label: 'Days on hand', kind: 'days', value: pnl.total.days, sub: 'at ' + (pnl.stage === 'mtd' ? 'month-to-date' : 'this month\'s') + ' cost of sales' });
  }
  return {
    property: input.property, period: input.period, highImpact: rules.highImpact,
    counts: countRows,
    headline: { value: round2Inv_(h.value), prevValue: round2Inv_(h.prevValue), change: round2Inv_(change),
      changePct: h.prevValue ? change / h.prevValue * 100 : null, priceEffect: round2Inv_(h.priceEffect), qtyEffect: round2Inv_(change - h.priceEffect) },
    status: questions.length || issues.length ? 'questions' : 'clean',
    kpis: kpis, questions: questions, others: others, issues: issues,
    accounts: accountRows, pnl: pnl
  };
}

function finishInvLine_(l) {
  const change = l.value - l.prev;
  return { name: l.name, value: round2Inv_(l.value), prev: round2Inv_(l.prev), change: round2Inv_(change),
    changePct: l.prev ? change / l.prev * 100 : null, priceEffect: round2Inv_(l.priceEffect),
    qtyEffect: round2Inv_(change - l.priceEffect), items: l.items, flagged: l.flagged, highImpact: l.highImpact };
}

/**
 * Inventory against the P&L month's cost of sales: days on hand, and the
 * change in inventory as a share of the month's cost (a decrease is cost of
 * sales bought in earlier months; an increase is purchases not yet used).
 * Liquor, wine and beer use their own cost lines when the P&L has them
 * (a detailed upload); otherwise they are compared with 5185 together.
 */
function inventoryPnl_(groups, month, period) {
  const lines = month.lines || {};
  const days = month.stage === 'mtd' && month.asOf ? Number(String(month.asOf).slice(8, 10))
    : new Date(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0).getDate();
  const bevKeys = INV_PNL_LINES.filter(function (l) { return l.parent === '5185' && groups[l.key]; }).map(function (l) { return l.key; });
  const splitBev = bevKeys.every(function (k) { return lines[k]; });
  const rows = [];
  const add = function (key, name, g) {
    const cost = lines[key] == null ? null : lines[key];
    const change = g.value - g.prev;
    rows.push({ key: key, name: name, inventory: round2Inv_(g.value), change: round2Inv_(change), cost: cost,
      days: cost > 0 ? g.value / (cost / days) : null, changeShare: cost > 0 ? change / cost * 100 : null });
  };
  INV_PNL_LINES.forEach(function (l) {
    const g = groups[l.key];
    if (!g || (l.parent && !splitBev)) return;
    add(l.key, l.name, g);
  });
  if (bevKeys.length && !splitBev) {
    const g = { value: 0, prev: 0 };
    bevKeys.forEach(function (k) { g.value += groups[k].value; g.prev += groups[k].prev; });
    add('5185', bevKeys.length > 1 ? 'Beer, wine & liquor' : INV_PNL_LINES.filter(function (l) { return l.key === bevKeys[0]; })[0].name, g);
  }
  rows.sort(function (a, b) { return a.key.localeCompare(b.key); });
  const matched = rows.filter(function (r) { return r.cost > 0; });
  let total = null;
  if (matched.length) {
    const inv = matched.reduce(function (s, r) { return s + r.inventory; }, 0);
    const cost = matched.reduce(function (s, r) { return s + r.cost; }, 0);
    const ch = matched.reduce(function (s, r) { return s + r.change; }, 0);
    total = { inventory: round2Inv_(inv), cost: round2Inv_(cost), change: round2Inv_(ch), days: inv / (cost / days), changeShare: ch / cost * 100 };
  }
  const other = groups[''];
  return { stage: month.stage, asOf: month.asOf || '', days: days, rows: rows, total: total,
    unmatched: other ? round2Inv_(other.value) : 0 };
}

/* ------------------------------------------------------------- sheet rows */

/** Check ⇄ row of Inventory Checks (SHEETS.invChecks). */
function inventoryCheckRow_(c) {
  return [c.id, c.property, c.period, c.label, c.file || '', c.uploadedAt || '', c.uploadedBy || '', c.items, c.stocked,
    c.current, c.previous, c.priceEffect, c.qtyEffect, c.tieOuts, c.picked, c.highImpact, c.highImpactValue, JSON.stringify(c.summary || {})];
}
function inventoryCheckFromRow_(r) {
  const n = function (v) { return Number(v) || 0; };
  let summary = {};
  try { summary = JSON.parse(String(r[17] || '{}')) || {}; } catch (e) { summary = {}; }
  return { id: String(r[0]), property: String(r[1]), period: periodText_(r[2]), label: String(r[3]), file: String(r[4] || ''),
    uploadedAt: String(r[5] || ''), uploadedBy: String(r[6] || ''), items: n(r[7]), stocked: n(r[8]), current: n(r[9]),
    previous: n(r[10]), priceEffect: n(r[11]), qtyEffect: n(r[12]), tieOuts: n(r[13]), picked: n(r[14]),
    highImpact: n(r[15]), highImpactValue: n(r[16]), summary: summary };
}

/** Picked item ⇄ row of Inventory Flags (SHEETS.invFlags). Reasons are kept one per line. */
function inventoryFlagRow_(countId, f) {
  return [countId, f.key, f.item, f.uom || '', f.inventoryAcct || '', f.costAcct || '', f.curQty, f.curCost, f.curTotal,
    f.prevQty, f.prevCost, f.prevTotal, f.priceEffect, f.qtyEffect, f.impact, f.flag || '', f.cats.join(','),
    f.reasons.map(function (x) { return x.text; }).join('\n')];
}
function inventoryFlagFromRow_(r) {
  const n = function (v) { return Number(v) || 0; };
  return { countId: String(r[0]), key: String(r[1]), item: String(r[2]), uom: String(r[3] || ''), inventoryAcct: String(r[4] || ''),
    costAcct: String(r[5] || ''), curQty: n(r[6]), curCost: n(r[7]), curTotal: n(r[8]), prevQty: n(r[9]), prevCost: n(r[10]),
    prevTotal: n(r[11]), priceEffect: n(r[12]), qtyEffect: n(r[13]), impact: n(r[14]), flag: String(r[15] || ''),
    cats: String(r[16] || '').split(',').filter(Boolean), reasons: String(r[17] || '').split('\n').filter(Boolean) };
}

/** Same name for the same slot regardless of spacing and case. */
function normalizeInventoryLabel_(label) {
  return String(label || '').trim().replace(/\s+/g, ' ');
}
function sameInventoryLabel_(a, b) {
  return normalizeInventoryLabel_(a).toLowerCase() === normalizeInventoryLabel_(b).toLowerCase();
}
