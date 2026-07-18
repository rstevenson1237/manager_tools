# Inventory Audit — Sheet-as-Database + Google Sites Web App

The Google Sheet is now a **pure data store**. All interface and logic — the
"Items to Review" categorisation, colour status, progress, notes, and settings —
live in the Apps Script web app embedded in Google Sites. Managers never open the
sheet; the only sheet-side actions are your setup tasks and the CSV import.

---

## 1. Frontend: why Vue, and what it cost

The review UI is built with **Vue 3**, loaded from a CDN
(`vue@3.4.31/dist/vue.global.prod.js`) directly in `Index.html` — **no build
step, no npm, no bundler**. Vue's directives (`v-for`, `v-if`, `v-model`,
`@click`) are written straight into the existing HTML; there's no compile stage
between editing the file and deploying it, so the "edit in the Apps Script
editor, click Deploy" workflow is unchanged.

**Why a framework at all, and why this one:**
- The feature set grew from a 5-column table with a text box into a 13-column
  table, a two-stage filtered dropdown, an in-memory sync queue with live status
  per row, and a settings panel with three editable lists. Hand-written
  `innerHTML` string-building (the old approach) gets error-prone and slow to
  extend at that size — every edit meant re-escaping strings and manually
  diffing DOM state. A reactive framework removes that whole class of bugs:
  the template describes what the UI *should* look like for the current state,
  and re-renders (efficiently — Vue patches only what changed) are automatic.
- Vue's no-build "global build" mode fits Apps Script's file model exactly: one
  `<script src>` tag, one plain `<script>` block, both plain files that live
  happily inside `HtmlService`. Sprinkling Alpine.js-style directives was
  considered but Vue's computed properties and reactive objects handle the
  settings CRUD and multi-key sync-status map far more cleanly at this scale.
  A "real" SPA framework requiring webpack/Vite was rejected — it would need a
  separate build pipeline and a way to get bundled output into the Apps Script
  project, adding real operational complexity for a single-page internal tool.
- **Resource cost:** the production Vue build is ~50 KB gzipped, cached by the
  browser after the first load, loaded from a CDN (not through Apps Script's
  own quota). For an internal tool with a handful of concurrent managers, this
  is negligible — the practical bottleneck was always Sheet read/write calls,
  not client-side JS weight, which is exactly what the new sync model (below)
  addresses.

---

## 2. The review table — full report columns

The table now shows the full range of reported data, not just Item/UofM/Qty/
Flag/Notes: **Item, UofM, Current Qty, Current $ Cost, Current $ Total,
Previous Qty, Prev $ Cost, Prev $ Total, Adjustment, Cost Acct, Inventory Acct,
Flag, Price Variance** — plus Notes. Price Variance (`|ΔCost / PrevCost|`) is
now computed and shown for *every* row, not just the Price Changes category.
Which of these columns are visible is admin-configurable (see Settings, §5) —
Item and Notes always show; everything else can be toggled off per deployment.

---

## 3. In-memory edits + background sync (replaces per-row Save)

The old UI wrote to the sheet on every individual "Save" click (one network
round trip per row) and only batched with an explicit "Save all changes" —
slow, and a failed row in a batch used to be silently indistinguishable from a
succeeded one. That's gone. Now:

- **Edits are instant and client-side.** Picking a note from the dropdown
  updates the in-memory table immediately (row recolours, progress bar moves)
  with **zero network round trip**. The full data set loaded once on page load
  is the client's working copy for the session.
- **Sync is a background batch**, either automatic (every 20 seconds, if there
  are pending edits and Auto-sync is on) or on demand via **Sync now**. Both
  paths call the same batched `saveNotesBatch` endpoint used before, but now
  every entry gets an individual pass/fail result: a row that fails (e.g. the
  sheet was re-imported underneath it) stays flagged **⚠ retry** and pending —
  it is never silently dropped, which is what made notes appear to "not save"
  under the old flow.
- Each row shows a small sync badge: **● pending**, spinner while syncing,
  **✓ synced** (fades after a moment), or **⚠ retry** on failure with the error
  in a tooltip.
- A pending-change counter appears in the header, and leaving the page with
  unsynced changes triggers the browser's native "are you sure?" warning.
- **Legacy notes are preserved.** Free-text notes saved before this dropdown
  existed (or a category an admin has since removed) are shown as-is in the
  `<select>` instead of being silently blanked — they just aren't in the fixed
  list, so picking a different value works normally afterward.

---

## 4. Notes UI — category buttons above a filtered dropdown

The old free-text `<input>` is now a `<select>`. Above it, three buttons —
**CORRECT / REVIEW / ADJUST** — set the row's category; picking one both fills
in the bare category value and **filters the dropdown to only that category's
options**. The full default list (admin-editable — see Settings):

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

## 5. Settings panel (admin only)

Admins get a **⚙ Settings** button (next to Refresh) opening a panel with three
editable lists, all persisted in the spreadsheet's **Document Properties**
(`PropertiesService.getDocumentProperties()`) — shared by every user of the
app, editable without a code redeploy:

- **Admin users** — add/remove emails that can upload/replace data, remove
  data, and change these settings. At least one must remain; removing your own
  access prompts a confirmation first.
- **Visible columns** — checkboxes for which of the 12 optional report columns
  show in the table (Item and Notes are always shown, not toggleable).
- **Note categories** — add/remove dropdown options. Each must start with
  `CORRECT`, `REVIEW`, or `ADJUST` (validated both client- and server-side) so
  row colouring and the two-stage filter keep working; at least one must
  remain.

The installing admin is seeded as `rstevenson1237@gmail.com` in
`DEFAULT_SETTINGS` (`Code.gs`) so the first deploy is never locked out; change
or add to this from inside the Settings panel afterwards.

---

## 6. The category rules (unchanged, still in code)

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

## 7. Data-store schema

Each Count Details sheet (`Beverage Count Details`, `Food Count Details`):

```
Row 1 (header, frozen): Item | UofM | Current Qty | Current $ Cost |
  Current $ Total | Previous Qty | Prev $ Cost | Prev $ Total | Adjustment |
  Cost Acct | Inventory Acct | Flag | Notes | Reviewed By | Reviewed At
Row 2+ : data (one row per unique item)
```

Columns 1–12 come from the CSV import; `Notes` / `Reviewed By` / `Reviewed At`
are written by the app. The item name (column 1) is unique, so it's the stable
identity used to preserve notes across re-imports. Settings (admin emails,
visible columns, note categories) live separately in Document Properties, not
in the sheet — they aren't part of this table.

---

## 8. Files

| File | Role |
|---|---|
| `Code.gs` | Backend: `doGet`, `getInventoryData`, `saveNote`, `saveNotesBatch`, `getSettings`/`saveSettings`, admin/session helpers, sheet-shaping helpers, optional `setupDatastore`. |
| `Index.html` | The entire interface served into Google Sites — a Vue 3 app: review table, notes dropdown, sync queue, admin CSV upload/remove, and the Settings panel. |
| `Import.gs` | Admin-gated server functions the web app calls: `getExistingDataSummary`, `processCSVData`, `removeAllCountData`. No spreadsheet menu. |
| `appsscript.json` | Manifest: web-app deployment + scopes (now includes `script.storage` for the settings store). |

Everything — review, note-taking, monthly upload, settings, and reset —
happens inside the Google Sites embed. **No one ever opens the spreadsheet**
(your setup runs from the Apps Script editor once). There is no `Import Data`
menu anymore.

---

## 8a. Monthly upload behaviour (from inside the web app)

An **Admin** bar appears at the top of the embed only for accounts on the
admin list (Settings panel → Admin users). Everyone else sees just the review
UI. The upload is a clean slate each month — last month's data and notes are
replaced, not merged:

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

Every one of these server functions re-checks admin status independently, so a
non-admin can't trigger a wipe (or a settings change) even by bypassing the
hidden buttons.

---

## 9. Step-by-step implementation

### A. Install the code
1. Create a Google Sheet to act as the database. **Extensions → Apps Script**.
2. Add the files: `Code.gs`, `Import.gs` (script); `Index.html` (HTML, named
   exactly `Index`). In **Project Settings**, show and replace `appsscript.json`
   with the provided manifest; set `timeZone` if needed.
3. `CONFIG` no longer hardcodes admin emails — the seed admin
   (`rstevenson1237@gmail.com`) lives in `DEFAULT_SETTINGS.adminEmails` in
   `Code.gs`. Change it there before first deploy if a different account should
   be the initial admin, or just sign in as that account once deployed and add
   co-admins from the Settings panel.

### B. Deploy the web app
4. **Deploy → New deployment → Web app.**
   - **Execute as:** *Me* (the owner) — so managers need no access to the sheet.
   - **Who has access:** *Anyone within [your domain]*.
   Approve the OAuth prompt — it now also requests **PropertiesService storage**
   (for settings) in addition to spreadsheet access and email identification.
   Copy the **/exec** URL.

### C. First upload (creates everything)
5. Open the `/exec` URL. Because you're on the admin list, the **Admin** bar
   appears → **Upload monthly counts (CSV)** → pick the export. The upload
   creates and formats both Count Details sheets and loads the data. Smoke-test
   a note: pick a category + dropdown value, wait for auto-sync (or click Sync
   now), and confirm it sticks after a Refresh. (Optional: run `setupDatastore`
   in the editor first to preview the empty table structure.)

### D. Embed in Google Sites
6. Site → **Insert → Embed → By URL**, paste the `/exec` URL, size to full width,
   **Publish**, and test as a view-only (non-admin) user — they should see the
   review UI with no Admin bar and no Settings button.

### E. Re-deploying after edits
7. **Deploy → Manage deployments → (edit) → New version** keeps the same URL, so
   Google Sites never needs re-embedding.

---

## 10. Notes & options

- **Admin identity.** The admin gate reads the accessing user's email
  (`Session.getActiveUser().getEmail()`) against the admin list stored in
  Document Properties (editable via Settings). With the app deployed as *Me* +
  *Anyone within your domain*, this reliably returns the real email **inside your
  own Google Workspace domain**, which is the intended setup. If a viewer's email
  comes back blank (e.g. a personal Gmail account outside the domain), they're
  treated as non-admin and the Admin bar / Settings button stay hidden. The
  "signed in as …" text in the Admin bar lets you confirm identity is resolving.
  If you ever need admin actions for accounts the email check can't see, the
  alternative is deploying as *User accessing* — but that requires granting
  those users edit access to the sheet.

- **Audit trail vs. sheet isolation.** Executing as *Me* (the default) keeps
  managers off the sheet but means `Reviewed By` records the owner or "unknown".
  If per-manager attribution matters more than sheet isolation, deploy as *User
  accessing* and grant managers edit access — then the stamp is accurate. You
  can't have both. `CONFIG.ENABLE_AUDIT` toggles the stamp either way.
- **Tuning categories (computed sections, not notes):** change counts in
  `CONFIG.CATEGORY_LIMITS` or labels/order in `CONFIG.CATEGORY_ORDER`. To add a
  datastore (e.g. a third table), add an entry to `CONFIG.DATASTORES`. Note-
  category *dropdown options* (as opposed to these computed sections) are
  admin-editable at runtime from the Settings panel — no redeploy needed.
  Column visibility likewise.
- **Standalone script:** replace `getActiveSpreadsheet()` in `getSpreadsheet_()`
  with `openById(...)` and widen the manifest scope to `spreadsheets`.
- **Concurrency:** writes are `LockService`-guarded with an item-name safety
  check; if a re-import shifts a row under an open page, the affected sync
  entries come back as per-row failures (flagged **⚠ retry**) rather than
  corrupting other rows in the same batch, and the user is asked to refresh.
- **Auto-sync interval:** 20 seconds, set via `AUTO_SYNC_MS` in `Index.html`.
