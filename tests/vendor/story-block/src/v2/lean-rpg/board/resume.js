// Exact foe bars that the next board fight may resume across fights.
// A lost or fled fight leaves only collapsed count/Health fields on the Foes block; the exact bars
// survive in that reply's rpg.resolve receipt. This module is pure: it reads only the records, foe
// slots and Foes-block entries passed in.

import { RESOLVE } from '../names.js';
import { carriedFrom, collapseFoes } from './members.js';

const ENDED = new Set(['won', 'lost', 'fled']);
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const num = value => (Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0);
const groupOf = member => (Number.isInteger(member?.group) ? member.group
    : num(member?.slot) >= 1 && num(member?.slot) <= 4 ? num(member.slot) : Math.floor(num(member?.slot) / 10));
const slotOf = member => (Number.isInteger(member?.slot) ? member.slot
    : groupOf(member) * 10 + Math.max(1, num(member?.n)));
const valueOf = member => (Number.isFinite(Number(member?.value)) ? Number(member.value) : Number(member?.hurt));

/** The receipts in chat order, from stored records or the store's `{ index, receipt }` entries. */
function receiptsOf(records) {
    const out = [];
    for (const record of (Array.isArray(records) ? records : records ? [records] : [])) {
        const nested = record?.extra?.storySuite?.receipts;
        if (Array.isArray(record?.receipts)) out.push(...record.receipts);
        else if (Array.isArray(nested)) out.push(...nested);
        else if (record?.receipt) out.push(record.receipt);
        else if (record?.type) out.push(record);
    }
    return out;
}

/** The newest ended board result whose member bars cover every requested real foe slot. */
function lastCovering(receipts, slots) {
    for (let at = receipts.length - 1; at >= 0; at -= 1) {
        const receipt = receipts[at]?.receipt ?? receipts[at];
        if (receipt?.type !== RESOLVE) continue;
        const result = receipt.data?.v2?.result;
        if (!ENDED.has(result?.stop) || !isObject(result?.board) || !Array.isArray(result.members)) continue;
        const groups = new Set(result.members.map(groupOf));
        if (slots.every(slot => groups.has(slot))) return result;
    }
    return null;
}

/**
 * `records`: the chat's records in order (each with `receipts`), or store receipt entries.
 * `slots`: the real Foes-block slot numbers of the fight about to open.
 * `foesBlock`: readSheet's foe entries (`sheet.foes`) after the last fight's collapse.
 * → `{ values, counts }` for `setup.carriedMembers`, or null when the last covering fight was won,
 *   the Foes block changed, or no ended board fight covers every slot.
 */
export function resumeMembers(records, slots, foesBlock) {
    const wanted = [...new Set((Array.isArray(slots) ? slots : []).map(Number).filter(slot => Number.isSafeInteger(slot) && slot > 0))];
    if (!wanted.length) return null;
    const result = lastCovering(receiptsOf(records), wanted);
    if (!result || result.stop === 'won') return null;

    const foes = Array.isArray(foesBlock) ? foesBlock : [];
    const current = new Map();
    for (const slot of wanted) {
        const foe = foes.find(entry => num(entry?.slot) === slot);
        if (!foe || foe.filled === false || num(foe.count) <= 0 || num(foe.hurt) <= 0) return null;
        current.set(slot, foe);
    }

    const members = result.members.filter(member => wanted.includes(groupOf(member)));
    const values = new Map();
    for (const member of members) {
        const group = groupOf(member), value = valueOf(member);
        if (!Number.isInteger(group) || !Number.isFinite(value)) return null;
        values.set(slotOf(member), value);
    }

    for (const slot of wanted) {
        const foe = current.get(slot), mine = members.filter(member => groupOf(member) === slot);
        if (!mine.length) return null;
        const count = num(foe.count), hurt = num(foe.hurt);
        const packed = mine.some(member => member?.pack === true || num(member?.count) > 1);
        const original = packed ? mine.reduce((sum, member) => sum + Math.max(0, num(member?.count)), 0) : mine.length;
        if (original <= 0) return null;
        if (original === 1) {
            if (count !== 1 || num(valueOf(mine[0])) !== hurt) return null;
            continue;
        }
        const [collapsed] = collapseFoes([{ ...foe, filled: true, count: original }], values);
        if (!collapsed || collapsed.count.to !== count || collapsed.hurt.to !== hurt) return null;
    }
    return carriedFrom(members);
}
