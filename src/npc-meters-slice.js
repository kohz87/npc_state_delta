// NPC meters, the per-reply slice: the initial slice, key-person absence and cast memory, slice validation, meter moves, the stage
// and ladder settling, and the change text. A pure part of npc-meters.js (same owner, moved without change); npc-meters.js
// re-exports every name it exported before. Never imports npc-meters.js.
import { readLeaf, leafText, clamp, CUSTOM_RANGE, DEFAULT_CONFLICT_AT, DISPOSITION_MAX, FORBIDDEN_KEYS, isInt, isObject, isReplyId, KEY_MAX, MAX_METERS_PER_NPC, MAX_MILESTONES, MAX_NPCS, MAX_PROBLEMS, MAX_RUNGS, MAX_UNLOCKED, METER_ID_MAX, MILESTONE_MAX, NAME_MAX, needMet, npcKey, own, RECORD_FIELDS, replyKey, sameReply, signed, STAGE_NAME_MAX, stageAt, thresholdReached, WORDS } from './npc-meters-config.js';
import { isKey, memoryKey, RECENT_REPLIES } from './key-people.js';
import { CAST_KEY, metWithEntry } from './cast-dossier.js';
import { RELATIONSHIP_KEYS } from '../core-mechanics.js';
import { flatDayProblems } from './relationship-pacing.js';
import { readEvent } from './npc-meters-pacing.js';
import { readApproachRing } from '../npc-meters-gate.js';
import { normalizeMood } from '../npc-mood.js';
import { INSTINCT_KINDS } from '../npc-instincts.js';
import { validateNotes } from './npc-notes-kinds.js';

/** The slice of a chat with no NPC meters yet. */
export function initialNpcSlice() {
    return { npcs: {}, problems: [] };
}

// ---- key people: the memory of the last absence (Story Director's director.keyPeople, read only) ----
//
// The query says only who is away NOW; after a return it is null again. So the slice keeps `keyAway`: { [memoryKey]: { name, aliases,
// away: { doing, since, back, steps }, returnedAt: reply | null, presentReplies } } for a key person who has been away, until they
// have been present for RECENT_REPLIES replies. npc.tick writes it (observeKeyAway), so it is part of the replies' state: it follows
// swipes and deletes, and a reload never loses it. Absent while nobody has been away.

/**
 * Notes the answer (`people`, normalized) into the memory at reply `head`: { memory, changed }.
 * - a key person away now: their record as it stands (the newest steps), not yet returned;
 * - one who was away and is not any more: returned at `head`; each later reply they are `here` counts toward
 *   RECENT_REPLIES, after which the record is dropped (a person who is not here waits);
 * - anyone no longer a key person is dropped. No usable head or no answer: nothing is touched.
 */
export function observeKeyAway(memory, people, head) {
    const before = isObject(memory) ? memory : {};
    if (!Number.isInteger(head) || head < 0 || !Array.isArray(people)) return { memory: before, changed: false };
    const next = {};
    for (const entry of people) {
        if (!isKey(entry)) continue;
        const key = memoryKey(entry.name);
        if (!key) continue;
        const had = isObject(before[key]) && before[key].away ? before[key] : null;
        const record = { name: entry.name, aliases: [...entry.aliases], away: JSON.parse(JSON.stringify(entry.away ?? had?.away ?? null)) };
        if (entry.away) {
            next[key] = { ...record, returnedAt: null, presentReplies: 0 };
            continue;
        }
        if (!had) continue;
        const fresh = !isInt(had.returnedAt);
        const present = fresh ? 0 : (isInt(had.presentReplies) ? had.presentReplies : 0) + (entry.here ? 1 : 0);
        if (present >= RECENT_REPLIES) continue;
        next[key] = { ...record, returnedAt: fresh ? head : had.returnedAt, presentReplies: present };
    }
    const changed = JSON.stringify(next) !== JSON.stringify(before);
    return { memory: changed ? next : before, changed };
}

// ---- the living cast: who Delta has made a dossier for (Story Director's director.cast, read only) ----

/** Story Director's query for the pack's cast (read only). */
export const CAST_QUERY = 'director.cast';
export const CAST_MADE_MAX = 64;
/**
 * Notes the met people of Story Director's answer (`people`, normalizeCast) into the record of made dossiers: { cast, fresh }.
 * `fresh` are the met people with an entry that the record did not have yet (at most up to CAST_MADE_MAX in all); `cast` is the
 * record with them added. Nobody is ever taken out: a swipe or delete rewinds the slice itself. No answer: nothing changes.
 */
export function observeCast(memory, people) {
    const before = isObject(memory) ? memory : {};
    if (!Array.isArray(people)) return { cast: before, fresh: [] };
    const cast = { ...before };
    const fresh = [];
    for (const person of metWithEntry(people)) {
        if (Object.hasOwn(cast, person.key) || Object.keys(cast).length >= CAST_MADE_MAX) continue;
        const rungs = Math.min(MAX_RUNGS, person.entry.stages.length);
        cast[person.key] = { name: person.name, ...(rungs ? { rungs } : {}) };
        fresh.push(person);
    }
    return { cast: fresh.length ? cast : before, fresh };
}

function validateCast(cast) {
    if (!isObject(cast)) return ['The made cast dossiers are not a record.'];
    const errors = [];
    const entries = Object.entries(cast);
    if (entries.length > CAST_MADE_MAX) errors.push(`The cast record keeps at most ${CAST_MADE_MAX} people.`);
    for (const [key, record] of entries) {
        const where = `The cast entry "${key}"`;
        if (!CAST_KEY.test(key) || FORBIDDEN_KEYS.has(key)) { errors.push(`${where} has an unusable key.`); continue; }
        if (!isObject(record) || typeof record.name !== 'string' || !record.name.trim() || record.name.length > NAME_MAX) { errors.push(`${where} has no usable name.`); continue; }
        if (record.rungs !== undefined && (!isInt(record.rungs) || record.rungs < 1 || record.rungs > MAX_RUNGS)) errors.push(`${where} has an unusable count of stages.`);
        for (const field of Object.keys(record)) if (!['name', 'rungs'].includes(field)) errors.push(`${where} has an unknown field "${field}".`);
    }
    return errors;
}

const KEY_AWAY_MAX = 40;
function validateKeyAway(memory) {
    if (!isObject(memory)) return ['The key people memory is not a record.'];
    const errors = [];
    const entries = Object.entries(memory);
    if (entries.length > KEY_AWAY_MAX) errors.push(`The key people memory keeps at most ${KEY_AWAY_MAX} people.`);
    const text = (value, max) => typeof value === 'string' && value.length <= max;
    for (const [key, record] of entries) {
        const where = `The key people entry "${key}"`;
        if (!key || key.length > 60) { errors.push(`${where} has an unusable key.`); continue; }
        if (!isObject(record) || !text(record.name, 80) || !record.name || !Array.isArray(record.aliases) || record.aliases.length > 8 || !record.aliases.every(item => text(item, 80))) { errors.push(`${where} has no usable name.`); continue; }
        const away = record.away;
        if (!isObject(away) || !text(away.doing, 200) || !text(away.since, 40) || !text(away.back, 40) || !Array.isArray(away.steps) || away.steps.length > 12
            || !away.steps.every(step => isObject(step) && text(step.date, 40) && text(step.text, 200))) errors.push(`${where} has an unusable absence.`);
        if (record.returnedAt !== null && !(isInt(record.returnedAt) && record.returnedAt >= 0)) errors.push(`${where} has an unusable return.`);
        if (!isInt(record.presentReplies) || record.presentReplies < 0 || record.presentReplies >= RECENT_REPLIES) errors.push(`${where} has an unusable count of replies.`);
    }
    return errors;
}

// The mood and pull fields (feature mood-pull): small whole numbers and short plain text, as the cores write them.
const LEAF_TEXT_MAX = 1200;
const shortText = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f]/.test(value);
export function moodPullProblems(record) {
    const out = [];
    const [mood, inst, pull, track] = [record.mood, record.inst, record.pull, record.track].map(readLeaf);
    if ([record.mood, record.inst, record.pull, record.track].some(raw => typeof raw === 'string' && (raw.length > LEAF_TEXT_MAX || readLeaf(raw) === undefined))) out.push('has an unreadable text leaf');
    if (mood !== undefined && (!isObject(mood) || JSON.stringify(normalizeMood(mood)) !== JSON.stringify(Object.fromEntries(Object.keys(normalizeMood(mood)).map(key => [key, mood[key]]))))) out.push('has an unusable mood');
    if (inst !== undefined && (!isObject(inst) || Object.keys(inst).some(key => !['belo', 'clos', 'awe'].includes(key)) || Object.values(inst).some(value => !isInt(value) || value < 0 || value > 3))) out.push('has unusable instincts');
    if (pull !== undefined && (!isObject(pull) || !INSTINCT_KINDS.includes(pull.kind) || !shortText(pull.cause, 120) || !isInt(pull.since) || pull.since < 0 || Object.keys(pull).length !== 3)) out.push('has an unusable pull');
    if (track !== undefined) {
        const ok = isObject(track) && Object.keys(track).every(key => ['party', 'join', 'bench', 'threads', 'places'].includes(key))
            && [track.party].every(value => value === undefined || value === 0 || value === 1)
            && [track.join, track.bench].every(value => value === undefined || (isInt(value) && value >= 0))
            && (track.threads === undefined || (isObject(track.threads) && Object.keys(track.threads).length <= 6 && Object.entries(track.threads).every(([id, day]) => id.length > 0 && id.length <= 40 && isInt(day) && day >= 0)))
            && (track.places === undefined || (Array.isArray(track.places) && track.places.length <= 6 && track.places.every(name => shortText(name, 60) && name.length > 0)));
        if (!ok) out.push('has an unusable pull memory');
    }
    return out;
}

/** Problems with the slice (§2.5): [] when fine. Any problem rejects the command that made it. */
export function validateNpcSlice(slice) {
    const errors = [];
    if (!isObject(slice)) return ['The NPC meters are not a record.'];
    if (!isObject(slice.npcs)) return ['The NPC meters have no list of people.'];
    const keys = Object.keys(slice.npcs);
    if (keys.length > MAX_NPCS) errors.push(`NPC State Delta keeps meters for up to ${MAX_NPCS} people (there are ${keys.length}).`);
    for (const key of keys) {
        const record = slice.npcs[key];
        const where = `The NPC entry "${key}"`;
        if (key.length > KEY_MAX || !WORDS.test(key) || key !== key.toLocaleLowerCase() || FORBIDDEN_KEYS.has(key)) errors.push(`${where} has a key that is not lowercase words joined by "-".`);
        if (!isObject(record)) { errors.push(`${where} is not a record.`); continue; }
        if (typeof record.name !== 'string' || !record.name.trim() || record.name.length > NAME_MAX) errors.push(`${where} has no usable name.`);
        if (!isObject(record.meters)) errors.push(`${where} has no meters.`);
        else {
            const meters = Object.entries(record.meters);
            if (meters.length > MAX_METERS_PER_NPC) errors.push(`${where} has more than ${MAX_METERS_PER_NPC} meters.`);
            for (const [id, value] of meters) {
                if (!WORDS.test(id) || id.length > METER_ID_MAX) errors.push(`${where} has a meter named "${id}", which is not a meter name.`);
                if (!isInt(value) || value < CUSTOM_RANGE.min || value > CUSTOM_RANGE.max) errors.push(`${where}: ${id} must be a whole number from ${CUSTOM_RANGE.min} to ${CUSTOM_RANGE.max} (got ${JSON.stringify(value)}).`);
            }
        }
        if (!isObject(record.stages)) errors.push(`${where} has no stages record.`);
        else for (const [id, name] of Object.entries(record.stages)) {
            if (!WORDS.test(id) || typeof name !== 'string' || !name.trim() || name.length > STAGE_NAME_MAX) errors.push(`${where} has an unusable stage for "${id}".`);
        }
        if (!Array.isArray(record.unlocked)) errors.push(`${where} has no unlocked list.`);
        else {
            if (record.unlocked.length > MAX_UNLOCKED) errors.push(`${where} has more than ${MAX_UNLOCKED} unlocked notes.`);
            if (record.unlocked.some(id => typeof id !== 'string' || !id || id.length > 40)) errors.push(`${where} has an unusable unlocked note id.`);
            if (new Set(record.unlocked).size !== record.unlocked.length) errors.push(`${where} lists an unlocked note twice.`);
        }
        if (record.progress !== undefined) {
            if (!isObject(record.progress) || Object.entries(record.progress).some(([id, part]) => !RELATIONSHIP_KEYS.includes(id) || typeof part !== 'number' || !Number.isFinite(part) || part <= -1 || part >= 1)) {
                errors.push(`${where} has an unusable record of part-points.`);
            }
        }
        if (record.impactDay !== undefined) for (const problem of flatDayProblems(record.impactDay)) errors.push(`${where}'s record of the day's events ${problem}.`);
        if (record.held !== undefined) {
            if (!Array.isArray(record.held) || record.held.length > MAX_UNLOCKED || record.held.some(id => typeof id !== 'string' || !id || id.length > 40)
                || new Set(record.held).size !== record.held.length) errors.push(`${where} has an unusable list of shut notes.`);
        }
        if (record.disposition !== undefined && (typeof record.disposition !== 'string' || record.disposition.length > DISPOSITION_MAX)) errors.push(`${where} has an unusable disposition.`);
        if (record.turn !== undefined) {
            const turn = record.turn;
            if (!isObject(turn) || replyKey(turn.reply, turn.reply) === null || !isObject(turn.from)
                || (turn.at !== undefined && (!isInt(turn.at) || turn.at < 0 || !isReplyId(turn.reply)))
                || Object.values(turn.from).some(value => !isInt(value))
                || (turn.story !== undefined && (!Array.isArray(turn.story) || turn.story.some(id => typeof id !== 'string')))) errors.push(`${where} has an unusable reply window.`);
        }
        if (record.lastEvent !== undefined && !readEvent(record.lastEvent)) errors.push(`${where} has an unusable last event.`);
        if (record.via !== undefined && !readApproachRing(record.via)) errors.push(`${where} has an unusable record of recent approaches.`);
        if (record.milestones !== undefined) {
            const list = isObject(record.milestones) ? Object.entries(record.milestones) : null;
            if (!list) errors.push(`${where} has an unusable milestones record.`);
            else {
                if (list.length > MAX_MILESTONES) errors.push(`${where} has more than ${MAX_MILESTONES} milestones.`);
                if (list.some(([id, name]) => !WORDS.test(id) || id.length > METER_ID_MAX || typeof name !== 'string' || !name.trim() || name.length > MILESTONE_MAX)) errors.push(`${where} has an unusable milestone.`);
            }
        }
        if (record.rank !== undefined && (typeof record.rank !== 'string' || !WORDS.test(record.rank) || record.rank.length > METER_ID_MAX)) errors.push(`${where} has an unusable stage on its ladder.`);
        if (record.low !== undefined && (!isInt(record.low) || record.low < 1 || record.low > 1000)) errors.push(`${where} has an unusable count of replies below its stage.`);
        if (record.day !== undefined && !isInt(record.day)) errors.push(`${where} has an unusable story day.`);
        errors.push(...moodPullProblems(record).map(problem => `${where} ${problem}.`));
        { const bad = validateNotes(record); if (bad) errors.push(`${where} ${bad}`); }
        for (const field of Object.keys(record)) {
            if (!RECORD_FIELDS.includes(field)) errors.push(`${where} has an unknown field "${field}".`);
        }
    }
    if (!Array.isArray(slice.problems)) errors.push('The NPC meters have no problems list.');
    else {
        if (slice.problems.length > MAX_PROBLEMS) errors.push(`The NPC meters keep at most ${MAX_PROBLEMS} problems.`);
        if (slice.problems.some(item => !isObject(item) || !isInt(item.rev) || typeof item.text !== 'string')) errors.push('An NPC meters problem is not { rev, text }.');
    }
    if (slice.keyAway !== undefined) errors.push(...validateKeyAway(slice.keyAway));
    if (slice.cast !== undefined) errors.push(...validateCast(slice.cast));
    for (const field of Object.keys(slice)) if (!['npcs', 'problems', 'keyAway', 'cast'].includes(field)) errors.push(`The NPC meters have an unknown field "${field}".`);
    return errors;
}

/** The entry key for `labels` (a name, then aliases) in `npcs`, or null. */
export function findNpcKey(npcs, labels = []) {
    if (!isObject(npcs)) return null;
    const wanted = labels.map(npcKey).filter(Boolean);
    for (const key of wanted) if (Object.hasOwn(npcs, key)) return key;
    for (const [key, record] of Object.entries(npcs)) if (wanted.includes(npcKey(record?.name))) return key;
    return null;
}

/** One meter's value on an entry (its start value when the entry has none yet). */
export const meterValue = (record, def) => (isInt(record?.meters?.[def.id]) ? record.meters[def.id] : def.start);

// Moves meters on `record` (in place). `changes`: [{ meter (id), mode: 'add' | 'set', value }].
// `limit` holds each meter within cap of the value the reply `reply` (replyKey: its record ID, else its
// index) started from (story lines and scans) and within the NPC's own `limits` (growth stops at a
// ceiling, a fall at a floor; a value already past one moves only back toward it); without it (the
// reader's own set) only the range applies. `at`: the reply's index now, kept beside a record ID for
// "moved lately" in the tail.
export function moveMeters(record, changes, { defs, cap, reply, at = null, limit, limits = {}, story = false }) {
    const byId = new Map(defs.map(def => [def.id, def]));
    const known = replyKey(reply, reply) !== null;
    const windowOf = () => ({ reply, ...(isReplyId(reply) && isInt(at) && at >= 0 ? { at } : {}), from: { ...record.meters } });
    if (limit && known && !sameReply(record.turn, reply)) record.turn = windowOf();
    const moved = [];
    for (const change of changes) {
        const def = byId.get(change.meter);
        if (!def) continue;
        const before = meterValue(record, def);
        const asked = change.mode === 'add' ? before + change.value : change.value;
        let low = def.min;
        let high = def.max;
        let why = '';
        if (limit) {
            if (record.turn && known && !isInt(record.turn.from[def.id])) record.turn.from[def.id] = before;
            const base = known && isInt(record.turn?.from?.[def.id]) ? record.turn.from[def.id] : before;
            low = Math.min(Math.max(low, base - cap), before);
            high = Math.max(Math.min(high, base + cap), before);
            const bound = isObject(limits[def.id]) ? limits[def.id] : null;
            if (bound && isInt(bound.ceiling) && asked > before && bound.ceiling < high) { high = Math.max(bound.ceiling, before); why = 'ceiling'; }
            if (bound && isInt(bound.floor) && asked < before && bound.floor > low) { low = Math.min(bound.floor, before); why = 'floor'; }
        }
        const after = clamp(asked, low, high);
        record.meters[def.id] = after;
        const stop = after !== asked && why && after === (why === 'ceiling' ? high : low) ? why : '';
        // `ask`: what the line asked for before its impact tier cut the step.
        const wanted = isInt(change.ask) ? change.ask : asked;
        moved.push({ meter: def.id, label: def.label, before, after, asked: wanted, held: after !== wanted, ...(stop ? { stop } : {}) });
    }
    // The meters a story line named in this reply: Delta's own scan of the same reply leaves them to the story.
    if (story && limit && known && record.turn && sameReply(record.turn, reply)) {
        const named = new Set([...(Array.isArray(record.turn.story) ? record.turn.story : []), ...changes.map(change => change.meter)]);
        record.turn.story = [...named].filter(id => byId.has(id));
    }
    // The reader's own values are the new start of this reply's window (or end it).
    if (!limit && moved.length) {
        if (known) record.turn = windowOf();
        else delete record.turn;
    }
    return moved;
}

/** True when every need of `step` holds on `record` and its milestone (if any) is set. */
export function rungMet(record, step, defs) {
    const byId = new Map(defs.map(def => [def.id, def]));
    const needs = step.needs.every(need => byId.has(need.meter) && needMet(need, meterValue(record, byId.get(need.meter))));
    return needs && (!step.milestone || own(record.milestones, step.milestone.key));
}

export const conflictOn = (record, defs, conflictAt) => meterValue(record, defs.find(def => def.id === 'tension') ?? { id: 'tension', start: 0 }) > conflictAt;

// Stages, the ladder and notes after a change: moves each stage to where its meter now stands,
// promotes on the ladder while the next rung is met (never in a conflict), counts and demotes on
// Delta's tick (`tick`), and unlocks the notes whose rule is met.
// → { stages: [{ meter, from, to, text }], ranks: [{ from, to, text }], held: text | '', unlocked: [{ id, text }] }.
export function settle(record, { defs, stages, rules, name, rungs = [], conflictAt = DEFAULT_CONFLICT_AT, demoteAfter = 0, tick = false }) {
    const moves = [];
    for (const def of defs) {
        const list = stages[def.id] ?? [];
        const old = typeof record.stages[def.id] === 'string' ? record.stages[def.id] : null;
        if (!list.length) {
            // The reader took this meter's stages away: the old name goes quietly.
            if (old !== null) delete record.stages[def.id];
            continue;
        }
        const value = meterValue(record, def);
        const now = stageAt(list, value);
        if ((now?.name ?? null) === old) continue;
        if (now) record.stages[def.id] = now.name;
        else delete record.stages[def.id];
        const was = list.find(stage => stage.name === old) ?? null;
        const further = now && (!was || Math.sign(now.at) !== Math.sign(was.at) || Math.abs(now.at) > Math.abs(was.at));
        const text = now
            ? (further ? `${name}: ${def.label.toLocaleLowerCase()} reached ${now.name}` : `${name}: ${def.label.toLocaleLowerCase()} fell back to ${now.name}`)
            : `${name}: ${def.label.toLocaleLowerCase()} left ${old}`;
        moves.push({ meter: def.id, from: old, to: now?.name ?? null, text });
    }
    const ranks = [];
    let held = '';
    if (!rungs.length) {
        // No ladder for this NPC (the feature is off, or the reader took it away): quietly gone.
        delete record.rank;
        delete record.low;
    } else {
        let at = rungs.findIndex(step => step.key === record.rank);
        if (record.rank !== undefined && at < 0) { delete record.rank; delete record.low; }
        const from = at;
        while (at + 1 < rungs.length && rungMet(record, rungs[at + 1], defs)) {
            if (conflictOn(record, defs, conflictAt)) {
                held = `${name}: ${rungs[at + 1].name} waits while tension is above ${conflictAt}`;
                break;
            }
            at += 1;
        }
        if (at > from) {
            record.rank = rungs[at].key;
            delete record.low;
            // A pack stage's line for the story goes with it (only the rung finally reached).
            ranks.push({ from: from >= 0 ? rungs[from].key : null, to: rungs[at].key, text: `${name}: now ${rungs[at].name}${rungs[at].cue ? ` (${rungs[at].cue.replace(/[.!?]+$/, '')})` : ''}` });
        } else if (at >= 0) {
            if (rungMet(record, rungs[at], defs)) delete record.low;
            else if (tick && demoteAfter > 0) {
                record.low = (isInt(record.low) ? record.low : 0) + 1;
                if (record.low >= demoteAfter) {
                    delete record.low;
                    const lost = rungs[at];
                    at -= 1;
                    if (at >= 0) record.rank = rungs[at].key;
                    else delete record.rank;
                    ranks.push({ from: lost.key, to: at >= 0 ? rungs[at].key : null, text: at >= 0 ? `${name}: fell back to ${rungs[at].name}` : `${name}: no longer ${lost.name}` });
                }
            }
        }
    }
    const opened = [];
    const byId = new Map(defs.map(def => [def.id, def]));
    const shut = Array.isArray(record.held) ? record.held : [];
    for (const rule of Array.isArray(rules) ? rules : []) {
        if (!rule || typeof rule.id !== 'string' || record.unlocked.includes(rule.id) || record.unlocked.length >= MAX_UNLOCKED) continue;
        // A note the reader shut stays shut; one that opens only on a story event waits for the scan.
        if (shut.includes(rule.id)) continue;
        const def = byId.get(rule.meter);
        if (!def || !isInt(rule.at)) continue;
        const value = meterValue(record, def);
        if (!thresholdReached(value, rule.at)) continue;
        record.unlocked.push(rule.id);
        opened.push({ id: rule.id, text: `${name}: a hidden note opened (${def.label.toLocaleLowerCase()} ${value})` });
    }
    return { stages: moves, ranks, held, unlocked: opened };
}

// A Re-read of a reply (the host gives ctx.standing: the story as it stood after that reply's earlier read) gives the reply's mood only where that
// state already had one on this person: a reply written before the feature was on is read again as it was; a reply written with it on keeps
// its mood. A first read (no standing) always may.
// A leaf is written in the form the reply's earlier read stored it: an object where the standing holds one (a chat written under 1.16.0, whose later
// per-field ops need the object), text otherwise (a first read, a new reply). So a Re-read of an old reply stores the same ops.
export const asStored = (ctx, key, field, value) => (isObject(ctx?.standing?.domains?.npc?.npcs?.[key]?.[field]) ? value : leafText(value));
export const moodStands = (ctx, key) => !ctx.standing || isObject(readLeaf(ctx.standing.domains?.npc?.npcs?.[key]?.mood));

export const sentence = parts => parts.filter(Boolean).map(part => (/[.!?]$/.test(part) ? part : `${part}.`)).join(' ');

// `pace`: the reader's words when pacing held the event (src/relationship-pacing.js pacingNote), else ''.
function changeText(name, moved, pace = '') {
    if (!moved.length) return pace ? `${name}: nothing changed (${pace})` : '';
    const why = item => (item.stop ? `, at the ${item.stop}` : '');
    return `${name}: ${moved.map(item => `${item.label.toLocaleLowerCase()} ${item.before} → ${item.after}${item.held && !pace ? ` (held at ${item.after}${why(item)}; ${signed(item.asked - item.before)} asked)` : ''}`).join(', ')}${pace ? ` (${pace})` : ''}`;
}

// The receipt: stage, ladder and note lines are what the next reply is told (narrate when a stage or
// a rung moved); the numbers are for the reply's card.
export function result({ name, key, moved, settled, problems, created, disposition, milestone = null, pace = '' }) {
    const notes = [...settled.stages.map(move => move.text), ...settled.ranks.map(move => move.text), ...settled.unlocked.map(note => note.text)];
    const numbers = changeText(name, moved, pace);
    const marked = milestone ? `${name}: milestone “${milestone.name}”` : '';
    const summary = sentence(notes.length
        ? [...notes, marked, numbers, settled.held]
        : [marked || numbers || (created ? `${name}: meters started` : `${name}: nothing moved`), marked ? numbers : '', settled.held, disposition ? `${name} is ${disposition}` : '']);
    return {
        summary,
        narrate: settled.stages.length > 0 || settled.ranks.length > 0,
        data: {
            name,
            key,
            created,
            changes: moved.map(({ meter, before, after, held, stop }) => ({ meter, before, after, held, ...(stop ? { stop } : {}) })),
            stages: settled.stages.map(({ meter, from, to }) => ({ meter, from, to })),
            ...(settled.ranks.length ? { ranks: settled.ranks.map(({ from, to }) => ({ from, to })) } : {}),
            ...(milestone ? { milestone: milestone.key } : {}),
            unlocked: settled.unlocked.map(note => note.id),
            problems,
        },
    };
}
