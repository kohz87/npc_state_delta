/* Appearance fill (role: appearance-fill). When a NEW person is met (their one new-admission backfill, or the catch-up Refresh, or the reader presses Refresh), that call may fill
   what the story never described: BLANK look fields (overallAppearance, appearance), and the hair, eyes and build MISSING from a
   PARTIAL overallAppearance ("Young human woman"), with details that fit what the story has said.
   This file owns: who qualifies (alive, not archived, no named forms, appearance not manually fixed), which of hair / eyes / build
   a text already describes (pure word lists), the one prompt line, the clash check on an appended addition, and the name of the
   merge option that lets this one call write without quoted evidence. Nothing is stored for it: the filled text is an ordinary
   value, so a later explicit story line replaces it through the normal refine gate. A partial text is only ever EXTENDED: the
   line quotes the exact stored overallAppearance (and, apart, the clothes text; the dossier shows both joined by ';'), the model
   returns that text plus the addition, and code accepts it only when the quoted text survives word for word (appendedLooks; its
   closing full stop may give way to the addition's comma). Pure. */

import { DURABLE_PROFILE_LIMITS } from './core-mechanics.js';
import { appearanceClauses, appearanceText, combineAppearance } from './appearance-text.js';
import { currentPresentationText } from './appearance-model.js';
import { CHANGEABLE_PRESENTATION, PHYSICAL_TRAITS, physicalTraitKeys } from './appearance-physical.js';

const blank = value => !String(value ?? '').trim();

const patternOf = key => PHYSICAL_TRAITS.find(([name]) => name === key)[1];
// Generous on purpose: a false "covered" only skips a fill, a false "missing" would invent over written text.
// A kind with no hair (scales, feathers, fur, chitin ...) counts as having its hair described.
const HAIR = new RegExp(`${patternOf('hair').source}|\\b(?:locks?|curls?|curly|tresses|bald|balding|shaved|shorn|buzz(?:ed)?|cropped|mohawk|bun|topknot|plaits?|dreadlocks?|dreads|beard|bearded|hairless|hairstyle|hairdo|fringe|wig|fur|furred|furry|scales?|scaled|scaly|feathers?|feathered|plumage|chitin(?:ous)?|carapace|exoskeleton|shell|bark|hide|slime|gelatinous|spectral|ghostly|incorporeal|skeletal|skeleton|bones?|metal|metallic|plating|stone|wooden)\\b`, 'i');
const EYES = new RegExp(`${patternOf('eyes').source}|\\b(?:gaze|gazes|stare|eyeless|heterochromia|sockets?|visor|glowing\\s+(?:red|blue|green|gold|golden|white|violet|amber)|(?:amber|hazel|emerald|sapphire|violet|golden|gold|green|blue|grey|gray|brown|black|silver|crimson|ruby)[- ]?(?:gaze|stare|orbs?))\\b`, 'i');
const BUILD = new RegExp(`${patternOf('build').source}|${patternOf('height').source}|\\b(?:stocky|stout|sturdy|broad|wiry|muscled|muscular|heavy[- ]?set|heavyset|gaunt|slight|skinny|thin|plump|chubby|portly|rotund|hulking|bulky|athletic|toned|statuesque|tall|short|towering|big|huge|large|small|tiny|giant|waif|waifish|curves|curvaceous|voluptuous|shapely|hourglass|bony|scrawny|spindly|sinewy|stature|size|bodied|body|torso|limbs|height|petite|dwarfish|squat|stubby|corpulent|well[- ]built|fit)\\b`, 'i');
const FEATURES = Object.freeze([['hair', HAIR], ['eyes', EYES], ['build', BUILD]]);

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

// The split of a look written into the clothes field (the scanner, the capture or a fill put build, height, hair ... in `appearance` and left
// overallAppearance blank or short). Pure and deterministic; the owner's words move whole, nothing is added or reworded.
// A comma piece is BODY when it names a physical trait (PHYSICAL_TRAITS keys) and no clothing/condition word; CLOTHES when it names clothing, gear or
// condition; any other piece follows the piece before it (a leading one stays with the clothes). A piece whose traits the overall text already
// describes stays where it is (no repeat). Named forms, a manually fixed appearance and pack-cast first words are never split.
const splittable = npc => eligible(npc) && !npc.castFrom?.first;
const limit = () => DURABLE_PROFILE_LIMITS?.appearance || 800;
const pieceClass = piece => (CHANGEABLE_PRESENTATION.test(piece) ? 'clothes' : physicalTraitKeys(piece).length ? 'body' : null);

// What a Look already says counts per trait, with wider words for height and for the parts of the figure (bust ...): the owner's Look "very petite
// build no taller than a boy of twelve ... heavy, round bust" already states height and bust, so the same words in Wearing are duplicates.
const HEIGHT_SAID = /\b(?:tall|taller|tallest|height|towering|diminutive|statuesque|petite|short|shorter|tiny|(?:\d+|one|two|three|four|five|six|seven|eight)\s+(?:feet|foot|ft))\b/i;
const PARTS = /\b(?:breasts?|bust|bosom|chest|hips?|waist|thighs?)\b/i;
const PART_TAIL = /\s+(?:straining|stretched|stretching|pulled|clinging|tight|resting|pressed|spilling)?\s*(?:across|over|against|around)\s+[^;.]*?\b(?:breasts?|bust|bosom|chest|hips?|waist|thighs?)\b[^;.]*$/i;
const said = (key, text) => (key === 'height' ? HEIGHT_SAID : patternOf(key)).test(text);
const lowerLead = text => text.replace(/^(?:Her|His|Their|Its|She|He|They|The|A|An)\b/, word => word.toLowerCase());

/** { overall, appearance, moved } for a record: the body clauses of its clothes text moved into overallAppearance. `moved` is false (and the
 *  texts the stored ones) when nothing moves or drops. A body piece whose trait the overall text already states is dropped from the clothes
 *  (never shown twice); one it lacks moves. Stored data is not touched; callers use the result for display and on a write. */
export function splitLook(npc = {}) {
    const same = { overall: appearanceText(npc?.overallAppearance), appearance: appearanceText(npc?.appearance), moved: false };
    if (!splittable(npc)) return same;
    const overall = same.overall;
    const source = overall ? appearanceText(currentPresentationText(npc)) : same.appearance;
    const have = new Set(overall ? [...PHYSICAL_TRAITS.map(([key]) => key), 'height'].filter(key => said(key, overall)) : []);
    const body = [];
    const clothes = [];
    let dropped = false;
    for (let clause of appearanceClauses(source)) {
        clause = clause.replace(/[.!?]+$/, '');
        if (overall && PARTS.test(overall) && PART_TAIL.test(clause)) { clause = clause.replace(PART_TAIL, ''); dropped = true; }
        const pieces = clause.split(/\s*,\s*/).filter(Boolean);
        const kinds = pieces.map(piece => {
            const found = pieceClass(piece);
            return found === 'body' && physicalTraitKeys(piece).every(key => have.has(key)) ? 'dup' : found;
        });
        // A piece naming nothing follows the piece before it; leading ones go with the first body piece when that is what comes next.
        const firstFound = kinds.find(Boolean);
        let last = firstFound === 'body' ? 'body' : 'clothes';
        const mine = { body: [], clothes: [] };
        pieces.forEach((piece, index) => {
            last = kinds[index] || last;
            if (last === 'dup') dropped = true; else mine[last].push(piece);
        });
        if (mine.body.length) body.push(lowerLead(mine.body.join(', ')));
        if (mine.clothes.length) clothes.push(mine.clothes.join(', '));
    }
    if (!body.length && !dropped) return same;
    const tail = /[.!?]\s*$/.test(source) ? '.' : '';
    const wearing = clothes.length ? clothes.join('; ') + tail : '';
    const joined = body.join('; ') + (clothes.length ? '' : tail);
    const moved = body.length ? (overall ? `${overall.replace(/[\s.;,]+$/, '')}; ${joined}` : joined) : overall;
    if (moved.length > limit()) return same;
    return { overall: moved, appearance: combineAppearance(moved, wearing), moved: true };
}

/** The record with its look split (a copy), or the record itself when nothing moves. */
export function withSplitLook(npc) {
    const split = npc && typeof npc === 'object' ? splitLook(npc) : null;
    return split?.moved ? { ...npc, overallAppearance: split.overall, appearance: split.appearance } : npc;
}

// A fill never contradicts a stored value. The stored apparentAge ("~20") is a number; a filled look that names an age look outside it
// ("apparent mid-twenties" for ~20) loses that phrase (words only removed, none added). Story-given looks are never touched: this runs on fill writes.
const DECADES = { teens: [13, 19], twenties: [20, 29], thirties: [30, 39], forties: [40, 49], fifties: [50, 59], sixties: [60, 69], seventies: [70, 79] };
const PART_OF = { early: [0, 3], mid: [4, 6], late: [7, 9] };
const AGE_LOOK = /(?:\s*(?:,|;)?\s*(?:of|in\s+(?:her|his|their|its))\s+)?(?:(?:an?\s+)?apparent(?:ly)?\s+)?(?:(early|mid|late)[- ]?)?(teens|twenties|thirties|forties|fifties|sixties|seventies)\b/i;
const storedAge = npc => { const found = String(npc?.apparentAge ?? '').match(/\d+/); return found ? Number(found[0]) : null; };

/** `text` with an age look that disagrees with the record's stored apparentAge removed; the text itself when none, or nothing is stored. */
export function agreeWithStoredAge(text, npc) {
    const value = String(text ?? '');
    const age = storedAge(npc);
    if (age === null) return value;
    const match = value.match(AGE_LOOK);
    if (!match) return value;
    const [from, to] = DECADES[match[2].toLowerCase()];
    const part = PART_OF[(match[1] || '').toLowerCase()];
    const [lo, hi] = part ? part.map(n => from + n) : [from, to];
    if (age >= lo - 1 && age <= hi + 1) return value;
    return value.replace(AGE_LOOK, '').replace(/\s{2,}/g, ' ').replace(/\s+([,;.])/g, '$1');
}

const storedFacts = npc => [storedAge(npc) !== null && `apparent age ${String(npc.apparentAge).trim()}`, String(npc?.species || '').trim() && `kind ${String(npc.species).trim()}`, String(npc?.gender || '').trim() && `gender ${String(npc.gender).trim()}`].filter(Boolean);

/** The blank look fields a fill may write for this record, or [] when none/ineligible (dead, archived, named forms in use). */
export function blankLookFields(raw = {}) {
    const npc = withSplitLook(raw);
    if (!eligible(npc)) return [];
    return [blank(npc.overallAppearance) && 'overallAppearance', blank(npc.appearance) && blank(npc.unclassifiedAppearance) && 'appearance'].filter(Boolean);
}

/** The hair / eyes / build a fill may append to this record's PARTIAL overallAppearance, or [] (blank, complete or ineligible). */
export function partialLookGaps(raw = {}) {
    const npc = withSplitLook(raw);
    return eligible(npc) ? missingFeatures(npc.overallAppearance) : [];
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
export function fillLooksLine(raw = {}) {
    const npc = withSplitLook(raw);
    const fields = blankLookFields(npc);
    const gaps = partialLookGaps(npc);
    if (!fields.length && !gaps.length) return '';
    const facts = storedFacts(npc);
    const parts = [];
    if (fields.length) parts.push(`${fields.join(', ')} ${fields.length > 1 ? 'are' : 'is'} blank because the story never described this person. Only for ${fields.length > 1 ? 'those fields' : 'that field'}, write a short plausible look that fits what the story and dossier say (kind and its own features, age, role, region, setting); no quoted evidence needed.`);
    if (gaps.length) {
        // The dossier shows one combined look ("<overall>; <clothes>"): quote the exact text appendedLooks checks, and the clothes apart.
        const clothes = appearanceText(currentPresentationText(npc));
        parts.push(`overallAppearance is exactly ${JSON.stringify(appearanceText(npc.overallAppearance))} and does not yet describe this person's ${gaps.join(', ')}. Return overallAppearance as that quoted text, unchanged, followed by a short addition for ${gaps.join(', ')} only, fitted to what the story and dossier say (kind and its own features, age, role, region, setting).${clothes ? ` The current-presentation text ${JSON.stringify(clothes)} is appearance, never part of overallAppearance.` : ''} Add nothing already described, and never a second colour or style for anything already stated.`);
    }
    return `\nFILL LOOKS: ${parts.join(' ')} Never contradict or repeat anything stated; invent nothing else.${facts.length ? ` Stored facts to keep exactly (never another age or kind): ${facts.join('; ')}.` : ''} Use plain descriptive wording: a height as a height (the stored or story one), never a comparison to a child or another person. overallAppearance is the body (kind, age look, build, eyes, hair, marks); appearance is clothes and their state in the fewest words.`;
}

// What `next` adds to `prior`, or '': all of `prior` word for word, then more. A closing full stop (or ; ,) of `prior` may give way to the
// addition's own comma or semicolon: "... a tear-blotched face." extended as "... a tear-blotched face, watery blue eyes." loses no word.
function additionTo(prior, next) {
    if (!prior || !next) return '';
    if (next.startsWith(prior)) return next.slice(prior.length);
    const core = prior.replace(/[\s.;,]+$/, '');
    return core && core !== prior && next.startsWith(core) && /^[,;]\s*\S/.test(next.slice(core.length)) ? next.slice(core.length) : '';
}

/** True when `incoming` is an attempt to extend `previous` (starts with all of it and says more); such a result in a fill call is
 *  accepted by appendedLooks or refused, never handed to the ordinary rewrite gate. */
export function attemptsExtension(previous, incoming, limit = DURABLE_PROFILE_LIMITS?.appearance || 800) {
    return Boolean(additionTo(appearanceText(previous), appearanceText(incoming, limit + 1)));
}

/** The accepted text when `incoming` is `previous` kept word for word plus an addition that describes only what was missing and fits
 *  the limit; null otherwise (the record stays as it is). The code enforces what the prompt asks. */
export function appendedLooks(previous, incoming, limit = DURABLE_PROFILE_LIMITS?.appearance || 800) {
    const prior = appearanceText(previous);
    const next = appearanceText(incoming, limit + 1);
    // The normaliser upstream cuts an over-long answer to `limit` characters (then trims): a text that long may be cut, so it is refused.
    const addition = next.length >= limit - 1 ? '' : additionTo(prior, next);
    if (!addition) return null;
    if (!/\W/.test(next.slice(-addition.length - 1, -addition.length)) && /\w/.test(addition[0])) return null;   // a word was changed, not extended
    const have = describedFeatures(prior);
    return describedFeatures(addition).some(key => have.includes(key)) ? null : next;
}

export const FILL_MERGE_OPTION = 'fillBlankAppearance';
