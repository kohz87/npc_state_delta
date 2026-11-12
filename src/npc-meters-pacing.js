// What the hosted slice does with a held event: the reader's words for the receipt and the cut of a forwarded scanner change to a
// lower tier, and the reply's last-event record (lastEvent: readEvent, nextEvent, eventSummary, askedOf). A pure part of the pacing rule (src/relationship-pacing.js, which holds the count); never imports npc-meters.js.
import { RELATIONSHIP_KEYS, RELATIONSHIP_MILESTONE_REQUIREMENTS, RELATIONSHIP_MILESTONE_THRESHOLDS } from '../core-relationship-model.js';
import { PACING_TIERS } from './relationship-pacing.js';
import { describeGate, gateEventProblems, normalizeApproachKind } from '../npc-meters-gate.js';

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

// ---- the last event of a reply (record.lastEvent): what the reply's meter lines and scans asked, and what the day's allowance made of it ----
//
// Stored as ONE text leaf (compact JSON), so the host always writes and replays it whole: { at: reply, date, events: [{ src, ask, tier,
// held, note }] } (up to 4 events, the oldest of its kind making room for a fifth; `ask`: the four built-in axes' asked amounts;
// `date`: the story date before the reply). A new reply replaces it; another event of the same reply writes the whole longer list.
// Nothing that decides meters reads it; it feeds the card and the next prompt's gate cue (npc-meters-prompt.js), so a gate event stays.
const AXES = ['trust', 'affection', 'desire', 'tension'];
export const EVENT_MAX = 4;
const EVENT_TEXT_MAX = 1300;
const NOTE_MAX = 120;
const WHY_MAX = 240;   // a story line's own why is cut to 80 where it is read (captureLine); a scan's evidence (withEvidence) may be longer
const DATE_MAX = 40;
const SOURCES = ['story', 'scan'];
const wholeInt = value => Number.isSafeInteger(value);
const replyOk = value => (typeof value === 'string' && value.length > 0 && value.length <= 80) || (wholeInt(value) && value >= 0);

function validEvent(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !SOURCES.includes(item.src) || !PACING_TIERS.includes(item.tier)) return false;
    if (typeof item.held !== 'boolean' || typeof item.note !== 'string' || item.note.length > NOTE_MAX) return false;
    // The anti-lever gate's part (npc-meters-gate.js): the approach the story line named, and the outcome when the gate fired.
    if (item.why !== undefined && (typeof item.why !== 'string' || !item.why || item.why.length > WHY_MAX)) return false;   // the story line's (or, rule NSDFOLLOW-3, the scan's) own reason, or its one-pass evidence (withEvidence)
    if (item.via !== undefined && !normalizeApproachKind(item.via)) return false;
    if (item.gate !== undefined && (!item.via || gateEventProblems(item.gate).length)) return false;
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
    return value;
}

/** What a hosted run records for one paced event: the whole new text for the record (`prior`: the stored text), or null when it need not change. */
export function nextEvent(prior, { reply, date, src, ask, tier, held, note, via, gate, why }) {
    const old = readEvent(prior);
    let events = old && old.at === reply ? old.events : [];
    const mine = Object.fromEntries(AXES.filter(axis => wholeInt(ask?.[axis]) && ask[axis] !== 0).map(axis => [axis, ask[axis]]));
    const item = { src, ask: mine, tier, held: Boolean(held), note: String(note || '').slice(0, NOTE_MAX), ...(String(why || '').trim() ? { why: String(why).trim().slice(0, WHY_MAX) } : {}), ...(via ? { via, ...(gate ? { gate } : {}) } : {}) };
    // A full list (EVENT_MAX) makes room by dropping the oldest event of the new one's own kind (held or spent), else the oldest, so
    // a later spent event is never hidden behind four held ones (the card would say "Nothing moved") nor the reverse. An event that
    // fired the gate is dropped last: the next prompt's gate cue reads it.
    if (events.length >= EVENT_MAX) {
        const at = [e => e.held === item.held && !e.gate, e => !e.gate, e => e.held === item.held, () => true]
            .map(test => events.findIndex(test)).find(index => index !== -1);
        events = events.filter((_, index) => index !== at);
    }
    const text = JSON.stringify({ at: reply, date: String(date || '').slice(0, DATE_MAX), events: [...events, item] });
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
