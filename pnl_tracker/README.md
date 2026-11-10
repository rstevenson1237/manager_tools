# P&L Tracker

One web app for a manager who looks after several properties. Upload the
Restaurant 365 P&L each week and again once the month settles. The app keeps
every month in one Google Sheet. For each property and month it builds a
report against budget and last year, flags what moved and why, and shows the
whole portfolio side by side. **Operating income is the headline number.**
The **Inventory** tab is the regional check of each property's month-end
inventory count (section 6). The **Labor** tab is the weekly sales and labor
review (section 7).

It is built the same way as `inventory_audit` and `payroll_audit`: a
standalone Apps Script project, Vue 3 from a CDN, no build step, and
embeddable in Google Sites.

---

## 1. Set up (once)

1. Create a standalone Apps Script project and add these files from this
   folder: `Code.gs`, `Import.gs`, `Parse.gs`, `Budget.gs`, `Store.gs`,
   `Analysis.gs`, `Review.gs`, `InventoryRules.gs`, `InventoryCheck.gs`,
   `InventoryApi.gs`, `Labor.gs`, `LaborApi.gs`, and the HTML
   files `Index`, `InventoryView`, `InventoryScript`, `LaborView` and
   `LaborScript` (named exactly so, without `.html`). Replace `appsscript.json` with the one here
   (Project Settings → "Show appsscript.json"). It turns on the **Drive**
   advanced service (v3), which converts uploaded budget .xlsx files.
2. In the editor, run **`setup()`**. It creates a workbook called
   *P&L Tracker Data* in the script's folder and remembers its ID. To use a
   workbook you already have, run `useExistingWorkbook('<spreadsheet id>')`
   instead.
3. Deploy → New deployment → Web app (execute as you, access: your domain).
   Embed the `/exec` URL in Google Sites like the other apps.
4. Administrators are the global admin list (Script Properties, same as the
   other apps). Add read-only viewers in **Upload & settings → Settings**.
5. Updating an existing install: add the new files, remove `Inventory.gs`,
   then run **`setup()`** once more. It adds the *Inventory Checks* and
   *Inventory Flags* tabs and changes nothing else. The four tabs of the
   earlier inventory review (*Inventory Counts*, *Items*, *Notes*,
   *Reports*) are no longer read. Delete them from the data workbook once
   you no longer need what is in them.
6. Adding the labor review to an existing install: add `Labor.gs`,
   `LaborApi.gs`, `LaborView` and `LaborScript`, replace `Code.gs`,
   `Store.gs`, `Index`, then run **`setup()`** once more. It adds the
   *Labor Weeks*, *Labor Jobs* and *Labor Shifts* tabs and changes nothing
   else.

Properties register themselves the first time an upload contains them
(code and name come from R365, e.g. `ARG1M - Bygone`). Rename or hide them
in Settings.

## 2. What to upload

| File | From R365 | When | What it does |
|---|---|---|---|
| Monthly P&L | *Profit & Loss – Location Side by Side – Period*, all locations, **detailed** preferred (simplified also works) | Weekly during the month, then **15+ days after month end** | Replaces that month for every property in the file |
| Trailing 12 | *Profit & Loss – Trailing 12 Periods*, **one location**, detailed | To fill history (last year, earlier months) | Replaces each month it covers, for that property |
| Budget | The annual budget template, as **.xlsx** or by **Google Sheet ID** | Once a year, or when the budget changes | Replaces that property's budget for the year |

Every upload shows a preview first and writes nothing until you press
**Save**. The preview covers:

- the format it detected, and whether every total adds up (a file that does
  not add up cannot be saved);
- which months and properties are in the file, and the stage each will be
  saved as;
- months already on file that would be replaced, with the lines that changed;
- recurring lines with nothing posted (for example 9100 Management Fee before
  corporate entries are booked).

### Month stages

You confirm the **"data runs through"** date when uploading. That date sets
each month's stage:

| Stage | When | How the report treats it |
|---|---|---|
| Month to date | Data runs through a day inside the month | Budget and last year are cut to the same share of the month (daily sales budget; banquets spread evenly). Only food, beverage and hourly labor are judged, on % of sales. |
| Preliminary | Month ended under 15 days ago | Full report. Missing recurring lines show as "not posted yet". |
| Settled | 15+ days after month end | The official month. Missing recurring lines become warnings. |

The number of days is a setting.

## 3. What is stored

All of it lives in the data workbook. Never edit these tabs by hand; the
app rewrites them.

| Tab | Holds |
|---|---|
| `Actuals` | Category lines (4100, 5002, 7005, 9100 …) and subtotals (NET_SALES, OPERATING_INCOME …): one row per month × property × line. Trends and the portfolio use only this. New R365 categories are picked up automatically. |
| `Detail` | Sub-accounts from detailed uploads (7165 Linen, 9060 Legal …). Used only to explain flags in the period report. |
| `Budget` | Per property and year: the rolled-up lines, every GL row from the 12 MONTH tab, and the daily sales budget. |
| `Tags` | Manager notes on a month, and "timing / accrual" tags on a line. |
| `Uploads` | Who uploaded what and when. |
| `Inventory Checks`, `Inventory Flags` | The inventory check: one row per count, plus the items the rules picked (section 6). |
| `Labor Weeks`, `Labor Jobs`, `Labor Shifts` | The labor review: one row per property and week, per job code, and per employee and job code with the seven days (section 7). |
| `_Config` (hidden) | Viewers, properties, flag rule, inventory reviewers, labor locations and job code groups. |

### Budget mapping

The budget's 12 MONTH tab is rolled up to the P&L category lines in
`BUDGET_LINE_MAP` (`Budget.gs`). This was checked against Bygone's detailed
P&L for Sep–Oct 2026. Notable choices:

- 4100 Gross Sales includes the Facilities Fee (R365 posts it to 4540 Other
  Sales).
- 6110 Management includes the template's CORPORATE ALLOCATIONS row (GL
  6100, a placeholder for corporate salaries), above the line, as R365 posts
  it. Budgets saved before this rule had it as 9010; they are read as 6110.
- 9100 Management Fee sits inside Expenses (7000), as in R365.

### Cost of sales by type

Sales and beverage cost are also shown by type, under their category:
Food, NA Beverage, Liquor, Beer, Wine and Sake Sales under 4100; Liquor
(including 5320 Bar Consumables), Beer, Wine and Sake Cost under 5185.
Actuals come from R365's sub-account detail (a simplified upload has none),
budgets from the template's GL rows (4110, 4210, 4310, 4410, 4510, 4520,
5300, 5320, 5400, 5500, 5520).

Each cost of sales line is a % of its own sales, as R365 and company
reporting show it: 5002 of food sales, 5190 of NA beverage sales, 5300 of
liquor sales (likewise beer, wine, sake), and 5185 of beer, wine, liquor and
sake sales together. Total cost of sales and every other line stay a % of
net sales. Flags, normal ranges, budget pushes and their dollar impacts use
the same basis.

On every budget read, the app checks that net sales match the template's
TOTAL NET row and that operating income matches its NET OPERATING INCOME
in all 12 months.

## 4. How flags work

Only cost categories in sections 5000–8000 are flagged. Lines below
operating income are shown but never flagged.

- **Flagged** when worse than budget by **$2,500 and 10%**, or when the
  line's % of net sales is above its **normal range**. The normal range is
  the last 12 months on file, dropping the highest month, the lowest month,
  and any month tagged as timing.
- **Trend:** the two months before were also over. This is a real problem.
- **Spike:** the months before were fine. Often timing or an accrual; tag it
  if so.
- **New:** the line was near zero for a year and is now recurring.
- **Missing:** a line that posted every recent month (averaging $1,000+)
  has nothing this month.
- **Sub-accounts:** up to 3 explain each flag, $1,000+ worse than their own
  budget GL line. Where the budget has no GL detail (food cost, hourly labor),
  they are compared with the same month last year instead, plus the largest
  offset.

All thresholds are settings. Properties without a budget still get flags from
the normal range once 6 months of history are on file.

### Month, quarter or year to date

The Portfolio and Period report have a **Show** choice: Month, Quarter or
Year to date. A quarter or YTD adds up the months on file in that window.
Budget covers the same months. Last year covers the same months a year
earlier, and is shown only when all of them are on file. If the latest month
is month to date, its budget and last year are cut to the same share of the
month. Flags, missing lines and notes belong to single months, so they appear
only in the Month view. In the portfolio, "Prior" means the previous month,
the previous quarter, or last year's YTD.

In the P&L table, the header row and the Line column stay in view while you
scroll. Drag the handle on the Line header to make the column narrower or
wider (arrow keys work too; double-click resets it). The width is remembered
in that browser.

## 5. Budget review

The **Budget review** tab checks a property's budget for a year before (and
after) it is approved. Pick the property and budget year.

**Status.** A budget uploaded before its year starts is a **draft**. From
1 January of its year it counts as **approved**, with nothing to click. A new
version can be uploaded at any time (Upload & settings); it replaces the one
on file. Who uploaded it, when, and the file name are shown on the review.

**What it is compared with.**
- *Last year*: R365 actuals for the 12 calendar months. Each month comes from
  the year before the budget, or two years before when that month is not on
  file yet. A 2027 budget reviewed in November 2026 uses Nov–Dec 2025 and
  Jan–Oct 2026. Month-to-date uploads are never used.
- *Last budget's track record*: the previous year's budget against that
  year's actuals, for the months on file. For sales, the growth that budget
  assumed against the growth that came in.

**Where the budget pushes.** Sales growth, and every cost category budgeted at
least 0.5 pts of sales better than last year and worth $5,000 or more. Each
one shows what last year's budget asked of the same line and whether it got
there. "Missed last year" marks lines where last year's budget was missed.
Costs budgeted worse than last year are listed as **room in the budget**. The
management fee is never counted as a push, because it is set by contract.

**Looks budgeted incorrectly.** *Likely errors*: a recurring line or
sub-account budgeted at zero, a negative cost, and a management fee off its
usual % of sales. *Checks*: lines budgeted with nothing posted last year, fixed
costs (occupancy, insurance) below last year, payroll taxes off their usual %
of wages, sub-accounts several times last year, months left blank, one
month's cost or labor % out of pattern, sales spread across the year unlike
last year, the workbook's own checks failing, and the workbook's forecast
column not matching R365. Sub-account checks need detailed uploads. They only
cover categories the budget breaks into sub-accounts; food cost, for one, is a
single row. The thresholds are at the top of `Review.gs`.

### Budget template changes (2027)

- **Forecast column.** The 12 MONTH tab now has a "2026 Forecast" column
  (actuals to date plus the rest of the year). It is read and checked against
  R365, but last year always comes from R365.
- **DEC tab.** It has an extra column after the 31st, headed "1" (New Year's
  Day). It is ignored, so it no longer overwrites December 1.
- **Negative sales.** Sales rows below zero, including the meal-period split,
  fail a workbook check. The Bygone's 2027 draft has BAR Beverage Sales
  negative in every month.

## 6. Inventory check

The month-end inventory review happens in two places:

1. **The store team** reviews its count in **Inventory Audit**
   (`inventory_audit`), notes each item, and fixes what is wrong in R365.
2. **The regional manager** exports the same **Inventory Count Item
   Details** from R365 and uploads it here, without the store's notes. This
   is a blind recheck: the same rules pick the items again, and anything
   still worth **$1,000 or more** becomes a question for the store manager.
   On a properly audited count, fewer than 10 should be left.

Both apps use one rules file, `InventoryRules.gs`, copied byte for byte into
each project. The tests fail when the two copies differ. The rules, what is
deliberately not flagged, and why are in `inventory_audit/README.md`
section 4. In short:

- every change splits into a price effect and a quantity effect;
- items are picked and ranked by dollar impact;
- R365's "More than Twice" / "Less than Half" flags are ignored as noise;
- fractional counts and food-coded cocktail ingredients are expected.

### Upload

In **Inventory → Upload**, choose the month the counts close, then choose
several CSV files at once, one per property and count. For each file:

- the **property** is guessed from the file name (a property name or code
  in it); check it;
- the **count name** is suggested from the accounts: Food, Beverage or Full
  count.

Each file is checked as soon as it is chosen, and nothing is saved until you
press **Save**. The check shows:

- how many high-impact items there are, their dollar impact, and the largest;
- whether previous value plus adjustment equals current value on every row;
- **whether it follows last month's check** for the same property and count:
  the file's previous total should be last month's total. A small difference
  means last month's count was edited in R365 after it was checked. A large
  one usually means the months are out of order or the property is wrong;
- whether it replaces a check already on file (same property, count name and
  month). A recount after the store's fixes replaces it;
- a file identical to one already on file for another property or count
  name is refused.

### What is kept

Per count, one row in *Inventory Checks* and the items the rules picked
(about 50) in *Inventory Flags*:

- the row holds totals, the price and quantity split, the checks, and value
  by account and by P&L line;
- each picked item keeps its figures and its questions.

The other items of the export, about 1,450 of a 1,500-item beverage count,
are read, checked and dropped. Uploads add rows at the end; only a
replacement rewrites the tabs.

### Dashboard

One row per property and month: value, change, how many items were picked,
the high-impact items and their dollar impact, and a status (*Clean*,
*N questions*, or *Export does not add up*). The cards show the latest
month across properties.

### Report

One report per property and month covers every count for that month:

- **Questions for the store:** the high-impact items, largest first, each
  with its question(s) and figures. **Last month's flags** add context:
  - *Reverses September's move (+$1,200). Was one of the two counts wrong?*
  - *A cost problem in September too.*
  - *Also picked in September: …*
- **Copy the questions:** the list as plain text, ready to paste into an
  email to the store manager. Also **Print / save as PDF**.
- **Problems with the file:** totals that do not add up, or a count that
  does not follow last month's.
- Inventory value against the last count, split into price and quantity,
  and the KPIs: high-impact items, items picked, not counted, gone to zero,
  counted with no cost, and days on hand.
- The **smaller items** the rules picked (the store reviewed them), shown
  on request.
- **Inventory by account**, with items picked and high impact per line.
- **Against the P&L**, when the month is on file. This covers days on hand
  (inventory ÷ daily cost of sales) and the inventory change as a share of
  the month's cost:
  - food uses 5002 and NA beverage uses 5190;
  - liquor, wine and beer use 5300 / 5500 / 5400 from a detailed upload,
    or 5185 together otherwise.

### Access

| Who | Can |
|---|---|
| Admins | Everything, including removing a check |
| Viewers | Read the dashboard and reports |
| Inventory reviewers (Settings) | Upload counts |

An inventory reviewer who is also a viewer sees everything. One who is not a
viewer sees only the Inventory tab, and the report's P&L comparison is left
out for them.

## 7. Weekly sales and labor review

The **Labor** tab compares each week's sales with the forecast, and labor
with the schedule and the budget. It has four parts: Dashboard, Week, Job
codes and (for admins) Upload.

### Upload

From R365, run **Labor Actual vs Scheduled - Detail** for one week, Monday
to Sunday, for as many locations as you like, and export it as CSV. Upload:

- **the coming week** once its schedule is written. With no hours worked and
  no sales yet, it is saved as a *Schedule*;
- **the past week** once it is over. It is saved as *Actual* (or *In
  progress* if the week has not ended).

The preview shows each location with the property it belongs to. Names are
matched to the P&L properties (a match is remembered). Choose another
property, keep a location as its own (not on the P&L), or skip it. The file
is refused when the employee rows do not add up to their job code, or the
job codes to their location. R365 rounds each row to the cent, so half a
cent a row is allowed.

Uploading a property's week again replaces it. **The original schedule:**
when a week on file is a schedule and the new upload has actuals, the
schedule is kept as the original. R365's own scheduled figures include every
edit made during the week; the original shows what was written before the
week started. The labor goal % columns in the export are not used.

### Groups

Every job code belongs to one group. New codes are grouped by name when first
uploaded; change them in **Job codes** (the change applies to every week on
file).

| Group | Which codes | How they count |
|---|---|---|
| FOH | Servers, bartenders, hosts, bussers, runners, barbacks … (the default) | Hourly labor |
| BOH | Cooks, prep, dish, sushi, pastry, porters, cleaners, facilities, raw bar | Hourly labor |
| Management | Manager, management, MGMT, AGM, GM, chef, restaurant supervisor | Salaried: no pay is listed and nobody clocks in. Only the scheduled hours are shown |
| Not counted | Ghost codes (bar terminals clocking in to pool tips), "Default Generic User" | Left out of every figure |

**Labor %** is hourly pay (FOH + BOH) ÷ net sales. Scheduled % is scheduled
pay ÷ the sales forecast.

### Expectations

- **Sales:** R365's forecast, last year, and the budget (each day's share of
  its month's net sales budget, from the daily sales budget).
- **Labor:** the budget's 6201 FOH and 6209 BOH hourly labor as % of net
  sales, for the days of the week. Without a budget: the property's average
  over its weeks on file in the 8 weeks before (up to 4).
- **Job codes:** scheduled hours against the average actual hours of the
  same recent weeks, allowing for the change in forecast sales.

### Dashboard

Choose a date range and one or more properties (none chosen = all), and
FOH, BOH or both. The cards add up the weeks with actuals: sales against
forecast and last year, labor % against scheduled % and target, pay against
the schedule, and overtime. Two charts show each week: labor % (actual,
scheduled, target) and net sales (actual, forecast, last year). Hover a week
for its figures. The table has one row per property and week; select a row
for its week.

### Week

One property and week:

- **What stands out**, most money first:
  - sales 10%+ off forecast; a missing forecast; a forecast far from last year;
  - FOH or BOH scheduled 1 pt+ over target on the forecast, or run 1 pt+ over
    target on actual sales (hourly as a whole only when neither is out alone);
  - shifts worked that were not on the schedule, and hours worked beyond
    scheduled shifts;
  - overtime, and employees scheduled over 40 hours;
  - job codes worked with nothing scheduled, or scheduled well above recent
    weeks;
  - employees scheduled under a different name than they clock in with.
- **Labor by group**: hours and pay, scheduled and actual, labor % against
  target, and pay above or below target.
- **Job codes**: scheduled, actual and recent hours, overtime, and notes
  (worked unscheduled; 8+ hours and 15%+ over the schedule; scheduled 15%+
  above recent weeks beyond the change in sales).
- **People off the schedule**, front and back of house:
  - a day worked with nothing scheduled. When someone scheduled in the same
    job code that day did not work, it is a **cover**, and only the hours
    beyond the missed shift count as added;
  - a day worked 1.5+ hours longer than scheduled;
  - also listed: covers, and scheduled shifts nobody worked.
  With an original schedule on file, choose to compare with it or with
  R365's schedule at week end.
- **Overtime**: hours over 40 in the week at this property, the estimated
  premium (half the straight-time rate per overtime hour), and whether the
  schedule wrote it in.
- **Schedule changes** since the original, by job code: hours, shifts added
  and removed, and job codes not on the original at all (the schedule may not
  have been finished when it was uploaded).
- **By day**, and the **management schedule**: each manager's scheduled
  hours by day.

**Names.** The schedule and the time clock do not always spell a name the
same way ("Swilling, Kenya Megan" scheduled, "Swilling, Kenya" clocking in;
"Bernadino" and "Bernardino"). Two names in the same week are read as one
person when the last names match, the first names match, start the same, or
differ by a typo, and one name has only scheduled hours and the other only
worked hours. They are listed so the employee record can be fixed.

All thresholds are in `LABOR_RULES` at the top of `Labor.gs`.

### Access

Admins and viewers read everything. Only admins upload, change job code
groups or remove a week. The inventory-only role does not see this tab.

## 8. Code layout

| File | Role | Uses Apps Script services? |
|---|---|---|
| `Parse.gs` | Reads the three R365 CSV formats; checks every total ties out | No |
| `Budget.gs` | Reads the budget template; .xlsx conversion at the bottom | Only the last two functions |
| `Store.gs` | Sheet layouts; upload ⇄ sheet rows ⇄ in-memory store | No |
| `Analysis.gs` | Period report, flags, portfolio, trends | No |
| `Review.gs` | Budget review | No |
| `InventoryRules.gs` | Reads the inventory count export and picks what to question. **The same file as inventory_audit's** | No |
| `InventoryCheck.gs` | The regional check: summary per count, comparison with last month, report, sheet rows | No |
| `InventoryApi.gs` | Inventory endpoints: upload, dashboard, report | Yes |
| `Labor.gs` | Reads the labor export; groups, expectations, dashboard rows, the week report | No |
| `LaborApi.gs` | Labor endpoints: upload, dashboard, week report, job codes | Yes |
| `Import.gs` | Upload endpoints (preview / commit) | Yes |
| `Code.gs` | Setup, access, settings, read endpoints | Yes |
| `Index.html` | Portfolio, Period report, Trends, Budget review, Upload & settings | — |
| `InventoryView.html`, `InventoryScript.html` | The Inventory tab (pulled into `Index.html` with `include()`) | — |
| `LaborView.html`, `LaborScript.html` | The Labor tab (likewise) | — |

### Tests

```bash
node pnl_tracker/tests/run_tests.js
```

The tests load the service-free files into Node and run them against made-up
exports that copy R365's layout, including its quirks: repeated group names,
three-level nesting, and blank amounts. Real exports hold the company's
financials, so they are kept out of the repository.

The inventory tests (`tests/inventory_tests.js`, run by the same command)
test the shared rules, check that the two copies of `InventoryRules.gs`
match, and run the endpoint files against `tests/gas_mock.js`. That file is
an in-memory stand-in for SpreadsheetApp, LockService and the other
services. The made-up count exports are in `inventory_audit/tests/sample.js`.

The labor tests (`tests/labor_tests.js`, also run by the same command) use
made-up exports in R365's layout from `tests/labor_sample.js`.

To click through the app without deploying, build a preview page. It runs
every `.gs` file in the browser against the same stand-in:

```bash
node pnl_tracker/tests/preview.js /tmp/preview.html --pnl
```

Add `--user bar@example.com` to see the inventory-only role, and
`--prop CODE:Name` to add a property, for example to upload real exports. Add
`--vue <file>` to inline Vue when offline.
