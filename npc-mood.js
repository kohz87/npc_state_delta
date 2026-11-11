// NPC mood (VAD): the per-NPC mood state, its clamp, the event -> delta rules, the decay per story day, the fixed
// 3x3 word table and the cause text. Pure: no DOM, no host, no clock, no randomness. The story day is given in, and
// the state is plain data on the NPC record (`mood`), written in the same change as the move that caused it, so a
// replay, a rebuild, a swipe or a Re-read gives the live values. Nothing here reads story text.
//
//   mood = { v, a, d, day, cause }
//   v      valence: -3 unpleasant .. 3 pleasant          (whole numbers, code-set only)
//   a      arousal: -3 slack .. 3 keyed up               (Energy bar)
//   d      dominance: -3 cornered .. 3 in control        (Control bar)
//   day    the story day the axes were last settled to; decay runs from here
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

// One step per event on each axis. Decay is one step per story day, toward 0.
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
  return {
    v: clampAxis(raw.v),
    a: clampAxis(raw.a),
    d: clampAxis(raw.d),
    day: dayOf(raw.day),
    cause: cleanReason(raw.cause),
  };
}

/**
 * The axes at `day`: each axis moves one step toward 0 per story day since the stored day, never past 0. The stored
 * day never moves backwards (an older day is read as no days passed). The cause is kept. Pure: the input is not changed.
 */
export function decayMood(mood, day) {
  const base = normalizeMood(mood) ?? neutralMood(day);
  const today = dayOf(day);
  const days = Math.max(0, today - base.day);
  const pull = axis => (axis > 0 ? Math.max(0, axis - days) : Math.min(0, axis + days));
  return {
    v: pull(base.v),
    a: pull(base.a),
    d: pull(base.d),
    day: Math.max(base.day, today),
    cause: base.cause,
  };
}

/**
 * The mood after `events` at `day`: decay from the stored day first, then each known event's delta in order, clamped
 * after each step. events: [{ kind: 'trust-drop' | 'betrayal' | 'rest' | 'safe', reason? }]; unknown kinds are skipped.
 * The cause becomes the last known event's cause text; with no known event the stored cause stays.
 */
export function applyEvents(mood, day, events) {
  let next = decayMood(mood, day);
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
  }
  return { ...next, cause };
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
