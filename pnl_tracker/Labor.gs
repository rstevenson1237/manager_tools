/*******************************************************************************
 * Labor.gs — the weekly sales and labor review. Plain JavaScript with no Apps
 * Script services, so the Node tests run it. LaborApi.gs holds the endpoints.
 *
 * THE EXPORT. R365's "Labor Actual vs Scheduled - Detail", one week (Monday to
 * Sunday), any number of locations. Every row repeats the location totals
 * (hours, dollars, net sales, forecast, prior year), the job code totals,
 * and one employee's figures for one day in one job code. An employee can
 * have two rows for the same job and day: R365 lists a punch that does not
 * line up with the scheduled shift on its own row. Those are added together.
 *
 *   Upcoming week   no actual hours or sales yet: the schedule as written.
 *   Past week       actual hours and pay against the schedule R365 holds at
 *                   the end of the week.
 *   The labor goal % columns are ignored.
 *
 * Each upload replaces the week: actuals are compared with the schedule R365
 * holds at the time of the export. Schedules rarely change once finalised a
 * week or two ahead, so no earlier version is kept.
 *
 * GROUPS. Every job code belongs to one group:
 *   FOH   front of house, hourly
 *   BOH   back of house, hourly
 *   MGMT  management. Salaried: hours are scheduled but no dollars are listed
 *         and nobody clocks in. Only the scheduled hours are reviewed.
 *   NONE  not counted: ghost and placeholder job codes (bar terminals that
 *         clock in to pool tips, "Default Generic User"). Their hours are not
 *         real shifts, so they are left out of every figure.
 * The group is guessed from the job code's name the first time it is seen and
 * kept in _Config; an administrator can change it (Labor → Job codes).
 * Hourly labor = FOH + BOH. Labor % is hourly labor ÷ net sales.
 *
 * EXPECTATIONS. A schedule is judged against
 *   - the sales forecast (R365's, entered by the property),
 *   - the budget: the week's share of the month's net sales budget (daily
 *     sales budget), and the month's 6201 FOH / 6209 BOH hourly labor as % of
 *     net sales;
 *   - without a budget: the property's own average labor % and job code hours
 *     over the last weeks on file (LABOR_RULES.recentWeeks).
 ******************************************************************************/

const LABOR_RULES = {
  recentWeeks: 4,          // past weeks averaged for "recent" job code hours and labor %
  salesMissPct: 10,        // sales this far off forecast (%) is a finding
  overTargetPts: 1,        // labor % this many points above its target is a finding
  jobOverHrs: 8,           // a job code over its schedule by this many hours …
  jobOverPct: 0.15,        // … and this share of its scheduled hours is a finding
  jobAboveRecentPct: 0.15, // scheduled this much above recent hours, beyond the change in sales
  shiftOverHrs: 1.5,       // a day worked this much longer than scheduled
  minShiftHrs: 0.25,       // punches shorter than this are ignored
  weeklyOtHrs: 40          // a week scheduled over this is overtime written into the schedule
};

const LABOR_GROUPS = [
  { key: 'FOH', label: 'Front of house' },
  { key: 'BOH', label: 'Back of house' },
  { key: 'MGMT', label: 'Management' },
  { key: 'NONE', label: 'Not counted' }
];

/** Columns of the export, by what they hold. */
const LABOR_COLS = {
  location: 'LocationName',
  loc: { a: 'ActualHrs1', s: 'ScheduledHrs1', o: 'OtherHrsDetail', ot: 'Hrs3', aa: 'ActualAmount2', sa: 'ScheduledAmount2', oa: 'OtherAmountDetail' },
  sales: { net: 'NetSale', forecast: 'ForeSale', py: 'PriorYearSalesDetail' },
  job: 'JobTitle',
  jobTotals: { a: 'DetailActualHrs', s: 'DetailScheduledHrs', o: 'DetailOtherHrs', ot: 'Hrs2', aa: 'DetailActualAmount', sa: 'DetailScheduledAmount', oa: 'DetailOtherAmountRow' },
  employee: 'EmployeeName',
  date: 'ActualDateTime',
  emp: { a: 'EmployeeActualHrs', s: 'EmployeeScheduledHrs', o: 'OtherHours', ot: 'Hrs1', aa: 'EmployeeActualAmount', sa: 'ScheduleAmountEmployee', oa: 'OtherPay' }
};
const LABOR_FIELDS = ['a', 's', 'o', 'ot', 'aa', 'sa', 'oa'];

/* ----------------------------------------------------------------- numbers */

function laborNum_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  let s = String(v == null ? '' : v).replace(/[$,%\s]/g, '');
  if (!s) return 0;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  const n = Number(s);
  return isFinite(n) ? (neg ? -n : n) : 0;
}
function laborRound_(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function laborZero_() { return { a: 0, s: 0, o: 0, ot: 0, aa: 0, sa: 0, oa: 0 }; }
function laborAdd_(into, x) { LABOR_FIELDS.forEach(function (k) { into[k] += x[k] || 0; }); return into; }
function laborRounded_(t) { const o = {}; LABOR_FIELDS.forEach(function (k) { o[k] = laborRound_(t[k]); }); return o; }
function laborPct_(amount, sales) { return sales ? amount / sales * 100 : null; }

/** '11/2/26' or '11/2/2026' → '2026-11-02'. */
function laborDate_(v) {
  if (v instanceof Date) return v.getFullYear() + '-' + laborPad_(v.getMonth() + 1) + '-' + laborPad_(v.getDate());
  const m = String(v || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?!\d)/);
  if (m) return (m[3].length === 2 ? '20' + m[3] : m[3]) + '-' + laborPad_(+m[1]) + '-' + laborPad_(+m[2]);
  const iso = String(v || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? iso[1] + '-' + iso[2] + '-' + iso[3] : '';
}
function laborPad_(n) { return n < 10 ? '0' + n : String(n); }
/** Days from 'YYYY-MM-DD' a to b. */
function laborDays_(a, b) {
  return Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86400000);
}
function laborAddDays_(d, n) {
  const t = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10) + n));
  return t.getUTCFullYear() + '-' + laborPad_(t.getUTCMonth() + 1) + '-' + laborPad_(t.getUTCDate());
}
/** The week's seven dates. */
function laborWeekDates_(week) { return [0, 1, 2, 3, 4, 5, 6].map(function (i) { return laborAddDays_(week, i); }); }

/* ------------------------------------------------------------------- groups */

function laborJobKey_(title) { return String(title || '').trim().replace(/\s+/g, ' ').toLowerCase(); }

/** The group a job code's name suggests. An administrator can change it. */
function guessLaborGroup_(title) {
  const t = laborJobKey_(title);
  if (/ghost|default generic|do not delete/.test(t)) return 'NONE';
  if (/manag|mgmt|\bagm\b|\bgm\b|director|restaurant supervisor/.test(t)) return 'MGMT';
  if (/^(executive |sous |head )?chef( de cuisine)?$|^chef\b/.test(t)) return 'MGMT';
  if (/bar prep/.test(t)) return 'FOH';
  if (/cook|kitchen|dish|prep|line|sushi|teppan|pastry|baker|porter|steward|clean|facilit|maintenance|raw bar|fish market|boh/.test(t)) return 'BOH';
  return 'FOH';
}

/** groupOf(title) using the saved groups, then the guess. */
function laborGroupFn_(saved) {
  saved = saved || {};
  return function (title) {
    const g = saved[laborJobKey_(title)];
    return LABOR_GROUPS.some(function (x) { return x.key === g; }) ? g : guessLaborGroup_(title);
  };
}

/* ------------------------------------------------------------------ parsing */

/**
 * Read the export.
 * @param {string[][]} rows  Utilities.parseCsv output
 * @return {{ week, end, rows, locations: [{ location, sales:{net,forecast,py}, totals, jobs: {title: totals},
 *   shifts: [{ job, employee, days: totals[7], totals }], rows }], tieOuts: string[], warnings: string[] }}
 */
function parseLaborCsv_(rows) {
  rows = (rows || []).map(function (r) { return r.map(function (c) { return String(c == null ? '' : c).replace(/^\uFEFF/, ''); }); });
  let range = null, hi = -1;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    if (rows[i][0].trim() === 'DateRange' && rows[i + 1]) range = rows[i + 1][0];
    if (rows[i].indexOf(LABOR_COLS.location) !== -1 && rows[i].indexOf(LABOR_COLS.employee) !== -1) { hi = i; break; }
  }
  if (hi === -1) throw new Error('This is not an R365 "Labor Actual vs Scheduled - Detail" export: no LocationName / EmployeeName columns.');
  const head = rows[hi];
  const col = {};
  head.forEach(function (h, i) { if (col[h.trim()] == null) col[h.trim()] = i; });
  const need = [LABOR_COLS.location, LABOR_COLS.job, LABOR_COLS.employee, LABOR_COLS.date];
  ['loc', 'sales', 'jobTotals', 'emp'].forEach(function (g) { Object.keys(LABOR_COLS[g]).forEach(function (k) { need.push(LABOR_COLS[g][k]); }); });
  const missing = need.filter(function (n) { return col[n] == null; });
  if (missing.length) throw new Error('The export is missing these columns: ' + missing.join(', ') + '.');

  const m = String(range || '').match(/(\d{1,2}\/\d{1,2}\/\d{2,4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/);
  if (!m) throw new Error('The export has no date range. Run it again for one week.');
  const week = laborDate_(m[1]), end = laborDate_(m[2]);
  if (laborDays_(week, end) !== 6) throw new Error('The export covers ' + (laborDays_(week, end) + 1) + ' days (' + m[1] + ' – ' + m[2] + '). Export one week, Monday to Sunday.');

  const get = function (r, name) { return r[col[name]] == null ? '' : r[col[name]]; };
  const pick = function (r, map) { const o = {}; LABOR_FIELDS.forEach(function (k) { o[k] = laborNum_(get(r, map[k])); }); return o; };
  const byLoc = {}, order = [], warnings = [];
  let count = 0;
  rows.slice(hi + 1).forEach(function (r) {
    if (!r.some(function (c) { return String(c).trim(); })) return;
    const location = String(get(r, LABOR_COLS.location)).trim();
    if (!location) return;
    count++;
    let L = byLoc[location];
    if (!L) {
      L = byLoc[location] = { location: location, totals: pick(r, LABOR_COLS.loc),
        sales: { net: laborNum_(get(r, LABOR_COLS.sales.net)), forecast: laborNum_(get(r, LABOR_COLS.sales.forecast)), py: laborNum_(get(r, LABOR_COLS.sales.py)) },
        jobs: {}, jobRows: {}, shiftMap: {}, rows: 0, sum: laborZero_() };
      order.push(location);
    }
    L.rows++;
    const job = String(get(r, LABOR_COLS.job)).trim() || '(no job code)';
    if (!L.jobs[job]) { L.jobs[job] = pick(r, LABOR_COLS.jobTotals); L.jobRows[job] = { rows: 0, sum: laborZero_() }; }
    const e = pick(r, LABOR_COLS.emp);
    const employee = String(get(r, LABOR_COLS.employee)).trim() || '(no name)';
    const date = laborDate_(get(r, LABOR_COLS.date));
    const day = date ? laborDays_(week, date) : -1;
    if (day < 0 || day > 6) { warnings.push(location + ': ' + employee + ' has a row dated ' + get(r, LABOR_COLS.date) + ', outside the week. Left out.'); return; }
    const key = job + '\u0001' + employee;
    const sh = L.shiftMap[key] = L.shiftMap[key] || { job: job, employee: employee, days: [0, 1, 2, 3, 4, 5, 6].map(laborZero_), totals: laborZero_() };
    laborAdd_(sh.days[day], e); laborAdd_(sh.totals, e);
    laborAdd_(L.jobRows[job].sum, e); L.jobRows[job].rows++;
    laborAdd_(L.sum, e);
  });
  if (!order.length) throw new Error('The export has no rows.');

  // Tie-out: employee rows add up to each job code, and job codes to the location.
  // R365 rounds every row to the cent, so a difference of half a cent a row is rounding.
  const tieOuts = [];
  const LABELS = { a: 'actual hours', s: 'scheduled hours', ot: 'overtime hours', aa: 'actual pay', sa: 'scheduled pay' };
  const compare = function (where, sum, total, n) {
    const tol = 0.01 + 0.005 * n;
    Object.keys(LABELS).forEach(function (k) {
      if (Math.abs(sum[k] - total[k]) > tol) tieOuts.push(where + ': ' + LABELS[k] + ' add up to ' + laborRound_(sum[k]) + ', the export says ' + total[k] + '.');
    });
  };
  const locations = order.map(function (name) {
    const L = byLoc[name];
    const jobSum = laborZero_();
    Object.keys(L.jobs).forEach(function (j) {
      compare(name + ' · ' + j, L.jobRows[j].sum, L.jobs[j], L.jobRows[j].rows);
      laborAdd_(jobSum, L.jobs[j]);
    });
    compare(name, jobSum, L.totals, L.rows);
    const shifts = Object.keys(L.shiftMap).map(function (k) {
      const s = L.shiftMap[k];
      return { job: s.job, employee: s.employee, days: s.days.map(laborRounded_), totals: laborRounded_(s.totals) };
    }).sort(function (a, b) { return a.job.localeCompare(b.job) || a.employee.localeCompare(b.employee); });
    return { location: name, sales: L.sales, totals: L.totals, jobs: L.jobs, shifts: shifts, rows: L.rows };
  });
  return { week: week, end: end, rows: count, locations: locations, tieOuts: tieOuts, warnings: warnings.slice(0, 20) };
}

/** 'schedule' (nothing worked yet), 'partial' (the week is not over), or 'actual'. */
function laborStage_(loc, end, today) {
  if (!(loc.totals.a > 0) && !(loc.totals.aa > 0) && !(loc.sales.net > 0)) return 'schedule';
  return today && today <= end ? 'partial' : 'actual';
}

/** The property a location name points to: a saved mapping, then a name match. */
function guessLaborProperty_(location, properties, saved) {
  if (saved && saved[location]) return saved[location];
  const norm = function (s) { return ' ' + String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' '; };
  const loc = norm(location);
  const hit = (properties || []).map(function (p) {
    const n = norm(p.name), c = norm(p.code);
    if (n === loc || c === loc) return { code: p.code, score: 1000 };
    if (n.trim() && loc.indexOf(n) !== -1) return { code: p.code, score: n.length };
    if (loc.trim() && n.indexOf(loc) !== -1) return { code: p.code, score: loc.length };
    return null;
  }).filter(Boolean).sort(function (a, b) { return b.score - a.score; })[0];
  return hit ? hit.code : '';
}

/* ------------------------------------------------------------- sheet rows */

/** Labor Weeks row. */
function laborWeekRow_(w) {
  const t = w.totals;
  return [w.week, w.property, w.location, w.end, w.stage, laborRound_(w.sales.net), laborRound_(w.sales.forecast), laborRound_(w.sales.py),
    laborRound_(t.a), laborRound_(t.s), laborRound_(t.o), laborRound_(t.ot), laborRound_(t.aa), laborRound_(t.sa), laborRound_(t.oa),
    w.uploadedAt || '', w.uploadedBy || '', w.file || '', w.uploadId || ''];
}
function laborWeekFromRow_(r) {
  const n = function (i) { return Number(r[i]) || 0; };
  return { week: laborDate_(r[0]), property: String(r[1]), location: String(r[2]), end: laborDate_(r[3]), stage: String(r[4] || 'actual'),
    sales: { net: n(5), forecast: n(6), py: n(7) }, totals: { a: n(8), s: n(9), o: n(10), ot: n(11), aa: n(12), sa: n(13), oa: n(14) },
    uploadedAt: String(r[15] || ''), uploadedBy: String(r[16] || ''), file: String(r[17] || ''), uploadId: String(r[18] || '') };
}
/**
 * Labor Jobs rows for one location: R365's totals per job code, and from the
 * week's analysis the overtime premium and the hours and pay added on top of
 * the schedule.
 */
function laborJobRows_(week, property, loc, analysis) {
  const people = {};
  loc.shifts.forEach(function (s) { people[s.job] = (people[s.job] || 0) + 1; });
  const extras = (analysis && analysis.jobExtras) || {};
  return Object.keys(loc.jobs).sort().map(function (j) {
    const t = loc.jobs[j], e = extras[j] || {};
    return [week, property, j, laborRound_(t.a), laborRound_(t.s), laborRound_(t.o), laborRound_(t.ot), laborRound_(t.aa), laborRound_(t.sa), laborRound_(t.oa), people[j] || 0,
      laborRound_(e.otPremium), laborRound_(e.addedHrs), laborRound_(e.addedPay)];
  });
}
function laborJobFromRow_(r) {
  const n = function (i) { return Number(r[i]) || 0; };
  return { week: laborDate_(r[0]), property: String(r[1]), job: String(r[2]),
    totals: { a: n(3), s: n(4), o: n(5), ot: n(6), aa: n(7), sa: n(8), oa: n(9) }, employees: n(10),
    extra: { otPremium: n(11), addedHrs: n(12), addedPay: n(13) } };
}

/**
 * Labor Items rows: only what the week report names. One row per person
 * (off the schedule, overtime, scheduled over 40 hours, managers' schedule)
 * and one summary row.
 */
function laborItemRows_(week, property, a) {
  const rows = [];
  const row = function (section, employee, jobs, group, sch, act, hrs, amount, detail) {
    rows.push([week, property, section, employee, (jobs || []).join(' | '), group || '', laborRound_(sch), laborRound_(act),
      hrs === '' ? '' : laborRound_(hrs), amount === '' ? '' : laborRound_(amount), JSON.stringify(detail || {})]);
  };
  const named = function (p) {
    return p.extraHrs > 0 || p.notOnSchedule || p.unscheduled.length || p.missed.some(function (m) { return !m.coveredBy.length; });
  };
  const offRows = function (section, off) {
    off.list.filter(named).forEach(function (p) {
      row(section, p.employee, p.jobs, p.group, p.schHrs, p.actHrs, p.extraHrs, p.extraPay,
        { u: p.unscheduled, o: p.over, m: p.missed, n: p.notOnSchedule ? 1 : 0 });
    });
  };
  offRows('off', a.people.off);
  a.people.overtime.forEach(function (o) { row('overtime', o.employee, o.jobs, o.group, o.schHrs, o.actHrs, o.otHrs, o.premium, { cause: o.cause }); });
  a.people.scheduledOver.forEach(function (o) { row('scheduledOver', o.employee, o.jobs, o.group, o.schHrs, 0, o.overHrs, '', { shifts: o.shifts }); });
  a.management.forEach(function (m) { row('management', m.employee, m.jobs, 'MGMT', m.schHrs, m.actHrs, '', '', { days: m.days, shifts: m.shifts }); });
  row('summary', '', [], '', 0, 0, '', '', { off: a.people.off.totals,
    daily: a.daily.map(function (d) { return [d.FOH.s, d.FOH.a, d.BOH.s, d.BOH.a, d.MGMT.s, d.MGMT.a]; }), names: a.namePairs });
  return rows;
}

/** The week's analysis back from its Labor Items rows (the shape laborAnalyzeWeek_ returns, without the job extras). */
function laborAnalysisFromRows_(rows) {
  const detail = function (r) { try { return JSON.parse(String(r[10] || '{}')); } catch (e) { return {}; } };
  const base = function (r) {
    return { employee: String(r[3]), jobs: String(r[4] || '').split(' | ').filter(Boolean), group: String(r[5] || ''), schHrs: Number(r[6]) || 0, actHrs: Number(r[7]) || 0 };
  };
  const out = { namePairs: [], people: { off: { list: [], totals: {} }, overtime: [], otTotals: { hrs: 0, premium: 0, scheduledHrs: 0 }, scheduledOver: [] },
    daily: [], management: [] };
  const offPerson = function (r) {
    const d = detail(r);
    return Object.assign(base(r), { unscheduled: d.u || [], over: d.o || [], missed: d.m || [], otherJob: [], extraHrs: Number(r[8]) || 0, extraPay: Number(r[9]) || 0, notOnSchedule: !!d.n });
  };
  rows.forEach(function (r) {
    const section = String(r[2]);
    if (section === 'off') out.people.off.list.push(offPerson(r));
    else if (section === 'overtime') {
      const o = Object.assign(base(r), { otHrs: Number(r[8]) || 0, premium: Number(r[9]) || 0, cause: detail(r).cause || 'extra' });
      out.people.overtime.push(o);
      out.people.otTotals.hrs += o.otHrs; out.people.otTotals.premium += o.premium; if (o.cause === 'scheduled') out.people.otTotals.scheduledHrs += o.otHrs;
    } else if (section === 'scheduledOver') out.people.scheduledOver.push(Object.assign(base(r), { overHrs: Number(r[8]) || 0, shifts: detail(r).shifts || 0 }));
    else if (section === 'management') { const d = detail(r); out.management.push(Object.assign(base(r), { days: d.days || [], shifts: d.shifts || 0 })); }
    else if (section === 'summary') {
      const d = detail(r);
      out.people.off.totals = d.off || {};
      out.namePairs = d.names || [];
      out.daily = (d.daily || []).map(function (x) { return { FOH: { s: x[0], a: x[1] }, BOH: { s: x[2], a: x[3] }, MGMT: { s: x[4], a: x[5] } }; });
    }
  });
  Object.keys(out.people.otTotals).forEach(function (k) { out.people.otTotals[k] = laborRound_(out.people.otTotals[k]); });
  const sortOff = function (x, y) { return y.extraPay - x.extraPay || y.extraHrs - x.extraHrs || x.employee.localeCompare(y.employee); };
  out.people.off.list.sort(sortOff);
  out.people.overtime.sort(function (x, y) { return y.otHrs - x.otHrs || x.employee.localeCompare(y.employee); });
  out.people.scheduledOver.sort(function (x, y) { return y.schHrs - x.schHrs || x.employee.localeCompare(y.employee); });
  out.management.sort(function (x, y) { return y.schHrs - x.schHrs || x.employee.localeCompare(y.employee); });
  while (out.daily.length < 7) out.daily.push({ FOH: { s: 0, a: 0 }, BOH: { s: 0, a: 0 }, MGMT: { s: 0, a: 0 } });
  return out;
}

/* ----------------------------------------------------------- expectations */

/**
 * The week's budget: net sales (each day's share of its month's net sales
 * budget, from the daily sales budget) and hourly labor as % of net sales
 * (6201 FOH, 6209 BOH), weighted by those sales. null without a budget.
 */
function laborBudgetWeek_(store, property, week) {
  let net = 0, foh = 0, boh = 0, found = false;
  laborWeekDates_(week).forEach(function (d) {
    const period = d.slice(0, 7);
    const b = store && budgetMonth_(store, property, period);
    if (!b || !b.NET_SALES) return;
    found = true;
    const by = budgetYear_(store, property, period);
    const y = +d.slice(0, 4), mo = +d.slice(5, 7), day = +d.slice(8, 10);
    const share = budgetMonthFraction_(by.daily, y, mo, day) - (day > 1 ? budgetMonthFraction_(by.daily, y, mo, day - 1) : 0);
    const sales = b.NET_SALES * share;
    net += sales;
    foh += (b['6201'] || 0) / b.NET_SALES * sales;
    boh += (b['6209'] || 0) / b.NET_SALES * sales;
  });
  if (!found || !net) return null;
  return { net: net, fohPct: foh / net * 100, bohPct: boh / net * 100, hourlyPct: (foh + boh) / net * 100 };
}

/** Totals by group for a list of { job, totals }. Hourly = FOH + BOH. */
function laborByGroup_(items, groupOf) {
  const out = { FOH: laborZero_(), BOH: laborZero_(), MGMT: laborZero_(), NONE: laborZero_() };
  items.forEach(function (x) { laborAdd_(out[groupOf(x.job)], x.totals); });
  out.HOURLY = laborAdd_(laborAdd_(laborZero_(), out.FOH), out.BOH);
  return out;
}
/** Pay actually spent: actual plus "other" pay. */
function laborPaid_(t) { return t.aa + t.oa; }

/**
 * One dashboard row: a property's week, figures by group.
 * @param {Object} w     laborWeekFromRow_
 * @param {Object[]} jobs laborJobFromRow_ for that week and property
 */
function laborSummary_(w, jobs, groupOf, budget) {
  const g = laborByGroup_(jobs, groupOf);
  const ex = { FOH: { ot: 0, hrs: 0, pay: 0 }, BOH: { ot: 0, hrs: 0, pay: 0 } };
  jobs.forEach(function (j) {
    const e = ex[groupOf(j.job)];
    if (e && j.extra) { e.ot += j.extra.otPremium; e.hrs += j.extra.addedHrs; e.pay += j.extra.addedPay; }
  });
  ex.HOURLY = { ot: ex.FOH.ot + ex.BOH.ot, hrs: ex.FOH.hrs + ex.BOH.hrs, pay: ex.FOH.pay + ex.BOH.pay };
  const net = w.sales.net || null, forecast = w.sales.forecast || null;
  const grp = function (t, k) {
    return { schHrs: laborRound_(t.s), actHrs: laborRound_(t.a + t.o), otHrs: laborRound_(t.ot), schPay: laborRound_(t.sa), actPay: laborRound_(laborPaid_(t)),
      schPct: laborPct_(t.sa, forecast), actPct: laborPct_(laborPaid_(t), net),
      otPremium: laborRound_(ex[k].ot), addedHrs: laborRound_(ex[k].hrs), addedPay: laborRound_(ex[k].pay) };
  };
  return {
    week: w.week, end: w.end, property: w.property, location: w.location, stage: w.stage,
    net: net, forecast: forecast, py: w.sales.py || null, budgetNet: budget ? laborRound_(budget.net) : null,
    target: budget ? { FOH: budget.fohPct, BOH: budget.bohPct, HOURLY: budget.hourlyPct } : null,
    FOH: grp(g.FOH, 'FOH'), BOH: grp(g.BOH, 'BOH'), HOURLY: grp(g.HOURLY, 'HOURLY'),
    // Job codes, compact, for the dashboard's job code table: [job, group, sch hrs, act hrs, sch $, act $, OT hrs, OT $, added hrs].
    jobs: jobs.filter(function (j) { return j.totals.s || j.totals.a || j.totals.o; }).map(function (j) {
      const t = j.totals, e = j.extra || {};
      return [j.job, groupOf(j.job), laborRound_(t.s), laborRound_(t.a + t.o), laborRound_(t.sa), laborRound_(laborPaid_(t)), laborRound_(t.ot),
        laborRound_(e.otPremium), laborRound_(e.addedHrs)];
    }),
    mgmtSchHrs: laborRound_(g.MGMT.s), noneHrs: laborRound_(g.NONE.a + g.NONE.s),
    uploadedAt: w.uploadedAt
  };
}

/* ------------------------------------------------------- employee names */

/**
 * The schedule and the time clock do not always spell a name the same way:
 * "Swilling, Kenya Megan" is scheduled and "Swilling, Kenya" clocks in;
 * "Rodriguez, Bernadino" against "Rodriguez, Bernardino". Read as two
 * people, one looks like a no-show and the other like an unscheduled shift.
 *
 * Two names are the same person when the last names match and the first
 * names match, one starts with the other, or they differ by a typo (one
 * letter, two in names of 6+ letters). "Last, First" and "First Last" are
 * both read. They are only joined when one name has scheduled hours and no
 * worked hours this week and the other the reverse.
 * @return {{ map: { name: canonical }, pairs: [{ worked, scheduled }] }}
 */
function laborNameAliases_(shifts) {
  const role = {};
  shifts.forEach(function (s) {
    const r = role[s.employee] = role[s.employee] || { s: 0, a: 0 };
    r.s += s.totals.s; r.a += s.totals.a + s.totals.o;
  });
  const worked = [], sched = [];
  Object.keys(role).forEach(function (n) {
    if (role[n].a > 0 && role[n].s === 0) worked.push(n);
    else if (role[n].s > 0 && role[n].a === 0) sched.push(n);
  });
  const map = {}, pairs = [], used = {};
  worked.sort().forEach(function (w) {
    const hits = sched.filter(function (x) { return !used[x] && laborSameName_(w, x); });
    if (hits.length !== 1) return;
    used[hits[0]] = true;
    map[hits[0]] = w;
    pairs.push({ worked: w, scheduled: hits[0] });
  });
  return { map: map, pairs: pairs };
}
function laborNameParts_(name) {
  const s = String(name || '').toLowerCase().replace(/[^a-z,\s-]/g, '').replace(/-/g, ' ');
  let last, first;
  if (s.indexOf(',') !== -1) { last = s.split(',')[0]; first = s.split(',').slice(1).join(' '); }
  else { const t = s.trim().split(/\s+/); last = t.pop() || ''; first = t.join(' '); }
  return { last: last.trim().replace(/\s+/g, ' '), first: first.trim().split(/\s+/).filter(Boolean) };
}
function laborSameName_(a, b) {
  const x = laborNameParts_(a), y = laborNameParts_(b);
  if (!x.last || x.last !== y.last || !x.first.length || !y.first.length) return false;
  const f = x.first[0], g = y.first[0];
  if (f === g) return true;
  if (f.length >= 3 && g.length >= 3 && (f.indexOf(g) === 0 || g.indexOf(f) === 0)) return true;
  const tol = Math.min(f.length, g.length) >= 6 ? 2 : 1;
  return Math.min(f.length, g.length) >= 4 && laborEditDistance_(f, g) <= tol;
}
function laborEditDistance_(a, b) {
  let prev = [];
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
/** The shifts with aliased names replaced by the name that clocked in. */
function laborRenamed_(shifts, map) {
  return shifts.map(function (s) { return map[s.employee] ? Object.assign({}, s, { employee: map[s.employee] }) : s; });
}

/* ------------------------------------------------------------ week report */

/**
 * Everything about a week that needs the employee-by-day detail, worked out
 * once when it is uploaded. Only this is kept: the people it names, a small
 * summary, and per job code the overtime premium and the hours added on top
 * of the schedule. The employee-by-day rows are not kept (see LaborApi.gs).
 * @param {Object[]} shifts  the upload's shifts (parseLaborCsv_)
 * @return {{ namePairs, people: { off, overtime, otTotals, scheduledOver }, daily,
 *   management, jobExtras: { job: { otPremium, addedHrs, addedPay } } }}
 */
function laborAnalyzeWeek_(shifts, groupOf, rules, stage, week) {
  rules = Object.assign({}, LABOR_RULES, rules || {});
  const hasActuals = stage !== 'schedule';
  // One person under two spellings (schedule and time clock) is one person.
  const hourly = function (list) { return list.filter(function (s) { const g = groupOf(s.job); return g === 'FOH' || g === 'BOH'; }); };
  const aliases = laborNameAliases_(hourly(shifts));
  shifts = laborRenamed_(shifts, aliases.map);
  const people = laborPeople_(shifts, groupOf, rules, hasActuals);

  // By day.
  const daily = [0, 1, 2, 3, 4, 5, 6].map(function (i) {
    const row = { date: week ? laborAddDays_(week, i) : '', FOH: { s: 0, a: 0 }, BOH: { s: 0, a: 0 }, MGMT: { s: 0, a: 0 } };
    shifts.forEach(function (s) {
      const grp = groupOf(s.job);
      if (!row[grp]) return;
      row[grp].s += s.days[i].s; row[grp].a += s.days[i].a + s.days[i].o;
    });
    ['FOH', 'BOH', 'MGMT'].forEach(function (k) { row[k].s = laborRound_(row[k].s); row[k].a = laborRound_(row[k].a); });
    return row;
  });

  // Management: scheduled hours per person.
  const mgmtBy = {};
  shifts.forEach(function (s) {
    if (groupOf(s.job) !== 'MGMT') return;
    const m = mgmtBy[s.employee] = mgmtBy[s.employee] || { employee: s.employee, jobs: [], schHrs: 0, days: [0, 0, 0, 0, 0, 0, 0], actHrs: 0 };
    if (m.jobs.indexOf(s.job) === -1) m.jobs.push(s.job);
    m.schHrs += s.totals.s; m.actHrs += s.totals.a + s.totals.o;
    s.days.forEach(function (d, i) { m.days[i] += d.s; });
  });
  const management = Object.keys(mgmtBy).map(function (k) {
    const m = mgmtBy[k];
    return { employee: m.employee, jobs: m.jobs, schHrs: laborRound_(m.schHrs), actHrs: laborRound_(m.actHrs), days: m.days.map(laborRound_),
      shifts: m.days.filter(function (h) { return h > 0; }).length };
  }).sort(function (a, b) { return b.schHrs - a.schHrs || a.employee.localeCompare(b.employee); });

  // Per job code: the overtime premium (each employee's straight-time rate) and the hours added on top of the schedule.
  const jobExtras = {};
  const ex = function (job) { return jobExtras[job] = jobExtras[job] || { otPremium: 0, addedHrs: 0, addedPay: 0 }; };
  const rate = {};
  people.overtime.forEach(function (o) { rate[o.employee] = o.rate; delete o.rate; });
  shifts.forEach(function (s) { if (s.totals.ot > 0 && rate[s.employee]) ex(s.job).otPremium += 0.5 * s.totals.ot * rate[s.employee]; });
  people.off.list.forEach(function (p) {
    p.unscheduled.forEach(function (u) { if (u.addedHrs) { const e = ex(u.jobs[0]); e.addedHrs += u.addedHrs; e.addedPay += u.addedPay; } });
    p.over.forEach(function (o) { const e = ex(o.job); e.addedHrs += o.hrs; e.addedPay += o.pay; });
  });
  Object.keys(jobExtras).forEach(function (j) { const e = jobExtras[j]; e.otPremium = laborRound_(e.otPremium); e.addedHrs = laborRound_(e.addedHrs); e.addedPay = laborRound_(e.addedPay); });

  return { namePairs: aliases.pairs, people: people, daily: daily, management: management, jobExtras: jobExtras };
}

/**
 * The week report for one property.
 * @param {Object} ctx {
 *   week: laborWeekFromRow_, jobs: laborJobFromRow_[] (with .extra from a saved week),
 *   analysis: laborAnalysisFromRows_ (a saved week) — or shifts to work it out here,
 *   recent: [{ week, jobs }] previous past weeks, newest first, groupOf, budget: laborBudgetWeek_ or null, rules }
 */
function buildLaborWeekReport_(ctx) {
  const rules = Object.assign({}, LABOR_RULES, ctx.rules || {});
  const w = ctx.week, groupOf = ctx.groupOf;
  const an = ctx.analysis || laborAnalyzeWeek_(ctx.shifts || [], groupOf, rules, w.stage, w.week);
  const stage = w.stage;
  const hasActuals = stage !== 'schedule';
  const dates = laborWeekDates_(w.week);
  const sales = { net: w.sales.net || null, forecast: w.sales.forecast || null, py: w.sales.py || null, budget: ctx.budget ? laborRound_(ctx.budget.net) : null };
  const g = laborByGroup_(ctx.jobs, groupOf);

  // Recent weeks: average hours per job code, sales, and labor % by group.
  const recent = (ctx.recent || []).slice(0, rules.recentWeeks);
  const recentJob = {}, recentPct = { FOH: [], BOH: [], HOURLY: [] };
  let recentSales = 0;
  recent.forEach(function (r) {
    recentSales += r.week.sales.net;
    r.jobs.forEach(function (j) { recentJob[j.job] = (recentJob[j.job] || 0) + j.totals.a + j.totals.o; });
    const rg = laborByGroup_(r.jobs, groupOf);
    ['FOH', 'BOH', 'HOURLY'].forEach(function (k) { const p = laborPct_(laborPaid_(rg[k]), r.week.sales.net); if (p != null) recentPct[k].push(p); });
  });
  const avg = function (xs) { return xs.length ? xs.reduce(function (s, x) { return s + x; }, 0) / xs.length : null; };
  const recentAvgSales = recent.length ? recentSales / recent.length : null;

  // Targets: the budget, or the recent average.
  const targetSource = ctx.budget ? 'budget' : (recent.length ? 'recent' : null);
  const target = {
    FOH: ctx.budget ? ctx.budget.fohPct : avg(recentPct.FOH),
    BOH: ctx.budget ? ctx.budget.bohPct : avg(recentPct.BOH),
    HOURLY: ctx.budget ? ctx.budget.hourlyPct : avg(recentPct.HOURLY)
  };

  const groupRow = function (key) {
    const t = key === 'HOURLY' ? g.HOURLY : g[key];
    const paid = laborPaid_(t);
    const tp = target[key];
    return {
      key: key, label: key === 'HOURLY' ? 'Hourly labor (FOH + BOH)' : LABOR_GROUPS.filter(function (x) { return x.key === key; })[0].label,
      schHrs: laborRound_(t.s), actHrs: laborRound_(t.a + t.o), varHrs: laborRound_(t.a + t.o - t.s), otHrs: laborRound_(t.ot),
      schPay: laborRound_(t.sa), actPay: laborRound_(paid), varPay: laborRound_(paid - t.sa),
      schPct: laborPct_(t.sa, sales.forecast), actPct: hasActuals ? laborPct_(paid, sales.net) : null, targetPct: tp == null ? null : tp,
      // Pay over the target at the schedule's sales (forecast) and at actual sales.
      schOverTarget: tp == null || !sales.forecast || key === 'MGMT' || key === 'NONE' ? null : laborRound_(t.sa - tp / 100 * sales.forecast),
      actOverTarget: tp == null || !sales.net || !hasActuals || key === 'MGMT' || key === 'NONE' ? null : laborRound_(paid - tp / 100 * sales.net)
    };
  };
  const groups = ['FOH', 'BOH', 'HOURLY', 'MGMT', 'NONE'].map(groupRow);
  const hourlyRow = groups.filter(function (x) { return x.key === 'HOURLY'; })[0];

  // Job codes.
  const jobs = ctx.jobs.map(function (j) {
    const t = j.totals, grp = groupOf(j.job);
    const act = t.a + t.o;
    const rec = recent.length ? (recentJob[j.job] || 0) / recent.length : null;
    const out = { job: j.job, group: grp, employees: j.employees, schHrs: laborRound_(t.s), actHrs: laborRound_(act), varHrs: laborRound_(act - t.s),
      otHrs: laborRound_(t.ot), schPay: laborRound_(t.sa), actPay: laborRound_(laborPaid_(t)), varPay: laborRound_(laborPaid_(t) - t.sa),
      recentHrs: rec == null ? null : laborRound_(rec), notes: [],
      otPremium: j.extra ? j.extra.otPremium : (an.jobExtras && an.jobExtras[j.job] ? an.jobExtras[j.job].otPremium : 0),
      addedHrs: j.extra ? j.extra.addedHrs : (an.jobExtras && an.jobExtras[j.job] ? an.jobExtras[j.job].addedHrs : 0) };
    if (grp === 'FOH' || grp === 'BOH') {
      if (hasActuals && t.s === 0 && act >= rules.minShiftHrs) out.notes.push({ kind: 'unscheduled', text: 'Worked with nothing scheduled' });
      else if (hasActuals && act - t.s >= rules.jobOverHrs && act - t.s >= rules.jobOverPct * t.s) out.notes.push({ kind: 'over', text: laborRound_(act - t.s) + ' hours over the schedule' });
      if (rec != null && rec > 0 && t.s - rec >= rules.jobOverHrs) {
        const salesChange = recentAvgSales && sales.forecast ? sales.forecast / recentAvgSales - 1 : 0;
        if (t.s / rec - 1 - salesChange >= rules.jobAboveRecentPct) {
          out.notes.push({ kind: 'aboveRecent', text: 'Scheduled ' + Math.round((t.s / rec - 1) * 100) + '% above ' + laborWeeksText_(recent.length) + ' (' + laborRound_(rec) + ' hrs)' +
            (recentAvgSales && sales.forecast ? '; forecast sales ' + (salesChange >= 0 ? '+' : '') + Math.round(salesChange * 100) + '%' : '') });
        }
      }
    }
    return out;
  }).sort(function (a, b) {
    const order = { FOH: 0, BOH: 1, MGMT: 2, NONE: 3 };
    return order[a.group] - order[b.group] || b.actHrs + b.schHrs - a.actHrs - a.schHrs || a.job.localeCompare(b.job);
  });

  const people = an.people;

  const findings = laborFindings_({ stage: stage, sales: sales, groups: groups, hourly: hourlyRow, namePairs: an.namePairs, targetSource: targetSource, jobs: jobs,
    people: people, rules: rules, recentWeeks: recent.length });

  return {
    property: w.property, location: w.location, week: w.week, end: w.end, dates: dates, stage: stage,
    uploadedAt: w.uploadedAt, uploadedBy: w.uploadedBy, file: w.file,
    sales: Object.assign({}, sales, {
      vsForecastPct: sales.net && sales.forecast ? (sales.net / sales.forecast - 1) * 100 : null,
      vsPyPct: sales.net && sales.py ? (sales.net / sales.py - 1) * 100 : null,
      vsBudgetPct: sales.net && sales.budget ? (sales.net / sales.budget - 1) * 100 : null,
      forecastVsPyPct: sales.forecast && sales.py ? (sales.forecast / sales.py - 1) * 100 : null,
      forecastVsBudgetPct: sales.forecast && sales.budget ? (sales.forecast / sales.budget - 1) * 100 : null
    }),
    targetSource: targetSource, recentWeeks: recent.length, recentAvgSales: recentAvgSales == null ? null : laborRound_(recentAvgSales),
    groups: groups, jobs: jobs, people: people,
    daily: an.daily.map(function (d, i) { return Object.assign({}, d, { date: dates[i] }); }), management: an.management,
    findings: findings, rules: rules, namePairs: an.namePairs
  };
}

/** Each employee's week across job codes at this property: { employee, jobs, group, days: [{ s, a, ot, aa, sa, byJob }] }. */
function laborEmployees_(shifts, groupOf) {
  const by = {};
  shifts.forEach(function (s) {
    const grp = groupOf(s.job);
    if (grp !== 'FOH' && grp !== 'BOH') return;
    const e = by[s.employee] = by[s.employee] || { employee: s.employee, jobs: [], group: grp,
      days: [0, 1, 2, 3, 4, 5, 6].map(function () { return { s: 0, a: 0, ot: 0, aa: 0, sa: 0, sJobs: [], aJobs: [] }; }) };
    if (e.jobs.indexOf(s.job) === -1) e.jobs.push(s.job);
    s.days.forEach(function (d, i) {
      const x = e.days[i];
      x.s += d.s; x.a += d.a + d.o; x.ot += d.ot; x.aa += d.aa + d.oa; x.sa += d.sa;
      if (d.s > 0) x.sJobs.push(s.job);
      if (d.a + d.o > 0) x.aJobs.push(s.job);
    });
  });
  return by;
}

/**
 * Shifts worked against R365's schedule at the time of the export.
 *
 * A day worked with nothing scheduled is matched against scheduled shifts in
 * the same job code that day that nobody worked: that is a cover (a swap or a
 * call-out filled), and only the hours beyond the missed shift are added
 * labor. Days worked longer than scheduled are listed too.
 */
function laborOffSchedule_(actualShifts, scheduleShifts, groupOf, rules, hasActuals) {
  const act = laborEmployees_(actualShifts, groupOf);
  const sch = scheduleShifts === actualShifts ? act : laborEmployees_(scheduleShifts, groupOf);
  const list = [];
  const totals = { unscheduledShifts: 0, unscheduledHrs: 0, unscheduledPay: 0, coveredShifts: 0, coveredHrs: 0, addedHrs: 0, addedPay: 0,
    overHrs: 0, overPay: 0, missedShifts: 0, missedHrs: 0, uncoveredMissed: 0, otherJobShifts: 0 };
  if (!hasActuals) return { list: list, totals: totals };
  const names = {};
  Object.keys(act).concat(Object.keys(sch)).forEach(function (n) { names[n] = true; });
  const people = [], missedPool = [[], [], [], [], [], [], []];
  Object.keys(names).sort().forEach(function (name) {
    const a = act[name], s = sch[name];
    const p = { employee: name, jobs: (a || s).jobs.slice(), group: (a || s).group, unscheduled: [], over: [], missed: [], otherJob: [], schHrs: 0, actHrs: 0, extraHrs: 0, extraPay: 0 };
    for (let i = 0; i < 7; i++) {
      const ad = a ? a.days[i] : { a: 0, aa: 0, aJobs: [] };
      const sd = s ? s.days[i] : { s: 0, sJobs: [] };
      p.schHrs += sd.s; p.actHrs += ad.a;
      if (ad.a >= rules.minShiftHrs && sd.s === 0) {
        p.unscheduled.push({ day: i, hrs: laborRound_(ad.a), pay: laborRound_(ad.aa), jobs: ad.aJobs, coveredHrs: 0, coveredFor: [] });
      } else if (sd.s > 0 && ad.a < rules.minShiftHrs) {
        const m = { day: i, hrs: laborRound_(sd.s), jobs: sd.sJobs, left: sd.s, coveredBy: [] };
        p.missed.push(m);
        missedPool[i].push({ employee: name, m: m });
      } else if (sd.s > 0) {
        if (ad.a - sd.s >= rules.shiftOverHrs) {
          const x = ad.a - sd.s, rate = ad.aa / ad.a;
          p.over.push({ day: i, hrs: laborRound_(x), scheduled: laborRound_(sd.s), worked: laborRound_(ad.a), pay: laborRound_(x * rate), job: ad.aJobs[0] });
        }
        const other = ad.aJobs.filter(function (j) { return sd.sJobs.indexOf(j) === -1; });
        if (other.length) p.otherJob.push({ day: i, worked: other, scheduled: sd.sJobs });
      }
    }
    people.push(p);
  });
  // Covers: longest unscheduled days first, against missed shifts in the same job code and day.
  const unsched = [];
  people.forEach(function (p) { p.unscheduled.forEach(function (u) { unsched.push({ p: p, u: u }); }); });
  unsched.sort(function (x, y) { return y.u.hrs - x.u.hrs || x.p.employee.localeCompare(y.p.employee); });
  unsched.forEach(function (x) {
    const u = x.u;
    missedPool[u.day].forEach(function (mp) {
      const room = u.hrs - u.coveredHrs;
      if (room <= 0 || mp.m.left <= 0 || mp.employee === x.p.employee) return;
      if (!mp.m.jobs.some(function (j) { return u.jobs.indexOf(j) !== -1; })) return;
      const take = Math.min(room, mp.m.left);
      u.coveredHrs += take; mp.m.left -= take;
      u.coveredFor.push(mp.employee); mp.m.coveredBy.push(x.p.employee);
    });
  });
  people.forEach(function (p) {
    p.unscheduled.forEach(function (u) {
      u.coveredHrs = laborRound_(u.coveredHrs);
      const added = Math.max(0, u.hrs - u.coveredHrs), addedPay = u.hrs ? u.pay * added / u.hrs : 0;
      u.addedHrs = laborRound_(added); u.addedPay = laborRound_(addedPay);
      p.extraHrs += added; p.extraPay += addedPay;
      totals.unscheduledShifts++; totals.unscheduledHrs += u.hrs; totals.unscheduledPay += u.pay;
      if (u.coveredHrs > 0) { totals.coveredShifts++; totals.coveredHrs += u.coveredHrs; }
      totals.addedHrs += added; totals.addedPay += addedPay;
    });
    p.over.forEach(function (o) { p.extraHrs += o.hrs; p.extraPay += o.pay; totals.overHrs += o.hrs; totals.overPay += o.pay; });
    p.missed.forEach(function (m) {
      totals.missedShifts++; totals.missedHrs += m.hrs;
      if (!m.coveredBy.length) totals.uncoveredMissed++;
      delete m.left;
    });
    totals.otherJobShifts += p.otherJob.length;
    if (p.unscheduled.length || p.over.length || p.missed.length || p.otherJob.length) {
      p.schHrs = laborRound_(p.schHrs); p.actHrs = laborRound_(p.actHrs); p.extraHrs = laborRound_(p.extraHrs); p.extraPay = laborRound_(p.extraPay);
      p.notOnSchedule = p.schHrs === 0 && p.actHrs > 0;
      list.push(p);
    }
  });
  Object.keys(totals).forEach(function (k) { totals[k] = laborRound_(totals[k]); });
  list.sort(function (x, y) { return y.extraPay - x.extraPay || y.extraHrs - x.extraHrs || x.employee.localeCompare(y.employee); });
  return { list: list, totals: totals };
}

/** Off-schedule shifts, overtime, and schedules over 40 hours. */
function laborPeople_(shifts, groupOf, rules, hasActuals) {
  const off = laborOffSchedule_(shifts, shifts, groupOf, rules, hasActuals);
  const emp = laborEmployees_(shifts, groupOf);
  const overtime = [], scheduledOver = [];
  Object.keys(emp).forEach(function (name) {
    const e = emp[name];
    let s = 0, a = 0, ot = 0, pay = 0;
    e.days.forEach(function (d) { s += d.s; a += d.a; ot += d.ot; pay += d.aa; });
    if (s > rules.weeklyOtHrs) scheduledOver.push({ employee: name, jobs: e.jobs, group: e.group, schHrs: laborRound_(s), overHrs: laborRound_(s - rules.weeklyOtHrs), shifts: e.days.filter(function (d) { return d.s > 0; }).length });
    if (ot > 0.005) {
      // Straight-time rate from pay that includes the overtime premium; the premium is half of it per overtime hour.
      const rate = a > 0 ? pay / (a + 0.5 * ot) : 0;
      overtime.push({ employee: name, jobs: e.jobs, group: e.group, actHrs: laborRound_(a), schHrs: laborRound_(s), otHrs: laborRound_(ot),
        premium: laborRound_(0.5 * ot * rate), cause: s > rules.weeklyOtHrs ? 'scheduled' : 'extra', rate: rate });
    }
  });
  overtime.sort(function (x, y) { return y.otHrs - x.otHrs || x.employee.localeCompare(y.employee); });
  scheduledOver.sort(function (x, y) { return y.schHrs - x.schHrs || x.employee.localeCompare(y.employee); });
  const otTotals = overtime.reduce(function (t, o) { t.hrs += o.otHrs; t.premium += o.premium; if (o.cause === 'scheduled') t.scheduledHrs += o.otHrs; return t; }, { hrs: 0, premium: 0, scheduledHrs: 0 });
  Object.keys(otTotals).forEach(function (k) { otTotals[k] = laborRound_(otTotals[k]); });
  return { off: off, overtime: overtime, otTotals: otTotals, scheduledOver: scheduledOver };
}

function laborWeeksText_(n) { return n === 1 ? 'the week before' : 'the last ' + n + ' weeks'; }

/** The headline findings, most money first. */
function laborFindings_(r) {
  const out = [];
  const rules = r.rules, s = r.sales, H = r.hourly;
  const pct = function (v) { return (Math.round(v * 10) / 10).toFixed(1) + '%'; };
  const money = function (v) { return '$' + Math.round(Math.abs(v)).toLocaleString('en-US'); };
  const tsrc = r.targetSource === 'budget' ? 'budget' : laborWeeksText_(r.recentWeeks);

  if (!s.forecast) out.push({ kind: 'sales', severity: 'warn', title: 'No sales forecast', detail: 'R365 has no forecast for this week, so the schedule cannot be judged against sales. Enter the forecast in R365 and upload again.' });
  if (r.stage !== 'schedule' && s.net && s.forecast) {
    const miss = (s.net / s.forecast - 1) * 100;
    if (Math.abs(miss) >= rules.salesMissPct) {
      out.push({ kind: 'sales', severity: miss < 0 ? 'bad' : 'info', impact: Math.abs(s.net - s.forecast),
        title: 'Sales ' + (miss < 0 ? 'missed' : 'beat') + ' the forecast by ' + pct(Math.abs(miss)),
        detail: money(s.net) + ' against ' + money(s.forecast) + ' forecast' + (s.py ? ' and ' + money(s.py) + ' last year' : '') + '.' +
          (miss < 0 && H.schPct != null && H.actPct != null ? ' Hourly labor was scheduled at ' + pct(H.schPct) + ' of the forecast and came in at ' + pct(H.actPct) + ' of actual sales.' : '') });
    }
  }
  if (s.forecast && s.py && r.stage === 'schedule' && Math.abs(s.forecast / s.py - 1) * 100 >= 15) {
    out.push({ kind: 'sales', severity: 'info', title: 'Forecast ' + (s.forecast > s.py ? 'above' : 'below') + ' last year by ' + pct(Math.abs(s.forecast / s.py - 1) * 100),
      detail: money(s.forecast) + ' forecast against ' + money(s.py) + ' last year' + (s.budget ? ' and ' + money(s.budget) + ' budget' : '') + '. Check it before the schedule is built on it.' });
  }
  // Front and back of house each; hourly as a whole only when neither is out on its own.
  const flagged = { sch: false, act: false };
  r.groups.filter(function (g) { return g.key === 'FOH' || g.key === 'BOH' || g.key === 'HOURLY'; }).forEach(function (g) {
    if (g.targetPct == null) return;
    if (g.key === 'HOURLY' && flagged.sch) g = Object.assign({}, g, { schPct: null });
    if (g.key === 'HOURLY' && flagged.act) g = Object.assign({}, g, { actPct: null });
    if (g.schPct != null && g.schPct - g.targetPct >= rules.overTargetPts && g.schOverTarget > 0) {
      flagged.sch = true;
      out.push({ kind: 'schedule', severity: 'bad', impact: g.schOverTarget, group: g.key,
        title: g.label + ' scheduled at ' + pct(g.schPct) + ' of forecast; target ' + pct(g.targetPct),
        detail: 'The schedule is ' + money(g.schOverTarget) + ' above ' + tsrc + ' at the forecast sales (' + money(g.schPay) + ' scheduled).' });
    }
    if (r.stage !== 'schedule' && g.actPct != null && g.actPct - g.targetPct >= rules.overTargetPts && g.actOverTarget > 0) {
      flagged.act = true;
      out.push({ kind: 'labor', severity: 'bad', impact: g.actOverTarget, group: g.key,
        title: g.label + ' ran at ' + pct(g.actPct) + ' of sales; target ' + pct(g.targetPct),
        detail: money(g.actOverTarget) + ' above ' + tsrc + ' at actual sales. ' + money(g.actPay) + ' paid against ' + money(g.schPay) + ' scheduled.' });
    }
  });
  const off = r.people.off.totals;
  if (r.stage !== 'schedule' && off.unscheduledShifts) {
    out.push({ kind: 'people', severity: off.addedHrs >= rules.jobOverHrs ? 'bad' : 'info', impact: off.addedPay,
      title: off.unscheduledShifts + ' shift' + (off.unscheduledShifts === 1 ? '' : 's') + ' worked that ' + (off.unscheduledShifts === 1 ? 'was' : 'were') + ' not on the schedule',
      detail: (off.coveredShifts ? off.coveredShifts + ' covered a scheduled shift someone else missed. ' : '') +
        laborRound_(off.addedHrs) + ' hours (about ' + money(off.addedPay) + ') were added on top of the schedule. See People off the schedule.' });
  }
  if (r.stage !== 'schedule' && off.overHrs >= rules.jobOverHrs) {
    out.push({ kind: 'people', severity: 'warn', impact: off.overPay,
      title: laborRound_(off.overHrs) + ' hours worked beyond scheduled shifts',
      detail: 'Days at least ' + rules.shiftOverHrs + ' hours longer than scheduled, about ' + money(off.overPay) + '.' });
  }
  const ot = r.people.otTotals;
  if (ot.hrs > 0) {
    out.push({ kind: 'overtime', severity: 'bad', impact: ot.premium,
      title: laborRound_(ot.hrs) + ' overtime hours, ' + r.people.overtime.length + ' employee' + (r.people.overtime.length === 1 ? '' : 's'),
      detail: 'Overtime premium about ' + money(ot.premium) + '.' + (ot.scheduledHrs ? ' ' + laborRound_(ot.scheduledHrs) + ' of those hours were written into the schedule (over ' + rules.weeklyOtHrs + ' hours).' : '') });
  }
  if (r.people.scheduledOver.length && (r.stage === 'schedule' || !ot.hrs)) {
    const hrs = r.people.scheduledOver.reduce(function (t, x) { return t + x.overHrs; }, 0);
    out.push({ kind: 'overtime', severity: 'warn',
      title: r.people.scheduledOver.length + ' employee' + (r.people.scheduledOver.length === 1 ? '' : 's') + ' scheduled over ' + rules.weeklyOtHrs + ' hours',
      detail: laborRound_(hrs) + ' overtime hours written into the schedule: ' + r.people.scheduledOver.slice(0, 4).map(function (x) { return x.employee + ' ' + x.schHrs; }).join(', ') + (r.people.scheduledOver.length > 4 ? ' …' : '') + '.' });
  }
  const unschJobs = r.jobs.filter(function (j) { return j.notes.some(function (n) { return n.kind === 'unscheduled'; }); });
  if (unschJobs.length) {
    out.push({ kind: 'jobs', severity: 'warn', impact: unschJobs.reduce(function (t, j) { return t + j.actPay; }, 0),
      title: unschJobs.length + ' job code' + (unschJobs.length === 1 ? '' : 's') + ' worked with nothing scheduled',
      detail: unschJobs.map(function (j) { return j.job + ' (' + j.actHrs + ' hrs)'; }).join(', ') + '.' });
  }
  const aboveRecent = r.jobs.filter(function (j) { return j.notes.some(function (n) { return n.kind === 'aboveRecent'; }); });
  if (aboveRecent.length) {
    out.push({ kind: 'schedule', severity: 'warn',
      title: aboveRecent.length + ' job code' + (aboveRecent.length === 1 ? '' : 's') + ' scheduled well above recent weeks',
      detail: aboveRecent.map(function (j) { return j.job + ' ' + j.schHrs + ' hrs vs ' + j.recentHrs; }).join(', ') + '.' });
  }
  if (r.namePairs && r.namePairs.length) {
    out.push({ kind: 'people', severity: 'info',
      title: r.namePairs.length + ' employee' + (r.namePairs.length === 1 ? ' is' : 's are') + ' scheduled under a different name than they clock in with',
      detail: r.namePairs.map(function (p) { return p.scheduled + ' / ' + p.worked; }).join(', ') + '. Read as the same person here; fix the employee record in R365.' });
  }
  const rank = { bad: 0, warn: 1, info: 2 };
  return out.sort(function (a, b) { return rank[a.severity] - rank[b.severity] || (b.impact || 0) - (a.impact || 0); });
}
