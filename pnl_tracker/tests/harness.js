/*
 * Loads the plain-JavaScript .gs files (Parse.gs, Budget.gs, Analysis.gs)
 * into one Node context, the way Apps Script loads every file of a project
 * into one global scope. Dev-only: not part of the Apps Script deploy.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function loadGs(files) {
  const context = vm.createContext({ console: console, Math: Math, JSON: JSON, Date: Date });
  files.forEach(function (f) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    vm.runInContext(src, context, { filename: f });
  });
  return context;
}

/** Minimal RFC 4180 CSV parser, standing in for Utilities.parseCsv. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', i = 0, inQuotes = false;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

module.exports = { loadGs: loadGs, parseCsv: parseCsv, ROOT: ROOT };
