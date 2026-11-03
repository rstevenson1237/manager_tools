/*******************************************************************************
 * Parse.gs — reads Restaurant 365 Profit & Loss CSV exports.
 *
 * Everything in this file is plain JavaScript with no Apps Script services,
 * so the same code runs in the Node test harness (tests/run_tests.js).
 *
 * THE THREE FORMATS
 *   All R365 P&L exports share one column layout (TrxDtlComment,
 *   ColumnGroupLabel, …, AccountName, Amount, Pct, …). What differs is what a
 *   "column group" is:
 *
 *   Report type (row 2)                          Column group is     Period from
 *   ------------------------------------------   -----------------   -----------------------------
 *   Profit & Loss - Location Side by Side -      a property          "Period Ending 10/31/2026"
 *     Period (simplified or detailed)            "ARG1M - Bygone"
 *   Profit & Loss - Trailing 12 Periods          a month             each "Period 10, 2025" column
 *                                                "Period 10, 2025"   (property from "Location: …")
 *
 *   A detailed export nests sub-accounts under each category, up to three
 *   levels deep (5185 → 5300 → 5320), each group closed by a "Total …" row.
 *   A simplified export lists only the categories.
 *
 * R365 QUIRKS HANDLED HERE
 *   - A group header and its own first line can share a name
 *     ("7005 - Direct Operating Expenses" twice). The second one is a line.
 *   - Every account appears for every column group, even when blank, so blank
 *     amounts are read as zero rather than skipped.
 *   - Section headers ("EXPENSES (7000)") have no amount. The sales section
 *     has no "Total" row; NET SALES closes it.
 *   - Amounts carry thousands separators and quotes ("1,234"); percentages
 *     may read "26.49%" or "-100.0 %".
 ******************************************************************************/

const PNL_SECTION_RE = /^[A-Z][A-Z ,&]*\((\d{4})\)$/;
const PNL_CODE_RE = /^(\d[\w.\-]*) - (.+)$/;
const PNL_PERIOD_ENDING_RE = /Period Ending (\d{1,2})\/(\d{1,2})\/(\d{4})/;
const PNL_TRAILING_RE = /Periods? Ending (\d{1,2})\/(\d{1,2})\/(\d{4})/;
const PNL_PERIOD_COL_RE = /^Period (\d{1,2}), (\d{4})$/;
const PNL_PROPERTY_RE = /^([A-Z0-9]+) - (.+)$/;

/** Subtotal rows that R365 computes and prints without an account code. */
const PNL_COMPUTED_KEYS = {
  'NET SALES': 'NET_SALES',
  'GROSS PROFIT': 'GROSS_PROFIT',
  'PROFIT AFTER PRIME COST': 'PROFIT_AFTER_PRIME_COST',
  'CONTROLLABLE PROFIT': 'CONTROLLABLE_PROFIT',
  'OPERATING INCOME': 'OPERATING_INCOME',
  'NET PROFIT': 'NET_PROFIT'
};

/**
 * Parse an R365 P&L export from CSV rows (an array of string arrays, as
 * returned by Utilities.parseCsv).
 *
 * Returns {
 *   format: 'period' | 'trailing12',
 *   detailed: boolean,             // true when sub-accounts are present
 *   reportType, dateRange,
 *   periodEnd: 'YYYY-MM-DD',       // end of the report's last period
 *   groups: [{ label, propertyCode, propertyName, period: 'YYYY-MM',
 *              summary: [line], detail: [line], problems: [tie-out issue] }]
 * }
 * Throws a plain-language Error when the file is not an R365 P&L export.
 */
function parsePnlRows_(rows) {
  if (!rows || rows.length < 5) throw new Error('This file is empty or too short to be an R365 P&L export.');
  const clean = rows.map(function (r) { return r.map(function (v) { return String(v == null ? '' : v); }); });
  clean[0][0] = clean[0][0].replace(/^﻿/, '');

  const meta = readPnlMeta_(clean);
  const headerIndex = clean.findIndex(function (r) {
    return r.indexOf('ColumnGroupLabel') !== -1 && r.indexOf('AccountName') !== -1;
  });
  if (headerIndex === -1) {
    throw new Error('Could not find the column headers (ColumnGroupLabel, AccountName, Amount). ' +
      'Export the P&L from R365 as CSV without changing it.');
  }
  const header = clean[headerIndex];
  const col = {
    group: header.indexOf('ColumnGroupLabel'),
    account: header.indexOf('AccountName'),
    amount: header.indexOf('Amount'),
    pct: header.indexOf('Pct')
  };
  if (col.amount === -1) throw new Error('The file has no Amount column.');

  // Group the rows by column group, keeping file order.
  const order = [];
  const linesByGroup = {};
  clean.slice(headerIndex + 1).forEach(function (r) {
    const label = (r[col.group] || '').trim();
    const name = (r[col.account] || '').trim();
    if (!label || !name) return;
    if (!linesByGroup[label]) { linesByGroup[label] = []; order.push(label); }
    linesByGroup[label].push({ name: name, amount: parsePnlNumber_(r[col.amount]),
      pct: col.pct === -1 ? null : parsePnlNumber_(r[col.pct]) });
  });
  if (!order.length) throw new Error('The file has headers but no account rows.');

  let detailed = false;
  const groups = order.map(function (label) {
    const ident = identifyPnlGroup_(meta, label);
    const tree = buildPnlTree_(linesByGroup[label]);
    if (tree.detail.length) detailed = true;
    return {
      label: label,
      propertyCode: ident.propertyCode,
      propertyName: ident.propertyName,
      period: ident.period,
      summary: tree.summary,
      detail: tree.detail,
      problems: tieOutPnl_(tree)
    };
  });

  return {
    format: meta.format,
    detailed: detailed,
    reportType: meta.reportType,
    dateRange: meta.dateRange,
    periodEnd: meta.periodEnd,
    groups: groups
  };
}

/** Read report type, date range and (for trailing-12) the property from row 2. */
function readPnlMeta_(rows) {
  const reportType = (rows[1][0] || '').trim();
  const dateRange = (rows[1][1] || '').trim();
  const location = (rows[1][2] || '').trim();
  if (reportType.indexOf('Profit & Loss') !== 0) {
    throw new Error('Row 2 should name an R365 "Profit & Loss" report, but it says "' + reportType + '".');
  }
  let format, m;
  if (reportType.indexOf('Trailing 12') !== -1) {
    format = 'trailing12';
    m = dateRange.match(PNL_TRAILING_RE);
  } else if (reportType.indexOf('Side by Side') !== -1) {
    format = 'period';
    m = dateRange.match(PNL_PERIOD_ENDING_RE);
  } else {
    throw new Error('Unsupported P&L report: "' + reportType + '". Use "Location Side by Side - Period" ' +
      'or "Trailing 12 Periods".');
  }
  if (!m) throw new Error('Could not read the period end date from "' + dateRange + '".');
  const periodEnd = m[3] + '-' + pad2Pnl_(m[1]) + '-' + pad2Pnl_(m[2]);

  let property = null;
  if (format === 'trailing12') {
    const loc = location.replace(/^Location:\s*/, '').trim();
    const pm = loc.match(PNL_PROPERTY_RE);
    if (!pm) {
      throw new Error('A Trailing 12 report must be run for one location. Row 2 says "' + location + '".');
    }
    property = { code: pm[1], name: pm[2].trim() };
  }
  return { format: format, reportType: reportType, dateRange: dateRange, periodEnd: periodEnd, property: property };
}

/** Work out which property and month a column group holds. */
function identifyPnlGroup_(meta, label) {
  if (meta.format === 'period') {
    const pm = label.match(PNL_PROPERTY_RE);
    if (!pm) throw new Error('Column "' + label + '" is not a location (expected e.g. "ARG1M - Bygone").');
    return { propertyCode: pm[1], propertyName: pm[2].trim(), period: meta.periodEnd.slice(0, 7) };
  }
  const tm = label.match(PNL_PERIOD_COL_RE);
  if (!tm) throw new Error('Column "' + label + '" is not a period (expected e.g. "Period 10, 2025").');
  return { propertyCode: meta.property.code, propertyName: meta.property.name,
    period: tm[2] + '-' + pad2Pnl_(tm[1]) };
}

/**
 * Turn one column group's rows into summary lines (categories, section totals
 * and computed subtotals) and detail lines (sub-accounts under a category).
 * Each line: { kind, key, code, name, section, depth, category, amount, pct }.
 */
function buildPnlTree_(lines) {
  const totals = {};
  lines.forEach(function (l) { if (l.name.indexOf('Total ') === 0) totals[l.name.slice(6)] = true; });

  const summary = [];
  const detail = [];
  const all = [];
  let section = null;
  let stack = [];

  lines.forEach(function (l) {
    const name = l.name;
    const sm = name.match(PNL_SECTION_RE);
    if (sm) { section = sm[1]; stack = []; return; }

    if (name.indexOf('Total ') === 0) {
      const base = name.slice(6);
      const bsm = base.match(PNL_SECTION_RE);
      if (bsm) {
        push_(summary, { kind: 'sectionTotal', key: 'TOTAL_' + bsm[1], code: '', name: name,
          section: bsm[1], depth: 0, category: '', amount: l.amount || 0, pct: l.pct });
        return;
      }
      while (stack.length && stack[stack.length - 1] !== base) stack.pop();
      if (stack.length) stack.pop();
      const depth = stack.length + 1;
      const parsed = splitPnlAccount_(base);
      const line = { kind: 'group', key: parsed.code, code: parsed.code, name: parsed.name, section: section,
        depth: depth, category: depth === 1 ? parsed.code : codeOf_(stack[0]), amount: l.amount || 0, pct: l.pct };
      if (depth === 1) push_(summary, line);
      else all.push(line); // nested group totals are only needed for tie-out
      return;
    }

    // A header that opens a group: it has a matching "Total" row, no amount,
    // and is not a repeat of the group just opened (R365's self-named line).
    if (totals[name] && l.amount == null && !(stack.length && stack[stack.length - 1] === name)) {
      stack.push(name);
      return;
    }

    const computedKey = PNL_COMPUTED_KEYS[name.toUpperCase()];
    if (computedKey || !PNL_CODE_RE.test(name)) {
      push_(summary, { kind: 'computed', key: computedKey || name.toUpperCase().replace(/[^A-Z0-9]+/g, '_'),
        code: '', name: name, section: computedKey === 'NET_SALES' ? '4000' : section, depth: 0,
        category: '', amount: l.amount || 0, pct: l.pct });
      if (computedKey !== 'NET_SALES') section = null;
      return;
    }

    const parsed = splitPnlAccount_(name);
    const depth = stack.length + 1;
    const line = { kind: 'line', key: parsed.code, code: parsed.code, name: parsed.name, section: section,
      depth: depth, category: depth === 1 ? parsed.code : codeOf_(stack[0]), amount: l.amount || 0, pct: l.pct,
      parent: stack.length ? codeOf_(stack[stack.length - 1]) : '' };
    if (depth === 1) push_(summary, line);
    else push_(detail, line);
  });

  function push_(list, line) { list.push(line); all.push(line); }
  return { summary: summary, detail: detail, all: all };
}

/**
 * Check one column group adds up: every group total equals the lines under
 * it, every section total equals its categories, and each computed subtotal
 * follows from the one above it. R365 rounds each line to whole dollars, so a
 * total over many lines can be a few dollars off; the tolerance allows half a
 * dollar per line added.
 */
function tieOutPnl_(tree) {
  const problems = [];
  const all = tree.all;

  // Group totals: children are the lines one level deeper since the group opened.
  all.forEach(function (t, i) {
    if (t.kind !== 'group') return;
    let sum = 0, n = 0;
    for (let j = i - 1; j >= 0; j--) {
      const c = all[j];
      if (c.kind !== 'line' && c.kind !== 'group') break;
      if (c.depth <= t.depth) break;
      if (c.depth === t.depth + 1) { sum += c.amount; n++; }
    }
    if (n && Math.abs(sum - t.amount) > 1 + 0.5 * n) {
      problems.push({ line: t.code + ' - ' + t.name, expected: sum, reported: t.amount });
    }
  });

  const bySection = {};
  tree.summary.forEach(function (l) {
    if (l.kind === 'line' || l.kind === 'group') {
      bySection[l.section] = bySection[l.section] || { sum: 0, n: 0 };
      bySection[l.section].sum += l.amount;
      bySection[l.section].n++;
    }
  });
  const value = {};
  tree.summary.forEach(function (l) { if (l.kind === 'sectionTotal' || l.kind === 'computed') value[l.key] = l.amount; });
  tree.summary.forEach(function (l) {
    if (l.kind !== 'sectionTotal') return;
    const s = bySection[l.section] || { sum: 0, n: 0 };
    if (Math.abs(s.sum - l.amount) > 1 + 0.5 * s.n) {
      problems.push({ line: l.name, expected: s.sum, reported: l.amount });
    }
  });

  const v = function (k) { return value[k] || 0; };
  const chain = [
    ['NET_SALES', (bySection['4000'] || { sum: 0 }).sum, (bySection['4000'] || { n: 0 }).n],
    ['GROSS_PROFIT', v('NET_SALES') - v('TOTAL_5000'), 2],
    ['PROFIT_AFTER_PRIME_COST', v('GROSS_PROFIT') - v('TOTAL_6000'), 2],
    ['CONTROLLABLE_PROFIT', v('PROFIT_AFTER_PRIME_COST') - v('TOTAL_7000'), 2],
    ['OPERATING_INCOME', v('CONTROLLABLE_PROFIT') - v('TOTAL_8000'), 2],
    ['NET_PROFIT', v('OPERATING_INCOME') - v('TOTAL_9000'), 2]
  ];
  chain.forEach(function (c) {
    if (!(c[0] in value)) return;
    if (Math.abs(c[1] - value[c[0]]) > 1 + 0.5 * c[2]) {
      problems.push({ line: c[0].replace(/_/g, ' '), expected: c[1], reported: value[c[0]] });
    }
  });
  return problems;
}

/** "7005 - Direct Operating Expenses" → { code: '7005', name: 'Direct Operating Expenses' } */
function splitPnlAccount_(text) {
  const m = String(text).match(PNL_CODE_RE);
  return m ? { code: m[1], name: m[2].trim() } : { code: String(text), name: String(text) };
}

function codeOf_(text) { return text ? splitPnlAccount_(text).code : ''; }

/** "1,234" → 1234 · "(1,234)" → -1234 · "26.49%" → 26.49 · "" → null */
function parsePnlNumber_(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[$,%\s]/g, '');
  if (!s) return null;
  const n = Number(s);
  if (isNaN(n)) return null;
  return neg ? -n : n;
}

function pad2Pnl_(n) { n = Number(n); return n < 10 ? '0' + n : String(n); }
