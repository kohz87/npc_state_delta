// Meter presets for Story Suite v2 (TRS ideas 2-3 as the coordinator took them): a named set of
// custom meters, a stage ladder and per-meter limits that the reader turns on in one click. The
// reader's settings keep only the ids in use (`presets`); the meters, the ladder and the limits are
// read from the preset each time, so a pack update reaches every chat that uses it.
//
//   preset = { id, name, describe, builtIn, meters: [custom meter rows], ladder: [{ name, needs,
//              milestone }], limits: { meterId: { ceiling?, floor? } } }
//
// * Built-in presets are plain and non-explicit: Companion, Rival, Mentor. The Mentor's desire
//   ceiling is 0, so that bond never turns romantic by the numbers.
// * A pack offers more through the content kind `meterPresets` (Story Block's `packs.content`,
//   PACKS.md: `{ id, title, meters: [{ id, name, min, max, start, describe?, bands?: [{ at, word }],
//   drift?: { toward, perDay } }], stages?: [{ id, name, needs: [{ meter, at }], milestone? }] }`); a
//   pack record is cleaned the same way and keeps the id `packs.content` gives it. A pack stage's
//   `milestone` is what the story is told when it is first reached, never a milestone it needs.
// * A preset's ladder runs on its own track: it applies to the NPCs the reader gave that preset in
//   the dossier editor (their limits come from it too), never to everyone.
//
// Pure: no DOM, no host. Bad entries are left out, never thrown.

export const MAX_PRESETS = 12;
export const PRESET_LADDER_MAX = 8;
const NAME_MAX = 40;
const DESCRIBE_MAX = 160;
const ID_MAX = 80;

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const clean = (value, max) => [...String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, max).join('');
const intOr = (value, fallback) => {
    if (value === null || value === undefined || value === '') return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number) : fallback;
};
const presetSlug = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');

export const BUILT_IN_PRESETS = Object.freeze([
    Object.freeze({
        id: 'companion',
        name: 'Companion',
        describe: 'Someone who travels with you: loyalty grows with shared danger and kept promises.',
        meters: Object.freeze([
            Object.freeze({ name: 'Loyalty', min: 0, max: 100, start: 20, tone: 'good', describe: 'rises when you keep promises or share danger; falls when you lie or leave them behind', bands: 'doubtful 25, steady 60, devoted' }),
        ]),
        ladder: Object.freeze([
            Object.freeze({ name: 'Travel companion', needs: 'loyalty 20' }),
            Object.freeze({ name: 'Trusted companion', needs: 'trust 40, loyalty 50' }),
            Object.freeze({ name: 'Sworn companion', needs: 'trust 60, loyalty 75', milestone: 'stood by you in danger' }),
        ]),
        limits: Object.freeze({}),
    }),
    Object.freeze({
        id: 'rival',
        name: 'Rival',
        describe: 'Someone who measures themselves against you: respect is earned, warmth is slow.',
        meters: Object.freeze([
            Object.freeze({ name: 'Respect', min: 0, max: 100, start: 10, tone: 'info', describe: 'rises when you beat or impress them fairly; falls with cheap tricks or backing down', bands: 'dismissive 20, wary 50, grudging 75, admiring' }),
            Object.freeze({ name: 'Rivalry', min: 0, max: 100, start: 50, tone: 'warn', describe: 'rises with each contest or slight; falls when you work together', bands: 'cooling 30, keen 70, fierce', drift: 2, driftTo: 40 }),
        ]),
        ladder: Object.freeze([
            Object.freeze({ name: 'Rival', needs: 'rivalry 30' }),
            Object.freeze({ name: 'Respected rival', needs: 'respect 40' }),
            Object.freeze({ name: 'Grudging ally', needs: 'respect 65, trust 25', milestone: 'fought a common enemy' }),
        ]),
        limits: Object.freeze({ affection: Object.freeze({ ceiling: 40 }) }),
    }),
    Object.freeze({
        id: 'mentor',
        name: 'Mentor',
        describe: 'Someone who teaches you: approval follows your progress. Never romantic (desire stays at 0 or below).',
        meters: Object.freeze([
            Object.freeze({ name: 'Approval', min: 0, max: 100, start: 10, tone: 'accent', describe: 'rises when you heed their lessons and show progress; falls when you ignore advice or act recklessly', bands: 'unimpressed 25, hopeful 60, proud' }),
        ]),
        ladder: Object.freeze([
            Object.freeze({ name: 'Student', needs: 'approval 10' }),
            Object.freeze({ name: 'Apprentice', needs: 'approval 40, trust 30' }),
            Object.freeze({ name: 'Protégé', needs: 'approval 70, trust 50', milestone: 'passed their trial' }),
        ]),
        limits: Object.freeze({ desire: Object.freeze({ ceiling: 0 }) }),
    }),
]);

/** One meter's limits from a record ({ ceiling, floor }, either optional): whole numbers only. */
export function normalizeLimit(raw) {
    if (!isObject(raw)) return null;
    const ceiling = intOr(raw.ceiling ?? raw.max, null);
    const floor = intOr(raw.floor ?? raw.min, null);
    const out = {};
    if (ceiling !== null) out.ceiling = Math.max(-1000, Math.min(1000, ceiling));
    if (floor !== null) out.floor = Math.max(-1000, Math.min(1000, floor));
    if (out.ceiling !== undefined && out.floor !== undefined && out.floor > out.ceiling) return null;
    return Object.keys(out).length ? out : null;
}

/** Limits by meter id: { trust: { ceiling: 60 } } (at most 24 meters; bad entries left out). */
export function normalizeLimits(raw) {
    const out = {};
    if (!isObject(raw)) return out;
    for (const [name, value] of Object.entries(raw).slice(0, 24)) {
        const id = presetSlug(name);
        const limit = normalizeLimit(value);
        if (id && limit && !['__proto__', 'constructor', 'prototype'].includes(id)) out[id] = limit;
    }
    return out;
}

/**
 * One preset from a built-in or pack record, cleaned: { id, name, describe, builtIn, meters, ladder,
 * limits }, or null when it has no name or nothing in it. `id`: the record's own (a pack's
 * `pack.<pack>/<slug>`), else its name's slug.
 */
export function normalizePreset(raw, { builtIn = false } = {}) {
    if (!isObject(raw)) return null;
    const name = clean(raw.title ?? raw.name, NAME_MAX);
    const given = typeof raw.id === 'string' ? clean(raw.id, ID_MAX) : '';
    const id = given && /^[\p{L}\p{N}][\p{L}\p{N}._/-]*$/u.test(given) ? given : presetSlug(raw.slug || name);
    if (!name || !id) return null;
    const meters = (Array.isArray(raw.meters) ? raw.meters : []).filter(isObject).slice(0, 6).map(meter => ({ ...meter }));
    // A built-in rung's `milestone` is a story milestone it needs. A pack's stage (Story Block
    // PACKS.md `meterPresets`) is reached on its needs alone; its `milestone` is the line the story is
    // told when the stage is first reached (kept as the rung's `cue`).
    const ladder = (Array.isArray(raw.ladder ?? raw.stages) ? (raw.ladder ?? raw.stages) : []).filter(isObject).slice(0, PRESET_LADDER_MAX)
        .map(rung => ({
            name: clean(rung.name, NAME_MAX),
            needs: typeof rung.needs === 'string' ? clean(rung.needs, 120) : rung.needs,
            ...(builtIn ? { milestone: clean(rung.milestone, 60) } : { cue: clean(rung.cue ?? rung.milestone, 200) }),
        }))
        .filter(rung => rung.name);
    const limits = normalizeLimits(raw.limits);
    if (!meters.length && !ladder.length && !Object.keys(limits).length) return null;
    const pack = typeof raw.pack === 'string' ? clean(raw.pack, ID_MAX) : '';
    return { id, name, describe: clean(raw.describe ?? raw.description, DESCRIBE_MAX), builtIn, meters, ladder, limits, ...(pack ? { pack } : {}) };
}

/**
 * Every preset the reader may use: the built-in ones, then the packs' `meterPresets` records (as
 * `packs.content` gives them), at most twelve, one per id (the first one wins).
 */
export function presetCatalog(packRecords = []) {
    const out = [];
    const seen = new Set();
    const add = preset => {
        if (!preset || seen.has(preset.id) || out.length >= MAX_PRESETS) return;
        seen.add(preset.id);
        out.push(preset);
    };
    for (const preset of BUILT_IN_PRESETS) add(normalizePreset(preset, { builtIn: true }));
    for (const record of Array.isArray(packRecords) ? packRecords : []) add(normalizePreset(record));
    return out;
}

/** The preset ids a settings value names (`presets`: ids or { id } rows), cleaned, at most twelve. */
export function presetIds(value) {
    const out = [];
    for (const item of Array.isArray(value) ? value : []) {
        const id = clean(isObject(item) ? item.id ?? item.preset : item, ID_MAX);
        if (id && !out.includes(id) && out.length < MAX_PRESETS) out.push(id);
    }
    return out;
}
