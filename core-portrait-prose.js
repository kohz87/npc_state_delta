/* NPC State Delta natural-language portrait prose: sentence assembly for the natural prompt format.
   Split unchanged from core-portrait.js; buildNaturalPortraitProse is module-internal rather than
   a public core export. */
import { normalizeName } from './core-text.js';
import { portraitPartKey } from './core-portrait-visuals.js';

function portraitProseLower(value) {
    const text = String(value ?? '').trim();
    const word = text.match(/^[A-Z][a-z'-]*(?=\s|$|[,;.])/);
    return word && !/[A-Z]/.test(text.slice(1, word[0].length)) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

function portraitProseUpper(value) {
    const text = String(value ?? '').trim();
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

function portraitProseClean(value) {
    return String(value ?? '').replace(/\s+/g, ' ').replace(/^[,;:\s]+|[,;:.\s]+$/g, '').trim();
}

function portraitProseArticle(phrase) {
    const text = String(phrase || '').trim();
    if (/^(?:a|an|the|his|her|their|its|one|some)(?=\s|$)/i.test(text)) return text;
    // By sound, not by letter: "a unicorn-kin", "a utopian", "an uninvited", "an 18-year-old", "an hour-old".
    const yoo = /^(?:uni(?!n|d)|use|usu|uti(?!l)|uto|ute|uro|ura|eu|one|once|ubiq|ufo|uk)/i.test(text) || /^unanim|^unilat|^unif/i.test(text);
    const vowelSound = /^(?:8\d?|11|18)(?!\d)/.test(text)
        || (/^[aeiou]/i.test(text) && !yoo)
        || /^(?:hour|honest|honou?r|heir)/i.test(text);
    return (vowelSound ? 'an ' : 'a ') + text;
}

// A clause that is only an adjective ("burly", "tall") describes the subject itself: "a burly man", never "with burly".
// Lower case only: a capitalised word ("Red") is a name or a colour, not read as an adjective.
const PORTRAIT_ADJECTIVE = /^(?:tall|short|slim|slender|thin|lean|stout|stocky|burly|brawny|muscular|pale|dark|fair|tan|young|old|elderly|ancient|small|large|big|huge|tiny|petite|plump|fat|heavy|lithe|lanky|wiry|gaunt|frail|sturdy|rugged|handsome|beautiful|pretty|plain|striking|androgynous|scrawny|willowy|curvy|chubby|bald|blind|weathered|broad-shouldered)$/i;
const PORTRAIT_ADJECTIVE_SUFFIX = /^[a-z]{3,}(?:ed|ful|ous|ish|ive|ly)$/;
function portraitProseIsAdjective(item, original = item) {
    const text = String(item || '').trim();
    if (!/^[A-Za-z][A-Za-z-]*$/.test(text)) return false;
    // The suffix guess is for lower-case words only: "Red" is a name or a colour.
    return PORTRAIT_ADJECTIVE.test(text) || (/^[a-z]/.test(String(original || '').trim()) && PORTRAIT_ADJECTIVE_SUFFIX.test(text));
}

// A people named first and then a trade or kind ("elf ranger") is still that people; plurals ("elves") read as the singular.
const PORTRAIT_HUMANOID_FIRST = /^(?:humans?|elf|elves|elven|dwarf|dwarves|dwarven|orcs?|goblins?|halflings?|gnomes?|tieflings?|ogres?|trolls?|centaurs?)$/i;
// The head noun is judged as a whole word. A hyphenated word is judged by its own pattern (half-elf, fox-beastfolk,
// bat-kin) or by its last part (wood-elf is an elf, elf-hound is a hound); the first part never decides.
const PORTRAIT_HUMANOID_WORD = /^(?:humans?|humanoids?|persons?|people|mortals?|elf|elves|elven|dwarf|dwarves|dwarven|orcs?|goblins?|halflings?|gnomes?|tieflings?|demons?|angels?|vampires?|fae|fey|nymphs?|giants?|ogres?|trolls?|centaurs?|beast-?men|beast-?man|beast-?wom[ae]n|\w*folk|kin|\w+born)$/i;
const PORTRAIT_HUMANOID_COMPOUND = /^(?:half-\w+|\w+-kin|(?:\w+-)*beast-?(?:men|man|wom[ae]n)|(?:\w+-)*\w*folk)$/i;
// "elf ranger", "orc warchief", "troll-wife": a people named first is still that people, unless what follows is a thing or an
// animal ("troll bridge", "elf-hound").
const PORTRAIT_NON_PERSON_TAIL = /^(?:bridges?|hounds?|dogs?|wolf|wolves|spiders?|horses?|steeds?|mounts?|birds?|cats?|beasts?|golems?|constructs?|statues?|trees?|camps?|markets?|towers?|ships?|boats?|castles?|caves?|forests?|mountains?|rivers?|swamps?|hills?|villages?|cities|city|fortress|gate|gates|axes?|swords?|hammers?|shields?|banners?|drums?|fires?|stones?|rocks?|snakes?|serpents?|rats?|bears?|boars?|hawks?|eagles?|owls?|ravens?|crows?|bats?|hogs?|pigs?|lizards?|drakes?|dragons?|wyrms?|worms?|insects?|beetles?|ants?|bugs?|flies|fly|robots?|machines?|puppets?|dolls?|scarecrows?|totems?|idols?)$/i;
function portraitSpeciesIsHumanoid(words) {
    if (!words.length) return true;
    const last = words[words.length - 1];
    if (PORTRAIT_HUMANOID_COMPOUND.test(last) || PORTRAIT_HUMANOID_WORD.test(last)) return true;
    if (last.includes('-') && PORTRAIT_HUMANOID_WORD.test(last.split('-').pop())) return true;
    // A hyphenated word led by a people word is that people unless its last part is a thing or an animal (troll-wife, not elf-hound).
    if (last.includes('-') && PORTRAIT_HUMANOID_FIRST.test(last.split('-')[0]) && !PORTRAIT_NON_PERSON_TAIL.test(last.split('-').pop())) return true;
    return words.length > 1 && PORTRAIT_HUMANOID_FIRST.test(words[0]) && !PORTRAIT_NON_PERSON_TAIL.test(last);
}

function portraitProseList(items) {
    const list = items.filter(Boolean);
    if (list.length <= 1) return list.join('');
    const inner = list.some(item => item.includes(','));
    return list.slice(0, -1).join(inner ? '; ' : ', ') + (inner ? ', and ' : ' and ') + list[list.length - 1];
}

export function buildNaturalPortraitProse({ name, gender, rawGender, species, visualAge, role, appearance, mood, location, composition, extraPositive, stylePositive }) {
    const noun = gender === 'male' ? 'man' : gender === 'female' ? 'woman' : 'person';
    const subject = gender === 'male' ? 'He' : gender === 'female' ? 'She' : (name || 'The person');
    const possessive = gender === 'male' ? 'His' : gender === 'female' ? 'Her' : (name || 'The person') + "'s";
    const objectPronoun = gender === 'male' ? 'him' : gender === 'female' ? 'her' : (name || 'the person');
    const approximate = /^~/.test(portraitProseClean(visualAge));
    const ageText = portraitProseClean(visualAge).replace(/^~\s*/, '');
    const numericAge = /^\d+(?:\s*[-–]\s*\d+)?$/.test(ageText);
    // No parenthetical ("Elf (wood)" reads "elf"); a plural people reads as the singular ("high elves" is "a high elf man").
    const singular = (word, to) => (/^[A-Z]/.test(word) ? to.charAt(0).toUpperCase() + to.slice(1) : to);
    const speciesText = portraitProseClean(String(species ?? '').replace(/\([^)]*\)/g, ' '))
        .replace(/\belves\b/gi, word => singular(word, 'elf'))
        .replace(/\bdwarves\b/gi, word => singular(word, 'dwarf'))
        .replace(/\b(orc|goblin|halfling|gnome|tiefling|ogre|troll|centaur|human)s\b/gi, '$1');
    // A boy or a girl stays one: the gender word said so, or the age is under 18 with a male or female gender.
    const teen = /^(?:teens?|teenage|teenaged|teenager|adolescent)$/i.test(ageText);
    const youngest = numericAge ? Math.min(...ageText.match(/\d+/g).map(Number)) : Infinity;
    const young = gender && (/^(?:boy|girl)$/.test(normalizeName(rawGender)) || youngest < 18 || teen);
    const nounWord = young ? (gender === 'male' ? 'boy' : 'girl') : noun;
    const speciesHasNoun = new RegExp('\\b(?:' + nounWord + '|male|female|man|woman|boy|girl|person)\\b|(?:boy|girl)\\b|beast-?(?:wo)?man\\b', 'i').test(speciesText);
    // "His hair is white" reads "white hair".
    const possessiveIs = item => item.replace(/^(?:his|her|their|its)\s+([a-z][a-z' -]{1,30}?)\s+(?:is|are)\s+(.+)$/i, (whole, thing, value) => `${value} ${thing}`);
    // "Tall, with silver hair" is two clauses: the adjective goes on the subject, the rest follows "with".
    const rawCore = appearance.core.flatMap(item => item.split(/,\s*(?=(?:with|has|have|having)\s)/i)).map(possessiveIs).map(item => item.replace(/^(?:(?:he|she|they)\s+(?:has|have|is|are)|has|have|having|with)\s+/i, ''));
    const stripped = rawCore.map(item => portraitProseLower(item));
    const speciesWords = new Set(normalizeName(speciesText).split(' '));
    const adjectiveAt = stripped.map((item, at) => portraitProseIsAdjective(item, rawCore[at]) && !speciesWords.has(normalizeName(item)));
    const adjectives = stripped.filter((item, at) => adjectiveAt[at]);
    const core = stripped.filter((item, at) => !adjectiveAt[at]);
    // man / woman / boy / girl / person only for a human, a humanoid people or no species: a wolf, a dragon or a robot is not
    // given a human form ("a male wolf", "a robot").
    // Only the head noun (the last word) decides: "giant spider" and "demon wolf" are animals, "half-elf" a people.
    const speciesWordsList = speciesText.replace(/\([^)]*\)/g, ' ').trim().split(/\s+/).filter(Boolean);
    const humanoid = !speciesText || portraitSpeciesIsHumanoid(speciesWordsList);
    const formNoun = humanoid ? (speciesHasNoun ? '' : nounWord) : '';
    const animalSex = !humanoid && gender && !speciesHasNoun ? gender : '';
    const head = [numericAge ? (approximate ? 'roughly ' : '') + ageText.replace(/\s+/g, '') + '-year-old' : (teen ? 'teenage' : ''), ...adjectives, animalSex, speciesText, formNoun].filter(Boolean).join(' ');
    const clothing = appearance.clothing.map(item => portraitProseLower(item));
    const coreKeys = new Set(core.map(portraitPartKey));
    const clothes = clothing.filter(item => !coreKeys.has(portraitPartKey(item)));

    const sentences = [];
    let first = 'A portrait of ' + portraitProseArticle(head);
    if (ageText && !numericAge && !teen) first += ', of apparent age ' + ageText;
    if (core.length) first += ' with ' + portraitProseList(core);
    sentences.push(first);
    if (role) sentences.push(subject + ' carries the look of ' + portraitProseArticle(portraitProseLower(portraitProseClean(role))));
    if (clothes.length) sentences.push(subject + ' wears ' + portraitProseList(clothes));
    if (mood) sentences.push(possessive + ' expression is ' + portraitProseLower(portraitProseClean(mood)));
    if (location) sentences.push('Behind ' + objectPronoun + ', ' + portraitProseLower(portraitProseClean(location)));
    if (composition) sentences.push(portraitProseUpper(portraitProseClean(composition)));
    if (extraPositive) sentences.push(portraitProseUpper(portraitProseClean(extraPositive)));
    if (stylePositive) sentences.push(portraitProseUpper(portraitProseClean(stylePositive)));
    return sentences.map(item => item.replace(/\s+([,.])/g, '$1') + '.').join(' ');
}
