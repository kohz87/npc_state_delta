// NPC meters for Story Suite v2 (Story Block 2, docs/v2/SPEC.md §2, §4, §5; coordinator decisions
// F81, F90 and TRS ideas 1-4): a small slice of each NPC in v2's per-reply state, so the meters swipe
// and delete back with the replies. The long prose dossiers stay in Delta's own sidecar; only numbers,
// stage names, milestone names and the ids of unlocked hidden notes live here.
//
//   npc = {
//     npcs: { [key]: { name, meters: { trust, affection, desire, tension, ...custom }, stages: { meter: name },
//                      unlocked: [noteId], disposition?, turn?: { reply, from: { meter: value } },
//                      milestones?: { [milestoneKey]: name }, rank?: rungKey, low?: n, day?: n } },
//     problems: [{ rev, text }],          // the last change lines code could not use in full (last 20)
//   }
//
// * Keys are the NPC's name in lowercase words joined by "-" (`mira`, `jean-luc`), so a line about
//   someone Delta has no dossier for still finds the same entry next time; a dossier is matched to
//   its entry by its name, then its aliases.
// * Meters: trust, affection, desire and tension (-100..100, starting from Delta's base values, or
//   from the dossier's own numbers for someone Delta already knows), plus up to six custom meters
//   from the reader's settings and the presets in use. Code clamps every value to its range, and the
//   change of one meter within one reply to the change cap (`turn.from` holds the values the reply
//   started from). A custom meter may carry a rule line for the story (`describe`), band words the
//   tail uses instead of its number (`bands`), and a drift toward a value per story day (`drift`).
// * Per-NPC limits (the dossier's `meterSetup`, or the preset the reader gave that NPC): growth from
//   the story or a scan stops at the meter's ceiling, a fall stops at its floor. A change away from a
//   limit always lands in full; a value the reader set beyond one is never pulled back to it.
// * Stages (F90): named thresholds per meter. A threshold at 0 or above is reached at or above it, a
//   negative one at or below it; the stage is the farthest one reached. Code moves the stage when a
//   meter crosses a threshold either way and says so in the receipt. The story cannot set a stage.
// * Stage ladder (feature npc-state-delta.stages): rungs in order, each needing several meters at once
//   and optionally a story milestone ("Confidant: trust 60, affection 40, milestone saved her
//   brother"). `rank` is the rung reached. Code promotes as soon as the next rung's needs are met,
//   never while a conflict is on (tension above `conflictAt`); it demotes one rung only after the
//   rung's needs have failed `demoteAfter` replies in a row (`low` counts them, on Delta's per-reply
//   tick). Milestones are keyed by their words: `+ milestone Mira — saved her brother` (once) or the
//   reader in the dossier editor. Setting one writes nothing to the prompt by itself.
// * Hidden notes ("secrets"): kept in Delta's dossier with an unlock rule { meter, at } and an
//   optional title. When the meter reaches `at` (same rule as a threshold), code adds the note's id to
//   `unlocked` (it stays unlocked on that line of history) and says so; the text itself never enters
//   this state and is given to the story only through the tail, only while the NPC is present and
//   unlocked. While locked, screens show the title and the rule ("🔒 Her past — unlocks at Trust 60").
//
// Pure: no DOM, no SillyTavern, no clock, no randomness. What Delta knows (dossier names, base
// values, note rules and texts, per-NPC setup, presets, who is present) comes in through the hooks
// given to createNpcPart.
import { BUILT_IN_PRESETS, normalizeLimits, normalizePreset, presetIds } from './npc-meters-presets.js';

export const NPC_DOMAIN = 'npc';
export const NPC_KIND = 'npc';
export const MILESTONE_KIND = 'milestone';
export const BUILT_IN_METERS = Object.freeze([
    Object.freeze({ id: 'trust', label: 'Trust', tone: 'info' }),
    Object.freeze({ id: 'affection', label: 'Affection', tone: 'good' }),
    Object.freeze({ id: 'desire', label: 'Desire', tone: 'accent' }),
    Object.freeze({ id: 'tension', label: 'Tension', tone: 'warn' }),
]);
export const BUILT_IN_RANGE = Object.freeze({ min: -100, max: 100 });
export const CUSTOM_RANGE = Object.freeze({ min: -1000, max: 1000 });
export const MAX_CUSTOM_METERS = 6;
export const MAX_NPCS = 80;
export const MAX_METERS_PER_NPC = 24;
export const MAX_STAGES_PER_METER = 8;
export const MAX_SECRETS = 8;
export const MAX_UNLOCKED = 32;
export const MAX_PROBLEMS = 20;
export const MAX_MILESTONES = 16;
export const MAX_RUNGS = 8;
export const MAX_TRACKS = 6;
export const MAX_BANDS = 8;
export const MAX_NEEDS = 6;
export const DEFAULT_CHANGE_CAP = 15;
export const MAX_CHANGE_CAP = 200;
export const DEFAULT_CONFLICT_AT = 50;
export const DEFAULT_DEMOTE_AFTER = 3;
export const DAY_MINUTES = 1440;
// "Changed lately" for the tail: the meters moved on one of the last few messages (about two replies).
export const RECENT_MESSAGES = 4;
export const SECRET_TEXT_MAX = 300;
export const SECRET_TITLE_MAX = 60;
export const MILESTONE_MAX = 60;
export const DESCRIBE_MAX = 100;
export const TAIL_SECRETS_PER_NPC = 3;
export const CONTEXT_BUDGET = 250;

// The optional mechanics (MODULES §F100). A host without the Features API gets each one's default.
export const FEATURE_STAGES = 'npc-state-delta.stages';
export const FEATURE_DRIFT = 'npc-state-delta.drift';
export const FEATURE_PRESETS = 'npc-state-delta.presets';
export const FEATURES = Object.freeze([
    Object.freeze({ id: FEATURE_STAGES, label: 'Stage ladders and milestones', describe: 'Stages that need several meters at once and a story milestone; promotion waits out a conflict, a stage is lost only after a sustained low.', default: true, prompt: true }),
    Object.freeze({ id: FEATURE_DRIFT, label: 'Meters drift each story day', describe: 'Meters with a drift setting move toward their resting value as story days pass (needs Story Director\'s clock).', default: false }),
    Object.freeze({ id: FEATURE_PRESETS, label: 'Meter presets and rules', describe: 'One-click meter sets (Companion, Rival, Mentor and packs\') and each meter\'s rule line in the story\'s instructions.', default: true, prompt: true }),
]);
const FEATURE_DEFAULTS = Object.freeze(Object.fromEntries(FEATURES.map(feature => [feature.id, feature.default])));

const NAME_MAX = 120;
const LABEL_MAX = 40;
const STAGE_NAME_MAX = 40;
const DISPOSITION_MAX = 80;
const KEY_MAX = 60;
const METER_ID_MAX = 40;
const BAND_WORD_MAX = 24;
const TRACK_MAX = 80;
const TONES = Object.freeze(['neutral', 'accent', 'good', 'warn', 'bad', 'info']);
// Labels a change line may carry that are not meters: the reason words are skipped quietly,
// `stage` is refused (code sets stages), `disposition` is a short word kept on the entry.
const REASON_LABELS = new Set(['reason', 'why', 'because', 'note', 'cause']);
const RESERVED_IDS = new Set(['stage', 'stages', 'disposition', 'name', 'meter', 'meters', 'milestone', 'milestones', ...REASON_LABELS]);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const WORDS = /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u;
const RECORD_FIELDS = Object.freeze(['name', 'meters', 'stages', 'unlocked', 'disposition', 'turn', 'milestones', 'rank', 'low', 'day']);

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const isInt = value => Number.isInteger(value);
// The longest reply record ID a meter window keeps (Story Block's are "sw_" and 12 letters).
const REPLY_ID_MAX = 64;
const isReplyId = value => typeof value === 'string' && value.length > 0 && value.length <= REPLY_ID_MAX;
/**
 * The reply a meter window belongs to (SPEC §2.2, per-reply bookkeeping): the reply's record ID (`sid`),
 * which a middle delete never moves (B-a1-15), else its index (a host that gives no record ID); null
 * when neither is known.
 */
export const replyKey = (sid, index) => (isReplyId(sid) ? sid : isInt(index) && index >= 0 ? index : null);
// Whether the window `turn` is the reply `key`'s.
const sameReply = (turn, key) => turn?.reply === key && key !== null && key !== undefined;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
// Flattened to one line and cut by code points (a surrogate pair is never split).
const clean = (value, max) => [...String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, max).join('').trim();
const own = (object, key) => isObject(object) && Object.hasOwn(object, key);

/** Lowercase words joined by "-": `Jean-Luc Picard` → `jean-luc-picard`. '' when nothing is left. */
export function slug(value, max = METER_ID_MAX) {
    return String(value ?? '').normalize('NFKC').toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
}

/** The slice key for an NPC's name, or null. Keys that name JavaScript internals get "-npc". */
export function npcKey(name) {
    const key = slug(name, KEY_MAX);
    if (!key) return null;
    return FORBIDDEN_KEYS.has(key) ? `${key}-npc` : key;
}

/** The key of a milestone or a rung: its words, lowercase, joined by "-" ('' when none). */
export function wordKey(value) {
    const key = slug(value, METER_ID_MAX);
    return FORBIDDEN_KEYS.has(key) ? `${key}-key` : key;
}

const intOr = (value, fallback) => {
    if (value === null || value === undefined || value === '') return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number) : fallback;
};

/**
 * Band words from a settings text: `doubtful 25, steady 60, devoted` → [{ upTo: 25, word }, { upTo:
 * 60, word }, { upTo: null, word: 'devoted' }]: a value up to a band's number takes its word, above
 * the last number the band without one. A list of { upTo, word } is read too. At most eight.
 */
export function parseBands(value) {
    // A pack's bands (Story Block PACKS.md): [{ at, word }] lowest first, each word holding from its
    // `at` up to the next band's: the same bands written as "up to" the next band's start.
    if (Array.isArray(value) && value.some(item => isObject(item) && item.at !== undefined && item.upTo === undefined)) {
        const from = value.filter(item => isObject(item) && isInt(intOr(item.at, null))).map(item => ({ at: intOr(item.at, null), word: item.word }))
            .sort((a, b) => a.at - b.at).slice(0, MAX_BANDS);
        value = from.map((item, index) => ({ word: item.word, upTo: index + 1 < from.length ? from[index + 1].at - 1 : null }));
    }
    const items = Array.isArray(value) ? value : String(value ?? '').split(/[,;\n]/);
    const out = [];
    let top = null;
    for (const item of items) {
        let word;
        let upTo;
        if (isObject(item)) {
            word = clean(item.word, BAND_WORD_MAX);
            upTo = intOr(item.upTo ?? item.to, null);
        } else {
            const match = /^(.*?)\s*(?:(?:<=|≤|up to|to)\s*)?([+\-−]?\d{1,4})?$/u.exec(clean(item, 60));
            if (!match) continue;
            word = clean(match[1], BAND_WORD_MAX);
            upTo = match[2] === undefined ? null : Number(match[2].replace('−', '-'));
        }
        if (!word || !/^[\p{L}][\p{L}\p{N}' -]*$/u.test(word)) continue;
        if (upTo === null) { top ??= word; continue; }
        if (out.length >= MAX_BANDS || out.some(band => band.upTo === upTo)) continue;
        out.push({ upTo, word });
    }
    out.sort((a, b) => a.upTo - b.upTo);
    if (top && out.length < MAX_BANDS) out.push({ upTo: null, word: top });
    return Object.freeze(out.map(band => Object.freeze(band)));
}

/** The band word for `value` ('' when the meter has no bands). */
export function bandWord(bands, value) {
    const list = Array.isArray(bands) ? bands : [];
    return list.find(band => band.upTo === null || value <= band.upTo)?.word ?? '';
}

/**
 * A rung's needs from a settings text: `trust 60, affection >= 40, tension <= -10` (also joined by
 * "and" or "&") → [{ meter, at, below }]. A plain number at 0 or more is "at or above", a negative one
 * "at or below" (the stages' rule); `<=` and `>=` say it outright. A record { trust: 60 } or a list of
 * { meter, at } is read too. At most six; parts that do not read are left out.
 */
export function parseNeeds(value) {
    const out = [];
    const push = (meter, at, op) => {
        const id = slug(meter);
        if (!id || !isInt(at) || out.length >= MAX_NEEDS || out.some(need => need.meter === id)) return;
        const below = op === '<=' || op === '≤' ? true : op === '>=' || op === '≥' ? false : at < 0;
        out.push(Object.freeze({ meter: id, at: clamp(at, CUSTOM_RANGE.min, CUSTOM_RANGE.max), below }));
    };
    if (Array.isArray(value)) {
        for (const item of value) if (isObject(item)) push(item.meter, intOr(item.at, null), item.below === true ? '<=' : item.below === false ? '>=' : null);
    } else if (isObject(value)) {
        for (const [meter, at] of Object.entries(value)) push(meter, intOr(at, null), null);
    } else {
        for (const part of String(value ?? '').split(/,|;|&|\band\b/iu)) {
            const match = /^([\p{L}][\p{L}\p{N} _-]*?)\s*(>=|≥|<=|≤|=|at)?\s*([+\-−]?\d{1,4})$/u.exec(clean(part, 80));
            if (match) push(match[1], Number(match[3].replace('−', '-')), match[2] ?? null);
        }
    }
    return Object.freeze(out);
}

const needMet = (need, value) => (need.below ? value <= need.at : value >= need.at);

// A custom meter row (the reader's or a preset's), cleaned, or null. `taken`: ids already in use.
function customMeter(entry, taken, preset = null) {
    if (!isObject(entry)) return null;
    const label = clean(entry.name ?? entry.label ?? entry.id, LABEL_MAX);
    const id = slug(entry.id || label);
    if (!id || taken.has(id) || RESERVED_IDS.has(id) || FORBIDDEN_KEYS.has(id)) return null;
    let min = clamp(intOr(entry.min, 0), CUSTOM_RANGE.min, CUSTOM_RANGE.max);
    let max = clamp(intOr(entry.max, 100), CUSTOM_RANGE.min, CUSTOM_RANGE.max);
    // An empty or upside-down range (a row just added in the overlay) reads as 0..100.
    if (!(max > min)) { min = 0; max = 100; }
    const start = clamp(intOr(entry.start, clamp(0, min, max)), min, max);
    const show = !(entry.show === false || entry.show === 'hidden' || entry.show === 'no');
    const tone = TONES.includes(entry.tone) ? entry.tone : 'neutral';
    // A longer rule (a pack's may run to 200 characters) is cut at a word, never mid-word.
    const fullRule = clean(entry.describe ?? entry.rule, 400);
    const cutRule = [...fullRule].length > DESCRIBE_MAX ? clean(fullRule, DESCRIBE_MAX).replace(/\s+\S*$/, '') : fullRule;
    const describe = cutRule.replace(/[.;\s]+$/, '');
    const bands = parseBands(entry.bands);
    // Drift: the settings' `drift` (a day) and `driftTo`, or a pack's { toward, perDay }.
    const given = isObject(entry.drift) ? entry.drift : { perDay: entry.drift, toward: entry.driftTo };
    const perDay = clamp(intOr(given.perDay, 0), 0, 100);
    const drift = perDay > 0 ? Object.freeze({ perDay, to: clamp(intOr(given.toward, start), min, max) }) : null;
    taken.add(id);
    return Object.freeze({ id, label: label || id, min, max, start, show, builtIn: false, tone, describe, bands, drift, ...(preset ? { preset } : {}) });
}

// One ladder row, cleaned: { key, name, needs, milestone: { key, name } | null }, or null.
function rung(entry) {
    if (!isObject(entry)) return null;
    const name = clean(entry.name, STAGE_NAME_MAX);
    const key = wordKey(name);
    const needs = parseNeeds(entry.needs ?? entry.need);
    const milestoneName = clean(entry.milestone, MILESTONE_MAX);
    const milestone = milestoneName && wordKey(milestoneName) ? Object.freeze({ key: wordKey(milestoneName), name: milestoneName }) : null;
    if (!name || !key || (!needs.length && !milestone)) return null;
    const cue = clean(entry.cue, 200);
    return Object.freeze({ key, name, needs, milestone, ...(cue ? { cue } : {}) });
}

/**
 * The reader's meter settings, cleaned: { changeCap, custom: [{ id, label, min, max, start, show,
 * tone, describe, bands, drift }], stages: { [meterId]: [{ at, name }] ascending }, ladder: { [track]:
 * [rung] }, limits: { [track]: { meterId: { ceiling?, floor? } } }, conflictAt, demoteAfter, presets:
 * [ids in use] }. Bad entries are left out, never thrown.
 *   changeCap     the most one meter moves within one reply (story lines and scans together)
 *   customMeters  [{ name (or id), min, max, start, show, tone, describe, bands, drift, driftTo }]: the first six usable ones
 *   stages        [{ meter, at, name }]: up to eight per meter
 *   ladder        [{ name, needs, milestone, track }]: rungs in order; track '' is everyone's
 *   conflictAt    tension above this blocks a promotion
 *   demoteAfter   replies in a row below a rung's needs before it is lost (0: never)
 *   presets       ids of the presets in use (their meters come after the reader's own; their ladder
 *                 runs on a track named by the preset id, with the preset's limits)
 * `options`: { presets: the catalog (presetCatalog), stagesOn (false: no ladder) }.
 */
export function normalizeMeterSettings(raw = {}, { presets = BUILT_IN_PRESETS, stagesOn = true } = {}) {
    const source = isObject(raw) ? raw : {};
    const changeCap = clamp(intOr(source.changeCap, DEFAULT_CHANGE_CAP), 1, MAX_CHANGE_CAP);
    const conflictAt = clamp(intOr(source.conflictAt, DEFAULT_CONFLICT_AT), BUILT_IN_RANGE.min, BUILT_IN_RANGE.max);
    const demoteAfter = clamp(intOr(source.demoteAfter, DEFAULT_DEMOTE_AFTER), 0, 50);
    const custom = [];
    const taken = new Set(BUILT_IN_METERS.map(meter => meter.id));
    for (const entry of Array.isArray(source.customMeters) ? source.customMeters : []) {
        if (custom.length >= MAX_CUSTOM_METERS) break;
        const meter = customMeter(entry, taken);
        if (meter) custom.push(meter);
    }
    // The presets in use, in the order the reader turned them on.
    const catalog = (Array.isArray(presets) ? presets : []).map(preset => (preset?.builtIn !== undefined && Array.isArray(preset.meters) ? preset : normalizePreset(preset, { builtIn: BUILT_IN_PRESETS.includes(preset) }))).filter(Boolean);
    const used = presetIds(source.presets).map(id => catalog.find(preset => preset.id === id)).filter(Boolean);
    for (const preset of used) {
        for (const entry of preset.meters) {
            if (custom.length >= MAX_CUSTOM_METERS) break;
            const meter = customMeter(entry, taken, preset.id);
            if (meter) custom.push(meter);
        }
    }
    const ids = new Map([...BUILT_IN_METERS, ...custom].flatMap(meter => [[meter.id, meter.id], [slug(meter.label), meter.id]]));
    const stages = {};
    for (const entry of Array.isArray(source.stages) ? source.stages : []) {
        if (!isObject(entry)) continue;
        const meter = ids.get(slug(entry.meter));
        const name = clean(entry.name, STAGE_NAME_MAX);
        const at = intOr(entry.at, null);
        if (!meter || !name || at === null) continue;
        const list = stages[meter] ??= [];
        if (list.length >= MAX_STAGES_PER_METER || list.some(stage => stage.at === at)) continue;
        list.push(Object.freeze({ at, name }));
    }
    for (const list of Object.values(stages)) list.sort((a, b) => a.at - b.at);
    const ladder = {};
    const limits = {};
    if (stagesOn) {
        const rows = [
            ...(Array.isArray(source.ladder) ? source.ladder : []).filter(isObject).map(row => ({ ...row, track: clean(row.track, TRACK_MAX) }))
                .filter(row => !FORBIDDEN_KEYS.has(row.track)),
            ...used.flatMap(preset => preset.ladder.map(row => ({ ...row, track: preset.id }))),
        ];
        for (const row of rows) {
            const step = rung(row);
            if (!step) continue;
            if (!Object.hasOwn(ladder, row.track) && Object.keys(ladder).length >= MAX_TRACKS) continue;
            const list = ladder[row.track] ??= [];
            if (list.length >= MAX_RUNGS || list.some(other => other.key === step.key)) continue;
            // A need names a meter by id or label.
            list.push(Object.freeze({ ...step, needs: Object.freeze(step.needs.map(need => Object.freeze({ ...need, meter: ids.get(need.meter) ?? need.meter }))) }));
        }
    }
    for (const preset of used) if (Object.keys(preset.limits).length) limits[preset.id] = preset.limits;
    return { changeCap, custom, stages, ladder, limits, conflictAt, demoteAfter, presets: used.map(preset => preset.id) };
}

/**
 * Every meter in use, built-ins first: [{ id, label, min, max, start, show, builtIn, tone, ... }].
 * `baseline` is Delta's base relationship values ({ trust, affection, desire, tension }).
 */
export function meterDefs(settings, baseline = {}) {
    const normalized = settings && Array.isArray(settings.custom) ? settings : normalizeMeterSettings(settings);
    const base = isObject(baseline) ? baseline : {};
    return [
        ...BUILT_IN_METERS.map(meter => Object.freeze({
            ...meter, ...BUILT_IN_RANGE, start: clamp(intOr(base[meter.id], 0), BUILT_IN_RANGE.min, BUILT_IN_RANGE.max), show: true, builtIn: true,
        })),
        ...normalized.custom,
    ];
}

/** True when `value` has reached threshold `at`: at or above it, or at or below it for a negative one. */
export function thresholdReached(value, at) {
    return at < 0 ? value <= at : value >= at;
}

/** The stage `value` stands at among ascending `stages` (the farthest threshold reached), or null. */
export function stageAt(stages, value) {
    const list = Array.isArray(stages) ? stages : [];
    const below = list.find(stage => stage.at < 0 && value <= stage.at);
    if (below) return below;
    return list.filter(stage => stage.at >= 0 && value >= stage.at).at(-1) ?? null;
}

/**
 * One label value from a change line: `+5` / `-3` (move by), `=40` or a bare `40` (set to).
 * Anything after the number is ignored ("+5 (she smiled)"). → { mode: 'add' | 'set', value } or null.
 */
export function parseMeterValue(raw) {
    const text = String(raw ?? '').trim().replace(/[−–—]/g, '-');
    // The number must end there (or before a space, a bracket or punctuation): `1e9`, `1.5` and
    // `99999` are not meter values.
    const match = /^(=\s*)?([+-])?\s*(\d{1,4})(?=$|\s|[(;,!?)]|\.(?!\d))/.exec(text);
    if (!match) return null;
    const amount = Number(match[3]);
    const signed = match[2] === '-' ? -amount : amount;
    if (match[1] || !match[2]) return { mode: 'set', value: signed };
    return { mode: 'add', value: signed };
}

/**
 * Hidden notes from a dossier record, cleaned: [{ id, meter, at, text, title? }] (at most eight; an
 * entry without a meter id, a whole-number `at` or text is left out). The id comes from the rule and
 * the text only, so giving a note a title never locks it again.
 */
export function normalizeSecrets(list) {
    const out = [];
    for (const entry of Array.isArray(list) ? list : []) {
        if (out.length >= MAX_SECRETS) break;
        if (!isObject(entry)) continue;
        const meter = slug(entry.meter);
        const at = intOr(entry.at, null);
        const text = clean(entry.text, SECRET_TEXT_MAX);
        if (!meter || at === null || !text) continue;
        const id = typeof entry.id === 'string' && /^[a-z][a-z0-9]*_[0-9a-z]{8}$/.test(entry.id) ? entry.id : secretId(meter, at, text);
        if (out.some(other => other.id === id)) continue;
        const title = clean(entry.title, SECRET_TITLE_MAX);
        out.push({ id, meter, at, text, ...(title ? { title } : {}) });
    }
    return out;
}

/** A stable id for a note from its rule and text (FNV-1a): `sec_` and 8 base-36 characters. */
export function secretId(meter, at, text) {
    let hash = 0x811c9dc5;
    for (const char of `${meter}|${at}|${text}`) {
        hash ^= char.codePointAt(0);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `sec_${hash.toString(36).padStart(8, '0').slice(-8)}`;
}

/** The notes as editor lines: `trust 40: [Her past] She is the duke's daughter.` */
export function secretsToLines(list) {
    return normalizeSecrets(list).map(secret => `${secret.meter} ${secret.at}: ${secret.title ? `[${secret.title}] ` : ''}${secret.text}`).join('\n');
}

/**
 * Editor lines back to notes: one per line, `meter at: text` (`trust 40: …`, `trust >= 40: …`,
 * `tension -30: …`), with an optional title in brackets before the text (`trust 60: [Her past] …`;
 * the title is what screens show while the note is locked). A note whose rule and text are
 * unchanged keeps its id. Lines that do not read are returned in `problems`.
 */
export function secretsFromLines(text, previous = []) {
    const kept = new Map(normalizeSecrets(previous).map(secret => [`${secret.meter}|${secret.at}|${secret.text}`, secret.id]));
    const secrets = [];
    const problems = [];
    for (const line of String(text ?? '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const match = /^([\p{L}][\p{L}\p{N} _-]*?)\s*(?:>=|≥|<=|≤|at)?\s*([+\-−]?\d{1,4})\s*:\s*(.+)$/u.exec(trimmed);
        if (!match) { problems.push(trimmed); continue; }
        const meter = slug(match[1]);
        const at = Number(match[2].replace('−', '-'));
        const titled = /^\[([^\]]{1,80})\]\s*(.+)$/u.exec(match[3].trim());
        const title = titled ? clean(titled[1], SECRET_TITLE_MAX) : '';
        const body = clean(titled ? titled[2] : match[3], SECRET_TEXT_MAX);
        if (!meter || !body) { problems.push(trimmed); continue; }
        const id = kept.get(`${meter}|${at}|${body}`) ?? secretId(meter, at, body);
        if (secrets.some(secret => secret.id === id)) continue;
        if (secrets.length >= MAX_SECRETS) { problems.push(trimmed); continue; }
        secrets.push({ id, meter, at, text: body, ...(title ? { title } : {}) });
    }
    return { secrets, problems };
}

/**
 * Per-NPC limits as editor lines: `trust: floor -20, ceiling 60` (one meter per line), and back.
 * Lines read `meter: ceiling N` / `max N` / `floor N` / `min N` (either or both); others are problems.
 */
export function limitsToLines(limits) {
    return Object.entries(normalizeLimits(limits))
        .map(([meter, limit]) => `${meter}: ${[limit.floor !== undefined ? `floor ${limit.floor}` : '', limit.ceiling !== undefined ? `ceiling ${limit.ceiling}` : ''].filter(Boolean).join(', ')}`)
        .join('\n');
}
export function limitsFromLines(text) {
    const limits = {};
    const problems = [];
    for (const line of String(text ?? '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const match = /^([\p{L}][\p{L}\p{N} _-]*?)\s*:\s*(.+)$/u.exec(trimmed);
        const meter = match ? slug(match[1]) : '';
        const limit = {};
        let ok = Boolean(meter);
        for (const part of match ? match[2].split(/[,;]/) : []) {
            const piece = /^\s*(ceiling|max|floor|min)\s*[:=]?\s*([+\-−]?\d{1,4})\s*$/iu.exec(part);
            if (!piece) { ok = false; break; }
            limit[/^(?:ceiling|max)$/i.test(piece[1]) ? 'ceiling' : 'floor'] = Number(piece[2].replace('−', '-'));
        }
        const normalized = ok ? normalizeLimits({ [meter]: limit })[meter] : null;
        if (!normalized || Object.keys(limits).length >= MAX_METERS_PER_NPC) { problems.push(trimmed); continue; }
        limits[meter] = normalized;
    }
    return { limits, problems };
}

// ---- the slice ----

/** The slice of a chat with no NPC meters yet. */
export function initialNpcSlice() {
    return { npcs: {}, problems: [] };
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
        if (record.disposition !== undefined && (typeof record.disposition !== 'string' || record.disposition.length > DISPOSITION_MAX)) errors.push(`${where} has an unusable disposition.`);
        if (record.turn !== undefined) {
            const turn = record.turn;
            if (!isObject(turn) || replyKey(turn.reply, turn.reply) === null || !isObject(turn.from)
                || (turn.at !== undefined && (!isInt(turn.at) || turn.at < 0 || !isReplyId(turn.reply)))
                || Object.values(turn.from).some(value => !isInt(value))) errors.push(`${where} has an unusable reply window.`);
        }
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
        for (const field of Object.keys(record)) {
            if (!RECORD_FIELDS.includes(field)) errors.push(`${where} has an unknown field "${field}".`);
        }
    }
    if (!Array.isArray(slice.problems)) errors.push('The NPC meters have no problems list.');
    else {
        if (slice.problems.length > MAX_PROBLEMS) errors.push(`The NPC meters keep at most ${MAX_PROBLEMS} problems.`);
        if (slice.problems.some(item => !isObject(item) || !isInt(item.rev) || typeof item.text !== 'string')) errors.push('An NPC meters problem is not { rev, text }.');
    }
    for (const field of Object.keys(slice)) if (!['npcs', 'problems'].includes(field)) errors.push(`The NPC meters have an unknown field "${field}".`);
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

const signed = value => (value > 0 ? `+${value}` : String(value));

// Moves meters on `record` (in place). `changes`: [{ meter (id), mode: 'add' | 'set', value }].
// `limit` holds each meter within cap of the value the reply `reply` (replyKey: its record ID, else its
// index) started from (story lines and scans) and within the NPC's own `limits` (growth stops at a
// ceiling, a fall at a floor; a value already past one moves only back toward it); without it (the
// reader's own set) only the range applies. `at`: the reply's index now, kept beside a record ID for
// "moved lately" in the tail.
function moveMeters(record, changes, { defs, cap, reply, at = null, limit, limits = {} }) {
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
        moved.push({ meter: def.id, label: def.label, before, after, asked, held: after !== asked, ...(stop ? { stop } : {}) });
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

const conflictOn = (record, defs, conflictAt) => meterValue(record, defs.find(def => def.id === 'tension') ?? { id: 'tension', start: 0 }) > conflictAt;

// Stages, the ladder and notes after a change: moves each stage to where its meter now stands,
// promotes on the ladder while the next rung is met (never in a conflict), counts and demotes on
// Delta's tick (`tick`), and unlocks the notes whose rule is met.
// → { stages: [{ meter, from, to, text }], ranks: [{ from, to, text }], held: text | '', unlocked: [{ id, text }] }.
function settle(record, { defs, stages, rules, name, rungs = [], conflictAt = DEFAULT_CONFLICT_AT, demoteAfter = 0, tick = false }) {
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
    for (const rule of Array.isArray(rules) ? rules : []) {
        if (!rule || typeof rule.id !== 'string' || record.unlocked.includes(rule.id) || record.unlocked.length >= MAX_UNLOCKED) continue;
        const def = byId.get(rule.meter);
        if (!def || !isInt(rule.at)) continue;
        const value = meterValue(record, def);
        if (!thresholdReached(value, rule.at)) continue;
        record.unlocked.push(rule.id);
        opened.push({ id: rule.id, text: `${name}: a hidden note opened (${def.label.toLocaleLowerCase()} ${value})` });
    }
    return { stages: moves, ranks, held, unlocked: opened };
}

const sentence = parts => parts.filter(Boolean).map(part => (/[.!?]$/.test(part) ? part : `${part}.`)).join(' ');

function changeText(name, moved) {
    if (!moved.length) return '';
    const why = item => (item.stop ? `, at the ${item.stop}` : '');
    return `${name}: ${moved.map(item => `${item.label.toLocaleLowerCase()} ${item.before} → ${item.after}${item.held ? ` (held at ${item.after}${why(item)}; ${signed(item.asked - item.before)} asked)` : ''}`).join(', ')}`;
}

// The receipt: stage, ladder and note lines are what the next reply is told (narrate when a stage or
// a rung moved); the numbers are for the reply's card.
function result({ name, key, moved, settled, problems, created, disposition, milestone = null }) {
    const notes = [...settled.stages.map(move => move.text), ...settled.ranks.map(move => move.text), ...settled.unlocked.map(note => note.text)];
    const numbers = changeText(name, moved);
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

/**
 * The `npc` part (MODULES §A part shape): domain, commands, queries, the `npc` and `milestone`
 * change-line kinds and the prompt context. Hooks (each optional, each may throw — a throw reads as
 * "nothing known"):
 *   resolve(name)     → Delta's dossier for that name or alias: { name, aliases, relationship } | null
 *   baseline()        → Delta's base relationship values (new NPCs start there)
 *   secretRules(name) → that dossier's notes as [{ id, meter, at, title? }] (never their text)
 *   secretTexts(name, ids) → [{ id, text }] for those unlocked notes (the tail and screens only)
 *   setup(name, labels) → that dossier's meter setup { track, limits } (the editor's)
 *   presets()         → the preset catalog (presetCatalog: built-ins and packs')
 *   feature(id)       → true / false for a feature the host knows; anything else: its default
 *   present()         → names of the NPCs present now
 *   settings()        → the module's stored settings (queries and the prompt; commands use ctx.settings)
 *   ownCommand(type, payload) → true while Delta's own adapter is sending exactly this command (its
 *                       scanner's npc.adjust, its tick); a button, screen or pack cannot make it true
 *   headReply()       → the index of the latest reply (the reader's own values start its window)
 */
export function createNpcPart(hooks = {}) {
    const call = (fn, fallback, ...args) => {
        if (typeof fn !== 'function') return fallback;
        try { return fn(...args) ?? fallback; } catch { return fallback; }
    };
    const resolve = name => {
        const found = call(hooks.resolve, null, name);
        return isObject(found) && typeof found.name === 'string' && found.name.trim() ? found : null;
    };
    const baseline = () => {
        const value = call(hooks.baseline, {});
        return isObject(value) ? value : {};
    };
    const rulesFor = (name, aliases = []) => {
        const value = call(hooks.secretRules, [], name, aliases);
        return Array.isArray(value) ? value : [];
    };
    const presentNames = () => {
        const value = call(hooks.present, []);
        return Array.isArray(value) ? value.filter(name => typeof name === 'string' && name.trim()) : [];
    };
    // A feature's switch: the command's own ctx.feature, else the host's (hook), else its default.
    const featureOn = (id, ctx = null) => {
        if (typeof ctx?.feature === 'function') {
            try {
                const answer = ctx.feature(id);
                if (typeof answer === 'boolean') return answer;
            } catch { /* the host's default below */ }
        }
        const answer = call(hooks.feature, undefined, id);
        return typeof answer === 'boolean' ? answer : FEATURE_DEFAULTS[id] === true;
    };
    const catalog = ctx => {
        if (!featureOn(FEATURE_PRESETS, ctx)) return [];
        const value = call(hooks.presets, null);
        return Array.isArray(value) ? value : BUILT_IN_PRESETS;
    };
    const normalized = (raw, ctx = null) => normalizeMeterSettings(raw, { presets: catalog(ctx), stagesOn: featureOn(FEATURE_STAGES, ctx) });
    const storedSettings = () => normalized(call(hooks.settings, {}));
    const defsFrom = settings => meterDefs(settings, baseline());
    // A reader's action at the top (a button, a screen, a pack): cause ui and no calling module.
    const readerAction = ctx => ctx.cause === 'ui' && !ctx.caller;
    const ownOrModule = (ctx, type, payload) => !readerAction(ctx) || call(hooks.ownCommand, false, type, payload) === true;
    const headReply = () => {
        const value = call(hooks.headReply, null);
        return isInt(value) && value >= 0 ? value : null;
    };
    // The window key for a command about the reply at `index` (Delta's scan of it, the reader's values):
    // the record ID Story Block gives the reply the command is stored on (`ctx.reply`) when that is the
    // reply meant, else the index (replyKey).
    const commandReply = (ctx, index) => replyKey(isInt(index) && ctx?.reply?.index === index ? ctx.reply.sid : null, index);
    // The NPC's meter setup from the dossier (track, limits) and what it means with these settings.
    const setupFor = (name, labels = []) => {
        const value = call(hooks.setup, null, name, labels);
        return { track: clean(value?.track, TRACK_MAX), limits: normalizeLimits(value?.limits) };
    };
    const rungsFor = (settings, setup) => (setup.track && Object.hasOwn(settings.ladder, setup.track) ? settings.ladder[setup.track] : settings.ladder[''] ?? []);
    const limitsFor = (settings, setup) => {
        const merged = { ...(setup.track && Object.hasOwn(settings.limits, setup.track) ? settings.limits[setup.track] : {}) };
        for (const [meter, limit] of Object.entries(setup.limits)) merged[meter] = limit;
        return merged;
    };

    // Who a change is about: the entry key, the name it shows, the dossier's labels and numbers.
    function identify(npcs, label) {
        const asked = clean(label, NAME_MAX);
        if (!asked) return null;
        const dossier = resolve(asked);
        const name = clean(dossier?.name ?? asked, NAME_MAX);
        const labels = [name, asked, ...(Array.isArray(dossier?.aliases) ? dossier.aliases : [])].map(item => clean(item, NAME_MAX)).filter(Boolean);
        const key = findNpcKey(npcs, labels) ?? npcKey(name);
        if (!key) return null;
        return { key, name, labels, seed: isObject(dossier?.relationship) ? dossier.relationship : null };
    }

    function ensure(ctx, npcs, who, defs, seed) {
        if (Object.hasOwn(npcs, who.key)) return false;
        if (Object.keys(npcs).length >= MAX_NPCS) ctx.fail('REFUSED', `NPC State Delta keeps meters for up to ${MAX_NPCS} people; ${who.name} was not added.`);
        const meters = {};
        for (const def of defs) {
            const given = intOr(seed?.[def.id], null);
            meters[def.id] = given === null ? def.start : clamp(given, def.min, def.max);
        }
        // `milestones` is made with the entry, so a later reply's milestone is an add under an object
        // the entry's first reply made (a middle delete never leaves it without its parent).
        npcs[who.key] = { name: who.name, meters, stages: {}, unlocked: [], milestones: {} };
        return true;
    }

    function note(slice, rev, problems) {
        if (!problems.length) return;
        if (!Array.isArray(slice.problems)) slice.problems = [];
        for (const text of problems) slice.problems.push({ rev: isInt(rev) ? rev : 0, text });
        if (slice.problems.length > MAX_PROBLEMS) slice.problems.splice(0, slice.problems.length - MAX_PROBLEMS);
    }

    // Meter changes from a record of numbers ({ trust: 3 }); unknown names become problems.
    function changesFrom(meters, defs, mode, problems) {
        const byId = new Map(defs.flatMap(def => [[def.id, def], [slug(def.label), def]]));
        const changes = [];
        for (const [name, raw] of Object.entries(isObject(meters) ? meters : {})) {
            const def = byId.get(slug(name));
            if (!def) { problems.push(`"${name}" is not a meter (meters: ${defs.map(item => item.id).join(', ')}).`); continue; }
            const value = Number(raw);
            if (!Number.isFinite(value) || Math.abs(value) > CUSTOM_RANGE.max * 2) { problems.push(`${def.label} was given ${JSON.stringify(raw)}, which is not a whole number.`); continue; }
            changes.push({ meter: def.id, mode, value: Math.round(value) });
        }
        return changes;
    }

    // Stages, ladder and notes of one record, with this NPC's own setup.
    const settleRecord = (record, labels, settings, defs, tick = false) => {
        const setup = setupFor(record.name, labels);
        return settle(record, {
            defs, stages: settings.stages, rules: rulesFor(record.name, labels), name: record.name,
            rungs: rungsFor(settings, setup), conflictAt: settings.conflictAt, demoteAfter: settings.demoteAfter, tick,
        });
    };

    // `milestone`: { add: [{ key, name }], remove: [key] } (the reader's or a story line's).
    function run(ctx, { label, changes, problems, limit, reply, at = null, seed, disposition, allowEmpty = false, milestone = null }) {
        const settings = normalized(ctx.settings(), ctx);
        const defs = defsFrom(settings);
        if (!changes.length && disposition === undefined && !allowEmpty) {
            ctx.fail('REFUSED', problems.length ? problems.join(' ') : 'It names no meter to change.');
        }
        const slice = ctx.draft(NPC_DOMAIN);
        if (!isObject(slice.npcs)) slice.npcs = {};
        if (!Array.isArray(slice.problems)) slice.problems = [];
        const who = identify(slice.npcs, label);
        if (!who) ctx.fail('INVALID', 'The change does not name anyone.');
        const created = ensure(ctx, slice.npcs, who, defs, seed ?? who.seed);
        const record = slice.npcs[who.key];
        if (!isObject(record.stages)) record.stages = {};
        if (!Array.isArray(record.unlocked)) record.unlocked = [];
        const setup = setupFor(record.name, who.labels);
        const moved = moveMeters(record, changes, { defs, cap: settings.changeCap, reply, at, limit, limits: limitsFor(settings, setup) });
        if (disposition !== undefined) {
            if (disposition) record.disposition = disposition;
            else delete record.disposition;
        }
        let marked = null;
        if (milestone) {
            const had = isObject(record.milestones) ? record.milestones : {};
            const next = { ...had };
            for (const key of milestone.remove ?? []) delete next[key];
            const added = (milestone.add ?? []).filter(item => !Object.hasOwn(had, item.key));
            for (const item of added) next[item.key] = item.name;
            if (Object.keys(next).length > MAX_MILESTONES) ctx.fail('REFUSED', `${record.name} can keep up to ${MAX_MILESTONES} milestones.`);
            if (JSON.stringify(next) === JSON.stringify(had)) {
                ctx.fail('REFUSED', milestone.add?.length === 1 && !milestone.remove?.length
                    ? `${record.name} already has the milestone “${had[milestone.add[0].key] ?? milestone.add[0].name}”.` : 'Those milestones are already as given.');
            }
            // Each milestone is its own key: added and taken away by key, never as a list.
            if (!isObject(record.milestones)) record.milestones = {};
            for (const key of milestone.remove ?? []) delete record.milestones[key];
            for (const item of added) record.milestones[item.key] = item.name;
            marked = added.length === 1 ? added[0] : null;
        }
        const settled = settleRecord(record, who.labels, settings, defs);
        note(slice, ctx.rev, problems);
        return result({ name: record.name, key: who.key, moved, settled, problems, created, disposition, milestone: marked });
    }

    // ---- the change lines ----

    function captureMilestone(ctx, line = {}) {
        if (!featureOn(FEATURE_STAGES, ctx)) ctx.fail('FEATURE_OFF', 'Stage ladders and milestones are turned off.');
        if (line.op !== '+') ctx.fail('REFUSED', 'A milestone is only ever added (+ milestone Name — what happened); the reader takes one away in the dossier editor.');
        const name = clean(line.text, MILESTONE_MAX);
        const key = wordKey(name);
        if (!key) ctx.fail('INVALID', 'The line names no milestone: + milestone Name — what happened.');
        return run(ctx, { label: line.name, changes: [], problems: [], limit: false, reply: null, allowEmpty: true, milestone: { add: [{ key, name }] } });
    }

    function captureLine(ctx, line = {}) {
        if (line.kind === MILESTONE_KIND) return captureMilestone(ctx, line);
        const settings = normalized(ctx.settings(), ctx);
        const defs = defsFrom(settings);
        const byLabel = new Map(defs.flatMap(def => [[def.id, def], [slug(def.label), def]]));
        const problems = [];
        const changes = [];
        let disposition;
        for (const [label, raw] of Object.entries(isObject(line.labels) ? line.labels : {})) {
            const key = slug(label);
            if (REASON_LABELS.has(key)) continue;
            if (key === 'stage' || key === 'stages') { problems.push(`Stages are set by code from the meters; "stage: ${clean(raw, 60)}" was not used.`); continue; }
            if (key === 'disposition') { disposition = clean(raw, DISPOSITION_MAX); continue; }
            const def = byLabel.get(key);
            if (!def) { problems.push(`"${clean(label, 40)}" is not a meter (meters: ${defs.map(item => item.id).join(', ')}).`); continue; }
            const parsed = parseMeterValue(raw);
            if (!parsed) { problems.push(`${def.label}: "${clean(raw, 40)}" is not +N, -N or =N.`); continue; }
            changes.push({ meter: def.id, ...parsed });
        }
        // B-a1-15: the window is the reply's by its record ID, so after a middle delete a new reply at an
        // index an older one had is its own reply, with its own cap.
        const at = isInt(ctx.carrier?.index) ? ctx.carrier.index : null;
        const reply = replyKey(ctx.carrier?.sid, at);
        return run(ctx, { label: line.name, changes, problems, limit: true, reply, at, disposition, allowEmpty: line.op === '+' });
    }

    // ---- commands (cause ui from Delta itself; capture is the story's) ----

    const milestoneList = value => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value])
        .map(item => clean(isObject(item) ? item.name ?? item.key : item, MILESTONE_MAX)).filter(Boolean)
        .map(name => ({ key: wordKey(name), name })).filter(item => item.key);

    const commands = {
        /**
         * npc.adjust { name, meters: { meter: ±n }, start?: { meter: n }, reply?: n }: moves meters
         * by the given amounts, with the same range, per-reply and per-NPC clamps as a story line.
         * Delta's own scanner sends its relationship changes this way while hosted (`start`: the
         * values the dossier had before them, for an NPC the slice has no entry for yet). Only
         * Delta's scanner and another module's command (ctx.call) may send it: a button, screen or
         * pack at the top (cause ui, no calling module) is refused, as the host's own steps are.
         */
        'npc.adjust'(ctx, payload = {}) {
            if (!ownOrModule(ctx, 'npc.adjust', payload)) {
                ctx.fail('REFUSED', 'Meters move with the story and with NPC State Delta\'s scans; the dossier editor sets them by hand.');
            }
            const problems = [];
            const defs = defsFrom(normalized(ctx.settings(), ctx));
            const changes = changesFrom(payload?.meters, defs, 'add', problems).filter(change => change.value !== 0);
            const at = isInt(payload?.reply) && payload.reply >= 0 ? payload.reply : null;
            return run(ctx, { label: payload?.name, changes, problems, limit: true, reply: commandReply(ctx, at), at, seed: isObject(payload?.start) ? payload.start : null });
        },
        /**
         * npc.set { name, meters: { meter: n }, reply? }: the reader's own values (range only). From
         * a button or screen the reply is the latest one, whatever the payload says; `reply` is
         * read only from another module's command.
         */
        'npc.set'(ctx, payload = {}) {
            const problems = [];
            const defs = defsFrom(normalized(ctx.settings(), ctx));
            const changes = changesFrom(payload?.meters, defs, 'set', problems);
            const asked = isInt(payload?.reply) && payload.reply >= 0 ? payload.reply : null;
            const at = readerAction(ctx) ? headReply() : asked;
            return run(ctx, { label: payload?.name, changes, problems, limit: false, reply: commandReply(ctx, at), at });
        },
        /** npc.refresh { name }: stages, the ladder and notes again (after the reader changed them). */
        'npc.refresh'(ctx, payload = {}) {
            const slice = ctx.read(NPC_DOMAIN);
            const who = identify(slice?.npcs ?? {}, payload?.name);
            if (!who || !Object.hasOwn(slice?.npcs ?? {}, who.key)) ctx.fail('NOT_FOUND', 'That NPC has no meters yet.');
            const out = run(ctx, { label: payload.name, changes: [], problems: [], limit: false, reply: null, allowEmpty: true });
            if (!out.data.stages.length && !out.data.unlocked.length && !out.data.ranks?.length) ctx.fail('REFUSED', 'Nothing to update.');
            return out;
        },
        /**
         * npc.milestone { name, add?: [words], remove?: [words or keys] }: the reader's own milestones
         * for one NPC (the dossier editor). Each is kept under its words' key, so the same milestone
         * written twice is one; a new one may promote on the ladder at once.
         */
        'npc.milestone'(ctx, payload = {}) {
            if (!featureOn(FEATURE_STAGES, ctx)) ctx.fail('FEATURE_OFF', 'Stage ladders and milestones are turned off.');
            const add = milestoneList(payload?.add);
            const remove = milestoneList(payload?.remove).map(item => item.key);
            if (!add.length && !remove.length) ctx.fail('INVALID', 'It names no milestone to add or take away.');
            return run(ctx, { label: payload?.name, changes: [], problems: [], limit: false, reply: null, allowEmpty: true, milestone: { add, remove } });
        },
        /**
         * npc.tick {}: Delta's own step after each reply (and another module's, through ctx.call):
         * meters with a drift move toward their resting value for each story day passed (Story
         * Director's clock; feature npc-state-delta.drift), and every NPC below its rung's needs counts
         * one more reply toward losing it (feature npc-state-delta.stages). Refused when nothing moves.
         */
        'npc.tick'(ctx, payload = {}) {
            if (!ownOrModule(ctx, 'npc.tick', payload)) ctx.fail('REFUSED', 'The per-reply step is NPC State Delta\'s own.');
            const settings = normalized(ctx.settings(), ctx);
            const defs = defsFrom(settings);
            const drifting = featureOn(FEATURE_DRIFT, ctx) ? defs.filter(def => def.drift) : [];
            let minutes = null;
            if (drifting.length && typeof ctx.time === 'function') {
                try { minutes = ctx.time(); } catch { minutes = null; }
            }
            const day = isInt(minutes) ? Math.floor(minutes / DAY_MINUTES) : null;
            const before = ctx.read(NPC_DOMAIN);
            if (!isObject(before?.npcs) || !Object.keys(before.npcs).length) ctx.fail('REFUSED', 'Nothing to update.');
            const slice = ctx.draft(NPC_DOMAIN);
            const texts = [];
            const data = [];
            let narrate = false;
            let changed = false;
            for (const key of Object.keys(slice.npcs).sort()) {
                const record = slice.npcs[key];
                if (!isObject(record) || !isObject(record.meters)) continue;
                if (!isObject(record.stages)) record.stages = {};
                if (!Array.isArray(record.unlocked)) record.unlocked = [];
                const was = JSON.stringify(record);
                const drift = [];
                if (day !== null) {
                    const days = isInt(record.day) ? day - record.day : 0;
                    if (record.day !== day) record.day = day;
                    const setup = setupFor(record.name);
                    const limits = limitsFor(settings, setup);
                    for (const def of days > 0 ? drifting : []) {
                        const value = meterValue(record, def);
                        const { perDay, to } = def.drift;
                        const step = Math.min(Math.abs(to - value), perDay * days);
                        let next = value + Math.sign(to - value) * step;
                        const bound = limits[def.id];
                        if (bound && isInt(bound.ceiling) && next > value) next = Math.max(value, Math.min(next, bound.ceiling));
                        if (bound && isInt(bound.floor) && next < value) next = Math.min(value, Math.max(next, bound.floor));
                        next = clamp(next, def.min, def.max);
                        if (next === value) continue;
                        record.meters[def.id] = next;
                        drift.push({ meter: def.id, before: value, after: next });
                    }
                }
                const settled = settleRecord(record, [record.name], settings, defs, featureOn(FEATURE_STAGES, ctx));
                if (JSON.stringify(record) === was) continue;
                changed = true;
                if (drift.length) texts.push(`${record.name}: ${drift.map(item => `${defs.find(def => def.id === item.meter)?.label.toLocaleLowerCase() ?? item.meter} ${item.before} → ${item.after}`).join(', ')} (story days passed)`);
                texts.push(...settled.stages.map(move => move.text), ...settled.ranks.map(move => move.text), ...settled.unlocked.map(item => item.text));
                if (settled.stages.length || settled.ranks.length) narrate = true;
                data.push({ key, drift, stages: settled.stages.map(({ meter, from, to }) => ({ meter, from, to })), ranks: settled.ranks.map(({ from, to }) => ({ from, to })), unlocked: settled.unlocked.map(item => item.id), ...(isInt(record.low) ? { low: record.low } : {}) });
            }
            if (!changed) ctx.fail('REFUSED', 'Nothing to update.');
            return { summary: sentence(texts.length ? texts : ['NPC meters: the reply was counted']), narrate, data: { day, npcs: data } };
        },
    };

    // ---- queries ----

    const sliceOf = state => (isObject(state?.domains?.[NPC_DOMAIN]?.npcs) ? state.domains[NPC_DOMAIN] : initialNpcSlice());
    const entryView = (key, record, defs, rungs) => ({
        key,
        name: record.name,
        meters: Object.fromEntries(defs.map(def => [def.id, meterValue(record, def)])),
        stages: { ...(record.stages ?? {}) },
        unlocked: [...(record.unlocked ?? [])],
        ...(record.disposition ? { disposition: record.disposition } : {}),
        // The window's reply by its index (as before record IDs): `at` beside a record ID.
        ...(isInt(record.turn?.at) ? { reply: record.turn.at } : isInt(record.turn?.reply) ? { reply: record.turn.reply } : {}),
        ...(isObject(record.milestones) && Object.keys(record.milestones).length ? { milestones: { ...record.milestones } } : {}),
        ...(rungs.find(step => step.key === record.rank) ? { rank: rungs.find(step => step.key === record.rank).name } : {}),
    });

    /**
     * What the NPC's ladder looks like from here: { rank, next, risk, text } (null without a ladder).
     *   rank  the rung reached (its name) or null
     *   next  { name, needs: [{ meter, label, value, at, below, met }], milestone: { name, met } | null,
     *         held } for the rung after it, or null at the top
     *   risk  { name, needs, replies, of } while the reached rung's needs fail (it falls back after
     *         `of` replies in a row; `replies` so far), or null
     *   text  one line: "Next: Confidant — affection 40/55, milestone “saved her brother”"
     */
    function ladderView(record, settings, defs) {
        const setup = setupFor(record.name);
        const rungs = rungsFor(settings, setup);
        if (!rungs.length) return null;
        const byId = new Map(defs.map(def => [def.id, def]));
        const at = rungs.findIndex(step => step.key === record.rank);
        const needsOf = step => step.needs.map(need => {
            const def = byId.get(need.meter);
            const value = def ? meterValue(record, def) : null;
            return { meter: need.meter, label: def?.label ?? need.meter, value, at: need.at, below: need.below, met: def ? needMet(need, value) : false };
        });
        const missing = needs => needs.filter(need => !need.met).map(need => (need.value === null ? `${need.label} (no such meter)` : `${need.label.toLocaleLowerCase()} ${need.value}/${need.at}`));
        const upcoming = rungs[at + 1] ?? null;
        const next = upcoming ? {
            name: upcoming.name,
            needs: needsOf(upcoming),
            milestone: upcoming.milestone ? { name: upcoming.milestone.name, met: own(record.milestones, upcoming.milestone.key) } : null,
            held: rungMet(record, upcoming, defs) && conflictOn(record, defs, settings.conflictAt),
        } : null;
        const current = at >= 0 ? rungs[at] : null;
        const risk = current && !rungMet(record, current, defs) && settings.demoteAfter > 0
            ? { name: current.name, needs: needsOf(current), replies: isInt(record.low) ? record.low : 0, of: settings.demoteAfter } : null;
        const parts = [];
        if (next) {
            const lacking = [...missing(next.needs), ...(next.milestone && !next.milestone.met ? [`milestone “${next.milestone.name}”`] : [])];
            if (next.held) parts.push(`Next: ${next.name} — waits while tension is above ${settings.conflictAt}`);
            else if (lacking.length) parts.push(`Next: ${next.name} — ${lacking.join(', ')}`);
        }
        if (risk) parts.push(`${risk.name} slipping — ${missing(risk.needs).join(', ') || 'milestone'} (${risk.replies}/${risk.of} replies)`);
        return { rank: current?.name ?? null, next, risk, text: parts.join('; ') };
    }

    // The notes of a dossier for screens: locked ones by title and rule only, never their text.
    function notesView(record, defs) {
        const byId = new Map(defs.map(def => [def.id, def]));
        const unlocked = new Set(Array.isArray(record.unlocked) ? record.unlocked : []);
        const locked = [];
        const opened = [];
        for (const rule of rulesFor(record.name, [record.name])) {
            if (!rule || typeof rule.id !== 'string' || !isInt(rule.at)) continue;
            const title = clean(rule.title, SECRET_TITLE_MAX) || 'A hidden note';
            if (unlocked.has(rule.id)) { opened.push({ id: rule.id, title }); continue; }
            const label = byId.get(rule.meter)?.label ?? rule.meter;
            locked.push({ id: rule.id, title, meter: rule.meter, at: rule.at, text: `🔒 ${title} — unlocks at ${label} ${rule.at}` });
        }
        return { locked, opened };
    }

    function bars(record, defs, settings, { headReply: head = undefined, reply = null } = {}) {
        const setup = setupFor(record.name);
        const limits = limitsFor(settings, setup);
        const rungs = rungsFor(settings, setup);
        // A window that belongs to a reply other than the head's is not "since the last reply". The head
        // is asked by index; a window keyed by record ID is the head's when the query's reply
        // (`tools.reply`, the head) is at that index with that ID.
        const headKey = isInt(head) && reply?.index === head && isReplyId(reply?.sid) ? reply.sid : head;
        const fresh = head === undefined || (isInt(head) && (sameReply(record.turn, head) || sameReply(record.turn, headKey)));
        return defs.filter(def => def.show).map(def => {
            const value = meterValue(record, def);
            const stage = record.stages?.[def.id] ?? '';
            const band = bandWord(def.bands, value);
            const ticks = [
                ...(settings.stages[def.id] ?? []).map(item => ({ at: item.at, label: item.name })),
                ...rungs.flatMap(step => step.needs.filter(need => need.meter === def.id).map(need => ({ at: need.at, label: step.name }))),
            ].filter(item => item.at >= def.min && item.at <= def.max).sort((a, b) => a.at - b.at).slice(0, MAX_STAGES_PER_METER);
            const limit = limits[def.id];
            const from = record.turn?.from?.[def.id];
            const delta = fresh && isInt(from) ? value - from : 0;
            const bar = {
                id: def.id, label: def.label, value, min: def.min, max: def.max, stage, tone: def.tone,
                text: stage ? `${value} · ${stage}` : band ? `${value} · ${band}` : String(value),
                ...(isInt(limit?.ceiling) ? { ceiling: limit.ceiling } : {}),
                ...(isInt(limit?.floor) ? { floor: limit.floor } : {}),
                ...(ticks.length ? { ticks } : {}),
            };
            return delta ? { ...bar, delta } : bar;
        });
    }
    const presentKeys = npcs => new Set(presentNames().map(name => findNpcKey(npcs, [name, ...(resolve(name)?.aliases ?? [])])).filter(Boolean));

    const queries = {
        /**
         * npc.meters({ name }) → { key, name, meters, stages, unlocked, disposition?, reply?,
         * milestones?, rank? } | null; without a name, every entry (in key order). Meters are filled
         * in for every meter in use.
         */
        'npc.meters'(state, args = {}) {
            const { npcs } = sliceOf(state);
            const settings = storedSettings();
            const defs = defsFrom(settings);
            const view = key => entryView(key, npcs[key], defs, rungsFor(settings, setupFor(npcs[key].name)));
            if (args && typeof args.name === 'string') {
                const who = identify(npcs, args.name);
                return who && Object.hasOwn(npcs, who.key) ? view(who.key) : null;
            }
            return Object.keys(npcs).sort().map(view);
        },
        /**
         * npc.cast() → [{ key, name, present, bars, still, rank?, next?, locked, opened }], present
         * first. `bars`: [{ id, label, value, min, max, stage, text, tone, ceiling?, floor?, ticks?,
         * delta? }] (ss.meter's props; `delta` is the change of the entry's latest reply window),
         * `still`: the same without `delta`. `locked`: the hidden notes still locked, as teasers
         * ({ title, meter, at, text: "🔒 Her past — unlocks at Trust 60" }); `opened`: [{ id, title }].
         */
        'npc.cast'(state, args = {}, tools = null) {
            const { npcs } = sliceOf(state);
            const settings = storedSettings();
            const defs = defsFrom(settings);
            const here = presentKeys(npcs);
            const head = isObject(args) && Object.hasOwn(args, 'headReply') ? args.headReply : undefined;
            return Object.keys(npcs)
                .map(key => {
                    const record = npcs[key];
                    const list = bars(record, defs, settings, { headReply: head, reply: tools?.reply ?? null });
                    const ladder = ladderView(record, settings, defs);
                    const notes = notesView(record, defs);
                    return {
                        key, name: record.name, present: here.has(key), bars: list, still: list.map(({ delta, ...bar }) => bar),
                        ...(ladder?.rank ? { rank: ladder.rank } : {}),
                        ...(ladder?.text ? { next: ladder.text } : {}),
                        locked: notes.locked.map(({ title, meter, at, text }) => ({ title, meter, at, text })),
                        opened: notes.opened.map(({ id, title }) => ({ id, title })),
                    };
                })
                .sort((a, b) => Number(b.present) - Number(a.present) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        },
        /** npc.next({ name }) → the NPC's ladder from here ({ rank, next, risk, text }), or null. */
        'npc.next'(state, args = {}) {
            const { npcs } = sliceOf(state);
            const who = identify(npcs, args?.name);
            if (!who || !Object.hasOwn(npcs, who.key)) return null;
            const settings = storedSettings();
            return ladderView(npcs[who.key], settings, defsFrom(settings));
        },
    };

    // ---- the prompt (SPEC §5) ----

    /**
     * One line: how to write an npc line and which meters there are, plus each meter's rule while the
     * presets feature is on. Changes only with the settings (and the presets in use).
     */
    function staticText() {
        const settings = storedSettings();
        const custom = settings.custom.map(def => `, ${def.id} (${def.min}..${def.max})`).join('');
        const base = `NPC meters: ${BUILT_IN_METERS.map(def => def.id).join(', ')} (-100..100)${custom}. When the scene changes how someone feels: ~ npc Name | meter: +N, -N or =N. Code clamps each meter, moves it at most ${settings.changeCap} a reply and sets the stages; never write a stage.`;
        const rules = featureOn(FEATURE_PRESETS) ? settings.custom.filter(def => def.describe).map(def => `${def.id} ${def.describe}`) : [];
        return rules.length ? `${base} Meter rules: ${rules.join('; ')}.` : base;
    }

    /** Present NPCs' meters when they moved lately (band words where a meter has them), and their unlocked notes. */
    function tail(view) {
        const state = view?.state;
        const { npcs } = sliceOf(state);
        const settings = storedSettings();
        const defs = defsFrom(settings);
        const length = Number.isInteger(view?.chat?.length) ? view.chat.length : 0;
        const here = presentKeys(npcs);
        const moved = [];
        const notes = [];
        for (const key of Object.keys(npcs).sort()) {
            if (!here.has(key)) continue;
            const record = npcs[key];
            // Where the window's reply was (its index, kept beside a record ID).
            const where = isInt(record.turn?.at) ? record.turn.at : record.turn?.reply;
            if (isInt(where) && where >= length - RECENT_MESSAGES) {
                const parts = defs.map(def => {
                    const stage = record.stages?.[def.id];
                    const value = meterValue(record, def);
                    return `${def.id} ${bandWord(def.bands, value) || value}${stage ? ` (${stage})` : ''}`;
                });
                const rank = record.rank !== undefined ? rungsFor(settings, setupFor(record.name)).find(step => step.key === record.rank)?.name : null;
                moved.push(`${record.name}${rank ? ` (${rank})` : ''} ${parts.join(', ')}`);
            }
            if (record.unlocked?.length) {
                const texts = call(hooks.secretTexts, [], record.name, [...record.unlocked]);
                for (const item of (Array.isArray(texts) ? texts : []).slice(0, TAIL_SECRETS_PER_NPC)) {
                    const text = clean(item?.text, SECRET_TEXT_MAX);
                    if (text && record.unlocked.includes(item?.id)) notes.push(`${record.name}, now known: ${text}`);
                }
            }
        }
        const lines = [];
        if (moved.length) lines.push(`NPC meters now: ${moved.join('; ')}.`);
        return { lines: [...lines, ...notes], optional: [] };
    }

    return {
        domains: { [NPC_DOMAIN]: { initial: initialNpcSlice, validate: slice => validateNpcSlice(slice) } },
        commands,
        queries,
        kinds: {
            [NPC_KIND]: { grammar: '~ npc Name | trust: +N | affection: -N', apply: captureLine },
            [MILESTONE_KIND]: { grammar: '+ milestone Name — the turning point that just happened between you (once)', apply: captureLine, feature: FEATURE_STAGES },
        },
        context: { static: staticText, tail, budget: CONTEXT_BUDGET },
        settings: { defaults: { ...SETTINGS_DEFAULTS }, schema: SETTINGS_SCHEMA },
        features: FEATURES,
        featureOn: id => featureOn(id),
        identify: (npcs, label) => identify(npcs ?? {}, label),
        defs: () => defsFrom(storedSettings()),
        meterSettings: () => storedSettings(),
        /** True when Delta's per-reply tick has something to look at (a ladder, or a drifting meter). */
        tickWanted: () => {
            const settings = storedSettings();
            return (featureOn(FEATURE_STAGES) && Object.keys(settings.ladder).length > 0)
                || (featureOn(FEATURE_DRIFT) && settings.custom.some(def => def.drift));
        },
        ladder: record => (isObject(record) ? ladderView(record, storedSettings(), defsFrom(storedSettings())) : null),
        notes: record => (isObject(record) ? notesView(record, defsFrom(storedSettings())) : { locked: [], opened: [] }),
    };
}

export const SETTINGS_DEFAULTS = Object.freeze({ changeCap: DEFAULT_CHANGE_CAP, customMeters: [], stages: [], ladder: [], conflictAt: DEFAULT_CONFLICT_AT, demoteAfter: DEFAULT_DEMOTE_AFTER, presets: [] });

const TONE_OPTIONS = Object.freeze(TONES.map(tone => Object.freeze({ value: tone, label: tone[0].toUpperCase() + tone.slice(1) })));

// Rendered by the Story Suite overlay in Delta's fold, above Delta's own panel (SPEC §6 schema fields).
// `presets` has no field here: the presets block in Delta's section turns them on and off.
export const SETTINGS_SCHEMA = Object.freeze({
    changeCap: Object.freeze({
        type: 'int', min: 1, max: MAX_CHANGE_CAP, label: 'Most a meter moves per reply',
        help: 'Story lines and Delta\'s scans together; code holds each meter within this of where the reply started.',
    }),
    customMeters: Object.freeze({
        type: 'list', label: 'Custom meters',
        help: `Up to ${MAX_CUSTOM_METERS} meters of your own beside trust, affection, desire and tension. The story moves them with "~ npc Name | meter: +N". Rule: one line telling the story what moves it (sent while presets and rules are on). Words: "doubtful 25, steady 60, devoted" — the story is told the word, not the number. Drift: how far it moves each story day toward its resting value (needs the drift feature and Story Director's clock).`,
        of: Object.freeze({
            name: Object.freeze({ type: 'text', label: 'Name', max: LABEL_MAX }),
            min: Object.freeze({ type: 'int', label: 'Lowest' }),
            max: Object.freeze({ type: 'int', label: 'Highest' }),
            start: Object.freeze({ type: 'int', label: 'Starts at' }),
            show: Object.freeze({ type: 'choice', label: 'Bar', options: Object.freeze([Object.freeze({ value: 'bar', label: 'Show' }), Object.freeze({ value: 'hidden', label: 'Hide' })]) }),
            tone: Object.freeze({ type: 'choice', label: 'Colour', options: TONE_OPTIONS }),
            describe: Object.freeze({ type: 'text', label: 'Rule', max: DESCRIBE_MAX }),
            bands: Object.freeze({ type: 'text', label: 'Words', max: 160 }),
            drift: Object.freeze({ type: 'int', label: 'Drift a day', min: 0, max: 100 }),
            driftTo: Object.freeze({ type: 'int', label: 'Rests at' }),
        }),
    }),
    stages: Object.freeze({
        type: 'list', label: 'Meter stages',
        help: 'Named thresholds: a stage at 0 or more is reached at or above it, a negative one at or below it. Code moves the stage and notes it on the reply.',
        of: Object.freeze({
            meter: Object.freeze({ type: 'text', label: 'Meter' }),
            at: Object.freeze({ type: 'int', label: 'At' }),
            name: Object.freeze({ type: 'text', label: 'Stage' }),
        }),
    }),
    ladder: Object.freeze({
        type: 'list', label: 'Stage ladder',
        help: 'Rungs in order, each reached when all its needs hold ("trust 60, affection 40") and, if named, its story milestone has happened ("+ milestone Mira — saved her brother"). Track: leave empty for everyone, or name a track an NPC is given in the dossier editor.',
        of: Object.freeze({
            name: Object.freeze({ type: 'text', label: 'Stage', max: STAGE_NAME_MAX }),
            needs: Object.freeze({ type: 'text', label: 'Needs', max: 120 }),
            milestone: Object.freeze({ type: 'text', label: 'Milestone', max: MILESTONE_MAX }),
            track: Object.freeze({ type: 'text', label: 'Track', max: TRACK_MAX }),
        }),
    }),
    conflictAt: Object.freeze({
        type: 'int', min: BUILT_IN_RANGE.min, max: BUILT_IN_RANGE.max, label: 'Conflict: tension above',
        help: 'While an NPC\'s tension is above this, no stage on the ladder is reached.',
    }),
    demoteAfter: Object.freeze({
        type: 'int', min: 0, max: 50, label: 'Replies before a stage is lost',
        help: 'A stage on the ladder falls back one rung only after its needs have failed this many replies in a row (0: never).',
    }),
});
