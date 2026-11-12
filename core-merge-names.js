/* NPC State Delta NPC name-in-text matching: title/common-word tables, whole-word matching and
   normalized phrase counts used by scan presence and scene matching. Split from core-merge.js
   without change; core-merge.js keeps the public exports. Never imports core-merge.js. */
import { normalizeName } from './core-text.js';
import { isRoleDescriptionLabel, normalizeGender } from './core-identity.js';

// Name/alias match used to bring an off-screen dossier into the next generation when the recent
// story names that NPC. It never changes presence.
// Titles and forms of address never identify one person on their own ("Lady", "Captain", "Capt.").
const NAME_TITLE_TOKENS = new Set([
    'lady', 'lord', 'sir', 'dame', 'madam', 'madame', 'mister', 'miss', 'mistress', 'master', 'captain',
    'commander', 'general', 'lieutenant', 'sergeant', 'major', 'colonel', 'admiral', 'doctor', 'professor',
    'father', 'mother', 'brother', 'sister', 'elder', 'king', 'queen', 'prince', 'princess', 'duke', 'duchess',
    'count', 'countess', 'baron', 'baroness', 'lady-in-waiting', 'saint', 'young', 'old', 'little', 'big',
    'capt', 'lt', 'sgt', 'cpl', 'col', 'gen', 'adm', 'cmdr', 'dr', 'mr', 'mrs', 'ms', 'mx', 'prof', 'rev', 'st', 'sr', 'jr',
    'of', 'the', 'von', 'van', 'de', 'del', 'della', 'der', 'den', 'du', 'la', 'le', 'al', 'bin', 'ibn',
]);
// Names that are also everyday words ("I will go"): matched only when written with a capital.
const COMMON_WORD_NAMES = new Set([
    'will', 'hope', 'grace', 'rose', 'mark', 'faith', 'joy', 'hunter', 'page', 'rich', 'bill', 'frank', 'sage', 'june',
    'dawn', 'summer', 'iris', 'lily', 'ruby', 'pearl', 'amber', 'jade', 'stone', 'black', 'white', 'brown', 'green',
    'wolf', 'bear', 'hawk', 'crow', 'raven', 'chase', 'drew', 'grant', 'honor', 'angel', 'star', 'rain', 'storm',
    'river', 'lake', 'glen', 'dale', 'forest', 'wood', 'hill', 'field', 'ford', 'mason', 'cook', 'baker', 'smith',
    'archer', 'fisher', 'miller', 'carter', 'cooper', 'porter', 'parker', 'taylor', 'sterling', 'rowan', 'ash',
]);

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// True when `word` stands as a whole word in the raw text starting with a capital letter.
function capitalisedWordIn(text, word) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(word)}(?![\\p{L}\\p{N}])`, 'giu');
    for (const match of String(text || '').matchAll(re)) {
        const first = match[0].charAt(0);
        if (first !== first.toLocaleLowerCase()) return true;
    }
    return false;
}

// A full name or alias always counts (a one-word alias only when capitalised); role descriptions
// ("the innkeeper") never count. Any other word of the name ("Hask" or "Orrin" for "Capt. Orrin
// Hask") counts when it has 4+ letters, is not a title, no other dossier's label carries it, and
// it is written with a capital (a first name may be lower-case unless it is an everyday word).
export function npcNamedInText(npc, text, roster = []) {
    const haystack = normalizeName(text);
    if (!haystack || !npc?.name) return false;
    const others = (Array.isArray(roster) ? roster : []).filter(other => other && other !== npc && other.id !== npc.id);
    const otherLabels = others.flatMap(other => [other.name, ...(other.aliases || [])]).map(normalizeName).filter(Boolean);
    const labels = [npc.name, ...(npc.aliases || [])].filter(label => label && !isRoleDescriptionLabel(label));
    for (const label of labels) {
        const needle = normalizeName(label);
        if (!needle || countNormalizedPhrase(haystack, needle) === 0) continue;
        // A label another dossier also carries ("Tomas") names nobody on its own, and a label
        // found only inside another dossier's longer name ("Mira" in "Lady Mira") is theirs.
        if (otherLabels.includes(needle)) continue;
        if (!needle.includes(' ') && label !== npc.name && !capitalisedWordIn(text, needle)) continue;
        // Mask every span of those longer labels (longest first, so overlapping labels such as
        // "Lady Mira Valen" and "Mira Valen" consume one span), then look for an independent mention.
        const masked = otherLabels
            .filter(other => other.length > needle.length && countNormalizedPhrase(other, needle) > 0)
            .sort((a, b) => b.length - a.length)
            .reduce((textSoFar, other) => textSoFar.replace(new RegExp(`(?<=^|\\s)${escapeRegExp(other)}(?=\\s|$)`, 'gu'), '#'), haystack);
        if (countNormalizedPhrase(masked, needle) === 0) continue;
        return true;
    }
    if (isRoleDescriptionLabel(npc.name)) return false;
    const tokens = normalizeName(npc.name).split(/\s+/).filter(Boolean);
    if (tokens.length < 2) return false;
    const firstPart = tokens.find(token => !NAME_TITLE_TOKENS.has(token)) || '';
    const otherTokens = new Set(otherLabels.flatMap(label => label.split(/\s+/)));
    for (const token of tokens) {
        if (token.length < 4 || NAME_TITLE_TOKENS.has(token)) continue;
        if (token === firstPart) {
            // A first name another dossier's label also starts with is ambiguous, and an occurrence
            // inside another dossier's named span ("Mira" in "Lady Mira Valen") is theirs.
            if (otherLabels.some(label => label.split(/\s+/)[0] === token)) continue;
            const masked = otherLabels
                .filter(other => other.length > token.length && countNormalizedPhrase(other, token) > 0)
                .sort((a, b) => b.length - a.length)
                .reduce((textSoFar, other) => textSoFar.replace(new RegExp(`(?<=^|\\s)${escapeRegExp(other)}(?=\\s|$)`, 'gu'), '#'), haystack);
            if (countNormalizedPhrase(masked, token) > 0 && (!COMMON_WORD_NAMES.has(token) || capitalisedWordIn(text, token))) return true;
            continue;
        }
        // Any other part (a surname) must be unique to this NPC and written with a capital.
        if (!otherTokens.has(token) && capitalisedWordIn(text, token)) return true;
    }
    return false;
}

export function countNormalizedPhrase(haystack, phrase) {
    if (!haystack || !phrase) return 0;
    const needle = ` ${phrase} `;
    let count = 0;
    let offset = 0;
    const padded = ` ${haystack} `;
    while ((offset = padded.indexOf(needle, offset)) !== -1) {
        count += 1;
        offset += Math.max(1, needle.length - 1);
    }
    return count;
}

// (name collisions) Two dossiers that share a label only through a PART of a longer name are not one person on that alone: a surname
// ("Pell" and "Vrena Pell"), a first word, or a name with a title dropped ("Varn" and "Master Varn"). `partialNamePair` finds such a pair;
// `identityConflict` says they are different people when their genders differ, or their roles share no word and the scanner did not say
// they are the same individual (`explicit`). A pair that is not partial, or has no conflict, matches exactly as before.
const bareTokens = label => normalizeName(label).split(/\s+/).filter(token => token && !NAME_TITLE_TOKENS.has(token));
export function partialNamePair(a, b) {
    const left = normalizeName(a);
    const right = normalizeName(b);
    if (!left || !right || left === right || isRoleDescriptionLabel(a) || isRoleDescriptionLabel(b)) return false;
    const [short, long] = bareTokens(a).length <= bareTokens(b).length ? [bareTokens(a), bareTokens(b)] : [bareTokens(b), bareTokens(a)];
    return short.length > 0 && short.every(token => long.includes(token));
}
const GENERIC_PLACE_WORDS = new Set(['near', 'from', 'with', 'into', 'outside', 'inside', 'room', 'hall', 'house',
    'street', 'road', 'square', 'market', 'tavern', 'city', 'town', 'village', 'district', 'quarter']);

export function placesOverlap(a, b) {
    const left = normalizeName(a);
    const right = normalizeName(b);
    if (!left || !right) return false;
    if (` ${left} `.includes(` ${right} `) || ` ${right} `.includes(` ${left} `)) return true;
    const words = new Set(left.split(' ').filter(word => word.length >= 4 && !GENERIC_PLACE_WORDS.has(word)));
    return right.split(' ').some(word => words.has(word));
}
const roleWords = role => new Set(normalizeName(role).split(/\s+/).filter(word => word.length >= 4));
// A role conflict alone is weak (the scanner words a role differently from scan to scan), so it blocks a merge only together with a second
// difference: the short name is the long one's surname ("Pell" / "Vrena Pell"), a title sits on one side only ("Varn" / "Master Varn"), or both
// have a place and the places do not overlap. A reworded role of the same person ("Vrena" / "Vrena Pell") still merges. Gender is stricter:
// a conflict there blocks on its own.
const titled = label => normalizeName(label).split(/\s+/).some(token => NAME_TITLE_TOKENS.has(token));
function secondDifference(a, b) {
    const [short, long] = bareTokens(a?.name).length <= bareTokens(b?.name).length ? [a, b] : [b, a];
    const shortTokens = bareTokens(short?.name), longTokens = bareTokens(long?.name);
    if (shortTokens.length === 1 && longTokens.length > 1 && longTokens.at(-1) === shortTokens[0]) return true;
    if (titled(a?.name) !== titled(b?.name)) return true;
    const places = record => [record?.location, record?.homeBase].filter(place => normalizeName(place));
    const left = places(a), right = places(b);
    return left.length > 0 && right.length > 0 && !left.some(place => right.some(other => placesOverlap(place, other)));
}
export function identityConflict(a, b, explicit = false) {
    const genderA = normalizeGender(a?.gender);
    const genderB = normalizeGender(b?.gender);
    if (genderA && genderB && genderA !== genderB) return true;
    if (explicit) return false;
    const wordsA = roleWords(a?.role);
    const wordsB = roleWords(b?.role);
    if (!wordsA.size || !wordsB.size) return false;
    const disjoint = ![...wordsA].some(word => wordsB.has(word) || [...wordsB].some(other => word.includes(other) || other.includes(word)));
    return disjoint && secondDifference(a, b);
}
