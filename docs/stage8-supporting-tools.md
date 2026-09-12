# Stage 8 supporting tools review

Status: Stage 8 deterministic implementation is complete; live SillyTavern UI acceptance is being refined from user desktop/tablet feedback. Stage 9 remains separate and pending.

## Scope and ownership

Stage 8 remains a thin UI/support layer over canonical Delta owners. It does not redesign scanner routing, relationship scoring, evidence, persistence, or terminal-death mechanics.

- `dossier-tools-core.js` owns bounded supporting-tool sessions, top-layer modal mounting, stale checks, and durable-flush reporting.
- `portrait-tools.js` owns the maintained portrait workflow: prompt generation/edit/copy plus explicit device upload/replace/remove. Delta does not call SillyTavern Image Generation from this maintained workflow.
- `dossier-tools.js` owns native Delta backup/restore and compact diagnostics.
- `native-transfer.js` extends the existing native bundle manifest without replacing `bundle.js`.
- `dossier-experience.js` refines the live dossier experience: compact cast rail, selected-dossier actions, adaptive editor sizing, and explicit manual life-state correction. It does not replace the Stage 1 launcher controller.

All UI remains a projection/controller over `NPCStateDelta`; no second dossier store is introduced.

## Launcher and extension-level tools

The movable NPC State launcher opens the dossier directly through the accepted Stage 1 launcher/controller. It is not an extension-tools hub.

**Settings** remains in SillyTavern's Extensions tab and is intentionally not duplicated in the dossier. **Backup** and **Diagnostics** remain dossier-level supporting-tool actions. Supporting dialogs use native modal `<dialog>` top-layer behavior where supported, so they are not dependent on SillyTavern/dossier z-index stacking contexts.

Backup/Restore keeps the versioned native Delta format. Export includes dossiers, portrait assets, declared portable portrait-prompt settings, and audit history. Import validates before mutation, preserves target history ownership, and does not provide Alpha/Beta/legacy converters.

Diagnostics remains read-only and does not initiate scans. It reports only exposed/bounded request, persistence, relationship-fraction/gate, and estimated-token information; credentials, full prompts, and provider responses are excluded.

## Portrait workflow

The selected dossier exposes **Portrait** from its More menu. The maintained workflow supports:

- generate/rebuild positive and negative prompts from the accepted dossier/current resolved appearance;
- edit prompt text without silent replacement during ordinary refresh;
- copy positive, negative, or both prompts;
- upload or replace a portrait from the device through the inherited canonical compression/mutation handler;
- remove the current portrait through the inherited canonical removal handler;
- durable-flush confirmation after portrait mutation, distinguishing saved from local-only outcomes.

There is no Generate Preview, Apply Preview, `/imagine`, or host Image Generation call in the maintained Portrait workflow. Portrait prompt generation is not image generation.

## Selected dossier actions

Frequent actions live directly under the selected dossier:

- **Edit**
- **Refresh**
- **… More**

More contains **Scan dossier**, **Portrait**, and the applicable lifecycle/archive action (**Archive dossier**, **Restore active**, or **Correct death record**). This removes scan/refresh/archive utilities from the editor itself and keeps editing focused on dossier fields.

## Dossier library

The cast library is a compact horizontal portrait rail inspired by the accepted reference layout. It includes a total NPC count, search and existing life-bucket filters, fixed-size portrait cards, selected-card emphasis, horizontal scrolling, and explicit left/right rail controls. The card CSS explicitly replaces the Stage 1 horizontal two-column card grid with a one-column portrait-over-copy layout; leaving both grid definitions active squeezes portraits and text into the distorted narrow columns observed during live host testing.

The canonical Stage 1 search/filter/selection projection remains the data owner.

## Adaptive editor and life state

The native dossier editor remains the canonical field editor, but its popup is sized to the same adaptive envelope as the dossier surface. Desktop uses the dossier-sized viewport and tablet/mobile becomes full-screen with `100dvh` behavior.

The redundant editor **Copy portrait prompts** action is removed from the maintained experience because prompt work belongs to Portrait. Scan, Refresh, and Archive/Restore are likewise presented on the dossier rather than duplicated in Edit.

The editor adds an explicit manual **Life state** control with `Unknown`, `Alive`, and `Deceased` choices. Life state is separate from archive status and current presence.

- Marking **Deceased** writes Delta's canonical `deceased` + `explicit` terminal shape, clears present/world-active, and enters deceased archival state.
- Correcting a confirmed death first uses Delta's canonical Restore/death-correction path so correction provenance remains owned by the runtime, then applies the explicitly selected living/unknown state.
- A non-death manual archive is preserved when life state is changed to Alive/Unknown.
- The short-lived UI-only `dead` + `confirmed` shape is recognized for correction compatibility, but new writes use the canonical terminal shape.

The life-state update uses Delta's canonical native dossier import/flush boundary for the selected record rather than creating another state writer.

## Editor mutation safety

The dossier root and editor now use separate bounded observers. The dossier observer watches only the dossier root. The editor observer reacts only to editor insertion/content changes. Editor text/value synchronization writes only when a displayed value actually changes, preventing the self-triggering `MutationObserver -> textContent mutation -> MutationObserver` loop that could freeze the page immediately after opening Edit.

## Responsive behavior

The dossier keeps the existing selected portrait-led two-pane presentation. The library rail and action row are touch-sized and responsive. On narrower screens the dossier remains full-viewport, cast tools stack, the horizontal card rail stays scrollable, and the editor matches the same full-screen envelope.

Supporting-tool dialogs remain browser top-layer modals with safe-area-aware bounded scrolling.

## Verification boundary

Deterministic tests cover the existing Stage 8 native-transfer/stale/persistence safety layer plus manual life-state transformations, canonical terminal state writes, idempotent editor synchronization, direct-launcher ownership, corrected portrait-card layout, and maintained prompt-only portrait behavior. Repository validation and package checks must pass on the exact PR candidate before merge.

Live SillyTavern checks still matter for:

- launcher direct-to-dossier interaction after dragging;
- desktop/tablet/mobile dossier and editor sizing;
- cast rail scrolling and portrait thumbnail layout;
- More-menu reachability;
- device portrait picker/upload/remove;
- life-state confirmation/correction UX;
- update arrival while the dossier or editor is open.

Synthetic CI is not treated as proof of those browser behaviors.
