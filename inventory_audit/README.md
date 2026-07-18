# Inventory Audit — Sheet-as-Database + Google Sites Web App

The Google Sheet is now a **pure data store**. All interface and logic — the
"Items to Review" categorisation, colour status, progress, and note-writing —
live in the Apps Script web app embedded in Google Sites. Managers never open the
sheet; the only sheet-side actions are your setup tasks and the CSV import.

---

## 1. What changed from the previous design

Previously the review categories were produced by `SORTN`/`FILTER` array formulas
inside two *Items to Review* tabs, and the app read those tabs. That coupling is
gone:

- **No Items to Review tabs.** The six categories are computed in `Code.gs` from
  the raw Count Details rows. I extracted the original formulas and reproduced
  their logic exactly — verified item-for-item against the old output (Beverage:
  25/10/10/5/1/80 and Food: 7/8/8/0/0/1 all match the formulas' results).
- **Count Details are real tables.** Each has a bold, frozen header row with data
  from row 2 (the old formulas required data at row 1; without them we can do
  this properly). Columns are resolved by header name, so order is flexible.
- **The data store owns the notes.** Notes live in the Count Details row itself
  (`Notes`, plus `Reviewed By` / `Reviewed At`). One row per item means one note
  per item — and since a single item can surface in several categories, that one
  note shows on all of them at once.

---

## 2. The category rules (now in code)

Count Details columns used: Current Qty, Current $ Cost, Prev $ Cost, Adjustment.

| Category | Rule | Limit |
|---|---|---|
| Price Changes | Qty > 0 and a valid variance; sort by `\|ΔCost / PrevCost\|` desc | 25 |
| Decreases | all rows sorted by Adjustment ascending (most negative first) | 10 |
| Increases | all rows sorted by Adjustment descending | 10 |
| New Items | Prev Cost = 0 and Qty > 0 and Cur Cost > 0 | 10 |
| $0 Cost | Qty > 0 and Cur Cost = 0 | 10 |
| Uncounted | Qty = 0 | all |

Variance is `-1` when current cost is 0, and treated as *not applicable* when
previous cost is 0 (a new item — it belongs under New Items, not Price Changes).
Limits are in `CONFIG.CATEGORY_LIMITS`. Flags (`More than Twice`, `Less than
Half`, …) come from the source system in the CSV and are displayed as-is.

---

## 3. Data-store schema

Each Count Details sheet (`Beverage Count Details`, `Food Count Details`):

```
Row 1 (header, frozen): Item | UofM | Current Qty | Current $ Cost |
  Current $ Total | Previous Qty | Prev $ Cost | Prev $ Total | Adjustment |
  Cost Acct | Inventory Acct | Flag | Notes | Reviewed By | Reviewed At
Row 2+ : data (one row per unique item)
```

Columns 1–12 come from the CSV import; `Notes` / `Reviewed By` / `Reviewed At`
are written by the app. The item name (column 1) is unique, so it's the stable
identity used to preserve notes across re-imports.

---

## 4. Files

| File | Role |
|---|---|
| `Code.gs` | Backend: `doGet`, `getInventoryData`, `saveNote`, `saveNotesBatch`, admin/session helpers, sheet-shaping helpers, optional `setupDatastore`. |
| `Index.html` | The entire interface served into Google Sites — review UI for everyone, plus an Admin panel (upload / remove) shown only to admins. |
| `Import.gs` | Admin-gated server functions the web app calls: `getExistingDataSummary`, `processCSVData`, `removeAllCountData`. No spreadsheet menu. |
| `appsscript.json` | Manifest: web-app deployment + scopes. |

Everything — review, note-taking, monthly upload, and reset — happens inside the
Google Sites embed. **No one ever opens the spreadsheet** (your setup runs from
the Apps Script editor once). There is no `Import Data` menu anymore.

---

## 4a. Monthly upload behaviour (from inside the web app)

An **Admin** bar appears at the top of the embed only for accounts listed in
`CONFIG.ADMIN_EMAILS`. Everyone else sees just the review UI. The upload is a
clean slate each month — last month's data and notes are replaced, not merged:

1. Admin clicks **Upload monthly counts (CSV)** and picks the file. The browser
   reads it and sends the text to the server.
2. The CSV is **parsed and validated first**. A missing column or malformed file
   stops the import and **nothing existing is touched**.
3. If the sheets already hold data, a modal shows a **warning listing exactly how
   many rows will be erased** and requires confirmation.
4. On confirm, each sheet is **deleted and recreated pristine** with the correct
   header row, then the new data is written, split Beverage/Food by
   `Inventory Acct`. The review UI reloads automatically.
5. Managers add notes for the month.
6. Next month: repeat. **Remove all data** (admin only) is available for a hard
   reset between cycles.

Every one of these server functions re-checks admin status independently, so a
non-admin can't trigger a wipe even by bypassing the hidden buttons.

---

## 5. Step-by-step implementation

### A. Install the code
1. Create a Google Sheet to act as the database. **Extensions → Apps Script**.
2. Add the files: `Code.gs`, `Import.gs` (script); `Index.html` (HTML, named
   exactly `Index`). In **Project Settings**, show and replace `appsscript.json`
   with the provided manifest; set `timeZone` if needed.
3. In `Code.gs`, add your account to **`CONFIG.ADMIN_EMAILS`** (e.g.
   `'you@atlasrestaurantgroup.com'`). Only listed accounts can upload or remove
   data. Add any co-admins here too.

### B. Deploy the web app
4. **Deploy → New deployment → Web app.**
   - **Execute as:** *Me* (the owner) — so managers need no access to the sheet.
   - **Who has access:** *Anyone within [your domain]*.
   Approve the OAuth prompt (it now also requests your email, used to identify
   admins). Copy the **/exec** URL.

### C. First upload (creates everything)
5. Open the `/exec` URL. Because you're on the admin list, the **Admin** bar
   appears → **Upload monthly counts (CSV)** → pick the export. The upload
   creates and formats both Count Details sheets and loads the data. Smoke-test a
   note: type one, Save, and confirm it sticks after a Refresh. (Optional: run
   `setupDatastore` in the editor first to preview the empty table structure.)

### D. Embed in Google Sites
6. Site → **Insert → Embed → By URL**, paste the `/exec` URL, size to full width,
   **Publish**, and test as a view-only (non-admin) user — they should see the
   review UI with no Admin bar.

### E. Re-deploying after edits
7. **Deploy → Manage deployments → (edit) → New version** keeps the same URL, so
   Google Sites never needs re-embedding.

---

## 6. Notes & options

- **Admin identity.** The admin gate reads the accessing user's email
  (`Session.getActiveUser().getEmail()`). With the app deployed as *Me* +
  *Anyone within your domain*, this reliably returns the real email **inside your
  own Google Workspace domain**, which is the intended setup. If a viewer's email
  comes back blank (e.g. a personal Gmail account outside the domain), they're
  treated as non-admin and the Admin bar stays hidden. The "signed in as …" text
  in the Admin bar lets you confirm identity is resolving. If you ever need admin
  actions for accounts the email check can't see, the alternative is deploying as
  *User accessing* — but that requires granting those users edit access to the
  sheet.

- **Audit trail vs. sheet isolation.** Executing as *Me* (the default) keeps
  managers off the sheet but means `Reviewed By` records the owner or "unknown".
  If per-manager attribution matters more than sheet isolation, deploy as *User
  accessing* and grant managers edit access — then the stamp is accurate. You
  can't have both. `CONFIG.ENABLE_AUDIT` toggles the stamp either way.
- **Tuning categories:** change counts in `CONFIG.CATEGORY_LIMITS` or labels/order
  in `CONFIG.CATEGORY_ORDER`. To add a datastore (e.g. a third table), add an
  entry to `CONFIG.DATASTORES`.
- **Standalone script:** replace `getActiveSpreadsheet()` in `getSpreadsheet_()`
  with `openById(...)` and widen the manifest scope to `spreadsheets`.
- **Concurrency:** writes are `LockService`-guarded with an item-name safety
  check; if a re-import shifts a row under an open page, the save is refused and
  the user is asked to refresh.
