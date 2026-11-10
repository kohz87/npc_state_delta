// What the hosted slice does with a held event: the reader's words for the receipt and the cut of a forwarded scanner change to a
// lower tier. A pure part of the pacing rule (src/relationship-pacing.js, which holds the count); never imports npc-meters.js.
import { RELATIONSHIP_KEYS, RELATIONSHIP_MILESTONE_REQUIREMENTS, RELATIONSHIP_MILESTONE_THRESHOLDS } from '../core-relationship-model.js';
import { PACING_TIERS } from './relationship-pacing.js';

const list = words => (words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0]);

/** The reader's words for a held event ('' when it counted as asked): "major counted as meaningful: today's major is used". */
export function pacingNote(tier, used, skipped) {
    if (!skipped.length || used === tier) return '';
    const full = `today's ${list(skipped)} ${skipped.length > 1 ? 'are' : 'is'} used`;
    return used ? `${tier} counted as ${used}: ${full}` : full;
}

/**
 * A scanner change already weighed at its asked tier (`changes`: [{ meter, value }] nets), cut down to what `used` allows:
 * each step within that tier's points, and no built-in relationship step across a gate needing a higher tier than `used`
 * (it stops on the gate). `value(meter)` reads the meter's value now. → the cut changes.
 */
export function cutToTier(changes, used, caps, value) {
    const rank = name => PACING_TIERS.indexOf(name);
    return changes.map(change => {
        const before = value(change.meter);
        let step = Math.max(-caps[used], Math.min(caps[used], change.value));
        const sign = Math.sign(step);
        if (RELATIONSHIP_KEYS.includes(change.meter) && sign && (before === 0 || Math.sign(before) === sign)) {
            for (const gate of RELATIONSHIP_MILESTONE_THRESHOLDS) {
                if (rank(RELATIONSHIP_MILESTONE_REQUIREMENTS[gate]) <= rank(used)) continue;
                if (Math.abs(before) <= gate && Math.abs(before + step) > gate) step = sign * (gate - Math.abs(before));
            }
        }
        return { ...change, value: step };
    });
}

/**
 * What the event asked, per built-in axis, before pacing and the yield to a story line: { trust: +1, ... } (whole numbers, none
 * for a meter the event leaves alone or one the story line already named: `left`). `value(meter)` is the meter now (for `=N`).
 */
export function askedAmounts(changes, left, value) {
    const out = {};
    for (const change of changes) {
        if (!RELATIONSHIP_KEYS.includes(change.meter) || left.includes(change.meter) || !Number.isInteger(change.value)) continue;
        const step = change.mode === 'add' ? change.value : change.value - value(change.meter);
        if (step) out[change.meter] = (out[change.meter] ?? 0) + step;
    }
    return out;
}

/** Keeps on the reply's window what the event asked (summed per axis), its tier (the highest of the reply) and the story date (the first). */
export function stampEvent(turn, { ask, tier, date }) {
    if (ask && Object.keys(ask).length) {
        const sum = { ...(turn.ask ?? {}) };
        for (const [key, step] of Object.entries(ask)) sum[key] = (sum[key] ?? 0) + step;
        turn.ask = Object.fromEntries(Object.entries(sum).filter(([, step]) => step));
        if (!Object.keys(turn.ask).length) delete turn.ask;
    }
    if (PACING_TIERS.includes(tier) && !(PACING_TIERS.indexOf(turn.tier) >= PACING_TIERS.indexOf(tier))) turn.tier = tier;
    if (date && !turn.date) turn.date = date;
}

const FLAT_DAY = /^d(-?\d{1,9}):(ordinary|meaningful|major|extreme)$/;

/**
 * What the newest reply did to one NPC's four built-in meters, read from the record as it is kept (nothing is stored for it):
 * { reply (index), delta: { trust, ... } (the net change from the reply's start: after pacing, caps and gates), source ('story' when a
 * story line took part, else 'scanner'), held (the reader's words when the day's allowance was used up and nothing moved, else '') },
 * or null when nothing moved and nothing was held; plus, when the window kept them (stampEvent): ask (what was asked per axis), tier (the
 * impact tier the event spent, or the tier it asked when held) and date (the story date before the reply). A held change names the asked tier.
 */
export function lastChangeOf(record, allowance) {
    const turn = record?.turn;
    if (!turn || typeof turn !== 'object' || !turn.from || typeof turn.from !== 'object') return null;
    const reply = Number.isInteger(turn.at) ? turn.at : Number.isInteger(turn.reply) ? turn.reply : null;
    if (reply === null) return null;
    const delta = Object.fromEntries(RELATIONSHIP_KEYS.map(key => [key, Number.isInteger(record.meters?.[key]) && Number.isInteger(turn.from[key]) ? record.meters[key] - turn.from[key] : 0]));
    const moved = Object.values(delta).some(Boolean);
    let held = '';
    const day = record.impactDay;
    if (!moved && allowance && day && typeof day === 'object' && day.reply === turn.reply) {
        const days = new Set(Object.keys(day).map(key => FLAT_DAY.exec(key)?.[1]).filter(Boolean));
        const [only] = days;
        const full = [];
        const reach = PACING_TIERS.includes(turn.tier) ? PACING_TIERS.indexOf(turn.tier) + 1 : PACING_TIERS.length;
        if (days.size === 1) for (const tier of PACING_TIERS.slice(0, reach)) {
            if (allowance[tier] === null || allowance[tier] === undefined || !(day[`d${only}:${tier}`] >= allowance[tier])) break;
            full.push(tier);
        }
        if (full.length === reach || (reach === PACING_TIERS.length && full.length)) held = pacingNote(full.at(-1), null, full);
    }
    if (!moved && !held) return null;
    const ask = turn.ask && typeof turn.ask === 'object' ? turn.ask : null;
    return { reply, delta, source: Array.isArray(turn.story) ? 'story' : 'scanner', held, ...(ask ? { ask } : {}), ...(turn.tier ? { tier: turn.tier } : {}), ...(turn.date ? { date: turn.date } : {}) };
}
