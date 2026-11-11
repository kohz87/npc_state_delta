// NPC meters, the constants and the pure parsers behind them: the meter, secret, stage and feature limits, the key and slug helpers,
// the band, need and rung parsers, normalizeMeterSettings, meterDefs and the stage thresholds. A pure part of npc-meters.js (same
// owner, moved without change); npc-meters.js re-exports every name it exported before. Never imports npc-meters.js.
import { FEATURE_SOCIAL } from './social-check.js';
import { BUILT_IN_PRESETS, normalizePreset, presetIds } from './npc-meters-presets.js';

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
// Notes the scan writes for someone new (2 to 5 layers); the pack's and the reader's keep MAX_SECRETS.
export const MAX_GENERATED_SECRETS = 5;
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
export const SECRET_WHEN_MAX = 120;
// Where a note that is not the reader's came from (its `from`).
export const NOTE_SOURCES = Object.freeze(['pack', 'scan']);
export const MILESTONE_MAX = 60;
export const DESCRIBE_MAX = 100;
export const TAIL_SECRETS_PER_NPC = 3;
export const CONTEXT_BUDGET = 250;

// The optional mechanics (MODULES §F100). A host without the Features API gets each one's default.
export const FEATURE_STAGES = 'npc-state-delta.stages';
export const FEATURE_DRIFT = 'npc-state-delta.drift';
export const FEATURE_PRESETS = 'npc-state-delta.presets';
export const FEATURE_SCAN_EVERY_REPLY = 'npc-state-delta.scan-every-reply';
// The anti-lever gate (npc-meters-gate.js): off by default, so the static prompt and every old chat stay as they were.
export const FEATURE_GATE = 'npc-state-delta.anti-lever';
export const FEATURE_MOOD_PULL = 'npc-state-delta.mood-pull';
// Dossier notes (src/npc-notes-kinds.js): lies told, what a person knows of others, tastes, ties; story kinds `~ lie|know|taste|tie`.
export const FEATURE_NOTES = 'npc-state-delta.notes';

// "How much to track" (Story Block): the Lean preset turns this feature off; Standard is its default.
const LEAN_OFF = Object.freeze({ lean: false });
export const FEATURES = Object.freeze([
    Object.freeze({ id: FEATURE_STAGES, label: 'Stage ladders and milestones', describe: 'Stages that need several meters at once and a story milestone; promotion waits out a conflict, a stage is lost only after a sustained low.', default: true, prompt: true, presets: LEAN_OFF }),
    Object.freeze({ id: FEATURE_DRIFT, label: 'Meters drift each story day', describe: 'Meters with a drift setting move toward their resting value as story days pass (needs Story Director\'s clock).', default: false }),
    Object.freeze({ id: FEATURE_PRESETS, label: 'Meter presets and rules', describe: 'One-click meter sets (Companion, Rival, Mentor and packs\') and each meter\'s rule line in the story\'s instructions.', default: true, prompt: true, presets: LEAN_OFF }),
    // Read-only (src/social-check.js): no prompt text, no state; a dice module asks npc.socialModifier.
    Object.freeze({ id: FEATURE_SOCIAL, label: 'Social checks use the dossier', describe: 'A persuade, charm, intimidate or deceive check against an NPC gets a small bonus or penalty from their meters, stage and disposition (for Story Director\'s checks or another dice module).', default: true }),
    // Read by index.js (scanAfterEveryReply): no prompt text, no state. Off, the automatic scan runs every 3 replies (or
    // "Scan every" when larger), reading every reply since the last scan; a manual scan is never held back.
    Object.freeze({ id: FEATURE_SCAN_EVERY_REPLY, label: 'Scan after every reply', describe: 'Off: the automatic scan runs every 3 replies (or the "Scan every" setting if larger) and that scan reads every reply since the last one, so a reply in between is read, not lost. A manual scan always runs.', default: true, presets: LEAN_OFF }),
    // A story line may say `| via: praise`; the same approach to the same person again soon gives less and then backfires (npc-meters-gate.js).
    Object.freeze({ id: FEATURE_GATE, label: 'Anti-lever: repeated approaches give less', describe: 'A story line may name its approach (praise, gift, help, flirt, threat, shared danger); repeating it to one person within a few days gives less, then backfires. Story lines only.', default: false, prompt: true, presets: LEAN_OFF }),
    // Mood and pull (npc-mood.js, npc-instincts.js): code-set state on each record plus tail lines for present NPCs. Off by default, so an
    // old chat's prompt and state stay byte-identical; a new chat turns it on in the feature list (the same gate as the anti-lever feature).
    Object.freeze({ id: FEATURE_MOOD_PULL, label: 'Mood and pull', describe: 'Each person has a mood (how a betrayal or a trust drop left them) and a pull (an instinct such as wanting closure or belonging); the narrator is told both for people present.', default: false, prompt: true, presets: LEAN_OFF }),
    // Dossier notes: four story kinds (lie, know, taste, tie), code-kept leaves on each record and optional tail lines. Their grammar is
    // only in the static prompt while this is on; a reply written before it existed never holds one of those lines.
    Object.freeze({ id: FEATURE_NOTES, label: 'Dossier notes', describe: 'The story may note a lie a person told, what they know of others, their tastes and ties (ally, rival, owes); a lie the story catches costs trust. Hidden until revealed.', default: false, prompt: true, presets: LEAN_OFF }),
]);
export const FEATURE_DEFAULTS = Object.freeze(Object.fromEntries(FEATURES.map(feature => [feature.id, feature.default])));

export const NAME_MAX = 120;
export const LABEL_MAX = 40;
export const STAGE_NAME_MAX = 40;
export const DISPOSITION_MAX = 80;
export const KEY_MAX = 60;
export const METER_ID_MAX = 40;
const BAND_WORD_MAX = 24;
export const TRACK_MAX = 80;
export const TONES = Object.freeze(['neutral', 'accent', 'good', 'warn', 'bad', 'info']);
// Labels a change line may carry that are not meters: the reason words are skipped quietly,
// `stage` is refused (code sets stages), `disposition` is a short word kept on the entry.
export const REASON_LABELS = new Set(['reason', 'why', 'because', 'note', 'cause']);
const RESERVED_IDS = new Set(['stage', 'stages', 'disposition', 'name', 'meter', 'meters', 'milestone', 'milestones', ...REASON_LABELS]);
export const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export const WORDS = /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u;
export const RECORD_FIELDS = Object.freeze(['name', 'meters', 'stages', 'unlocked', 'disposition', 'turn', 'milestones', 'rank', 'low', 'day', 'held', 'progress', 'impactDay', 'lastEvent', 'via', 'mood', 'inst', 'pull', 'track', 'lies', 'knows', 'tastes', 'ties', 'drives', 'lookLockedAt']);
// The impact tiers of a story line (`| impact: major`), the scanner's own: the line's step is held to the tier's cap
// (the reader's relationshipCaps). A missing or unknown tier is the smallest.
export const IMPACT_TIERS = Object.freeze(['ordinary', 'meaningful', 'major', 'extreme']);
export const tierOf = raw => {
    const word = String(raw ?? '').trim().toLowerCase().split(/[^a-z]+/)[0];
    return IMPACT_TIERS.includes(word) ? word : 'ordinary';
};

export const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
export const isInt = value => Number.isInteger(value);
// The longest reply record ID a meter window keeps (Story Block's are "sw_" and 12 letters).
const REPLY_ID_MAX = 64;
export const isReplyId = value => typeof value === 'string' && value.length > 0 && value.length <= REPLY_ID_MAX;
/**
 * The reply a meter window belongs to (SPEC §2.2, per-reply bookkeeping): the reply's record ID (`sid`),
 * which a middle delete never moves (B-a1-15), else its index (a host that gives no record ID); null
 * when neither is known.
 */
export const replyKey = (sid, index) => (isReplyId(sid) ? sid : isInt(index) && index >= 0 ? index : null);
// Whether the window `turn` is the reply `key`'s.
export const sameReply = (turn, key) => turn?.reply === key && key !== null && key !== undefined;
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
// Flattened to one line and cut by code points (a surrogate pair is never split).
export const clean = (value, max) => [...String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, max).join('').trim();
export const own = (object, key) => isObject(object) && Object.hasOwn(object, key);

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

/** Story Director's key people (read only): who is a key person, and where the away ones are (src/key-people.js). */
export const KEY_PEOPLE_QUERY = 'director.keyPeople';

/** The key of a milestone or a rung: its words, lowercase, joined by "-" ('' when none). */
export function wordKey(value) {
    const key = slug(value, METER_ID_MAX);
    return FORBIDDEN_KEYS.has(key) ? `${key}-key` : key;
}

export const intOr = (value, fallback) => {
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

export const needMet = (need, value) => (need.below ? value <= need.at : value >= need.at);

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
export function rung(entry) {
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
    return { changeCap, custom, stages, ladder, limits, conflictAt, demoteAfter, presets: used.map(preset => preset.id), stagesOn };
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

export const signed = value => (value > 0 ? `+${value}` : String(value));
