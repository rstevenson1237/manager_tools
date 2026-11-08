/*
 * Tests for the inventory check: the shared rules (InventoryRules.gs, the
 * same file as inventory_audit's), InventoryCheck.gs on its own, then the
 * endpoints (InventoryApi.gs with Code.gs, Store.gs …) against the in-memory
 * Apps Script stand-in in gas_mock.js. Run with:
 *   node pnl_tracker/tests/inventory_tests.js
 * (run_tests.js runs it too). All data here is made up
 * (inventory_audit/tests/sample.js).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const h = require('./harness');
const mock = require('./gas_mock');
const sample = require('../../inventory_audit/tests/sample');
const { countCsv, W, L, F } = sample;

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + String(e.stack || e.message).split('\n').slice(0, 6).join('\n       ')); process.exitCode = 1; }
}
const same = (a, b, msg) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), msg);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= (tol == null ? 0.01 : tol), (msg || '') + ' expected ' + b + ', got ' + a);

const g = h.loadGs(['Store.gs', 'InventoryRules.gs', 'InventoryCheck.gs']);
const parseText = text => g.parseInventoryCsv_(h.parseCsv(text));
const cur = () => parseText(sample.currentCsv());
const keysOf = (t, cat) => t.sections.filter(s => s.key === cat)[0].keys;

/* ------------------------------------------------------------- the shared file */
console.log('Inventory: the shared rules');

test('InventoryRules.gs is the same file in inventory_audit and pnl_tracker', () => {
  const a = fs.readFileSync(path.join(h.ROOT, 'InventoryRules.gs'), 'utf8');
  const b = fs.readFileSync(path.join(h.ROOT, '..', 'inventory_audit', 'InventoryRules.gs'), 'utf8');
  assert.ok(a === b, 'the two copies differ: change one, copy it over the other');
});

test('reads R365 money formats and keeps every row', () => {
  const p = cur();
  assert.strictEqual(p.rows, 49);
  assert.strictEqual(p.tieOuts, 0);
  const v = p.items.filter(i => i.key === 'VODKA Case Slip')[0];
  same([v.curQty, v.curCost, v.curTotal, v.prevTotal, v.adjustment], [37.6, 96, 3609.6, 528, 3081.6]);
  same([g.parseInvNumber_('$1,799.88'), g.parseInvNumber_('-$2.26'), g.parseInvNumber_('(12.50)'), g.parseInvNumber_(''), g.parseInvNumber_('abc'), g.parseInvNumber_(12)],
    [1799.88, -2.26, -12.5, 0, null, 12]);
});

test('quoted names with commas and doubled quotes, a byte-order mark, and blank lines', () => {
  const text = '﻿' + sample.HEADER + '\n' +
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
  assert.throws(() => parseText(sample.HEADER + '\n'), /no items/);
});

test('counts rows where previous value + adjustment ≠ current value, not quantity × cost', () => {
  assert.strictEqual(parseText(countCsv([W('A', 1, 10, 1, 10)]).replace('$10.00,$0.00', '$10.00,$5.00')).tieOuts, 1);
  // R365 rounds the quantity to 2 decimals: 0.53 × 3659.52 is not $1,924.91, and that is fine.
  const text = sample.HEADER + '\nCOGNAC Old,BTL (1 L),0.53,3659.5161,"$1,924.91",0.53,3659.5161,"$1,924.91",$0.00,Liquor Cost,Liquor,\n';
  assert.strictEqual(parseText(text).tieOuts, 0);
});

test('suggests a count name from the inventory accounts', () => {
  assert.strictEqual(g.suggestInventoryLabel_(cur().items), 'Beverage', 'a food-coded cocktail ingredient does not change that');
  assert.strictEqual(g.suggestInventoryLabel_(parseText(countCsv([F('A', 1, 1, 1, 1), F('B', 1, 1, 1, 1), L('C', 1, 1, 1, 1)])).items), 'Full count');
  assert.strictEqual(g.suggestInventoryLabel_(parseText(countCsv([F('A', 1, 1, 1, 1), F('B', 1, 1, 1, 1), F('C', 1, 1, 1, 1)])).items), 'Food');
});

test('every change splits into price and quantity, adding up to the adjustment', () => {
  cur().items.forEach(it => { const e = g.inventoryEffects_(it); near(e.priceEffect + e.qtyEffect, it.adjustment, 0.011, it.key); });
  // A case price on a bottle: value up $3,082 although fewer bottles were counted.
  const v = g.inventoryEffects_(cur().items.filter(i => i.key === 'VODKA Case Slip')[0]);
  same([v.priceEffect, v.qtyEffect], [3308.8, -227.2]);
  const t = g.inventoryTotals_(cur().items);
  same([t.current, t.previous, t.change, t.priceEffect, t.qtyEffect], [17921.5, 14495.5, 3426, 4893.7, -1467.7]);
});

test('each kind of problem lands in its section, largest dollar impact first', () => {
  const t = g.triageInventory_(cur().items);
  same(keysOf(t, 'notCounted'), ['BORDEAUX Not Counted', 'MERLOT Gone Missing']);
  same(keysOf(t, 'costErrors'), ['VODKA Case Slip', 'GIN Odd Price', 'RUM Bottle For Case', 'SYRAH Zero Cost Again', 'ROSE No Cost']);
  same(keysOf(t, 'priceChanges'), ['PINOT Price Up']);
  same(keysOf(t, 'decreases'), ['CHAMPAGNE Big Drop']);
  same(keysOf(t, 'increases'), ['RIESLING Big Rise', 'TEQUILA Delivery']);
  same(keysOf(t, 'wentToZero'), ['BURGUNDY Last Bottle'], 'CHABLIS ($140) is under the $150 line');
  same(keysOf(t, 'newItems'), ['ZIN New Arrival']);
  ['AMARO Small Swing', 'MADEIRA By The Glass', 'LIME JUICE Bar', 'PORT Never Stocked', 'CABERNET Steady', 'CHABLIS Sold Out'].forEach(k =>
    assert.ok(!t.items[k], k + ' should not be picked'));
  assert.strictEqual(t.total, 13);
});

test('the reasons are the questions to ask', () => {
  const t = g.triageInventory_(cur().items);
  assert.strictEqual(t.items['VODKA Case Slip'].reasons[0].text, 'Cost $8.00 → $96.00 (×12), +$3,309 on this count. Looks like a case price entered for one unit.');
  assert.ok(/÷12.*unit price entered for a case of 12, or last count's cost was the mistake/.test(t.items['RUM Bottle For Case'].reasons[0].text));
  assert.ok(/×5\.6.*Which cost is right\?/.test(t.items['GIN Odd Price'].reasons[0].text));
  assert.strictEqual(t.items['RIESLING Big Rise'].reasons[0].text, 'Up 28.8 BTL (750 ML) (26 → 54.8), +$1,152. Was this much really bought?');
  assert.ok(/Did this much really sell or get used\?$/.test(t.items['CHAMPAGNE Big Drop'].reasons[0].text));
  assert.ok(/Sold out, or missed in the count\?$/.test(t.items['BURGUNDY Last Bottle'].reasons[0].text));
  assert.ok(/Missed in the count, or really out\?$/.test(t.items['BORDEAUX Not Counted'].reasons[0].text));
  assert.ok(/about \$100 missing from the value/.test(t.items['SYRAH Zero Cost Again'].reasons[0].text));
});

test('high-impact items are the picked ones of $1,000 or more', () => {
  same(g.highImpactItems_(g.triageInventory_(cur().items)).map(i => i.key),
    ['VODKA Case Slip', 'GIN Odd Price', 'RIESLING Big Rise', 'BORDEAUX Not Counted', 'CHAMPAGNE Big Drop', 'BURGUNDY Last Bottle']);
  assert.strictEqual(g.highImpactItems_(g.triageInventory_(cur().items), { highImpact: 3000 }).length, 1);
});

test('section limits and floors come from INV_RULES', () => {
  const rows = [];
  for (let i = 0; i < 14; i++) rows.push(W('UP ' + String(i).padStart(2, '0'), 20 + i, 30, 5, 30));
  rows.push(W('SMALL MOVE', 12, 20, 4, 20)); // +$160: under $250
  const t = g.triageInventory_(parseText(countCsv(rows)).items);
  assert.strictEqual(keysOf(t, 'increases').length, 10);
  assert.ok(!t.items['SMALL MOVE']);
  assert.strictEqual(keysOf(g.triageInventory_(parseText(countCsv(rows)).items, { moves: 3 }), 'increases').length, 3);
});

test('how a new export relates to the count on file: next, recount, unrelated', () => {
  const prev = parseText(sample.previousCsv()).items, now = cur().items;
  same([g.inventoryRelation_(prev, now).relation, g.inventoryRelation_(prev, now).differ], ['next', 0]);
  assert.strictEqual(g.inventoryRelation_(now, now).relation, 'recount');
  const fixed = parseText(countCsv(sample.currentRows().map(r => r[0] === 'VODKA Case Slip' ? [r[0], r[1], r[2], 8, r[4], r[5], r[6], r[7]] : r))).items;
  assert.strictEqual(g.inventoryRelation_(now, fixed).relation, 'recount', 'the same count with a cost fixed');
  const rel = g.inventoryRelation_(now, prev);
  assert.strictEqual(rel.relation, 'unrelated', 'the months uploaded the wrong way round');
  assert.ok(rel.differ >= 3 && rel.examples.length);
});

/* ------------------------------------------------------------- the check */
console.log('Inventory: the regional check');

const meta = (period, label) => ({ id: 'c-' + period, property: 'TST1', period: period, label: label || 'Beverage', file: 'x.csv', uploadedAt: '2026-11-03T10:00:00Z', uploadedBy: 'rm@example.com' });
const viaRows = b => ({ check: g.inventoryCheckFromRow_(g.inventoryCheckRow_(b.check)), flags: b.flags.map(f => g.inventoryFlagFromRow_(g.inventoryFlagRow_(b.check.id, f))) });

test('one count: totals, what was picked, and a summary small enough for one row', () => {
  const b = g.buildInventoryCheck_(cur(), meta('2026-10'));
  const c = b.check;
  same([c.items, c.stocked, c.current, c.previous, c.priceEffect, c.qtyEffect, c.picked, c.highImpact], [49, 48, 17921.5, 14495.5, 4893.7, -1467.7, 13, 6]);
  near(c.highImpactValue, 9888.7);
  same([c.summary.notCounted, c.summary.zeroCost, c.summary.wentToZero.items], [{ items: 2, value: 1260 }, 2, 2]);
  same(Object.keys(c.summary.accounts).sort(), ['Food Inventory', 'Liquor', 'Wine']);
  same(c.summary.pnl['5002'], [27, 22.5], 'the food-coded ingredient feeds food cost');
  assert.strictEqual(b.flags.length, 13);
  const row = g.inventoryCheckRow_(c);
  assert.strictEqual(row.length, 18);
  assert.ok(row[17].length < 2000, 'the summary JSON fits a cell easily');
  same(g.inventoryCheckFromRow_(row), JSON.parse(JSON.stringify(c)));
  const f = g.inventoryFlagFromRow_(g.inventoryFlagRow_(c.id, b.flags[0]));
  same([f.key, f.cats, f.reasons.length, f.impact], ['VODKA Case Slip', ['costErrors'], 1, 3308.8]);
});

test('against last month: follows, small edits since, out of order, a gap, the first count', () => {
  const before = viaRows(g.buildInventoryCheck_(parseText(sample.previousCsv()), meta('2026-09')));
  const now = viaRows(g.buildInventoryCheck_(cur(), meta('2026-10')));
  same(g.compareInventoryChecks_(now, before).follows.status, 'follows');
  assert.strictEqual(g.compareInventoryChecks_(now, before).follows.changedBy, 0);
  const edited = JSON.parse(JSON.stringify(before)); edited.check.current -= 23.42;
  const fe = g.compareInventoryChecks_(now, edited).follows;
  same([fe.status, fe.changedBy], ['follows', 23.42]);
  const wrong = JSON.parse(JSON.stringify(before)); wrong.check.current += 5000;
  same(g.compareInventoryChecks_(now, wrong).follows.status, 'differs');
  const old = JSON.parse(JSON.stringify(before)); old.check.period = '2026-07';
  same(g.compareInventoryChecks_(now, old).follows.status, 'gap');
  same(g.compareInventoryChecks_(now, null).follows.status, 'first');
  same(g.shiftPeriod_('2026-01', -1), '2025-12');
});

test('against last month: a swing that reverses, a cost problem twice, picked again', () => {
  // Last month the riesling jumped 4 → 26 and the vodka's cost was already wrong.
  const lastRows = [W('RIESLING Big Rise', 26, 40, 4, 40), L('VODKA Case Slip', 66, 8, 70, 0.67), L('GIN Odd Price', 6, 60, 6, 50), W('BORDEAUX Not Counted', 12, 95, 0, 0)];
  const before = viaRows(g.buildInventoryCheck_(parseText(countCsv(lastRows)), meta('2026-09')));
  const nowRows = [W('RIESLING Big Rise', 3, 40, 26, 40), L('VODKA Case Slip', 37.6, 96, 66, 8), L('GIN Odd Price', 7.7, 337, 6, 60), W('BORDEAUX Not Counted', 0, 95, 12, 95, 'Assumed 0')];
  const now = viaRows(g.buildInventoryCheck_(parseText(countCsv(nowRows)), meta('2026-10')));
  const hist = g.compareInventoryChecks_(now, before).history;
  assert.strictEqual(hist['RIESLING Big Rise'], 'Reverses September\'s move (+$880). Was one of the two counts wrong?');
  assert.strictEqual(hist['VODKA Case Slip'], 'A cost problem in September too.');
  assert.strictEqual(hist['GIN Odd Price'], 'Also picked in September: Cost +20.0% ($50.00 → $60.00): +$60 on this count.', 'the question is left off');
  assert.ok(/^Reverses September's move \(\+\$1,140\)/.test(hist['BORDEAUX Not Counted']), 'bought last month, not counted now');
});

test('the report: questions of $1,000 or more, the rest below, issues, days on hand', () => {
  const before = viaRows(g.buildInventoryCheck_(parseText(sample.previousCsv()), meta('2026-09')));
  const nowB = viaRows(g.buildInventoryCheck_(cur(), meta('2026-10')));
  nowB.check.tieOuts = 2;
  const r = g.buildInventoryCheckReport_({ property: 'TST1', period: '2026-10',
    counts: [{ check: nowB.check, flags: nowB.flags, compare: g.compareInventoryChecks_(nowB, before) }],
    pnl: { stage: 'settled', asOf: '2026-11-20', lines: { '5002': 62000, '5185': 78000, '5190': 4100 } } });
  same(r.questions.map(q => q.item), ['VODKA Case Slip', 'GIN Odd Price', 'RIESLING Big Rise', 'BORDEAUX Not Counted', 'CHAMPAGNE Big Drop', 'BURGUNDY Last Bottle']);
  assert.strictEqual(r.others.length, 7);
  assert.strictEqual(r.status, 'questions');
  assert.ok(/2 items do not add up/.test(r.issues[0]));
  same([r.headline.value, r.headline.priceEffect, r.headline.qtyEffect], [17921.5, 4893.7, -1467.7]);
  same(r.kpis.map(k => k.key), ['high', 'picked', 'notCounted', 'zero', 'zeroCost', 'days']);
  same(r.pnl.rows.map(x => x.key), ['5002', '5185']);
  near(r.pnl.rows[1].days, 17894.5 / (78000 / 31), 0.01);
  const wine = r.accounts.filter(a => a.name === 'Wine')[0];
  assert.ok(wine.flagged >= 6 && wine.highImpact === 4);
  const clean = g.buildInventoryCheckReport_({ property: 'TST1', period: '2026-10',
    counts: [{ check: before.check, flags: before.flags.filter(f => f.impact < 1000) }] });
  same([clean.status, clean.questions.length, clean.pnl], ['clean', 0, null]);
});

/* ---------------------------------------------------------- the endpoints */
console.log('Inventory: endpoints (against the Apps Script stand-in)');

function app(user) {
  const ctx = vm.createContext({ console: console, Math: Math, JSON: JSON, Date: Date });
  mock.installGasMock(ctx, { user: 'robert.stevenson@atlasrestaurantgroup.com' });
  ['Parse.gs', 'Budget.gs', 'Analysis.gs', 'Store.gs', 'Review.gs', 'InventoryRules.gs', 'InventoryCheck.gs', 'Code.gs', 'Import.gs', 'InventoryApi.gs'].forEach(f => {
    vm.runInContext(fs.readFileSync(path.join(h.ROOT, f), 'utf8'), ctx, { filename: f });
  });
  ctx.setup();
  const ss = ctx.dataSpreadsheet_();
  const cfg = ctx.readConfig_(ss);
  cfg.properties = [{ code: 'TST1', name: 'Sample Grill', active: true }, { code: 'TST2', name: 'Harbor House', active: true }];
  cfg.viewers = ['viewer@example.com'];
  cfg.inventory.reviewers = ['rm@example.com'];
  ctx.writeConfig_(ss, cfg);
  if (user) ctx.__setUser(user);
  return ctx;
}
const sep = sample.previousCsv(), oct = sample.currentCsv();

test('setup makes the two inventory tabs and none of the old four', () => {
  const a = app();
  const names = a.dataSpreadsheet_().getSheets().map(s => s.getName());
  assert.ok(names.indexOf('Inventory Checks') !== -1 && names.indexOf('Inventory Flags') !== -1);
  ['Inventory Counts', 'Inventory Items', 'Inventory Notes', 'Inventory Reports'].forEach(n => assert.ok(names.indexOf(n) === -1, n));
  same(a.readConfig_(a.dataSpreadsheet_()).inventory, { reviewers: ['rm@example.com'] });
});

test('upload: the preview writes nothing; saving keeps one row plus the picked items only', () => {
  const a = app('rm@example.com');
  const ss = a.dataSpreadsheet_();
  const pv = a.previewInventoryUpload(oct, 'Sample_Grill_October.csv', 'TST1', '2026-10', '');
  same([pv.target.label, pv.picked, pv.highImpact, pv.follows.status, pv.existing], ['Beverage', 13, 6, 'first', null]);
  same(pv.top.map(t => t.item).slice(0, 2), ['VODKA Case Slip', 'GIN Odd Price']);
  assert.strictEqual(a.readDataRows_(ss, 'invChecks').length, 0);
  a.commitInventoryUpload(sep, 'sep.csv', 'TST1', '2026-09', 'Beverage');
  const res = a.commitInventoryUpload(oct, 'oct.csv', 'TST1', '2026-10', 'Beverage');
  same([res.picked, res.highImpact, res.replaced], [13, 6, false]);
  assert.strictEqual(a.readDataRows_(ss, 'invChecks').length, 2);
  const flags = a.readDataRows_(ss, 'invFlags');
  assert.ok(flags.length < 49 * 2 / 2, 'only picked items are kept, not the 98 items of both exports');
  assert.strictEqual(flags.filter(r => r[0] === res.countId).length, 13);
  assert.strictEqual(a.previewInventoryUpload(oct, 'oct.csv', 'TST1', '2026-10', 'Beverage').existing.id, res.countId);
});

test('upload: a recount replaces its check; the same file for another property is refused', () => {
  const a = app();
  const ss = a.dataSpreadsheet_();
  a.commitInventoryUpload(oct, 'oct.csv', 'TST1', '2026-10', 'Beverage');
  const fixed = countCsv(sample.currentRows().map(r => r[0] === 'VODKA Case Slip' ? [r[0], r[1], r[2], 8, r[4], r[5], r[6], r[7]] : r));
  const res = a.commitInventoryUpload(fixed, 'oct-fixed.csv', 'TST1', '2026-10', 'beverage');
  same([res.replaced, res.highImpact], [true, 5]);
  same(a.readInventoryChecks_(ss).map(c => c.file), ['oct-fixed.csv']);
  assert.strictEqual(a.readDataRows_(ss, 'invFlags').length, res.picked);
  assert.throws(() => a.commitInventoryUpload(fixed, 'oops.csv', 'TST2', '2026-10', 'Beverage'), /identical to the beverage count already on file for TST1/i);
});

test('upload: out of order is caught by the preview', () => {
  const a = app();
  a.commitInventoryUpload(oct, 'oct.csv', 'TST1', '2026-10', 'Beverage');
  const pv = a.previewInventoryUpload(sep, 'sep.csv', 'TST1', '2026-11', 'Beverage');
  same(pv.follows.status, 'differs');
  assert.throws(() => a.previewInventoryUpload(oct, 'x.csv', '', '2026-10', 'Beverage'), /Choose the property/);
  assert.throws(() => a.previewInventoryUpload(oct, 'x.csv', 'TST1', '10/2026', 'Beverage'), /Choose the month/);
});

test('report and dashboard through the endpoints, with days on hand for viewers only', () => {
  const a = app();
  const ss = a.dataSpreadsheet_();
  a.writeDataRows_(ss, 'actuals', [['2026-10', 'TST1', '5185', 'Beer Wine & Liquor Cost', '5000', 'group', 78000, '', 'settled', '2026-11-20', 'seed']]);
  a.commitInventoryUpload(sep, 'sep.csv', 'TST1', '2026-09', 'Beverage');
  a.commitInventoryUpload(oct, 'oct.csv', 'TST1', '2026-10', 'Beverage');
  const d = a.getInventoryDashboard();
  same(d.checks.map(c => [c.period, c.highImpact]), [['2026-10', 6], ['2026-09', 0]]);
  assert.ok(!('summary' in d.checks[0]));
  const r = a.getInventoryReport('TST1', '2026-10').report;
  same([r.questions.length, r.counts[0].follows.status, r.pnl.rows.map(x => x.key)], [6, 'follows', ['5002', '5185']]);
  near(r.pnl.rows[1].days, 17894.5 / (78000 / 31), 0.01);
  a.__setUser('rm@example.com');
  assert.strictEqual(a.getInventoryReport('TST1', '2026-10').report.pnl, null, 'the inventory-only role sees no P&L');
  assert.strictEqual(a.getInventoryReport('TST1', '2026-08').report, null);
});

test('access: viewers read, reviewers upload, only admins remove', () => {
  const a = app();
  const id = a.commitInventoryUpload(oct, 'oct.csv', 'TST1', '2026-10', 'Beverage').countId;
  a.__setUser('viewer@example.com');
  assert.strictEqual(a.getInventoryDashboard().checks.length, 1);
  assert.throws(() => a.commitInventoryUpload(sep, 's.csv', 'TST1', '2026-09', 'Beverage'), /administrator or an inventory reviewer/);
  a.__setUser('rm@example.com');
  assert.throws(() => a.removeInventoryCount(id), /Only an administrator/);
  a.__setUser('stranger@example.com');
  assert.throws(() => a.getInventoryDashboard(), /do not have access/);
  a.__setUser('robert.stevenson@atlasrestaurantgroup.com');
  same(a.removeInventoryCount(id), { removed: true });
  same([a.readDataRows_(a.dataSpreadsheet_(), 'invChecks').length, a.readDataRows_(a.dataSpreadsheet_(), 'invFlags').length], [0, 0]);
  same(a.removeInventoryCount(id), { removed: false });
});

console.log('\n' + passed + ' inventory tests passed' + (process.exitCode ? ', some FAILED' : ''));
