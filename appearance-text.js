/* Appearance text and form primitives: bounded cleaning, clause splitting, shared-prefix combination,
   form keys/state and the public form/version limits. A pure part of appearance.js (same owner, moved
   without change); appearance.js keeps the public facade and re-exports every public name. Never imports appearance.js. */
import { DURABLE_PROFILE_LIMITS, normalizeName } from './core-mechanics.js';

export const APPEARANCE_FORM_LIMIT = 8;
// Version 2: a named form's description is that form's complete appearance. Version 1 forms were
// partial and were combined with the shared physical features when resolved; normalization
// converts them once (see legacyFormPresentation).
export const APPEARANCE_MODEL_VERSION = 2;

export function clean(value, max = 1800) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}
export function truthy(value) {
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}
export function appearanceText(value, max = DURABLE_PROFILE_LIMITS?.appearance || 800) { return clean(value, max); }
export function sameAppearance(a, b) { return normalizeName(a) === normalizeName(b); }
export function regexEscape(value) { return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
export function appearanceClauses(value, max) {
    return appearanceText(value, max).split(/\s*;\s*|(?<=[.!?])\s+/).map(part => appearanceText(part, max)).filter(Boolean);
}
export function stripOverallPrefix(value, overall, max) {
    const current = appearanceText(value, max);
    const shared = appearanceText(overall, max);
    if (!current || !shared) return current;
    if (sameAppearance(current, shared)) return '';

    const sharedClauses = appearanceClauses(shared, max);
    const currentClauses = appearanceClauses(current, max);
    const remaining = currentClauses.filter(clause => !sharedClauses.some(sharedClause => sameAppearance(clause, sharedClause)));
    if (remaining.length !== currentClauses.length) return appearanceText(remaining.join('; '), max);

    // Some providers repeat the shared phrase before a comma/colon rather than as a complete
    // sentence. Match the exact normalized word sequence only, never loose keyword overlap, so
    // negated or genuinely different form anatomy remains intact.
    const words = normalizeName(shared).split(/\s+/).filter(Boolean);
    if (words.length) {
        const boundary = String.raw`[\s,.;:!?()\[\]{}\-–—/]`;
        const separator = `${boundary}+`;
        const trailing = `${boundary}*`;
        const prefix = new RegExp(`^\\s*${words.map(regexEscape).join(separator)}(?=$|${boundary})${trailing}`, 'iu');
        const match = prefix.exec(current);
        if (match) {
            const remainder = current.slice(match[0].length);
            if (!/^\s*(?:is|are|was|were|be|been|being|not|never|no|hidden|covered|concealed|veiled|beneath|under|obscured)\b/i.test(remainder)) {
                return appearanceText(remainder, max);
            }
        }
    }
    return current;
}
export function combineAppearance(overall, specific, max) {
    const shared = appearanceText(overall, max);
    const local = stripOverallPrefix(specific, shared, max);
    if (!shared) return local;
    if (!local) return shared;
    if (sameAppearance(shared, local)) return shared;
    if (normalizeName(local).startsWith(normalizeName(shared))) return local;
    return appearanceText(`${shared.replace(/[\s.;,]+$/, '')}; ${local}`, max);
}
export function formKey(value) { return clean(value, 120).normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim(); }
export function formState(value) {
    const state = String(value ?? '').trim().toLowerCase();
    if (['change', 'evolve', 'correct'].includes(state)) return 'change';
    if (['refine', 'update', 'learn', 'establish'].includes(state)) return 'refine';
    return 'keep';
}
export function hasOwn(object, key) { return Object.prototype.hasOwnProperty.call(object || {}, key); }
