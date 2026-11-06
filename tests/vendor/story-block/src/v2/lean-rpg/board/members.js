// Foe members and packs for a board fight.
// A filled slot of 2..5 foes becomes numbered bars; 1 stays a real lone foe and 6 or more become evenly split packs of at most 12. These helpers only
// turn the real Foes block into virtual bars and back, so the engine can keep its own values and write ordinary moves.
import { foeBlocksByLevel } from '../foes.js';
import { foeHealthBlocks } from '../formula.js';

export const MEMBER_CAP = 5;
export const PACK_MAX_SIZE = 12;
export const PACK_MAX_ATTACKS = 3;

const num = value => (Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0);
const hurtField = slot => `hurt${((num(slot) - 1) % 4) + 1}`;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const held = (value, size) => clamp(num(value), 0, Math.max(0, num(size)));
const isPack = foe => num(foe?.count) > MEMBER_CAP;
const groupOf = foe => (Number.isInteger(foe?.group) ? num(foe.group)
    : num(foe?.slot) >= 1 && num(foe?.slot) <= 4 ? num(foe.slot) : Math.floor(num(foe?.slot) / 10));
const nOf = foe => (Number.isFinite(foe?.n) ? num(foe.n)
    : num(foe?.slot) >= 1 && num(foe?.slot) <= 4 ? 1 : num(foe?.slot) % 10);
const valueOf = foe => (Number.isFinite(foe?.value) ? foe.value : foe?.hurt);

function valuesAt(values, slot) {
    if (values instanceof Map) return values.get(slot);
    return values?.[slot];
}

/** The blocks one foe of this slot has, held to the block field's maximum (`maxOf(module, field)`). */
export function memberSize(foe, maxOf = () => Infinity) {
    const blocks = foe?.levelled ? foe.size ?? foeBlocksByLevel(foe.level) : foeHealthBlocks(foe.class);
    const limit = typeof maxOf === 'function' ? maxOf(foe?.module, hurtField(foe?.slot)) : Infinity;
    return Math.max(1, Math.min(num(blocks) || 1, Number.isFinite(limit) ? limit : Infinity));
}

/** The pack's bar size: one member's bar plus one block per three foes, at most 12. */
export const packSize = (memberBlocks, count) => Math.min(PACK_MAX_SIZE,
    Math.max(1, num(memberBlocks)) + Math.floor(Math.max(0, num(count)) / 3));

/** How many attacks a full pack makes each exchange. Rounding the count term gives a six-foe pack two and a twelve-foe pack three. */
export const packFullAttacks = count => Math.min(PACK_MAX_ATTACKS, 1 + Math.floor(Math.max(0, num(count)) / 6));

/** A pack's attacks now, thinning with its bar; 0 when it is Down. */
export function packAttacks(count, value, size) {
    if (num(value) <= 0) return 0;
    const full = packFullAttacks(count);
    return clamp(Math.ceil(full * num(value) / Math.max(1, num(size))), 1, full);
}

/** How many of a pack's foes are about left; 0 when it is Down. */
export const packLeft = (count, value, size) => (num(value) <= 0 ? 0
    : Math.ceil(Math.max(0, num(count)) * num(value) / Math.max(1, num(size))));

/** A virtual bar's slot: group 3, pack 2 is 32. Virtual slots are never a real slot 1..4. */
export const virtualSlot = (group, n) => num(group) * 10 + num(n);

/** How many foes each pack holds: packs of at most 12, evenly split, earlier packs taking the extra. */
export function packCounts(count) {
    const total = Math.max(0, num(count));
    if (total < 1) return [];
    const packs = Math.ceil(total / PACK_MAX_SIZE), even = Math.floor(total / packs), extra = total % packs;
    return Array.from({ length: packs }, (_, at) => even + (at < extra ? 1 : 0));
}

/** One roll's blocks against a pack: an area hit takes a third of its bar, plus one when decisive. */
export const packAreaBlocks = (size, decisive) => Math.ceil(num(size) / 3) + (decisive ? 1 : 0);

const memberName = (name, n, count) => (num(count) === 1 ? name : `${name} ${n}`);
const packValue = (hurt, one, size) => held(Math.ceil(size * held(hurt, one) / Math.max(1, one)), size);
const packName = (name, n, count) => (count === 1 ? name : `${name} pack ${n}`);

const carriedValues = carried => (carried && typeof carried.values === 'object' ? carried.values : null);
const carriedCount = (carried, group) => {
    const count = num(carried?.counts?.[group]);
    return count > 0 ? count : null;
};
const carriedValue = (values, slot) => (values && Object.hasOwn(values, slot) && Number.isFinite(Number(values[slot]))
    ? Number(values[slot]) : undefined);

/** Split filled, standing real slots into virtual foes, sorted by group then number. A Down group has no bars. */
export function splitFoes(realFoes, { carried = null, maxOf } = {}) {
    const out = [];
    for (const real of (Array.isArray(realFoes) ? realFoes : [])) {
        const group = num(real?.slot), blockCount = num(real?.count), hurt = num(real?.hurt);
        if (!real?.filled || blockCount <= 0) continue;
        const count = carriedCount(carried, group) ?? blockCount, values = carriedValues(carried);
        if (count === 1 && blockCount === 1) {
            // A real count-one foe always writes its own field. Its carried count only keeps a foe that went
            // Down during this open fight on the list; a group that was already Down was never in the fight.
            if (hurt <= 0 && carriedCount(carried, group) === null) continue;
            out.push(hurt <= 0 ? { ...real, hurt: 0 } : real);
            continue;
        }
        if (hurt <= 0) continue;
        const one = memberSize(real, maxOf);
        if (isPack(real)) {
            const counts = packCounts(count);
            counts.forEach((packCount, at) => {
                const n = at + 1, size = packSize(one, packCount);
                const exact = carriedValue(values, virtualSlot(group, n));
                const value = exact === undefined ? packValue(hurt, one, size) : held(exact, size);
                out.push({ ...real, slot: virtualSlot(group, n), group, n, name: packName(real.name, n, counts.length),
                    module: null, levelled: true, size, hurt: value, count: packCount, filled: true, pack: true });
            });
            continue;
        }
        for (let n = 1; n <= Math.min(MEMBER_CAP, count); n += 1) {
            const exact = carriedValue(values, virtualSlot(group, n));
            const value = exact === undefined ? held(hurt, one) : held(exact, one);
            out.push({ ...real, slot: virtualSlot(group, n), group, n, name: memberName(real.name, n, count), module: null,
                levelled: true, size: one, hurt: value, count: 1, filled: true, member: true });
        }
    }
    return out.sort((a, b) => groupOf(a) - groupOf(b) || nOf(a) - nOf(b));
}

/** The exact bars a committed result records as the next segment's carried state. */
export function carriedFrom(members) {
    const values = {}, counts = {};
    for (const member of (Array.isArray(members) ? members : [])) {
        const group = groupOf(member), slot = Number.isInteger(member?.slot) ? member.slot : virtualSlot(group, nOf(member) || 1);
        const value = Number(valueOf(member));
        if (!Number.isFinite(group) || !Number.isFinite(value)) continue;
        // Carried bars are for virtual foes only. A real count-one foe's next value comes from its live field.
        if (slot !== group) values[slot] = value;
        counts[group] = (counts[group] ?? 0) + (member?.pack ? Math.max(0, num(member.count)) : 1);
    }
    return Object.keys(counts).length ? { values, counts } : null;
}

function packBars(real, values, maxOf) {
    const one = memberSize(real, maxOf), group = num(real?.slot);
    return packCounts(real.count).map((count, at) => {
        const n = at + 1, size = packSize(one, count), raw = valuesAt(values, virtualSlot(group, n));
        return { count, n, one, size, value: raw === undefined ? 0 : held(raw, size) };
    });
}

/** Collapse virtual final values into ordinary count/hurt changes for the real Foes block. */
export function collapseFoes(realFoes, values, { maxOf } = {}) {
    const out = [];
    for (const real of (Array.isArray(realFoes) ? realFoes : [])) {
        const group = num(real?.slot), count = num(real?.count), hurt = num(real?.hurt);
        if (!real?.filled || count <= 0 || hurt <= 0) continue;
        let toCount = count, toHurt = 0;
        if (isPack(real)) {
            const standing = packBars(real, values, maxOf).filter(bar => bar.value > 0);
            if (standing.length) {
                toCount = standing.reduce((sum, bar) => sum + packLeft(bar.count, bar.value, bar.size), 0);
                toHurt = Math.max(...standing.map(bar => Math.max(1, Math.ceil(bar.one * bar.value / bar.size))));
            }
        } else {
            const one = memberSize(real, maxOf);
            const standing = Array.from({ length: Math.min(MEMBER_CAP, count) }, (_, at) => held(valuesAt(values, virtualSlot(group, at + 1)), one))
                .filter(value => value > 0);
            if (standing.length) { toCount = standing.length; toHurt = Math.max(...standing); }
        }
        out.push({ slot: group, module: real.module, count: { from: count, to: toCount }, hurt: { from: hurt, to: toHurt } });
    }
    return out;
}

/** The UI's virtual foe list: values override the bars rebuilt from the real block. */
export function boardFoes(realFoes, values, { maxOf, carried = null } = {}) {
    return splitFoes(realFoes, { maxOf, carried }).map(foe => {
        const size = Number.isFinite(Number(foe.size)) ? num(foe.size) : memberSize(foe, maxOf);
        const value = held(valuesAt(values, foe.slot) ?? foe.hurt, size), standing = value > 0;
        if (foe.pack) {
            return { slot: foe.slot, group: foe.group, n: foe.n, name: foe.name, value, size, pack: true, count: foe.count,
                left: packLeft(foe.count, value, size), attacks: packAttacks(foe.count, value, size), standing };
        }
        return { slot: foe.slot, group: groupOf(foe), n: nOf(foe), name: foe.name, value, size, pack: false, count: 1,
            left: standing ? 1 : 0, attacks: standing ? 1 : 0, standing };
    });
}
