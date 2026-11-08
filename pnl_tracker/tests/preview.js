/*
 * Builds a self-contained preview of the web app: Index.html with its
 * includes filled in, and the whole backend (every .gs file) running in the
 * page against the in-memory Apps Script stand-in (gas_mock.js). Open the
 * result in a browser to click through the app without deploying it.
 * Dev-only; nothing here is part of the Apps Script project.
 *
 *   node pnl_tracker/tests/preview.js <out.html> [--vue <vue.global.prod.js>] [--user <email>] [--pnl]
 *
 *   --vue   inline a local copy of Vue instead of the CDN link (offline use)
 *   --user  the signed-in account (default: the seeded global admin)
 *   --pnl   seed a made-up October 2026 P&L month for TST1 (for days on hand)
 *   --prop  add a property, CODE:Name (repeat for more), e.g. to upload real exports
 * Data lives only in the page: a reload starts empty.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const args = process.argv.slice(2);
const out = args[0];
if (!out) { console.error('usage: node preview.js <out.html> [--vue file] [--user email] [--pnl]'); process.exit(1); }
const opt = name => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const extraProps = args.reduce((list, a, i) => (a === '--prop' ? list.concat([args[i + 1]]) : list), [])
  .map(s => ({ code: s.split(':')[0], name: s.split(':').slice(1).join(':') || s.split(':')[0], active: true }));

const GS = ['Parse.gs', 'Budget.gs', 'Analysis.gs', 'Store.gs', 'Review.gs', 'InventoryRules.gs', 'InventoryCheck.gs', 'Code.gs', 'Import.gs', 'InventoryApi.gs'];
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const noScriptEnd = s => s.replace(/<\/script/gi, '<\\/script');

// Every .gs file runs inside one function so its top-level names cannot clash with the page's own.
const backendSrc = GS.map(read).join('\n;\n');
const names = Array.from(new Set((backendSrc.match(/^function ([A-Za-z0-9_]+)/gm) || []).map(m => m.slice(9))));
const backend = `
GasMock.installGasMock(window, { user: ${JSON.stringify(opt('--user') || 'robert.stevenson@atlasrestaurantgroup.com')} });
window.__backend = (function () {
${backendSrc}
;
  return { ${names.map(n => n + ': ' + n).join(', ')} };
})();
(function seed() {
  const b = window.__backend;
  const admin = Session.getActiveUser().getEmail();
  window.__setUser('robert.stevenson@atlasrestaurantgroup.com');
  b.setup();
  const ss = b.dataSpreadsheet_();
  const cfg = b.readConfig_(ss);
  cfg.properties = [{ code: 'TST1', name: 'Sample Grill', active: true }, { code: 'TST2', name: 'Harbor House', active: true }].concat(${JSON.stringify(extraProps)});
  cfg.viewers = ['viewer@example.com'];
  cfg.inventory.reviewers = ['bar@example.com'];
  b.writeConfig_(ss, cfg);
  ${args.indexOf('--pnl') !== -1 ? `b.writeDataRows_(ss, 'actuals', [
    ['2026-10', 'TST1', 'NET_SALES', 'Net sales', '4000', 'computed', 600000, '', 'settled', '2026-11-20', 'seed'],
    ['2026-10', 'TST1', '5002', 'Food Cost', '5000', 'group', 62000, '', 'settled', '2026-11-20', 'seed'],
    ['2026-10', 'TST1', '5185', 'Beer Wine & Liquor Cost', '5000', 'group', 78000, '', 'settled', '2026-11-20', 'seed'],
    ['2026-10', 'TST1', '5190', 'NA Beverage Cost', '5000', 'group', 4100, '', 'settled', '2026-11-20', 'seed'],
    ['2026-10', 'TST1', 'OPERATING_INCOME', 'Operating income', '8000', 'computed', 90000, '', 'settled', '2026-11-20', 'seed']]);` : ''}
  window.__setUser(admin);
})();
// google.script.run / google.script.url, answering asynchronously like the real thing.
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

let html = read('Index.html').replace(/<\?!= include\('([A-Za-z]+)'\); \?>/g, (m, f) => read(f + '.html'));
if (/<\?/.test(html)) throw new Error('An Apps Script scriptlet was left in the page.');
const vue = opt('--vue');
const vueTag = '<script src="https://cdn.jsdelivr.net/npm/vue@3.4.31/dist/vue.global.prod.js"></script>';
if (html.indexOf(vueTag) === -1) throw new Error('Vue script tag not found.');
html = html.replace(vueTag, () => (vue ? '<script>' + noScriptEnd(fs.readFileSync(vue, 'utf8')) + '</script>' : vueTag) +
  '\n<script>' + noScriptEnd(read('tests/gas_mock.js')) + '</script>\n<script>' + noScriptEnd(backend) + '</script>');
fs.writeFileSync(out, html);
console.log('Wrote ' + out + ' (' + names.length + ' server functions)');
