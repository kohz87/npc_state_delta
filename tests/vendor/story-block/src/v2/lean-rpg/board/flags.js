// The board's skill flags, inferred from a skill's words until the reader edits them.
// The defaults are a read only: old skill blocks and old roll records stay untouched.
// Overrides are keyed by the block, slot and skill name, so a replacement skill starts fresh.

import { fold } from '../read.js';

const AREA = /\b(?:area|all (?:foes|enemies|opponents|targets)|every (?:foe|enemy|opponent|target)|sweep(?:s|ing)?)\b/iu;
const DEFENCE = /\b(?:dodge|dodges|dodging|evade|evades|evading|evasion|parry|parries|parrying|defen[cs]e|defend|defends|block|blocks|ward|wards|avoid|avoids)\b/iu;

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

/** Use explicit boolean flags when present; older skills need no migration. */
export function skillFlags(skill, overrides = null) {
    const defaults = defaultFlags(skill);
    return Object.fromEntries(Object.keys(defaults).map(flag => [flag, typeof overrides?.[flag] === 'boolean' ? overrides[flag] : defaults[flag]]));
}
