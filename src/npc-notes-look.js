// The locked look of an NPC (NSDMAP2 §5): the first grounded durable look is the lock. This file holds the pure pieces the
// scan and the slice use: the drift text for a durable look the scan refused (lookDrift), the one-reply cue that goes with
// it (lookFlagWording, sent as npc.flag with narrate: true), the Problem key that dedupes it (lookFlagKey), and the stamp
// that records when the look was first set (lookLockedAt: { day, r }, restored with the appearance revert group).
// Pure: no DOM, no host, no imports; it never imports npc-meters.js.

export const LOOK_TEXT_MAX = 160;
const NAME_MAX = 40;
const REPLY_MAX = 80;
const FLAG_TEXT_MAX = 300;

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const clean = (value, max) => [...String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, max).join('');
const comparable = value => clean(value, LOOK_TEXT_MAX).toLocaleLowerCase().replace(/[.;,\s]+$/g, '');
const possessive = name => (/s$/i.test(name) ? `${name}'` : `${name}'s`);

/** The locked look text, cleaned and capped to LOOK_TEXT_MAX ('' when there is none). */
export function lookText(value) {
    return clean(value, LOOK_TEXT_MAX);
}

/**
 * The drift the scan refused: `before` is the locked look, `rejected` the incoming durable text (a string, or { incoming }).
 * → '' when there is no lock, nothing incoming, or the same look (case, spacing and a closing full stop ignored).
 * Otherwise: `Look drift refused: "<rejected>" does not match the fixed look "<before>".`
 * (card traits win) With `rejected.swaps` ([{ trait, said, kept }], the traits a refine swapped and the record kept) and `name`:
 * `Look drift refused: the story called Temiwa's eyes pale; the record keeps brown.` (one clause pair per trait).
 */
export function lookDrift(before, rejected) {
    const locked = lookText(before);
    const incoming = lookText(isObject(rejected) ? rejected.incoming : rejected);
    const swaps = isObject(rejected) && Array.isArray(rejected.swaps) ? rejected.swaps.filter(swap => isObject(swap) && clean(swap.trait, 20) && clean(swap.said, 40) && clean(swap.kept, 40)) : [];
    if (!locked || !incoming || (!swaps.length && comparable(locked) === comparable(incoming))) return '';
    // A kept swap may sit past the capped text both looks share, so it is named whatever their first words.
    if (swaps.length) {
        const who = possessive(clean(rejected.name, NAME_MAX) || 'The NPC');
        return `Look drift refused: ${swaps.map((swap, index) => `${index ? 'The' : 'the'} story called ${who} ${clean(swap.trait, 20)} ${clean(swap.said, 40)}; the record keeps ${clean(swap.kept, 40)}`).join('. ')}.`;
    }
    return `Look drift refused: "${incoming}" does not match the fixed look "${locked}".`;
}

/**
 * The next-reply cue for a refused look (npc.flag, narrate: true), e.g. `Rika's look is fixed: white hair, yellow-green eyes.
 * Keep it unless the story shows why it changed.` → '' without a locked look. A missing name reads as "The NPC".
 */
export function lookFlagWording(name, before) {
    const locked = lookText(before);
    if (!locked) return '';
    const who = clean(name, NAME_MAX) || 'The NPC';
    return `${possessive(who)} look is fixed: ${locked.replace(/[.;,\s]+$/, '')}. Keep it unless the story shows why it changed.`;
}

/**
 * The key note() dedupes a look flag by: the same reply with the same text is one Problem, so a re-scan of that reply adds
 * nothing new. → 'reply|text' (both cleaned and capped).
 */
export function lookFlagKey(reply, text) {
    return `${clean(reply, REPLY_MAX)}|${clean(text, FLAG_TEXT_MAX)}`;
}

/** A stamp { day, r } for the reply that set the look, or null when the day is not a whole number >= 0 or r is empty. */
export function lookStamp(day, r) {
    const whole = Math.trunc(Number(day));
    const reply = clean(r, REPLY_MAX);
    if (!Number.isFinite(whole) || whole < 0 || !reply) return null;
    return { day: whole, r: reply };
}

/** A stored stamp read back; anything malformed is null, never thrown. */
export function readLookStamp(value) {
    return isObject(value) ? lookStamp(value.day, value.r) : null;
}

/**
 * The stamp after an update. It is set when the look goes from empty to set (the first grounded look is the lock) and
 * otherwise kept as it was, so a later refinement never moves it. `before`/`after` are overallAppearance texts; `stamp` is
 * the stored lookLockedAt; `day`/`r` are the reply. → the stamp, or null.
 */
export function stampLook(before, after, stamp, day, r) {
    const stored = readLookStamp(stamp);
    if (lookText(before) || !lookText(after)) return stored;
    return lookStamp(day, r) ?? stored;
}

/** True when the look is locked: it has text and a readable stamp. This is what the "Look 🔒" mark reads. */
export function isLookLocked(text, stamp) {
    return Boolean(lookText(text) && readLookStamp(stamp));
}
