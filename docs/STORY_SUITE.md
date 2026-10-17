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

## One place to manage them all

With two or more installed, **Story Suite** (in the extensions menu, and the gear in Story Block's
sidebar header) opens one overlay for all of them. Story Director and RPG Battle need Story Block,
so any two of the four include it, and Story Block hosts the overlay:

- **Overview:** each installed extension with its version and, where it has one, its on/off
  switch; and **one Source of truth table**, a row per shared area with one owner: Automatic, or
  one of the extensions that can keep it. Picking one sets every extension's own choice to match
  (that one *This extension*, the others *The other one*), so two can never both claim an area.
- **A tab per extension** showing its own settings panel, moved into the overlay while it is
  open and put back when it closes, so every control keeps working.

Each panel stays in the Extensions drawer as before, with a *Manage all in Story Suite* link
while the overlay is available. Alone, nothing changes.

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

Two optional announcement fields let Story Suite's overlay manage an extension (no change to
`suite.js`; announcements keep any extra fields):

```js
suite.announce({
    id: 'my-ext', name: 'My Extension', version: '1.0.0', owns: ['scene'],
    settings: '#my_ext_settings',          // the root of its panel under Extensions, moved into the overlay
    api: {
        manage: {
            areas: ['scene'],              // every area it can keep, offered now or not
            sources: () => ({ scene: 'auto' }),           // its Source of truth choices now
            setSource: (area, choice) => { … },           // save and apply, like its own select
            enabled: () => true,           // optional: its on/off switch
            setEnabled: on => { … },       // optional
        },
    },
});
suite.api('story-block')?.openSuite?.('my-ext');  // open the overlay on a tab ('overview' by default)
```

`setSource` and `setEnabled` update the extension's own panel too, and re-announce when what it
offers changes. Switched off, an extension with `setEnabled` announces again with
`enabled: false` rather than withdrawing, so the overlay can switch it back on (`owner`, `has`
and `api` already skip it; the overlay reads `providers()`). Story Block's overlay is shown
while two or more extensions are announced, on or off.
While it is open, `<body>` carries the class `story-suite-open`: hide floating buttons that would
sit over it (`body.story-suite-open #my-launcher { display: none !important; }`). Each
extension's *Manage all in Story Suite* link carries `data-story-suite-link`, so the overlay
hides it while that panel is shown inside it.

Announce again whenever what you offer changes (a block switched on or off), and `withdraw(id)`
when the extension is turned off (or announce `enabled: false`, below). Ids: `story-block`, `story-director`, `npc-state-delta`,
`rpg-battle`.
