// NPC State Delta, the participant's NPC identity (contract §8, P24): one `np_` surrogate per dossier, so other modules can name a person
// without a name that can change. The pair nativeKey <-> np_ lives in the native state itself (timeline.js: state.timeline), so it is part of every
// checkpoint, moves with a chat rename, is inherited by a branch and travels in an export, and:
//   * is assigned to every admitted dossier before the new native head is published (hydration, import, creation, scan, manual edit all
//     go through `hydrateIdentity`);
//   * survives a rename (the nativeKey is the dossier's own id, `npc_<slug>`, which a rename does not change) and an alias change;
//   * is archived, never reused, when the dossier is gone; an id once issued stays reserved even after a restore took its dossier back
//     (audit-reserved: inactive, resolves through no query);
//   * resolves by id to the active dossier's { id, nativeKey, name }, and by name, alias or native key only when exactly one dossier
//     answers; unknown, ambiguous or malformed is null and nothing is created by asking.
// Pure.

import { sha256 } from './hash.js';

export const NP_ID = /^np_[0-9a-z]{8}$/;
const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
const NAME_MAX = 80;

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export const emptyIdentity = () => ({ map: {}, byKey: {} });

/** The key a name is found by: invisible marks dropped, NFKC, apostrophes dropped, spaces folded, lowercase. */
export const nameKey = value => String(value ?? '').replace(/\p{Cf}+/gu, '').normalize('NFKC').replace(/['’‘`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** An identity as stored, checked: a copy, or an empty one for anything that is not whole. */
export function cleanIdentity(raw) {
    const out = emptyIdentity();
    if (!isRecord(raw) || !isRecord(raw.map)) return out;
    for (const [id, entry] of Object.entries(raw.map)) {
        if (!NP_ID.test(id) || !isRecord(entry) || typeof entry.nativeKey !== 'string' || !entry.nativeKey) continue;
        out.map[id] = { nativeKey: entry.nativeKey, archived: entry.archived === true, since: Number.isSafeInteger(entry.since) ? entry.since : 0 };
    }
    for (const [id, entry] of Object.entries(out.map)) if (!entry.archived) out.byKey[entry.nativeKey] = id;
    return out;
}

/** A fresh np_ id for a dossier: from the lineage, the native key and a counter past every id in use or ever issued. */
export function newNpId(seed, nativeKey, taken) {
    for (let n = 0; n < 10000; n += 1) {
        const hex = sha256(`${seed}\u0000${nativeKey}\u0000${n}`);
        let value = BigInt(`0x${hex.slice(0, 12)}`);
        let text = '';
        for (let i = 0; i < 8; i += 1) {
            text = BASE36[Number(value % 36n)] + text;
            value /= 36n;
        }
        const id = `np_${text}`;
        if (!taken.has(id)) return id;
    }
    throw new Error('No free np_ id.');
}

/**
 * Brings an identity up to date with the dossiers: every dossier has a live np_ (assigned in dossier order), and an entry whose dossier is
 * gone is archived. `reserved`: every id ever issued in this lineage, which is never issued again; a native key that comes back after its
 * dossier was deleted gets a new id, never the archived one.
 * → { identity, reserved, assigned: [np_], archived: [np_], changed }; the inputs are not changed.
 */
export function hydrateIdentity(identity, npcs, { seed, reserved = [] } = {}) {
    const next = cleanIdentity(identity);
    const used = new Set([...Object.keys(next.map), ...reserved]);
    const keys = new Set((Array.isArray(npcs) ? npcs : []).map(npc => (typeof npc?.id === 'string' ? npc.id : '')).filter(Boolean));
    const assigned = [];
    const archived = [];
    for (const [id, entry] of Object.entries(next.map)) {
        if (!entry.archived && !keys.has(entry.nativeKey)) {
            entry.archived = true;
            delete next.byKey[entry.nativeKey];
            archived.push(id);
        }
    }
    for (const nativeKey of keys) {
        if (Object.hasOwn(next.byKey, nativeKey)) continue;
        const id = newNpId(seed, nativeKey, used);
        used.add(id);
        next.map[id] = { nativeKey, archived: false, since: Object.keys(next.map).length + 1 };
        next.byKey[nativeKey] = id;
        assigned.push(id);
    }
    return { identity: next, reserved: [...new Set([...reserved, ...Object.keys(next.map)])].sort(), assigned, archived, changed: assigned.length > 0 || archived.length > 0 };
}

const nameOf = npc => String(npc?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);

/**
 * `npc.identity({ id } | { name })`: exactly one selector. → { id, nativeKey, name } | null. `npcs`: the live dossiers.
 * Unknown, ambiguous, archived, malformed or both selectors: null.
 */
export function resolveIdentity(identity, npcs, args) {
    if (!isRecord(args)) return null;
    const hasId = args.id !== undefined && args.id !== null;
    const hasName = args.name !== undefined && args.name !== null;
    if (hasId === hasName) return null;
    const list = Array.isArray(npcs) ? npcs.filter(npc => isRecord(npc) && typeof npc.id === 'string') : [];
    const found = nativeKey => list.find(npc => npc.id === nativeKey) ?? null;
    if (hasId) {
        if (typeof args.id !== 'string' || !NP_ID.test(args.id)) return null;
        const entry = identity?.map?.[args.id];
        const npc = entry && !entry.archived ? found(entry.nativeKey) : null;
        return npc ? { id: args.id, nativeKey: npc.id, name: nameOf(npc) } : null;
    }
    if (typeof args.name !== 'string') return null;
    const want = nameKey(args.name);
    if (!want) return null;
    const hits = list.filter(npc => nameKey(npc.id) === want || nameKey(npc.name) === want || (Array.isArray(npc.aliases) && npc.aliases.some(alias => nameKey(alias) === want)));
    if (hits.length !== 1) return null;
    const id = identity?.byKey?.[hits[0].id];
    return id ? { id, nativeKey: hits[0].id, name: nameOf(hits[0]) } : null;
}
