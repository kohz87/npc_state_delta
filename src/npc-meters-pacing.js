// What the hosted slice does with a held event: the reader's words for the receipt and the cut of a forwarded scanner change to a
// lower tier, and the reply's last-event record (lastEvent: readEvent, nextEvent, eventSummary, askedOf). A pure part of the pacing rule (src/relationship-pacing.js, which holds the count); never imports npc-meters.js.
import { RELATIONSHIP_KEYS, RELATIONSHIP_MILESTONE_REQUIREMENTS, RELATIONSHIP_MILESTONE_THRESHOLDS } from '../core-relationship-model.js';
import { PACING_TIERS } from './relationship-pacing.js';
import { describeGate, gateEventProblems, normalizeApproachKind } from '../npc-meters-gate.js';

const list = words => (words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0]);

/**
 * The day rule (1: a meter line is judged on the story time in effect at that line, so a `~ time` of the same reply counts; 0: on the minute
 * before the reply, as replies read before this rule did). A first read is 1; a Re-read keeps what the reply's earlier read used: 1 only when
 * its receipt for this person carries `dayRule: 1` (result data).
 */
export const dayRuleFor = (ctx, key) => (!ctx?.standing || (Array.isArray(ctx.standingReceipts) && ctx.standingReceipts.some(item => item?.data?.key === key && item.data.dayRule === 1)) ? 1 : 0);

/** The reader's words for a held event ('' when it counted as asked): "major counted as meaningful: today's major is used". */
export function pacingNote(tier, used, skipped, date = '') {
    if (!skipped.length || used === tier) return '';
    const full = `today's ${list(skipped)} ${skipped.length > 1 ? 'are' : 'is'} used${date ? ` on ${date}` : ''}`;
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

// ---- the last event of a reply (record.lastEvent): what the reply's meter lines and scans asked, and what the day's allowance made of it ----
//
// Stored as ONE text leaf (compact JSON), so the host always writes and replays it whole: { at: reply, date, events: [{ src, ask, tier,
// held, note, mv }] } (up to 4 events, the oldest of its kind making room for a fifth; `ask`: the four built-in axes' asked amounts;
// `mv`: the signed amounts the event actually moved; `date`: the story date before the reply). Another event of the same reply writes the whole longer list.
// A new reply starts a new current event and keeps the one it replaces as the first of `prev` (the previous two replies' events, newest first, each
// squeezed to one row by snapshotOf), so the dossier lists the last three changes. Only a text that has `prev` keeps one: an older text (no `prev`) is
// written as it was (rule mark: old replies and their Re-reads stay byte-identical) until its reply is replaced; it then starts a log, never a made-up one.
// Nothing that decides meters reads it; it feeds the card and the next prompt's gate cue (npc-meters-prompt.js), so a gate event stays.
const AXES = ['trust', 'affection', 'desire', 'tension'];
export const EVENT_MAX = 4;
const EVENT_TEXT_MAX = 2600;
export const LOG_MAX = 2;   // earlier replies kept beside the current one: the dossier lists the last three
const NOTE_MAX = 120;
const WHY_MAX = 240;   // a story line's own why is cut to 80 where it is read (captureLine); a scan's evidence (withEvidence) may be longer
const DATE_MAX = 40;
const SOURCES = ['story', 'scan'];
const wholeInt = value => Number.isSafeInteger(value);
const axesOk = map => Boolean(map) && typeof map === 'object' && !Array.isArray(map) && Object.keys(map).every(axis => AXES.includes(axis) && wholeInt(map[axis]) && map[axis] !== 0 && Math.abs(map[axis]) <= 400);
const replyOk = value => (typeof value === 'string' && value.length > 0 && value.length <= 80) || (wholeInt(value) && value >= 0);

function validEvent(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !SOURCES.includes(item.src) || !PACING_TIERS.includes(item.tier)) return false;
    if (typeof item.held !== 'boolean' || typeof item.note !== 'string' || item.note.length > NOTE_MAX) return false;
    // The anti-lever gate's part (npc-meters-gate.js): the approach the story line named, and the outcome when the gate fired.
    if (item.why !== undefined && (typeof item.why !== 'string' || !item.why || item.why.length > WHY_MAX)) return false;   // the story line's (or, rule NSDFOLLOW-3, the scan's) own reason, or its one-pass evidence (withEvidence)
    if (item.via !== undefined && !normalizeApproachKind(item.via)) return false;
    if (item.gate !== undefined && (!item.via || gateEventProblems(item.gate).length)) return false;
    if (item.mv !== undefined && !axesOk(item.mv)) return false;
    const ask = item.ask;
    return Boolean(ask) && typeof ask === 'object' && !Array.isArray(ask) && Object.keys(ask).every(axis => AXES.includes(axis) && wholeInt(ask[axis]) && ask[axis] !== 0);
}

/** The parsed last event ({ at, date, events }) of stored text, or null when it is absent or not valid in every part. */
export function readEvent(text) {
    if (typeof text !== 'string' || !text || text.length > EVENT_TEXT_MAX) return null;
    let value;
    try { value = JSON.parse(text); } catch { return null; }
    if (!value || typeof value !== 'object' || !replyOk(value.at) || typeof value.date !== 'string' || value.date.length > DATE_MAX) return null;
    if (!Array.isArray(value.events) || !value.events.length || value.events.length > EVENT_MAX || !value.events.every(validEvent)) return null;
    if (value.n !== undefined && !(wholeInt(value.n) && value.n >= 0)) return null;
    if (value.prev !== undefined && (!Array.isArray(value.prev) || value.prev.length > LOG_MAX || !value.prev.every(validRow))) return null;
    return value;
}

// One earlier reply as a row of the log: { at, n?, date, mv? | ask?, held, note?, why? } (mv: signed amounts moved; ask only for a text from before mv was kept).
function validRow(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || !replyOk(row.at) || typeof row.date !== 'string' || row.date.length > DATE_MAX || typeof row.held !== 'boolean') return false;
    if (row.n !== undefined && !(wholeInt(row.n) && row.n >= 0)) return false;
    if (row.note !== undefined && (typeof row.note !== 'string' || row.note.length > NOTE_MAX)) return false;
    if (row.why !== undefined && (typeof row.why !== 'string' || !row.why || row.why.length > WHY_MAX)) return false;
    return [row.mv, row.ask].every(map => map === undefined || axesOk(map));
}

const sumAxes = (events, key) => Object.fromEntries(AXES.map(axis => [axis, events.reduce((sum, item) => sum + (item[key]?.[axis] ?? 0), 0)]).filter(([, value]) => value !== 0));

/** One current-format reply's events as one log row (the oldest events' reasons first, joined by "; "). */
function snapshotOf(event) {
    const events = event.events;
    const mv = sumAxes(events, 'mv');
    const ask = Object.keys(mv).length || events.some(item => item.mv) ? {} : sumAxes(events, 'ask');
    const why = cutWords([...new Set(events.map(item => item.why).filter(Boolean))].join('; '));
    const held = events.every(item => item.held);
    const note = held ? events.find(item => item.note)?.note : '';
    const n = wholeInt(event.n) ? event.n : (wholeInt(event.at) ? event.at : null);
    return { at: event.at, ...(n !== null ? { n } : {}), date: event.date, ...(Object.keys(mv).length ? { mv } : Object.keys(ask).length ? { ask } : {}), held, ...(note ? { note } : {}), ...(why ? { why } : {}) };
}

/** The recent change rows of a read event, newest first: the current reply's, then the earlier ones the log kept (up to three). A text from before the log has only its own. */
export function eventLog(event) {
    return event ? [snapshotOf(event), ...(event.prev ?? [])].slice(0, LOG_MAX + 1) : [];
}

/** The signed amounts a run's moved meters made on the four built-in axes: { axis: n } (nothing moved: {}). */
export const movesOf = moved => Object.fromEntries(moved.filter(item => AXES.includes(item.meter) && item.after !== item.before).map(item => [item.meter, item.after - item.before]));

/** What a hosted run records for one paced event: the whole new text for the record (`prior`: the stored text), or null when it need not change. */
export function nextEvent(prior, { reply, date, src, ask, tier, held, note, via, gate, why, mv, n = null, log = true }) {
    const old = readEvent(prior);
    const same = Boolean(old) && old.at === reply;
    // `log` false: a Re-read of a reply the older code wrote (no log) writes it as it was. The same reply's later events follow the text they join.
    const logged = log !== false && (!same || Array.isArray(old.prev));
    let events = same ? old.events : [];
    const mine = Object.fromEntries(AXES.filter(axis => wholeInt(ask?.[axis]) && ask[axis] !== 0).map(axis => [axis, ask[axis]]));
    const item = { src, ask: mine, tier, held: Boolean(held), note: String(note || '').slice(0, NOTE_MAX), ...(String(why || '').trim() ? { why: String(why).trim().slice(0, WHY_MAX) } : {}), ...(via ? { via, ...(gate ? { gate } : {}) } : {}), ...(logged && mv && Object.keys(mv).length ? { mv } : {}) };
    // A full list (EVENT_MAX) makes room by dropping the oldest event of the new one's own kind (held or spent), else the oldest, so
    // a later spent event is never hidden behind four held ones (the card would say "Nothing moved") nor the reverse. An event that
    // fired the gate is dropped last: the next prompt's gate cue reads it.
    if (events.length >= EVENT_MAX) {
        const at = [e => e.held === item.held && !e.gate, e => !e.gate, e => e.held === item.held, () => true]
            .map(test => events.findIndex(test)).find(index => index !== -1);
        events = events.filter((_, index) => index !== at);
    }
    const head = { at: reply, date: String(date || '').slice(0, DATE_MAX), events: [...events, item] };
    let prev = logged ? (same ? old.prev : [...(old ? [snapshotOf(old)] : []), ...(old?.prev ?? [])].slice(0, LOG_MAX)) : null;
    // A text that is too long loses the oldest log row first, never the new event.
    const write = () => JSON.stringify(prev ? { ...head, ...(wholeInt(n) && n >= 0 ? { n } : {}), prev } : head);
    while (prev?.length && write().length > EVENT_TEXT_MAX) prev = prev.slice(0, -1);
    const text = write();
    return validEvent(item) && text.length <= EVENT_TEXT_MAX ? text : null;
}

/**
 * A reason as the dossier keeps it (both sources: a line's own why and a scan's evidence): whole up to `max` characters (WHY_MAX), else cut at a
 * word with an ellipsis. Counted in UTF-16 units like the stored-event check (validEvent), so a cut never makes the event invalid.
 */
export function cutWords(text, max = WHY_MAX) {
    const whole = String(text ?? '');
    if (whole.length <= max) return whole;
    const head = [...whole].reduce((out, char) => (out.length + char.length <= max - 1 ? out + char : out), '');
    return `${head.replace(/\s+\S*$/, '')}…`;   // the same cut the one-pass evidence has had since it was added
}

/**
 * A one-pass scan's evidence as the reason of this reply's story events that gave none (`evidence`: { axis: words }): each such event's why is
 * the evidence of the axes its line asked, in axis order, joined by "; " (cut at a word to WHY_MAX). → the whole new text, or null when nothing gains a reason.
 */
export function withEvidence(prior, reply, evidence) {
    const old = readEvent(prior);
    if (!old || old.at !== reply || !evidence || typeof evidence !== 'object') return null;
    const words = item => AXES.filter(axis => Object.hasOwn(item.ask, axis) && typeof evidence[axis] === 'string').map(axis => evidence[axis].trim().replace(/[\s.;]+$/, '')).filter(Boolean).join('; ');
    let changed = false;
    const events = old.events.map(item => (item.src !== 'story' || item.why || !words(item) ? item : (changed = true, { ...item, why: cutWords(words(item)) })));
    const text = changed ? JSON.stringify({ ...old, events }) : null;
    return text && text.length <= EVENT_TEXT_MAX ? text : null;
}

/**
 * The card's words for one reply's events: { tier, held, note, ask, date }. `tier`: the highest tier actually spent, else the highest
 * asked (events naming only custom meters are left out); `held`: every event was held (then `note` is the first hold's words); `ask`: the held events' asks summed per axis, an axis a
 * story line named counted from the story only (a scanner's request for it is left out).
 */
export function eventSummary(event) {
    if (!event) return null;
    const rank = name => PACING_TIERS.indexOf(name);
    const top = list => list.reduce((best, item) => (rank(item.tier) > rank(best) ? item.tier : best), list[0].tier);
    const spent = event.events.filter(item => !item.held);
    const held = spent.length === 0;
    // An event that names only custom meters asks nothing of the axes: it does not set the chip (unless no event asks anything).
    const asking = event.events.filter(item => Object.keys(item.ask).length);
    const counted = asking.length ? asking : event.events;
    const countedSpent = counted.filter(item => !item.held);
    const named = new Set(event.events.filter(item => item.src === 'story').flatMap(item => Object.keys(item.ask)));
    const ask = {};
    for (const item of event.events.filter(entry => entry.held)) {
        for (const [axis, value] of Object.entries(item.ask)) if (item.src === 'story' || !named.has(axis)) ask[axis] = (ask[axis] || 0) + value;
    }
    // The anti-lever gate's words for the last story line that named an approach: "via praise · 3rd in 2 days · backfired".
    const approach = event.events.findLast(item => item.src === 'story' && item.via);
    const gate = approach ? describeGate(approach.gate ? { via: approach.via, ...approach.gate } : null) || `via ${approach.via}` : '';
    // The reason the story line gave (reason / why / because ...): the last story event's; (rule NSDFOLLOW-3) none: the scan's for the same reply.
    const why = event.events.findLast(item => item.src === 'story' && item.why)?.why ?? event.events.findLast(item => item.why)?.why ?? '';
    return { tier: top(countedSpent.length ? countedSpent : counted), held, note: held ? event.events[0].note : '', ask, date: event.date, ...(gate ? { gate } : {}), ...(why ? { why } : {}) };
}

/** What `changes` ask of the four built-in axes, per axis: an add is its value, a set the distance from the value now (`now(meter)`). */
export function askedOf(changes, now) {
    const ask = {};
    for (const change of changes) {
        if (!RELATIONSHIP_KEYS.includes(change.meter)) continue;
        ask[change.meter] = (ask[change.meter] || 0) + (change.mode === 'add' ? change.value : change.value - now(change.meter));
    }
    return ask;
}
