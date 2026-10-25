# The timeline participant (Story Block docs/v2/TIMELINE.md, contract §8, track B6)

NPC State Delta keeps native state beside the story: dossiers (with their evidence and locks), the relationship map, its own rollback
history, portraits. When a character dies and the story returns to a save point, that state has to go back with the story, and the
dossier of the person who died has to learn it. Story Block's timeline asks every module with native state to be a **participant**.
This folder is Delta's: `src/storysuite-participant/` (new files only; Delta's own modules, storage and **prompts** are untouched).

Story Block's side is `docs/v2/TIMELINE.md` (participants, the commit-time probe, recovery) and `docs/v2/HISTORY.md` (active history, the head-selection
barrier) in kohz87/Story_block. This note is Delta's side; the vendored copy in `tests/vendor/story-block/` is Story Block `5043028` (E1, E5, E6a, ctx-seams, E6b).

## What it is

- `participant.js` `createParticipant({ port, vault })` -> `{ participant, queries, hydrate, nativeChange, noteChange, flush, ... }`. `participant` is
  what a module definition declares (`participant:`): `schema` 1 and the callbacks `checkpoint`, `prepare`, `activate`, `abort`, `status`,
  `applyEvent`, `attach`, each answering `{ ok: true, ... }` or the common failure envelope, run one at a time.
- `timeline.js`: **what the participant keeps lives in Delta's own chat state**, `state.timeline = { v, lineage, identity: { map }, reserved, applied }`:
  - `lineage` (`lg_xxxxxxxx`) is the id of the story's native line, minted once and stored in the state. A checkpoint belongs to a lineage, never to a
    chat key or a file name. A chat rename moves the state file (the block goes with it), a branch inherits the block (`branch.js` `bestAncestorState`),
    a bundle export carries it (`bundle.js`); an import into a chat with no lineage adopts the map, and takes a lineage of its own when the bundle came from another chat.
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

- `checkpoint({ cursor, headHash })`: **quiet**. It waits for dossier work (`port.idle`, 20 s), and answers a retryable `STALE` if Delta will not be quiet, the
  state moves while the checkpoint is made, or Delta has **saved a change the story has not recorded yet** (the live state is not the baseline the timeline stands
  on; the publish is asked for, and the save made again). When the host gives no way to publish (`UNSUPPORTED`) nothing is waited for. Then it hydrates,
  snapshots, stores, answers `{ checkpoint, hash, schema }`.
- `current({ checkpoint, hash, schema })` -> `{ ok: true, current: boolean }`, **synchronous**: Story Block's commit-time probe. The host asks it once, inside
  the synchronous section that commits a save point, for the checkpoint this participant supplied (a native change that lands after `checkpoint()` answered is
  not in the head hash, so the probe is the only thing that sees it). `current` is true only when the checkpoint is one this participant handed over (or
  installed), the native state still hashes to what it was then, and no dossier work is running, due or queued. False (or a throw, or a promise, or any other
  answer) makes the host discard the save with a retryable `STALE`. The same reading of "the state is the one handed over" (`stands`) is what an activation
  checks after it installs a checkpoint, minus the "no dossier work" clause (work waiting for the barrier is not a reason to refuse the install).
- `prepare({ return, checkpoint, hash })`: verifies the bytes (gone: `SNAPSHOT_UNAVAILABLE`; another hash, another lineage or a return already
  prepared for another checkpoint: `CONFLICT`; a newer schema: `SNAPSHOT_UNAVAILABLE`) and shows nothing. The same prepare answers the same.
- `activate({ return, prepared })`: **the journal decides what the story stands on, so the selected bytes are the live state before this answers.** A restore
  and a selected head (the host's own `selection` journal entry, below) install the saved state through the port (`restoredState`: its map and deaths, this
  lineage's id, every np_ either timeline issued reserved), durably, then read it back and check it (the bytes are what stands, and the probe above agrees)
  before acknowledging; a failed install or check is a retryable answer and the barrier holds. A change Delta made and published after the fact (below) is
  acknowledged as it is when the live state already is those bytes; when it is not (a recovery after a crash finds an older state file) the selected bytes
  are installed the same way. The one exception is a newer change of Delta's own, announced (`noteChange`) after the state of the publication was read (so also
  while its checkpoint was being uploaded): it is live, it is not overwritten, and it is published next on this baseline. The index entry of the publication
  carries that fact (`newer`, saved), so a restart that finds the publication in the host's journal knows it too. An aborted preparation is refused.
- `abort`: before the commit only (a committed return is `REFUSED`); idempotent.
- `status({ return })`: `prepared | active | aborted`. The host's recovery asks it to learn whether the participant switched already and **skips the
  activation when it says active**, so it says active only while the live state is that checkpoint's bytes; otherwise (a write that never reached the file, bytes
  gone) it says prepared and the activation is asked for again, which installs them or refuses. A completed restore is not skipped on the index's word.
- `applyEvent({ event, nativeKey, kind: 'confirmed-death' })`: the dossier becomes Delta's explicit, terminal death (`manualLifeStateRecord` with the
  event as the reason), the event is put in `timeline.applied`, a checkpoint is made, the ack is recorded; the same event again returns the same ack (and
  finishes an install that was lost); another person for the same event is `CONFLICT`; an unknown native key is `NOT_FOUND` (the death is held, never guessed).

## What counts as "Delta is at work" (scan intent)

The scan registry (`isScanBusy`) holds only the operations that have begun, so it is false between one scan ending and the queued one beginning (`scanNow` awaits
the server first), and for a reply whose scan is due but not started. `index.js` therefore counts **intent** per chat: from the reply arriving
(`handleAssistantMessageReceived`) and for the whole run of every `scanNow`, queued drain, backfill pass and targeted pass (`withScanIntent`); `scanWorkPending`
is the registry, the intents and a queued automatic scan (`pendingAutoScans`). That is what `scanActive`/`scanIdle` (the port's `busy`/`idle`) answer. The
participant's own writes are counted per chat too, so one chat's install never hides another chat's change.

## Nothing runs until the chat uses the timeline

Registering with the host, opening a chat, a reply, a scan and a rebuild hydrate nothing, write nothing and publish nothing for a chat that has not used the timeline,
so a populated chat that never asks stays byte for byte what Delta alone keeps (no `state.timeline`, no checkpoint file, no participant index, nothing in the host's
chat metadata). A chat **uses** it when something needs the line: a save point (`checkpoint`), a restore or a selected head (`prepare`/`activate`), a confirmed
death, or the first question to `npc.identity` (the ids are made behind it). The state then carries `state.timeline.lineage`, which is how every later run knows
(`started`; the runtime answers `timelineStarted()` without cloning the state), and its changes are published from then on. What changed before the first use is in
the first checkpoint, which is the baseline.

## Every native change is published (N2)

Delta saves its chat state through three functions (`persist`, `persistCritical`, `persistCriticalDurable`), all ending in `markStateDirty`; a scan, a targeted
dossier pass, a branch reconcile, a manual add, edit or delete, an import, the canonical server state, a rename and the v2 meter sync all save that way. So
`markStateDirty` announces the change (`window.NPCStateDelta.onNativeChange`), and the participant publishes it: `noteChange()` (debounced) ->
`nativeMutation` with the checkpoint the story stood on as `before` and the state now as `after`, both durable, at the head. STALE and RESTORE_PENDING are
tried again; nothing is published when the state is the one the story already stands on. The participant's own writes (`installState`, `writeTimeline`) carry
a counter and are not announced. `nativeChange({ source, edit })` is the other direction (edit a copy, let the host activate it) for a change that has not
been made yet.

The **baseline** of a change (the checkpoint the story stands on, `before`) is verified (bytes, hash, lineage) before the change is made: when it is gone or is not
the recorded one the change is refused with a Problem (the participant's `warn`, and the reason reaches the host as a `FAILED` prepare) and is never published on a
baseline made up from the new state.

`nativeMutation` takes the `Source` of the reply at the head (`sid`, `swipeKey`, `evidence`, `ordinal`). The host's `head()` carries it (`head().source`, Story Block
E6a), and the participant takes it from there; `port.headSource()` is only the fallback for a host that predates it, and with neither the publication answers
`UNSUPPORTED`, the change waits (the next checkpoint still carries it, state is whole in every one) and a save is not held up for it.

## Head selection: the host's barrier

A delete, a swipe, a retraction (the reply that holds a restore goes) or a Re-read moves the head. Story Block then raises its barrier (every module is
`restore-pending`, generations are held), works out the checkpoint of the selected head for each participant from the prefix map (exact surviving prefix
witnesses and replayed state, one rule: `selectionPlan`), writes a `selection` journal entry and calls the participant's `prepare` and `activate` like it does for
a restore, and lowers the barrier only when the participants stand on those checkpoints and the chat file has it. **Delta does not select anything and keeps no
copy of that rule**: the callbacks above are all it does. What Delta owes the barrier is to read and write nothing while it is up:

- `messageGate.settled()` (the adapter, `src/storysuite-v2.js`) asks `sdk.timeline.head()` — the host's own look at the head, which raises the barrier when a
  selection is needed and answers `RESTORE_PENDING` while it is up — every 50 ms until it answers, for at most 20 s; false when it does not.
- `index.js` asks it (`messageGateSettled`) before a reply's scan, a queued drain, a backfill, a targeted pass (`withScanIntent`), before a branch reconcile
  (`reconcileCurrentBranch`: a delete or a swipe) and before a generation's injection is built (`generationReady`: `MESSAGE_SENT` and `GENERATION_AFTER_COMMANDS`).
  A scan that waits counts as dossier work (a save point waits for it). **Work is never dropped when the wait runs out:** a reply's scan (its receipt), a queued
  drain, backfills, a targeted pass, a reconcile and the injection are kept in `deferredWork` (`deferUntilSettled`) and carried out when the barrier is down; a
  Problem (a warning toast) says the scan is pending if the host has not settled for ten minutes, and the work still waits. A reply's retry runs only if the reply
  is unchanged (same text, same place in the story: `replyGuard`); work for a chat that is no longer open is the only other work given up.
- The host's queries of Delta are held by the host while the barrier is up (it answers null for a module that is `restore-pending`).

## After a restore: active history

Story Block fades the replies of the dead timeline and **hides them with SillyTavern's own flag** (`is_system`; HISTORY.md): SillyTavern builds no prompt from a hidden
message, so Delta's prompt text needs no filter and has none. Delta's own readers of the chat skip `is_system` like `cleanMessage` always did, the story day
included. The gate is the second look, for a message the host could not hide and for the moment before it has: `refreshMessageGate()` (`src/transcript.js`) asks the
adapter, which answers Story Block's one active-history filter, `sdk.timeline.history()` (one `active` flag per message of the chat at the moment it is asked), and the
faded messages are remembered **by identity** (a `WeakSet`), so a delete or a swipe after the ask cannot move the mark onto another message. It is asked before any
prompt is built from the chat: a scan, a targeted pass, Refresh from chat, the dossier import, a backfill, a generation's injection. A faded message reads as a system
message. With no gate, or nothing faded, the chat is read as it always was, byte for byte.

## The port, and what is wired

The participant needs of Delta's runtime (the `port`): `chatKey()`, `readState()` (synchronous, a copy), `installState(state)` (absolute, durable),
`writeTimeline(block)` (the block into the state, durable), and optionally `started()`, `busy()`, `idle(ms)`, `headSource()`, `restored()`, `warn(text)`. The
runtime entries (`chatKey`, `requestHeaders`, `installState`, `writeTimeline`, `onNativeChange`, `timelineStarted`, `stateReady`, `scanActive`, `scanIdle`,
`useMessageGate`), the announcement in `index.js`, the branch and bundle carry and the registration in `src/storysuite-v2.js` are Delta's own wiring;
`tests/storysuite-participant-runtime.test.js` runs them in the real runtime. The ids exist before the first ask only for a chat that uses the timeline (above).

Not done, written down:

- A merge or rekey of a dossier (its native id changes) looks like one dossier gone and one new: the old np_ is archived and the new one gets
  a new id. The contract holds that as CONFLICT until Delta reconciles it; nothing here reconciles.
- Companions are not remapped by name (contract); nothing here does it.
- The vault never prunes (checkpoints are small next to their chat, but a long chat with portraits is not): pruning is the timeline's own gap.
- Publishing happens after Delta saved the change, so the new state is visible in Delta (and its prompt) a moment before the timeline records it; the
  contract's order (before exposing) needs Delta to build the change on a copy and let the host activate it (`nativeChange`), a rewrite of the scan apply
  paths. The prefix map still gets its entry at the head the change was made at, and a save point is exact (it waits for the scan).
- A manual scan and the targeted passes read the transcript through the gate; the dossier prompts built before a restore are not rebuilt.
- The retained bytes are never pruned on either side (the host's archive, Delta's vault): Story Block's HISTORY.md lists reachability pruning and an owner
  checkpoint-release protocol as its follow-up, and the vault follows it.

## The prompt rule

Model-facing text is untouched: the participant adds no prompt, no request and no scan, and the transcript gate changes nothing without a gate. `scripts/measure-stage9.mjs` and
`tests/stage9-regression.test.js` (the scanner request bytes), `npm run measure:prompts` and `npm run validate` are the proof, run at the end
of the branch and shown unchanged.
