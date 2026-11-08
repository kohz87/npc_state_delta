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

