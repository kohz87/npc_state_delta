# Story Suite v2 adapter and NPC meters

How NSD joins a Story Block v2 host without changing its own engine. Detail: the header comments of
`src/storysuite-v2.js` and `src/npc-meters.js` (the exact rules), `docs/STORY_SUITE.md`, Story Block
MODULES.md §D and §F (F81 meters, F90 stages), SPEC §2.2 (replay), §5 (own prompt keys, `ownPrompt`), §6.

## Rules

- **Standalone first.** NSD's storage, scanner, prompts and history rules are its own; the adapter changes
  none of them. Without a v2 host (no Story Block, or a v1 one) it does nothing: it looks for
  `globalThis.StoryBlock` every `HOST_RETRY_MS` (250 ms) up to `HOST_RETRY_ATTEMPTS` (40) times, then stops.
  While hosted it checks every `HOST_ALIVE_MS` (5 s) that the host is still there, and restores the drawer copy
  when it is not. The v1 handshake (`suite-handshake.js`) offers nothing to a v2 host (`storyBlockIsV2`).
- Registers module `npc-state-delta`: queries `QUERY_NAMES` (`npc.present`, `npc.dossier`, `npc.known`,
  `npc.portrait`, `npc.meters`, `npc.cast`, `npc.next`, `npc.socialModifier`), commands `COMMAND_NAMES` (`npc.adjust`, `npc.set`,
  `npc.refresh`, `npc.milestone`, `npc.tick`), the Cast / Dossiers tab and screen (`CAST_SCREEN_ID`,
  widget `CAST_WIDGET`), its settings section, and hooks `diagnostics` and `ownPrompt`.
- **`npc` domain** (only numbers, stage and milestone names, ids of unlocked notes; prose stays in NSD's
  sidecar): meters trust, affection, desire, tension in `BUILT_IN_RANGE` (−100..100) plus up to
  `MAX_CUSTOM_METERS` (6) custom ones, at most `MAX_NPCS` (80). While hosted this slice is the truth for meter
  values: `index.js` reads it back through `sliceView()`, and the scanner's relationship changes go in as
  `npc.adjust`.
- **Code sets numbers:** every value clamped to its range; one meter's change within one reply held to the
  change cap (`DEFAULT_CHANGE_CAP` 15; `turn.from` keeps the reply's starting values, keyed by the reply `sid`);
  per-NPC floors and ceilings; stages and ladder rungs moved by code when thresholds are crossed; the story
  cannot set a stage. Hidden notes unlock by rule and their text reaches the story only through the tail,
  only while the NPC is present and unlocked.
- Change lines: `~ npc <Name> | trust: +5 ...` and `+ milestone <Name> — <words>`; refused parts become
  problems (last 20). `npc.tick` runs once per new reply or swipe (`TICK_TURNS`), never for a Continue or Re-read.
- Who is present: `director.world.here` when Story Director answers, else Story Block's `scene.present`.
- NSD's own prompt keys (`story_suite_tail_4_npc_state_delta…`) are sent by NSD; Story Block only counts them
  (`ownPrompt`). The scanner and roleplay prompts stay byte-identical (core contract C10).
- Features: `npc-state-delta.stages`, `npc-state-delta.drift`, `npc-state-delta.presets`, `npc-state-delta.social` (`FEATURES`).

## Social checks (`npc.socialModifier`)

- `npc.socialModifier({ name, skill })` → `{ mod, name, skill, reasons: [{ text, value }] } | null`, for a dice
  module's check (RPG Battle reads it through its check-modifier hook, by `tryQuery`; Delta never calls RPG Battle).
  Delta owns the rules, all in `src/social-check.js` (header comment): `socialSkill` (skill words → persuade,
  charm, intimidate, deceive, social; anything else null), `SKILL_METERS` (meters and weights per skill),
  `STEPS` (25/50/75% of a meter's reach → 1/2/3), `RANK_BONUS_MAX`, `DISPOSITION_WORDS`, `socialSettings`
  (settings `socialScale` %, `socialCap`), `socialModifier` (pure).
- The query lives in the part (`npc-meters.js`, beside `npc.next`): the name resolves like `npc.dossier`
  (name, alias or id, any case) or to a slice entry; a dossier with no entry stands at its seed values.
  It reads only the `state` it is given (the view of the check's reply), the stored settings and the
  dossier; it writes nothing and calls no model. The adapter tags it `feature: npc-state-delta.social` (the
  host answers null while off) and also checks the switch and `enabled()` itself.
- Invariants (tests/storysuite-v2-social.test.js): |mod| ≤ cap, reasons add up to mod, null for non-social
  skills / unknown names / feature off / Delta off, aliases, state at a reply / swipe / delete, and the
  host's prompt log identical with the feature off and on (asked every reply). No prompt text: C10 holds.
- Everything outside (runtime api, host global, document, timers) is injectable: no SillyTavern import here.

## Screens on the glass look (UI 4c)

- **Present cards** (`index.js` `inlineCardHtml`, `style.css` `.npc-state-delta-present-card*`): one compact row per person, one
  column at every width: a 44px portrait; the name and the relationship stage on the first line, the role and mood on the second; the now lines and
  chatter sit under the row; the NPC's meters sit inside its row. The meters are built by `renderCast` (`meterEntries`, `meterBarNode`) as DOM, not strings.
- **Dossiers** (`story-block-tabs.js` `dossierRowNodes`, DOM with textContent): a listcard (`ss-listcard`) of rows. A row is the
  row button (class `npc-state-delta-story-row`, `data-npc-id`), the portrait, the name, the role and status, the stage as an `ss-pill`
  and up to `DOSSIER_BAR_MAX` (6, ss.hero's `BAR_MAX`) meters as `ss-bar` bars. `storysuite-v2.js` `withMeters` adds each row's
  `stage` and `bars` from `npc.cast` when the list is drawn (never cached with the rows).
- **Colours** are Story Block tokens everywhere a Story Suite root holds the screen (`--ss-text`, `--ss-muted`, `--ss-glass`,
  `--ss-border`, `--ss-accent`, …). In the chat and the drawer, and wherever a token is unset (Solid, Follow SillyTavern without a
  root), each rule keeps Delta's own value as the fallback. No new colour.
- **The dossier panel** (`dossier-ui.js`, `#npc_state_delta_dossier_root .delta-panel`) carries the `ss-cards` root class; its
  `--delta-*` variables read the tokens with Delta's values as fallbacks. Its scrolling is its own (`.delta-document`).
- **Social check lines**: Delta draws none. `npc.socialModifier` only answers; the reasons list is drawn by RPG Battle's check table.
- **Delta's warning** under Custom fields keeps its own rule (`#npc_state_delta_settings .npc-state-delta-suite-warning`); the
  `story-suite-notice` glass in Story Block is scoped to the bar.

## Key files and functions

- `src/storysuite-v2.js`: `createStorySuiteV2Adapter`, `startStorySuiteV2`, `isV2Host`, `sliceView`,
  `ownPrompt`, `dossierFields`, `safeImageUrl`, `portraitUrl`, `meterBarNode`, `V2_HOST_EVENT`, `HOSTED_FLAG`.
- `src/social-check.js`: `socialModifier`, `socialSkill`, `socialSettings`, `meterPoints`, `SKILL_WORDS`,
  `SKILL_METERS`, `DISPOSITION_WORDS`, `FEATURE_SOCIAL`, `SOCIAL_QUERY`.
- `src/npc-meters.js`: `createNpcPart`, `initialNpcSlice`, `validateNpcSlice`, `meterDefs`, `stageAt`,
  `thresholdReached`, `rungMet`, `findNpcKey`, `npcKey`, `SETTINGS_SCHEMA`; `npc-meters-presets.js`
  (`presetCatalog`, `normalizeLimits`); `npc-meters-screen.js` (`metersCardScreen`).
- `index.js`: where the adapter is started and the slice read back (`adapter.sliceView`).

## Tests that guard it

- `tests/storysuite-v2.test.js`, `storysuite-v2-host`, `-hosted`, `-meters`, `-meters-ladder`, `-social`,
  `-meters-runtime`, `-cast-screen`, `-fresh-chat`, `-own-prompt-date`, `v2-r2-fixes`, `v2-world-scene-present`,
  `b7-*` (hosted capture, Cast tab, register refused).
- `tests/v2/break/` (`a1-meter-window-after-delete`, `b5b-r2-capture-rule-names`,
  `b6-soak-prompt-and-backfill`, `b7r2-cast-*`).
- Prompt identity: `tests/stage9-regression.test.js` (runs `scripts/measure-stage9.mjs`), `npm run measure:prompts`.
- Across repos: the suite tests in Story Block and RPG Battle import `src/storysuite-v2.js` from a sibling checkout.

## When you change it

- Keep the unhosted path untouched: a test with no host must show NSD exactly as before.
- Run the adapter tests with Story Director and RPG Battle absent (the default here) and, once, the suite
  check with all four side by side.
