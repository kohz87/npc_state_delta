// Key people, read from Story Director (the user's decision, 1 Nov): Story Director owns who is a key person and
// where they are when they are away; Delta only READS its query `director.keyPeople` and shows it in the dossier,
// on the present cards and in the narrator's dossier text, and holds a key person's stable fields still while
// they are away. Nothing here writes to Story Director. Without Story Director, or with one that lacks the
// query, `keyPeople()` is null and nothing anywhere changes: Delta alone has no key people.
//
// The query: `director.keyPeople` → [{ name, aliases?, here: bool, away: { doing, since, back, steps: [{ date,
// text }] } | null, removed?: { reason, on } }]. A `removed` entry is no longer a key person (archived, dead or
// unpinned): it gets no badge, no section and no hold. `since`, `back` and a step's `date` are story minutes (null when not
// known); the adapter's `storyMinuteText` writes them as "Goldwane 18" on Story Director's calendar.
//
// The answer says only who is away NOW. After the return it is null again, so Delta keeps a small memory of the
// last absence (`state.keyAway`, by dossier id) to show "While away" until the person has been present for a few
// replies, and to give the narrator the summary once (see observeKeyAway). Everything here is pure and takes its
// inputs; index.js, the adapter and core.js call it.

/** Replies a returned key person must be present for before the dossier drops "While away". */
export const RECENT_REPLIES = 3;
/** The stable profile fields and the custom fields a scan leaves alone while a key person is away (as if locked). */
export const AWAY_LOCKED_FIELDS = Object.freeze(['personality', 'speech', 'appearance', 'mannerisms', 'behaviorProfile', 'background', 'customFields']);
/** The longest "While away" summary the narrator is given with the returned person's dossier. */
export const RETURN_NOTE_CHARS = 360;

const NAME_MAX = 80;
const ALIASES_MAX = 8;
const PEOPLE_MAX = 50;
const STEPS_MAX = 12;
const TEXT_MAX = 200;
const DATE_MAX = 40;
const MEMORY_MAX = 40;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clip = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();

/** A name as a comparison key: letters and digits only, lowercase (the same reading as Delta's own name match). */
export function labelKey(value) {
    return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// A date as text: Story Director sends story minutes (null when not known), which `dateText` writes on the chat's
// calendar ('' without one); a date already given as words is kept.
const dateOf = (value, dateText) => {
    if (Number.isSafeInteger(value)) {
        let text = '';
        try { text = typeof dateText === 'function' ? clip(dateText(value), DATE_MAX) : ''; } catch { text = ''; }
        return text;
    }
    return typeof value === 'string' ? clip(value, DATE_MAX) : '';
};

function normalizeAway(raw, dateText) {
    if (!isObject(raw)) return null;
    const steps = (Array.isArray(raw.steps) ? raw.steps : [])
        .filter(isObject)
        .map(step => ({ date: dateOf(step.date, dateText), text: clip(step.text, TEXT_MAX) }))
        .filter(step => step.text)
        .slice(-STEPS_MAX);
    return { doing: clip(raw.doing, TEXT_MAX), since: dateOf(raw.since, dateText), back: dateOf(raw.back, dateText), steps };
}

/**
 * Story Director's answer as a clean list: [{ name, aliases, here, away: { doing, since, back, steps } | null,
 * removed: { reason, on } | null }], texts cut and cleaned, at most 50 people. Its dates are story minutes: `dateText`
 * (minutes → "Goldwane 18") writes them; without it a minute has no text. A removed person never has an away record
 * here. Anything that is not an array gives [] (the adapter tells "no answer" apart: null).
 */
export function normalizeKeyPeople(answer, dateText = null) {
    if (!Array.isArray(answer)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of answer.slice(0, PEOPLE_MAX)) {
        if (!isObject(raw)) continue;
        const name = clip(raw.name, NAME_MAX);
        const key = labelKey(name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const removed = isObject(raw.removed) ? { reason: clip(raw.removed.reason, NAME_MAX), on: dateOf(raw.removed.on, dateText) } : null;
        out.push(Object.freeze({
            name,
            aliases: (Array.isArray(raw.aliases) ? raw.aliases : []).map(alias => clip(alias, NAME_MAX)).filter(Boolean).slice(0, ALIASES_MAX),
            here: raw.here === true,
            away: removed ? null : normalizeAway(raw.away, dateText),
            removed,
        }));
    }
    return out;
}

/** Whether the entry is a current key person (pinned, not removed). */
export const isKey = entry => Boolean(entry) && !entry.removed;
/** Whether the entry is a current key person who is away now. */
export const isAway = entry => isKey(entry) && Boolean(entry.away);

/** The comparison keys of an entry's name and aliases. */
export const labelsOf = entry => [entry?.name, ...(Array.isArray(entry?.aliases) ? entry.aliases : [])].map(labelKey).filter(Boolean);

/** The entry of `list` that names the dossier (by its name or an alias, either side), or null. */
export function findKeyEntry(list, npc) {
    if (!Array.isArray(list) || !list.length || !npc) return null;
    const mine = [npc.name, ...(Array.isArray(npc.aliases) ? npc.aliases : [])].map(labelKey).filter(Boolean);
    if (!mine.length) return null;
    return list.find(entry => labelsOf(entry).some(label => mine.includes(label))) ?? null;
}

/** The ids of the dossiers that are key people away now. */
export function awayNpcIds(list, npcs) {
    const ids = new Set();
    for (const npc of Array.isArray(npcs) ? npcs : []) {
        if (npc?.id && isAway(findKeyEntry(list, npc))) ids.add(String(npc.id));
    }
    return ids;
}

// ---- the dates and the words ----

/** "Gw 12 – Gw 18" for an absence ('' when neither date is known). */
export function awayRange(away) {
    if (!away) return '';
    if (away.since && away.back) return `${away.since} – ${away.back}`;
    if (away.since) return `since ${away.since}`;
    if (away.back) return `until ${away.back}`;
    return '';
}

/**
 * What the narrator is told once, with the returned person's dossier: where they went, the steps, and the
 * dates, in one short line (at most `max` characters, cut at a step, never mid-word).
 */
export function returnNote(away, max = RETURN_NOTE_CHARS) {
    if (!away) return '';
    const range = awayRange(away);
    const head = `WHILE AWAY, NOW BACK${range ? ` (${range})` : ''}: ${away.doing || 'away'}`;
    const steps = (away.steps ?? []).map(step => (step.date ? `${step.date}: ${step.text}` : step.text));
    let text = head;
    // The newest steps matter most; keep as many as fit, oldest dropped first.
    for (let from = Math.max(0, steps.length - 4); from < steps.length; from += 1) {
        const tail = steps.slice(from).join('; ');
        const candidate = `${head}; ${tail}`;
        if (candidate.length <= max) { text = candidate; break; }
    }
    if (text.length > max) text = `${text.slice(0, Math.max(0, max - 1)).replace(/\s+\S*$/, '').trimEnd()}…`;
    return text;
}

// ---- the memory of the last absence ----

/**
 * Notes the answer into the memory (`state.keyAway`: { [dossier id]: { away, returnedAt, presentReplies,
 * lastHead } }) at reply `head`, and gives back { memory, changed }:
 * - a key person away now: their record is kept as it stands (the newest steps), not yet returned;
 * - one who was away and is not any more: returned at `head`, and each later reply they are `here` counts toward
 *   `RECENT_REPLIES`, after which the record is dropped;
 * - a swipe or delete that takes `head` back before the return clears the return (the answer decides again);
 * - anyone no longer a key person, or no longer a dossier, is dropped.
 * It never reads anything but its arguments.
 */
export function observeKeyAway(memory, list, npcs, head) {
    const before = isObject(memory) ? memory : {};
    if (!Number.isInteger(head) || head < 0 || !Array.isArray(list)) return { memory: before, changed: false };
    const next = {};
    for (const npc of Array.isArray(npcs) ? npcs : []) {
        const id = npc?.id ? String(npc.id) : '';
        const entry = id ? findKeyEntry(list, npc) : null;
        if (!id || !isKey(entry)) continue;
        const had = isObject(before[id]) && before[id].away ? before[id] : null;
        if (entry.away) {
            next[id] = { away: entry.away, returnedAt: null, presentReplies: 0, lastHead: head };
            continue;
        }
        if (!had) continue;
        let returnedAt = Number.isInteger(had.returnedAt) && had.returnedAt <= head ? had.returnedAt : head;
        let present = Number.isInteger(had.presentReplies) && had.presentReplies > 0 ? had.presentReplies : 0;
        if (returnedAt === head && had.returnedAt !== head) present = 0;
        else if (entry.here && Number.isInteger(had.lastHead) && head > had.lastHead) present += 1;
        present = Math.min(present, Math.max(0, head - returnedAt), RECENT_REPLIES);
        if (present >= RECENT_REPLIES) continue;
        next[id] = { away: had.away, returnedAt, presentReplies: present, lastHead: head };
    }
    const kept = Object.fromEntries(Object.entries(next).slice(0, MEMORY_MAX));
    const changed = JSON.stringify(kept) !== JSON.stringify(before);
    return { memory: changed ? kept : before, changed };
}

/**
 * What the dossier, the cards and the narrator show for one dossier, or null when the person is not a key
 * person: { name, here, away: {…} | null, recent: { away, justReturned } | null }. `recent` is the last absence of
 * someone who has come back and has not yet been present for a few replies; `justReturned` is true at the reply
 * the return was noticed (the narrator is told then, once: when the next reply starts the head has moved on).
 */
export function keyView(list, memory, npc, head) {
    const entry = findKeyEntry(list, npc);
    if (!isKey(entry)) return null;
    const view = { name: entry.name, here: entry.here, away: entry.away ?? null, recent: null };
    const kept = isObject(memory) && npc?.id ? memory[String(npc.id)] : null;
    if (!entry.away && kept?.away && Number.isInteger(kept.returnedAt) && Number.isInteger(head) && head >= kept.returnedAt
        && (kept.presentReplies ?? 0) < RECENT_REPLIES) {
        view.recent = { away: kept.away, justReturned: head === kept.returnedAt };
    }
    return view;
}

// ---- holding a key person's stable fields still while they are away ----

/**
 * The state with the away key people's stable profile fields and custom fields locked, for one scan's merge:
 * { state, restore(npcs) } — `restore` puts each locked dossier's own lock list back, so nothing of this
 * is stored. Null when nobody is away (the merge then runs on the state itself).
 */
export function lockAwayNpcs(state, ids) {
    const away = ids instanceof Set ? ids : new Set(Array.isArray(ids) ? ids.map(String) : []);
    if (!away.size || !Array.isArray(state?.npcs)) return null;
    const saved = new Map();
    const npcs = state.npcs.map(npc => {
        const id = npc?.id ? String(npc.id) : '';
        if (!id || !away.has(id)) return npc;
        const own = Array.isArray(npc.manualProfileFields) ? [...npc.manualProfileFields] : [];
        saved.set(id, own);
        return { ...npc, manualProfileFields: [...new Set([...own, ...AWAY_LOCKED_FIELDS])] };
    });
    if (!saved.size) return null;
    return {
        state: { ...state, npcs },
        restore: list => (Array.isArray(list) ? list : []).map(npc => {
            const own = saved.get(npc?.id ? String(npc.id) : '');
            return own ? { ...npc, manualProfileFields: [...own] } : npc;
        }),
    };
}
