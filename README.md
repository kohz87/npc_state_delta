# NPC State Delta v1.3.0 ("Delta")

> Story Suite 2.0.0. Delta keeps its own application version: **1.3.0**.

## What it is

Delta keeps a living dossier for every NPC in your roleplay: who they are, how they look, how they talk, what they
remember and how they feel about you. After each reply it reads the scene, updates the dossiers only where the
story gives evidence, and sends the NPCs who are present back to the roleplay model so they stay in character.

In Story Suite v2 it is the people part of the suite. It works on its own, and beside
[Story Block](https://github.com/kohz87/Story_block) (the host) it also keeps trust, affection, desire and tension
with every reply, shows a **Dossiers** tab, feeds its cards to
[Story Director](https://github.com/kohz87/Story_director)'s World screen and gives
[RPG Battle](https://github.com/kohz87/rpg_battle) its social checks.

## Install

Tested with **SillyTavern 1.19**. In **Extensions → Install extension**, install in this order, then reload:

1. [Story Block](https://github.com/kohz87/Story_block)
2. [Story Director](https://github.com/kohz87/Story_director)
3. [RPG Battle](https://github.com/kohz87/rpg_battle)
4. [NPC State Delta](https://github.com/kohz87/npc_state_delta)

To start with the bundled **Ersveil** rules pack, open a fresh chat and follow **Setup → Pin Ersveil Rules → Create**,
then choose your character's options. Existing chats load and rebuild unchanged; legacy chats stay unpinned.

Report bugs in [this repo's Issues](https://github.com/kohz87/npc_state_delta/issues), with steps to reproduce.

For the old version (Delta for Story Block 1, Story Suite v1), install the `v1` branch of the same repo instead: paste the URL and type `v1` as the branch.

Needs (`requires`): nothing to run on its own. To join the suite it needs Story Block **2.0.0-beta.2 or later**;
with an older Story Block 2 Delta keeps working alone, without meters, the Dossiers tab or its Story Suite
section, and logs a console warning. Before updating an existing install, export a backup from
**Data & maintenance → Backup / Export**.

## What you get

Switches are in Story Suite **Settings → Features**. "No switch" means it is always on.

- **Dossiers** (tab, last by default; no switch): every dossier in the chat, with search; tap one for the dossier
  view (portrait, role, status, relationship). It was the Cast tab and keeps the id `npc-state-delta/cast`, so a
  tab order you saved stays. Without Story Director, the cards of the people here sit at its top.
- **The page API for World** (no switch): Delta exposes `NPCStateDeltaCast` so Story Director's **World → Now →
  Here** draws Delta's own cards for the people present, with each person's Inner chatter thought inside the card,
  and redraws when a scan finishes. No copy of the markup.
- **NPC meters** (no switch): trust, affection, desire and tension from -100 to 100, plus up to six meters of your
  own, kept with each reply. The story moves them with a `~ npc` line; code clamps and caps them (**Most a meter
  moves per reply**, default 15).
- **Stage ladders and milestones** (`npc-state-delta.stages`, on): named rungs that need several meters and a story
  milestone; code moves the stage and tells the next reply.
- **Meter presets and rules** (`npc-state-delta.presets`, on): one-click Companion, Rival and Mentor sets, plus
  any a pack brings. **Meters drift each story day** (`npc-state-delta.drift`, **off**; needs Story Director's clock).
- **Hidden notes** (dossier editor): a note stays out of every prompt until its meter reaches a threshold; while
  locked, a screen shows only "Her past, unlocks at Trust 60".
- **Social checks** (`npc-state-delta.social`, on): a persuade, charm, intimidate or deceive check against an NPC
  gets a bonus or penalty from their meters, stage and disposition, for a dice module such as RPG Battle
  ("Elula trusts you (+2)"). Delta only reads; it sends nothing to the model. Settings **Social checks: strength
  (%)** (default 100) and **Social checks: most a check moves** (default 5).
- **Questions other modules can ask** (read-only): `npc.present`, `npc.known`, `npc.dossier`, `npc.meters`,
  `npc.cast`, `npc.portrait`, `npc.socialModifier`.
- **Scans and dossiers** (Quick bar: **Enable NPC State Delta**, **Auto scan**, both on): portraits, calendar and
  birthdays, relationships, swipe and edit rollback, backup and diagnostics, as in Delta 1.2.

## Looking after a dossier

- **Appearance keeps up.** Outfits change without erasing hair, eyes or scars. An NPC who transforms can have several
  **named forms** (human, dragon, ...), each with one complete description, body and outfit together.
- **If someone is missing**, use **Add NPC**. If a dossier looks stale, open it and use **Refresh**, which re-reads
  the recent story for that one NPC. For an NPC with named forms, the body belongs in each form instead; Refresh or
  edit the form.
- Deleting, editing or swiping a message rolls the dossiers back to match. Backup, restore and a diagnostics report are
  under **Data & maintenance**.

## How a turn works

Delta's own scan runs after the reply, as a separate request, and updates the dossier text only where the story
gives evidence. The numbers go through Story Block: the model ends the reply with a hidden `<Changes>` list, and
Delta's lines look like this:

```
<Changes>
~ npc Mira | trust: +5 | affection: -2
~ npc Mira | disposition: wary
+ milestone Saved her brother — the bridge rescue
</Changes>
```

Code clamps each meter to its range and holds each change to the cap; the story cannot set a stage. Swipe, delete,
Re-read and reload take the changes back with the reply. Delta's own prompts are unchanged from earlier 1.2 builds. Details: Story Block's
[GUIDE](https://github.com/kohz87/Story_block/blob/main/docs/v2/GUIDE.md) and
[MODULES](https://github.com/kohz87/Story_block/blob/main/docs/v2/MODULES.md) (section D), and
[docs/dev/storysuite-adapter.md](docs/dev/storysuite-adapter.md).

## Settings

With Story Block 2 Delta's panel moves into the Story Suite overlay (Settings on the Story Suite bar) as its own
fold; without it, it is under **Extensions → NPC State Delta**.

| Setting | Where | Default |
|---|---|---|
| Enable NPC State Delta, Auto scan | Quick bar | on |
| Scanner connection profile, how often to scan | Scanning | the chat's connection |
| Source of truth (NPCs, calendar, scene, game stats) | Source of truth | Automatic |
| NPCs in the dossier, Injection budget | Advanced | 3, 4000 tokens |
| Most a meter moves per reply, Custom meters, Meter stages | Delta's fold, above the panel | 15, none, none |
| Social checks: strength (%), most a check moves | Delta's fold | 100, 5 |

Story Block's prompt size shows Delta's dossier as its own row ("sent by itself", often 2,000-4,000 tokens) and it
counts toward the Share of the context. Delta's scanner route and last call are in Story Block's **Diagnostics**.

## With the other extensions

- **Alone:** dossiers, scans, portraits, calendar and birthdays work as in Delta 1.2.
- **With Story Block 2:** meters kept with each reply, the Dossiers tab, and its settings in the Story Suite overlay.
- **With Story Director:** its World screen draws Delta's cards; birthdays and ages follow its clock when the two
  calendars agree.
- **With RPG Battle:** social checks and companion portraits.

## Known issues in this beta

- A brand-new chat can still log one `404` line for Delta's data file in the browser console (low priority).
- The dossier cards are tall: the portrait takes the space and the text becomes a wall. The cards are redesigned
  after the beta.
- Each scan is a separate model call (**Scanning** sets how often). Pick a cheaper scanner connection profile if
  that matters.
- Meters drift needs Story Director's clock; without it nothing drifts.

The suite's full list is in Story Block's
[RELEASES](https://github.com/kohz87/Story_block/blob/main/docs/v2/RELEASES.md).

## Links

- [Player guide](https://github.com/kohz87/Story_block/blob/main/docs/v2/GUIDE.md), [Changelog](CHANGELOG.md),
  [Releases and known issues](https://github.com/kohz87/Story_block/blob/main/docs/v2/RELEASES.md)
- Developers: [docs/dev](docs/dev/), [DEVELOPMENT.md](DEVELOPMENT.md), [CLAUDE.md](CLAUDE.md), [docs/STORY_SUITE.md](docs/STORY_SUITE.md)
- History, decisions and the after-beta list: `suite-notes/` in
  [kohz87/inventory-block](https://github.com/kohz87/inventory-block/tree/claude/hopeful-babbage-tipaw8/suite-notes)

Licence: [AGPL-3.0](LICENSE). RPG Battle and Story Director are MIT-licensed, so you can start your own module from either of them.
