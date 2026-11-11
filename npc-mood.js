// NPC mood (VAD): the per-NPC mood state, its clamp, the event -> delta rules, the settling toward a resting mood
// over story time, the fixed 3x3 word table and the cause text. Pure: no DOM, no host, no clock, no randomness. The story minute is given in, and
// the state is plain data on the NPC record (`mood`), written in the same change as the move that caused it, so a
// replay, a rebuild, a swipe or a Re-read gives the live values. Nothing here reads story text.
//
//   mood = { v, a, d, day, cause, at?, from?, rest? }
//   v      valence: -3 unpleasant .. 3 pleasant          (whole numbers, code-set only)
//   a      arousal: -3 slack .. 3 keyed up               (Energy bar)
//   d      dominance: -3 cornered .. 3 in control        (Control bar)
//   day    the story day the axes were last settled to
//   at     the story minute of the last event; from = the axes at that minute; rest = this person's resting mood (their
//          temperament, -2..2 per axis, default 0,0,0). The axes now are always eased from `from` over (now - at), so the
//          result does not depend on how often it is read: the same minute twice gives the same axes. Old records (no
//          at/from/rest) read as at = day start, from = their axes, rest = 0.
//   All three axes are always kept, also at rest (they settle at `rest`, never removed or nulled).
//   cause  the last cause text, e.g. "trust dropped: Astra lied" (plain text; the UI escapes it)
//
// Events come from code: a trust drop or betrayal from the reply's own trust move (eventsFromMoves), rest and safety
// from the rest kinds. Fight and hurt are NOT derived here: no NSD reader of RPG receipts exists yet.
// TODO: add 'hurt' and 'fight' events when that reader lands (NSDMAP section 1, RPG receipts).
// Wired in src/: run() applies the events of a line's trust move (feature npc-state-delta.mood-pull), the tick decays, the tail and the dossier row read the word.
// Never imports the host, the meter modules or the instinct modules.

export const MOOD_MIN = -3;
export const MOOD_MAX = 3;
export const MOOD_BAND_EDGE = 2; // |axis| >= 2 is a band; -1..1 reads as neutral
export const CAUSE_MAX = 80;
// The story's own steps are small (a line moves a person at most 1 / 2 / 3 / 6 points by its impact tier), so the thresholds are too.
export const TRUST_DROP_MIN = 2; // a trust change of -2 or worse in one reply is a trust drop
export const BETRAYAL_TRUST = 6; // a trust change of -6 or worse is a betrayal; so is -3 or worse at a major/extreme impact
export const SEVERE_DROP_MIN = 3;

// One step per event on each axis. Between events each axis eases toward the resting mood: the further away, the bigger the
// step back (halves every HALF_LIFE minutes, integer, never past rest). Arousal about half every 3.5 story hours, valence
// about gone in 1-2 days, dominance about 3 days. New events add on top of whatever is left.
export const DAY_MIN = 1440;
export const HALF_LIFE = Object.freeze({ a: 210, v: 720, d: 1620 });
export const REST_LIMIT = 2;
export const EVENT_DELTAS = Object.freeze({
  'trust-drop': Object.freeze({ v: -1, a: 1, d: -1 }),
  betrayal: Object.freeze({ v: -2, a: 2, d: -1 }),
  rest: Object.freeze({ v: 1, a: -1, d: 0 }),
  safe: Object.freeze({ v: 1, a: 0, d: 1 }),
});

const EVENT_LABELS = Object.freeze({
  'trust-drop': 'trust dropped',
  betrayal: 'betrayed',
  rest: 'rested',
  safe: 'felt safe',
});

// Rows: valence band (-1 unpleasant, 0 neutral, 1 pleasant). Columns: arousal band (-1 low, 0 mid, 1 high).
export const MOOD_WORDS = Object.freeze([
  Object.freeze(['Wary', 'Tense', 'Alarmed']),
  Object.freeze(['Flat', 'Steady', 'Restless']),
  Object.freeze(['Calm', 'Content', 'Eager']),
]);

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);

/** One axis as a whole number in -3..3. Non-numbers and NaN read as 0; -0 is returned as 0. */
export function clampAxis(value) {
  if (!isFiniteNumber(value)) return 0;
  const n = Math.round(value);
  if (n === 0) return 0;
  return n < MOOD_MIN ? MOOD_MIN : n > MOOD_MAX ? MOOD_MAX : n;
}

/** A story day as a whole number >= 0; anything else reads as day 0. */
export function dayOf(value) {
  return isFiniteNumber(value) && value > 0 ? Math.floor(value) : 0;
}

/** Plain text on one line: control characters and the line-grammar '|' become spaces, runs collapse, ends trim. */
function flatText(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/[\r\n\t|]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Plain text capped at CAUSE_MAX characters; a longer text ends in an ellipsis. Idempotent. */
export function cleanReason(text) {
  const flat = flatText(text);
  return flat.length > CAUSE_MAX ? `${flat.slice(0, CAUSE_MAX - 1).trimEnd()}…` : flat;
}

/**
 * The cause text for one event: "trust dropped: Astra lied", "betrayed", "rested". The reason is the story's own
 * reason label (reason|why|because|note|cause), flattened and capped. An unknown kind gives ''.
 */
export function causeText(kind, reason) {
  if (!hasOwn(EVENT_LABELS, kind)) return '';
  const why = flatText(reason);
  return cleanReason(why ? `${EVENT_LABELS[kind]}: ${why}` : EVENT_LABELS[kind]);
}

/** The starting mood on a given story day: every axis 0, no cause. */
export function neutralMood(day = 0) {
  return { v: 0, a: 0, d: 0, day: dayOf(day), cause: '' };
}

/**
 * A stored mood record cleaned to its shape: axes clamped to -3..3, day a whole number >= 0, cause capped plain text.
 * Absent or non-object input gives null (an old record without `mood`). Idempotent.
 */
export function normalizeMood(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const axes = value => (value && typeof value === 'object' && !Array.isArray(value) ? { v: clampAxis(value.v), a: clampAxis(value.a), d: clampAxis(value.d) } : null);
  const from = axes(raw.from);
  const rest = axes(raw.rest);
  return {
    v: clampAxis(raw.v),
    a: clampAxis(raw.a),
    d: clampAxis(raw.d),
    day: dayOf(raw.day),
    cause: cleanReason(raw.cause),
    ...(isFiniteNumber(raw.at) ? { at: dayOf(raw.at) } : {}),
    ...(from ? { from } : {}),
    ...(rest ? { rest } : {}),
  };
}

/** One axis eased from `from` toward `rest` over `minutes`: magnitude x 2^-(minutes/half) in integers (linear between halvings, rounded half up), never past rest. */
export function easeAxis(from, rest, minutes, half) {
  const dist = from - rest;
  if (!dist || !(minutes > 0)) return from;
  const mag = Math.abs(dist);
  const whole = Math.min(40, Math.floor(minutes / half));
  const den = 2 * half * 2 ** whole;
  const left = Math.min(mag, Math.floor((2 * mag * (2 * half - (minutes - whole * half)) + den) / (2 * den)));
  return rest + (dist < 0 ? -left : left);
}

/** A person's resting mood from their temperament words (pack personality / first description): -2..2 per axis, 0,0,0 when no word is known. */
const TEMPER = Object.freeze({
  v: [[/\b(cheerful|warm|kind|gentle|joyful|optimistic|sunny|genial|easygoing|affectionate)\b/g, 1], [/\b(bitter|gloomy|sullen|cold|morose|pessimistic|cynical|brooding|grim|melancholy)\b/g, -1]],
  a: [[/\b(energetic|excitable|restless|fiery|hot-headed|jumpy|nervous|eager|hyper|volatile)\b/g, 1], [/\b(calm|serene|placid|lethargic|stoic|unhurried|sleepy|relaxed|composed)\b/g, -1]],
  d: [[/\b(confident|commanding|bold|assertive|authoritative|proud|fearless|domineering)\b/g, 1], [/\b(timid|meek|anxious|shy|submissive|fearful|insecure|hesitant|nervous)\b/g, -1]],
});
export function restingMood(...texts) {
  const text = texts.filter(item => typeof item === 'string').join(' ').toLowerCase();
  const out = { v: 0, a: 0, d: 0 };
  for (const axis of Object.keys(TEMPER)) {
    const sum = TEMPER[axis].reduce((total, [word, sign]) => total + sign * (text.match(word)?.length ?? 0), 0);
    out[axis] = Math.max(-REST_LIMIT, Math.min(REST_LIMIT, sum));
  }
  return out;
}

/** A fresh mood sitting at a resting mood at story minute `at` (axes = rest, no cause). */
export function restMood(rest, at = 0) {
  const r = { v: clampAxis(rest?.v), a: clampAxis(rest?.a), d: clampAxis(rest?.d) };
  const minute = dayOf(at);
  return { v: r.v, a: r.a, d: r.d, day: Math.floor(minute / DAY_MIN), cause: '', at: minute, from: { v: r.v, a: r.a, d: r.d }, rest: { v: r.v, a: r.a, d: r.d } };
}

/**
 * The mood settled to story minute `minutes`: each axis eased from the anchor (`from` at `at`) toward the resting mood by its
 * own speed, so it does not matter how often this runs. Never past rest; the cause, anchor and rest are kept. Pure.
 */
export function decayMood(mood, minutes) {
  const base = normalizeMood(mood) ?? neutralMood(Math.floor(dayOf(minutes) / DAY_MIN));
  const now = dayOf(minutes);
  const at = base.at ?? base.day * DAY_MIN;
  const from = base.from ?? { v: base.v, a: base.a, d: base.d };
  const rest = base.rest ?? { v: 0, a: 0, d: 0 };
  const elapsed = Math.max(0, now - at);
  const ease = axis => clampAxis(easeAxis(from[axis], rest[axis], elapsed, HALF_LIFE[axis]));
  return { v: ease('v'), a: ease('a'), d: ease('d'), day: Math.max(base.day, Math.floor(now / DAY_MIN)), cause: base.cause, at, from, rest };
}

/**
 * The mood after `events` at story minute `minutes`: settle toward rest first, then each known event's delta in order, clamped
 * after each step; an event re-anchors the easing (from = the new axes, at = now). events: [{ kind: 'trust-drop' | 'betrayal' | 'rest' | 'safe', reason? }]; unknown kinds are skipped.
 * The cause becomes the last known event's cause text; with no known event the stored cause stays.
 */
export function applyEvents(mood, minutes, events) {
  let next = decayMood(mood, minutes);
  let hit = false;
  let cause = next.cause;
  for (const event of Array.isArray(events) ? events : []) {
    const kind = event?.kind;
    if (!hasOwn(EVENT_DELTAS, kind)) continue;
    const delta = EVENT_DELTAS[kind];
    next = {
      ...next,
      v: clampAxis(next.v + delta.v),
      a: clampAxis(next.a + delta.a),
      d: clampAxis(next.d + delta.d),
    };
    cause = causeText(kind, event.reason);
    hit = true;
  }
  return hit ? { ...next, cause, at: dayOf(minutes), from: { v: next.v, a: next.a, d: next.d } } : { ...next, cause };
}

/**
 * The events one reply makes for one NPC, from that NPC's own meter moves in the reply.
 * moves: [{ meter: 'trust', change: -12 }], the applied change after the per-reply caps (several trust rows are summed).
 * opts: { reason, impact } where impact is the reply's tier label ('ordinary' | 'meaningful' | 'major' | 'extreme').
 * A trust change of -6 or worse is a betrayal; so is -3 or worse at a major or extreme impact. A smaller drop is a
 * trust drop. A rise or no change gives no event.
 */
export function eventsFromMoves(moves, opts = {}) {
  const trust = Array.isArray(moves) ? moves.filter(m => m && m.meter === 'trust' && isFiniteNumber(m.change)) : [];
  const change = trust.reduce((sum, m) => sum + m.change, 0);
  if (!(change < 0)) return [];
  const severe = opts?.impact === 'major' || opts?.impact === 'extreme';
  let kind = null;
  if (change <= -BETRAYAL_TRUST || (severe && change <= -SEVERE_DROP_MIN)) kind = 'betrayal';
  else if (change <= -TRUST_DROP_MIN) kind = 'trust-drop';
  return kind ? [{ kind, reason: opts?.reason ?? '' }] : [];
}

/** The band of one axis: -1 at -2 or below, 1 at 2 or above, else 0. */
export function bandOf(value) {
  const n = clampAxis(value);
  if (n <= -MOOD_BAND_EDGE) return -1;
  return n >= MOOD_BAND_EDGE ? 1 : 0;
}

/** The one word for a mood, from the 3x3 table by valence and arousal bands. Dominance is not in the table. */
export function moodWord(mood) {
  const m = normalizeMood(mood) ?? neutralMood();
  return MOOD_WORDS[bandOf(m.v) + 1][bandOf(m.a) + 1];
}

/** The Energy (arousal) and Control (dominance) bars as steps 0..6, where 3 is the middle. */
export function moodBars(mood) {
  const m = normalizeMood(mood) ?? neutralMood();
  return { energy: m.a - MOOD_MIN, control: m.d - MOOD_MIN, max: MOOD_MAX - MOOD_MIN };
}
