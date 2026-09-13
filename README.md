# NPC State Delta v1.0.4

Delta is a standalone SillyTavern NPC continuity extension: a completed story exchange is scanned, grounded dossier changes are persisted with chat/branch ownership, and relevant accepted characterization reaches the next roleplay request. It is built forward from the pinned source recorded in `docs/seed-provenance.*`, not from a replacement Beta/Alpha engine.

Stages 1-9 are implemented. Delta 1.0.4 is a bounded targeted-Refresh parity hotfix on the accepted 1.0.x architecture. It retains the 1.0.1 grounded apparent-age fix, 1.0.2 manual birthday correction, and 1.0.3 implicit anatomical-transition/native-export fixes, while making direct per-NPC Refresh advertise and reconcile the same appearance-form fields as the accepted Stage 4 model. No extra scanner request, completeness pass, retry, relationship-model change, or model worker is added. Live SillyTavern/Gemini extraction quality, provider latency, physical-device file pickers and actual image-provider behavior are separate verification boundaries, not claims made by this release. See [Stage 9 evidence](docs/stage9-review.md).

## Features and controls

**Dossiers.** The floating launcher opens a searchable portrait-led cast library. Edit dossier identity, personality, behavior, voice, goals, memories and relationships through the existing editor. Manual Add NPC, archive, removal and correction remain explicit controls. Story-text OOC commands do not execute.

**Appearance forms.** The dossier displays resolved current appearance and named forms. In Edit, Appearance forms exposes shared appearance, the selected form, named `Form name | Description` entries and an unclassified current presentation. Apply appearance forms saves that section independently of unrelated editor drafts. The shared resolver is also used by portrait prompts and roleplay injection; selecting one form does not overwrite another form's anatomy or canonical colors. Scanner form handling recognizes grounded anatomical transitions such as horns, wings, tails, plumage or ears visibly dissolving, retracting, appearing or otherwise changing even when narration never uses the words `form` or `transform`. Direct per-NPC Refresh now uses the same form/current-presentation contract and receives the selected NPC's established form context, so an unnamed new presentation can become current without erasing stored alternate anatomy.

**Calendar & birthdays.** Dedicated settings accept ordered `Month name:days` lines and an optional era. No current year is required for stable deterministic month/day birthdays. A manual year/month/day is an optional all-or-none fallback. Recognized full dates in the owned assistant World State can supply chronology during scanning. Exact actual age may anchor a derived birth year; a compatible full birth date supports local chronological aging. Generated dates remain distinguishable from established dates. Edit Dossier exposes Birthday beside Chronological age so a generated or story-established birthday can be corrected manually; the entered value is validated against the active calendar, accepted through the canonical birthday continuity engine, and recorded as an established manual correction without a model call. Apparent age and fantasy lifespan are never used for chronological deduction. See [birthday continuity](docs/birthday-continuity.md) for supported formats and limits.

**Portraits.** Dossier More > Portrait provides device upload/replacement, removal, editable positive/negative prompts, copying and explicit prompt rebuilding. That maintained surface is prompt-and-upload based. The retained runtime host-image workflow uses SillyTavern Image Generation independently of the scanner and keeps generated results preview-only until explicit application. Neither an appearance change nor a generated preview silently replaces an uploaded image. Uploads are bounded and failures/cancellation preserve the previous portrait.

**Scanning and routes.** Settings > Scanning controls cadence, admission, full-window mode and the scanner connection profile. Empty profile retains the host default route; an explicit unavailable profile fails visibly rather than silently falling back. Ordinary roleplay and image generation retain their own routes. Direct Refresh remains one targeted NPC request over the configured recent-story window; 1.0.4 changes its form schema/context, not its request count. Maximum output tokens `0` preserves the built-in per-request allowances; an existing explicit override remains supported. No extra completeness/self-review calls, model worker or generation barrier is added.

**Relationships and lifecycle.** Accepted signed relationship formulas, fractional progress, directional gates, milestones, evidence rules and duplicate handling are preserved. Explicit confirmed death is terminal to automatic writers. A deliberate manual erroneous-death correction or owned rollback can correct invalid death state without fabricating narrative resurrection.

**Native data and diagnostics.** Data & maintenance offers the versioned Delta-only native bundle, portraits, opt-in portable portrait settings and source-history audit. Matching dossiers reconcile and unrelated target dossiers remain; skipped records are reported. Imported source history is not replayed across chats: the target retains its safe history baseline and unproven source-message ownership is cleared. Audit-only source history is secondary to the actual backup; if full audit metadata would exceed the native manifest or file budget, Delta stores a compact truncation summary, and if necessary omits the audit archive, rather than blocking export of canonical dossiers and portraits. Complete validation precedes mutation. Diagnostics show actual dispatcher aggregates and current-chat pending writes, not private prompts or credentials. Token values are labelled local estimates, not provider usage.

## Installation and updates

Use SillyTavern 1.18.0 or a compatible later host. Install this repository through the host extension installer, or unpack `npc_state_delta-1.0.4.zip` so one `npc_state_delta` folder contains `manifest.json` directly. Reload the host after updating. Keep a native Delta backup before changing an existing installation.

The package is generated by the existing `npm run package` command; its SHA-256 sidecar is written beside it in `dist/`. It contains only the declared runtime JavaScript, stylesheet, manifest, runtime inventory, license and README. Tests, development scripts, Git history and verification artifacts are excluded. CI retains the same installable ZIP and a reproducible verification source bundle through the existing artifact workflow. There is no additional release/tag pipeline.

Do not import Alpha/Beta/other-generation databases. Required historical Delta storage readers remain active for owned recovery; they are not foreign-generation converters. Namespace isolation does not make simultaneous automatic writers from multiple NPC extensions an accepted configuration.

## Ownership and verification

`runtime-modules.json` is the one shipping inventory. Canonical state, settings, scanner dispatch, numerical mechanics, persistence/recovery and appearance resolution each retain one owner. UI projections and editor drafts do not become parallel databases. Application version 1.0.4 is independent of the unchanged storage/bundle/branch format versions. GPL-3.0 and immutable seed/history records are preserved.

```sh
npm test
npm run validate
npm run measure:prompts
node scripts/measure-stage9.mjs
npm run package
git diff --check
```

Node.js 24 and Python 3 are required for the dependency-free core workflow. Optional synthetic-browser checks use an already available Playwright/Chromium installation; they are not runtime dependencies. Commands, evidence and limitations are in [DEVELOPMENT.md](DEVELOPMENT.md) and [the Stage 9 report](docs/stage9-review.md).

Behavior is governed by [AGENTS.md](AGENTS.md), [the core contract](docs/core-contract.md) and [the workplan](docs/WORKPLAN.md). Historical source records describe their original snapshots, not current release acceptance.
