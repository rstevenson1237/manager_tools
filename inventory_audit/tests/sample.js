/*
 * Made-up R365 "Inventory Count Item Details" exports for the tests and the
 * preview, in R365's layout (money as "$1,799.88", negative as "-$2.26").
 * Real exports hold the company's figures and stay out of the repository.
 * Dev-only; shared by inventory_audit/tests and pnl_tracker/tests.
 */
const HEADER = 'Item,UofM,Current Qty,Current $ Cost,Current $ Total,Previous Qty,Prev $ Cost,Prev $ Total,Adjustment,Cost Acct,Inventory Acct,Flag';
const fmt = v => { const a = Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); return (v < 0 ? '-$' : '$') + a; };
const q = v => /[",]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : v;

/** [name, uom, curQty, curCost, prevQty, prevCost, costAcct, invAcct, flag] → CSV text. */
function countCsv(rows) {
  return [HEADER].concat(rows.map(r => {
    const [name, uom, cq, cc, pq, pc, ca, ia, flag] = r;
    const ct = Math.round(cq * cc * 100) / 100, pt = Math.round(pq * pc * 100) / 100;
    return [name, uom, cq.toFixed(2), String(cc), fmt(ct), pq.toFixed(2), String(pc), fmt(pt), fmt(ct - pt), ca, ia, flag || ''].map(q).join(',');
  })).join('\n') + '\n';
}
const W = (name, cq, cc, pq, pc, flag) => [name, 'BTL (750 ML)', cq, cc, pq, pc, 'Wine Cost', 'Wine', flag];
const L = (name, cq, cc, pq, pc, flag) => [name, 'BTL (1 L)', cq, cc, pq, pc, 'Liquor Cost', 'Liquor', flag];
const F = (name, cq, cc, pq, pc, flag, acct) => [name, 'LB', cq, cc, pq, pc, acct || 'Produce', 'Food Inventory', flag];

/**
 * The current month: one item of every kind the rules look for, plus steady
 * filler. Dollar sizes chosen so a handful clear the $1,000 high-impact line.
 */
function currentRows() {
  const rows = [
    W('CABERNET Steady', 10, 30, 10, 30),
    W('MERLOT Gone Missing', 0, 20, 6, 20, 'Assumed 0'),          // not counted, $120
    W('BORDEAUX Not Counted', 0, 95, 12, 95, 'Assumed 0'),        // not counted, $1,140: high impact
    L('VODKA Case Slip', 37.6, 96, 66, 8),                        // ×12, +$3,309: high impact, count fell
    L('GIN Odd Price', 7.7, 337, 6, 60),                          // ×5.6, +$2,133: high impact
    L('RUM Bottle For Case', 24, 2, 20, 24),                      // ÷12
    W('ROSE No Cost', 6, 0, 0, 0),                                // counted, no cost
    W('SYRAH Zero Cost Again', 4, 0, 4, 25),                      // $0 cost, $100 missing
    W('PINOT Price Up', 20, 24, 20, 20),                          // +20%, +$80
    W('CHAMPAGNE Big Drop', 7.5, 90, 20, 90, 'Less than Half'),   // −$1,125: high impact
    W('RIESLING Big Rise', 54.8, 40, 26, 40, 'More than Twice'),  // +$1,152: high impact
    L('TEQUILA Delivery', 30, 45, 12, 45, 'More than Twice'),     // +$810
    L('AMARO Small Swing', 0.9, 30, 0.3, 30, 'More than Twice'),  // flagged by R365, $18: not picked
    W('ZIN New Arrival', 12, 15, 0, 0),                           // new item
    W('CHABLIS Sold Out', 0, 35, 4, 35, '0 Quantity'),            // gone to zero, $140: under $150
    W('BURGUNDY Last Bottle', 0, 1030, 1, 1030, '0 Quantity'),    // gone to zero, $1,030: high impact
    W('PORT Never Stocked', 0, 40, 0, 40),                        // zero both times: ignored
    W('MADEIRA By The Glass', 0.6, 80, 1.2, 80),                  // fractional, $48: not picked
    F('LIME JUICE Bar', 6, 4.5, 5, 4.5, '', 'Grocery and Dry Goods') // food-coded cocktail ingredient
  ];
  for (let i = 1; i <= 30; i++) rows.push(W('FILLER Wine ' + String(i).padStart(2, '0'), 6, 20 + i, 6, 20 + i));
  return rows;
}

/** The month before, so that currentRows() follows it (its previous figures are this month's current). */
function previousRows() {
  return currentRows().map(r => {
    const [name, uom, , , pq, pc, ca, ia] = r;
    const back = { 'MERLOT Gone Missing': 5, 'VODKA Case Slip': 70, 'BORDEAUX Not Counted': 12 }[name];
    return [name, uom, pq, pc, back != null ? back : pq, pc, ca, ia, ''];
  });
}

module.exports = {
  HEADER, countCsv, W, L, F, currentRows, previousRows,
  currentCsv: () => countCsv(currentRows()),
  previousCsv: () => countCsv(previousRows())
};
