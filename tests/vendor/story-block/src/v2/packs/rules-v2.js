// Rules pack v2 schema, constants, validation, expansion, and export (SPEC §7, §4, §9, §10; pure).
//
// Contract for every exported function: it never throws. Hostile input (null entries, revoked or
// throwing Proxies, getters, cycles, shared-reference graphs, deep nesting) comes back as the
// module's stable error result, `{ ok: false, errors: [{ code, path, message }] }`, using
// BAD_SCHEMA (or the function's own documented failure code: powerScore BAD_FORM, generatePowerUp
// BAD_RULES). All untrusted values are read once into a detached plain copy (readPlain) and the
// rest of the module only ever touches that copy.
//
// Two hashes, two names:
//   rulesHash  the contract's H: SHA-256 of the normalised authored manifest and owned content
//              + the schema + the constants. expandRulesV2 computes it.
//   packHash   SHA-256 of the whole canonical pack (the envelope too: id, version, name, requires,
//              currency ...) + the schema + the constants. validateRulesPack and exportRulesV2
//              return it next to rulesHash.
// Both are stable: the same authored data, in any key order and any equivalent spelling, gives
// the same value.

import { rulesV2SchemaSource } from './rules-v2.schema.js';
import { byteLength, unsafeText } from './safety.js';
import { parseRange } from './version.js';
import { PACK_FIELDS, PACK_ID, SLUG, SEMVER, DEF_ID, CONTENT_KINDS, LIMITS } from './limits.js';
import { validatePack, slugify, HOST_VERSION } from './validate.js';

/** Deeply freezes an object or array and all nested structures. */
function deepFreeze(object) {
    if (object === null || typeof object !== 'object') return object;
    Object.freeze(object);
    for (const value of Object.values(object)) {
        if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
            deepFreeze(value);
        }
    }
    return object;
}

/** Deeply frozen JSON Schema for rules-v2 manifests and owned defs. */
export const rulesV2Schema = deepFreeze(rulesV2SchemaSource);

/** The capability a pack with content.rules must declare in requires.capabilities. */
export const RULES_V2_CAPABILITY = 'rb-rules-v2';

/** Canonical 7 stats defined in SPEC §4. */
export const RULES_V2_STATS = rulesV2Schema.$defs.stat.enum;

/** Canonical 8 equipment slots defined in SPEC §4. */
export const RULES_V2_SLOTS = rulesV2Schema.$defs.slot.enum;

/** Rules v2 constants with approved defaults from SPEC §4. */
export const RULES_V2_CONSTANTS = deepFreeze({
    levelCap: 99,
    startLevel: 1,
    startStat: 5,
    startPoints: 10,
    pointsPerLevel: 4,
    statCap: 99,
    xpPerLevel: 100,
    masteryAt: [1, 5, 12, 22, 35],
    usePerSkillReply: 2,
    usePerSkillDay: 10,
    usePerActorReply: 6,
    usePerActorDay: 30,
    trainMinutes: 60,
    trainCredits: 2,
    trainEventPercent: 10,
    promotionMilestones: [10, 20, 30],
    pathMilestones: [40, 50, 60, 70, 80, 90],
    classBudget: [12, 24, 36, 48],
    pathBudgetIncrement: 12,
    deathDc: 15,
    injuryMinutes: 1440,
    injuryCheckPenalty: -2,
    temporaryLimit: 6,
    promptChars: 2000,
    difficulty: 'normal',
    clockMinutesPerDay: 1440,
});

/** Rules v2 pack limits and resolved bounds from SPEC §7. */
export const RULES_V2_LIMITS = deepFreeze({
    packBytes: 512 * 1024,
    installedBytes: 2 * 1024 * 1024,
    depth: 16,
    keys: 200,
    array: 1000,
    string: 4000,
    name: rulesV2Schema.$defs.name.maxLength,
    note: rulesV2Schema.$defs.note.maxLength,
    slug: rulesV2Schema.$defs.slug.maxLength,
    forms: 2048,
    nodes: 100000,
    errors: 20,
    branches: rulesV2Schema.properties.branches.maxItems,
    itemRules: rulesV2Schema.properties.itemRules.maxItems,
    trainers: rulesV2Schema.properties.trainers.maxItems,
    resolvedBytes: 2 * 1024 * 1024,
});

/** Progression structure describing class tiers, skills, mastery, and pathways. */
export const RULES_V2_PROGRESSION = deepFreeze({
    tiers: [0, 1, 2, 3],
    tierLevels: { 0: 0, 1: 10, 2: 20, 3: 30 },
    skillsPerClass: 3,
    maxMastery: 5,
    pathwaySteps: 2,
    writtenChoices: ['a', 'b'],
    generatedChoice: 'g',
    graph: {
        perSkill: { written: 8, generated: 4, total: 12 },
        perClass: { written: 24, generated: 12, total: 36 },
    },
});

/** Stable error codes for rules-v2 validation and checking. */
export const RULES_V2_ERROR_CODES = deepFreeze({
    ENVELOPE_UNKNOWN: 'envelope-unknown',
    BAD_CAPABILITY: 'bad-capability',
    UNSAFE_MARKUP: 'unsafe-markup',
    UNSAFE_KEY: 'unsafe-key',
    CONTROL_CHARACTER: 'control-character',
    DUP_ID: 'dup-id',
    TIER_CHAIN: 'tier-chain',
    CLASS_SKILLS: 'class-skills',
    BRANCH_GRAPH: 'branch-graph',
    NUMERIC_RANGE: 'numeric-range',
    BAD_TRANSFORM: 'bad-transform',
    BAD_EFFECT: 'bad-effect',
    MP_SP_CONFLICT: 'mp-sp-conflict',
    NUMERIC_ONLY_BRANCH: 'numeric-only-branch',
    BUDGET_CLOSURE: 'budget-closure',
    BAD_REF: 'bad-ref',
    TOO_LARGE: 'too-large',
    ITEM_RULE_MISMATCH: 'item-rule-mismatch',
    BAD_XP_PER_LEVEL: 'bad-xp-per-level',
    BAD_SCHEMA: 'bad-schema',
    STEP_LIMIT: 'step-limit',
    BAD_FORM: 'bad-form',
    BAD_RULES: 'bad-rules',
    // Story Block's own code for a missing capability (validate.js), kept as written there.
    MISSING_CAPABILITY: 'MISSING_CAPABILITY',
});

const RECORD_ID_REGEX = /^[a-z][a-z0-9]*_[0-9a-z]{8}$/;
const DEF_ID_REGEX = /^[a-z0-9]+(?:[._-][a-z0-9]+)*\/[a-z0-9]+(?:[_-][a-z0-9]+)*$/;
const REF_REGEX = /^(?:pack\.[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// Canonical ids of things the story or the map owns, resolved at activation (SPEC §7).
const EXTERNAL_IDS = Object.freeze({
    place: /^pl_[0-9a-z]{8}$/,
    npc: /^np_[0-9a-z]{8}$/,
    thread: /^th_[0-9a-z]{8}$/,
});

const fail = (code, path, message) => ({ ok: false, errors: [{ code, path, message }] });
const unreadable = (code = RULES_V2_ERROR_CODES.BAD_SCHEMA) => fail(code, '', 'Input could not be read safely');

/**
 * Pure JavaScript synchronous SHA-256 implementation.
 * Browser-compatible, zero Node builtins, deterministic.
 */
function sha256Bytes(bytes) {
    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

    const K = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];

    const l = bytes.length;
    const bitLen = l * 8;
    const padLen = ((l + 8) >> 6) + 1 << 6;
    const padded = new Uint8Array(padLen);
    padded.set(bytes);
    padded[l] = 0x80;

    const view = new DataView(padded.buffer);
    view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false);
    view.setUint32(padLen - 4, bitLen >>> 0, false);

    const w = new Uint32Array(64);

    for (let i = 0; i < padLen; i += 64) {
        for (let t = 0; t < 16; t++) {
            w[t] = view.getUint32(i + t * 4, false);
        }
        for (let t = 16; t < 64; t++) {
            const s0 = ((w[t - 15] >>> 7) | (w[t - 15] << 25)) ^
                       ((w[t - 15] >>> 18) | (w[t - 15] << 14)) ^
                       (w[t - 15] >>> 3);
            const s1 = ((w[t - 2] >>> 17) | (w[t - 2] << 15)) ^
                       ((w[t - 2] >>> 19) | (w[t - 2] << 13)) ^
                       (w[t - 2] >>> 10);
            w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
        }

        let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;

        for (let t = 0; t < 64; t++) {
            const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
            const ch = (e & f) ^ (~e & g);
            const temp1 = (h + S1 + ch + K[t] + w[t]) >>> 0;
            const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (S0 + maj) >>> 0;

            h = g;
            g = f;
            f = e;
            e = (d + temp1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (temp1 + temp2) >>> 0;
        }

        h0 = (h0 + a) >>> 0;
        h1 = (h1 + b) >>> 0;
        h2 = (h2 + c) >>> 0;
        h3 = (h3 + d) >>> 0;
        h4 = (h4 + e) >>> 0;
        h5 = (h5 + f) >>> 0;
        h6 = (h6 + g) >>> 0;
        h7 = (h7 + h) >>> 0;
    }

    return [h0, h1, h2, h3, h4, h5, h6, h7]
        .map(x => x.toString(16).padStart(8, '0'))
        .join('');
}

/**
 * SHA-256 of a string (UTF-8), Uint8Array or ArrayBuffer as lowercase hex.
 * Never throws: any other input returns `{ ok: false, errors: [BAD_SCHEMA] }`.
 */
export function sha256(input) {
    try {
        if (typeof input === 'string') return sha256Bytes(new TextEncoder().encode(input));
        if (input instanceof Uint8Array) return sha256Bytes(input);
        if (input instanceof ArrayBuffer) return sha256Bytes(new Uint8Array(input));
        return fail(RULES_V2_ERROR_CODES.BAD_SCHEMA, '', 'sha256 input must be a string, Uint8Array or ArrayBuffer');
    } catch {
        return unreadable();
    }
}

/** Sorts object keys (after NFC) alphabetically at every level; array order is kept. Plain data only. */
function sortKeys(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(sortKeys);
    const normalized = new Map();
    for (const key of Object.keys(value)) normalized.set(key.normalize('NFC'), key);
    const sorted = {};
    for (const key of [...normalized.keys()].sort()) sorted[key] = sortKeys(value[normalized.get(key)]);
    return sorted;
}

/**
 * Canonical form of plain JSON data: object keys NFC-normalised and sorted at every level, array
 * order kept, -0 written as 0. Reads the input once into a detached copy first, so it never throws
 * and never runs accessors; unreadable input (cycles, accessors, Proxies that throw, depth over 16,
 * more than RULES_V2_LIMITS.nodes values, keys that collide after NFC) returns the error result.
 */
export function canonicalizeJson(value) {
    try {
        const read = readPlain(value, { text: false });
        if (read.errors.length) return { ok: false, errors: read.errors };
        return sortKeys(read.value);
    } catch {
        return unreadable();
    }
}

/** Unicode normalization: NFC, line endings to \n, outer whitespace trimmed. */
function normalizeString(val) {
    if (typeof val !== 'string') return val;
    return val.normalize('NFC').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

/** Pure plain clone of values already read by readPlain (or built by this module). */
function clonePlain(val) {
    if (val === null || typeof val !== 'object') return val;
    if (Array.isArray(val)) return val.map(clonePlain);
    const out = {};
    for (const key of Object.keys(val)) {
        out[key] = clonePlain(val[key]);
    }
    return out;
}

/** Normalizes every string value (NFC, newlines, trim) and every object key (NFC) without mutation. */
function normalizeStructure(val) {
    if (typeof val === 'string') return normalizeString(val);
    if (val === null || typeof val !== 'object') return val;
    if (Array.isArray(val)) return val.map(normalizeStructure);
    const out = {};
    for (const [k, v] of Object.entries(val)) {
        out[k.normalize('NFC')] = normalizeStructure(v);
    }
    return out;
}

const NAMED_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: '\'' };
const codePointText = number => String.fromCodePoint(Number.isFinite(number) && number <= 0x10ffff ? number : 0xfffd);

/** Character references decoded the way a browser does (semicolon optional), repeatedly, at most three passes. */
function decodeMarkupEntities(text) {
    let current = text;
    for (let pass = 0; pass < 3; pass++) {
        const next = current
            .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => codePointText(parseInt(hex, 16)))
            .replace(/&#(\d+);?/g, (_, dec) => codePointText(Number(dec)))
            .replace(/&(lt|gt|amp|quot|apos);?/gi, (_, name) => NAMED_ENTITIES[name.toLowerCase()]);
        if (next === current) break;
        current = next;
    }
    return current;
}

// Controls other than tab, newline and carriage return are refused in text. Keys refuse all of them.
const CONTROL_IN_TEXT = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/;
const CONTROL_IN_KEY = /[\x00-\x1F\x7F-\x9F]/;

// What the rules checker owns, and so holds to its stricter text rule: the manifest and the definitions it validates
// (creatures, quests, shops, recipes). Everything else in a pack (the envelope, items, places, events, screens, theme,
// layouts ...) belongs to Story Block's validator, so "<" and ">" are not the checker's business there: a version range
// (`>=2.0.0`), a condition (`gold > 5`) or a screen template is read as in an ordinary pack.
const OUTSIDE_NODES = 300000;
const OWNED_TEXT = /^content\.(?:rules|creatures|quests|shops|recipes)(?:[.[]|$)/;
// A screen's template or css may be longer (Story Block's `limits.code`), wherever a field of that name sits.
const CODE_TEXT = /(?:^|\.)(?:template|css)(?:\[\d+\])*$/;

/**
 * Why a string (a value or, with `isKey`, an object key) cannot be pack text, or null when fine. `kind`:
 * * 'owned' (the default): Story Block's own safety scan (safety.js unsafeText: script-like tags, on... attributes,
 *   javascript: and data: links, with entities and hidden characters removed first), and also "<" and ">" banned
 *   outright, written plainly or as a character reference (`&#60;script&#62;`), and control characters;
 * * 'outside' (what Story Block owns, when the checker is also doing the envelope pass): the same, except that
 *   plain "<" and ">" are allowed;
 * * 'host' (what Story Block owns, when Story Block has already scanned it): unsafeText and nothing more.
 */
function textProblem(text, isKey = false, kind = 'owned') {
    if (kind === 'host') return plainProblem(text);
    if (kind === 'owned' && (text.includes('<') || text.includes('>'))) {
        return { code: RULES_V2_ERROR_CODES.UNSAFE_MARKUP, message: isKey ? 'Key cannot contain "<" or ">"' : 'Text cannot contain "<" or ">"' };
    }
    const spelled = kind === 'owned' ? text : text.replace(/[<>]/g, '');
    if (spelled.includes('&') && /[<>]/.test(decodeMarkupEntities(spelled))) {
        return { code: RULES_V2_ERROR_CODES.UNSAFE_MARKUP, message: 'Text cannot contain "<" or ">" written as a character reference' };
    }
    const why = unsafeText(text);
    if (why) return { code: RULES_V2_ERROR_CODES.UNSAFE_MARKUP, message: `Text ${why}` };
    if (!isKey && CONTROL_IN_TEXT.test(text)) {
        return { code: RULES_V2_ERROR_CODES.CONTROL_CHARACTER, message: 'Text cannot contain control characters' };
    }
    return null;
}

/** Story Block's own text rule, for what the checker does not own: unsafeText and nothing more. */
function plainProblem(text) {
    const why = unsafeText(text);
    return why ? { code: RULES_V2_ERROR_CODES.UNSAFE_MARKUP, message: `Text ${why}` } : null;
}

/**
 * Reads untrusted data once into a detached plain copy: `{ errors, value }` (value is undefined when
 * there are errors). Uses property descriptors and plain prototypes only, so no getter or Proxy
 * trap result is trusted twice, and everything after this works on the copy.
 *
 * Refuses: values that are not JSON (undefined, functions, symbols, bigint, NaN/Infinity), cycles,
 * non-plain prototypes, accessors, non-enumerable or extra array properties, sparse arrays, symbol
 * keys, reserved keys, control characters in keys, keys that collide after NFC, depth >= limits.depth,
 * arrays over limits.array, objects over limits.keys, strings over limits.string, and more than
 * limits.nodes visited values in total (a shared reference counts every time it is reached, so a
 * small graph of repeated references cannot blow up). -0 becomes 0. With `text` (the default) every
 * string and key also goes through textProblem (the markup and link scan).
 */
function readPlain(root, { path: rootPath = '', limits = RULES_V2_LIMITS, text = true, packwide = false, host = false } = {}) {
    // `packwide`: the data is a whole pack or its content, where only the manifest and the definitions the checker owns get its
    // strict text rule (OWNED_TEXT) and the rest is Story Block's (`host`: Story Block has scanned it; else the checker's lighter
    // 'outside' rule). Anything else read here (a form, a manifest alone) is the checker's own and strict.
    const kindOf = path => (!packwide || OWNED_TEXT.test(path) ? 'owned' : host ? 'host' : 'outside');
    const errors = [];
    const add = (code, path, message) => { if (errors.length < limits.errors) errors.push({ code, path, message }); };
    const active = new Set();
    const child = (path, key) => (path ? `${path}.${key}` : key);
    let nodes = 0;
    let outsideNodes = 0;
    let stopped = false;

    function visitObject(node, path, depth) {
        if (active.has(node)) {
            add(RULES_V2_ERROR_CODES.BAD_SCHEMA, path, 'Circular reference detected');
            return undefined;
        }
        if (depth >= limits.depth) {
            add(RULES_V2_ERROR_CODES.TOO_LARGE, path, `Object nested ${depth} levels deep; maximum allowed is ${limits.depth - 1}`);
            return undefined;
        }
        const isArr = Array.isArray(node);
        const proto = Object.getPrototypeOf(node);
        if (proto !== (isArr ? Array.prototype : Object.prototype) && !(proto === null && !isArr)) {
            add(RULES_V2_ERROR_CODES.BAD_SCHEMA, path, 'Unsupported object prototype');
            return undefined;
        }
        active.add(node);
        try {
            if (isArr) {
                const length = node.length;
                if (length > limits.array) {
                    add(RULES_V2_ERROR_CODES.TOO_LARGE, path, `Array has more than ${limits.array} entries`);
                    return undefined;
                }
                const values = new Array(length);
                let count = 0;
                for (const key of Reflect.ownKeys(node)) {
                    if (key === 'length') continue;
                    if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length) {
                        add(RULES_V2_ERROR_CODES.BAD_SCHEMA, `${path}.${String(key)}`, 'Array has invalid property key or extra properties');
                        return undefined;
                    }
                    const desc = Object.getOwnPropertyDescriptor(node, key);
                    if (!desc || !desc.enumerable) {
                        add(RULES_V2_ERROR_CODES.BAD_SCHEMA, `${path}[${key}]`, 'Non-enumerable array property is forbidden');
                        return undefined;
                    }
                    if (desc.get || desc.set) {
                        add(RULES_V2_ERROR_CODES.BAD_SCHEMA, `${path}[${key}]`, 'Property accessor is forbidden');
                        return undefined;
                    }
                    values[Number(key)] = desc.value;
                    count += 1;
                }
                if (count !== length) {
                    let hole = 0;
                    while (hole in values) hole += 1;
                    add(RULES_V2_ERROR_CODES.BAD_SCHEMA, `${path}[${hole}]`, 'Sparse arrays are forbidden');
                    return undefined;
                }
                const out = [];
                for (let i = 0; i < length; i++) out.push(visit(values[i], `${path}[${i}]`, depth + 1));
                return out;
            }
            const keys = Reflect.ownKeys(node);
            if (keys.length > limits.keys) {
                add(RULES_V2_ERROR_CODES.TOO_LARGE, path, `Object has more than ${limits.keys} fields`);
                return undefined;
            }
            const out = {};
            const seenKeys = new Set();
            for (const key of keys) {
                if (typeof key === 'symbol') {
                    add(RULES_V2_ERROR_CODES.BAD_SCHEMA, path, 'Symbol keys are forbidden');
                    continue;
                }
                const at = child(path, key);
                if (UNSAFE_KEYS.has(key)) {
                    add(RULES_V2_ERROR_CODES.UNSAFE_KEY, at, `Reserved key "${key}" is forbidden`);
                    continue;
                }
                if (key.length > limits.string) {
                    add(RULES_V2_ERROR_CODES.TOO_LARGE, path, `Key is longer than ${limits.string} characters`);
                    continue;
                }
                // A key keeps the strict rule unless Story Block has scanned it: "<" in a field name is never a version range or a condition.
                const kind = kindOf(at) === 'host' ? 'host' : 'owned';
                if (kind !== 'host' && CONTROL_IN_KEY.test(key)) {
                    add(RULES_V2_ERROR_CODES.CONTROL_CHARACTER, at, 'Key cannot contain control characters');
                    continue;
                }
                if (text) {
                    const problem = textProblem(key, true, kind);
                    if (problem) {
                        add(problem.code, at, problem.message);
                        continue;
                    }
                }
                // Keys that collide after NFC are refused in what the checker owns (Story Block does not look at its own).
                if (kindOf(at) === 'owned') {
                    const normalized = key.normalize('NFC');
                    if (seenKeys.has(normalized)) {
                        add(RULES_V2_ERROR_CODES.DUP_ID, at, `Key "${normalized}" appears twice once Unicode-normalized`);
                        continue;
                    }
                    seenKeys.add(normalized);
                }
                const desc = Object.getOwnPropertyDescriptor(node, key);
                if (!desc || !desc.enumerable) {
                    add(RULES_V2_ERROR_CODES.BAD_SCHEMA, at, 'Non-enumerable property is forbidden');
                    continue;
                }
                if (desc.get || desc.set) {
                    add(RULES_V2_ERROR_CODES.BAD_SCHEMA, at, 'Property accessor is forbidden');
                    continue;
                }
                out[key] = visit(desc.value, at, depth + 1);
            }
            return out;
        } finally {
            active.delete(node);
        }
    }

    function visit(node, path, depth) {
        if (stopped || errors.length >= limits.errors) return undefined;
        // The budget of values is for what the checker owns; what Story Block owns only counts against a larger one, which a file of
        // 512 KiB cannot reach (about 260,000 values at most), so it stops shared references and nothing a pack can honestly hold.
        if (kindOf(path) === 'owned') {
            nodes += 1;
            if (nodes > limits.nodes) {
                stopped = true;
                add(RULES_V2_ERROR_CODES.TOO_LARGE, path, `More than ${limits.nodes} values; a shared reference counts every time it is reached`);
                return undefined;
            }
        } else {
            outsideNodes += 1;
            if (outsideNodes > OUTSIDE_NODES) {
                stopped = true;
                add(RULES_V2_ERROR_CODES.TOO_LARGE, path, `More than ${OUTSIDE_NODES} values outside the rules; a shared reference counts every time it is reached`);
                return undefined;
            }
        }
        if (node === null || typeof node === 'boolean') return node;
        if (typeof node === 'string') {
            const kind = kindOf(path);
            const max = kind !== 'owned' && CODE_TEXT.test(path) ? LIMITS.code : limits.string;
            if (node.length > max) {
                add(RULES_V2_ERROR_CODES.TOO_LARGE, path, `String is longer than ${max} characters`);
                return undefined;
            }
            if (text) {
                const problem = textProblem(node, false, kind);
                if (problem) {
                    add(problem.code, path, problem.message);
                    return undefined;
                }
            }
            return node;
        }
        if (typeof node === 'number') {
            if (!Number.isFinite(node)) {
                add(RULES_V2_ERROR_CODES.NUMERIC_RANGE, path, 'Number must be finite');
                return undefined;
            }
            return node === 0 ? 0 : node;
        }
        if (typeof node !== 'object') {
            add(RULES_V2_ERROR_CODES.BAD_SCHEMA, path, `Unsupported value type: ${typeof node}`);
            return undefined;
        }
        try {
            return visitObject(node, path, depth);
        } catch {
            add(RULES_V2_ERROR_CODES.BAD_SCHEMA, path, 'Value could not be read safely');
            return undefined;
        }
    }

    const value = visit(root, rootPath, 0);
    return errors.length ? { errors, value: undefined } : { errors, value };
}

/** Reads an options bag (`{ packKey, constants, capabilities }`) the same safe way; missing means {}. */
function readOptions(rawOptions) {
    if (rawOptions === undefined || rawOptions === null) return { ok: true, options: {} };
    if (typeof rawOptions !== 'object' || Array.isArray(rawOptions)) return { ok: true, options: {} };
    const read = readPlain(rawOptions, { path: 'options', text: false });
    if (read.errors.length) return { ok: false, errors: read.errors };
    return { ok: true, options: read.value };
}

/**
 * Validates Constants argument against frozen specification.
 * Fixed literal fields and budgets cannot be overridden. Unknown keys rejected.
 * Reads the argument through readPlain; never calls JSON.stringify on untrusted input.
 */
function validateConstants(constants) {
    if (constants === undefined || constants === null) {
        return { ok: true, constants: RULES_V2_CONSTANTS };
    }
    if (typeof constants !== 'object' || Array.isArray(constants)) {
        return { ok: false, errors: [{ code: RULES_V2_ERROR_CODES.BAD_SCHEMA, path: 'constants', message: 'Constants must be an object' }] };
    }
    const read = readPlain(constants, { path: 'constants', text: false });
    if (read.errors.length) return { ok: false, errors: read.errors };
    constants = read.value;

    const allowedKeys = new Set(Object.keys(RULES_V2_CONSTANTS));
    for (const k of Object.keys(constants)) {
        if (!allowedKeys.has(k)) {
            return { ok: false, errors: [{ code: RULES_V2_ERROR_CODES.BAD_SCHEMA, path: `constants.${k}`, message: `Unknown constant "${k}"` }] };
        }
    }
    const fixedScalar = [
        'levelCap', 'startLevel', 'startStat', 'startPoints', 'pointsPerLevel', 'statCap',
        'usePerSkillReply', 'usePerSkillDay', 'usePerActorReply', 'usePerActorDay',
        'trainMinutes', 'trainCredits', 'trainEventPercent',
        'pathBudgetIncrement', 'deathDc', 'injuryMinutes', 'injuryCheckPenalty', 'temporaryLimit',
        'difficulty', 'clockMinutesPerDay'
    ];
    for (const f of fixedScalar) {
        if (constants[f] !== undefined && constants[f] !== RULES_V2_CONSTANTS[f]) {
            return { ok: false, errors: [{ code: RULES_V2_ERROR_CODES.BAD_SCHEMA, path: `constants.${f}`, message: `Constant "${f}" is fixed and cannot be overridden` }] };
        }
    }

    const fixedArrays = ['masteryAt', 'promotionMilestones', 'pathMilestones', 'classBudget'];
    for (const f of fixedArrays) {
        if (constants[f] !== undefined) {
            const expected = RULES_V2_CONSTANTS[f];
            if (!Array.isArray(constants[f]) || constants[f].length !== expected.length || !constants[f].every((v, i) => v === expected[i])) {
                return { ok: false, errors: [{ code: RULES_V2_ERROR_CODES.BAD_SCHEMA, path: `constants.${f}`, message: `Constant "${f}" is fixed and cannot be overridden` }] };
            }
        }
    }

    let xpPerLevel = RULES_V2_CONSTANTS.xpPerLevel;
    if (constants.xpPerLevel !== undefined) {
        const xpDef = rulesV2Schema.$defs.xpPerLevel;
        const val = constants.xpPerLevel;
        if (typeof val !== 'number' || !Number.isSafeInteger(val) ||
            (xpDef.minimum !== undefined && val < xpDef.minimum) ||
            (xpDef.maximum !== undefined && val > xpDef.maximum) ||
            (xpDef.multipleOf !== undefined && val % xpDef.multipleOf !== 0)) {
            return { ok: false, errors: [{ code: RULES_V2_ERROR_CODES.BAD_XP_PER_LEVEL, path: 'constants.xpPerLevel', message: `xpPerLevel must be integer between ${xpDef.minimum} and ${xpDef.maximum} and a multiple of ${xpDef.multipleOf}` }] };
        }
        xpPerLevel = val;
    }

    let promptChars = RULES_V2_CONSTANTS.promptChars;
    if (constants.promptChars !== undefined) {
        const val = constants.promptChars;
        if (typeof val !== 'number' || !Number.isSafeInteger(val) || val < 500 || val > 8000) {
            return { ok: false, errors: [{ code: RULES_V2_ERROR_CODES.NUMERIC_RANGE, path: 'constants.promptChars', message: 'promptChars must be a safe integer between 500 and 8000' }] };
        }
        promptChars = val;
    }

    const merged = deepFreeze({
        ...RULES_V2_CONSTANTS,
        xpPerLevel,
        promptChars,
    });
    return { ok: true, constants: merged };
}

/** Target factor mapping per SPEC §7 & B3/P06. */
function targetFactor(target) {
    if (target === 'one' || target === 'self' || target === 'ally') return 1;
    if (target === 'all' || target === 'allies') return 3;
    return null;
}

const LEGAL_ELEMENTS = new Set(['none', 'fire', 'ice', 'lightning', 'poison', 'holy']);
const HARMFUL_CONDITIONS = new Set(['poison', 'burn', 'bleed', 'stun', 'daze', 'slow', 'weaken']);
const FRIENDLY_CONDITIONS = new Set(['regen', 'guard']);
const LEGAL_FORM_TYPES = new Set(['physical', 'magic', 'heal', 'buff', 'debuff']);

/** Validates an effect structure and semantics strictly per SPEC §7 & schema. */
function validateSingleEffect(eff, path = 'effects') {
    if (!eff || typeof eff !== 'object' || Array.isArray(eff)) {
        return { ok: false, error: { code: RULES_V2_ERROR_CODES.BAD_EFFECT, path, message: 'Effect must be an object' } };
    }

    if (eff.op === 'damage') {
        const allowedKeys = new Set(['op', 'target', 'power', 'element', 'damageType']);
        for (const k of Object.keys(eff)) {
            if (!allowedKeys.has(k)) {
                return { ok: false, error: { code: RULES_V2_ERROR_CODES.BAD_EFFECT, path: `${path}.${k}`, message: `Unknown field "${k}" in damage effect` } };
            }
        }
        if (eff.damageType !== 'physical' && eff.damageType !== 'magic') {
            return { ok: false, error: { code: RULES_V2_ERROR_CODES.BAD_EFFECT, path: `${path}.damageType`, message: 'Damage effect requires damageType "physical" or "magic"' } };
        }
        if (eff.target !== 'one' && eff.target !== 'all') {
            return { ok: false, error: { code: RULES_V2_ERROR_CODES.BAD_EFFECT, path: `${path}.target`, message: 'Damage effect must target "one" or "all"' } };
        }
        if (!LEGAL_ELEMENTS.has(eff.element)) {
            return { ok: false, error: { code: RULES_V2_ERROR_CODES.BAD_EFFECT, path: `${path}.element`, message: `Invalid element "${eff.element}"` } };
        }
        if (typeof eff.power !== 'number' || !Number.isSafeInteger(eff.power) || eff.power < 1 || eff.power > 1000) {
            return { ok: false, error: { code: RULES_V2_ERROR_CODES.NUMERIC_RANGE, path: `${path}.power`, message: 'Power must be safe integer 1 to 1000' } };
        }
        return { ok: true, score: Math.ceil(eff.power / 10) * targetFactor(eff.target) };
    }

    if (eff.op === 'heal' || eff.op === 'shield') {
        const allowedKeys = new Set(['op', 'target', 'power', 'element', 'damageType']);
        for (const k of Object.keys(eff)) {
            if (!allowedKeys.has(k)) {
                return { ok: false, error: { code: RULES_V2_ERROR_CODES.BAD_EFFECT, path: `${path}.${k}`, message: `Unknown field "${k}" in ${eff.op} effect` } };
            }
        }
        if (eff.damageType !== null) {
            return { ok: false, error: { code: RULES_V2_ERROR_CODES.BAD_EFFECT, path: `${path}.damageType`, message: 'Heal and shield effects require damageType null' } };
        }
        if (eff.target !== 'self' && eff.target !== 'ally' && eff.target !== 'allies') {
            return { ok: false, error: { code: RULES_V2_ERROR_CODES.BAD_EFFECT, path: `${path}.target`, message: 'Heal and shield effects must target friends ("self", "ally", "allies")' } };
        }
        if (!LEGAL_ELEMENTS.has(eff.element)) {
            return { ok: false, error: { code: RULES_V2_ERROR_CODES.BAD_EFFECT, path: `${path}.element`, message: `Invalid element "${eff.element}"` } };
        }
        if (typeof eff.power !== 'number' || !Number.isSafeInteger(eff.power) || eff.power < 1 || eff.power > 1000) {
            return { ok: false, error: { code: RULES_V2_ERROR_CODES.NUMERIC_RANGE, path: `${path}.power`, message: 'Power must be safe integer 1 to 1000' } };
        }
        return { ok: true, score: Math.ceil(eff.power / 10) * targetFactor(eff.target) };
    }

    if (eff.op === 'condition') {
        const allowedKeys = new Set(['op', 'target', 'kind', 'chance', 'rounds']);
        for (const k of Object.keys(eff)) {
            if (!allowedKeys.has(k)) {
                return { ok: false, error: { code: RULES_V2_ERROR_CODES.BAD_EFFECT, path: `${path}.${k}`, message: `Unknown field "${k}" in condition effect` } };
            }
        }
        if (HARMFUL_CONDITIONS.has(eff.kind)) {
            if (eff.target !== 'one' && eff.target !== 'all') {
                return { ok: false, error: { code: RULES_V2_ERROR_CODES.BAD_EFFECT, path: `${path}.target`, message: `Harmful condition "${eff.kind}" must target foes ("one" or "all")` } };
            }
        } else if (FRIENDLY_CONDITIONS.has(eff.kind)) {
            if (eff.target !== 'self' && eff.target !== 'ally' && eff.target !== 'allies') {
                return { ok: false, error: { code: RULES_V2_ERROR_CODES.BAD_EFFECT, path: `${path}.target`, message: `Beneficial condition "${eff.kind}" must target friends ("self", "ally", "allies")` } };
            }
        } else {
            return { ok: false, error: { code: RULES_V2_ERROR_CODES.BAD_EFFECT, path: `${path}.kind`, message: `Invalid condition kind "${eff.kind}"` } };
        }
        if (typeof eff.chance !== 'number' || !Number.isSafeInteger(eff.chance) || eff.chance < 1 || eff.chance > 100) {
            return { ok: false, error: { code: RULES_V2_ERROR_CODES.NUMERIC_RANGE, path: `${path}.chance`, message: 'Condition chance must be integer 1 to 100' } };
        }
        if (typeof eff.rounds !== 'number' || !Number.isSafeInteger(eff.rounds) || eff.rounds < 1 || eff.rounds > 6) {
            return { ok: false, error: { code: RULES_V2_ERROR_CODES.NUMERIC_RANGE, path: `${path}.rounds`, message: 'Condition rounds must be integer 1 to 6' } };
        }
        return { ok: true, score: Math.ceil(eff.chance / 25) * eff.rounds * targetFactor(eff.target) };
    }

    if (eff.op === 'stat') {
        const allowedKeys = new Set(['op', 'target', 'stat', 'amount', 'rounds']);
        for (const k of Object.keys(eff)) {
            if (!allowedKeys.has(k)) {
                return { ok: false, error: { code: RULES_V2_ERROR_CODES.BAD_EFFECT, path: `${path}.${k}`, message: `Unknown field "${k}" in stat effect` } };
            }
        }
        if (!RULES_V2_STATS.includes(eff.stat)) {
            return { ok: false, error: { code: RULES_V2_ERROR_CODES.BAD_EFFECT, path: `${path}.stat`, message: `Invalid stat "${eff.stat}"` } };
        }
        if (typeof eff.amount !== 'number' || !Number.isSafeInteger(eff.amount) || eff.amount === 0 || Math.abs(eff.amount) > 10) {
            return { ok: false, error: { code: RULES_V2_ERROR_CODES.NUMERIC_RANGE, path: `${path}.amount`, message: 'Stat amount must be non-zero integer -10 to 10' } };
        }
        if (eff.amount > 0) {
            if (eff.target !== 'self' && eff.target !== 'ally' && eff.target !== 'allies') {
                return { ok: false, error: { code: RULES_V2_ERROR_CODES.BAD_EFFECT, path: `${path}.target`, message: 'Positive stat buff must target friends ("self", "ally", "allies")' } };
            }
        } else {
            if (eff.target !== 'one' && eff.target !== 'all') {
                return { ok: false, error: { code: RULES_V2_ERROR_CODES.BAD_EFFECT, path: `${path}.target`, message: 'Negative stat debuff must target foes ("one" or "all")' } };
            }
        }
        if (typeof eff.rounds !== 'number' || !Number.isSafeInteger(eff.rounds) || eff.rounds < 1 || eff.rounds > 6) {
            return { ok: false, error: { code: RULES_V2_ERROR_CODES.NUMERIC_RANGE, path: `${path}.rounds`, message: 'Stat rounds must be integer 1 to 6' } };
        }
        return { ok: true, score: 2 * Math.abs(eff.amount) * eff.rounds * targetFactor(eff.target) };
    }

    return { ok: false, error: { code: RULES_V2_ERROR_CODES.BAD_EFFECT, path: `${path}.op`, message: `Unknown effect op "${eff.op}"` } };
}

/**
 * Pure power score calculation for a form per SPEC §7 & B3/P06.
 * Target factor 1 for one/self/ally, 3 for all/allies.
 * damage/heal/shield: ceil(power/10), condition: ceil(chance/25)*rounds, stat: 2*abs(amount)*rounds.
 * Sum effect scores times target factor plus 12 if unit is non-null. Safe Count score. Never throws.
 */
export function powerScore(form) {
    try {
        if (!form || typeof form !== 'object' || Array.isArray(form)) {
            return fail(RULES_V2_ERROR_CODES.BAD_FORM, '', 'Form must be an object');
        }
        const read = readPlain(form);
        if (read.errors.length) return { ok: false, errors: read.errors };
        return powerScoreOf(read.value);
    } catch {
        return unreadable(RULES_V2_ERROR_CODES.BAD_FORM);
    }
}

/** powerScore for a form that is already a plain copy (internal callers). */
function powerScoreOf(form) {
    const effects = form.effects ?? form.base?.effects;
    if (!Array.isArray(effects) || effects.length === 0 || effects.length > 4) {
        return { ok: false, errors: [{ code: RULES_V2_ERROR_CODES.BAD_FORM, path: 'effects', message: 'Form must have 1 to 4 effects' }] };
    }

    let total = 0;
    for (let i = 0; i < effects.length; i++) {
        const valRes = validateSingleEffect(effects[i], `effects[${i}]`);
        if (!valRes.ok) return { ok: false, errors: [valRes.error] };
        total += valRes.score;
    }

    const unit = form.unit !== undefined ? form.unit : form.base?.unit;
    if (unit !== null && unit !== undefined) {
        if (typeof unit !== 'object' || Array.isArray(unit)) {
            return { ok: false, errors: [{ code: RULES_V2_ERROR_CODES.BAD_FORM, path: 'unit', message: 'Unit must be an object' }] };
        }
        const allowedUnitKeys = new Set(['kind', 'class', 'statShare', 'poolShare', 'rounds']);
        for (const k of Object.keys(unit)) {
            if (!allowedUnitKeys.has(k)) {
                return { ok: false, errors: [{ code: RULES_V2_ERROR_CODES.BAD_FORM, path: `unit.${k}`, message: `Unknown unit field "${k}"` }] };
            }
        }
        if (unit.kind !== 'summon' && unit.kind !== 'pet') {
            return { ok: false, errors: [{ code: RULES_V2_ERROR_CODES.BAD_FORM, path: 'unit.kind', message: 'Unit kind must be "summon" or "pet"' }] };
        }
        if (typeof unit.class !== 'string' || !unit.class) {
            return { ok: false, errors: [{ code: RULES_V2_ERROR_CODES.BAD_FORM, path: 'unit.class', message: 'Unit class must be a valid reference string' }] };
        }
        if (typeof unit.statShare !== 'number' || unit.statShare < 10 || unit.statShare > 100 || !Number.isSafeInteger(unit.statShare)) {
            return { ok: false, errors: [{ code: RULES_V2_ERROR_CODES.BAD_FORM, path: 'unit.statShare', message: 'Unit statShare must be integer 10 to 100' }] };
        }
        if (typeof unit.poolShare !== 'number' || unit.poolShare < 10 || unit.poolShare > 100 || !Number.isSafeInteger(unit.poolShare)) {
            return { ok: false, errors: [{ code: RULES_V2_ERROR_CODES.BAD_FORM, path: 'unit.poolShare', message: 'Unit poolShare must be integer 10 to 100' }] };
        }
        if (typeof unit.rounds !== 'number' || unit.rounds < 1 || unit.rounds > 60 || !Number.isSafeInteger(unit.rounds)) {
            return { ok: false, errors: [{ code: RULES_V2_ERROR_CODES.BAD_FORM, path: 'unit.rounds', message: 'Unit rounds must be integer 1 to 60' }] };
        }
        total += 12;
    }

    if (!Number.isSafeInteger(total) || total < 0) {
        return { ok: false, errors: [{ code: RULES_V2_ERROR_CODES.NUMERIC_RANGE, path: 'powerScore', message: 'Power score overflow or non-integer' }] };
    }
    return { ok: true, score: total };
}

/** Compatibility stub for power budget calculation; returns null. */
export function budgetOf() {
    return null;
}

/** Budget calculation for given tier and step. */
function budgetFor(tier, step, constants = RULES_V2_CONSTANTS) {
    if (typeof tier !== 'number' || tier < 0 || tier > 3) return null;
    const baseBudget = constants.classBudget[tier];
    if (baseBudget === undefined) return null;
    return baseBudget + (step ?? 0) * (constants.pathBudgetIncrement ?? 12);
}

/** Checks the complete resolved form before generating a descendant. */
function checkParentForm(form, constants) {
    const errors = [];
    const add = (path, message) => errors.push({ code: RULES_V2_ERROR_CODES.BAD_RULES, path, message });
    const allowed = new Set(['id', 'skill', 'name', 'note', 'step', 'fromForm', 'origin',
        'type', 'stat', 'cost', 'effects', 'unit', 'tier', 'powerScore']);
    for (const key of Object.keys(form)) if (!allowed.has(key)) add(key, `Unknown form field "${key}"`);
    for (const key of ['id', 'skill']) {
        const value = form[key];
        if (typeof value !== 'string' || !DEF_ID.test(value) || value.length > 160 || value.split('/')[1].length > 64) add(key, 'Expected an SB definition ID');
    }
    if (typeof form.skill === 'string' && form.skill.split('/').at(-1).length > 52) add('skill', 'Base skill slug must leave room for both pathway steps');
    for (const key of ['name', 'note']) {
        for (const error of validateSchemaValue(form[key], rulesV2Schema.$defs[key], rulesV2Schema.$defs, key)) add(error.path, error.message);
    }
    if (!Number.isInteger(form.tier) || form.tier !== 3) add('tier', 'Only advanced forms have pathway descendants');
    if (!Number.isInteger(form.step) || form.step < 0 || form.step > 1) add('step', 'Parent step must be 0 or 1');
    if (form.step === 0) {
        if (form.id !== `${form.skill}-base`) add('id', 'Base ID must be skill ID plus -base');
        if (form.fromForm !== null) add('fromForm', 'Base has no parent');
        if (form.origin !== 'base') add('origin', 'Base origin must be base');
    } else if (form.step === 1) {
        const baseId = `${form.skill}-base`;
        if (form.fromForm !== baseId) add('fromForm', 'Step 1 must name its exact base parent');
        if (form.origin === 'generated') {
            if (form.id !== `${baseId}-g`) add('id', 'Generated ID must append -g to parent');
        } else if (form.origin === 'written') {
            if (![`${baseId}-a`, `${baseId}-b`].includes(form.id)) add('id', 'Written ID must append -a or -b to parent');
        } else add('origin', 'Step 1 origin must be written or generated');
    }
    const base = {};
    for (const key of Object.keys(rulesV2Schema.$defs.base.properties)) if (form[key] !== undefined) base[key] = form[key];
    for (const error of validateSchemaValue(base, rulesV2Schema.$defs.base, rulesV2Schema.$defs)) add(error.path, error.message);
    for (const error of validateCostCompatibility(form.type, form.cost)) add(error.path, error.message);
    const score = powerScoreOf(form);
    if (!score.ok) for (const error of score.errors) add(error.path, error.message);
    else {
        if (score.score > budgetFor(form.tier, form.step, constants)) add('powerScore', 'Parent exceeds its own budget');
        if (form.powerScore !== undefined && form.powerScore !== score.score) add('powerScore', 'Stored score does not match form');
    }
    return errors;
}

/**
 * Deterministic g power-up generation per SPEC §7 & B3/P06.
 * Clones parent, sets id=parent.id+'-g', step=step+1, origin='generated', fromForm=parent.id.
 * Adds +20 to first numeric power, else +1 to first stat magnitude, else +1 to first condition rounds.
 * Validates bounds and budget closure. Parent step 2 or invalid closure returns frozen BAD_RULES contract. Never throws.
 */
export function generatePowerUp(form, constants = RULES_V2_CONSTANTS) {
    try {
        if (!form || typeof form !== 'object' || Array.isArray(form)) {
            return fail(RULES_V2_ERROR_CODES.BAD_RULES, '', 'Form must be an object');
        }
        const read = readPlain(form);
        if (read.errors.length) return fail(RULES_V2_ERROR_CODES.BAD_RULES, '', 'Unsafe parent form input');
        return generatePowerUpOf(read.value, constants);
    } catch {
        return unreadable(RULES_V2_ERROR_CODES.BAD_RULES);
    }
}

/** generatePowerUp for a form that is already a plain copy (internal callers). */
function generatePowerUpOf(form, constants = RULES_V2_CONSTANTS) {
    const cRes = validateConstants(constants);
    if (!cRes.ok) return cRes;
    const c = cRes.constants;

    const parentErrors = checkParentForm(form, c);
    if (parentErrors.length) return { ok: false, errors: parentErrors };
    const step = form.step;
    const tier = form.tier;
    const effects = form.effects;

    const cloned = clonePlain(form);
    cloned.effects = clonePlain(effects);
    cloned.id = `${form.id}-g`;
    cloned.step = step + 1;
    cloned.origin = 'generated';
    cloned.fromForm = form.id;
    cloned.tier = tier;

    let applied = false;
    for (let i = 0; i < cloned.effects.length; i++) {
        const eff = cloned.effects[i];
        if (eff && (eff.op === 'damage' || eff.op === 'heal' || eff.op === 'shield')) {
            eff.power += 20;
            if (eff.power > 1000) {
                return { ok: false, errors: [{ code: RULES_V2_ERROR_CODES.BAD_RULES, path: `effects[${i}].power`, message: 'Power exceeds maximum 1000' }] };
            }
            applied = true;
            break;
        }
    }
    if (!applied) {
        for (let i = 0; i < cloned.effects.length; i++) {
            const eff = cloned.effects[i];
            if (eff && eff.op === 'stat') {
                if (eff.amount > 0) eff.amount += 1;
                else eff.amount -= 1;
                if (Math.abs(eff.amount) > 10) {
                    return { ok: false, errors: [{ code: RULES_V2_ERROR_CODES.BAD_RULES, path: `effects[${i}].amount`, message: 'Stat amount magnitude exceeds 10' }] };
                }
                applied = true;
                break;
            }
        }
    }
    if (!applied) {
        for (let i = 0; i < cloned.effects.length; i++) {
            const eff = cloned.effects[i];
            if (eff && eff.op === 'condition') {
                eff.rounds += 1;
                if (eff.rounds > 6) {
                    return { ok: false, errors: [{ code: RULES_V2_ERROR_CODES.BAD_RULES, path: `effects[${i}].rounds`, message: 'Condition rounds exceed 6' }] };
                }
                applied = true;
                break;
            }
        }
    }
    if (!applied) {
        return { ok: false, errors: [{ code: RULES_V2_ERROR_CODES.BAD_RULES, path: 'effects', message: 'No modifiable effect found for power-up' }] };
    }

    const scoreRes = powerScoreOf(cloned);
    if (!scoreRes.ok) {
        return { ok: false, errors: [{ code: RULES_V2_ERROR_CODES.BAD_RULES, path: 'powerScore', message: 'Failed powerScore on generated form' }] };
    }

    const budget = budgetFor(tier, cloned.step, c);
    if (budget === null || scoreRes.score > budget) {
        return { ok: false, errors: [{ code: RULES_V2_ERROR_CODES.BAD_RULES, path: 'powerScore', message: `Power score ${scoreRes.score} exceeds budget ${budget} at step ${cloned.step}` }] };
    }
    cloned.powerScore = scoreRes.score;
    return { ok: true, form: deepFreeze(cloned) };
}

/** Validates MP/SP compatibility: physical forms use SP and MP 0; others MP and SP 0. */
function validateCostCompatibility(type, cost, path = 'cost') {
    const errors = [];
    if (!cost || typeof cost !== 'object') return errors;
    if (type === 'physical') {
        if (cost.mp !== 0) {
            errors.push({ code: RULES_V2_ERROR_CODES.MP_SP_CONFLICT, path: `${path}.mp`, message: 'Physical forms must have mp 0' });
        }
    } else {
        if (cost.sp !== 0) {
            errors.push({ code: RULES_V2_ERROR_CODES.MP_SP_CONFLICT, path: `${path}.sp`, message: 'Non-physical forms must have sp 0' });
        }
    }
    return errors;
}

/**
 * Checks whether final form behavior differs from parent excluding numeric-only differences.
 * Returns true if behavior changed, false if identical/numeric-only.
 */
function hasBehavioralDifference(parentForm, form) {
    if (form.type !== parentForm.type) return true;
    if (form.stat !== parentForm.stat) return true;
    const u1 = form.unit, u0 = parentForm.unit;
    if (Boolean(u1) !== Boolean(u0)) return true;
    if (u1 && u0 && (u1.kind !== u0.kind || u1.class !== u0.class)) return true;

    if (form.effects.length !== parentForm.effects.length) return true;
    for (let i = 0; i < form.effects.length; i++) {
        const e1 = form.effects[i];
        const e0 = parentForm.effects[i];
        if (e1.op !== e0.op) return true;
        if (e1.target !== e0.target) return true;
        if (e1.element !== e0.element) return true;
        if (e1.damageType !== e0.damageType) return true;
        if (e1.kind !== e0.kind) return true;
        if (e1.stat !== e0.stat) return true;
        if (e1.op === 'stat' && Math.sign(e1.amount) !== Math.sign(e0.amount)) return true;
    }
    return false;
}

/** Applies sequential typed transforms to clone of parent form. */
function applyBranchTransforms(parentForm, branch, tier, constants = RULES_V2_CONSTANTS, branchPath = '') {
    const form = clonePlain(parentForm);
    form.id = `${parentForm.id}-${branch.choice}`;
    form.step = branch.step;
    form.origin = 'written';
    form.fromForm = parentForm.id;
    form.name = branch.name;
    form.note = branch.note ?? '';
    form.tier = tier;

    for (let t = 0; t < branch.transforms.length; t++) {
        const tr = branch.transforms[t];
        const p = `${branchPath}transforms[${t}]`;

        switch (tr.op) {
            case 'set-target': {
                if (tr.at < 0 || tr.at >= form.effects.length) {
                    return { ok: false, errors: [{ code: RULES_V2_ERROR_CODES.BAD_TRANSFORM, path: `${p}.at`, message: `Index ${tr.at} out of range for effects array` }] };
                }
                form.effects[tr.at].target = tr.value;
                break;
            }
            case 'set-element': {
                if (tr.at < 0 || tr.at >= form.effects.length) {
                    return { ok: false, errors: [{ code: RULES_V2_ERROR_CODES.BAD_TRANSFORM, path: `${p}.at`, message: `Index ${tr.at} out of range for effects array` }] };
                }
                const eff = form.effects[tr.at];
                if (eff.op !== 'damage' && eff.op !== 'heal' && eff.op !== 'shield') {
                    return { ok: false, errors: [{ code: RULES_V2_ERROR_CODES.BAD_TRANSFORM, path: `${p}.at`, message: `Cannot set element on effect op "${eff.op}"` }] };
                }
                eff.element = tr.value;
                break;
            }
            case 'set-power': {
                if (tr.at < 0 || tr.at >= form.effects.length) {
                    return { ok: false, errors: [{ code: RULES_V2_ERROR_CODES.BAD_TRANSFORM, path: `${p}.at`, message: `Index ${tr.at} out of range for effects array` }] };
                }
                const eff = form.effects[tr.at];
                if (eff.op !== 'damage' && eff.op !== 'heal' && eff.op !== 'shield') {
                    return { ok: false, errors: [{ code: RULES_V2_ERROR_CODES.BAD_TRANSFORM, path: `${p}.at`, message: `Cannot set power on effect op "${eff.op}"` }] };
                }
                eff.power = tr.value;
                break;
            }
            case 'replace-effect': {
                if (tr.at < 0 || tr.at >= form.effects.length) {
                    return { ok: false, errors: [{ code: RULES_V2_ERROR_CODES.BAD_TRANSFORM, path: `${p}.at`, message: `Index ${tr.at} out of range for effects array` }] };
                }
                form.effects[tr.at] = clonePlain(tr.value);
                break;
            }
            case 'add-effect': {
                if (form.effects.length >= 4) {
                    return { ok: false, errors: [{ code: RULES_V2_ERROR_CODES.BAD_TRANSFORM, path: p, message: 'Cannot add effect; maximum 4 effects allowed' }] };
                }
                form.effects.push(clonePlain(tr.value));
                break;
            }
            case 'remove-effect': {
                if (tr.at < 0 || tr.at >= form.effects.length) {
                    return { ok: false, errors: [{ code: RULES_V2_ERROR_CODES.BAD_TRANSFORM, path: `${p}.at`, message: `Index ${tr.at} out of range for effects array` }] };
                }
                if (form.effects.length <= 1) {
                    return { ok: false, errors: [{ code: RULES_V2_ERROR_CODES.BAD_TRANSFORM, path: p, message: 'Cannot remove effect; minimum 1 effect required' }] };
                }
                form.effects.splice(tr.at, 1);
                break;
            }
            case 'set-cost': {
                form.cost = clonePlain(tr.value);
                break;
            }
            case 'set-stat': {
                form.stat = tr.value;
                break;
            }
            case 'set-type': {
                form.type = tr.value;
                break;
            }
            default:
                return { ok: false, errors: [{ code: RULES_V2_ERROR_CODES.BAD_TRANSFORM, path: `${p}.op`, message: `Unknown transform op: ${tr.op}` }] };
        }
    }

    const costErr = validateCostCompatibility(form.type, form.cost, `${branchPath}cost`);
    if (costErr.length) return { ok: false, errors: costErr };

    for (let i = 0; i < form.effects.length; i++) {
        const valRes = validateSingleEffect(form.effects[i], `${branchPath}effects[${i}]`);
        if (!valRes.ok) return { ok: false, errors: [valRes.error] };
    }

    if (!hasBehavioralDifference(parentForm, form)) {
        return { ok: false, errors: [{ code: RULES_V2_ERROR_CODES.NUMERIC_ONLY_BRANCH, path: branchPath.replace(/\.$/, ''), message: 'Written branch must change behavior, not merely numeric fields' }] };
    }

    const scoreRes = powerScoreOf(form);
    if (!scoreRes.ok) return scoreRes;
    const budget = budgetFor(tier, branch.step, constants);
    if (budget === null || scoreRes.score > budget) {
        return { ok: false, errors: [{ code: RULES_V2_ERROR_CODES.BUDGET_CLOSURE, path: `${branchPath}powerScore`, message: `Power score ${scoreRes.score} exceeds budget ${budget} at step ${branch.step}` }] };
    }
    form.powerScore = scoreRes.score;
    return { ok: true, form };
}

function resolveSchema(s, defs) {
    let curr = s;
    let depth = 0;
    while (curr && curr.$ref && depth < 10) {
        const refName = curr.$ref.replace('#/$defs/', '');
        const target = defs ? defs[refName] : null;
        if (!target) break;
        const { $ref: _r, ...siblings } = curr;
        curr = Object.keys(siblings).length > 0 ? { ...target, ...siblings } : target;
        depth++;
    }
    return curr;
}

function matchesDiscriminator(resolvedSub, key, valKey) {
    if (!resolvedSub || !resolvedSub.properties || !resolvedSub.properties[key]) return false;
    const prop = resolvedSub.properties[key];
    if (prop.const !== undefined && prop.const === valKey) return true;
    if (Array.isArray(prop.enum) && prop.enum.includes(valKey)) return true;
    return false;
}

/**
 * Generic schema validation for manifest and owned definitions subset with $ref sibling checks.
 * Evaluates keywords independently of explicit type so siblings (e.g. maxLength:40 on $ref) are strictly enforced.
 * Record boundaries allow and validate id/pack; nested structures strictly reject them.
 */
function validateSchemaValue(val, schema, defs, path = '', options = {}) {
    const errors = [];
    if (!schema) return errors;

    if (schema.$ref) {
        const refName = schema.$ref.replace('#/$defs/', '');
        const targetDef = defs[refName];
        if (!targetDef) {
            errors.push({ code: RULES_V2_ERROR_CODES.BAD_SCHEMA, path, message: `Unknown schema ref: ${schema.$ref}` });
            return errors;
        }
        const { $ref: _r, ...siblings } = schema;
        const merged = Object.keys(siblings).length > 0 ? { ...targetDef, ...siblings } : targetDef;
        return validateSchemaValue(val, merged, defs, path, options);
    }

    if (schema.oneOf) {
        const matches = [];
        const branchDiagnostics = [];
        for (const sub of schema.oneOf) {
            const errs = validateSchemaValue(val, sub, defs, path, options);
            if (errs.length === 0) {
                matches.push(sub);
            }
            branchDiagnostics.push({ sub, resolved: resolveSchema(sub, defs), errs });
        }
        if (matches.length === 1) {
            return errors;
        }
        if (matches.length > 1) {
            errors.push({ code: RULES_V2_ERROR_CODES.BAD_SCHEMA, path, message: `Value matched multiple oneOf branches (${matches.length})` });
            return errors;
        }

        // matches.length === 0: select discriminator-compatible alternative (op/kind or matching type)
        let selected = null;
        if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
            if (val.op !== undefined) {
                const opBranches = branchDiagnostics.filter(b => matchesDiscriminator(b.resolved, 'op', val.op));
                if (opBranches.length === 1) selected = opBranches[0];
            }
            if (!selected && val.kind !== undefined) {
                const kindBranches = branchDiagnostics.filter(b => matchesDiscriminator(b.resolved, 'kind', val.kind));
                if (kindBranches.length === 1) selected = kindBranches[0];
            }
            if (!selected) {
                const objBranches = branchDiagnostics.filter(b => b.resolved?.type === 'object' || b.resolved?.properties !== undefined);
                if (objBranches.length === 1) selected = objBranches[0];
            }
        } else if (val === null) {
            const nullBranches = branchDiagnostics.filter(b => b.resolved?.type === 'null');
            if (nullBranches.length === 1) selected = nullBranches[0];
        } else if (typeof val === 'string') {
            const strBranches = branchDiagnostics.filter(b => b.resolved?.type === 'string');
            if (strBranches.length === 1) selected = strBranches[0];
        } else if (typeof val === 'number') {
            const numBranches = branchDiagnostics.filter(b => b.resolved?.type === 'integer' || b.resolved?.type === 'number');
            if (numBranches.length === 1) selected = numBranches[0];
        } else if (typeof val === 'boolean') {
            const boolBranches = branchDiagnostics.filter(b => b.resolved?.type === 'boolean');
            if (boolBranches.length === 1) selected = boolBranches[0];
        }

        if (selected && selected.errs.length > 0) {
            return selected.errs;
        }

        errors.push({ code: RULES_V2_ERROR_CODES.BAD_SCHEMA, path, message: 'Value did not match any oneOf branch' });
        return errors;
    }

    // Type validation
    if (schema.type) {
        const t = schema.type;
        if (t === 'object') {
            if (val === null || typeof val !== 'object' || Array.isArray(val)) {
                errors.push({ code: RULES_V2_ERROR_CODES.BAD_SCHEMA, path, message: `Expected object, got ${Array.isArray(val) ? 'array' : typeof val}` });
                return errors;
            }
        } else if (t === 'array') {
            if (!Array.isArray(val)) {
                errors.push({ code: RULES_V2_ERROR_CODES.BAD_SCHEMA, path, message: `Expected array, got ${typeof val}` });
                return errors;
            }
        } else if (t === 'string') {
            if (typeof val !== 'string') {
                errors.push({ code: RULES_V2_ERROR_CODES.BAD_SCHEMA, path, message: `Expected string, got ${typeof val}` });
                return errors;
            }
        } else if (t === 'integer') {
            if (typeof val !== 'number' || !Number.isSafeInteger(val)) {
                errors.push({ code: RULES_V2_ERROR_CODES.NUMERIC_RANGE, path, message: `Expected safe integer, got ${val}` });
                return errors;
            }
        } else if (t === 'boolean') {
            if (typeof val !== 'boolean') {
                errors.push({ code: RULES_V2_ERROR_CODES.BAD_SCHEMA, path, message: `Expected boolean, got ${typeof val}` });
                return errors;
            }
        } else if (t === 'null') {
            if (val !== null) {
                errors.push({ code: RULES_V2_ERROR_CODES.BAD_SCHEMA, path, message: `Expected null, got ${typeof val}` });
                return errors;
            }
        }
    }

    // String keywords
    if (typeof val === 'string') {
        // Lengths are counted in UTF-16 units, as Story Block counts every name and text (not in code points).
        const units = val.length;
        if (schema.minLength !== undefined && units < schema.minLength) {
            errors.push({ code: RULES_V2_ERROR_CODES.NUMERIC_RANGE, path, message: `String length ${units} below minLength ${schema.minLength}` });
        }
        if (schema.maxLength !== undefined && units > schema.maxLength) {
            errors.push({ code: RULES_V2_ERROR_CODES.NUMERIC_RANGE, path, message: `String length ${units} above maxLength ${schema.maxLength}` });
        }
        if (schema.pattern) {
            const regex = new RegExp(schema.pattern);
            if (!regex.test(val)) {
                errors.push({ code: RULES_V2_ERROR_CODES.BAD_SCHEMA, path, message: `String "${val}" does not match pattern ${schema.pattern}` });
            }
        }
    }

    // Number keywords
    if (typeof val === 'number') {
        if (schema.minimum !== undefined && val < schema.minimum) {
            errors.push({ code: RULES_V2_ERROR_CODES.NUMERIC_RANGE, path, message: `Number ${val} below minimum ${schema.minimum}` });
        }
        if (schema.maximum !== undefined && val > schema.maximum) {
            errors.push({ code: RULES_V2_ERROR_CODES.NUMERIC_RANGE, path, message: `Number ${val} above maximum ${schema.maximum}` });
        }
        if (schema.multipleOf !== undefined && val % schema.multipleOf !== 0) {
            errors.push({ code: RULES_V2_ERROR_CODES.NUMERIC_RANGE, path, message: `Number ${val} must be a multiple of ${schema.multipleOf}` });
        }
        if (schema.not && schema.not.const !== undefined && val === schema.not.const) {
            errors.push({ code: RULES_V2_ERROR_CODES.NUMERIC_RANGE, path, message: `Number cannot equal ${schema.not.const}` });
        }
    }

    // Array keywords
    if (Array.isArray(val)) {
        const isClassSkills = path.endsWith('skills') && (path.includes('classes') || path.startsWith('classes'));
        if (schema.minItems !== undefined && val.length < schema.minItems) {
            errors.push({
                code: isClassSkills ? RULES_V2_ERROR_CODES.CLASS_SKILLS : RULES_V2_ERROR_CODES.NUMERIC_RANGE,
                path,
                message: `Array has ${val.length} items, minimum ${schema.minItems}`
            });
        }
        if (schema.maxItems !== undefined && val.length > schema.maxItems) {
            errors.push({
                code: isClassSkills ? RULES_V2_ERROR_CODES.CLASS_SKILLS : RULES_V2_ERROR_CODES.NUMERIC_RANGE,
                path,
                message: `Array has ${val.length} items, maximum ${schema.maxItems}`
            });
        }
        if (schema.uniqueItems) {
            const set = new Set(val.map(x => typeof x === 'object' ? JSON.stringify(x) : x));
            if (set.size !== val.length) {
                errors.push({
                    code: isClassSkills ? RULES_V2_ERROR_CODES.CLASS_SKILLS : RULES_V2_ERROR_CODES.DUP_ID,
                    path,
                    message: 'Array items must be unique'
                });
            }
        }
        if (schema.items) {
            const areItemsRecords = (
                path.endsWith('classes') || path.endsWith('skills') || path.endsWith('branches') ||
                path.endsWith('trainers') || path.endsWith('items') || path.endsWith('creatures') ||
                path.endsWith('quests') || path.endsWith('shops') || path.endsWith('recipes') ||
                path.endsWith('places') || path.endsWith('rules')
            );
            for (let i = 0; i < val.length; i++) {
                errors.push(...validateSchemaValue(
                    val[i],
                    schema.items,
                    defs,
                    `${path}[${i}]`,
                    { ...options, isRecordBoundary: areItemsRecords }
                ));
            }
        }
    }

    // Object keywords
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
        if (schema.required) {
            for (const req of schema.required) {
                if (val[req] === undefined) {
                    errors.push({ code: RULES_V2_ERROR_CODES.BAD_SCHEMA, path: path ? `${path}.${req}` : req, message: `Missing required field: "${req}"` });
                }
            }
        }
        if (schema.properties) {
            for (const [propName, propSchema] of Object.entries(schema.properties)) {
                if (val[propName] !== undefined) {
                    errors.push(...validateSchemaValue(
                        val[propName],
                        propSchema,
                        defs,
                        path ? `${path}.${propName}` : propName,
                        { ...options, isRecordBoundary: false } // NEVER propagate record boundary to properties
                    ));
                }
            }
        }
        if (schema.additionalProperties === false && schema.properties) {
            const allowed = new Set(Object.keys(schema.properties));
            const isRecord = options.isRecordBoundary === true;
            for (const key of Object.keys(val)) {
                if (isRecord && (key === 'id' || key === 'pack')) {
                    if (key === 'id') {
                        if (typeof val.id !== 'string' || !(RECORD_ID_REGEX.test(val.id) || DEF_ID_REGEX.test(val.id) || REF_REGEX.test(val.id))) {
                            errors.push({ code: RULES_V2_ERROR_CODES.BAD_SCHEMA, path: path ? `${path}.id` : 'id', message: 'Record id wrapper has invalid syntax' });
                        }
                    } else if (key === 'pack') {
                        if (typeof val.pack !== 'string' || !PACK_ID.test(val.pack)) {
                            errors.push({ code: RULES_V2_ERROR_CODES.BAD_SCHEMA, path: path ? `${path}.pack` : 'pack', message: 'Record pack wrapper has invalid syntax' });
                        }
                    }
                    continue;
                }
                if (!allowed.has(key)) {
                    errors.push({ code: RULES_V2_ERROR_CODES.ENVELOPE_UNKNOWN, path: path ? `${path}.${key}` : key, message: `Unknown field: "${key}"` });
                }
            }
        }
    }

    if (schema.const !== undefined && val !== schema.const) {
        errors.push({ code: RULES_V2_ERROR_CODES.BAD_SCHEMA, path, message: `Expected constant ${JSON.stringify(schema.const)}, got ${JSON.stringify(val)}` });
    }

    if (schema.enum && !schema.enum.includes(val)) {
        errors.push({ code: RULES_V2_ERROR_CODES.BAD_SCHEMA, path, message: `Value ${JSON.stringify(val)} not in enum: ${schema.enum.join(', ')}` });
    }

    return errors;
}

/**
 * Normalizes a raw rules manifest object without mutating the input.
 * Requires valid packKey matching SB PACK_ID. Validates constants per frozen type.
 * Strips host wrappers (id, pack) from manifest root for closed checking while retaining pack identity.
 * Applies schema defaults generically without guessing required unannotated lists.
 * Converges local and same-pack refs on qualified normalized IDs. Never throws.
 */
export function normalizeRulesV2(raw, rawOptions = {}) {
    try {
        return normalizeRulesV2Of(raw, rawOptions);
    } catch {
        return unreadable();
    }
}

const MANIFEST_PATH = 'content.rules[0]';

function normalizeRulesV2Of(raw, rawOptions) {
    const optionsRead = readOptions(rawOptions);
    if (!optionsRead.ok) return { ok: false, errors: optionsRead.errors };
    const { packKey = null, constants = RULES_V2_CONSTANTS } = optionsRead.options;

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return fail(RULES_V2_ERROR_CODES.BAD_SCHEMA, MANIFEST_PATH, 'Manifest must be an object');
    }

    if (!packKey || typeof packKey !== 'string' || !PACK_ID.test(packKey)) {
        return fail(RULES_V2_ERROR_CODES.BAD_SCHEMA, 'packKey', 'Valid packKey matching PACK_ID (1 to 40 lowercase letters, digits, or dashes) is required');
    }

    const constRes = validateConstants(constants);
    if (!constRes.ok) return constRes;

    const read = readPlain(raw, { path: MANIFEST_PATH });
    if (read.errors.length) return { ok: false, errors: read.errors };

    const cloned = read.value;

    if (cloned.id !== undefined) {
        if (typeof cloned.id !== 'string' || !(RECORD_ID_REGEX.test(cloned.id) || DEF_ID_REGEX.test(cloned.id) || REF_REGEX.test(cloned.id))) {
            return fail(RULES_V2_ERROR_CODES.BAD_SCHEMA, `${MANIFEST_PATH}.id`, 'Manifest id wrapper has invalid syntax');
        }
        delete cloned.id;
    }
    if (cloned.pack !== undefined) {
        if (typeof cloned.pack !== 'string' || !PACK_ID.test(cloned.pack) || cloned.pack !== packKey) {
            return fail(RULES_V2_ERROR_CODES.BAD_SCHEMA, `${MANIFEST_PATH}.pack`, 'Manifest pack wrapper has invalid syntax or does not match packKey');
        }
        delete cloned.pack;
    }

    for (const kind of ['classes', 'skills', 'branches', 'trainers']) {
        if (Array.isArray(cloned[kind])) {
            for (let i = 0; i < cloned[kind].length; i++) {
                const rec = cloned[kind][i];
                if (rec && typeof rec === 'object' && !Array.isArray(rec)) {
                    if (rec.id !== undefined) {
                        if (typeof rec.id !== 'string' || !(RECORD_ID_REGEX.test(rec.id) || DEF_ID_REGEX.test(rec.id) || REF_REGEX.test(rec.id))) {
                            return fail(RULES_V2_ERROR_CODES.BAD_SCHEMA, `${MANIFEST_PATH}.${kind}[${i}].id`, 'Record id wrapper has invalid syntax');
                        }
                        delete rec.id;
                    }
                    if (rec.pack !== undefined) {
                        if (typeof rec.pack !== 'string' || !PACK_ID.test(rec.pack) || rec.pack !== packKey) {
                            return fail(RULES_V2_ERROR_CODES.BAD_SCHEMA, `${MANIFEST_PATH}.${kind}[${i}].pack`, 'Record pack wrapper has invalid syntax');
                        }
                        delete rec.pack;
                    }
                }
            }
        }
    }

    // Apply generic annotated defaults from rulesV2Schema
    if (cloned.statLabels === undefined && rulesV2Schema.properties.statLabels?.default !== undefined) {
        cloned.statLabels = clonePlain(rulesV2Schema.properties.statLabels.default);
    }
    if (cloned.memory === undefined && rulesV2Schema.properties.memory?.default !== undefined) {
        cloned.memory = rulesV2Schema.properties.memory.default;
    }

    const norm = normalizeStructure(cloned);

    // Default application on children from schema annotations
    const noteDef = rulesV2Schema.$defs.note?.default ?? '';
    const repDef = rulesV2Schema.$defs.skill?.properties?.replaces?.default ?? null;
    const uniqueDef = rulesV2Schema.$defs.itemRule?.properties?.unique?.default ?? false;

    if (Array.isArray(norm.classes)) {
        for (const cls of norm.classes) {
            if (cls && typeof cls === 'object' && !Array.isArray(cls)) {
                if (cls.note === undefined) cls.note = noteDef;
            }
        }
    }
    if (Array.isArray(norm.skills)) {
        for (const skl of norm.skills) {
            if (skl && typeof skl === 'object' && !Array.isArray(skl)) {
                if (skl.note === undefined) skl.note = noteDef;
                if (skl.replaces === undefined) skl.replaces = repDef;
            }
        }
    }
    if (Array.isArray(norm.branches)) {
        for (const br of norm.branches) {
            if (br && typeof br === 'object' && !Array.isArray(br)) {
                if (br.note === undefined) br.note = noteDef;
            }
        }
    }
    if (Array.isArray(norm.itemRules)) {
        for (const ir of norm.itemRules) {
            if (ir && typeof ir === 'object' && !Array.isArray(ir)) {
                if (ir.unique === undefined) ir.unique = uniqueDef;
            }
        }
    }

    const schemaErrors = validateSchemaValue(norm, rulesV2Schema, rulesV2Schema.$defs, MANIFEST_PATH, { isRecordBoundary: true });
    if (schemaErrors.length) return { ok: false, errors: schemaErrors };

    // Converge local and qualified references to normalized IDs
    const prefix = `pack.${packKey}/`;
    const toFull = ref => (typeof ref === 'string' && !ref.startsWith('pack.') && !ref.startsWith('story/') ? `${prefix}${ref}` : ref);

    norm.pack = packKey;
    norm.id = `${prefix}${norm.slug}`;

    if (Array.isArray(norm.classes)) {
        for (const cls of norm.classes) {
            if (cls && typeof cls === 'object') {
                cls.id = `${prefix}${cls.slug}`;
                cls.pack = packKey;
                if (cls.parent) cls.parent = toFull(cls.parent);
                if (Array.isArray(cls.skills)) cls.skills = cls.skills.map(toFull);
            }
        }
    }

    if (Array.isArray(norm.skills)) {
        for (const skl of norm.skills) {
            if (skl && typeof skl === 'object') {
                skl.id = `${prefix}${skl.slug}`;
                skl.pack = packKey;
                if (skl.replaces) skl.replaces = toFull(skl.replaces);
                if (skl.base?.unit?.class) skl.base.unit.class = toFull(skl.base.unit.class);
            }
        }
    }

    if (Array.isArray(norm.branches)) {
        for (const br of norm.branches) {
            if (br && typeof br === 'object') {
                br.id = `${prefix}${br.slug}`;
                br.pack = packKey;
                if (br.skill) br.skill = toFull(br.skill);
                if (br.fromForm) br.fromForm = toFull(br.fromForm);
            }
        }
    }

    if (Array.isArray(norm.itemRules)) {
        for (const ir of norm.itemRules) {
            if (ir && typeof ir === 'object') {
                if (ir.def) ir.def = toFull(ir.def);
            }
        }
    }

    if (Array.isArray(norm.trainers)) {
        for (const trn of norm.trainers) {
            if (trn && typeof trn === 'object') {
                trn.id = `${prefix}${trn.slug}`;
                trn.pack = packKey;
                if (Array.isArray(trn.skills)) trn.skills = trn.skills.map(toFull);
                if (Array.isArray(trn.eventTemplates)) trn.eventTemplates = trn.eventTemplates.map(toFull);
            }
        }
    }

    return { ok: true, manifest: sortKeys(norm) };
}

/**
 * Resolves a reference against this pack's own slugs of one kind (`localSet`), or accepts it as external.
 * - This pack's prefix (`pack.<id>/x`) or a bare slug must name a local entry; a miss is BAD_REF, never external.
 * - `external` ('place', 'npc' or 'thread') names what the story or the map owns: a canonical id
 *   (pl_xxxxxxxx, np_xxxxxxxx, th_xxxxxxxx) and, for places and NPCs, another pack's `pack.<other>/x`
 *   are accepted as external and resolved at activation. Anything else is BAD_REF.
 * - Without `external`, another pack's prefix is rejected (no cross-pack rules mixing).
 */
function checkReference(ref, packId, localSet, external = null, path = '') {
    if (!ref || typeof ref !== 'string') {
        return { ok: false, error: { code: RULES_V2_ERROR_CODES.BAD_REF, path, message: 'Reference must be a string' } };
    }
    const prefix = `pack.${packId}/`;
    if (ref.startsWith(prefix) || !ref.startsWith('pack.')) {
        const localSlug = ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
        if (localSet.has(localSlug)) return { ok: true, id: `${prefix}${localSlug}`, isExternal: false };
        if (external && EXTERNAL_IDS[external].test(ref)) return { ok: true, id: ref, isExternal: true };
        return { ok: false, error: { code: RULES_V2_ERROR_CODES.BAD_REF, path, message: `Reference "${ref}" is not defined in this pack` } };
    }
    if ((external === 'place' || external === 'npc') && DEF_ID_REGEX.test(ref)) {
        return { ok: true, id: ref, isExternal: true };
    }
    return { ok: false, error: { code: RULES_V2_ERROR_CODES.BAD_REF, path, message: `Foreign-pack internal reference "${ref}" is rejected` } };
}

/**
 * Validates manifest and owned content per SPEC §7.
 * Resolves references, checks graph, budgets, 24 written + 12 generated structure, slots/hands compatibility.
 * Structural owned-content validation completes before semantic access. Reads both inputs once into detached
 * copies, so it never mutates caller data and never throws.
 */
export function validateRulesV2(manifest, content = {}, constants = RULES_V2_CONSTANTS) {
    try {
        const result = validateRulesV2Of(manifest, content, constants);
        return result.ok ? { ok: true, resolved: result.resolved, warnings: result.warnings } : result;
    } catch {
        return unreadable();
    }
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Items and places are Story Block's: a record without a `slug` gets the one Story Block derives from its name
 * (validate.js slugify), here as there. Changes the (detached) lists it is given.
 */
function deriveSlugs(content) {
    for (const kind of ['items', 'places']) {
        if (!Array.isArray(content?.[kind])) continue;
        for (const record of content[kind]) {
            if (isRecord(record) && record.slug === undefined && typeof record.name === 'string') {
                const slug = slugify(record.name);
                if (slug) record.slug = slug;
            }
        }
    }
}

function validateRulesV2Of(manifest, content, constants, { host = false } = {}) {
    if (!isRecord(manifest)) {
        return fail(RULES_V2_ERROR_CODES.BAD_SCHEMA, MANIFEST_PATH, 'Manifest must be an object');
    }
    if (!isRecord(content)) {
        return fail(RULES_V2_ERROR_CODES.BAD_SCHEMA, 'content', 'Content must be an object');
    }

    // One safe read of both inputs: from here on only the detached copies m and cnt are touched.
    const manifestRead = readPlain(manifest, { path: MANIFEST_PATH });
    if (manifestRead.errors.length) return { ok: false, errors: manifestRead.errors };
    const contentRead = readPlain(content, { path: 'content', packwide: true, host });
    if (contentRead.errors.length) return { ok: false, errors: contentRead.errors };
    const m = manifestRead.value;
    const cnt = contentRead.value;
    delete cnt._envelope;
    deriveSlugs(cnt);

    const constRes = validateConstants(constants);
    if (!constRes.ok) return constRes;
    const c = constRes.constants;

    const packKey = m.pack;
    if (!packKey || typeof packKey !== 'string' || !PACK_ID.test(packKey)) {
        return fail(RULES_V2_ERROR_CODES.BAD_SCHEMA, `${MANIFEST_PATH}.pack`, 'Manifest must be normalized with a packKey before validation');
    }

    // Structural validation of manifest root against rulesV2Schema
    const manifestSchemaErrors = validateSchemaValue(m, rulesV2Schema, rulesV2Schema.$defs, MANIFEST_PATH, { isRecordBoundary: true });
    if (manifestSchemaErrors.length) {
        return { ok: false, errors: manifestSchemaErrors };
    }

    const errors = [];
    const warnings = [];

    // Owned content lists must be arrays of plain objects, each with a string slug (events: slug or id),
    // before any record is read.
    const ownedContainerKinds = ['items', 'creatures', 'quests', 'shops', 'recipes', 'places', 'events'];
    const shapeErrors = [];
    for (const k of ownedContainerKinds) {
        if (cnt[k] === undefined) continue;
        if (!Array.isArray(cnt[k])) {
            shapeErrors.push({ code: RULES_V2_ERROR_CODES.BAD_SCHEMA, path: `content.${k}`, message: `content.${k} must be an array` });
            continue;
        }
        cnt[k].forEach((entry, i) => {
            const at = `content.${k}[${i}]`;
            if (!isRecord(entry)) {
                shapeErrors.push({ code: RULES_V2_ERROR_CODES.BAD_SCHEMA, path: at, message: `${at} must be an object` });
            } else if (k === 'events') {
                const named = entry.slug ?? entry.id;
                if (named !== undefined && typeof named !== 'string') {
                    shapeErrors.push({ code: RULES_V2_ERROR_CODES.BAD_SCHEMA, path: `${at}.${entry.slug !== undefined ? 'slug' : 'id'}`, message: 'An event slug or id must be a string' });
                }
            } else if (typeof entry.slug !== 'string' || !entry.slug) {
                shapeErrors.push({ code: RULES_V2_ERROR_CODES.BAD_SCHEMA, path: `${at}.slug`, message: `${at} needs a string slug` });
            }
        });
    }
    if (shapeErrors.length) return { ok: false, errors: shapeErrors.slice(0, RULES_V2_LIMITS.errors) };

    const contentItems = cnt.items ?? [];
    const contentCreatures = cnt.creatures ?? [];
    const contentQuests = cnt.quests ?? [];
    const contentShops = cnt.shops ?? [];
    const contentRecipes = cnt.recipes ?? [];
    const contentPlaces = cnt.places ?? [];
    const contentEvents = cnt.events ?? [];

    for (let i = 0; i < contentCreatures.length; i++) {
        errors.push(...validateSchemaValue(contentCreatures[i], rulesV2Schema.$defs.foe, rulesV2Schema.$defs, `content.creatures[${i}]`, { isRecordBoundary: true }));
    }
    for (let i = 0; i < contentQuests.length; i++) {
        errors.push(...validateSchemaValue(contentQuests[i], rulesV2Schema.$defs.quest, rulesV2Schema.$defs, `content.quests[${i}]`, { isRecordBoundary: true }));
    }
    for (let i = 0; i < contentShops.length; i++) {
        errors.push(...validateSchemaValue(contentShops[i], rulesV2Schema.$defs.shop, rulesV2Schema.$defs, `content.shops[${i}]`, { isRecordBoundary: true }));
    }
    for (let i = 0; i < contentRecipes.length; i++) {
        const rcp = contentRecipes[i];
        if (rcp && typeof rcp === 'object' && rcp.known === undefined) {
            rcp.known = rulesV2Schema.$defs.recipe?.properties?.known?.default ?? true;
        }
        errors.push(...validateSchemaValue(rcp, rulesV2Schema.$defs.recipe, rulesV2Schema.$defs, `content.recipes[${i}]`, { isRecordBoundary: true }));
    }

    if (errors.length) return { ok: false, errors };

    // Sets for slug uniqueness and reference verification
    const classSlugs = new Set();
    for (let i = 0; i < (m.classes ?? []).length; i++) {
        const s = m.classes[i].slug;
        if (classSlugs.has(s)) errors.push({ code: RULES_V2_ERROR_CODES.DUP_ID, path: `content.rules[0].classes[${i}].slug`, message: `Duplicate class slug "${s}"` });
        classSlugs.add(s);
    }

    const skillSlugs = new Set();
    for (let i = 0; i < (m.skills ?? []).length; i++) {
        const s = m.skills[i].slug;
        if (skillSlugs.has(s)) errors.push({ code: RULES_V2_ERROR_CODES.DUP_ID, path: `content.rules[0].skills[${i}].slug`, message: `Duplicate skill slug "${s}"` });
        skillSlugs.add(s);
    }

    const branchSlugs = new Set();
    for (let i = 0; i < (m.branches ?? []).length; i++) {
        const s = m.branches[i].slug;
        if (branchSlugs.has(s)) errors.push({ code: RULES_V2_ERROR_CODES.DUP_ID, path: `content.rules[0].branches[${i}].slug`, message: `Duplicate branch slug "${s}"` });
        branchSlugs.add(s);
    }

    const trainerSlugs = new Set();
    for (let i = 0; i < (m.trainers ?? []).length; i++) {
        const s = m.trainers[i].slug;
        if (trainerSlugs.has(s)) errors.push({ code: RULES_V2_ERROR_CODES.DUP_ID, path: `content.rules[0].trainers[${i}].slug`, message: `Duplicate trainer slug "${s}"` });
        trainerSlugs.add(s);
    }

    // One slug, one definition: classes, skills, branches and trainers share the pack's id space
    // (pack.<id>/<slug>), so the same slug in two of those lists is refused. Same-list duplicates
    // are reported above.
    const definitionKinds = new Map([['rules', 'the rules manifest']]);
    for (const kind of ['classes', 'skills', 'branches', 'trainers']) {
        (m[kind] ?? []).forEach((record, i) => {
            const first = definitionKinds.get(record.slug);
            if (first === undefined) definitionKinds.set(record.slug, kind);
            else if (first !== kind) {
                errors.push({ code: RULES_V2_ERROR_CODES.DUP_ID, path: `${MANIFEST_PATH}.${kind}[${i}].slug`, message: `Slug "${record.slug}" is already used by an entry of ${first}; a slug names one definition in a pack` });
            }
        });
    }

    const itemSlugs = new Set();
    for (let i = 0; i < contentItems.length; i++) {
        const s = contentItems[i].slug;
        if (itemSlugs.has(s)) errors.push({ code: RULES_V2_ERROR_CODES.DUP_ID, path: `content.items[${i}].slug`, message: `Duplicate item slug "${s}"` });
        itemSlugs.add(s);
    }

    const creatureSlugs = new Set();
    for (let i = 0; i < contentCreatures.length; i++) {
        const s = contentCreatures[i].slug;
        if (creatureSlugs.has(s)) errors.push({ code: RULES_V2_ERROR_CODES.DUP_ID, path: `content.creatures[${i}].slug`, message: `Duplicate creature slug "${s}"` });
        creatureSlugs.add(s);
    }

    const questSlugs = new Set();
    for (let i = 0; i < contentQuests.length; i++) {
        const s = contentQuests[i].slug;
        if (questSlugs.has(s)) errors.push({ code: RULES_V2_ERROR_CODES.DUP_ID, path: `content.quests[${i}].slug`, message: `Duplicate quest slug "${s}"` });
        questSlugs.add(s);
    }

    const shopSlugs = new Set();
    for (let i = 0; i < contentShops.length; i++) {
        const s = contentShops[i].slug;
        if (shopSlugs.has(s)) errors.push({ code: RULES_V2_ERROR_CODES.DUP_ID, path: `content.shops[${i}].slug`, message: `Duplicate shop slug "${s}"` });
        shopSlugs.add(s);
    }

    const recipeSlugs = new Set();
    for (let i = 0; i < contentRecipes.length; i++) {
        const s = contentRecipes[i].slug;
        if (recipeSlugs.has(s)) errors.push({ code: RULES_V2_ERROR_CODES.DUP_ID, path: `content.recipes[${i}].slug`, message: `Duplicate recipe slug "${s}"` });
        recipeSlugs.add(s);
    }

    const placeSlugs = new Set();
    for (let i = 0; i < contentPlaces.length; i++) {
        const s = contentPlaces[i].slug;
        if (placeSlugs.has(s)) errors.push({ code: RULES_V2_ERROR_CODES.DUP_ID, path: `content.places[${i}].slug`, message: `Duplicate place slug "${s}"` });
        placeSlugs.add(s);
    }

    const eventSlugs = new Set();
    for (let i = 0; i < contentEvents.length; i++) {
        const s = contentEvents[i].slug ?? contentEvents[i].id;
        if (s) eventSlugs.add(s);
    }

    // Class hierarchy and skill ownership
    const classBySlug = new Map();
    const skillOwner = new Map();

    for (let i = 0; i < (m.classes ?? []).length; i++) {
        const cls = m.classes[i];
        classBySlug.set(cls.slug, cls);
        if (!cls.skills || cls.skills.length !== 3) {
            errors.push({ code: RULES_V2_ERROR_CODES.CLASS_SKILLS, path: `content.rules[0].classes[${i}].skills`, message: `Class "${cls.slug}" must have exactly 3 skills` });
        } else {
            const rawSkills = cls.skills.map(s => s.startsWith(`pack.${packKey}/`) ? s.slice(`pack.${packKey}/`.length) : s);
            const uniqueSkills = new Set(rawSkills);
            if (uniqueSkills.size !== 3) {
                errors.push({ code: RULES_V2_ERROR_CODES.CLASS_SKILLS, path: `content.rules[0].classes[${i}].skills`, message: `Skills for class "${cls.slug}" must be unique` });
            }
            for (let j = 0; j < rawSkills.length; j++) {
                const s = rawSkills[j];
                if (!skillSlugs.has(s)) {
                    errors.push({ code: RULES_V2_ERROR_CODES.BAD_REF, path: `content.rules[0].classes[${i}].skills[${j}]`, message: `Referenced skill "${s}" does not exist in manifest` });
                } else if (skillOwner.has(s)) {
                    errors.push({ code: RULES_V2_ERROR_CODES.CLASS_SKILLS, path: `content.rules[0].classes[${i}].skills[${j}]`, message: `Skill "${s}" is already owned by class "${skillOwner.get(s)}"` });
                } else {
                    skillOwner.set(s, cls.slug);
                }
            }
        }
        if (cls.tier === 0) {
            if (cls.parent !== null) {
                errors.push({ code: RULES_V2_ERROR_CODES.TIER_CHAIN, path: `content.rules[0].classes[${i}].parent`, message: `Tier 0 class "${cls.slug}" must have parent null` });
            }
        } else {
            if (!cls.parent) {
                errors.push({ code: RULES_V2_ERROR_CODES.TIER_CHAIN, path: `content.rules[0].classes[${i}].parent`, message: `Tier ${cls.tier} class "${cls.slug}" must have a parent` });
            }
        }
    }

    // Check each skill has exactly one owner (no orphan skills)
    for (let i = 0; i < (m.skills ?? []).length; i++) {
        const skl = m.skills[i];
        if (!skillOwner.has(skl.slug)) {
            errors.push({ code: RULES_V2_ERROR_CODES.CLASS_SKILLS, path: `content.rules[0].skills[${i}]`, message: `Orphan skill "${skl.slug}" is not owned by any class` });
        }
    }

    // Class parent linkage and tier chain
    const parentOf = new Set();
    for (let i = 0; i < (m.classes ?? []).length; i++) {
        const cls = m.classes[i];
        if (cls.parent) {
            const parentSlug = cls.parent.startsWith(`pack.${packKey}/`) ? cls.parent.slice(`pack.${packKey}/`.length) : cls.parent;
            parentOf.add(parentSlug);
            const pClass = classBySlug.get(parentSlug);
            if (!pClass) {
                errors.push({ code: RULES_V2_ERROR_CODES.BAD_REF, path: `content.rules[0].classes[${i}].parent`, message: `Parent class "${cls.parent}" not found` });
            } else if (pClass.tier !== cls.tier - 1) {
                errors.push({ code: RULES_V2_ERROR_CODES.TIER_CHAIN, path: `content.rules[0].classes[${i}].parent`, message: `Class "${cls.slug}" (tier ${cls.tier}) parent "${cls.parent}" must be tier ${cls.tier - 1}` });
            }
        }
    }

    // Cycle and root check
    for (let i = 0; i < (m.classes ?? []).length; i++) {
        const cls = m.classes[i];
        let cur = cls;
        const visited = new Set();
        while (cur && cur.parent) {
            if (visited.has(cur.slug)) {
                errors.push({ code: RULES_V2_ERROR_CODES.TIER_CHAIN, path: `content.rules[0].classes[${i}]`, message: `Cycle detected in class hierarchy through "${cur.slug}"` });
                break;
            }
            visited.add(cur.slug);
            const pSlug = cur.parent.startsWith(`pack.${packKey}/`) ? cur.parent.slice(`pack.${packKey}/`.length) : cur.parent;
            cur = classBySlug.get(pSlug);
        }
        if (cur && cur.tier !== 0) {
            errors.push({ code: RULES_V2_ERROR_CODES.TIER_CHAIN, path: `content.rules[0].classes[${i}]`, message: `Class "${cls.slug}" does not chain back to a tier 0 root` });
        }
    }

    // All leaves must be tier 3
    for (let i = 0; i < (m.classes ?? []).length; i++) {
        const cls = m.classes[i];
        if (!parentOf.has(cls.slug) && cls.tier !== 3) {
            errors.push({ code: RULES_V2_ERROR_CODES.TIER_CHAIN, path: `content.rules[0].classes[${i}].tier`, message: `Leaf class "${cls.slug}" must be tier 3` });
        }
    }

    // Skills validation
    for (let i = 0; i < (m.skills ?? []).length; i++) {
        const skl = m.skills[i];
        if ([...skl.slug].length > 52) {
            errors.push({ code: RULES_V2_ERROR_CODES.NUMERIC_RANGE, path: `content.rules[0].skills[${i}].slug`, message: `Skill slug "${skl.slug}" exceeds maximum length 52` });
        }
        const owningClassSlug = skillOwner.get(skl.slug);
        const owningClass = owningClassSlug ? classBySlug.get(owningClassSlug) : null;
        const tier = owningClass ? owningClass.tier : 0;

        const costErr = validateCostCompatibility(skl.base.type, skl.base.cost, `content.rules[0].skills[${i}].base.cost`);
        errors.push(...costErr);

        for (let eIdx = 0; eIdx < skl.base.effects.length; eIdx++) {
            const valRes = validateSingleEffect(skl.base.effects[eIdx], `content.rules[0].skills[${i}].base.effects[${eIdx}]`);
            if (!valRes.ok) errors.push(valRes.error);
        }

        if (skl.base.unit) {
            const uClass = skl.base.unit.class.startsWith(`pack.${packKey}/`) ? skl.base.unit.class.slice(`pack.${packKey}/`.length) : skl.base.unit.class;
            if (!classSlugs.has(uClass)) {
                errors.push({ code: RULES_V2_ERROR_CODES.BAD_REF, path: `content.rules[0].skills[${i}].base.unit.class`, message: `Unit class "${skl.base.unit.class}" not found` });
            }
        }
        if (skl.replaces) {
            const rep = skl.replaces.startsWith(`pack.${packKey}/`) ? skl.replaces.slice(`pack.${packKey}/`.length) : skl.replaces;
            if (!skillSlugs.has(rep)) {
                errors.push({ code: RULES_V2_ERROR_CODES.BAD_REF, path: `content.rules[0].skills[${i}].replaces`, message: `Replaced skill "${skl.replaces}" not found` });
            } else if (rep === skl.slug) {
                errors.push({ code: RULES_V2_ERROR_CODES.BAD_REF, path: `content.rules[0].skills[${i}].replaces`, message: `Skill "${skl.slug}" cannot replace itself` });
            }
        }

        const scoreRes = powerScoreOf(skl.base);
        if (!scoreRes.ok) {
            errors.push(...scoreRes.errors);
        } else {
            const budget = budgetFor(tier, 0, c);
            if (budget === null || scoreRes.score > budget) {
                errors.push({ code: RULES_V2_ERROR_CODES.BUDGET_CLOSURE, path: `content.rules[0].skills[${i}].base.powerScore`, message: `Skill "${skl.slug}" power score ${scoreRes.score} exceeds tier ${tier} budget ${budget}` });
            }
        }
    }

    // Form ID collision index: reserve all base, written, and generated form IDs
    const reservedFormIds = new Map();
    for (const skl of m.skills ?? []) {
        const baseFormId = `pack.${packKey}/${skl.slug}-base`;
        reservedFormIds.set(baseFormId, `base form of skill "${skl.slug}"`);
        const owningClassSlug = skillOwner.get(skl.slug);
        const owningClass = owningClassSlug ? classBySlug.get(owningClassSlug) : null;
        if (owningClass && owningClass.tier === 3) {
            const s1 = [`${baseFormId}-g`, `${baseFormId}-a`, `${baseFormId}-b`];
            for (const f of s1) reservedFormIds.set(f, `step 1 form of skill "${skl.slug}"`);
            for (const p of s1) {
                for (const ch of ['g', 'a', 'b']) {
                    reservedFormIds.set(`${p}-${ch}`, `step 2 form of skill "${skl.slug}"`);
                }
            }
        }
    }

    // Check collision of all authored definition slugs/IDs with reserved form IDs
    for (let i = 0; i < (m.skills ?? []).length; i++) {
        const skl = m.skills[i];
        const qId = `pack.${packKey}/${skl.slug}`;
        if (reservedFormIds.has(qId)) {
            errors.push({ code: RULES_V2_ERROR_CODES.DUP_ID, path: `content.rules[0].skills[${i}].slug`, message: `Skill slug "${skl.slug}" collides with form ID "${qId}"` });
        }
    }

    for (let i = 0; i < (m.classes ?? []).length; i++) {
        const cls = m.classes[i];
        const qId = `pack.${packKey}/${cls.slug}`;
        if (reservedFormIds.has(qId)) {
            errors.push({ code: RULES_V2_ERROR_CODES.DUP_ID, path: `content.rules[0].classes[${i}].slug`, message: `Class slug "${cls.slug}" collides with form ID "${qId}"` });
        }
    }

    for (let i = 0; i < (m.trainers ?? []).length; i++) {
        const trn = m.trainers[i];
        const qId = `pack.${packKey}/${trn.slug}`;
        if (reservedFormIds.has(qId)) {
            errors.push({ code: RULES_V2_ERROR_CODES.DUP_ID, path: `content.rules[0].trainers[${i}].slug`, message: `Trainer slug "${trn.slug}" collides with form ID "${qId}"` });
        }
    }

    for (let i = 0; i < contentItems.length; i++) {
        const it = contentItems[i];
        const qId = `pack.${packKey}/${it.slug}`;
        if (reservedFormIds.has(qId)) {
            errors.push({ code: RULES_V2_ERROR_CODES.DUP_ID, path: `content.items[${i}].slug`, message: `Item slug "${it.slug}" collides with form ID "${qId}"` });
        }
    }

    for (let i = 0; i < contentCreatures.length; i++) {
        const f = contentCreatures[i];
        const qId = `pack.${packKey}/${f.slug}`;
        if (reservedFormIds.has(qId)) {
            errors.push({ code: RULES_V2_ERROR_CODES.DUP_ID, path: `content.creatures[${i}].slug`, message: `Creature slug "${f.slug}" collides with form ID "${qId}"` });
        }
    }

    for (let i = 0; i < contentQuests.length; i++) {
        const q = contentQuests[i];
        const qId = `pack.${packKey}/${q.slug}`;
        if (reservedFormIds.has(qId)) {
            errors.push({ code: RULES_V2_ERROR_CODES.DUP_ID, path: `content.quests[${i}].slug`, message: `Quest slug "${q.slug}" collides with form ID "${qId}"` });
        }
    }

    for (let i = 0; i < contentShops.length; i++) {
        const s = contentShops[i];
        const qId = `pack.${packKey}/${s.slug}`;
        if (reservedFormIds.has(qId)) {
            errors.push({ code: RULES_V2_ERROR_CODES.DUP_ID, path: `content.shops[${i}].slug`, message: `Shop slug "${s.slug}" collides with form ID "${qId}"` });
        }
    }

    for (let i = 0; i < contentRecipes.length; i++) {
        const r = contentRecipes[i];
        const qId = `pack.${packKey}/${r.slug}`;
        if (reservedFormIds.has(qId)) {
            errors.push({ code: RULES_V2_ERROR_CODES.DUP_ID, path: `content.recipes[${i}].slug`, message: `Recipe slug "${r.slug}" collides with form ID "${qId}"` });
        }
    }

    for (let i = 0; i < (m.branches ?? []).length; i++) {
        const br = m.branches[i];
        if (br.slug.endsWith('-g')) {
            errors.push({ code: RULES_V2_ERROR_CODES.DUP_ID, path: `content.rules[0].branches[${i}].slug`, message: 'Branch slug cannot end with reserved generated suffix "-g"' });
        }
        const expectedFromForm = br.fromForm.startsWith(`pack.${packKey}/`) ? br.fromForm.slice(`pack.${packKey}/`.length) : br.fromForm;
        const skillSlug = br.skill.startsWith(`pack.${packKey}/`) ? br.skill.slice(`pack.${packKey}/`.length) : br.skill;
        const baseSlug = `${skillSlug}-base`;
        const parents = br.step === 1 ? [baseSlug] : ['g', 'a', 'b'].map(choice => `${baseSlug}-${choice}`);
        if (!parents.includes(expectedFromForm)) {
            errors.push({ code: RULES_V2_ERROR_CODES.BRANCH_GRAPH, path: `content.rules[0].branches[${i}].fromForm`, message: 'Branch must name its exact parent at the preceding step in its own skill' });
        }
        const expectedSlug = `${expectedFromForm}-${br.choice}`;
        if (br.slug !== expectedSlug) {
            errors.push({ code: RULES_V2_ERROR_CODES.BRANCH_GRAPH, path: `content.rules[0].branches[${i}].slug`, message: `Branch slug "${br.slug}" does not match expected "${expectedSlug}"` });
        }
    }

    // Branch Graph Validation
    const branchesBySkill = new Map();
    const branchIndexMap = new Map();
    for (let i = 0; i < (m.branches ?? []).length; i++) {
        const br = m.branches[i];
        const sklSlug = br.skill.startsWith(`pack.${packKey}/`) ? br.skill.slice(`pack.${packKey}/`.length) : br.skill;
        if (!branchesBySkill.has(sklSlug)) branchesBySkill.set(sklSlug, []);
        branchesBySkill.get(sklSlug).push(br);
        branchIndexMap.set(br, i);
    }

    for (const [si, skl] of (m.skills ?? []).entries()) {
        const owningClassSlug = skillOwner.get(skl.slug);
        const owningClass = owningClassSlug ? classBySlug.get(owningClassSlug) : null;
        const tier = owningClass ? owningClass.tier : 0;
        const branches = branchesBySkill.get(skl.slug) ?? [];

        if (tier < 3) {
            if (branches.length > 0) {
                errors.push({ code: RULES_V2_ERROR_CODES.BRANCH_GRAPH, path: `content.rules[0].skills[${si}].branches`, message: `Starter/intermediate class skills (tier ${tier}) cannot have branches` });
            }
            continue;
        }

        if (branches.length !== 8) {
            errors.push({ code: RULES_V2_ERROR_CODES.BRANCH_GRAPH, path: `content.rules[0].skills[${si}].branches`, message: `Advanced skill "${skl.slug}" must have exactly 8 written branches, found ${branches.length}` });
        }

        const baseFormId = `pack.${packKey}/${skl.slug}-base`;
        const baseForm = {
            id: baseFormId,
            skill: `pack.${packKey}/${skl.slug}`,
            name: skl.name,
            note: skl.note ?? '',
            step: 0,
            fromForm: null,
            origin: 'base',
            type: skl.base.type,
            stat: skl.base.stat,
            cost: skl.base.cost,
            effects: skl.base.effects,
            unit: skl.base.unit,
            tier: 3,
        };

        const step1Branches = branches.filter(b => (b.fromForm === baseFormId || b.fromForm === `${skl.slug}-base`) && b.step === 1);
        const step1Choices = new Set(step1Branches.map(b => b.choice));
        if (step1Branches.length !== 2 || step1Choices.size !== 2 || !step1Choices.has('a') || !step1Choices.has('b')) {
            errors.push({ code: RULES_V2_ERROR_CODES.BRANCH_GRAPH, path: `content.rules[0].skills[${si}].branches`, message: `Skill "${skl.slug}" base form must have written step-1 choices 'a' and 'b'` });
        }

        const g1Res = generatePowerUpOf(baseForm, c);
        if (!g1Res.ok) errors.push(...g1Res.errors);
        const g1Form = g1Res.ok ? g1Res.form : null;

        const formsAtStep1 = new Map();
        if (g1Form) formsAtStep1.set(g1Form.id, g1Form);

        for (const b of step1Branches) {
            const bIdx = branchIndexMap.get(b);
            const applied = applyBranchTransforms(baseForm, b, 3, c, `content.rules[0].branches[${bIdx}].`);
            if (!applied.ok) errors.push(...applied.errors);
            else formsAtStep1.set(applied.form.id, applied.form);
        }

        const step1Parents = [`${baseFormId}-g`, `${baseFormId}-a`, `${baseFormId}-b`];
        for (const pId of step1Parents) {
            const step2Branches = branches.filter(b => (b.fromForm === pId || b.fromForm === pId.slice(`pack.${packKey}/`.length)) && b.step === 2);
            const step2Choices = new Set(step2Branches.map(b => b.choice));
            if (step2Branches.length !== 2 || step2Choices.size !== 2 || !step2Choices.has('a') || !step2Choices.has('b')) {
                errors.push({ code: RULES_V2_ERROR_CODES.BRANCH_GRAPH, path: `content.rules[0].skills[${si}].branches`, message: `Parent form "${pId}" must have written step-2 choices 'a' and 'b'` });
            }
            const parentForm = formsAtStep1.get(pId);
            if (parentForm) {
                const g2Res = generatePowerUpOf(parentForm, c);
                if (!g2Res.ok) errors.push(...g2Res.errors);
                for (const b of step2Branches) {
                    const bIdx = branchIndexMap.get(b);
                    const applied2 = applyBranchTransforms(parentForm, b, 3, c, `content.rules[0].branches[${bIdx}].`);
                    if (!applied2.ok) errors.push(...applied2.errors);
                }
            }
        }
    }

    // Check for unaccounted branches belonging to nonexistent skills
    for (let i = 0; i < (m.branches ?? []).length; i++) {
        const br = m.branches[i];
        const sSlug = br.skill.startsWith(`pack.${packKey}/`) ? br.skill.slice(`pack.${packKey}/`.length) : br.skill;
        if (!skillSlugs.has(sSlug)) {
            errors.push({ code: RULES_V2_ERROR_CODES.BAD_REF, path: `content.rules[0].branches[${i}].skill`, message: `Branch skill "${br.skill}" not found` });
        }
    }

    // Item rules bijection and equipment slot/hands checks
    if (contentItems.length !== (m.itemRules ?? []).length) {
        errors.push({ code: RULES_V2_ERROR_CODES.ITEM_RULE_MISMATCH, path: 'content.rules[0].itemRules', message: `Item rules count (${(m.itemRules ?? []).length}) must match content.items count (${contentItems.length}) 1:1` });
    }

    const itemMap = new Map(contentItems.map(it => [it.slug, it]));
    const coveredItemSlugs = new Set();

    for (let i = 0; i < (m.itemRules ?? []).length; i++) {
        const rule = m.itemRules[i];
        const defSlug = rule.def.startsWith(`pack.${packKey}/`) ? rule.def.slice(`pack.${packKey}/`.length) : rule.def;
        if (coveredItemSlugs.has(defSlug)) {
            errors.push({ code: RULES_V2_ERROR_CODES.ITEM_RULE_MISMATCH, path: `content.rules[0].itemRules[${i}].def`, message: `Duplicate item rule definition "${rule.def}"` });
        }
        coveredItemSlugs.add(defSlug);

        const item = itemMap.get(defSlug);
        if (!item) {
            errors.push({ code: RULES_V2_ERROR_CODES.BAD_REF, path: `content.rules[0].itemRules[${i}].def`, message: `Item rule definition "${rule.def}" does not match any item in content.items` });
            continue;
        }

        if (item.kind !== 'equipment') {
            if (rule.allowedSlots && rule.allowedSlots.length > 0) {
                errors.push({ code: RULES_V2_ERROR_CODES.ITEM_RULE_MISMATCH, path: `content.rules[0].itemRules[${i}].allowedSlots`, message: `Non-equipment item "${item.slug}" must have empty allowedSlots` });
            }
            if (rule.hands !== 0) {
                errors.push({ code: RULES_V2_ERROR_CODES.ITEM_RULE_MISMATCH, path: `content.rules[0].itemRules[${i}].hands`, message: `Non-equipment item "${item.slug}" must have hands 0` });
            }
        } else {
            if (!Array.isArray(rule.allowedSlots) || rule.allowedSlots.length === 0) {
                errors.push({ code: RULES_V2_ERROR_CODES.ITEM_RULE_MISMATCH, path: `content.rules[0].itemRules[${i}].allowedSlots`, message: `Equipment item "${item.slug}" requires nonempty allowedSlots` });
            } else {
                for (const slt of rule.allowedSlots) {
                    if (!RULES_V2_SLOTS.includes(slt)) {
                        errors.push({ code: RULES_V2_ERROR_CODES.ITEM_RULE_MISMATCH, path: `content.rules[0].itemRules[${i}].allowedSlots`, message: `Invalid equipment slot "${slt}"` });
                    }
                }
                const isHand = rule.allowedSlots.includes('weapon') || rule.allowedSlots.includes('offhand');
                if (isHand) {
                    if (rule.hands !== 1 && rule.hands !== 2) {
                        errors.push({ code: RULES_V2_ERROR_CODES.ITEM_RULE_MISMATCH, path: `content.rules[0].itemRules[${i}].hands`, message: 'Hand gear (weapon/offhand) requires hands 1 or 2' });
                    }
                    if (rule.hands === 2) {
                        if (rule.allowedSlots.length !== 1 || rule.allowedSlots[0] !== 'weapon') {
                            errors.push({ code: RULES_V2_ERROR_CODES.ITEM_RULE_MISMATCH, path: `content.rules[0].itemRules[${i}].allowedSlots`, message: '2-handed gear must have allowedSlots ["weapon"] only' });
                        }
                    } else if (rule.hands === 1) {
                        for (const slt of rule.allowedSlots) {
                            if (slt !== 'weapon' && slt !== 'offhand') {
                                errors.push({ code: RULES_V2_ERROR_CODES.ITEM_RULE_MISMATCH, path: `content.rules[0].itemRules[${i}].allowedSlots`, message: '1-handed gear can only occupy weapon or offhand' });
                            }
                        }
                    }
                } else {
                    if (rule.hands !== 0) {
                        errors.push({ code: RULES_V2_ERROR_CODES.ITEM_RULE_MISMATCH, path: `content.rules[0].itemRules[${i}].hands`, message: 'Non-hand equipment requires hands 0' });
                    }
                }
                // Only a standard slot id on the item is checked against the rule. A legacy free-text slot
                // ("ring", "chest", "boots") stays Story Block's own label; the rule decides where it fits.
                if (RULES_V2_SLOTS.includes(item.slot) && !rule.allowedSlots.includes(item.slot)) {
                    errors.push({ code: RULES_V2_ERROR_CODES.ITEM_RULE_MISMATCH, path: `content.rules[0].itemRules[${i}].allowedSlots`, message: `Item rule allowedSlots must include item declared slot "${item.slot}"` });
                }
            }
        }
    }

    // Owned content cross-references
    for (let i = 0; i < contentCreatures.length; i++) {
        const foe = contentCreatures[i];
        const p = `content.creatures[${i}]`;
        if (foe.skills) {
            for (let s = 0; s < foe.skills.length; s++) {
                const sRef = checkReference(foe.skills[s], packKey, skillSlugs, null, `${p}.skills[${s}]`);
                if (!sRef.ok) errors.push(sRef.error);
            }
        }
        if (foe.loot) {
            for (let l = 0; l < foe.loot.length; l++) {
                const lRef = checkReference(foe.loot[l].def, packKey, itemSlugs, null, `${p}.loot[${l}].def`);
                if (!lRef.ok) errors.push(lRef.error);
            }
        }
    }

    for (let i = 0; i < contentQuests.length; i++) {
        const q = contentQuests[i];
        const p = `content.quests[${i}]`;
        if (q.giver) {
            const gRef = checkReference(q.giver, packKey, creatureSlugs, 'npc', `${p}.giver`);
            if (!gRef.ok) errors.push(gRef.error);
            else if (gRef.isExternal) warnings.push({ path: `${p}.giver`, message: `External giver reference "${q.giver}" accepted with runtime eligibility check` });
        }
        if (q.turnInPlace) {
            const pRef = checkReference(q.turnInPlace, packKey, placeSlugs, 'place', `${p}.turnInPlace`);
            if (!pRef.ok) errors.push(pRef.error);
            else if (pRef.isExternal) warnings.push({ path: `${p}.turnInPlace`, message: `External place reference "${q.turnInPlace}" accepted with runtime eligibility check` });
        }
        if (q.requirements) {
            for (let r = 0; r < q.requirements.length; r++) {
                const req = q.requirements[r];
                if (req.kind === 'class') {
                    for (let cIdx = 0; cIdx < req.classes.length; cIdx++) {
                        const cRef = checkReference(req.classes[cIdx], packKey, classSlugs, null, `${p}.requirements[${r}].classes[${cIdx}]`);
                        if (!cRef.ok) errors.push(cRef.error);
                    }
                } else if (req.kind === 'item') {
                    const iRef = checkReference(req.def, packKey, itemSlugs, null, `${p}.requirements[${r}].def`);
                    if (!iRef.ok) errors.push(iRef.error);
                } else if (req.kind === 'quest') {
                    const qRef = checkReference(req.template, packKey, questSlugs, null, `${p}.requirements[${r}].template`);
                    if (!qRef.ok) errors.push(qRef.error);
                } else if (req.kind === 'place') {
                    const plRef = checkReference(req.place, packKey, placeSlugs, 'place', `${p}.requirements[${r}].place`);
                    if (!plRef.ok) errors.push(plRef.error);
                    else if (plRef.isExternal) warnings.push({ path: `${p}.requirements[${r}].place`, message: `External place reference "${req.place}" accepted with runtime eligibility check` });
                } else if (req.kind === 'thread') {
                    const thRef = checkReference(req.thread, packKey, new Set(), 'thread', `${p}.requirements[${r}].thread`);
                    if (!thRef.ok) errors.push(thRef.error);
                    else if (thRef.isExternal) warnings.push({ path: `${p}.requirements[${r}].thread`, message: `External thread reference "${req.thread}" accepted with runtime eligibility check` });
                }
            }
        }
        if (q.objectives) {
            const objectiveIds = new Set();
            for (let o = 0; o < q.objectives.length; o++) {
                const obj = q.objectives[o];
                if (objectiveIds.has(obj.id)) {
                    errors.push({ code: RULES_V2_ERROR_CODES.DUP_ID, path: `${p}.objectives[${o}].id`, message: `Duplicate objective id "${obj.id}" in quest "${q.slug}"` });
                }
                objectiveIds.add(obj.id);
                if (obj.kind === 'kill') {
                    const fRef = checkReference(obj.foe, packKey, creatureSlugs, null, `${p}.objectives[${o}].foe`);
                    if (!fRef.ok) errors.push(fRef.error);
                } else if (obj.kind === 'collect') {
                    const cRef = checkReference(obj.def, packKey, itemSlugs, null, `${p}.objectives[${o}].def`);
                    if (!cRef.ok) errors.push(cRef.error);
                } else if (obj.kind === 'visit') {
                    const vRef = checkReference(obj.place, packKey, placeSlugs, 'place', `${p}.objectives[${o}].place`);
                    if (!vRef.ok) errors.push(vRef.error);
                    else if (vRef.isExternal) warnings.push({ path: `${p}.objectives[${o}].place`, message: `External place reference "${obj.place}" accepted with runtime eligibility check` });
                }
            }
        }
        if (q.reward?.items) {
            for (let ri = 0; ri < q.reward.items.length; ri++) {
                const rRef = checkReference(q.reward.items[ri].def, packKey, itemSlugs, null, `${p}.reward.items[${ri}].def`);
                if (!rRef.ok) errors.push(rRef.error);
            }
        }
        if (q.chain) {
            for (const link of ['previous', 'next']) {
                if (!q.chain[link]) continue;
                const chRef = checkReference(q.chain[link], packKey, questSlugs, null, `${p}.chain.${link}`);
                if (!chRef.ok) errors.push(chRef.error);
                else if (chRef.id === `pack.${packKey}/${q.slug}`) {
                    errors.push({ code: RULES_V2_ERROR_CODES.BAD_REF, path: `${p}.chain.${link}`, message: `Quest "${q.slug}" cannot chain to itself` });
                }
            }
        }
    }

    for (let i = 0; i < contentShops.length; i++) {
        const shp = contentShops[i];
        const p = `content.shops[${i}]`;
        const plRef = checkReference(shp.place, packKey, placeSlugs, 'place', `${p}.place`);
        if (!plRef.ok) errors.push(plRef.error);
        else if (plRef.isExternal) warnings.push({ path: `${p}.place`, message: `External place reference "${shp.place}" accepted with runtime eligibility check` });
        if (shp.stock) {
            for (let s = 0; s < shp.stock.length; s++) {
                const iRef = checkReference(shp.stock[s].item, packKey, itemSlugs, null, `${p}.stock[${s}].item`);
                if (!iRef.ok) errors.push(iRef.error);
            }
        }
    }

    for (let i = 0; i < contentRecipes.length; i++) {
        const rcp = contentRecipes[i];
        const p = `content.recipes[${i}]`;
        const mRef = checkReference(rcp.makes, packKey, itemSlugs, null, `${p}.makes`);
        if (!mRef.ok) errors.push(mRef.error);
        if (rcp.materials) {
            for (let mIdx = 0; mIdx < rcp.materials.length; mIdx++) {
                const matRef = checkReference(rcp.materials[mIdx].item, packKey, itemSlugs, null, `${p}.materials[${mIdx}].item`);
                if (!matRef.ok) errors.push(matRef.error);
            }
        }
    }

    for (let i = 0; i < (m.trainers ?? []).length; i++) {
        const trn = m.trainers[i];
        const p = `content.rules[0].trainers[${i}]`;
        const plRef = checkReference(trn.place, packKey, placeSlugs, 'place', `${p}.place`);
        if (!plRef.ok) errors.push(plRef.error);
        else if (plRef.isExternal) warnings.push({ path: `${p}.place`, message: `External place reference "${trn.place}" accepted with runtime eligibility check` });
        for (let s = 0; s < trn.skills.length; s++) {
            const sRef = checkReference(trn.skills[s], packKey, skillSlugs, null, `${p}.skills[${s}]`);
            if (!sRef.ok) errors.push(sRef.error);
        }
        if (trn.eventTemplates) {
            for (let e = 0; e < trn.eventTemplates.length; e++) {
                const eRef = checkReference(trn.eventTemplates[e], packKey, eventSlugs, null, `${p}.eventTemplates[${e}]`);
                if (!eRef.ok) errors.push(eRef.error);
            }
        }
    }

    if (errors.length) return { ok: false, errors };

    // Build fully expanded forms table
    const forms = {};
    const branchesBySkillFinal = new Map();
    for (const br of m.branches ?? []) {
        const sSlug = br.skill.startsWith(`pack.${packKey}/`) ? br.skill.slice(`pack.${packKey}/`.length) : br.skill;
        if (!branchesBySkillFinal.has(sSlug)) branchesBySkillFinal.set(sSlug, []);
        branchesBySkillFinal.get(sSlug).push(br);
    }

    for (const skl of m.skills ?? []) {
        const owningClassSlug = skillOwner.get(skl.slug);
        const owningClass = classBySlug.get(owningClassSlug);
        const tier = owningClass ? owningClass.tier : 0;
        const baseFormId = `pack.${packKey}/${skl.slug}-base`;
        const baseForm = {
            id: baseFormId,
            skill: `pack.${packKey}/${skl.slug}`,
            name: skl.name,
            note: skl.note ?? '',
            step: 0,
            fromForm: null,
            origin: 'base',
            type: skl.base.type,
            stat: skl.base.stat,
            cost: skl.base.cost,
            effects: skl.base.effects,
            unit: skl.base.unit,
            tier,
        };
        const scoreRes = powerScoreOf(baseForm);
        baseForm.powerScore = scoreRes.ok ? scoreRes.score : 0;
        forms[baseFormId] = baseForm;

        if (tier === 3) {
            const branches = branchesBySkillFinal.get(skl.slug) ?? [];
            const step1Branches = branches.filter(b => (b.fromForm === baseFormId || b.fromForm === `${skl.slug}-base`) && b.step === 1);
            const g1Res = generatePowerUpOf(baseForm, c);
            if (g1Res.ok) forms[g1Res.form.id] = g1Res.form;

            for (const b of step1Branches) {
                const applied = applyBranchTransforms(baseForm, b, 3, c, '');
                if (applied.ok) forms[applied.form.id] = applied.form;
            }

            const step1Parents = [`${baseFormId}-g`, `${baseFormId}-a`, `${baseFormId}-b`];
            for (const pId of step1Parents) {
                const parentForm = forms[pId];
                if (!parentForm) continue;
                const g2Res = generatePowerUpOf(parentForm, c);
                if (g2Res.ok) forms[g2Res.form.id] = g2Res.form;

                const step2Branches = branches.filter(b => (b.fromForm === pId || b.fromForm === pId.slice(`pack.${packKey}/`.length)) && b.step === 2);
                for (const b of step2Branches) {
                    const applied2 = applyBranchTransforms(parentForm, b, 3, c, '');
                    if (applied2.ok) forms[applied2.form.id] = applied2.form;
                }
            }
        }
    }

    // Build fully normalized resolved definitions with qualified IDs and references (no local aliases in keys)
    const prefix = `pack.${packKey}/`;
    const toFull = ref => (typeof ref === 'string' && !ref.startsWith('pack.') && !ref.startsWith('story/') ? `${prefix}${ref}` : ref);

    const resolvedItems = {};
    for (const r of m.itemRules ?? []) {
        const fullDef = toFull(r.def);
        const copy = clonePlain(r);
        copy.def = fullDef;
        resolvedItems[fullDef] = copy;
    }

    const resolvedFoes = {};
    for (const f of contentCreatures) {
        const fullId = `${prefix}${f.slug}`;
        const copy = clonePlain(f);
        copy.id = fullId;
        if (Array.isArray(copy.skills)) copy.skills = copy.skills.map(toFull);
        if (Array.isArray(copy.loot)) {
            for (const l of copy.loot) {
                if (l.def) l.def = toFull(l.def);
            }
        }
        resolvedFoes[fullId] = copy;
    }

    const resolvedQuests = {};
    for (const q of contentQuests) {
        const fullId = `${prefix}${q.slug}`;
        const copy = clonePlain(q);
        copy.id = fullId;
        if (copy.giver && !copy.giver.startsWith('np_') && !copy.giver.startsWith('pack.')) copy.giver = toFull(copy.giver);
        if (copy.turnInPlace && !copy.turnInPlace.startsWith('pl_') && !copy.turnInPlace.startsWith('pack.')) copy.turnInPlace = toFull(copy.turnInPlace);
        if (Array.isArray(copy.requirements)) {
            for (const req of copy.requirements) {
                if (req.kind === 'class' && Array.isArray(req.classes)) req.classes = req.classes.map(toFull);
                else if (req.kind === 'item' && req.def) req.def = toFull(req.def);
                else if (req.kind === 'quest' && req.template) req.template = toFull(req.template);
                else if (req.kind === 'place' && req.place && !req.place.startsWith('pl_') && !req.place.startsWith('pack.')) req.place = toFull(req.place);
            }
        }
        if (Array.isArray(copy.objectives)) {
            for (const obj of copy.objectives) {
                if (obj.kind === 'kill' && obj.foe) obj.foe = toFull(obj.foe);
                else if (obj.kind === 'collect' && obj.def) obj.def = toFull(obj.def);
                else if (obj.kind === 'visit' && obj.place && !obj.place.startsWith('pl_') && !obj.place.startsWith('pack.')) obj.place = toFull(obj.place);
            }
        }
        if (Array.isArray(copy.reward?.items)) {
            for (const it of copy.reward.items) {
                if (it.def) it.def = toFull(it.def);
            }
        }
        if (copy.chain) {
            if (copy.chain.previous) copy.chain.previous = toFull(copy.chain.previous);
            if (copy.chain.next) copy.chain.next = toFull(copy.chain.next);
        }
        resolvedQuests[fullId] = copy;
    }

    const resolvedShops = {};
    for (const s of contentShops) {
        const fullId = `${prefix}${s.slug}`;
        const copy = clonePlain(s);
        copy.id = fullId;
        if (copy.place && !copy.place.startsWith('pl_') && !copy.place.startsWith('pack.')) copy.place = toFull(copy.place);
        if (Array.isArray(copy.stock)) {
            for (const st of copy.stock) {
                if (st.item) st.item = toFull(st.item);
            }
        }
        resolvedShops[fullId] = copy;
    }

    const resolvedRecipes = {};
    for (const r of contentRecipes) {
        const fullId = `${prefix}${r.slug}`;
        const copy = clonePlain(r);
        copy.id = fullId;
        copy.known = copy.known !== undefined ? copy.known : (rulesV2Schema.$defs.recipe?.properties?.known?.default ?? true);
        if (copy.makes) copy.makes = toFull(copy.makes);
        if (Array.isArray(copy.materials)) {
            for (const m of copy.materials) {
                if (m.item) m.item = toFull(m.item);
            }
        }
        resolvedRecipes[fullId] = copy;
    }

    const resolved = deepFreeze({
        manifest: m,
        forms,
        items: resolvedItems,
        foes: resolvedFoes,
        quests: resolvedQuests,
        shops: resolvedShops,
        recipes: resolvedRecipes,
        constants: clonePlain(c),
    });

    return { ok: true, resolved, warnings, content: cnt };
}

/** Shortens internal reference string to local slug if in same pack. */
function shortenTypedRef(ref, packId) {
    if (typeof ref !== 'string') return ref;
    const prefix = `pack.${packId}/`;
    if (ref.startsWith(prefix)) return ref.slice(prefix.length);
    return ref;
}

/**
 * Builds canonical authored shortened representation of document.
 * Normalizes text (NFC, CRLF to LF, trimmed) and defaults across WHOLE document.
 * Validates and strips host wrappers ONLY at documented record boundaries.
 * Shortens ONLY typed internal $defs.ref fields, never names, notes, or canonical place IDs.
 * Preserves authored array ordering and canonicalizes object keys.
 */
function buildCanonicalDocument(doc, packId) {
    const raw = normalizeStructure(clonePlain(doc));

    // Money defaults (SPEC §7): coins [] and display 'mixed', so equivalent packs hash the same.
    if (isRecord(raw.currency)) applyCurrencyDefaults(raw.currency);

    function stripWrappers(rec) {
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return;
        if (rec.id !== undefined) {
            if (typeof rec.id === 'string' && (RECORD_ID_REGEX.test(rec.id) || DEF_ID_REGEX.test(rec.id) || REF_REGEX.test(rec.id))) {
                delete rec.id;
            }
        }
        if (rec.pack !== undefined) {
            if (typeof rec.pack === 'string' && PACK_ID.test(rec.pack)) {
                delete rec.pack;
            }
        }
    }

    if (raw.content?.rules?.[0]) {
        const r = raw.content.rules[0];
        stripWrappers(r);

        if (r.statLabels === undefined) r.statLabels = clonePlain(rulesV2Schema.properties.statLabels.default);
        if (r.memory === undefined) r.memory = rulesV2Schema.properties.memory.default;

        if (Array.isArray(r.classes)) {
            for (const c of r.classes) {
                stripWrappers(c);
                if (c.note === undefined) c.note = rulesV2Schema.$defs.note.default;
                if (c.parent) c.parent = shortenTypedRef(c.parent, packId);
                if (Array.isArray(c.skills)) c.skills = c.skills.map(s => shortenTypedRef(s, packId));
            }
        }
        if (Array.isArray(r.skills)) {
            for (const s of r.skills) {
                stripWrappers(s);
                if (s.note === undefined) s.note = rulesV2Schema.$defs.note.default;
                if (s.replaces === undefined) s.replaces = rulesV2Schema.$defs.skill.properties.replaces.default;
                if (s.replaces) s.replaces = shortenTypedRef(s.replaces, packId);
                if (s.base?.unit?.class) s.base.unit.class = shortenTypedRef(s.base.unit.class, packId);
            }
        }
        if (Array.isArray(r.branches)) {
            for (const b of r.branches) {
                stripWrappers(b);
                if (b.note === undefined) b.note = rulesV2Schema.$defs.note.default;
                if (b.skill) b.skill = shortenTypedRef(b.skill, packId);
                if (b.fromForm) b.fromForm = shortenTypedRef(b.fromForm, packId);
            }
        }
        if (Array.isArray(r.itemRules)) {
            for (const ir of r.itemRules) {
                if (ir.unique === undefined) ir.unique = rulesV2Schema.$defs.itemRule.properties.unique.default;
                if (ir.def) ir.def = shortenTypedRef(ir.def, packId);
            }
        }
        if (Array.isArray(r.trainers)) {
            for (const trn of r.trainers) {
                stripWrappers(trn);
                if (Array.isArray(trn.skills)) trn.skills = trn.skills.map(s => shortenTypedRef(s, packId));
                if (Array.isArray(trn.eventTemplates)) trn.eventTemplates = trn.eventTemplates.map(e => shortenTypedRef(e, packId));
            }
        }
    }

    if (Array.isArray(raw.content?.items)) {
        for (const it of raw.content.items) {
            stripWrappers(it);
        }
    }

    if (Array.isArray(raw.content?.creatures)) {
        for (const f of raw.content.creatures) {
            stripWrappers(f);
            if (Array.isArray(f.skills)) f.skills = f.skills.map(s => shortenTypedRef(s, packId));
            if (Array.isArray(f.loot)) {
                for (const l of f.loot) {
                    if (l.def) l.def = shortenTypedRef(l.def, packId);
                }
            }
        }
    }

    if (Array.isArray(raw.content?.quests)) {
        for (const q of raw.content.quests) {
            stripWrappers(q);
            if (Array.isArray(q.requirements)) {
                for (const req of q.requirements) {
                    if (req.kind === 'class' && Array.isArray(req.classes)) req.classes = req.classes.map(c => shortenTypedRef(c, packId));
                    else if (req.kind === 'item' && req.def) req.def = shortenTypedRef(req.def, packId);
                    else if (req.kind === 'quest' && req.template) req.template = shortenTypedRef(req.template, packId);
                }
            }
            if (Array.isArray(q.objectives)) {
                for (const obj of q.objectives) {
                    // Retain required authored obj.id (ob_...)
                    if (obj.kind === 'kill' && obj.foe) obj.foe = shortenTypedRef(obj.foe, packId);
                    else if (obj.kind === 'collect' && obj.def) obj.def = shortenTypedRef(obj.def, packId);
                }
            }
            if (Array.isArray(q.reward?.items)) {
                for (const it of q.reward.items) {
                    if (it.def) it.def = shortenTypedRef(it.def, packId);
                }
            }
            if (q.chain) {
                if (q.chain.previous) q.chain.previous = shortenTypedRef(q.chain.previous, packId);
                if (q.chain.next) q.chain.next = shortenTypedRef(q.chain.next, packId);
            }
        }
    }

    if (Array.isArray(raw.content?.shops)) {
        for (const s of raw.content.shops) {
            stripWrappers(s);
            // Place IDs stay qualified
            if (Array.isArray(s.stock)) {
                for (const st of s.stock) {
                    if (st.item) st.item = shortenTypedRef(st.item, packId);
                }
            }
        }
    }

    if (Array.isArray(raw.content?.recipes)) {
        for (const r of raw.content.recipes) {
            stripWrappers(r);
            if (r.known === undefined) r.known = rulesV2Schema.$defs.recipe?.properties?.known?.default ?? true;
            if (r.makes) r.makes = shortenTypedRef(r.makes, packId);
            if (Array.isArray(r.materials)) {
                for (const m of r.materials) {
                    if (m.item) m.item = shortenTypedRef(m.item, packId);
                }
            }
        }
    }

    if (Array.isArray(raw.content?.places)) {
        for (const p of raw.content.places) {
            stripWrappers(p);
        }
    }

    return sortKeys(raw);
}


const CURRENCY_DISPLAYS = ['mixed', 'base'];

/** Money defaults (SPEC §7): no coins, mixed display. */
function applyCurrencyDefaults(currency) {
    if (currency.coins === undefined) currency.coins = [];
    if (currency.display === undefined) currency.display = 'mixed';
}

function sha256Text(text) {
    return sha256Bytes(new TextEncoder().encode(text));
}

/**
 * Limits on a resolved ruleset (SPEC §7): at most limits.forms expanded forms and limits.resolvedBytes
 * of JSON. Returns `{ ok: true }` or the TOO_LARGE error result; a value exactly at a limit passes.
 * Import, runtime and Studio share it; `limits` exists so the boundaries can be tested.
 */
export function checkResolvedLimits(resolved, limits = RULES_V2_LIMITS) {
    try {
        const formCount = Object.keys(resolved.forms).length;
        if (formCount > limits.forms) {
            return fail(RULES_V2_ERROR_CODES.TOO_LARGE, 'forms', `Forms count ${formCount} exceeds limit of ${limits.forms}`);
        }
        if (byteLength(JSON.stringify(resolved)) > limits.resolvedBytes) {
            return fail(RULES_V2_ERROR_CODES.TOO_LARGE, 'resolved', `Resolved ruleset exceeds ${limits.resolvedBytes} bytes`);
        }
        return { ok: true };
    } catch {
        return unreadable(RULES_V2_ERROR_CODES.TOO_LARGE);
    }
}

/** rulesHash, the contract's H: the normalised manifest and owned content + schema + constants. */
function computeRulesHash(resolved, content) {
    const canonical = buildCanonicalDocument({ content: { ...content, rules: [resolved.manifest] } }, resolved.manifest.pack).content;
    return sha256Text(JSON.stringify(sortKeys({ constants: resolved.constants, content: canonical, schema: rulesV2Schema })));
}

/** Size checks and the rulesHash for a result of validateRulesV2Of. */
function finishExpansion(validated, hashes = true) {
    const limits = checkResolvedLimits(validated.resolved);
    if (!limits.ok) return limits;
    return {
        ok: true,
        resolved: deepFreeze(sortKeys(validated.resolved)),
        ...(hashes ? { rulesHash: computeRulesHash(validated.resolved, validated.content) } : {}),
    };
}

/**
 * Expands all forms (bases, written branches, generated power-ups) per SPEC §7.
 * Returns the immutable resolved ruleset and its `rulesHash` (SHA-256 of the normalised authored
 * manifest and owned content + schema + constants; the contract's H). Never throws.
 */
export function expandRulesV2(manifest, content = {}, constants = RULES_V2_CONSTANTS) {
    try {
        const validated = validateRulesV2Of(manifest, content, constants);
        if (!validated.ok) return validated;
        return finishExpansion(validated);
    } catch {
        return unreadable();
    }
}

/**
 * Exports the canonical raw envelope per SPEC §7.
 * Validates the document, strips host wrappers, shortens only typed internal refs, preserves authored
 * arrays, sorts object keys. UTF-8, two-space indent, final newline.
 * Returns `{ ok, text, rulesHash, packHash }` (see the header for the two hashes). Never throws.
 */
export function exportRulesV2(document, constants = RULES_V2_CONSTANTS) {
    try {
        const chk = validatePackOf(document, { constants });
        if (!chk.ok) return { ok: false, errors: chk.errors };

        const canonical = buildCanonicalDocument(chk.pack, chk.pack.id);
        const text = JSON.stringify(canonical, null, 2) + '\n';
        if (byteLength(text) > RULES_V2_LIMITS.packBytes) {
            return fail(RULES_V2_ERROR_CODES.TOO_LARGE, '', 'Canonical export exceeds 512 KiB');
        }
        return { ok: true, text, rulesHash: chk.rulesHash, packHash: chk.packHash };
    } catch {
        return unreadable();
    }
}

/**
 * JSON.parse that also refuses duplicate keys (JSON.parse keeps the last one silently).
 * Keys are compared after JSON unescaping, so "name" and "name" are the same key.
 * Returns `{ ok: true, value }` or `{ ok: false, errors }` (BAD_SCHEMA for bad JSON, DUP_ID per duplicate).
 */
function parseJsonText(text) {
    let value;
    try {
        value = JSON.parse(text);
    } catch (err) {
        return fail(RULES_V2_ERROR_CODES.BAD_SCHEMA, '', `Invalid JSON: ${String(err?.message)}`);
    }
    const duplicates = findDuplicateKeys(text);
    if (duplicates.length) return { ok: false, errors: duplicates };
    return { ok: true, value };
}

/** Scans syntactically valid JSON text for repeated keys in one object; linear, no recursion. */
function findDuplicateKeys(text) {
    const errors = [];
    const stack = [];
    const join = (path, key) => (path ? `${path}.${key}` : key);
    let i = 0;
    while (i < text.length && errors.length < RULES_V2_LIMITS.errors) {
        const ch = text[i];
        if (ch === '"') {
            let end = i + 1;
            while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
            const top = stack[stack.length - 1];
            if (top && top.object && top.expectKey) {
                const key = JSON.parse(text.slice(i, end + 1));
                if (top.keys.has(key)) {
                    errors.push({ code: RULES_V2_ERROR_CODES.DUP_ID, path: join(top.path, key), message: `Duplicate key "${key}" in the JSON text` });
                }
                top.keys.add(key);
                top.lastKey = key;
                top.expectKey = false;
            }
            i = end + 1;
            continue;
        }
        if (ch === '{' || ch === '[') {
            const parent = stack[stack.length - 1];
            let path = '';
            if (parent) path = parent.object ? join(parent.path, parent.lastKey) : `${parent.path}[${parent.commas}]`;
            stack.push({ object: ch === '{', path, keys: new Set(), expectKey: ch === '{', lastKey: '', commas: 0 });
        } else if (ch === '}' || ch === ']') {
            stack.pop();
        } else if (ch === ',') {
            const top = stack[stack.length - 1];
            if (top.object) top.expectKey = true;
            else top.commas += 1;
        }
        i += 1;
    }
    return errors;
}

/**
 * Validates a rules pack per SPEC §7, §9, §10: the envelope, JSON safety (SB's markup and link scan
 * over every string and key), the rules manifest and the owned content. Accepts an object or JSON
 * text (text with a repeated key is refused). Reuses SB validatePack on a detached legacy projection.
 * Options: `constants`; `capabilities` (the host's capability names; when given, a missing one
 * is MISSING_CAPABILITY like Story Block's own check); `hostVersion` (default HOST_VERSION) and `limits`
 * (Story Block's pack limits, default LIMITS), used for the envelope pass; `envelope` (default true): false
 * skips that pass for a caller that has just made it on the same pack (Story Block's validatePack does);
 * `hashes` (default true): false leaves out `rulesHash` and `packHash`, which cost about a sixth of the check, for a caller
 * that may never ask for them.
 * A pack with content.rules must declare the `rb-rules-v2` capability. Returns `{ ok, errors, pack, raw, resolved, rulesHash, packHash, warnings }`.
 * Never throws.
 */
export function validateRulesPack(pack, rawOptions = {}) {
    try {
        return validatePackOf(pack, rawOptions);
    } catch {
        return unreadable();
    }
}

// Content kinds whose records are named `pack.<id>/<slug>` (slug, or id for the kinds that write it so).
const SLUGGED_KINDS = ['items', 'creatures', 'shops', 'recipes', 'events', 'quests', 'races', 'talents', 'skills', 'presets', 'places', 'routes', 'terms', 'crafts', 'meterPresets'];

/** An error result when another record of the pack is called `rules` (the manifest's own slug), else null. */
function reservedRulesSlug(content) {
    const errors = [];
    for (const kind of SLUGGED_KINDS) {
        if (!Array.isArray(content?.[kind])) continue;
        content[kind].forEach((record, i) => {
            if (!isRecord(record)) return;
            const field = record.slug !== undefined ? 'slug' : record.id !== undefined ? 'id' : null;
            const slug = field ? record[field] : typeof record.name === 'string' ? slugify(record.name) : undefined;
            if (slug === 'rules') {
                errors.push({ code: RULES_V2_ERROR_CODES.DUP_ID, path: `content.${kind}[${i}]${field ? `.${field}` : ''}`, message: 'The slug "rules" is the rules manifest\'s own (pack.<id>/rules); name this record something else' });
            }
        });
    }
    return errors.length ? { ok: false, errors: errors.slice(0, RULES_V2_LIMITS.errors) } : null;
}

function validatePackOf(pack, rawOptions) {
    const optionsRead = readOptions(rawOptions);
    if (!optionsRead.ok) return { ok: false, errors: optionsRead.errors };
    const { constants = RULES_V2_CONSTANTS, capabilities = null, limits = null } = optionsRead.options;
    const hostVersion = optionsRead.options.hostVersion ?? HOST_VERSION;
    const envelope = optionsRead.options.envelope ?? true;
    const hashes = optionsRead.options.hashes ?? true;
    if (typeof hostVersion !== 'string' || !SEMVER.test(hostVersion)) {
        return fail(RULES_V2_ERROR_CODES.BAD_SCHEMA, 'options.hostVersion', 'hostVersion must be a version like 2.0.0');
    }
    if (typeof hashes !== 'boolean') {
        return fail(RULES_V2_ERROR_CODES.BAD_SCHEMA, 'options.hashes', 'hashes must be true or false');
    }
    if (typeof envelope !== 'boolean') {
        return fail(RULES_V2_ERROR_CODES.BAD_SCHEMA, 'options.envelope', 'envelope must be true or false');
    }
    if (limits !== null && (!isRecord(limits) || Object.entries(limits).some(([key, n]) => !(key in LIMITS) || !Number.isSafeInteger(n) || n < 1))) {
        return fail(RULES_V2_ERROR_CODES.BAD_SCHEMA, 'options.limits', 'limits must name Story Block pack limits (packBytes, depth, keys, array, string, name, errors ...) as whole numbers of 1 or more');
    }

    let value = pack;
    if (typeof pack === 'string') {
        if (byteLength(pack) > RULES_V2_LIMITS.packBytes) {
            return fail(RULES_V2_ERROR_CODES.TOO_LARGE, '', 'Pack text exceeds 512 KiB');
        }
        const parsed = parseJsonText(pack.replace(/^﻿/, ''));
        if (!parsed.ok) return parsed;
        value = parsed.value;
    }
    if (!isRecord(value)) {
        return fail(RULES_V2_ERROR_CODES.BAD_SCHEMA, '', 'Pack must be a JSON object');
    }

    const read = readPlain(value, { packwide: true, host: !envelope });
    if (read.errors.length) return { ok: false, errors: read.errors };
    const raw = read.value;

    // The 512 KiB raw boundary applies to objects as well as text.
    if (byteLength(JSON.stringify(raw)) > RULES_V2_LIMITS.packBytes) {
        return fail(RULES_V2_ERROR_CODES.TOO_LARGE, '', 'Pack object exceeds 512 KiB');
    }

    const constRes = validateConstants(constants);
    if (!constRes.ok) return constRes;
    const c = constRes.constants;

    // Normalize the detached copy before SB/structural/semantic checking (NFC text and keys, trim, CRLF/CR -> LF)
    const detachedVal = normalizeStructure(raw);
    // (an item or place without a slug has the one Story Block derives, so equivalent spellings are one pack and hash alike)
    if (isRecord(detachedVal.content)) deriveSlugs(detachedVal.content);

    // Check envelope fields against closed PACK_FIELDS
    for (const key of Object.keys(detachedVal)) {
        if (!PACK_FIELDS.includes(key)) {
            return fail(RULES_V2_ERROR_CODES.ENVELOPE_UNKNOWN, key, `Unknown pack envelope field: "${key}"`);
        }
    }

    // Validate envelope requirements
    if (!detachedVal.id || typeof detachedVal.id !== 'string' || !PACK_ID.test(detachedVal.id)) {
        return fail(RULES_V2_ERROR_CODES.BAD_SCHEMA, 'id', 'Pack id must be 1 to 40 lowercase letters, digits, or dashes');
    }
    if (!detachedVal.version || typeof detachedVal.version !== 'string' || !SEMVER.test(detachedVal.version)) {
        return fail(RULES_V2_ERROR_CODES.BAD_SCHEMA, 'version', 'Pack version must match semver syntax');
    }
    if (!isRecord(detachedVal.requires)) {
        return fail(RULES_V2_ERROR_CODES.BAD_SCHEMA, 'requires', 'Pack requires must be an object');
    }
    for (const rk of Object.keys(detachedVal.requires)) {
        if (rk !== 'storyBlock' && rk !== 'capabilities') {
            return fail(RULES_V2_ERROR_CODES.ENVELOPE_UNKNOWN, `requires.${rk}`, `"${rk}" is not a requires field`);
        }
    }
    if (typeof detachedVal.requires.storyBlock !== 'string' || !parseRange(detachedVal.requires.storyBlock)) {
        return fail(RULES_V2_ERROR_CODES.BAD_SCHEMA, 'requires.storyBlock', 'requires.storyBlock must be a valid version range');
    }
    if (detachedVal.requires.capabilities !== undefined) {
        if (!Array.isArray(detachedVal.requires.capabilities) || !detachedVal.requires.capabilities.every(cap => typeof cap === 'string' && SLUG.test(cap))) {
            return fail(RULES_V2_ERROR_CODES.BAD_CAPABILITY, 'requires.capabilities', 'requires.capabilities must be a list of capability slugs');
        }
    }

    if (!isRecord(detachedVal.content)) {
        return fail(RULES_V2_ERROR_CODES.BAD_SCHEMA, 'content', 'Pack content must be an object');
    }
    for (const ck of Object.keys(detachedVal.content)) {
        if (ck !== 'rules' && !CONTENT_KINDS.includes(ck)) {
            return fail(RULES_V2_ERROR_CODES.ENVELOPE_UNKNOWN, `content.${ck}`, `"${ck}" is not a content kind`);
        }
    }

    if (!Array.isArray(detachedVal.content.rules) || detachedVal.content.rules.length !== 1) {
        return fail(RULES_V2_ERROR_CODES.BAD_SCHEMA, 'content.rules', 'Pack must carry exactly one rules manifest in content.rules[0]');
    }

    // The manifest is `pack.<id>/rules`: no other record of the pack may take that ID.
    const taken = reservedRulesSlug(detachedVal.content);
    if (taken) return taken;

    // A pack with content.rules must say so: an old Story Block does not know the kind, and the capability
    // is how it learns that it cannot run this pack.
    if (!(detachedVal.requires.capabilities ?? []).includes(RULES_V2_CAPABILITY)) {
        return fail(RULES_V2_ERROR_CODES.MISSING_CAPABILITY, 'requires.capabilities', `A pack with content.rules must list "${RULES_V2_CAPABILITY}" in requires.capabilities`);
    }

    // Money: the display default is ours (SB's checkCurrency does not know it), so it is read here and
    // left out of the projection that SB checks, with an empty coin list.
    let currencyForSb = detachedVal.currency;
    if (isRecord(detachedVal.currency)) {
        const { display, ...rest } = detachedVal.currency;
        if (display !== undefined && !CURRENCY_DISPLAYS.includes(display)) {
            return fail(RULES_V2_ERROR_CODES.BAD_SCHEMA, 'currency.display', `currency.display must be one of ${CURRENCY_DISPLAYS.join(', ')}`);
        }
        if (Array.isArray(rest.coins) && rest.coins.length === 0) delete rest.coins;
        currencyForSb = rest;
    }

    // Run SB validatePack on detached legacy projection. A caller that has already done this pass on the same
    // pack (Story Block's own validatePack) says `envelope: false` and the checker goes straight on to the manifest
    // and the definitions it owns; its own cheap envelope checks above still run.
    if (envelope) {
        const legacyProj = clonePlain(detachedVal);
        delete legacyProj.content.rules;
        if (currencyForSb !== undefined) legacyProj.currency = currencyForSb;

        const hostCapabilities = Array.isArray(capabilities) && capabilities.every(name => typeof name === 'string') ? capabilities : null;
        const sbRes = validatePack(legacyProj, { hostVersion, capabilities: hostCapabilities, ...(limits ? { limits: { ...LIMITS, ...limits } } : {}) });
        if (!sbRes.ok) {
            const mapped = sbRes.errors.map(err => {
                if (err.code === 'UNKNOWN_FIELD' && !err.path.includes('.')) {
                    return { ...err, code: RULES_V2_ERROR_CODES.ENVELOPE_UNKNOWN };
                }
                if (err.code === 'UNKNOWN_KIND') {
                    return { ...err, code: RULES_V2_ERROR_CODES.ENVELOPE_UNKNOWN };
                }
                return err;
            });
            return { ok: false, errors: mapped };
        }
    }

    const normRes = normalizeRulesV2Of(detachedVal.content.rules[0], { packKey: detachedVal.id, constants: c });
    if (!normRes.ok) return normRes;

    const valRes = validateRulesV2Of(normRes.manifest, detachedVal.content, c, { host: !envelope });
    if (!valRes.ok) return valRes;

    const expRes = finishExpansion(valRes, hashes);
    if (!expRes.ok) return expRes;

    // Build clean normalized pack with text normalization, money and recipe defaults
    const normalizedPack = detachedVal;
    normalizedPack.content.rules = [normRes.manifest];
    if (isRecord(normalizedPack.currency)) applyCurrencyDefaults(normalizedPack.currency);
    if (Array.isArray(normalizedPack.content?.recipes)) {
        for (const r of normalizedPack.content.recipes) {
            if (r && typeof r === 'object' && r.known === undefined) {
                r.known = rulesV2Schema.$defs.recipe?.properties?.known?.default ?? true;
            }
        }
    }

    // packHash: the whole canonical pack (envelope included) + schema + constants
    let packHash;
    if (hashes) {
        const canonicalPack = buildCanonicalDocument(normalizedPack, detachedVal.id);
        packHash = sha256Text(JSON.stringify(sortKeys({ constants: c, pack: canonicalPack, schema: rulesV2Schema })));
    }

    return {
        ok: true,
        errors: [],
        pack: normalizedPack,
        raw,
        resolved: expRes.resolved,
        ...(hashes ? { rulesHash: expRes.rulesHash, packHash } : {}),
        warnings: valRes.warnings ?? [],
    };
}
