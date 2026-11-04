# AI-README: NPC State Delta 1.9.0

For AI assistants that read this repository. Plain facts, no marketing. For people, read [README.md](README.md). For the rules
every change must keep, read [AGENTS.md](AGENTS.md) and [docs/core-contract.md](docs/core-contract.md). Depth lives in `docs/`;
this file points there instead of copying.

## Purpose

NPC State Delta ("Delta") is a SillyTavern 1.19 extension (JavaScript ES modules, no dependencies, no build step). It keeps one
dossier per NPC per chat (identity, look, voice, bonds, memories, relationship numbers), updates it from the story, and tells the
roleplay model about the NPCs who are present. With Story Block it also keeps meters, stages and hidden notes per reply.

## Suite map

| Repo | Module id | Version | Owns |
|---|---|---|---|
| kohz87/Story_block | `story-block` | 2.16.1 | The host: store, replay, command bus, `<Changes>` capture, prompt assembly, module registry, settings window, Game view, packs and portraits, save points. |
| kohz87/Story_director | `story-director` | 2.9.1 | Story clock and calendar, quests, map, World, key people, the living cast (who has been met, where everyone is). Needs Story Block. |
| kohz87/npc_state_delta (this) | `npc-state-delta` | 1.9.0 | NPC dossiers, meters, stages, hidden notes ("secrets"), the Dossiers screen, cast dossiers and cast portraits, social-check modifiers. |
| kohz87/Story_studio | (not an extension) | 0.6.0 | A separate page that writes and checks packs. |

Data flows one way: Studio writes a pack; Story Block validates and stores it; Story Director reads what Story Block holds; Delta
reads both. Delta reads Story Block's `packs.portrait` and `packs.content`, and Story Director's `director.cast`,
`director.keyPeople`, `director.calendar`, `director.world.here`. It only writes to Story Block through commands on its own `npc`
domain, and sends Story Director one command (`keypeople.pin`, from the reader's button). It never writes to Studio or to
packs. Nothing flows back to Studio.

## Install & requirements

- SillyTavern: Extensions, Install extension, `https://github.com/kohz87/npc_state_delta`. Install Story Block first, then Story
  Director, then Delta. Reload. The `v1` branch of this repo is Delta for Story Block 1 (not maintained here).
- `manifest.json`: `loading_order` 110, `js: bootstrap.js`, `css: style.css`, `minimum_client_version` 1.18.0, `requires: []`.
- Alone (no host, or a Story Block 1): dossiers, scans, portraits, calendar and birthdays, relationships, backup, diagnostics. Its
  own prompt and storage are unchanged by the suite.
- Hosted (Story Block 2.12.0 or later, `requires: { storyBlock: '>=2.12.0' }` on its module definition): adds meters, stages,
  hidden notes, `~ npc` change lines, the reply card, the Dossiers screen and tab, social checks, Key people, the cast. The
  cast needs Story Block 2.15.0 and Story Director 2.8.0; Key people need Story Director 2.7.0.
- Story Block 2.16.1 heals a chat that an earlier Delta left stuck (see CHANGELOG 1.7.1). Update Story Block before Delta.
- Development: Node 24 (`engines`). Full tests: `node --import ./tests/active-runtime-test-setup.mjs --test tests/*.test.js
  tests/v2/break/*.test.js`, then `npm test` (adds the compatibility check and runtime smoke). `npm run check` is
  `scripts/validate.mjs`. `npm run package` builds the zip with Python 3.

## Concepts

- **Dossier / NPC record**: one stored record per person: the fields of `src/fields/registry.js` (`FIELDS` is the one table).
  Kinds: identity, text, list, map, meter, life, secret, meta, part.
- **Present**: the dossier's `present` flag, set by the scan (and corrected from World State's NPCs Present headers,
  `present-scene.js`). Only present, not archived NPCs are injected. A person the player's message names is "named by player".
- **Archived / life state**: `archived` is a roster state; `lifeState` (alive, deceased, unknown) is separate. Confirmed death is
  terminal for automatic writers; only a manual Restore ("Correct death record") reverses it.
- **Scan**: a separate model request after a reply that proposes dossier updates. Code validates and merges. **Refresh** is the
  same for one NPC over a longer window. **One-pass capture** (experimental, off) asks the roleplay model to end its reply with
  `<!--npc_state_delta {json} -->` instead of a separate scan.
- **Evidence and locks**: a scan changes a field only with evidence. A reader's Edit can lock fields ("Protect edited stable
  profile fields"); locked fields survive scans, swipes and branch restores.
- **Named forms / current form**: an NPC who transforms keeps several appearance forms (`appearance.js`). The body belongs in
  each form. A flat `appearance` is a resolved projection.
- **Relationship**: `trust`, `affection`, `desire`, `tension`, each -100..100. Scan changes are capped by impact tier (ordinary 1,
  meaningful 2, major 5, extreme 10 by default).
- **Slice (`npc` domain)**: Story Block's per-reply state for Delta (`src/npc-meters.js`): meters, stages, milestones, unlocked
  note ids, disposition, cast and key-away records. Numbers and ids only. Prose stays in Delta's sidecar. While hosted, the
  slice is the truth for meter values.
- **Meter**: one of the four above or up to 6 custom ones (`customMeters`, custom range -1000..1000, optional rule line, band
  words, drift per story day).
- **Stage / ladder / rung**: a named threshold on a meter (`stages`), or a ladder of rungs that each need several meters and an
  optional story milestone. Code moves them. The story cannot set a stage.
- **Milestone**: a named turning point added by `+ milestone` or by the reader. At most 16 per NPC.
- **Secret / hidden note**: `{ id, title?, text, meter+at | when }`. Opens at a meter value, on a story event, or by hand. At most
  8 from a pack or the reader, 2 to 5 generated for a new dossier. `held` keeps a note shut by hand.
- **Preset**: a named set of custom meters, a ladder and limits: built in (Companion, Rival, Mentor) or from a pack (`meterPresets`).
- **Cast dossier**: a dossier made from a pack's cast entry at the first meeting, with `castFrom`. No scan, no model call.
- **Key person**: a person Story Director pinned. Delta reads `director.keyPeople` only.
- **Sidecar**: Delta's per-chat state file (see Storage).
- **Checkpoint / rollback journal**: the history Delta keeps so swipes, edits and deletes restore dossiers (`branch.js`,
  `branch-core.js`, `destructive-settlement.js`).
- **Participant**: Delta's registration with Story Block's timeline (`src/storysuite-participant/`) so save points restore
  dossiers with the story, and a confirmed death returns to the dossier.

## Reader features

- **Dossiers screen** (Story Block Game view, plus a Dossiers tab in the Story panel; id `npc-state-delta/cast`, tab id `cast`):
  list rows with portrait, stage pill and up to 6 meter bars; search box. Built in `story-block-tabs.js`,
  `src/storysuite-v2.js`.
- **Dossier panel** (`dossier-ui.js`, root `#npc_state_delta_dossier_root`): hero portrait, badges (Key person, cast), Edit, Refresh,
  More (Scan dossier, Portrait, Diagnostics, Archive or Restore), section bar (Player, Identity, Current, Profile, Dynamic, Bonds &
  memories, History, Secrets), Dossier / Map toggle, Dossier library fold. Opens from a Dossiers row, the floating launcher
  (`launcher-ui.js`) or "Open dossiers" in Delta's settings.
- **Edit** (`index.js` editor, `src/dossier-edit.js`): every field, locks, custom fields, appearance forms, birthday, meter setup
  (track, ceilings and floors), hidden notes, milestones.
- **Map** (`relationship-map.js`): people placed around the player by a lens (warmth, trust, affection, desire, tension).
- **Add NPC, Scan dossier now**: Delta's settings, top bar. **Backup / Export, Restore / Import, Diagnostics, Clear chat
  dossier**: Data & maintenance.
- **Reply card** ("NPCs", id `npc-state-delta/meters`, mount `card`): under each reply, meters of present people and of anyone that
  reply changed, with stage and next step. Built from `npc.cast` at that reply.
- **People here** (Story Director World, Now, Here): Delta draws the present cards through the page API `NPCStateDeltaCast`
  (`render(el, { slot })`, `onChange(fn)`, `available()`). Without Story Director the cards sit at the top of Dossiers. An in-chat
  strip is a setting ("Present NPCs in chat": full cards, compact strip, only in Story Block, off).
- **Cast dossier**: made on the reply where Story Director reports a met person with an entry. Badge "<Pack> cast", a "From the
  cast" box, optional "Pin as Key people" button (calls `keypeople.pin`).
- **Key person**: badge, While away timeline, return note (below), meters held while away.
- **Secrets section**: "n opened, m still hidden"; a locked note is a blank bar and "Opens at Trust 40" or "Opens with the story".
- **Portraits**: upload, replace, remove, prompt building and generation through SillyTavern's Image Generation (preview first,
  applied on confirm), per-form portraits.
- **Social checks**: read-only modifier for Story Director's checks (`vs: Name`) or another dice module.
- **Save points**: dossiers go back with Story Block's save points through the participant. Branches inherit state and wait
  for the parent's dossiers.

## Settings

Settings live in `extension_settings.npc_state_delta` (defaults in `index.js` `DEFAULTS`, schema version 30). Delta's panel is in
Extensions, or in Story Suite settings when hosted. Hosted settings (the `npc` part) are in `src/npc-meters.js` `SETTINGS_SCHEMA`.

| Name (UI label) | Does | Default |
|---|---|---|
| `enabled` (Enable NPC State Delta) | Master switch. Off: no scan, no injection. | on |
| `autoScan` (Auto scan) | Scan after assistant replies. | on |
| `fullScanEveryTurn` (Full scan every turn) | Reconcile the whole scan window every reply. | off |
| `narrationCapture` (One-pass narration capture) | Reply carries the scan block. Experimental. | off |
| `narrationCaptureCompact`, `narrationCaptureCatchUp` | Shorter one-pass rules; quiet Refresh every N captured replies. | off, 8 |
| `scannerConnectionProfile` | Route for every scan, Refresh and focused pass. Empty keeps the chat's route; a missing profile errors, never falls back. | empty |
| `scanEvery` (Scan every) | Quick-scan cadence in replies. | 1 |
| `scanDepth` (Scan context) | Messages in the window for full, manual and Refresh scans (quick scans read the latest exchange). | 6 |
| `admissionMode` (NPC admission) | `conservative`, `balanced`, `manual_only`. | conservative |
| `maxNpcs` (Maximum active NPCs) | Active dossier cap, 1 to 100. | 40 |
| `inject` (Inject present NPC state) | Send the dossier block to the model. | on |
| `injectLimit` (NPCs in the dossier) | Present NPCs per reply, 1 to 12, most relevant first. | 3 |
| `injectBudgetTokens` (Injection budget) | Upper limit for the block, 512 to 6000. | 4000 |
| `injectDepth` | Depth of the block (0 is the cache-friendly tail). | 0 |
| `layeredSecrets` (Hidden notes for new people) | A scan that builds a new dossier writes 2 to 5 notes. Hosted only. | on |
| `autoArchiveDeaths`, `autoReactivateArchived` | Archive confirmed deaths; reactivate on a clear return. | on, on |
| `autoPruneStale`, `staleArchiveAfter`, `staleDeleteAfter` | Auto-archive after 30 replies away, delete stale auto-archives after 50. | on, 30, 50 |
| `midDeleteRewind` | On: deleting a middle message rewinds every dossier to just before it. Off: undo only that message's changes. | off |
| `branchRescan` | Rescan the surviving branch after a swipe, edit or middle delete. | on |
| `customFieldNames` | Up to 6 custom field names on every dossier. | none |
| `sourceOfTruth` | Per area (npc, calendar, scene, stats): auto, this extension, the other one. | Automatic |
| `presentCastDisplay` | In-chat cast: full, compact, storyblock, off. | full (storyblock while hosted until chosen) |
| `portraitGenerationEnabled`, `portraitThemePreset`, ... | Image Generation prompt building. | on, fantasy_anime |
| `relationshipBaseline`, `relationshipCaps`, three rubric texts | Start values, per-tier caps, scoring and behavior criteria. | 0, 1/2/5/10 |
| `changeCap` (Most a meter moves per reply) | Story lines and scans together. | 15 (max 200) |
| `customMeters`, `stages`, `ladder`, `presets` | Meter setup (hosted). | none |
| `conflictAt`, `demoteAfter` | Ladder promotion waits while tension is above this; a rung is lost after this many low replies. | 50, 3 |
| `socialScale`, `socialCap` | Social check strength (percent, 0 to 200) and most a check moves (to 10). | 100, 5 |

Features (Story Suite Settings, Features; `FEATURES` in `src/npc-meters.js`): `npc-state-delta.stages` (on),
`.presets` (on), `.drift` (off, needs Story Director's clock), `.social` (on), `.scan-every-reply` (on; off scans every 3 replies
or "Scan every" if larger; Story Block's Lean preset turns it off). Off means fully off: no prompt text, no state change.

## Data the model sees

Sent (all only while Delta is on and the chat's dossiers are loaded):

- **Dossier block**: prompt key `story_suite_tail_4_npc_state_delta`, in-chat, system role, depth `injectDepth`. Header text, then one
  line per present, not archived NPC (at most `injectLimit`, within `injectBudgetTokens`): IDENTITY (personality, behavioral profile,
  speech, mannerisms), AGENCY / OTHER BONDS (role, current goal, key relationships, custom fields), CURRENT STATE (mood, status),
  PLAYER RELATIONSHIP (a short secondary modifier, not obedience), then optional current appearance and important memories.
  Over budget, lower-ranked NPCs go first, then section caps shrink. An NPC the player's message names but who is not here
  comes as "named by player". A returning key person adds a return note once. Built in `core-mechanics.js` `buildInjection`.
- **Meters line** (hosted): one static line (meter ids, ranges, the grammar `~ npc Name | meter: +N, -N or =N`, the cap, custom
  meter rules while presets are on), byte-identical each reply. Tail: "NPC meters now: ..." for present people whose meters moved
  in the last 4 messages (band words where a meter has them); opened notes as "known to the player now; may come out"; locked
  notes as "hidden: never state or reveal; let it shape how they act", nearest to opening first, so the host's budget drops the
  farthest first. Only for present people. Budget `CONTEXT_BUDGET` 250. The stage names come from code.
- **One-pass rules and context** (only when `narrationCapture` is on): keys `story_suite_static_npc_state_delta` (rules) and
  `story_suite_tail_5_npc_state_delta_capture`.
- **The scanner request** (separate): the recent transcript window, the roster, criteria texts, and for hidden notes only the
  event wording of present people's locked event notes (6 people, 3 events each), never a note's text.

Never sent: portraits and images, portrait prompts and seeds (`prompt: 'never'` in the registry), `meterSetup`, `castFrom`
bookkeeping, evidence ledgers, locks, diagnostics, the raw `secrets` outside the tail above, other chats' dossiers, archived
NPCs. The "What's sent" view shows a locked note as "1 hidden note" (`redactSent`). SillyTavern's own prompt viewer still
shows the raw text.

Prompt wording is frozen on purpose: prompts are byte-identical across releases unless a release says otherwise
(`npm run measure:prompts`, `tests/stage9-regression.test.js`).

## Reply format the model writes

Delta reads two change-line kinds inside Story Block's `<Changes>` block (Story Block hides the block). Labels are meter ids or
labels, any case. A value is `+N`, `-N` (add) or `=N` (set). `reason`, `why`, `because`, `note`, `cause` are skipped. `stage` is
refused (a Problem). `disposition` takes a short word. Code clamps to each meter's range, to the change cap per reply, and to the
NPC's own ceiling or floor.

```
<Changes>
~ npc Mira | trust: +5 | affection: -2
~ npc Mira | trust: =40
~ npc Mira | disposition: wary
~ npc Old Hob | loyalty: +3 | reason: he kept the promise
+ milestone Mira — saved her brother at the bridge
</Changes>
```

- Grammar lines registered with Story Block: `~ npc Name | trust: +N | affection: -N` and `+ milestone Name — the turning point
  that just happened between you (once)`.
- A milestone is only ever added by the story (once per key, `feature: npc-state-delta.stages`); the reader removes one in the editor.
- A line Delta cannot use becomes a Problem (last 20 kept in the slice), shown on the reply's card.
- Delta's own scanner returns JSON to Delta, not these lines; its relationship changes go in as `npc.adjust`.
- One-pass capture (off by default) uses `<!--npc_state_delta {valid JSON} -->` at the end of the reply, stripped on arrival.

## Pack format pointers

Delta reads packs only through Story Block's queries. Full pack format: Story Block `docs/v2/PACKS.md`. Fields Delta reads:

- **Cast entry** (`director.cast`, `src/cast-dossier.js` `normalizeEntry`): `id`, `name`, `aliases` (8), `about` (300, becomes role),
  `look` (1800), `voice` (600), `personality` (900), `history` (1200), `portrait` (file name), `start.place` (300), `start.goal`
  (500), `start.routine` (300), `drawnTo` (8), `meters` (`preset` plus meter values), `stages` (8, each `{ id, name, needs: [{ meter,
  at }], milestone }`; the milestone is the line told on reaching it, not a requirement), `fields` (12 custom fields), `secrets` (8,
  each `{ title?, text, meter+at | when }`; text 300, title 60, when 120). At most 200 people per answer.
- **Meter presets** (`packs.content`, kind `meterPresets`): `{ id, title, meters: [{ id, name, min, max, start, describe?, bands?,
  drift? }], stages?: [...] }`. At most 12 presets.
- **Portrait**: `packs.portrait({ pack, file })` returns a safe image URL (Story Block keeps cast portraits up to 150 KB, 1200 px).
  Delta saves it once as `/user/files/npc-state-delta-portrait-<40 hex of SHA-256>.<ext>`; the dossier keeps a short reference.
- A pack's words are kept exactly (`castFrom.first`) until a scan or the reader changes the field.

## Commands and queries

Module id `npc-state-delta`. Registered in `src/storysuite-v2.js` (`QUERY_NAMES`, `COMMAND_NAMES`). Queries are read-only.

| Query | Returns |
|---|---|
| `npc.present` | Names of NPCs present. With `{ meters: true }`: `[{ name, meters, stages }]`. |
| `npc.known` | Names of every tracked, not archived NPC. |
| `npc.dossier` | One NPC's dossier fields by `name` (or alias) or `id`, with meters, stages and unlocked note ids. Never hidden notes. |
| `npc.portrait` | One NPC's portrait URL, or null. |
| `npc.meters` | One entry `{ key, name, meters, stages, unlocked, disposition?, milestones?, rank? }`, or all entries. |
| `npc.cast` | Entries with bars, ladder line and locked-note teasers, present first (feeds the reply card). Takes `headReply`. |
| `npc.next` | `{ rank, next, risk, text }` for an NPC's ladder, or null. |
| `npc.keyAway` | Memory of key people's last absences (`{}` when none). |
| `npc.castMade` | People Delta made a dossier for from the cast (`{}` when none). |
| `npc.socialModifier` | `{ mod, name, skill, reasons: [{ text, value }] }` for a social skill (`persuade`, `charm`, `intimidate`, `deceive`, `social`), else null. |
| `npc.identity` | The stable `np_` id for a dossier, by `id` or `name` (timeline contract). |

| Command | Does | Who may send it |
|---|---|---|
| `npc.adjust` | Move meters by amounts (same clamps as a story line). | Delta's scan, or another module. A button is refused. |
| `npc.set` | Set meters to values (range only). | The reader's editor, or another module. |
| `npc.refresh` | Recompute stages, ladder and notes after a setup change. | The editor. |
| `npc.milestone` | Add or remove milestones for one NPC. | The editor. |
| `npc.open` | Open or shut hidden notes. `by: 'story'` is Delta's own scan only. | Editor or scan. |
| `npc.tick` | Per-reply step: drift, ladder demotion counting, key-away memory, cast records. | Delta only. |

Page API `globalThis.NPCStateDeltaCast` for Story Director's World screen. Public global `NPCStateDelta` for Delta's own runtime.
Story Director queries Delta reads: `director.cast`, `director.keyPeople`, `director.calendar`, `director.world.here`.
Detail: [docs/dev/storysuite-adapter.md](docs/dev/storysuite-adapter.md), [docs/dev/storysuite-participant.md](docs/dev/storysuite-participant.md).

## Storage

- **Sidecar (per chat)**: `npc-state-delta-<hash>.json` in SillyTavern user files (format `npc_state_delta_chat_data` v1), found
  through `extension_settings.npc_state_delta.dataFiles[chatKey]`. It holds dossiers, evidence, the social graph, rollback
  checkpoints and journal, candidates, portraits and `timeline` (lineage, identity map). One writer at a time: in-process
  lock plus a `localStorage` lease across tabs. Failed writes retry (0, 1, 2, 5, 15, 30 s). Recovery copies are
  `npc-state-delta-recovery-...json`. Deleted chats leave tombstones in settings.
- **Per-reply slice**: Story Block's per-reply state, domain `npc` (`message.extra.storySuite` on reply messages). Meters,
  stages, milestones, unlocked and held note ids, disposition, `cast`, `keyAway`, `problems`. At most 80 NPCs.
- **Portraits**: cast portraits are user files `npc-state-delta-portrait-<hash>.<ext>`, written once, never deleted by Delta.
  An uploaded or generated portrait stays in the dossier as before.
- **Timeline checkpoints**: one user file per checkpoint, one small index per lineage (`src/storysuite-participant/vault.js`).
- **Settings**: `extension_settings.npc_state_delta`. Floating launcher position is `localStorage` (UI only).
- Export bundles (`bundle.js`, `native-transfer.js`) carry dossiers and portrait files. Import merges; another chat keeps its own
  lineage. Clearing a chat's dossiers never touches other chats. A UI change never deletes stored state.

## File map

- `bootstrap.js` entry (manifest `js`). `index.js` runtime controller (settings, scans, injection, editor, roster). `core.js`
  facade over `core-mechanics.js` (prompts, merge rules, scoring). `storage.js` persistence. `identity.js` chat identity.
- Scanning: `scanner-routing.js` (the one dispatcher), `scan-context.js`, `full-cast.js` (optional full-window scan),
  `src/scanner-request.js`, `src/relationship-pass.js`, `src/transcript.js`, `present-scene.js`, `scanner-output-ui.js`.
- State and recovery: `branch.js`, `branch-core.js`, `destructive-settlement*.js`, `hardening*.js`, `terminal-lifecycle.js`,
  `continuity-core.js`, `appearance.js`, `social.js` (social graph), `calendar*.js`, `birthday.js`, `bundle.js`, `native-transfer.js`.
- UI: `dossier-ui.js`, `dossier-experience.js`, `dossier-tools*.js`, `portrait-tools.js`, `launcher-ui.js`, `relationship-map*.js`,
  `continuity-ui.js`, `story-block-tabs.js`, `style.css`, `suite.css`.
- Suite: `src/storysuite-v2.js` (adapter: registration, queries, commands, screens, page API), `src/npc-meters*.js` (the `npc`
  domain), `src/social-check.js`, `src/key-people.js`, `src/cast-dossier.js`, `src/portrait-file.js`,
  `src/storysuite-participant/`, `src/fields/registry.js`, `suite.js` and `suite-handshake.js` (the v1 registry; offers nothing to a
  v2 host).
- `runtime-modules.json`: every shipped top-level runtime `.js` file, once, with a role.
- `scripts/`: `validate.mjs`, `package.mjs` (Python), `measure-prompts.mjs`. `tests/`: about 190 test files plus fixtures and a
  vendored Story Block testkit (`tests/vendor/story-block/`).
- `docs/`: `core-contract.md` (behavior authority), `STORY_SUITE.md`, `dev/`, `history/` (evidence only), stage reviews,
  `images/` (README screenshots, not shipped). `CHANGELOG.md`, `DEVELOPMENT.md`, `AGENTS.md`, `CLAUDE.md`.

## Limits & known follow-ups

- Each scan is a separate model call (more with focused passes). Scan context 2 to 30 messages.
- Meter slice: 80 NPCs, 24 meters per NPC, 6 custom meters, 8 stages per meter, 8 rungs, 16 milestones per NPC, 32 unlocked notes.
- Hidden notes need Story Block. Cast and Key people need Story Director. Drift needs Story Director's clock.
- A swipe, delete or edit rolls dossiers back by the rollback journal (256 messages, 8 MB aggregate checkpoint limit, 2 MB each).
  A deep edit that cannot be replayed fails closed and keeps the dossiers.
- A reply cut short by the reply length setting loses its change lines (they are at the end).
- Cast portraits and dossiers made before 1.7.0 keep their embedded pictures; only new ones become files.
- Do not change prompt text, request counts or persisted formats without a release that says so (AGENTS.md).
- RPG Battle is no longer part of the suite. Do not touch it.
- Open items for after the clean-up: see `suite-notes/` in kohz87/inventory-block and Story Block `docs/v2/RELEASES.md`.

## Version

NPC State Delta 1.9.0. The version lives in `manifest.json`, `package.json`, `runtime-modules.json`, `core.js`
(`NPC_STATE_VERSION`) and the `bootstrap.js` banner; `scripts/validate.mjs` checks they agree with README and CHANGELOG.
Built for Story Block 2.16.1 and Story Director 2.9.1 in Story Suite with Story Studio 0.6.0. Persisted schema versions are
separate from the application version.
