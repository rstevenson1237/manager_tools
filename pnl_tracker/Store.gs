/*******************************************************************************
 * Store.gs — the data workbook's sheet layouts, and conversion between
 * parsed uploads, sheet rows, and the in-memory "store" Analysis.gs reads.
 * Plain JavaScript (no Apps Script services) so the Node harness runs the
 * exact same conversion the app uses.
 *
 * SHEETS (one data workbook for the whole portfolio)
 *   Actuals  category lines and subtotals: one row per month × property × line.
 *            This is the month-to-month history trends and the dashboard use.
 *   Detail   sub-accounts from detailed uploads, one row per month × property
 *            × sub-account. Used only to explain flags in the period report.
 *   Budget   per property and year: rolled-up lines, every GL row, and the
 *            daily sales budget (for month-to-date).
 *   Tags     the manager's notes and "timing / accrual" tags on a line.
 *   Uploads  one row per upload: who, when, which file, what it held.
 *   _Config  settings (viewers, properties, flag rule).
 ******************************************************************************/

const SHEETS = {
  actuals: { name: 'Actuals', headers: ['Period', 'Property', 'Key', 'Name', 'Section', 'Kind', 'Amount', 'Pct',
    'Stage', 'Data Through', 'Upload ID'] },
  detail: { name: 'Detail', headers: ['Period', 'Property', 'Category', 'Code', 'Name', 'Amount', 'Upload ID'] },
  budget: { name: 'Budget', headers: ['Year', 'Property', 'Kind', 'Key', 'Name',
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] },
  tags: { name: 'Tags', headers: ['Period', 'Property', 'Key', 'Tag', 'Note', 'By', 'At'] },
  uploads: { name: 'Uploads', headers: ['Upload ID', 'At', 'By', 'File', 'Format', 'Detailed', 'Periods',
    'Properties', 'Rows', 'Warnings'] }
};

/** Key used in Tags for the manager's free-text note on a whole month. */
const NOTE_KEY = '_NOTE';

/**
 * Rows to write for one parsed P&L upload.
 * @param {Object} parsed  result of parsePnlRows_
 * @param {string} asOf    'YYYY-MM-DD' — the date the data runs through
 * @return {{ actuals: [][], detail: [][], months: [{property, propertyName, period, stage}] }}
 */
function parsedToRows_(parsed, asOf, uploadId, settleDays) {
  const actuals = [], detail = [], months = [];
  parsed.groups.forEach(function (g) {
    // A trailing-12 report's later months can be after the data-through date
    // only if it was run early; the newest month is the open one.
    const stage = stageFor_(g.period, asOf, settleDays);
    months.push({ property: g.propertyCode, propertyName: g.propertyName, period: g.period, stage: stage,
      problems: g.problems });
    g.summary.forEach(function (l) {
      actuals.push([g.period, g.propertyCode, l.key, l.name, l.section || '', l.kind, round2_(l.amount),
        l.pct == null ? '' : l.pct, stage, asOf, uploadId]);
    });
    g.detail.forEach(function (l) {
      if (!l.amount) return; // R365 lists every account for every column; keep only posted ones
      detail.push([g.period, g.propertyCode, l.category, l.code, l.name, round2_(l.amount), uploadId]);
    });
  });
  return { actuals: actuals, detail: detail, months: months };
}

/** Rows to write for one parsed budget. */
function budgetToRows_(budget, property) {
  const rows = [];
  Object.keys(budget.lines).forEach(function (k) {
    rows.push([budget.year, property, 'line', k, '', ].concat(budget.lines[k].map(round2_)));
  });
  Object.keys(budget.gl).forEach(function (code) {
    rows.push([budget.year, property, 'gl', code, budget.gl[code].name].concat(budget.gl[code].months.map(round2_)));
  });
  Object.keys(budget.daily).sort().forEach(function (d) {
    const e = budget.daily[d];
    const vals = [round2_(e.gross), round2_(e.banquet), '', '', '', '', '', '', '', '', '', ''];
    rows.push([budget.year, property, 'daily', d, ''].concat(vals));
  });
  return rows;
}

/**
 * Remove the rows for the given (property, period) pairs, keeping the rest.
 * Used before writing an upload so a month is replaced, never duplicated.
 */
function withoutMonths_(rows, months) {
  const drop = {};
  months.forEach(function (m) { drop[m.property + '|' + m.period] = true; });
  return rows.filter(function (r) { return !drop[r[1] + '|' + periodText_(r[0])]; });
}

/** Build the store Analysis.gs reads from the sheets' rows. */
function rowsToStore_(sheetRows, properties, rules) {
  const store = { properties: properties || [], actuals: {}, detail: {}, budgets: {}, tags: {}, notes: {},
    rules: Object.assign({}, DEFAULT_RULES, rules || {}) };

  (sheetRows.actuals || []).forEach(function (r) {
    const period = periodText_(r[0]), prop = String(r[1]);
    const byProp = store.actuals[prop] = store.actuals[prop] || {};
    const m = byProp[period] = byProp[period] || { stage: String(r[8] || 'settled'), asOf: dateText_(r[9]), lines: {} };
    m.lines[String(r[2])] = { key: String(r[2]), name: String(r[3]), section: String(r[4] || ''), kind: String(r[5]),
      amount: Number(r[6]) || 0, pct: r[7] === '' || r[7] == null ? null : Number(r[7]) };
  });

  (sheetRows.detail || []).forEach(function (r) {
    const period = periodText_(r[0]), prop = String(r[1]);
    const byProp = store.detail[prop] = store.detail[prop] || {};
    (byProp[period] = byProp[period] || []).push({ category: String(r[2]), code: String(r[3]), name: String(r[4]),
      amount: Number(r[5]) || 0 });
  });

  (sheetRows.budget || []).forEach(function (r) {
    const year = Number(r[0]), prop = String(r[1]), kind = String(r[2]), key = String(r[3]);
    const byProp = store.budgets[prop] = store.budgets[prop] || {};
    const b = byProp[year] = byProp[year] || { lines: {}, gl: {}, daily: {} };
    const months = r.slice(5, 17).map(function (v) { return Number(v) || 0; });
    if (kind === 'line') b.lines[key] = months;
    else if (kind === 'gl') b.gl[key] = { name: String(r[4]), months: months };
    else if (kind === 'daily') b.daily[dateText_(r[3])] = { gross: months[0], banquet: months[1] };
  });

  (sheetRows.tags || []).forEach(function (r) {
    const period = periodText_(r[0]), prop = String(r[1]), key = String(r[2]);
    if (key === NOTE_KEY) {
      (store.notes[prop] = store.notes[prop] || {})[period] = String(r[4] || '');
      return;
    }
    const byProp = store.tags[prop] = store.tags[prop] || {};
    (byProp[period] = byProp[period] || {})[key] = { tag: String(r[3] || ''), note: String(r[4] || '') };
  });

  // Properties seen in data but not configured are still shown.
  const known = {};
  store.properties.forEach(function (p) { known[p.code] = true; });
  Object.keys(store.actuals).forEach(function (code) {
    if (!known[code]) store.properties.push({ code: code, name: code, active: true });
  });
  return store;
}

/** Sheets may turn '2026-10' into a Date; always read periods back as 'YYYY-MM'. */
function periodText_(v) {
  if (v instanceof Date) return v.getFullYear() + '-' + String(v.getMonth() + 1).padStart(2, '0');
  return String(v).slice(0, 7);
}
function dateText_(v) {
  if (v instanceof Date) {
    return v.getFullYear() + '-' + String(v.getMonth() + 1).padStart(2, '0') + '-' + String(v.getDate()).padStart(2, '0');
  }
  return String(v || '').slice(0, 10);
}
function round2_(n) { return Math.round((Number(n) || 0) * 100) / 100; }
