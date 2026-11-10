// What the hosted slice does with a held event: the reader's words for the receipt and the cut of a forwarded scanner change to a
// lower tier. A pure part of the pacing rule (src/relationship-pacing.js, which holds the count); never imports npc-meters.js.
import { RELATIONSHIP_KEYS, RELATIONSHIP_MILESTONE_REQUIREMENTS, RELATIONSHIP_MILESTONE_THRESHOLDS } from '../core-relationship-model.js';
import { PACING_TIERS } from './relationship-pacing.js';
import { NPC_KIND } from './npc-meters-config.js';

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

const TIER = '(ordinary|meaningful|major|extreme)';
const CUT_NOTE = new RegExp(`\\(${TIER} counted as ${TIER}: today's [^)]*\\)`);
const HELD_NOTE = /nothing changed \((today's [^)]*)\)/;
const ASKED_NOTE = /([a-z]+) -?\d+ → -?\d+ \(held at -?\d+[^;)]*; ([+-]?\d+) asked\)/g;
const RANK = name => PACING_TIERS.indexOf(name);

/**
 * What the newest reply that touched one NPC's four built-in meters did, read from Story Block's own receipts of that reply (the
 * host's `receipts()`: [{ index, receipt }] on the current line of history; nothing is stored for it, so a swipe, a deleted
 * message or a reload gives the card of the reply that remains). Looks at NPC State Delta's story-line receipts (`capture.npc`) and
 * its scanner's (`npc.adjust`) for `key`, newest reply first, and reads each receipt's moved amounts (`data.changes`), its held
 * meters' "+N asked" and the pacing words of its summary.
 * → { reply, delta: { trust, ... } (what moved), source ('story' when a story line's receipt took part, else 'scanner'),
 * scannerMoved (the scanner's receipt moved a meter), held ('' or the reader's words: the day's allowance held it and nothing
 * moved), ask: { axis: n } (what a held meter asked), tier (the tier actually spent, only when pacing cut it) } or null.
 */
export function lastChangeOf(entries, key) {
    const mine = (Array.isArray(entries) ? entries : []).filter(({ index, receipt }) => Number.isInteger(index)
        && receipt?.module === 'npc-state-delta' && (receipt.type === 'npc.adjust' || receipt.type === `capture.${NPC_KIND}`)
        && receipt.data?.key === key && Array.isArray(receipt.data.changes));
    const replies = [...new Set(mine.map(entry => entry.index))].sort((a, b) => b - a);
    for (const reply of replies) {
        const delta = Object.fromEntries(RELATIONSHIP_KEYS.map(axis => [axis, 0]));
        const ask = {};
        let story = false;
        let scannerMoved = false;
        let held = '';
        let tier = '';
        for (const { index, receipt } of mine) {
            if (index !== reply) continue;
            const summary = typeof receipt.summary === 'string' ? receipt.summary : '';
            let moved = false;
            for (const change of receipt.data.changes) {
                if (!RELATIONSHIP_KEYS.includes(change?.meter) || !Number.isInteger(change.before) || !Number.isInteger(change.after) || change.after === change.before) continue;
                delta[change.meter] += change.after - change.before;
                moved = true;
            }
            for (const [, axis, amount] of summary.matchAll(ASKED_NOTE)) if (RELATIONSHIP_KEYS.includes(axis)) ask[axis] = Number(amount);
            const cut = CUT_NOTE.exec(summary)?.[2];
            if (cut && RANK(cut) >= RANK(tier)) tier = cut;
            const words = HELD_NOTE.exec(summary)?.[1];
            if (words && !receipt.data.changes.length) held = words;
            if (receipt.type === 'npc.adjust') scannerMoved ||= moved;
            else story ||= moved || Boolean(words);
        }
        if (!Object.values(delta).some(Boolean) && !held) continue;
        const asked = Object.fromEntries(Object.entries(ask).filter(([axis]) => delta[axis] !== undefined));
        return { reply, delta, source: story ? 'story' : 'scanner', scannerMoved, held: Object.values(delta).some(Boolean) ? '' : held, ...(Object.keys(asked).length ? { ask: asked } : {}), ...(tier ? { tier } : {}) };
    }
    return null;
}
