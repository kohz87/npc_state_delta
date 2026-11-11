// NPC anti-lever gate: a story line that repeats one approach (praise, gift, help, flirt, threat, shared danger) to the
// same NPC gives less each time, backfires on the repeat the strength sets, and reads praise or a gift from low trust as
// pressure. Pure: no DOM, no clock, no randomness, no mutation of the inputs. The story day and the reply are given in.
// The recent-approach ring (`via` on the NPC record) is written by the caller in the same op as the move it gates, so a
// replay, a rebuild, a swipe and a Re-read give the live values.
//
//   ring  [{ d: story day, r: reply ID or index, v: approach kind }]   at most RECENT_APPROACH_MAX, oldest first
//   gate  { day, reply, via, mode, n, span }   the last outcome; mode 'less' | 'back' | 'susp'
//         n     this approach's place in the window (1 = first)
//         span  days from the first counted approach of this kind to this day, inclusive
//
// Only source 'story' (the story's own meter lines) is gated. A scan-forwarded change passes through unchanged and writes
// no ring entry. The delta is the reply's meter move { trust, affection, tension } in integer step units; the gate adds
// tension (backfire, pressure) and sets trust below zero only on a backfire.
//
// Called by: src/npc-meters.js run() through gateStoryLine() (a story line with `| via:`, only while the feature
// npc-state-delta.anti-lever is on); src/npc-meters-pacing.js (the last-event record) and src/npc-meters-prompt.js (the cue).
// The ring is stored on the NPC record as ONE text leaf (`via`, compact JSON), so the host writes and replays it whole.
// Never imports other NSD modules.

export const APPROACH_KINDS = Object.freeze(['praise', 'gift', 'help', 'flirt', 'threat', 'shared-danger']);
const APPROACH_LABEL = Object.freeze({
    praise: 'praise', gift: 'gift', help: 'help', flirt: 'flirting', threat: 'threat', 'shared-danger': 'shared danger',
});
// Only these approaches read as pressure from low trust (a threat from low trust is simply a threat).
const FLATTERY_KINDS = Object.freeze(['praise', 'gift']);
const METERS_GATED = Object.freeze(['trust', 'affection', 'tension']);

export const GATE_SOURCE = 'story';
export const GATE_MODES = Object.freeze({ less: 'less', back: 'backfired', susp: 'suspicion' });
// `less` multiplies a positive meter move; `backfireAt` is the place in the window whose approach backfires.
export const GATE_STRENGTHS = Object.freeze({
    light: Object.freeze({ less: 0.75, backfireAt: 4 }),
    normal: Object.freeze({ less: 0.5, backfireAt: 3 }),
    strong: Object.freeze({ less: 0.25, backfireAt: 2 }),
});
export const DEFAULT_GATE_SETTINGS = Object.freeze({ windowDays: 3, strength: 'normal' });
export const GATE_WINDOW_MAX = 14;
export const RECENT_APPROACH_MAX = 6;
export const GATE_LOW_TRUST_BELOW = -20;
export const GATE_BACKFIRE_STEP = 1;

const CUE_NAME_MAX = 80;
const REPLY_MAX = 120;
const isInt = value => Number.isInteger(value);
const isReply = value => (typeof value === 'string' ? value.length > 0 && value.length <= REPLY_MAX : isInt(value) && value >= 0);
const numberOr = (value, fallback) => (value === undefined || value === null || value === '' || !Number.isFinite(Number(value)) ? fallback : Number(value));

/** The approach kind of a label (`via: praise`), or null: an unknown or missing label is not gated. */
export function normalizeApproachKind(value) {
    return APPROACH_KINDS.includes(value) ? value : null;
}

/** The gate settings as { windowDays: whole days 1..14, strength: 'light' | 'normal' | 'strong' }. Blank or unknown means the default. */
export function normalizeGateSettings(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const days = Math.round(numberOr(source.windowDays, DEFAULT_GATE_SETTINGS.windowDays));
    return {
        windowDays: Math.max(1, Math.min(GATE_WINDOW_MAX, days)),
        strength: Object.hasOwn(GATE_STRENGTHS, source.strength) ? source.strength : DEFAULT_GATE_SETTINGS.strength,
    };
}

/** The strength's rule: { less, backfireAt }. */
export function strengthRule(strength) {
    return Object.hasOwn(GATE_STRENGTHS, strength) ? GATE_STRENGTHS[strength] : GATE_STRENGTHS[DEFAULT_GATE_SETTINGS.strength];
}

function approachEntryProblems(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return ['is not a record'];
    const errors = [];
    if (!isInt(entry.d)) errors.push('has no whole story day');
    if (!isReply(entry.r)) errors.push('has no reply');
    if (!normalizeApproachKind(entry.v)) errors.push('has no approach kind');
    return errors;
}

/** Problems with a stored ring ([] when fine). */
export function approachRingProblems(value) {
    if (!Array.isArray(value)) return ['is not a list'];
    const errors = [];
    if (value.length > RECENT_APPROACH_MAX) errors.push(`has more than ${RECENT_APPROACH_MAX} entries`);
    value.forEach((entry, index) => {
        for (const problem of approachEntryProblems(entry)) errors.push(`entry ${index + 1} ${problem}`);
    });
    return errors;
}

/** The usable entries of a stored ring, oldest first, at most RECENT_APPROACH_MAX (the newest are kept). */
export function normalizeApproachRing(raw) {
    if (!Array.isArray(raw)) return [];
    const usable = raw.filter(entry => approachEntryProblems(entry).length === 0).map(entry => ({ d: entry.d, r: entry.r, v: entry.v }));
    return usable.slice(-RECENT_APPROACH_MAX);
}

/**
 * The entries that count against this reply: the same story days as the window (`day` back `windowDays` - 1 days, to `day`)
 * and not this reply's own entry, so a re-read of the same reply counts the same as its first read.
 */
export function priorApproaches(ring, { day, reply, windowDays }) {
    const first = day - windowDays + 1;
    return normalizeApproachRing(ring).filter(entry => entry.d >= first && entry.d <= day && entry.r !== reply);
}

/** The ring with this reply's approach added (replacing any earlier entry of the same reply), capped at RECENT_APPROACH_MAX. */
export function addApproach(ring, { day, reply, kind }) {
    const kept = normalizeApproachRing(ring).filter(entry => entry.r !== reply);
    return [...kept, { d: day, r: reply, v: kind }].slice(-RECENT_APPROACH_MAX);
}

/** "1st", "2nd", "3rd", "4th", "11th", "21st" ... */
export function ordinalWord(n) {
    if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
    return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/** The cue name: control characters and extra spaces removed, at most CUE_NAME_MAX code points, never empty. */
function cueName(name) {
    const text = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    return Array.from(text).slice(0, CUE_NAME_MAX).join('') || 'Someone';
}

/** The one-line tail cue for a fired gate, or '' when none fired. No pronoun: the NPC's name is the subject. */
export function gateCue({ mode, via, name }) {
    const label = APPROACH_LABEL[via];
    if (!label) return '';
    const who = cueName(name);
    if (mode === 'back') return `${who} has noticed the repeated ${label}; it backfires.`;
    if (mode === 'susp') return `${who} reads the ${label} as pressure, not warmth.`;
    if (mode === 'less') return `${who} has heard this ${label} before; it lands less.`;
    return '';
}

/** The receipt words for a gate: "via praise · 3rd in 2 days · backfired" ('' when none fired). */
export function describeGate(gate) {
    if (!gate || !Object.hasOwn(GATE_MODES, gate.mode)) return '';
    const parts = [`via ${gate.via}`];
    if (gate.n > 1) parts.push(`${ordinalWord(gate.n)} in ${gate.span} ${gate.span === 1 ? 'day' : 'days'}`);
    parts.push(GATE_MODES[gate.mode]);
    return parts.join(' · ');
}

const isLowTrust = trust => typeof trust === 'number' && trust < GATE_LOW_TRUST_BELOW;

/**
 * Gate one story-line meter move. Inputs: source ('story' or a scan source), via (approach label or null), day (story day
 * before the reply), reply (its ID or index), name (for the cue), trust (the NPC's trust before the move), delta (the move
 * { trust, affection, tension }), ring (the NPC's stored `via` ring), settings (gate settings, normalized here).
 *
 * Rules, in order:
 *   back   n >= backfireAt: a positive affection is dropped, tension +1, trust set to below zero (min(trust, 0) - 1).
 *   susp   praise or gift from trust below GATE_LOW_TRUST_BELOW with a positive affection: that affection moves to tension.
 *   less   n > 1 (a repeat within the window): each positive trust, affection and tension move is multiplied by the factor.
 *   none   otherwise, or when the source is not 'story', or the label is not a known kind.
 * n counts the same kind in the window, this reply included (the first approach is n = 1).
 *
 * Returns { delta, mode, n, via, cue, gate, ring }: the adjusted move; the outcome tag; the cue text (or ''); the gate record
 * for the last-change record (null when none fired); and the ring to store (updated for a story approach, unchanged otherwise).
 */
export function gateApproach({ source, via, day, reply, name, trust, delta, ring, settings }) {
    const kind = normalizeApproachKind(via);
    const out = { ...(delta ?? {}) };
    const stored = normalizeApproachRing(ring);
    if (source !== GATE_SOURCE || !kind || !isInt(day) || !isReply(reply)) {
        return { delta: out, mode: 'none', n: 0, via: kind, cue: '', gate: null, ring: stored };
    }
    const config = normalizeGateSettings(settings);
    const rule = strengthRule(config.strength);
    const sameKind = priorApproaches(stored, { day, reply, windowDays: config.windowDays }).filter(entry => entry.v === kind);
    const n = sameKind.length + 1;
    const span = n > 1 ? day - Math.min(...sameKind.map(entry => entry.d)) + 1 : 1;

    let mode = 'none';
    if (n >= rule.backfireAt) {
        mode = 'back';
        if (out.affection > 0) out.affection = 0;
        out.tension = (out.tension ?? 0) + GATE_BACKFIRE_STEP;
        out.trust = Math.min(out.trust ?? 0, 0) - GATE_BACKFIRE_STEP;
    } else if (FLATTERY_KINDS.includes(kind) && isLowTrust(trust) && out.affection > 0) {
        mode = 'susp';
        out.tension = (out.tension ?? 0) + out.affection;
        out.affection = 0;
    } else if (n > 1) {
        mode = 'less';
        for (const meter of METERS_GATED) if (out[meter] > 0) out[meter] = Math.trunc(out[meter] * rule.less);
    }

    const gate = mode === 'none' ? null : { day, reply, via: kind, mode, n, span };
    return {
        delta: out,
        mode,
        n,
        via: kind,
        cue: gateCue({ mode, via: kind, name }),
        gate,
        ring: addApproach(stored, { day, reply, kind }),
    };
}

// ---- the stored ring, the settings and the story-line wiring (src/npc-meters.js) ----

export const GATE_RING_TEXT_MAX = 1200;

/** The ring held in stored text, or null when the text is absent or not valid in every entry. */
export function readApproachRing(text) {
    if (typeof text !== 'string' || !text || text.length > GATE_RING_TEXT_MAX) return null;
    let value;
    try { value = JSON.parse(text); } catch { return null; }
    return approachRingProblems(value).length ? null : value;
}

/** The ring as the text the record stores. */
export const approachRingText = ring => JSON.stringify(normalizeApproachRing(ring));

/** The gate settings of the module's stored settings (`gateDays`, `gateStrength`), normalized. */
const gateSettingsOf = raw => normalizeGateSettings({ windowDays: raw?.gateDays, strength: raw?.gateStrength });

/** Problems with the gate part of a last-event item ({ mode, n, span }; absent is fine) ([] when fine). */
export function gateEventProblems(value) {
    if (value === undefined) return [];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return ['is not a record'];
    const errors = [];
    if (!Object.hasOwn(GATE_MODES, value.mode)) errors.push('has no known mode');
    if (!isInt(value.n) || value.n < 1) errors.push('has no place in the window');
    if (!isInt(value.span) || value.span < 1) errors.push('has no span');
    if (Object.keys(value).some(key => !['mode', 'n', 'span'].includes(key))) errors.push('has an unknown field');
    return errors;
}

/**
 * The gate for one story line of a hosted run. `changes` are the line's meter changes ({ meter, mode: 'add' | 'set', value }), `cap` the points its impact tier allows (null: none),
 * `read(id)` a meter's value now, `stored` the record's `via` text. A change to trust, affection or tension is turned into the
 * move it asks (a `=N` is its distance from now) and gated as one; every other change is kept as it is.
 * → { changes, ring (text to store, or null when it is as stored), via, event ({ mode, n, span } or null), cue, receipt (the words) },
 *   or null when nothing is gated (no known approach, no story day, no reply).
 */
export function gateStoryLine({ changes, read, via, day, reply, name, settings, stored, cap = null }) {
    const kind = normalizeApproachKind(via);
    if (!kind || !isInt(day) || !isReply(reply)) return null;
    const asked = {};
    for (const change of changes) {
        if (METERS_GATED.includes(change.meter)) asked[change.meter] = (asked[change.meter] ?? 0) + (change.mode === 'add' ? change.value : change.value - read(change.meter));
    }
    // A rise is held to the tier's cap first, so "less" is a share of what the move would have given, not of a larger ask.
    if (isInt(cap)) for (const meter of METERS_GATED) if (asked[meter] > cap) asked[meter] = cap;
    const out = gateApproach({ source: GATE_SOURCE, via: kind, day, reply, name, trust: read('trust'), delta: asked, ring: readApproachRing(stored) ?? [], settings: gateSettingsOf(settings) });
    const kept = changes.filter(change => !METERS_GATED.includes(change.meter));
    const gated = METERS_GATED.filter(meter => out.delta[meter]).map(meter => ({ meter, mode: 'add', value: out.delta[meter] }));
    const text = approachRingText(out.ring);
    const event = out.gate ? { mode: out.gate.mode, n: out.gate.n, span: out.gate.span } : null;
    return {
        changes: out.mode === 'none' ? changes : [...kept, ...gated],
        ring: text === stored ? null : text,
        via: kind,
        event: event && !gateEventProblems(event).length ? event : null,
        cue: out.cue,
        receipt: describeGate(out.gate),
    };
}
