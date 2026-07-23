# Frontend Modernization Plan — `inventory_audit` + `payroll_audit`

Status legend: 🔲 Not started · 🟡 In progress · ✅ Done · ⏭️ Skipped (see notes)

| Phase | Scope | Status |
|---|---|---|
| [Phase 1](#phase-1-toasts-palette-sticky-header-var-modal-a11y-promise-wrapper) | Promise-ify `google.script.run` (#1) + toasts (#4) + palette (#6) + sticky-header CSS var (#7) + modal a11y (#8) | 🔲 Not started |
| [Phase 2](#phase-2-iconography) | Inline SVG iconography (#5) | 🔲 Not started |
| [Phase 3](#phase-3-es5--es6) | ES5 → ES6+ cleanup (#2a) | 🔲 Not started |
| [Phase 4](#phase-4-composition-api-evaluation) | Composition API rewrite (#2b) | 🔲 Not started |
| Phase 5+ | *(not yet defined — see "Growing this plan")* | — |

---

## How to use this doc (read this first if you're a new session)

This file is the single source of truth for the modernization effort across both apps. It
was seeded from a Gemini code-review pass evaluated for feasibility against two **hard
constraints** (below) that are easy to forget mid-task — re-read them before touching CSS,
storage, or dependencies.

**If you are resuming this work:**
1. Check the status table above for the current phase.
2. Open that phase's section. Confirm the **Entry gate** is actually satisfied (don't trust
   the checkbox alone — verify the prior phase's exit criteria yourself if picking up cold).
3. Work the task checklist. Check items off as you land them, in the same commit that lands
   them (don't batch checkbox updates separately from the work).
4. Add a dated entry to that phase's **Session log** every session that touches it, even if
   incomplete — one or two lines: what you did, what you found, what's left.
5. Before marking a phase ✅, walk its **Exit gate** literally, including the Google Sites
   embed check — this is the step most likely to be skipped and most likely to matter.
6. Update the status table at the top when a phase's state changes.

**If you're adding new scope (Phase 5+):** see [Growing this plan](#growing-this-plan) at
the bottom — don't just append ad hoc; there's a template.

**Do not** re-litigate the ordering (1,4,6,7,8 → 5 → 2a → 2b) or re-run the feasibility
debate — that's settled. This doc is about *execution*, not re-deciding *what*. If new
information genuinely invalidates a phase, say so explicitly in its Session log and raise it
with the user rather than silently reordering.

---

## Governing constraints (apply to every phase)

1. **No build step.** Both apps ship as hand-edited `Code.gs` / `Import.gs` / `Index.html`
   deployed from the Apps Script editor. No npm, no bundler, no transpiler. Vue 3 loads from
   a CDN in global-build mode. Any new code must be plain script-tag-runnable JS/CSS.
2. **Google Sites embedding is mandatory.** Both apps set
   `HtmlService.XFrameOptionsMode.ALLOWALL` (`inventory_audit/Code.gs:297`,
   `payroll_audit/Code.gs:255`) specifically so `/exec` can be embedded in a Google Sites
   page. That means the app runs inside a **nested, cross-origin iframe**. Consequences to
   design around every phase:
   - `localStorage`/`sessionStorage` can be partitioned or blocked (Safari ITP, Firefox
     state partitioning, Chrome storage partitioning) — anything storage-backed must degrade
     gracefully.
   - Extra CDN dependencies are extra failure points inside the sandbox (proxy blocks, CSP,
     added latency) — prefer inlining small assets over adding a library.
   - Keyboard/focus handlers only work once focus is inside the app iframe; they can't
     intercept from the hosting Sites chrome.
   - `position: fixed` is relative to the iframe viewport, not the browser window.
3. **Validate in the real deployment shape.** A change that looks right hitting the raw
   `/exec` URL directly can behave differently embedded. Every phase's exit gate requires an
   embedded-in-Sites check, not just a direct `/exec` check.

## Shared vs. divergent surface

| Element | inventory | payroll | Shared? |
|---|---|---|---|
| CDN Vue 3, Options API, `var self = this`, callback `google.script.run` | ✅ | ✅ | **Yes** |
| In-flow `#status` banner (CLS source) | ✅ | ✅ | **Yes** |
| Color tokens (`--green #d9ead3` etc.) | ✅ | ✅ (+`--orange`) | **Yes** |
| Emoji icons `⚙` `×` | ✅ | ✅ | **Yes** |
| Sync badge emoji `●` `⚠` `✓` | ✅ | ✗ | inventory only |
| `tr.section td { top:29px }` magic-pixel sticky bug | ✅ | ✗ (no section sub-rows) | inventory only |
| Column drag-reorder + resize (`columnOrder`/`columnWidths`) | ✅ | ✗ | inventory only |
| Select-driven note editing (`applyEdit`) | ✅ | ✗ (CSV upload + admin fields) | inventory only |

Full point-by-point feasibility rationale (including deferred/rejected items #2b-in-isolation,
#3, #9, #10) lives in the session record; this doc carries forward only the approved,
sequenced work. Deferred items are listed under [Backlog](#backlog-deferred-items) at the
bottom so they aren't lost.

---

## Phase 1: Toasts, palette, sticky-header var, modal a11y, Promise wrapper

**Status:** 🔲 Not started

**Entry gate:** none — this is the starting phase. Working tree clean on
`claude/planning-session-zu32ey` before starting.

**Rationale:** these five items are all high-value, low-risk, genuinely shared across both
apps, and don't conflict with either governing constraint. Bundled into one phase because
they're independent of each other and touch the same files, but land as **separate commits**
per item (or per item-per-app) so each is independently revertable.

### Task checklist

**1a. Promise-ify `google.script.run`**
- [ ] Add a `gas(funcName, ...args)` Promise wrapper to `inventory_audit/Index.html`
- [ ] Add the same wrapper to `payroll_audit/Index.html`
- [ ] Migrate `.withSuccessHandler/.withFailureHandler` call sites to `await gas(...)`
      one at a time, preserving existing error-message handling (`err.message`) — behavior
      must stay identical, this is a mechanical transport change only
  - [ ] inventory: bootstrap load, data load, sync batch, CSV summary/upload, remove data,
        settings save/reset, global admins load/save
  - [ ] payroll: mirror the equivalent call sites (enumerate during implementation —
        payroll has ~13 chains per the initial audit)
- [ ] Confirm methods calling `gas()` are `async` and callers don't assume sync return

**1b. Floating toasts (replace in-flow `#status`)**
- [ ] Convert `#status` to a `position: fixed` toast stack (top-right or bottom-right,
      `z-index` above modals which are currently `z-index:50`)
- [ ] Keep existing `showStatus`/`_statusTimer` logic: success/loading auto-dismiss,
      error persists until manually dismissed
- [ ] Support multiple stacked toasts if more than one status can be in flight
      (check: can loading + a stale error coexist today?)
- [ ] Apply to both `inventory_audit/Index.html` and `payroll_audit/Index.html`

**1c. Palette modernization**
- [ ] Update the shared `:root` tokens in `inventory_audit/Index.html` (green/yellow/red →
      emerald/amber/rose tints per the review, e.g. `#ecfdf5` / `#fffbeb` / `#fff1f2`)
- [ ] Mirror in `payroll_audit/Index.html`, folding in its extra `--orange`/`--orange-b`
      tokens so both apps share one coherent system
- [ ] Check text contrast (WCAG AA) for row-state text against new background tints
- [ ] Preserve row-state *semantics* (correct/review/adjust mapping unchanged)

**1d. Sticky header CSS variable**
- [ ] Introduce `--table-header-height` custom property in both apps
- [ ] inventory: replace the hardcoded `tr.section td { top:29px }`
      (`inventory_audit/Index.html:53`) with `top: var(--table-header-height)`
- [ ] payroll: adopt the same variable for its `th` sticky offset for parity, even though
      it has no section-row collision today
- [ ] Verify no visual regression in header stacking at default and slightly larger
      font-size (browser zoom test)

**1e. Modal accessibility**
- [ ] Add `Escape`-key listener to close active modals (CSV modal, remove modal, settings
      modal — both apps' equivalents)
- [ ] Add `backdrop-filter: blur(4px)` + darker overlay background to `.overlay`
- [ ] Autofocus first interactive element on modal open via `nextTick(() => ref.focus())`
- [ ] Add `role="dialog"` and `aria-modal="true"` to modal containers
- [ ] Confirm Escape/focus behavior is scoped correctly to the iframe (won't intercept
      Sites-level Escape, and that's expected — document it in the log if it surprises you)

### Exit gate
- [ ] All checklist items done in both apps (or explicitly marked N/A with reason)
- [ ] Manual smoke test on raw `/exec` URL: load data, trigger a success toast, trigger an
      error toast (e.g. bad input), open every modal and close via Escape, resize a column,
      confirm sticky header/section stacking on scroll
- [ ] **Embedded-in-Google-Sites smoke test**: same checks as above, run inside an actual
      Sites embed, in at least Chrome and Safari — this is the step that catches iframe-only
      regressions
- [ ] No console errors introduced
- [ ] Status table at top of this doc updated to ✅

### Session log
- *(empty — add entries as work happens)*

---

## Phase 2: Iconography

**Status:** 🔲 Not started

**Entry gate:** Phase 1 marked ✅ (specifically 1c palette, since icons should use
`currentColor` against the new tokens).

**Rationale:** replaces inconsistent OS-rendered emoji (`⚙ × ● ⚠ ✓`) with **inlined SVG**,
not a CDN icon library — an extra CDN dependency is a real risk inside the sandboxed Sites
iframe (proxy blocks, load failures) for a handful of glyphs that don't justify it.

### Task checklist
- [ ] Identify full glyph inventory across both apps: `⚙` (settings), `×` (remove/close,
      several places), `●` (pending), `⚠` (error/retry), `✓` (synced) — confirm no others
      missed via a fresh grep before starting
- [ ] Source or hand-draw minimal SVG paths for each (e.g. from a permissively-licensed set,
      redrawn/simplified by hand — do not add a CDN or npm dependency)
- [ ] Inline each as a `<svg>` in the template (or a small Vue functional component /
      inline snippet reused via a helper), sized via `em`/`currentColor` so it inherits the
      surrounding text color and the palette tokens from Phase 1
- [ ] Replace emoji usages one-for-one in `inventory_audit/Index.html` and
      `payroll_audit/Index.html`
- [ ] Optional nice-to-have (only if trivial): animate the "syncing" icon as a rotating
      spinner instead of the existing `.spin` div, if it can reuse the same CSS keyframe

### Exit gate
- [ ] No emoji glyphs remain in either `Index.html` for status/UI iconography
- [ ] No new external network dependency added (verify: no new `<script src=` /
      `<link href=` pointing off-origin)
- [ ] Icons render consistently and pick up palette colors correctly in both apps
- [ ] Embedded-in-Sites smoke test (icons visible, not blocked, correctly colored)
- [ ] Status table updated to ✅

### Session log
- *(empty)*

---

## Phase 3: ES5 → ES6+

**Status:** 🔲 Not started

**Entry gate:** Phase 1's item 1a (Promise wrapper) must be ✅ and merged first — doing the
`var`→`const/let`/arrow-function pass before the Promise migration would mean touching the
same lines twice and makes the `async/await` conversion harder to review cleanly on top of
still-ES5 callback code.

**Rationale:** mechanical modernization enabled by the V8 runtime + modern iframe (no
functional change, no build-step requirement). Large diff — treat as its own isolated
commit(s), not bundled with any feature work.

### Task checklist
- [ ] `inventory_audit/Index.html`: replace all `var` → `const`/`let` as appropriate
- [ ] `inventory_audit/Index.html`: replace `function(){...}` callbacks passed to
      `map`/`filter`/`forEach`/etc. with arrow functions; remove now-unnecessary
      `var self = this` capture points
- [ ] Repeat both steps for `payroll_audit/Index.html`
- [ ] Do **not** change logic/behavior in this pass — pure syntax modernization
- [ ] Review diff carefully for `this`-binding changes in non-lexical contexts (e.g. a
      `function` used as an event handler where `this` intentionally referred to the DOM
      element, not the Vue instance) — arrow functions would break that specific case, so
      each conversion needs a sanity check, not blanket find-replace

### Exit gate
- [ ] No remaining `var` declarations in either `Index.html` (verify via grep)
- [ ] No remaining `var self = this` pattern (verify via grep)
- [ ] Full manual regression pass: load, edit/select a note (inventory), CSV upload,
      settings save, sync, column drag/resize (inventory) — behavior identical to pre-Phase-3
- [ ] Embedded-in-Sites smoke test
- [ ] Status table updated to ✅

### Session log
- *(empty)*

---

## Phase 4: Composition API evaluation

**Status:** 🔲 Not started

**Entry gate:** Phases 1–3 ✅. Additionally — **this phase requires an explicit go/no-go
decision, not just checklist completion**, because unlike the prior phases it has no direct
user-facing payoff on its own. Do not start the rewrite without re-confirming with the user
that the trigger condition below is actually met.

**Trigger condition (re-confirm before starting):** the value of the Composition API here
is **enabling shared code between `inventory_audit` and `payroll_audit`** — pulling common
logic (the `gas()` wrapper usage patterns, toast/status handling, settings/admin modal
logic, CSV-upload state machine) into reusable composables instead of duplicated
per-app methods. If, when this phase comes up, there is no active plan to actually extract
shared logic, **defer this phase again** rather than doing a rewrite for its own sake — the
risk (regressing the sync/pending state machine and inventory's drag/resize handlers) isn't
justified by tidiness alone.

### Task checklist (do not start until trigger condition reconfirmed)
- [ ] Re-confirm trigger condition with the user; log the decision here either way
- [ ] Inventory the logic that's actually duplicated between the two apps today (don't
      assume — diff the two `Index.html` files' `methods` blocks)
- [ ] Design composable boundaries (e.g. `useGasCall()`, `useToasts()`,
      `useSettingsAdmin()`, `useCsvUpload()`) — how will they be shared across two separate
      `Index.html` files with no build step? (likely: a shared `.html` include file, or
      duplicated composable source kept byte-identical by convention — decide and document)
- [ ] Migrate one app (`inventory_audit`, the more feature-rich of the two) to
      `Vue.createApp({ setup() {...} })` first as a proof of concept
- [ ] Verify full behavioral parity before touching the second app
- [ ] Migrate `payroll_audit`, using the now-extracted shared composables
- [ ] Remove duplicated logic now covered by shared composables

### Exit gate
- [ ] Both apps on Composition API with no behavior regressions
- [ ] Demonstrated code-sharing win (name the composables and where they're shared)
- [ ] Full manual regression pass on both apps (see Phase 3's list, plus settings/admin
      flows and global-admin flow)
- [ ] Embedded-in-Sites smoke test on both apps
- [ ] Status table updated to ✅

### Session log
- *(empty)*

---

## Growing this plan

When new scope is identified (a new Gemini/review pass, a user request, or something found
mid-implementation), add it as a new phase rather than shoehorning it into an existing one:

1. Add a row to the status table at the top.
2. Add a `## Phase N: <name>` section using the same structure as above: **Status**,
   **Entry gate**, **Task checklist**, **Exit gate**, **Session log**.
3. State the entry gate honestly — what must actually be true (not just "previous phase
   done") before this phase can start safely.
4. If the new phase conflicts with or supersedes a backlog item below, move that item out
   of the backlog and note the resolution.
5. Keep the [Governing constraints](#governing-constraints-apply-to-every-phase) section
   current — if a new constraint is discovered (e.g. a new hosting requirement), add it
   there so every future phase inherits it.

## Backlog (deferred items)

Not scheduled. Listed so they aren't lost if circumstances change; each needs its own
re-evaluation (and likely a new phase per the process above) before being picked up.

- **`localStorage` layout persistence** (inventory only — column order/width). Deferred:
  unreliable in the mandatory Google Sites nested iframe (storage partitioning on
  Safari/Firefox/Chrome). Revisit only with a graceful in-memory fallback designed in from
  the start.
- **Debounce category/note input.** Deferred: inventory's note editing is
  button/`<select>`-driven, not free-text, so the keystroke-thrash problem this would solve
  doesn't currently occur. Revisit only if a free-text note field is introduced.
- **Virtualize long tables (`vue-virtual-scroller` or similar).** Deferred: premature below
  ~500 rows/tab, requires another CDN dependency, and conflicts with the current
  `position:sticky` section rows and inventory's column drag/resize. Revisit only if real
  data volume grows to justify it, and expect real integration work with the sticky/drag
  features.
