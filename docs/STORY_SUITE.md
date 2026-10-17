# Story Suite: working alone and together

Story Block, Story Director, NPC State Delta and RPG Battle each work on their own. When several
are installed, they find each other through a small shared registry (`globalThis.StorySuite`,
created by whichever loads first; `src/suite.js`, identical in all four) and agree on **who is the
source of truth** for each area, so the model is not told the same thing twice and two
extensions never contradict each other.

## Areas and owners

The specialist for an area wins; the next one listed owns it when the first is not installed.

| Area | What it covers | Owner, in order |
|---|---|---|
| `scene` | Who is in the scene now: presence, outfit, mood, position, place | Story Block (World State) → NPC State Delta |
| `npc` | Who an NPC is: identity, personality, voice, relationships, goals | NPC State Delta → Story Director |
| `calendar` | The calendar and story time | Story Director → NPC State Delta |
| `timeline` | Off-screen agendas, quests, clocks, arcs | Story Director → Story Block (World State's lists) |
| `stats` | HP, MP, stats, skills, fights | RPG Battle → Story Block (Character Sheet) → NPC State Delta (custom fields) |
| `items` | What the player carries | Story Block (Inventory) → RPG Battle |
| `rolls` | Roll modifiers for checks | RPG Battle (Checks) → Story Block (Dice) |

An extension offers an area only while it actually provides it (for example Story Block offers
`stats` only while its Character Sheet block is on, and `rolls` only while a Dice block is on).

## What each does when it is not the owner

| Extension | Defers when another owns… |
|---|---|
| Story Block | `stats`: its Character Sheet is marked "RPG Battle owns stats" (the reader decides whether to keep it). `rolls`: the Dice block takes RPG Battle's modifier (since 0.7). |
| Story Director | `npc`: agenda lines describe only an NPC's plan and timing, never who they are. Shares its calendar (`StoryDirector.calendar()`), story time (`timeAt`) and encounters (`encountersAt`). |
| NPC State Delta | `scene`: present-NPC cards leave out the live mood and current outfit that World State already gives. `calendar`: uses Story Director's months and era instead of its own. `stats`: warns when its custom fields name game stats (Level, HP, Class…) that RPG Battle keeps. Reads World State inside Story Block's hidden envelope. |
| RPG Battle | `items` is Story Block's: reads gear, writes loot. Offers its party (`api.members()`). |

## The reader decides

Each extension's settings have **Source of truth** choices for the areas it shares: **Automatic**
(the table above), **This extension**, or **The other one**. With one extension installed, every
choice behaves like Automatic.

## For developers

```js
import { storySuite, isSourceOfTruth } from './src/suite.js';
const suite = storySuite();
suite.announce({ id: 'my-ext', name: 'My Extension', version: '1.0.0', owns: ['scene'], api: { … } });
suite.owner('scene');                       // → 'story-block'
isSourceOfTruth('my-ext', 'scene', 'auto'); // → false while Story Block is announced
suite.onChange(() => refresh());            // installs, uninstalls and switches
suite.api('story-director')?.calendar?.();  // what another extension shares
```

Announce again whenever what you offer changes (a block switched on or off), and `withdraw(id)`
when the extension is turned off. Ids: `story-block`, `story-director`, `npc-state-delta`,
`rpg-battle`.
