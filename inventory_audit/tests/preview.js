/*
 * Builds a self-contained preview of the web app: Index.html with the whole
 * backend (every .gs file) running in the page against the in-memory Apps
 * Script stand-in (pnl_tracker/tests/gas_mock.js). Open the result in a
 * browser to click through the app without deploying it. Dev-only; nothing
 * here is part of the Apps Script project.
 *
 *   node inventory_audit/tests/preview.js <out.html> [--vue <vue.global.prod.js>] [--user <email>] [--csv <file>]...
 *
 *   --vue   inline a local copy of Vue instead of the CDN link (offline use)
 *   --user  the signed-in account (default: the seeded global admin)
 *   --csv   an R365 count export to upload into the sample property first
 *           (repeat for several months, oldest first). Without it the
 *           property starts with a made-up beverage count.
 * Data lives only in the page: a reload starts again from the seed.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const sample = require('./sample');

const args = process.argv.slice(2);
const out = args[0];
if (!out) { console.error('usage: node preview.js <out.html> [--vue file] [--user email] [--csv file]...'); process.exit(1); }
const opt = name => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const all = name => args.reduce((list, a, i) => (a === name ? list.concat(args[i + 1]) : list), []);

const GS = ['InventoryRules.gs', 'Code.gs', 'Import.gs'];
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const noScriptEnd = s => s.replace(/<\/script/gi, '<\\/script');
const ADMIN = 'robert.stevenson@atlasrestaurantgroup.com';

const csvs = all('--csv').map(f => fs.readFileSync(f, 'utf8'));
if (!csvs.length) csvs.push(sample.previousCsv(), sample.currentCsv());

// Every .gs file runs inside one function so its top-level names cannot clash with the page's own.
const backendSrc = GS.map(read).join('\n;\n');
const names = Array.from(new Set((backendSrc.match(/^function ([A-Za-z0-9_]+)/gm) || []).map(m => m.slice(9))));
const backend = `
GasMock.installGasMock(window, { user: ${JSON.stringify(opt('--user') || ADMIN)} });
window.__backend = (function () {
${backendSrc}
;
  return { ${names.map(n => n + ': ' + n).join(', ')} };
})();
(function seed() {
  const b = window.__backend;
  const user = Session.getActiveUser().getEmail();
  window.__setUser(${JSON.stringify(ADMIN)});
  const p = b.addProperty('Sample Grill');
  b.saveSettings(p.id, { propertyAdmins: [], propertyUsers: ['bar@example.com'], noteCategories: b.getSettings(p.id).noteCategories });
  ${JSON.stringify(csvs)}.forEach(function (csv, i) { b.commitUpload(p.id, csv, 'count-' + (i + 1) + '.csv'); });
  b.addProperty('Harbor House');
  window.__setUser(user);
})();
window.google = { script: {
  url: { getLocation: function (cb) { const p = {}; new URLSearchParams(location.search).forEach(function (v, k) { p[k] = v; }); setTimeout(function () { cb({ parameter: p }); }, 0); } },
  get run() {
    let ok = function () {}, fail = function (e) { console.error(e); };
    const runner = new Proxy({}, { get: function (t, name) {
      if (name === 'withSuccessHandler') return function (f) { ok = f; return runner; };
      if (name === 'withFailureHandler') return function (f) { fail = f; return runner; };
      return function () {
        const a = Array.prototype.slice.call(arguments);
        setTimeout(function () {
          try {
            if (!window.__backend[name]) throw new Error('Unknown server function ' + String(name));
            ok(JSON.parse(JSON.stringify(window.__backend[name].apply(null, a)) || 'null'));
          } catch (e) { fail(e); }
        }, 30);
      };
    } });
    return runner;
  }
} };`;

let html = read('Index.html');
const vue = opt('--vue');
const vueTag = '<script src="https://cdn.jsdelivr.net/npm/vue@3.4.31/dist/vue.global.prod.js"></script>';
if (html.indexOf(vueTag) === -1) throw new Error('Vue script tag not found.');
const mock = fs.readFileSync(path.join(ROOT, '..', 'pnl_tracker', 'tests', 'gas_mock.js'), 'utf8');
html = html.replace(vueTag, () => (vue ? '<script>' + noScriptEnd(fs.readFileSync(vue, 'utf8')) + '</script>' : vueTag) +
  '\n<script>' + noScriptEnd(mock) + '</script>\n<script>' + noScriptEnd(backend) + '</script>');
fs.writeFileSync(out, html);
console.log('Wrote ' + out + ' (' + names.length + ' server functions)');
