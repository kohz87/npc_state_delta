// Story Suite v2 evidence, submit part: a root's set of given proofs (newRoot) and submitProof, which checks a ctx.proof
// call and builds its proof. Pure. evidence.js keeps the public path of each export.

import { KINDS, LIMITS, OWNERS, isObject } from './constants.js';
import { intentProblem, payloadKey, payloadProblem } from './payloads.js';
import { pinOf, pinsOf } from './stored.js';
import { indexOf, visibleProofs } from './visible.js';
import { canonicalJson, hashJson, idFromHash, isRecordId, sha256 } from '../replay.js';

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
