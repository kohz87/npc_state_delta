# The timeline participant (Story Block docs/v2/TIMELINE.md, contract §8, track B6)

NPC State Delta keeps native state beside the story: dossiers (with their evidence and locks), the relationship map, its own rollback
history, portraits. When a character dies and the story returns to a save point, that state has to go back with the story, and the
dossier of the person who died has to learn it. Story Block's timeline asks every module with native state to be a **participant**.
This folder is Delta's: `src/storysuite-participant/` (new files only; Delta's own modules, storage and **prompts** are untouched).

## What it is

- `participant.js` `createParticipant({ port, vault })` -> `{ participant, queries, hydrate, nativeChange, noteChange, flush, ... }`. `participant` is
  what a module definition declares (`participant:`): `schema` 1 and the callbacks `checkpoint`, `prepare`, `activate`, `abort`, `status`,
  `applyEvent`, `attach`, each answering `{ ok: true, ... }` or the common failure envelope, run one at a time.
- `timeline.js`: **what the participant keeps lives in Delta's own chat state**, `state.timeline = { v, lineage, identity: { map }, reserved, applied }`:
  - `lineage` (`lg_xxxxxxxx`) is the id of the story's native line, minted once and stored in the state. A checkpoint belongs to a lineage, never to a
    chat key or a file name. A chat rename moves the state file (the block goes with it), a branch inherits the block (`branch.js` `bestAncestorState`),
    a bundle export carries it (`bundle.js`, and an import into a chat with no lineage adopts it).
  - `identity.map` is the np_ of every dossier (below), `reserved` every np_ ever issued in the lineage, `applied` the confirmed deaths applied.
- `checkpoint.js`: a native checkpoint is one plain-JSON document `{ schema, kind, lineage, cursor, headHash, state }`: Delta's whole chat state as
  `getState()` gives it (dossiers, candidates, the social graph, rollback checkpoints and lineage, portraits, and `timeline`). Its hash is the contract's
  Hash (`hash.js`); its id is `nk_` plus eight base36 characters of the hash. A restore therefore puts dossiers, np_ map and applied deaths back together.
- `identity.js`: `npc.identity({ id } | { name })` (contract §8). One `np_` per dossier, assigned to every dossier before a native head is published,
  stable through a rename (the native key is the dossier's own id), archived and never reused when the dossier is gone (a native key that comes back gets
  a new id), a name, alias or native key resolves only when exactly one dossier answers; unknown, ambiguous, archived or malformed is null and asking
  creates nothing. The query reads the ids from the state, so the first ask after a reload answers; a dossier with no np_ yet is hydrated behind it.
  Ids the dead timeline issued stay **reserved** after a restore (kept in `reserved`, merged by `restoredState`).
- `vault.js`: where the bytes live. `fileVault` writes SillyTavern user files the way Delta's sidecar does (one file per checkpoint, written once; one small
  index per lineage: the restores in flight, the acknowledged deaths, the checkpoint the story stands on), with a request timeout; `memoryVault` is for tests.

## The callbacks

- `checkpoint({ cursor, headHash })`: **quiet**. It waits for a scan or dossier pass in flight (`port.idle`, 20 s), and answers a retryable `STALE` if Delta
  will not be quiet or the state moves while the checkpoint is made, never a save that would miss the scan. Then it hydrates, snapshots, stores, answers
  `{ checkpoint, hash, schema }`.
- `prepare({ return, checkpoint, hash })`: verifies the bytes (gone: `SNAPSHOT_UNAVAILABLE`; another hash, another lineage or a return already
  prepared for another checkpoint: `CONFLICT`; a newer schema: `SNAPSHOT_UNAVAILABLE`) and shows nothing. The same prepare answers the same.
- `activate({ return, prepared })`: installs the saved state through the port (`restoredState`: its map and deaths, this lineage's id, every np_ either
  timeline issued reserved); idempotent; a failed install leaves it prepared, so it can be tried again; an aborted preparation is refused. A change Delta
  already made and published after the fact (below) is not installed over the live state.
- `abort`: before the commit only (a committed return is `REFUSED`); idempotent. `status({ return })`: `prepared | active | aborted`.
- `applyEvent({ event, nativeKey, kind: 'confirmed-death' })`: the dossier becomes Delta's explicit, terminal death (`manualLifeStateRecord` with the
  event as the reason), the event is put in `timeline.applied`, a checkpoint is made, the ack is recorded; the same event again returns the same ack (and
  finishes an install that was lost); another person for the same event is `CONFLICT`; an unknown native key is `NOT_FOUND` (the death is held, never guessed).

## Every native change is published (N2)

Delta saves its chat state through three functions (`persist`, `persistCritical`, `persistCriticalDurable`), all ending in `markStateDirty`; a scan, a targeted
dossier pass, a branch reconcile, a manual add, edit or delete, an import, the canonical server state, a rename and the v2 meter sync all save that way. So
`markStateDirty` announces the change (`window.NPCStateDelta.onNativeChange`), and the participant publishes it: `noteChange()` (debounced) ->
`nativeMutation` with the checkpoint the story stood on as `before` and the state now as `after`, both durable, at the head. STALE and RESTORE_PENDING are
tried again; nothing is published when the state is the one the story already stands on. The participant's own writes (`installState`, `writeTimeline`) carry
a counter and are not announced. `nativeChange({ source, edit })` is the other direction (edit a copy, let the host activate it) for a change that has not
been made yet.

**A gap that blocks this in production, and a patch for it.** `nativeMutation` takes the `Source` of the reply at the head (`sid`, `swipeKey`, `evidence`,
`ordinal`) and a module has no way to get one: `handle.head()` carries a cursor. The participant takes `head.source` when the host gives one, else `port.headSource()`
(the tests' seam is `store.sourceAt`); with neither it answers `UNSUPPORTED` and the change waits (the next checkpoint still carries it, state is whole in every
one). `e6a-head-source.patch` (for Story Block, not edited here) adds `source` to `head()`.

## After a restore

Story Block fades the replies of the dead timeline; they stay in SillyTavern's chat array. The adapter keeps `sdk.timeline.history()`'s `active` flags
(refreshed at a turn, a restore and before a scan) and gives Delta a gate (`useMessageGate`, `src/transcript.js`): the transcript walks read a faded message as a system
message (skipped, index kept), so a scan does not read the dead timeline. With no gate, or nothing faded, the chat is read as it always was, byte for byte.

## The port, and what is wired

The participant needs of Delta's runtime (the `port`): `chatKey()`, `readState()` (synchronous, a copy), `installState(state)` (absolute, durable),
`writeTimeline(block)` (the block into the state, durable), and optionally `busy()`, `idle(ms)`, `headSource()`, `restored()`, `warn(text)`. The
runtime entries (`chatKey`, `requestHeaders`, `installState`, `writeTimeline`, `onNativeChange`, `stateReady`, `scanBusy`, `scanIdle`, `useMessageGate`), the
announcement in `index.js`, the branch and bundle carry and the registration in `src/storysuite-v2.js` are the "lead-owned:" commits on this branch;
`tests/storysuite-participant-runtime.test.js` runs them in the real runtime. At chat open the adapter hydrates (`primeTimeline`), so the ids exist before the
first ask.

Not done, written down:

- A merge or rekey of a dossier (its native id changes) looks like one dossier gone and one new: the old np_ is archived and the new one gets
  a new id. The contract holds that as CONFLICT until Delta reconciles it; nothing here reconciles.
- Companions are not remapped by name (contract); nothing here does it.
- The vault never prunes (checkpoints are small next to their chat, but a long chat with portraits is not): pruning is the timeline's own gap.
- Publishing happens after Delta saved the change, so the new state is visible in Delta (and its prompt) a moment before the timeline records it; the
  contract's order (before exposing) needs Delta to build the change on a copy and let the host activate it (`nativeChange`), a rewrite of the scan apply
  paths. The prefix map still gets its entry at the head the change was made at, and a save point is exact (it waits for the scan).
- The testkit is the E6a branch's (`dcb371f`); it is re-vendored to the final E6a head when it lands.
- A manual scan and the targeted passes read the transcript through the gate; the dossier prompts built before a restore are not rebuilt.

## The prompt rule

Model-facing text is untouched: the participant adds no prompt, no request and no scan, and the transcript gate changes nothing without a gate. `scripts/measure-stage9.mjs` and
`tests/stage9-regression.test.js` (the scanner request bytes), `npm run measure:prompts` and `npm run validate` are the proof, run at the end
of the branch and shown unchanged.
