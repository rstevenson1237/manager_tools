# Payroll Audit — Multi-Property Sheet-as-Database + Web App

One **standalone** Apps Script project serves **every property** from a single
deployment — the same architecture as the sibling `inventory_audit` app in
this repo. Each property is its own Google Sheet workbook (a pure data
store); the script opens the right workbook per request based on which
property the signed-in user is working in. All reconciliation logic — the
Hours matching, the day-by-day payments breakdown, withholding, and pooled
withholding — live in the Apps Script web app. Managers never open a sheet;
the only sheet-side actions are the one-time setup tasks (run from the Apps
Script editor) and the three CSV uploads (done from inside the app).

This app replaces a spreadsheet + Apps Script "Payroll Data Uploader" tool
that used `SUMIFS`/`QUERY`/`VLOOKUP` formulas across `Toast`, `PDP`,
`Payments`, `Hours`, and `Audit` sheets to reconcile PDP payroll against
Toast POS data for a pay period. Every one of those formulas has been
re-implemented here in code (see §8) and was validated against a real pay
period's cached spreadsheet output before this app was written — the ported
logic reproduces the legacy totals exactly, including the same 5 employees
the legacy sheet flagged as unmatched for that period. UI is **not** 1:1 with
the old spreadsheet — the single `Audit` sheet is presented as **four
focused views** instead of one wide table (see §5).

---

## 1. Frontend: Vue 3, no build step (same choice as inventory_audit)

The UI is built with **Vue 3**, loaded from a CDN
(`vue@3.4.31/dist/vue.global.prod.js`) directly in `Index.html` — no build
step, no npm, no bundler. This is a deliberate constraint, not a limitation:
the app is served through `HtmlService` at a first-party `…/exec` URL, which
is what lets it be **embedded in Google Sites** with the viewer's Google
identity flowing through automatically. A separately-hosted SPA (Vite build,
its own host) would need its own OAuth flow and would very likely break
identity inside a cross-origin Google Sites iframe — the exact restriction
this project's original framework was built around. See `inventory_audit`'s
README §1 for the fuller trade-off writeup; the reasoning is identical here.

---

## 2. Multi-property architecture

**1 workbook = 1 property.** The script is standalone (not bound to any
single Sheet), so it can open any property's workbook by ID on demand.
Identical model to `inventory_audit`:

1. **Global admin** — a small list stored in this script project's **Script
   Properties**. Admin on *every* property, always. Seeded with a hardcoded
   default (`rstevenson1237@gmail.com`) on first run; editable afterwards
   from the Settings panel or `getGlobalAdmins`/`saveGlobalAdmins`.
2. **Property admin** — per property. Can upload/replace/remove data, edit
   manual-entry figures, and edit settings for *that property only*.
3. **Property user** — per property. View-only access to that property.

Property admin/user lists live in a hidden **`_Config`** sheet inside each
property's own workbook (see §3), separate from the global admin list and
the property registry (also Script Properties, `{ id, name, spreadsheetId }`
per property, maintained via `addProperty`/`addExistingProperty`/
`removeProperty`/`listProperties` run from the Apps Script editor — no
spreadsheet menu, same as inventory_audit).

The property picker works the same way too: `getBootstrap()` returns every
property the signed-in user can access; a single-property account skips the
picker; `?property=<id>` on the `/exec` URL pre-selects a property for a
Google Sites embed.

---

## 3. Per-property configuration — the `_Config` sheet

Each property's admins, users, company code, and manual-entry figures are
stored as plain rows in a hidden sheet named **`_Config`**:

```
Setting             | Value
--------------------|---------------------------------------------
Property Admins     | alice@company.com, bob@company.com
Property Users      | carol@company.com, dave@company.com
Company Code        | QPI
Pooled Withholding  | [{"label":"Pool 1","poolServers":["AM Bar","Indoor Bar","Outdoor Bar"],"jobClass":"Bartender"}, ...]
PDP Manual Totals   | {"2026-07-06":{"addlTips":0,"cashSvc":0,"ccFee":0,"ccSvc":0,"declared":0}, ...}
Sales Summary       | [{"label":"Net Sales","value":12345.67}, ...]
```

Simple lists (admins/users) stay comma-separated and hand-editable, same as
inventory_audit. The three structured values (pooled withholding config,
PDP manual totals, sales summary) are JSON in the Value cell — not something
a human would want to hand-edit as a comma list, but still visible and
fixable directly in Sheets in an emergency (unhide via **View → Hidden
sheets**), or restorable via **Settings → Reset to defaults**.

---

## 4. The three CSV uploads

Raw data lives in three plain import sheets per property — `PDP`, `Toast`,
`Payments` — each just a straight column-for-column copy of the uploaded
CSV. Uploading is admin-gated, validates the CSV **before** touching
anything (a bad file destroys nothing), and each of the three uploads is
independent — replacing Payments does not touch PDP or Toast.

| Upload | Target sheet | Required columns |
|---|---|---|
| PDP Payroll Export | `PDP` | `Co Code`, `Employee`, `Hours`, `Amount` |
| Toast Labor Summary | `Toast` | `Employee`, `Job Title`, `Regular Hours`, `Overtime Hours` |
| Toast Payments | `Payments` | `Order Date`, `Server`, `Tip`, `Gratuity`, `Status`, `Type` |

`Order Date` is parsed into a real Date value on upload (not stored as text)
so the Business Date bucketing in §8 is exact regardless of the export's
date-string format.

---

## 5. The four views

The legacy spreadsheet's single wide `Audit` sheet is split into four
focused tabs:

1. **Day-by-Day Audit** — the 14-day matrix: Credit/Cash/Other Tips & Grat,
   Withholding, Voids, Denied, Refunds, and Toast Total, one column per pay
   period day plus a Total column. Read-only.
2. **Totals Audit** — the same rows collapsed to period totals, the
   **PDP daily manual-entry grid** (Addl Tips / Cash SVC / CC Fee / CC SVC /
   Declared per day, admin-editable), the PDP-vs-Toast total comparison, and
   the free-form **Sales Summary** (admin-editable label/value rows).
3. **Error Reporting** — the Hours reconciliation table (PDP vs Toast hours
   per employee, color-coded by status) plus the **Unmatched Employees**
   list (every non-Match row, surfaced up front).
4. **Employee Withholding** — the per-server 2% withholding table and its
   grand total, plus the three independent **pooled withholding**
   calculators (admin-editable pool server list + job class per pool).

---

## 6. Manual-entry inputs (persisted per property, admin-only)

These are the only values this app writes back to `_Config` — everything
else (Hours, daily/totals, per-server and pooled withholding) is computed
fresh from the raw CSVs on every load.

- **Company Code** — the expected `Co Code` value; drives the "Wrong
  Company Code" status in the Hours view.
- **PDP daily totals** — per pay-period day: `Addl Tips`, `Cash SVC`,
  `CC Fee`, `CC SVC`, `Declared`. PDP Total for a day = `Addl Tips + Cash SVC
  + CC SVC` (CC Fee and Declared are informational only, matching the legacy
  `Audit!B19` formula). Source: PDP → Calculated Data → TOTALS (DAILY) →
  Gratuity Income.
- **Sales Summary** — up to 10 free-form label/value rows, for cross-
  checking against a POS Sales Summary report.
- **Pooled withholding config** — 3 independent `{ label, poolServers[],
  jobClass }` entries (e.g. pool = "AM Bar, Indoor Bar, Outdoor Bar", job
  class = "Bartender").

---

## 7. Access model & auth

Identical to `inventory_audit`: `Session.getActiveUser().getEmail()` against
the global admin list (Script Properties) and each property's `Property
Admins`/`Property Users` rows (`_Config`). Deployed as *Me* + *Anyone within
your domain*, this reliably resolves the real signed-in email inside your
Workspace domain. A viewer whose email can't be resolved (e.g. a personal
Gmail account outside the domain) is treated as having no access. Every
manual-entry save and every CSV upload independently re-checks admin status
for the active property (`requireAdmin_`), so a non-admin — or an admin of a
*different* property — can't write data even by bypassing the hidden UI.

---

## 8. The reconciliation logic — ported from the legacy formulas

All of the following live in `Code.gs`'s `COMPUTE` section as pure functions
(no `SpreadsheetApp` calls), so they can be unit-tested in isolation. They
were validated during development against a real pay period's cached
spreadsheet output (Node harness, not part of this deploy) and reproduce
every legacy total exactly.

**Name standardization** (`standardizePdpName_`, `standardizeToastName_`) —
PDP names have newlines replaced with spaces; Toast names (`"Last, First"`)
have commas replaced with spaces; both then collapse repeated whitespace and
trim. The legacy sheet's `SUBSTITUTE`+`TRIM` formulas didn't collapse
internal double-spaces, an occasional source of false "Missing" mismatches
on irregularly-spaced source data — this port fixes that (collapsing
whitespace only ever helps equality, never breaks a legitimate match).

**Business Date** (`businessDate_`) — `INT(OrderDate − 5 hours)`: a sale
after midnight but before 5:00am is bucketed into the prior calendar day, so
a late-night closing shift reports against the day it started.

**Hours view** (`computeHours_`) — for every employee name (union of PDP and
standardized-Toast names): `pdpHours` = Σ PDP Hours for that name;
`toastHours` = Σ (Regular + Overtime) for that name. Status, in order:
`pdpHours==0` → **Missing from PDP**; else `toastHours==0` → **Missing from
Toast**; else `abs(pdp−toast)>1` → **Hours Mismatch T:{toast} P:{pdp}**; else
Co Code ≠ configured Company Code → **Wrong Company Code (…)**; else
**Match**. `computeUnmatched_` is just every non-Match row.

**Day-by-day / totals** (`computeDaily_`) — pay period = 14 days starting at
the earliest Business Date across all Payments rows. Per day: Credit/Cash/
Other-Tips and -Grat sum `Tip`/`Gratuity` by `Type` (`Other` bucket also
includes `House Account`); Voids sums Tip+Gratuity where `Status` is
`VOIDED` or `DENIED`; Denied is the `DENIED` subset alone (the legacy sheet's
formula double-counted this row — a copy/paste artifact fixed here, and it
doesn't affect Withholding or Toast Total, which never referenced it);
Refunds is `Status=REFUNDED` (informational, not subtracted from Toast
Total, matching the legacy behavior); Withholding = `(Σ tips&grat − Voids) ×
0.02`; Toast Total = `Σ tips&grat − (Withholding + Voids)`.

**Per-server withholding** (`computePerServerWithholding_`) — group Payments
by `Server`, sum `(Tip+Gratuity) × 0.02` where `Type` is `Other` or `Cash`.
The grand total is the "2% Withholding Addition for Payroll."

**Pooled withholding** (`computePooled_`) — for a `{ poolServers[], jobClass
}` config: pool total = Σ per-server 2% amounts for the listed servers;
per-employee = pool total ÷ (count of unique Toast employees whose `Job
Title` matches `jobClass`, company-wide, not filtered by anything else).

---

## 9. Per-property workbook schema

```
PDP
Row 1 (header, frozen): Co Code | Employee | Hours | Amount

Toast
Row 1 (header, frozen): Employee | Job Title | Regular Hours | Overtime Hours

Payments
Row 1 (header, frozen): Order Date | Server | Tip | Gratuity | Status | Type

_Config (hidden)
Row 1 (header, frozen): Setting | Value
Row 2+ : Property Admins | Property Users | Company Code | Pooled Withholding
         | PDP Manual Totals | Sales Summary
```

All three data sheets are pure CSV mirrors this app itself writes (via
`Import.gs`) — no app-managed columns, no notes, nothing a manager edits by
hand in the sheet. Each upload deletes-and-recreates its one sheet pristine,
so a period's data is a clean slate, not a merge with the prior period.

---

## 10. Files

| File | Role |
|---|---|
| `Code.gs` | Backend: `doGet`, global store + registry (Script Properties), `_Config` sheet helpers, three-tier auth, the pure reconciliation/compute functions (§8), `getPayrollData` (the one-call read for all four views), manual-entry save endpoints (`saveCompanyCode`/`savePdpManualTotals`/`saveSalesSummary`/`savePooledConfig`), settings (`getSettings`/`saveSettings`/`resetSettings`), `getBootstrap`, global-admin management, property-management functions (`addProperty`, `addExistingProperty`, `removeProperty`, `listProperties`). |
| `Index.html` | The entire interface served into the web app — a Vue 3 app: bootstrap/property picker, admin bar (Company Code + 3 CSV uploads + remove-all), the four tabbed views, and the Settings panel. |
| `Import.gs` | Admin-gated, property-aware server functions the web app calls: `getExistingDataSummary`, `processPdpCsv`, `processToastCsv`, `processPaymentsCsv`, `removeAllPayrollData`. No spreadsheet menu. |
| `appsscript.json` | Manifest: web-app deployment + scopes. Uses the full `spreadsheets` scope (not `.currentonly`) since the script opens many workbooks by ID. |

Everything — CSV upload, review, and manual-entry figures — happens inside
the web app. **No one ever opens a property's spreadsheet** day-to-day
(setup/property-management runs from the Apps Script editor once per
property, same as inventory_audit).

---

## 11. Step-by-step implementation

### A. Install the code
1. Go to [script.google.com](https://script.google.com) → **New project**
   (a **standalone** script — do not create it from within a Sheet).
2. Add the files: `Code.gs`, `Import.gs` (script); `Index.html` (HTML, named
   exactly `Index`). In **Project Settings**, show and replace
   `appsscript.json` with the provided manifest.
3. The seed global admin (`rstevenson1237@gmail.com`) lives in
   `DEFAULT_GLOBAL_ADMINS` in `Code.gs`. Change it there before first deploy
   if a different account should be the initial admin, or sign in as that
   account once deployed and add co-admins from the Settings panel.

### B. Deploy the web app
4. **Deploy → New deployment → Web app.**
   - **Execute as:** *Me* (the owner) — so managers need no access to any
     property's sheet.
   - **Who has access:** *Anyone within [your domain]*.
   Approve the OAuth prompt (Spreadsheets, email identification, script
   storage). Copy the **/exec** URL.

### C. Create your first property
5. In the Apps Script editor, select `addProperty` from the function
   dropdown (edit the call to pass a name, e.g. `addProperty("Maximon")`)
   and **Run**. Check **Executions** (or **View → Logs**) for the returned
   `{ id, name, spreadsheetId, url }`.
6. Open the `/exec` URL. As a global admin with exactly one property, the
   app loads straight into it. The **Admin** bar appears →
   set the **Company Code**, then upload the PDP export, Toast Labor
   Summary, and Toast Payments CSVs. Confirm the four views populate and the
   totals look right.

### D. Add more properties
7. Repeat step 5 with `addProperty("Second Property")` for each additional
   location — or `addExistingProperty("Name", "spreadsheetId")` to adopt a
   Sheet you already have.

### E. Embed in Google Sites (optional)
8. Site → **Insert → Embed → By URL**, paste the `/exec` URL (optionally with
   `?property=<id>`), size to full width, **Publish**, and test as a
   non-admin user.

### F. Re-deploying after edits
9. **Deploy → Manage deployments → (edit) → New version** keeps the same
   URL, so Google Sites never needs re-embedding.

---

## 12. Notes & options

- **Audit trail vs. sheet isolation.** Same trade-off as inventory_audit:
  deployed as *Me*, managers stay off every sheet, but there's no per-
  manager attribution on manual-entry saves beyond whichever account made
  the change being visible in the property's admin list. Deploy as *User
  accessing* instead if per-manager attribution matters more than sheet
  isolation.
- **Pay period length.** Fixed at 14 days (`CONFIG.PAY_PERIOD_DAYS` in
  `Code.gs`), starting at the earliest Business Date found in the uploaded
  Payments CSV — change that constant if a property runs a different cycle
  length.
- **Concurrency:** CSV uploads are `LockService`-guarded per property, same
  as inventory_audit's writes.
- **Recovering from a corrupted `_Config` sheet.** Because it's a plain
  sheet, not an opaque properties blob, the workbook owner can open it
  directly (**View → Hidden sheets**) and hand-fix a `Setting | Value` row,
  or use **Settings → Reset to defaults** from inside the app.
