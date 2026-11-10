/*******************************************************************************
 * LaborApi.gs — the weekly sales and labor review's endpoints. The logic is
 * in Labor.gs; this file reads and writes the three labor sheets (Store.gs
 * SHEETS.laborWeeks / laborJobs / laborShifts) and the labor settings in
 * _Config (which property each export location is, the group of each job
 * code).
 *
 * WHO CAN DO WHAT
 *   read      admins and viewers (not the inventory-only role)
 *   upload, job code groups, remove   admins only
 *
 * UPLOADS. One export covers one week and any number of locations. Each
 * location × week replaces what is on file for that property and week. When
 * the week on file is a schedule (uploaded before the week had actuals) and
 * the new upload has actuals, the schedule on file is kept as the original
 * schedule. New job codes get their guessed group saved, so a later change to
 * the guess never reclassifies past weeks.
 ******************************************************************************/

/** ------------------------------------------------------------- reading */
function readLaborWeeks_(ss) { return readDataRows_(ss, 'laborWeeks').map(laborWeekFromRow_); }
function readLaborJobs_(ss) { return readDataRows_(ss, 'laborJobs').map(laborJobFromRow_); }

/** { 'property|week': jobs[] } */
function laborJobsByWeek_(jobs) {
  const by = {};
  jobs.forEach(function (j) { (by[j.property + '|' + j.week] = by[j.property + '|' + j.week] || []).push(j); });
  return by;
}

/** Only the budget rows: enough for laborBudgetWeek_. */
function laborBudgetStore_(ss, config) {
  return rowsToStore_({ budget: readDataRows_(ss, 'budget') }, JSON.parse(JSON.stringify(config.properties || [])), config.rules);
}

/** Properties a week can belong to: configured ones, plus any with labor on file. */
function laborProperties_(config, weeks) {
  const list = (config.properties || []).map(function (p) { return { code: p.code, name: p.name, active: p.active !== false }; });
  const known = {};
  list.forEach(function (p) { known[p.code] = true; });
  (weeks || []).forEach(function (w) {
    if (!known[w.property]) { list.push({ code: w.property, name: w.location || w.property, active: true, laborOnly: true }); known[w.property] = true; }
  });
  return list.sort(function (a, b) { return a.name.localeCompare(b.name); });
}

/** ------------------------------------------------------------- dashboard */

/** Every property-week on file, figures by group, newest first. The page filters by property and date range. */
function getLaborDashboard() {
  const ss = dataSpreadsheet_();
  const role = requireViewer_(ss);
  const config = readConfig_(ss);
  const groupOf = laborGroupFn_(config.labor.jobs);
  const weeks = readLaborWeeks_(ss);
  const jobs = laborJobsByWeek_(readLaborJobs_(ss));
  const store = laborBudgetStore_(ss, config);
  const rows = weeks.map(function (w) {
    return laborSummary_(w, jobs[w.property + '|' + w.week] || [], groupOf, laborBudgetWeek_(store, w.property, w.week));
  }).sort(function (a, b) { return b.week.localeCompare(a.week) || a.property.localeCompare(b.property); });
  return safe_({ isAdmin: role === 'admin', rows: rows, properties: laborProperties_(config, weeks), rules: LABOR_RULES, today: today_() });
}

/** ------------------------------------------------------------- upload */

/**
 * Read an export and work out, per location, which property it is, its
 * stage, and what it replaces. Writes nothing.
 * @param {Object=} mapping  { location: property code, or '' to skip }
 */
function laborUploadPlan_(ss, csvText, mapping) {
  const parsed = parseLaborCsv_(Utilities.parseCsv(String(csvText || '')));
  const config = readConfig_(ss);
  const weeks = readLaborWeeks_(ss);
  const props = laborProperties_(config, weeks);
  const today = today_();
  mapping = mapping && typeof mapping === 'object' ? mapping : {};
  const seen = {};
  const locations = parsed.locations.map(function (loc) {
    const guess = guessLaborProperty_(loc.location, props, config.labor.locations);
    const code = Object.prototype.hasOwnProperty.call(mapping, loc.location) ? String(mapping[loc.location] || '').trim() : (guess || loc.location);
    const existing = code ? weeks.filter(function (w) { return w.property === code && w.week === parsed.week; })[0] || null : null;
    const stage = laborStage_(loc, parsed.end, today);
    const keepsOriginal = !!(existing && (existing.originalAt || (existing.stage === 'schedule' && stage !== 'schedule')));
    const twice = !!(code && seen[code]);
    if (code) seen[code] = true;
    return { loc: loc, code: code, guess: guess, matched: !!guess, existing: existing, stage: stage, keepsOriginal: keepsOriginal,
      makesOriginal: !!(existing && !existing.originalAt && existing.stage === 'schedule' && stage !== 'schedule'), twice: twice };
  });
  const known = config.labor.jobs;
  const newJobs = {};
  parsed.locations.forEach(function (loc) {
    Object.keys(loc.jobs).forEach(function (j) { if (!known[laborJobKey_(j)]) newJobs[laborJobKey_(j)] = j; });
  });
  return { parsed: parsed, config: config, properties: props, locations: locations, newJobs: newJobs, today: today };
}

/** Admin. What a labor export holds, by location, and what saving it would replace. */
function previewLaborUpload(csvText, fileName, mapping) {
  const ss = dataSpreadsheet_();
  requireAdmin_(ss);
  const plan = laborUploadPlan_(ss, csvText, mapping);
  const groupOf = laborGroupFn_(plan.config.labor.jobs);
  const store = laborBudgetStore_(ss, plan.config);
  return safe_({
    fileName: String(fileName || ''), week: plan.parsed.week, end: plan.parsed.end, rows: plan.parsed.rows,
    tieOuts: plan.parsed.tieOuts, warnings: plan.parsed.warnings, properties: plan.properties,
    newJobs: Object.keys(plan.newJobs).sort().map(function (k) { return { job: plan.newJobs[k], group: guessLaborGroup_(plan.newJobs[k]) }; }),
    locations: plan.locations.map(function (l) {
      const jobs = Object.keys(l.loc.jobs).map(function (j) { return { job: j, totals: l.loc.jobs[j] }; });
      const sum = laborSummary_({ week: plan.parsed.week, end: plan.parsed.end, property: l.code, location: l.loc.location, stage: l.stage,
        sales: l.loc.sales, totals: l.loc.totals }, jobs, groupOf, l.code ? laborBudgetWeek_(store, l.code, plan.parsed.week) : null);
      return { location: l.loc.location, property: l.code, guess: l.guess, matched: l.matched, stage: l.stage, rows: l.loc.rows,
        employees: Object.keys(l.loc.shifts.reduce(function (o, s) { o[s.employee] = 1; return o; }, {})).length,
        jobs: jobs.length, summary: sum, twice: l.twice, makesOriginal: l.makesOriginal,
        existing: l.existing ? { stage: l.existing.stage, uploadedAt: l.existing.uploadedAt, uploadedBy: l.existing.uploadedBy, originalAt: l.existing.originalAt } : null };
    })
  });
}

/** Admin. Save every location that has a property; skip the ones mapped to ''. */
function commitLaborUpload(csvText, fileName, mapping) {
  const ss = dataSpreadsheet_();
  requireAdmin_(ss);
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); }
  catch (e) { throw new Error('Another upload is being saved. Try again in a moment.'); }
  try {
    const plan = laborUploadPlan_(ss, csvText, mapping);
    if (plan.parsed.tieOuts.length) throw new Error('Not saved: the export does not add up (' + plan.parsed.tieOuts[0] + ') Export it again from R365.');
    const save = plan.locations.filter(function (l) { return l.code; });
    if (!save.length) throw new Error('Nothing to save: choose a property for at least one location.');
    const twice = save.filter(function (l) { return l.twice; })[0];
    if (twice) throw new Error('Two locations are set to the same property (' + twice.code + '). Choose a different property or skip one.');
    const week = plan.parsed.week;
    const at = new Date().toISOString(), who = currentUserEmail_(), id = Utilities.getUuid().slice(0, 8);
    const drop = {}, toOriginal = {};
    save.forEach(function (l) { if (l.existing) drop[l.code] = true; if (l.makesOriginal) toOriginal[l.code] = true; });
    const isDropped = function (r) { return Object.prototype.hasOwnProperty.call(drop, String(r[1])) && laborDate_(r[0]) === week; };

    const weekRows = save.map(function (l) {
      return laborWeekRow_({ week: week, end: plan.parsed.end, property: l.code, location: l.loc.location, stage: l.stage,
        sales: l.loc.sales, totals: l.loc.totals,
        originalAt: l.existing ? (l.existing.originalAt || (l.makesOriginal ? l.existing.uploadedAt : '')) : '',
        uploadedAt: at, uploadedBy: who, file: String(fileName || ''), uploadId: id });
    });
    let jobRows = [], shiftRows = [];
    save.forEach(function (l) {
      jobRows = jobRows.concat(laborJobRows_(week, l.code, l.loc));
      shiftRows = shiftRows.concat(laborShiftRows_(week, l.code, 'final', l.loc.shifts));
    });

    if (Object.keys(drop).length) {
      writeDataRows_(ss, 'laborWeeks', readDataRows_(ss, 'laborWeeks').filter(function (r) { return !isDropped(r); }).concat(weekRows));
      writeDataRows_(ss, 'laborJobs', readDataRows_(ss, 'laborJobs').filter(function (r) { return !isDropped(r); }).concat(jobRows));
      // The schedule on file becomes the original schedule; an original already on file stays.
      const kept = [];
      readDataRows_(ss, 'laborShifts').forEach(function (r) {
        if (!isDropped(r)) { kept.push(r); return; }
        if (String(r[2]) === 'original') { kept.push(r); return; }
        if (toOriginal[String(r[1])]) { const c = r.slice(); c[2] = 'original'; kept.push(c); }
      });
      writeDataRows_(ss, 'laborShifts', kept.concat(shiftRows));
    } else {
      appendDataRows_(ss, 'laborWeeks', weekRows);
      appendDataRows_(ss, 'laborJobs', jobRows);
      appendDataRows_(ss, 'laborShifts', shiftRows);
    }

    // Remember the location mapping and the group of every new job code.
    const config = readConfig_(ss);
    save.forEach(function (l) { config.labor.locations[l.loc.location] = l.code; });
    Object.keys(plan.newJobs).forEach(function (k) { if (!config.labor.jobs[k]) config.labor.jobs[k] = guessLaborGroup_(plan.newJobs[k]); });
    writeConfig_(ss, config);

    appendDataRow_(ss, 'uploads', [id, at, who, String(fileName || ''), 'labor', '', week, save.map(function (l) { return l.code; }).join(', '),
      plan.parsed.rows, save.map(function (l) { return l.code + ' ' + l.stage + (l.existing ? ' (replaced ' + String(l.existing.uploadedAt).slice(0, 10) + ')' : ''); }).join('; ')]);
    SpreadsheetApp.flush();
    return safe_({ week: week, saved: save.map(function (l) { return { property: l.code, location: l.loc.location, stage: l.stage, replaced: !!l.existing, original: l.makesOriginal }; }),
      skipped: plan.locations.filter(function (l) { return !l.code; }).map(function (l) { return l.loc.location; }) });
  } finally {
    lock.releaseLock();
  }
}

/** Admin. Remove one property's week (and its original schedule). */
function removeLaborWeek(property, week) {
  const ss = dataSpreadsheet_();
  requireAdmin_(ss);
  property = String(property); week = laborDate_(week);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const keep = function (r) { return !(String(r[1]) === property && laborDate_(r[0]) === week); };
    const rows = readDataRows_(ss, 'laborWeeks');
    if (rows.every(keep)) return { removed: false };
    writeDataRows_(ss, 'laborWeeks', rows.filter(keep));
    writeDataRows_(ss, 'laborJobs', readDataRows_(ss, 'laborJobs').filter(keep));
    writeDataRows_(ss, 'laborShifts', readDataRows_(ss, 'laborShifts').filter(keep));
    return { removed: true };
  } finally {
    lock.releaseLock();
  }
}

/** ------------------------------------------------------------- week report */

/** The week report for one property. */
function getLaborWeek(property, week) {
  const ss = dataSpreadsheet_();
  const role = requireViewer_(ss);
  property = String(property); week = laborDate_(week);
  const config = readConfig_(ss);
  const weeks = readLaborWeeks_(ss).filter(function (w) { return w.property === property; });
  const w = weeks.filter(function (x) { return x.week === week; })[0];
  if (!w) return safe_({ report: null, isAdmin: role === 'admin' });
  const jobs = laborJobsByWeek_(readLaborJobs_(ss).filter(function (j) { return j.property === property; }));
  const shifts = readDataRows_(ss, 'laborShifts').filter(function (r) { return String(r[1]) === property && laborDate_(r[0]) === week; })
    .map(laborShiftFromRow_);
  // Recent = past weeks in the 8 weeks before this one: older weeks say little about this week's needs.
  const since = laborAddDays_(week, -7 * 8);
  const recent = weeks.filter(function (x) { return x.week < week && x.week >= since && x.stage === 'actual'; })
    .sort(function (a, b) { return b.week.localeCompare(a.week); }).slice(0, LABOR_RULES.recentWeeks)
    .map(function (x) { return { week: x, jobs: jobs[property + '|' + x.week] || [] }; });
  const report = buildLaborWeekReport_({
    week: w, jobs: jobs[property + '|' + week] || [],
    shifts: shifts.filter(function (s) { return s.kind !== 'original'; }),
    original: shifts.filter(function (s) { return s.kind === 'original'; }),
    recent: recent, groupOf: laborGroupFn_(config.labor.jobs),
    budget: laborBudgetWeek_(laborBudgetStore_(ss, config), property, week)
  });
  return safe_({ report: report, isAdmin: role === 'admin' });
}

/** ------------------------------------------------------------- job codes */

/** Every job code on file with its group, where it is used, and its hours over the last 8 weeks on file. */
function getLaborJobCodes() {
  const ss = dataSpreadsheet_();
  const role = requireViewer_(ss);
  const config = readConfig_(ss);
  const groupOf = laborGroupFn_(config.labor.jobs);
  const jobs = readLaborJobs_(ss);
  const allWeeks = Array.from(new Set(jobs.map(function (j) { return j.week; }))).sort().reverse();
  const since = allWeeks[Math.min(7, allWeeks.length - 1)] || '';
  const by = {};
  jobs.forEach(function (j) {
    const k = laborJobKey_(j.job);
    const x = by[k] = by[k] || { key: k, job: j.job, group: groupOf(j.job), saved: !!config.labor.jobs[k], guess: guessLaborGroup_(j.job),
      properties: [], lastWeek: '', schHrs: 0, actHrs: 0, schPay: 0, actPay: 0 };
    if (x.properties.indexOf(j.property) === -1) x.properties.push(j.property);
    if (j.week > x.lastWeek) x.lastWeek = j.week;
    if (j.week >= since) { x.schHrs += j.totals.s; x.actHrs += j.totals.a + j.totals.o; x.schPay += j.totals.sa; x.actPay += j.totals.aa + j.totals.oa; }
  });
  const list = Object.keys(by).map(function (k) {
    const x = by[k];
    ['schHrs', 'actHrs', 'schPay', 'actPay'].forEach(function (f) { x[f] = laborRound_(x[f]); });
    return x;
  }).sort(function (a, b) { return a.job.toLowerCase().localeCompare(b.job.toLowerCase()); });
  return safe_({ isAdmin: role === 'admin', jobs: list, groups: LABOR_GROUPS, weeks: Math.min(8, allWeeks.length) });
}

/** Admin. Set job code groups: { job code: 'FOH' | 'BOH' | 'MGMT' | 'NONE' }. */
function saveLaborJobGroups(changes) {
  const ss = dataSpreadsheet_();
  requireAdmin_(ss);
  if (!changes || typeof changes !== 'object') throw new Error('saveLaborJobGroups: invalid payload.');
  const valid = {};
  LABOR_GROUPS.forEach(function (g) { valid[g.key] = true; });
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const config = readConfig_(ss);
    Object.keys(changes).forEach(function (job) {
      const g = String(changes[job]);
      if (!valid[g]) throw new Error('Unknown group ' + g + ' for ' + job + '.');
      config.labor.jobs[laborJobKey_(job)] = g;
    });
    writeConfig_(ss, config);
  } finally {
    lock.releaseLock();
  }
  return getLaborJobCodes();
}
