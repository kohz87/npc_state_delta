/* Social relation families, inverse/sanitization rules and shared relation parsing.
   Split from social.js; social.js remains the public facade. */

import {
    clean, normalizedWhitespace, cleanBoundary, norm, uniq,
    SOCIAL_DYNAMIC_MAX_CHARS, cleanDynamic, richer,
} from './social-primitives.js';

export function socialRelationFamily(value) {
    const rel = norm(value);
    if (!rel) return '';
    // Ties by marriage are their own families: a father-in-law is not a parent, so he neither
    // mirrors as "child" nor proves that two people who share him are siblings.
    if (/\bin[\s-]*law\b/.test(rel)) {
        if (/\b(?:daughter|son|child)\b/.test(rel)) return 'child-in-law';
        if (/\b(?:mother|father|parent)\b/.test(rel)) return 'parent-in-law';
        if (/\b(?:sister|brother|sibling)\b/.test(rel)) return 'sibling-in-law';
    }
    if (/\b(?:daughter|son|child)\b/.test(rel)) return 'child';
    if (/\b(?:mother|father|parent)\b/.test(rel)) return 'parent';
    if (/\b(?:sister|brother|sibling)\b/.test(rel)) return 'sibling';
    if (/\b(?:wife|husband|spouse|fiance|fiancee|partner|lover|girlfriend|boyfriend)\b/.test(rel)) return 'partner';
    if (/\b(?:mentor|teacher)\b/.test(rel)) return 'mentor';
    if (/\b(?:student|apprentice|protege)\b/.test(rel)) return 'student';
    if (/\bguardian\b/.test(rel)) return 'guardian';
    if (/\bward\b/.test(rel)) return 'ward';
    if (/\b(?:friend|rival|cousin)\b/.test(rel)) return rel.match(/\b(friend|rival|cousin)\b/)?.[1] || rel;
    if (/\b(?:aunt|uncle)\b/.test(rel)) return 'aunt-uncle';
    if (/\b(?:niece|nephew)\b/.test(rel)) return 'niece-nephew';
    if (/\b(?:grandmother|grandfather|grandparent)\b/.test(rel)) return 'grandparent';
    if (/\bgrandchild\b/.test(rel)) return 'grandchild';
    return rel;
}

const KNOWN_SOCIAL_RELATION_FAMILIES = new Set([
    'child', 'parent', 'sibling', 'partner', 'mentor', 'student', 'guardian', 'ward',
    'friend', 'rival', 'cousin', 'aunt-uncle', 'niece-nephew', 'grandparent', 'grandchild',
    'parent-in-law', 'child-in-law', 'sibling-in-law',
]);

const INVERSE_SOCIAL_RELATION_FAMILIES = new Map([
    ['child', 'parent'], ['parent', 'child'], ['mentor', 'student'], ['student', 'mentor'],
    ['guardian', 'ward'], ['ward', 'guardian'], ['aunt-uncle', 'niece-nephew'], ['niece-nephew', 'aunt-uncle'],
    ['grandparent', 'grandchild'], ['grandchild', 'grandparent'],
    ['parent-in-law', 'child-in-law'], ['child-in-law', 'parent-in-law'], ['sibling-in-law', 'sibling-in-law'],
]);

const KINSHIP_RELATION_FAMILIES = new Set(['child', 'parent', 'sibling', 'cousin', 'aunt-uncle', 'niece-nephew', 'grandparent', 'grandchild']);

// Two different blood ties to the same person cannot both hold ("niece / sibling").
function conflictingKinship(a, b) {
    const left = socialRelationFamily(a);
    const right = socialRelationFamily(b);
    return KINSHIP_RELATION_FAMILIES.has(left) && KINSHIP_RELATION_FAMILIES.has(right)
        && left !== right && !inverseRelationFamilies(left, right);
}

function inverseRelationFamilies(a, b) {
    const left = KNOWN_SOCIAL_RELATION_FAMILIES.has(a) ? a : socialRelationFamily(a);
    const right = KNOWN_SOCIAL_RELATION_FAMILIES.has(b) ? b : socialRelationFamily(b);
    return Boolean(left && right && INVERSE_SOCIAL_RELATION_FAMILIES.get(left) === right);
}

function relationshipSubjectLooksStructured(value) {
    const subject = clean(value, 120);
    if (!subject || /[.!?]\s*$/.test(subject)) return false;
    const words = norm(subject).split(/\s+/).filter(Boolean);
    if (!words.length || words.length > 8) return false;
    return !/^(?:supports?|provides?|raises?|feeds?|dresses?|guides?|works?|serves?|helps?|keeps?|uses?|lives?|died|dies|has|had|is|was|were|remains?|cares?)\b/i.test(subject);
}

// A bare life-state word is a fragment split off a bond ("…; deceased"), never a bond itself.
const ORPHAN_LIFE_STATE = /^\(?(?:deceased|dead|late|departed)\)?\.?$/i;

function preserveUnstructuredRelationshipText(value) {
    const text = clean(value, 420);
    if (!text || /[.!?]\s*$/.test(text) || ORPHAN_LIFE_STATE.test(text)) return false;
    if (/^(?:supports?|provides?|raises?|feeds?|dresses?|guides?|works?|serves?|helps?|keeps?|uses?|lives?|died|dies|has|had|is|was|were|remains?|cares?)\b/i.test(text)) return false;
    const words = norm(text).split(/\s+/).filter(Boolean);
    return words.length > 0 && words.length <= 8;
}

// A relation names only the relation. Scanners sometimes fold the dynamic in after a pipe
// ("cousin | endures her scolding") while also returning it as the dynamic; split it back out so
// the graph never stores it in the relation and projection never prints it twice.
function splitRelationDynamic(value) {
    const text = normalizedWhitespace(value);
    const pipe = text.indexOf('|');
    return pipe < 0 ? { relation: text, dynamic: '' } : { relation: text.slice(0, pipe), dynamic: text.slice(pipe + 1) };
}

// An inverse derived without gender reads "aunt / uncle"; once the counterpart's gender is known
// the bond names the one that applies.
const GENDERED_RELATION_PAIRS = [['aunt', 'uncle'], ['niece', 'nephew']];

function genderedRelation(relation, counterpart = null) {
    const gender = String(counterpart?.gender || '').toLowerCase();
    if (!relation || (gender !== 'female' && gender !== 'male')) return relation;
    const parts = relation.split(/\s*\/\s*/).map(norm);
    const pair = GENDERED_RELATION_PAIRS.find(([f, m]) => parts.length === 2 && parts.includes(f) && parts.includes(m));
    return pair ? pair[gender === 'female' ? 0 : 1] : relation;
}

function withFoldedDynamic(dynamic, folded) {
    return folded ? richer(dynamic, folded) : cleanDynamic(dynamic, SOCIAL_DYNAMIC_MAX_CHARS);
}

function sanitizeRelationshipRelation(subject, value) {
    let relation = cleanBoundary(value, 180, { ellipsis: false });
    if (!relation) return '';
    const slash = [];
    const seen = new Set();
    for (const part of relation.split(/\s*\/\s*/).map(item => cleanBoundary(item, 180, { ellipsis: false })).filter(Boolean)) {
        const key = norm(part);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        slash.push(part);
    }
    if (slash.length === 2 && inverseRelationFamilies(slash[0], slash[1])) relation = slash[0];
    else if (slash.length) relation = cleanBoundary(slash.join(' / '), 180, { ellipsis: false });
    const subjectKey = norm(subject);
    const relationKey = norm(relation);
    if (/^late husband\b/.test(subjectKey) && /^(?:surviving )?widow\b/.test(relationKey)) return 'spouse';
    if (/^late wife\b/.test(subjectKey) && /^(?:surviving )?widower\b/.test(relationKey)) return 'spouse';
    return relation;
}

// Words a symmetric bond shares on both sides ("childhood friend", "second cousin"). Any other
// qualifier ("older", "disinherited half-elf") describes one person only and must not be mirrored.
const MUTUAL_RELATION_QUALIFIERS = new Set([
    'best', 'close', 'childhood', 'old', 'lifelong', 'sworn', 'bitter', 'former', 'estranged', 'ex',
    'first', 'second', 'third', 'distant', 'fellow',
]);
const SYMMETRIC_RELATION_WORD = /\b(friend|rival|cousin|ally|companion|comrade|colleague|coworker|neighbou?r|classmate|enemy|acquaintance|teammate)\b/;

function symmetricInverse(rel) {
    const words = norm(rel).split(/\s+/).filter(Boolean);
    const index = words.findIndex(word => SYMMETRIC_RELATION_WORD.test(word));
    if (index < 0) return '';
    return [...words.slice(0, index).filter(word => MUTUAL_RELATION_QUALIFIERS.has(word)), words[index]].join(' ');
}

export function inverseSocialRelation(value) {
    const text = clean(value, 180);
    const parts = text.split(/\s*\/\s*/).filter(Boolean);
    // A relation that contradicts itself ("niece / sibling") has no trustworthy inverse.
    if (parts.some((part, i) => parts.slice(i + 1).some(other => conflictingKinship(part, other)))) return '';
    if (parts.length > 1) return uniq(parts.map(inverseSingleRelation).filter(Boolean)).join(' / ');
    return inverseSingleRelation(text);
}

function inverseSingleRelation(value) {
    const rel = clean(value, 180);
    const family = socialRelationFamily(rel);
    if (!family) return '';
    if (family === 'parent-in-law') return 'child-in-law';
    if (family === 'child-in-law') return 'parent-in-law';
    if (family === 'sibling-in-law') return 'sibling-in-law';
    if (family === 'child') return 'parent';
    if (family === 'parent') return 'child';
    if (family === 'sibling') return /\bclone\b/i.test(rel) ? 'clone sibling' : (/\btwin\b/i.test(rel) ? 'twin sibling' : 'sibling');
    if (family === 'friend' || family === 'rival' || family === 'cousin') return symmetricInverse(rel);
    if (family === 'partner') {
        if (/\b(?:wife|husband|spouse)\b/i.test(rel)) return 'spouse';
        return 'partner';
    }
    if (family === 'mentor') return 'student';
    if (family === 'student') return 'mentor';
    if (family === 'guardian') return 'ward';
    if (family === 'ward') return 'guardian';
    if (family === 'aunt-uncle') return 'niece/nephew';
    if (family === 'niece-nephew') return 'aunt/uncle';
    if (family === 'grandparent') return 'grandchild';
    if (family === 'grandchild') return 'grandparent';
    // Only a known symmetric bond mirrors itself; "servant" or "employer" has no safe inverse.
    return symmetricInverse(rel);
}

function relationSpecificity(value) {
    const rel = norm(value);
    let score = rel.split(/\s+/).filter(Boolean).length;
    if (/\b(?:daughter|son|mother|father|sister|brother|wife|husband)\b/.test(rel)) score += 2;
    if (/\b(?:clone|twin|adoptive|biological|step|half|older|younger|elder)\b/.test(rel)) score += 2;
    return score;
}

function mergeRelations(a, b) {
    const left = cleanBoundary(a, 180, { ellipsis: false });
    const right = cleanBoundary(b, 180, { ellipsis: false });
    if (!left) return right;
    if (!right) return left;
    const ln = norm(left);
    const rn = norm(right);
    if (ln === rn) return relationSpecificity(right) >= relationSpecificity(left) ? right : left;
    // A gender-neutral inverse ("aunt / uncle") never replaces the specific relation it covers.
    const slashParts = value => value.split(/\s*\/\s*/).map(norm).filter(Boolean);
    if (slashParts(right).length > 1 && slashParts(right).includes(ln)) return left;
    if (slashParts(left).length > 1 && slashParts(left).includes(rn)) return right;
    if (ln.includes(rn)) return left;
    if (rn.includes(ln)) return right;
    const lf = socialRelationFamily(left);
    const rf = socialRelationFamily(right);
    if (lf && lf === rf) return relationSpecificity(right) >= relationSpecificity(left) ? right : left;
    if (inverseRelationFamilies(lf, rf)) return left;
    return cleanBoundary(`${left} / ${right}`, 180, { ellipsis: false });
}

function numberWord(value) {
    const raw = norm(value);
    const map = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twin: 2, twins: 2 };
    if (map[raw]) return map[raw];
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 && n <= 20 ? n : 0;
}

function singularRelation(value) {
    const raw = norm(value);
    if (raw === 'daughters') return 'daughter';
    if (raw === 'sons') return 'son';
    if (raw === 'children') return 'child';
    if (raw === 'sisters') return 'sister';
    if (raw === 'brothers') return 'brother';
    if (raw === 'siblings') return 'sibling';
    return raw.replace(/s$/, '');
}

function collectiveRelationshipShape(parsed) {
    if (!parsed) return null;
    const subject = norm(parsed.subject);
    const relationFamily = socialRelationFamily(singularRelation(parsed.relation));
    const plural = subject.match(/\b(daughters|sons|children|sisters|brothers|siblings)\b/);
    if (!plural) return null;
    const subjectFamily = socialRelationFamily(singularRelation(plural[1]));
    if (!subjectFamily || subjectFamily !== relationFamily) return null;
    const twin = /\btwins?\b/.test(subject);
    let expectedCount = twin ? 2 : 0;
    if (!expectedCount) {
        const countToken = subject.split(/\s+/).find(token => numberWord(token) > 0);
        if (countToken) expectedCount = numberWord(countToken);
    }
    if (expectedCount < 2) return null;
    return { family: relationFamily, expectedCount, sharedDescriptor: twin ? 'twins' : '' };
}

function kinshipParts(value) {
    return clean(value, 180).split(/\s*\/\s*/).map(part => clean(part, 180)).filter(Boolean);
}

export {
    KNOWN_SOCIAL_RELATION_FAMILIES, INVERSE_SOCIAL_RELATION_FAMILIES,
    KINSHIP_RELATION_FAMILIES, conflictingKinship, inverseRelationFamilies,
    relationshipSubjectLooksStructured, ORPHAN_LIFE_STATE,
    preserveUnstructuredRelationshipText, splitRelationDynamic,
    GENDERED_RELATION_PAIRS, genderedRelation, withFoldedDynamic,
    sanitizeRelationshipRelation, MUTUAL_RELATION_QUALIFIERS, SYMMETRIC_RELATION_WORD,
    symmetricInverse, inverseSingleRelation, relationSpecificity, mergeRelations,
    numberWord, singularRelation, collectiveRelationshipShape, kinshipParts,
};
