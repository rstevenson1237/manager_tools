/*******************************************************************************
 * Budget.gs — reads a property's annual budget workbook.
 *
 * The budget template is a Google Sheet. It can reach the app two ways:
 *   1. its Google Sheet ID (the app opens it directly), or
 *   2. an uploaded .xlsx export, which the app converts to a temporary Google
 *      Sheet with the Drive service, reads, and then deletes. The template's
 *      formulas use only SUM and COUNT, so the conversion recalculates to the
 *      same values.
 *
 * WHAT IS READ
 *   12 MONTH tab — one row per GL line, months in the columns headed JANUARY …
 *     DECEMBER (the quarter % columns between them are skipped). Rows are
 *     matched by the label in column D (and the GL code in column C where a
 *     label repeats), then rolled up to the same category lines the P&L uses
 *     (BUDGET_LINE_MAP below). Every GL row is also kept as-is, so the period
 *     report can compare a sub-account (e.g. 7165 Linen) with its own budget.
 *   JAN … DEC tabs — daily TOTAL GROSS SALES and BANQUET Sales, used to work
 *     out how much of the month's sales budget falls before a given day (the
 *     month-to-date budget). Banquets are entered as one sum on the 1st, so
 *     they are spread evenly across the month instead.
 *
 * Only parseBudgetSheets_ and its helpers are plain JavaScript (tested in
 * Node); the functions at the bottom use SpreadsheetApp and Drive.
 ******************************************************************************/

/**
 * P&L category line → the 12 MONTH rows that make it up. `labels` are matched
 * case-insensitively against column D; `gl`, when given, must also match
 * column C (used where the same label appears more than once).
 * Confirmed against the detailed R365 P&L for The Bygone, Sep–Oct 2026.
 */
const BUDGET_LINE_MAP = [
  { key: '4100', labels: ['RESTAURANT GROSS F&B SALES', 'Retail Sales', 'Cigar Sales', 'Facilities Fee', 'Membership Dues'] },
  { key: '4560', labels: ['TOTAL COMPS'] },
  { key: '5002', labels: ['FOOD COST'] },
  { key: '5185', labels: ['BEVERAGE COSTS'] },
  { key: '5190', labels: ['NA Beverage Costs'] },
  { key: '6110', labels: ['MANAGEMENT SALARIES & WAGES'] },
  { key: '6201', labels: ['FOH HOURLY LABOR'] },
  { key: '6209', labels: ['BOH HOURLY LABOR'] },
  { key: '6252', labels: ['Cleaners'] },
  { key: '6266', labels: ['Training'] },
  { key: '6267', labels: ['Fringe Benefit'] },
  { key: '6272', labels: ['Commissions'] },
  { key: '6275', labels: ['Payroll Related Expenses'], gl: '6275' },
  { key: '7005', labels: ['Total Direct Operating Expenses'] },
  { key: '7202', labels: ['Total Music & Entertainment'] },
  { key: '7300', labels: ['TOTAL Marketing & Promotions'] },
  { key: '7400', labels: ['Total Utilities'] },
  { key: '7500', labels: ['Total General & Administrative'] },
  { key: '7590', labels: ['Total Repairs & Maintenance'] },
  { key: '9100', labels: ['Management Fee'] },
  { key: '8100', labels: ['Total Occupancy Costs'] },
  { key: '9010', labels: ['CORPORATE ALLOCATIONS'] }
];

/** Which P&L section each budget line belongs to (matches R365's layout). */
const BUDGET_LINE_SECTION = {
  '4100': '4000', '4560': '4000',
  '5002': '5000', '5185': '5000', '5190': '5000',
  '6110': '6000', '6201': '6000', '6209': '6000', '6252': '6000', '6266': '6000', '6267': '6000',
  '6272': '6000', '6275': '6000',
  '7005': '7000', '7202': '7000', '7300': '7000', '7400': '7000', '7500': '7000', '7590': '7000', '9100': '7000',
  '8100': '8000',
  '9010': '9000'
};

const BUDGET_MONTH_NAMES = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST',
  'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
const BUDGET_MONTH_TABS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/**
 * Read a budget from its tabs' cell values.
 * @param {Object} sheets { '12 MONTH': values[][], 'JAN': values[][], … }
 * @param {number=} yearHint used when the 12 MONTH tab does not show the year
 * @return {{ year, nameCell, lines: {key: number[12]}, gl: {code: {name, months}},
 *            daily: {'YYYY-MM-DD': {gross, banquet}}, checks: [{label, ok, detail}],
 *            missingLines: string[] }}
 */
function parseBudgetSheets_(sheets, yearHint) {
  const grid = sheets['12 MONTH'];
  if (!grid) throw new Error('The workbook has no "12 MONTH" tab. Is this the annual budget template?');

  // Month columns: find the header row naming JANUARY … DECEMBER.
  let monthCols = null, year = null;
  for (let r = 0; r < Math.min(grid.length, 10) && !monthCols; r++) {
    const row = grid[r].map(function (v) { return String(v == null ? '' : v).trim().toUpperCase(); });
    const cols = BUDGET_MONTH_NAMES.map(function (m) { return row.indexOf(m); });
    if (cols.every(function (c) { return c !== -1; })) {
      monthCols = cols;
      grid[r].forEach(function (v) { const n = Number(v); if (!year && n >= 2000 && n <= 2100) year = n; });
    }
  }
  if (!monthCols) throw new Error('Could not find the JANUARY … DECEMBER columns on the 12 MONTH tab.');
  year = year || yearHint;
  if (!year) throw new Error('Could not tell which year this budget is for. Enter the year and try again.');

  // Label column: the one holding "TOTAL NET"; GL codes sit one column to its left.
  let labelCol = -1;
  for (let r = 0; r < Math.min(grid.length, 60) && labelCol === -1; r++) {
    labelCol = grid[r].findIndex(function (v) { return normBudgetLabel_(v) === 'TOTAL NET'; });
  }
  if (labelCol < 1) throw new Error('Could not find the "TOTAL NET" row on the 12 MONTH tab.');
  const glCol = labelCol - 1;

  const rows = grid.map(function (r) {
    return {
      label: normBudgetLabel_(r[labelCol]),
      rawLabel: String(r[labelCol] == null ? '' : r[labelCol]).trim(),
      gl: normBudgetGl_(r[glCol]),
      months: monthCols.map(function (c) { const n = Number(r[c]); return isFinite(n) && r[c] !== '' && r[c] != null ? n : null; })
    };
  });
  const hasNumbers = function (row) { return row.months.some(function (v) { return v !== null; }); };
  const findRow = function (label, gl) {
    const want = normBudgetLabel_(label);
    return rows.filter(function (row) {
      return row.label === want && (!gl || row.gl === gl) && hasNumbers(row);
    })[0] || null;
  };
  const zeros = function (m) { return m.map(function (v) { return v || 0; }); };

  const lines = {};
  const missingLines = [];
  BUDGET_LINE_MAP.forEach(function (spec) {
    let total = null;
    spec.labels.forEach(function (label) {
      const row = findRow(label, spec.gl);
      if (!row) return;
      const m = zeros(row.months);
      total = total ? total.map(function (v, i) { return v + m[i]; }) : m;
    });
    if (total) lines[spec.key] = total;
    else missingLines.push(spec.key + ' (' + spec.labels[0] + ')');
  });

  // Every GL row, first occurrence of each code (later repeats are subtotals).
  const gl = {};
  rows.forEach(function (row) {
    if (!row.gl || gl[row.gl] || !hasNumbers(row)) return;
    gl[row.gl] = { name: row.rawLabel, months: zeros(row.months) };
  });

  const daily = readBudgetDaily_(sheets, year);

  // Checks: the roll-up must reproduce the template's own totals.
  const checks = [];
  const totalNet = findRow('TOTAL NET');
  const noi = findRow('NET OPERATING INCOME');
  const subtotals = BUDGET_MONTH_NAMES.map(function (_, i) { return budgetSubtotals_(lines, i); });
  if (totalNet) {
    const worst = maxBudgetGap_(subtotals.map(function (s) { return s.NET_SALES; }), zeros(totalNet.months));
    checks.push({ label: 'Net sales match the TOTAL NET row', ok: worst <= 5,
      detail: worst <= 5 ? 'All 12 months match.' : 'Off by up to ' + Math.round(worst) + ' in a month.' });
  }
  if (noi) {
    // The template's NET OPERATING INCOME is after corporate allocations; R365's
    // operating income is before them (they sit in 9010, below the line).
    const ours = subtotals.map(function (s) { return s.OPERATING_INCOME - (lines['9010'] ? s._corp : 0); });
    const worst = maxBudgetGap_(ours, zeros(noi.months));
    checks.push({ label: 'Operating income matches NET OPERATING INCOME (after corporate allocations)', ok: worst <= 5,
      detail: worst <= 5 ? 'All 12 months match.' : 'Off by up to ' + Math.round(worst) + ' in a month.' });
  }
  const salesRow = findRow('RESTAURANT GROSS F&B SALES');
  if (salesRow && Object.keys(daily).length) {
    const byMonth = BUDGET_MONTH_NAMES.map(function () { return 0; });
    Object.keys(daily).forEach(function (d) { byMonth[Number(d.slice(5, 7)) - 1] += daily[d].gross; });
    const worst = maxBudgetGap_(byMonth, zeros(salesRow.months));
    checks.push({ label: 'Daily sales tabs add up to the monthly sales budget', ok: worst <= 5,
      detail: worst <= 5 ? 'All months match.' : 'Off by up to ' + Math.round(worst) + ' in a month; month-to-date budget will be approximate.' });
  }
  if (missingLines.length) {
    checks.push({ label: 'Every P&L line found', ok: false, detail: 'Not found: ' + missingLines.join(', ') + '.' });
  }

  let nameCell = '';
  for (let r = 0; r < 3 && !nameCell; r++) {
    (grid[r] || []).forEach(function (v) { if (!nameCell && typeof v === 'string' && /[A-Za-z]{3,}/.test(v)) nameCell = v.trim(); });
  }
  return { year: year, nameCell: nameCell, lines: lines, gl: gl, daily: daily, checks: checks, missingLines: missingLines };
}

/** Daily gross sales and banquet sales from the JAN … DEC tabs (when present). */
function readBudgetDaily_(sheets, year) {
  const daily = {};
  BUDGET_MONTH_TABS.forEach(function (tab, mi) {
    const grid = sheets[tab];
    if (!grid) return;
    let dayRow = -1, labelCol = -1, grossRow = -1, banquetRow = -1;
    for (let r = 0; r < Math.min(grid.length, 80); r++) {
      for (let c = 0; c < Math.min(grid[r].length, 8); c++) {
        const lab = normBudgetLabel_(grid[r][c]);
        if (lab === 'TOTAL GROSS SALES' && grossRow === -1) { grossRow = r; labelCol = c; }
        if (lab === 'BANQUET SALES' && banquetRow === -1) banquetRow = r;
      }
    }
    if (grossRow === -1) return;
    for (let r = 0; r < Math.min(grid.length, 5) && dayRow === -1; r++) {
      if (Number(grid[r][labelCol + 1]) === 1) dayRow = r;
    }
    if (dayRow === -1) return;
    const dim = new Date(year, mi + 1, 0).getDate();
    for (let c = labelCol + 1; c < grid[dayRow].length; c++) {
      const day = Number(grid[dayRow][c]);
      if (!(day >= 1 && day <= dim)) continue;
      const key = year + '-' + pad2Budget_(mi + 1) + '-' + pad2Budget_(day);
      daily[key] = {
        gross: Number(grid[grossRow][c]) || 0,
        banquet: banquetRow === -1 ? 0 : (Number(grid[banquetRow][c]) || 0)
      };
    }
  });
  return daily;
}

/**
 * Subtotals for one month of budget lines, built the same way R365 builds
 * them, so budget and actual subtotals compare like for like.
 */
function budgetSubtotals_(lines, monthIndex) {
  const v = function (k) { return lines[k] ? lines[k][monthIndex] : 0; };
  const sec = {};
  Object.keys(lines).forEach(function (k) {
    const s = BUDGET_LINE_SECTION[k];
    if (!s) return;
    sec[s] = (sec[s] || 0) + v(k);
  });
  const s = function (x) { return sec[x] || 0; };
  const out = {};
  out.NET_SALES = s('4000');
  out.TOTAL_5000 = s('5000');
  out.GROSS_PROFIT = out.NET_SALES - out.TOTAL_5000;
  out.TOTAL_6000 = s('6000');
  out.PROFIT_AFTER_PRIME_COST = out.GROSS_PROFIT - out.TOTAL_6000;
  out.TOTAL_7000 = s('7000');
  out.CONTROLLABLE_PROFIT = out.PROFIT_AFTER_PRIME_COST - out.TOTAL_7000;
  out.TOTAL_8000 = s('8000');
  out.OPERATING_INCOME = out.CONTROLLABLE_PROFIT - out.TOTAL_8000;
  out.TOTAL_9000 = s('9000');
  out.NET_PROFIT = out.OPERATING_INCOME - out.TOTAL_9000;
  out._corp = v('9010');
  return out;
}

/**
 * Share of a month's sales budget that falls on or before `day`: daily
 * restaurant sales to date, plus banquet sales spread evenly over the month.
 * Falls back to days elapsed ÷ days in month when no daily budget exists.
 */
function budgetMonthFraction_(daily, year, month, day) {
  const dim = new Date(year, month, 0).getDate();
  if (day >= dim) return 1;
  let total = 0, toDate = 0, banquet = 0, found = false;
  for (let d = 1; d <= dim; d++) {
    const e = daily && daily[year + '-' + pad2Budget_(month) + '-' + pad2Budget_(d)];
    if (!e) continue;
    found = true;
    const restaurant = e.gross - e.banquet;
    total += e.gross;
    banquet += e.banquet;
    if (d <= day) toDate += restaurant;
  }
  if (!found || total <= 0) return day / dim;
  return (toDate + banquet * day / dim) / total;
}

function normBudgetLabel_(v) { return String(v == null ? '' : v).trim().replace(/\s+/g, ' ').toUpperCase(); }
function normBudgetGl_(v) {
  if (v == null || v === '') return '';
  const s = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(v)) : String(v).trim();
  return /^\d{4}(\.\d+)?$/.test(s) ? s.replace(/\.0+$/, '') : '';
}
function maxBudgetGap_(a, b) { let w = 0; a.forEach(function (v, i) { w = Math.max(w, Math.abs(v - (b[i] || 0))); }); return w; }
function pad2Budget_(n) { return n < 10 ? '0' + n : String(n); }

/* ------------------------------------------------- Apps Script side (not Node) */

/** Read the 12 MONTH and JAN … DEC tabs of an open spreadsheet. */
function readBudgetSpreadsheet_(ss, yearHint) {
  const sheets = {};
  ['12 MONTH'].concat(BUDGET_MONTH_TABS).forEach(function (name) {
    const sh = ss.getSheetByName(name);
    if (!sh) return;
    const lastRow = Math.min(sh.getLastRow(), name === '12 MONTH' ? 300 : 80);
    const lastCol = Math.min(sh.getLastColumn(), 40);
    if (lastRow < 1 || lastCol < 1) return;
    sheets[name] = sh.getRange(1, 1, lastRow, lastCol).getValues();
  });
  return parseBudgetSheets_(sheets, yearHint);
}

/**
 * Convert an uploaded .xlsx (base64) to a temporary Google Sheet, read it,
 * and delete the copy. Needs the Drive advanced service (appsscript.json).
 */
function readBudgetXlsx_(base64, fileName, yearHint) {
  const blob = Utilities.newBlob(Utilities.base64Decode(base64),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileName || 'budget.xlsx');
  const file = Drive.Files.create({ name: '[P&L Tracker temp] ' + (fileName || 'budget'),
    mimeType: 'application/vnd.google-apps.spreadsheet' }, blob);
  try {
    return readBudgetSpreadsheet_(SpreadsheetApp.openById(file.id), yearHint);
  } finally {
    try { DriveApp.getFileById(file.id).setTrashed(true); } catch (e) { /* best effort */ }
  }
}
