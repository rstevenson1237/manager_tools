/*******************************************************************************
 * Review.gs — the budget review: a property's budget for a year against what
 * the property actually did, and against how its last budget turned out.
 * Plain JavaScript with no Apps Script services, so the Node harness runs it.
 *
 * STATUS
 *   A budget is a draft until 1 January of its year, then approved. A new
 *   version can be uploaded at any time; it replaces the one on file.
 *
 * LAST YEAR ("PY")
 *   R365 actuals for the 12 calendar months, taking each month from the year
 *   before the budget year, or two years before when that month is not on
 *   file yet (a 2027 budget reviewed in November uses Nov–Dec 2025 and
 *   Jan–Oct 2026). Month-to-date uploads are never used. Budget and PY are
 *   compared over the same calendar months, so a missing month never skews a
 *   comparison. The workbook's own forecast column is only checked, not used.
 *
 * LAST BUDGET'S TRACK RECORD
 *   The previous year's budget against that year's actuals, for the months on
 *   file — and, for sales, the growth that budget assumed against the growth
 *   that came in.
 *
 * WHERE THE BUDGET PUSHES (intentional, but worth a conversation)
 *   Sales growth, and every cost category budgeted at a better % of sales than
 *   PY by at least pushPts and minImpact. Each says what last year's budget
 *   asked of the same line and whether it was achieved.
 *   The opposite — a cost budgeted at a worse % than PY — is listed as room in
 *   the budget.
 *
 * LOOKS BUDGETED INCORRECTLY (likely mistakes)
 *   recurring lines or sub-accounts budgeted at zero — unless the latest
 *   months ran at about the budgeted level too, which means the spend stopped
 *   or moved during last year (listed as a check, naming the sub-accounts that
 *   stopped, not as an error); sub-accounts several
 *   times last year or new; fixed costs (occupancy, insurance) below last
 *   year; lines set as a rate (management fee, payroll taxes, card fees) off
 *   their usual rate; months left blank; one month's cost % out of pattern;
 *   sales spread across the year unlike last year; negative costs; the
 *   template's own totals not adding up; its forecast column not matching R365.
 ******************************************************************************/

const REVIEW_RULES = {
  minImpact: 5000,   // smallest dollar effect worth listing
  pushPts: 0.5,      // % of sales change that counts as a push (or room)
  zeroShare: 0.1,    // budget below this share of PY counts as "about zero"
  glMin: 5000,       // sub-account differences smaller than this are ignored
  seasonPts: 1.5,    // a month's share of annual sales moving this many points
  monthPts: 3,       // a month's cost % this far from its PY month, beyond the annual change
  fixedDrop: 0.05,   // fixed costs budgeted this share below PY
  rateDrift: 0.15,   // rate-set lines this share away from their PY rate
  recentMonths: 6    // latest months of PY that show the current run rate
};

/** Cost sections whose lines can be pushed or mis-budgeted. */
const REVIEW_COST_SECTIONS = ['5000', '6000', '7000', '8000'];
/** Lines that pay wages; payroll taxes and benefits (6275) run as a share of these. */
const WAGE_LINES = ['6110', '6201', '6209', '6252', '6266', '6272'];
const FIXED_GL = { '7526': 'Insurance' };
/** Lines set by contract or formula, not by the operator: checked as rates, never counted as a push. */
const RATE_SET_LINES = { '9100': true };

function pad2Review_(n) { return n < 10 ? '0' + n : String(n); }

/** Draft until 1 January of the budget year, then approved. */
function budgetStatus_(year, today) {
  return String(today || '') >= year + '-01-01' ? 'approved' : 'draft';
}

/**
 * The month each calendar month of the budget year is compared with: the
 * same month a year earlier, or two years earlier when that is not on file.
 */
function reviewBasis_(store, prop, year) {
  const out = [];
  for (let m = 1; m <= 12; m++) {
    let pick = null;
    [year - 1, year - 2].some(function (y) {
      const p = y + '-' + pad2Review_(m);
      const mo = monthOnFile_(store, prop, p);
      if (mo && mo.stage !== 'mtd') { pick = p; return true; }
      return false;
    });
    out.push(pick);
  }
  return out;
}

/**
 * Everything the Budget review tab shows for one property and budget year.
 * @param {string} today 'YYYY-MM-DD', decides draft or approved
 */
function buildBudgetReview_(store, prop, year, today) {
  year = Number(year);
  const by = budgetYear_(store, prop, year + '-01');
  if (!by) throw new Error('No ' + year + ' budget on file for ' + prop + '.');
  const R = REVIEW_RULES;
  const rules = Object.assign({}, DEFAULT_RULES, store.rules || {});

  const basis = reviewBasis_(store, prop, year);
  const covered = [];
  basis.forEach(function (p, i) { if (p) covered.push(i); });

  const budCache = {};
  const budMonth = function (y, mi) {
    const k = y + '-' + pad2Review_(mi + 1);
    if (!(k in budCache)) budCache[k] = budgetMonth_(store, prop, k);
    return budCache[k];
  };
  const bud = function (mi, key) { const b = budMonth(year, mi); return b && key in b ? b[key] : 0; };
  const py = function (mi, key) { return basis[mi] ? amountOf_(store, prop, basis[mi], key) : null; };
  const sum = function (idx, fn) { return idx.reduce(function (s, i) { return s + (fn(i) || 0); }, 0); };
  const all12 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

  const budNetAll = sum(all12, function (i) { return bud(i, 'NET_SALES'); });
  const budNet = sum(covered, function (i) { return bud(i, 'NET_SALES'); });
  const pyNet = sum(covered, function (i) { return py(i, 'NET_SALES'); });

  /* ----- last year's budget against last year's actuals (its track record) */
  const prevYear = year - 1;
  const hasPrevBudget = !!budgetYear_(store, prop, prevYear + '-01');
  const trackIdx = [];
  if (hasPrevBudget) {
    for (let i = 0; i < 12; i++) {
      const m = monthOnFile_(store, prop, prevYear + '-' + pad2Review_(i + 1));
      if (m && m.stage !== 'mtd') trackIdx.push(i);
    }
  }
  const prevPeriod = function (i) { return prevYear + '-' + pad2Review_(i + 1); };
  const twoBack = function (i) { return (prevYear - 1) + '-' + pad2Review_(i + 1); };
  const trackNet = { bud: sum(trackIdx, function (i) { const b = budMonth(prevYear, i); return b ? b.NET_SALES : 0; }),
    act: sum(trackIdx, function (i) { return amountOf_(store, prop, prevPeriod(i), 'NET_SALES'); }) };
  const growthIdx = trackIdx.filter(function (i) { return monthOnFile_(store, prop, twoBack(i)); });
  const track = function (key, dir) {
    if (!trackIdx.length) return null;
    const b = sum(trackIdx, function (i) { const x = budMonth(prevYear, i); return x && key in x ? x[key] : 0; });
    const a = sum(trackIdx, function (i) { return amountOf_(store, prop, prevPeriod(i), key); });
    return { budget: b, actual: a, variance: dir * (a - b), budgetPct: pctOf_(b, trackNet.bud), actualPct: pctOf_(a, trackNet.act),
      months: trackIdx.length };
  };

  /* ----- line rows */
  const catalog = lineCatalog_(store, prop, year + '-01');
  const rows = catalog.map(function (meta) {
    const key = meta.key, dir = direction_(key, meta.section);
    const months = all12.map(function (i) { return bud(i, key); });
    const b = sum(covered, function (i) { return months[i]; });
    const p = covered.length ? sum(covered, function (i) { return py(i, key); }) : null;
    const budgetPct = pctOf_(b, budNet), pyPct = p == null ? null : pctOf_(p, pyNet);
    const row = {
      key: key, name: meta.name, section: meta.section, kind: meta.kind,
      budget: months.reduce(function (s, v) { return s + v; }, 0), months: months,
      budgetPct: pctOf_(months.reduce(function (s, v) { return s + v; }, 0), budNetAll),
      compBudget: b, py: p, pyPct: pyPct,
      change: p == null ? null : b - p, changePct: p ? (b - p) / Math.abs(p) * 100 : null,
      better: p == null ? null : dir * (b - p),
      pts: budgetPct == null || pyPct == null ? null : budgetPct - pyPct,
      track: track(key, dir), mark: null, issues: 0
    };
    // Dollars the budget gains (or gives up) by running this cost at a different % of sales than PY.
    row.rateImpact = row.pts == null || dir > 0 ? null : -row.pts / 100 * budNet;
    return row;
  });
  const row = function (k) { return rows.filter(function (r) { return r.key === k; })[0] || null; };

  /* ----- where the budget pushes */
  const pushes = [];
  const cushions = [];
  const netRow = row('NET_SALES');
  if (netRow && pyNet) {
    const growth = (budNet - pyNet) / Math.abs(pyNet) * 100;
    const byMonth = covered.map(function (i) { return { i: i, d: bud(i, 'NET_SALES') - (py(i, 'NET_SALES') || 0) }; })
      .sort(function (a, b) { return Math.abs(b.d) - Math.abs(a.d); }).slice(0, 3)
      .filter(function (x) { return Math.abs(x.d) >= R.minImpact; });
    const item = { kind: 'sales', key: 'NET_SALES', name: 'Net sales', impact: budNet - pyNet, growthPct: growth,
      months: byMonth.map(function (x) { return { month: year + '-' + pad2Review_(x.i + 1), change: x.d }; }), track: null };
    if (growthIdx.length) {
      const prevBud = sum(growthIdx, function (i) { const x = budMonth(prevYear, i); return x ? x.NET_SALES : 0; });
      const prevAct = sum(growthIdx, function (i) { return amountOf_(store, prop, prevPeriod(i), 'NET_SALES'); });
      const base = sum(growthIdx, function (i) { return amountOf_(store, prop, twoBack(i), 'NET_SALES'); });
      if (base) item.track = { months: growthIdx.length, assumedPct: (prevBud - base) / Math.abs(base) * 100,
        deliveredPct: (prevAct - base) / Math.abs(base) * 100, missedBy: prevBud - prevAct };
    }
    if (growth >= 1) pushes.push(item);
    else if (growth <= -1) cushions.push(item);
  }
  rows.forEach(function (r) {
    if (!isReviewCost_(r) || r.rateImpact == null || r.section === '8000' || RATE_SET_LINES[r.key]) return;
    if (Math.abs(r.pts) < R.pushPts || Math.abs(r.rateImpact) < R.minImpact) return;
    const item = { kind: 'cost', key: r.key, name: r.name, impact: r.rateImpact, budgetPct: pctOf_(r.compBudget, budNet),
      pyPct: r.pyPct, pts: r.pts, track: null, repeat: false };
    if (r.track && r.track.budgetPct != null && r.track.actualPct != null) {
      item.track = { budgetPct: r.track.budgetPct, actualPct: r.track.actualPct, variance: r.track.variance, months: r.track.months };
      item.repeat = r.track.variance <= -R.minImpact;   // last year's budget for this line was missed
    }
    if (r.rateImpact > 0) { r.mark = 'push'; pushes.push(item); }
    else { r.mark = 'room'; cushions.push(item); }
  });

  /* ----- looks budgeted incorrectly */
  const issues = [];
  const add = function (severity, key, name, title, detail, impact) {
    issues.push({ severity: severity, key: key || null, name: name || '', title: title, detail: detail || '', impact: impact || 0 });
    const r = key && row(key); if (r) r.issues++;
  };
  const coveredLabel = covered.length + ' month' + (covered.length === 1 ? '' : 's');

  // Last year's months stored under this property but copied from another.
  const copies = copiedMonths_(store, prop, basis.filter(Boolean));
  if (copies.length) {
    const others = copies.map(function (c) { return c.other; }).filter(function (o, i, a) { return a.indexOf(o) === i; });
    add('error', null, '', 'Last year\'s actuals are a copy of ' + others.join(', ') + ' for ' + copies.length + ' month' + (copies.length === 1 ? '' : 's'),
      copies.map(function (c) { return periodLabel_(c.period); }).join(', ') + ' match ' + others.join(', ') +
      ' to the dollar on every line, so they were most likely uploaded under the wrong location. Re-upload this property\'s R365 P&L for those months; until then every comparison with last year is off.', 0);
  }

  ((by.meta && by.meta.checks) || []).forEach(function (c) {
    if (!c.ok) add('check', null, '', 'Workbook check failed: ' + c.label, c.detail, 0);
  });

  const zeroKeys = {}, newKeys = {}, droppedKeys = {};
  rows.forEach(function (r) {
    if (!isReviewCost_(r) || r.py == null) return;
    const posted = covered.filter(function (i) { return py(i, r.key); }).length;
    // A line budgeted that never posted last year.
    if (Math.abs(r.py) < R.minImpact / 5 && r.compBudget >= R.minImpact) {
      newKeys[r.key] = true;
      add('check', r.key, r.name, 'Budgeted, but nothing posted last year',
        money_(r.compBudget) + ' budgeted; last year ' + money_(r.py) + '. Confirm it is new spend and not posted under another line in R365.', r.compBudget);
      return;
    }
    // Recurring line budgeted at about zero.
    if (r.py >= R.minImpact && posted >= Math.ceil(covered.length * 0.75) && r.compBudget <= R.zeroShare * r.py) {
      // Not a mistake when the spend already stopped during last year.
      const recent = recentRun_(basis, covered, function (i) { return py(i, r.key); });
      if (recent && (recent.annual - r.compBudget < R.minImpact || r.compBudget >= R.zeroShare * recent.annual)) {
        droppedKeys[r.key] = true;
        const stopped = stoppedSubAccounts_(store, prop, r.key, basis, covered, recent);
        add('check', r.key, r.name, 'Budget follows a lower recent run rate',
          'Last year ' + money_(r.py) + ', but ' + money_(recent.amount) + ' in the latest ' + recent.months.length + ' months (' +
          recent.label + '), which the budget follows.' +
          (stopped.length ? ' Stopped posting: ' + stopped.join(', ') + '.' : '') +
          ' Confirm the cost ended or moved to another line and is not just missing in R365.', 0);
        return;
      }
      zeroKeys[r.key] = true;
      add('error', r.key, r.name, 'Budgeted at ' + (r.compBudget ? 'almost nothing' : 'zero'),
        'Last year ' + money_(r.py) + ', posted in ' + posted + ' of ' + covered.length + ' months.', r.py - r.compBudget);
      return;
    }
    // Negative cost.
    if (r.months.some(function (v) { return v < -1; })) {
      add('error', r.key, r.name, 'Negative cost budgeted', 'A cost line should not be below zero (' +
        monthsWhere_(year, r.months, function (v) { return v < -1; }) + ').', 0);
    }
    // Fixed costs below last year.
    if (r.section === '8000' && r.compBudget < r.py * (1 - R.fixedDrop) && r.py - r.compBudget >= R.minImpact) {
      add('check', r.key, r.name, 'Fixed cost below last year',
        money_(r.compBudget) + ' against ' + money_(r.py) + ' last year (' + pct_(r.changePct) + '). Rent, property taxes and occupancy rarely fall.',
        r.py - r.compBudget);
    }
    // Months left blank that had spend last year.
    const active = r.months.filter(function (v) { return v; }).length;
    if (active >= 6 && active < 12) {
      const gaps = covered.filter(function (i) { return !r.months[i] && (py(i, r.key) || 0) >= rules.driverMin; });
      if (gaps.length) {
        const lost = sum(gaps, function (i) { return py(i, r.key); });
        if (lost >= R.minImpact / 2) add('check', r.key, r.name, 'Nothing budgeted in ' + gaps.map(function (i) { return MONTH_ABBR_[i]; }).join(', '),
          'The other ' + active + ' months are budgeted; last year these months had ' + money_(lost) + '.', lost);
      }
    }
  });

  // Lines set as a rate of something else.
  const rateCheck = function (key, label, baseKeys, baseLabel, severity, why) {
    const r = row(key); if (!r || r.py == null || !r.py) return;
    const bBase = sum(covered, function (i) { return baseKeys.reduce(function (s, k) { return s + bud(i, k); }, 0); });
    const pBase = sum(covered, function (i) { return baseKeys.reduce(function (s, k) { return s + (py(i, k) || 0); }, 0); });
    if (!bBase || !pBase || zeroKeys[key]) return;
    const bRate = r.compBudget / bBase * 100, pRate = r.py / pBase * 100;
    const impact = (bRate - pRate) / 100 * bBase;
    if (Math.abs(bRate - pRate) / Math.abs(pRate) >= R.rateDrift && Math.abs(impact) >= R.minImpact) {
      add(severity, key, r.name, label + ' is ' + pct_(bRate) + ' of ' + baseLabel + '; last year ' + pct_(pRate),
        why + ' At last year\'s rate it would be ' + money_(pRate / 100 * bBase) + ', ' + money_(Math.abs(impact)) +
        (impact < 0 ? ' more' : ' less') + ' than budgeted.', Math.abs(impact));
    }
  };
  rateCheck('9100', 'Management fee', ['NET_SALES'], 'net sales', 'error', 'The fee is normally a fixed share of sales set by the management agreement.');
  rateCheck('6275', 'Payroll taxes & benefits', WAGE_LINES, 'wages', 'check', 'Payroll taxes and benefits move with wages.');

  // One month's cost % out of pattern with the same month last year.
  ['TOTAL_5000', 'TOTAL_6000'].forEach(function (key) {
    const r = row(key); if (!r || r.pts == null) return;
    const odd = covered.filter(function (i) {
      const bn = bud(i, 'NET_SALES'), pn = py(i, 'NET_SALES');
      if (!bn || !pn) return false;
      const dev = bud(i, key) / bn * 100 - (py(i, key) || 0) / pn * 100;
      return Math.abs(dev - r.pts) >= R.monthPts;
    });
    if (odd.length && odd.length <= 4) {
      add('check', key, r.name, r.name + ' % out of pattern in ' + odd.map(function (i) { return MONTH_ABBR_[i]; }).join(', '),
        odd.map(function (i) {
          return MONTH_ABBR_[i] + ' ' + pct_(bud(i, key) / bud(i, 'NET_SALES') * 100) + ' vs ' + pct_(py(i, key) / py(i, 'NET_SALES') * 100) + ' last year';
        }).join(' · ') + '. The year as a whole moves ' + pts_(r.pts) + '.', 0);
    }
  });

  // Sales spread across the year.
  if (covered.length === 12 && budNet && pyNet) {
    const moved = all12.map(function (i) {
      return { i: i, b: bud(i, 'NET_SALES') / budNet * 100, p: py(i, 'NET_SALES') / pyNet * 100 };
    }).filter(function (x) { return Math.abs(x.b - x.p) >= R.seasonPts; });
    if (moved.length) {
      add('check', 'NET_SALES', 'Net sales', 'Sales spread across the year differs from last year',
        moved.map(function (x) { return MONTH_ABBR_[x.i] + ' ' + pct_(x.b) + ' of the year (last year ' + pct_(x.p) + ')'; }).join(' · ') +
        '. Check events, holidays and any closures in those months.',
        moved.reduce(function (s, x) { return s + Math.max(0, x.b - x.p) / 100 * budNet; }, 0));
    }
  }

  glReviewIssues_(store, prop, year, by, basis, covered, Object.assign({}, zeroKeys, droppedKeys)).forEach(function (x) { add(x.severity, x.key, x.name, x.title, x.detail, x.impact); });
  const fc = forecastIssue_(store, prop, year, by, basis, covered, py, sum);
  if (fc) add('check', null, '', fc.title, fc.detail, 0);

  // A line that is really a mistake (budgeted at zero, new), or whose spend
  // stopped during last year, is not also a push.
  const notMistake = function (x) { return !zeroKeys[x.key] && !newKeys[x.key] && !droppedKeys[x.key]; };
  const pushList = pushes.filter(notMistake).sort(function (a, b) { return (a.kind === 'sales' ? -1 : 0) - (b.kind === 'sales' ? -1 : 0) || b.impact - a.impact; });
  const roomList = cushions.filter(notMistake).sort(function (a, b) { return a.impact - b.impact; });
  rows.forEach(function (r) { if (zeroKeys[r.key] || newKeys[r.key] || droppedKeys[r.key]) r.mark = null; });

  const sevRank = { error: 0, check: 1 };
  issues.sort(function (a, b) { return sevRank[a.severity] - sevRank[b.severity] || b.impact - a.impact; });

  /* ----- month by month */
  const monthly = all12.map(function (i) {
    const bn = bud(i, 'NET_SALES'), pn = py(i, 'NET_SALES');
    const ratio = function (v, n) { return n ? v / n * 100 : null; };
    return {
      month: year + '-' + pad2Review_(i + 1), basis: basis[i],
      budNet: bn, pyNet: pn, growthPct: pn ? (bn - pn) / Math.abs(pn) * 100 : null,
      budOi: bud(i, 'OPERATING_INCOME'), pyOi: py(i, 'OPERATING_INCOME'),
      budOiPct: ratio(bud(i, 'OPERATING_INCOME'), bn), pyOiPct: pn ? ratio(py(i, 'OPERATING_INCOME'), pn) : null,
      budPrimePct: ratio(bud(i, 'TOTAL_5000') + bud(i, 'TOTAL_6000'), bn),
      pyPrimePct: pn ? ratio((py(i, 'TOTAL_5000') || 0) + (py(i, 'TOTAL_6000') || 0), pn) : null,
      budLaborPct: ratio(bud(i, 'TOTAL_6000'), bn), pyLaborPct: pn ? ratio(py(i, 'TOTAL_6000'), pn) : null
    };
  });

  const oi = row('OPERATING_INCOME');
  const basisPeriods = basis.filter(Boolean).sort();
  return {
    property: prop,
    year: year,
    status: budgetStatus_(year, today),
    approvedFrom: year + '-01-01',
    rules: { pushPts: R.pushPts, minImpact: R.minImpact },
    upload: by.meta || null,
    basis: { months: basis, covered: covered.length, first: basisPeriods[0] || null, last: basisPeriods[basisPeriods.length - 1] || null,
      label: coveredLabel },
    track: trackIdx.length ? { year: prevYear, months: trackIdx.length, first: prevPeriod(trackIdx[0]), last: prevPeriod(trackIdx[trackIdx.length - 1]) } : null,
    headline: {
      budNet: budNetAll, budOi: oi ? oi.budget : null, budOiPct: oi ? oi.budgetPct : null,
      compNet: budNet, compOi: oi ? oi.compBudget : null, compOiPct: oi ? pctOf_(oi.compBudget, budNet) : null,
      pyNet: covered.length ? pyNet : null, pyOi: oi ? oi.py : null, pyOiPct: oi ? oi.pyPct : null,
      growthPct: pyNet ? (budNet - pyNet) / Math.abs(pyNet) * 100 : null,
      trackNet: trackIdx.length ? trackNet : null, trackOi: oi ? oi.track : null
    },
    kpis: ['TOTAL_5000', 'TOTAL_6000', 'TOTAL_7000'].map(function (k) {
      const r = row(k);
      return { key: k, label: { TOTAL_5000: 'Cost of sales %', TOTAL_6000: 'Labor %', TOTAL_7000: 'Expenses (7000) %' }[k],
        budget: r ? pctOf_(r.compBudget, budNet) : null, py: r ? r.pyPct : null,
        prevBudget: r && r.track ? r.track.budgetPct : null, prevActual: r && r.track ? r.track.actualPct : null };
    }).concat([(function () {
      const a = row('TOTAL_5000'), b = row('TOTAL_6000');
      const bp = a && b ? pctOf_(a.compBudget + b.compBudget, budNet) : null;
      const pp = a && b && a.py != null ? pctOf_(a.py + b.py, pyNet) : null;
      return { key: 'PRIME', label: 'Prime cost %', budget: bp, py: pp,
        prevBudget: a && b && a.track ? a.track.budgetPct + b.track.budgetPct : null,
        prevActual: a && b && a.track ? a.track.actualPct + b.track.actualPct : null };
    })()]),
    rows: rows,
    pushes: pushList,
    room: roomList,
    issues: issues,
    monthly: monthly
  };
}

/**
 * Last year's latest months (by period, not calendar month), which show what
 * a line runs at now. Null when too few months are on file to tell.
 * @param {function(number): number} amount PY amount for a calendar month index
 */
function recentRun_(basis, idx, amount) {
  const n = REVIEW_RULES.recentMonths;
  if (idx.length < 2 * n) return null;
  const months = idx.slice().sort(function (a, b) { return basis[a] < basis[b] ? 1 : -1; }).slice(0, n);
  const total = months.reduce(function (s, i) { return s + (amount(i) || 0); }, 0);
  const periods = months.map(function (i) { return basis[i]; }).sort();
  return { months: months, amount: total, annual: total / n * idx.length,
    label: periodLabel_(periods[0]) + '–' + periodLabel_(periods[periods.length - 1]) };
}

/** Sub-accounts of a category that posted earlier in PY but not in its latest months, largest first. */
function stoppedSubAccounts_(store, prop, category, basis, covered, recent) {
  const det = store.detail[prop] || {};
  const inRecent = {};
  recent.months.forEach(function (i) { inRecent[i] = true; });
  const earlier = {}, later = {};
  covered.forEach(function (i) {
    (det[basis[i]] || []).forEach(function (d) {
      if (String(d.category) !== String(category) || !d.amount) return;
      const t = inRecent[i] ? later : earlier;
      t[d.code] = t[d.code] || { label: d.code + ' ' + d.name, amount: 0 };
      t[d.code].amount += d.amount;
    });
  });
  return Object.keys(earlier).filter(function (c) { return !later[c] && earlier[c].amount >= REVIEW_RULES.minImpact / 5; })
    .sort(function (a, b) { return earlier[b].amount - earlier[a].amount; })
    .map(function (c) { return earlier[c].label; });
}

function periodLabel_(period) {
  return MONTH_ABBR_[Number(period.slice(5, 7)) - 1] + ' ' + period.slice(2, 4);
}

function isReviewCost_(r) {
  return (r.kind === 'line' || r.kind === 'group') && REVIEW_COST_SECTIONS.indexOf(r.section) !== -1;
}

/**
 * Sub-account checks, from detailed uploads: budgeted at zero though it ran
 * last year, new spend, several times (or a fraction of) last year, and
 * insurance below last year. Compared over the months that have detail.
 */
function glReviewIssues_(store, prop, year, by, basis, covered, zeroKeys) {
  const R = REVIEW_RULES;
  const det = store.detail[prop] || {};
  const idx = covered.filter(function (i) { return det[basis[i]]; });
  if (idx.length < 6) return [];
  const categories = {};
  Object.keys(BUDGET_LINE_SECTION).forEach(function (k) { categories[k] = true; });
  ['4000', '5000', '6000', '7000', '8000', '9000'].forEach(function (k) { categories[k] = true; });

  const pyGl = {};
  idx.forEach(function (i) {
    det[basis[i]].forEach(function (d) {
      const sec = BUDGET_LINE_SECTION[d.category] || (String(d.category).charAt(0) + '000');
      if (REVIEW_COST_SECTIONS.indexOf(sec) === -1 || categories[d.code] || zeroKeys[d.category]) return;
      const e = pyGl[d.code] = pyGl[d.code] || { code: d.code, name: d.name, category: d.category, amount: 0, months: {} };
      e.amount += d.amount; e.months[i] = (e.months[i] || 0) + d.amount;
    });
  });
  // Only categories the budget breaks into sub-accounts (food cost, for one, is a single row).
  const split = {};
  Object.keys(pyGl).forEach(function (code) { if (by.gl[code]) split[pyGl[code].category] = true; });
  Object.keys(pyGl).forEach(function (code) { if (!split[pyGl[code].category]) delete pyGl[code]; });
  const budGl = function (code) {
    const g = by.gl[code]; if (!g) return 0;
    return idx.reduce(function (s, i) { return s + (g.months[i] || 0); }, 0);
  };
  const out = [];
  const where = idx.length + ' months with detail';
  Object.keys(pyGl).forEach(function (code) {
    const e = pyGl[code], p = e.amount, b = budGl(code);
    const name = code + ' ' + e.name;
    const posted = Object.keys(e.months).length;
    const recent = recentRun_(basis, idx, function (i) { return e.months[i] || 0; });
    const stopped = recent && (recent.annual - b < R.glMin || b >= R.zeroShare * recent.annual);
    if (p >= R.glMin && b <= R.zeroShare * p && posted >= Math.ceil(idx.length / 2) && stopped) {
      out.push({ severity: 'check', key: e.category, name: name, title: name + ' follows a lower recent run rate',
        detail: 'Last year ' + money_(p) + ' over ' + where + ', but ' + money_(recent.amount) + ' in the latest ' + recent.months.length +
          ' (' + recent.label + '), which the budget follows. Confirm it ended or moved to another account.', impact: 0 });
    } else if (p >= R.glMin && b <= R.zeroShare * p && posted >= Math.ceil(idx.length / 2)) {
      out.push({ severity: 'error', key: e.category, name: name, title: name + ' budgeted at ' + (b ? 'almost nothing' : 'zero') + (by.gl[code] ? '' : ' (no budget line)'),
        detail: 'Last year ' + money_(p) + ' over ' + where + ', posted in ' + posted + ' of them.', impact: p - b });
    } else if (FIXED_GL[code] && p - b >= R.minImpact && b < p * (1 - R.fixedDrop)) {
      out.push({ severity: 'check', key: e.category, name: name, title: name + ' below last year',
        detail: money_(b) + ' against ' + money_(p) + ' last year. ' + FIXED_GL[code] + ' rarely falls.', impact: p - b });
    } else if (b > 0 && p > 0 && Math.abs(b - p) >= 2 * R.glMin && (b / p >= 2.5 || b / p <= 0.4)) {
      out.push({ severity: 'check', key: e.category, name: name, title: name + ' is ' + (b / p).toFixed(1) + '× last year',
        detail: money_(b) + ' budgeted against ' + money_(p) + ' last year (' + where + ').', impact: Math.abs(b - p) });
    }
  });
  // New spend: a budgeted sub-account with nothing last year, only where last
  // year's detail has neighbouring accounts (same first two digits), so a
  // range R365 never breaks down is not mistaken for new spend.
  const prefixes = {};
  Object.keys(pyGl).forEach(function (code) { prefixes[code.slice(0, 2)] = true; });
  Object.keys(by.gl).forEach(function (code) {
    if (pyGl[code] || categories[code] || !prefixes[code.slice(0, 2)] || '5678'.indexOf(code.charAt(0)) === -1) return;
    const b = budGl(code);
    if (b >= 2 * R.glMin) {
      out.push({ severity: 'check', key: null, name: code + ' ' + by.gl[code].name, title: code + ' ' + by.gl[code].name + ' is new spend',
        detail: money_(b) + ' budgeted; nothing posted last year (' + where + ').', impact: b });
    }
  });
  return out.sort(function (a, b) { return b.impact - a.impact; }).slice(0, 12);
}

/**
 * The template's forecast column (actuals to date plus the rest of the year)
 * against R365. Goals typed in from a wrong forecast are themselves off.
 */
function forecastIssue_(store, prop, year, by, basis, covered, py, sum) {
  const f = by.forecast;
  if (!f || f.year !== year - 1 || covered.length < 9) return null;
  const R = REVIEW_RULES;
  const bad = [];
  Object.keys(f.lines).concat(['NET_SALES']).forEach(function (key, n, all) {
    if (all.indexOf(key) !== n || f.lines[key] == null) return;
    const actual = sum(covered, function (i) { return py(i, key); });
    const fv = f.lines[key];
    const gap = fv - actual;
    if (Math.abs(gap) < Math.max(R.minImpact * 2, 0.1 * Math.abs(actual))) return;
    let note = '';
    if (Math.abs(fv) < 2 && Math.abs(actual) > 1000) note = ' — looks like a percentage, not dollars';
    else if (fv * actual < 0) note = ' — sign is reversed';
    const name = key === 'NET_SALES' ? 'Net sales' : key + ' ' + ((BUDGET_LINE_MAP.filter(function (s) { return s.key === key; })[0] || {}).labels || [key])[0];
    bad.push({ text: name + ': ' + (Math.abs(fv) < 2 ? String(fv) : money_(fv)) + ' vs ' + money_(actual) + ' in R365' + note, gap: Math.abs(gap) });
  });
  if (!bad.length) return null;
  bad.sort(function (a, b) { return b.gap - a.gap; });
  return {
    title: 'The workbook\'s ' + f.year + ' forecast does not match R365 on ' + bad.length + ' line' + (bad.length === 1 ? '' : 's'),
    detail: bad.slice(0, 8).map(function (b) { return b.text; }).join(' · ') + (bad.length > 8 ? ' · …' : '') +
      '. Goals built on this forecast may be off; this review compares with R365.'
  };
}

const MONTH_ABBR_ = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function money_(v) { const n = Math.round(v || 0); return (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString('en-US'); }
function pct_(v) { return v == null || !isFinite(v) ? '—' : v.toFixed(1) + '%'; }
function pts_(v) { return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1) + ' pts'; }
function monthsWhere_(year, months, test) {
  return months.map(function (v, i) { return test(v) ? MONTH_ABBR_[i] : null; }).filter(Boolean).join(', ');
}
