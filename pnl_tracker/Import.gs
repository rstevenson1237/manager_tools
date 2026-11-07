/*******************************************************************************
 * Import.gs — uploads, driven from the web app. Every upload is two calls:
 *   preview… reads the file and reports what it holds and what it would
 *            change, without writing anything;
 *   commit…  reads it again and writes it.
 * A file that fails a check is never written, so a bad export cannot damage
 * what is already stored.
 *
 * P&L CSV (monthly side-by-side or trailing 12): each month × property in the
 * file replaces that month × property in Actuals and Detail. The stage of
 * each month (month to date / preliminary / settled) comes from the "data
 * through" date the manager confirms in the preview.
 *
 * Budget (.xlsx upload or Google Sheet ID): replaces that property's budget
 * for the year. Who uploaded it, when, and the template's own checks are kept
 * with it for the Budget review. A budget for a year that has not started is
 * a draft; it counts as approved from 1 January. A new version can be
 * uploaded at any time. An .xlsx is converted once during preview; the parsed result
 * is held in the script cache for 30 minutes so saving does not convert it
 * again.
 ******************************************************************************/

/** Admin. What a P&L CSV holds and what saving it would change. */
function previewPnlUpload(csvText, fileName, asOf) {
  const ss = dataSpreadsheet_();
  requireAdmin_(ss);
  asOf = checkAsOf_(asOf);
  const parsed = parsePnlRows_(Utilities.parseCsv(String(csvText || '')));
  const config = readConfig_(ss);
  const built = parsedToRows_(parsed, asOf, 'preview', config.rules.settleDays);

  const store = loadStore_(ss);
  const known = {};
  store.properties.forEach(function (p) { known[p.code] = p; });

  // Months already on file that this upload replaces, with what would change.
  const replaces = [];
  built.months.forEach(function (m) {
    const existing = store.actuals[m.property] && store.actuals[m.property][m.period];
    if (!existing) return;
    const incoming = {};
    built.actuals.forEach(function (r) { if (r[0] === m.period && r[1] === m.property) incoming[r[2]] = { name: r[3], amount: r[6] }; });
    const changes = [];
    const keys = {};
    Object.keys(existing.lines).concat(Object.keys(incoming)).forEach(function (k) { keys[k] = true; });
    Object.keys(keys).forEach(function (k) {
      const before = existing.lines[k] ? existing.lines[k].amount : 0;
      const after = incoming[k] ? incoming[k].amount : 0;
      if (Math.abs(before - after) >= 1) {
        changes.push({ key: k, name: (incoming[k] || existing.lines[k]).name, before: before, after: after });
      }
    });
    replaces.push({ property: m.property, period: m.period, stageBefore: existing.stage, stageAfter: m.stage,
      asOfBefore: existing.asOf, changes: changes.slice(0, 12), changeCount: changes.length });
  });

  // Recurring lines with nothing this time, for the newest month per property.
  const merged = rowsToStore_({
    actuals: withoutMonths_(readDataRows_(ss, 'actuals'), built.months).concat(built.actuals),
    detail: [], budget: readDataRows_(ss, 'budget'), tags: readDataRows_(ss, 'tags')
  }, store.properties.slice(), config.rules);
  const newest = {};
  built.months.forEach(function (m) { if (!newest[m.property] || m.period > newest[m.property].period) newest[m.property] = m; });
  const missing = [];
  Object.keys(newest).forEach(function (code) {
    const m = newest[code];
    if (m.stage === 'mtd') return;
    const r = buildPeriodReport_(merged, code, m.period);
    r.missing.forEach(function (x) {
      missing.push({ property: code, period: m.period, key: x.key, name: x.name, expected: x.expected, severity: x.severity });
    });
  });

  const props = {};
  built.months.forEach(function (m) { props[m.property] = m.propertyName; });
  const copies = uploadCopies_(merged, built.months);
  return safe_({
    fileName: fileName || '',
    format: parsed.format,
    formatLabel: parsed.format === 'trailing12' ? 'Trailing 12 Periods' : 'Location Side by Side – Period',
    detailed: parsed.detailed,
    dateRange: parsed.dateRange,
    asOf: asOf,
    months: built.months.map(function (m) {
      return { property: m.property, propertyName: m.propertyName, period: m.period, stage: m.stage, problems: m.problems };
    }),
    properties: Object.keys(props).map(function (code) {
      return { code: code, name: props[code], isNew: !known[code],
        hasBudget: !!(store.budgets[code] && Object.keys(store.budgets[code]).length) };
    }),
    problems: built.months.reduce(function (n, m) { return n + m.problems.length; }, 0),
    summaryRows: built.actuals.length,
    detailRows: built.detail.length,
    replaces: replaces,
    missing: missing,
    copies: copies
  });
}

/** Admin. Save a P&L CSV. Refuses a file whose totals do not add up. */
function commitPnlUpload(csvText, fileName, asOf) {
  const ss = dataSpreadsheet_();
  requireAdmin_(ss);
  asOf = checkAsOf_(asOf);
  const parsed = parsePnlRows_(Utilities.parseCsv(String(csvText || '')));
  const problems = [];
  parsed.groups.forEach(function (g) { g.problems.forEach(function (p) { problems.push(g.label + ': ' + p.line); }); });
  if (problems.length) {
    throw new Error('Not saved: some totals in the file do not add up (' + problems.slice(0, 3).join('; ') +
      (problems.length > 3 ? '…' : '') + '). Re-export from R365 and try again.');
  }
  const config = readConfig_(ss);
  const uploadId = Utilities.getUuid().slice(0, 8);
  const built = parsedToRows_(parsed, asOf, uploadId, config.rules.settleDays);

  const copies = uploadCopies_(rowsToStore_({
    actuals: withoutMonths_(readDataRows_(ss, 'actuals'), built.months).concat(built.actuals)
  }, [], config.rules), built.months);
  if (copies.length) throw new Error('Not saved: ' + copiesText_(copies) + '. Check that the report was run for the right location.');

  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); }
  catch (e) { throw new Error('Another upload is being saved. Try again in a moment.'); }
  try {
    writeDataRows_(ss, 'actuals', withoutMonths_(readDataRows_(ss, 'actuals'), built.months).concat(built.actuals));
    writeDataRows_(ss, 'detail', withoutMonths_(readDataRows_(ss, 'detail'), built.months).concat(built.detail));
    const props = {};
    built.months.forEach(function (m) { props[m.property] = m.propertyName; });
    registerProperties_(ss, Object.keys(props).map(function (c) { return { code: c, name: props[c] }; }));
    const periods = built.months.map(function (m) { return m.period; }).filter(function (p, i, a) { return a.indexOf(p) === i; }).sort();
    appendDataRow_(ss, 'uploads', [uploadId, new Date().toISOString(), currentUserEmail_(), String(fileName || ''),
      parsed.format, parsed.detailed ? 'yes' : 'no', periods.join(', '), Object.keys(props).join(', '),
      built.actuals.length + built.detail.length, '']);
    SpreadsheetApp.flush();
    return safe_({ uploadId: uploadId, months: built.months.length, rows: built.actuals.length + built.detail.length,
      periods: periods, latest: periods[periods.length - 1] });
  } finally {
    lock.releaseLock();
  }
}

/** Admin. Read a budget (xlsx as base64, or a Google Sheet ID) and report what it holds. */
function previewBudgetUpload(request) {
  const ss = dataSpreadsheet_();
  requireAdmin_(ss);
  request = request || {};
  const yearHint = Number(request.year) || null;
  let budget, sourceLabel;
  if (request.sheetId) {
    const id = extractSheetId_(request.sheetId);
    let src;
    try { src = SpreadsheetApp.openById(id); }
    catch (e) { throw new Error('Could not open that Google Sheet. Check the ID and that your account can open it.'); }
    budget = readBudgetSpreadsheet_(src, yearHint);
    sourceLabel = src.getName();
  } else if (request.base64) {
    budget = readBudgetXlsx_(String(request.base64), String(request.fileName || 'budget.xlsx'), yearHint);
    sourceLabel = String(request.fileName || 'budget.xlsx');
  } else {
    throw new Error('Choose a budget file or enter a Google Sheet ID.');
  }
  if (yearHint) budget.year = yearHint;
  budget.source = sourceLabel;

  const token = Utilities.getUuid();
  CacheService.getScriptCache().put('budget:' + token, JSON.stringify(budget), 1800);

  const store = loadStore_(ss, { skipDetail: true });
  const suggestion = suggestProperty_(store.properties, sourceLabel + ' ' + (budget.nameCell || ''));
  const lines = Object.keys(budget.lines).map(function (k) {
    const spec = BUDGET_LINE_MAP.filter(function (s) { return s.key === k; })[0];
    return { key: k, label: spec ? spec.labels.join(' + ') : k, months: budget.lines[k],
      total: budget.lines[k].reduce(function (s, v) { return s + v; }, 0) };
  });
  const oi = [];
  for (let i = 0; i < 12; i++) oi.push(budgetSubtotals_(budget.lines, i).OPERATING_INCOME);
  return safe_({
    token: token, source: sourceLabel, year: budget.year, nameCell: budget.nameCell,
    suggestedProperty: suggestion, checks: budget.checks, lines: lines, operatingIncome: oi,
    glRows: Object.keys(budget.gl).length, dailyDays: Object.keys(budget.daily).length,
    existing: store.budgets[suggestion] && store.budgets[suggestion][budget.year] ? true : false,
    status: budgetStatus_(budget.year, today_()),
    forecastYear: budget.forecast ? budget.forecast.year : null
  });
}

/** Admin. Save the previewed budget for a property and year. */
function commitBudgetUpload(token, property, year) {
  const ss = dataSpreadsheet_();
  requireAdmin_(ss);
  const raw = CacheService.getScriptCache().get('budget:' + token);
  if (!raw) throw new Error('This preview has expired. Choose the budget again.');
  const budget = JSON.parse(raw);
  property = String(property || '').trim();
  if (!property) throw new Error('Choose which property this budget belongs to.');
  if (year) budget.year = Number(year);
  const rows = budgetToRows_(budget, property, { at: new Date().toISOString(), by: currentUserEmail_(), file: budget.source || '' });
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); }
  catch (e) { throw new Error('Another upload is being saved. Try again in a moment.'); }
  try {
    const kept = readDataRows_(ss, 'budget').filter(function (r) {
      return !(Number(r[0]) === Number(budget.year) && String(r[1]) === property);
    });
    writeDataRows_(ss, 'budget', kept.concat(rows));
    appendDataRow_(ss, 'uploads', [Utilities.getUuid().slice(0, 8), new Date().toISOString(), currentUserEmail_(), '',
      'budget', '', String(budget.year), property, rows.length, '']);
    CacheService.getScriptCache().remove('budget:' + token);
    return safe_({ property: property, year: budget.year, rows: rows.length, status: budgetStatus_(budget.year, today_()) });
  } finally {
    lock.releaseLock();
  }
}

/** Pick the property whose name appears in the file name or name cell ("THE_BYGONE…" → Bygone). */
function suggestProperty_(properties, text) {
  const hay = ' ' + String(text || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ') + ' ';
  let best = null, bestLen = 0;
  properties.forEach(function (p) {
    const words = String(p.name).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().split(' ')
      .filter(function (w) { return w.length >= 3 && ['THE', 'BALTIMORE', 'BAR', 'AND'].indexOf(w) === -1; });
    words.forEach(function (w) {
      if (hay.indexOf(' ' + w + ' ') !== -1 && w.length > bestLen) { best = p.code; bestLen = w.length; }
    });
  });
  return best;
}

function extractSheetId_(text) {
  const s = String(text || '').trim();
  const m = s.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
  return m ? m[1] : s;
}

function checkAsOf_(asOf) {
  const s = String(asOf || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('Enter the date this data runs through.');
  return s;
}
