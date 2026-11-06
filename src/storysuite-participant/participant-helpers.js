// Participant storage helpers: result envelopes, plain copies, prepared ids, checked lineage indexes and confirmed-death records.

import { hashJson } from './hash.js';
import { manualLifeStateRecord } from '../../terminal-lifecycle.js';

export const fail = (code, message) => ({ ok: false, code, message });
export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const plain = value => JSON.parse(JSON.stringify(value ?? null));
const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';

export function preparedId(seed) {
    let value = BigInt(`0x${hashJson(seed).slice(0, 12)}`);
    let text = '';
    for (let i = 0; i < 8; i += 1) {
        text = BASE36[Number(value % 36n)] + text;
        value /= 36n;
    }
    return `pn_${text}`;
}

const HASH = /^[0-9a-f]{64}$/;

/** The lineage's index as stored, checked. */
export function cleanIndex(raw) {
    const index = { v: 2, acks: {}, prepared: {}, returns: {}, selected: null, base: null };
    if (!isRecord(raw)) return index;
    for (const [event, ack] of Object.entries(isRecord(raw.acks) ? raw.acks : {})) if (isRecord(ack) && typeof ack.checkpoint === 'string' && typeof ack.hash === 'string') index.acks[event] = { checkpoint: ack.checkpoint, hash: ack.hash };
    for (const [id, entry] of Object.entries(isRecord(raw.prepared) ? raw.prepared : {})) {
        if (isRecord(entry) && typeof entry.checkpoint === 'string' && typeof entry.hash === 'string') index.prepared[id] = { checkpoint: entry.checkpoint, hash: entry.hash, return: typeof entry.return === 'string' ? entry.return : null, inPlace: entry.inPlace === true, stateHash: typeof entry.stateHash === 'string' ? entry.stateHash : null, newer: entry.newer === true };
    }
    for (const [id, entry] of Object.entries(isRecord(raw.returns) ? raw.returns : {})) {
        if (isRecord(entry) && typeof entry.prepared === 'string' && typeof entry.checkpoint === 'string' && ['prepared', 'active', 'aborted'].includes(entry.status)) index.returns[id] = { prepared: entry.prepared, checkpoint: entry.checkpoint, hash: String(entry.hash ?? ''), status: entry.status };
    }
    index.selected = typeof raw.selected === 'string' ? raw.selected : null;
    if (isRecord(raw.base) && typeof raw.base.checkpoint === 'string' && HASH.test(String(raw.base.hash)) && typeof raw.base.stateHash === 'string') index.base = { checkpoint: raw.base.checkpoint, hash: raw.base.hash, stateHash: raw.base.stateHash };
    return index;
}

/** A dossier marked dead by a confirmed event: Delta's own explicit, terminal death record, with the event as its reason. */
export function confirmedDeath(npc, { event, now }) {
    const dead = manualLifeStateRecord(npc, 'deceased', now);
    dead.lifeStateReason = `Confirmed dead by the rules (event ${String(event).slice(0, 60)}).`;
    return dead;
}
