// NPC notes, "knows about others" (the `~ know` line): the stored list of what a person knows about someone else (one JSON text
// leaf per record, each entry keyed by its reply `r` so a Re-read of the same reply replaces its own entries), the input check, the
// secret redaction (a secret fact shows as "a secret about X · hidden" until the story opens it with openKnow, or the caller asks
// to show it), the one optional tail line per present person, and the dossier rows. Pure: no storage, no host, and it never imports
// npc-meters.js, so it runs alone in tests. The host decides who is present and what is optional.

export const KNOWS_MAX = 6;
export const KNOW_FACT_MAX = 140;
export const KNOW_ABOUT_MAX = 40;
export const KNOWS_TEXT_MAX = 2000;
export const KNOWS_TAIL_PER_NPC = 1;
export const KNOWS_TAIL_MAX = 4;
export const KNOW_HOW = Object.freeze(['saw', 'heard']);
export const KNOW_RULE = 1;
const REPLY_KEY_MAX = 80;
// Rule mark (KNOW_RULE): `how:` is read by its words (see/hear families). Only new lines read so; a stored reply whose line was refused replays refused.
const SEE_WORDS = new Set(['saw', 'seen', 'see', 'sees', 'seeing', 'shown', 'show', 'showed', 'shows', 'witnessed', 'watched', 'verified', 'read', 'found', 'spotted', 'noticed', 'checked', 'inspected']);
const HEAR_WORDS = new Set(['heard', 'hear', 'hears', 'told', 'tell', 'said', 'overheard', 'rumour', 'rumor', 'rumours', 'rumors', 'gossip', 'reported', 'informed']);
/** The canonical 'saw' or 'heard' for a written `how:` value, or null when it names neither. Both kinds in one value give 'saw'. */
export function readHow(value) {
    const words = String(value ?? '').toLowerCase().match(/[a-z]+/g) ?? [];
    if (words.some(word => SEE_WORDS.has(word))) return 'saw';
    return words.some(word => HEAR_WORDS.has(word)) ? 'heard' : null;
}
const SECRET_TAIL_NOTE = 'never reveal it unless the story shows them telling.';

// The same cleaning as the neighbours (control characters to spaces, runs of space to one, cut to `max` characters).
const clean = (value, max) => [...String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, max).join('').trim();
const wholeDay = value => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const replyKeyOk = value => (typeof value === 'string' && value.length > 0 && value.length <= REPLY_KEY_MAX) || (Number.isSafeInteger(value) && value >= 0);
const sameFact = (a, b) => a.about.toLowerCase() === b.about.toLowerCase() && a.fact.toLowerCase() === b.fact.toLowerCase();

/**
 * One stored or written entry, cleaned: { about, fact, how, day, r, secret? } or null. `about` and `fact` are needed, `how` is
 * 'saw' or 'heard' only, `r` is the reply key, `day` is a whole story day or null. `secret` is kept only when it is true.
 */
function knowOf(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const about = clean(item.about, KNOW_ABOUT_MAX);
    const fact = clean(item.fact, KNOW_FACT_MAX);
    if (!about || !fact || !KNOW_HOW.includes(item.how) || !replyKeyOk(item.r)) return null;
    if (item.day !== undefined && item.day !== null && wholeDay(item.day) === null) return null;
    const entry = { about, fact, how: item.how, day: wholeDay(item.day), r: item.r };
    if (item.secret === true) entry.secret = true;
    if (item.rule === KNOW_RULE) entry.rule = KNOW_RULE;
    return entry;
}

/** A source (the stored text, or an array of entries) as clean entries, at most KNOWS_MAX, oldest first. */
function listOf(source) {
    if (typeof source === 'string') return readKnows(source);
    return Array.isArray(source) ? source.map(knowOf).filter(Boolean).slice(-KNOWS_MAX) : [];
}

/** The stored list of a record's `knows` leaf (JSON text), oldest first, at most KNOWS_MAX. Bad text or bad entries give nothing for those parts. */
export function readKnows(text) {
    if (typeof text !== 'string' || !text || text.length > KNOWS_TEXT_MAX) return [];
    let value;
    try { value = JSON.parse(text); } catch { return []; }
    if (!Array.isArray(value)) return [];
    return value.map(knowOf).filter(Boolean).slice(-KNOWS_MAX);
}

/**
 * Records one reply's `~ know` lines (`lines`: [{ about, fact, how, secret?, day? }]). The reply's earlier entries are replaced
 * (a Re-read), and so is any older entry with the same about and fact (a second source for it refreshes it, it does not repeat it).
 * The list keeps the newest KNOWS_MAX. → { text, problem }: `text` is the whole new leaf, or null with a `problem` when a line is
 * bad (the whole reply's command is then refused, nothing is written). An empty `lines` clears the reply's entries.
 */
export function addKnow(prior, reply, lines, { tolerant = false } = {}) {
    if (!replyKeyOk(reply) || !Array.isArray(lines)) return { text: null, problem: 'know needs a reply key and a list of lines' };
    const written = [];
    for (const line of lines) {
        // The rule mark is stored only on an entry whose written how: was not already exactly saw/heard (old bytes stay old bytes).
        const widened = tolerant && !KNOW_HOW.includes(line?.how);
        const entry = knowOf({ ...line, how: widened ? readHow(line?.how) : line?.how, r: reply, rule: widened || line?.rule === KNOW_RULE ? KNOW_RULE : 0 });
        if (!entry) return { text: null, problem: 'know needs about, fact and how (saw or heard)' };
        written.push(entry);
    }
    const kept = listOf(prior).filter(old => old.r !== reply && !written.some(entry => sameFact(entry, old)));
    return { text: JSON.stringify([...kept, ...written].slice(-KNOWS_MAX)), problem: null };
}

const ruleKey = (about, fact) => `${clean(about, KNOW_ABOUT_MAX)}|${clean(fact, KNOW_FACT_MAX)}`.toLowerCase();

/**
 * KNOW_RULE for a new line whose how: needs the tolerant read; for a Re-read (`standing` set) only when the reply's stored entry (its own
 * rule mark) or receipt shows the line was kept under the rule, else 0 (strict). A how: already exactly saw/heard is never marked (both reads agree).
 */
export function knowRuleFor(standing, key, reply, labels, receipts = []) {
    if (KNOW_HOW.includes(labels.how)) return 0;
    if (!standing) return KNOW_RULE;
    const id = ruleKey(labels.about, labels.fact);
    if (Array.isArray(receipts) && receipts.some(r => r?.type === 'capture.know' && r.data?.key === key && r.data?.knowRule === KNOW_RULE && r.data?.knowId === id)) return KNOW_RULE;
    const how = readHow(labels.how);
    return readKnows(standing.domains?.npc?.npcs?.[key]?.knows).some(e => e.r === reply && e.rule === KNOW_RULE && e.how === how && ruleKey(e.about, e.fact) === id) ? KNOW_RULE : 0;
}

export const markKnowResult = (result, labels, rule) => rule === KNOW_RULE
    ? { ...result, data: { ...result.data, knowRule: KNOW_RULE, knowId: ruleKey(labels.about, labels.fact) } } : result;

/**
 * The story (or a `told` line) opens a secret: the matching entries (same about and fact, ignoring case) lose `secret`.
 * → the new leaf text, or null when nothing matches (nothing to write).
 */
export function openKnow(prior, about, fact) {
    const target = knowOf({ about, fact, how: 'saw', r: 0 });
    if (!target) return null;
    const list = listOf(prior);
    if (!list.some(entry => entry.secret && sameFact(entry, target))) return null;
    return JSON.stringify(list.map(entry => {
        if (!entry.secret || !sameFact(entry, target)) return entry;
        const { secret, ...rest } = entry;
        return rest;
    }));
}

/**
 * The fact as the player sees it: a secret that is not opened reads "a secret about <who> · hidden"; `show` (the owner's
 * editor, or a caller that already decided the reader may see it) gives the fact itself.
 */
export function knowFact(entry, show = false) {
    if (!entry.secret || show) return entry.fact;
    return `a secret about ${entry.about} · hidden`;
}

/**
 * Dossier rows for a record's knows, newest first: { about, how, day, secret, hidden, text }. `hidden` is true for a secret that is
 * not shown, and then `text` is the redacted words (the fact itself is never in the row). `source` is the stored text or entries.
 */
export function knowsView(source, { show = false } = {}) {
    return listOf(source).reverse().map(entry => ({
        about: entry.about,
        how: entry.how,
        day: entry.day,
        secret: Boolean(entry.secret),
        hidden: Boolean(entry.secret) && !show,
        text: knowFact(entry, show),
    }));
}

/**
 * The tail lines for the people who are present (`people`: [{ name, knows }], the caller filters to present, and `knows` is the
 * stored text or entries of that person's own record). Per person at most KNOWS_TAIL_PER_NPC line, the newest secret first, else the
 * newest fact; at most KNOWS_TAIL_MAX lines in all, in the order given. A secret goes in as a hidden line (the knower is the only
 * carrier of it; it is never put in another person's line). The lines are optional for the host's budget. → string[].
 */
export function knowsTail(people) {
    const lines = [];
    for (const person of Array.isArray(people) ? people : []) {
        if (lines.length >= KNOWS_TAIL_MAX) break;
        const name = clean(person?.name, 60);
        if (!name) continue;
        const list = listOf(person.knows).reverse();
        const pick = list.find(entry => entry.secret) ?? list[0];
        if (!pick) continue;
        const about = `${pick.about}'s ${pick.fact}`;
        lines.push(pick.secret ? `${name} (hidden): knows ${about}; ${SECRET_TAIL_NOTE}` : `${name} knows: ${about}`);
    }
    return lines.slice(0, KNOWS_TAIL_MAX);
}
