/*
 * Made-up "Labor Actual vs Scheduled - Detail" exports in R365's layout: a
 * DateRange line, a blank line, then one row per employee, job code and day,
 * each repeating its location's and job code's totals and the report's grand
 * totals. Amounts are formatted the way R365 writes them ("1,234.50",
 * "-5.0 %"). Every name and figure here is invented.
 */
const HEADER = ['LocationName', 'ActualHrs1', 'ScheduledHrs1', 'OtherHrsDetail', 'VarianceHrs3', 'VarianceHrsPercentDetail', 'Hrs3',
  'ActualAmount2', 'ScheduledAmount2', 'OtherAmountDetail', 'VarianceAmount2', 'VarianceAmountPercentDetail', 'NetSale', 'ForeSale',
  'PriorYearSalesDetail', 'LaborPercentDetail', 'LaborGoalDetail', 'GoalVarianceDetail', 'JobTitle', 'DetailActualHrs',
  'DetailScheduledHrs', 'DetailOtherHrs', 'DetailVarianceHrs', 'DetailVarianceHrsPercent', 'Hrs2', 'DetailActualAmount',
  'DetailScheduledAmount', 'DetailOtherAmountRow', 'DetailVarianceAmount', 'DetailVarianceAmountPercent', 'LaborPercentJob',
  'EmployeeName', 'ActualDateTime', 'EmployeeActualHrs', 'EmployeeScheduledHrs', 'OtherHours', 'VarianceEmployeeHrs', 'VarianceHrsPer',
  'Hrs1', 'EmployeeActualAmount', 'ScheduleAmountEmployee', 'OtherPay', 'VarianceAmountEmployee', 'VariancePercentEmployee',
  'LaborPercentEmployee', 'TotalActHrs', 'TotalSchHrs', 'TotalOtherHrs', 'TotalVarianceHrs', 'TotalVarianceHrsPer', 'TotalOTHrs',
  'TotalActualAmount', 'TotalScheduledAmount', 'TotalOtherAmount', 'TotalVarianceAmount', 'TotalVarPer', 'TotalSales', 'TotalForecast',
  'TotalPYSales', 'TotalLaborPercent'];

const num = (v, d) => {
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d == null ? 2 : d, maximumFractionDigits: d == null ? 2 : d });
  return (v < 0 ? '-' : '') + s;
};
const pctOf = (a, b) => (b ? num((a - b) / b * 100, 1) : '0.0') + ' %';
const mdY = iso => (+iso.slice(5, 7)) + '/' + (+iso.slice(8, 10)) + '/' + iso.slice(0, 4);
const mdy = iso => (+iso.slice(5, 7)) + '/' + (+iso.slice(8, 10)) + '/' + iso.slice(2, 4);
const addDays = (d, n) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10) + n)).toISOString().slice(0, 10);
const q = v => (/[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));

/**
 * @param {string} week  Monday, 'YYYY-MM-DD'
 * @param {Array} locations [{ name, net, forecast, py, rows: [[job, employee, day 0-6, actHrs, schHrs, otHrs, actPay, schPay]] }]
 * @param {Object=} opts { breakJob: 'Location|Job' — misstate that job code's actual hours }
 */
function laborCsv(week, locations, opts) {
  opts = opts || {};
  const tot = a => a.reduce((t, r) => { t.a += r[3]; t.s += r[4]; t.ot += r[5]; t.aa += r[6]; t.sa += r[7]; return t; }, { a: 0, s: 0, ot: 0, aa: 0, sa: 0 });
  const all = []; locations.forEach(l => l.rows.forEach(r => all.push(r)));
  const G = tot(all);
  const gNet = locations.reduce((t, l) => t + l.net, 0), gF = locations.reduce((t, l) => t + l.forecast, 0), gPy = locations.reduce((t, l) => t + l.py, 0);
  const lines = ['﻿DateRange,Locations', q(mdY(week) + ' - ' + mdY(addDays(week, 6))) + ',Location: More than 5 selected', '', HEADER.join(',')];
  locations.forEach(l => {
    const L = tot(l.rows);
    const jobs = {};
    l.rows.forEach(r => { (jobs[r[0]] = jobs[r[0]] || []).push(r); });
    Object.keys(jobs).sort().forEach(job => {
      const J = tot(jobs[job]);
      if (opts.breakJob === l.name + '|' + job) J.a += 5;
      jobs[job].forEach(r => {
        lines.push([l.name, num(L.a), num(L.s), '0.00', num(L.a - L.s), pctOf(L.a, L.s), num(L.ot), num(L.aa), num(L.sa), '0.00', num(L.aa - L.sa), pctOf(L.aa, L.sa),
          num(l.net, 0), num(l.forecast, 0), num(l.py, 0), (l.net ? num(L.aa / l.net * 100, 1) : '0.0') + '%', '0.0 %', '0.0 %',
          job, num(J.a), num(J.s), '0.00', num(J.a - J.s), pctOf(J.a, J.s), num(J.ot), num(J.aa), num(J.sa), '0.00', num(J.aa - J.sa), pctOf(J.aa, J.sa), '0.0 %',
          r[1], mdy(addDays(week, r[2])), num(r[3]), num(r[4]), '0.00', num(r[3] - r[4]), pctOf(r[3], r[4]), num(r[5]), num(r[6]), num(r[7]), '0.00', num(r[6] - r[7]), pctOf(r[6], r[7]), '0.0 %',
          num(G.a), num(G.s), '0.00', num(G.a - G.s), pctOf(G.a, G.s), num(G.ot), num(G.aa), num(G.sa), '0.00', num(G.aa - G.sa), (G.sa ? num((G.aa - G.sa) / G.sa * 100, 1) : '0.0') + '%',
          num(gNet, 0), num(gF, 0), num(gPy, 0), (gNet ? num(G.aa / gNet * 100, 1) : '0.0') + '%'].map(q).join(','));
      });
    });
  });
  return lines.join('\r\n') + '\r\n';
}

/** A schedule: every row's actual hours and pay at zero, no sales. */
function asSchedule(loc) {
  return Object.assign({}, loc, { net: 0, rows: loc.rows.filter(r => r[4] > 0).map(r => [r[0], r[1], r[2], 0, r[4], 0, 0, r[7]]) });
}

/**
 * Sample Grill, one week. FOH: servers and a host; BOH: cooks; a chef and a
 * manager (salaried, no pay); a ghost bar terminal.
 *   Ann     scheduled Mon–Fri 8 h, works them, plus Saturday unscheduled (covers Bea)
 *   Bea     scheduled Sat 8 h, does not work
 *   Cy      scheduled Mon–Wed 6 h; works Mon 9 h (3 over); Sun 5 h unscheduled with no one to cover
 *   Dee     cook, scheduled 5 × 8 h, works 5 × 9.5 h: 1.5 h over each day, 7.5 overtime
 *   Eli     cook, scheduled 6 × 7.5 h (45: overtime written into the schedule), works it
 *   Host    host, scheduled 4 h Mon, works it
 *   Chef/Manager  salaried: hours scheduled, no pay, no punches
 *   BAR GHOST     bar terminal clock-ins, no pay
 */
function sampleGrill(opts) {
  opts = opts || {};
  const rows = [];
  for (let d = 0; d < 5; d++) rows.push(['Server', 'Ann Able', d, 8, 8, 0, 80, 80]);
  rows.push(['Server', 'Ann Able', 5, 8, 0, 0, 80, 0]);
  rows.push(['Server', 'Bea Bell', 5, 0, 8, 0, 0, 40]);
  rows.push(['Server', 'Cy Cole', 0, 9, 6, 0, 45, 30]);
  rows.push(['Server', 'Cy Cole', 1, 6, 6, 0, 30, 30]);
  rows.push(['Server', 'Cy Cole', 2, 6, 6, 0, 30, 30]);
  rows.push(['Server', 'Cy Cole', 6, 5, 0, 0, 25, 0]);
  for (let d = 0; d < 5; d++) rows.push(['Line Cook', 'Dee Dunn', d, 9.5, 8, d === 4 ? 7.5 : 0, d === 4 ? 9.5 * 20 + 7.5 * 10 : 190, 160]);
  for (let d = 0; d < 6; d++) rows.push(['Line Cook', 'Eli Egan', d, 7.5, 7.5, d === 5 ? 5 : 0, d === 5 ? 150 + 5 * 10 : 150, d === 5 ? 200 : 150]);
  rows.push(['Host', 'Hal Hart', 0, 4, 4, 0, 60, 60]);
  for (let d = 0; d < 5; d++) rows.push(['Chef', 'Kim Kerr', d, 0, 10, 0, 0, 0]);
  for (let d = 1; d < 6; d++) rows.push(['FOH Management', 'Max Moss', d, 0, 11, 0, 0, 0]);
  rows.push(['Bartender Ghost (PM)', 'PM BAR, PM BAR', 4, 12, 0, 0, 0, 0]);
  return { name: 'Sample Grill Baltimore', net: opts.net == null ? 30000 : opts.net, forecast: opts.forecast == null ? 33000 : opts.forecast, py: 29000, rows: rows };
}
function harborHouse() {
  const rows = [];
  for (let d = 0; d < 7; d++) rows.push(['Bartender', 'Ivy Ince', d, 6, 6, 0, 30, 30]);
  for (let d = 0; d < 7; d++) rows.push(['Dishwasher', 'Jon Joy', d, 6, 6, 0, 90, 90]);
  return { name: 'Harbor House', net: 20000, forecast: 20000, py: 19000, rows: rows };
}
function unknownPlace() {
  return { name: 'Pop-up Kiosk', net: 1000, forecast: 1000, py: 0, rows: [['Server', 'Zed Zane', 0, 4, 4, 0, 40, 40]] };
}

module.exports = { HEADER, laborCsv, asSchedule, sampleGrill, harborHouse, unknownPlace, addDays };
