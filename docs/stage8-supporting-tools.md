# Stage 8 supporting tools review

Status: Stage 8 deterministic implementation is complete; live SillyTavern UI acceptance is being refined from user desktop/tablet feedback. Stage 9 remains separate and pending.

## Scope and ownership

Stage 8 remains a thin UI/support layer over canonical Delta owners. It does not redesign scanner routing, relationship scoring, evidence, persistence, or terminal-death mechanics.

- `dossier-tools-core.js` owns bounded supporting-tool sessions, top-layer modal mounting, stale checks, and durable-flush reporting.
- `portrait-tools.js` owns the maintained portrait workflow: prompt generation/edit/copy plus explicit device upload/replace/remove. Delta does not call SillyTavern Image Generation from this maintained workflow.
- `dossier-tools.js` owns native Delta backup/restore and compact diagnostics.
- `native-transfer.js` extends the existing native bundle manifest without replacing `bundle.js`.
- `dossier-experience.js` refines the live dossier experience: cast carousel, selected-dossier actions, adaptive editor organization, settings presentation, and explicit manual life-state correction. It does not replace the Stage 1 launcher/controller or canonical editor/state owners.

All UI remains a projection/controller over `NPCStateDelta`; no second dossier store is introduced.

## Launcher and extension-level tools

The movable NPC State launcher opens the dossier directly through the accepted Stage 1 launcher/controller. It is not an extension-tools hub. The 48 px drag/touch target is presented as a circular floating launcher while retaining the existing position persistence and drag behavior.

**Settings** remains in SillyTavern's Extensions tab and is intentionally not duplicated in the dossier. Extension-wide **Backup / Restore** and **Diagnostics** are consolidated into the Settings Data & maintenance section rather than occupying the dossier header. Supporting dialogs use native modal `<dialog>` top-layer behavior where supported, so they are not dependent on SillyTavern/dossier z-index stacking contexts.

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

There is no Generate Preview, Apply Preview, `/imagine`, or host Image Generation call in the maintained Portrait workflow. Portrait prompt generation is not image generation. Settings therefore presents this area as **Portrait prompts** and hides the obsolete maintained-UI generation/gallery toggles while leaving their legacy controls mounted for compatibility.

## Selected dossier actions

The selected dossier presentation itself is intentionally left unchanged. Frequent actions remain directly under it:

- **Edit**
- **Refresh**
- **… More**

More contains **Scan dossier**, **Portrait**, and the applicable lifecycle/archive action (**Archive dossier**, **Restore active**, or **Correct death record**). Scan/refresh/archive utilities are not duplicated in Edit.

## Cast carousel

The library is a compact horizontal cast carousel inspired by the accepted reference layout. Each fixed-size card is a full-bleed portrait (or initial placeholder) with name, identity metadata and lifecycle status overlaid on a bottom gradient. The carousel keeps the canonical Stage 1 count, search, filters and selection projection while adding selected-card emphasis, touch/trackpad scrolling and explicit left/right controls.

The browser scrollbar is visually hidden so the rail reads as a cast carousel rather than a nested data pane. The library row reserves enough height for the toolbar and complete cards, avoiding the clipped card bottoms seen in live host testing.

## Adaptive editor and life state

The native dossier editor remains the canonical field editor and uses the dossier-sized desktop envelope plus full-screen narrow/tablet/mobile behavior. The popup now has exactly one maintained scrolling region: SillyTavern's outer popup content is overflow-contained and `#npc_state_delta_editor_content` owns vertical scrolling. Save/Cancel remain outside that body.

The existing editor controls are reorganized without creating replacement field owners:

- **Identity & profile**
- **Current state**
- **Relationships**
- **Continuity**
- **Advanced NPC options**

Advanced NPC options contains manual **Life state**, stable-profile protection, stale-cleanup retention and Minor NPC controls. Existing per-NPC portrait override inputs remain mounted but hidden so the canonical save path preserves their values; maintained portrait prompt editing belongs to Portrait instead.

The manual Life state choices are `Unknown`, `Alive`, and `Deceased`. Life state is separate from archive status and current presence.

- Marking **Deceased** writes Delta's canonical `deceased` + `explicit` terminal shape, clears present/world-active, and enters deceased archival state.
- Correcting a confirmed death first uses Delta's canonical Restore/death-correction path so correction provenance remains owned by the runtime, then applies the explicitly selected living/unknown state.
- A non-death manual archive is preserved when life state is changed to Alive/Unknown.
- The short-lived UI-only `dead` + `confirmed` shape is recognized for correction compatibility, but new writes use the canonical terminal shape.

The life-state update uses Delta's canonical native dossier import/flush boundary for the selected record rather than creating another state writer.

## Settings organization

The Extensions-tab Settings panel keeps the same canonical inputs and handlers but groups them by task instead of presenting one long wall of controls:

1. **General**
2. **Scanning**
3. **Continuity & injection**
4. **Roster & cleanup**
5. **Portrait prompts**
6. **Relationship tuning** (Advanced)
7. **Memory & behavior rules** (Advanced)
8. **Data & maintenance**

Data & maintenance contains native Backup / Export, Restore / Import and Diagnostics plus the current-chat scan/add/clear operations and a collapsible current-chat roster. Legacy transfer controls remain mounted but hidden so existing bindings are not broken.

## Mutation safety

The dossier root and editor use separate bounded observers. The dossier observer watches only the dossier root. The editor observer reacts only to editor insertion/content changes. Editor text/value synchronization writes only when a displayed value actually changes, preventing the self-triggering `MutationObserver -> textContent mutation -> MutationObserver` loop that previously froze the page after opening Edit.

Settings restructuring is one-shot and idempotent; it moves existing controls instead of copying or recreating their state.

## Responsive behavior

The dossier keeps the existing selected portrait-led two-pane presentation. The carousel and action row are touch-sized and responsive. On narrower screens the dossier remains full-viewport, cast tools stack, the cast carousel stays horizontally scrollable without a visible browser scrollbar, and the editor becomes full-screen with a single body scroll.

Supporting-tool dialogs remain browser top-layer modals with safe-area-aware bounded scrolling.

## Verification boundary

Deterministic tests cover the existing Stage 8 native-transfer/stale/persistence safety layer plus manual life-state transformations, canonical terminal state writes, idempotent editor synchronization, direct-launcher ownership, circular launcher presentation, full-portrait carousel layout, single-scroll editor organization, Settings grouping, and maintained prompt-only portrait behavior. Repository validation and package checks must pass on the exact PR candidate before merge.

Live SillyTavern checks still matter for:

- circular launcher dragging and direct-to-dossier activation;
- desktop/tablet/mobile carousel card proportions and overlay readability;
- editor single-scroll behavior and persistent Save/Cancel reachability;
- Extensions Settings grouping and native Backup / Restore / Diagnostics actions;
- More-menu reachability;
- device portrait picker/upload/remove;
- life-state confirmation/correction UX;
- update arrival while the dossier or editor is open.

Synthetic CI is not treated as proof of those browser behaviors.
