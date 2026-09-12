// Inputs for a frozen oracle recorded from the pinned source, not a second scoring implementation.
const axes = ['trust', 'affection', 'desire', 'tension'];
const zero = () => Object.fromEntries(axes.map(axis => [axis, 0]));
export function* scoringCases() {
    const magnitudes = [0, 1, 24, 25, 26, 29, 30, 49, 50, 51, 69, 70, 74, 75, 76, 84, 85, 89, 90, 91, 94, 95, 99, 100];
    const tiers = ['none', 'ordinary', 'meaningful', 'major', 'extreme'];
    for (const axis of axes) for (const sign of [-1, 1]) for (const magnitude of magnitudes) {
        for (const tier of tiers) for (const delta of [-10, -3, -1, 0, 1, 3, 10]) {
            for (const carry of [-0.45, 0, 0.45]) for (const unlocked of [false, true]) {
                const scores = { ...zero(), [axis]: sign * magnitude };
                const progress = { ...zero(), [axis]: carry };
                const milestones = unlocked ? [25, 50, 75, 90].map(threshold => ({ axis, polarity: sign, threshold, reason: 'Fixture milestone.' })) : [];
                yield [scores, { ...zero(), [axis]: delta }, tier, undefined, progress, milestones];
            }
        }
    }
    // Overflow ties, signed mixed axes, and configured-cap minima are part of the baseline too.
    for (const values of [[1, 1, 0, 0], [5, 5, 5, 5], [5, 3, 3, 1], [1, -2, 3, -4], [-10, 10, -10, 10]]) {
        for (const tier of tiers) for (const sign of [-1, 1]) for (const magnitude of [0, 25, 50, 75, 90]) {
            for (const caps of [{ ordinary: 1, meaningful: 2, major: 5, extreme: 10 }, { ordinary: 2, meaningful: 3, major: 9, extreme: 18 }, { ordinary: 1, meaningful: 1, major: 2, extreme: 3 }]) {
                yield [Object.fromEntries(axes.map(axis => [axis, sign * magnitude])), Object.fromEntries(axes.map((axis, i) => [axis, values[i]])), tier, caps, zero(), []];
            }
        }
    }
}

// Ignore object property insertion order; compare numeric values and ordered history entries.
export function canonicalResult(value) {
    if (Array.isArray(value)) return value.map(canonicalResult);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalResult(value[key])]));
    return value;
}
