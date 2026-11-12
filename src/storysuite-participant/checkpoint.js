// NPC State Delta, the participant's native checkpoint (contract §8: "persists full native state/history/evidence/identity map and applied
// death IDs"). A checkpoint is one document, immutable once made, named by its own hash:
//
//   { schema, kind, lineage, cursor, headHash,
//     state }     the chat's whole native state as Delta keeps it: dossiers (with their evidence and locks), candidates, the social graph
//                 (the relationship map), the rollback checkpoints and lineage (its history), portraits, pending work, and `timeline`: the
//                 np_ map, the reserved ids and the applied deaths (timeline.js)
//
// Restoring one installs the state, and with it the np_ map and the deaths, **together**, so a dossier and its np_ can never come from different
// times. A checkpoint belongs to a lineage (the story's native line, stored in the state), not to a chat's key or file name: renamed, branched
// or exported, the chat still finds its checkpoints. The document is plain JSON, its hash is the contract's Hash of it, and its id is derived from
// the hash, so the same native state at the same head is the same checkpoint.

import { hashJson } from './hash.js';
import { packCheckpoints, unpackCheckpoints } from '../../checkpoint-pack.js';

export const PARTICIPANT_SCHEMA = 1;
export const KIND = 'npc-state-delta-native';
const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
export const CHECKPOINT_ID = /^nk_[0-9a-z]{8}$/;

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const plain = value => JSON.parse(JSON.stringify(value ?? null));

/** The id a checkpoint with this hash has: `nk_` and eight base36 characters of the hash. */
export function checkpointIdOf(hash) {
    let value = BigInt(`0x${String(hash).slice(0, 12)}`);
    let text = '';
    for (let i = 0; i < 8; i += 1) {
        text = BASE36[Number(value % 36n)] + text;
        value /= 36n;
    }
    return `nk_${text}`;
}

/** The applied deaths as stored: { eventId: { nativeKey, at } }, checked. */
export function cleanApplied(raw) {
    const out = {};
    if (!isRecord(raw)) return out;
    for (const [event, entry] of Object.entries(raw)) {
        if (event && isRecord(entry) && typeof entry.nativeKey === 'string' && entry.nativeKey) out[event] = { nativeKey: entry.nativeKey, at: Number.isSafeInteger(entry.at) ? entry.at : 0 };
    }
    return out;
}

/** → { id, hash, doc } for the native state now. `cursor` and `headHash` are the host's (or null for a checkpoint made outside a head). */
export function buildCheckpoint({ lineage, state, cursor = null, headHash = null }) {
    const doc = {
        schema: PARTICIPANT_SCHEMA,
        kind: KIND,
        lineage: String(lineage ?? ''),
        cursor: plain(cursor),
        headHash: typeof headHash === 'string' ? headHash : null,
        state: plain(state),
    };
    const hash = hashJson(doc);
    return { id: checkpointIdOf(hash), hash, doc };
}

/**
 * '' when `doc` is a whole checkpoint with this hash; else why not. A newer schema than this code reads is a problem of its own.
 * `known` is an optional precomputed hashJson(doc) (a caller that hashed already passes it, so the document is hashed once).
 */
export function checkpointProblem(doc, hash, known) {
    if (!isRecord(doc) || doc.kind !== KIND) return 'It is not a native checkpoint of NPC State Delta.';
    if (!Number.isInteger(doc.schema) || doc.schema > PARTICIPANT_SCHEMA) return 'It was made by a newer NPC State Delta than this one.';
    if (!isRecord(doc.state) || !isRecord(doc.state.timeline) || typeof doc.lineage !== 'string') return 'It is missing the native state, its lineage or the identity map and applied deaths in it.';
    let actual = known;
    try { if (actual === undefined) actual = hashJson(doc); } catch { return 'It is not plain JSON.'; }
    return actual === hash ? '' : 'Its bytes do not hash to its hash.';
}

// The on-disk form (vault.js): the same document with `state.checkpoints` (Delta's own rollback history, nine tenths of the bytes and a copy of
// it in every file) packed like sidecar format 2. Ids and hashes are of the plain document; a packed file is unpacked on read, so every reader
// sees the document it hashed. A different `kind` makes an older build refuse the file cleanly instead of reading packed entries as snapshots.
export const KIND_PACKED = 'npc-state-delta-native-packed';

/** → the packed wrapper for `doc`, or `doc` itself when packing is not possible or does not reproduce the document exactly (never throws). */
export function packForFile(doc) {
    try {
        if (!isRecord(doc) || !isRecord(doc.state) || !Array.isArray(doc.state.checkpoints) || !doc.state.checkpoints.length) return doc;
        const { entries, packing } = packCheckpoints(doc.state.checkpoints);
        const wrapper = { schema: PARTICIPANT_SCHEMA, kind: KIND_PACKED, packing, doc: { ...doc, state: { ...doc.state, checkpoints: entries } } };
        const back = unpackFromFile(JSON.parse(JSON.stringify(wrapper)));
        // Compared as text (key order included): stricter than the hash and much cheaper on a multi-megabyte document.
        return back && JSON.stringify(back) === JSON.stringify(doc) ? wrapper : doc;
    } catch { return doc; }
}

/** → the plain document of what the vault read: a packed wrapper is unpacked (null when it cannot be rebuilt); anything else is returned as it is. */
export function unpackFromFile(raw) {
    if (!isRecord(raw) || raw.kind !== KIND_PACKED) return raw;
    try {
        if (!isRecord(raw.doc) || !isRecord(raw.doc.state) || !Array.isArray(raw.doc.state.checkpoints)) return null;
        return { ...raw.doc, state: { ...raw.doc.state, checkpoints: unpackCheckpoints(raw.doc.state.checkpoints, raw.packing) } };
    } catch { return null; }
}
