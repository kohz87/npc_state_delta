# NPC State Delta v1.2.3

A SillyTavern extension that keeps a living dossier for every NPC in your roleplay: who they are, how they look, how they talk and behave, what they remember, and how they feel about you. After each reply it scans the story, updates the dossiers carefully, and feeds the present NPCs back to the roleplay model so they stay in character.

**Current release:** 1.2.3 · [Changelog](CHANGELOG.md) · [Development guide](DEVELOPMENT.md)

---

## Contents

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Install and update](#install-and-update)
- [Getting started](#getting-started)
- [Settings](#settings)
- [How dossiers work](#how-dossiers-work)
- [Swipes, edits and rollback](#swipes-edits-and-rollback)
- [Data, backups and multiple devices](#data-backups-and-multiple-devices)
- [Troubleshooting](#troubleshooting)
- [For developers](#for-developers)
- [License](#license)

---

## What it does

- **Dossiers for every NPC.** Identity, species, gender, age, home base, appearance, personality, speech, mannerisms, Behavioral Levers, background, goals, important memories and bonds with other NPCs.
- **Automatic scanning.** After each story exchange, a scanner request reads the latest scene and proposes changes. Only changes the story supports are accepted.
- **Stays in character.** Present NPCs are injected into the next roleplay request, so the model sees their personality, voice and behaviour, not just their name. An off-screen NPC you name in your message is sent too, so she arrives as herself.
- **Relationships.** Trust, Affection, Desire and Tension toward the player move in small, capped steps with a reason recorded for each change.
- **Appearance that keeps up.** Outfits change without erasing hair, eyes or scars. Shapeshifters can have several named forms.
- **Portraits.** Upload one, or generate one through SillyTavern Image Generation, with prompts built from the dossier.
- **Calendar and birthdays.** Custom fantasy calendars, and birthdays that age NPCs correctly.
- **Swipe and edit safe.** Deleting, editing or swiping messages rolls the dossiers back to match.
- **Backups and diagnostics.** Export and import dossiers and portraits, and see why each profile change was accepted or held.

## Requirements

- SillyTavern **1.18.0** or later.
- A model connection for scanning. It can be the same one you roleplay with, or a separate connection profile.

## Install and update

1. In SillyTavern, open **Extensions → Install extension** and paste this repository's URL.
   Or unpack `npc_state_delta-1.2.3.zip` so that a single `npc_state_delta` folder contains `manifest.json` directly.
2. Reload SillyTavern.
3. **Before updating an existing install,** export a backup from **Data & maintenance → Backup / Export**.

## Getting started

1. Open **Extensions → NPC State Delta** and make sure **Enable NPC State Delta** and **Auto scan** are on.
2. Play normally. After each reply the scanner picks up named NPCs and starts their dossiers.
3. Click the floating launcher, or **Open dossiers**, to browse the cast.
4. If someone is missing, use **Add NPC**. If a dossier looks stale, open it and use **Refresh**, which re-reads the recent story for that one NPC.

> **Tip:** Automatic scans only read the latest exchange. **Refresh** reads a longer recent window, so it is the quickest way to fill in or fix one NPC.

## Settings

The settings panel has a quick bar that is always visible, plus seven groups.

| Where | What you'll find |
|---|---|
| **Quick bar** | Enable, Auto scan, Open dossiers, Scan dossier now, Full scan current cast, Add NPC |
| **Scanning** | Scanner connection profile, how often to scan, how much story to send, how readily new NPCs get a dossier (Conservative, Balanced or Manual only), and the experimental one-pass narration capture |
| **Roster & continuity** | Present NPCs in chat (Full cards, Compact strip, Only in Story Block or Off), injection on/off and budget (a ceiling, default 4000 tokens), relationship map (on/off, default distance), custom fields, maximum active NPCs, death and return handling, stale NPC cleanup, rescan and middle-deletion rewind options |
| **Calendar & birthdays** | Month names and lengths, optional era, optional campaign date |
| **Source of truth** | Who leads each shared area (NPCs, calendar, scene, game stats) when Story Block, Story Director or RPG Battle is installed: Automatic, This extension or The other one |
| **Portrait generation** | Style presets, positive and negative prompts, composition, prompt format |
| **Scanner rules** | Advanced: relationship starting values and per-scan caps, memory criteria, behaviour rubric |
| **Data & maintenance** | Backup / Export, Restore / Import, Diagnostics, and clearing this chat's dossiers |

Leave the scanner connection profile empty to use SillyTavern's current connection. If you pick a profile that isn't available, scanning fails visibly instead of silently switching.

### Story Block tabs

With [Story Block](https://github.com/kohz87/Story_block) installed, Delta adds two tabs to its sidebar and card, next to your inventory, World State and other blocks:

- **👥 Present NPCs:** the same cards as in the chat, for whoever is present in the latest scene.
- **📇 Dossiers:** every dossier with a search box. The dead stay out of the list until you search for them. Tap a row to open that dossier.

Each present NPC's card shows, under the portrait, what they are like now as labelled lines: **Mood**, **Condition** and **Outfit** (only those known, each wrapping to two lines; hover a line for its full text), from Story Block's World State for the latest reply while Story Block keeps the scene (Source of truth → Scene), otherwise from the dossier. With Story Block's **NPC Inner Chatter** block on, each line of chatter appears as a bubble beside the speaker's card, in the chatter's order: speech bubbles when two or more NPCs whisper, a thought bubble when only one has a line. On wide screens the bubble sits beside the card, on phones under it; lines from someone without a card go to a small *Others* line under the cards. Story Block then hides its own Chatter tab (the block is still written as before). All of this is display only.

While Story Block is installed, the cast shows only in Story Block until you pick a choice under **Roster & continuity → Present NPCs in chat**. Pick **Full cards** or **Compact strip** to keep it in the chat as well; **Only in Story Block** shows full cards in the chat when Story Block isn't installed. The tabs are display only and change nothing in prompts, scans or saved data. Without Story Block nothing changes.

### Story Suite: Story Block, Story Director and RPG Battle

Delta works alone and alongside [Story Block](https://github.com/kohz87/Story_block), Story Director and RPG Battle. Installed together, they agree on one source of truth per area so the model is not told the same thing twice ([how it works](docs/STORY_SUITE.md)):

- **NPCs:** Delta leads; Story Director's agenda lines then describe only an NPC's plans. Delta keeps its dossiers whatever is chosen here.
- **Scene:** when Story Block's World State block is on, the present NPCs' cards leave out the live mood and current outfit that World State already gives; personality, voice, goals, bonds, custom fields and enduring features are still sent.
- **Calendar:** with Story Director installed, Delta uses its months and era for birthdays and ages, and keeps its own calendar if Story Director's is missing.
- **Game stats:** with RPG Battle installed, **Custom fields** warns when a field name looks like a game stat (Level, HP, Class…) that RPG Battle keeps.
- Delta also reads the World State inside Story Block's hidden block, as it reads Megumin Suite's.
- **Shared with the others (read-only):** the current chat's NPCs (`npcs()`) and NPC profiles (`npcProfiles()`: name, aliases, present, a short role and a summary of up to 200 characters built from the dossier), which RPG Battle can offer as companions, and `openDossier(id)`, which opens Delta's dossier view on that NPC (an exact name or alias also works; archived NPCs open nothing) for RPG Battle's **Dossier** button. Archived and dead NPCs are left out of the profiles; nothing extra is scanned or sent to the model.
- **Tokens per reply:** the Story Suite overlay shows Delta's estimate (about four characters a token) of what it adds to the next ordinary reply: the dossier injection by section (instructions, present NPC cards, mentioned and deceased references, relationship rubric) and, with one-pass capture on, its instruction plus the block the model writes back. Scans are separate requests and are not counted.
- **Chatter on the cards:** Delta tells Story Block it shows NPC Inner Chatter on its Present NPCs cards, so Story Block hides its own Chatter tab while Delta is on.
- **One look:** Delta's settings panel is the shared Story Suite look (`suite.css`, loaded once for all four extensions).

**Source of truth** in the settings lets you choose per area: **Automatic** (the order above), **This extension** or **The other one**. Alone, every choice behaves like Automatic and Delta works exactly as before.

With two or more installed, **Manage all in Story Suite** at the top of Delta's settings opens Story Block's Story Suite overlay: one Source of truth table and on/off switch for all of them, with Delta's own settings in its tab ([how it works](docs/STORY_SUITE.md)).

### One-pass narration capture (experimental)

Off by default. **Scanning → One-pass narration capture** asks the roleplay model to end each reply with a hidden NPC update block. Delta removes the block from the message and uses it instead of the separate scan request for that reply.

- **When it applies:** with Auto scan on and Full scan every turn off, for new replies and continues. Swipes and regenerates use the normal scan, and impersonate and background (quiet) generations never get the instruction.
- **Cost:** every asked-for reply's prompt grows by about 7,500-9,500 characters (roughly 2,000-2,700 tokens, estimated), plus the JSON block at the end of the reply. In return, a reply with a good block needs no scan request.
- **Same checks as a scan:** the block goes through the same evidence checks as an ordinary scan, so it can only propose changes the story supports. It is used once, kept only in memory, and never saved, exported or shown in diagnostics.
- **Fallback:** the normal scan runs on its usual schedule if the block is missing, broken or cut off, if the dossiers changed while the reply was being written (outdated), if the reply or an earlier message was edited, or if the page was reloaded first. Focused relationship passes, Refresh and backfills still run as separate scanner requests.
- **Your story's own text is safe:** with the setting off, Delta removes only its own hidden `npc_state_delta` comment; JSON blocks and tags the story writes are left alone.
- **Scanner connection profile:** replies with a good block are scanned by your roleplay model; the scanner profile still handles everything else.
- **Check it live before relying on it:** watch a reply while it streams (the block should stay hidden), reload the chat to confirm the saved message has no block, and compare narration quality and length with the setting off. **Data & maintenance → Diagnostics → Roleplay injection** shows the instruction's size and how many replies were asked, used, missing, invalid, cut off or outdated.

## How dossiers work

### The golden rule: evidence first

Nothing changes because the model guessed. A proposed change is accepted only when the story (or the model's quoted evidence) supports it, and only story text about **that** NPC counts. One NPC's scene can never rewrite another NPC's profile. If a field isn't mentioned, it stays as it is.

### Personality, speech and mannerisms

These are meant to be stable, like a real person's character:

- **One scene is not enough** to rewrite them. A change needs repeated evidence across separate scenes (three, or two for Personality and Speech when they are a week or more apart in story time), or an explicit event or time skip in the story ("after a winter at the academy, she speaks with formal precision").
- **Story time, not message count.** When your World State block carries a date (for example Megumin Suite's World State, parsed with your **Calendar** months), development is measured in story days: a tendency shown once and confirmed a week or more later can change Personality or Speech, however few messages passed. A later sighting of the opposite ("timid" after "confident") breaks the trend and it starts again. Without dates, Personality falls back to 20+ messages apart.
- **Speech is recorded as a style.** Evidence names how the NPC talks ("formal aphorisms"), with a quoted line only as an example, so repeated scenes can add up to a Speech change.
- **Mood is not personality.** Fear, anger, flirting or behaviour only toward you never becomes a global trait.
- **Refine vs evolve.** A *refine* adds detail without changing the meaning. A real change of character is an *evolve*, which needs a reason and the evidence above.

### Behavioral Levers

Levers describe how an NPC **generally** responds and decides, with anyone. Each lever is written as `Category: level - effect`, for example:

> `Conflict/Assertiveness: avoidant - answers challenges with cold politeness`

There are twelve categories:

| | | |
|---|---|---|
| Disposition | Care/Warmth | Expressiveness |
| Independence/Agency | Conflict/Assertiveness | Threat Sensitivity |
| Analytical Style | Social Presentation | Cruelty/Mercy |
| Loyalty | Drive/Ambition | Honesty/Candor |

- An NPC has at most six levers.
- **Habits and routines are not levers.** "Keeps a quiet household and enforces curfews" belongs in Mannerisms and is kept out of the lever list.
- **How a lever swings:** the first scene showing a different tendency is stored as pending evidence, and the lever changes when the behaviour shows up again in a later scene. Each category keeps its own pending evidence, so unrelated behaviour in between doesn't push it out. An explicit event or time skip changes it at once. Kind ↔ cruel and independence reversals face extra safety checks.
- Old entries that don't fit a category are listed for rewriting at the next **Refresh**.
- **Outdated traits:** Personality, Speech or levers unchanged for 30+ story days (30+ turns when the chat has no dates), or written before the NPC's background or home base later changed (a servant who now owns the inn), are re-checked at the next **Refresh**. A clause tied to something that has ended (a former job, an abuser who has died) is rewritten from the recent story; everything else is kept.

### Relationship with the player

- **Trust, Affection, Desire and Tension** each run from −100 to +100 and only describe how the NPC feels about **you**.
- Each scan can move them by a small amount capped by how big the moment was (ordinary, meaningful, major, extreme). Every change records its reason, shown on the dossier's Player relationship card.
- The roleplay model gets a short qualitative description, never raw numbers. Personality and levers come first, and the relationship only tints them. A reserved NPC stays reserved even when they like you.
- **Reply numbers:** the dossier header shows **Reply #N**, the latest reply's number in the chat as Story Block counts it (the greeting is reply #0). Changed fields (• #14), the *Updated at reply #14* line and each relationship change show the reply they were recorded at. Changes recorded before 1.2.3 show Delta's older internal count, labelled *turn N*, instead.
- **Map view:** the **Dossier | Map** switch in the dossier panel (or **See on map** on the Player relationship card) puts you at the centre and every NPC around you. The closer they sit, the higher the chosen value (Warmth, Trust, Affection, Desire or Tension); lines are Important Bonds between NPCs, and a gold badge marks this turn's change. Picking someone on the map selects their dossier. Everyone in the scene and active off-screen is always shown, plus the strongest of the rest (24, or 16 on a phone); archived NPCs appear dimmed, while the dead and stale removals are left out. The map only reads the dossiers and never changes them.

### Appearance, outfits and forms

- **Physical features** (hair, eyes, build, scars) are kept separate from the **current outfit & presentation**. Changing clothes never erases physical traits unless the story re-describes them (dyed hair, a new scar).
- NPCs who transform can have several **named forms** (human, dragon, …), each with one complete description, body and outfit together; Physical features apply only when no form is selected. Switching form keeps every form's own anatomy, and outfit and hairstyle changes keep the form's body traits.
- Edit appearance under **Edit dossier → Appearance**.

### Custom fields

- Name up to six fields under **Roster & continuity → Custom fields** (for example `Level, Class, Faction`). Every dossier gets them.
- The scanner fills a value only when the story or World State states it, keeps it while it goes unmentioned, and changes it only when the story says so ("reached level 5"). An NPC who returns after a long absence keeps the value they left with.
- Present NPCs' values are sent to the roleplay model with the rest of their dossier. You can edit them under **Edit dossier**, and **Protect edits** locks them like other fields.
- Leave the setting empty to turn custom fields off; prompts are then exactly as before.
- With RPG Battle installed, a field named like a game stat (Level, HP, Class…) gets a warning under the setting, since RPG Battle already keeps those numbers. Nothing is blocked.

### Important memories and bonds

- **Important memories:** up to five consequential events (promises, betrayals, rescues, discoveries). Routine chatter is ignored.
- **Important bonds:** relationships between NPCs, written as `Name — relation | dynamic` and kept in step on both sides. Deleting a bond by hand keeps it deleted.

### Life and death

- A confirmed on-page death is final for automatic updates. Later scans cannot bring the NPC back.
- If a death was recorded by mistake, open the dossier and use **Restore**. The correction is recorded.
- With **Archive confirmed deaths** on (the default), dead NPCs are archived rather than deleted. They don't take roster slots and never get a full dossier in the roleplay prompt, but the scanner still recognises their name, so a later mention doesn't create a new, living duplicate.
- When the recent story mentions an NPC who isn't in the scene (off-screen, or archived after a long absence), the roleplay model gets one short line of their established facts, such as role, home base, custom fields and how they feel about you, so a returning NPC arrives as they left. The full dossier is sent once they're back in the scene.
- When someone in the story talks about a confirmed-dead NPC, the roleplay model gets one short line about them (who they were and how they died) so it neither revives nor reinvents them. Mention lines are capped at four per reply, living NPCs first.
- A new NPC who shares only a job title with someone you know (a different innkeeper in another town) gets their own dossier instead of overwriting the one you know.
- An NPC is recognised by their full name, an alias, or any distinctive part of their name ("Hask" or "Orrin" for "Capt. Orrin Hask"). Surnames, one-word nicknames and names that are everyday words ("Will") must be capitalised; titles such as "Capt." or "Dr." and role descriptions such as "the innkeeper" never recall anyone on their own.
- The dossier list (**All · Active · Archived**) leaves the dead out. Search by name to find one; a dead dossier you open stays listed while it is selected.

### Portraits

- Upload, replace or remove a portrait, or generate one through **SillyTavern Image Generation** from the dossier's prompt.
- Generated images stay a preview until you apply them, and nothing silently replaces an uploaded image.
- An optional per-NPC seed makes regeneration repeatable.
- Each named form can have its own portrait, and a portrait is flagged when the appearance has moved on since it was made.

### Calendar and birthdays

- Define months as `Month name:days` lines, with an optional era.
- A full date in the story's World State can drive chronology.
- An NPC with a known birthday ages on the right day. Apparent age (how old they look) is tracked separately and never used to work out real age.
- See [birthday continuity](docs/birthday-continuity.md) for supported formats.

### Manual control

- **Edit dossier** changes any field, including **Aliases / nicknames**. Distinctive nicknames help the extension recognise an NPC; role descriptions ("the innkeeper") are kept for reference only.
- Tick **Protect edited stable profile fields** to stop scans from rewriting the fields you edited.
- **Add NPC, Archive, Remove and Restore** are always manual.
- Commands typed into the story text are never executed.

## Swipes, edits and rollback

- **Swipes:** each swipe keeps its own dossier state. Switching back to a known swipe restores it. A swipe that was never scanned starts from the state before it and is scanned again.
- **Hidden messages:** hiding or unhiding messages (for example memory extensions that hide summarised ones) does not affect rollback.
- **Delete or regenerate:** dossiers roll back to the message you returned to. NPCs who only appeared in the removed messages are removed too.
- **Deleting a message from the middle:** later messages were scanned on top of it, so dossiers are not rewound. Instead, everything the deleted message itself changed is undone wherever nothing later touched it: each field returns to how it was before the message (relationship values and the Last relationship change card, mood, appearance, memories the message added, an NPC who only appeared in it, and so on). A field a later message also changed is kept, and confirmed deaths stay unless the deleted message caused the death. Delta tells you when this happens. To rewind everything instead, turn on **Rewind dossiers on middle deletion** (Roster & continuity): every dossier returns to exactly how it was just before the deleted message and whatever the later messages changed is discarded, with no model requests.
- **Edits deep in the past:** if an edit can't be replayed exactly, current dossiers are kept rather than guessed.
- **Reply numbers** follow the branch: a swipe or a rolled-back delete restores them with the rest of the dossier. After a message is deleted from the middle (without **Rewind dossiers on middle deletion**), changes recorded at later replies keep the number the reply had when they were recorded until that field changes again.
- The rollback journal covers the last 256 messages. Full snapshots are size-limited (8 MB total, 2 MB each).

## Data, backups and multiple devices

- Dossiers are stored on your SillyTavern server, in `/user/files/npc-state-delta-*.json`. Any browser or device using the same SillyTavern server sees the same data.
- **Backup / Export** saves dossiers and portraits as a Delta bundle, and **Restore / Import** loads one into the current chat. Importing into a different chat never pretends that chat's history happened.
- Only import Delta's own bundles. Data from other NPC extensions or older generations is not supported.
- Don't run several NPC-tracking extensions that write automatically at the same time.

## Troubleshooting

| Problem | Try |
|---|---|
| Behavioral Levers read like habits or routines | Open the dossier and **Refresh**. Entries outside the twelve categories get rewritten or moved to Mannerisms. |
| An outfit or appearance change was missed | **Refresh** that NPC. Automatic scans only see the latest exchange. |
| Physical features are empty, or body traits sit under the current outfit | **Refresh** that NPC. Enduring traits move into Physical features and the outfit keeps only clothing and condition. For an NPC with named forms, the body belongs in each form instead; Refresh or edit the form (for example a dragon form that still lists human hair). |
| Personality or levers never seem to change | Expected for one-off scenes. They change after repeated scenes or an explicit event or time skip. If the dossier still describes who they *were* (an old job, an old situation), **Refresh** them: long-unchanged traits are re-checked against the recent story. |
| An NPC is missing | **Add NPC**, or use **Full scan current cast**. |
| A scan failed | Check the scanner connection profile in **Scanning**, then use **Scan dossier now**. |
| NPCs contradict their dossier (appearance, voice, levers) | Check **Roster & continuity → Injection budget** is at least 4000 (the default). It's a ceiling: only what the present NPCs need is sent, and detailed dossiers arrive in full. |
| An NPC walks back in and doesn't match her dossier | Name her in your message when you call her in; her dossier is then sent with that reply. If the story brings her in unprompted, the dossier arrives from the next reply, or swipe once she's marked present. |
| An NPC's dossier doesn't seem to reach the story | Open **Data & maintenance → Diagnostics**. The **Roleplay injection** section shows exactly what is sent with each generation, or why nothing is (NPC not present, chat not loaded, injection off). With one-pass capture on, the capture instruction is added after it and shown only as a size. |
| You want to know why a field didn't change | Open the dossier's diagnostics (**Show**) or export them from **Data & maintenance → Diagnostics**. Each field has an outcome such as `applied-refine`, `not-provided` or `waiting-for-revised-candidate`. |

Diagnostics are bounded and read-only. They never store whole stories, full prompts or credentials, and their token counts are local estimates.

## For developers

The extension is plain ES modules with no runtime dependencies. Node.js 24 and Python 3 run the development workflow.

```sh
npm test                        # unit, compatibility and synthetic-host tests
npm run validate                # inventory, isolation, version and ownership checks
npm run measure:prompts         # prompt size measurements
node scripts/measure-stage9.mjs # prompt/request budget baseline
npm run package                 # builds dist/npc_state_delta-1.2.3.zip and its SHA-256
git diff --check
```

- `runtime-modules.json` is the single inventory of shipped modules. The package contains only the runtime modules, stylesheet, manifest, inventory, license and README.
- Application version 1.2.3 is independent of the unchanged storage and bundle formats. Branch lineage remains v5, with guarded v4 compatibility.
- Behaviour is governed by [AGENTS.md](AGENTS.md), [the core contract](docs/core-contract.md) and [the workplan](docs/WORKPLAN.md). Development commands, evidence and limits are in [DEVELOPMENT.md](DEVELOPMENT.md).
- Historical reviews: [1.0.28](docs/v1.0.28-review.md), [1.0.27 prefix cache](docs/v1.0.27-review.md), [Stage 9](docs/stage9-review.md). Seed provenance is in `docs/seed-provenance.*`.

## License

GPL-3.0. See [LICENSE](LICENSE). The seed and history records in `docs/` are preserved as provenance.
