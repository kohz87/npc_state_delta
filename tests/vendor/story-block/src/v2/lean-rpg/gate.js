// The planner gate (prompt diet): the pre-call (precall.js) is a model call of its own, so it runs only when the dice may be wanted:
// (a) a fight is open (a foe group that is filled in and not Down), or (b) the reader's message reads as risky (the words below, or a
// skill the party has), or (c) the last reply opened foes: its Foes line is on the sheet before the next message, so (c) is (a).
// Otherwise there is no call and the reply goes on exactly as one the planner answered "none" to.
// Pure: the same sheet and message give the same answer on every swipe, regenerate and retry, so a replay never asks again.
import { fold } from './read.js';

// Verbs and nouns that mean an uncertain action: the planner's own words (attack, sneak, persuade, climb, lie, a parry, a dodge) and the
// Combat rules' (strike, wound, collapse). Each base word is read with its -s, -es, -ed, -d, -ing forms (and a doubled last letter: hit, hitting);
// IRREGULAR holds the forms that do not follow (struck, shot, fought, stole).
const BASE = [
    'attack', 'strike', 'stab', 'slash', 'hit', 'punch', 'kick', 'swing', 'smash', 'bash', 'fight', 'battle', 'duel', 'kill', 'slay', 'wound',
    'shoot', 'throw', 'hurl', 'cast', 'charge', 'ambush', 'grapple', 'wrestle', 'tackle', 'shove', 'disarm',
    'dodge', 'block', 'parry', 'evade', 'defend', 'brace', 'shield',
    'sneak', 'slip', 'hide', 'steal', 'pickpocket', 'lockpick', 'climb', 'jump', 'leap', 'swim', 'vault', 'scale',
    'persuade', 'convince', 'bluff', 'lie', 'deceive', 'threaten', 'intimidate', 'charm', 'seduce', 'haggle', 'bribe',
    // Weapons, flight, force, the senses and care: the review's phrases (draw and lunge, fire and loose, flee, break down, force, search, track, listen, heal).
    'lunge', 'thrust', 'fire', 'loose', 'aim', 'draw', 'flee', 'run', 'escape', 'chase', 'break', 'force', 'search', 'track', 'listen', 'spot', 'heal', 'resist', 'endure', 'try', 'attempt',
    // Cutting words (a reader who cuts the gnashers down with a sword is fighting).
    'cut', 'slice', 'cleave', 'hack', 'slaughter', 'butcher',
];
// (Planning too often costs one cheap "none"; dropping a roll costs the story its dice, so "listen" and "try" plan even in a calm sentence.
// "fire" the noun is the exception, see FIRE_NOUN.)
const IRREGULAR = ['hid', 'hidden', 'leapt', 'fled', 'ran', 'broke', 'broken', 'drew', 'drawn', 'tried', 'tries', 'sought', 'felt', 'healed', 'struck', 'shot', 'fought', 'stole', 'stolen', 'slew', 'slain', 'threw', 'thrown', 'swung', 'swam', 'crept', 'sneaked', 'snuck', 'lying', 'spell', 'spells', 'spar', 'sparring', 'brawl', 'skirmish'];

const formsOf = base => {
    const last = base.at(-1), stem = base.endsWith('e') ? base.slice(0, -1) : base;
    return [base, `${base}s`, `${base}es`, `${base}ed`, `${base}d`, `${base}ing`, `${stem}ing`, `${base}${last}ed`, `${base}${last}ing`];
};
const WORDS = new Set([...BASE.flatMap(formsOf), ...IRREGULAR]);
// "fire" and "fires" after one of these words is the noun ("by the fire", "a fire", "our fires"), not the act of firing.
const FIRE_NOUN = new Set(['the', 'a', 'an', 'by', 'of', 'in', 'near', 'to', 'around', 'from', 'our', 'my', 'your', 'his', 'her', 'their', 'its', 'this', 'that', 'camp', 'at', 'with', 'for', 'into', 'beside', 'over']);
// What reads as combat in a narrator reply: the fight words above (up to "shield") and these nouns.
const COMBAT = new Set([...BASE.slice(0, 33).flatMap(formsOf), 'struck', 'shot', 'fought', 'slew', 'slain', 'threw', 'swung', 'brawl', 'skirmish', 'combat', 'war',
    'enemy', 'enemies', 'foe', 'foes', 'hostile', 'hostiles', 'bandit', 'bandits', 'raider', 'raiders', 'assailant', 'assailants', 'attacker', 'attackers', 'monster', 'monsters',
    'sword', 'dagger', 'blade', 'blades', 'arrow', 'arrows', 'axe', 'spear', 'bow', 'blood', 'bleeding', 'wounds']);
// "pick a lock", "pick the lock", "picks locks", "picking the old lock"
const PICK_LOCK = /\bpick(?:s|ed|ing)?\s+(?:\p{L}+\s+){0,2}locks?\b/u;

const wordsOf = text => String(text ?? '').normalize('NFKC').toLowerCase().match(/\p{L}+(?:['’]\p{L}+)?/gu) ?? [];

/** Whether a fight is live on the sheet: some foe group is filled in and not Down. (quiet.js's `fightIsOpen` also counts a Down group that is still listed.) */
export const fightLive = sheet => (sheet?.foes ?? []).some(foe => foe.filled && foe.hurt > 0);

/** Whether the words hold a listed risk word ("fire" the noun does not count). */
const hasRiskWord = words => words.some((word, at) => WORDS.has(word) && !((word === 'fire' || word === 'fires') && FIRE_NOUN.has(words[at - 1])));

/** Whether a narrator reply reads as combat: a fight word or a hostile named. */
export const readsAsCombat = text => wordsOf(text).some(word => COMBAT.has(word));

/** Whether the reader's message reads as a risky action: a listed word (the fight verbs, cut and slice among them; a weapon or a wound as a noun, a bow, a foe named do not count: a narrator reply keeps those, `readsAsCombat`), "pick a lock", or one of the party's skills (by its name) or a listed foe. */
export function riskyMessage(text, sheet = null) {
    const message = String(text ?? '');
    if (hasRiskWord(wordsOf(message)) || PICK_LOCK.test(message.normalize('NFKC').toLowerCase())) return true;
    const folded = fold(message), words = wordsOf(message).map(fold);
    const names = [...(sheet?.characters ?? []).flatMap(entry => entry.skills.map(skill => skill.name)), ...(sheet?.foes ?? []).filter(foe => foe.filled).map(foe => foe.name)];
    // A name matches whole, or by any one word of it of 4 letters or more ("Short blade": blade, blades; a message word that begins with it).
    return names.some(name => {
        const key = fold(name);
        if (key.length >= 4 && folded.includes(key)) return true;
        return String(name ?? '').normalize('NFKC').toLowerCase().match(/\p{L}{4,}/gu)?.some(part => words.some(word => word.startsWith(part))) ?? false;
    });
}

/** Whether the pre-call is to ask the model for this message. `lastReply`: the narrator reply before it (its text), if any. */
export const plannerWanted = (sheet, message, lastReply = '') => fightLive(sheet) || riskyMessage(message, sheet) || readsAsCombat(lastReply);
