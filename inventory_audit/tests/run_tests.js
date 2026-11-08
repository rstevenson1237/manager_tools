/*
 * Tests for Inventory Audit's endpoints (Code.gs, Import.gs with the shared
 * InventoryRules.gs) against the in-memory Apps Script stand-in from
 * pnl_tracker/tests/gas_mock.js. The rules themselves are tested with the
 * P&L Tracker (pnl_tracker/tests/inventory_tests.js), which also checks the
 * two copies of InventoryRules.gs are identical. Run with:
 *   node inventory_audit/tests/run_tests.js
 * All data is made up (sample.js). Dev-only: not part of the Apps Script deploy.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const mock = require('../../pnl_tracker/tests/gas_mock');
const sample = require('./sample');
const { countCsv, W, L, F } = sample;

const ROOT = path.join(__dirname, '..');
const ADMIN = 'robert.stevenson@atlasrestaurantgroup.com';
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + String(e.stack || e.message).split('\n').slice(0, 6).join('\n       ')); process.exitCode = 1; }
}
const same = (a, b, msg) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), msg);

/** A fresh backend with one property ("Sample Grill") whose users are given. */
function app(opts) {
  opts = opts || {};
  const ctx = vm.createContext({ console: console, Math: Math, JSON: JSON, Date: Date });
  mock.installGasMock(ctx, { user: ADMIN });
  ['InventoryRules.gs', 'Code.gs', 'Import.gs'].forEach(f => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f }));
  const p = ctx.addProperty('Sample Grill');
  const other = ctx.addProperty('Harbor House');
  ctx.saveSettings(p.id, { propertyAdmins: ['gm@example.com'], propertyUsers: ['bar@example.com'], noteCategories: ctx.getSettings(p.id).noteCategories });
  ctx.saveSettings(other.id, { propertyAdmins: ['other@example.com'], propertyUsers: [], noteCategories: ['CORRECT'] });
  ctx.id = p.id; ctx.otherId = other.id;
  ctx.ss = () => ctx.getSpreadsheetForProperty_(p.id);
  if (opts.user) ctx.__setUser(opts.user);
  return ctx;
}
const prev = sample.previousCsv(), cur = sample.currentCsv();
const bev = d => d.tabs.filter(t => t.key === 'beverage')[0];
const food = d => d.tabs.filter(t => t.key === 'food')[0];
const noteFor = (a, key, note) => {
  const it = bev(a.getInventoryData(a.id)).review[key];
  return a.saveNotesBatch(a.id, [{ datastore: 'beverage', row: it.row, note: note, expectedItem: it.item }]).results[0];
};

console.log('Inventory Audit: upload');

test('the preview writes nothing and says what the file holds', () => {
  const a = app();
  const pv = a.previewUpload(a.id, cur, 'oct.csv');
  same([pv.kind, pv.rows, pv.tieOuts, pv.tables.map(t => t.key)], ['Beverage', 49, 0, ['beverage']]);
  same([pv.tables[0].review.total, pv.tables[0].review.highImpact, pv.tables[0].existing], [13, 6, null]);
  assert.strictEqual(bev(a.getInventoryData(a.id)).items, 0);
  assert.throws(() => a.previewUpload(a.id, 'Report,Date\nP&L,Oct\n', 'pnl.csv'), /not an R365 Inventory Count/);
});

test('a beverage count goes to the Beverage tab whole, food-coded ingredients included', () => {
  const a = app();
  a.commitUpload(a.id, cur, 'oct.csv');
  const d = a.getInventoryData(a.id);
  same([bev(d).items, food(d).items, bev(d).counts.total, bev(d).upload.file], [49, 0, 13, 'oct.csv']);
  assert.strictEqual(bev(d).totals.current, 17921.5);
  const values = a.ss().getSheetByName('Beverage Count Details').getRange(2, 1, 1, 15).getValues()[0];
  assert.strictEqual(typeof values[2], 'number', 'stored as numbers, not "$1,799.88" text');
});

test('a food count replaces only the Food tab; a full count is split by account', () => {
  const a = app();
  a.commitUpload(a.id, cur, 'bev.csv');
  const foodCsv = countCsv([F('BEEF', 10, 31, 8, 30, '', 'Meat'), F('KALE', 0, 3, 4, 3, '0 Quantity'), F('SALT', 5, 1, 5, 1)]);
  same(a.previewUpload(a.id, foodCsv, 'food.csv').tables.map(t => t.key), ['food']);
  a.commitUpload(a.id, foodCsv, 'food.csv');
  same([bev(a.getInventoryData(a.id)).items, food(a.getInventoryData(a.id)).items], [49, 3]);
  const full = countCsv([W('A', 1, 10, 1, 10), W('B', 1, 10, 1, 10), F('C', 1, 1, 1, 1), F('D', 1, 1, 1, 1)]);
  const pv = a.previewUpload(a.id, full, 'full.csv');
  same([pv.kind, pv.tables.map(t => [t.key, t.items])], ['Full count', [['beverage', 2], ['food', 2]]]);
});

test('next month: follows the count on file and replaces its notes', () => {
  const a = app();
  a.commitUpload(a.id, prev, 'sep.csv');
  a.commitUpload(a.id, cur, 'oct.csv');
  assert.ok(noteFor(a, 'VODKA Case Slip', 'ADJUST - CASE AS BOTTLE PRICE').ok);
  const next = countCsv(sample.currentRows().map(r => [r[0], r[1], r[2], r[3], r[2], r[3], r[6], r[7]]));
  const t = a.previewUpload(a.id, next, 'nov.csv').tables[0];
  same([t.relation.relation, t.lostNotes, t.keptNotes], ['next', 1, 0]);
  a.commitUpload(a.id, next, 'nov.csv');
  assert.strictEqual(bev(a.getInventoryData(a.id)).counts.reviewed, 0);
});

test('a recount (fixed in R365, exported again) keeps notes for items still picked', () => {
  const a = app();
  a.commitUpload(a.id, cur, 'oct.csv');
  noteFor(a, 'VODKA Case Slip', 'ADJUST - CASE AS BOTTLE PRICE');
  noteFor(a, 'GIN Odd Price', 'REVIEW');
  const fixed = countCsv(sample.currentRows().map(r => r[0] === 'VODKA Case Slip' ? [r[0], r[1], r[2], 8, r[4], r[5], r[6], r[7]] : r));
  const t = a.previewUpload(a.id, fixed, 'oct-fixed.csv').tables[0];
  same([t.relation.relation, t.keptNotes, t.lostNotes], ['recount', 1, 1], 'the vodka was fixed, so it is no longer picked');
  a.commitUpload(a.id, fixed, 'oct-fixed.csv');
  const d = bev(a.getInventoryData(a.id));
  same([d.review['GIN Odd Price'].note, d.review['GIN Odd Price'].reviewedBy, !!d.review['VODKA Case Slip']], ['REVIEW', ADMIN, false]);
});

test('files in the wrong order are flagged by the preview', () => {
  const a = app();
  a.commitUpload(a.id, cur, 'oct.csv');
  const t = a.previewUpload(a.id, prev, 'sep.csv').tables[0];
  assert.strictEqual(t.relation.relation, 'unrelated');
  assert.ok(t.relation.differ > 0 && t.relation.examples.length);
});

test('remove all data empties both tabs but keeps the sheets and settings', () => {
  const a = app();
  a.commitUpload(a.id, cur, 'oct.csv');
  same(a.removeAllCountData(a.id), { removed: 1 });
  const d = a.getInventoryData(a.id);
  same([bev(d).items, bev(d).upload, d.settings.propertyUsers], [0, null, ['bar@example.com']]);
  assert.ok(a.ss().getSheetByName('Beverage Count Details') && a.ss().getSheetByName('Food Count Details'));
});

console.log('Inventory Audit: review and notes');

test('the review lists the picked items with their reasons, effects and dollar size', () => {
  const a = app();
  a.commitUpload(a.id, cur, 'oct.csv');
  const d = a.getInventoryData(a.id);
  const t = bev(d);
  same(Object.keys(t.review).length, 13);
  const v = t.review['VODKA Case Slip'];
  same([v.impact, v.priceEffect, v.qtyEffect, v.cats, v.note], [3308.8, 3308.8, -227.2, ['costErrors'], '']);
  assert.ok(v.row >= 2 && /case price entered for one unit/.test(v.reasons[0].text));
  same(t.sections.map(s => s.key), ['notCounted', 'costErrors', 'priceChanges', 'decreases', 'increases', 'wentToZero', 'newItems']);
  same(d.rules, { highImpact: 1000 });
});

test('notes save in a batch, one result per entry, and a moved row is refused', () => {
  const a = app();
  a.commitUpload(a.id, cur, 'oct.csv');
  const t = bev(a.getInventoryData(a.id));
  const v = t.review['VODKA Case Slip'], g = t.review['GIN Odd Price'];
  const res = a.saveNotesBatch(a.id, [
    { datastore: 'beverage', row: v.row, note: 'ADJUST', expectedItem: v.item },
    { datastore: 'beverage', row: g.row, note: 'CORRECT', expectedItem: 'SOMETHING ELSE' },
    { datastore: 'beverage', row: 999, note: 'CORRECT', expectedItem: v.item },
    { datastore: 'nope', row: 2, note: 'CORRECT' }
  ]).results;
  same(res.map(r => r.ok), [true, false, false, false]);
  same([res[1].error, res[2].error], ['row moved — refresh', 'row out of range — refresh']);
  const after = bev(a.getInventoryData(a.id));
  same([after.review['VODKA Case Slip'].note, after.review['VODKA Case Slip'].status, after.counts.reviewed], ['ADJUST', 'adjust', 1]);
  assert.ok(a.saveNotesBatch(a.id, [{ datastore: 'beverage', row: v.row, note: '', expectedItem: v.item }]).results[0].ok);
  same([bev(a.getInventoryData(a.id)).review['VODKA Case Slip'].reviewedBy, bev(a.getInventoryData(a.id)).counts.reviewed], ['', 0]);
});

test('a sheet written by the old import (money as text) still reads', () => {
  const a = app();
  const sheet = a.recreateDatastoreSheet_(a.ss(), 'Beverage Count Details');
  sheet.getRange(2, 1, 1, 15).setValues([['VODKA Case Slip', 'BTL (1 L)', '37.60', '96', '$3,609.60', '66.00', '8', '$528.00', '$3,081.60', 'Liquor Cost', 'Liquor', '', 'ADJUST', 'x', 'y']]);
  const v = bev(a.getInventoryData(a.id)).review['VODKA Case Slip'];
  same([v.curTotal, v.adjustment, v.note], [3609.6, 3081.6, 'ADJUST']);
});

console.log('Inventory Audit: settings and access');

test('settings rows are found by label; old rows are dropped, never duplicated', () => {
  const a = app();
  const sheet = a.ss().getSheetByName('_Config');
  // A workbook from before: Visible Columns as the third row.
  sheet.getRange(2, 1, 4, 2).setValues([['Property Admins', 'gm@example.com'], ['Property Users', ''], ['Visible Columns', 'uom, flag'], ['Note Categories', 'CORRECT, REVIEW']]);
  same(a.getSettings(a.id).noteCategories, ['CORRECT', 'REVIEW']);
  a.saveSettings(a.id, { propertyAdmins: ['gm@example.com'], propertyUsers: [], noteCategories: ['CORRECT', 'ADJUST - X', 'adjust - x'] });
  const labels = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues().map(r => r[0]);
  same(labels, ['Property Admins', 'Property Users', 'Note Categories']);
  same(a.getSettings(a.id).noteCategories, ['CORRECT', 'ADJUST - X']);
  assert.throws(() => a.saveSettings(a.id, { noteCategories: ['LOOKS FINE'] }), /must start with CORRECT, REVIEW, or ADJUST/);
  a.commitUpload(a.id, cur, 'oct.csv');
  a.saveSettings(a.id, { propertyAdmins: [], propertyUsers: [], noteCategories: ['CORRECT'] });
  assert.strictEqual(bev(a.getInventoryData(a.id)).upload.file, 'oct.csv', 'saving settings keeps the upload rows');
  same(a.resetSettings(a.id).noteCategories.length, 11);
});

test('access: users write notes, only admins upload, other properties are off limits', () => {
  const a = app();
  a.commitUpload(a.id, cur, 'oct.csv');
  a.__setUser('bar@example.com');
  same(a.getBootstrap().properties.map(p => [p.name, p.role]), [['Sample Grill', 'user']]);
  assert.ok(noteFor(a, 'GIN Odd Price', 'REVIEW').ok);
  assert.throws(() => a.previewUpload(a.id, cur, 'x.csv'), /Administrator access required/);
  assert.throws(() => a.removeAllCountData(a.id), /Administrator access required/);
  a.__setUser('gm@example.com');
  assert.strictEqual(a.previewUpload(a.id, cur, 'x.csv').rows, 49);
  a.__setUser('other@example.com');
  assert.throws(() => a.getInventoryData(a.id), /do not have access/);
  assert.throws(() => a.commitUpload(a.id, cur, 'x.csv'), /do not have access/);
  a.__setUser('stranger@example.com');
  same(a.getBootstrap().properties, []);
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
