# Stage 8 supporting tools review

Status: Stage 8 deterministic implementation is complete; live SillyTavern UI acceptance is being refined from user desktop/tablet feedback. Stage 9 remains separate and pending.

## Scope and ownership

Stage 8 remains a thin UI/support layer over canonical Delta owners. It does not redesign scanner routing, relationship scoring, evidence, persistence, or terminal-death mechanics.

- `dossier-tools-core.js` owns bounded supporting-tool sessions, top-layer modal mounting, stale checks, and durable-flush reporting.
- `portrait-tools.js` owns the maintained portrait workflow: prompt generation/edit/copy plus explicit device upload/replace/remove. Delta does not call SillyTavern Image Generation from this maintained workflow.
- `dossier-tools.js` owns native Delta backup/restore and compact diagnostics.
- `native-transfer.js` extends the existing native bundle manifest without replacing `bundle.js`.
- `dossier-experience.js` consolidates the live dossier experience: launcher hub, compact cast rail, selected-dossier actions, adaptive editor sizing, and explicit manual life-state correction.

All UI remains a projection/controller over `NPCStateDelta`; no second dossier store is introduced.

## Launcher and extension-level tools

The movable NPC State launcher is now the extension-level hub instead of opening the dossier directly. It exposes:

- **Dossiers**
- **Settings**
- **Backup / Restore**
- **Diagnostics**

The dossier header therefore no longer needs standalone Settings, Backup, or Diagnostics buttons. Supporting dialogs use native modal `<dialog>` top-layer behavior where supported, so they are not dependent on SillyTavern/dossier z-index stacking contexts.

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

The cast library is a compact horizontal portrait rail inspired by the accepted reference layout. It includes a total NPC count, search and existing life-bucket filters, fixed-size portrait cards, selected-card emphasis, horizontal scrolling, and explicit left/right rail controls. The canonical Stage 1 search/filter/selection projection remains the data owner.

## Adaptive editor and life state

The native dossier editor remains the canonical field editor, but its popup is sized to the same adaptive envelope as the dossier surface: desktop uses the dossier-sized viewport and tablet/mobile becomes full-screen with `100dvh` behavior.

The redundant editor **Copy portrait prompts** action is removed from the maintained experience because prompt work belongs to Portrait. Scan, Refresh, and Archive/Restore are likewise presented on the dossier rather than duplicated in Edit.

The editor adds an explicit manual **Life state** control with `Unknown`, `Alive`, and `Deceased` choices. Life state is separate from archive status and current presence.

- Marking **Deceased** is an explicit terminal user decision: present/world-active are cleared and the record enters deceased archival state.
- Correcting a confirmed death first uses Delta's canonical Restore/death-correction path so correction provenance remains owned by the runtime, then applies the explicitly selected living/unknown state.
- A non-death manual archive is preserved when life state is changed to Alive/Unknown.

The life-state update uses Delta's canonical native dossier import/flush boundary for the selected record rather than creating another state writer.

## Responsive behavior

The dossier keeps the existing selected portrait-led two-pane presentation. The library rail and action row are touch-sized and responsive. On narrower screens the dossier remains full-viewport, cast tools stack, the horizontal card rail stays scrollable, and the editor matches the same full-screen envelope.

Supporting-tool dialogs remain browser top-layer modals with safe-area-aware bounded scrolling.

## Verification boundary

Deterministic tests cover the existing Stage 8 native-transfer/stale/persistence safety layer plus the consolidated experience's manual life-state transformations and maintained prompt-only portrait behavior. Repository validation and package checks must pass on the exact PR candidate before merge.

Live SillyTavern checks still matter for:

- launcher hub interaction after dragging;
- desktop/tablet/mobile dossier and editor sizing;
- cast rail scrolling and portrait thumbnail layout;
- More-menu reachability;
- device portrait picker/upload/remove;
- life-state confirmation/correction UX;
- update arrival while the dossier or editor is open.

Synthetic CI is not treated as proof of those browser behaviors.
