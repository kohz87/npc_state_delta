// Story Suite v2: the state store (SPEC §2, §12). State lives in carriers; this module replays it.
//
// * State at carrier N = the latest checkpoint at or before N, then every carrier's `ops` from there
//   through N. Head state = state at the last carrier. Rebuilding replays stored ops only; it never runs a
//   command handler.
// * A carrier that gets its first record also gets a checkpoint (the state before its own ops) when 100
//   carriers have passed since the last checkpoint, or the ops since then exceed 128 KB of JSON. Older
//   chats have them every 20 carriers / 32 KB: a checkpoint is read wherever it is.
// * Writes go to the head carrier (actions after reply N belong to reply N, so swiping or deleting reply N
//   takes them back) and only ever touch `extra.storySuite` and the matching `swipe_info` extra.
// * Each record is kept once (persist.js): the shown swipe's copy in `swipe_info` only on the last
//   carrier and on carriers with more than one swipe. When a reply gets its first record, the carrier
//   before it drops that copy, and the carrier `receiptKeep` back drops its receipts' `data`; a rebuild
//   does the same over the whole chat (so an older chat shrinks with its next save) and gives the last
//   carrier its copy back. Neither changes any state: replay reads `message.extra` only.
// * Told and untold (§4.1 step 2): a receipt is told once a carrier at or after its own lists its ID in
//   `narrated`. Untold receipts are the `narrate: true` ones that no such carrier lists, oldest first. "At
//   or after" rather than "after" so a cue committed on the head carrier while it is being re-generated
//   (a swipe) counts as told by that same carrier.
// * Replay goes block by block (`spans`: one block per stored receipt, one for a Re-read's story changes):
//   a block that no longer applies (a middle reply deleted, a hand-edited chat) is skipped and reported
//   alone; its receipts' revs still count. Everything stored before and after it still applies, so a
//   command committed onto such a carrier survives the next rebuild, and so does its claim.
// * Guarded blocks (docs/v2/REPLAY.md, contract §6): a block a module attached a guard to (ctx.replayGuard)
//   has a span with more than `{ n, story }`: its id, module, source, guard, claims, boundaries, operation,
//   recorded inputs, result and replan. On replay such a block is applied only when its source still
//   matches its carrier, its claims are the ones its ops make and the owner's `hooks.replayGuard` says
//   yes on the state before it; then its ops and its claims go in together, else neither (it stays stored
//   and inactive, REPLAY_PREREQUISITE). A span without an `id` is a legacy block and replays as before.
// * Proof (docs/v2/EVIDENCE.md, contract §6): a block that gives proof keeps it on its span (`evidence`) and pins
//   it in `meta.proofs` with the same ops; the span must hold exactly the proof its ops pin, or it is not
//   applied. `store.proofs()` lists the stored proof of the chat in source order; which of it is active is what
//   the state pins (evidence.js), so a skipped block, a deleted reply or another swipe publishes nothing.
// * The carrier source map (`record.source`, contract §4): each record carries the canonical pair of its
//   logical message and swipe, worked out from its stored `sid` and persisted with it.
// * Every state handed out is deep-frozen. The head and the checkpoints are cached; the cache is checked
//   against the chat on each read, and `rebuild()` drops it.

import { apply as applyOps } from './ops.js';
import {
    KEY, RECEIPT_KEEP, carryRecord, createSaver, dropCopy, isCarrier, lastCarrier, newRecordId,
    readRecord, swipeOf, writeRecord,
} from './persist.js';
import { hashJson, isMetaSpan, replayInputsOf } from './replay.js';
import { CHECKPOINT_EVERY, CHECKPOINT_BYTES, isObject } from './store/constants.js';
import { hasMeta, payloadHashOf } from './store/digest.js';
import { createTombs } from './store/tombs.js';
import { createSources } from './store/sources.js';
import { createGuards } from './store/guards.js';
import { createWalk } from './store/walk.js';
import { createReplayBlocks } from './store/replay-blocks.js';
import { createMemo } from './store/memo.js';
import { createRead } from './store/read.js';
import { createWrite } from './store/write.js';
export { CHECKPOINT_EVERY, CHECKPOINT_BYTES, CHECKPOINT_MIN_GAP, NO_LONGER_DONE, deepFreeze } from './store/constants.js';

/**
 * @param {object} options
 * @param {() => object[]} options.chat     the live chat array (SillyTavern's `chat`)
 * @param {(target, options) => Promise<void>} options.save  saves the open chat; it must start writing
 *     before it returns (see createSaver). `target` = { chatId, place, carrier } of the newest change.
 * @param {() => string} [options.chatId]    the open chat's ID (SillyTavern's getCurrentChatId)
 * @param {() => *} [options.place]          where the open chat is saved (kept in a change's target for rescue)
 * @param {(target, entries) => Promise<void>} [options.rescue]  writes changes made in a chat that is no
 *     longer open into that chat's file; `entries` = [{ message, index }] of the messages written
 * @param {{ holds, fresh, restore, forget }} [options.confirm]  after a write timed out: reads the stamped
 *     file back, so a late write of the timed-out one is found and put right (persist.js createSaver)
 * @param {{ get(chatId), set(chatId, value) }} [options.memo]  keeps a suspect chat's read-backs over a reload
 * @param {() => number} [options.now]       accepted for the §12 interface; the store keeps no clock
 * @param {(state, ops) => object} [options.apply]  defaults to ops.js; tests inject a fake
 * @param {(error) => void} [options.onSaveError]   told when a scheduled (not flushed) save fails, once until one works
 * @param {object} [options.timers]          { setTimeout, clearTimeout } for tests
 * @param {number} [options.checkpointEvery] / [options.checkpointBytes]  thresholds (default 100 / 128 KB)
 * @param {number} [options.receiptKeep]     carriers back (the head is 0) from which receipts drop `data` (200)
 * @param {() => string} [options.recordId]  ID of a new carrier record
 * @param {(state, domains: string[]) => string[]} [options.validate]  the domains' validators, run on a
 *   state whose counts were moved by a replay (ops.js rebaseOps), and on every replayed block's touched
 *   domains; a problem the block brings skips that block
 * @param {(domain: string) => string[]} [options.scratch]  a domain's per-reply scratch fields (ops.js)
 * @param {() => object|null} [options.metadata]  the open chat's metadata, saved with the chat: the archive of deleted
 *   source-map ids lives in `storySuite.sourceArchive` (without it the archive is kept in memory only)
 *
 * `attachGuard(check, mark?)` (the command bus calls it): `check(state, { guard, source, block, operation,
 * recorded })` → `{ ok: true } | { ok: false, reason }` is how a guarded block is asked on replay (a throw or any
 * other answer fails closed); `mark()` → text that changes when the answer could (a module registered).
 */
export function createStore({
    chat, save, now = null, apply = applyOps, onSaveError = null, timers = globalThis,
    checkpointEvery = CHECKPOINT_EVERY, checkpointBytes = CHECKPOINT_BYTES, recordId = newRecordId, validate = null,
    chatId = () => undefined, place = () => null, rescue = null, scratch = null, receiptKeep = RECEIPT_KEEP,
    confirm = null, memo = null, metadata = () => null, marked = () => false, replayEnv = () => '',
} = {}) {
    if (typeof chat !== 'function') throw new TypeError('createStore needs a chat() function.');
    if (typeof apply !== 'function') throw new TypeError('createStore needs an apply(state, ops) function.');
    void now;
    // The store's state: one object, so the parts of the store can share it (`s.name`).
    const s = {
        frozenCheckpoints: new WeakMap(),
        checkpointBytesOf: new WeakMap(),
        cache: null,  // { key, state, problems }
        lastWrite: null,  // { message, swipe, sid, rev } of the last record written, for save verification
        holding: 0,  // inside batch(): swipe_info copies wait until it ends
        held: new Set(),
        known: null,  // the carriers (message objects) the last good head was built from
        writes: 0,
        unsaved: new Map(),  // message → { index, chatId, n }: records written since their chat was saved
        reserved: new WeakMap(),  // message → { swipe, sid }: a record ID handed out before the record
        epoch: 0,
        lineMemo: null,  // { epoch, key, receipts?, untold? }
        atMemo: new Map(),  // index → { arr, epoch, from, refs: [message, record, swipe, mes][], state }
        witnessGen: null,  // the generation of timeline witnesses kept now (see witnessGeneration)
        counts: { replays: 0, recordsRead: 0, lineScans: 0, witnessMisses: 0 },
        guardCheck: null,
        guardMark: null,
        guardSeen: false,  // a guarded block was replayed or written: the mark is looked at on each read
        applying: null,  // while the head is replayed: { list, index }, where the proof of each block that applies is put
        walkProofs: null,  // while a Re-read or a reconcile plans blocks: Map id → { proof, block } of what it has planned
        lastMark: '',
        replanFrom: Infinity,  // the first carrier seen holding a guarded step with a replan, or revs to number on (none: nothing to reconcile)
        fallback: null,  // the initial state ensureInitial was given, frozen
        noted: null,  // the kept-aside start the reader was last told about
        tombs: new Set(),
        tombMeta: undefined,  // the metadata object the set was read from
        idIndex: null,  // { arr, chat, swipeKeys: Map<sw_ id, stored sid>, evidences: Map<ev_ id, stored sid>, logicals: Map<sr_ id, Set<message>> }
        bodies: new WeakMap(),
        links: new WeakMap(),
        staged: null,  // index → the record a Re-read / reconcile has worked out and not stored yet: prefix hashes follow it
        tail: null,  // { arr, upTo, length, hash }
        spineDigests: new WeakMap(),
        spineLinks: new WeakMap(),
        guardFaults: null,
        receiptCopies: new WeakMap(),
        witnessScoped: null,  // { gen, epoch }
    };
    // Guarded replay (REPLAY.md): how a block's guard is asked, and the mark that says the answer may differ.
    // A first record that is a future version's or damaged is never written over (REPLAY.md "Preserved
    // records"): while the chat has no other state, the head is this empty state, read-only.

    // Every record goes through here, so a save can be checked against the last one written, and a change
    // left in a chat that is no longer open can be found again (rescue).
    function write(message, record) {
        const there = message.extra?.[KEY];
        const kind = rawKind(there);
        if (KEPT_ASIDE.has(kind)) throw new Error(`The story record on this reply ${WHY[kind](there)}; it is kept as it is and not written over.`);
        s.epoch++;
        if (s.holding) s.held.add(message);
        const keep = keeps(message);
        if (s.tail && s.tail.arr[s.tail.upTo] !== message) s.tail = null;      // a reply before the head changed
        const given = withSource(message, record);
        if (isObject(given.source)) noteIds(idsOf(list()), message, given.source, given.sid);
        if (Array.isArray(given.spans)) for (const span of given.spans) if (isMetaSpan(span)) idsOf(list()).blocks.add(span.id);
        const stored = writeRecord(message, given, { mirror: !s.holding && keep });
        if (!keep) dropCopy(message);
        s.lastWrite = { message, swipe: stored.swipe, sid: stored.sid, rev: stored.rev };
        s.unsaved.set(message, { index: list().indexOf(message), chatId: chatId(), n: ++s.writes });
        return stored;
    }

    function forget(id, upTo) {
        for (const [message, entry] of s.unsaved) if (entry.chatId === id && entry.n <= upTo) s.unsaved.delete(message);
    }

    // B-b2-timeline-1: the chat a change belongs to, taken when it is made, and checked right before the
    // save starts. SillyTavern opens another chat by emptying this same array, then setting the new
    // chat's name, then reading it from the server: a save in between would write the wrong chat.
    function target() {
        const arr = list();
        return { chatId: chatId(), place: place(), carrier: arr[lastCarrier(arr)] ?? null };
    }
    function check(change) {
        const arr = list();
        if (chatId() !== change.chatId) return { moved: 'another chat is open' };
        if (!arr.length) return { wait: 'a chat is being opened' };
        if (change.carrier && !arr.includes(change.carrier)) {
            let left = false;
            for (const [message, entry] of s.unsaved) {
                if (entry.chatId !== change.chatId) continue;
                if (arr.includes(message)) left = true;
                // The same chat read again (a reload, or opened again before the save): the change goes
                // onto the same message as read back, when it still is that message.
                else if (carryRecord(message, arr[entry.index])) {
                    s.unsaved.delete(message);
                    s.unsaved.set(arr[entry.index], { ...entry, n: ++s.writes });
                    s.cache = null;
                    forgetMemos();
                    left = true;
                }
            }
            return left ? '' : { gone: 'the reply that held the change is no longer in the chat' };
        }
        return '';
    }

    // SPEC §3.3: after a save, the carrier last written must still hold the rev it was given. If
    // something replaced it while the save ran, the save counts as failed (the story stays marked
    // unsaved and the reader is told); the next save writes the chat as it is then.
    const verify = {
        before: () => s.lastWrite,
        after(token) {
            if (!token) return '';
            const arr = list();
            const index = arr.indexOf(token.message);
            if (index < 0) return '';   // deleted, or another chat: nothing of this one to check
            const message = token.message;
            const extra = swipeOf(message) === token.swipe ? message.extra : message.swipe_info?.[token.swipe]?.extra;
            let rev = extra?.[KEY]?.rev;
            // C1-2: an earlier swipe deleted since moved the record to another index (restamp): it is
            // found by its record ID, shown or in its swipe's copy.
            if (rev !== token.rev && typeof token.sid === 'string' && extra?.[KEY]?.sid !== token.sid) {
                const held = [message.extra, ...(Array.isArray(message.swipe_info) ? message.swipe_info.map(info => info?.extra) : [])]
                    .map(where => where?.[KEY]).filter(record => isObject(record) && record.sid === token.sid);
                if (held.some(record => record.rev === token.rev)) return '';
                if (held.length) rev = held[0].rev;
            }
            if (rev === token.rev) return '';
            if (s.lastWrite === token) s.lastWrite = null;
            return `The story was saved, but message ${index} no longer holds its latest changes (change ${rev ?? 'none'} instead of ${token.rev ?? 'none'}); the story stays marked unsaved.`;
        },
    };
    const saver = createSaver({
        save: (change, options) => {
            const upTo = s.writes;
            return Promise.resolve(save(change, options)).then(result => {
                forget(change ? change.chatId : chatId(), upTo);
                return result;
            });
        },
        rescue: typeof rescue === 'function' ? (change, options = {}) => {
            const entries = [...s.unsaved].filter(([, entry]) => entry.chatId === change.chatId)
                .map(([message, entry]) => ({ message, index: entry.index }));
            return Promise.resolve(rescue(change, entries, options)).then(result => {
                forget(change.chatId, Infinity);
                return result;
            });
        } : null,
        target, check, onError: onSaveError, timers, verify, confirm, memo,
    });

    const list = () => {
        const arr = chat();
        return Array.isArray(arr) ? arr : [];
    };

    // The parts of the store that moved to src/v2/store/ (each is given the state holder `s` and the store functions it calls).
    const { rawKind, KEPT_ASIDE, WHY, preservedAt, readOnlyMessage, keptNow, writable, archive, bury2, idsOf, noteIds } = createTombs(s, { chatId, metadata, current: (...args) => current(...args), list });
    const { sourceFor, withSource, reservedSid, occurrenceFor, carrierSid, sourceAt, allocateOccurrence } = createSources(s, { recordId, list, archive, idsOf });
    const { markNow, seeGuards, faultsNow, blocksBefore, replayLegacy, guardHolds, blockIntact, replayGuarded, attachGuard } = createGuards(s, { chatId, metadata, list, step: (...args) => step(...args), forgetMemos: (...args) => forgetMemos(...args) });

    // (`step` is given to the guards as a wrapper that looks it up when it runs: it comes from createWalk, wired below, which needs the guards' functions.)

    // The one classifier every path uses (replay, Re-read, reconcile, rewind): a block is guarded when the host marked it
    // so: its span has an id, or its receipt carries the host's `guarded` mark (a receipt's data.v2 is the module's own
    // and never makes a block guarded). Whatever is left of its metadata, a guarded block is never taken for a legacy one.
    // `receipts`: one receipt or all those the block stands for (a block whose span is gone may stand for several: every one counts).
    const isGuardedBlock = (span, receipts) => isMetaSpan(span) || [receipts].flat().some(receipt => receipt?.guarded === true);

    // QUARANTINE, decided once per record, here, before anything runs: a guarded receipt that names none of its record's
    // changes (an older build renumbered the changes apart from it) means what it guarded cannot be told, so the record
    // applies nothing at all (every block, whether its span survived or not, stays stored and inactive), is never planned
    // again and is never cut down by a rewind. Replay, Re-read, reconcile and truncate (so rewind) all ask this.
    const quarantined = record => {
        const revs = new Set(record.ops.filter(op => op?.path === '/meta/rev').map(op => op.value));
        return record.receipts.some(receipt => receipt?.guarded === true && !revs.has(receipt.rev));
    };
    const ORPHAN = 'a guarded receipt of this reply names none of its stored changes, so what it guarded cannot be told';

    // The receipts whose changes are in `ops` (each receipt's ops end with its `/meta/rev` op), in the record's order.
    const receiptsFor = (record, ops) => {
        const revs = new Set(ops.filter(op => op?.path === '/meta/rev' && Number.isInteger(op.value)).map(op => op.value));
        return record.receipts.filter(receipt => revs.has(receipt?.rev));
    };

    // What a record holds, as a hash: its swipe key and each block's id and ops. Records are never changed in
    // place (each write puts a new one), so it is worked out once per record.
    function bodyDigest(record) {
        let digest = s.bodies.get(record);
        if (!digest) {
            s.bodies.set(record, digest = hashJson({
                k: record.source?.swipeKey ?? record.sid ?? null,
                // (a guarded block by all of its metadata: guard, recorded inputs, evidence, claims, boundaries, result)
                b: blockParts(record).map(({ ops, span }) => [isMetaSpan(span) ? hashJson(span) : null, hashJson(ops)]),
            }));
        }
        return digest;
    }

    // The hash of everything on the carriers before `upTo` (block contents, swipe keys and, for carriers with
    // guarded blocks, their text), chained from the first; each link is kept per record while its input stays.
    // The hash before the head reply, kept for the next guarded block on it: valid while nothing but that reply is written
    // (write() drops it), the chat is the same array of the same length, and nothing is staged.
    function chainHash(arr, upTo) {
        if (!s.staged && s.tail && s.tail.arr === arr && s.tail.upTo === upTo && s.tail.length === arr.length) return s.tail.hash;
        const hash = chainHashUncached(arr, upTo);
        if (!s.staged) s.tail = { arr, upTo, length: arr.length, hash };
        return hash;
    }
    function chainHashUncached(arr, upTo) {
        let hash = '';
        for (let i = 0; i < upTo && i < arr.length; i++) {
            if (!isCarrier(arr[i])) continue;
            const record = s.staged?.get(i) ?? readRecord(arr[i]);
            if (!record) continue;
            const text = hasMeta(record) ? payloadHashOf(arr[i]) : null;
            const hit = s.links.get(record);
            if (hit && hit.prev === hash && hit.text === text) {
                hash = hit.out;
                continue;
            }
            const out = hashJson({ p: hash, d: bodyDigest(record), t: text });
            s.links.set(record, { prev: hash, text, out });
            hash = out;
        }
        return hash;
    }

    // The exact prefix a checkpoint was made over (the gate of trust, REPLAY.md "Checkpoints and covers"): a hash chained over
    // every record before it as it is shown now, from the first: all of replay.js replayInputsOf (everything replay reads
    // from a record), the text of records that hold guarded blocks, and the first record's own starting point. Each link is kept per record while its input stays, so a read costs a lookup
    // per record and a change costs the records from it on.
    function spineDigest(record) {
        let digest = s.spineDigests.get(record);
        if (!digest) s.spineDigests.set(record, digest = hashJson(replayInputsOf(record)));
        return digest;
    }
    function spineStep(prev, record, message, first) {
        const text = hasMeta(record) ? payloadHashOf(message) : null;
        const hit = s.spineLinks.get(record);
        if (hit && hit.prev === prev && hit.text === text && hit.first === first) return hit.out;
        const out = hashJson({ p: prev, d: spineDigest(record), t: text, c: first ? hashJson(record.checkpoint ?? null) : null });
        s.spineLinks.set(record, { prev, text, first, out });
        return out;
    }
    // The prefix hash in front of carrier `upTo`; `at(i)` gives the record to use for carrier i (a Re-read passes the ones it is
    // about to write).
    function spineBefore(arr, upTo, at = i => readRecord(arr[i])) {
        let hash = '';
        let first = true;
        for (let i = 0; i < upTo && i < arr.length; i++) {
            if (!isCarrier(arr[i])) continue;
            const record = at(i);
            if (!record) continue;
            hash = spineStep(hash, record, arr[i], first);
            first = false;
        }
        return hash;
    }

    // The identity of a checkpoint's window (chain): the records it covers, with the swipe keys, block
    // contents and text of the ones that hold guarded blocks. undefined when none does (nothing to add to
    // `covers`). `at(i)` gives the record to use for carrier i (a Re-read passes the ones it is about to write).
    function windowHash(arr, members, at = i => readRecord(arr[i])) {
        let guarded = false;
        const entries = members.map(i => {
            const record = at(i);
            if (!hasMeta(record)) return record?.sid ?? null;
            guarded = true;
            return { s: record.sid, k: record.source?.swipeKey ?? null, p: payloadHashOf(arr[i]), d: bodyDigest(record) };
        });
        return guarded ? hashJson(entries) : undefined;
    }

    const arr0 = index => list()[index];

    const intactReason = (record, ops, span, receipt) => {
        try { blockIntact(record, ops, span, receipt); return null; } catch (error) { return error.message; }
    };

    // The walk and replay parts (store/walk.js, store/replay-blocks.js) call each other: createWalk is given the replay functions it
    // calls as wrappers that look them up when they run, because createReplayBlocks is wired right after it and is given the real ones.
    const { stamp, advanced, walkSuffix, keeps, settleAll, settleBehind, checkpointState, step, chain, problemText, rawSidAt, packProblems, unpackProblems } = createWalk(s, {
        apply, receiptKeep, scratch, validate, list, current: (...args) => current(...args), blocksBefore, markNow, seeGuards, chainHash, spineBefore, spineStep, windowHash,
        replay: (...args) => replay(...args), replayBlocks: (...args) => replayBlocks(...args), appliedOf: (...args) => appliedOf(...args),
        proofBefore: (...args) => proofBefore(...args), packOwners: (...args) => packOwners(...args), listProofs: (...args) => listProofs(...args),
    });
    const { replay, replayRecord, replayBlocks, rerunBlock, skipped, headKey, stillHolds, proofsBefore, proofBefore, packOwners, listProofs, appliedOf } = createReplayBlocks(s, {
        ORPHAN, quarantined, receiptsFor, isGuardedBlock, arr0, intactReason, ownedAlready, publish, asOps: (...args) => asOps(...args), blockParts: (...args) => blockParts(...args),
        receiptsOf: (...args) => receiptsOf(...args), lineOf: (...args) => lineOf(...args), current: (...args) => current(...args), list,
        guardHolds, occurrenceFor, withSource, replayGuarded, replayLegacy, advanced, chain, checkpointState, problemText, stamp, step, unpackProblems,
    });

    // What a story line is, apart from where it stands in the reply: the command and the line as written.

    // The span of a guarded block about to be stored on carrier `index` as `record` (which has its source),
    // after the blocks `earlier` ([{ ops, span }]) and `offset` ops: the host stamps the id (kept when the
    // block is planned again), the source, the claims its ops make and the boundary it starts at. `block` is
    // what the bus handed over: { module, source, guard, operation, recorded, result, id? }.
    // The proof of a block that has applied, for the guards asked on the rest of a Re-read or a reconcile (walkProofs). Called only
    // after the block applied: a block that was refused or collided publishes nothing.
    // The first of `evidence`'s proofs whose id a block that has applied already owns in `state`, else undefined. A block planned again that
    // would give such an id is refused before it applies and before it publishes: replacing a block's own ids never exempts another owner.
    function ownedAlready(state, evidence) {
        const pins = state?.meta?.proofs;
        return isObject(pins) && Array.isArray(evidence) ? evidence.find(proof => Object.hasOwn(pins, proof?.id)) : undefined;
    }

    function publish(span, at = s.applying?.index) {
        if (s.walkProofs && isMetaSpan(span) && Array.isArray(span.evidence)) for (const proof of span.evidence) s.walkProofs.set(proof.id, Object.freeze({ proof, block: span.id, index: at }));
    }



    const sameKey = (a, b) => Object.keys(a).every(name => a[name] === b[name]);


    // The memo and read parts (store/memo.js, store/read.js). The parts wired before them call the memo functions through wrappers
    // that look them up when they run (`current`, `forgetMemos`, `asOps`, `blockParts`, `receiptsOf`, `lineOf`), because createMemo needs their
    // results and is wired after them, where `sameKey` exists. `api` is only used for `api.sourceAt(...)`, which is looked up when it runs.
    const { current, retain, carrierAt, memoAt, frozenReceipts, forgetMemos, witnessKeyOf, markSeen, witnessGeneration, lineOf, baseFor, stateBefore, take, sidFor, carriedTo, spansOf, spansFor, blockParts, receiptsOf, asOps, prefixWitnessUncached } = createMemo(s, {
        KEPT_ASIDE, WHY, api: { sourceAt: (...args) => api.sourceAt(...args) }, appliedOf, archive, blocksBefore, chain, chainHash, chatId, checkpointBytes,
        checkpointEvery, checkpointState, headKey, list, markNow, marked, metadata, packOwners, packProblems, preservedAt, proofBefore, proofsBefore,
        rawKind, rawSidAt, recordId, replay, replayEnv, replayRecord, sameKey, settleBehind, sourceFor, spineBefore, stillHolds, windowHash,
    });
    const { head, at, headIndex, opsAt, changesAt, problems, readOnly, startOver, keepEarliest, ensureInitial, proofs, blockAt, replansFrom, boundaryProblems, payloadHashAt, boundary, timelineMarkers, prefixWitness, witnessScope, witnessMemoSize, witnessFresh } = createRead(s, {
        api: { sourceAt: (...args) => api.sourceAt(...args) }, blockParts, blocksBefore, carriedTo, chainHash, current, faultsNow, forgetMemos, idsOf, keptNow,
        list, listProofs, markSeen, memoAt, prefixWitnessUncached, preservedAt, rawKind, readOnlyMessage, reservedSid, saver, sidFor, sourceFor, spansFor,
        witnessGeneration, witnessKeyOf, write,
    });
    // The write part (store/write.js): the methods of `api` that change the chat's records. Wired last, after every part and function it
    // calls; nothing here is looked up before it runs.
    const { touch, lifecycleChanged, append, before, replaceStory, reconcile, setNarrated, setPracticeRule, receipts, truncate, untold, work, rebuild, archived, archiveList, batch, renamed, saveIdle, saveLate, idleSaves } = createWrite(s, {
        advanced, archive, asOps, baseFor, blockParts, bury2, carrierAt, current, forgetMemos, frozenReceipts, guardHolds, headKey, idsOf,
        intactReason, isGuardedBlock, keeps, lineOf, list, marked, markNow, ORPHAN, ownedAlready, place, publish, quarantined, receiptsFor,
        receiptsOf, replay, replayGuarded, replayLegacy, replayRecord, rerunBlock, rescue, retain, sameKey, saver, settleAll, skipped,
        spansFor, spansOf, stamp, stateBefore, step, take, walkSuffix, withSource, writable, write,
    });

    const api = {
        // head, at, headIndex, opsAt, changesAt, problems, readOnly, startOver, keepEarliest, ensureInitial: store/read.js
        head, at, headIndex, opsAt, changesAt, problems, readOnly, startOver, keepEarliest, ensureInitial,

        // carrierSid, sourceAt and allocateOccurrence: store/sources.js
        carrierSid, sourceAt, allocateOccurrence,

        // proofs, blockAt, replansFrom, boundaryProblems, payloadHashAt, boundary, timelineMarkers, prefixWitness, witnessScope, witnessMemoSize, witnessFresh: store/read.js
        proofs, blockAt, replansFrom, boundaryProblems, payloadHashAt, boundary, timelineMarkers, prefixWitness, witnessScope, witnessMemoSize, witnessFresh,

        // touch, lifecycleChanged: store/write.js
        touch, lifecycleChanged,

        // attachGuard: store/guards.js
        attachGuard,

        // append, before, replaceStory, reconcile, setNarrated, setPracticeRule, receipts, truncate, untold, work, rebuild, archived, archiveList, batch, renamed: store/write.js
        append, before, replaceStory, reconcile, setNarrated, setPracticeRule, receipts, truncate, untold, work, rebuild, archived, archiveList, batch, renamed,

        scheduleSave(ms = 400) { saver.schedule(ms); },
        /**
         * Puts off a save that was only scheduled (not one already running): the turn's cues before a reply
         * are saved with the reply's own save, one write of the chat file instead of two. The change stays
         * dirty; the caller saves it (or schedules it again) when the reply comes or the generation ends.
         */
        deferSave() { saver.defer(); },
        // saveIdle, saveLate, idleSaves: store/write.js
        saveIdle, saveLate, idleSaves,
        /** Saves now (a reader's action is saved at once); → Promise<true | false>, never throws: a failure is told and tried again. */
        saveSoon(options) { return saver.saveSoon(options); },
        /** The page is closing: the newest state goes out at once, even past a save still on its way. */
        saveUrgent(options) { return saver.urgent(options); },
        /** True while a save of the open chat is on its way. */
        inFlight() { return saver.inFlight(); },
        /** True while a timed-out write's file is still to be read back. */
        suspect() { return saver.suspect(); },
        /** A chat was opened: read-backs a reload of the page left for it go on (persist.js createSaver.resume). */
        resume() { return saver.resume(target()); },
        flush() { return saver.flush(); },
        dirty() { return saver.dirty(); },
        /** True while saves are failing (until one works again). */
        failing() { return saver.failing(); },
    };
    // A Re-read and a reconcile plan blocks that are stored only when they are all planned: for their length the proof
    // those blocks give is laid over the stored (store.proofs), so a step planned again, and the guards asked on the
    // way, see the proof of the blocks planned before it and not the old bytes of the blocks they replace.
    for (const name of ['replaceStory', 'reconcile']) {
        const inner = api[name];
        api[name] = (...args) => {
            const outer = s.walkProofs;
            s.walkProofs = new Map();
            try { return inner.apply(api, args); } finally { s.walkProofs = outer; }
        };
    }
    return api;
}
