// Story Suite v2: proof and evidence (docs/v2/EVIDENCE.md, contract §6 "Proof submission" and "story.evidence").
//
// A module that owns a kind of proof (Story Director: visit, acceptance, event) calls `ctx.proof({ kind, payload, parents? })` inside a command. The host checks who is asking, what
// the payload is and what the reader really said, stamps the id, the Source and the payload hash, keeps the
// proof on the span of the block the command makes (`span.evidence`) and pins it in the state
// (`meta.proofs[id]`, written by the same ops as the block). The pin is what makes a proof ACTIVE: a block
// that does not apply, a reply that was deleted or a swipe that is not shown leave no pin, so the proof is
// not there. `story.evidence` shows a proof only while its bytes still match its pin, its owner and kind
// still match the table below, its payload is still closed and well formed, and every parent is visible too.
//
// This file is pure: it reads no chat and no registry. The command bus (commands.js) calls `submitProof`, the
// store (store.js) calls `recordEntries` and `evidenceProblem`, and `createEvidenceQuery` is the query the
// core module registers.

import { isId } from './check.js';
import { escapeKey, parsePath } from './ops.js';
import { canonicalJson, hashJson, idFromHash, isRecordId, sha256, sourceProblem, spanProblem } from './replay.js';

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const utf8 = new TextEncoder();

/** Who may give each kind of proof (contract §6): the module id that owns it. */
export const OWNERS = Object.freeze({
    visit: 'story-director', acceptance: 'story-director', event: 'story-director',
});
export const KINDS = Object.freeze(Object.keys(OWNERS));
export const STATS = Object.freeze(['STR', 'VIT', 'AGI', 'DEX', 'INT', 'LUK', 'CHA']);

/** The structural caps; the contract names none, so these are the host's (EVIDENCE.md "Caps"). */
export const LIMITS = Object.freeze({
    opaqueBytes: 4096,     // a payload the contract leaves to B3/B6 (normalized JSON, UTF-8 bytes)
    selection: 120,        // code points of an acceptance's `selection`
    words: 240,            // code points of an acceptance's `words`
    parents: 8,            // parents of one proof
    perRoot: 32,           // proofs one command (its root transaction) may give
    ids: 500,              // ids one story.evidence call may ask for
});

const PROOF_KEYS = ['id', 'source', 'owner', 'kind', 'payload', 'payloadHash', 'parents'];
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

// ---------- payloads ----------

// Plain text: nothing at the ends, no control characters, 1..max code points.
const textProblem = (value, max) => {
    if (typeof value !== 'string' || !value) return 'is text';
    if (value.trim() !== value) return 'has no space at either end';
    if (CONTROL.test(value)) return 'has no control characters';
    if ([...value].length > max) return `is at most ${max} characters`;
    return '';
};

const exactKeys = (payload, keys) => Object.keys(payload).length === keys.length && keys.every(key => Object.hasOwn(payload, key));

/** An acceptance (contract §6): `{ thread, selection }` (the reader's pick) or `{ thread, words }` (what they said). */
function acceptanceProblem(payload) {
    if (!isRecordId(payload.thread)) return 'its thread is a record id like th_k3f9a2qz';
    const keys = Object.keys(payload).filter(key => key !== 'thread');
    if (keys.length !== 1 || (keys[0] !== 'selection' && keys[0] !== 'words')) return 'it names its thread and either a selection or the reader\'s words, nothing else';
    const why = textProblem(payload[keys[0]], keys[0] === 'selection' ? LIMITS.selection : LIMITS.words);
    return why ? `its ${keys[0]} ${why}` : '';
}

/** The check Story Director asks evidence for (contract §6): `{ check, actor, stat, dc }`, an `event` proof. */
function checkProblem(payload) {
    if (!exactKeys(payload, ['check', 'actor', 'stat', 'dc'])) return 'a check is { check, actor, stat, dc } and nothing else';
    if (!isRecordId(payload.check)) return 'its check is a record id';
    if (!isId(payload.actor)) return 'its actor is an id';
    if (!STATS.includes(payload.stat)) return `its stat is one of ${STATS.join(', ')}`;
    if (!Number.isInteger(payload.dc) || payload.dc < 1 || payload.dc > 40) return 'its dc is a whole number from 1 to 40';
    return '';
}

// A payload the contract leaves to a later package (B3/B6, Story Director's own events and visits): any plain
// JSON object, not empty, within the byte cap. Whether it means anything is its owner's to check.
function opaqueProblem(json, payload) {
    if (!Object.keys(payload).length) return 'it has nothing in it';
    if (utf8.encode(json).length > LIMITS.opaqueBytes) return `it is more than ${LIMITS.opaqueBytes} bytes`;
    return '';
}

const MAX_DEPTH = 64;

// '' when `value` is a tree that JSON can hold as it is: no list with a hole ([1, , 3] would come back as null), no
// object that contains itself, nothing nested deeper than MAX_DEPTH; else why not.
function structureProblem(value, ancestors = new Set(), depth = 0) {
    if (!value || typeof value !== 'object') return '';
    if (depth > MAX_DEPTH) return `it is nested more than ${MAX_DEPTH} levels deep`;
    if (ancestors.has(value)) return 'it contains itself';
    ancestors.add(value);
    let found = '';
    if (Array.isArray(value)) {
        for (let at = 0; at < value.length && !found; at += 1) {
            found = !(at in value) ? 'it has a list with a gap in it' : structureProblem(value[at], ancestors, depth + 1);
        }
    } else {
        for (const item of Object.values(value)) {
            found = structureProblem(item, ancestors, depth + 1);
            if (found) break;
        }
    }
    ancestors.delete(value);
    return found;
}

/**
 * { problem, json }: '' when `payload` is a closed payload for `kind`, else why not (structure only: intent is
 * `intentProblem`), and its normalized JSON (what its hash is taken of) when it is plain JSON.
 */
function payloadCheck(kind, payload) {
    if (!isObject(payload)) return { problem: 'its payload is a plain JSON record', json: '' };
    const shape = structureProblem(payload);
    if (shape) return { problem: `its payload is plain JSON, and ${shape}`, json: '' };
    let json = '';
    try { json = canonicalJson(payload); } catch { json = ''; }
    if (!json) return { problem: 'its payload is a plain JSON record', json: '' };
    if (kind === 'acceptance') return { problem: acceptanceProblem(payload), json };
    if (kind === 'event' && Object.hasOwn(payload, 'check')) return { problem: checkProblem(payload), json };
    return { problem: opaqueProblem(json, payload), json };
}

/** '' when `payload` is a closed payload for `kind`, else why not. */
export const payloadProblem = (kind, payload) => payloadCheck(kind, payload).problem;

/**
 * What names a proof inside one root (contract §6: the same key with a changed payload is a CONFLICT): an
 * acceptance is its thread, a check is its check id; a payload nobody shaped is its own key, so a different
 * payload is simply another proof.
 */
export function payloadKey(kind, payload) {
    if (kind === 'acceptance') return `thread:${payload.thread}`;
    if (kind === 'event' && Object.hasOwn(payload, 'check')) return `check:${payload.check}`;
    return `payload:${hashJson(payload)}`;
}

// Folded for comparing: Unicode compatibility form, one space between words, lower case.
const fold = text => String(text ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
// The end marks of a sentence, and what may stand at a sentence's ends without being part of it (quotes, commas, dashes).
const SENTENCE_END = /[.!?\u2026\u3002\uff01\uff1f;\n\r]+/u;
const EDGE = /^[\s"'\u201c\u201d\u2018\u2019\u00ab\u00bb.!?\u2026\u3002\uff01\uff1f,:;\-\u2013\u2014()[\]*_~]+|[\s"'\u201c\u201d\u2018\u2019\u00ab\u00bb.!?\u2026\u3002\uff01\uff1f,:;\-\u2013\u2014()[\]*_~]+$/gu;
const core = text => fold(text).replace(EDGE, '');

/**
 * The sentences of the reader's message, folded and without their edges: the text cut at . ! ? … ; and line breaks.
 * A comma does not end one ("Sure, I accept the job" is one sentence).
 */
export function sentences(text) {
    // Cut first (a line break is a sentence end), then fold each piece: folding first would turn the break into a space.
    return String(text ?? '').normalize('NFKC').split(SENTENCE_END).map(piece => fold(piece).replace(EDGE, '')).filter(Boolean);
}

/**
 * '' when the host saw the reader's intent the proof claims, else why not (REFUSED). An acceptance by
 * `selection` is the reader's own action in a screen (cause `ui`). One by `words` must be a whole sentence of the
 * reader's message the host gave this reply (`chat.lastUser`: the message right before the reply), after folding
 * case, spacing and the marks at its ends, and at least two words: a piece of a sentence ("take it" out of "I will
 * not take it"), one word ("No") or text only the narration (`chat.reply`) says is REFUSED. The host proves
 * quoting, not meaning: whether the quoted sentence accepts is the owner's to judge.
 */
export function intentProblem(kind, payload, { cause, chat }) {
    if (kind !== 'acceptance') return '';
    if (Object.hasOwn(payload, 'selection')) {
        return cause === 'ui' ? '' : 'a selection is the reader\'s own pick in a screen, and this did not come from one';
    }
    const spoken = sentences(chat?.lastUser);
    if (!chat || !spoken.length) return 'the host saw no message from the reader for this reply, and narration cannot accept for them';
    const quoted = core(payload.words);
    if (quoted.split(' ').length < 2) return 'the reader\'s words are at least two words';
    return spoken.includes(quoted) ? '' : 'the words are not a whole sentence of the reader\'s message the host saw (narration cannot accept for the reader, and a piece of a sentence is not what they said)';
}

// ---------- stored proofs ----------

/** '' when `proof` is a whole, closed Proof of an owner that may give its kind, else why not. */
export function proofProblem(proof) {
    if (!isObject(proof) || !exactKeys(proof, PROOF_KEYS)) return 'a proof is { id, source, owner, kind, payload, payloadHash, parents } and nothing else';
    if (!isRecordId(proof.id) || !proof.id.startsWith('pf_')) return 'its id is pf_xxxxxxxx';
    const source = sourceProblem(proof.source);
    if (source) return source;
    if (typeof proof.kind !== 'string' || !Object.hasOwn(OWNERS, proof.kind)) return `"${proof.kind}" is not a kind of proof`;
    if (proof.owner !== OWNERS[proof.kind]) return `${proof.owner} does not own "${proof.kind}" proof`;
    const { problem, json } = payloadCheck(proof.kind, proof.payload);
    if (problem) return problem;
    if (proof.payloadHash !== sha256(json)) return 'its payload hash is not its payload\'s';
    if (!Array.isArray(proof.parents) || proof.parents.length > LIMITS.parents || new Set(proof.parents).size !== proof.parents.length
        || !proof.parents.every(id => isRecordId(id) && id !== proof.id)) return 'its parents are a short list of other proof ids';
    return '';
}

/**
 * The pin of a proof in `meta.proofs`: the SHA-256 of its id, kind, owner and payload hash and each parent's pin as the
 * state holds it (one line each). A proof whose kind or owner was changed, or a parent given again with other bytes (an edit, a
 * Re-read), no longer matches the pin it was committed with, and what was built on it is hidden with it.
 */
export function pinOf(proof, pins) {
    let text = `pin\n${proof.id}\n${proof.kind}\n${proof.owner}\n${proof.payloadHash}`;
    for (const id of proof.parents) text += `\n${id}=${typeof pins?.[id] === 'string' ? pins[id] : ''}`;
    return sha256(text);
}

/** What a block's proof is, for the hashes that say whether a block is the one it was (ids, kinds, owners, payload hashes, parents). */
export const evidenceDigest = evidence => (Array.isArray(evidence) && evidence.length
    ? evidence.map(proof => [proof?.id, proof?.kind, proof?.owner, proof?.payloadHash, proof?.parents ?? null])
    : null);

/** The receipt's short form of the proof a command gave: its id, kind and payload hash (the span holds the bytes). */
export const receiptEvidence = proofs => proofs.map(({ id, kind, payloadHash }) => ({ id, kind, payloadHash }));

const pinsOf = state => (isObject(state?.meta?.proofs) ? state.meta.proofs : {});

const unescapeKey = key => key.replace(/~1/g, '/').replace(/~0/g, '~');

/**
 * The pins a list of ops writes under `/meta/proofs`: Map id → pin (null when it is not text). One add or
 * replace of the whole record counts, as claimKeys counts claims; removals do not.
 */
export function proofPins(ops) {
    const out = new Map();
    for (const op of Array.isArray(ops) ? ops : []) {
        if (!isObject(op) || (op.op !== 'add' && op.op !== 'replace') || typeof op.path !== 'string') continue;
        if (op.path === '/meta/proofs') {
            if (isObject(op.value)) for (const [id, pin] of Object.entries(op.value)) out.set(id, typeof pin === 'string' ? pin : null);
        } else if (op.path.startsWith('/meta/proofs/') && !op.path.slice(13).includes('/')) {
            out.set(unescapeKey(op.path.slice(13)), typeof op.value === 'string' ? op.value : null);
        }
    }
    return out;
}

/**
 * A block's ops as they are applied on replay: the record `meta.proofs` is made when the state has none, and a
 * write of the whole record (the first proof of a chat makes one) becomes a write per id, so a block that
 * stays never wipes the pins of the ones before it (a Re-read puts new lines ahead of blocks it keeps), and one
 * whose first-proof block is gone still finds its record.
 */
export function pinOps(state, ops) {
    const out = [];
    let there = isObject(state?.meta?.proofs);
    const make = () => {
        if (!there) out.push({ op: 'add', path: '/meta/proofs', value: {} });
        there = true;
    };
    for (const op of ops) {
        const whole = isObject(op) && op.path === '/meta/proofs' && (op.op === 'add' || op.op === 'replace') && isObject(op.value);
        if (whole) {
            make();
            for (const [id, pin] of Object.entries(op.value)) out.push({ op: 'add', path: `/meta/proofs/${escapeKey(id)}`, value: pin });
        } else {
            if (isObject(op) && typeof op.path === 'string' && op.path.startsWith('/meta/proofs/')) make();
            out.push(op);
        }
    }
    return out;
}

/**
 * True when `path` reaches `branch` (a list of keys): it names the branch, something below it, or something that holds it, any
 * ancestor up to the document root. A path that cannot be read counts, since nothing can say it does not; no path (`undefined`) does not.
 * The rule for every record only some blocks may write (the proof pins here, the host's savepoints in the store).
 */
export function reachesBranch(path, branch) {
    if (path === undefined) return false;
    let keys;
    try { keys = parsePath(path); } catch { return true; }
    for (let at = 0; at < Math.min(keys.length, branch.length); at++) if (keys[at] !== branch[at]) return false;
    return true;
}

const PROOF_BRANCH = ['meta', 'proofs'];

// The keys of an op's path (or `from`) when it names the state's proof record or something that holds it: the document
// root, `/meta`, `/meta/proofs` or anything under it. An unreadable path counts, since nothing can say it does not.
function touchedKeys(path) {
    if (!reachesBranch(path, PROOF_BRANCH)) return null;
    try { return parsePath(path); } catch { return []; }
}

/** True when `op` changes the record of proof pins, or something that holds it (the root, /meta, /meta/proofs, below it): any op, add, replace, remove, move or copy, whole or empty. */
export const touchesProof = op => !isObject(op) || touchedKeys(op.path) !== null || touchedKeys(op.from) !== null;

/**
 * '' when the only changes `ops` make to the record of proof pins are the pins of `owned` (a Set of proof ids): a pin
 * added (or replaced) under its own id, or the whole record written with just those. Anything else that touches it
 * (an erase, a rewrite of /meta or of the root, a pin that is not its own, a move or a copy) is why not. `erases`: the
 * host's restore may also erase single pins.
 */
export function proofWriteProblem(ops, owned, { erases = false } = {}) {
    for (const op of Array.isArray(ops) ? ops : []) {
        if (!touchesProof(op)) continue;
        if (!isObject(op)) return 'a change of the block is not a change at all';
        const keys = touchedKeys(op.path);
        const writes = isObject(op) && (op.op === 'add' || op.op === 'replace') && op.from === undefined && keys !== null;
        if (writes && keys.length === 3 && keys[1] === 'proofs' && owned.has(keys[2]) && typeof op.value === 'string') continue;
        // The host's restore (docs/v2/TIMELINE.md) takes back the pins the faded story gave: an erase of one pin, nothing more.
        if (erases && isObject(op) && op.op === 'remove' && op.from === undefined && keys !== null && keys.length === 3 && keys[1] === 'proofs') continue;
        if (writes && keys.length === 2 && keys[1] === 'proofs' && isObject(op.value) && Object.keys(op.value).length > 0 && Object.entries(op.value).every(([id, pin]) => owned.has(id) && typeof pin === 'string')) continue;
        return `it changes the record of proof pins in a way a block cannot (${isObject(op) ? `${op.op} ${op.path ?? ''}` : 'an unreadable change'})`;
    }
    return '';
}

const KNOWN_OPS = ['add', 'replace', 'remove'];

/**
 * '' when every change of `ops` is a change the state knows: an object with add, replace or remove, a path that reads, and
 * a value where it adds or replaces. A block with a change that is not one is not applied and gives no proof.
 */
export function opShapeProblem(ops) {
    if (!Array.isArray(ops)) return 'its changes are not a list';
    for (const op of ops) {
        if (!isObject(op) || !KNOWN_OPS.includes(op.op) || typeof op.path !== 'string') return 'a change of the block is not an add, replace or remove with a path';
        // (a plain path with no escapes reads as it is)
        if (op.path !== '' && (op.path[0] !== '/' || op.path.includes('~'))) {
            try { parsePath(op.path); } catch { return 'a change of the block has a path that cannot be read'; }
        }
        if (op.op !== 'remove' && !Object.hasOwn(op, 'value')) return 'a change of the block adds or replaces with no value';
    }
    return '';
}

/**
 * '' when a block's span holds exactly the proof its ops pin (and each proof is whole, carries the span's
 * Source and is given once), else why not. Asked when the block is stored and again when it is replayed.
 */
export function evidenceProblem(span, ops) {
    const list = Array.isArray(span?.evidence) ? span.evidence : [];
    const pins = proofPins(ops);
    const ids = new Set();
    const writes = proofWriteProblem(ops, new Set(list.map(proof => proof?.id)), { erases: span?.module === 'story-block' && span?.operation?.type === 'savepoint.restore' });
    if (writes) return writes;
    const shape = opShapeProblem(ops);
    if (shape) return shape;
    // A block with proof and no occurrence is from a build before proof was released: not supported, so it fails closed.
    if (list.length && occurrenceOf(span) === null) return 'its proof has no occurrence (a block written before proof was released is not supported)';
    for (const proof of list) {
        const why = proofProblem(proof);
        if (why) return `a proof of the block is not whole: ${why}`;
        if (hashJson(proof.source) !== hashJson(span.source)) return 'a proof of the block carries another source than the block';
        if (ids.has(proof.id)) return `proof ${proof.id} is given twice`;
        ids.add(proof.id);
        if (typeof pins.get(proof.id) !== 'string') return `the block's changes do not pin proof ${proof.id}`;
    }
    if (pins.size !== ids.size) return 'the block\'s changes pin proof that it does not hold';
    return '';
}

const entries = new WeakMap();
// Whether a block could be applied, kept per span object (a record written again keeps the spans it had), so listing the
// proof of a record that grows by one block does not look at every block again.
const checked = new WeakMap();

/**
 * [{ proof, block }] a stored record holds on its blocks, in block order (kept per record). `parts` is the record's
 * blocks as the store replays them ([{ ops, span }], store.js blockParts). Only a block that replay could apply
 * counts: it has changes (an empty span is never replayed), its metadata is whole and is the record's own, and it holds
 * exactly the proof its changes pin. A block that is none of these gives none, whatever its span says.
 */
export function recordEntries(record, parts) {
    let out = entries.get(record);
    if (out) return out;
    out = [];
    const own = record?.source;
    for (const { ops, span } of parts) {
        if (!isObject(span) || typeof span.id !== 'string' || !Array.isArray(span.evidence) || !span.evidence.length) continue;
        let whole = checked.get(span);
        if (whole === undefined) {
            whole = Array.isArray(ops) && ops.length > 0 && !spanProblem(span) && !evidenceProblem(span, ops);
            checked.set(span, whole);
        }
        if (!whole) continue;
        if (!isObject(own) || span.source.sid !== own.logical || span.source.swipeKey !== own.swipeKey || span.source.evidence !== own.evidence) continue;
        for (const proof of span.evidence) out.push(Object.freeze({ proof, block: span.id }));
    }
    Object.freeze(out);
    entries.set(record, out);
    return out;
}

// ---------- what is visible ----------

/** The entries with `pending` (this root's, not stored yet) laid over `stored`: a pending proof shadows a stored one of its id. */
export function merged(stored, pending) {
    if (!pending?.length) return stored;
    const ids = new Set(pending.map(entry => entry.proof.id));
    return [...stored.filter(entry => !ids.has(entry.proof.id)), ...pending];
}

// The proof of a list by id, and the ids given twice, kept for a frozen list (the store's, which is a new one whenever
// anything is written), so asking for an id does not look at every proof.
const indexes = new WeakMap();
function indexOf(list) {
    const kept = indexes.get(list);
    if (kept) return kept;
    const byId = new Map();
    const twice = new Set();
    for (const { proof } of list) {
        if (!isObject(proof) || typeof proof.id !== 'string') continue;
        if (byId.has(proof.id)) twice.add(proof.id);
        else byId.set(proof.id, proof);
    }
    const index = { byId, twice };
    if (Object.isFrozen(list)) indexes.set(list, index);
    return index;
}

/**
 * The proofs of `list` ([{ proof }], in source order) that are visible on `state`: pinned in its `meta.proofs`
 * with the pin their bytes and parents give, whole, of an owner that owns the kind, given once, and every parent
 * visible too (a cycle is not visible). → Proof[] in the same order. With `only` (a list of ids) just those are
 * looked at, and their parents: the work is theirs, not the whole chat's. `over` ([{ proof }]: this root's, a
 * Re-read's): laid over the list, a proof of the same id shadows the listed one. The walk through parents is a loop,
 * not a recursion, so a chain of any length is read.
 */
export function visibleProofs(state, list, only = null, over = []) {
    const pins = pinsOf(state);
    const base = indexOf(list);
    const top = new Map();
    const twiceTop = new Set();
    for (const { proof } of over) {
        if (!isObject(proof) || typeof proof.id !== 'string') continue;
        if (top.has(proof.id)) twiceTop.add(proof.id);
        else top.set(proof.id, proof);
    }
    const find = id => (top.has(id) ? { proof: top.get(id), twice: twiceTop.has(id) } : { proof: base.byId.get(id), twice: base.twice.has(id) });
    const memo = new Map();
    const visible = start => {
        if (memo.has(start)) return memo.get(start);
        const stack = [{ id: start, proof: null, next: -1 }];
        const onPath = new Set([start]);
        while (stack.length) {
            const frame = stack.at(-1);
            if (frame.next === -1) {
                const { proof, twice } = find(frame.id);
                if (!proof || twice || !Object.hasOwn(pins, frame.id) || proofProblem(proof) || pins[frame.id] !== pinOf(proof, pins)) {
                    memo.set(frame.id, false);
                    onPath.delete(frame.id);
                    stack.pop();
                    continue;
                }
                frame.proof = proof;
                frame.next = 0;
            }
            let ok = true;
            let pushed = false;
            while (frame.next < frame.proof.parents.length) {
                const parent = frame.proof.parents[frame.next];
                if (memo.has(parent)) {
                    if (!memo.get(parent)) { ok = false; break; }
                    frame.next += 1;
                } else if (onPath.has(parent)) {
                    ok = false;     // a cycle
                    break;
                } else {
                    stack.push({ id: parent, proof: null, next: -1 });
                    onPath.add(parent);
                    pushed = true;
                    break;
                }
            }
            if (pushed) continue;
            memo.set(frame.id, ok);
            onPath.delete(frame.id);
            stack.pop();
        }
        return memo.get(start);
    };
    if (only) return only.filter(id => visible(id)).map(id => find(id).proof);
    const all = over.length ? merged(list, over.map(({ proof }) => ({ proof }))) : list;
    return all.map(entry => entry.proof).filter(proof => isObject(proof) && visible(proof.id));
}

/**
 * The `story.evidence` query (contract §6): `({ ids? }) → Proof[]`, the visible proof in source order, or in
 * the order of `ids` (once each) when they are given; unknown ids are left out and malformed arguments give [].
 * `stored()` → the stored entries (store.proofs); inside a command the transaction's own pending proofs come
 * with the query's tools (`tools.pendingProofs`), so a nested command sees them and a public query does not.
 */
export function createEvidenceQuery({ stored = () => [] } = {}) {
    return function storyEvidence(state, args, tools) {
        let ids = null;
        if (args !== undefined) {
            if (!isObject(args) || Object.keys(args).some(key => key !== 'ids')) return [];
            if (args.ids !== undefined) {
                if (!Array.isArray(args.ids) || args.ids.length > LIMITS.ids) return [];
                for (let at = 0; at < args.ids.length; at += 1) if (!(at in args.ids) || !isRecordId(args.ids[at])) return [];
                ids = [...new Set(args.ids)];
            }
        }
        let pending = [];
        try { pending = typeof tools?.pendingProofs === 'function' ? tools.pendingProofs() ?? [] : []; } catch { pending = []; }
        return visibleProofs(state, stored() ?? [], ids, pending);
    };
}

/**
 * What a root is, apart from where it stands in the reply: its command and, for a story line, the line as written (the same
 * thing store.js calls a line's key). Two blocks of one reply that did the same thing are told apart by their rank among them.
 */
export function operationKey(type, payload) {
    return hashJson({ type, line: typeof payload?.raw === 'string' ? payload.raw : payload ?? {} });
}

// ---------- occurrence ----------
//
// Two blocks of one reply that did exactly the same (two lines with the same text, two steps with the same command and payload) are told
// apart by their occurrence: a whole number given to a block once, when it is first stamped, kept in its span (`span.occurrence`) and
// never worked out again. A step planned again, a reconcile, a Re-read of text that did not change and a rebuild all use the one the
// block has, so an earlier block that goes cannot move the later ones onto its identity. A new block takes the next number nobody
// has used in that reply (`record.source.taken`, kept past the blocks that go, and the numbers of the blocks that stand). A block that
// gives proof and has no number was written by a build before proof was released: it is not supported (evidenceProblem) and fails closed.

const whole = value => (Number.isInteger(value) && value >= 0 ? value : null);

/** The key a span's operation has (operationKey), or null. */
export function spanOperationKey(span) {
    try { return isObject(span?.operation) ? operationKey(span.operation.type, span.operation.payload) : null; } catch { return null; }
}

/** The occurrence a block was stamped with, or null (a block from before there was one). */
export const occurrenceOf = span => whole(span?.occurrence);

const takenKey = key => key.slice(0, 16);

/** `entry` (a record's source) with the occurrences of `spans` taken: undefined when none ever was (a store with no guarded block stays as it was). */
export function takenAfter(entry, spans) {
    const out = isObject(entry?.taken) ? { ...entry.taken } : {};
    for (const span of spans) {
        const at = occurrenceOf(span);
        const key = at === null ? null : spanOperationKey(span);
        if (key) out[takenKey(key)] = Math.max(whole(out[takenKey(key)]) ?? 0, at + 1);
    }
    return Object.keys(out).length ? out : undefined;
}

/** The next occurrence nobody has used in `record` (the reply) for the operation `key`. */
export function nextOccurrence(record, key) {
    let next = whole(record?.source?.taken?.[takenKey(key)]) ?? 0;
    for (const span of Array.isArray(record?.spans) ? record.spans : []) {
        if (!isObject(span) || spanOperationKey(span) !== key) continue;
        const at = occurrenceOf(span);
        if (at !== null) next = Math.max(next, at + 1);
    }
    return next;
}

/**
 * The one place a new occurrence is allocated. A plan (a Re-read, a reconcile of a record) works on one allocator per record: it starts from
 * what the record holds (`nextOccurrence`: `record.source.taken` and the numbers of the blocks that stand, `also(key)`: numbers the plan has
 * given in blocks not stored yet) and moves on after each number it gives, so two blocks of one plan never take the same one. Nothing is
 * kept in the record until the plan is stored (the span's `occurrence` and `takenAfter` do that).
 * → { peek(key), note(key, value), take(key) }: the next number for an operation, a number used, and both.
 */
export function allocator(record, also = () => 0) {
    const given = new Map();
    const peek = key => Math.max(nextOccurrence(record, key), also(key), given.get(key) ?? 0);
    const note = (key, value) => given.set(key, Math.max(given.get(key) ?? 0, value + 1));
    return { peek, note, take(key) { const value = peek(key); note(key, value); return value; } };
}

// The supported guarded spans a Re-read gives again, in record order. Old proofless spans have an id but no occurrence.
function regeneratedSpans(record) {
    const spans = Array.isArray(record?.spans) ? record.spans : [];
    const receipts = Array.isArray(record?.receipts) ? record.receipts : [];
    const out = new Map();
    let at = 0;
    for (const span of spans) {
        const ops = Array.isArray(record?.ops) && Number.isInteger(span?.n) ? record.ops.slice(at, at + span.n) : [];
        at += Number.isInteger(span?.n) ? span.n : 0;
        if (!isObject(span) || typeof span.id !== 'string') continue;
        const key = occurrenceOf(span) !== null || !span.evidence?.length ? spanOperationKey(span) : null;
        if (!key) continue;
        const rev = [...ops].reverse().find(op => op?.path === '/meta/rev' && Number.isInteger(op.value))?.value;
        const step = !!span.replan && receipts.some(receipt => receipt?.rev === rev && receipt?.afterCapture === true);
        if (span.story !== true && !step) continue;
        (out.get(key) ?? out.set(key, []).get(key)).push(span);
    }
    return out;
}

/**
 * The occurrences for the blocks a Re-read of `record` plans. For an operation whose blocks are as many as before, the k-th block that is
 * given again takes the k-th number of the blocks of that operation it replaces (an unchanged Re-read gives every block its own). When
 * the number of blocks of an operation goes up or down, which old block each new one stands for is not known, so none of that
 * operation's old numbers is given again (`retire`, found with `ambiguous` after a first plan): every block of it takes a number
 * nobody has used, every old proof id of it is retired and what was built on them is hidden. A block with none to take back also takes
 * the next unused one. `peek(key)` → the number the next block of that operation would take; `commit(key, value)` once it was planned;
 * `span(key)` → the stored identity to reuse (including old proofless spans without an occurrence);
 * `ambiguous(planned)` → the operations (keys) whose block count differs from the one it replaces.
 */
export function reusePlan(record, retire = new Set()) {
    const pool = regeneratedSpans(record);
    const used = new Map();
    const fresh = allocator(record);
    const span = key => (retire.has(key) ? null : pool.get(key)?.[used.get(key) ?? 0] ?? null);
    return {
        span,
        peek(key) {
            return occurrenceOf(span(key)) ?? fresh.peek(key);
        },
        commit(key, value) {
            used.set(key, (used.get(key) ?? 0) + 1);
            if (whole(value) !== null) fresh.note(key, value);
        },
        ambiguous(planned) {
            const counts = new Map();
            for (const piece of planned) {
                const block = piece?.block;
                if (!isObject(block?.operation)) continue;
                let key = null;
                try { key = operationKey(block.operation.type, block.operation.payload); } catch { key = null; }
                if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
            }
            return [...counts].filter(([key, count]) => !retire.has(key) && pool.has(key) && pool.get(key).length !== count).map(([key]) => key);
        },
    };
}

/**
 * The proof of the blocks of a record that a Re-read regenerates (its story lines and its planned steps), in record order. A
 * block regenerated by a Re-read may hold these ids again (its own and nobody else's); an id any other block holds is not
 * given to it (see submitProof).
 */
export function replacedProofs(record) {
    const out = [];
    for (const span of Array.isArray(record?.spans) ? record.spans : []) {
        if (!isObject(span) || typeof span.id !== 'string' || !(span.story === true || span.replan)) continue;
        for (const proof of Array.isArray(span.evidence) ? span.evidence : []) if (isObject(proof)) out.push(proof);
    }
    return out;
}

// ---------- ctx.proof ----------

/** A new, empty set of what one root has given: by key and in order. */
export const newRoot = () => ({ byKey: new Map(), list: [] });

/**
 * One `ctx.proof(spec)` (contract §6) for the module `who` in a command whose cause, chat, Source and state are
 * given (`state` is a function: the transaction's state as it is now, asked only when there are parents). The checks, in order: INVALID (the call's shape), REFUSED (owner or kind), INVALID (payload, parents),
 * REFUSED (reader intent the host did not see), CONFLICT (same key, other contents), NOT_FOUND (a parent), then
 * the stamped proof. `root` is the transaction's (newRoot), `stored()` the stored entries of the blocks that applied (`taken()`: of every block that could), `planned` the proofs a Re-read's earlier lines gave, `fail(code, message)`
 * throws the bus's error. `free` (a Set of proof ids): those of blocks the host is about to replace (a Re-read's
 * story lines and steps, a step planned again), so a line read again gets its own id back.
 * → { proof, pin, created }; `created: false` is an identical retry, which gives back the proof it made.
 */
export function submitProof(spec, { who, cause, chat, source, origin = '', state, stored, taken: everyStored = null, planned = [], root, fail, replacing = [] }) {
    if (!isObject(spec) || Object.keys(spec).some(key => key !== 'kind' && key !== 'payload' && key !== 'parents')) {
        fail('INVALID', 'A proof is { kind, payload, parents? } and nothing else.');
    }
    const { kind, payload } = spec;
    if (typeof kind !== 'string' || !kind) fail('INVALID', 'A proof names its kind.');
    const owner = Object.hasOwn(OWNERS, kind) ? OWNERS[kind] : null;
    if (!owner) fail('REFUSED', `"${kind}" is not a kind of proof (${KINDS.join(', ')}).`);
    if (owner !== who) fail('REFUSED', `${who} cannot give "${kind}" proof: only ${owner} does.`);
    const bad = payloadProblem(kind, payload);
    if (bad) fail('INVALID', `That is not a "${kind}" proof: ${bad}.`);
    const parents = spec.parents === undefined ? [] : spec.parents;
    if (!Array.isArray(parents) || parents.length > LIMITS.parents || new Set(parents).size !== parents.length || !parents.every(isRecordId)) {
        fail('INVALID', `A proof's parents are up to ${LIMITS.parents} different proof ids.`);
    }
    const unseen = intentProblem(kind, payload, { cause, chat });
    if (unseen) fail('REFUSED', `The host did not see that: ${unseen}.`);
    if (!source) fail('FAILED', 'There is no reply yet to hold a proof.');

    const key = `${kind}:${payloadKey(kind, payload)}`;
    const payloadHash = hashJson(payload);
    const had = root.byKey.get(key);
    if (had) {
        if (had.payloadHash === payloadHash && canonicalJson(had.parents) === canonicalJson(parents)) return { proof: had, pin: null, created: false };
        fail('CONFLICT', `This command already gave "${kind}" proof for ${key.slice(kind.length + 1)} with other contents.`);
    }
    if (root.list.length >= LIMITS.perRoot) fail('LIMITED', `One command gives at most ${LIMITS.perRoot} proofs.`);

    const held = stored() ?? [];
    const pending = [...planned, ...root.list].map(proof => ({ proof, block: null }));
    const now = parents.length ? state() : null;     // the state is only looked at for the parents' pins
    if (parents.length) {
        const found = new Set(visibleProofs(now, held, parents, pending).map(proof => proof.id));
        const missing = parents.find(id => !found.has(id));
        if (missing) fail('NOT_FOUND', `There is no visible proof ${missing} to be a parent.`);
    }
    // The id is the block's own: derived from the reply's evidence id (so a new swipe has fresh ids), what the block is (`origin`:
    // its command and line, and its rank among identical ones) and the proof's key. Two blocks differ in what they are, so they
    // cannot give one id and nothing is matched or reserved; a block regenerated (a Re-read, a step planned again) works out the
    // ids it had. An id another block holds (a file edited by hand) is refused; `replacing`: the proof of the blocks being replaced.
    const pendingIds = new Set(pending.map(entry => entry.proof.id));
    const id = idFromHash('pf', sha256(`pf:${source.evidence}:${origin}:${key}`));
    const heldIds = indexOf(everyStored ? everyStored() ?? [] : held).byId;
    if (pendingIds.has(id) || (heldIds.has(id) && !(replacing ?? []).some(old => old?.id === id))) {
        fail('CONFLICT', `Proof ${id} belongs to another block already.`);
    }
    const proof = Object.freeze({
        id, source: Object.freeze({ ...source }), owner, kind, payload: structuredClone(payload), payloadHash, parents: Object.freeze([...parents]),
    });
    const pin = pinOf(proof, pinsOf(now));
    root.byKey.set(key, proof);
    root.list.push(proof);
    return { proof, pin, created: true };
}
