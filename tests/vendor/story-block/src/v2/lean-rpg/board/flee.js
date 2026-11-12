// The board's escape attempt is an AGI contest against the strongest standing foe group.
// It reads the same rules and seeded d20 stream as a fight, and returns a log line.
// A successful contest ends the fight; no character or foe bar moves here.

import { statPart, levelBonus } from '../formula.js';
import { FOE_LEVEL } from '../foes.js';
import { classTerm } from '../rules.js';
import { outcomeStd } from '../standard.js';

// `hard`: the harder-foes rule (setup.foesHard): the foe adds level / 4, as in its other rolls, and the line says so (`divisor`).
export function fleeRoll(actor, foes, rules, roll, { hard = false } = {}) {
    const foe = [...foes].filter(entry => entry.filled && entry.hurt > 0)
        .sort((a, b) => (b.level ?? 0) - (a.level ?? 0) || a.slot - b.slot)[0];
    if (!actor || !foe) return null;
    const part = statPart('check', actor.stats, { fittingStat: 'agi' });
    const term = classTerm(rules, actor), die = roll(), foeDie = roll();
    const leveled = Number.isInteger(rules.levelDivisor), classBonus = leveled ? levelBonus(foe.level, hard ? FOE_LEVEL.hardDivisor : rules.levelDivisor) : rules.foeClassWeight * foe.class;
    const total = die + part.value + term.classBonus, foeTotal = foeDie + rules.foeBase + classBonus;
    const outcome = outcomeStd(die, total, foeTotal, rules);
    return { kind: 'check', type: 'check', flee: true, skill: null, outcome, decisive: false,
        pc: { who: actor.who, die, stat: 'agi', second: part.second, statBonus: part.value, ...term, rank: 0, edge: 0, total },
        foe: { slot: foe.slot, name: foe.name, die: foeDie, base: rules.foeBase, classValue: foe.level, classBonus, ...(hard && leveled ? { divisor: FOE_LEVEL.hardDivisor } : {}), total: foeTotal },
        dc: foeTotal };
}
