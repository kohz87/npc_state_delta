// NPC meters for Story Suite v2 (Story Block 2, docs/v2/SPEC.md §2, §4, §5; coordinator decisions
// F81 and F90): a small slice of each NPC in v2's per-reply state, so the meters swipe and delete
// back with the replies. The long prose dossiers stay in Delta's own sidecar; only numbers, stage
// names and the ids of unlocked hidden notes live here.
//
//   npc = {
//     npcs: { [key]: { name, meters: { trust, affection, desire, tension, ...custom }, stages: { meter: name },
//                      unlocked: [noteId], disposition?, turn?: { reply, from: { meter: value } } } },
//     problems: [{ rev, text }],          // the last change lines code could not use in full (last 20)
//   }
//
// * Keys are the NPC's name in lowercase words joined by "-" (`mira`, `jean-luc`), so a line about
//   someone Delta has no dossier for still finds the same entry next time; a dossier is matched to
//   its entry by its name, then its aliases.
// * Meters: trust, affection, desire and tension (-100..100, starting from Delta's base values, or
//   from the dossier's own numbers for someone Delta already knows), plus up to six custom meters
//   from the reader's settings. Code clamps every value to its range, and the change of one meter
//   within one reply to the change cap (`turn.from` holds the values the reply started from).
// * Stages: named thresholds per meter. A threshold at 0 or above is reached at or above it, a
//   negative one at or below it; the stage is the farthest one reached. Code moves the stage when a
//   meter crosses a threshold either way and says so in the receipt. The story cannot set a stage.
// * Hidden notes ("secrets"): kept in Delta's dossier with an unlock rule { meter, at }. When the
//   meter reaches `at` (same rule as a threshold), code adds the note's id to `unlocked` (it stays
//   unlocked on that line of history) and says so; the text itself never enters this state and is
//   given to the story only through the tail, only while the NPC is present and unlocked.
//
// Pure: no DOM, no SillyTavern, no clock, no randomness. What Delta knows (dossier names, base
// values, note rules and texts, who is present) comes in through the hooks given to createNpcPart.

export const NPC_DOMAIN = 'npc';
export const NPC_KIND = 'npc';
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
export const DEFAULT_CHANGE_CAP = 15;
export const MAX_CHANGE_CAP = 200;
// "Changed lately" for the tail: the meters moved on one of the last few messages (about two replies).
export const RECENT_MESSAGES = 4;
export const SECRET_TEXT_MAX = 300;
export const TAIL_SECRETS_PER_NPC = 3;
export const CONTEXT_BUDGET = 250;

const NAME_MAX = 120;
const LABEL_MAX = 40;
const STAGE_NAME_MAX = 40;
const DISPOSITION_MAX = 80;
const KEY_MAX = 60;
const METER_ID_MAX = 40;
// Labels a change line may carry that are not meters: the reason words are skipped quietly,
// `stage` is refused (code sets stages), `disposition` is a short word kept on the entry.
const REASON_LABELS = new Set(['reason', 'why', 'because', 'note', 'cause']);
const RESERVED_IDS = new Set(['stage', 'stages', 'disposition', 'name', 'meter', 'meters', ...REASON_LABELS]);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const WORDS = /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u;

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const isInt = value => Number.isInteger(value);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
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

const intOr = (value, fallback) => {
    if (value === null || value === undefined || value === '') return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number) : fallback;
};

/**
 * The reader's meter settings, cleaned: { changeCap, custom: [{ id, label, min, max, start, show }],
 * stages: { [meterId]: [{ at, name }] ascending } }. Bad entries are left out, never thrown.
 *   changeCap     the most one meter moves within one reply (story lines and scans together)
 *   customMeters  [{ name (or id), min, max, start, show }]: the first six usable ones
 *   stages        [{ meter, at, name }]: up to eight per meter
 */
export function normalizeMeterSettings(raw = {}) {
    const source = isObject(raw) ? raw : {};
    const changeCap = clamp(intOr(source.changeCap, DEFAULT_CHANGE_CAP), 1, MAX_CHANGE_CAP);
    const custom = [];
    const taken = new Set(BUILT_IN_METERS.map(meter => meter.id));
    for (const entry of Array.isArray(source.customMeters) ? source.customMeters : []) {
        if (custom.length >= MAX_CUSTOM_METERS) break;
        if (!isObject(entry)) continue;
        const label = clean(entry.name ?? entry.label ?? entry.id, LABEL_MAX);
        const id = slug(entry.id || label);
        if (!id || taken.has(id) || RESERVED_IDS.has(id) || FORBIDDEN_KEYS.has(id)) continue;
        let min = clamp(intOr(entry.min, 0), CUSTOM_RANGE.min, CUSTOM_RANGE.max);
        let max = clamp(intOr(entry.max, 100), CUSTOM_RANGE.min, CUSTOM_RANGE.max);
        // An empty or upside-down range (a row just added in the overlay) reads as 0..100.
        if (!(max > min)) { min = 0; max = 100; }
        const start = clamp(intOr(entry.start, clamp(0, min, max)), min, max);
        const show = !(entry.show === false || entry.show === 'hidden' || entry.show === 'no');
        taken.add(id);
        custom.push(Object.freeze({ id, label: label || id, min, max, start, show, builtIn: false, tone: 'neutral' }));
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
    return { changeCap, custom, stages };
}

/**
 * Every meter in use, built-ins first: [{ id, label, min, max, start, show, builtIn, tone }].
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
 * Hidden notes from a dossier record, cleaned: [{ id, meter, at, text }] (at most eight; an entry
 * without a meter id, a whole-number `at` or text is left out).
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
        out.push({ id, meter, at, text });
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

/** The notes as editor lines: `trust 40: She is the duke's daughter.` */
export function secretsToLines(list) {
    return normalizeSecrets(list).map(secret => `${secret.meter} ${secret.at}: ${secret.text}`).join('\n');
}

/**
 * Editor lines back to notes: one per line, `meter at: text` (`trust 40: …`, `trust >= 40: …`,
 * `tension -30: …`). A note whose rule and text are unchanged keeps its id. Lines that do not read
 * are returned in `problems`.
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
        const body = clean(match[3], SECRET_TEXT_MAX);
        if (!meter || !body) { problems.push(trimmed); continue; }
        const id = kept.get(`${meter}|${at}|${body}`) ?? secretId(meter, at, body);
        if (secrets.some(secret => secret.id === id)) continue;
        if (secrets.length >= MAX_SECRETS) { problems.push(trimmed); continue; }
        secrets.push({ id, meter, at, text: body });
    }
    return { secrets, problems };
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
            if (!isObject(turn) || !isInt(turn.reply) || turn.reply < 0 || !isObject(turn.from)
                || Object.values(turn.from).some(value => !isInt(value))) errors.push(`${where} has an unusable reply window.`);
        }
        for (const field of Object.keys(record)) {
            if (!['name', 'meters', 'stages', 'unlocked', 'disposition', 'turn'].includes(field)) errors.push(`${where} has an unknown field "${field}".`);
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
// `limit` holds each meter within cap of the value the reply `reply` started from (story lines and
// scans); without it (the reader's own set) only the range applies.
function moveMeters(record, changes, { defs, cap, reply, limit }) {
    const byId = new Map(defs.map(def => [def.id, def]));
    const known = Number.isInteger(reply) && reply >= 0;
    if (limit && known && record.turn?.reply !== reply) record.turn = { reply, from: { ...record.meters } };
    const moved = [];
    for (const change of changes) {
        const def = byId.get(change.meter);
        if (!def) continue;
        const before = meterValue(record, def);
        const asked = change.mode === 'add' ? before + change.value : change.value;
        let low = def.min;
        let high = def.max;
        if (limit) {
            if (record.turn && known && !isInt(record.turn.from[def.id])) record.turn.from[def.id] = before;
            const base = known && isInt(record.turn?.from?.[def.id]) ? record.turn.from[def.id] : before;
            low = Math.min(Math.max(low, base - cap), before);
            high = Math.max(Math.min(high, base + cap), before);
        }
        const after = clamp(asked, low, high);
        record.meters[def.id] = after;
        moved.push({ meter: def.id, label: def.label, before, after, asked, held: after !== asked });
    }
    // The reader's own values are the new start of this reply's window (or end it).
    if (!limit && moved.length) {
        if (known) record.turn = { reply, from: { ...record.meters } };
        else delete record.turn;
    }
    return moved;
}

// Stages and notes after a change: moves each stage to where its meter now stands and unlocks the
// notes whose rule is met. → { stages: [{ meter, from, to, text }], unlocked: [{ id, text }] }.
function settle(record, { defs, stages, rules, name }) {
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
    return { stages: moves, unlocked: opened };
}

const sentence = parts => parts.filter(Boolean).map(part => (/[.!?]$/.test(part) ? part : `${part}.`)).join(' ');

function changeText(name, moved) {
    if (!moved.length) return '';
    return `${name}: ${moved.map(item => `${item.label.toLocaleLowerCase()} ${item.before} → ${item.after}${item.held ? ` (held at ${item.after}; ${signed(item.asked - item.before)} asked)` : ''}`).join(', ')}`;
}

// The receipt: stage and note lines are what the next reply is told (narrate when a stage moved);
// the numbers are for the reply's card.
function result({ name, key, moved, settled, problems, created, disposition }) {
    const notes = [...settled.stages.map(move => move.text), ...settled.unlocked.map(note => note.text)];
    const numbers = changeText(name, moved);
    const summary = sentence(notes.length ? [...notes, numbers] : [numbers || (created ? `${name}: meters started` : `${name}: nothing moved`), disposition ? `${name} is ${disposition}` : '']);
    return {
        summary,
        narrate: settled.stages.length > 0,
        data: {
            name,
            key,
            created,
            changes: moved.map(({ meter, before, after, held }) => ({ meter, before, after, held })),
            stages: settled.stages.map(({ meter, from, to }) => ({ meter, from, to })),
            unlocked: settled.unlocked.map(note => note.id),
            problems,
        },
    };
}

/**
 * The `npc` part (MODULES §A part shape): domain, commands, queries, the `npc` change-line kind and
 * the prompt context. Hooks (each optional, each may throw — a throw reads as "nothing known"):
 *   resolve(name)     → Delta's dossier for that name or alias: { name, aliases, relationship } | null
 *   baseline()        → Delta's base relationship values (new NPCs start there)
 *   secretRules(name) → that dossier's notes as [{ id, meter, at }] (never their text)
 *   secretTexts(name, ids) → [{ id, text }] for those unlocked notes (the tail only)
 *   present()         → names of the NPCs present now
 *   settings()        → the module's stored settings (queries and the prompt; commands use ctx.settings)
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
    const storedSettings = () => normalizeMeterSettings(call(hooks.settings, {}));
    const defsFrom = settings => meterDefs(settings, baseline());

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
        npcs[who.key] = { name: who.name, meters, stages: {}, unlocked: [] };
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

    function run(ctx, { label, changes, problems, limit, reply, seed, disposition, allowEmpty = false }) {
        const settings = normalizeMeterSettings(ctx.settings());
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
        const moved = moveMeters(record, changes, { defs, cap: settings.changeCap, reply, limit });
        if (disposition !== undefined) {
            if (disposition) record.disposition = disposition;
            else delete record.disposition;
        }
        const settled = settle(record, { defs, stages: settings.stages, rules: rulesFor(record.name, who.labels), name: record.name });
        note(slice, ctx.rev, problems);
        return result({ name: record.name, key: who.key, moved, settled, problems, created, disposition });
    }

    // ---- the change line ----

    function captureLine(ctx, line = {}) {
        const settings = normalizeMeterSettings(ctx.settings());
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
        const reply = Number.isInteger(ctx.carrier?.index) ? ctx.carrier.index : null;
        return run(ctx, { label: line.name, changes, problems, limit: true, reply, disposition, allowEmpty: line.op === '+' });
    }

    // ---- commands (cause ui from Delta itself; capture is the story's) ----

    const commands = {
        /**
         * npc.adjust { name, meters: { meter: ±n }, start?: { meter: n }, reply?: n }: moves meters
         * by the given amounts, with the same range and per-reply clamps as a story line. Delta's
         * own scanner sends its relationship changes this way while hosted (`start`: the values the
         * dossier had before them, for an NPC the slice has no entry for yet).
         */
        'npc.adjust'(ctx, payload = {}) {
            const problems = [];
            const defs = defsFrom(normalizeMeterSettings(ctx.settings()));
            const changes = changesFrom(payload?.meters, defs, 'add', problems).filter(change => change.value !== 0);
            const reply = isInt(payload?.reply) && payload.reply >= 0 ? payload.reply : null;
            return run(ctx, { label: payload?.name, changes, problems, limit: true, reply, seed: isObject(payload?.start) ? payload.start : null });
        },
        /** npc.set { name, meters: { meter: n }, reply? }: the reader's own values (range only). */
        'npc.set'(ctx, payload = {}) {
            const problems = [];
            const defs = defsFrom(normalizeMeterSettings(ctx.settings()));
            const changes = changesFrom(payload?.meters, defs, 'set', problems);
            const reply = isInt(payload?.reply) && payload.reply >= 0 ? payload.reply : null;
            return run(ctx, { label: payload?.name, changes, problems, limit: false, reply });
        },
        /** npc.refresh { name }: stages and notes again (after the reader changed them). */
        'npc.refresh'(ctx, payload = {}) {
            const slice = ctx.read(NPC_DOMAIN);
            const who = identify(slice?.npcs ?? {}, payload?.name);
            if (!who || !Object.hasOwn(slice?.npcs ?? {}, who.key)) ctx.fail('NOT_FOUND', 'That NPC has no meters yet.');
            const out = run(ctx, { label: payload.name, changes: [], problems: [], limit: false, reply: null, allowEmpty: true });
            if (!out.data.stages.length && !out.data.unlocked.length) ctx.fail('REFUSED', 'Nothing to update.');
            return out;
        },
    };

    // ---- queries ----

    const sliceOf = state => (isObject(state?.domains?.[NPC_DOMAIN]?.npcs) ? state.domains[NPC_DOMAIN] : initialNpcSlice());
    const entryView = (key, record, defs) => ({
        key,
        name: record.name,
        meters: Object.fromEntries(defs.map(def => [def.id, meterValue(record, def)])),
        stages: { ...(record.stages ?? {}) },
        unlocked: [...(record.unlocked ?? [])],
        ...(record.disposition ? { disposition: record.disposition } : {}),
        ...(record.turn ? { reply: record.turn.reply } : {}),
    });
    const bars = (record, defs) => defs.filter(def => def.show).map(def => {
        const value = meterValue(record, def);
        const stage = record.stages?.[def.id] ?? '';
        return { id: def.id, label: def.label, value, min: def.min, max: def.max, stage, tone: def.tone, text: stage ? `${value} · ${stage}` : String(value) };
    });
    const presentKeys = npcs => new Set(presentNames().map(name => findNpcKey(npcs, [name, ...(resolve(name)?.aliases ?? [])])).filter(Boolean));

    const queries = {
        /**
         * npc.meters({ name }) → { key, name, meters, stages, unlocked, disposition?, reply? } | null;
         * without a name, every entry (in key order). Meters are filled in for every meter in use.
         */
        'npc.meters'(state, args = {}) {
            const { npcs } = sliceOf(state);
            const defs = defsFrom(storedSettings());
            if (args && typeof args.name === 'string') {
                const who = identify(npcs, args.name);
                return who && Object.hasOwn(npcs, who.key) ? entryView(who.key, npcs[who.key], defs) : null;
            }
            return Object.keys(npcs).sort().map(key => entryView(key, npcs[key], defs));
        },
        /** npc.cast() → [{ key, name, present, bars: [{ id, label, value, min, max, stage, text, tone }] }], present first. */
        'npc.cast'(state) {
            const { npcs } = sliceOf(state);
            const defs = defsFrom(storedSettings());
            const here = presentKeys(npcs);
            return Object.keys(npcs)
                .map(key => ({ key, name: npcs[key].name, present: here.has(key), bars: bars(npcs[key], defs) }))
                .sort((a, b) => Number(b.present) - Number(a.present) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        },
    };

    // ---- the prompt (SPEC §5) ----

    /** One line: how to write an npc line and which meters there are. Changes only with the settings. */
    function staticText() {
        const settings = storedSettings();
        const custom = settings.custom.map(def => `, ${def.id} (${def.min}..${def.max})`).join('');
        return `NPC meters: ${BUILT_IN_METERS.map(def => def.id).join(', ')} (-100..100)${custom}. When the scene changes how someone feels: ~ npc Name | meter: +N, -N or =N. Code clamps each meter, moves it at most ${settings.changeCap} a reply and sets the stages; never write a stage.`;
    }

    /** Present NPCs' meters when they moved lately, and their unlocked notes. */
    function tail(view) {
        const state = view?.state;
        const { npcs } = sliceOf(state);
        const defs = defsFrom(storedSettings());
        const length = Number.isInteger(view?.chat?.length) ? view.chat.length : 0;
        const here = presentKeys(npcs);
        const moved = [];
        const notes = [];
        for (const key of Object.keys(npcs).sort()) {
            if (!here.has(key)) continue;
            const record = npcs[key];
            if (isInt(record.turn?.reply) && record.turn.reply >= length - RECENT_MESSAGES) {
                const parts = defs.map(def => {
                    const stage = record.stages?.[def.id];
                    return `${def.id} ${meterValue(record, def)}${stage ? ` (${stage})` : ''}`;
                });
                moved.push(`${record.name} ${parts.join(', ')}`);
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
        kinds: { [NPC_KIND]: { grammar: '~ npc Name | trust: +N | affection: -N', apply: captureLine } },
        context: { static: staticText, tail, budget: CONTEXT_BUDGET },
        settings: { defaults: { ...SETTINGS_DEFAULTS }, schema: SETTINGS_SCHEMA },
        identify: (npcs, label) => identify(npcs ?? {}, label),
        defs: () => defsFrom(storedSettings()),
    };
}

export const SETTINGS_DEFAULTS = Object.freeze({ changeCap: DEFAULT_CHANGE_CAP, customMeters: [], stages: [] });

// Rendered by the Story Suite overlay in Delta's fold, above Delta's own panel (SPEC §6 schema fields).
export const SETTINGS_SCHEMA = Object.freeze({
    changeCap: Object.freeze({
        type: 'int', min: 1, max: MAX_CHANGE_CAP, label: 'Most a meter moves per reply',
        help: 'Story lines and Delta\'s scans together; code holds each meter within this of where the reply started.',
    }),
    customMeters: Object.freeze({
        type: 'list', label: 'Custom meters',
        help: `Up to ${MAX_CUSTOM_METERS} meters of your own beside trust, affection, desire and tension. The story moves them with "~ npc Name | meter: +N".`,
        of: Object.freeze({
            name: Object.freeze({ type: 'text', label: 'Name' }),
            min: Object.freeze({ type: 'int', label: 'Lowest' }),
            max: Object.freeze({ type: 'int', label: 'Highest' }),
            start: Object.freeze({ type: 'int', label: 'Starts at' }),
            show: Object.freeze({ type: 'choice', label: 'Bar', options: Object.freeze([Object.freeze({ value: 'bar', label: 'Show' }), Object.freeze({ value: 'hidden', label: 'Hide' })]) }),
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
});
