// The board's skill flags, inferred from a skill's words until the reader edits them.
// The defaults are a read only: old skill blocks and old roll records stay untouched.
// Overrides are keyed by the block, slot and skill name, so a replacement skill starts fresh.

import { fold } from '../read.js';

const AREA = /\b(?:area|all (?:foes|enemies|opponents|targets)|every (?:foe|enemy|opponent|target)|sweep(?:s|ing)?)\b/iu;
const DEFENCE = /\b(?:dodge|dodges|dodging|evade|evades|evading|evasion|parry|parries|parrying|defen[cs]e|defend|defends|block|blocks|ward|wards|avoid|avoids)\b/iu;
const HEALING = /\b(?:heal|heals|healing|mend|mends|mending|restore|restores|restoring|recover|recovers|recovering|remedy|remedies|cure|cures|curing|soothe|soothes|soothing|revive|revives|reviving)\b/iu;

/** Whether a skill describes healing, as Auto and the marked board both understand it. */
export const healingSkill = skill => skill?.healing === true || skill?.support === true || skill?.kind === 'heal'
    || HEALING.test(`${skill?.name ?? ''} ${skill?.about ?? ''} ${skill?.describe ?? ''}`);

/** The inferred flags are independent; a skill can attack an area and also defend. */
export function defaultFlags(skill) {
    const words = `${skill?.name ?? ''} ${skill?.about ?? ''}`;
    const area = AREA.test(words), defence = DEFENCE.test(words);
    return { target: !area && !defence, area, defence };
}

/** A stable key for one named skill in a slot (not a list position used for reply bookkeeping). */
export function skillKey(module, skill) {
    return JSON.stringify([String(module ?? ''), Number(skill?.slot) || 0, fold(skill?.name ?? '')]);
}

/** A utility skill (the Skills block's `type`, read.js skillsOf) is for the story: the board never offers it, Auto never picks it, and it is never a defence. */
export const isUtility = skill => skill?.type === 'utility';

/** Use explicit boolean flags when present; older skills need no migration. A utility skill has none. */
export function skillFlags(skill, overrides = null) {
    if (isUtility(skill)) return { target: false, area: false, defence: false };
    const defaults = defaultFlags(skill);
    return Object.fromEntries(Object.keys(defaults).map(flag => [flag, typeof overrides?.[flag] === 'boolean' ? overrides[flag] : defaults[flag]]));
}

/**
 * Whether a fight on this sheet plays the harder-foes rule (`setup.foesHard`): the party has the doubled bars (every character scale 2; the rule's hits are tuned for that
 * Health) and every foe is on a new Foes block. Filled foes decide; with none filled (the odds shown in Settings) the Foes block's slots do. One predicate for the board's
 * opening and the odds, so what is shown is what is played.
 */
export const hardFightFor = sheet => {
    const characters = sheet?.characters ?? [], foes = sheet?.foes ?? [], filled = foes.filter(foe => foe.filled), list = filled.length ? filled : foes;
    return characters.length > 0 && characters.every(actor => actor.scale === 2) && list.length > 0 && list.every(foe => foe.hard === 1);
};
