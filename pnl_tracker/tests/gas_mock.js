/*
 * An in-memory stand-in for the Apps Script services the P&L Tracker uses
 * (SpreadsheetApp, LockService, Session, Utilities, PropertiesService,
 * CacheService, HtmlService, DriveApp, ScriptApp, Logger). Dev-only: it lets
 * tests run the endpoint files (Code.gs, Import.gs, InventoryApi.gs) in Node,
 * and the preview page run the whole app in a browser. Plain JavaScript with
 * no Node APIs, so it works in both.
 *
 * Sheets keep whatever is written (no type conversion), which is what the
 * app expects for its plain-text columns.
 */
(function (root) {
  function makeSheet(name) {
    let data = [];       // rows of values; '' for empty
    let hidden = false;
    const width = function () { return data.reduce(function (w, r) { return Math.max(w, r.length); }, 0); };
    const cell = function (r, c) { return data[r] && data[r][c] !== undefined ? data[r][c] : ''; };
    const sheet = {
      getName: function () { return name; },
      setName: function (n) { name = n; },
      getLastRow: function () {
        for (let i = data.length - 1; i >= 0; i--) if (data[i] && data[i].some(function (v) { return v !== '' && v != null; })) return i + 1;
        return 0;
      },
      getLastColumn: function () { return width(); },
      getMaxRows: function () { return Math.max(1000, data.length); },
      getMaxColumns: function () { return Math.max(26, width()); },
      insertRowsAfter: function () {},
      insertColumnsAfter: function () {},
      setFrozenRows: function () {},
      hideSheet: function () { hidden = true; },
      isSheetHidden: function () { return hidden; },
      appendRow: function (row) { data.splice(sheet.getLastRow(), 0, row.slice()); },
      getRange: function (row, col, nRows, nCols) {
        nRows = nRows || 1; nCols = nCols || 1;
        const r0 = row - 1, c0 = col - 1;
        const range = {
          getValues: function () {
            const out = [];
            for (let i = 0; i < nRows; i++) { const r = []; for (let j = 0; j < nCols; j++) r.push(cell(r0 + i, c0 + j)); out.push(r); }
            return out;
          },
          getValue: function () { return cell(r0, c0); },
          setValues: function (vals) {
            if (vals.length !== nRows || vals.some(function (v) { return v.length !== nCols; })) {
              throw new Error('Range size mismatch: ' + vals.length + 'x' + (vals[0] || []).length + ' into ' + nRows + 'x' + nCols);
            }
            for (let i = 0; i < nRows; i++) {
              data[r0 + i] = data[r0 + i] || [];
              for (let j = 0; j < nCols; j++) data[r0 + i][c0 + j] = vals[i][j];
            }
            return range;
          },
          setValue: function (v) { return range.setValues([[v]]); },
          clearContent: function () {
            for (let i = 0; i < nRows; i++) for (let j = 0; j < nCols; j++) if (data[r0 + i]) data[r0 + i][c0 + j] = '';
            return range;
          },
          setNumberFormat: function () { return range; },
          setFontWeight: function () { return range; }
        };
        return range;
      },
      _data: function () { return data; }
    };
    return sheet;
  }

  function makeSpreadsheet(id) {
    let sheets = [makeSheet('Sheet1')];
    const ss = {
      getId: function () { return id; },
      getUrl: function () { return 'https://docs.google.com/spreadsheets/d/' + id; },
      getName: function () { return 'P&L Tracker Data'; },
      getSheets: function () { return sheets.slice(); },
      getSheetByName: function (n) { return sheets.filter(function (s) { return s.getName() === n; })[0] || null; },
      insertSheet: function (n) { const s = makeSheet(n); sheets.push(s); return s; },
      deleteSheet: function (s) { sheets = sheets.filter(function (x) { return x !== s; }); },
      getSpreadsheetTimeZone: function () { return 'America/New_York'; }
    };
    return ss;
  }

  /** Minimal RFC 4180 CSV parser, standing in for Utilities.parseCsv. */
  function parseCsv(text) {
    const rows = [];
    let row = [], field = '', i = 0, inQuotes = false;
    text = String(text);
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

  /**
   * Install the services on `g` (a global object or a vm context).
   * @param {{ user?: string }} opts  the signed-in account; change later with g.__setUser(email)
   */
  function installGasMock(g, opts) {
    opts = opts || {};
    let user = opts.user || 'admin@example.com';
    let uuid = 0;
    const spreadsheets = {};
    const props = {};
    const cache = {};
    g.__setUser = function (email) { user = email; };
    g.__spreadsheets = spreadsheets;
    g.SpreadsheetApp = {
      create: function () { const id = 'ss' + (Object.keys(spreadsheets).length + 1); spreadsheets[id] = makeSpreadsheet(id); return spreadsheets[id]; },
      openById: function (id) { if (!spreadsheets[id]) throw new Error('No spreadsheet ' + id); return spreadsheets[id]; },
      flush: function () {}
    };
    g.LockService = { getScriptLock: function () { return { waitLock: function () {}, tryLock: function () { return true; }, releaseLock: function () {} }; } };
    g.Session = {
      getActiveUser: function () { return { getEmail: function () { return user; } }; },
      getScriptTimeZone: function () { return 'America/New_York'; }
    };
    g.Utilities = {
      parseCsv: parseCsv,
      getUuid: function () { uuid++; return ('00000000' + uuid.toString(16)).slice(-8) + '-mock'; },
      formatDate: function (d) {
        const p = function (n) { return String(n).padStart(2, '0'); };
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
      }
    };
    g.PropertiesService = { getScriptProperties: function () {
      return { getProperty: function (k) { return props[k] == null ? null : props[k]; }, setProperty: function (k, v) { props[k] = String(v); } };
    } };
    g.CacheService = { getScriptCache: function () {
      return { get: function (k) { return cache[k] || null; }, put: function (k, v) { cache[k] = v; }, remove: function (k) { delete cache[k]; } };
    } };
    g.DriveApp = { getFileById: function () { return { getParents: function () { return { hasNext: function () { return false; } }; }, moveTo: function () {} }; } };
    g.ScriptApp = { getScriptId: function () { return 'script'; } };
    g.Logger = { log: function () {} };
    g.HtmlService = {
      createTemplateFromFile: function () { throw new Error('HtmlService is not available in the mock.'); },
      createHtmlOutputFromFile: function () { throw new Error('HtmlService is not available in the mock.'); },
      XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' }
    };
    return g;
  }

  const api = { installGasMock: installGasMock, parseCsv: parseCsv };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GasMock = api;
})(this);
