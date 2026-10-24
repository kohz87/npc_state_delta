// NPC State Delta, what the timeline participant keeps **inside Delta's chat state** (`state.timeline`), so that it travels with the dossiers it
// names: a chat rename moves the state file, a branch inherits it (branch.js), an export carries it (native-transfer.js), and a restore puts a
// checkpoint's block back with the dossiers of the same checkpoint.
//
//   timeline = {
//     v: 1,
//     lineage,       'lg_xxxxxxxx': the id of this story's native line. Minted once, never from the chat's key or name; a rename keeps it, a branch
//                    inherits it. A checkpoint belongs to a lineage, not to a file name.
//     identity,      { map: { np_id: { nativeKey, archived, since } } }: the np_ of every dossier, archived (never reused) when its dossier goes
//     reserved,      [np_id]: every np_ ever issued in this lineage, including the ones a restore took back (inactive, never issued again)
//     applied,       { event id: { nativeKey, at } }: the confirmed deaths applied
//   }
//
// Pure. The block is plain JSON and is part of every checkpoint (restoring puts the saved map and deaths back; `reserved` is merged with the
// live one so an id the dead timeline issued is not issued again).

import { cleanApplied } from './checkpoint.js';
import { cleanIdentity } from './identity.js';

export const TIMELINE_VERSION = 1;
export const LINEAGE_ID = /^lg_[0-9a-z]{8}$/;
const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
const NP_ID = /^np_[0-9a-z]{8}$/;

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A new lineage id. `random()` is a number in [0, 1) (Math.random by default, crypto when there is one). */
export function mintLineage(random = defaultRandom) {
    let text = '';
    for (let i = 0; i < 8; i += 1) text += BASE36[Math.floor(random() * 36) % 36];
    return `lg_${text}`;
}

function defaultRandom() {
    const crypto = globalThis.crypto;
    if (crypto?.getRandomValues) return crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
    return Math.random();
}

/** The block of a state as stored, checked: a whole block for anything, with `lineage` null when there is none yet. */
export function cleanTimeline(raw) {
    const block = { v: TIMELINE_VERSION, lineage: null, identity: cleanIdentity(null), reserved: [], applied: {} };
    if (!isRecord(raw)) return block;
    if (typeof raw.lineage === 'string' && LINEAGE_ID.test(raw.lineage)) block.lineage = raw.lineage;
    block.identity = cleanIdentity(raw.identity);
    block.reserved = [...new Set([...(Array.isArray(raw.reserved) ? raw.reserved.filter(id => typeof id === 'string' && NP_ID.test(id)) : []), ...Object.keys(block.identity.map)])].sort();
    block.applied = cleanApplied(raw.applied);
    return block;
}

/** The block as it is written into the state: no derived index. */
export function storedTimeline(block) {
    return {
        v: TIMELINE_VERSION,
        lineage: block.lineage,
        identity: { map: Object.fromEntries(Object.entries(block.identity.map).map(([id, entry]) => [id, { nativeKey: entry.nativeKey, archived: entry.archived === true, since: entry.since }])) },
        reserved: [...block.reserved].sort(),
        applied: Object.fromEntries(Object.entries(block.applied).map(([event, entry]) => [event, { nativeKey: entry.nativeKey, at: entry.at }])),
    };
}

/** The block of `state` (a state object), checked. */
export const timelineOf = state => cleanTimeline(state?.timeline);

/**
 * The state a restore installs: the checkpoint's state with its block, but this lineage's id and every np_ id that either timeline issued
 * kept reserved.
 */
export function restoredState(saved, live) {
    const state = JSON.parse(JSON.stringify(saved ?? {}));
    const then = cleanTimeline(state.timeline);
    const now = cleanTimeline(live?.timeline);
    then.lineage = now.lineage ?? then.lineage;
    then.reserved = [...new Set([...then.reserved, ...now.reserved, ...Object.keys(now.identity.map)])].sort();
    state.timeline = storedTimeline(then);
    return state;
}
