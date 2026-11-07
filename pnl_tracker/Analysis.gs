/*******************************************************************************
 * Analysis.gs — turns stored months into the period report, the portfolio
 * view and trends. Plain JavaScript with no Apps Script services, so the
 * Node harness runs it against real exports.
 *
 * INPUT: a "store" object assembled by Code.gs from the data workbook:
 *   {
 *     properties: [{ code, name, active }],
 *     actuals: { [prop]: { [period 'YYYY-MM']: { stage, asOf, lines: { [key]: line } } } },
 *     detail:  { [prop]: { [period]: [{ category, code, name, amount }] } },
 *     budgets: { [prop]: { [year]: { lines: {key: number[12]}, gl: {code: {name, months}}, daily } } },
 *     tags:    { [prop]: { [period]: { [key]: { tag: 'timing', note } } } },
 *     notes:   { [prop]: { [period]: 'text' } },
 *     rules:   see DEFAULT_RULES
 *   }
 *   A line is { key, name, section, kind, amount, pct } where kind is
 *   'line' | 'group' (a category), 'sectionTotal' (TOTAL_7000) or 'computed'
 *   (NET_SALES, OPERATING_INCOME …).
 *
 * MONTH STAGES (set at upload from the "data through" date)
 *   mtd          uploaded before the month ended (weekly month-to-date upload)
 *   preliminary  month ended less than settleDays ago; corporate entries
 *                (management fee, commission …) may not be posted yet
 *   settled      uploaded settleDays or more after month end — the official month
 *
 * FLAG RULE (cost categories in sections 5000–8000, incl. 9100 Mgmt Fee)
 *   A category is flagged when it is worse than budget by minDollar AND
 *   minPct, or when its % of net sales is above its normal range (the last 12
 *   months on file, dropping the highest and lowest and any month the manager
 *   tagged as timing). Each flag is then labelled:
 *     trend  the two months before were also over (together) → a real problem
 *     spike  the months before were fine → one month, often timing / accrual
 *     new    the line was about zero for the past year and now recurs
 *   A line is "missing" when it posted in every recent month but has nothing
 *   now (warning once settled; "not posted yet" while preliminary).
 *   Up to 3 sub-accounts explain each flag: against their own budget GL line
 *   where the budget has one, otherwise against the same month last year.
 *   Lines below operating income (9000) are reported but never flagged:
 *   operating income is the property's headline number.
 *   During a month-to-date upload only real-time lines (food, beverage,
 *   hourly labor) are judged, on % of sales; the rest post at close.
 ******************************************************************************/

const DEFAULT_RULES = {
  minDollar: 2500,      // flag: at least this much worse than budget …
  minPct: 0.10,         // … and at least this share of the budget
  driverMin: 1000,      // sub-account call-outs: at least this far off
  mtdPctPoints: 1.0,    // month to date: % of sales worse than budget by this many points
  settleDays: 15,       // days after month end when an upload counts as settled
  realTimeLines: ['5002', '5185', '5190', '6201', '6209']
};

const SUBTOTAL_NAMES = {
  NET_SALES: 'Net sales', TOTAL_5000: 'Total cost of sales', GROSS_PROFIT: 'Gross profit',
  TOTAL_6000: 'Total labor', PROFIT_AFTER_PRIME_COST: 'Profit after prime cost',
  TOTAL_7000: 'Total expenses', CONTROLLABLE_PROFIT: 'Controllable profit',
  TOTAL_8000: 'Total non-controllable', OPERATING_INCOME: 'Operating income',
  TOTAL_9000: 'Total corporate, interest & other', NET_PROFIT: 'Net profit'
};
const SUBTOTAL_SECTION = {
  NET_SALES: '4000', TOTAL_5000: '5000', GROSS_PROFIT: '5000', TOTAL_6000: '6000',
  PROFIT_AFTER_PRIME_COST: '6000', TOTAL_7000: '7000', CONTROLLABLE_PROFIT: '7000',
  TOTAL_8000: '8000', OPERATING_INCOME: '8000', TOTAL_9000: '9000', NET_PROFIT: '9000'
};
const HIGHER_IS_BETTER = { NET_SALES: 1, GROSS_PROFIT: 1, PROFIT_AFTER_PRIME_COST: 1,
  CONTROLLABLE_PROFIT: 1, OPERATING_INCOME: 1, NET_PROFIT: 1 };

/* --------------------------------------------------------------- periods */

function periodAdd_(period, n) {
  const y = Number(period.slice(0, 4)), m = Number(period.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12 + 1;
  return yy + '-' + (mm < 10 ? '0' : '') + mm;
}
function periodEndDate_(period) {
  const y = Number(period.slice(0, 4)), m = Number(period.slice(5, 7));
  return y + '-' + period.slice(5, 7) + '-' + String(new Date(y, m, 0).getDate()).padStart(2, '0');
}
function daysBetween_(a, b) { // 'YYYY-MM-DD' strings, b − a in days
  return Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) -
    Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86400000);
}

/** Which stage a month is in, given the date its data runs through. */
function stageFor_(period, asOf, settleDays) {
  const end = periodEndDate_(period);
  if (asOf < end) return 'mtd';
  return daysBetween_(end, asOf) >= settleDays ? 'settled' : 'preliminary';
}

/* ----------------------------------------------------------- line helpers */

function sectionRank_(key, section) {
  return Number(section || SUBTOTAL_SECTION[key] || String(key).charAt(0) + '000') || 9999;
}
/** Canonical order: section, then categories by code, section total, computed subtotals. */
function compareLines_(a, b) {
  const sa = sectionRank_(a.key, a.section), sb = sectionRank_(b.key, b.section);
  if (sa !== sb) return sa - sb;
  const kr = function (l) { return l.kind === 'sectionTotal' ? 1 : (l.kind === 'computed' ? 2 : 0); };
  if (kr(a) !== kr(b)) return kr(a) - kr(b);
  if (kr(a) === 2) { // GROSS_PROFIT etc. are one per section; NET_SALES alone in 4000
    return 0;
  }
  return parseFloat(a.key) - parseFloat(b.key) || String(a.key).localeCompare(String(b.key));
}
function isCategory_(line) { return line.kind === 'line' || line.kind === 'group'; }
function direction_(key, section) {
  if (HIGHER_IS_BETTER[key]) return 1;
  if ((section || SUBTOTAL_SECTION[key]) === '4000') return 1;
  return -1;
}
function isFlaggable_(line) {
  return isCategory_(line) && ['5000', '6000', '7000', '8000'].indexOf(line.section) !== -1;
}

/* ---------------------------------------------------------- store lookups */

function monthOnFile_(store, prop, period) {
  return (store.actuals[prop] && store.actuals[prop][period]) || null;
}
function amountOf_(store, prop, period, key) {
  const m = monthOnFile_(store, prop, period);
  if (!m) return null;
  const l = m.lines[key];
  return l ? l.amount : 0;
}
/**
 * Months of a property whose every line matches another property's same
 * month to the dollar: a file uploaded under the wrong location. Two real
 * properties never post identical P&Ls.
 * @return {Array<{period: string, other: string}>}
 */
function copiedMonths_(store, prop, periods) {
  const out = [];
  (periods || []).forEach(function (period) {
    const m = monthOnFile_(store, prop, period);
    if (!m || !amountOf_(store, prop, period, 'NET_SALES')) return;
    const keys = Object.keys(m.lines);
    Object.keys(store.actuals).some(function (other) {
      if (other === prop) return false;
      const o = monthOnFile_(store, other, period);
      if (!o || Object.keys(o.lines).length !== keys.length) return false;
      const same = keys.every(function (k) { return o.lines[k] && Math.abs(o.lines[k].amount - m.lines[k].amount) < 0.5; });
      if (same) out.push({ period: period, other: other });
      return same;
    });
  });
  return out;
}
/** Months in an upload whose figures are identical to another property's, grouped by property pair. */
function uploadCopies_(store, months) {
  const byProp = {};
  months.forEach(function (m) { (byProp[m.property] = byProp[m.property] || []).push(m.period); });
  const out = [];
  Object.keys(byProp).forEach(function (prop) {
    const hits = copiedMonths_(store, prop, byProp[prop]);
    const byOther = {};
    hits.forEach(function (h) { (byOther[h.other] = byOther[h.other] || []).push(h.period); });
    Object.keys(byOther).forEach(function (other) { out.push({ property: prop, other: other, periods: byOther[other].sort() }); });
  });
  return out;
}
function copiesText_(copies) {
  return copies.map(function (c) {
    return c.property + ' ' + c.periods.length + ' month' + (c.periods.length === 1 ? '' : 's') + ' (' + c.periods[0] +
      (c.periods.length > 1 ? ' to ' + c.periods[c.periods.length - 1] : '') + ') identical to ' + c.other + ' on file';
  }).join('; ');
}

function budgetYear_(store, prop, period) {
  const b = store.budgets[prop];
  return (b && b[Number(period.slice(0, 4))]) || null;
}
/** Budget for one month, category lines plus subtotals, or null. */
function budgetMonth_(store, prop, period) {
  const by = budgetYear_(store, prop, period);
  if (!by) return null;
  const mi = Number(period.slice(5, 7)) - 1;
  const out = budgetSubtotals_(by.lines, mi);
  Object.keys(by.lines).forEach(function (k) { out[k] = by.lines[k][mi]; });
  delete out._corp;
  return out;
}
function budgetGl_(store, prop, period, code) {
  const by = budgetYear_(store, prop, period);
  if (!by || !by.gl[code]) return null;
  return by.gl[code].months[Number(period.slice(5, 7)) - 1];
}
function tagOf_(store, prop, period, key) {
  const t = store.tags[prop] && store.tags[prop][period] && store.tags[prop][period][key];
  return t || null;
}
function pctOf_(amount, net) { return net ? amount / net * 100 : null; }
function median_(xs) {
  const s = xs.slice().sort(function (a, b) { return a - b; });
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The previous `n` months (newest first) that are on file and settled or preliminary. */
function priorMonths_(store, prop, period, n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const p = periodAdd_(period, -i);
    const m = monthOnFile_(store, prop, p);
    if (m && m.stage !== 'mtd') out.push(p);
  }
  return out;
}

/** Every line this property has reported recently, plus budget lines, with names. */
function lineCatalog_(store, prop, period) {
  const meta = {};
  const add = function (l) {
    if (!meta[l.key]) meta[l.key] = { key: l.key, name: l.name, section: l.section, kind: l.kind };
  };
  const cur = monthOnFile_(store, prop, period);
  if (cur) Object.keys(cur.lines).forEach(function (k) { add(cur.lines[k]); });
  priorMonths_(store, prop, period, 12).forEach(function (p) {
    const m = monthOnFile_(store, prop, p);
    Object.keys(m.lines).forEach(function (k) { add(m.lines[k]); });
  });
  const by = budgetYear_(store, prop, period);
  if (by) {
    Object.keys(by.lines).forEach(function (k) {
      if (meta[k] || !by.lines[k].some(function (v) { return v; })) return;
      const spec = BUDGET_LINE_MAP.filter(function (s) { return s.key === k; })[0];
      add({ key: k, name: spec ? spec.labels[0] : k, section: BUDGET_LINE_SECTION[k], kind: 'line' });
    });
  }
  Object.keys(SUBTOTAL_NAMES).forEach(function (k) {
    if (!meta[k] && (k === 'NET_SALES' || k === 'OPERATING_INCOME' || k === 'NET_PROFIT')) {
      add({ key: k, name: SUBTOTAL_NAMES[k], section: SUBTOTAL_SECTION[k], kind: k.indexOf('TOTAL_') === 0 ? 'sectionTotal' : 'computed' });
    }
  });
  return Object.keys(meta).map(function (k) { return meta[k]; }).sort(compareLines_);
}

/* ------------------------------------------------------------ the report */

/**
 * Everything the period report needs for one property and month.
 */
function buildPeriodReport_(store, prop, period) {
  const rules = Object.assign({}, DEFAULT_RULES, store.rules || {});
  const cur = monthOnFile_(store, prop, period);
  if (!cur) throw new Error('No data on file for ' + prop + ' in ' + period + '.');
  const stage = cur.stage;
  const net = amountOf_(store, prop, period, 'NET_SALES') || 0;

  // Month-to-date: scale the month's budget to the share that falls before the as-of day.
  let fraction = 1;
  const by = budgetYear_(store, prop, period);
  if (stage === 'mtd') {
    const day = Number(String(cur.asOf).slice(8, 10)) || 1;
    fraction = budgetMonthFraction_(by && by.daily, Number(period.slice(0, 4)), Number(period.slice(5, 7)), day);
  }
  const budRaw = budgetMonth_(store, prop, period);
  const bud = budRaw ? scaleMap_(budRaw, fraction) : null;
  const budNet = bud ? bud.NET_SALES : null;
  const lyPeriod = periodAdd_(period, -12);
  const lyMonth = monthOnFile_(store, prop, lyPeriod);
  const lyNet = lyMonth ? amountOf_(store, prop, lyPeriod, 'NET_SALES') * fraction : null;

  // Windows: last 3 months (all on file) and year to date (months on file).
  const p3 = [periodAdd_(period, -2), periodAdd_(period, -1), period];
  const has3 = p3.every(function (p) { const m = monthOnFile_(store, prop, p); return m && (p === period || m.stage !== 'mtd'); });
  const ytdPeriods = [];
  for (let mo = 1; mo <= Number(period.slice(5, 7)); mo++) {
    const p = period.slice(0, 4) + '-' + (mo < 10 ? '0' : '') + mo;
    if (monthOnFile_(store, prop, p)) ytdPeriods.push(p);
  }
  const budgetFor = function (p, key) {
    const b = budgetMonth_(store, prop, p);
    if (!b || !(key in b)) return null;
    return p === period ? b[key] * fraction : b[key];
  };
  const sumOver = function (periods, fn) {
    let s = 0;
    for (let i = 0; i < periods.length; i++) { const v = fn(periods[i]); if (v == null) return null; s += v; }
    return s;
  };

  const catalog = lineCatalog_(store, prop, period);
  const prior12 = priorMonths_(store, prop, period, 12);
  const flags = [];
  const missing = [];

  const rows = catalog.map(function (meta) {
    const key = meta.key;
    const line = cur.lines[key];
    const act = line ? line.amount : 0;
    const dir = direction_(key, meta.section);
    const b = bud && key in bud ? bud[key] : null;
    // Month to date: last year's full month is cut to the same share of the month as the budget.
    const lyFull = lyMonth ? amountOf_(store, prop, lyPeriod, key) : null;
    const ly = lyFull == null ? null : lyFull * fraction;
    const row = {
      key: key, name: meta.name, section: meta.section, kind: meta.kind,
      actual: act, pct: pctOf_(act, net), reportedPct: line ? line.pct : null, absent: !line,
      budget: b, budgetPct: b == null ? null : pctOf_(b, budNet),
      varBudget: b == null ? null : dir * (act - b),
      ly: ly, lyPct: ly == null ? null : pctOf_(ly, lyNet), varLy: ly == null ? null : dir * (act - ly),
      three: null, ytd: null, flag: null, missing: null, tag: tagOf_(store, prop, period, key)
    };
    if (has3) {
      const a3 = sumOver(p3, function (p) { return amountOf_(store, prop, p, key); });
      const b3 = sumOver(p3, function (p) { return budgetFor(p, key); });
      row.three = { actual: a3, budget: b3, variance: b3 == null ? null : dir * (a3 - b3) };
    }
    if (ytdPeriods.length) {
      const ay = sumOver(ytdPeriods, function (p) { return amountOf_(store, prop, p, key); });
      const byd = sumOver(ytdPeriods, function (p) { return budgetFor(p, key); });
      row.ytd = { actual: ay, budget: byd, variance: byd == null ? null : dir * (ay - byd), months: ytdPeriods.length };
    }

    if (isCategory_(meta) && !act && stage !== 'mtd') { // absent, or listed with no amount
      const m = missingCheck_(store, rules, prop, period, key, prior12, b);
      if (m) { row.missing = m; m.severity = stage === 'settled' ? 'warning' : 'pending'; missing.push(Object.assign({ key: key, name: meta.name, section: meta.section }, m)); }
    }

    if (isFlaggable_(meta)) {
      const f = stage === 'mtd'
        ? mtdFlag_(rules, meta, row, net, budNet)
        : monthFlag_(store, rules, prop, period, meta, row, net, prior12, has3, p3);
      if (f) {
        f.drivers = driversFor_(store, rules, prop, period, key);
        f.tagged = !!(row.tag && row.tag.tag === 'timing');
        row.flag = f;
        flags.push(Object.assign({ key: key, name: meta.name, actual: act, budget: b, pct: row.pct }, f));
      }
    }
    return row;
  });

  flags.sort(function (a, b) {
    return (a.tagged - b.tagged) || ((b.overBy || 0) - (a.overBy || 0));
  });

  const get = function (k) { return rows.filter(function (x) { return x.key === k; })[0] || null; };
  const summary = reportSummary_(rows, !!bud, !!lyMonth);
  const oiRow = get('OPERATING_INCOME');
  const expectedMissing = missing.filter(function (m) { return ['5000', '6000', '7000', '8000'].indexOf(m.section) !== -1; })
    .reduce(function (s, m) { return s + (m.expected || 0); }, 0);

  return {
    property: prop,
    period: period,
    stage: stage,
    asOf: cur.asOf,
    fraction: fraction,
    hasBudget: !!bud,
    hasLastYear: !!lyMonth,
    lyProrated: !!lyMonth && fraction < 1,
    lyPeriod: lyPeriod,
    threeMonths: has3 ? p3 : null,
    ytdMonths: ytdPeriods,
    headline: Object.assign(summary.headline, {
      ifMissingPosted: missing.length && oiRow ? oiRow.actual - expectedMissing : null
    }),
    kpis: summary.kpis,
    rows: rows,
    flags: flags,
    missing: missing,
    note: (store.notes[prop] && store.notes[prop][period]) || ''
  };
}

/**
 * A recurring line with nothing this month: posted in every one of the last
 * 3+ months on file, averaging at least driverMin (small lines such as
 * training come and go and are not worth a warning).
 */
function missingCheck_(store, rules, prop, period, key, prior12, budget) {
  const recent = prior12.slice(0, 6);
  if (recent.length < 3) return null;
  const vals = recent.map(function (p) { return amountOf_(store, prop, p, key); });
  if (vals.some(function (v) { return !v; })) return null;
  const avg = vals.slice(0, 3).reduce(function (s, v) { return s + v; }, 0) / 3;
  if (Math.abs(avg) < rules.driverMin) return null;
  return { expected: budget != null && budget ? budget : avg, basis: budget ? 'budget' : 'average of last 3 months',
    monthsPosted: recent.length };
}

/** Month-to-date: real-time lines only, judged on % of sales against budget %. */
function mtdFlag_(rules, meta, row, net, budNet) {
  if (rules.realTimeLines.indexOf(meta.key) === -1 || row.budgetPct == null || row.pct == null) return null;
  const pts = row.pct - row.budgetPct;
  if (pts < rules.mtdPctPoints) return null;
  return { type: 'pace', overBy: pts / 100 * net, reason: 'Running ' + pts.toFixed(1) + ' pts of sales above budget so far this month' };
}

function isOver_(rules, actual, budget) {
  if (budget == null) return false;
  const worse = actual - budget;
  if (worse < rules.minDollar) return false;
  return budget <= 0 || worse / Math.abs(budget) >= rules.minPct;
}

/** Normal range of a line's % of sales over the prior 12 months on file. */
function normalRange_(store, prop, period, key, prior12) {
  const pcts = [];
  prior12.forEach(function (p) {
    const t = tagOf_(store, prop, p, key);
    if (t && t.tag === 'timing') return;
    const n = amountOf_(store, prop, p, 'NET_SALES');
    if (!n) return;
    pcts.push(amountOf_(store, prop, p, key) / n * 100);
  });
  if (pcts.length < 6) return null;
  pcts.sort(function (a, b) { return a - b; });
  return { low: pcts[1], high: pcts[pcts.length - 2], months: pcts.length };
}

function monthFlag_(store, rules, prop, period, meta, row, net, prior12, has3, p3) {
  const key = meta.key;
  const act = row.actual;
  const over = isOver_(rules, act, row.budget);
  const range = normalRange_(store, prop, period, key, prior12);
  const outside = !!(range && row.pct != null && row.pct > range.high + 0.05 &&
    act - range.high / 100 * net >= rules.minDollar);

  const priorVals = prior12.map(function (p) { return amountOf_(store, prop, p, key); });
  const prev = amountOf_(store, prop, periodAdd_(period, -1), key);
  const med = priorVals.length >= 6 ? median_(priorVals) : null;
  const isNew = med != null && Math.abs(med) < 0.1 * act && act >= rules.minDollar && prev != null && prev >= rules.minDollar;

  if (!over && !outside && !isNew) return null;

  // Trend: the two months before were also over (together). Otherwise this
  // month stands alone — a spike, often timing or an accrual.
  let type;
  const before = [p3[0], p3[1]];
  if (isNew) type = 'new';
  else if (has3 && row.budget != null) {
    const a2 = before.reduce(function (s, p) { return s + (amountOf_(store, prop, p, key) || 0); }, 0);
    const b2 = before.map(function (p) { const b = budgetMonth_(store, prop, p); return b && key in b ? b[key] : null; });
    type = b2.indexOf(null) === -1 && isOver_(rules, a2, b2[0] + b2[1]) ? 'trend' : 'spike';
  } else if (has3 && range) {
    const n2 = before.reduce(function (s, p) { return s + (amountOf_(store, prop, p, 'NET_SALES') || 0); }, 0);
    const a2 = before.reduce(function (s, p) { return s + (amountOf_(store, prop, p, key) || 0); }, 0);
    type = n2 && a2 / n2 * 100 > range.high ? 'trend' : 'spike';
  } else type = 'spike';

  const reasons = [];
  if (over) reasons.push('over budget by ' + Math.round(act - row.budget).toLocaleString('en-US'));
  if (outside) reasons.push(row.pct.toFixed(1) + '% of sales, above the normal ' + range.low.toFixed(1) + '–' + range.high.toFixed(1) + '%');
  if (isNew) reasons.push('was near zero for the past year');
  return {
    type: type,
    overBudget: over,
    outsideNormal: outside,
    range: range,
    overBy: over ? act - row.budget : (range ? act - range.high / 100 * net : 0),
    reason: reasons.join('; ')
  };
}

/**
 * Up to 3 sub-accounts that explain a flag (plus the largest offset), against
 * their own budget GL line when the budget has them, otherwise against the
 * same month last year, otherwise last month.
 */
function driversFor_(store, rules, prop, period, category) {
  const det = store.detail[prop] && store.detail[prop][period];
  if (!det) return null;
  const leaves = det.filter(function (d) { return d.category === category; });
  if (!leaves.length) return null;

  const glBudgeted = leaves.some(function (d) { return d.code !== category && budgetGl_(store, prop, period, d.code) != null; });
  let basis, refOf;
  if (glBudgeted) {
    basis = 'budget';
    refOf = function (d) { return d.code === category ? null : (budgetGl_(store, prop, period, d.code) || 0); };
  } else {
    const refPeriod = store.detail[prop][periodAdd_(period, -12)] ? periodAdd_(period, -12)
      : (store.detail[prop][periodAdd_(period, -1)] ? periodAdd_(period, -1) : null);
    if (!refPeriod) return null;
    basis = refPeriod === periodAdd_(period, -12) ? 'same month last year' : 'last month';
    const ref = {};
    store.detail[prop][refPeriod].forEach(function (d) { if (d.category === category) ref[d.code] = (ref[d.code] || 0) + d.amount; });
    refOf = function (d) { return ref[d.code] || 0; };
  }
  const scored = [];
  const seen = {};
  leaves.forEach(function (d) {
    if (seen[d.code]) return; seen[d.code] = true;
    const ref = refOf(d);
    if (ref == null) return;
    scored.push({ code: d.code, name: d.name, actual: d.amount, ref: ref, worseBy: d.amount - ref });
  });
  const worse = scored.filter(function (s) { return s.worseBy >= rules.driverMin; })
    .sort(function (a, b) { return b.worseBy - a.worseBy; }).slice(0, 3);
  const offset = scored.filter(function (s) { return -s.worseBy >= rules.driverMin; })
    .sort(function (a, b) { return a.worseBy - b.worseBy; })[0];
  return { basis: basis, lines: worse, offset: offset || null };
}

function scaleMap_(map, f) {
  if (f === 1) return map;
  const out = {};
  Object.keys(map).forEach(function (k) { out[k] = map[k] * f; });
  return out;
}

/* --------------------------------------------------- quarter and YTD views */

const GROUPINGS = ['month', 'quarter', 'ytd'];

/**
 * The calendar months a grouping covers for the month `period`:
 *   month    just that month
 *   quarter  the whole calendar quarter the month falls in
 *   ytd      January through that month
 */
function groupingMonths_(period, grouping) {
  const y = period.slice(0, 4), m = Number(period.slice(5, 7));
  let first = m, last = m;
  if (grouping === 'quarter') { first = Math.floor((m - 1) / 3) * 3 + 1; last = first + 2; }
  if (grouping === 'ytd') first = 1;
  const out = [];
  for (let mo = first; mo <= last; mo++) out.push(y + '-' + (mo < 10 ? '0' : '') + mo);
  return out;
}

/** The same grouping one step back: previous month, previous quarter, or last year's YTD. */
function priorGroupingPeriod_(period, grouping) {
  return periodAdd_(period, grouping === 'quarter' ? -3 : (grouping === 'ytd' ? -12 : -1));
}

function worstStage_(stages) {
  return stages.indexOf('mtd') !== -1 ? 'mtd' : (stages.indexOf('preliminary') !== -1 ? 'preliminary' : (stages.length ? 'settled' : null));
}

/**
 * The report for a month, quarter or year to date. A month is the full
 * period report. A quarter or YTD adds up the months on file in that window:
 * budget over the same months, last year over the same months a year
 * earlier (only when every one of them is on file). A month-to-date upload
 * in the window cuts that month's budget and last year to the same share of
 * the month, as the monthly report does. Flags, missing lines and notes
 * belong to single months, so they are left out of these totals.
 */
function buildGroupedReport_(store, prop, period, grouping) {
  grouping = GROUPINGS.indexOf(grouping) === -1 ? 'month' : grouping;
  if (grouping === 'month') return Object.assign(buildPeriodReport_(store, prop, period), { grouping: 'month', months: [period] });

  const months = groupingMonths_(period, grouping).filter(function (p) { return monthOnFile_(store, prop, p); });
  if (!months.length) throw new Error('No data on file for ' + prop + ' in that ' + (grouping === 'quarter' ? 'quarter' : 'year') + '.');
  const lastMonth = months[months.length - 1];
  const last = monthOnFile_(store, prop, lastMonth);

  // Share of each month that counts: 1, except a month-to-date upload.
  const fractionOf = {};
  months.forEach(function (p) {
    const m = monthOnFile_(store, prop, p);
    if (m.stage !== 'mtd') { fractionOf[p] = 1; return; }
    const by = budgetYear_(store, prop, p);
    fractionOf[p] = budgetMonthFraction_(by && by.daily, Number(p.slice(0, 4)), Number(p.slice(5, 7)), Number(String(m.asOf).slice(8, 10)) || 1);
  });
  const sumOver = function (fn) {
    let s = 0;
    for (let i = 0; i < months.length; i++) { const v = fn(months[i]); if (v == null) return null; s += v; }
    return s;
  };
  const budgetsByMonth = {};
  months.forEach(function (p) { budgetsByMonth[p] = budgetMonth_(store, prop, p); });
  const hasBudget = months.every(function (p) { return budgetsByMonth[p]; });
  const lyMonths = months.map(function (p) { return periodAdd_(p, -12); });
  const hasLy = lyMonths.every(function (p) { return monthOnFile_(store, prop, p); });

  const budgetOf = function (key) {
    if (!hasBudget) return null;
    return sumOver(function (p) { const b = budgetsByMonth[p]; return key in b ? b[key] * fractionOf[p] : null; });
  };
  const lyOf = function (key) {
    if (!hasLy) return null;
    return sumOver(function (p) { return amountOf_(store, prop, periodAdd_(p, -12), key) * fractionOf[p]; });
  };

  const net = sumOver(function (p) { return amountOf_(store, prop, p, 'NET_SALES'); }) || 0;
  const budNet = budgetOf('NET_SALES');
  const lyNet = lyOf('NET_SALES');

  const rows = lineCatalog_(store, prop, lastMonth).map(function (meta) {
    const key = meta.key;
    const dir = direction_(key, meta.section);
    const act = sumOver(function (p) { return amountOf_(store, prop, p, key); });
    const b = budgetOf(key);
    const ly = lyOf(key);
    return {
      key: key, name: meta.name, section: meta.section, kind: meta.kind,
      actual: act, pct: pctOf_(act, net), reportedPct: null, absent: false,
      budget: b, budgetPct: b == null ? null : pctOf_(b, budNet),
      varBudget: b == null ? null : dir * (act - b),
      ly: ly, lyPct: ly == null ? null : pctOf_(ly, lyNet), varLy: ly == null ? null : dir * (act - ly),
      three: null, ytd: null, flag: null, missing: null, tag: null
    };
  });

  const summary = reportSummary_(rows, hasBudget, hasLy);
  const stages = months.map(function (p) { return monthOnFile_(store, prop, p).stage; });
  return {
    property: prop,
    period: period,
    grouping: grouping,
    months: months,
    expectedMonths: groupingMonths_(period, grouping).length,
    stage: worstStage_(stages),
    asOf: last.asOf,
    fraction: fractionOf[lastMonth],
    hasBudget: hasBudget,
    hasLastYear: hasLy,
    lyProrated: hasLy && fractionOf[lastMonth] < 1,
    lyPeriod: lyMonths[lyMonths.length - 1],
    lyMonths: lyMonths,
    threeMonths: null,
    ytdMonths: [],
    headline: summary.headline,
    kpis: summary.kpis,
    rows: rows,
    flags: [],
    missing: [],
    note: ''
  };
}

/** Headline and KPI tiles from finished report rows. */
function reportSummary_(rows, hasBudget, hasLy) {
  const get = function (k) { return rows.filter(function (x) { return x.key === k; })[0] || null; };
  const kpi = function (label, num, den) {
    const ratio = function (src) {
      const n = num.reduce(function (s, k) { const r = get(k); return s + (r && r[src] != null ? r[src] : 0); }, 0);
      const d = den ? (get(den) && get(den)[src]) : null;
      if (den) return d ? n / d * 100 : null;
      return n;
    };
    const has = function (src) { return num.every(function (k) { const r = get(k); return r && r[src] != null; }); };
    return { label: label, actual: ratio('actual'), budget: hasBudget && has('budget') ? ratio('budget') : null,
      ly: hasLy && has('ly') ? ratio('ly') : null, isPct: !!den };
  };
  const oi = get('OPERATING_INCOME');
  return {
    headline: {
      operatingIncome: oi ? oi.actual : null, operatingIncomePct: oi ? oi.pct : null,
      budget: oi ? oi.budget : null, budgetPct: oi ? oi.budgetPct : null,
      ly: oi ? oi.ly : null, lyPct: oi ? oi.lyPct : null, ifMissingPosted: null
    },
    kpis: [
      kpi('Net sales', ['NET_SALES']),
      kpi('Prime cost %', ['TOTAL_5000', 'TOTAL_6000'], 'NET_SALES'),
      kpi('Cost of sales %', ['TOTAL_5000'], 'NET_SALES'),
      kpi('Labor %', ['TOTAL_6000'], 'NET_SALES'),
      kpi('Expenses (7000) %', ['TOTAL_7000'], 'NET_SALES')
    ]
  };
}

/* -------------------------------------------------------------- portfolio */

/** Operating income % for a property over a month, quarter or YTD; null when nothing is on file. */
function groupedOiPct_(store, prop, period, grouping) {
  let net = 0, oi = 0, any = false;
  groupingMonths_(period, grouping).forEach(function (p) {
    if (!monthOnFile_(store, prop, p)) return;
    any = true;
    net += amountOf_(store, prop, p, 'NET_SALES') || 0;
    oi += amountOf_(store, prop, p, 'OPERATING_INCOME') || 0;
  });
  return any && net ? oi / net * 100 : null;
}

/**
 * One row per active property for a month, quarter or year to date, ranked
 * by operating income %. "Prior" is the previous month, the previous quarter,
 * or the same months last year for YTD.
 */
function buildPortfolio_(store, period, grouping) {
  grouping = GROUPINGS.indexOf(grouping) === -1 ? 'month' : grouping;
  const rows = [];
  const total = { net: 0, oi: 0, cos: 0, labor: 0, budOi: 0, budNet: 0, budCount: 0, count: 0 };
  const span = groupingMonths_(period, grouping);
  store.properties.filter(function (p) { return p.active !== false; }).forEach(function (p) {
    if (!span.some(function (m) { return monthOnFile_(store, p.code, m); })) {
      rows.push({ code: p.code, name: p.name, onFile: false });
      return;
    }
    const r = buildGroupedReport_(store, p.code, period, grouping);
    const v = function (k, f) { const x = r.rows.filter(function (y) { return y.key === k; })[0]; return x ? x[f || 'actual'] : null; };
    const net = v('NET_SALES') || 0;
    const row = {
      code: p.code, name: p.name, onFile: true, stage: r.stage, asOf: r.asOf, months: r.months.length,
      net: net, oi: v('OPERATING_INCOME'), oiPct: v('OPERATING_INCOME', 'pct'),
      primePct: net ? ((v('TOTAL_5000') || 0) + (v('TOTAL_6000') || 0)) / net * 100 : null,
      laborPct: v('TOTAL_6000', 'pct'), cosPct: v('TOTAL_5000', 'pct'),
      budgetOi: v('OPERATING_INCOME', 'budget'), varBudgetOi: v('OPERATING_INCOME', 'varBudget'),
      lyOi: v('OPERATING_INCOME', 'ly'), varLyOi: v('OPERATING_INCOME', 'varLy'),
      prevOiPct: groupedOiPct_(store, p.code, priorGroupingPeriod_(period, grouping), grouping),
      flags: r.flags.filter(function (f) { return !f.tagged; }).length,
      missing: r.missing.length,
      ifMissingPosted: r.headline.ifMissingPosted
    };
    rows.push(row);
    total.count++;
    total.net += net; total.oi += row.oi || 0;
    total.cos += v('TOTAL_5000') || 0; total.labor += v('TOTAL_6000') || 0;
    if (row.budgetOi != null) { total.budOi += row.budgetOi; total.budNet += v('NET_SALES', 'budget') || 0; total.budCount++; }
  });
  rows.sort(function (a, b) {
    if (a.onFile !== b.onFile) return a.onFile ? -1 : 1;
    return (b.oiPct == null ? -1e9 : b.oiPct) - (a.oiPct == null ? -1e9 : a.oiPct);
  });
  return {
    period: period,
    grouping: grouping,
    months: span,
    rows: rows,
    totals: {
      properties: total.count,
      net: total.net, oi: total.oi, oiPct: total.net ? total.oi / total.net * 100 : null,
      primePct: total.net ? (total.cos + total.labor) / total.net * 100 : null,
      laborPct: total.net ? total.labor / total.net * 100 : null,
      withBudget: total.budCount, budgetOi: total.budCount ? total.budOi : null
    }
  };
}

/* ----------------------------------------------------------------- trends */

const RATIO_KEYS = {
  OI_PCT: { label: 'Operating income %', num: ['OPERATING_INCOME'] },
  PRIME_PCT: { label: 'Prime cost %', num: ['TOTAL_5000', 'TOTAL_6000'] },
  LABOR_PCT: { label: 'Labor %', num: ['TOTAL_6000'] },
  COS_PCT: { label: 'Cost of sales %', num: ['TOTAL_5000'] },
  EXP_PCT: { label: 'Expenses (7000) %', num: ['TOTAL_7000'] }
};

/** Value of a line or ratio for one property-month (actual or budget). */
function seriesValue_(store, prop, period, key, source) {
  const get = function (k) {
    if (source === 'budget') { const b = budgetMonth_(store, prop, period); return b && k in b ? b[k] : null; }
    return amountOf_(store, prop, period, k);
  };
  const ratio = RATIO_KEYS[key];
  if (!ratio) return get(key);
  const net = get('NET_SALES');
  if (!net) return null;
  let s = 0;
  for (let i = 0; i < ratio.num.length; i++) { const v = get(ratio.num[i]); if (v == null) return null; s += v; }
  return s / net * 100;
}

/**
 * Monthly series for one property (or 'ALL' properties added together) and
 * one line or ratio, for the `months` months ending at `endPeriod`.
 */
function buildTrend_(store, prop, key, endPeriod, months) {
  const props = prop === 'ALL'
    ? store.properties.filter(function (p) { return p.active !== false; }).map(function (p) { return p.code; })
    : [prop];
  const ratio = RATIO_KEYS[key];
  const points = [];
  for (let i = months - 1; i >= 0; i--) {
    const period = periodAdd_(endPeriod, -i);
    const point = { period: period, actual: null, budget: null, stage: null, properties: 0 };
    if (props.length === 1) {
      const m = monthOnFile_(store, props[0], period);
      if (m) { point.actual = seriesValue_(store, props[0], period, key, 'actual'); point.stage = m.stage; point.properties = 1; }
      point.budget = seriesValue_(store, props[0], period, key, 'budget');
    } else {
      // Add amounts across properties, then take ratios of the sums.
      // Budget is only shown when every property reporting that month has one,
      // so a partial budget never sits against a full-portfolio actual.
      const reporting = props.filter(function (pc) { return monthOnFile_(store, pc, period); });
      const sum = function (k, source) {
        let s = 0, n = 0;
        if (source === 'budget') {
          if (!reporting.length) return null;
          for (let j = 0; j < reporting.length; j++) {
            const b = budgetMonth_(store, reporting[j], period);
            if (!b) return null;
            s += b[k] || 0; n++;
          }
          return { s: s, n: n };
        }
        reporting.forEach(function (pc) {
          const v = amountOf_(store, pc, period, k);
          if (v != null) { s += v; n++; }
        });
        return n ? { s: s, n: n } : null;
      };
      const val = function (source) {
        if (!ratio) { const x = sum(key, source); return x ? x : null; }
        const n = sum('NET_SALES', source);
        if (!n || !n.s) return null;
        let s = 0;
        for (let j = 0; j < ratio.num.length; j++) { const x = sum(ratio.num[j], source); s += x ? x.s : 0; }
        return { s: s / n.s * 100, n: n.n };
      };
      const a = val('actual'), b = val('budget');
      if (a) { point.actual = a.s; point.properties = a.n; }
      if (b) point.budget = b.s;
      const stages = props.map(function (pc) { const m = monthOnFile_(store, pc, period); return m ? m.stage : null; }).filter(Boolean);
      point.stage = stages.indexOf('mtd') !== -1 ? 'mtd' : (stages.indexOf('preliminary') !== -1 ? 'preliminary' : (stages.length ? 'settled' : null));
    }
    const lyPoint = periodAdd_(period, -12);
    point.ly = props.length === 1 ? (monthOnFile_(store, props[0], lyPoint) ? seriesValue_(store, props[0], lyPoint, key, 'actual') : null) : null;
    points.push(point);
  }
  return { property: prop, key: key, label: ratio ? ratio.label : (SUBTOTAL_NAMES[key] || key), isPct: !!ratio, points: points };
}
