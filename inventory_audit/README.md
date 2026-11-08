# Inventory Audit — Multi-Property Sheet-as-Database + Web App

One **standalone** Apps Script project serves **every property** from a single
deployment. Each property is its own Google Sheet workbook (a pure data
store); the script opens the right workbook per request based on which
property the signed-in user is working in. All interface and logic — the
"Items to Review" categorisation, colour status, progress, notes, and settings
— live in the Apps Script web app. Managers never open a sheet; the only
sheet-side actions are the one-time setup tasks (run from the Apps Script
editor) and the CSV import (done from inside the app).

**Where this fits.** The store team reviews its month-end count here and
fixes what is wrong in R365. The regional manager then uploads the same R365
export to the P&L Tracker's Inventory tab, which re-runs the same rules
blind and lists what is still worth asking about. Both apps use one rules
file, `InventoryRules.gs`, copied byte for byte into each project. The look
matches the P&L Tracker.

---

## 1. Frontend: why Vue, and what it cost

The review UI is built with **Vue 3**, loaded from a CDN
(`vue@3.4.31/dist/vue.global.prod.js`) directly in `Index.html` — **no build
step, no npm, no bundler**. Vue's directives (`v-for`, `v-if`, `v-model`,
`@click`) are written straight into the existing HTML; there's no compile stage
between editing the file and deploying it, so the "edit in the Apps Script
editor, click Deploy" workflow is unchanged.

**Why a framework at all, and why this one:**
- The feature set spans a multi-column table, a two-stage filtered dropdown,
  an in-memory sync queue with live status per row, a property picker, and a
  settings panel with several editable lists. Hand-written `innerHTML`
  string-building gets error-prone and slow to extend at that size. A
  reactive framework removes that whole class of bugs: the template describes
  what the UI *should* look like for the current state, and re-renders
  (efficiently — Vue patches only what changed) are automatic.
- Vue's no-build "global build" mode fits Apps Script's file model exactly: one
  `<script src>` tag, one plain `<script>` block, both plain files that live
  happily inside `HtmlService`. A "real" SPA framework requiring webpack/Vite
  was rejected — it would need a separate build pipeline and a way to get
  bundled output into the Apps Script project, adding real operational
  complexity for a single-page internal tool.
- **Resource cost:** the production Vue build is ~50 KB gzipped, cached by the
  browser after the first load, loaded from a CDN (not through Apps Script's
  own quota). For an internal tool, this is negligible — the practical
  bottleneck was always Sheet read/write calls, not client-side JS weight,
  which is exactly what the sync model (below) addresses.

---

## 2. Multi-property architecture

**1 workbook = 1 property.** The script is standalone (not bound to any
single Sheet), so it can open any property's workbook by ID on demand.

### Access model (three tiers)

1. **Global admin** — a small list stored in this script project's **Script
   Properties**. Admin on *every* property, always. Seeded with a hardcoded
   default (`rstevenson1237@gmail.com`) on first run; editable afterwards from
   the Settings panel (visible only to global admins) or directly via
   `getGlobalAdmins`/`saveGlobalAdmins`.
2. **Property admin** — per property. Can upload/replace/remove data and edit
   settings for *that property only*. Lets an owner delegate configuration to
   a property manager without handing them reach into every other property.
3. **Property user** — per property. Can work through the review and write notes for that property.

Property admin/user lists are **not** stored in Script Properties or Document
Properties — they live in a hidden **`_Config`** sheet inside each property's
own workbook (see §3), separate from the global admin list and registry.

### The property registry

Also in Script Properties: a list of every registered property —
`{ id, name, spreadsheetId }`. There is **no spreadsheet menu or dialog** for
managing this; it's maintained by three ordinary functions run from the Apps
Script editor's **Run** menu (no UI, matching the "no one ever opens the
sheet" philosophy):

| Function | What it does |
|---|---|
| `addProperty(name)` | Creates a brand-new Sheet, builds both Count Details tabs plus `_Config`, and registers it. Returns `{ id, name, spreadsheetId, url }` — check the Logs (or the Executions panel) for the URL. |
| `addExistingProperty(name, spreadsheetId)` | Adopts a Sheet you already created: fills in any missing Count Details/`_Config` sheets (non-destructive) and registers it. |
| `removeProperty(id)` | Unregisters a property. **Does not delete or trash the workbook** — it's left fully intact and can be re-adopted later with `addExistingProperty`. |
| `listProperties()` | Lists the registry (Logs/Executions panel) — use it to find a property's `id` before calling `removeProperty`. |

Edit the arguments in the editor (or run from a temporary wrapper cell) before
each `Run`, the same way `setupDatastore` worked in the single-property
version of this app.

### The property picker

On load, the client calls `getBootstrap()`, which returns every property the
signed-in user can access, each tagged with their role (`admin`/`user`).

- **Most accounts only have access to one property.** In that case the app
  skips the picker entirely and loads straight into it — no extra click.
- Accounts with access to more than one property (typically global admins)
  see a dropdown in the header to switch between them.
- An optional `?property=<id>` query parameter on the `/exec` URL pre-selects
  a property when more than one is accessible (handy for a dedicated Google
  Sites embed per property). It is **not** a security boundary by itself —
  every server call independently re-validates access — it only decides which
  property the picker defaults to.

---

## 3. Per-property configuration — the `_Config` sheet

Each property's admins, users, note categories and last uploads are
stored as plain rows in a **hidden sheet named `_Config`** inside that
property's own workbook — not JSON in a properties blob.

```
Setting          | Value
-----------------|---------------------------------------------
Property Admins  | alice@company.com, bob@company.com
Property Users   | carol@company.com, dave@company.com
Note Categories  | CORRECT, CORRECT - ISSUE HAS BEEN RESOLVED, ...
Last Upload: Beverage | oct.csv | 2026-11-03T14:02:00Z | gm@company.com
```

Rows are found by their label, so their order does not matter. A
`Visible Columns` row from an older version is ignored and dropped the next
time settings are saved.

This is deliberate, not incidental:

- **End users never open the underlying Sheet** — only the `/exec` web app —
  so this sheet is exactly as safe from accidental edits as the Beverage/Food
  data tabs already are.
- **It's human-readable and hand-editable.** If a setting is ever corrupted or
  someone gets accidentally locked out, the workbook owner can open the
  `_Config` sheet directly in Sheets and fix a cell — no Apps Script editor,
  no JSON, no redeploy. (Unhide it via **View → Hidden sheets** if needed;
  it's hidden by default just to keep it out of the way.)
- The app also reads/writes it normally through Settings, so day-to-day
  changes don't require touching the sheet at all.

`getSettings`/`saveSettings` (property-admin gated) and `resetSettings`
(restores the hardcoded defaults below) are the normal way to edit this.

---

## 4. What gets picked for review — `InventoryRules.gs`

The rules are the same file the P&L Tracker uses for the regional check, so
the store reviews with exactly the rules it will be checked with. **Do not
edit one copy only**: change `InventoryRules.gs`, copy it over the other
project's, and run the tests (they fail when the copies differ).

Every item's change since the last count splits in two, and the two add up
to R365's adjustment:

- **price effect** = current qty × (current cost − previous cost): what the
  cost change did to what was counted;
- **quantity effect** = everything else.

Ranking by the raw adjustment mixes the two. A case price keyed on a bottle
shows up as a large "increase" even when fewer bottles were counted.

| Section | Rule |
|---|---|
| Not counted | R365 flag *Assumed 0*: nothing was entered. Missed, or really out? |
| Possible cost or unit errors | Cost ×2.5 or more (or ÷2.5) since the last count. Within 3% of a pack size (6, 12, 24 …) it is named as a case price on a unit, or the reverse. Also a quantity with $0 cost. |
| Price changes | Cost moved 10%+ and the price effect is $50+; top 25 |
| Large decreases / increases | Quantity effect $250+ either way; top 10 each. Often right (it sold, a delivery came in), but worth a question: "did you really buy 3 cases?" |
| Gone to zero | Zero now, $150+ at the last count. Sold out, or missed? |
| New items | No cost at the last count; top 10 by value |

An item can sit in several sections; it has one note, shown in each. Items
at zero in both counts are never shown. Thresholds are in `INV_RULES`.

Deliberately **not** flagged:

- **R365's "More than Twice" / "Less than Half" flags.** They have no dollar
  floor, so they flag $3 moves. The quantity effect, with a dollar floor,
  replaces them.
- **Fractional counts.** Wines sold by the glass, and liquor R365 converts
  between 750 ml and 1 L, are counted in fractions on purpose.
- **Food-coded items in a beverage count.** Accounts are company-wide, so a
  bar's cocktail ingredients are coded to food.

On real beverage counts (about 1,500 items) this picks about 50 items a
month. Items whose dollar impact is **$1,000 or more** (`INV_RULES.highImpact`)
carry a *High impact* badge. These are what the regional check lists. On a
properly audited count, fewer than 10 should be left.

## 5. The review page

The page follows the P&L Tracker's Inventory review:

- **Header:** the count, when it was uploaded and by whom, and review
  progress. Below it, cards for inventory value, the price and quantity
  split, and high-impact items without a note.
- **Show:** *Largest dollar impact first* (the default), *By section*,
  *By account* (to split the work: wine, liquor …), or *Action items*
  (ADJUST / REVIEW). Also **Find an item** and **Only items without a note**.
- **Table:** item, quantity and cost (last count → now), value, dollar
  impact (with the price and quantity parts), why it is here (the question to
  answer), and the note.

## 6. Notes, saved in the background

Each item gets a note. The **CORRECT / REVIEW / ADJUST** buttons pick the
type and narrow the list. Default list (per property, editable in Settings):

```
CORRECT
CORRECT - ISSUE HAS BEEN RESOLVED
CORRECT - FIXED FROM LAST MONTH
REVIEW
REVIEW - DOUBLE CHECK COUNT
ADJUST
ADJUST - CASE AS BOTTLE PRICE
ADJUST - INCORRECT ITEM COUNTED
ADJUST - BOTTLE AS CASE PRICE
ADJUST - INCORRECT PRICE IN SYSTEM
ADJUST - PRODUCT NEEDS TO BE RECOSTED
```

- Edits are instant: the row recolours (green, yellow, red) with no network
  round trip.
- Notes are saved in one batch every 20 seconds, or with **Save now**. Each
  entry gets its own result. One that fails (for example, the sheet was
  re-imported underneath it) stays queued, marked *retry* with the reason.
- Leaving the page with unsaved notes triggers the browser's warning.
- A note no longer in the list (a legacy free-text note, or one removed in
  Settings) still shows as-is.
- Writes are keyed by row number, with an item-name check.

## 7. Settings

Property admins get a **Settings** button in the top bar:

- **Property admins:** can upload and remove counts and change settings
  for this property.
- **Property users:** can work through the review and write notes.
- **Notes:** add or remove options. Each must start with `CORRECT`,
  `REVIEW` or `ADJUST`.
- **Reset to defaults.**
- **Global admins** *(global admins only):* the list with access to every
  property.

## 8. Uploading a count

An admin opens **Upload** and chooses R365's **Inventory Count Item Details**
CSV. The preview writes nothing. It shows:

- whether every item's previous value plus its adjustment equals its
  current value (quantity × cost is not checked: R365 rounds the quantity,
  so it misses by a few dollars on expensive bottles);
- value, the price and quantity split, and how many items are picked
  (and how many are high impact);
- **how the file relates to the count on file:**
  - *Follows it:* the file's previous figures are the count on file's
    current figures. This is next month's count. It replaces the old one,
    notes and all.
  - *The same count again:* same previous figures, for example after fixing
    costs in R365 and exporting again. Notes carry over for items still
    picked.
  - *Does not follow:* a warning with examples. The months may be out of
    order, or it may be the wrong property.

**One file, one tab.** A beverage count goes to the Beverage tab whole,
food-coded cocktail ingredients included, and a food count goes to the Food
tab. Only a full count (no clear majority of accounts) is split by
inventory account. A tab the file does not cover is left alone.

**Remove all data** (admin) empties both tabs, notes included.

Every upload and settings function re-checks admin rights for the active
property on the server.

## 9. Per-property workbook schema

Each property workbook has three sheets:

```
Beverage Count Details / Food Count Details
Row 1 (header, frozen): Item | UofM | Current Qty | Current $ Cost |
  Current $ Total | Previous Qty | Prev $ Cost | Prev $ Total | Adjustment |
  Cost Acct | Inventory Acct | Flag | Notes | Reviewed By | Reviewed At
Row 2+ : data (one row per unique item)

_Config (hidden)
Row 1 (header, frozen): Setting | Value
Row 2+ : Property Admins | Property Users | Note Categories | Last Upload: <tab>
```

Columns 1–12 of the Count Details tabs come from the CSV import (stored as
numbers); `Notes` /
`Reviewed By` / `Reviewed At` are written by the app. The item name (column 1)
is unique, so it's the stable identity used to preserve notes across
re-imports.

---

## 10. Files

| File | Role |
|---|---|
| `InventoryRules.gs` | **Shared with the P&L Tracker.** Reads the R365 export, splits each change into price and quantity, picks the items to review, and compares a new export with the count on file. No Apps Script services. |
| `Code.gs` | Backend: `doGet`, global store and registry (Script Properties), `_Config` sheet, three-tier access, `getInventoryData`, `saveNotesBatch`, settings, `getBootstrap`, global admins, and the property-management functions. |
| `Import.gs` | Admin upload functions the page calls: `previewUpload`, `commitUpload`, `removeAllCountData`. |
| `Index.html` | The whole interface (Vue 3): property picker, review table, notes and saving, upload with preview, and Settings. |
| `appsscript.json` | Manifest: web-app deployment and scopes. |
| `tests/` | Dev-only, not deployed: `run_tests.js` (endpoint tests against the Apps Script stand-in), `sample.js` (made-up exports), and `preview.js` (builds a clickable page without deploying). |

```bash
node inventory_audit/tests/run_tests.js
```

The shared rules are tested with the P&L Tracker:

```bash
node pnl_tracker/tests/run_tests.js
```

To click through the app without deploying:

```bash
node inventory_audit/tests/preview.js /tmp/audit.html --csv last-month.csv --csv this-month.csv
```

Add `--vue <file>` to inline Vue when offline, and `--user bar@example.com`
to see the page as a property user.

## 11. Step-by-step implementation

### A. Install the code
1. Go to [script.google.com](https://script.google.com) → **New project**
   (this is a **standalone** script — do not create it from within a Sheet).
2. Add the files: `InventoryRules.gs`, `Code.gs`, `Import.gs` (script);
   `Index.html` (HTML, named exactly `Index`). In **Project Settings**, show and replace
   `appsscript.json` with the provided manifest.
3. The seed global admin (`robert.stevenson@atlasrestaurantgroup.com`) lives in
   `DEFAULT_GLOBAL_ADMINS` in `Code.gs`. Change it there before first deploy
   if a different account should be the initial admin, or just sign in as
   that account once deployed and add co-admins from the Settings panel.

### B. Deploy the web app
4. **Deploy → New deployment → Web app.**
   - **Execute as:** *Me* (the owner) — so managers need no access to any
     property's sheet.
   - **Who has access:** *Anyone within [your domain]*.
   Approve the OAuth prompt — it now requests broader **Spreadsheets** access
   (to open any property's workbook by ID, and to create new ones) in
   addition to email identification and script storage. Copy the **/exec**
   URL.

### C. Create your first property
5. In the Apps Script editor, select `addProperty` from the function dropdown
   (edit the call to pass a name, e.g. `addProperty("Maximon")`, or add a
   temporary line calling it) and **Run**. Check **Executions** (or
   **View → Logs**) for the returned `{ id, name, spreadsheetId, url }`.
6. Open the `/exec` URL. Since you're a global admin and there's now exactly
   one property, the app loads straight into it — no picker. Open **Upload**,
   choose the export, check the preview and **Save count**. Smoke-test a
   note: pick a type and a note, wait 20 seconds (or click **Save now**), and
   confirm it sticks after a Refresh.

**Updating an existing install:** add `InventoryRules.gs`, replace `Code.gs`,
`Import.gs` and `Index.html`, and deploy a new version. Existing workbooks
keep working: the Count Details tabs and notes are read as they are, and
`_Config` is tidied the next time settings are saved.

### D. Add more properties
7. Repeat step 5 with `addProperty("Second Property")` for each additional
   location — or `addExistingProperty("Name", "spreadsheetId")` to adopt a
   Sheet you already have. Once a user has access to more than one property,
   the picker appears automatically.

### E. Embed in Google Sites (optional)
8. Site → **Insert → Embed → By URL**, paste the `/exec` URL (optionally with
   `?property=<id>` to default a specific property for that page), size to
   full width, **Publish**, and test as a non-admin user.

### F. Re-deploying after edits
9. **Deploy → Manage deployments → (edit) → New version** keeps the same URL,
   so Google Sites never needs re-embedding.

---

## 12. Notes & options

- **Admin identity.** The admin gate reads the accessing user's email
  (`Session.getActiveUser().getEmail()`) against the global admin list (Script
  Properties) and each property's `Property Admins` row (`_Config`). With the
  app deployed as *Me* + *Anyone within your domain*, this reliably returns
  the real email **inside your own Google Workspace domain**. If a viewer's
  email comes back blank (e.g. a personal Gmail account outside the domain),
  they're treated as having no access.
- **Audit trail vs. sheet isolation.** Executing as *Me* (the default) keeps
  managers off every sheet but means `Reviewed By` records the owner or
  "unknown". If per-manager attribution matters more than sheet isolation,
  deploy as *User accessing* and grant managers edit access to each
  property's workbook — then the stamp is accurate. You can't have both.
  `CONFIG.ENABLE_AUDIT` toggles the stamp either way.
- **Tuning the rules:** change `INV_RULES` in `InventoryRules.gs`. They
  apply to every property, and to the P&L Tracker's check once the file is
  copied over. To add a datastore (e.g. a third table per
  property), add an entry to `CONFIG.DATASTORES`. Note-category *dropdown
  options* and admins/users are per-property and
  admin-editable at runtime from the Settings panel — no redeploy needed.
- **Concurrency:** writes are `LockService`-guarded (per property) with an
  item-name safety check; if a re-import shifts a row under an open page, the
  affected sync entries come back as per-row failures (flagged **⚠ retry**)
  rather than corrupting other rows in the same batch, and the user is asked
  to refresh.
- **Save interval:** 20 seconds, set via `SYNC_SECONDS` in `Index.html`.
- **Recovering from a corrupted `_Config` sheet.** Because it's a plain
  sheet, not an opaque properties blob, the workbook owner can open it
  directly (**View → Hidden sheets** to unhide it) and hand-fix a `Setting |
  Value` row, or use **Settings → Reset to defaults** from inside the app.
