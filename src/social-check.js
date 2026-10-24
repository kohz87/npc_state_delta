// Social checks against an NPC (feature npc-state-delta.social): how an NPC's dossier stage and
// meters change the difficulty of a social check the player makes against them. Delta owns these
// rules; the dice belong to whoever rolls (RPG Battle reads the answer through its "check modifiers
// from other modules" hook). Read-only: nothing here writes state, sends a prompt or calls the model.
//
//   npc.socialModifier({ name, skill }) → { mod, name, skill, reasons: [{ text, value }] } | null
//
// * `skill`: a social skill word (SKILL_WORDS): persuade, charm (seduce), intimidate, deceive, or the
//   generic `social`. Any other word (Athletics, Stealth, "sleight of hand") is null, so a non-social
//   check is never touched.
// * `mod`: a whole number added to the d20 roll, within ±cap (setting `socialCap`, default 5).
//   `reasons` are the parts, in a fixed order (meters in Delta's order, then the stage ladder, then
//   the disposition word), and always add up to `mod`; a part of 0 is left out. A check display
//   shows each as `${text} (${signed value})`: "Elula trusts you (+2)", "Old Hob is wary of you (−1)".
// * The rules (all here, all whole numbers):
//   1. Each meter the skill uses (SKILL_METERS) counts by how far it is from 0, as a share of its
//      range's far end (a built-in −100..100 meter as is; a 0..100 custom one the same; a 0..10 one ×10):
//      25 or more → 1, 50 or more → 2, 75 or more → 3 (STEPS), signed like the value and multiplied by
//      the skill's weight for that meter (+1 helps the player, −1 works against them). A meter the
//      reader does not have (fear, loyalty, respect, … are custom meters) is skipped.
//   2. The stage ladder (feature npc-state-delta.stages): +1 for each rung reached, at most +2
//      (RANK_BONUS_MAX), for every skill but intimidate.
//   3. The NPC's disposition word (the slice's `disposition`, from "~ npc Name | disposition: wary"):
//      a warm word +1, a cold word −1 for every skill but intimidate; a frightened word +1 and a
//      defiant word −1 for intimidate (DISPOSITION_WORDS).
//   4. Each part is multiplied by the scale (setting `socialScale`, a percent, default 100; 0 turns
//      every modifier to 0) and rounded half away from 0; the sum is held to ±cap, and when it is
//      held, one last reason ("Held to the most a check moves") carries the difference.
//
// Pure: no DOM, no clock, no randomness; the same entry, settings and skill give the same answer.

export const FEATURE_SOCIAL = 'npc-state-delta.social';
export const SOCIAL_QUERY = 'npc.socialModifier';
export const SOCIAL_SKILLS = Object.freeze(['persuade', 'charm', 'intimidate', 'deceive', 'social']);
export const DEFAULT_SOCIAL_SCALE = 100;
export const MAX_SOCIAL_SCALE = 200;
export const DEFAULT_SOCIAL_CAP = 5;
export const MAX_SOCIAL_CAP = 10;
export const RANK_BONUS_MAX = 2;
/** How far from 0 (as a share of the meter's far end, 0..100) earns 1, 2, 3 points. */
export const STEPS = Object.freeze([25, 50, 75]);

/** The words a check may name, by the skill they mean (matched as whole words, any case). */
export const SKILL_WORDS = Object.freeze({
    persuade: Object.freeze(['persuade', 'persuasion', 'convince', 'negotiate', 'negotiation', 'diplomacy', 'plead', 'bargain', 'barter', 'haggle']),
    charm: Object.freeze(['charm', 'seduce', 'seduction', 'flirt', 'flirting', 'allure']),
    intimidate: Object.freeze(['intimidate', 'intimidation', 'threaten', 'coerce', 'menace', 'bully']),
    deceive: Object.freeze(['deceive', 'deception', 'lie', 'bluff', 'trickery', 'mislead', 'feint']),
    social: Object.freeze(['social', 'charisma', 'cha', 'speech', 'speechcraft', 'etiquette', 'rapport']),
});

/**
 * Which meters each skill reads and which way: +1 a high value helps the player, −1 it works against
 * them. Built-in meters first; the others are the custom meters of Delta's presets (loyalty, respect,
 * rivalry, approval) and two common ones a reader may add (fear, suspicion).
 */
export const SKILL_METERS = Object.freeze({
    persuade: Object.freeze({ trust: 1, tension: -1, loyalty: 1, respect: 1, approval: 1, suspicion: -1, rivalry: -1 }),
    charm: Object.freeze({ affection: 1, desire: 1, tension: -1 }),
    intimidate: Object.freeze({ trust: -1, tension: 1, fear: 1, respect: -1 }),
    deceive: Object.freeze({ trust: 1, tension: -1, suspicion: -1 }),
    social: Object.freeze({ trust: 1, affection: 1, tension: -1, loyalty: 1, respect: 1, approval: 1 }),
});

/** Disposition words (the first word of the slice's `disposition`) and what they give. */
export const DISPOSITION_WORDS = Object.freeze({
    warm: Object.freeze(['friendly', 'warm', 'fond', 'kind', 'grateful', 'loyal', 'devoted', 'cheerful', 'open', 'helpful', 'trusting']),
    cold: Object.freeze(['wary', 'suspicious', 'guarded', 'cold', 'distrustful', 'hostile', 'angry', 'annoyed', 'irritated', 'bitter', 'resentful']),
    afraid: Object.freeze(['afraid', 'scared', 'fearful', 'frightened', 'nervous', 'cowed', 'terrified', 'timid']),
    defiant: Object.freeze(['defiant', 'fearless', 'brave', 'bold', 'unafraid', 'stubborn']),
});

/** What a meter's value says, high (+) and low (−); a meter not listed reads "<Name>: <label> high/low". */
const METER_WORDS = Object.freeze({
    trust: ['trusts you', 'distrusts you'],
    affection: ['is fond of you', 'dislikes you'],
    desire: ['is drawn to you', 'is put off by you'],
    tension: ['is wary of you', 'is at ease with you'],
    fear: ['fears you', 'is not afraid of you'],
    loyalty: ['is loyal to you', 'owes you little loyalty'],
    respect: ['respects you', 'looks down on you'],
    approval: ['approves of you', 'disapproves of you'],
    suspicion: ['suspects you', 'takes you at your word'],
    rivalry: ['sees you as a rival', 'does not see you as a rival'],
});

const NAME_MAX = 60;
const TEXT_MAX = 100;
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
// Flattened to one line and cut by code points (a surrogate pair is never split).
const clean = (value, max) => [...String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, max).join('').trim();
const words = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const intIn = (value, min, max, fallback) => (Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback);
// Half away from 0, so −1.5 and +1.5 round alike.
const roundAway = value => Math.sign(value) * Math.round(Math.abs(value));

const SKILL_BY_WORD = new Map(Object.entries(SKILL_WORDS).flatMap(([skill, list]) => list.map(word => [word, skill])));
const DISPOSITION_BY_WORD = new Map(Object.entries(DISPOSITION_WORDS).flatMap(([kind, list]) => list.map(word => [word, kind])));

/**
 * The social skill a check's skill word means, or null: "Persuasion" → persuade, "seduce" → charm,
 * "Deception (CHA)" → deceive, "cha" → social. The first word that names a skill decides.
 */
export function socialSkill(value) {
    if (typeof value !== 'string') return null;
    for (const word of words(value)) {
        const skill = SKILL_BY_WORD.get(word);
        if (skill) return skill;
    }
    return null;
}

/** The scale (percent) and cap from Delta's stored settings, clamped: { scale, cap }. */
export function socialSettings(raw = {}) {
    const source = isObject(raw) ? raw : {};
    return {
        scale: intIn(source.socialScale, 0, MAX_SOCIAL_SCALE, DEFAULT_SOCIAL_SCALE),
        cap: intIn(source.socialCap, 1, MAX_SOCIAL_CAP, DEFAULT_SOCIAL_CAP),
    };
}

/** Points for a meter's value: 0..3 by STEPS on its share of the range's far end, signed like the value. */
export function meterPoints(value, def) {
    if (!Number.isInteger(value) || !value) return 0;
    const reach = Math.max(Math.abs(Number(def?.min) || 0), Math.abs(Number(def?.max) || 0)) || 100;
    const share = Math.abs(value) * 100 / reach;
    const points = STEPS.filter(step => share >= step).length;
    return Math.sign(value) * points;
}

/**
 * The modifier for one NPC and one social skill (rules in the header).
 *   name         the NPC's name as the reasons show it
 *   skill        one of SOCIAL_SKILLS (socialSkill's answer)
 *   meters       [{ def, value, stage }] in Delta's meter order (def: { id, label, min, max })
 *   rank         { name, index } the ladder rung reached (index from 0), or null
 *   disposition  the slice's disposition word, or ''
 *   settings     { scale, cap } (socialSettings)
 * → { mod, name, skill, reasons: [{ text, value }] }.
 */
export function socialModifier({ name, skill, meters = [], rank = null, disposition = '', settings = socialSettings() }) {
    const who = clean(name, NAME_MAX) || 'They';
    const weights = SKILL_METERS[skill] ?? {};
    const raw = [];
    for (const { def, value, stage } of Array.isArray(meters) ? meters : []) {
        const weight = weights[def?.id];
        if (!weight) continue;
        const points = meterPoints(value, def);
        if (!points) continue;
        const said = METER_WORDS[def.id]?.[points > 0 ? 0 : 1] ?? `${clean(def.label, 40).toLocaleLowerCase()} ${points > 0 ? 'high' : 'low'}`;
        const where = clean(stage, 40);
        raw.push({ text: `${who} ${said}${where ? ` (${where})` : ''}`, value: points * weight });
    }
    if (skill !== 'intimidate' && rank && Number.isInteger(rank.index) && rank.index >= 0) {
        raw.push({ text: `${who}: ${clean(rank.name, 40) || 'stage reached'}`, value: Math.min(RANK_BONUS_MAX, rank.index + 1) });
    }
    const word = words(disposition)[0] ?? '';
    const kind = DISPOSITION_BY_WORD.get(word);
    const given = skill === 'intimidate'
        ? (kind === 'afraid' ? 1 : kind === 'defiant' ? -1 : 0)
        : (kind === 'warm' ? 1 : kind === 'cold' ? -1 : 0);
    if (given) raw.push({ text: `${who} is ${clean(disposition, 40)}`, value: given });

    const { scale, cap } = settings;
    const reasons = raw
        .map(reason => ({ text: clean(reason.text, TEXT_MAX), value: roundAway(reason.value * scale / 100) }))
        .filter(reason => reason.value !== 0);
    const sum = reasons.reduce((total, reason) => total + reason.value, 0);
    const mod = Math.min(cap, Math.max(-cap, sum));
    if (mod !== sum) reasons.push({ text: `Held to the most a check moves (${mod > 0 ? '+' : '−'}${cap})`, value: mod - sum });
    return { mod, name: who, skill, reasons };
}
