# Histology Lab OS — shared UI foundation

Build pages from these pieces. Design source of truth: `docs/design-spec.md`.

**Rules that apply everywhere**
- Tokens only. Tailwind's default palette is **disabled** (`bg-red-500` silently does nothing). Use token classes: `bg-canvas bg-surface bg-surface-subtle bg-surface-sunken`, `border-line border-line-strong`, `text-ink text-ink-secondary text-ink-muted text-ink-disabled`, `bg-brand text-brand bg-brand-50 bg-brand-100 text-brand-ink`, tones `{info|success|warning|danger|hold}-{fg|bg|border|solid}`, doctors `bg-dr-{teal|violet|amber}` / `-tint`, `bg-pas-bg text-pas-fg border-pas-border bg-pas-row`, `{bg|text|border}-sim-*`, `text-white`. Never put text on `warning-solid`.
- Type scale: `text-xs` 12, `text-sm` 13, `text-base` 15, `text-md` 17, `text-lg` 20, `text-xl` 24, `text-2xl` 30. Weights 400/500/600 only. Radius `rounded-sm` (4, chips/inputs), `rounded-md` (6, buttons/cards), `rounded-lg` (10, panels/dialogs), `rounded-pill` (pills only). Shadows `shadow-1/2/3`.
- Every identifier uses `id-mono` (never truncated). Numbers in table columns use `num-tabular`.
- Copy: "Scanned"/"Matched", never "verified" for a scan. `Unknown` (with reason), never 0/blank/dash. Label simulated connectors and illustrative numbers in words.
- Layout CSS vars: `--hlo-chrome-h` (banner + top bar; the top bar `--hlo-topbar-h` is 3.25rem, 52px at the default text size, 6.375rem below 1024px), `--hlo-identity-h` (68px), `--hlo-panel-w` (420px), `--hlo-row-h` / `--hlo-cell-fs` (density). Print: `.print-only` shows only in print, `.no-print` hides in print; shell chrome is hidden automatically.
- Times: pass the **demo** now. Server: `readClock(getDb()).now`. Client: `useDemoNow()`.

Imports: `@/components/ui/<file>` and `@/components/domain/<file>`, or the barrels `@/components/ui` and `@/components/domain`. Files marked (client) use hooks; everything else also works in server components.

---

## Shell (already mounted by `src/app/layout.tsx`; pages render only their content)

`AppShell` (server) loads the demo actor (cookie `hlos_actor`), clock, sources, staff and nav counts, and renders: skip links, one hematoxylin `TopBar` (`BrandMark`, `JobNav` grouped by job, `ScanField`, `SourceFreshness`, `ShortcutsButton`, `DemoBanner` "Synthetic demo", and in synthetic demo mode only the read-only `DemoRoleIndicator` (demo role and demo time, not a control) and `PresenterConsoleLink` to `/demo`; the role switch `ActingAs`, `DemoClockPanel`, every simulated world event and the Settings link live on the presenter console, never on a bench screen), and `<main id="main">` at full width. Visual rules: docs/redesign/visual-system.md. Pages start with `<PageBody>` (padding) or, for case work, an `IdentityBar` first.

`landingPathFor(role)` in `shell/landing.ts` — role → landing route (used by `/`).

---

## ui/

| Component | Props | Use when |
|---|---|---|
| `Button` | `variant: primary\|secondary\|ghost\|destructive\|quiet` (default secondary), `size: sm\|md\|lg` (32/40/48px), `loading`, `loadingLabel` ("Requesting..."), `icon`, `reasonId` (id of visible disabled reason), plus native button props incl. `ref` | Any action. Verb-first label. One primary per region. Loading keeps width and disables. |
| `ButtonLink` | `href` + Link props, `variant`, `size`, `icon` | Navigation styled as a button. |
| `DisabledReason` | `id`, `children` | Visible "why is this disabled" text next to a control; pass its id as `reasonId`. |
| `CommandButton` (client) | `command`, `input` (value or `() => value`), `children`, `variant`, `size`, `pendingLabel`, `icon`, `confirm?: {title, body?, confirmLabel, cancelLabel, destructive?}`, `disabledReason`, `disabled`, `showError: inline\|toast\|both`, `successToast`, `replayToast`, `onSuccess`, `onError`, `conflict`, `refresh`, `wrapperClassName` | One-click state change through `/api/commands/<name>`. Handles idempotency key per intent, double-click, refresh, inline error, conflict dialog, optional confirm. |
| `CommandError` (client) | `error: CommandFailure \| null`, `id?` | Inline danger text for a failed command ("Not allowed: …"). |
| `StatusPill` | `tone: neutral\|info\|success\|warning\|danger\|hold`, `children`, `icon?`, `size: sm\|md` | One status per row. |
| `StatePill` | `domain: clarification\|gross\|sourceUpdate\|print\|traySlide\|tray\|routing\|intake\|retrieval\|sync`, `state` (DB value), `suffix?` | Status pill with the spec's exact wording and tone (`PILL_STATES`, `pillTone()`). |
| `AlertBanner` | `tone: info\|success\|warning\|danger`, `title`, `children` (body), `action?`, `blocking?` (danger → role=alert), `icon?`, `headingLevel?` | Page/section messages: error, partial success, printer unavailable, blocked reasons. Not dismissible. |
| `Card` / `Panel` | `title?`, `description?`, `actions?`, `footer?`, `headingLevel` (2), `flush` (no body padding), `as`, `id`, `bodyClassName` | A working surface/region. |
| `FactList` | `items: {label, value}[]` | Label/value facts in cards and side panels. |
| `PageHeader` | `title`, `description?`, `actions?`, `simulated?: string\|true`, `illustrative?: string\|true`, `readOnly?`, `meta?` ("Refreshing...") | Top of every page (h1). |
| `PageBody` | `children`, `className` | Standard page padding and 16px rhythm. |
| `EmptyState` | `title`, `children` (why empty + how to start), `action?`, `icon?`, `compact?` | Empty lists. Never just "No data". |
| `Skeleton`, `SkeletonRows` | `className`; `rows`, `columns` | First load (set `aria-busy` on the region). |
| `Tabs` (client) | `items: {key, label, count?, href?, disabled?}[]`, `active`, `label` (aria name), `onChange?`, `idBase?`, `size` | Link mode when every item has `href` (URL-kept tabs/saved filters, aria-current). Button mode otherwise (ARIA tablist + `TabPanel`). Counts render "To review (3)"; `count: null` shows none. |
| `TabPanel` (client) | `idBase`, `tabKey`, `active`, `children` | Panel for button-mode Tabs. |
| `SidePanel` (client) | `title`, `identity?` (chip), `status?` (pill), `fullRecordHref?`, `closeHref?` or `onClose?`, `focusKey?`, `preserveFocus?`, `belowIdentityBar?`, `footer?`, `children` | One record's detail beside a list. Focuses heading on open, Esc closes, focus returns to the opener. In the stacked layout (200% zoom) it is a modal sheet: a dialog over a scrim, the rest of the page inert (mark live regions that must stay usable with `data-modal-exempt`). Keep `?selected=<id>` in the URL and pass `closeHref`. |
| `SidePanelLayout` (client) | `children` (list), `panel?` | Push layout: list left (keeps scroll/selection), panel right; overlays below 1280px. |
| `Dialog` (client) | `open`, `onClose`, `title`, `description?`, `children`, `footer?`, `size: sm\|md\|lg`, `initialFocusRef?`, `role?`, `hideCloseButton?` | Native modal `<dialog>`. Esc → `onClose`. Focus returns to the trigger. |
| `ConfirmDialog` (client) | `open`, `title` (names action + object), `children`, `confirmLabel`, `cancelLabel`, `onConfirm`, `onCancel`, `destructive?`, `pending?`, `pendingLabel?`, `confirmDisabled?` | Destructive/irreversible confirmations. Focus starts on the safe option. Never "OK/Cancel". |
| `ConflictDialog` (client) | `open`, `onClose` (= Keep editing), `onLoadLatest`, `onDiscard`, `fields: {field, label?, theirs, yours}[]`, `changedBy?`, `changedAt?`, `subject?`, `message?`, `now?` | Normally opened for you by `useCommand` on CONFLICT. No overwrite option. |
| `Toast` — `ToastProvider` (mounted), `useToast()` (client) | `show({tone: info\|success\|warning, title, body?, action?: {label, onClick}, durationMs?})` → id; `dismiss(id)` | Confirmation of something that also appears in History. Success auto-hides 6 s, warning stays. Blocking errors go in `AlertBanner`/`CommandError`. |
| `Field` (client) | `label`, `children` (one control), `hint?`, `error?`, `required?` ("(required)"), `unit?` ("Length (mm)"), `id?`, `labelHidden?` | Wraps `Input`/`Select`/`Textarea`; wires id, `aria-describedby`, `aria-invalid`. |
| `Label`, `Input`, `Select`, `Textarea`, `Checkbox` (client) | native props + `invalid?`, `size: sm\|md` (Input/Select), `mono?` (Input, identifiers); `Checkbox`: `label`, `hint?` | Form controls with visible labels. |
| `Kbd` | `children` | Key caps in help text. |
| `Tooltip` (client) | `content`, `children` (focusable element), `side?`, `focusable?` (wrap non-focusable child) | Extra detail only (full date + UTC, namespace). Never the only place for a value or reason. |
| `Table`, `THead`, `TBody`, `TH`, `TR`, `TD`, `TableMessageRow`, `TableCount` | `Table`: `caption` (required; hidden unless `captionVisible`), `scroll: container\|page`, `maxHeight?`, `belowIdentityBar?`, `busy?`, `hideP3?`, `hideP2?`. `TH`: `sort?: asc\|desc\|none`, `onSort?`, `align?`, `priority?: 1\|2\|3`, `stickyFirst?`. `TR`: `selected?` (aria-selected, fill + hairline outline), `hold?` (hatched first cell), `pas?` (pale tint kept when selected), `canceled?`, `interactive?`. `TD`: `numeric?`, `priority?`, `stickyFirst?`, `wrap?`. `TableCount`: `shown`, `total`, `noun` | Dense lists. Row height/text follow density. Use @tanstack/react-table for sorting/grouping logic and render with these. Empty cells: "None" when known empty, `UnknownValue` when unknown. |
| `Timeline` (client) | `events: {id, at, actorName?, actorRole?, summary, source: local\|source\|demo\|office\|assistant\|system, object?, details?: {label, before?, after?}[] \| ReactNode, reason?}[]`, `now`, `order?`, `showNote?` (default true), `title?`, `emptyText?` | Case history, clarification timeline. Shows "Local append-only audit log for this demo. Not proof of tamper resistance." `sourceFromOrigin(audit_event.origin)` maps origins; `SourceTag` is exported. |
| `tone.ts` | `TONE_ICON`, `TONE_CLASSES`, types `Tone`, `AlertTone` | Building a new tone-aware element. |

## domain/

| Component | Props | Use when |
|---|---|---|
| `AccessionChip` | `accession`, `namespace?` ("EMA-SIM DERM"), `compact?` (hide caption), `href?` (default `/cases/<accession>`; `false` = no link) | Official accession anywhere. |
| `ProvisionalChip` | `id` ("INT-1014-031"), `compact?`, `href?` (default `/intake?item=<id>`) | Before an accession exists. "Provisional" is always visible. |
| `IdChip` | `id`, `kind: CLR\|WO\|PJ\|TRY\|RR\|ORD\|MRN\|INT\|HOLD\|PART\|BLOCK\|SLIDE\|TASK\|OTHER`, `tenant?` (required in practice for MRN/ORD), `href?`, `showKind?` | Every other identifier. Slide chips include the stain ("D26-04817 A1-2 PAS"). |
| `PartChip` | `part` ("B"), `description?` ("dorsal forearm, punch"), `warning?` ("Order says Right, bottle says Left.") | Part identity (identity bar, parts strip). |
| `DoctorChip` | `name` (null → "Unassigned: routing exception"), `color: teal\|violet\|amber`, `shortName?`, `compact?`, `showColorName?` ("(teal)"), `withRole?` | Assigned dermatopathologist. Swatch + name, never color alone. Also `DoctorSwatch`, `DOCTOR_SWATCH/TINT/STRIPE` class maps for group headers. |
| `PasTag` | `workOrder?` ("WO-2213"), `target?` ("A1-2"), `source?` ("Source order"), `canceled?` | PAS everywhere. Detailed variant when `workOrder`/`target` given. Canceled stays visible, struck through. |
| `HoldBanner` | `scope` ("Part B"), `reason`, `otherScopeNote?` ("Part A can continue."), `evidence?`, `clarification?: {displayId, href?, state?}`, `owner?`, `nextFollowUpAt?`, `now?`, `headingLevel?`, `children?` | Part/case hold. Not dismissible; scope always named. |
| `HoldPill` | `scope?` | "Hold: Part B" in tables and the identity bar. |
| `HoldTag` | — | Solid "HOLD" (print snapshot, very dense rows). |
| `SimulatedLabel` | `connector?` ("notifications"), `children?`, `size?` | Only where data leaves/enters through a connector: send, print, accession request, sync, AI draft. |
| `IllustrativeTag` | `children?` (default "Illustrative: synthetic prior-day data") | Charts and computed demo numbers. |
| `UnknownValue` | `reason?`, `label?` | Any unknown value. |
| `ReadOnlyTag`, `SyntheticTag` | — | Director roles; after synthetic patient names. |
| `StaleBanner` | `sourceName`, `since` (ISO or null), `now`, `detail?`, `action?` | Source offline/stale at the top of content. |
| `IdentityBar` (client) | `identity: {kind:"accession", accession, namespace?} \| {kind:"provisional", id}`, `part?: {letter, description?, warning?}`, `patient?: {name, mrn?, tenant?}`, `office?`, `doctor?: {name, color?} \| null` (null = unassigned; omit = hidden), `holds?: string[]`, `pas?: boolean \| {workOrder?, target?}`, `actions?`, `contextKey?`, `announcement?` | Sticky "Current case" bar on /grossing, /materials, /cases/[id], led by the `SpecimenLabel` (dashed provisional, solid official with DataMatrix). Changing `contextKey` flashes a 2px outline and announces "Now working on …". Reset your form when it changes. |
| `SpecimenLabel` (client) | `status: provisional\|official`, `id`, `parts?`, `lines?` (≤2 short lines), `payload?` (official DataMatrix), `size?: lg\|md` | The signature: the part in hand set as its label. Provisional ids never look official. |
| `LabelPreview` (client) | `payload` (from `encodeLabel`), `text` (from `humanLabel`), `size?` (88), `showPayload?` (true), `caption?` (true) | Label previews in print jobs. DataMatrix via bwip-js; alt text gives the content. |
| `PersonName` | `role: ordering_clinician\|assigned_dermatopathologist\|accessioner\|owner\|office_contact\|reviewer\|requester\|<Role>`, `name` (null → Unknown), `org?`, `inline?` | Any person: "Ordering clinician: Dr. Hannah Cole (Harbor Point Dermatology)". |
| `Timestamp` | `iso`, `now`, `showAge?` ("(12 min ago)"), `unknownText?` | Times in rows/panels: "10:40 AM ET", full date + UTC in tooltip, `<time datetime>`. |

## Client helpers — `src/lib/client/`

| Export | Signature | Notes |
|---|---|---|
| `useCommand` (`command.ts`) | `useCommand<R, I>(name, { successToast?, replayToast?, errorToast? = true, refresh? = true, onSuccess?, onError?, conflict?: false \| {fieldLabels?, subject?, onLoadLatest?(current), onDiscard?(current), fields?} })` → `{ run(input): Promise<CommandOutcome<R>>, pending, error, result, reset }` | One idempotency key per intent (same input = retry → same key; success clears it). Repeated `run` while pending returns the same promise. Success → `router.refresh()`. CONFLICT → global ConflictDialog (fields derived from `details.current` vs your input; camelCase input keys are matched to snake_case columns). Other failures → returned `error` (+ warning toast). |
| `runCommand` | `runCommand<R>(name, input, { idempotencyKey?, signal? })` → `CommandOutcome<R>` | Low-level fetch. |
| `fieldErrors(error)` | → `Record<path, message>` | Field messages from a VALIDATION error (zod tree). |
| `ERROR_TITLE`, types `CommandFailure`, `CommandOutcome`, `CommandErrorCode` (`DomainErrorCode \| "NETWORK"`) | | |
| `useConflict()` (`conflict.tsx`) | `{ open({message?, details?, yours?, fields?, fieldLabels?, subject?, onLoadLatest?, onDiscard?}), close() }` | Open the conflict dialog yourself. `deriveConflictFields()` exported. |
| `useLive()` (`live.tsx`) | `{ data: {auditSeq, worklistSeq, clock, sources}, ok, receivedAt, sync(), pollNow() }` | Polled every 2.5 s by `LiveRefresh` (paused when hidden); refreshes the page when audit/worklist counters move. `useLiveActions()` = `{sync, pollNow}` only. |
| `useDemoNow(tickMs?)` | → ISO string | Demo-clock now, ticking locally while the clock runs. |
| `useScanTarget` (`scan.tsx`) | `useScanTarget(label \| null, handler, { placeholder? })`; handler `(value, { navigate }) => ScanOutcome \| void \| Promise<…>`; `ScanOutcome = { tone: success\|info\|warning\|danger, message, alert?, sound?: match\|mismatch\|null, keepValue? }` | Register what a scan does on this page ("Add to tray TRY-M-03"). Unregisters on unmount. Return `alert: true` for blocking mismatches. |
| `useScan()` | `{ target, isDefault, focus(), setResult(outcome, value?), resetTarget(), submit(value), result, pending, inputRef }` | Return focus to the scan field after an action: `useScan().focus()`. |
| `useFocusScanOnMount(enabled?)` | | Bench pages: focus the scan field on load. |
| `resolveFindRecord(text)` | | Default "Find record": `D26-04817[ A1-2 PAS]` → `/cases/D26-04817[?part=A]`; `INT-1014-031` → `/intake?item=…`; `CLR-0457` → `/clarifications?selected=…`; `PJ-…` → `/materials?tab=print&selected=…`; `TRY-…` → `/materials?tab=trays&selected=…`; `RR-…` → `/materials?tab=retrieval&selected=…`; `HL1:…` label payloads are decoded (`decodeLabel`) and open the case (`?part=`). **Pages: honor these params.** |
| `usePreference(key, default)`, `usePref(PREFS.x)`, `readPreference`, `writePreference` (`preferences.ts`) | `PREFS`: `density` (auto\|compact\|comfortable), `sound` (false), `soundVolume` (0.5), `singleKeyShortcuts` (true), `scannerSuffix` (enter\|tab), `navCollapsed` | localStorage, try/catch guarded (falls back to memory). For the Settings > Preferences tab. |
| `playTone(kind, volume)`, `playScanFeedback(kind)` (`sound.ts`) | `kind: match \| mismatch` | Web Audio tones. `playScanFeedback` respects the sound preference (off by default). Use `playTone` for "Play test sound". |
| `useSingleKey(map, enabled?)` (`keyboard.tsx`) | `useSingleKey({ j: next, k: prev, Enter: open, a: ack })` | Page shortcuts; ignored while typing, in dialogs, with modifiers, or when single-key shortcuts are off. Also `isEditableTarget`, `isDialogOpen`, `singleKeyShortcutsOn`, `openShortcutHelp`. Global: `/`, Ctrl/Cmd+K, `?`, `G` then I/C/W/G/M/O. |
| `useActor()`, `useStaff()`, `useStaffName()`, `useCan(permission)`, `isReadOnlyRole(role)` (`shell-context.tsx`) | `useCan` → `{ allowed, reason }` | UI hints only (explain disabled controls). The server enforces permissions. |
| `useUnsavedChanges(isDirty, label)`, `hasUnsavedChanges()` (`unsaved.ts`) | | Register dirty forms; the role switch asks first and the browser warns before leaving. |
| `syncState`, `syncSentence`, `worstSyncState`, `sourceLabel`, `tenantSources`, `SYNC_THRESHOLDS_MIN` (`freshness.ts`) | | Source freshness rules (5/15 min, demo settings) for the Operations freshness panel. |
| `DEMO_CLOCK_COMMAND`, `DemoClockInput` (`demo-commands.ts`) | `"demo.setClock"` with `{ advanceMinutes? , iso?, running?, reset? }` | The top-bar demo clock uses it (advance 5 min, jump to 11:00, pause/resume, explicit reset to 10:52 after a confirm). |
| Types (`types.ts`) | `LivePayload`, `LiveSource`, `ClockSnapshot`, `ShellActor`, `ShellStaff`, `NavCounts` | |

Other shared modules: `@/lib/cn` (`cn(...)` = clsx + tailwind-merge aware of the theme), `@/lib/tokens` (hex mirror for Recharts: `DOCTOR_COLORS`, `AGE_RAMP`, `AGE_BUCKET_LABELS`, `CHART`, `ALERT_SOLID`, `PAS`, `TEXT`, `CSS_TOKEN_MIRROR`).

## API routes used by the shell

- `POST /api/commands/<name>` `{ input, idempotencyKey }` → `{ ok: true, result, replayed? }` or `{ ok: false, error: { code, message, details } }` with HTTP status from `httpStatusFor`.
- `GET /api/live` → `{ auditSeq, worklistSeq, clock, sources, delivered }` (calls `pumpSources(db)` first).
- `GET|POST /api/session` `{ staffId }` → `{ ok, actor }`. Demo role switch, not authentication.
- Server: `getActor()`, `getActorId()` in `@/server/session`.

## Page recipe

```tsx
// Server page
import { PageBody, PageHeader, Card } from "@/components/ui";
export default async function Page({ searchParams }: { searchParams: Promise<{ selected?: string }> }) {
  const { selected } = await searchParams;          // Next 16: async
  const now = readClock(getDb()).now;               // demo now for Timestamp / fmtSmart
  return (
    <PageBody>
      <PageHeader title="Clarifications" description="…" />
      <ClientList rows={rows} selected={selected ?? null} now={now} />
    </PageBody>
  );
}
```
Client lists: `SidePanelLayout` + `Table` + `SidePanel closeHref=…`; actions with `CommandButton` or `useCommand`; scans with `useScanTarget`.
