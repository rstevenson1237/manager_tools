/*
 * Tests for the inventory review: Inventory.gs on its own, then the
 * endpoints (InventoryApi.gs with Code.gs, Store.gs …) against the in-memory
 * Apps Script stand-in in gas_mock.js. Run with:
 *   node pnl_tracker/tests/inventory_tests.js
 * (run_tests.js runs it too). All data here is made up.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const h = require('./harness');
const mock = require('./gas_mock');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + String(e.stack || e.message).split('\n').slice(0, 6).join('\n       ')); process.exitCode = 1; }
}
const same = (a, b, msg) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), msg);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= (tol == null ? 0.01 : tol), (msg || '') + ' expected ' + b + ', got ' + a);

const g = h.loadGs(['Store.gs', 'Analysis.gs', 'Inventory.gs']);

/* ------------------------------------------------------------ sample exports */

const HEADER = 'Item,UofM,Current Qty,Current $ Cost,Current $ Total,Previous Qty,Prev $ Cost,Prev $ Total,Adjustment,Cost Acct,Inventory Acct,Flag';
const fmt = v => { const a = Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); return (v < 0 ? '-$' : '$') + a; };
const q = v => /[",]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : v;
/** [name, uom, curQty, curCost, prevQty, prevCost, costAcct, invAcct, flag] → CSV in R365's layout. */
function countCsv(rows) {
  return [HEADER].concat(rows.map(r => {
    const [name, uom, cq, cc, pq, pc, ca, ia, flag] = r;
    const ct = Math.round(cq * cc * 100) / 100, pt = Math.round(pq * pc * 100) / 100;
    return [name, uom, cq.toFixed(2), String(cc), fmt(ct), pq.toFixed(2), String(pc), fmt(pt), fmt(ct - pt), ca, ia, flag || ''].map(q).join(',');
  })).join('\n') + '\n';
}
const W = (name, cq, cc, pq, pc, flag) => [name, 'BTL (750 ML)', cq, cc, pq, pc, 'Wine Cost', 'Wine', flag];
const L = (name, cq, cc, pq, pc, flag) => [name, 'BTL (1 L)', cq, cc, pq, pc, 'Liquor Cost', 'Liquor', flag];
const F = (name, cq, cc, pq, pc, flag, acct) => [name, 'LB', cq, cc, pq, pc, acct || 'Produce', 'Food Inventory', flag];

/** A beverage count with one item of every kind the triage looks for. */
function bevRows(over) {
  const rows = [
    W('CABERNET Steady', 10, 30, 10, 30),                       // nothing to see
    W('MERLOT Gone Missing', 0, 20, 6, 20, 'Assumed 0'),        // not counted
    L('VODKA Case Slip', 4, 96, 5, 8),                          // ×12: case price on a bottle
    L('GIN Odd Price', 3, 50, 3, 10),                           // ×5: unit error, no pack size
    L('RUM Bottle For Case', 24, 2, 20, 24),                    // ÷12: unit price for a case
    W('ROSE No Cost', 6, 0, 0, 0),                              // counted, no cost
    W('PINOT Price Up', 20, 22, 20, 20),                        // +10%: price change, +$40
    W('SYRAH Price Down', 5, 40, 5, 50, 'Less than Half'),      // −20%: price change, −$50 (flag ignored: qty same)
    W('CHAMPAGNE Big Drop', 2, 100, 30, 100, 'Less than Half'), // largest decrease
    W('RIESLING Big Rise', 40, 25, 4, 25, 'More than Twice'),   // largest increase
    L('AMARO Small Swing', 0.9, 30, 0.3, 30, 'More than Twice'),// +$18: under the $25 count-swing minimum
    W('ZIN New Arrival', 12, 15, 0, 0),                         // new item
    W('CHABLIS Sold Out', 0, 35, 4, 35, '0 Quantity'),          // counted as zero
    W('PORT Never Stocked', 0, 40, 0, 40)                       // zero both times: ignored
  ];
  return rows.concat(over || []);
}
const parseText = text => g.parseInventoryCsv_(h.parseCsv(text));

/* ------------------------------------------------------------------- parsing */
console.log('Inventory: reading the export');

test('reads R365 money formats and keeps every row', () => {
  const p = parseText(countCsv(bevRows()));
  assert.strictEqual(p.rows, 14);
  assert.strictEqual(p.tieOuts, 0);
  const vodka = p.items.filter(i => i.key === 'VODKA Case Slip')[0];
  same([vodka.curQty, vodka.curCost, vodka.curTotal, vodka.prevTotal, vodka.adjustment], [4, 96, 384, 40, 344]);
  same([g.parseInvNumber_('$1,799.88'), g.parseInvNumber_('-$2.26'), g.parseInvNumber_('(12.50)'), g.parseInvNumber_(''), g.parseInvNumber_('abc')],
    [1799.88, -2.26, -12.5, 0, null]);
});

test('quoted names with commas and doubled quotes, a byte-order mark, and blank lines', () => {
  const text = '﻿' + HEADER + '\n' +
    '"BIB Coke, Diet",Case,1.00,10,$10.00,1.00,10,$10.00,$0.00,"Soft Beverages (if included in ""Food"")",Soft Beverages,\n\n' +
    'ALTO ADIGE,BTL,12.00,149.99,"$1,799.88",12.00,149.99,"$1,799.88",$0.00,Wine Cost,Wine,\n';
  const p = parseText(text);
  same(p.items.map(i => i.key), ['BIB Coke, Diet', 'ALTO ADIGE']);
  assert.strictEqual(p.items[0].costAcct, 'Soft Beverages (if included in "Food")');
  assert.strictEqual(p.items[1].curTotal, 1799.88);
});

test('a duplicate item name gets a unique key; nothing is merged', () => {
  const p = parseText(countCsv([W('SAME', 1, 10, 1, 10), ['SAME', 'Case', 1, 60, 1, 60, 'Wine Cost', 'Wine'], W('SAME', 2, 10, 2, 10)]));
  same(p.items.map(i => i.key), ['SAME', 'SAME [Case]', 'SAME [BTL (750 ML)]']);
});

test('refuses a file that is not a count export, or is missing a column', () => {
  assert.throws(() => parseText('ReportType,DateRange\nProfit & Loss,Period Ending 10/31/2026\n'), /not an R365 Inventory Count/);
  assert.throws(() => parseText('Item,Current Qty,UofM\nA,1,EA\n'), /missing these columns: Current \$ Cost, Previous Qty, Prev \$ Cost/);
  assert.throws(() => parseText(HEADER + '\n'), /no items/);
});

test('counts rows where previous value + adjustment ≠ current value', () => {
  const text = countCsv([W('A', 1, 10, 1, 10)]).replace('$10.00,$0.00', '$10.00,$5.00');
  assert.strictEqual(parseText(text).tieOuts, 1);
});

test('suggests a count name from the inventory accounts', () => {
  assert.strictEqual(g.suggestInventoryLabel_(parseText(countCsv(bevRows())).items), 'Beverage');
  assert.strictEqual(g.suggestInventoryLabel_(parseText(countCsv([F('A', 1, 1, 1, 1), F('B', 1, 1, 1, 1), L('C', 1, 1, 1, 1)])).items), 'Full count');
  assert.strictEqual(g.suggestInventoryLabel_(parseText(countCsv([F('A', 1, 1, 1, 1), F('B', 1, 1, 1, 1), F('C', 1, 1, 1, 1)])).items), 'Food');
  assert.ok(g.sameInventoryLabel_(' food ', 'Food') && !g.sameInventoryLabel_('Food', 'Beverage'));
});

/* -------------------------------------------------------------------- triage */
console.log('Inventory: triage');

const tri = rows => g.triageInventory_(parseText(countCsv(rows)).items);
const keysOf = (t, cat) => t.sections.filter(s => s.key === cat)[0].keys;

test('each kind of problem lands in its section', () => {
  const t = tri(bevRows());
  same(keysOf(t, 'notCounted'), ['MERLOT Gone Missing']);
  same(keysOf(t, 'unitErrors'), ['RUM Bottle For Case', 'VODKA Case Slip', 'GIN Odd Price', 'ROSE No Cost'], 'largest dollar size first');
  same(keysOf(t, 'priceChanges'), ['SYRAH Price Down', 'PINOT Price Up']);
  same(keysOf(t, 'newItems'), ['ZIN New Arrival']);
  same(keysOf(t, 'wentToZero'), ['CHABLIS Sold Out'], 'assumed-zero items are not repeated here');
  assert.strictEqual(keysOf(t, 'decreases')[0], 'CHAMPAGNE Big Drop');
  assert.strictEqual(keysOf(t, 'increases')[0], 'RIESLING Big Rise');
  assert.ok(!t.items['PORT Never Stocked'], 'zero in both counts is never shown');
  assert.ok(!t.items['CABERNET Steady'], 'an unchanged item is not under review');
});

test('a case price on a unit, and the reverse, are named as such', () => {
  const t = tri(bevRows());
  const why = k => t.items[k].reasons.filter(r => r.cat === 'unitErrors')[0].text;
  assert.ok(/×12\), looks like a case price entered for one unit: \+\$352/.test(why('VODKA Case Slip')), why('VODKA Case Slip'));
  assert.ok(/÷12\), looks like a unit price entered for a case of 12/.test(why('RUM Bottle For Case')), why('RUM Bottle For Case'));
  assert.ok(/×5\.0\): \+\$120/.test(why('GIN Odd Price')) && !/looks like/.test(why('GIN Odd Price')), why('GIN Odd Price'));
  assert.ok(/cost is \$0, so it adds nothing/.test(why('ROSE No Cost')));
  const noCost = tri([W('X', 3, 0, 3, 18)]);
  assert.ok(/was \$18\.00\): about \$54 missing/.test(noCost.items.X.reasons[0].text), noCost.items.X.reasons[0].text);
  assert.strictEqual(noCost.items.X.impact, 54, 'dollar size of a missing cost is what it would have been worth');
});

test('price changes leave out unit errors and rank by dollar effect, top 25', () => {
  const many = [];
  for (let i = 0; i < 30; i++) many.push(W('P' + String(i).padStart(2, '0'), 10, 110 + i, 10, 100));
  const t = tri(many.concat([L('VODKA Case Slip', 4, 96, 5, 8)]));
  const pc = keysOf(t, 'priceChanges');
  assert.strictEqual(pc.length, 25);
  assert.strictEqual(pc[0], 'P29');
  assert.ok(pc.indexOf('VODKA Case Slip') === -1);
  assert.ok(pc.indexOf('P00') === -1 && pc.indexOf('P04') === -1, 'the smallest dollar effects fall off the list');
});

test('count swings: R365 flag, $25 or more, beyond the top 10 changes', () => {
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push(W('BIG' + i, 40 + i, 25, 4, 25, 'More than Twice'));
  rows.push(W('MID Swing', 10, 10, 4, 10, 'More than Twice'));   // +$60
  rows.push(W('TINY Swing', 3, 10, 1, 10, 'More than Twice'));   // +$20
  const t = tri(rows);
  same(keysOf(t, 'countSwings'), ['BIG1', 'BIG0', 'MID Swing']);
  assert.strictEqual(keysOf(t, 'increases').length, 10);
});

test('one entry per item even when it is in several sections', () => {
  const t = tri(bevRows());
  const c = t.items['CHAMPAGNE Big Drop'];
  assert.ok(c.cats.indexOf('decreases') !== -1);
  assert.strictEqual(t.total, Object.keys(t.items).length);
  assert.strictEqual(new Set(t.sections.reduce((a, s) => a.concat(s.keys), [])).size, t.total);
});

test('note text sets the status', () => {
  same(['CORRECT - FIXED', 'review', 'ADJUST - CASE AS BOTTLE PRICE', 'Looks fine', ''].map(g.inventoryStatus_),
    ['correct', 'review', 'adjust', 'other', '']);
});

/* -------------------------------------------------------------------- report */
console.log('Inventory: report');

function sampleReport(notes, pnl, extraCount) {
  const bev = parseText(countCsv(bevRows())).items;
  const counts = [{ id: 'c1', label: 'Beverage', period: '2026-10', items: bev, notes: notes || {} }];
  if (extraCount) counts.push(extraCount);
  return g.buildInventoryReport_({ property: 'TST1', period: '2026-10', counts: counts, pnl: pnl || null, summary: 'All good' });
}

test('value, change, and the price/quantity split add up', () => {
  const r = sampleReport();
  const items = parseText(countCsv(bevRows())).items;
  const cur = items.reduce((s, i) => s + i.curTotal, 0), prev = items.reduce((s, i) => s + i.prevTotal, 0);
  near(r.headline.value, cur); near(r.headline.prevValue, prev); near(r.headline.change, cur - prev);
  near(r.headline.priceEffect + r.headline.qtyEffect, r.headline.change, 0.02);
  near(r.headline.priceEffect, 352 + 120 - 528 + 40 - 50, 0.02, 'price effect = Σ current qty × cost change');
  const accSum = r.accounts.reduce((s, a) => s + a.value, 0);
  near(accSum, cur);
  same(r.accounts.map(a => a.name), ['Wine', 'Liquor']);
  r.accounts.forEach(a => near(a.lines.reduce((s, l) => s + l.change, 0), a.change));
});

test('action items: ADJUST first, by dollar size; grouped by note', () => {
  const r = sampleReport({
    'VODKA Case Slip': { note: 'ADJUST - CASE AS BOTTLE PRICE', by: 'a@x.com', at: '2026-11-03T10:00:00Z' },
    'RUM Bottle For Case': { note: 'ADJUST - BOTTLE AS CASE PRICE' },
    'MERLOT Gone Missing': { note: 'REVIEW - DOUBLE CHECK COUNT' },
    'CABERNET Steady': { note: 'ADJUST' },                  // not under review: ignored
    'PINOT Price Up': { note: 'CORRECT' }
  });
  same(r.actions.map(a => a.key), ['RUM Bottle For Case', 'VODKA Case Slip', 'MERLOT Gone Missing']);
  same([r.review.adjust, r.review.review, r.review.noted], [2, 1, 4]);
  assert.strictEqual(r.review.open, r.review.total - 4);
  same(r.adjustGroups.map(x => x.note), ['ADJUST - BOTTLE AS CASE PRICE', 'ADJUST - CASE AS BOTTLE PRICE']);
  const unit = r.triage.filter(t => t.key === 'unitErrors')[0];
  same([unit.items, unit.noted, unit.adjust], [4, 2, 2]);
  const liquor = r.accounts.filter(a => a.name === 'Liquor')[0];
  assert.strictEqual(liquor.actions, 2);
  assert.strictEqual(r.actions[1].by, 'a@x.com');
  assert.strictEqual(r.summary, 'All good');
});

test('KPIs: not counted, counted as zero, no cost, progress', () => {
  const r = sampleReport();
  const k = {}; r.kpis.forEach(x => { k[x.key] = x; });
  same([k.notCounted.value, k.zero.value, k.zeroCost.value], [1, 1, 1]);
  assert.ok(/\$120 at the last count/.test(k.notCounted.sub), k.notCounted.sub);
  assert.strictEqual(k.progress.value, 0);
  assert.ok(!k.days, 'no days on hand without a P&L month');
});

test('against the P&L: own lines when the upload is detailed, 5185 together otherwise', () => {
  const food = { id: 'c2', label: 'Food', period: '2026-10', notes: {},
    items: parseText(countCsv([F('BEEF', 10, 31, 10, 31, '', 'Meat'), ['TONGS', 'EA', 2, 5, 2, 5, 'Kitchen Utensils and Supplies', 'Supplies']])).items };
  const detailed = sampleReport(null, { stage: 'settled', asOf: '2026-11-20', lines: { '5002': 3100, '5300': 6200, '5500': 9300, '5185': 15500 } }, food);
  same(detailed.pnl.rows.map(x => x.key), ['5002', '5300', '5500']);
  const f = detailed.pnl.rows[0];
  near(f.days, 310 / (3100 / 31), 0.001, 'food: inventory ÷ daily food cost');
  assert.strictEqual(detailed.pnl.unmatched, 10, 'supplies have no cost of sales line');
  assert.ok(detailed.kpis.some(x => x.key === 'days'));
  const simple = sampleReport(null, { stage: 'settled', lines: { '5002': 3100, '5185': 15500 } }, food);
  same(simple.pnl.rows.map(x => x.key), ['5002', '5185']);
  const bev = simple.pnl.rows[1];
  near(bev.inventory, simple.headline.value - 310 - 10);
  near(bev.changeShare, bev.change / 15500 * 100, 1e-9);
  const mtd = sampleReport(null, { stage: 'mtd', asOf: '2026-10-10', lines: { '5002': 1000 } }, food);
  assert.strictEqual(mtd.pnl.days, 10, 'month to date: days elapsed');
  near(mtd.pnl.rows.filter(x => x.key === '5002')[0].days, 310 / 100);
});

/* -------------------------------------------------------------- re-uploads */
console.log('Inventory: re-uploads and storage');

test('continuity: the new file\'s previous figures against the count it replaces', () => {
  const oct = parseText(countCsv([W('A', 5, 10, 4, 10), W('B', 2, 10, 2, 10)])).items;
  const novOk = parseText(countCsv([W('A', 3, 10, 5, 10), W('B', 1, 10, 2, 10), W('C', 1, 10, 0, 0)])).items;
  same(g.inventoryContinuity_(oct, novOk), { compared: 2, differ: 0, examples: [], oldTotal: 70, newPrevTotal: 70 });
  const novBad = parseText(countCsv([W('A', 3, 10, 6, 10), W('B', 1, 10, 2, 10)])).items;
  const c = g.inventoryContinuity_(oct, novBad);
  same([c.differ, c.examples], [1, ['A (5 → 6)']]);
});

test('a recount keeps notes only for items still under review', () => {
  const t = tri(bevRows());
  const carry = g.carryInventoryNotes_({ 'VODKA Case Slip': { note: 'ADJUST' }, 'CABERNET Steady': { note: 'CORRECT' } }, t);
  same(Object.keys(carry.kept), ['VODKA Case Slip']);
  same(carry.dropped, ['CABERNET Steady']);
});

test('sheet rows round-trip; each count\'s items are laid out together', () => {
  const items = parseText(countCsv(bevRows())).items;
  const back = items.map(i => g.inventoryItemFromRow_(g.inventoryItemRow_('c1', i)));
  same(back, items.map(i => ({ key: i.key, item: i.item, uom: i.uom, curQty: i.curQty, curCost: i.curCost, curTotal: i.curTotal,
    prevQty: i.prevQty, prevCost: i.prevCost, prevTotal: i.prevTotal, adjustment: i.adjustment, costAcct: i.costAcct,
    inventoryAcct: i.inventoryAcct, flag: i.flag })));
  const a = { id: 'a' }, b = { id: 'b' };
  const rows = g.layoutInventoryItems_([{ count: a, rows: [[1], [2]] }, { count: b, rows: [[3], [4], [5]] }]);
  same([a.firstRow, a.rowCount, b.firstRow, b.rowCount, rows.length], [2, 2, 4, 3, 5]);
  const c = { id: 'x1', property: 'TST1', period: '2026-10', label: 'Food', file: 'f.csv', uploadedAt: '2026-11-01T00:00:00Z', uploadedBy: 'a@x.com',
    items: 3, current: 10.5, previous: 9, reviewItems: 2, firstRow: 4, rowCount: 3 };
  same(g.inventoryCountFromRow_(g.inventoryCountRow_(c)), c);
});

test('a large saved report is split across rows and read back whole', () => {
  const r = sampleReport();
  r.summary = 'x'.repeat(95000);
  const rows = g.inventoryReportRows_('TST1|2026-10', r, { at: '2026-11-05T00:00:00Z', by: 'a@x.com' });
  assert.strictEqual(rows.length, 3);
  assert.ok(rows.every(x => x[9].length <= 40000));
  const back = g.inventoryReportsFromRows_(rows.slice().reverse(), true)['TST1|2026-10'];
  assert.strictEqual(back.report.summary.length, 95000);
  same([back.savedBy, back.counts, back.value], ['a@x.com', 'Beverage', r.headline.value]);
  const meta = g.inventoryReportsFromRows_(rows, false)['TST1|2026-10'];
  assert.ok(!('report' in meta));
});

/* ---------------------------------------------------------- the endpoints */
console.log('Inventory: endpoints (against the Apps Script stand-in)');

function app(user) {
  const ctx = vm.createContext({ console: console, Math: Math, JSON: JSON, Date: Date });
  mock.installGasMock(ctx, { user: user || 'robert.stevenson@atlasrestaurantgroup.com' });
  ['Parse.gs', 'Budget.gs', 'Analysis.gs', 'Store.gs', 'Review.gs', 'Inventory.gs', 'Code.gs', 'Import.gs', 'InventoryApi.gs'].forEach(f => {
    vm.runInContext(fs.readFileSync(path.join(h.ROOT, f), 'utf8'), ctx, { filename: f });
  });
  ctx.setup();
  const ss = ctx.dataSpreadsheet_();
  const cfg = ctx.readConfig_(ss);
  cfg.properties = [{ code: 'TST1', name: 'Sample Grill', active: true }, { code: 'TST2', name: 'Harbor House', active: true }];
  ctx.writeConfig_(ss, cfg);
  return ctx;
}
const bevOct = countCsv(bevRows());
// November: the October current figures become the previous ones.
const bevNov = countCsv(parseText(bevOct).items.map(i => [i.item, i.uom, i.curQty * 0.5, i.curCost || 10, i.curQty, i.curCost, i.costAcct, i.inventoryAcct, '']));
const foodOct = countCsv([F('BEEF', 10, 31, 8, 30, '', 'Meat'), F('KALE', 0, 3, 4, 3, '0 Quantity'), F('SALT', 5, 1, 5, 1)]);

test('upload: preview writes nothing; save stores the count and lays out its items', () => {
  const a = app();
  const pv = a.previewInventoryUpload(bevOct, 'InventoryCountItemDetails_21.csv', 'TST1', '2026-10', '');
  assert.strictEqual(pv.target.label, 'Beverage', 'blank name → suggested');
  assert.strictEqual(pv.existing, null);
  assert.strictEqual(pv.review.total, a.triageInventory_(parseText(bevOct).items).total);
  assert.strictEqual(a.readInventoryCounts_(a.dataSpreadsheet_()).length, 0);
  const res = a.commitInventoryUpload(bevOct, 'InventoryCountItemDetails_21.csv', 'TST1', '2026-10', 'Beverage');
  const f = a.commitInventoryUpload(foodOct, 'food.csv', 'TST1', '2026-10', 'Food');
  const counts = a.readInventoryCounts_(a.dataSpreadsheet_());
  same(counts.map(c => [c.label, c.firstRow, c.rowCount]), [['Beverage', 2, 14], ['Food', 16, 3]]);
  const data = a.getInventoryCount(f.countId);
  same(Object.keys(data.items).sort(), ['BEEF', 'KALE']);
  assert.strictEqual(a.getInventoryCount(res.countId).count.label, 'Beverage');
});

test('notes: saved per item, refused for items not under review, removed when cleared', () => {
  const a = app();
  const id = a.commitInventoryUpload(bevOct, 'b.csv', 'TST1', '2026-10', 'Beverage').countId;
  const r = a.saveInventoryNotes(id, [{ key: 'VODKA Case Slip', note: 'ADJUST - CASE AS BOTTLE PRICE' }, { key: 'CABERNET Steady', note: 'CORRECT' },
    { key: 'MERLOT Gone Missing', note: 'REVIEW' }]);
  same(r.results.map(x => x.ok), [true, false, true]);
  assert.ok(/not under review/.test(r.results[1].error));
  assert.strictEqual(r.noted, 2);
  a.saveInventoryNotes(id, [{ key: 'MERLOT Gone Missing', note: '' }, { key: 'VODKA Case Slip', note: 'ADJUST - INCORRECT PRICE IN SYSTEM' }]);
  const notes = a.getInventoryCount(id).notes;
  same(Object.keys(notes), ['VODKA Case Slip']);
  assert.strictEqual(notes['VODKA Case Slip'].note, 'ADJUST - INCORRECT PRICE IN SYSTEM');
  assert.strictEqual(notes['VODKA Case Slip'].by, 'robert.stevenson@atlasrestaurantgroup.com');
});

test('a recount (same month) replaces the count and carries its notes', () => {
  const a = app();
  const id = a.commitInventoryUpload(bevOct, 'b.csv', 'TST1', '2026-10', 'Beverage').countId;
  a.saveInventoryNotes(id, [{ key: 'VODKA Case Slip', note: 'ADJUST' }, { key: 'MERLOT Gone Missing', note: 'REVIEW' }]);
  // The recount fixed the vodka price; Merlot is still not counted.
  const fixedCsv = countCsv(bevRows().map(r => r[0] === 'VODKA Case Slip' ? L('VODKA Case Slip', 5, 8, 5, 8) : r));
  const pv = a.previewInventoryUpload(fixedCsv, 'b2.csv', 'TST1', '2026-10', 'beverage ');
  same([pv.existing.sameMonth, pv.keptNotes, pv.droppedNotes], [true, 1, ['VODKA Case Slip']]);
  const res = a.commitInventoryUpload(fixedCsv, 'b2.csv', 'TST1', '2026-10', 'beverage ');
  assert.strictEqual(res.keptNotes, 1);
  const counts = a.readInventoryCounts_(a.dataSpreadsheet_());
  assert.strictEqual(counts.length, 1, 'same slot, case and spaces ignored');
  same(Object.keys(a.getInventoryCount(res.countId).notes), ['MERLOT Gone Missing']);
});

test('next month replaces the slot; the saved report stays, notes go; continuity is checked', () => {
  const a = app();
  const id = a.commitInventoryUpload(bevOct, 'b.csv', 'TST1', '2026-10', 'Beverage').countId;
  a.commitInventoryUpload(foodOct, 'f.csv', 'TST1', '2026-10', 'Food');
  a.saveInventoryNotes(id, [{ key: 'VODKA Case Slip', note: 'ADJUST - CASE AS BOTTLE PRICE' }]);
  let pv = a.previewInventoryUpload(bevNov, 'n.csv', 'TST1', '2026-11', 'Beverage');
  same([pv.existing.period, pv.reportSaved, pv.droppedCount], ['2026-10', false, 1]);
  same([pv.continuity.differ, pv.continuity.compared], [0, 14]);
  const saved = a.saveInventoryReport('TST1', '2026-10', 'Vodka price fixed in R365.');
  assert.ok(saved.savedAt);
  pv = a.previewInventoryUpload(bevNov, 'n.csv', 'TST1', '2026-11', 'Beverage');
  assert.strictEqual(pv.reportSaved, true);
  const nov = a.commitInventoryUpload(bevNov, 'n.csv', 'TST1', '2026-11', 'Beverage');
  const counts = a.readInventoryCounts_(a.dataSpreadsheet_());
  same(counts.map(c => c.label + ' ' + c.period).sort(), ['Beverage 2026-11', 'Food 2026-10']);
  same(Object.keys(a.getInventoryCount(nov.countId).notes), []);
  // Items sheet holds exactly the two counts on file, each where its row says.
  const ss = a.dataSpreadsheet_();
  counts.forEach(c => assert.strictEqual(a.readInventoryItems_(ss, c).length, c.items));
  assert.strictEqual(a.readDataRows_(ss, 'invItems').length, 14 + 3);
  // October's report: the food count is still on file (live); the beverage count is gone.
  const rep = a.getInventoryReport('TST1', '2026-10');
  assert.ok(rep.live);
  same(rep.report.counts.map(c => c.label), ['Food']);
  assert.strictEqual(rep.saved.summary, 'Vodka price fixed in R365.');
  assert.strictEqual(rep.report.summary, 'Vodka price fixed in R365.', 'the saved summary is the starting draft');
});

test('report: saved copy is served once every count for the month is replaced', () => {
  const a = app();
  const id = a.commitInventoryUpload(bevOct, 'b.csv', 'TST1', '2026-10', 'Beverage').countId;
  a.saveInventoryNotes(id, [{ key: 'VODKA Case Slip', note: 'ADJUST - CASE AS BOTTLE PRICE' }]);
  a.saveInventoryReport('TST1', '2026-10', 'Summary text');
  a.commitInventoryUpload(bevNov, 'n.csv', 'TST1', '2026-11', 'Beverage');
  const rep = a.getInventoryReport('TST1', '2026-10');
  assert.strictEqual(rep.live, false);
  same(rep.report.actions.map(x => x.key), ['VODKA Case Slip']);
  assert.strictEqual(rep.report.summary, 'Summary text');
  const dash = a.getInventoryDashboard();
  same(dash.reports.map(r => r.property + ' ' + r.period + ' ' + r.actionItems), ['TST1 2026-10 1']);
  same(dash.counts.map(c => c.period), ['2026-11']);
  assert.strictEqual(dash.counts[0].report, null);
});

test('refuses an older month over a newer count, and the same file under a second name', () => {
  const a = app();
  a.commitInventoryUpload(bevNov, 'n.csv', 'TST1', '2026-11', 'Beverage');
  assert.throws(() => a.commitInventoryUpload(bevOct, 'b.csv', 'TST1', '2026-10', 'Beverage'), /later than 2026-10/);
  assert.throws(() => a.commitInventoryUpload(bevNov, 'n.csv', 'TST1', '2026-11', 'Bar'), /identical to the Beverage count/);
  a.commitInventoryUpload(bevNov, 'n.csv', 'TST2', '2026-11', 'Beverage'); // another property is fine
  assert.throws(() => a.previewInventoryUpload(bevOct, 'b.csv', 'TST1', '2026-13', 'Beverage'), /month/);
  assert.throws(() => a.previewInventoryUpload(bevOct, 'b.csv', '', '2026-10', 'Beverage'), /property/);
});

test('dashboard: progress, action items, and a report that changed after saving', () => {
  const a = app();
  const id = a.commitInventoryUpload(bevOct, 'b.csv', 'TST1', '2026-10', 'Beverage').countId;
  a.saveInventoryNotes(id, [{ key: 'VODKA Case Slip', note: 'ADJUST - CASE AS BOTTLE PRICE' }, { key: 'MERLOT Gone Missing', note: 'REVIEW' },
    { key: 'PINOT Price Up', note: 'CORRECT' }]);
  let d = a.getInventoryDashboard();
  const c = d.counts[0];
  same([c.review.noted, c.review.adjust, c.review.review, c.report], [3, 1, 1, null]);
  same(d.actions.map(x => x.key), ['VODKA Case Slip', 'MERLOT Gone Missing']);
  near(c.review.openImpact, 352 + 120);
  a.saveInventoryReport('TST1', '2026-10', '');
  d = a.getInventoryDashboard();
  assert.strictEqual(d.counts[0].report.stale, false);
  // A later note makes the saved report out of date (note times are compared as ISO text).
  const ss = a.dataSpreadsheet_();
  const rows = a.readDataRows_(ss, 'invNotes');
  rows[0][6] = '2999-01-01T00:00:00.000Z';
  a.writeDataRows_(ss, 'invNotes', rows);
  assert.strictEqual(a.getInventoryDashboard().counts[0].report.stale, true);
});

test('report includes days on hand from the P&L month when on file', () => {
  const a = app();
  const ss = a.dataSpreadsheet_();
  a.writeDataRows_(ss, 'actuals', [['2026-10', 'TST1', '5002', 'Food Cost', '5000', 'group', 6200, '', 'settled', '2026-11-20', 'u1'],
    ['2026-10', 'TST1', 'NET_SALES', 'Net sales', '4000', 'computed', 50000, '', 'settled', '2026-11-20', 'u1']]);
  a.commitInventoryUpload(foodOct, 'f.csv', 'TST1', '2026-10', 'Food');
  const rep = a.getInventoryReport('TST1', '2026-10').report;
  const food = rep.pnl.rows.filter(r => r.key === '5002')[0];
  near(food.days, 315 / (6200 / 31), 1e-9);
});

test('access: viewers read, reviewers edit, the inventory-only role sees no P&L', () => {
  const a = app();
  const ss = a.dataSpreadsheet_();
  const cfg = a.readConfig_(ss);
  cfg.viewers = ['viewer@x.com', 'both@x.com'];
  cfg.inventory.reviewers = ['bar@x.com', 'both@x.com'];
  a.writeConfig_(ss, cfg);
  a.writeDataRows_(ss, 'actuals', [['2026-10', 'TST1', '5002', 'Food Cost', '5000', 'group', 6200, '', 'settled', '2026-11-20', 'u1']]);
  const id = a.commitInventoryUpload(foodOct, 'f.csv', 'TST1', '2026-10', 'Food').countId;

  a.__setUser('viewer@x.com');
  assert.strictEqual(a.getBootstrap().canEditInventory, false);
  assert.ok(a.getInventoryDashboard().counts.length === 1);
  assert.throws(() => a.saveInventoryNotes(id, [{ key: 'BEEF', note: 'CORRECT' }]), /inventory reviewer/);
  assert.throws(() => a.commitInventoryUpload(foodOct, 'f.csv', 'TST1', '2026-10', 'Food'), /inventory reviewer/);

  a.__setUser('both@x.com');
  assert.strictEqual(a.getBootstrap().canEditInventory, true);
  assert.ok(a.saveInventoryNotes(id, [{ key: 'BEEF', note: 'CORRECT' }]).results[0].ok);
  assert.ok(a.getInventoryReport('TST1', '2026-10').report.pnl, 'a viewer who reviews sees the P&L comparison');

  a.__setUser('bar@x.com');
  const boot = a.getBootstrap();
  same([boot.role, boot.inventoryOnly, boot.canEditInventory, Object.keys(boot.months).length], ['inventory', true, true, 0]);
  assert.ok(boot.properties.some(p => p.code === 'TST1'));
  assert.throws(() => a.getPortfolio('2026-10', 'month'), /Inventory tab only/);
  assert.throws(() => a.getPeriodReport('TST1', '2026-10', 'month'), /Inventory tab only/);
  assert.strictEqual(a.getInventoryReport('TST1', '2026-10').report.pnl, null, 'no P&L figures for the inventory-only role');
  assert.throws(() => a.removeInventoryCount(id), /administrator/);
  assert.throws(() => a.saveSettings({}), /Inventory tab only/);

  a.__setUser('stranger@x.com');
  assert.throws(() => a.getInventoryDashboard(), /do not have access/);
});

test('settings: inventory reviewers and notes are validated and kept', () => {
  const a = app();
  const s = a.saveSettings({ inventory: { reviewers: [' bar@x.com ', ''], noteCategories: ['correct', 'ADJUST - WRONG UNIT', 'ADJUST - WRONG UNIT'] } });
  same(s.inventory, { reviewers: ['bar@x.com'], noteCategories: ['CORRECT', 'ADJUST - WRONG UNIT'] });
  assert.throws(() => a.saveSettings({ inventory: { noteCategories: ['LOOKS FINE'] } }), /must start with CORRECT, REVIEW or ADJUST/);
  assert.throws(() => a.saveSettings({ inventory: { noteCategories: [] } }), /At least one/);
  // A workbook set up before the inventory existed has no Inventory row: defaults apply.
  const ss = a.dataSpreadsheet_();
  const sheet = ss.getSheetByName('_Config');
  sheet.getRange(5, 1, 1, 2).clearContent();
  same(a.readConfig_(ss).inventory.noteCategories, a.defaultInventoryConfig_().noteCategories);
  assert.strictEqual(a.readConfig_(ss).inventory.noteCategories.length, 11);
});

test('remove: a count (and its notes) or a saved report, admins only', () => {
  const a = app();
  const b = a.commitInventoryUpload(bevOct, 'b.csv', 'TST1', '2026-10', 'Beverage').countId;
  const f = a.commitInventoryUpload(foodOct, 'f.csv', 'TST1', '2026-10', 'Food').countId;
  a.saveInventoryNotes(b, [{ key: 'VODKA Case Slip', note: 'ADJUST' }]);
  a.saveInventoryNotes(f, [{ key: 'BEEF', note: 'CORRECT' }]);
  a.saveInventoryReport('TST1', '2026-10', '');
  a.removeInventoryCount(b);
  const ss = a.dataSpreadsheet_();
  const counts = a.readInventoryCounts_(ss);
  same(counts.map(c => [c.label, c.firstRow]), [['Food', 2]], 'the food count moved up and its row says so');
  assert.strictEqual(a.readInventoryItems_(ss, counts[0]).length, 3);
  same(a.readDataRows_(ss, 'invNotes').map(r => r[1]), ['BEEF']);
  a.removeInventoryReport('TST1', '2026-10');
  assert.strictEqual(a.getInventoryDashboard().reports.length, 0);
});

test('reading a count falls back to a full scan when its rows moved', () => {
  const a = app();
  const id = a.commitInventoryUpload(foodOct, 'f.csv', 'TST1', '2026-10', 'Food').countId;
  const ss = a.dataSpreadsheet_();
  const c = a.readInventoryCounts_(ss)[0];
  c.firstRow = 3; // stale index
  assert.strictEqual(a.readInventoryItems_(ss, c).length, 3);
  assert.strictEqual(a.findInventoryCount_(ss, id).id, id);
  assert.throws(() => a.findInventoryCount_(ss, 'nope'), /no longer on file/);
});

console.log('\n' + passed + ' inventory tests passed' + (process.exitCode ? ', some FAILED' : ''));
