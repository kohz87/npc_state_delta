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

- **Tokens per reply:** each extension's estimate of what it adds to an ordinary reply (the
  prompt it injects, and what it asks the model to write back), with a total and a breakdown.

Each panel stays in the Extensions drawer as before, with a *Manage all in Story Suite* link
while the overlay is available. Alone, nothing changes.

## Shown in one place

With NPC State Delta installed, the **Present NPCs** cards show each NPC as they are this moment:
a *now* line (mood, condition, outfit: from World State when Story Block keeps the scene) and
their **NPC Inner Chatter** line as a speech bubble beside the card (a thought bubble when only
one NPC has a line). Story Block then hides its own Chatter tab; the block is still written and
kept as before, and its instruction points the model at NPC State Delta's cards.

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

`api.manage.tokens()` (optional) → `{ input, output, parts: [{ label, input, output }] }`: the
extension's estimate, at about four characters a token, of what it adds to the next ordinary
reply: `input` the prompt it injects, `output` what it asks the model to write back. Each counts
only what it injects itself; Story Block counts kept blocks under their owners' names. Quiet
calls (summaries, planning, flavour) are not counted.

**One look for the four settings panels**, NPC State Delta's. `src/suite.css` (identical in all
four, loaded once as `<link id="story-suite-css">`) styles the shared parts:

```html
<div class="inline-drawer-content story-suite-panel">                     <!-- the drawer content -->
  <div class="story-suite-manage" data-story-suite-link hidden>           <!-- first -->
    <button class="menu_button"><i class="fa-solid fa-layer-group"></i> Manage all in Story Suite</button>
  </div>
  <div class="story-suite-quickbar">                                      <!-- switches and main actions -->
    <label class="story-suite-row" for="my_enabled"><span><b>Enable My Extension</b></span><input id="my_enabled" type="checkbox"></label>
    <div class="story-suite-actions"><button class="menu_button">…</button></div>
  </div>
  <div class="story-suite-folds">
    <details class="story-suite-fold" data-fold="money">                  <!-- each section -->
      <summary><b>Money</b><small>copper / silver / gold</small></summary>
      <div class="story-suite-fold-body">
        <label class="story-suite-row" for="my_currency">                  <!-- each setting -->
          <span><b>Currency</b><small>Loot is written in it. · Now: …</small></span>
          <select id="my_currency" class="text_pole">…</select>
        </label>
      </div>
    </details>
  </div>
</div>
```

Also: `story-suite-number` (a number with its unit), `story-suite-subhead`, `story-suite-muted`,
`story-suite-notice` (a gold-edged line) and `story-suite-danger`. Checkboxes in a row show as an
Enabled/Disabled pill. Sections start closed and the open ones are remembered in the browser;
*Source of truth* is one section of rows like the above.

An announcement may carry `shows: ['chatter']`: this extension displays Story Block's NPC Inner
Chatter, so Story Block hides its own Chatter tab while that extension is announced and on.

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
