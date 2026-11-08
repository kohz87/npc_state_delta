// The doubled bar sizes of the Standard Character block ("scale 2"): Health, Stamina and Mana are each 2 x (4 + stat/5), and the block says so with
// `scale: 2` on its three bars. `scaledCharacter` turns the Character definition as it was made before (templates.js `characterV1For`, which stays
// frozen and has no mark) into the new one: the size expressions of the kinds, the grow rules and Rest, the bars' maximum and default, the hidden
// size fields. A pin with no mark keeps today's sizes, damage and costs forever; only a block made from this definition carries the mark.
// Pure: no state, no randomness. (It does not import templates.js, which imports it.)
import { STANDARD_NUMBERS, STAT_KEYS, blocksFor } from './formula.js';

const BARS = ['health', 'stamina', 'mana'];

const statsAt = value => Object.fromEntries(STAT_KEYS.map(key => [key, value]));
/** The biggest each bar can be (every stat at its maximum), and what a new character's bars hold (every stat at the starting value). */
export const BAR_MAX = Object.freeze(blocksFor(statsAt(STANDARD_NUMBERS.statMax), 2));
export const BAR_START = Object.freeze(blocksFor(statsAt(STANDARD_NUMBERS.startStat), 2));

const get = field => ['get', [field]];
const STAT_OF = { health: 'vit', stamina: 'agi', mana: 'int' };
// 4 + stat/5 as one division, (stat + 20) / 5, so the doubled size 2 x (4 + stat/5) nests no deeper than a block's expression budget allows (data-modules DM_LIMITS.expressionDepth).
const half = bar => ['floorDiv', ['add', get(STAT_OF[bar]), 4 * 5], 5];
const sizeOf = bar => ['mul', 2, half(bar)];

// Walks a definition's kinds: the old size expression becomes the doubled one, and a stage word's blocks `word x size` become `(word x 2) x half`, the same number one level shallower.
function swap(node, oldSize) {
    if (Array.isArray(node)) {
        const bar = BARS.find(name => JSON.stringify(node) === JSON.stringify(oldSize[name]));
        if (bar) return sizeOf(bar);
        const times = node[0] === 'mul' ? BARS.find(name => JSON.stringify(node[2]) === JSON.stringify(oldSize[name])) : null;
        if (times) return ['mul', ['mul', swap(node[1], oldSize), 2], half(times)];
        return node.map(item => swap(item, oldSize));
    }
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, swap(value, oldSize)]));
    return node;
}

// The size rule of a bar, as two: a bar that grew gains the new blocks full (not while Down), then the stored size and the shrink cap. (Split so each expression fits the budget.)
const barRules = bar => [
    { id: `${bar}-grow`, when: ['and', ['gt', get(bar), 0], ['gt', sizeOf(bar), get(`${bar}-blocks`)]],
        then: [{ op: 'add', path: [bar], value: ['sub', sizeOf(bar), get(`${bar}-blocks`)], bounds: 'clamp' }] },
    { id: `${bar}-bar`, when: ['ne', get(`${bar}-blocks`), sizeOf(bar)],
        then: [{ op: 'set', path: [`${bar}-blocks`], value: sizeOf(bar) }, { op: 'set', path: [bar], value: ['min', get(bar), sizeOf(bar)] }] },
];

/** The Character definition with scale 2, made from the one without (`oldSize`: the old size expression of each bar, templates.js SIZE). */
export function scaledCharacter(old, oldSize) {
    const definition = structuredClone(old);
    definition.kinds = swap(definition.kinds, oldSize);
    definition.rules = definition.rules.flatMap(rule => {
        const bar = BARS.find(name => rule.id === `${name}-bar`);
        return bar ? barRules(bar) : [swap(rule, oldSize)];
    });
    for (const bar of BARS) {
        definition.state[bar] = { ...definition.state[bar], max: BAR_MAX[bar], default: BAR_START[bar], scale: 2 };
        definition.state[`${bar}-blocks`] = { ...definition.state[`${bar}-blocks`], max: BAR_MAX[bar], default: BAR_START[bar] };
    }
    return definition;
}
