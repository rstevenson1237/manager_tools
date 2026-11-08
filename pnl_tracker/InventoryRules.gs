/*******************************************************************************
 * InventoryRules.gs — reads R365's "Inventory Count Item Details" export and
 * picks the items worth a second look.
 *
 * THIS FILE IS SHARED. The same file, byte for byte, is in inventory_audit/
 * and pnl_tracker/: the store teams review with the rules the regional
 * manager checks with. Change it in one place, copy it to the other; the
 * tests fail when the two copies differ. Plain JavaScript with no Apps Script
 * services, so the Node tests run it.
 *
 * EVERY ITEM'S CHANGE SPLITS IN TWO
 *   price effect     what the cost change did to what was counted:
 *                    current qty × (current cost − previous cost)
 *   quantity effect  everything else: adjustment − price effect, so the two
 *                    always add up to R365's adjustment
 * Ranking by the raw adjustment mixes the two: a case price keyed on a bottle
 * shows up as a large "increase" even when fewer bottles were counted.
 *
 * SECTIONS (INV_SECTIONS, thresholds in INV_RULES). An item can sit in more
 * than one; each section's reason is written as the question to ask.
 *   notCounted    R365 flag "Assumed 0": nothing was entered
 *   costErrors    cost moved ×2.5 or more (or ÷2.5) since the last count, or
 *                 a quantity with no cost. Near a pack size it is named as a
 *                 case price on a unit, or the reverse.
 *   priceChanges  cost moved 10%+ with a dollar effect of $50+; top 25
 *   decreases     quantity effect −$250 or more; top 10. Often right (it
 *   increases     sold, or a delivery came in), but worth asking about.
 *   wentToZero    stocked at the last count, zero now, $150+ last count
 *   newItems      no cost at the last count; top 10 by value
 * A store team works through every section (about 50 items a month for a
 * large beverage program). The regional check lists only the items whose
 * dollar size is INV_RULES.highImpact or more (highImpactItems_): on a
 * properly audited count that should be fewer than 10.
 * Items at zero in both counts are not stocked and never shown. Fractional
 * counts are not flagged: wines sold by the glass and liquor converted
 * between 750 ml and 1 L are counted in fractions on purpose.
 ******************************************************************************/

const INV_RULES = {
  costRatio: 2.5,           // cost per unit at least this many times (or 1/x) last count's
  packSizes: [2, 4, 6, 8, 10, 12, 15, 20, 24, 30, 36, 48],
  packTolerance: 0.03,      // a ratio within 3% of a pack size reads as case vs unit
  priceChangePct: 0.10,     // price changes: cost moved at least this much …
  priceEffectMin: 50,       // … with at least this dollar effect …
  priceChanges: 25,         // … top N by dollar effect
  moveMin: 250,             // decreases / increases: quantity effect at least this …
  moves: 10,                // … top N each
  zeroMin: 150,             // gone to zero: last count's value at least this
  newItems: 10,             // new items: top N by value
  highImpact: 1000          // the regional check lists items whose dollar size is at least this
};

const INV_SECTIONS = [
  { key: 'notCounted', label: 'Not counted', hint: 'R365 assumed zero: nothing was entered. Missed in the count, or really out?' },
  { key: 'costErrors', label: 'Possible cost or unit errors', hint: 'Cost moved ×2.5 or more since the last count, or a quantity with no cost. Usually a case price on a unit, or the reverse.' },
  { key: 'priceChanges', label: 'Price changes', hint: 'Cost moved 10% or more, worth $50 or more on this count. Largest dollar effect first (top 25).' },
  { key: 'decreases', label: 'Large decreases', hint: 'Quantity down $250 or more at last count\'s cost (top 10). Did it really sell or get used?' },
  { key: 'increases', label: 'Large increases', hint: 'Quantity up $250 or more at last count\'s cost (top 10). Was this much really bought?' },
  { key: 'wentToZero', label: 'Gone to zero', hint: 'Zero now, worth $150 or more at the last count. Sold out, or missed in the count?' },
  { key: 'newItems', label: 'New items', hint: 'No cost at the last count. Check the unit and the cost (top 10 by value).' }
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

/* ------------------------------------------------------------------ reading */

/**
 * Read an Inventory Count Item Details export (rows from a CSV parser).
 * @return {{ items: Object[], rows: number, warnings: string[], tieOuts: number }}
 *   tieOuts: rows where previous total + adjustment ≠ current total. (Quantity
 *   × cost is not checked: R365 rounds the quantity to 2 decimals, so it
 *   misses by a few dollars on expensive bottles.)
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
    const raw = {};
    INV_COLUMNS.forEach(function (c) { raw[c.field] = map[c.field] === -1 ? undefined : r[map[c.field]]; });
    const it = inventoryItem_(raw);
    if (!it) return;
    badNumbers += it._bad; delete it._bad;
    if (Math.abs(it.prevTotal + it.adjustment - it.curTotal) > 0.02) tieOuts++;
    it.key = uniqueInvKey_(it, seen);
    items.push(it);
  });
  if (!items.length) throw new Error('The count export has no items.');
  if (badNumbers) warnings.push(badNumbers + ' cell' + (badNumbers === 1 ? '' : 's') + ' could not be read as numbers and were taken as 0.');
  return { items: items, rows: items.length, warnings: warnings, tieOuts: tieOuts };
}

/**
 * One item from raw values keyed by INV_COLUMNS field (CSV text or sheet
 * values). Missing totals are worked out. Null when there is no item name.
 * _bad counts cells that could not be read as numbers.
 */
function inventoryItem_(raw) {
  const it = { _bad: 0 };
  INV_COLUMNS.forEach(function (c) {
    const v = raw[c.field];
    if (c.text) { it[c.field] = String(v == null ? '' : v).trim(); return; }
    const n = parseInvNumber_(v);
    if (n === null) { it._bad++; it[c.field] = 0; } else it[c.field] = n;
  });
  if (!it.item) return null;
  if (raw.curTotal === undefined || raw.curTotal === '') it.curTotal = round2Inv_(it.curQty * it.curCost);
  if (raw.prevTotal === undefined || raw.prevTotal === '') it.prevTotal = round2Inv_(it.prevQty * it.prevCost);
  if (raw.adjustment === undefined || raw.adjustment === '') it.adjustment = round2Inv_(it.curTotal - it.prevTotal);
  return it;
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

/** Value now and at the last count, and the change split into price and quantity. */
function inventoryTotals_(items) {
  let cur = 0, prev = 0, price = 0;
  items.forEach(function (it) { cur += it.curTotal; prev += it.prevTotal; price += inventoryEffects_(it).priceEffect; });
  return { current: round2Inv_(cur), previous: round2Inv_(prev), change: round2Inv_(cur - prev),
    priceEffect: round2Inv_(price), qtyEffect: round2Inv_(cur - prev - price) };
}

/* ------------------------------------------------------------------ effects */

/** The price and quantity parts of an item's change (they add up to its adjustment). */
function inventoryEffects_(it) {
  let price = 0;
  if (it.prevCost > 0 && it.curQty > 0) price = it.curQty * (it.curCost - it.prevCost);
  return { priceEffect: round2Inv_(price), qtyEffect: round2Inv_(it.adjustment - price) };
}

/** Numbers derived for every item: price variance, both effects, and the dollar size used to rank it. */
function deriveInventoryItem_(it) {
  const e = inventoryEffects_(it);
  const variance = it.prevCost > 0 && it.curCost > 0 ? (it.curCost - it.prevCost) / it.prevCost : null;
  let impact = Math.max(Math.abs(e.qtyEffect), Math.abs(e.priceEffect));
  if (it.curQty === 0 && it.prevQty > 0) impact = Math.max(impact, Math.abs(it.prevTotal));
  return { variance: variance, priceEffect: e.priceEffect, qtyEffect: e.qtyEffect, impact: round2Inv_(impact) };
}

/* ------------------------------------------------------------------- triage */

/**
 * Pick the items to review.
 * @return {{ sections: [{key,label,hint,keys}], items: {key: item}, total: number }}
 *   items holds only the items picked, each with variance, priceEffect,
 *   qtyEffect, impact, cats (section keys) and reasons ([{cat, text}]).
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
  const byKey = function (a, b) { return a.key.localeCompare(b.key); };
  const assumedZero = function (it) { return /assumed\s*0/i.test(it.flag); };
  const toZero = function (it) { return it.curQty === 0 && it.prevQty > 0 && !assumedZero(it); };

  const notCounted = all.filter(assumedZero).sort(function (a, b) { return b.prevTotal - a.prevTotal || byKey(a, b); });
  const cost = all.filter(function (it) { return costIssue_(it, rules); })
    .sort(function (a, b) { return b.impact - a.impact || byKey(a, b); });
  const costKeys = {}; cost.forEach(function (it) { costKeys[it.key] = true; });
  const price = all.filter(function (it) {
    return it.curQty > 0 && it.variance != null && Math.abs(it.variance) >= rules.priceChangePct - 1e-9 &&
      Math.abs(it.priceEffect) >= rules.priceEffectMin && !costKeys[it.key];
  }).sort(function (a, b) { return Math.abs(b.priceEffect) - Math.abs(a.priceEffect) || byKey(a, b); })
    .slice(0, rules.priceChanges);
  const dec = all.filter(function (it) { return it.qtyEffect <= -rules.moveMin && !assumedZero(it) && !toZero(it); })
    .sort(function (a, b) { return a.qtyEffect - b.qtyEffect || byKey(a, b); }).slice(0, rules.moves);
  const inc = all.filter(function (it) { return it.qtyEffect >= rules.moveMin; })
    .sort(function (a, b) { return b.qtyEffect - a.qtyEffect || byKey(a, b); }).slice(0, rules.moves);
  const zero = all.filter(function (it) { return toZero(it) && it.prevTotal >= rules.zeroMin; })
    .sort(function (a, b) { return b.prevTotal - a.prevTotal || byKey(a, b); });
  const fresh = all.filter(function (it) { return it.prevCost === 0 && it.curQty > 0 && it.curCost > 0; })
    .sort(function (a, b) { return b.curTotal - a.curTotal || byKey(a, b); }).slice(0, rules.newItems);

  const qtyMove = function (it) { return invQty_(Math.abs(it.curQty - it.prevQty), it.uom) + ' (' + invQty_(it.prevQty) + ' → ' + invQty_(it.curQty) + ')'; };
  const keys = {
    notCounted: pick('notCounted', notCounted, function (it) {
      return 'Not counted (R365 assumed 0). Was ' + invQty_(it.prevQty, it.uom) + ', ' + invMoney_(it.prevTotal) + '. Missed in the count, or really out?';
    }),
    costErrors: pick('costErrors', cost, function (it) { return costIssue_(it, rules); }),
    priceChanges: pick('priceChanges', price, function (it) {
      return 'Cost ' + invSignedPct_(it.variance * 100) + ' (' + invMoney_(it.prevCost, true) + ' → ' + invMoney_(it.curCost, true) + '): ' +
        invSignedMoney_(it.priceEffect) + ' on this count. Is the new cost right?';
    }),
    decreases: pick('decreases', dec, function (it) {
      return 'Down ' + qtyMove(it) + ', ' + invSignedMoney_(it.qtyEffect) + '. Did this much really sell or get used?';
    }),
    increases: pick('increases', inc, function (it) {
      return 'Up ' + qtyMove(it) + ', ' + invSignedMoney_(it.qtyEffect) + '. Was this much really bought?';
    }),
    wentToZero: pick('wentToZero', zero, function (it) {
      return 'Zero now. Was ' + invQty_(it.prevQty, it.uom) + ', ' + invMoney_(it.prevTotal) + '. Sold out, or missed in the count?';
    }),
    newItems: pick('newItems', fresh, function (it) {
      return 'New: ' + invQty_(it.curQty, it.uom) + ' at ' + invMoney_(it.curCost, true) + ' = ' + invMoney_(it.curTotal) + '. Are the unit and cost right?';
    })
  };
  return {
    sections: INV_SECTIONS.map(function (c) { return { key: c.key, label: c.label, hint: c.hint, keys: keys[c.key] }; }),
    items: out,
    total: Object.keys(out).length
  };
}

/** The picked items whose dollar size is at least rules.highImpact, largest first. */
function highImpactItems_(triage, rules) {
  rules = Object.assign({}, INV_RULES, rules || {});
  return Object.keys(triage.items).map(function (k) { return triage.items[k]; })
    .filter(function (it) { return it.impact >= rules.highImpact; })
    .sort(function (a, b) { return b.impact - a.impact || a.key.localeCompare(b.key); });
}

/** Text describing a cost or unit problem, or '' when there is none. */
function costIssue_(it, rules) {
  rules = rules || INV_RULES;
  if (it.curQty > 0 && it.curCost === 0) {
    return 'Counted ' + invQty_(it.curQty, it.uom) + ' but the cost is $0' +
      (it.prevCost > 0 ? ' (was ' + invMoney_(it.prevCost, true) + '): about ' + invMoney_(it.curQty * it.prevCost) + ' missing from the value.' : ', so it adds nothing to the value.') +
      ' What should it cost?';
  }
  if (!(it.curQty > 0 && it.prevCost > 0 && it.curCost > 0)) return '';
  const ratio = it.curCost / it.prevCost;
  if (ratio < rules.costRatio && ratio > 1 / rules.costRatio) return '';
  const up = ratio >= 1, r = up ? ratio : 1 / ratio;
  const pack = (rules.packSizes || []).filter(function (p) { return Math.abs(r - p) / p <= rules.packTolerance; })[0];
  const priceEffect = it.priceEffect != null ? it.priceEffect : inventoryEffects_(it).priceEffect;
  const what = 'Cost ' + invMoney_(it.prevCost, true) + ' → ' + invMoney_(it.curCost, true) + ' (' + (up ? '×' : '÷') + invRatio_(r) + '), ' +
    invSignedMoney_(priceEffect) + ' on this count.';
  if (pack && up) return what + ' Looks like a case price entered for one unit.';
  if (pack) return what + ' Looks like a unit price entered for a case of ' + pack + ', or last count\'s cost was the mistake.';
  return what + ' Which cost is right?';
}

/* ------------------------------------------------- comparing with the count on file */

/**
 * How a new export relates to the count on file for the same slot:
 *   'next'       its previous figures are the old count's current figures
 *   'recount'    same previous figures as the old count: the same count again
 *   'unrelated'  neither. Files in the wrong order, the wrong property, or a
 *                count changed in R365 after it was reviewed.
 * @return {{ relation, compared, differ, examples, oldCurrent, oldPrevious, newPrevious }}
 *   differ / examples are measured against the relation found ('next' unless
 *   'recount' fits better).
 */
function inventoryRelation_(oldItems, newItems) {
  const old = {};
  oldItems.forEach(function (it) { old[it.key] = it; });
  let compared = 0, asNext = 0, asRecount = 0;
  const nextEx = [];
  newItems.forEach(function (it) {
    const o = old[it.key];
    if (!o) return;
    compared++;
    const followsOld = Math.abs(o.curQty - it.prevQty) <= 0.005 && Math.abs(o.curTotal - it.prevTotal) <= 0.02;
    const sameStart = Math.abs(o.prevQty - it.prevQty) <= 0.005 && Math.abs(o.prevTotal - it.prevTotal) <= 0.02;
    if (!followsOld) { asNext++; if (nextEx.length < 5) nextEx.push(it.key + ' (' + invQty_(o.curQty) + ' on file, ' + invQty_(it.prevQty) + ' in this file)'); }
    if (!sameStart) asRecount++;
  });
  const sum = function (list, f) { return round2Inv_(list.reduce(function (s, it) { return s + it[f]; }, 0)); };
  const res = { compared: compared, oldCurrent: sum(oldItems, 'curTotal'), oldPrevious: sum(oldItems, 'prevTotal'), newPrevious: sum(newItems, 'prevTotal') };
  if (!compared) return Object.assign(res, { relation: 'unrelated', differ: 0, examples: [] });
  const tol = Math.max(1, compared * 0.02);
  if (asNext <= tol) return Object.assign(res, { relation: 'next', differ: asNext, examples: nextEx });
  if (asRecount <= tol && asRecount < asNext) return Object.assign(res, { relation: 'recount', differ: asRecount, examples: [] });
  return Object.assign(res, { relation: 'unrelated', differ: asNext, examples: nextEx });
}

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
