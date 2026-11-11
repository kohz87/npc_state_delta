// NPC notes, lies told (phase 2 item 1): the slice record's `lies` leaf (one JSON text: [{ id, to, said, day, r, caught? }],
// at most six entries), its reader (readLies), adding a lie the story told (addLie), catching one (catchLie: stamps it and
// returns the trust change to run at a tier), the optional tail line for a present NPC's latest uncaught lie (lieTail), the
// dossier rows (lieRows: a `hidden` flag on every uncaught lie, and a `redact` option) and the caught receipt (caughtSummary).
// Pure: never imports npc-meters.js. The host writes the returned text inside the line's own op; nothing here touches storage.

export const LIES_MAX = 6;
export const LIE_TO_MAX = 40;
export const LIE_SAID_MAX = 120;
export const LIES_TEXT_MAX = 3200;
// The owner's decision (10 Nov): a caught lie is an extreme-tier trust drop of 6. The one place it is written; npc-notes-kinds.js re-exports it.
export const CAUGHT_TIER = 'extreme';
export const CAUGHT_DROP = 6;
const TIERS = ['ordinary', 'meaningful', 'major', 'extreme'];
const ID_MAX = 200;
const NAME_MAX = 120;

// Code points, not UTF-16 units, so the same cut as the neighbours (npc-notes-knows.js) and a cut never splits a character.
const clip = (value, max) => [...String(value ?? '').replace(/\s+/g, ' ').trim()].slice(0, max).join('').trim();
const replyOk = value => (typeof value === 'string' && value.length > 0 && value.length <= 80) || (Number.isSafeInteger(value) && value >= 0);
// A story day is null when the story has no clock (clockDay in npc-meters.js).
const dayOk = value => value === null || (Number.isSafeInteger(value) && value >= 0);
const sameName = (a, b) => clip(a, LIE_TO_MAX).toLowerCase() === clip(b, LIE_TO_MAX).toLowerCase();
const text = (value, max) => typeof value === 'string' && value.length > 0 && [...value].length <= max;

function validLie(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    if (!text(item.id, ID_MAX) || !text(item.to, LIE_TO_MAX) || !text(item.said, LIE_SAID_MAX)) return false;
    if (!dayOk(item.day) || !replyOk(item.r)) return false;
    if (item.caught === undefined) return true;
    return !!item.caught && typeof item.caught === 'object' && !Array.isArray(item.caught) && dayOk(item.caught.day) && replyOk(item.caught.r);
}

/** The parsed lies of stored text (oldest first), or null when the text is absent, too long, or not valid in every part. */
export function readLies(stored) {
    if (typeof stored !== 'string' || !stored || stored.length > LIES_TEXT_MAX) return null;
    let value;
    try { value = JSON.parse(stored); } catch { return null; }
    if (!Array.isArray(value) || value.length > LIES_MAX || !value.every(validLie)) return null;
    return value;
}

const listOf = stored => readLies(stored) || [];

// Over the cap, the oldest caught lie goes first; with none caught, the oldest lie goes.
function capped(list) {
    const out = [...list];
    while (out.length > LIES_MAX) {
        const caughtAt = out.findIndex(item => item.caught);
        out.splice(caughtAt >= 0 ? caughtAt : 0, 1);
    }
    return out;
}

/**
 * A lie the story told: { text, entry, changed, problem }. `text` is the whole new leaf (the prior text when nothing changed).
 * A Re-read of the same reply replaces its own entry (id = reply, person and words, and a caught stamp is kept). The same words
 * to the same person on the same day, from another reply, are a no-op. Without who it was told to, what was said, or a valid
 * day and reply, nothing is written and `problem` says why.
 */
export function addLie(prior, { to, said, day = null, r } = {}) {
    const teller = clip(to, LIE_TO_MAX);
    const words = clip(said, LIE_SAID_MAX);
    const refuse = problem => ({ text: prior, entry: null, changed: false, problem });
    if (!teller || !words) return refuse('A lie needs who it was told to and what was said.');
    if (!dayOk(day) || !replyOk(r)) return refuse('A lie needs a valid story day and reply.');
    const before = listOf(prior);
    const id = `${String(r)}:${teller}:${words}`.slice(0, ID_MAX);
    const old = before.find(item => item.id === id);
    const kept = before.filter(item => item.id !== id);
    if (kept.some(item => !item.caught && sameName(item.to, teller) && item.said === words && item.day === day)) return refuse('');
    const entry = { id, to: teller, said: words, day, r };
    if (old?.caught) entry.caught = { ...old.caught };
    const next = JSON.stringify(capped([...kept, entry]));
    if (next.length > LIES_TEXT_MAX) return refuse('The lies are too long to record.');
    return { text: next, entry, changed: true, problem: '' };
}

/**
 * The meter change a caught lie makes, for run(): trust down by `drop` at `tier` (both are the owner's settings; the defaults
 * are CAUGHT_TIER and CAUGHT_DROP, the owner's decision).
 */
export function caughtChange(tier = CAUGHT_TIER, drop = CAUGHT_DROP) {
    return { changes: [{ meter: 'trust', mode: 'add', value: -drop }], impact: { tier } };
}

/**
 * Stamps the latest uncaught lie to `to` (and, when given, whose words contain `said`, ignoring case) as caught at { day, r }.
 * → { text, entry, change } with `change` the trust change at `tier` (see caughtChange), or null when no lie matches or the
 * tier or drop is not usable.
 */
export function catchLie(prior, { to, said, day = null, r, tier = CAUGHT_TIER, drop = CAUGHT_DROP } = {}) {
    const teller = clip(to, LIE_TO_MAX);
    const words = clip(said, LIE_SAID_MAX).toLowerCase();
    if (!teller && !words) return null;
    if (!TIERS.includes(tier) || !Number.isSafeInteger(drop) || drop <= 0 || !dayOk(day) || !replyOk(r)) return null;
    const list = listOf(prior);
    let at = -1;
    list.forEach((item, i) => {
        if (item.caught) return;
        if (teller && !sameName(item.to, teller)) return;
        if (words && !item.said.toLowerCase().includes(words)) return;
        at = i;
    });
    if (at < 0) return null;
    const entry = { ...list[at], caught: { day, r } };
    const next = list.map((item, i) => (i === at ? entry : item));
    return { text: JSON.stringify(next), entry, change: caughtChange(tier, drop) };
}

/**
 * The one optional tail line for a present NPC: their latest uncaught lie, or '' when there is none. The text is hidden, so the
 * caller puts it under the shared (hidden) wording of src/npc-meters-prompt.js; this line is never shown to the reader.
 */
export function lieTail(name, stored) {
    const open = listOf(stored).filter(item => !item.caught);
    const last = open.at(-1);
    if (!last) return '';
    return `${clip(name, NAME_MAX)} (hidden): told ${last.to} "${last.said}"; stay consistent unless caught.`;
}

/**
 * Dossier rows, oldest first: { id, to, said, day, hidden, caught }. `hidden` is set on every uncaught lie. With `redact` (the
 * default, since the owner has not chosen plain or redacted) a hidden row's `said` is null, so the view can show "a lie to Astra ·
 * hidden" without the words; `redact: false` shows the words of every row.
 */
export function lieRows(stored, { redact = true } = {}) {
    return listOf(stored).map((item, i) => {
        const hidden = !item.caught;
        const secret = hidden && redact;
        return {
            // The stored id embeds the words, so a redacted row gets an opaque place number instead.
            id: secret ? `lie-${i}` : item.id,
            to: item.to,
            said: secret ? null : item.said,
            day: item.day,
            hidden,
            caught: item.caught ? { ...item.caught } : null,
        };
    });
}

/** The caught receipt and next-reply cue: "Rika: caught in a lie to Astra; trust 11 → 5." (no trust numbers: "…to Astra.") */
export function caughtSummary(name, to, before, after) {
    const head = `${clip(name, NAME_MAX)}: caught in a lie to ${clip(to, LIE_TO_MAX)}`;
    return Number.isFinite(before) && Number.isFinite(after) ? `${head}; trust ${before} → ${after}.` : `${head}.`;
}
