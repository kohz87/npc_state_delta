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

import { apply as applyOps, rebaseOps } from './ops.js';
import {
    KEY, RECEIPT_KEEP, carrierIndexes, carryRecord, createSaver, dropCopy, isCarrier, keepsCopy, lastCarrier,
    newRecordId, payloadText, readRecord, recordFault, restamp, restoreCopy, swipeOf, trimReceipts, writeRecord,
} from './persist.js';
import { blockIdOf, claimKeys, deriveId, hashJson, isMetaSpan, isRecordId, replayInputsOf, spanProblem } from './replay.js';
import { clockWriteProblem, markerProblem, markerPrefixProblem } from './timeline/boundary.js';
import { allocator, evidenceDigest, evidenceProblem, merged, occurrenceOf, opShapeProblem, operationKey, pinOps, reachesBranch, recordEntries, spanOperationKey, takenAfter, touchesProof } from './evidence.js';
import { HOST_DOMAIN, gateProblem } from './timeline/gate.js';

export const CHECKPOINT_EVERY = 100;
export const CHECKPOINT_BYTES = 128 * 1024;
// The bytes rule never puts checkpoints closer than this many carriers, and waits for at least twice
// the last checkpoint's own size of ops: one domain that rewrites a large list whole on every reply
// cannot make every few replies write the whole state again (b6-soak).
export const CHECKPOINT_MIN_GAP = 10;
/** The code an owner's replan answers with when the step is no longer done (REPLAY.md): only this removes a block. */
export const NO_LONGER_DONE = 'NO_LONGER_DONE';

// The host's savepoints domain (timeline/gate.js): written only by the host's own blocks (module story-block, operation savepoint.*).
// A write reaches it when its path or `from` is the domain, anything below it, or anything that holds it (/domains, the root): any op.
const HOST_BRANCH = ['domains', HOST_DOMAIN];
const touchesHostDomain = op => !op || typeof op !== 'object' || reachesBranch(op.path, HOST_BRANCH) || reachesBranch(op.from, HOST_BRANCH);
const hostBlock = (module, type) => module === 'story-block' && typeof type === 'string' && type.startsWith('savepoint.');

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const utf8 = new TextEncoder();
const jsonBytes = value => utf8.encode(JSON.stringify(value)).length;

export function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const item of Object.values(value)) deepFreeze(item);
    }
    return value;
}

const revOf = state => (Number.isInteger(state?.meta?.rev) ? state.meta.rev : 0);

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
    confirm = null, memo = null, metadata = () => null,
} = {}) {
    if (typeof chat !== 'function') throw new TypeError('createStore needs a chat() function.');
    if (typeof apply !== 'function') throw new TypeError('createStore needs an apply(state, ops) function.');
    void now;
    let frozenCheckpoints = new WeakMap();
    const checkpointBytesOf = new WeakMap();
    let cache = null;          // { key, state, problems }
    let lastWrite = null;      // { message, swipe, sid, rev } of the last record written, for save verification
    let holding = 0;           // inside batch(): swipe_info copies wait until it ends
    const held = new Set();
    let known = null;          // the carriers (message objects) the last good head was built from
    let writes = 0;
    const unsaved = new Map(); // message → { index, chatId, n }: records written since their chat was saved
    const reserved = new WeakMap();   // message → { swipe, sid }: a record ID handed out before the record
    // Memos of what a reply reads over the whole chat (docs/v2/PERFORMANCE.md, "Long chats"): the stored
    // receipts and the untold ones, each kept until a record is written or the store rebuilds (`epoch`) or
    // the chat's last carrier, length or array changes (headKey); the state at an earlier carrier, kept
    // while the messages it was replayed from are the same objects with the same records and text.
    let epoch = 0;
    let lineMemo = null;       // { epoch, key, receipts?, untold? }
    let atMemo = new Map();    // index → { arr, epoch, from, refs: [message, record, swipe, mes][], state }
    const AT_MEMO_MAX = 64;
    const counts = { replays: 0, recordsRead: 0, lineScans: 0 };
    // Guarded replay (REPLAY.md): how a block's guard is asked, and the mark that says the answer may differ.
    let guardCheck = null;
    let guardMark = null;
    let guardSeen = false;     // a guarded block was replayed or written: the mark is looked at on each read
    let applying = null;       // while the head is replayed: { list, index }, where the proof of each block that applies is put
    let walkProofs = null;     // while a Re-read or a reconcile plans blocks: Map id → { proof, block } of what it has planned
    let lastMark = '';
    let replanFrom = Infinity; // the first carrier seen holding a guarded step with a replan, or revs to number on (none: nothing to reconcile)
    // A first record that is a future version's or damaged is never written over (REPLAY.md "Preserved
    // records"): while the chat has no other state, the head is this empty state, read-only.
    let fallback = null;       // the initial state ensureInitial was given, frozen
    let noted = null;          // the kept-aside start the reader was last told about

    // Every record goes through here, so a save can be checked against the last one written, and a change
    // left in a chat that is no longer open can be found again (rescue).
    function write(message, record) {
        const there = message.extra?.[KEY];
        const kind = rawKind(there);
        if (KEPT_ASIDE.has(kind)) throw new Error(`The story record on this reply ${WHY[kind](there)}; it is kept as it is and not written over.`);
        epoch++;
        if (holding) held.add(message);
        const keep = keeps(message);
        if (tail && tail.arr[tail.upTo] !== message) tail = null;      // a reply before the head changed
        const given = withSource(message, record);
        if (isObject(given.source)) noteIds(idsOf(list()), message, given.source, given.sid);
        if (Array.isArray(given.spans)) for (const span of given.spans) if (isMetaSpan(span)) idsOf(list()).blocks.add(span.id);
        const stored = writeRecord(message, given, { mirror: !holding && keep });
        if (!keep) dropCopy(message);
        lastWrite = { message, swipe: stored.swipe, sid: stored.sid, rev: stored.rev };
        unsaved.set(message, { index: list().indexOf(message), chatId: chatId(), n: ++writes });
        return stored;
    }

    function forget(id, upTo) {
        for (const [message, entry] of unsaved) if (entry.chatId === id && entry.n <= upTo) unsaved.delete(message);
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
            for (const [message, entry] of unsaved) {
                if (entry.chatId !== change.chatId) continue;
                if (arr.includes(message)) left = true;
                // The same chat read again (a reload, or opened again before the save): the change goes
                // onto the same message as read back, when it still is that message.
                else if (carryRecord(message, arr[entry.index])) {
                    unsaved.delete(message);
                    unsaved.set(arr[entry.index], { ...entry, n: ++writes });
                    cache = null;
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
        before: () => lastWrite,
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
            if (lastWrite === token) lastWrite = null;
            return `The story was saved, but message ${index} no longer holds its latest changes (change ${rev ?? 'none'} instead of ${token.rev ?? 'none'}); the story stays marked unsaved.`;
        },
    };
    const saver = createSaver({
        save: (change, options) => {
            const upTo = writes;
            return Promise.resolve(save(change, options)).then(result => {
                forget(change ? change.chatId : chatId(), upTo);
                return result;
            });
        },
        rescue: typeof rescue === 'function' ? (change, options = {}) => {
            const entries = [...unsaved].filter(([, entry]) => entry.chatId === change.chatId)
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

    // ---- records that are kept as they are -------------------------------------------------------------

    // What a stored `storySuite` value is: 'absent', 'ours' (a whole v2 record), or one Story Block must never write over:
    // 'future' (a newer version's), 'legacy' (v1 or no version) and 'damaged' (a v2 record that is not whole, or not a record).
    function rawKind(raw) {
        if (raw === undefined || raw === null) return 'absent';
        if (!isObject(raw)) return 'damaged';
        if (Number.isFinite(raw.v) && raw.v > 2) return 'future';
        if (raw.v === 2) return recordFault({ extra: { [KEY]: raw } }) ? 'damaged' : 'ours';
        return 'legacy';
    }
    const KEPT_ASIDE = new Set(['future', 'legacy', 'damaged']);
    const WHY = {
        future: raw => `is from a newer version (v${raw.v})`,
        legacy: () => 'is from an older version of Story Suite',
        damaged: raw => `is damaged (${isObject(raw) ? recordFault({ extra: { [KEY]: raw } }) || 'it is not a record' : 'it is not a record'})`,
    };

    // The chat's first record when it is one Story Block does not own (a future version's, an older one's, a damaged
    // one): it is neither read nor repaired nor written over. With `stateless` (the chat has no state at all) also an
    // unresolved start: the replies before the earliest checkpoint that is left are gone and this session never saw
    // them, so that checkpoint cannot be checked; it is kept as it is and nothing is adopted or reset by itself.
    // → { index, kind, why, raw? } or null.
    function preservedAt(arr, stateless = false) {
        const first = carrierIndexes(arr)[0];
        if (first === undefined) return null;
        const raw = arr[first].extra?.[KEY];
        const kind = rawKind(raw);
        if (KEPT_ASIDE.has(kind)) return { index: first, kind, why: WHY[kind](raw), raw };
        if (stateless) {
            const at = carrierIndexes(arr).find(i => readRecord(arr[i])?.checkpoint);
            if (at !== undefined) return { index: at, kind: 'unresolved', why: `has the earliest saved point of a story whose first replies are gone (this session had not seen them)`, raw: null };
        }
        return null;
    }

    const readOnlyMessage = kept => (kept.kind === 'unresolved'
        ? `The story on message ${kept.index} ${kept.why}; Story Block keeps the saved history as it is and works read-only on an empty story until you choose what to do.`
        : `The story record on message ${kept.index} ${kept.why}; Story Block keeps it as it is and works read-only on an empty story until it can be read.${kept.kind === 'future' ? ' Update Story Block to read it.' : ''}`);

    // Every writer starts here: while the head is the read-only fallback, nothing is written.
    // Derived from the head each time (not only from the cache entry), so no cache path can lose it.
    function keptNow() {
        const head = current();
        if (head.readOnly) return head.readOnly;
        return fallback && head.state === fallback ? preservedAt(list(), true) : null;
    }
    function writable() {
        const kept = keptNow();
        if (kept) throw new Error(readOnlyMessage(kept));
    }

    // ---- the carrier source map (contract §4) ------------------------------------------------------

    // The ids the chat's records already hold, found once per chat array (and again after rebuild()) and kept up
    // to date by write(): an id that left with a deleted reply only stays "taken", which costs nothing but a salt.
    // The archive (contract §4): ids of the canonical sids, swipe keys and evidence ids of replies and swipes that were
    // deleted. They stay in the chat's metadata, are never handed out again, and confer no eligibility (archived(id)).
    let tombs = new Set();
    let tombMeta;           // the metadata object the set was read from
    function archive() {
        let meta = null;
        try { meta = metadata(); } catch { meta = null; }
        if (!isObject(meta)) meta = null;
        if (meta !== tombMeta) {
            tombMeta = meta;
            const stored = meta?.storySuite?.sourceArchive?.deleted;
            tombs = new Set(Array.isArray(stored) ? stored.filter(id => typeof id === 'string') : []);
        }
        return tombs;
    }
    function bury(ids) {
        const set = archive();
        const before = set.size;
        for (const id of ids) if (typeof id === 'string' && id) set.add(id);
        if (set.size === before) return;
        if (tombMeta) {
            if (!isObject(tombMeta.storySuite)) tombMeta.storySuite = {};
            // (Not a change to save on its own: SillyTavern saves the chat after a delete, and every later save carries it.)
            tombMeta.storySuite.sourceArchive = { v: 1, deleted: [...set].sort() };
        }
    }
    // What a rebuild finds gone since the index was last built: the ids of replies and swipes that left the chat.
    function bury2(previous, now) {
        const gone = [];
        for (const key of ['swipeKeys', 'evidences', 'logicals']) for (const id of previous[key].keys()) if (!now[key].has(id)) gone.push(id);
        bury(gone);
    }

    let idIndex = null;     // { arr, chat, swipeKeys: Map<sw_ id, stored sid>, evidences: Map<ev_ id, stored sid>, logicals: Map<sr_ id, Set<message>> }
    function idsOf(arr) {
        // (the chat array SillyTavern holds is the same object whichever chat is open: the index is for one chat's ids)
        if (idIndex?.arr === arr && idIndex.chat === chatId()) return idIndex;
        idIndex = { arr, chat: chatId(), swipeKeys: new Map(), evidences: new Map(), logicals: new Map(), blocks: new Set() };
        for (const other of arr) {
            for (const record of [other?.extra?.[KEY], ...(Array.isArray(other?.swipe_info) ? other.swipe_info.map(info => info?.extra?.[KEY]) : [])]) {
                if (isObject(record?.source)) noteIds(idIndex, other, record.source, record.sid);
                for (const span of Array.isArray(record?.spans) ? record.spans : []) if (isMetaSpan(span)) idIndex.blocks.add(span.id);
            }
        }
        return idIndex;
    }
    function noteIds(index, message, entry, sid) {
        if (entry.swipeKey) index.swipeKeys.set(entry.swipeKey, sid);
        if (entry.evidence) index.evidences.set(entry.evidence, sid);
        if (entry.logical) {
            if (!index.logicals.has(entry.logical)) index.logicals.set(entry.logical, new Set());
            index.logicals.get(entry.logical).add(message);
        }
    }

    // The canonical pair of a record: { sid: sr_, swipeKey: sw_, evidence: ev_, next }. `sid` is the logical
    // message's, shared by all its swipes (taken from a swipe that has one, else worked out from the stored
    // ID of the swipe it was copied from); `swipeKey` and `evidence` are this swipe's own, worked out from
    // its stored `sid` and moved on by a salt when another record already holds them. The stored `sid`
    // (`sw_<12 hex>`) is never changed. Persisted with the record by write().
    function sourceFor(arr, message, sid) {
        const own = message.extra?.[KEY];
        const siblings = [own, ...(Array.isArray(message.swipe_info) ? message.swipe_info.map(info => info?.extra?.[KEY]) : [])]
            .filter(record => isObject(record));
        const index = idsOf(arr);
        let logical = siblings.map(record => record.source?.logical).find(value => isRecordId(value) && value.startsWith('sr_'));
        if (!logical) {
            const anchor = typeof own?.sid === 'string' ? own.sid : siblings.find(record => typeof record.sid === 'string')?.sid ?? sid;
            // (taken: canonical sids that belong to another message)
            const elsewhere = { has: id => archive().has(id) || [...(index.logicals.get(id) ?? [])].some(holder => holder !== message) };
            logical = deriveId('sr', anchor, elsewhere);
        }
        // (a record's own earlier ids are not "taken" from it)
        const heldBy = map => ({ has: id => archive().has(id) || (map.has(id) && map.get(id) !== sid) });
        return { logical, swipeKey: deriveId('sw', sid, heldBy(index.swipeKeys)), evidence: deriveId('ev', sid, heldBy(index.evidences)), next: 0 };
    }

    // A record that has no source map entry yet (one stored before this existed) gets one when it is written.
    function withSource(message, record) {
        if (!isObject(record) || isObject(record.source) || typeof record.sid !== 'string') return record;
        return { ...record, source: sourceFor(list(), message, record.sid) };
    }

    // The Source a command run on carrier `index` stamps its block with (REPLAY.md): the canonical pair, the
    // evidence ID and the block's ordinal. `pending` = blocks of this carrier that a Re-read has planned but
    // not stored yet; `ordinal` names one outright (a block planned again keeps its own). null for a message
    // that is not a carrier. The pair is worked out from the stored ID, so it is the one the record is
    // written with (before any block that carries it is).
    function sourceOf(index, { pending = 0, ordinal = undefined } = {}) {
        const arr = list();
        const message = arr[index];
        if (!isCarrier(message)) return null;
        const record = readRecord(message);
        const sid = record ? record.sid : reservedSid(message);
        if (typeof sid !== 'string') return null;
        const entry = isObject(record?.source) ? record.source : sourceFor(arr, message, sid);
        return { sid: entry.logical, swipeKey: entry.swipeKey, evidence: entry.evidence,
            ordinal: Number.isInteger(ordinal) && ordinal >= 0 ? ordinal : (Number.isInteger(entry.next) ? entry.next : 0) + Math.max(0, pending) };
    }

    // The stored ID a first record on this message's shown swipe will get (handed out once, like carrierSid).
    function reservedSid(message) {
        const swipe = swipeOf(message);
        const kept = reserved.get(message);
        if (kept && kept.swipe === swipe) return kept.sid;
        const sid = recordId();
        reserved.set(message, { swipe, sid });
        return sid;
    }

    // The hash of the text a record's evidence is (REPLAY.md): a reply that is edited or continued has another.
    const payloadHashes = new WeakMap();    // message → { mes, hash }: worked out once per text
    function payloadHashOf(message) {
        const mes = message?.mes;
        const hit = payloadHashes.get(message);
        if (hit && hit.mes === mes) return hit.hash;
        const hash = hashJson(payloadText(message));
        if (message && typeof message === 'object') payloadHashes.set(message, { mes, hash });
        return hash;
    }

    const hasMeta = record => Array.isArray(record?.spans) && record.spans.some(isMetaSpan);

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
    const bodies = new WeakMap();
    function bodyDigest(record) {
        let digest = bodies.get(record);
        if (!digest) {
            bodies.set(record, digest = hashJson({
                k: record.source?.swipeKey ?? record.sid ?? null,
                // (a guarded block by all of its metadata: guard, recorded inputs, evidence, claims, boundaries, result)
                b: blockParts(record).map(({ ops, span }) => [isMetaSpan(span) ? hashJson(span) : null, hashJson(ops)]),
            }));
        }
        return digest;
    }

    // The hash of everything on the carriers before `upTo` (block contents, swipe keys and, for carriers with
    // guarded blocks, their text), chained from the first; each link is kept per record while its input stays.
    const links = new WeakMap();
    let staged = null;    // index → the record a Re-read / reconcile has worked out and not stored yet: prefix hashes follow it
    // The hash before the head reply, kept for the next guarded block on it: valid while nothing but that reply is written
    // (write() drops it), the chat is the same array of the same length, and nothing is staged.
    let tail = null;      // { arr, upTo, length, hash }
    function chainHash(arr, upTo) {
        if (!staged && tail && tail.arr === arr && tail.upTo === upTo && tail.length === arr.length) return tail.hash;
        const hash = chainHashUncached(arr, upTo);
        if (!staged) tail = { arr, upTo, length: arr.length, hash };
        return hash;
    }
    function chainHashUncached(arr, upTo) {
        let hash = '';
        for (let i = 0; i < upTo && i < arr.length; i++) {
            if (!isCarrier(arr[i])) continue;
            const record = staged?.get(i) ?? readRecord(arr[i]);
            if (!record) continue;
            const text = hasMeta(record) ? payloadHashOf(arr[i]) : null;
            const hit = links.get(record);
            if (hit && hit.prev === hash && hit.text === text) {
                hash = hit.out;
                continue;
            }
            const out = hashJson({ p: hash, d: bodyDigest(record), t: text });
            links.set(record, { prev: hash, text, out });
            hash = out;
        }
        return hash;
    }

    // The exact prefix a checkpoint was made over (the gate of trust, REPLAY.md "Checkpoints and covers"): a hash chained over
    // every record before it as it is shown now, from the first: all of replay.js replayInputsOf (everything replay reads
    // from a record), the text of records that hold guarded blocks, and the first record's own starting point. Each link is kept per record while its input stays, so a read costs a lookup
    // per record and a change costs the records from it on.
    const spineDigests = new WeakMap();
    function spineDigest(record) {
        let digest = spineDigests.get(record);
        if (!digest) spineDigests.set(record, digest = hashJson(replayInputsOf(record)));
        return digest;
    }
    const spineLinks = new WeakMap();
    function spineStep(prev, record, message, first) {
        const text = hasMeta(record) ? payloadHashOf(message) : null;
        const hit = spineLinks.get(record);
        if (hit && hit.prev === prev && hit.text === text && hit.first === first) return hit.out;
        const out = hashJson({ p: prev, d: spineDigest(record), t: text, c: first ? hashJson(record.checkpoint ?? null) : null });
        spineLinks.set(record, { prev, text, first, out });
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

    // ---- guarded blocks: asking the guard, stamping a block -------------------------------------------

    const prerequisite = message => Object.assign(new Error(message), { code: 'REPLAY_PREREQUISITE' });

    // What the guards could answer differently on (a module registered or went): looked at on each read once a
    // guarded block has been replayed or written here, never for a chat that has none.
    function markNow() {
        try { return typeof guardMark === 'function' ? String(guardMark()) : ''; } catch { return ''; }
    }
    function seeGuards() {
        if (guardSeen) return;
        guardSeen = true;
        lastMark = markNow();
    }

    // Rejected plans have no stored block to replay a Problem from. Keep thrown-guard diagnostics in
    // this chat only, at the one point where every guard is checked; successful checks clear that exact fault.
    let guardFaults = null;
    function faultsNow() {
        const arr = list(), id = chatId(), holder = metadata();
        if (!guardFaults || guardFaults.arr !== arr || guardFaults.id !== id || guardFaults.holder !== holder) {
            guardFaults = { arr, id, holder, entries: new Map() };
        }
        return guardFaults.entries;
    }
    const guardFaultKey = span => `${span.id}:${hashJson(span.guard)}`;
    function thrownGuard(span, message, error) {
        const kind = isObject(span.guard?.predicate) && typeof span.guard.predicate.kind === 'string' ? span.guard.predicate.kind : '<missing>';
        const why = `${span.guard.owner}'s replayGuard kind ${kind} failed (${error?.message ?? error})`;
        faultsNow().set(guardFaultKey(span), { message, source: span.source, block: span.id, why });
        return { ok: false, reason: why };
    }

    // The owner's answer for a guarded block on `state` (the state before it): { ok: true } or { ok: false,
    // reason }. Nothing to ask, a throw, a promise or any other shape fails closed.
    function askGuard(state, span, message) {
        seeGuards();
        if (typeof guardCheck !== 'function') return { ok: false, reason: 'nothing here can check its guard, so it stays off' };
        let answer;
        try {
            // `payload`: the hash of the reply's text when the block was stored, and now (REPLAY.md): an edit shows as a difference.
            const payload = { saved: span.boundaries?.[0]?.payloadHash ?? null, current: message ? payloadHashOf(message) : null };
            answer = guardCheck(state, { guard: span.guard, source: span.source, block: span.id, operation: span.operation, recorded: span.recorded ?? null, payload });
        } catch (error) {
            return thrownGuard(span, message, error);
        }
        if (answer && typeof answer.then === 'function') {
            answer.then(null, () => {});
            return { ok: false, reason: 'its guard did not answer at once' };
        }
        if (isObject(answer) && answer.ok === true) { faultsNow().delete(guardFaultKey(span)); return { ok: true }; }
        if (isObject(answer) && answer.ok === false && typeof answer.reason === 'string' && answer.reason) return { ok: false, reason: answer.reason };
        return { ok: false, reason: 'its guard gave an answer that is neither { ok: true } nor { ok: false, reason }' };
    }

    // The blocks before a guarded block, as its boundary's prefix hash has them: each one's id and changes, and the proof it
    // gave (ids, kinds, owners, payload hashes, parents). One function, so the hash stamped and the hash checked agree.
    function blocksBefore(earlier) {
        return earlier.map(part => [isMetaSpan(part.span) ? part.span.id : null, hashJson(part.ops), ...(isMetaSpan(part.span) && evidenceDigest(part.span.evidence) ? [evidenceDigest(part.span.evidence)] : [])]);
    }

    // A block with no metadata (a legacy block) never pins proof: only a guarded or proof block that holds the proof it
    // pins does (replayGuarded), so a hand-edited record cannot publish a proof by writing its pin on another block.
    function replayLegacy(state, ops) {
        const clock = clockWriteProblem(null, ops);
        if (clock) throw prerequisite(clock);
        if (ops.some(op => op && typeof op === 'object' && touchesProof(op))) throw prerequisite('it changes the record of proof pins (or the state around it), and a block with no proof of its own cannot');
        if (ops.some(touchesHostDomain)) throw prerequisite('it writes the host\'s savepoints, and only the host\'s own blocks do');
        return step(state, ops, { replayed: true });
    }

    // A guarded block is stored only if its guard holds on the state before it when replayed (the context a replay asks in:
    // the state and what it recorded). What a replay would refuse is refused here, so a state that was built live and one that
    // is built again by replay cannot disagree about it. Nothing is asked of a store with no guard check attached.
    const arr0 = index => list()[index];
    function guardHolds(state, span, message) {
        const clockPrefix = markerPrefixProblem(span, state);
        if (clockPrefix) throw prerequisite(clockPrefix);
        if (typeof guardCheck !== 'function' || !isMetaSpan(span) || !span.guard) return;
        // (the epoch and rules gate first, as a replay does: docs/v2/TIMELINE.md)
        const gate = gateProblem(state, span.guard);
        if (gate) throw new Error(`Its guard would not hold when this is replayed, so it is not stored: ${gate}`);
        const answer = askGuard(state, span, message);
        if (!answer.ok) throw new Error(`Its guard would not hold when this is replayed, so it is not stored: ${answer.reason}`);
    }

    // A guarded block on replay (and in a Re-read's kept blocks): its record must be whole, from this
    // carrier, make the claims it lists, and pass its owner's guard on `state`; then its ops (claims among
    // them) are applied together. Throws a REPLAY_PREREQUISITE error otherwise, with nothing applied.
    // What a guarded block must be on its own, whatever the state: its record whole, the guard its receipt kept the one it holds, the
    // reply and swipe it was recorded for, the claims its ops make. Throws a REPLAY_PREREQUISITE otherwise. A block that is not
    // intact is not planned again either: planning would bring back what replay keeps off.
    function blockIntact(record, ops, span, receipt) {
        const bad = spanProblem(span);
        if (bad) throw prerequisite(`its saved guard record is damaged: ${bad}`);
        // A guard the receipt kept (data.v2, set by the host) must be the one the span holds.
        if (receipt?.guarded === true && receipt.data?.v2?.guard && hashJson(receipt.data.v2.guard) !== hashJson(span.guard)) {
            throw prerequisite('the guard its receipt kept is not the one saved with the block');
        }
        const entry = record.source;
        if (!isObject(entry) || span.source.sid !== entry.logical || span.source.swipeKey !== entry.swipeKey || span.source.evidence !== entry.evidence) {
            throw prerequisite('it was recorded for another reply or swipe');
        }
        const claims = claimKeys(ops);
        if (claims.length !== span.claims.length || !claims.every(key => span.claims.includes(key))) {
            throw prerequisite('the claims it saved are not the claims its changes make');
        }
        if (ops.some(touchesHostDomain) && !hostBlock(span.module, span.operation?.type)) throw prerequisite('it writes the host\'s savepoints, and only the host\'s own blocks do');
        const clock = clockWriteProblem(span, ops);
        if (clock) throw prerequisite(clock);
        const proof = evidenceProblem(span, ops);
        if (proof) throw prerequisite(`the proof it saved is not the proof its changes pin: ${proof}`);
    }
    const intactReason = (record, ops, span, receipt) => {
        try { blockIntact(record, ops, span, receipt); return null; } catch (error) { return error.message; }
    };

    function replayGuarded(state, record, ops, span, message = null, receipt = null) {
        blockIntact(record, ops, span, receipt);
        // Some setup choices must retract even when deletion of the earliest replies carries their
        // other state forward (carriedTo replays the formerly known prefix). Never carry this choice.
        if (span.guard?.replyBound === true && message && !list().includes(message)) throw prerequisite('its reply was deleted');
        const clockPrefix = markerPrefixProblem(span, state);
        if (clockPrefix) throw prerequisite(clockPrefix);
        // A proof id belongs to the block that applied with it first: a later block that gives the same id collides and does not apply.
        const owned = state?.meta?.proofs;
        const collides = isObject(owned) ? span.evidence.find(each => Object.hasOwn(owned, each.id)) : undefined;
        if (collides !== undefined) throw prerequisite(`proof ${collides.id} already belongs to a block that applied`);
        // A claim someone else holds already (a retried settlement, a block that woke up after its twin was stored)
        // is never paid twice: the block stays off.
        const held = state?.meta?.claims;
        const taken = isObject(held) ? span.claims.find(key => Object.hasOwn(held, key)) : undefined;
        if (taken !== undefined) throw prerequisite(`claim already held (${taken})`);
        if (span.guard) {
            // The host's own check of the guard's epoch and rules hash against the timeline (docs/v2/TIMELINE.md), then the owner's.
            const gate = gateProblem(state, span.guard);
            if (gate) throw prerequisite(`its guard no longer holds: ${gate}`);
            const answer = askGuard(state, span, message);
            if (!answer.ok) throw prerequisite(`its guard no longer holds: ${answer.reason}`);
        }
        const next = step(state, span.evidence.length ? pinOps(state, ops) : ops, { replayed: true, strict: true });
        if (applying && span.evidence.length) for (const each of span.evidence) applying.list.push(Object.freeze({ proof: each, block: span.id, index: applying.index }));
        return next;
    }

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

    function publish(span, at = applying?.index) {
        if (walkProofs && isMetaSpan(span) && Array.isArray(span.evidence)) for (const proof of span.evidence) walkProofs.set(proof.id, Object.freeze({ proof, block: span.id, index: at }));
    }

    function stamp(arr, index, record, block, ops, receipt, earlier, offset) {
        const entry = record.source;
        const planned = block.source;
        if (!isObject(entry) || !isObject(planned) || planned.sid !== entry.logical || planned.swipeKey !== entry.swipeKey || planned.evidence !== entry.evidence) {
            throw new Error('The block was planned for another reply or swipe.');
        }
        const ordinal = planned.ordinal;
        // A block is named by what it is: the reply, its operation, and its occurrence among the reply's blocks of that operation (replay.js
        // blockIdOf). The occurrence is given once, when the block is first stamped, and kept in its span (evidence.js): a block planned again,
        // a Re-read of an unchanged line, a reload and an earlier block that goes all leave it as it was. A block stored before there was one
        // has the id it was stamped with, and keeps its rank among the blocks that did the same.
        let id = block.id;
        let occurrence = occurrenceOf(block);
        if (typeof id !== 'string') {
            let key = '';
            try { key = operationKey(block.operation?.type, block.operation?.payload); } catch { key = ''; }
            // (a block handed over with no number, by a caller that did not allocate one: the reply's next unused, from the same record the allocator reads)
            occurrence ??= allocator(record, other => earlier.reduce((most, part) => (occurrenceOf(part.span) !== null && spanOperationKey(part.span) === other ? Math.max(most, occurrenceOf(part.span) + 1) : most), 0)).take(key);
            id = blockIdOf({ sid: entry.logical, swipeKey: entry.swipeKey, key, rank: occurrence });
        }
        const revOp = [...ops].reverse().find(op => op?.path === '/meta/rev' && Number.isInteger(op.value));
        const message = arr[index];
        const span = {
            ...(block.clockBoundaries ? { clockBoundaries: structuredClone(block.clockBoundaries) } : {}),
            id, module: block.module, source: { sid: entry.logical, swipeKey: entry.swipeKey, evidence: entry.evidence, ordinal },
            guard: block.guard ?? null, claims: claimKeys(ops), evidence: structuredClone(block.evidence ?? []),
            ...(occurrence !== null ? { occurrence } : {}),
            boundaries: [{
                cursor: { sid: entry.logical, swipeKey: entry.swipeKey, block: id, op: offset, rev: Math.max(0, (revOp ? revOp.value : 1) - 1) },
                prefixHash: hashJson({ p: chainHash(arr, index), k: entry.swipeKey, t: payloadHashOf(message), b: blocksBefore(earlier) }),
                payloadHash: payloadHashOf(message),
            }],
            operation: structuredClone(block.operation), recorded: structuredClone(block.recorded ?? null), result: structuredClone(block.result ?? null),
            replan: receipt?.replan && Number.isInteger(receipt.seed) && typeof receipt.type === 'string'
                ? { type: receipt.type, payload: structuredClone(receipt.replan.payload ?? {}), seed: receipt.seed } : null,
        };
        const bad = spanProblem(span) || evidenceProblem(span, ops) || clockWriteProblem(span, ops);
        if (bad) throw new Error(`The guarded block cannot be stored: ${bad}.`);
        // A command that read its cursor (ctx.cursor) was told which block it is: it is stored as that one, or it is not stored. (Where the block
        // starts, `op` and `rev`, is where it sits when it is told; a Re-read moves it.)
        if (block.cursor !== undefined && ['sid', 'swipeKey', 'block'].some(key => block.cursor[key] !== span.boundaries[0].cursor[key])) {
            throw new Error('The block is not the one the cursor its command read named; it is not stored.');
        }
        if (span.guard) seeGuards();
        if (span.guard && span.replan) replanFrom = Math.min(replanFrom, index);
        return span;
    }

    // `entry` with its `next` ordinal moved past the blocks in `spans`.
    function advanced(entry, spans) {
        let next = Number.isInteger(entry?.next) ? entry.next : 0;
        for (const span of spans) if (isMetaSpan(span) && Number.isInteger(span.source?.ordinal)) next = Math.max(next, span.source.ordinal + 1);
        const taken = takenAfter(entry, spans);     // (the occurrences of proof blocks, kept past the blocks that go)
        return { ...entry, next, ...(taken ? { taken } : {}) };
    }

    // The carriers from `first` on, replayed on `state` (a Re-read's, reconcile's suffix): a later change that
    // no longer applies throws; a guarded block whose guard no longer holds is inactive and does not. Blocks
    // already skipped on the chat as it stands stay skipped (a guarded one is asked again). Guarded system
    // blocks with a `replan` are planned again when `rerun` is given. → { state, writes: [[message, record]],
    // planned } (`writes`: the checkpoints made true again and the records that were planned again).
    function walkSuffix(arr, state, first, { rerun = null, overlay, prior = null }) {
        const known = replay(arr, lastCarrier(arr)).problems;
        const broken = new Set(known
            .filter(problem => problem.code !== 'REPLAY_PREREQUISITE').map(problem => `${problem.index}:${problem.block}`));
        // The Problems so far, for the checkpoints rewritten on the way (`carried`): those before the walk, then each record's.
        const acc = prior ?? known.filter(problem => problem.index < first);
        const sidAtNow = i => (overlay.get(i) ?? readRecord(arr[i]) ?? arr[i]?.extra?.[KEY])?.sid;
        const writes = [];
        const counted = { planned: 0, removed: 0 };
        let planned = false;
        staged = overlay;
        const outerApplying = applying;
        const head = current();
        // Seeded from the walk's own base: the blocks before `first` that replay applied, counted once. A walk that starts before the
        // checkpoint the head replays from lists the records before `first` as could-apply, and every record from `first` on is the walk's.
        const rooted = first <= (head.from ?? -1);
        applying = head.state && !head.readOnly
            ? { list: rooted ? [] : [...appliedOf(arr, head).filter(entry => entry.index < first)], index: first, from: rooted ? first : head.from }
            : null;
        try {
            let running = revOf(state);      // the rev the replies before ended on (a Re-read's new lines, a step planned again): the revs after are numbered on from it
            let history = false;     // guarded blocks before here: a checkpoint written here depends on their owners
            for (let i = 0; i < first && !history; i++) history = hasMeta(overlay.get(i) ?? readRecord(arr[i]));
            for (let i = first; i < arr.length; i++) {
                const later = readRecord(arr[i]);
                if (!later) continue;
                const guardedBefore = history;
                history ||= hasMeta(later);
                const checkpoint = later.checkpoint ? structuredClone(state) : undefined;
                const owners = checkpoint && applying && proofBefore(arr, i, j => overlay.get(j) ?? readRecord(arr[j])) ? packOwners(listProofs(false), sidAtNow) : null;     // (the blocks that applied before this record)
                const failed = [];
                if (applying) applying.index = i;
                const out = replayBlocks(state, later, i, failed, { skip: broken, rerun, message: arr[i], running });
                state = out.state;
                running = out.running;
                const refusing = failed.filter(problem => problem.code !== 'REPLAY_PREREQUISITE');
                if (refusing.length) throw new Error(`A later change (message ${i}) depends on this reply's old story changes: ${refusing[0].why}`);
                const snapshot = packProblems(acc, sidAtNow);      // (before this record: what a checkpoint here carries)
                // A block that stays skipped is passed over without a try: its Problem is the one it had.
                for (const old of known) if (old.index === i && broken.has(`${old.index}:${old.block}`) && !failed.some(problem => problem.block === old.block)) failed.push(old);
                acc.push(...failed);
                const { planned: made = 0, removed: gone = 0, ...fields } = out.fields ?? {};
                if (out.fields) {
                    planned = true;
                    counted.planned += made;
                    counted.removed += gone;
                }
                if (!checkpoint && !out.fields) continue;
                const next = { ...later, ...fields, ...(checkpoint ? { checkpoint } : {}), rev: revOf(state) };
                if (checkpoint) {
                    if (guardedBefore) next.guardEnv = markNow();
                    else delete next.guardEnv;
                    if (snapshot.length) next.carried = snapshot;
                    else delete next.carried;
                    if (owners) next.owned = owners;
                    else delete next.owned;
                }
                overlay.set(i, next);
                writes.push([arr[i], next]);
            }
        } finally {
            staged = null;
            applying = outerApplying;
        }
        // A rewritten checkpoint's state is the chat as it stands now, so its window is too (REPLAY.md "Checkpoints and covers"):
        // the records from the checkpoint before it (itself included) up to the carrier before this one. A window left as it
        // was could line up again after a later delete and make a state that includes a record trusted without it.
        for (const [target, next] of writes) {
            if (!next.checkpoint) continue;
            const at = arr.indexOf(target);
            // (whatever it was before, a rewritten checkpoint is the state over the records as they are now: its prefix says so)
            next.prefix = spineBefore(arr, at, i => overlay.get(i) ?? readRecord(arr[i]));
            if (!Array.isArray(next.covers)) continue;
            const members = [];
            for (let i = at - 1; i >= 0; i--) {
                const record = isCarrier(arr[i]) ? overlay.get(i) ?? readRecord(arr[i]) : null;
                if (!record) continue;
                members.unshift(i);
                if (record.checkpoint) break;
            }
            next.covers = members.map(i => (overlay.get(i) ?? readRecord(arr[i])).sid);
            const hash = windowHash(arr, members, i => overlay.get(i) ?? readRecord(arr[i]));
            if (hash === undefined) delete next.coverHash;
            else next.coverHash = hash;
        }
        return { state, writes, any: planned, ...counted };
    }

    // Is the shown swipe's copy of this carrier's record kept in swipe_info (persist.js keepsCopy)?
    function keeps(message, arr = list()) {
        return keepsCopy(message, arr[lastCarrier(arr)] === message);
    }

    // A rebuild's pass over the whole chat (persist.js): the last carrier gets its copy (again), the
    // others with one swipe drop theirs, and receipts `receiptKeep` or more carriers back drop `data`.
    // Only records that are the shown swipe's own are touched. In memory: the next save writes it.
    // True when a record was stamped again (that one is a change to save).
    function settleAll(arr) {
        const carriers = carrierIndexes(arr);
        let stamped = false;
        carriers.forEach((i, at) => {
            const message = arr[i];
            const last = at === carriers.length - 1;
            const keep = keepsCopy(message, last);
            // A swipe deleted before another shifts that one's index: stamp it again, so the copy
            // SillyTavern makes for the next new swipe is not taken for the new swipe's own.
            stamped = restamp(message, { mirror: keep }) || stamped;
            if (!readRecord(message)) return;
            if (last) restoreCopy(message);
            else if (!keep) dropCopy(message);
            if (carriers.length - 1 - at >= receiptKeep) trimReceipts(message);
        });
        return stamped;
    }

    // A new record on the last carrier `index`: the carrier before it is no longer the one the reader
    // can swipe, so it drops its copy (unless it has other swipes), and the one `receiptKeep` back drops
    // its receipts' data.
    function settleBehind(arr, index) {
        let back = 0;
        for (let i = index - 1; i >= 0; i--) {
            if (!isCarrier(arr[i])) continue;
            back += 1;
            if (back === 1 && !keepsCopy(arr[i], false) && readRecord(arr[i])) dropCopy(arr[i]);
            if (back >= receiptKeep) {
                trimReceipts(arr[i]);
                return;
            }
        }
    }

    function checkpointState(raw) {
        let state = frozenCheckpoints.get(raw);
        if (!state) frozenCheckpoints.set(raw, state = deepFreeze(structuredClone(raw)));
        return state;
    }

    // Ops are cloned on the way in so nothing the chat holds ends up inside (and frozen with) a state.
    // A count that stands elsewhere than when the op was made (a reply before it was deleted) takes the
    // op's change rather than its number (ops.js rebaseOps, B3-8), and per-reply scratch fits what is
    // there (ops.js scratch); the domains whose counts moved are checked by their validators, and a
    // problem there throws (the block is skipped and reported). With `strict` (a guarded block) no problem that was
    // already there is forgiven. With `replayed` (a stored block replayed,
    // r2-14) every domain the block touches is checked too: a block that leaves one invalid (a stack
    // whose definition a deleted reply made) throws the same way. Only problems the block brings count,
    // so a chat stored before a validator grew stricter still replays.
    function step(state, ops, { replayed = false, strict = false } = {}) {
        if (!ops.length) return state;
        // Every change is looked at before any is rebased or passed over: a block with a change that is not one applies nothing.
        const shape = opShapeProblem(ops);
        if (shape) throw new Error(shape);
        const { ops: rebased, rebased: moved } = rebaseOps(state, ops, { scratch, replayed });
        const next = deepFreeze(apply(state, structuredClone(rebased)));
        if (typeof validate !== 'function') return next;
        const names = new Set(moved);
        if (replayed) for (const op of rebased) if (/^\/domains\/[^/]/.test(op?.path ?? '')) names.add(op.path.split('/')[2].replace(/~1/g, '/').replace(/~0/g, '~'));
        if (!names.size) return next;
        const list = [...names].filter(name => next?.domains?.[name] !== undefined).sort();
        const problems = list.length ? validate(next, list) ?? [] : [];
        if (!problems.length) return next;
        // A guarded block fails closed: every domain it touches must pass outright (no error that was already there
        // is forgiven, as it is for a legacy block whose chat was stored before a validator grew stricter).
        if (strict) throw new Error(`These changes leave the story invalid: ${problems.join(' ')}`);
        const before = new Set(validate(state, list.filter(name => state?.domains?.[name] !== undefined)) ?? []);
        const brought = problems.filter(problem => !before.has(problem));
        if (brought.length) {
            throw new Error(moved.size
                ? `Taken onto the counts as they stand now, these changes no longer fit: ${brought.join(' ')}`
                : `Taken onto the story as it stands now, these changes no longer fit: ${brought.join(' ')}`);
        }
        return next;
    }

    // The checkpoint to replay from for carrier `upTo` and the records after it (B2-4). A checkpoint is trusted only
    // when the prefix it was made over is exactly the prefix in front of it now (`prefix`, see spineStep): every record
    // before it as it is shown, so one made before a reply was deleted, edited, Re-read or another swipe was shown, and
    // a hidden swipe's, fails and the replay starts from an earlier one that still holds. One that stored no prefix
    // (older records) is trusted only as the first record there is. It must also hold under the owners it was made with
    // (`guardEnv`) and, when it has them, `covers` and `coverHash` (the records it covers and, for guarded blocks, their swipe
    // keys, contents and text). When no checkpoint holds there is no state to start from (the chat starts again from the
    // state ensureInitial gives it) rather than the latest one being taken unchecked.
    // → { from: index | -1, since: the record IDs from `from` through `upTo`, members: their indexes }.
    function chain(arr, upTo) {
        let from = -1;
        let since = [];
        let members = [];
        let guarded = false;     // a record in the window holds guarded blocks
        let history = false;     // a record before this point (anywhere) holds guarded blocks: a checkpoint here depends on its owners
        let running = '';        // the prefix hash in front of this record (spineStep)
        let seen = 0;            // records before this one
        const last = Math.min(upTo, arr.length - 1);
        for (let i = 0; i <= last; i++) {
            if (!isCarrier(arr[i])) continue;
            const record = readRecord(arr[i]);
            if (!record) continue;
            if (record.checkpoint) {
                const covers = Array.isArray(record.covers) ? record.covers : null;
                // Over guarded blocks a checkpoint holds only under the owners it was made with (guardEnv): its state
                // carries what their guards allowed, and replay does not ask them again from here on.
                const under = !history ? true : record.guardEnv !== undefined && record.guardEnv === markNow();
                // The gate: the prefix it was made over is exactly the prefix in front of it now. One that stored none (older
                // records, a hidden swipe's) is trusted only as the first record there is.
                const exact = record.prefix !== undefined ? record.prefix === running : seen === 0;
                // (covers and coverHash are further checks when it has them)
                const holds = under && exact && (!covers || (from >= 0 && covers.length === since.length && covers.every((sid, at) => sid === since[at])
                    && (record.coverHash === undefined ? !guarded : record.coverHash === windowHash(arr, members))));
                if (holds) {
                    from = i;
                    since = [];
                    members = [];
                    guarded = false;
                }
            }
            running = spineStep(running, record, arr[i], seen === 0);
            seen += 1;
            since.push(record.sid);
            members.push(i);
            if (hasMeta(record)) {
                guarded = true;
                if (!history) {
                    history = true;
                    seeGuards();
                }
            }
        }
        return { from, since, members, history };
    }

    // The Problems of blocks before a checkpoint ride with it (`carried`), so a replay that starts from the checkpoint still
    // reports a block that is off in front of it: by the sid of the record it was on (a message index moves when a user
    // message is deleted), the block's position, why and its code.
    const problemText = (index, why, code) => (code === 'DAMAGED'
        ? `The story record on message ${index} is damaged and was skipped: ${why}.`
        : `Some changes stored on message ${index} no longer apply and were skipped: ${why}`);
    const rawSidAt = (arr, i) => (readRecord(arr[i]) ?? arr[i]?.extra?.[KEY])?.sid;
    function packProblems(problems, sidAt) {
        const out = [];
        for (const problem of problems) {
            const sid = sidAt(problem.index);
            if (typeof sid !== 'string') continue;
            out.push({ sid, block: problem.block ?? null, receipts: [...(problem.receipts ?? [])], why: String(problem.why), ...(problem.code ? { code: problem.code } : {}) });
        }
        return out;
    }
    function unpackProblems(arr, before, carried) {
        if (!Array.isArray(carried) || !carried.length) return [];
        const at = new Map();
        for (let i = 0; i < before && i < arr.length; i++) {
            const sid = rawSidAt(arr, i);
            if (typeof sid === 'string' && isCarrier(arr[i])) at.set(sid, i);
        }
        const out = [];
        for (const each of carried) {
            if (!isObject(each) || !at.has(each.sid)) continue;
            const index = at.get(each.sid);
            out.push({ index, block: each.block ?? null, receipts: Array.isArray(each.receipts) ? [...each.receipts] : [], why: String(each.why),
                message: problemText(index, each.why, each.code), ...(each.code ? { code: each.code } : {}) });
        }
        return out;
    }

    // State after the last carrier at or before `upTo`, or null when no checkpoint precedes it. A block
    // of ops that no longer applies (a hand-edited chat, a middle reply deleted) is skipped and reported
    // on its own, so a bad change cannot take the rest of its carrier, or anything later, with it.
    // `whole`: from the first carrier's own checkpoint, past every later one (carriedTo, below).
    function replay(arr, upTo, { whole = false } = {}) {
        counts.replays++;
        let { from } = chain(arr, upTo);
        if (whole) {
            const first = carrierIndexes(arr)[0];
            if (first !== undefined && first <= upTo && readRecord(arr[first])?.checkpoint) from = first;
        }
        // A damaged record (B-b2-timeline-7) is skipped, and said so.
        const problems = from >= 0 ? unpackProblems(arr, from, readRecord(arr[from]).carried) : [];
        for (let i = Math.max(from, 0); i <= upTo && i < arr.length; i++) {
            const fault = recordFault(arr[i]);
            if (fault) {
                problems.push({ index: i, block: null, receipts: [], why: fault, code: 'DAMAGED', message: problemText(i, fault, 'DAMAGED') });
            }
        }
        if (from < 0) return { state: null, problems };
        let state = checkpointState(readRecord(arr[from]).checkpoint);
        // The proof of the blocks that applied, in the order they applied (replayGuarded adds to it).
        const outer = applying;
        const applied = [];
        applying = { list: applied, index: from, from };
        try {
            for (let i = from; i <= upTo && i < arr.length; i++) {
                const record = readRecord(arr[i]);
                if (!record) continue;
                counts.recordsRead++;
                applying.index = i;
                state = replayRecord(state, record, i, problems, null, arr[i]);
            }
        } finally {
            applying = outer;
        }
        return { state, problems, from, applied };
    }

    // One carrier's ops, block by block. `skip` (a Set of "index:block") names blocks to pass over
    // without trying them (Re-read keeps blocks that were already skipped skipped).
    function replayRecord(state, record, index, problems, skip = null, message = null) {
        return replayBlocks(state, record, index, problems, { skip, message }).state;
    }

    // The rev a block's last `/meta/rev` op sets, or null.
    const revOfOps = ops => [...ops].reverse().find(op => op?.path === '/meta/rev' && Number.isInteger(op.value))?.value ?? null;

    // replayRecord, and with `rerun` (a Re-read's or reconcile's way of planning a system step again) the
    // record's guarded system blocks that carry a `replan` are planned again on the state as it stands at their
    // place (REPLAY.md "Reconciling"): the old block (ops, claims, receipt) is not applied, and the new one takes
    // its place, keeping its block id and source. The step is asked with what the span saved (`span.replan`:
    // type, payload, seed). Only an owner that says NO_LONGER_DONE removes a block; when the step cannot be asked
    // (the command is not there, the owner is held back, a feature is off, it threw, any other refusal) the old
    // block stays as it is, untouched, and is replayed as it was (its guard decides: off, REPLAY_PREREQUISITE, when it fails). A block planned again to what it was
    // changes nothing. A guarded block whose guard no longer holds stays stored and inactive and is asked again
    // the next time. → { state, fields }: `fields` ({ ops, receipts, spans, source, planned, removed }) is what
    // the record is to hold now, or null when nothing changed (the record stays as it is).
    function replayBlocks(state, record, index, problems, { skip = null, rerun = null, message = null, running = null } = {}) {
        const parts = blockParts(record);
        const replans = parts.some(({ span }) => isMetaSpan(span) && span.guard && span.replan);
        if (replans) replanFrom = Math.min(replanFrom, index);
        const plans = typeof rerun === 'function' && replans;
        // `running`: the rev the replies before this one ended on after a step was planned again; from there on the revs
        // are numbered on (so no two receipts share one), here and on the replies after.
        const rewrites = plans || running !== null;
        const out = rewrites ? { parts: [], gone: new Map(), changed: false, running, planned: 0, removed: 0 } : null;
        const anyGuardedReceipt = record.receipts.some(each => each?.guarded === true);
        const orphan = anyGuardedReceipt && quarantined(record);
        // Where each block of this record stands in the record that is written back (a planned-again step that is no longer
        // done takes its place out of it), so the Problems below name the block as a full replay will number it.
        const firstProblem = problems.length;
        const placed = new Map();
        // Quarantine is decided on the record as it is stored, before any rebase, renumbering or filtering below can touch it:
        // it applies nothing and is never rewritten (so nothing renumbered can reattach the receipt that is detached).
        if (orphan) {
            parts.forEach(({ ops }, block) => {
                problems.push({
                    index, block, receipts: receiptsOf(record, ops), why: ORPHAN,
                    message: `Some changes stored on message ${index} no longer apply and were skipped: ${ORPHAN}`,
                    code: 'REPLAY_PREREQUISITE',
                });
                state = skipped(state, ops);
            });
            return { state, fields: null, running };
        }
        parts.forEach(({ ops, span: stored }, block) => {
            let span = stored;
            // A block numbered at or below the rev the story is at (a swipe made before an earlier reply was read again, shown
            // now): a reconcile from here numbers it on (walkSuffix), so revs stay strictly increasing along the chat.
            const firstRev = ops.find(op => op?.path === '/meta/rev' && Number.isInteger(op.value))?.value;
            if (firstRev !== undefined && firstRev <= revOf(state)) replanFrom = Math.min(replanFrom, index);
            const receipt = rewrites || anyGuardedReceipt ? record.receipts.find(each => each?.rev === revOfOps(ops)) ?? null : null;
            let blockOps = ops;
            const stands = rewrites || anyGuardedReceipt ? receiptsFor(record, ops) : [];     // every receipt this block's ops are
            const remapped = new Map();                                                       // receipt → the same receipt at its new rev
            if (rewrites && out.running !== null) {
                const moves = new Map();
                blockOps = ops.map(op => {
                    if (op?.path !== '/meta/rev' || !Number.isInteger(op.value)) return op;
                    if (op.value > out.running) {
                        out.running = op.value;
                        return op;
                    }
                    out.running += 1;
                    moves.set(op.value, out.running);
                    return { ...op, value: out.running };
                });
                if (moves.size) {
                    out.changed = true;
                    // (every receipt of the block follows its ops, not only the last one: a block that stands for several
                    // receipts keeps each of them, the guarded one too, tied to its changes)
                    for (const each of stands) if (moves.has(each.rev)) remapped.set(each, { ...each, rev: moves.get(each.rev) });
                }
            }
            const keep = () => {
                if (!rewrites) return;
                out.parts.push({ ops: blockOps, span });
                placed.set(block, out.parts.length - 1);
                for (const [was, now] of remapped) out.gone.set(was, now);
            };
            if (skip?.has(`${index}:${block}`)) {
                state = skipped(state, blockOps);
                keep();
                return;
            }
            const guarded = isGuardedBlock(span, anyGuardedReceipt ? stands : null);
            if (plans && isMetaSpan(span) && span.guard && span.replan && receipt) {
                const done = replanned(state, record, index, span, receipt, blockOps, out, rerun);
                if (!done.kept) {
                    if (done.state) {
                        state = done.state;
                        if (done.same) {
                            if (done.span) {
                                out.changed = true;
                                span = done.span;
                            }
                            keep();
                        }
                    }
                    return;
                }
                // It could not be asked: the block stays as it was, replayed as any block is (its guard decides).
            }
            try {
                state = guarded ? replayGuarded(state, record, blockOps, span, message, receipt) : replayLegacy(state, blockOps);
                keep();
            } catch (error) {
                const why = String(error?.message ?? error);
                problems.push({
                    index, block, receipts: receiptsOf(record, ops), why,
                    message: `Some changes stored on message ${index} no longer apply and were skipped: ${why}`,
                    ...(guarded || error?.code === 'REPLAY_PREREQUISITE' ? { code: 'REPLAY_PREREQUISITE' } : {}),
                });
                state = skipped(state, blockOps);
                keep();
            }
        });
        if (!out?.changed) return { state, fields: null, running: out?.running ?? null };
        for (let at = firstProblem; at < problems.length; at += 1) {
            const entry = problems[at];
            if (entry.index === index && placed.has(entry.block)) entry.block = placed.get(entry.block);
        }
        const receipts = [];
        for (const each of record.receipts) {
            if (!out.gone.has(each)) receipts.push(each);
            else if (out.gone.get(each)) receipts.push(out.gone.get(each));
        }
        const spans = out.parts.map(part => part.span);
        const ops = out.parts.flatMap(part => part.ops);
        return { state, fields: { ops, receipts, spans, source: advanced(record.source, spans), planned: out.planned, removed: out.removed }, running: out.running };
    }

    // The occurrence a block planned again gives its proof: the one it was stamped with, else (a block that gave no proof until now, guarded
    // or not) the next one nobody has used in its reply, from the plan's one allocator (evidence.js allocator). The operation is the one the
    // block is run again as: its replan's, else its own.
    function occurrenceFor(span, receipt, alloc) {
        const stored = occurrenceOf(span);
        if (stored !== null) return stored;
        let key = null;
        try {
            const again = isObject(span?.replan) ? span.replan : isObject(receipt?.replan) ? { type: receipt.type, payload: receipt.replan.payload ?? {} } : null;
            key = again ? operationKey(again.type, again.payload) : spanOperationKey(span);
        } catch { key = null; }
        return key ? alloc.take(key) : undefined;
    }

    // Every rerun sees the position the accepted blocks of this plan leave, rather than the old record's offset.
    function rerunBlock(rerun, state, receipt, index, span, earlier, alloc) {
        return rerun(deepFreeze(structuredClone(state)), receipt, {
            index, span, replan: span.replan ?? null, occurrence: occurrenceFor(span, receipt, alloc),
            opsBefore: earlier.reduce((sum, part) => sum + part.ops.length, 0),
        });
    }

    // One guarded system block planned again on `state` (replayBlocks). → { state } the state after the new block
    // (or after the old one when it comes out the same: nothing changes), { state: null } when the owner says the
    // step is NO_LONGER_DONE (the block, its claims and its receipt go), or { kept: true, why } when it could not
    // be asked (the old block stays exactly as it was, and is replayed as it was: its guard decides). A new block that does not apply, or cannot be stored, throws:
    // nothing is changed.
    function replanned(state, record, index, span, receipt, blockOps, out, rerun) {
        const broken = intactReason(record, blockOps, span, receipt);
        if (broken) return { kept: true, why: broken };
        let planned = null;
        let failure = '';
        try {
            planned = rerunBlock(rerun, state, receipt, index, span, out.parts, (out.alloc ??= allocator(record)));
        } catch (error) {
            failure = `it threw (${error?.message ?? error})`;
        }
        if (!planned?.ok) {
            if (planned?.ok === false && planned.code === NO_LONGER_DONE) {
                out.changed = true;
                out.removed += 1;
                out.gone.set(receipt, null);
                return { state: null };
            }
            const why = failure || `it was not asked (${planned?.code ?? 'no answer'}: ${planned?.message ?? 'nothing came back'})`;
            return { kept: true, why };
        }
        const clash = ownedAlready(state, planned.block?.evidence);
        if (clash) return { kept: true, why: `it would give proof ${clash.id}, which a block that applied already owns` };
        const fresh = asOps(planned.ops);
        let next;
        try {
            next = step(state, fresh);
        } catch (error) {
            throw new Error(`A step planned again on message ${index} does not apply: ${error?.message ?? error}`);
        }
        const own = revOfOps(fresh);
        if (Number.isInteger(own)) out.running = out.running === null ? own : Math.max(out.running, own);
        const newReceipt = { ...structuredClone(planned.receipt), id: receipt.id, ...(receipt.afterCapture === true ? { afterCapture: true } : {}), ...(receipt.beforeGenerate === true ? { beforeGenerate: true } : {}) };
        let newSpan = { n: fresh.length, story: false };
        if (planned.block) {
            const arr = list();
            const holder = withSource(arr[index], record);
            newSpan = { ...newSpan, ...stamp(arr, index, holder, { ...planned.block, id: span.id, source: { ...planned.block.source, ordinal: span.source.ordinal } }, fresh, newReceipt, out.parts, out.parts.reduce((sum, part) => sum + part.ops.length, 0)) };
        }
        // A block that would not hold on replay is not stored: the old block stays as it is, its own guard decides.
        if (newSpan.guard) {
            try { guardHolds(state, newSpan, arr0(index)); } catch (error) { return { kept: true, why: error.message }; }
        }
        // Its proof is the guards' to see only now: it applied and it is stored. A refusal above leaves no trace of it.
        publish(newSpan, index);
        // Planned to what it was: the old block stays as it is.
        const sameness = value => hashJson({ ops: value.ops, guard: value.span.guard ?? null, claims: value.span.claims ?? null, recorded: value.span.recorded ?? null,
            result: value.span.result ?? null, operation: value.span.operation ?? null, replan: value.span.replan ?? null, evidence: evidenceDigest(value.span.evidence) });
        if (sameness({ ops: blockOps, span }) === sameness({ ops: fresh, span: newSpan })) {
            // The same step; but where it stands may have moved (the boundaries' prefix hashes follow what is before
            // it), and then the new span is what is stored: ops, receipt and result stay as they were.
            return { state: next, same: true, ...(hashJson(span) === hashJson(newSpan) ? {} : { span: newSpan }) };
        }
        out.changed = true;
        out.planned += 1;
        out.parts.push({ ops: fresh, span: newSpan });
        out.gone.set(receipt, newReceipt);
        return { state: next };
    }

    // A skipped block still counts its receipts' revs, so every later receipt keeps a rev of its own.
    function skipped(state, ops) {
        const revs = ops.filter(op => op?.path === '/meta/rev' && Number.isInteger(op.value));
        if (!revs.length || revs.at(-1).value <= revOf(state)) return state;
        try { return step(state, [{ op: 'replace', path: '/meta/rev', value: revs.at(-1).value }]); } catch { return state; }
    }

    function headKey(arr) {
        const index = lastCarrier(arr);
        const message = arr[index];
        return { arr, length: arr.length, index, message, swipe: message?.swipe_id, extra: message?.extra,
            record: message?.extra?.[KEY] };
    }

    const sameKey = (a, b) => Object.keys(a).every(name => a[name] === b[name]);

    // The cached head still holds when all that changed is messages after its carrier that hold no
    // record (the reader's next message, a reply not read yet): replaying them would give it again.
    function stillHolds(arr, key) {
        const old = cache?.key;
        if (!cache?.state || old.arr !== arr || old.index < 0 || key.index < old.index || arr.length < old.length) return false;
        const message = arr[old.index];
        if (message !== old.message || message?.swipe_id !== old.swipe || message?.extra !== old.extra || message?.extra?.[KEY] !== old.record) return false;
        for (let i = old.index + 1; i < arr.length; i++) if (arr[i]?.extra?.[KEY] !== undefined) return false;
        return true;
    }

    // The proof of the blocks before the one replay starts from. When the checkpoint there says which blocks applied before it (`owned`: the
    // record's sid and the block's id), those and no others; else (an older checkpoint) every block that could apply (replay did not look
    // at them), and of two that give one id the first listed keeps it.
    function proofsBefore(arr, from) {
        const memo = lineOf(arr);
        const kept = memo.proofsBefore?.get(from);
        if (kept) return kept;
        const owned = from >= 0 ? readRecord(arr[from])?.owned : undefined;
        const on = Array.isArray(owned) ? new Set(owned.map(each => (Array.isArray(each) ? `${each[0]}\u0000${each[1]}` : ''))) : null;
        const out = [];
        for (const i of carrierIndexes(arr)) {
            if (i >= from) break;
            const record = readRecord(arr[i]);
            if (record && hasMeta(record)) for (const entry of recordEntries(record, blockParts(record))) if (!on || on.has(`${record.sid}\u0000${entry.block}`)) out.push(Object.freeze({ ...entry, index: i }));
        }
        // A checkpoint that does not say (one written before it did) is worked out by replaying what is before it.
        let listed = out;
        if (!on && out.length && from > 0) {
            const prior = replay(arr, from - 1);
            if (prior.state) listed = [...proofsBefore(arr, prior.from), ...(prior.applied ?? [])];
        }
        const seen = new Set();
        const once = listed.filter(entry => !seen.has(entry.proof.id) && seen.add(entry.proof.id));
        (memo.proofsBefore ??= new Map()).set(from, once);
        return once;
    }

    // Did any record before carrier `upTo` hold proof (a block with evidence)? A checkpoint carries `owned` only when one did, so a store
    // that never gave proof is written exactly as it was.
    function proofBefore(arr, upTo, at = i => readRecord(arr[i])) {
        for (let i = 0; i < upTo && i < arr.length; i++) {
            const record = isCarrier(arr[i]) ? at(i) : null;
            if (record && Array.isArray(record.spans) && record.spans.some(span => Array.isArray(span?.evidence) && span.evidence.length)) return true;
        }
        return false;
    }

    // The blocks that applied, as a checkpoint carries them (`owned`): [record sid, block id], each once.
    function packOwners(entries, sidAt) {
        const seen = new Set();
        const out = [];
        for (const entry of entries) {
            const sid = Number.isInteger(entry.index) ? sidAt(entry.index) : undefined;
            if (typeof sid !== 'string' || typeof entry.block !== 'string' || seen.has(`${sid}\u0000${entry.block}`)) continue;
            seen.add(`${sid}\u0000${entry.block}`);
            out.push([sid, entry.block]);
        }
        return out;
    }

    // store.proofs (see there).
    function listProofs(all) {
        const arr = list();
        const memo = lineOf(arr);
        const laid = base => (walkProofs?.size ? Object.freeze(merged(base, [...walkProofs.values()])) : base);
        // A replay or a walk is going on (a guard asks): the blocks that have applied so far, in the order they did.
        if (applying && !all) return laid(Object.freeze([...proofsBefore(arr, applying.from), ...applying.list]));
        const slot = all ? 'proofsAll' : 'proofsApplied';
        if (!memo[slot]) {
            let out = [];
            if (all) {
                for (const i of carrierIndexes(arr)) {
                    const record = readRecord(arr[i]);
                    if (record && hasMeta(record)) for (const entry of recordEntries(record, blockParts(record))) out.push(Object.freeze({ ...entry, index: i }));
                }
            } else {
                const head = current();
                if (head.state && !head.readOnly) {
                    appliedOf(arr, head);
                    out = [...proofsBefore(arr, head.from), ...head.applied];
                }
            }
            memo[slot] = Object.freeze(out);
        }
        return laid(memo[slot]);
    }

    // The head's applied proof, worked out again when a write left it unknown (a truncate).
    function appliedOf(arr, head) {
        if (!head.applied) {
            const again = replay(arr, head.key.index);
            head.applied = again.applied ?? [];
            head.from = again.from ?? -1;
        }
        return head.applied;
    }

    function current() {
        const arr = list();
        const key = headKey(arr);
        if (guardSeen) {
            const mark = markNow();
            if (mark !== lastMark) {
                lastMark = mark;
                cache = null;
                forgetMemos();
            }
        }
        if (cache && !sameKey(cache.key, key) && stillHolds(arr, key)) {
            cache = { ...cache, key };
            known = carrierIndexes(arr).map(i => arr[i]);
        }
        if (!cache || !sameKey(cache.key, key)) {
            replanFrom = Infinity;
            const { state, problems, applied = [], from = -1 } = key.index < 0 ? { state: null, problems: [] } : replay(arr, key.index);
            const kept = !state && fallback ? preservedAt(arr, true) : null;
            cache = { key, state: kept ? fallback : state, problems, applied, from, ...(kept ? { readOnly: kept } : {}) };
            if (state) known = carrierIndexes(arr).map(i => arr[i]);
        }
        return cache;
    }

    // After a write that changed the head carrier's record: keep the cache, with the new key.
    // `applied`: the proof of the blocks that applied since the replay began (cache.applied), as it is after this write: undefined
    // keeps it, null says it is not known (the next read works it out again).
    function retain(arr, state, problems = cache?.problems ?? [], applied = cache?.applied ?? null) {
        cache = { key: headKey(arr), state, problems, applied, from: cache?.from ?? -1, ...(cache?.readOnly && cache.state === state ? { readOnly: cache.readOnly } : {}) };
    }

    function carrierAt(arr, index) {
        if (!Number.isInteger(index) || index < 0 || index >= arr.length) {
            throw new RangeError(`There is no message ${index} in this chat.`);
        }
        if (!isCarrier(arr[index])) throw new RangeError(`Message ${index} is the user's; it holds no story state.`);
        return arr[index];
    }

    // The state after carrier `index` (not the head), replayed once and then kept (atMemo) while every
    // message it was replayed from (its checkpoint's carrier through `index`) is the same object at the same
    // place with the same record, swipe and text. A card drawn again, or a card under each of several replies
    // on screen, then costs a look at those messages, not a replay with every domain's validator.
    function memoAt(arr, index) {
        const hit = atMemo.get(index);
        if (hit && hit.arr === arr && hit.refs.every(([message, record, swipe, mes], at) => {
            const now = arr[hit.from + at];
            return now === message && now?.extra?.[KEY] === record && now?.swipe_id === swipe && now?.mes === mes;
        })) {
            atMemo.delete(index);
            atMemo.set(index, hit);
            return hit.state;
        }
        const { state, from = -1 } = replay(arr, index);
        if (from >= 0) {
            const refs = [];
            for (let i = from; i <= index; i++) refs.push([arr[i], arr[i]?.extra?.[KEY], arr[i]?.swipe_id, arr[i]?.mes]);
            atMemo.delete(index);
            atMemo.set(index, { arr, from, refs, state });
            while (atMemo.size > AT_MEMO_MAX) atMemo.delete(atMemo.keys().next().value);
        }
        return state;
    }

    // A record's receipts as frozen copies, made once per record (a record is never changed in place: each
    // write puts a new one), so a pass over the chat copies only the receipts it has not seen yet.
    const receiptCopies = new WeakMap();
    function frozenReceipts(record) {
        let list = receiptCopies.get(record);
        if (!list) receiptCopies.set(record, list = deepFreeze(structuredClone(record.receipts.filter(isObject))));
        return list;
    }

    // Forgets the memos (a rebuild, or a write that is not on the head carrier alone).
    function forgetMemos() {
        epoch++;
        tail = null;
        lineMemo = null;
        atMemo = new Map();
    }

    // The memo of the whole line of history (receipts, untold) for the chat as it is now.
    function lineOf(arr) {
        const key = headKey(arr);
        if (!lineMemo || lineMemo.epoch !== epoch || !sameKey(lineMemo.key, key)) lineMemo = { epoch, key };
        return lineMemo;
    }

    // The state carrier `index`'s own ops start from: the state after the carrier before it, replayed through the
    // chain (a checkpoint that does not hold is never used), or, when nothing is before it, its own checkpoint if
    // the chain trusts it. Re-read, reconcile and rewind start here (not from whatever the record says it starts from).
    function baseFor(arr, index) {
        const before = stateBefore(arr, index);
        if (before) return before;
        const record = readRecord(arr[index]);
        return record?.checkpoint && chain(arr, index).from === index ? checkpointState(record.checkpoint) : null;
    }

    function stateBefore(arr, index) {
        const prev = lastCarrier(arr, index);
        return prev < 0 ? null : replay(arr, prev).state;
    }

    // Does a new record on carrier `index` need a checkpoint? Counts the carriers and the op JSON since
    // the last checkpoint before it: due after `checkpointEvery` carriers, or once the ops exceed
    // `checkpointBytes` and twice the last checkpoint's size, `CHECKPOINT_MIN_GAP` carriers on at least.
    function needsCheckpoint(arr, index) {
        let carriers = 0;
        let bytes = 0;
        for (let i = index - 1; i >= 0; i--) {
            if (!isCarrier(arr[i])) continue;
            carriers++;
            const record = readRecord(arr[i]);
            if (record?.ops.length) bytes += jsonBytes(record.ops);
            if (record?.checkpoint) {
                if (carriers >= checkpointEvery) return true;
                const gap = Math.min(CHECKPOINT_MIN_GAP, checkpointEvery);
                return carriers >= gap && bytes > Math.max(checkpointBytes, 2 * checkpointSize(record.checkpoint));
            }
            if (carriers >= checkpointEvery) return true;
        }
        return false;
    }

    // A checkpoint's JSON size, worked out once per stored checkpoint.
    function checkpointSize(raw) {
        let size = checkpointBytesOf.get(raw);
        if (size === undefined) checkpointBytesOf.set(raw, size = jsonBytes(raw));
        return size;
    }

    // The carrier's record to build on: its own, or a fresh one (with a checkpoint when one is due).
    // `before` is the state before the carrier when the caller already has it.
    function take(arr, index, before) {
        const message = carrierAt(arr, index);
        const own = readRecord(message);
        if (own) return { message, record: own, fresh: false };
        // A record that is not ours is never taken for an absent one: it would be written over.
        const there = message.extra?.[KEY];
        if (KEPT_ASIDE.has(rawKind(there))) throw new Error(`The story record on this reply ${WHY[rawKind(there)](there)}; it is kept as it is and not written over.`);
        const sid = sidFor(message);
        const record = { v: 2, sid, ops: [], receipts: [], narrated: [], spans: [], source: sourceFor(arr, message, sid) };
        if (index === lastCarrier(arr)) settleBehind(arr, index);
        if (needsCheckpoint(arr, index)) {
            const base = before === undefined ? stateBefore(arr, index) : before;
            if (base) {
                const { since, members, history } = chain(arr, index - 1);
                record.checkpoint = structuredClone(base);
                record.prefix = spineBefore(arr, index);
                const prior = index === lastCarrier(arr) ? current().problems : replay(arr, index - 1).problems;
                const carried = packProblems(prior.filter(problem => problem.index < index), i => rawSidAt(arr, i));
                if (carried.length) record.carried = carried;
                // The blocks before it that applied (the proof of an id belongs to the one that applied with it).
                const head = index === lastCarrier(arr) ? current() : replay(arr, index - 1);
                if (head.state && !head.readOnly && proofBefore(arr, index)) {
                    record.owned = packOwners([...proofsBefore(arr, head.from), ...appliedOf(arr, head)].filter(entry => entry.index < index), i => rawSidAt(arr, i));
                }
                record.covers = since;
                if (history) record.guardEnv = markNow();
                const hash = windowHash(arr, members);
                if (hash !== undefined) record.coverHash = hash;
            }
        }
        return { message, record, fresh: true };
    }

    // The ID a new record on this message's shown swipe gets: the one handed out by carrierSid(), if any.
    function sidFor(message) {
        const kept = reserved.get(message);
        reserved.delete(message);
        return kept && kept.swipe === swipeOf(message) ? kept.sid : recordId();
    }

    // B-b2-timeline-3: the state the first carrier starts from when the carriers before it were deleted:
    // what they ended with, as the store last saw them (their message objects still hold their records).
    // The deleted replies are replayed whole, from the first one's checkpoint: a later checkpoint among them holds what their
    // blocks did without asking them, and a block that must not outlive its reply (a reply-bound guard) is asked here again.
    function carriedTo(message) {
        const at = known ? known.indexOf(message) : -1;
        if (at <= 0) return null;
        const { state } = replay(known, at - 1, { whole: true });
        return state ? structuredClone(state) : null;
    }

    function spansOf(record) {
        const spans = Array.isArray(record.spans) ? record.spans : null;
        const total = spans?.reduce((sum, span) => sum + (Number.isInteger(span?.n) ? span.n : NaN), 0);
        if (spans && total === record.ops.length) return spans.some(span => span?.mixed) ? null : spans;
        // A record without usable spans: fine as one kept block if it holds no story receipts.
        if (!record.receipts.some(receipt => receipt?.cause === 'story')) return [{ n: record.ops.length, story: false }];
        return null;
    }

    // C1-1: the spans a new block is added after. A record whose spans do not add up is replayed as one
    // block (blockParts); it stays one block, `mixed` (its story changes cannot be told apart, so Re-read
    // still refuses it), and the new block is one of its own, so a bad op in the old ones cannot take it
    // with them on the next rebuild.
    function spansFor(record) {
        const spans = Array.isArray(record.spans) ? record.spans : null;
        const total = spans?.reduce((sum, span) => sum + (Number.isInteger(span?.n) && span.n >= 0 ? span.n : NaN), 0);
        if (spans && total === record.ops.length) return spans;
        return spansOf(record) ?? (record.ops.length ? [{ n: record.ops.length, story: true, mixed: true }] : []);
    }

    // The record's ops in the blocks they were stored in: one per append (one receipt), one for a
    // Re-read's story changes, each with its span. A record whose spans are missing or do not add up is one
    // block (and has no span to read).
    function blockParts(record) {
        const spans = Array.isArray(record.spans) ? record.spans : null;
        const fits = spans && spans.every(span => Number.isInteger(span?.n) && span.n >= 0)
            && spans.reduce((sum, span) => sum + span.n, 0) === record.ops.length;
        if (!fits) return record.ops.length ? [{ ops: record.ops, span: null }] : [];
        const out = [];
        let at = 0;
        for (const span of spans) {
            if (span.n) out.push({ ops: record.ops.slice(at, at + span.n), span });
            at += span.n;
        }
        return out;
    }

    // The IDs of the receipts whose changes are `ops` (each receipt's ops end with its /meta/rev op).
    function receiptsOf(record, ops) {
        const revs = new Set(ops.filter(op => op?.path === '/meta/rev').map(op => op.value));
        return record.receipts.filter(receipt => revs.has(receipt?.rev)).map(receipt => receipt.id);
    }

    function asOps(ops) {
        if (ops === undefined || ops === null) return [];
        if (!Array.isArray(ops)) throw new TypeError('Ops must be an array.');
        return structuredClone(ops);
    }

    const api = {
        head() {
            return current().state;
        },

        at(index) {
            const arr = list();
            if (!Number.isInteger(index) || index < 0 || index >= arr.length) {
                throw new RangeError(`There is no message ${index} in this chat.`);
            }
            const head = current();
            if (index >= head.key.index) return head.state;
            return memoAt(arr, index);
        },

        headIndex() {
            return lastCarrier(list());
        },

        // Carrier `index`'s own ops (frozen copies), [] for a message with no record.
        opsAt(index) {
            const arr = list();
            if (!Number.isInteger(index) || index < 0 || index >= arr.length) return [];
            return deepFreeze(structuredClone(readRecord(arr[index])?.ops ?? []));
        },

        // The JSON Pointers carrier `index`'s ops touched, in first-touched order (for a card's
        // "only what changed" and changed(path)). [] for a message with no record.
        changesAt(index) {
            const arr = list();
            if (!Number.isInteger(index) || index < 0 || index >= arr.length) return [];
            const record = readRecord(arr[index]);
            return [...new Set((record?.ops ?? []).map(op => op?.path).filter(path => typeof path === 'string'))];
        },

        // Problems met by the last head rebuild: [{ index, block, receipts, why, message }], one per block
        // of stored ops that no longer applies (`receipts`: the IDs whose changes were skipped).
        problems() {
            const problems = current().problems.map(problem => ({ ...problem, receipts: [...(problem.receipts ?? [])] }));
            for (const fault of faultsNow().values()) {
                const index = list().indexOf(fault.message);
                if (index < 0) continue;
                const source = api.sourceAt(index);
                if (source?.sid !== fault.source.sid || source?.swipeKey !== fault.source.swipeKey) continue;
                if (problems.some(problem => problem.index === index && problem.why.includes(fault.why))) continue;
                problems.push({ index, block: null, receipts: [], why: fault.why, code: 'REPLAY_PREREQUISITE',
                    message: `A replay guard on message ${index} refused its planned changes: ${fault.why}` });
            }
            return problems;
        },

        // Why the head is only the empty read-only state: the first record is a future version's, an older one's or
        // damaged ('future' | 'legacy' | 'damaged'), or the replies before the earliest saved point are gone and
        // unseen ('unresolved'); it is kept as it is. → { index, kind, why }, else null. Nothing is written meanwhile.
        readOnly() {
            const kept = keptNow();
            return kept ? { index: kept.index, kind: kept.kind, why: kept.why } : null;
        },

        // The reader's own repair (never automatic; each needs `{ confirmed: true }`, the caller has asked the reader):
        // * startOver: the story's state starts over from its beginning, the replies after it replaying on top. A
        //   damaged or older record on any reply is set aside beside where it was (`extra.storySuiteAside`, a list that only
        //   grows: each repair adds its records), not lost.
        //   Not for a record from a newer version: update Story Block.
        // * keepEarliest (unresolved only): the earliest saved point is trusted as the start of the story.
        startOver({ confirmed = false } = {}) {
            const kept = keptNow();
            if (!kept) throw new Error('The story record is not being kept aside; there is nothing to start over.');
            if (kept.kind === 'future') throw new Error('The story record is from a newer version of Story Block, so it is not started over; update Story Block to read it.');
            if (confirmed !== true) throw new Error('Starting the story state over needs the reader\'s confirmation.');
            const arr = list();
            for (const message of arr) {
                if (!isCarrier(message)) continue;
                const raw = message.extra?.[KEY];
                const kind = rawKind(raw);
                if (kind !== 'legacy' && kind !== 'damaged') continue;
                // Every record set aside is kept, in the order it was: a later repair adds to the list, never replaces an entry.
                const earlier = message.extra.storySuiteAside;
                // (a list of { kind, record } entries is ours; anything else that is there, an array of records from before included, is one earlier record)
                const ours = Array.isArray(earlier) && earlier.every(entry => isObject(entry) && typeof entry.kind === 'string' && Object.hasOwn(entry, 'record'));
                const kept = ours ? earlier : earlier === undefined ? [] : [{ kind: 'earlier', record: earlier }];
                message.extra.storySuiteAside = [...kept, { kind, record: structuredClone(raw) }];
                delete message.extra[KEY];
                const info = Array.isArray(message.swipe_info) ? message.swipe_info[swipeOf(message)] : null;
                if (isObject(info?.extra) && info.extra !== message.extra && rawKind(info.extra[KEY]) === kind) delete info.extra[KEY];
            }
            const first = carrierIndexes(arr)[0];
            const message = arr[first];
            const checkpoint = structuredClone(fallback);
            // The checkpoints after it hold the story the start used to be: they go (the story builds new ones as it grows).
            for (const i of carrierIndexes(arr)) {
                if (i === first) continue;
                const record = readRecord(arr[i]);
                if (!record?.checkpoint) continue;
                const { checkpoint: gone, covers, coverHash, guardEnv, prefix, carried, owned, ...rest } = record;
                void gone; void covers; void coverHash; void guardEnv; void prefix; void carried; void owned;
                write(arr[i], rest);
            }
            const own = readRecord(message);
            const { covers, coverHash, guardEnv, prefix, carried, owned, ...rest } = own ?? {};
            void covers; void coverHash; void guardEnv; void prefix; void carried; void owned;
            write(message, own
                ? { ...rest, checkpoint, rev: revOf(checkpoint) }
                : { v: 2, sid: sidFor(message), checkpoint, ops: [], receipts: [], narrated: [], spans: [], rev: revOf(checkpoint) });
            saver.touch();
            cache = null;
            forgetMemos();
            return { index: first };
        },
        keepEarliest({ confirmed = false } = {}) {
            const kept = keptNow();
            if (kept?.kind !== 'unresolved') throw new Error('There is no unresolved start to keep a saved point of.');
            if (confirmed !== true) throw new Error('Keeping the earliest saved point needs the reader\'s confirmation.');
            const arr = list();
            const { covers, coverHash, prefix, carried, owned, ...rest } = readRecord(arr[kept.index]);
            void covers; void coverHash; void prefix; void carried; void owned;     // (the first record there is: trusted as the start, whatever was in front of it)
            write(arr[kept.index], rest);
            saver.touch();
            cache = null;
            forgetMemos();
            return { index: kept.index };
        },

        // A chat with no state yet gets one on its first carrier. A record already there is never
        // replaced: it gets the starting point it lacks (the state the deleted carriers before it ended
        // with, else `initialState`) and keeps its own changes. A first record that is a newer version's, an older
        // one's or damaged is never written over or repaired, and a story whose first replies are gone and unseen
        // (the earliest checkpoint left cannot be checked) is not adopted or reset by itself: both are kept as they
        // are, read-only, and the reader decides (startOver / keepEarliest). Returns notes for the Problems list.
        ensureInitial(initialState) {
            if (!isObject(initialState)) throw new TypeError('The initial state must be an object.');
            const head = current();
            idsOf(list());    // the baseline of the ids this chat holds, for what is deleted before anything is written
            if (head.state && !keptNow()) return [];
            const arr = list();
            const first = carrierIndexes(arr)[0];
            if (first === undefined) return [];
            const keepAside = () => {
                if (!fallback) {
                    fallback = deepFreeze(structuredClone(initialState));
                    cache = null;
                    forgetMemos();
                }
                const kept = preservedAt(arr, true);
                const key = `${kept.kind}:${kept.index}:${kept.raw ? JSON.stringify(kept.raw).length : 0}`;
                if (noted === key) return [];
                noted = key;
                return [readOnlyMessage(kept)];
            };
            if (preservedAt(arr)) return keepAside();
            const message = arr[first];
            const carried = carriedTo(message);
            // The replies before the first one that is left are gone and this session never saw them: the earliest
            // checkpoint that survives cannot be checked, so nothing is adopted and the story is not reset to its start.
            if (!carried && carrierIndexes(arr).some(i => readRecord(arr[i])?.checkpoint)) return keepAside();
            const checkpoint = carried ?? structuredClone(initialState);
            const own = readRecord(message);
            const { covers, coverHash, prefix, carried: droppedProblems, owned: droppedOwners, ...base } = own ?? {};
            void covers; void coverHash; void prefix; void droppedProblems; void droppedOwners;
            const record = own
                ? { ...base, sid: typeof own.sid === 'string' ? own.sid : sidFor(message), checkpoint,
                    rev: Number.isInteger(own.rev) ? own.rev : revOf(checkpoint) }
                : { v: 2, sid: sidFor(message), checkpoint, ops: [], receipts: [], narrated: [], spans: [], rev: revOf(checkpoint) };
            write(message, record);
            saver.touch();
            cache = null;
            forgetMemos();
            return [];
        },

        /**
         * The record ID of carrier `index`'s shown swipe (MODULES §F2's ctx.carrier.sid): its record's,
         * or one handed out now that its first record will get. null for a message that is not a carrier.
         */
        carrierSid(index) {
            const message = list()[index];
            if (!isCarrier(message)) return null;
            const own = readRecord(message);
            if (own) return typeof own.sid === 'string' ? own.sid : null;
            const swipe = swipeOf(message);
            const kept = reserved.get(message);
            if (kept && kept.swipe === swipe) return kept.sid;
            const sid = recordId();
            reserved.set(message, { swipe, sid });
            return sid;
        },

        /**
         * The Source of carrier `index` (contract §4): { sid: sr_…, swipeKey: sw_…, evidence: ev_…, ordinal }, the
         * canonical pair of its logical message and swipe, from the record's source map entry (worked out
         * from the stored ID when the record has none yet, and persisted with the record's next write).
         * `ordinal` is the next block ordinal, or `{ ordinal }` names one; `{ pending }` counts blocks a
         * Re-read has planned but not stored. null for a message that is not a carrier. Numeric message
         * and swipe indexes are never part of it.
         */
        sourceAt(index, options) {
            return sourceOf(index, options);
        },

        /** A new block's occurrence for the operation `key` (operationKey) on carrier `index`: the next one nobody has used in its reply (evidence.js allocator). */
        allocateOccurrence(index, key) {
            const arr = list();
            const record = isCarrier(arr[index]) ? readRecord(arr[index]) : null;
            return allocator(record ?? {}).take(key);
        },

        /**
         * The proof of the chat's blocks, in apply order: [{ proof, block, index }] (frozen). Only the blocks that applied
         * (replay's own account of them: a block that was skipped, is off, collided on a proof id or is damaged gives none;
         * before the first checkpoint replay starts from, the blocks that could apply), so the one that owns an id is the
         * one that applied with it. Not yet active: the state pins the active ones (evidence.js visibleProofs, the
         * `story.evidence` query). `{ all: true }`: the proof of every block that could apply, whether it did or not (what
         * a new proof must not take an id from).
         */
        proofs(options = {}) {
            return listProofs(options?.all === true);
        },

        /** The guarded block of carrier `index` whose Source ordinal is `ordinal` (a step planned again names its own): { block, op } (its id, the changes before it), or null. */
        blockAt(index, ordinal) {
            const arr = list();
            const record = isCarrier(arr[index]) ? readRecord(arr[index]) : null;
            if (!record) return null;
            let op = 0;
            for (const span of spansFor(record)) {
                if (isMetaSpan(span) && span.source?.ordinal === ordinal) return { block: span.id, op };
                op += Number.isInteger(span?.n) ? span.n : 0;
            }
            return null;
        },

        /** The first carrier seen holding a guarded step with a `replan`, or blocks numbered at or below the rev before them (the turn reconciles from it), else null. */
        replansFrom() {
            return Number.isFinite(replanFrom) ? replanFrom : null;
        },

        /**
         * The guarded blocks whose recorded boundary (prefix hash) is not what the chat as it stands gives: [{ index, block }].
         * Empty after a Re-read or a reconcile that was staged right, and for a chat nobody edited; a reply edited since
         * its blocks were stored shows here too (its text is part of the prefix).
         */
        boundaryProblems() {
            const arr = list();
            const out = [];
            for (let i = 0; i < arr.length; i++) {
                const record = isCarrier(arr[i]) ? readRecord(arr[i]) : null;
                if (!record || !hasMeta(record)) continue;
                const before = chainHash(arr, i);
                const earlier = [];
                for (const part of blockParts(record)) {
                    if (isMetaSpan(part.span) && part.span.boundaries?.[0]) {
                        const expected = hashJson({ p: before, k: record.source?.swipeKey, t: payloadHashOf(arr[i]), b: blocksBefore(earlier) });
                        if (expected !== part.span.boundaries[0].prefixHash) out.push({ index: i, block: part.span.id });
                    }
                    earlier.push(part);
                }
            }
            return out;
        },

        /** The hash of the text of carrier `index`'s shown swipe as evidence (what a block's boundary recorded). */
        payloadHashAt(index) {
            const message = list()[index];
            return isCarrier(message) ? payloadHashOf(message) : null;
        },

        /**
         * Where the committed story ends (the timeline's head, contract §8): the cursor and the prefix hash a block
         * stored now would start at, so `{ cursor, prefixHash }` is exactly the boundary that block's span will carry
         * (apart from its own block id: `cursor.block` is the last block's on the head reply, or a stand-in worked out
         * from the position when it has none). `payloadHash` is the head reply's text as evidence; `source` its Source.
         * null without a carrier or a state. Nothing is written (a first record's id is only reserved, as sourceAt does).
         */
        boundary() {
            const arr = list();
            const index = lastCarrier(arr);
            if (index < 0) return null;
            const head = current();
            if (!head.state) return null;
            const message = arr[index];
            const record = readRecord(message);
            const sid = record ? record.sid : reservedSid(message);
            if (typeof sid !== 'string') return null;
            const entry = isObject(record?.source) ? record.source : sourceFor(arr, message, sid);
            const spans = record ? spansFor(record) : [];
            const parts = record ? blockParts({ ...record, spans, ops: record.ops }) : [];
            const op = record ? record.ops.length : 0;
            const last = [...spans].reverse().find(isMetaSpan);
            return {
                index,
                cursor: { sid: entry.logical, swipeKey: entry.swipeKey, block: last ? last.id : deriveId('bl', `end:${entry.swipeKey}:${op}`), op, rev: revOf(head.state) },
                prefixHash: hashJson({ p: chainHash(arr, index), k: entry.swipeKey, t: payloadHashOf(message), b: blocksBefore(parts) }),
                payloadHash: payloadHashOf(message),
                source: { sid: entry.logical, swipeKey: entry.swipeKey, evidence: entry.evidence, ordinal: Number.isInteger(entry.next) ? entry.next : 0 },
            };
        },

        // Only committed marker pins are projected. A skipped/failed/replaced root publishes none.
        timelineMarkers() {
            const state = current().state;
            const pins = state?.meta?.proofs ?? {};
            const out = [];
            const seen = new Set();
            for (const index of carrierIndexes(list())) {
                const record = readRecord(list()[index]);
                if (!record) continue;
                for (const span of record.spans ?? []) {
                    const prior = [];
                    for (const marker of span.clockBoundaries ?? []) {
                        if (markerProblem(marker) || pins[marker.proof] !== marker.pin || seen.has(marker.cursor.block)) continue;
                        seen.add(marker.cursor.block);
                        out.push({ ...structuredClone(marker), root: structuredClone(span.boundaries[0]), prior: [...prior] });
                        prior.push(marker.cursor.block);
                    }
                }
            }
            return out;
        },

        // Internal timeline witness. A native checkpoint belongs to this exact surviving prefix,
        // including the state its guards accepted. Never match by revision or by message index.
        prefixWitness(cursor) {
            const arr = list();
            const matches = carrierIndexes(arr).filter(index => {
                const source = api.sourceAt(index);
                return source?.sid === cursor.sid && source?.swipeKey === cursor.swipeKey;
            });
            if (matches.length !== 1) return null;
            const index = matches[0];
            const record = readRecord(arr[index]);
            if (!record || !Number.isSafeInteger(cursor.op) || cursor.op < 0) return null;
            const parts = blockParts(record);
            const earlier = [];
            let count = 0;
            for (const part of parts) {
                if (count === cursor.op) break;
                count += part.ops.length;
                earlier.push(part);
            }
            if (count !== cursor.op) return null;
            const base = baseFor(arr, index);
            if (!base) return null;
            const ops = earlier.flatMap(part => part.ops);
            const revs = new Set(ops.filter(op => op.path === '/meta/rev').map(op => op.value));
            const state = replayRecord(base, { ...record, ops, spans: earlier.map(part => ({ ...part.span, n: part.ops.length })), receipts: record.receipts.filter(receipt => revs.has(receipt.rev)) }, index, [], null, arr[index]);
            return {
                index, op: count, state,
                prefixHash: hashJson({ p: chainHash(arr, index), k: cursor.swipeKey, t: payloadHashOf(arr[index]), b: blocksBefore(earlier) }),
            };
        },

        /** Marks the chat as changed outside its records (the timeline's archive in the chat's metadata): the next save writes it. */
        touch() {
            saver.touch();
        },

        /**
         * The modules' lifecycle changed (a module turned ready or dormant, the `modules` event): the checkpoints over guarded
         * blocks that were made under other owners no longer hold (chain), so the head is replayed again from before them with
         * the guards asked, and only then does the caller publish a head. Guarded blocks before the checkpoint a replay would
         * start from are found by that replay. → true when the chat holds guarded blocks.
         */
        lifecycleChanged() {
            lastMark = markNow();
            cache = null;
            forgetMemos();
            current();
            return guardSeen;
        },

        /**
         * Tells the store how a guarded block is asked on replay (the command bus does this when it is made):
         * `check(state, { guard, source, block, operation, recorded })` → `{ ok: true } | { ok: false, reason }`
         * (a throw, a promise or any other answer fails closed), and `mark()` → text that changes when the
         * answer could (a module with a guard hook registered or went). The head is replayed again.
         */
        attachGuard(check, mark = null) {
            guardCheck = typeof check === 'function' ? check : null;
            guardMark = typeof mark === 'function' ? mark : null;
            lastMark = markNow();
            cache = null;
            forgetMemos();
        },

        // `block` (what the command bus hands over for a guarded transaction, REPLAY.md): { module, source, guard,
        // operation, recorded, result }. The host stamps the block id, the claims its ops make and the boundary
        // it starts at, and the record keeps all of it on the block's span, written together with the ops.
        append({ ops, receipt = null, block = null } = {}) {
            const arr = list();
            const index = lastCarrier(arr);
            if (index < 0) throw new Error('There is no reply in this chat to hold the change yet.');
            writable();
            const base = current().state;
            if (!base) throw new Error('This chat has no story state yet.');
            const added = asOps(ops);
            if (receipt !== null && !isObject(receipt)) throw new TypeError('A receipt must be an object.');
            if (block !== null && !isObject(block)) throw new TypeError('A block must be an object.');
            if (!added.length && !receipt) return;
            const clock = clockWriteProblem(block, added);
            if (clock) throw new Error(clock);
            if (added.some(touchesHostDomain) && !hostBlock(block?.module, block?.operation?.type)) throw new Error('The savepoints are the host\'s own; only its blocks write them.');
            if (block?.guard) {
                // A guard that replay would turn away (another epoch, other rules) is not stored: live and replay agree.
                const gate = gateProblem(base, block.guard);
                if (gate) throw new Error(`The guarded change cannot be stored: ${gate}.`);
            }
            const next = step(base, added);       // throws on a bad op: nothing is written
            const taken = take(arr, index, base);
            // (what a quarantined record would hold is never applied: a change put on it would be lost on the next replay)
            if (!taken.fresh && quarantined(taken.record)) throw new Error(`This reply's story record is kept as it is and nothing is added to it: ${ORPHAN}.`);
            const { message } = taken;
            const record = withSource(message, taken.record);
            if (typeof receipt?.id === 'string' && record.receipts.some(known => known?.id === receipt.id)) {
                throw new Error(`Receipt ${receipt.id} is already stored on this reply.`);
            }
            const spans = spansFor(record);
            const story = receipt?.cause === 'story';
            const span = block
                ? stamp(arr, index, record, block, added, receipt, blockParts({ ...record, spans, ops: record.ops }), record.ops.length)
                : null;
            if (span) guardHolds(base, span, message);
            write(message, {
                ...record,
                ops: [...record.ops, ...added],
                receipts: receipt ? [...record.receipts, structuredClone(receipt)] : record.receipts,
                spans: [...spans, { n: added.length, story, ...(span ?? {}) }],
                ...(span ? { source: advanced(record.source, [span]) } : {}),
                rev: revOf(next),
            });
            saver.touch();
            retain(arr, next, undefined, cache?.applied && span?.evidence?.length
                ? [...cache.applied, ...span.evidence.map(proof => Object.freeze({ proof, block: span.id, index }))] : undefined);
        },

        // The state a Re-read of carrier `index` runs its lines on: its own checkpoint when it starts
        // one, else the state after the carrier before it (null without one). Frozen.
        before(index) {
            const arr = list();
            const message = carrierAt(arr, index);
            return baseFor(arr, index);
        },

        // Re-read: the carrier's `story` receipts and their ops are replaced; ui and system receipts stay,
        // after the new story ops. A kept block whose rev (its `/meta/rev` op and its receipt) is not after
        // the new story ops' last one is numbered on from it, so no two receipts on the carrier share one.
        // A kept system step marked `replan` (its receipt's `replan: { payload }`, B-a1-13: planned from the
        // story state, like a story-time heal) is not applied again as it was: `rerun(state, receipt, { index,
        // span })` runs it again on the state as it now stands at its place (→ { ok, ops, receipt, block? });
        // when it is not done, its block goes. `settled` ([{ ops, receipt, block? }], system steps; SPEC §4.2
        // step 3): the reply's afterCapture steps as the Re-read ran them again after the new story lines.
        // They take the place of the kept blocks whose receipt is marked `afterCapture` and go right after
        // the new story ops, before the reader's actions; without `settled` such a block is kept as any other
        // system step. `blocks` ([{ n, block?, receipt }], one per story line, `n` its ops): what the lines'
        // guarded transactions handed over (REPLAY.md), so each of them is stored as a block of its own.
        // The kept blocks are replayed as a rebuild replays them (step with `replayed: true`): a guarded one
        // whose guard no longer holds stays stored and inactive instead of stopping the Re-read.
        // Later carriers are replayed on top so their checkpoints stay true (and their guarded system blocks
        // that carry a `replan` are planned again with `rerun`, REPLAY.md "Reconciling"); if any later change
        // no longer applies, nothing is written and this throws.
        replaceStory(index, { ops, receipts = [], rerun = null, settled = null, blocks: lines = null } = {}) {
            writable();
            const arr = list();
            const message = carrierAt(arr, index);
            if (!Array.isArray(receipts) || receipts.some(receipt => !isObject(receipt) || (receipt.cause !== 'story' && !(receipt.cause === 'system' && receipt.beforeGenerate === true)))) {
                throw new TypeError('Re-read takes story receipts and generated-reply preludes only.');
            }
            if (settled !== null && (!Array.isArray(settled) || settled.some(ran => !isObject(ran?.receipt) || ran.receipt.cause !== 'system'))) {
                throw new TypeError('Re-read\'s afterCapture steps are system steps, each { ops, receipt }.');
            }
            const before = stateBefore(arr, index);
            const base = baseFor(arr, index);
            if (!base) throw new Error('This chat has no story state yet.');
            const taken = take(arr, index, before).record;
            const record = withSource(message, taken);
            const spans = spansOf(record);
            if (!spans) throw new Error('The story changes on this reply cannot be told apart from the others.');
            // The kept blocks, each with its receipt when they line up one to one (every append stores one).
            const blocks = [];
            let at = 0;
            for (const span of spans) {
                if (!span.story) blocks.push({ ops: record.ops.slice(at, at + span.n), span });
                at += span.n;
            }
            let keptReceipts = record.receipts.filter(receipt => receipt?.cause !== 'story').map(receipt => structuredClone(receipt));
            // A quarantined record applies nothing and is not rewritten: decided on the record as stored, before the story
            // receipts are filtered out or anything is renumbered.
            if (quarantined(record)) throw new Error(`This reply's story record is kept as it is and not read again: ${ORPHAN}.`);
            const paired = keptReceipts.length === blocks.length;
            // The old afterCapture steps go when the Re-read ran them again (only told apart one to one).
            const resettle = Array.isArray(settled) && paired;
            if (resettle) {
                for (let n = blocks.length - 1; n >= 0; n -= 1) {
                    if (keptReceipts[n]?.afterCapture !== true) continue;
                    blocks.splice(n, 1);
                    keptReceipts.splice(n, 1);
                }
            }
            const fresh = asOps(ops);
            let state;
            const fail = error => new Error(`The new story changes and this reply's other changes do not fit together: ${error?.message ?? error}`);
            try {
                state = step(base, fresh);
            } catch (error) {
                throw fail(error);
            }
            // The kept blocks' revs follow the new story ops' last one (they ran after the old ones).
            let rev = [...fresh].reverse().find(op => op?.path === '/meta/rev' && Number.isInteger(op.value))?.value ?? revOf(base);
            const nextOps = [...fresh];
            const nextReceipts = [];
            const nextParts = [];     // [{ ops, span }] of the record being built, for the boundaries' prefix hashes
            // (the occurrences the blocks built so far hold, so a kept step that starts giving proof takes one nobody has)
            const keptAlloc = allocator(record, key => nextParts.reduce((most, part) => (occurrenceOf(part.span) !== null && spanOperationKey(part.span) === key ? Math.max(most, occurrenceOf(part.span) + 1) : most), 0));
            const storySpans = [];
            // The new story lines: each guarded one a block of its own, the others together as one (as before).
            const replacedIds = new Set(spans.filter(span => span.story && isMetaSpan(span)).map(span => span.id));
            const pieces = Array.isArray(lines) && lines.length && lines.every(piece => Number.isInteger(piece?.n) && piece.n >= 0)
                && lines.reduce((sum, piece) => sum + piece.n, 0) === fresh.length && lines.some(piece => piece.block || piece.receipt?.beforeGenerate === true) ? lines : null;
            if (pieces) {
                let offset = 0;
                let upTo = base;         // the state before the piece
                for (const piece of pieces) {
                    const own = fresh.slice(offset, offset + piece.n);
                    const story = piece.receipt?.beforeGenerate !== true;
                    if (piece.block) {
                        let span;
                        try {
                            span = { n: piece.n, story, ...stamp(arr, index, record, piece.block, own, piece.receipt, nextParts, offset) };
                            guardHolds(upTo, span, message);
                        } catch (error) {
                            throw fail(error);
                        }
                        publish(span, index);     // the lines applied to the state before this point
                        storySpans.push(span);
                        nextParts.push({ ops: own, span });
                    } else if (storySpans.length && storySpans.at(-1).story === story && !isMetaSpan(storySpans.at(-1))) {
                        storySpans.at(-1).n += piece.n;
                        nextParts.at(-1).ops = [...nextParts.at(-1).ops, ...own];
                    } else {
                        const span = { n: piece.n, story };
                        storySpans.push(span);
                        nextParts.push({ ops: own, span });
                    }
                    upTo = step(upTo, own);
                    offset += piece.n;
                }
            } else {
                const span = { n: fresh.length, story: true };
                storySpans.push(span);
                nextParts.push({ ops: fresh, span });
            }
            const keptSpans = [];
            const keptProblems = [];       // this reply's blocks that stay off (the checkpoints after it carry them)
            const moved = new Map();
            // The afterCapture steps run again, right after the new story ops (their revs follow them).
            for (const ran of resettle ? settled : []) {
                const blockOps = asOps(ran.ops);
                const before = state;
                try {
                    state = step(state, blockOps);
                } catch (error) {
                    throw fail(error);
                }
                const own = [...blockOps].reverse().find(op => op?.path === '/meta/rev' && Number.isInteger(op.value))?.value;
                if (Number.isInteger(own)) rev = Math.max(rev, own);
                let span = { n: blockOps.length, story: false };
                if (ran.block) {
                    try {
                        span = { ...span, ...stamp(arr, index, record, ran.block, blockOps, ran.receipt, nextParts, nextOps.length) };
                        guardHolds(before, span, message);
                        publish(span, index);     // applied (step above)
                    } catch (error) {
                        throw fail(error);
                    }
                }
                nextOps.push(...blockOps);
                keptSpans.push(span);
                nextParts.push({ ops: blockOps, span });
                nextReceipts.push(structuredClone(ran.receipt));
            }
            for (const [n, { ops: block, span: was }] of blocks.entries()) {
                const receipt = paired ? keptReceipts[n] : null;
                // A reply-bound block goes when its reply is read again, its receipt with it (as a delete or a swipe takes it);
                // what was built on it is replayed below without it.
                if (was.guard?.replyBound === true) {
                    if (!paired) for (const gone of receiptsFor({ receipts: keptReceipts }, block)) keptReceipts.splice(keptReceipts.indexOf(gone), 1);
                    continue;
                }
                let blockOps;
                let kept = receipt;
                let again = null;      // the block as planned again, when it was
                const asks = typeof rerun === 'function' && !(isMetaSpan(was) && intactReason(record, block, was, receipt)) && ((isMetaSpan(was) && was.guard && was.replan && receipt) || (receipt?.replan && !isGuardedBlock(was, paired ? receipt : receiptsFor({ receipts: keptReceipts }, block))));
                if (asks) {
                    let out = null;
                    try { out = rerunBlock(rerun, state, receipt, index, was, nextParts, keptAlloc); } catch { out = null; }
                    // A guarded step goes only when its owner says it is no longer done; when it cannot be asked it stays.
                    if (!out?.ok && isMetaSpan(was) && !(out?.ok === false && out.code === NO_LONGER_DONE)) {
                        // (it could not be asked: the block stays exactly as it was, replayed below as any kept block is)
                    } else if (!out?.ok) continue;
                    else if (ownedAlready(state, out.block?.evidence)) {
                        // (it would give a proof id a block that applied already owns: refused; the block stays as it was, replayed below)
                    } else {
                        again = out;
                        blockOps = asOps(out.ops);
                        kept = { ...structuredClone(out.receipt), id: receipt.id, ...(receipt.beforeGenerate === true ? { beforeGenerate: true } : {}) };
                        const own = [...blockOps].reverse().find(op => op?.path === '/meta/rev' && Number.isInteger(op.value))?.value;
                        if (Number.isInteger(own)) rev = Math.max(rev, own);
                    }
                }
                if (!again) {
                    blockOps = block.map(op => {
                        if (op?.path !== '/meta/rev' || !Number.isInteger(op.value)) return op;
                        if (op.value > rev) {
                            rev = op.value;   // already after the new story ops: kept as it is
                            return op;
                        }
                        rev += 1;
                        moved.set(op.value, rev);
                        return { ...op, value: rev };
                    });
                }
                // A kept guarded block is asked again here (its guard may not hold on the new story): then
                // it stays stored and inactive. A block planned again is applied as a live command is.
                const meta = isMetaSpan(was);
                const heldBy = state;     // the state before this block
                const guarded = isGuardedBlock(was, paired ? receipt : receiptsFor({ receipts: keptReceipts }, block));       // (the one classifier: a stripped span is still a guarded block)
                let applied = true;      // the block applied: only then is its proof the guards' to see
                try {
                    state = again ? step(state, blockOps) : guarded ? replayGuarded(state, record, blockOps, was, message, receipt) : replayLegacy(state, blockOps);
                } catch (error) {
                    if (!guarded || again) throw fail(error);
                    applied = false;
                    state = skipped(state, blockOps);
                    keptProblems.push({ index, block: storySpans.filter(each => each.n).length + keptSpans.filter(each => each.n).length, receipts: receiptsOf({ receipts: keptReceipts }, block), why: String(error?.message ?? error), code: 'REPLAY_PREREQUISITE' });
                }
                let span = { n: blockOps.length, story: false };
                try {
                    if (again?.block) {
                        span = { ...span, ...stamp(arr, index, record, { ...again.block, ...(meta ? { id: was.id, source: { ...again.block.source, ordinal: was.source.ordinal } } : {}) }, blockOps, kept, nextParts, nextOps.length) };
                        guardHolds(heldBy, span, message);
                    } else if (meta && !again) {
                        if (intactReason(record, block, was, receipt)) {
                            // Not intact (damaged, another reply's, claims that are not its changes'): it stays exactly as stored, inactive.
                            span = { ...was, n: blockOps.length };
                        } else {
                            // A Re-read moves a kept block's position and nothing else: its cursor and prefix hash follow where it stands now,
                            // but its payload hash, evidence, claims, guard, source and results are the ones it was stored with.
                            const placed = stamp(arr, index, record, { module: was.module, source: was.source, guard: was.guard, operation: was.operation, recorded: was.recorded, result: was.result, evidence: was.evidence, occurrence: was.occurrence, id: was.id }, blockOps, kept, nextParts, nextOps.length);
                            span = { ...was, n: blockOps.length, story: false,
                                boundaries: was.boundaries.map((boundary, at) => (at === 0 ? { ...boundary, cursor: placed.boundaries[0].cursor, prefixHash: placed.boundaries[0].prefixHash } : boundary)) };
                        }
                    }
                } catch (error) {
                    throw fail(error);
                }
                if (applied) publish(span, index);
                nextOps.push(...blockOps);
                keptSpans.push(span);
                nextParts.push({ ops: blockOps, span });
                if (kept) nextReceipts.push(kept);
            }
            // Every kept receipt follows its ops through every rev they moved to (once: by the rev it had), the guarded one too.
            for (const receipt of keptReceipts) if (moved.has(receipt.rev)) receipt.rev = moved.get(receipt.rev);
            if (!paired) nextReceipts.push(...keptReceipts);
            const allSpans = [...storySpans, ...keptSpans];
            const rewritten = {
                ...record,
                ops: nextOps,
                receipts: [...structuredClone(receipts), ...nextReceipts],
                spans: allSpans,
                source: advanced(record.source, allSpans),
                rev: revOf(state),
            };
            const writes = [[message, rewritten]];
            // Later blocks that were already skipped stay skipped (a guarded block that is inactive is asked again);
            // one that applied before must still apply.
            const prior = [...replay(arr, index - 1).problems.filter(problem => problem.index < index), ...keptProblems];
            const walked = walkSuffix(arr, state, index + 1, { rerun, overlay: new Map([[index, rewritten]]), prior });
            writes.push(...walked.writes);
            for (const [target, next] of writes) write(target, next);
            saver.touch();
            forgetMemos();
            cache = null;   // rebuilt on the next read, with the blocks that stay skipped reported
        },

        // Plans the guarded system blocks that carry a `replan` again, from carrier `index` to the head, on the
        // state as it stands at each one's place (REPLAY.md "Reconciling"): after a swipe, a delete or a
        // rollback changed what they depended on. `rerun(state, receipt, { index, span })` is as in replaceStory
        // (→ { ok, ops, receipt, block? }). All or nothing: the old ops, claims and receipts of a block are
        // removed as the new ones are put in, or the block goes when it is not done any more; a later change
        // that no longer applies throws and nothing is written. → { changed: boolean }.
        reconcile(index, { rerun = null } = {}) {
            writable();
            const arr = list();
            const message = carrierAt(arr, index);
            if (typeof rerun !== 'function') return { changed: false, planned: 0, removed: 0 };
            const base = baseFor(arr, index);
            if (!base) throw new Error('This chat has no story state yet.');
            const walked = walkSuffix(arr, base, index, { rerun, overlay: new Map() });
            if (!walked.any) return { changed: false, planned: 0, removed: 0 };
            for (const [target, next] of walked.writes) write(target, next);
            saver.touch();
            forgetMemos();
            cache = null;
            return { changed: true, planned: walked.planned, removed: walked.removed };
        },

        setNarrated(index, ids) {
            if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) {
                throw new TypeError('Narrated receipts must be a list of receipt IDs.');
            }
            writable();
            const arr = list();
            const head = current();
            const atHead = index === head.key.index;
            const { message, record, fresh } = take(arr, index, atHead ? head.state : undefined);
            const rev = fresh ? revOf(atHead ? head.state : stateBefore(arr, index)) : record.rev;
            write(message, { ...record, narrated: [...new Set(ids)], ...(rev === undefined ? {} : { rev }) });
            saver.touch();
            if (atHead) retain(arr, head.state, head.problems);
        },

        // Every stored receipt on the current line of history, in chat order: [{ index, receipt }]
        // (the carriers the head is built from; frozen copies).
        receipts() {
            const arr = list();
            const memo = lineOf(arr);
            if (memo.receipts) return memo.receipts;
            counts.lineScans++;
            const out = [];
            let started = false;
            for (const i of carrierIndexes(arr)) {
                const record = readRecord(arr[i]);
                if (record?.checkpoint) started = true;
                if (!started || !record) continue;
                for (const receipt of frozenReceipts(record)) out.push(Object.freeze({ index: i, receipt }));
            }
            memo.receipts = Object.freeze(out);
            return memo.receipts;
        },

        // Return in time (MODULES §F17): drops the head carrier's receipts with rev >= beforeRev and
        // their ops, so the head is the state just before the first of them. Each receipt's ops end with
        // its `/meta/rev` op, which is where they are cut. Only the head carrier (nothing after it holds
        // state that depends on it). Returns { dropped: receipt ids, rev }.
        // `{ dryRun: true, chat? }` works it all out and writes nothing, on `chat` (messages, default the
        // chat) if given: rewind asks it on the messages its branch will hold before it branches.
        truncate(index, beforeRev, { dryRun = false, chat: messages = null } = {}) {
            if (!dryRun) writable();
            const arr = dryRun && Array.isArray(messages) ? messages : list();
            if (index !== lastCarrier(arr)) throw new RangeError(`Message ${index} is not the last reply that keeps the story, so its changes cannot be taken back alone.`);
            if (!Number.isInteger(beforeRev) || beforeRev < 1) throw new TypeError('beforeRev must be a whole number of 1 or more.');
            const message = carrierAt(arr, index);
            const record = readRecord(message);
            if (!record) return { dropped: [], rev: revOf(arr === list() ? current().state : stateBefore(arr, index + 1)) };
            if (quarantined(record)) throw new Error(`This reply's story record cannot be cut down: ${ORPHAN}.`);
            const chunks = [];
            let start = 0;
            record.ops.forEach((op, at) => {
                if (op?.path === '/meta/rev') {
                    chunks.push({ ops: record.ops.slice(start, at + 1), rev: op.value });
                    start = at + 1;
                }
            });
            if (start < record.ops.length) chunks.push({ ops: record.ops.slice(start), rev: null });
            const cut = chunks.findIndex(chunk => chunk.rev === null || chunk.rev >= beforeRev);
            const kept = cut < 0 ? chunks : chunks.slice(0, cut);
            const keptRevs = new Set(kept.map(chunk => chunk.rev));
            const receipts = record.receipts.filter(receipt => keptRevs.has(receipt?.rev));
            const dropped = record.receipts.filter(receipt => !keptRevs.has(receipt?.rev)).map(receipt => receipt?.id);
            const base = baseFor(arr, index);
            if (!base) throw new Error('This chat has no story state yet.');
            const ops = kept.flatMap(chunk => chunk.ops);
            const byRev = new Map(receipts.map(receipt => [receipt.rev, receipt]));
            // A kept block that was a guarded one keeps its span's record (id, guard, claims, …).
            const was = new Map();
            let from = 0;
            for (const span of spansFor(record)) {
                if (isMetaSpan(span)) was.set(`${from}:${span.n}`, span);
                from += span.n;
            }
            let offset = 0;
            const spans = kept.map(chunk => {
                const old = was.get(`${offset}:${chunk.ops.length}`);
                offset += chunk.ops.length;
                return { ...(old ?? {}), n: chunk.ops.length, story: byRev.get(chunk.rev)?.cause === 'story' };
            });
            // C1-3: the kept changes are replayed as a rebuild replays them (block by block, by the
            // replay rules: a remove of what a deleted reply added is passed over), so a chat that
            // replays fine is not refused. A kept block that still does not apply refuses the rewind.
            const problems = [];
            const earlier = (dryRun ? [] : current().problems).filter(problem => problem.index < index);     // (read before anything is written)
            const state = replayRecord(base, { ...record, ops, spans, receipts }, index, problems, null, message);
            // (a guarded block whose guard no longer holds stays stored and inactive; it does not refuse)
            const refusing = problems.filter(problem => problem.code !== 'REPLAY_PREREQUISITE');
            if (refusing.length) throw new Error(refusing[0].why);
            if (dryRun) return { dropped, rev: revOf(state) };
            write(message, {
                ...record,
                ops,
                receipts,
                spans,
                narrated: record.narrated.filter(id => !dropped.includes(id)),
                rev: revOf(state),
            });
            saver.touch();
            // Only this carrier was rewritten: earlier problems stay, and so do those of its kept blocks that are off.
            retain(arr, state, [...earlier, ...problems], null);
            return { dropped, rev: revOf(state) };
        },

        untold() {
            const arr = list();
            const memo = lineOf(arr);
            if (memo.untold) return memo.untold;
            counts.lineScans++;
            const records = [];
            for (const i of carrierIndexes(arr)) {
                const record = readRecord(arr[i]);
                if (record?.checkpoint || (records.length && record)) records.push(record);
            }
            const told = new Set();
            const out = [];
            for (let r = records.length - 1; r >= 0; r--) {
                for (const id of records[r].narrated) told.add(id);
                const receipts = records[r].receipts;
                for (let k = receipts.length - 1; k >= 0; k--) {
                    if (receipts[k]?.narrate === true && !told.has(receipts[k].id)) out.push(receipts[k]);
                }
            }
            memo.untold = deepFreeze(structuredClone(out.reverse()));
            return memo.untold;
        },

        /**
         * How much replay work the store has done (for tests that count work rather than time): `replays`
         * (state rebuilt from a checkpoint), `recordsRead` (carriers replayed), `lineScans` (whole-chat
         * passes for receipts or untold). A copy.
         */
        work() {
            return { ...counts };
        },

        rebuild() {
            frozenCheckpoints = new WeakMap();
            const previous = idIndex;
            idIndex = null;
            cache = null;
            forgetMemos();
            // The record copies and old receipts are settled over the whole chat, and a record whose
            // swipe moved is stamped again (settleAll).
            if (settleAll(list())) saver.touch();
            // Ids this session knew of this chat that are no longer in it were deleted: they are archived. The index is
            // (re)built on every rebuild, so what is there now is the baseline of the next one (a store just opened over
            // saved records has one from its first rebuild); another chat's ids are never carried over.
            const now = idsOf(list());
            if (previous && previous.arr === list() && previous.chat === now.chat) bury2(previous, now);
            current();
        },

        /** Is this canonical sid, swipe key or evidence id archived (its reply or swipe was deleted)? It confers no eligibility. */
        archived(id) {
            return archive().has(id);
        },
        /** The archive: the ids that were deleted, sorted. */
        archiveList() {
            return [...archive()].sort();
        },

        // Runs `fn` (it may be async) with the swipe_info copies of every record it writes held back,
        // then copies each once: a reply's change lines are stored one by one (each must apply on its
        // own), but a long block is not copied once per line (B1-1).
        async batch(fn) {
            holding += 1;
            try {
                return await fn();
            } finally {
                holding -= 1;
                if (!holding) {
                    // The copies are written again as they are: a head cached before stays the head.
                    const arr = list();
                    const kept = cache && sameKey(cache.key, headKey(arr)) ? cache : null;
                    for (const message of held) {
                        const record = message.extra?.[KEY];
                        if (!record) continue;
                        if (keeps(message, arr)) writeRecord(message, record);
                        else dropCopy(message);
                    }
                    held.clear();
                    if (kept) retain(arr, kept.state, kept.problems);
                }
            }
        },

        /**
         * B-b2-timeline-r2-2: chat `from` was renamed `to` (SillyTavern's CHAT_RENAMED). A change not yet
         * saved, or left for its old chat's file, goes into the renamed chat's file instead: the old one
         * is gone, and a renamed open chat is read back as new messages, which looks like another chat.
         */
        renamed(from, to) {
            if (typeof from !== 'string' || typeof to !== 'string' || !from || !to || from === to) return false;
            let moved = saver.renamed(from, to);
            for (const entry of unsaved.values()) {
                if (entry.chatId !== from) continue;
                entry.chatId = to;
                moved = true;
            }
            if (moved && saver.dirty()) saver.schedule();
            return moved;
        },

        scheduleSave(ms = 400) { saver.schedule(ms); },
        /**
         * Puts off a save that was only scheduled (not one already running): the turn's cues before a reply
         * are saved with the reply's own save, one write of the chat file instead of two. The change stays
         * dirty; the caller saves it (or schedules it again) when the reply comes or the generation ends.
         */
        deferSave() { saver.defer(); },
        /**
         * The turn's save (docs/v2/PERFORMANCE.md, "Long chats"): the reply's capture and the reader's actions
         * after it are written once, a moment after the last of them (persist.js IDLE_MS, at most IDLE_MAX_MS
         * after the first). Only where a change left behind by a chat switch can still be put into its own
         * chat's file (a chat file and `rescue`): then → true. Elsewhere (no chat file this page can write,
         * e.g. a temporary chat) → false, and the caller saves at once as before.
         */
        saveIdle(wait, max) {
            let where = null;
            try { where = typeof rescue === 'function' ? place() : null; } catch { where = null; }
            if (!where) return false;
            saver.idle(wait, max);
            return true;
        },
        /** True when changes are saved by the turn's idle save here (see saveIdle). */
        idleSaves() {
            try { return typeof rescue === 'function' && !!place(); } catch { return false; }
        },
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
            const outer = walkProofs;
            walkProofs = new Map();
            try { return inner.apply(api, args); } finally { walkProofs = outer; }
        };
    }
    return api;
}
