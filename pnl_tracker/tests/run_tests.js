/*
 * Tests for the plain-JavaScript parts of the P&L Tracker (Parse, Budget,
 * Store, Analysis). Run with:   node pnl_tracker/tests/run_tests.js
 *
 * All data here is made up. Real R365 exports contain the company's
 * financials and are never committed; the same checks were run against them
 * locally before this was written.
 */
const assert = require('assert');
const h = require('./harness');
const g = h.loadGs(['Parse.gs', 'Budget.gs', 'Analysis.gs', 'Store.gs']);

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.log("  FAIL " + name + "\n       " + String(e.message).split("\n").slice(0, 8).join("\n       ")); process.exitCode = 1; }
}
const same = (a, b, msg) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), msg);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= (tol == null ? 0.5 : tol), (msg || '') + ' expected ' + b + ', got ' + a);

/* ------------------------------------------------------------------ sample files */

// Account tree in R365's layout. A node is [code - name, children] or [code - name, null] for a line.
// "self" marks R365's habit of repeating the group's own name as its first line.
const TREE = [
  ['SALES (4000)', [
    ['4100 - Gross Sales', [['4110 - Food Sales'], ['4525 - BWL Sales', [['4310 - Liquor Sales'], ['4510 - Wine Sales'], ['4520 - Sake']]], ['4540 - Other Sales']]],
    ['4560 - Discounts & Comps', [['4190 - Food - Disc and Comps']]]
  ], 'NET SALES'],
  ['COST OF SALES (5000)', [
    ['5002 - Food Cost', [['5110 - Meat'], ['5120 - Seafood']]],
    ['5185 - Beer Wine & Liquor Cost', [['5300 - Liquor Cost', [['5300 - Liquor Cost'], ['5320 - Bar Consumables']]], ['5500 - Wine Cost']]]
  ], 'GROSS PROFIT'],
  ['LABOR (6000)', [
    ['6110 - Management - General', [['6100 - Management Salaries and Wages', [['6100 - Management Salaries and Wages']]]]],
    ['6201 - Front of House - Hourly', [['6240 - Servers']]],
    ['6272 - Commission']
  ], 'PROFIT AFTER PRIME COST'],
  ['EXPENSES (7000)', [
    ['7005 - Direct Operating Expenses', [['7005 - Direct Operating Expenses'], ['7122 - Chemical Supplies'], ['7165 - Linen and Linen Rental']]],
    ['7202 - Music & Entertainment', [['7200 - Music and Entertainment']]],
    ['7400 - Utilities', [['7420 - Electricity'], ['7480 - Water and Sewage']]],
    ['9100 - Management Fee']
  ], 'CONTROLLABLE PROFIT'],
  ['NON CONTROLLABLE EXPENSES (8000)', [['8100 - Occupancy Costs', [['8115 - Building Cost']]]], 'OPERATING INCOME'],
  ['CORPORATE OVERHEAD, INTEREST AND OTHER (9000)', [['9190 - Other (Income) / Expense', [['9300 - Other (Income) Expense']]]], 'Net Profit']
];

/** Leaf amounts for one column: a base month, scaled, with overrides. */
function amounts(scale, over) {
  const base = { '4110': 400000, '4310': 150000, '4510': 90000, '4520': null, '4540': 20000, '4190': -20000,
    '5110': 70000, '5120': 40000, '5300': 25000, '5320': 5000, '5500': 28000,
    '6100': 60000, '6240': 35000, '6272': 6000,
    '7005': 300, '7122': 1200, '7165': 5000, '7200': 900, '7420': 8000, '7480': 7000, '9100': 19000,
    '8115': 9000, '9300': 500 };
  const out = {};
  Object.keys(base).forEach(k => { out[k] = base[k] == null ? null : Math.round(base[k] * scale); });
  Object.assign(out, over || {});
  return out;
}

/** Emit one column group's rows: [label, accountName, amount]. */
function columnRows(label, amt, simplified) {
  const rows = [];
  const fmt = v => v == null ? '' : Math.round(v).toLocaleString('en-US');
  function total(node) {
    if (!node[1]) return amt[node[0].split(' - ')[0]] || 0;
    return node[1].reduce((s, c) => s + total(c), 0);
  }
  function emit(node, depth) {
    const [name, kids] = node;
    if (!kids || (simplified && depth === 1)) { rows.push([label, name, fmt(kids ? total(node) : amt[name.split(' - ')[0]])]); return; }
    rows.push([label, name, '']);
    kids.forEach(k => emit(k, depth + 1));
    rows.push([label, 'Total ' + name, fmt(total(node))]);
  }
  let running = 0;
  TREE.forEach(([section, cats, computed], i) => {
    rows.push([label, section, '']);
    cats.forEach(c => emit(c, 1));
    const secTotal = cats.reduce((s, c) => s + total(c), 0);
    if (i === 0) { running = secTotal; rows.push([label, computed, fmt(running)]); return; }
    rows.push([label, 'Total ' + section, fmt(secTotal)]);
    running -= secTotal;
    rows.push([label, computed, fmt(running)]);
  });
  return rows;
}

function csv(reportType, dateRange, location, columns) {
  const q = v => /[",]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : v;
  const lines = ['﻿ReportType,DateRange,Location,Textbox37,Textbox38',
    [reportType, dateRange, location, 'Custom Field:  None', 'Custom Field Options:   None'].map(q).join(','), '',
    'TrxDtlComment,ColumnGroupLabel,TotalHeader,VarianceHeader,TrxDtlComment1,AccountName,Amount,Pct,TotalAmount,TotalPercent,Textbox15,Textbox11,VarianceAmount,VarPercent'];
  // R365 interleaves columns row by row; the parser must not depend on order within a row block.
  const per = columns.map(c => c);
  const n = per[0].length;
  for (let i = 0; i < n; i++) per.forEach(rows => {
    const [label, name, amount] = rows[i];
    lines.push([' - ', label, 'Total', 'Variance B/-W', '', name, amount, amount ? '1.00%' : '', '', '', '', '0.00%', '', ''].map(q).join(','));
  });
  return lines.join('\n') + '\n';
}
const parse = text => g.parsePnlRows_(h.parseCsv(text));

const sideBySide = (period, cols, simplified) => csv('Profit & Loss - Location Side by Side - Period',
  'Period Ending ' + period, 'Location: More than 5 selected',
  cols.map(([label, a]) => columnRows(label, a, simplified)));
const trailing = (ending, property, months) => csv('Profit & Loss - Trailing 12 Periods', '12 Periods Ending ' + ending,
  'Location: ' + property, months.map(([label, a]) => columnRows(label, a)));

/* ---------------------------------------------------------------------- parsing */
console.log('Parse');

test('reads a detailed side-by-side export', () => {
  const r = parse(sideBySide('10/31/2026', [['TST1 - Sample Grill', amounts(1)], ['TST2 - Harbor House', amounts(0.5)]]));
  assert.strictEqual(r.format, 'period');
  assert.strictEqual(r.detailed, true);
  assert.strictEqual(r.periodEnd, '2026-10-31');
  assert.strictEqual(r.groups.length, 2);
  const a = r.groups[0];
  assert.strictEqual(a.propertyCode, 'TST1');
  assert.strictEqual(a.propertyName, 'Sample Grill');
  assert.strictEqual(a.period, '2026-10');
  same(a.problems, []);
  const s = {}; a.summary.forEach(l => { s[l.key] = l; });
  assert.strictEqual(s['4100'].amount, 660000);
  assert.strictEqual(s.NET_SALES.amount, 640000);
  assert.strictEqual(s['5185'].amount, 58000, 'three-level group (5185 → 5300 → 5320)');
  assert.strictEqual(s['6110'].amount, 60000, 'group with a self-named header');
  assert.strictEqual(s['7005'].amount, 6500, 'self-named first line counted once');
  assert.strictEqual(s['9100'].section, '7000', 'management fee sits in expenses');
  assert.strictEqual(s.TOTAL_7000.amount, 6500 + 900 + 15000 + 19000);
  assert.strictEqual(s.OPERATING_INCOME.amount, 640000 - 168000 - 101000 - 41400 - 9000);
  const linen = a.detail.filter(d => d.code === '7165')[0];
  assert.strictEqual(linen.category, '7005');
  assert.strictEqual(a.detail.filter(d => d.code === '5320')[0].category, '5185');
});

test('reads a simplified export (categories only)', () => {
  const r = parse(sideBySide('09/30/2026', [['TST1 - Sample Grill', amounts(1)]], true));
  assert.strictEqual(r.detailed, false);
  same(r.groups[0].problems, []);
  assert.strictEqual(r.groups[0].summary.filter(l => l.key === 'OPERATING_INCOME')[0].amount, 320600);
});

test('reads a trailing-12 export, one column per month', () => {
  const months = [];
  for (let m = 1; m <= 12; m++) months.push(['Period ' + m + ', 2025', amounts(1 + m / 100)]);
  const r = parse(trailing('12/31/2025', 'TST1 - Sample Grill', months));
  assert.strictEqual(r.format, 'trailing12');
  assert.strictEqual(r.groups.length, 12);
  assert.strictEqual(r.groups[0].period, '2025-01');
  assert.strictEqual(r.groups[11].period, '2025-12');
  assert.ok(r.groups.every(x => x.propertyCode === 'TST1' && !x.problems.length));
});

test('flags totals that do not add up', () => {
  const text = sideBySide('10/31/2026', [['TST1 - Sample Grill', amounts(1)]]).replace('Total 7400 - Utilities,"15,000"', 'Total 7400 - Utilities,"16,000"');
  const r = parse(text);
  assert.ok(r.groups[0].problems.some(p => /Utilities/.test(p.line)), JSON.stringify(r.groups[0].problems));
});

test('rejects files that are not an R365 P&L', () => {
  assert.throws(() => parse('a,b\n1,2\n3,4\n5,6\n7,8\n'), /Profit & Loss/);
  assert.throws(() => parse(csv('Profit & Loss - Trailing 12 Periods', '12 Periods Ending 12/31/2025', 'Location: More than 5 selected',
    [columnRows('Period 1, 2025', amounts(1))])), /one location/);
});

test('reads R365 number formats', () => {
  assert.strictEqual(g.parsePnlNumber_('"1,234"'.replace(/"/g, '')), 1234);
  assert.strictEqual(g.parsePnlNumber_('-1,460'), -1460);
  assert.strictEqual(g.parsePnlNumber_('(250)'), -250);
  assert.strictEqual(g.parsePnlNumber_('-100.0 %'), -100);
  assert.strictEqual(g.parsePnlNumber_(''), null);
});

/* ----------------------------------------------------------------------- budget */
console.log('Budget');

/** A small 12 MONTH tab plus one daily tab, in the template's layout. */
function budgetSheets() {
  const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', null, 'APRIL', 'MAY', 'JUNE', null, 'JULY', 'AUGUST', 'SEPTEMBER', null, 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
  const header = [null, null, null, null, null].concat(MONTHS, [null, 2026]);
  const row = (gl, label, monthly) => [0, 0, gl, label, null].concat(MONTHS.map(m => m ? monthly : null));
  const grid = [[null, 'SAMPLE GRILL'], header,
    row('GL CODE', 'RESTAURANT GROSS F&B SALES', 600000),
    row('4540', 'Facilities Fee', 20000),
    row('4560', 'TOTAL COMPS', -20000),
    row(null, 'TOTAL NET', 600000),
    row('5002', 'FOOD COST', 110000),
    row('5185', 'BEVERAGE COSTS', 55000),
    row('5190', 'NA Beverage Costs', 4000),
    row('6100', 'MANAGEMENT SALARIES & WAGES', 55000),
    row('6100', 'CORPORATE ALLOCATIONS', 8000),
    row('6201', 'FOH HOURLY LABOR', 40000),
    row('6272', 'Commissions', 6000),
    row(null, 'Payroll Related Expenses', null),
    row('6275', 'Payroll Related Expenses', 30000),
    row('7122', 'Chemical Supplies', 1200),
    row('7165', 'Linen and Linen Rental', 5000),
    row('7005', 'Total Direct Operating Expenses', 7000),
    row('7200', 'Music and Entertainment', 1000),
    row('7202', 'Total Music & Entertainment', 1000),
    row('7420', 'Electricity', 8000),
    row('7480', 'Water and Sewage', 7000),
    row('7400.0', 'Total Utilities', 15000),
    row('9100', 'Management Fee', 18000),
    row('8100', 'Total Occupancy Costs', 9000),
    row(null, 'NET OPERATING INCOME', 600000 - 169000 - 139000 - 41000 - 9000)
  ];
  // OCT daily tab: banquet entered as one lump on the 1st.
  const days = [null, null, null, null]; for (let d = 1; d <= 31; d++) days.push(d);
  const gross = [null, null, null, 'TOTAL GROSS SALES']; const banquet = [null, null, null, 'BANQUET Sales'];
  for (let d = 1; d <= 31; d++) { gross.push(d === 1 ? 155000 + 15000 : 15000); banquet.push(d === 1 ? 155000 : 0); }
  return { '12 MONTH': grid, OCT: [[null, null, null, 'OCTOBER'], days, [], gross, banquet] };
}

test('rolls the 12 MONTH tab up to P&L lines and checks it against the template totals', () => {
  const b = g.parseBudgetSheets_(budgetSheets());
  assert.strictEqual(b.year, 2026);
  assert.strictEqual(b.lines['4100'][9], 620000, 'gross sales include the facilities fee');
  assert.strictEqual(b.lines['6110'][9], 55000, 'management = salaries only');
  assert.strictEqual(b.lines['9010'][9], 8000, 'corporate allocations sit below operating income');
  assert.strictEqual(b.lines['6275'][0], 30000, 'repeated label matched by GL code');
  assert.strictEqual(b.gl['7165'].months[9], 5000);
  assert.strictEqual(b.gl['7400'].months[0], 15000, '7400.0 read as 7400');
  const st = g.budgetSubtotals_(b.lines, 9);
  assert.strictEqual(st.NET_SALES, 600000);
  assert.strictEqual(st.OPERATING_INCOME, 600000 - 169000 - 131000 - 41000 - 9000);
  assert.ok(b.checks.filter(c => /TOTAL NET/.test(c.label))[0].ok);
  assert.ok(b.checks.filter(c => /NET OPERATING INCOME/.test(c.label))[0].ok);
});

test('month-to-date budget spreads banquets over the month', () => {
  const b = g.parseBudgetSheets_(budgetSheets());
  const f = g.budgetMonthFraction_(b.daily, 2026, 10, 3);
  near(f, (3 * 15000 + 155000 * 3 / 31) / (31 * 15000 + 155000), 1e-9);
  assert.strictEqual(g.budgetMonthFraction_(b.daily, 2026, 10, 31), 1);
  near(g.budgetMonthFraction_(null, 2026, 11, 3), 0.1, 1e-9, 'no daily budget: days elapsed');
});

/* ------------------------------------------------------------------ stages */
console.log('Stages');

test('a month is month-to-date, preliminary, then settled', () => {
  assert.strictEqual(g.stageFor_('2026-11', '2026-11-03', 15), 'mtd');
  assert.strictEqual(g.stageFor_('2026-10', '2026-11-03', 15), 'preliminary');
  assert.strictEqual(g.stageFor_('2026-10', '2026-11-15', 15), 'settled');
  assert.strictEqual(g.stageFor_('2026-02', '2026-03-14', 15), 'preliminary');
});

/* ------------------------------------------------------------ store + analysis */
console.log('Analysis');

/** 2025 history and 2026 Jan–Oct for one property, with a budget, through the app's own conversion. */
function sampleStore(octOverrides, octAsOf) {
  let actuals = [], detail = [];
  const load = (text, asOf, id) => {
    const r = g.parsedToRows_(parse(text), asOf, id, 15);
    actuals = g.withoutMonths_(actuals, r.months).concat(r.actuals);
    detail = g.withoutMonths_(detail, r.months).concat(r.detail);
  };
  const m2025 = []; for (let m = 1; m <= 12; m++) m2025.push(['Period ' + m + ', 2025', amounts(0.95)]);
  load(trailing('12/31/2025', 'TST1 - Sample Grill', m2025), '2026-11-03', 'a');
  const m2026 = []; for (let m = 1; m <= 9; m++) m2026.push(['Period ' + m + ', 2026', amounts(1)]);
  load(trailing('09/30/2026', 'TST1 - Sample Grill', m2026), '2026-10-20', 'b');
  load(sideBySide('10/31/2026', [['TST1 - Sample Grill', amounts(1, octOverrides)]]), octAsOf || '2026-11-03', 'c');
  const budget = g.budgetToRows_(g.parseBudgetSheets_(budgetSheets()), 'TST1');
  return g.rowsToStore_({ actuals, detail, budget, tags: [] }, [{ code: 'TST1', name: 'Sample Grill', active: true }], {});
}

test('re-uploading a month replaces it instead of adding to it', () => {
  const s = sampleStore();
  assert.strictEqual(Object.keys(s.actuals.TST1).length, 22);
  assert.strictEqual(s.actuals.TST1['2026-10'].stage, 'preliminary');
  assert.strictEqual(s.actuals.TST1['2026-09'].stage, 'settled');
});

test('a normal month has no flags and nothing missing', () => {
  const r = g.buildPeriodReport_(sampleStore(), 'TST1', '2026-10');
  same(r.flags.map(f => f.key), []);
  same(r.missing, []);
  assert.ok(r.hasBudget && r.hasLastYear && r.threeMonths);
  const oi = r.rows.filter(x => x.key === 'OPERATING_INCOME')[0];
  assert.strictEqual(oi.actual, 320600);
  assert.strictEqual(oi.budget, 600000 - 169000 - 131000 - 41000 - 9000);
});

test('one bad month is a spike, explained by its sub-accounts against budget', () => {
  const r = g.buildPeriodReport_(sampleStore({ '7420': 22000 }), 'TST1', '2026-10');
  const f = r.flags.filter(x => x.key === '7400')[0];
  assert.ok(f, 'utilities flagged');
  assert.strictEqual(f.type, 'spike', 'the months before were within budget');
  assert.strictEqual(f.drivers.basis, 'budget');
  assert.strictEqual(f.drivers.lines[0].code, '7420');
  assert.strictEqual(f.drivers.lines[0].worseBy, 14000);
});

test('a month with a recurring line not posted reports it as missing, with operating income if it posts', () => {
  const r = g.buildPeriodReport_(sampleStore({ '9100': 0, '6272': 0 }), 'TST1', '2026-10');
  same(r.missing.map(m => m.key).sort(), ['6272', '9100']);
  assert.ok(r.missing.every(m => m.severity === 'pending'), 'preliminary month');
  const oi = r.rows.filter(x => x.key === 'OPERATING_INCOME')[0].actual;
  assert.strictEqual(r.headline.ifMissingPosted, oi - 18000 - 6000);
  const settled = g.buildPeriodReport_(sampleStore({ '9100': 0 }, '2026-11-20'), 'TST1', '2026-10');
  assert.strictEqual(settled.missing[0].severity, 'warning');
});

test('a line that was near zero all year and now recurs is new', () => {
  const s = sampleStore({ '7200': 11000 });
  s.actuals.TST1['2026-09'].lines['7202'].amount = 10500;
  const r = g.buildPeriodReport_(s, 'TST1', '2026-10');
  assert.strictEqual(r.flags.filter(x => x.key === '7202')[0].type, 'new');
});

test('three bad months in a row are a trend', () => {
  const s = sampleStore({ '7420': 22000 });
  ['2026-08', '2026-09'].forEach(p => { s.actuals.TST1[p].lines['7400'].amount = 29000; });
  const r = g.buildPeriodReport_(s, 'TST1', '2026-10');
  assert.strictEqual(r.flags.filter(x => x.key === '7400')[0].type, 'trend');
});

test('a month tagged as timing is left out of the normal range', () => {
  const s = sampleStore();
  s.actuals.TST1['2026-06'].lines['7400'].amount = 60000;
  const before = g.normalRange_(s, 'TST1', '2026-10', '7400', g.priorMonths_(s, 'TST1', '2026-10', 12));
  s.tags.TST1 = { '2026-06': { '7400': { tag: 'timing', note: 'catch-up bill' } } };
  const after = g.normalRange_(s, 'TST1', '2026-10', '7400', g.priorMonths_(s, 'TST1', '2026-10', 12));
  assert.ok(after.months === before.months - 1);
});

test('without a budget, flags come from the normal range and drivers from last year', () => {
  const s = sampleStore({ '7165': 16000 });
  delete s.budgets.TST1;
  const r = g.buildPeriodReport_(s, 'TST1', '2026-10');
  const f = r.flags.filter(x => x.key === '7005')[0];
  assert.ok(f && f.outsideNormal, JSON.stringify(r.flags));
  assert.strictEqual(f.drivers.basis, 'same month last year');
  assert.strictEqual(f.drivers.lines[0].code, '7165');
});

test('month to date: budget and last year are cut to the same share of the month', () => {
  let actuals = [], detail = [];
  const r1 = g.parsedToRows_(parse(sideBySide('11/30/2026', [['TST1 - Sample Grill', amounts(0.1)]])), '2026-11-03', 'm', 15);
  const base = sampleStore();
  const s = g.rowsToStore_({ actuals: r1.actuals, detail: [], budget: g.budgetToRows_(g.parseBudgetSheets_(budgetSheets()), 'TST1'), tags: [] },
    [{ code: 'TST1', name: 'Sample Grill', active: true }], {});
  s.actuals.TST1['2025-11'] = base.actuals.TST1['2025-11'];
  const r = g.buildPeriodReport_(s, 'TST1', '2026-11');
  assert.strictEqual(r.stage, 'mtd');
  near(r.fraction, 0.1);
  const net = r.rows.filter(x => x.key === 'NET_SALES')[0];
  near(net.budget, 60000, 1);
  near(net.ly, base.actuals.TST1['2025-11'].lines.NET_SALES.amount * 0.1, 1);
  assert.ok(r.flags.every(f => f.type === 'pace'));
});

test('portfolio ranks properties by operating income %', () => {
  const s = sampleStore();
  s.properties.push({ code: 'TST2', name: 'Harbor House', active: true });
  const r2 = g.parsedToRows_(parse(sideBySide('10/31/2026', [['TST2 - Harbor House', amounts(1, { '6240': 90000 })]])), '2026-11-03', 'x', 15);
  r2.actuals.forEach(row => {
    const byProp = s.actuals.TST2 = s.actuals.TST2 || {};
    const m = byProp[row[0]] = byProp[row[0]] || { stage: row[8], asOf: row[9], lines: {} };
    m.lines[row[2]] = { key: row[2], name: row[3], section: row[4], kind: row[5], amount: row[6], pct: null };
  });
  const p = g.buildPortfolio_(s, '2026-10');
  same(p.rows.map(r => r.code), ['TST1', 'TST2']);
  assert.strictEqual(p.totals.properties, 2);
  near(p.totals.oi, 320600 + 265600, 1);
});

test('trends return 24 months with budget and last year', () => {
  const t = g.buildTrend_(sampleStore(), 'TST1', 'OI_PCT', '2026-10', 24);
  assert.strictEqual(t.points.length, 24);
  assert.strictEqual(t.points[23].period, '2026-10');
  assert.ok(t.points[23].budget != null && t.points[23].ly != null);
  assert.strictEqual(t.points[0].actual, null, 'Nov 2024 not on file');
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
