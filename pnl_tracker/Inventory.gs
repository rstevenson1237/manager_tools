/*******************************************************************************
 * Inventory.gs — the inventory review: reads R365's "Inventory Count Item
 * Details" export, picks the items worth checking (triage), and builds the
 * inventory report. Plain JavaScript with no Apps Script services, so the
 * Node harness runs it against sample exports. InventoryApi.gs holds the
 * endpoints that read and write the data workbook.
 *
 * A COUNT is one R365 export: one property, one month, one count name
 * ("Food", "Beverage", "Full count" …). A property can have several counts a
 * month. Property + count name is a slot: uploading it again replaces the
 * count on file (and, for a new month, its notes). Only the saved report is
 * kept after that, on the assumption that action items are fixed once
 * reported.
 *
 * TRIAGE (INV_CATEGORIES, thresholds in INV_RULES). An item can sit in more
 * than one category; its note is the same everywhere it appears.
 *   notCounted    R365 flag "Assumed 0": nothing was entered for the item
 *   unitErrors    cost per unit moved 3× or more since the last count
 *                 (often a case price on a unit, or the reverse), or a
 *                 quantity with no cost
 *   priceChanges  cost moved 10% or more; largest dollar effect first
 *   decreases / increases   largest dollar changes
 *   countSwings   R365 flagged the quantity as more than twice or less than
 *                 half of last count, beyond the largest changes above
 *   newItems      no cost at the last count
 *   wentToZero    stocked at the last count, zero now
 * Items at zero in both counts are not stocked and never shown.
 ******************************************************************************/

const INV_RULES = {
  unitRatio: 3,             // cost per unit at least this many times (or 1/x) last count's
  packSizes: [2, 4, 6, 8, 10, 12, 15, 20, 24, 30, 36, 48],
  packTolerance: 0.03,      // ratio within 3% of a pack size reads as case vs unit
  priceChangePct: 0.10,     // price changes: at least this much …
  priceChanges: 25,         // … top N by dollar effect
  swings: 10,               // largest decreases and increases: top N each
  countSwings: 15,          // count swings: top N …
  countSwingMin: 25,        // … with at least this dollar change
  newItems: 15
};

const INV_CATEGORIES = [
  { key: 'notCounted', label: 'Not counted', hint: 'R365 assumed zero: nothing was entered for these items.' },
  { key: 'unitErrors', label: 'Possible unit or cost errors', hint: 'Cost per unit moved 3× or more since the last count, or the item has a quantity but no cost.' },
  { key: 'priceChanges', label: 'Price changes', hint: 'Cost moved 10% or more since the last count. Largest dollar effect first (top 25).' },
  { key: 'decreases', label: 'Largest decreases', hint: 'Biggest drops in value since the last count (top 10).' },
  { key: 'increases', label: 'Largest increases', hint: 'Biggest rises in value since the last count (top 10).' },
  { key: 'countSwings', label: 'Count swings', hint: 'R365 flagged the quantity as more than twice or less than half of the last count. Largest dollar change first (top 15, $25 or more).' },
  { key: 'newItems', label: 'New items', hint: 'No cost at the last count. Check the unit and the cost.' },
  { key: 'wentToZero', label: 'Counted as zero', hint: 'Stocked at the last count, zero now. Confirm the item is really gone.' }
];

const INV_STATUS_RULES = [
  { prefix: 'CORRECT', status: 'correct' },
  { prefix: 'REVIEW', status: 'review' },
  { prefix: 'ADJUST', status: 'adjust' }
];

const DEFAULT_INV_NOTES = [
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
];

/** Columns of the R365 export. `field` is the item property; required columns must be present. */
const INV_COLUMNS = [
  { header: 'Item', field: 'item', required: true, text: true },
  { header: 'UofM', field: 'uom', text: true },
  { header: 'Current Qty', field: 'curQty', required: true },
  { header: 'Current $ Cost', field: 'curCost', required: true },
  { header: 'Current $ Total', field: 'curTotal' },
  { header: 'Previous Qty', field: 'prevQty', required: true },
  { header: 'Prev $ Cost', field: 'prevCost', required: true },
  { header: 'Prev $ Total', field: 'prevTotal' },
  { header: 'Adjustment', field: 'adjustment' },
  { header: 'Cost Acct', field: 'costAcct', text: true },
  { header: 'Inventory Acct', field: 'inventoryAcct', text: true },
  { header: 'Flag', field: 'flag', text: true }
];

/** Inventory account → the P&L cost of sales line it feeds. Tested on the inventory account, then the cost account. */
const INV_PNL_LINES = [
  { key: '5002', name: 'Food', test: /food/i },
  { key: '5300', name: 'Liquor', test: /liquor|spirit/i, parent: '5185' },
  { key: '5500', name: 'Wine', test: /wine/i, parent: '5185' },
  { key: '5400', name: 'Beer', test: /beer/i, parent: '5185' },
  { key: '5190', name: 'NA beverage', test: /soft|n\.?a\.? bev|non.?alc/i }
];

/* ------------------------------------------------------------------ reading */

/**
 * Read an Inventory Count Item Details export (rows from a CSV parser).
 * @return {{ items: Object[], rows: number, warnings: string[], tieOuts: number }}
 *   tieOuts: rows where previous total + adjustment ≠ current total.
 * Throws when the file is not a count export, so nothing is ever saved from it.
 */
function parseInventoryCsv_(rows) {
  rows = rows || [];
  let headerAt = -1, map = null;
  for (let i = 0; i < Math.min(rows.length, 10) && headerAt === -1; i++) {
    const cells = (rows[i] || []).map(function (c) { return String(c == null ? '' : c).replace(/^﻿/, '').trim().toLowerCase(); });
    if (cells.indexOf('item') !== -1 && cells.indexOf('current qty') !== -1) {
      headerAt = i;
      map = {};
      INV_COLUMNS.forEach(function (c) { map[c.field] = cells.indexOf(c.header.toLowerCase()); });
    }
  }
  if (headerAt === -1) {
    throw new Error('This is not an R365 Inventory Count Item Details export: no "Item" and "Current Qty" columns were found.');
  }
  const missing = INV_COLUMNS.filter(function (c) { return c.required && map[c.field] === -1; }).map(function (c) { return c.header; });
  if (missing.length) throw new Error('The count export is missing these columns: ' + missing.join(', ') + '.');

  const items = [], warnings = [];
  const seen = {};
  let tieOuts = 0, badNumbers = 0;
  rows.slice(headerAt + 1).forEach(function (r) {
    if (!r || r.every(function (v) { return String(v == null ? '' : v).trim() === ''; })) return;
    const it = {};
    INV_COLUMNS.forEach(function (c) {
      const raw = map[c.field] === -1 ? '' : r[map[c.field]];
      if (c.text) { it[c.field] = String(raw == null ? '' : raw).trim(); return; }
      const n = parseInvNumber_(raw);
      if (n === null) { badNumbers++; it[c.field] = 0; } else it[c.field] = n;
    });
    if (!it.item) return;
    if (map.curTotal === -1) it.curTotal = round2Inv_(it.curQty * it.curCost);
    if (map.prevTotal === -1) it.prevTotal = round2Inv_(it.prevQty * it.prevCost);
    if (map.adjustment === -1) it.adjustment = round2Inv_(it.curTotal - it.prevTotal);
    if (Math.abs(it.prevTotal + it.adjustment - it.curTotal) > 0.02) tieOuts++;
    it.key = uniqueInvKey_(it, seen);
    items.push(it);
  });
  if (!items.length) throw new Error('The count export has no items.');
  if (badNumbers) warnings.push(badNumbers + ' cell' + (badNumbers === 1 ? '' : 's') + ' could not be read as numbers and were taken as 0.');
  return { items: items, rows: items.length, warnings: warnings, tieOuts: tieOuts };
}

/** '$1,799.88', '-$2.26', '(12.00)', '' → number (blank is 0); null when unreadable. */
function parseInvNumber_(raw) {
  if (typeof raw === 'number') return isFinite(raw) ? raw : null;
  let s = String(raw == null ? '' : raw).trim();
  if (s === '' || s === '-') return 0;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[$,\s]/g, '');
  if (s.charAt(0) === '-') { neg = !neg; s = s.slice(1); }
  if (!/^\d*\.?\d+(e[+-]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return neg ? -n : n;
}

/** The item name, made unique within the count (R365 names are unique; this is a safety net). */
function uniqueInvKey_(it, seen) {
  let key = it.item;
  if (seen[key]) key = it.item + ' [' + (it.uom || '?') + ']';
  let n = 2;
  const base = key;
  while (seen[key]) { key = base + ' #' + n; n++; }
  seen[key] = true;
  return key;
}

/** Count name suggested from the inventory accounts: Food, Beverage or Full count. */
function suggestInventoryLabel_(items) {
  let food = 0, bev = 0;
  (items || []).forEach(function (it) {
    if (/food/i.test(it.inventoryAcct)) food++;
    else if (/liquor|wine|beer|soft|bev/i.test(it.inventoryAcct)) bev++;
  });
  const n = (items || []).length || 1;
  if (food / n >= 0.7) return 'Food';
  if (bev / n >= 0.7) return 'Beverage';
  return 'Full count';
}

/** Same name for the same slot regardless of spacing and case. */
function normalizeInventoryLabel_(label) {
  return String(label || '').trim().replace(/\s+/g, ' ');
}
function sameInventoryLabel_(a, b) {
  return normalizeInventoryLabel_(a).toLowerCase() === normalizeInventoryLabel_(b).toLowerCase();
}

function inventoryTotals_(items) {
  let cur = 0, prev = 0;
  items.forEach(function (it) { cur += it.curTotal; prev += it.prevTotal; });
  return { current: round2Inv_(cur), previous: round2Inv_(prev), change: round2Inv_(cur - prev) };
}

/* ------------------------------------------------------------------- triage */

/** Note text → 'correct' | 'review' | 'adjust' | 'other' | ''. */
function inventoryStatus_(note) {
  const n = String(note || '').trim().toUpperCase();
  if (!n) return '';
  for (let i = 0; i < INV_STATUS_RULES.length; i++) {
    if (n.indexOf(INV_STATUS_RULES[i].prefix) === 0) return INV_STATUS_RULES[i].status;
  }
  return 'other';
}

/** Numbers derived for every item: price variance, the price part of the change, and the dollar size used to rank it. */
function deriveInventoryItem_(it) {
  const variance = it.prevCost > 0 && it.curCost > 0 ? (it.curCost - it.prevCost) / it.prevCost : null;
  const priceEffect = it.prevCost > 0 && it.curQty > 0 ? it.curQty * (it.curCost - it.prevCost) : 0;
  let impact = Math.max(Math.abs(it.adjustment), Math.abs(priceEffect));
  if (it.curQty > 0 && it.curCost === 0 && it.prevCost > 0) impact = Math.max(impact, it.curQty * it.prevCost);
  if (it.curQty === 0 && it.prevQty > 0) impact = Math.max(impact, Math.abs(it.prevTotal));
  return { variance: variance, priceEffect: round2Inv_(priceEffect), impact: round2Inv_(impact) };
}

/**
 * Pick the items to review.
 * @return {{ sections: [{key,label,hint,keys}], items: {key: item}, total: number }}
 *   items holds only the items under review, each with variance, priceEffect,
 *   impact, cats (category keys) and reasons ([{cat, text}]).
 */
function triageInventory_(items, rules) {
  rules = Object.assign({}, INV_RULES, rules || {});
  const all = items.map(function (it) { return Object.assign({}, it, deriveInventoryItem_(it)); });
  const out = {};
  const pick = function (cat, list, why) {
    return list.map(function (it) {
      const o = out[it.key] = out[it.key] || Object.assign({ cats: [], reasons: [] }, it);
      if (o.cats.indexOf(cat) === -1) { o.cats.push(cat); o.reasons.push({ cat: cat, text: why(it) }); }
      return it.key;
    });
  };
  const byImpact = function (a, b) { return b.impact - a.impact || a.key.localeCompare(b.key); };
  const assumedZero = function (it) { return /assumed\s*0/i.test(it.flag); };

  const notCounted = all.filter(assumedZero).sort(byImpact);
  const unit = all.filter(function (it) { return unitIssue_(it, rules); }).sort(byImpact);
  const unitKeys = {}; unit.forEach(function (it) { unitKeys[it.key] = true; });
  const price = all.filter(function (it) {
    return it.curQty > 0 && it.variance != null && Math.abs(it.variance) >= rules.priceChangePct - 1e-9 && !unitKeys[it.key];
  }).sort(function (a, b) { return Math.abs(b.priceEffect) - Math.abs(a.priceEffect) || a.key.localeCompare(b.key); })
    .slice(0, rules.priceChanges);
  const dec = all.filter(function (it) { return it.adjustment < 0; })
    .sort(function (a, b) { return a.adjustment - b.adjustment || a.key.localeCompare(b.key); }).slice(0, rules.swings);
  const inc = all.filter(function (it) { return it.adjustment > 0; })
    .sort(function (a, b) { return b.adjustment - a.adjustment || a.key.localeCompare(b.key); }).slice(0, rules.swings);
  const top = {}; dec.concat(inc).forEach(function (it) { top[it.key] = true; });
  const swings = all.filter(function (it) {
    return /more than twice|less than half/i.test(it.flag) && Math.abs(it.adjustment) >= rules.countSwingMin && !top[it.key];
  }).sort(function (a, b) { return Math.abs(b.adjustment) - Math.abs(a.adjustment) || a.key.localeCompare(b.key); })
    .slice(0, rules.countSwings);
  const fresh = all.filter(function (it) { return it.prevCost === 0 && it.curQty > 0 && it.curCost > 0; })
    .sort(function (a, b) { return b.curTotal - a.curTotal || a.key.localeCompare(b.key); }).slice(0, rules.newItems);
  const zero = all.filter(function (it) { return it.curQty === 0 && it.prevQty > 0 && !assumedZero(it); })
    .sort(function (a, b) { return b.prevTotal - a.prevTotal || a.key.localeCompare(b.key); });

  const keys = {
    notCounted: pick('notCounted', notCounted, function (it) {
      return 'Not counted: R365 assumed 0. Was ' + invQty_(it.prevQty, it.uom) + ' (' + invMoney_(it.prevTotal) + ').';
    }),
    unitErrors: pick('unitErrors', unit, function (it) { return unitIssue_(it, rules); }),
    priceChanges: pick('priceChanges', price, function (it) {
      return 'Cost ' + invSignedPct_(it.variance * 100) + ' (' + invMoney_(it.prevCost, true) + ' → ' + invMoney_(it.curCost, true) + '): ' +
        invSignedMoney_(it.priceEffect) + ' on this count.';
    }),
    decreases: pick('decreases', dec, function (it) {
      return 'Down ' + invMoney_(-it.adjustment) + ' (' + invQty_(it.prevQty) + ' → ' + invQty_(it.curQty, it.uom) + ').';
    }),
    increases: pick('increases', inc, function (it) {
      return 'Up ' + invMoney_(it.adjustment) + ' (' + invQty_(it.prevQty) + ' → ' + invQty_(it.curQty, it.uom) + ').';
    }),
    countSwings: pick('countSwings', swings, function (it) {
      return 'Quantity ' + invQty_(it.prevQty) + ' → ' + invQty_(it.curQty, it.uom) +
        (it.prevQty > 0 && it.curQty > 0 ? ' (×' + invRatio_(it.curQty / it.prevQty) + ')' : '') + ': ' + invSignedMoney_(it.adjustment) + '.';
    }),
    newItems: pick('newItems', fresh, function (it) {
      return 'New: ' + invQty_(it.curQty, it.uom) + ' at ' + invMoney_(it.curCost, true) + ' = ' + invMoney_(it.curTotal) + '.';
    }),
    wentToZero: pick('wentToZero', zero, function (it) {
      return 'Zero now. Was ' + invQty_(it.prevQty, it.uom) + ' (' + invMoney_(it.prevTotal) + ').';
    })
  };
  return {
    sections: INV_CATEGORIES.map(function (c) { return { key: c.key, label: c.label, hint: c.hint, keys: keys[c.key] }; }),
    items: out,
    total: Object.keys(out).length
  };
}

/** Text describing a unit or cost problem, or '' when there is none. */
function unitIssue_(it, rules) {
  if (it.curQty > 0 && it.curCost === 0) {
    return 'Counted ' + invQty_(it.curQty, it.uom) + ' but the cost is $0' +
      (it.prevCost > 0 ? ' (was ' + invMoney_(it.prevCost, true) + '): about ' + invMoney_(it.curQty * it.prevCost) + ' missing.' : ', so it adds nothing to the value.');
  }
  if (!(it.curQty > 0 && it.prevCost > 0 && it.curCost > 0)) return '';
  const ratio = it.curCost / it.prevCost;
  if (ratio < rules.unitRatio && ratio > 1 / rules.unitRatio) return '';
  const up = ratio >= 1, r = up ? ratio : 1 / ratio;
  const pack = (rules.packSizes || []).filter(function (p) { return Math.abs(r - p) / p <= rules.packTolerance; })[0];
  const what = 'Cost ' + invMoney_(it.prevCost, true) + ' → ' + invMoney_(it.curCost, true) + ' (' + (up ? '×' : '÷') + invRatio_(r) + ')';
  const effect = ': ' + invSignedMoney_(it.priceEffect) + ' on this count.';
  if (pack) return what + ', looks like a ' + (up ? 'case price entered for one unit' : 'unit price entered for a case of ' + pack) + effect;
  return what + effect;
}

/* ------------------------------------------------------------------- report */

/**
 * The inventory report for one property and month: every count on file for it.
 * @param {Object} input {
 *   property, period,
 *   counts: [{ id, label, period, file, uploadedAt, uploadedBy, items, notes: {key: {note, by, at}} }],
 *   pnl: { stage, asOf, lines: {key: amount} } | null,   // the P&L month, when on file and the viewer may see it
 *   summary: 'manager text', rules
 * }
 */
function buildInventoryReport_(input) {
  const counts = input.counts || [];
  const accounts = {};
  const pnlGroups = {};
  const actions = [];
  const triageRows = INV_CATEGORIES.map(function (c) { return { key: c.key, label: c.label, items: 0, noted: 0, correct: 0, review: 0, adjust: 0 }; });
  const triageByKey = {}; triageRows.forEach(function (t) { triageByKey[t.key] = t; });
  let value = 0, prev = 0, priceEffect = 0, itemsCounted = 0, itemsStocked = 0;
  let notCounted = 0, notCountedValue = 0, toZero = 0, toZeroValue = 0, zeroCost = 0;
  let reviewTotal = 0, reviewNoted = 0;

  const countRows = counts.map(function (c) {
    const tri = triageInventory_(c.items, input.rules);
    const notes = c.notes || {};
    const st = { total: tri.total, noted: 0, correct: 0, review: 0, adjust: 0, other: 0 };
    Object.keys(tri.items).forEach(function (k) {
      const n = notes[k];
      const status = n ? inventoryStatus_(n.note) : '';
      if (status) { st.noted++; st[status]++; }
      tri.items[k].cats.forEach(function (cat) {
        const t = triageByKey[cat];
        t.items++;
        if (status) { t.noted++; if (t[status] != null) t[status]++; }
      });
      if (status === 'review' || status === 'adjust') {
        const it = tri.items[k];
        actions.push({ countId: c.id, countLabel: c.label, key: k, item: it.item, uom: it.uom, note: n.note, status: status,
          reason: it.reasons[0] ? it.reasons[0].text : '', reasons: it.reasons.map(function (r) { return r.text; }),
          impact: it.impact, curQty: it.curQty, prevQty: it.prevQty, curCost: it.curCost, prevCost: it.prevCost,
          value: it.curTotal, adjustment: it.adjustment, inventoryAcct: it.inventoryAcct, by: n.by || '', at: n.at || '' });
      }
    });
    reviewTotal += st.total; reviewNoted += st.noted;
    let cValue = 0, cPrev = 0;
    c.items.forEach(function (it) {
      const d = deriveInventoryItem_(it);
      cValue += it.curTotal; cPrev += it.prevTotal; priceEffect += d.priceEffect;
      if (it.curQty > 0) itemsCounted++;
      if (it.curQty > 0 || it.prevQty > 0) itemsStocked++;
      if (/assumed\s*0/i.test(it.flag)) { notCounted++; notCountedValue += it.prevTotal; }
      else if (it.curQty === 0 && it.prevQty > 0) { toZero++; toZeroValue += it.prevTotal; }
      if (it.curQty > 0 && it.curCost === 0) zeroCost++;
      const accName = it.inventoryAcct || 'No inventory account';
      const a = accounts[accName] = accounts[accName] || { name: accName, lines: {} };
      const lName = it.costAcct || 'No cost account';
      const l = a.lines[lName] = a.lines[lName] || { name: lName, value: 0, prev: 0, priceEffect: 0, items: 0, review: 0, actions: 0 };
      l.value += it.curTotal; l.prev += it.prevTotal; l.priceEffect += d.priceEffect;
      if (it.curQty > 0 || it.prevQty > 0) l.items++;
      if (tri.items[it.key]) {
        l.review++;
        const s = notes[it.key] ? inventoryStatus_(notes[it.key].note) : '';
        if (s === 'review' || s === 'adjust') l.actions++;
      }
      const map = inventoryPnlLine_(it);
      const gk = map ? map.key : '';
      const g = pnlGroups[gk] = pnlGroups[gk] || { key: gk, value: 0, prev: 0 };
      g.value += it.curTotal; g.prev += it.prevTotal;
    });
    value += cValue; prev += cPrev;
    return { id: c.id, label: c.label, period: c.period, file: c.file || '', uploadedAt: c.uploadedAt || '', uploadedBy: c.uploadedBy || '',
      items: c.items.length, value: round2Inv_(cValue), prevValue: round2Inv_(cPrev), change: round2Inv_(cValue - cPrev),
      review: st, progressPct: st.total ? st.noted / st.total * 100 : 100 };
  });

  const accountRows = Object.keys(accounts).sort(function (a, b) { return accountTotal_(accounts[b]) - accountTotal_(accounts[a]); }).map(function (k) {
    const a = accounts[k];
    const lines = Object.keys(a.lines).map(function (n) { return finishInvLine_(a.lines[n]); })
      .sort(function (x, y) { return y.value - x.value || x.name.localeCompare(y.name); });
    const t = { name: a.name, value: 0, prev: 0, priceEffect: 0, items: 0, review: 0, actions: 0 };
    lines.forEach(function (l) { ['value', 'prev', 'priceEffect', 'items', 'review', 'actions'].forEach(function (f) { t[f] += l[f]; }); });
    return Object.assign(finishInvLine_(t), { lines: lines });
  });

  actions.sort(function (a, b) {
    return (a.status === b.status ? 0 : a.status === 'adjust' ? -1 : 1) || b.impact - a.impact || a.key.localeCompare(b.key);
  });
  const adjustGroups = {};
  actions.forEach(function (x) {
    if (x.status !== 'adjust') return;
    const g = adjustGroups[x.note] = adjustGroups[x.note] || { note: x.note, items: 0, impact: 0 };
    g.items++; g.impact += x.impact;
  });

  const change = value - prev;
  const qtyEffect = change - priceEffect;
  const pnl = input.pnl ? inventoryPnl_(pnlGroups, input.pnl, input.period) : null;
  const kpis = [
    { key: 'counted', label: 'Items counted', kind: 'count', value: itemsCounted, sub: itemsStocked + ' stocked in either count' },
    { key: 'notCounted', label: 'Not counted (assumed 0)', kind: 'count', value: notCounted, sub: invMoney_(notCountedValue) + ' at the last count', bad: notCounted > 0 },
    { key: 'zero', label: 'Counted as zero', kind: 'count', value: toZero, sub: invMoney_(toZeroValue) + ' at the last count' },
    { key: 'price', label: 'Price changes', kind: 'money', value: round2Inv_(priceEffect), sub: 'cost changes on what was counted', signed: true },
    { key: 'zeroCost', label: 'Counted with no cost', kind: 'count', value: zeroCost, sub: zeroCost ? 'value understated' : 'every counted item has a cost', bad: zeroCost > 0 },
    { key: 'progress', label: 'Review progress', kind: 'pct', value: reviewTotal ? reviewNoted / reviewTotal * 100 : 100, sub: reviewNoted + ' of ' + reviewTotal + ' items have a note' }
  ];
  if (pnl && pnl.total && pnl.total.days != null) {
    kpis.push({ key: 'days', label: 'Days on hand', kind: 'days', value: pnl.total.days, sub: 'at ' + (pnl.stage === 'mtd' ? 'month-to-date' : 'this month\'s') + ' cost of sales' });
  }
  return {
    property: input.property, period: input.period,
    counts: countRows,
    headline: { value: round2Inv_(value), prevValue: round2Inv_(prev), change: round2Inv_(change),
      changePct: prev ? change / prev * 100 : null, priceEffect: round2Inv_(priceEffect), qtyEffect: round2Inv_(qtyEffect) },
    kpis: kpis,
    accounts: accountRows,
    actions: actions,
    adjustGroups: Object.keys(adjustGroups).map(function (k) { return adjustGroups[k]; })
      .sort(function (a, b) { return b.impact - a.impact; }),
    triage: triageRows,
    review: { total: reviewTotal, noted: reviewNoted, open: reviewTotal - reviewNoted,
      adjust: actions.filter(function (a) { return a.status === 'adjust'; }).length,
      review: actions.filter(function (a) { return a.status === 'review'; }).length },
    pnl: pnl,
    summary: input.summary || ''
  };
}

function accountTotal_(a) {
  return Object.keys(a.lines).reduce(function (s, k) { return s + a.lines[k].value; }, 0);
}
function finishInvLine_(l) {
  const change = l.value - l.prev;
  return { name: l.name, value: round2Inv_(l.value), prev: round2Inv_(l.prev), change: round2Inv_(change),
    changePct: l.prev ? change / l.prev * 100 : null, priceEffect: round2Inv_(l.priceEffect),
    qtyEffect: round2Inv_(change - l.priceEffect), items: l.items, review: l.review, actions: l.actions };
}

/** The P&L line an item's account feeds, or null (supplies and the like). */
function inventoryPnlLine_(it) {
  const a = String(it.inventoryAcct || ''), c = String(it.costAcct || '');
  for (let i = 0; i < INV_PNL_LINES.length; i++) if (INV_PNL_LINES[i].test.test(a)) return INV_PNL_LINES[i];
  for (let i = 0; i < INV_PNL_LINES.length; i++) if (INV_PNL_LINES[i].test.test(c)) return INV_PNL_LINES[i];
  return null;
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

/* ------------------------------------------------------ re-upload checks */

/**
 * Compare a new upload with the count it replaces. When the new file follows
 * the old count, its "previous" columns should be the old count's current
 * figures; differences mean the old count was changed in R365 after it was
 * reviewed, or the files are not the same count.
 */
function inventoryContinuity_(oldItems, newItems) {
  const old = {};
  oldItems.forEach(function (it) { old[it.key] = it; });
  let compared = 0, differ = 0;
  const examples = [];
  newItems.forEach(function (it) {
    const o = old[it.key];
    if (!o) return;
    compared++;
    if (Math.abs(o.curQty - it.prevQty) > 0.005 || Math.abs(o.curTotal - it.prevTotal) > 0.02) {
      differ++;
      if (examples.length < 5) examples.push(it.key + ' (' + invQty_(o.curQty) + ' → ' + invQty_(it.prevQty) + ')');
    }
  });
  const oldTotal = oldItems.reduce(function (s, it) { return s + it.curTotal; }, 0);
  const newPrev = newItems.reduce(function (s, it) { return s + it.prevTotal; }, 0);
  return { compared: compared, differ: differ, examples: examples, oldTotal: round2Inv_(oldTotal), newPrevTotal: round2Inv_(newPrev) };
}

/** Keep notes on a re-uploaded count only for items still under review. */
function carryInventoryNotes_(notes, triage) {
  const kept = {}, dropped = [];
  Object.keys(notes || {}).forEach(function (k) {
    if (triage.items[k]) kept[k] = notes[k]; else dropped.push(k);
  });
  return { kept: kept, dropped: dropped };
}

/* ------------------------------------------------------------- sheet rows */

/** Item ⇄ row of the Inventory Items sheet (SHEETS.invItems). */
function inventoryItemRow_(countId, it) {
  return [countId, it.key, it.item, it.uom || '', it.curQty, it.curCost, it.curTotal, it.prevQty, it.prevCost, it.prevTotal,
    it.adjustment, it.costAcct || '', it.inventoryAcct || '', it.flag || ''];
}
function inventoryItemFromRow_(r) {
  const n = function (v) { return Number(v) || 0; };
  return { key: String(r[1]), item: String(r[2]), uom: String(r[3] || ''), curQty: n(r[4]), curCost: n(r[5]), curTotal: n(r[6]),
    prevQty: n(r[7]), prevCost: n(r[8]), prevTotal: n(r[9]), adjustment: n(r[10]), costAcct: String(r[11] || ''),
    inventoryAcct: String(r[12] || ''), flag: String(r[13] || '') };
}

/** Count ⇄ row of the Inventory Counts sheet (SHEETS.invCounts). */
function inventoryCountRow_(c) {
  return [c.id, c.property, c.period, c.label, c.file || '', c.uploadedAt || '', c.uploadedBy || '', c.items || 0,
    c.current || 0, c.previous || 0, c.reviewItems || 0, c.firstRow || '', c.rowCount || 0];
}
function inventoryCountFromRow_(r) {
  return { id: String(r[0]), property: String(r[1]), period: periodText_(r[2]), label: String(r[3]), file: String(r[4] || ''),
    uploadedAt: String(r[5] || ''), uploadedBy: String(r[6] || ''), items: Number(r[7]) || 0, current: Number(r[8]) || 0,
    previous: Number(r[9]) || 0, reviewItems: Number(r[10]) || 0, firstRow: Number(r[11]) || 0, rowCount: Number(r[12]) || 0 };
}

/**
 * Lay out the Inventory Items sheet: each count's rows together, so one count
 * is read with a single range. Sets firstRow / rowCount on each count.
 * @param {Array<{count: Object, rows: Array[]}>} groups
 * @return {Array[]} rows to write below the header (data starts on sheet row 2)
 */
function layoutInventoryItems_(groups) {
  const rows = [];
  groups.forEach(function (g) {
    g.count.firstRow = rows.length + 2;
    g.count.rowCount = g.rows.length;
    g.rows.forEach(function (r) { rows.push(r); });
  });
  return rows;
}

/** Notes rows (SHEETS.invNotes) → { countId: { key: {note, status, impact, by, at} } }. */
function inventoryNotesByCount_(rows) {
  const out = {};
  (rows || []).forEach(function (r) {
    const id = String(r[0]), key = String(r[1]), note = String(r[2] || '');
    if (!note) return;
    (out[id] = out[id] || {})[key] = { note: note, status: String(r[3] || inventoryStatus_(note)), impact: Number(r[4]) || 0,
      by: String(r[5] || ''), at: String(r[6] || '') };
  });
  return out;
}

/** A saved report split across rows of the Inventory Reports sheet (a cell holds at most 50,000 characters). */
const INV_REPORT_CHUNK = 40000;
function inventoryReportRows_(id, report, meta) {
  const json = JSON.stringify(report);
  const rows = [];
  for (let i = 0, part = 0; i < json.length || part === 0; i += INV_REPORT_CHUNK, part++) {
    rows.push([id, report.property, report.period, meta.at || '', meta.by || '',
      report.counts.map(function (c) { return c.label; }).join(', '), report.headline.value,
      report.review.adjust + report.review.review, part, json.slice(i, i + INV_REPORT_CHUNK)]);
  }
  return rows;
}
/** Saved reports: { id: { meta, json } } from the sheet's rows (in any order). */
function inventoryReportsFromRows_(rows, withJson) {
  const out = {};
  (rows || []).forEach(function (r) {
    const id = String(r[0]);
    const e = out[id] = out[id] || { id: id, property: String(r[1]), period: periodText_(r[2]), savedAt: '', savedBy: '', counts: '',
      value: 0, actionItems: 0, parts: [] };
    if (Number(r[8]) === 0) {
      e.savedAt = String(r[3] || ''); e.savedBy = String(r[4] || ''); e.counts = String(r[5] || '');
      e.value = Number(r[6]) || 0; e.actionItems = Number(r[7]) || 0;
    }
    if (withJson) e.parts[Number(r[8]) || 0] = String(r[9] || '');
  });
  Object.keys(out).forEach(function (id) {
    if (withJson) {
      try { out[id].report = JSON.parse(out[id].parts.join('')); } catch (e) { out[id].report = null; }
    }
    delete out[id].parts;
  });
  return out;
}
function inventoryReportId_(property, period) { return property + '|' + period; }

/* ---------------------------------------------------------------- format */

function round2Inv_(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function invMoney_(v, cents) {
  const n = Number(v) || 0, a = Math.abs(n);
  const s = cents ? a.toFixed(2) : String(Math.round(a));
  const parts = s.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (n < 0 && (cents ? a >= 0.005 : Math.round(a) > 0) ? '−' : '') + '$' + parts.join('.');
}
function invSignedMoney_(v) {
  const n = Math.round(Number(v) || 0);
  return (n > 0 ? '+' : n < 0 ? '−' : '') + invMoney_(Math.abs(n));
}
function invSignedPct_(v) { return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1) + '%'; }
function invRatio_(r) { return r >= 9.95 ? String(Math.round(r)) : r.toFixed(1); }
function invQty_(q, uom) {
  const n = Number(q) || 0;
  const s = Math.abs(n - Math.round(n)) < 0.005 ? String(Math.round(n)) : n.toFixed(2).replace(/0$/, '');
  return s + (uom ? ' ' + uom : '');
}
