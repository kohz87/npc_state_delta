/* Appearance fill (role: appearance-fill). When a NEW person is met (their one new-admission backfill, or the catch-up Refresh, or the reader presses Refresh), that call may fill
   what the story never described: BLANK look fields (overallAppearance, appearance), and the hair, eyes and build MISSING from a
   PARTIAL overallAppearance ("Young human woman"), with details that fit what the story has said.
   This file owns: who qualifies (alive, not archived, no named forms, appearance not manually fixed), which of hair / eyes / build
   a text already describes (pure word lists), the one prompt line, the clash check on an appended addition, and the name of the
   merge option that lets this one call write without quoted evidence. Nothing is stored for it: the filled text is an ordinary
   value, so a later explicit story line replaces it through the normal refine gate. A partial text is only ever EXTENDED: the
   model returns the full text and code accepts it only when the previous text survives word for word (appendedLooks). Pure. */

import { DURABLE_PROFILE_LIMITS } from './core-mechanics.js';
import { appearanceText, stripOverallPrefix } from './appearance-text.js';
import { PHYSICAL_TRAITS } from './appearance-physical.js';

const blank = value => !String(value ?? '').trim();

const patternOf = key => PHYSICAL_TRAITS.find(([name]) => name === key)[1];
// Generous on purpose: a false "covered" only skips a fill, a false "missing" would invent over written text.
// A kind with no hair (scales, feathers, fur, chitin ...) counts as having its hair described.
const HAIR = new RegExp(`${patternOf('hair').source}|\\b(?:locks?|curls?|curly|tresses|bald|balding|shaved|shorn|buzz(?:ed)?|cropped|mohawk|bun|topknot|plaits?|dreadlocks?|dreads|beard|bearded|hairless|hairstyle|hairdo|fringe|wig|fur|furred|furry|scales?|scaled|scaly|feathers?|feathered|plumage|chitin(?:ous)?|carapace|exoskeleton|shell|bark|hide|slime|gelatinous|spectral|ghostly|incorporeal|skeletal|skeleton|bones?|metal|metallic|plating|stone|wooden)\\b`, 'i');
const EYES = new RegExp(`${patternOf('eyes').source}|\\b(?:gaze|gazes|stare|eyeless|heterochromia|sockets?|visor|glowing\\s+(?:red|blue|green|gold|golden|white|violet|amber)|(?:amber|hazel|emerald|sapphire|violet|golden|gold|green|blue|grey|gray|brown|black|silver|crimson|ruby)[- ]?(?:gaze|stare|orbs?))\\b`, 'i');
const BUILD = new RegExp(`${patternOf('build').source}|${patternOf('height').source}|\\b(?:stocky|stout|sturdy|broad|wiry|muscled|muscular|heavy[- ]?set|heavyset|gaunt|slight|skinny|thin|plump|chubby|portly|rotund|hulking|bulky|athletic|toned|statuesque|tall|short|towering|big|huge|large|small|tiny|giant|waif|waifish|curves|curvaceous|voluptuous|shapely|hourglass|bony|scrawny|spindly|sinewy|stature|size|bodied|body|torso|limbs|height|petite|dwarfish|squat|stubby|corpulent|well[- ]built|fit)\\b`, 'i');
const FEATURES = Object.freeze([['hair', HAIR], ['eyes', EYES], ['build', BUILD]]);
// An ungrounded fill (blank slot or partial addition) is looks-only: every word must be a look word and every clause must END in a
// look noun or a build/age word, so a verb, a name, an object or a deed ("she murdered the ferryman", "with a ruby") fails closed
// and the record stays as it is. A claim with evidence may still arrive by the ordinary grounded route.
const words = text => String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
const set = list => new Set(list.split(/\s+/));
const LOOK_WORDS = set(`a almond amber an and as at auburn back bald balding bangs be beard bearded black blonde blond blue body bodied bone bony braid braided braids broad brown brunette build built bun buzz buzzed chestnut chin chubby coarse copper cropped curl curled curls curly curvaceous curves curvy dark dread dreads dreadlock dreadlocks dwarfish ebony emerald eye eyed eyeless eyes fair fine fit frame fringe frizzy full gaunt gaze gazes ginger gold golden gray green grey hair haired hairless hairstyle hairdo hazel heavy heavyset height her high his honey hourglass huge hulking in iris irises large lanky lean length light lilac limbed lithe locks lock long loose low mane metallic mohawk muscle muscled muscles muscular narrow of one orange petite pigtail pigtails pink plait plaited plaits platinum plump ponytail portly purple raven red rotund round ruby russet sandy sapphire shaped shaved shorn short shoulder shoulders shouldered silver silvery slight slender slim small soft spindly squat standing stature statuesque stocky straight straw strawberry stout sturdy tanned tall tangle tangled taper tapered teal their thick thin tiny toned topknot torso towering tresses two violet waist waif waifish wavy well white wiry with wood wooden yellow
young youthful old elderly aged middle teenage adult ancient woman man girl boy lady lad youth child person male female human elf elven elf-kin dwarf dwarven orc half halfling gnome folk kin dogfolk catfolk foxfolk wolfkin figure physique ears ear eared hands hand fingers face skin complexion freckles freckled tail tailed tails horns horned wings feathers fur furred scales scaled paws claws nose lips cheeks jaw brow weathered pale olive dusky sun kissed rough calloused delicate fox wolf cat dog rabbit deer scar scarred`);
const KIND_ENDS = set('woman man girl boy lady lad youth child person male female human elf dwarf orc halfling gnome folk kin dogfolk catfolk foxfolk wolfkin young old elderly aged adult ancient youthful');
const LOOK_ENDS = set(`shouldered shoulders ears ear hands fingers face skin complexion freckles tail tails horns wings feathers fur scales paws claws nose lips cheeks jaw brow eared horned tailed freckled hair eyes eye build frame body figure physique stature height locks curls braid braids ponytail mane tresses bun topknot plait plaits pigtails pigtail bangs fringe beard mohawk dreadlocks dreads dreadlock waist shoulders shoulder torso chin iris irises gaze tall short slim slender lean stocky stout sturdy broad wiry muscular petite lanky plump portly gaunt curvy thin tiny huge large small bald hairless heavyset toned fit curvaceous hulking rotund slight waifish squat built shaped limbed`);
const DRESS_WORDS = set(`salt oilskin wearing worn wears wear dressed clad plain simple patched faded travel stained cloak robe robes tunic dress gown shirt blouse trousers pants skirt boots shoes sandals coat jacket vest leather linen wool woolen cotton silk velvet cloth hood hooded cap hat scarf gloves belt apron armor armour mail chainmail plate helm helmet breeches leggings corset bodice sash shawl uniform habit cowl mantle cape collar necklace pendant earrings circlet crown glasses sewn hand`);
const DRESS_ENDS = set('cloak robe robes tunic dress gown shirt blouse trousers pants skirt boots shoes sandals coat jacket vest leather linen wool cotton silk velvet cloth hood cap hat scarf gloves belt apron armor armour mail chainmail plate helm helmet breeches leggings corset bodice sash shawl uniform habit cowl mantle cape collar necklace pendant earrings circlet crown glasses');

/** True when `text` is a pure description of looks (hair, eyes, build, age, kind; with `clothes`, also what is worn) and nothing else. Pure. */
export function lookOnly(text, { clothes = false } = {}) {
    const clauses = String(text ?? '').split(/[,;.!?:]|\band\b/i).filter(part => words(part).length);
    if (!clauses.length) return false;
    return clauses.every(clause => {
        const list = words(clause);
        const ok = word => LOOK_WORDS.has(word) || (clothes && DRESS_WORDS.has(word));
        const end = list[list.length - 1];
        return list.every(ok) && (LOOK_ENDS.has(end) || KIND_ENDS.has(end) || (clothes && DRESS_ENDS.has(end)));
    });
}

/** Per-feature test: which of hair / eyes / build this text already describes (generous word lists). Pure. */
export function describedFeatures(text = '') {
    const value = String(text ?? '');
    return FEATURES.filter(([, pattern]) => pattern.test(value)).map(([key]) => key);
}

/** The features (hair, eyes, build) a PARTIAL overallAppearance does not describe; [] for a blank text (that is a blank fill). */
export function missingFeatures(text = '') {
    const value = String(text ?? '').trim();
    if (!value) return [];
    const have = describedFeatures(value);
    return FEATURES.map(([key]) => key).filter(key => !have.includes(key));
}

const eligible = npc => {
    if (!npc || typeof npc !== 'object' || npc.archived) return false;
    const life = String(npc.lifeState || '').toLowerCase();
    if (life === 'deceased' || life === 'dead') return false;
    if ((Array.isArray(npc.appearanceForms) && npc.appearanceForms.length) || !blank(npc.currentForm) || npc.currentFormUnknown) return false;
    return !(Array.isArray(npc.manualProfileFields) && npc.manualProfileFields.includes('appearance'));
};

/** The blank look fields a fill may write for this record, or [] when none/ineligible (dead, archived, named forms in use). */
export function blankLookFields(npc = {}) {
    if (!eligible(npc)) return [];
    return [blank(npc.overallAppearance) && 'overallAppearance', blank(stripOverallPrefix(npc.appearance, npc.overallAppearance)) && blank(npc.unclassifiedAppearance) && 'appearance'].filter(Boolean);
}

/** The hair / eyes / build a fill may append to this record's PARTIAL overallAppearance, or [] (blank, complete or ineligible). */
export function partialLookGaps(npc = {}) {
    if (!eligible(npc) || blank(npc.overallAppearance)) return [];
    if (appearanceText(npc.overallAppearance, (DURABLE_PROFILE_LIMITS?.appearance || 800) + 1).length >= (DURABLE_PROFILE_LIMITS?.appearance || 800) - 1) return [];
    return missingFeatures(`${npc.overallAppearance} ${npc.appearance || ''}`);   // the resolved outfit counts as already described
}

/** True when a fill call has anything to do for this record (a blank field or a partial description's gap). */
export const fillWanted = npc => blankLookFields(npc).length > 0 || partialLookGaps(npc).length > 0;

/** True when this record is the reader's own character (name or alias equals the player's name, case-insensitive). */
export const isReadersOwn = (npc, playerName) => {
    const player = String(playerName || '').trim().toLowerCase();
    return Boolean(player) && [npc?.name, ...(npc?.aliases || [])].some(label => String(label || '').trim().toLowerCase() === player);
};

/** The one gate for a fill call (Refresh and the new-admission backfill share it): something to fill, and not the reader's own character. */
export const fillAllowed = (npc, playerName) => fillWanted(npc) && !isReadersOwn(npc, playerName);

/** The prompt's tail line for a fill call, or '' (static rules stay untouched; the line exists only on this call). */
export function fillLooksLine(npc = {}) {
    const fields = blankLookFields(npc);
    const gaps = partialLookGaps(npc);
    if (!fields.length && !gaps.length) return '';
    const parts = [];
    if (fields.length) parts.push(`${fields.join(', ')} ${fields.length > 1 ? 'are' : 'is'} blank because the story never described this person. Only for ${fields.length > 1 ? 'those fields' : 'that field'}, write a short plausible look that fits what the story and dossier say (kind and its own features, age, role, region, setting); no quoted evidence needed.`);
    if (gaps.length) parts.push(`overallAppearance does not yet describe this person's ${gaps.join(', ')}. Return overallAppearance as the existing text exactly as written, unchanged, followed by a short addition for ${gaps.join(', ')} only, fitted to what the story and dossier say (kind and its own features, age, role, region, setting). Add nothing already described, and never a second colour or style for anything already stated. Existing overallAppearance: ${JSON.stringify(npc.overallAppearance)}.`);
    return `\nFILL LOOKS: ${parts.join(' ')} Never contradict or repeat anything stated; invent nothing else.`;
}

/** True when `incoming` is an attempt to extend `previous` (starts with all of it and says more); such a result in a fill call is
 *  accepted by appendedLooks or refused, never handed to the ordinary rewrite gate. */
export function attemptsExtension(previous, incoming, limit = DURABLE_PROFILE_LIMITS?.appearance || 800) {
    const prior = appearanceText(previous);
    const next = appearanceText(incoming, limit + 1);
    return Boolean(prior) && next.length > prior.length && next.startsWith(prior);
}

/** The accepted text when `incoming` is `previous` kept word for word plus an addition that describes only what was missing and fits
 *  the limit; null otherwise (the record stays as it is). The code enforces what the prompt asks. */
export function appendedLooks(previous, incoming, limit = DURABLE_PROFILE_LIMITS?.appearance || 800, otherAppearance = '') {
    const prior = appearanceText(previous);
    const next = appearanceText(incoming, limit + 1);
    // The normaliser upstream cuts an over-long answer to `limit` characters (then trims): a text that long may be cut, so it is refused.
    if (!prior || !next || next.length >= limit - 1 || !next.startsWith(prior) || next.length === prior.length) return null;
    const addition = next.slice(prior.length);
    if (!/\W/.test(prior.slice(-1)) && /\w/.test(addition[0])) return null;   // a word was changed, not extended
    const have = describedFeatures(`${prior} ${otherAppearance}`);
    const added = describedFeatures(addition);
    if (!added.length || added.some(key => have.includes(key)) || !lookOnly(addition)) return null;
    return next;
}

export const FILL_MERGE_OPTION = 'fillBlankAppearance';
