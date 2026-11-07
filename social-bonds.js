/* Important-bond parsing, compaction and display formatting.
   Split from social.js; social.js remains the public facade. */

import { normalizedWhitespace, cleanBoundary, cleanDynamic, SOCIAL_DYNAMIC_MAX_CHARS, SOCIAL_KEY_RELATIONSHIP_MAX_CHARS } from './social-primitives.js';
import {
    KNOWN_SOCIAL_RELATION_FAMILIES, ORPHAN_LIFE_STATE, genderedRelation,
    relationshipSubjectLooksStructured, sanitizeRelationshipRelation,
    socialRelationFamily, splitRelationDynamic, withFoldedDynamic,
} from './social-relations.js';

export function parseKeyRelationshipEntry(value) {
    const text = normalizedWhitespace(value);
    if (!text) return null;
    const match = text.match(/^(.+?)(?:\s+[—–-]\s+|\s*:\s+)([\s\S]*)$/);
    if (!match) return null;
    const subject = cleanBoundary(match[1], 120, { ellipsis: false });
    const rest = normalizedWhitespace(match[2]);
    if (!subject || !rest || !relationshipSubjectLooksStructured(subject)) return null;
    const pipe = rest.indexOf('|');
    let relationText = pipe >= 0 ? rest.slice(0, pipe) : rest;
    let dynamicText = pipe >= 0 ? rest.slice(pipe + 1) : '';
    if (pipe < 0) {
        const semicolon = rest.indexOf(';');
        if (semicolon > 0) {
            const candidateRelation = cleanBoundary(rest.slice(0, semicolon), 180, { ellipsis: false });
            if (KNOWN_SOCIAL_RELATION_FAMILIES.has(socialRelationFamily(candidateRelation))) {
                relationText = candidateRelation;
                dynamicText = rest.slice(semicolon + 1);
            }
        }
    }
    const relation = sanitizeRelationshipRelation(subject, relationText);
    const dynamic = cleanDynamic(dynamicText, SOCIAL_DYNAMIC_MAX_CHARS);
    if (!relation) return null;
    return { subject, relation, dynamic };
}

function formatKeyRelationship(subject, relation, dynamic = '', counterpart = null) {
    const who = cleanBoundary(subject, 120, { ellipsis: false });
    const split = splitRelationDynamic(relation);
    const rel = genderedRelation(sanitizeRelationshipRelation(who, split.relation), counterpart);
    if (!who || !rel) return '';
    const base = `${who} — ${rel}`;
    const availableDynamic = Math.max(0, Math.min(SOCIAL_DYNAMIC_MAX_CHARS, SOCIAL_KEY_RELATIONSHIP_MAX_CHARS - base.length - 3));
    let dyn = availableDynamic > 0 ? cleanDynamic(withFoldedDynamic(dynamic, split.dynamic), availableDynamic) : '';
    if (counterpart?.lifeState === 'deceased' && !/\b(?:deceased|dead|late)\b/i.test(`${rel} ${dyn}`)) {
        dyn = cleanDynamic(dyn ? `${dyn}; deceased` : 'deceased', availableDynamic);
    }
    return dyn ? `${base} | ${dyn}` : base;
}

export function compactSocialKeyRelationship(value) {
    const text = normalizedWhitespace(value);
    if (!text) return '';
    const parsed = parseKeyRelationshipEntry(text);
    if (!parsed) return ORPHAN_LIFE_STATE.test(text) ? '' : cleanBoundary(text, SOCIAL_KEY_RELATIONSHIP_MAX_CHARS);
    return formatKeyRelationship(parsed.subject, parsed.relation, parsed.dynamic);
}

export {
    formatKeyRelationship,
};
