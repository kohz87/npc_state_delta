/* NPC State Delta development-time grounding: time-skip detection, content-token comparison,
   development-reason grounding and user-canon declarative checks. Split from core-development.js
   as a line-for-line part; the original keeps the public exports. */

import { cleanText, normalizeName } from '../core-text.js';
import { durableRefinementTokens } from '../core-relationship.js';
import { developmentContextSegments } from '../core-durable.js';

export function isBareTimePassageDevelopmentReason(value) {
    const text = normalizeName(value);
    if (!text) return true;
    if (/^(?:time|some time|a while|several years) (?:passed|elapsed)$/.test(text)) return true;
    return /^(?:(?:after|over|during) )?(?:the )?(?:next )?(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|several|many|few|\d+) (?:day|days|week|weeks|month|months|year|years|decade|decades)(?: later| passed| elapsed)?$/.test(text);
}

const DEVELOPMENT_TIME_TOKENS = new Set([
    'time', 'day', 'week', 'month', 'year', 'decade', 'season', 'spring', 'summer', 'autumn', 'fall', 'winter', 'later', 'pass', 'elapse', 'next', 'during', 'after', 'over', 'throughout', 'across', 'through', 'into', 'past', 'previous', 'last', 'within', 'for', 'in',
    'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
    'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'couple', 'several', 'many', 'few',
]);

const DEVELOPMENT_CONTENT_ALIASES = new Map([
    ['school', 'learn'], ['study', 'learn'], ['education', 'learn'], ['academic', 'learn'], ['academics', 'learn'],
    ['train', 'practice'], ['practic', 'practice'], ['practis', 'practice'], ['lesson', 'practice'], ['coach', 'practice'], ['mentor', 'practice'],
    ['develop', 'development'], ['progress', 'development'], ['improv', 'development'],
]);

const DEVELOPMENT_DURATION_AMOUNT = String.raw`(?:\d+|a|an|couple|few|several|many|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)`;
const DEVELOPMENT_DURATION_UNIT = String.raw`(?:day|week|month|year|decade|season)s?`;
const DEVELOPMENT_DURATION_RE = new RegExp(`\\b${DEVELOPMENT_DURATION_AMOUNT}(?:\\s+${DEVELOPMENT_DURATION_AMOUNT})?\\s+${DEVELOPMENT_DURATION_UNIT}\\b`);
const DEVELOPMENT_QUALIFIED_DURATION_RE = new RegExp(`\\b(?:after|over|during|throughout|across|for|in|within|through)\\s+(?:the\\s+)?(?:(?:past|previous|last|next|preceding|following)\\s+)?(?:about\\s+|roughly\\s+|nearly\\s+|almost\\s+)?(?:${DEVELOPMENT_DURATION_AMOUNT}\\s+)?${DEVELOPMENT_DURATION_UNIT}\\b`);
const DEVELOPMENT_PAST_DURATION_RE = new RegExp(`\\b(?:past|previous|last)\\s+(?:about\\s+|roughly\\s+|nearly\\s+|almost\\s+)?(?:${DEVELOPMENT_DURATION_AMOUNT}\\s+)?${DEVELOPMENT_DURATION_UNIT}\\b`);
const DEVELOPMENT_BARE_DURATION_CONTEXT_RE = new RegExp(`\\b${DEVELOPMENT_DURATION_AMOUNT}(?:\\s+${DEVELOPMENT_DURATION_AMOUNT})?\\s+${DEVELOPMENT_DURATION_UNIT}\\s+(?:of|under|with|at|in)\\b`);

export function hasNarratedTimeSkip(value) {
    const text = normalizeName(value);
    if (!text) return false;
    return /\b(?:day|week|month|year|decade|season)s?\b[^.!?\n]{0,48}\b(?:pass|passed|elapse|elapsed|later|afterward|afterwards)\b/.test(text)
        || DEVELOPMENT_QUALIFIED_DURATION_RE.test(text)
        || DEVELOPMENT_PAST_DURATION_RE.test(text)
        || (DEVELOPMENT_BARE_DURATION_CONTEXT_RE.test(text) && !/\b(?:year|years)\s+of\s+age\b/.test(text))
        || /\b(?:months|years|weeks|days|seasons)\s+later\b/.test(text)
        || /\b(?:over|during|throughout|across)\s+(?:the\s+)?(?:spring|summer|autumn|fall|winter)(?:\s+(?:and|through|into)\s+(?:the\s+)?(?:spring|summer|autumn|fall|winter))?\b/.test(text)
        || /\b(?:spring|summer|autumn|fall|winter)\s+(?:through|into)\s+(?:the\s+)?(?:spring|summer|autumn|fall|winter)\b/.test(text)
        || (DEVELOPMENT_DURATION_RE.test(text) && /\b(?:time jump|time skip|elapsed|duration|period)\b/.test(text));
}

function developmentContentTokens(value) {
    return [...new Set(durableRefinementTokens(value))]
        .filter(token => !DEVELOPMENT_TIME_TOKENS.has(token) && !/^\d+$/.test(token))
        .map(token => DEVELOPMENT_CONTENT_ALIASES.get(token) || token);
}

export function developmentReasonGrounded(reason, context, { strong = false } = {}) {
    const why = cleanText(reason, 500);
    const source = String(context || '').trim();
    if (!why) return false;
    if (!source) return true; // library/API compatibility; runtime supplies source context.
    const sourceTokens = new Set(developmentContentTokens(source));
    const reasonTokens = developmentContentTokens(why);
    if (!reasonTokens.length) return false;
    const matches = reasonTokens.filter(token => sourceTokens.has(token)).length;
    const required = strong && reasonTokens.length > 2 ? 2 : 1;
    return matches >= required;
}

const EXPLICIT_DEVELOPMENT_CUE_RE = /\b(?:no longer|formerly|used to|ceased|stopped being|became|become|grown|grew|increasingly|decreasingly|changed|from then on|henceforth|ever since|second nature|true nature|habitual|habitually|permanent|permanently|lasting|now (?:always|usually|routinely|consistently|more|less)|contrary to|actually|in fact|has always|had always|never was|never had been|mistaken|misunderstood)\b/;
export const BATCH_DEVELOPMENT_CUE_RE = /\b(?:gradually|repeatedly|consistently|routinely|throughout|eventually|over time|during that time|by then|became|become|grown|grew|learn(?:ed|ing|s)?|practic(?:ed|ing)|practis(?:ed|ing)|progress(?:ed|ing|ion)|develop(?:ed|ing|ment)|improv(?:ed|ing|ement)|train(?:ed|ing)|stud(?:y|ies|ied|ying)|apprentice(?:d|ship)?|school(?:ing|ed)?|education|master(?:ed|ing)|lesson(?:s)?|taught|teaching|coach(?:ed|ing)|mentor(?:ed|ing)|adopt(?:ed|ing)|replac(?:ed|ing)|discard(?:ed|ing)|transition(?:ed|ing)|shift(?:ed|ing)|habitual|second nature|true nature|chang(?:e|ed|es|ing))\b/;

export function contextWindowGroundsReason(reason, value, strong = false) {
    const reasonTokens = developmentContentTokens(reason);
    if (!reasonTokens.length) return false;
    const sourceTokens = new Set(developmentContentTokens(value));
    const matches = reasonTokens.filter(token => sourceTokens.has(token)).length;
    const required = strong && reasonTokens.length > 2 ? 2 : 1;
    return matches >= required;
}

const USER_CANON_NONDECLARATIVE_RE = /^(?:m\d+\s+)?(?:["'“‘]|(?:i|we)\s+(?:wonder|wish|want|hope|ask|suggest|imagine|think|guess|suppose)|(?:please|let(?:'s| us)|maybe|perhaps|possibly|could|would|should|might|what if|if only|can you|could you|would you|make\b|have\b))/i;
const USER_CANON_SPECULATIVE_RE = /\b(?:maybe|perhaps|possibly|might|could become|would become|should become|may become|i wonder|i think|i guess|i suppose|i hope|i want|i wish)\b/i;

export function declarativeUserDevelopmentSegment(segment) {
    const source = cleanText(segment, 1200);
    if (!source || /\?\s*$/.test(source)) return false;
    const body = source.replace(/^\[m\d+\]\s*/i, '').replace(/^[^:]{1,80}:\s*/, '').trim();
    if (!body || USER_CANON_NONDECLARATIVE_RE.test(normalizeName(body)) || USER_CANON_SPECULATIVE_RE.test(normalizeName(body))) return false;
    // A line that is entirely quoted speech is dialogue, not narrator/player canon.
    const quoted = body.match(/^(?:["“‘'])([\s\S]*)(?:["”’'])$/);
    if (quoted) return false;
    return true;
}

export function explicitDevelopmentContextGrounded(reason, context, { requireDeclarativeUser = false } = {}) {
    const source = String(context || '').trim();
    if (!source) return true;
    return developmentContextSegments(source).some(segment => {
        if (requireDeclarativeUser && !declarativeUserDevelopmentSegment(segment)) return false;
        return EXPLICIT_DEVELOPMENT_CUE_RE.test(normalizeName(segment))
            && contextWindowGroundsReason(reason, segment);
    });
}
