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
 *   Budget   per property and year: rolled-up lines, every GL row, the
 *            daily sales budget (for month-to-date), the workbook's forecast
 *            of the year before (annual, in the Jan column) and one 'meta'
 *            row recording the upload (JSON in the Name column).
 *   Tags     the manager's notes and "timing / accrual" tags on a line.
 *   Uploads  one row per upload: who, when, which file, what it held.
 *   Inventory Checks  one row per inventory count export checked: totals,
 *            the price / quantity split, the checks, and a small JSON summary
 *            (value by account, by P&L line). About 20 cells a count.
 *   Inventory Flags   the items the rules picked from each count (about 50),
 *            each with its figures and the questions to ask. Every other
 *            item of the export is read, checked and dropped: nothing item-
 *            level is kept for items that did not need a second look.
 *            Only InventoryApi.gs reads these two, so they never slow the
 *            P&L views down.
 *   _Config  settings (viewers, properties, flag rule, inventory).
 ******************************************************************************/

const SHEETS = {
  actuals: { name: 'Actuals', headers: ['Period', 'Property', 'Key', 'Name', 'Section', 'Kind', 'Amount', 'Pct',
    'Stage', 'Data Through', 'Upload ID'] },
  detail: { name: 'Detail', headers: ['Period', 'Property', 'Category', 'Code', 'Name', 'Amount', 'Upload ID'] },
  budget: { name: 'Budget', headers: ['Year', 'Property', 'Kind', 'Key', 'Name',
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] },
  tags: { name: 'Tags', headers: ['Period', 'Property', 'Key', 'Tag', 'Note', 'By', 'At'] },
  uploads: { name: 'Uploads', headers: ['Upload ID', 'At', 'By', 'File', 'Format', 'Detailed', 'Periods',
    'Properties', 'Rows', 'Warnings'] },
  invChecks: { name: 'Inventory Checks', headers: ['Count ID', 'Property', 'Period', 'Label', 'File', 'Uploaded At',
    'Uploaded By', 'Items', 'Stocked', 'Current Total', 'Previous Total', 'Price Effect', 'Quantity Effect', 'Tie-out Errors',
    'Picked', 'High Impact', 'High Impact Value', 'Summary'] },
  invFlags: { name: 'Inventory Flags', headers: ['Count ID', 'Key', 'Item', 'UofM', 'Inventory Acct', 'Cost Acct',
    'Current Qty', 'Current Cost', 'Current Total', 'Previous Qty', 'Previous Cost', 'Previous Total',
    'Price Effect', 'Quantity Effect', 'Impact', 'Flag', 'Sections', 'Reasons'] }
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

/**
 * Rows to write for one parsed budget.
 * @param {Object=} meta { at, by, file } — who uploaded it, kept with the budget
 */
function budgetToRows_(budget, property, meta) {
  const rows = [];
  const blank11 = ['', '', '', '', '', '', '', '', '', '', ''];
  if (meta) {
    const info = { at: meta.at || '', by: meta.by || '', file: meta.file || '',
      checks: (budget.checks || []).map(function (c) { return { label: c.label, ok: c.ok, detail: c.detail }; }) };
    rows.push([budget.year, property, 'meta', 'upload', JSON.stringify(info), ''].concat(blank11));
  }
  if (budget.forecast) {
    const f = budget.forecast;
    Object.keys(f.lines).forEach(function (k) {
      rows.push([budget.year, property, 'forecast', k, String(f.year), round2_(f.lines[k])].concat(blank11));
    });
    if (f.net != null) rows.push([budget.year, property, 'forecast', 'NET_SALES', String(f.year), round2_(f.net)].concat(blank11));
  }
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
function addBudgetMonths_(lines, key, months) {
  lines[key] = lines[key] ? lines[key].map(function (v, i) { return v + months[i]; }) : months;
}

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
    const b = byProp[year] = byProp[year] || { lines: {}, gl: {}, daily: {}, forecast: null, meta: null };
    const months = r.slice(5, 17).map(function (v) { return Number(v) || 0; });
    if (kind === 'meta') {
      try { b.meta = JSON.parse(String(r[4] || '{}')); } catch (e) { b.meta = {}; }
      return;
    }
    if (kind === 'forecast') {
      b.forecast = b.forecast || { year: Number(r[4]) || year - 1, lines: {} };
      b.forecast.lines[key] = months[0];
      return;
    }
    if (kind === 'line' && key === '9010') addBudgetMonths_(b.lines, '6110', months);   // saved before corporate allocations moved to 6110
    else if (kind === 'line') addBudgetMonths_(b.lines, key, months);
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
  // Sales and beverage cost sub-lines (see COS_SUB_LINES): actuals from the
  // sub-account detail, budgets from the GL rows.
  Object.keys(store.actuals).forEach(function (prop) {
    Object.keys(store.actuals[prop]).forEach(function (period) {
      const det = store.detail[prop] && store.detail[prop][period];
      if (!det) return;
      const byCode = {};
      det.forEach(function (d) { byCode[d.code] = (byCode[d.code] || 0) + d.amount; });
      addCosSubLines_(store.actuals[prop][period].lines, function (c) { return byCode[c]; });
    });
  });
  Object.keys(store.budgets).forEach(function (prop) {
    Object.keys(store.budgets[prop]).forEach(function (year) {
      const b = store.budgets[prop][year];
      COS_SUB_LINES.forEach(function (sub) {
        const rows = sub.codes.map(function (c) { return b.gl[c]; }).filter(Boolean);
        if (!rows.length) return;
        const months = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(function (i) {
          return rows.reduce(function (s, g) { return s + (g.months[i] || 0); }, 0);
        });
        if (months.some(function (v) { return v; })) b.lines[sub.key] = months;
      });
    });
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
