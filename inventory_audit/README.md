# Inventory Audit — Multi-Property Sheet-as-Database + Web App

One **standalone** Apps Script project serves **every property** from a single
deployment. Each property is its own Google Sheet workbook (a pure data
store); the script opens the right workbook per request based on which
property the signed-in user is working in. All interface and logic — the
"Items to Review" categorisation, colour status, progress, notes, and settings
— live in the Apps Script web app. Managers never open a sheet; the only
sheet-side actions are the one-time setup tasks (run from the Apps Script
editor) and the CSV import (done from inside the app).

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
3. **Property user** — per property. View-only access to that property.

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

Each property's admins, users, visible columns, and note categories are
stored as plain rows in a **hidden sheet named `_Config`** inside that
property's own workbook — not JSON in a properties blob.

```
Setting          | Value
-----------------|---------------------------------------------
Property Admins  | alice@company.com, bob@company.com
Property Users   | carol@company.com, dave@company.com
Visible Columns  | uom, currentQty, currentCost, ...
Note Categories  | CORRECT, CORRECT - ISSUE HAS BEEN RESOLVED, ...
```

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

## 4. The review table — full report columns

The table shows the full range of reported data, not just Item/UofM/Qty/Flag/
Notes: **Item, UofM, Current Qty, Current $ Cost, Current $ Total, Previous
Qty, Prev $ Cost, Prev $ Total, Adjustment, Cost Acct, Inventory Acct, Flag,
Price Variance** — plus Notes. Price Variance (`|ΔCost / PrevCost|`) is
computed and shown for *every* row, not just the Price Changes category.
Which of these columns are visible, and in what order and width, is
controllable per property:

- **Visible columns** — admin-configurable in Settings (persisted per
  property in `_Config`).
- **Column order and width** — drag a column header to reorder it, or its
  right edge to resize it. This is a **session-only view preference**: it
  resets to the configured default on page reload, by design, so it never
  drifts from what Settings defines.
- **Density** — the table uses a compact row/cell padding so more rows and
  columns fit on screen.

---

## 5. In-memory edits + background sync

- **Edits are instant and client-side.** Picking a note from the dropdown
  updates the in-memory table immediately (row recolours, progress bar moves)
  with **zero network round trip**. The full data set loaded once on page load
  is the client's working copy for the session.
- **Sync is a background batch**, either automatic (every 20 seconds, if there
  are pending edits and Auto-sync is on) or on demand via **Sync now**. Every
  entry in a batch gets an individual pass/fail result: a row that fails
  (e.g. the sheet was re-imported underneath it) stays flagged **⚠ retry** and
  pending — it is never silently dropped.
- Each row shows a small sync badge: **● pending**, spinner while syncing,
  **✓ synced** (fades after a moment), or **⚠ retry** on failure with the error
  in a tooltip.
- A pending-change counter appears in the header, and leaving the page with
  unsynced changes triggers the browser's native "are you sure?" warning.
- **Legacy notes are preserved.** Free-text notes saved before this dropdown
  existed (or a category an admin has since removed) are shown as-is in the
  `<select>` instead of being silently blanked.

---

## 6. Notes UI — category buttons above a filtered dropdown

The old free-text `<input>` is a `<select>`. Above it, three buttons —
**CORRECT / REVIEW / ADJUST** — set the row's category; picking one both fills
in the bare category value and **filters the dropdown to only that category's
options**. Default list (per property, editable in Settings):

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

Row colouring (green/yellow/red) is unchanged — still driven by the CORRECT/
REVIEW/ADJUST prefix of the saved note, computed server-side in
`statusForNote_`.

---

## 7. Settings panel

Property admins get a **⚙ Settings** button (next to Refresh) opening a panel
scoped to the active property:

- **Property admins** — accounts that can upload/replace data, remove data,
  and change settings for this property.
- **Property users** — accounts with view-only access to this property.
- **Visible columns** — checkboxes for which report columns show (Item and
  Notes are always shown).
- **Note categories** — add/remove dropdown options; each must start with
  `CORRECT`, `REVIEW`, or `ADJUST`.
- **Reset to defaults** — restores this property's admins, users, columns,
  and categories to the hardcoded defaults (the same recovery path as
  hand-editing `_Config`, but from inside the app).
- **Global admins** *(visible only to global admins)* — a separate section
  for managing the account list with access to every property. Property
  admins never see or can edit this.

---

## 8. The category rules (unchanged, still in code)

Count Details columns used: Current Qty, Current $ Cost, Prev $ Cost, Adjustment.

| Category | Rule | Limit |
|---|---|---|
| Price Changes | Qty > 0 and a valid variance; sort by `\|ΔCost / PrevCost\|` desc | 25 |
| Decreases | all rows sorted by Adjustment ascending (most negative first) | 10 |
| Increases | all rows sorted by Adjustment descending | 10 |
| New Items | Prev Cost = 0 and Qty > 0 and Cur Cost > 0 | 10 |
| $0 Cost | Qty > 0 and Cur Cost = 0 | 10 |
| Uncounted | Qty = 0 | all |

Variance is `-1` when current cost is 0 (shown as "Zero $ cost"), and treated
as *not applicable* when previous cost is 0 (a new item — it belongs under New
Items, not Price Changes). Limits are in `CONFIG.CATEGORY_LIMITS`. Flags (`More
than Twice`, `Less than Half`, …) come from the source system in the CSV and
are displayed as-is.

---

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
Row 2+ : Property Admins | Property Users | Visible Columns | Note Categories
```

Columns 1–12 of the Count Details tabs come from the CSV import; `Notes` /
`Reviewed By` / `Reviewed At` are written by the app. The item name (column 1)
is unique, so it's the stable identity used to preserve notes across
re-imports.

---

## 10. Files

| File | Role |
|---|---|
| `Code.gs` | Backend: `doGet`, global store + registry (Script Properties), `_Config` sheet helpers, three-tier auth, property-aware `getInventoryData`/`saveNote`/`saveNotesBatch`/`getSettings`/`saveSettings`/`resetSettings`, `getBootstrap`, global-admin management, property-management functions (`addProperty`, `addExistingProperty`, `removeProperty`, `listProperties`). |
| `Index.html` | The entire interface served into the web app — a Vue 3 app: bootstrap/property picker, review table with drag-reorder/resizable columns, notes dropdown, sync queue, admin CSV upload/remove, and the Settings panel. |
| `Import.gs` | Admin-gated, property-aware server functions the web app calls: `getExistingDataSummary`, `processCSVData`, `removeAllCountData`. No spreadsheet menu. |
| `appsscript.json` | Manifest: web-app deployment + scopes. Uses the full `spreadsheets` scope (not `.currentonly`) since the script opens many workbooks by ID. |

Everything — review, note-taking, monthly upload, settings, and reset —
happens inside the web app. **No one ever opens a property's spreadsheet**
day-to-day (setup/property-management runs from the Apps Script editor once
per property).

---

## 10a. Monthly upload behaviour (from inside the web app)

An **Admin** bar appears at the top of the app only for accounts with admin
rights (global or property) on the currently active property. Everyone else
sees just the review UI. The upload is a clean slate each month — last
month's data and notes are replaced, not merged:

1. Admin clicks **Upload monthly counts (CSV)** and picks the file. The browser
   reads it and sends the text to the server.
2. The CSV is **parsed and validated first**. A missing column or malformed file
   stops the import and **nothing existing is touched**.
3. If the sheets already hold data, a modal shows a **warning listing exactly how
   many rows will be erased** and requires confirmation.
4. On confirm, each sheet is **deleted and recreated pristine** with the correct
   header row, then the new data is written, split Beverage/Food by
   `Inventory Acct`. The review UI reloads automatically.
5. Managers add notes for the month (kept in memory, synced in the background).
6. Next month: repeat. **Remove all data** (admin only) is available for a hard
   reset between cycles.

Every one of these server functions re-checks admin status for the active
property independently, so a non-admin — or an admin of a *different*
property — can't trigger a wipe (or a settings change) even by bypassing the
hidden buttons.

---

## 11. Step-by-step implementation

### A. Install the code
1. Go to [script.google.com](https://script.google.com) → **New project**
   (this is a **standalone** script — do not create it from within a Sheet).
2. Add the files: `Code.gs`, `Import.gs` (script); `Index.html` (HTML, named
   exactly `Index`). In **Project Settings**, show and replace
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
   one property, the app loads straight into it — no picker. The **Admin**
   bar appears → **Upload monthly counts (CSV)** → pick the export. Smoke-test
   a note: pick a category + dropdown value, wait for auto-sync (or click Sync
   now), and confirm it sticks after a Refresh.

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
- **Tuning categories (computed sections, not notes):** change counts in
  `CONFIG.CATEGORY_LIMITS` or labels/order in `CONFIG.CATEGORY_ORDER` — these
  apply to every property. To add a datastore (e.g. a third table per
  property), add an entry to `CONFIG.DATASTORES`. Note-category *dropdown
  options*, visible columns, and admins/users are per-property and
  admin-editable at runtime from the Settings panel — no redeploy needed.
- **Concurrency:** writes are `LockService`-guarded (per property) with an
  item-name safety check; if a re-import shifts a row under an open page, the
  affected sync entries come back as per-row failures (flagged **⚠ retry**)
  rather than corrupting other rows in the same batch, and the user is asked
  to refresh.
- **Auto-sync interval:** 20 seconds, set via `AUTO_SYNC_MS` in `Index.html`.
- **Recovering from a corrupted `_Config` sheet.** Because it's a plain
  sheet, not an opaque properties blob, the workbook owner can open it
  directly (**View → Hidden sheets** to unhide it) and hand-fix a `Setting |
  Value` row, or use **Settings → Reset to defaults** from inside the app.
