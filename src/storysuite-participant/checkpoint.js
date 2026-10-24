// NPC State Delta, the participant's native checkpoint (contract §8: "persists full native state/history/evidence/identity map and applied
// death IDs"). A checkpoint is one document, immutable once made, named by its own hash:
//
//   { schema, kind, chatKey, cursor, headHash,
//     state,      the chat's whole native state as Delta keeps it: dossiers (with their evidence and locks), candidates, the social graph
//                 (the relationship map), the rollback checkpoints and lineage (its history), portraits, pending work
//     identity,   the np_ map (nativeKey <-> np_, archived entries kept)
//     applied }   the confirmed deaths applied, by event id
//
// Restoring one installs `state`, `identity` and `applied` **together**, so a dossier and its np_ can never come from different times.
// The document is plain JSON (the state is persisted as JSON anyway: a value JSON cannot hold does not survive into a checkpoint), its hash
// is the contract's Hash of it, and its id is derived from the hash, so the same native state at the same head is the same checkpoint.

import { hashJson } from './hash.js';
import { cleanIdentity } from './identity.js';

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
export function buildCheckpoint({ chatKey, state, identity, applied, cursor = null, headHash = null }) {
    const doc = {
        schema: PARTICIPANT_SCHEMA,
        kind: KIND,
        chatKey: String(chatKey ?? ''),
        cursor: plain(cursor),
        headHash: typeof headHash === 'string' ? headHash : null,
        state: plain(state),
        identity: cleanIdentity(identity),
        applied: cleanApplied(applied),
    };
    const hash = hashJson(doc);
    return { id: checkpointIdOf(hash), hash, doc };
}

/** '' when `doc` is a whole checkpoint with this hash; else why not. A newer schema than this code reads is a problem of its own. */
export function checkpointProblem(doc, hash) {
    if (!isRecord(doc) || doc.kind !== KIND) return 'It is not a native checkpoint of NPC State Delta.';
    if (!Number.isInteger(doc.schema) || doc.schema > PARTICIPANT_SCHEMA) return 'It was made by a newer NPC State Delta than this one.';
    if (!isRecord(doc.state) || !isRecord(doc.identity) || !isRecord(doc.applied) || typeof doc.chatKey !== 'string') return 'It is missing the native state, the identity map or the applied deaths.';
    let actual;
    try { actual = hashJson(doc); } catch { return 'It is not plain JSON.'; }
    return actual === hash ? '' : 'Its bytes do not hash to its hash.';
}
