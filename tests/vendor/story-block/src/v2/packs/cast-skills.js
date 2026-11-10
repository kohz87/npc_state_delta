// A cast member's signature skills (`cast[].skills`, docs/v2/PACKS.md "The cast"): the skills a person brings when they join the party, in the order written.
// Pure: the enabled packs in, plain rows out. The seeding itself is data-modules/part.js (join and return).

import { foldKey, oneLine } from '../../text.js';

/** The ranks a pack writes, in order (the Skills block's rank numbers 0 to 3). */
export const CAST_SKILL_RANKS = Object.freeze(['novice', 'adept', 'expert', 'master']);

/**
 * The cast entry a name means (its name or an alias, folded) and its signature skills: `{ id, name, aliases, pack, skills: [{ name, about, stat, uses, rank, type? }] }`
 * (`rank` 0 to 3; `type: 'utility'` only on a utility skill, a combat one has no key), or null. `packs`: the enabled packs (`packs.packs()`); the first pack with the person wins.
 */
export function castSkillsOf(packs, name) {
    const key = foldKey(oneLine(name));
    if (!key) return null;
    for (const pack of Array.isArray(packs) ? packs : []) {
        const person = (pack?.content?.cast ?? []).find(entry => [entry.name, ...(entry.aliases ?? [])].some(each => foldKey(each) === key));
        if (!person) continue;
        const skills = (person.skills ?? []).map(skill => ({ name: skill.name, about: skill.about, stat: skill.stat, uses: skill.uses ?? 'stamina', rank: Math.max(0, CAST_SKILL_RANKS.indexOf(skill.rank ?? 'novice')), ...(skill.type === 'utility' ? { type: 'utility' } : {}) }));
        return { id: person.id, name: person.name, aliases: [...(person.aliases ?? [])], pack: pack.id, skills };
    }
    return null;
}
