// Story Suite v2 evidence, stored part: whether a stored proof is whole and owned, its pin, the pins written with a block's
// ops and the write checks on the proof record (proofWriteProblem, evidenceProblem). Pure. evidence.js keeps the public path.

import { LIMITS, OWNERS, PROOF_KEYS, isObject, occurrenceOf, whole } from './constants.js';
import { exactKeys, payloadCheck } from './payloads.js';
import { escapeKey, parsePath } from '../ops.js';
import { hashJson, isRecordId, sha256, sourceProblem } from '../replay.js';

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

export const pinsOf = state => (isObject(state?.meta?.proofs) ? state.meta.proofs : {});

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
