// Version ranges for `requires.storyBlock` (pure). A small subset of npm's semver ranges,
// enough for packs: `*`, `2`, `2.x`, `2.1`, `^2`, `^2.1`, `^2.1.3`, `~2.1`, `~2.1.3`,
// `>=2.0.0`, `>2`, `<3`, `<=2.4.0`, `=2.0.0`, `2.0.0`, comparators joined by spaces (all must
// hold) and alternatives joined by `||`.
//
// The host's pre-release tag is ignored when comparing (2.0.0-alpha.3 counts as 2.0.0), so
// packs written for `^2` work during the v2 alpha.

import { SEMVER } from './limits.js';

const PART = /^(>=|<=|>|<|=|\^|~)?\s*(\*|x|\d+)(?:\.(\*|x|\d+))?(?:\.(\*|x|\d+))?(?:-[0-9A-Za-z.-]+)?$/i;

/** [major, minor, patch] of a version string, pre-release dropped; null when not a version. */
export function parseVersion(text) {
    const match = SEMVER.exec(String(text ?? '').trim());
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

const compare = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
const wild = part => part === undefined || part === '*' || part.toLowerCase() === 'x';

// One comparator as a list of [operator, version] checks; null when it does not parse.
function comparator(text) {
    const match = PART.exec(text);
    if (!match) return null;
    const [, op = '', ...raw] = match;
    if (wild(raw[0])) return op === '' || op === '=' || op === '>=' ? [] : null;
    const nums = raw.map(part => (wild(part) ? null : Number(part)));
    const given = nums.findIndex(n => n === null);
    const depth = given < 0 ? 3 : given;                    // how many parts were written
    const low = [nums[0], nums[1] ?? 0, nums[2] ?? 0];
    const bump = index => {                                  // the first version past `index`
        const next = [...low];
        next[index] += 1;
        for (let i = index + 1; i < 3; i += 1) next[i] = 0;
        return next;
    };
    if (op === '^') {
        const first = low[0] > 0 || depth === 1 ? 0 : low[1] > 0 || depth === 2 ? 1 : 2;
        return [['>=', low], ['<', bump(first)]];
    }
    if (op === '~') return [['>=', low], ['<', bump(depth === 1 ? 0 : 1)]];
    if (op === '' || op === '=') return depth === 3 ? [['=', low]] : [['>=', low], ['<', bump(depth - 1)]];
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
