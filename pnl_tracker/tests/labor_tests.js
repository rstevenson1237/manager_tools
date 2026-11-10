/*
 * Tests for the weekly sales and labor review: Labor.gs on its own, then the
 * endpoints (LaborApi.gs with Code.gs, Store.gs …) against the in-memory Apps
 * Script stand-in in gas_mock.js. Run with:
 *   node pnl_tracker/tests/labor_tests.js
 * (run_tests.js runs it too). All data here is made up (tests/labor_sample.js).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const h = require('./harness');
const mock = require('./gas_mock');
const S = require('./labor_sample');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + String(e.stack || e.message).split('\n').slice(0, 6).join('\n       ')); process.exitCode = 1; }
}
const same = (a, b, msg) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), msg);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= (tol == null ? 0.01 : tol), (msg || '') + ' expected ' + b + ', got ' + a);

const g = h.loadGs(['Store.gs', 'Budget.gs', 'Analysis.gs', 'Labor.gs']);
const WEEK = '2026-11-02';
const parse = text => g.parseLaborCsv_(h.parseCsv(text));
const groupOf = g.laborGroupFn_({});

/** A report for one parsed location, the way getLaborWeek builds it. */
function reportFor(loc, opts) {
  opts = opts || {};
  const p = opts.parsed;
  const jobs = Object.keys(loc.jobs).map(j => ({ job: j, totals: loc.jobs[j], employees: 1 }));
  const week = { week: p.week, end: p.end, property: 'TST1', location: loc.location, stage: g.laborStage_(loc, p.end, '2026-11-20'),
    sales: loc.sales, totals: loc.totals, uploadedAt: '2026-11-10T12:00:00Z' };
  return g.buildLaborWeekReport_({ week, jobs, shifts: loc.shifts, recent: opts.recent || [],
    groupOf: opts.groupOf || groupOf, budget: opts.budget || null });
}

/* ------------------------------------------------------------------ parsing */
console.log('Labor: reading the export');

test('reads the week, every location, job code and employee day', () => {
  const p = parse(S.laborCsv(WEEK, [S.sampleGrill(), S.harborHouse()]));
  same([p.week, p.end, p.locations.length, p.tieOuts.length, p.warnings.length], [WEEK, '2026-11-08', 2, 0, 0]);
  const L = p.locations[0];
  same([L.location, L.sales.net, L.sales.forecast, L.sales.py], ['Sample Grill Baltimore', 30000, 33000, 29000]);
  same(Object.keys(L.jobs).sort(), ['Bartender Ghost (PM)', 'Chef', 'FOH Management', 'Host', 'Line Cook', 'Server']);
  const ann = L.shifts.filter(s => s.employee === 'Ann Able')[0];
  same([ann.totals.a, ann.totals.s, ann.days[5].a, ann.days[5].s], [48, 40, 8, 0]);
  near(L.totals.aa, L.rows ? L.totals.aa : 0);
});

test('two rows for the same employee, job and day are added together', () => {
  const loc = S.sampleGrill();
  loc.rows.push(['Host', 'Hal Hart', 0, 1, 0, 0, 15, 0]);   // a punch R365 lists apart from the shift
  const hal = parse(S.laborCsv(WEEK, [loc])).locations[0].shifts.filter(s => s.employee === 'Hal Hart')[0];
  same([hal.days[0].a, hal.days[0].s, hal.days[0].aa], [5, 4, 75]);
});

test('R365 number formats: thousands, negatives, percent signs, 2- and 4-digit years', () => {
  same([g.laborNum_('2,147.26'), g.laborNum_('-364.75'), g.laborNum_('-100.0 %'), g.laborNum_('(5.00)'), g.laborNum_(''), g.laborNum_('x')],
    [2147.26, -364.75, -100, -5, 0, 0]);
  same([g.laborDate_('11/2/26'), g.laborDate_('6/1/2026'), g.laborDate_('2026-11-02')], ['2026-11-02', '2026-06-01', '2026-11-02']);
});

test('a job code whose rows do not add up fails the tie-out; cent rounding does not', () => {
  const bad = parse(S.laborCsv(WEEK, [S.sampleGrill()], { breakJob: 'Sample Grill Baltimore|Server' }));
  assert.ok(bad.tieOuts.some(t => /Server: actual hours add up to/.test(t)), JSON.stringify(bad.tieOuts));
  // Every row rounded to the cent, totals from the unrounded figures: within half a cent a row.
  const loc = S.sampleGrill();
  loc.rows = loc.rows.map(r => r.slice(0, 6).concat([r[6] + 0.004, r[7]]));
  same(parse(S.laborCsv(WEEK, [loc])).tieOuts, []);
});

test('refuses another report, a missing column, and more than one week', () => {
  assert.throws(() => parse('ReportType,DateRange\nProfit & Loss,Period Ending 10/31/2026\n'), /not an R365 "Labor Actual vs Scheduled/);
  assert.throws(() => parse(S.laborCsv(WEEK, [S.sampleGrill()]).replace('ForeSale', 'Forecast')), /missing these columns: ForeSale/);
  assert.throws(() => parse(S.laborCsv(WEEK, [S.sampleGrill()]).replace('11/8/2026', '11/15/2026')), /covers 14 days/);
});

test('a row dated outside the week is left out with a warning', () => {
  const text = S.laborCsv(WEEK, [S.harborHouse()]).replace(',11/8/26,', ',11/9/26,');
  const p = parse(text);
  assert.ok(/outside the week/.test(p.warnings[0]));
});

test('stage: a schedule has no actuals; a week not over is in progress', () => {
  const p = parse(S.laborCsv(WEEK, [S.sampleGrill(), S.asSchedule(S.harborHouse())]));
  same([g.laborStage_(p.locations[0], p.end, '2026-11-20'), g.laborStage_(p.locations[0], p.end, '2026-11-06'), g.laborStage_(p.locations[1], p.end, '2026-11-20')],
    ['actual', 'partial', 'schedule']);
});

test('job code groups are guessed from the name', () => {
  const by = {};
  ['Server', 'R-Bartender', 'Busser-Ruxton', 'HOST', 'Barback', 'Bar Prep', 'Shift Supervisor', 'LINE COOK', 'Dishwasher', 'SUSHI COOKS', 'Pastry Cook',
    'Porter', 'RAW BAR', 'Chef', 'Manager', 'MGMT-BOH', 'FOH-MANAGEMENT', 'AGM', 'General Manager', 'Shift Manager / Assistant Manager',
    'Bartender Ghost (PM)', 'Host-Ghost-Togo', 'Default Generic User (Do Not Delete)']
    .forEach(j => { (by[g.guessLaborGroup_(j)] = by[g.guessLaborGroup_(j)] || []).push(j); });
  same(by.FOH, ['Server', 'R-Bartender', 'Busser-Ruxton', 'HOST', 'Barback', 'Bar Prep', 'Shift Supervisor']);
  same(by.BOH, ['LINE COOK', 'Dishwasher', 'SUSHI COOKS', 'Pastry Cook', 'Porter', 'RAW BAR']);
  same(by.MGMT, ['Chef', 'Manager', 'MGMT-BOH', 'FOH-MANAGEMENT', 'AGM', 'General Manager', 'Shift Manager / Assistant Manager']);
  same(by.NONE, ['Bartender Ghost (PM)', 'Host-Ghost-Togo', 'Default Generic User (Do Not Delete)']);
  same(g.laborGroupFn_({ 'pastry cook': 'FOH' })('PASTRY  Cook'), 'FOH', 'a saved group wins, matched without case or extra spaces');
});

test('a location is matched to a property by name', () => {
  const props = [{ code: 'TST1', name: 'Sample Grill' }, { code: 'TST2', name: 'Harbor House' }, { code: 'TST3', name: 'Sample' }];
  same([g.guessLaborProperty_('Sample Grill Baltimore', props), g.guessLaborProperty_('Harbor House', props), g.guessLaborProperty_('Pop-up Kiosk', props),
    g.guessLaborProperty_('Pop-up Kiosk', props, { 'Pop-up Kiosk': 'TST2' })], ['TST1', 'TST2', '', 'TST2']);
});

test('sheet rows round-trip', () => {
  const p = parse(S.laborCsv(WEEK, [S.sampleGrill()]));
  const L = p.locations[0];
  const w = g.laborWeekFromRow_(g.laborWeekRow_({ week: WEEK, end: p.end, property: 'TST1', location: L.location, stage: 'actual', sales: L.sales, totals: L.totals }));
  same([w.week, w.sales.forecast, w.totals.s], [WEEK, 33000, L.totals.s]);
  const j = g.laborJobRows_(WEEK, 'TST1', L).map(g.laborJobFromRow_).filter(x => x.job === 'Server')[0];
  same([j.totals.a, j.totals.s, j.employees], [74, 66, 3]);
});

/* ------------------------------------------------------------------ report */
console.log('Labor: the week report');

const P = parse(S.laborCsv(WEEK, [S.sampleGrill()]));
const R = reportFor(P.locations[0], { parsed: P });
const grp = k => R.groups.filter(x => x.key === k)[0];

test('groups: hourly is FOH + BOH; management shows hours only; ghost codes are left out', () => {
  same([grp('FOH').schHrs, grp('FOH').actHrs, grp('BOH').schHrs, grp('BOH').actHrs], [70, 78, 85, 92.5]);
  same([grp('HOURLY').schHrs, grp('HOURLY').actHrs], [155, 170.5]);
  same([grp('MGMT').schHrs, grp('MGMT').actHrs, grp('MGMT').schPay, grp('MGMT').schOverTarget], [105, 0, 0, null]);
  same([grp('NONE').actHrs], [12]);
  near(grp('HOURLY').actPct, grp('HOURLY').actPay / 30000 * 100);
  near(grp('HOURLY').schPct, grp('HOURLY').schPay / 33000 * 100);
});

test('a day worked unscheduled where a scheduled shift went unworked is a cover, not added labor', () => {
  const off = R.people.off;
  const ann = off.list.filter(p => p.employee === 'Ann Able')[0];
  same([ann.unscheduled.length, ann.unscheduled[0].coveredFor, ann.unscheduled[0].addedHrs, ann.extraHrs], [1, ['Bea Bell'], 0, 0]);
  const bea = off.list.filter(p => p.employee === 'Bea Bell')[0];
  same(bea.missed[0].coveredBy, ['Ann Able']);
  const cy = off.list.filter(p => p.employee === 'Cy Cole')[0];
  same([cy.unscheduled[0].day, cy.unscheduled[0].addedHrs, cy.over[0].hrs, cy.extraHrs, cy.extraPay], [6, 5, 3, 8, 40]);
  same([off.totals.unscheduledShifts, off.totals.coveredShifts, off.totals.addedHrs, off.totals.uncoveredMissed], [2, 1, 5, 0]);
  const dee = off.list.filter(p => p.employee === 'Dee Dunn')[0];
  same([dee.over.length, dee.extraHrs], [5, 7.5], 'days 1.5 hours over the schedule');
  assert.ok(!off.list.some(p => /GHOST|Kim|Max/.test(p.employee)), 'management and ghost codes are not people off the schedule');
});

test('overtime: hours, the premium at half the straight-time rate, and whether the schedule wrote it in', () => {
  const ot = R.people.overtime;
  same(ot.map(o => [o.employee, o.otHrs, o.premium, o.cause]), [['Dee Dunn', 7.5, 75, 'extra'], ['Eli Egan', 5, 50, 'scheduled']]);
  same(R.people.otTotals, { hrs: 12.5, premium: 125, scheduledHrs: 5 });
  same(R.people.scheduledOver.map(x => [x.employee, x.schHrs, x.overHrs]), [['Eli Egan', 45, 5]]);
});

test('job codes: worked with nothing scheduled, and over the schedule', () => {
  const loc = S.sampleGrill();
  for (let d = 0; d < 3; d++) loc.rows.push(['Runner', 'Rae Ray', d, 5, 0, 0, 50, 0]);
  for (let d = 0; d < 5; d++) loc.rows.push(['Prep Cook', 'Pat Poe', d, 9, 6, 0, 135, 90]);
  const p = parse(S.laborCsv(WEEK, [loc]));
  const r = reportFor(p.locations[0], { parsed: p });
  const job = n => r.jobs.filter(j => j.job === n)[0];
  same(job('Runner').notes.map(x => x.kind), ['unscheduled']);
  same(job('Prep Cook').notes.map(x => x.kind), ['over']);
  same(job('Host').notes, []);
  assert.ok(r.findings.some(f => /1 job code worked with nothing scheduled/.test(f.title)));
});

test('findings: sales against forecast, shifts off the schedule, overtime', () => {
  const titles = R.findings.map(f => f.title);
  assert.ok(titles.some(t => /2 shifts worked that were not on the schedule/.test(t)), titles.join(' | '));
  assert.ok(titles.some(t => /12.5 overtime hours, 2 employees/.test(t)));
  assert.ok(!titles.some(t => /forecast by/.test(t)), 'sales 9% under forecast is inside the 10% rule');
  const miss = reportFor(P.locations[0], { parsed: Object.assign({}, P) });
  assert.ok(miss);
  const p2 = parse(S.laborCsv(WEEK, [S.sampleGrill({ net: 27000 })]));
  const f = reportFor(p2.locations[0], { parsed: p2 }).findings.filter(x => /missed the forecast/.test(x.title))[0];
  assert.ok(f && f.severity === 'bad' && /18.2%/.test(f.title), JSON.stringify(f));
});

test('targets from the budget: the week\'s share of the month, and 6201 / 6209 as % of net sales', () => {
  const months = v => [v, v, v, v, v, v, v, v, v, v, v, v];
  const store = { budgets: { TST1: { 2026: { lines: { '4100': months(300000), '6201': months(15000), '6209': months(4500) }, gl: {}, daily: {} } } } };
  const b = g.laborBudgetWeek_(store, 'TST1', WEEK);
  near(b.net, 300000 * 7 / 30, 0.5);
  same([Math.round(b.fohPct * 10) / 10, Math.round(b.bohPct * 10) / 10, Math.round(b.hourlyPct * 10) / 10], [5, 1.5, 6.5]);
  // A week across two months takes each day from its own month.
  store.budgets.TST1[2026].lines['4100'][11] = 620000;
  near(g.laborBudgetWeek_(store, 'TST1', '2026-11-30').net, 300000 / 30 + 620000 / 31 * 6, 0.5);
  assert.strictEqual(g.laborBudgetWeek_(store, 'TST9', WEEK), null);

  const r = reportFor(P.locations[0], { parsed: P, budget: b });
  same(r.targetSource, 'budget');
  const boh = r.groups.filter(x => x.key === 'BOH')[0];
  near(boh.actOverTarget, boh.actPay - 0.015 * 30000);
  assert.ok(r.findings.some(f => /Back of house ran at 6.6% of sales; target 1.5%/.test(f.title)), r.findings.map(f => f.title).join(' | '));
});

test('without a budget, targets and job code hours come from recent weeks', () => {
  const p = parse(S.laborCsv('2026-10-26', [S.sampleGrill()]));
  const L = p.locations[0];
  const prior = { week: { week: '2026-10-26', sales: { net: 30000 } }, jobs: Object.keys(L.jobs).map(j => ({ job: j, totals: Object.assign({}, L.jobs[j], { a: L.jobs[j].a * 0.5 }) })) };
  const r = reportFor(P.locations[0], { parsed: P, recent: [prior] });
  same([r.targetSource, r.recentWeeks], ['recent', 1]);
  const server = r.jobs.filter(j => j.job === 'Server')[0];
  same(server.recentHrs, 37);
  assert.ok(server.notes.some(n => n.kind === 'aboveRecent'), 'scheduled 66 hrs against 37 recently, with sales flat');
});

test('a schedule (upcoming week): judged on the forecast; overtime written into it is flagged', () => {
  const p = parse(S.laborCsv('2026-11-16', [S.asSchedule(S.sampleGrill())]));
  const r = reportFor(p.locations[0], { parsed: p });
  same([r.stage, r.people.off.list.length, r.groups[2].actPct], ['schedule', 0, null]);
  assert.ok(r.findings.some(f => /1 employee scheduled over 40 hours/.test(f.title)), r.findings.map(f => f.title).join(' | '));
  const noFc = parse(S.laborCsv('2026-11-16', [S.asSchedule(S.sampleGrill({ forecast: 0 }))]));
  assert.ok(reportFor(noFc.locations[0], { parsed: noFc }).findings.some(f => f.title === 'No sales forecast'));
});

test('one person scheduled and clocked in under two spellings is one person', () => {
  same([g.laborSameName_('Rodriguez, Bernadino', 'Rodriguez, Bernardino'), g.laborSameName_('Swilling, Kenya Megan', 'Swilling, Kenya'),
    g.laborSameName_('Efrain Rivera', 'Rivera, Efrain'), g.laborSameName_('Rivera, Efrain', 'Rivera, Ruben'), g.laborSameName_('Lee, Al', 'Lee, Ali'),
    g.laborSameName_('Smith, John', 'Smyth, John')], [true, true, true, false, false, false]);
  const loc = S.sampleGrill();
  [1, 3].forEach(d => {                                            // scheduled as Grant, Gustavo; clocks in as Gus Grant
    loc.rows.push(['Server', 'Grant, Gustavo', d, 0, 6, 0, 0, 30]);
    loc.rows.push(['Server', 'Gus Grant', d, d === 3 ? 8 : 6, 0, 0, d === 3 ? 40 : 30, 0]);
  });
  const p = parse(S.laborCsv(WEEK, [loc]));
  const r = reportFor(p.locations[0], { parsed: p });
  same(r.namePairs, [{ worked: 'Gus Grant', scheduled: 'Grant, Gustavo' }]);
  const gus = r.people.off.list.filter(x => x.employee === 'Gus Grant')[0];
  same([gus.unscheduled.length, gus.missed.length, gus.over.map(o => o.hrs)], [0, 0, [2]], 'scheduled shifts worked, Thursday 2 hours long');
  assert.ok(!r.people.off.list.some(x => x.employee === 'Grant, Gustavo'));
  assert.ok(r.findings.some(f => /scheduled under a different name/.test(f.title)));
  // Two different people with the same last name are not joined.
  const two = S.sampleGrill();
  two.rows.push(['Server', 'Able, Zoe', 6, 0, 6, 0, 0, 30]);
  const p2 = parse(S.laborCsv(WEEK, [two]));
  same(reportFor(p2.locations[0], { parsed: p2 }).namePairs, []);
});

test('front and back of house over target are reported on their own, not again as hourly', () => {
  const months = v => [v, v, v, v, v, v, v, v, v, v, v, v];
  const store = { budgets: { TST1: { 2026: { lines: { '4100': months(300000), '6201': months(3000), '6209': months(3000) }, gl: {}, daily: {} } } } };
  const r = reportFor(P.locations[0], { parsed: P, budget: g.laborBudgetWeek_(store, 'TST1', WEEK) });
  const t = r.findings.map(f => f.title);
  assert.ok(t.some(x => /^Front of house ran/.test(x)) && t.some(x => /^Back of house ran/.test(x)), t.join(' | '));
  assert.ok(!t.some(x => /^Hourly labor/.test(x)), t.join(' | '));
});

/* ---------------------------------------------------------------- endpoints */
console.log('Labor: endpoints (against the Apps Script stand-in)');

function app(user) {
  const ctx = vm.createContext({ console: console, Math: Math, JSON: JSON, Date: Date });
  mock.installGasMock(ctx, { user: 'robert.stevenson@atlasrestaurantgroup.com' });
  ['Parse.gs', 'Budget.gs', 'Analysis.gs', 'Store.gs', 'Review.gs', 'InventoryRules.gs', 'InventoryCheck.gs', 'Labor.gs', 'Code.gs', 'Import.gs', 'InventoryApi.gs', 'LaborApi.gs']
    .forEach(f => vm.runInContext(fs.readFileSync(path.join(h.ROOT, f), 'utf8'), ctx, { filename: f }));
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
const rows = (a, key) => a.readDataRows_(a.dataSpreadsheet_(), key);
const past = S.laborCsv(WEEK, [S.sampleGrill(), S.harborHouse(), S.unknownPlace()]);

test('setup makes the three labor tabs', () => {
  const names = app().dataSpreadsheet_().getSheets().map(s => s.getName());
  ['Labor Weeks', 'Labor Jobs', 'Labor Items'].forEach(n => assert.ok(names.indexOf(n) !== -1, n));
  assert.ok(names.indexOf('Labor Shifts') === -1);
});

test('preview: matches locations to properties, writes nothing', () => {
  const a = app();
  const p = a.previewLaborUpload(past, 'labor.csv');
  same(p.locations.map(l => [l.location, l.property, l.matched, l.stage]),
    [['Sample Grill Baltimore', 'TST1', true, 'actual'], ['Harbor House', 'TST2', true, 'actual'], ['Pop-up Kiosk', 'Pop-up Kiosk', false, 'actual']]);
  assert.ok(p.newJobs.some(j => j.job === 'Chef' && j.group === 'MGMT'));
  same(rows(a, 'laborWeeks'), []);
});

test('save: weeks and job codes; skip a location; remember the mapping and the job code groups', () => {
  const a = app();
  const res = a.commitLaborUpload(past, 'labor.csv', { 'Sample Grill Baltimore': 'TST1', 'Harbor House': 'TST2', 'Pop-up Kiosk': '' });
  same([res.saved.map(s => s.property), res.skipped], [['TST1', 'TST2'], ['Pop-up Kiosk']]);
  same([rows(a, 'laborWeeks').length, rows(a, 'laborJobs').length], [2, 8]);
  assert.ok(!a.dataSpreadsheet_().getSheetByName('Labor Shifts'), 'no employee-by-day rows are kept');
  const cfg = a.readConfig_(a.dataSpreadsheet_());
  same([cfg.labor.locations['Harbor House'], cfg.labor.jobs.chef, cfg.labor.jobs['bartender ghost (pm)']], ['TST2', 'MGMT', 'NONE']);
  const up = rows(a, 'uploads').filter(r => r[4] === 'labor')[0];
  same([up[6], up[7]], [WEEK, 'TST1, TST2']);
});

test('dashboard rows and the week report', () => {
  const a = app();
  a.commitLaborUpload(past, 'labor.csv', { 'Pop-up Kiosk': '' });
  const d = a.getLaborDashboard();
  same(d.rows.map(r => [r.property, r.week, r.stage, r.HOURLY.schHrs, r.mgmtSchHrs]), [['TST1', WEEK, 'actual', 155, 105], ['TST2', WEEK, 'actual', 84, 0]]);
  const rep = a.getLaborWeek('TST1', WEEK).report;
  same([rep.property, rep.people.otTotals.hrs, rep.people.off.totals.coveredShifts], ['TST1', 12.5, 1]);
  same(a.getLaborWeek('TST1', '2026-10-26').report, null);
});

test('only what the report names is kept: people named, a summary, and the job code record', () => {
  const a = app();
  a.commitLaborUpload(past, 'labor.csv', { 'Pop-up Kiosk': '' });
  const items = rows(a, 'laborItems').filter(r => r[1] === 'TST1');
  const by = items.reduce((o, r) => { o[r[2]] = (o[r[2]] || []).concat([r[3]]); return o; }, {});
  same(by.off.sort(), ['Ann Able', 'Cy Cole', 'Dee Dunn'], 'Eli and Hal worked their schedule, and Bea\'s missed shift was covered (named in Ann\'s row): not kept');
  same([by.overtime, by.scheduledOver, by.management.sort(), by.summary.length], [['Dee Dunn', 'Eli Egan'], ['Eli Egan'], ['Kim Kerr', 'Max Moss'], 1]);
  const cook = rows(a, 'laborJobs').map(g.laborJobFromRow_).filter(j => j.property === 'TST1' && j.job === 'Line Cook')[0];
  same([cook.extra.otPremium, cook.extra.addedHrs], [125, 7.5]);
  // The report read back from those rows matches the one worked out from every shift.
  const stored = a.getLaborWeek('TST1', WEEK).report;
  same([stored.people.off.totals, stored.people.otTotals, stored.people.overtime.map(o => o.employee), stored.management.length, stored.daily[0].BOH],
    [R.people.off.totals, R.people.otTotals, R.people.overtime.map(o => o.employee), R.management.length, R.daily[0].BOH]);
  same(stored.findings.map(f => f.title), R.findings.map(f => f.title));
  same(stored.jobs.filter(j => j.job === 'Line Cook')[0].otPremium, 125);
});

test('a schedule, then the actuals: each upload replaces the week', () => {
  const a = app();
  a.commitLaborUpload(S.laborCsv(WEEK, [S.asSchedule(S.sampleGrill())]), 'schedule.csv');
  same(a.getLaborDashboard().rows.map(r => r.stage), ['schedule']);
  const sr = a.getLaborWeek('TST1', WEEK).report;
  same([sr.stage, sr.people.scheduledOver.map(x => x.employee), sr.management.length], ['schedule', ['Eli Egan'], 2]);
  const again = a.previewLaborUpload(S.laborCsv(WEEK, [S.sampleGrill()]), 'actual.csv');
  same(again.locations[0].existing.stage, 'schedule');
  a.commitLaborUpload(S.laborCsv(WEEK, [S.sampleGrill()]), 'actual.csv');
  same([rows(a, 'laborWeeks').length, rows(a, 'laborWeeks')[0][4], rows(a, 'laborJobs').length], [1, 'actual', 6]);
  same(a.getLaborWeek('TST1', WEEK).report.people.off.totals, R.people.off.totals);
});

test('the dashboard carries overtime $, added hours and every job code for long-term views', () => {
  const a = app();
  a.commitLaborUpload(past, 'labor.csv', { 'Pop-up Kiosk': '' });
  const d = a.getLaborDashboard().rows.filter(r => r.property === 'TST1')[0];
  same([d.HOURLY.otPremium, d.BOH.otPremium, d.HOURLY.addedHrs, d.FOH.addedHrs], [125, 125, 15.5, 8]);
  same(d.jobs.filter(j => j[0] === 'Line Cook')[0], ['Line Cook', 'BOH', 85, 92.5, 1750, 1975, 12.5, 125, 7.5]);
  assert.ok(d.jobs.some(j => j[0] === 'Chef' && j[1] === 'MGMT'));
});

test('job code groups can be changed, and apply to every week on file', () => {
  const a = app();
  a.commitLaborUpload(past, 'labor.csv', { 'Pop-up Kiosk': '' });
  const codes = a.getLaborJobCodes();
  same(codes.jobs.filter(j => j.job === 'Host')[0].group, 'FOH');
  a.saveLaborJobGroups({ Host: 'BOH' });
  const d = a.getLaborDashboard().rows.filter(r => r.property === 'TST1')[0];
  same([d.FOH.schHrs, d.BOH.schHrs], [66, 89]);
  assert.throws(() => a.saveLaborJobGroups({ Host: 'BAR' }), /Unknown group/);
});

test('a file that does not add up is not saved; two locations cannot share a property', () => {
  const a = app();
  assert.throws(() => a.commitLaborUpload(S.laborCsv(WEEK, [S.sampleGrill()], { breakJob: 'Sample Grill Baltimore|Server' }), 'x.csv'), /does not add up/);
  assert.throws(() => a.commitLaborUpload(past, 'x.csv', { 'Sample Grill Baltimore': 'TST1', 'Harbor House': 'TST1', 'Pop-up Kiosk': '' }), /same property/);
  same(rows(a, 'laborWeeks'), []);
});

test('remove a week', () => {
  const a = app();
  a.commitLaborUpload(past, 'labor.csv', { 'Pop-up Kiosk': '' });
  same(a.removeLaborWeek('TST1', WEEK), { removed: true });
  same([rows(a, 'laborWeeks').length, rows(a, 'laborJobs').every(r => r[1] === 'TST2'), rows(a, 'laborItems').every(r => r[1] === 'TST2')], [1, true, true]);
});

test('access: viewers read; only admins upload or change groups; the inventory-only role sees nothing', () => {
  const a = app();
  a.commitLaborUpload(past, 'labor.csv', { 'Pop-up Kiosk': '' });
  a.__setUser('viewer@example.com');
  same(a.getLaborDashboard().rows.length, 2);
  assert.ok(a.getLaborWeek('TST2', WEEK).report);
  assert.throws(() => a.previewLaborUpload(past, 'x.csv'), /Only an administrator/);
  assert.throws(() => a.saveLaborJobGroups({ Host: 'BOH' }), /Only an administrator/);
  assert.throws(() => a.removeLaborWeek('TST1', WEEK), /Only an administrator/);
  a.__setUser('rm@example.com');
  assert.throws(() => a.getLaborDashboard(), /Inventory tab only/);
  a.__setUser('stranger@example.com');
  assert.throws(() => a.getLaborDashboard(), /do not have access/);
});

console.log('\n' + passed + ' labor tests passed' + (process.exitCode ? ', some FAILED' : ''));
