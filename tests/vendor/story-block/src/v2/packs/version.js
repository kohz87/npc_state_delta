// Version ranges for `requires.storyBlock` (pure). A small subset of npm's semver ranges,
// enough for packs: `*`, `2`, `2.x`, `2.1`, `^2`, `^2.1`, `^2.1.3`, `~2.1`, `~2.1.3`,
// `>=2.0.0`, `>2`, `<3`, `<=2.4.0`, `=2.0.0`, `2.0.0`, comparators joined by spaces (all must
// hold) and alternatives joined by `||`. A comparator may name a pre-release (`>=2.0.0-alpha.3`).
//
// Pre-releases order the semver way (R2-b7-1): 2.0.0-alpha.1 < 2.0.0-alpha.3 < 2.0.0-beta < 2.0.0
// (identifiers compared one by one, numbers as numbers and below words, a shorter list first). A
// bound written as a whole version without a tag (`>=2.0.0`, `=2.0.0`) means that release, so an alpha
// host does not meet `>=2.0.0`. A bound the range only implies (`^2`, `~2.1`, `2.x`, `<3`, and the
// top of `^`/`~`) takes in that version's pre-releases, so packs written for `^2` work during the v2
// alpha, and `^2` ends before 3.0.0-alpha.

import { SEMVER } from './limits.js';

const PART = /^(>=|<=|>|<|=|\^|~)?\s*(\*|x|\d+)(?:\.(\*|x|\d+))?(?:\.(\*|x|\d+))?(?:-([0-9A-Za-z.-]+))?$/i;

const tagOf = text => String(text).split('.').map(part => (/^\d+$/.test(part) ? Number(part) : part));

/**
 * [major, minor, patch, pre] of a version string; `pre` is null for a release, else the pre-release's
 * identifiers ([] is below every pre-release of that version). Null when not a version.
 */
export function parseVersion(text) {
    const written = String(text ?? '').trim();
    const match = SEMVER.exec(written);
    if (!match) return null;
    const tag = /^[^-+]*-([^+]+)/.exec(written)?.[1];
    return [Number(match[1]), Number(match[2]), Number(match[3]), tag ? tagOf(tag) : null];
}

function comparePre(a, b) {
    if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
        const x = a[i];
        const y = b[i];
        if (x === y) continue;
        if (typeof x === 'number' && typeof y === 'number') return x - y;
        if (typeof x === 'number') return -1;
        if (typeof y === 'number') return 1;
        return x < y ? -1 : 1;
    }
    return a.length - b.length;
}

/** Negative, 0 or positive as version `a` comes before, with or after `b` ([major, minor, patch, pre?]). */
export const compareVersions = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]) || comparePre(a[3] ?? null, b[3] ?? null);

/** A parsed version as text: "2.1.0", "2.0.0-alpha.3". */
export const formatVersion = v => `${v[0]}.${v[1]}.${v[2]}${Array.isArray(v[3]) && v[3].length ? `-${v[3].join('.')}` : ''}`;

const compare = compareVersions;
const wild = part => part === undefined || part === '*' || part.toLowerCase() === 'x';

// One comparator as a list of [operator, version] checks; null when it does not parse.
function comparator(text) {
    const match = PART.exec(text);
    if (!match) return null;
    const [, op = '', a, b, c, tag] = match;
    const raw = [a, b, c];
    if (wild(raw[0])) return op === '' || op === '=' || op === '>=' ? [] : null;
    const nums = raw.map(part => (wild(part) ? null : Number(part)));
    const given = nums.findIndex(n => n === null);
    const depth = given < 0 ? 3 : given;                    // how many parts were written
    // A written tag is that pre-release; a whole version without one is the release; a partial one
    // (or a bound only implied) starts below its pre-releases.
    const pre = tag ? tagOf(tag) : depth === 3 ? null : [];
    const low = [nums[0], nums[1] ?? 0, nums[2] ?? 0, pre];
    const floor = [low[0], low[1], low[2], tag ? pre : []];
    const bump = index => {                                  // the first version past `index`, below its pre-releases
        const next = [low[0], low[1], low[2], []];
        next[index] += 1;
        for (let i = index + 1; i < 3; i += 1) next[i] = 0;
        return next;
    };
    if (op === '^') {
        const first = low[0] > 0 || depth === 1 ? 0 : low[1] > 0 || depth === 2 ? 1 : 2;
        return [['>=', floor], ['<', bump(first)]];
    }
    if (op === '~') return [['>=', floor], ['<', bump(depth === 1 ? 0 : 1)]];
    if (op === '' || op === '=') return depth === 3 ? [['=', low]] : [['>=', floor], ['<', bump(depth - 1)]];
    if (op === '>') return depth === 3 ? [['>', low]] : [['>=', bump(depth - 1)]];
    if (op === '<=') return depth === 3 ? [['<=', low]] : [['<', bump(depth - 1)]];
    return [[op, low]];
}

/** The range as alternatives of checks; null when any part does not parse. */
export function parseRange(range) {
    const text = String(range ?? '').trim();
    if (!text || text.length > 100) return null;
    const alternatives = [];
    for (const alternative of text.split('||')) {
        const parts = alternative.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean);
        if (!parts.length) return null;
        const checks = [];
        for (const part of parts) {
            const parsed = comparator(part);
            if (!parsed) return null;
            checks.push(...parsed);
        }
        alternatives.push(checks);
    }
    return alternatives;
}

const HOLDS = { '=': c => c === 0, '>': c => c > 0, '>=': c => c >= 0, '<': c => c < 0, '<=': c => c <= 0 };

/** Does `version` satisfy `range`? False when either does not parse. */
export function satisfies(version, range) {
    const v = parseVersion(version);
    const alternatives = parseRange(range);
    if (!v || !alternatives) return false;
    return alternatives.some(checks => checks.every(([op, target]) => HOLDS[op](compare(v, target))));
}
