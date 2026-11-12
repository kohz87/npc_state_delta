/* NPC State Delta pull core: the Belonging, Closure and Awe signal readers, the per-NPC instinct values and the top pressure pick. Pure: no host, storage, clock or DOM access; every input is passed in and never mutated. */

// Scores are small ints 0..3. A reader that cannot date its signal (no finite story day), or whose
// input is missing or malformed, returns null, so a failed or slow query degrades to "no signal".
export const INSTINCT_KINDS = Object.freeze(['belonging', 'closure', 'awe']);
export const INSTINCT_KEYS = Object.freeze({ belonging: 'belo', closure: 'clos', awe: 'awe' });
export const NEW_MEMBER_DAYS = 2;
export const CLOSURE_MIN_DAYS = 2;
const CAUSE_MAX = 120;
const BENCHED_SCORE = 3;
const AWAY_SCORE = 2;
const NEW_MEMBER_SCORE = 1;
const AWE_SCORE = 2;

const idOf = value => (value === null || value === undefined || value === '' ? '' : String(value).trim());
const dayOf = value => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Math.floor(Number(value)) : null);
const plainCause = (text, fallback) => {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, CAUSE_MAX);
    return clean || fallback;
};
// A place's own name: the part before a region ("Market District, Highmark Capital" and "Bluewatch / Guild Office" both lose the rest), lower case.
const placeKey = name => idOf(name).toLowerCase().split(/\s*[,/]\s*/)[0].trim();
// The same place under a fuller or shorter name ("Ram's Head" and "Ram's Head Inn"): one name's words open the other's. Run 3 read these as arrivals.
export function samePlace(a, b) {
    const x = placeKey(a).split(/\s+/).filter(Boolean);
    const y = placeKey(b).split(/\s+/).filter(Boolean);
    const [short, long] = x.length <= y.length ? [x, y] : [y, x];
    return short.length > 0 && short.every((word, i) => word === long[i]);
}

// Closure score by days an open thread has been waiting: 2 to 3 days = 1, 4 to 6 = 2, 7 or more = 3.
export function closureScore(ageDays) {
    if (!Number.isFinite(ageDays) || ageDays < CLOSURE_MIN_DAYS) return 0;
    if (ageDays >= 7) return 3;
    if (ageDays >= 4) return 2;
    return 1;
}

// Belonging: benched (left out of the party) beats away (a key person who is gone) beats a new member
// who joined within NEW_MEMBER_DAYS. Only the NPC's own id counts. Null when nothing applies.
export function readBelonging(input) {
    const { id, day, benched, keyPeople, joins } = input || {};
    const npc = idOf(id);
    const now = dayOf(day);
    if (!npc || now === null) return null;
    const benchedRow = Array.isArray(benched) ? benched.find(row => idOf(row?.id) === npc) : null;
    if (benchedRow && dayOf(benchedRow.since) !== null) {
        return { kind: 'belonging', score: BENCHED_SCORE, cause: 'benched from the party', since: dayOf(benchedRow.since) };
    }
    const away = Array.isArray(keyPeople) ? keyPeople.find(row => idOf(row?.id) === npc && row.away === true) : null;
    if (away && dayOf(away.since) !== null) {
        return { kind: 'belonging', score: AWAY_SCORE, cause: 'left behind while the group moved on', since: dayOf(away.since) };
    }
    const join = Array.isArray(joins) ? joins.find(row => idOf(row?.id) === npc) : null;
    const joinDay = join ? dayOf(join.day) : null;
    if (joinDay !== null && now - joinDay >= 0 && now - joinDay <= NEW_MEMBER_DAYS) {
        return { kind: 'belonging', score: NEW_MEMBER_SCORE, cause: 'new to the party', since: joinDay };
    }
    return null;
}

// Closure: the oldest-scoring open thread that lists this NPC among its people. Ties go to the earlier
// opening day, then to the thread id, so the pick is stable across replays.
export function readClosure(input) {
    const { id, day, threads } = input || {};
    const npc = idOf(id);
    const now = dayOf(day);
    if (!npc || now === null || !Array.isArray(threads)) return null;
    let best = null;
    for (const thread of threads) {
        if (!thread || thread.open !== true || !Array.isArray(thread.people)) continue;
        if (!thread.people.some(person => idOf(person) === npc)) continue;
        const openedDay = dayOf(thread.openedDay);
        if (openedDay === null) continue;
        const score = closureScore(now - openedDay);
        if (score < 1) continue;
        const candidate = { kind: 'closure', score, cause: plainCause(thread.title, 'an open thread'), since: openedDay, threadId: idOf(thread.id) };
        if (!best || candidate.score > best.score || (candidate.score === best.score && (candidate.since < best.since || (candidate.since === best.since && candidate.threadId < best.threadId)))) best = candidate;
    }
    return best ? { kind: best.kind, score: best.score, cause: best.cause, since: best.since } : null;
}

// Awe: the NPC arrives at a place their own history does not contain. Null when visited is not a list
// (unknown history), so an unreadable place never reads as a first arrival.
export function readAwe(input) {
    const { day, here, visited } = input || {};
    const now = dayOf(day);
    const place = idOf(here);
    if (now === null || !place || !Array.isArray(visited)) return null;
    const seen = visited.some(name => samePlace(name, place));
    if (seen) return null;
    return { kind: 'awe', score: AWE_SCORE, cause: plainCause(`first time at ${place}`, 'a new place'), since: now };
}

// The pull for one NPC: the three signals, the per-NPC inst values (belo, clos, awe) and the top pressure.
// The top pressure is the highest-scoring signal; ties go to the earlier kind in INSTINCT_KINDS.
// Preservation and Comfort are not built here (no data for non-party NPCs).
export function readInstincts(input) {
    const signals = [readBelonging(input), readClosure(input), readAwe(input)];
    const inst = { belo: 0, clos: 0, awe: 0 };
    let top = null;
    // `input.scale(key, score)` (optional): the person's drive for that instinct scales the score before it is read (a muted drive: no pull).
    const scale = typeof input?.scale === 'function' ? input.scale : null;
    for (const found of signals) {
        if (!found) continue;
        const signal = scale ? { ...found, score: scale(INSTINCT_KEYS[found.kind], found.score) } : found;
        inst[INSTINCT_KEYS[signal.kind]] = Math.max(0, Math.min(3, Math.floor(signal.score)));
        if (signal.score < 1) continue;
        if (!top || signal.score > top.score || (signal.score === top.score && INSTINCT_KINDS.indexOf(signal.kind) < INSTINCT_KINDS.indexOf(top.kind))) top = signal;
    }
    return { inst, pressure: top ? { kind: top.kind, cause: top.cause, since: top.since } : null };
}

// ---- the per-NPC step (the tick's one call; pure) ----
// `track` is the private memory the readers need and the state does not otherwise keep: whether the NPC was in the party,
// the day they were benched or joined, the day each open thread naming them was first seen, and up to PLACES_MAX places
// they were present at. facts: { day, party: true|false|null (null = no party answer), awayDay: int|null, threads:
// [{ id, title, opened?: day }] (open threads that name them), here: place name | '', present: boolean }.
// → { track, inst, pull } with `track` and `pull` left out when empty. All whole numbers and short plain text.
export const PLACES_MAX = 6;
export const THREADS_MAX = 6;
const SELF = 'self';
export function stepPull(before, facts) {
    const prior = before && typeof before === 'object' ? before : {};
    const day = dayOf(facts?.day);
    if (day === null) return { track: prior, inst: { belo: 0, clos: 0, awe: 0 }, pull: null };
    const track = {};
    const wasIn = prior.party;
    if (facts.party === true) { track.party = 1; if (wasIn === 0) track.join = day; else if (prior.join !== undefined) track.join = prior.join; }
    else if (facts.party === false) { track.party = 0; if (wasIn === 1) track.bench = day; else if (prior.bench !== undefined) track.bench = prior.bench; }
    else for (const key of ['party', 'join', 'bench']) if (prior[key] !== undefined) track[key] = prior[key];
    const seen = {};
    const threads = [];
    for (const row of (Array.isArray(facts.threads) ? facts.threads : []).slice(0, THREADS_MAX)) {
        const id = idOf(row?.id);
        if (!id) continue;
        // The thread's own opening day when the host gives it (facts.threads[].opened), else the day this person's record first saw it.
        const first = dayOf(row.opened) ?? dayOf(prior.threads?.[id]) ?? day;
        seen[id] = Math.min(first, day);
        threads.push({ id, open: true, title: row.title, openedDay: seen[id], people: [SELF] });
    }
    if (threads.length) track.threads = seen;
    const known = Array.isArray(prior.places) ? prior.places.filter(name => typeof name === 'string').slice(-PLACES_MAX) : [];
    const here = idOf(facts.here);
    const places = [...known];
    if (here && facts.present === true && !known.some(name => samePlace(name, here))) places.push(here);
    if (places.length) track.places = places.slice(-PLACES_MAX);
    const { inst, pressure } = readInstincts({
        id: SELF, day, here: facts.present === true ? here : '',
        // The first place ever seen is the baseline, not an arrival: awe needs a history.
        visited: known.length ? known : null,
        benched: track.bench !== undefined && track.party === 0 ? [{ id: SELF, since: track.bench }] : [],
        keyPeople: dayOf(facts.awayDay) !== null ? [{ id: SELF, away: true, since: facts.awayDay }] : [],
        joins: track.join !== undefined ? [{ id: SELF, day: track.join }] : [],
        threads, scale: facts.scale,
    });
    return { track, inst, pull: pressure };
}
