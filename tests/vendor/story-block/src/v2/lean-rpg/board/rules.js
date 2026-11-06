// Pure board choices for weapon attacks and automatic defence.
// They read a character's effective stats, skills and equipped weapon; they write no sheet state.
// The ordinary roll code still performs the dice and spends any resource.

import { statPart } from '../formula.js';
import { skillFlags } from './flags.js';

const finite = value => (Number.isFinite(value) ? value : 0);
const LIGHT = /\b(?:light[ -]?(?:blade|sword|weapon)|finesse|rapier|dagger|dirk|stiletto|short[ -]?sword|cane[ -]?sword)\b/iu;

/** A weapon's eligible stats compete on the wielder's sheet; ties favour STR, then AGI, then DEX. */
export function attackStat(character, weapon = null) {
    const words = [weapon?.name, weapon?.kind, weapon?.type, weapon?.slot, ...(Array.isArray(weapon?.tags) ? weapon.tags : [])].filter(Boolean).join(' ');
    const stats = weapon?.stats && typeof weapon.stats === 'object' ? weapon.stats : {};
    const keyed = Object.fromEntries(Object.entries(stats).map(([key, value]) => [key.toLowerCase(), value]));
    const light = LIGHT.test(words), options = ['str'];
    if (light || finite(keyed.agi) > 0) options.push('agi');
    if (light || finite(keyed.dex) > 0) options.push('dex');
    return options.reduce((best, stat) => finite(character?.stats?.[stat]) > finite(character?.stats?.[best]) ? stat : best, 'str');
}

/** The strongest available evasion skill, measured by the bonus its defence roll would use. */
export function bestDefence(character, flagsFor = () => null, { againstMagic = false } = {}) {
    const skills = Array.isArray(character?.skills) ? character.skills : [];
    let best = null;
    for (const skill of skills) {
        if (!skillFlags(skill, flagsFor(skill)).defence) continue;
        const resource = skill.uses === 'mana' ? 'mana' : 'stamina';
        if (character?.[resource] === 0) continue;
        const bonus = statPart('defence', character?.stats, { skillStat: skill.stat, againstMagic }).value + finite(skill.rank);
        if (!best || bonus > best.bonus) best = { skill, bonus };
    }
    return best?.skill ?? null;
}
