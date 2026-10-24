# The timeline participant (Story Block docs/v2/TIMELINE.md, contract §8, track B6)

NPC State Delta keeps native state beside the story: dossiers (with their evidence and locks), the relationship map, its own rollback
history, portraits. When a character dies and the story returns to a save point, that state has to go back with the story, and the
dossier of the person who died has to learn it. Story Block's timeline asks every module with native state to be a **participant**.
This folder is Delta's: `src/storysuite-participant/` (new files only; Delta's own modules, storage and **prompts** are untouched).

## What it is

- `participant.js` `createParticipant({ port, vault })` -> `{ participant, queries, hydrate, nativeChange, identity, index }`. `participant` is
  what a module definition declares (`participant:`): `schema` 1 and the callbacks `checkpoint`, `prepare`, `activate`, `abort`, `status`,
  `applyEvent`, `attach`, each answering `{ ok: true, ... }` or the common failure envelope, run one at a time.
- `checkpoint.js`: a native checkpoint is one plain-JSON document `{ schema, kind, chatKey, cursor, headHash, state, identity, applied }`:
  Delta's whole chat state as `getState()` gives it (dossiers, candidates, the social graph, rollback checkpoints and lineage, portraits), the
  np_ map and the applied death ids. Its hash is the contract's Hash (`hash.js`, the same SHA-256 of normalized JSON as the other repos); its
  id is `nk_` plus eight base36 characters of the hash, so the same native state at the same head is the same checkpoint.
- `identity.js`: `npc.identity({ id } | { name })` (contract §8). One `np_` per dossier, assigned to every dossier before a native head is
  published, stable through a rename (the native key is the dossier's own id), archived and never reused when the dossier is gone, bound to
  the chat; a name, alias or native key resolves only when exactly one dossier answers; unknown, ambiguous, archived or malformed is null and
  asking creates nothing. The map is part of every checkpoint, so a restore puts the dossiers and their ids back together; ids the dead timeline
  issued stay **reserved** (kept outside the checkpoints, inactive, resolving through nothing, never issued again).
- `vault.js`: where the bytes live. `fileVault` writes SillyTavern user files the way Delta's sidecar does (one file per checkpoint, written
  once; one small index per chat: the live np_ map, the applied deaths, the ids ever issued, the restores in flight); `memoryVault` is for tests.

## The callbacks

- `checkpoint({ cursor, headHash })`: hydrates the np_ map, snapshots, stores, answers `{ checkpoint, hash, schema }`.
- `prepare({ return, checkpoint, hash })`: verifies the bytes (gone: `SNAPSHOT_UNAVAILABLE`; another hash, another chat or a return already
  prepared for another checkpoint: `CONFLICT`; a newer schema: `SNAPSHOT_UNAVAILABLE`) and shows nothing. The same prepare answers the same.
- `activate({ return, prepared })`: installs the state through the port, then the np_ map and the applied deaths together; idempotent; a failed
  install leaves it prepared, so it can be tried again; an aborted preparation is refused.
- `abort`: before the commit only (a committed return is `REFUSED`); idempotent. `status({ return })`: `prepared | active | aborted`.
- `applyEvent({ event, nativeKey, kind: 'confirmed-death' })`: the dossier becomes Delta's explicit, terminal death (`manualLifeStateRecord`
  with the event as the reason), a checkpoint is made, the event is recorded with its ack; the same event again returns the same ack (and
  finishes an install that was lost); another person for the same event is `CONFLICT`; an unknown native key is `NOT_FOUND` (the death is
  held, never guessed).
- `nativeChange({ source, edit })`: the route for a scan, a manual edit or a meter synchronization to be published through the timeline's
  `nativeMutation`: `edit` changes a copy, both checkpoints are made durable, the host activates the after.

## The port, and what is wired

The participant needs three things of Delta's runtime (the `port`): `chatKey()`, `readState()` (synchronous, a copy) and `installState(state)`
(an absolute, durable replacement). `chatKey` and `installState` are new on `window.NPCStateDelta` (`index.js`), and the module definition in
`src/storysuite-v2.js` declares `participant` and answers `npc.identity`: that registration is the lead's ("lead-owned:" commit on this
branch). Not done, written down:

- Delta's scan, manual edit and meter paths do **not** yet publish through `nativeChange`; until they do, a native change made between two save
  points is carried by the next checkpoint (state is whole in every checkpoint) but is not a head of its own. The np_ of a dossier admitted by
  such a path is assigned by the next `hydrate()` (a checkpoint, a query's first use after `hydrate`, a restore).
- A merge or rekey of a dossier (its native id changes) looks like one dossier gone and one new: the old np_ is archived and the new one gets
  a new id. The contract holds that as CONFLICT until Delta reconciles it; nothing here reconciles.
- Companions are not remapped by name (contract); nothing here does it.
- The vault never prunes (checkpoints are small next to their chat, but a long chat with portraits is not): pruning is the timeline's own gap.

## The prompt rule

Model-facing text is untouched: the participant adds no prompt, no request and no scan. `scripts/measure-stage9.mjs` and
`tests/stage9-regression.test.js` (the scanner request bytes), `npm run measure:prompts` and `npm run validate` are the proof, run at the end
of the branch and shown unchanged.
