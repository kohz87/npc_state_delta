/* NPC State Delta durable profile development: profile-update evidence normalizing, development-reason and time-skip grounding,
   development episodes (tagged, targeted, bounded, batch), developmentScaleReady, applyDurableProfileUpdate(s) and
   resolveInterimIdentityPromotions. A pure part of core-mechanics.js (same owner, moved without change); core-mechanics.js
   re-exports every name it exported before. Never imports core-mechanics.js or core.js. */
import { durableProfileEvidenceReason, gradualProfileEvolutionReady, mergeProfileEvidence, mergeRecentProfileEvidence, normalizeProfileEvidence, profileEvidenceCount, unresolvedCollectionEvidence, unresolvedProfileEvidence } from './core-evidence.js';
import { cleanText, normalizeName } from './core-text.js';
import { DURABLE_PROFILE_LIMITS, durableEvidenceGroundsValue, durableRefinementTokens, durableSeedGrounded } from './core-relationship.js';
import { BATCH_EPISODE_MAX_CHARS, developmentBindingLabels, developmentContextSegments, durableRefinementCandidateGrounded, filterSafeMannerismRefinements, groundedAppearanceChange, groundedAppearanceCorrection, identityMoralityConflict, isExplicitRecurringMannerism, isSafeIdentityTextRefinement, isSafeSpeechRefinement, isSafeUnmarkedDurableFieldReplacement, isSafeUnmarkedDurableRefinement, mergeDurableTextRefinement, normalizedPhrasePresent, normalizeMannerisms, presentationContinuationEvidence, scopedEpisodeText, speechSupportContext } from './core-durable.js';
import { durableTextAccepted, incomingCustomFields, incomingKeyRelationships, mergeImportantMemories, mergeLists, normalizeScanNpc, npcMatchesLabel, PROFILE_UPDATE_TEXT_FIELDS } from './core-record.js';
import { PROFILE_EVIDENCE_FIELDS } from './src/fields/registry.js';
import { durableProfileCollectionCandidateGrounded, durableProfileCollectionEquivalent, groundedBehaviorProfile, mergeBehaviorProfileRefinements, normalizeBehaviorProfile, reconcileBehaviorProfileWithPersonality, recoverBehaviorProfileKeepAdditions } from './core-behavior.js';
import { findInterimIdentityPromotionIndex, inferNpcIdentityKind } from './core-identity.js';

function normalizeProfileUpdateEvidence(raw = {}) {
    return normalizeProfileEvidence(raw.evidence ?? raw.profileEvidence ?? raw.profile_evidence ?? raw.observations ?? {});
}

function isBareTimePassageDevelopmentReason(value) {
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

function hasNarratedTimeSkip(value) {
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

function developmentReasonGrounded(reason, context, { strong = false } = {}) {
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
const BATCH_DEVELOPMENT_CUE_RE = /\b(?:gradually|repeatedly|consistently|routinely|throughout|eventually|over time|during that time|by then|became|become|grown|grew|learn(?:ed|ing|s)?|practic(?:ed|ing)|practis(?:ed|ing)|progress(?:ed|ing|ion)|develop(?:ed|ing|ment)|improv(?:ed|ing|ement)|train(?:ed|ing)|stud(?:y|ies|ied|ying)|apprentice(?:d|ship)?|school(?:ing|ed)?|education|master(?:ed|ing)|lesson(?:s)?|taught|teaching|coach(?:ed|ing)|mentor(?:ed|ing)|adopt(?:ed|ing)|replac(?:ed|ing)|discard(?:ed|ing)|transition(?:ed|ing)|shift(?:ed|ing)|habitual|second nature|true nature|chang(?:e|ed|es|ing))\b/;

function contextWindowGroundsReason(reason, value, strong = false) {
    const reasonTokens = developmentContentTokens(reason);
    if (!reasonTokens.length) return false;
    const sourceTokens = new Set(developmentContentTokens(value));
    const matches = reasonTokens.filter(token => sourceTokens.has(token)).length;
    const required = strong && reasonTokens.length > 2 ? 2 : 1;
    return matches >= required;
}

const USER_CANON_NONDECLARATIVE_RE = /^(?:m\d+\s+)?(?:["'“‘]|(?:i|we)\s+(?:wonder|wish|want|hope|ask|suggest|imagine|think|guess|suppose)|(?:please|let(?:'s| us)|maybe|perhaps|possibly|could|would|should|might|what if|if only|can you|could you|would you|make\b|have\b))/i;
const USER_CANON_SPECULATIVE_RE = /\b(?:maybe|perhaps|possibly|might|could become|would become|should become|may become|i wonder|i think|i guess|i suppose|i hope|i want|i wish)\b/i;

function declarativeUserDevelopmentSegment(segment) {
    const source = cleanText(segment, 1200);
    if (!source || /\?\s*$/.test(source)) return false;
    const body = source.replace(/^\[m\d+\]\s*/i, '').replace(/^[^:]{1,80}:\s*/, '').trim();
    if (!body || USER_CANON_NONDECLARATIVE_RE.test(normalizeName(body)) || USER_CANON_SPECULATIVE_RE.test(normalizeName(body))) return false;
    // A line that is entirely quoted speech is dialogue, not narrator/player canon.
    const quoted = body.match(/^(?:["“‘'])([\s\S]*)(?:["”’'])$/);
    if (quoted) return false;
    return true;
}

function explicitDevelopmentContextGrounded(reason, context, { requireDeclarativeUser = false } = {}) {
    const source = String(context || '').trim();
    if (!source) return true;
    return developmentContextSegments(source).some(segment => {
        if (requireDeclarativeUser && !declarativeUserDevelopmentSegment(segment)) return false;
        return EXPLICIT_DEVELOPMENT_CUE_RE.test(normalizeName(segment))
            && contextWindowGroundsReason(reason, segment);
    });
}

const BATCH_TEMPORAL_CONTINUATION_RE = /\b(?:during that time|during this time|over that period|over this period|throughout that time|throughout this period|by then|over the interval|during the interval)\b/;
const BATCH_WEAK_TRANSITION_CUE_RE = /\b(?:chang(?:e|ed|es|ing)|adopt(?:ed|ing)|replac(?:ed|ing)|discard(?:ed|ing)|transition(?:ed|ing)|shift(?:ed|ing))\b/;
const BATCH_EPISODE_MAX_SEGMENTS = 12;
const BATCH_EPISODE_END_RE = /\b(?:back in the present|back to the present|returned to the present|returning to the present|the present scene|later that evening|later that night|the next morning|the following morning)\b/;
const BATCH_EPISODE_NEW_ANCHOR_RE = /^(?:m\d+\s+)?(?:another\s+)?(?:(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|\d+)(?:\s+(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|\d+))?\s+)?(?:day|week|month|year|decade|season)s?\s+(?:passed|later)\b/;

function startsNewDevelopmentEpisode(segment) {
    return BATCH_EPISODE_NEW_ANCHOR_RE.test(normalizeName(segment));
}

function developmentEvidenceOwnsScope(evidence, scoped) {
    const evidenceTokens = [...new Set(durableRefinementTokens(evidence))];
    const scopeTokens = new Set(durableRefinementTokens(scoped));
    if (!evidenceTokens.length || !scopeTokens.size) return false;
    const overlap = evidenceTokens.filter(token => scopeTokens.has(token)).length;
    const required = evidenceTokens.length <= 2 ? 1 : 2;
    return overlap >= required && contextWindowGroundsReason(evidence, scoped, false);
}

function developmentEpisodeNpcBound(window, binding = null) {
    if (!binding) return true;
    const labels = developmentBindingLabels(binding);
    const evidence = Array.isArray(binding?.evidence) ? binding.evidence : [];
    const targetMentioned = labels.some(label => normalizedPhrasePresent(window, label));
    const scoped = targetMentioned ? scopedEpisodeText(window, binding) : window;
    const groundedEvidence = evidence
        .map(value => cleanText(String(value || '').replace(/^\[m\d+\]\s*/i, '').replace(/^[^:]{1,52}:\s*/, ''), DURABLE_PROFILE_LIMITS.evidence))
        .filter(Boolean)
        .some(value => developmentEvidenceOwnsScope(value, scoped));
    if (targetMentioned) return evidence.length ? groundedEvidence : true;
    if (binding?.targeted === true) return evidence.length ? groundedEvidence : true;
    return false;
}

function taggedDevelopmentMessages(context) {
    return String(context || '').split(/\n+/).map(line => {
        const match = String(line || '').match(/^\[m(\d+)\]\s*([\s\S]*)$/i);
        return match ? { id: Number(match[1]), text: cleanText(match[2], 12000) } : null;
    }).filter(item => item && Number.isInteger(item.id) && item.text);
}

function targetedDevelopmentEpisode(reason, context, binding = null) {
    if (binding?.targeted !== true) return null;
    const evidence = Array.isArray(binding?.evidence) ? binding.evidence : [];
    const evidenceItems = evidence.map(value => {
        const text = String(value || '');
        const marker = text.match(/^\[m(\d+)\]\s*/i);
        const sourceMessageId = marker ? Number(marker[1]) : null;
        const body = cleanText(text.replace(/^\[m\d+\]\s*/i, '').replace(/^[^:]{1,52}:\s*/, ''), DURABLE_PROFILE_LIMITS.evidence);
        return { sourceMessageId, body };
    }).filter(item => Number.isInteger(item.sourceMessageId) && item.body);
    if (!evidenceItems.length) return null;
    const messages = taggedDevelopmentMessages(context);
    if (!messages.length) return null;
    const evidenceIds = [...new Set(evidenceItems.map(item => item.sourceMessageId))].sort((a, b) => a - b);
    const firstEvidenceId = evidenceIds[0];
    const lastEvidenceId = evidenceIds[evidenceIds.length - 1];
    let anchorIndex = -1;
    for (let i = 0; i < messages.length; i += 1) {
        if (messages[i].id > firstEvidenceId) break;
        if (hasNarratedTimeSkip(messages[i].text)) anchorIndex = i;
    }
    if (anchorIndex < 0) return null;
    let lastIndex = messages.findIndex(item => item.id === lastEvidenceId);
    if (lastIndex < anchorIndex) lastIndex = anchorIndex;
    const selected = messages.slice(anchorIndex, Math.min(messages.length, lastIndex + 1));
    const window = cleanText(selected.map(item => `[m${item.id}] ${item.text}`).join(' '), 18000);
    const hasDevelopment = selected.some(item => BATCH_DEVELOPMENT_CUE_RE.test(normalizeName(item.text)));
    const evidenceGrounded = evidenceItems.some(item => {
        const source = messages.find(message => message.id === item.sourceMessageId)?.text || '';
        return source && developmentEvidenceOwnsScope(item.body, source);
    });
    const reasonGrounded = hasDevelopment && contextWindowGroundsReason(reason, window, true);
    return {
        detected: true,
        grounded: Boolean(reasonGrounded && evidenceGrounded),
        npcBound: Boolean(evidenceGrounded),
        anchorIndex: messages[anchorIndex].id,
        segmentCount: selected.length,
        window,
    };
}

function boundedDevelopmentEpisode(segments, anchorIndex) {
    const selected = [];
    let chars = 0;
    let sawDevelopment = false;
    for (let i = anchorIndex; i < segments.length && selected.length < BATCH_EPISODE_MAX_SEGMENTS; i += 1) {
        const segment = segments[i];
        if (i > anchorIndex && sawDevelopment && startsNewDevelopmentEpisode(segment)) break;
        const normalized = normalizeName(segment);
        if (i > anchorIndex && sawDevelopment && BATCH_EPISODE_END_RE.test(normalized)
            && !BATCH_TEMPORAL_CONTINUATION_RE.test(normalized)) break;
        if (chars + segment.length > BATCH_EPISODE_MAX_CHARS) break;
        selected.push(segment);
        chars += segment.length;
        if (BATCH_DEVELOPMENT_CUE_RE.test(normalized)) sawDevelopment = true;
    }
    return selected.join(' ');
}

export function developmentEpisodeDiagnostic(reason, context, binding = null) {
    const source = String(context || '').trim();
    const diagnostic = { detected: false, grounded: false, npcBound: binding ? false : null, anchorIndex: null, segmentCount: 0 };
    if (!source) return { ...diagnostic, grounded: true, npcBound: binding ? Boolean(binding?.targeted) : null };
    const targeted = targetedDevelopmentEpisode(reason, source, binding);
    if (targeted?.grounded) {
        const { window: _window, ...details } = targeted;
        return details;
    }
    const segments = developmentContextSegments(source);
    for (let i = 0; i < segments.length; i += 1) {
        if (!hasNarratedTimeSkip(segments[i])) continue;
        diagnostic.detected = true;
        const window = boundedDevelopmentEpisode(segments, i);
        const segmentCount = developmentContextSegments(window).length;
        const hasDevelopment = developmentContextSegments(window).some(segment => {
            const normalized = normalizeName(segment);
            if (!BATCH_DEVELOPMENT_CUE_RE.test(normalized)) return false;
            if (BATCH_WEAK_TRANSITION_CUE_RE.test(normalized) && !contextWindowGroundsReason(reason, segment)) return false;
            return true;
        });
        const npcBound = developmentEpisodeNpcBound(window, binding);
        const reasonGrounded = hasDevelopment && npcBound && contextWindowGroundsReason(reason, window, true);
        if (reasonGrounded && npcBound) {
            return { detected: true, grounded: true, npcBound: binding ? true : null, anchorIndex: i, segmentCount };
        }
        if (reasonGrounded) diagnostic.grounded = true;
        if (npcBound && binding) diagnostic.npcBound = true;
        if (diagnostic.anchorIndex === null) {
            diagnostic.anchorIndex = i;
            diagnostic.segmentCount = segmentCount;
        }
    }
    return diagnostic;
}

export function developmentEpisodeEvidence(reason, context, binding = null) {
    const source = String(context || '').trim();
    if (!source) return '';
    const targeted = targetedDevelopmentEpisode(reason, source, binding);
    if (targeted?.grounded && targeted.window) return targeted.window;
    const segments = developmentContextSegments(source);
    for (let i = 0; i < segments.length; i += 1) {
        if (!hasNarratedTimeSkip(segments[i])) continue;
        const window = boundedDevelopmentEpisode(segments, i);
        const hasDevelopment = developmentContextSegments(window).some(segment => {
            const normalized = normalizeName(segment);
            if (!BATCH_DEVELOPMENT_CUE_RE.test(normalized)) return false;
            if (BATCH_WEAK_TRANSITION_CUE_RE.test(normalized) && !contextWindowGroundsReason(reason, segment)) return false;
            return true;
        });
        if (!hasDevelopment || !developmentEpisodeNpcBound(window, binding)) continue;
        const scoped = scopedEpisodeText(window, binding);
        if (!scoped || !contextWindowGroundsReason(reason, window, true)) continue;
        return scoped;
    }
    return '';
}

function batchDevelopmentContextGrounded(reason, context, binding = null) {
    const source = String(context || '').trim();
    if (!source) return true;
    const diagnostic = developmentEpisodeDiagnostic(reason, source, binding);
    return diagnostic.grounded && (!binding || diagnostic.npcBound === true);
}

export function developmentScaleReady(scale, reason, context, binding = null) {
    const mode = ['gradual', 'explicit', 'batch'].includes(String(scale || '')) ? String(scale) : 'gradual';
    if (mode === 'gradual') return false;
    const source = String(context || '').trim();
    if (binding?.sourceAuthority === 'user' && !source) return false;
    if (!developmentReasonGrounded(reason, context, { strong: mode === 'batch' })) return false;
    if (mode === 'explicit' && source && !explicitDevelopmentContextGrounded(reason, source, {
        requireDeclarativeUser: binding?.sourceAuthority === 'user',
    })) return false;
    if (mode === 'batch') {
        if (isBareTimePassageDevelopmentReason(reason)) return false;
        if (binding?.sourceAuthority === 'user' && source) {
            const declarativeDevelopment = developmentContextSegments(source).some(segment =>
                declarativeUserDevelopmentSegment(segment)
                && BATCH_DEVELOPMENT_CUE_RE.test(normalizeName(segment))
                && contextWindowGroundsReason(reason, segment));
            if (!declarativeDevelopment) return false;
        }
        if (source && (!hasNarratedTimeSkip(source) || !batchDevelopmentContextGrounded(reason, source, binding))) return false;
    }
    return true;
}

function applyDurableProfileUpdate(npc, raw = {}, options = {}) {
    const incoming = normalizeScanNpc(raw);
    const manualFields = new Set(Array.isArray(npc.manualProfileFields) ? npc.manualProfileFields : []);
    const beforeEvidence = normalizeProfileEvidence(npc.profileEvidence);
    const incomingEvidence = normalizeProfileUpdateEvidence(raw);
    if (incoming.nonLeverBehavior?.length) {
        incomingEvidence.mannerisms = mergeRecentProfileEvidence(incomingEvidence.mannerisms, incoming.nonLeverBehavior);
    }
    let evidence = mergeProfileEvidence(beforeEvidence, Object.fromEntries(PROFILE_EVIDENCE_FIELDS.map(field => [
        field, manualFields.has(field) ? [] : incomingEvidence[field],
    ])));
    let changed = false;

    const evolutionReady = (field, { allowObservationCount = true } = {}) => {
        const scale = incoming.developmentScale || 'gradual';
        const authorityProvenanceSupplied = Object.prototype.hasOwnProperty.call(options, 'userDevelopmentContext');
        if (authorityProvenanceSupplied && (field === 'personality' || field === 'speech')) return false;
        const fieldReason = field === 'mannerisms' ? incoming.mannerismReason
            : field === 'behaviorProfile' ? incoming.behaviorProfileReason
                : field === 'personality' ? incoming.personalityReason
                    : field === 'speech' ? incoming.speechReason : '';
        const currentValue = field === 'mannerisms' || field === 'behaviorProfile' ? npc[field] || [] : npc[field] || '';
        const candidateValue = field === 'mannerisms' || field === 'behaviorProfile' ? incoming[field] || [] : incoming[field] || '';
        const evidenceReason = durableProfileEvidenceReason(field, currentValue, candidateValue, incomingEvidence[field] || []);
        const effectiveReason = cleanText(incoming.developmentReason || fieldReason || evidenceReason, 500);
        const authoritativeContext = String(authorityProvenanceSupplied
            ? (options.userDevelopmentContext || '')
            : (options.developmentContext || '')).trim();
        const binding = {
            npc,
            evidence: incomingEvidence[field] || [],
            targeted: options.targeted === true,
            sourceAuthority: authorityProvenanceSupplied ? 'user' : null,
        };
        const candidateSpecificGrounding = field === 'mannerisms' || field === 'behaviorProfile'
            ? durableProfileCollectionCandidateGrounded(field, currentValue, candidateValue, incomingEvidence[field] || [])
            : true;
        if (scale === 'gradual') {
            return (allowObservationCount && gradualProfileEvolutionReady(field, beforeEvidence, incomingEvidence))
                || (authoritativeContext && effectiveReason && candidateSpecificGrounding
                    && developmentScaleReady('batch', effectiveReason, authoritativeContext, binding));
        }
        return (!authorityProvenanceSupplied || Boolean(authoritativeContext))
            && Boolean(effectiveReason) && candidateSpecificGrounding
            && developmentScaleReady(scale, effectiveReason, authoritativeContext, binding);
    };

    const applyText = (field, stateField, reasonField, refineState, evolveState, maxChars) => {
        if (manualFields.has(field)) return;
        const value = cleanText(incoming[field], maxChars);
        if (!value) return;
        const current = cleanText(npc[field], maxChars);
        const state = String(incoming[stateField] || 'keep');
        if (!current) {
            const repeatedEvidence = gradualProfileEvolutionReady(field, beforeEvidence, incomingEvidence)
                && durableEvidenceGroundsValue(value, [...(beforeEvidence[field] || []), ...(incomingEvidence[field] || [])]);
            // A first Speech seed must rest on this NPC's own affirmative voice in the narration.
            const seedContext = field === 'speech' && String(options.developmentContext || '').trim()
                ? (speechSupportContext(options.developmentContext, { npc, otherLabels: options.otherLabels || [] }) || '-')
                : options.developmentContext;
            const seedReady = durableSeedGrounded(value, seedContext) || repeatedEvidence;
            if (!seedReady) {
                evidence[field] = mergeRecentProfileEvidence(evidence[field], incomingEvidence[field] || [], field);
                return;
            }
            npc[field] = value;
            evidence[field] = [];
            changed = true;
            return;
        }
        const fieldEvidence = [...(beforeEvidence[field] || []), ...(incomingEvidence[field] || [])];
        const binding = {
            npc,
            evidence: fieldEvidence,
            targeted: options.targeted === true,
            otherLabels: options.otherLabels || [],
        };
        if (state === evolveState) {
            if (!String(incoming[reasonField] || '').trim()) return;
            const directAppearanceChange = field === 'appearance' && groundedAppearanceChange(
                current,
                value,
                incoming[reasonField],
                options.developmentContext,
                [...fieldEvidence, ...presentationContinuationEvidence(options.developmentContext, npc, options.otherLabels)],
                binding,
            );
            if (!directAppearanceChange && !evolutionReady(field)) return;
            // A count of observations with an evolve label may develop Personality, but a protected
            // morality reversal (kind -> cruel) needs grounded story authority, not the label alone.
            if (field === 'personality' && identityMoralityConflict(current, value)
                && !evolutionReady(field, { allowObservationCount: false })) return;
            if (normalizeName(current) !== normalizeName(value)) { npc[field] = value; changed = true; }
            evidence[field] = [];
            return;
        }
        const safeRefinement = field === 'personality'
            ? isSafeIdentityTextRefinement(current, value, options.developmentContext, fieldEvidence, binding)
            : (field === 'speech'
                ? isSafeSpeechRefinement(current, value, options.developmentContext, fieldEvidence, binding)
                : (groundedAppearanceCorrection(current, value, options.developmentContext, fieldEvidence, binding)
                    || (isSafeUnmarkedDurableRefinement(current, value)
                        && durableRefinementCandidateGrounded(field, current, value, options.developmentContext, fieldEvidence, binding))));
        const explicitRefinement = state === refineState && safeRefinement;
        const unmarkedRecovery = state !== refineState && state !== evolveState
            && isSafeUnmarkedDurableFieldReplacement(field, current, value)
            && durableRefinementCandidateGrounded(field, current, value, options.developmentContext, fieldEvidence, binding);
        if (explicitRefinement || unmarkedRecovery) {
            const merged = mergeDurableTextRefinement(current, value, maxChars);
            if (normalizeName(merged) !== normalizeName(current)) { npc[field] = merged; changed = true; }
            evidence[field] = unresolvedProfileEvidence(field, merged, beforeEvidence[field] || [], incomingEvidence[field] || []);
        }
    };

    applyText('personality', 'personalityState', 'personalityReason', 'refine', 'evolve', DURABLE_PROFILE_LIMITS.personality);
    applyText('speech', 'speechState', 'speechReason', 'refine', 'evolve', DURABLE_PROFILE_LIMITS.speech);
    applyText('appearance', 'appearanceState', 'appearanceReason', 'refine', 'change', DURABLE_PROFILE_LIMITS.appearance);

    if (!manualFields.has('mannerisms') && incoming.mannerismsProvided) {
        const current = normalizeMannerisms(npc.mannerisms || []);
        if (!current.length) {
            const source = String(options.developmentContext || '').trim();
            const gradualSeedReady = gradualProfileEvolutionReady('mannerisms', beforeEvidence, incomingEvidence);
            const mannerEvidence = [...(beforeEvidence.mannerisms || []), ...(incomingEvidence.mannerisms || [])];
            const seed = source
                ? (incoming.mannerisms || []).filter(entry => isExplicitRecurringMannerism(entry, source)
                    || (gradualSeedReady && durableEvidenceGroundsValue(entry, mannerEvidence)))
                : (incoming.mannerisms || []);
            npc.mannerisms = normalizeMannerisms(seed);
            if (npc.mannerisms.length) evidence.mannerisms = [];
            changed = npc.mannerisms.length > 0 || changed;
        } else if (incoming.mannerismState === 'evolve' && String(incoming.mannerismReason || '').trim() && evolutionReady('mannerisms')) {
            const replacement = normalizeMannerisms(incoming.mannerisms || []);
            if (JSON.stringify(replacement) !== JSON.stringify(current)) { npc.mannerisms = replacement; changed = true; }
            evidence.mannerisms = [];
        } else if (incoming.mannerismState === 'refine') {
            const allowNewPattern = evolutionReady('mannerisms');
            const safe = filterSafeMannerismRefinements(current, incoming.mannerisms, allowNewPattern, options.developmentContext);
            const proposedRefined = safe.length ? normalizeMannerisms(safe) : current;
            const refined = durableProfileCollectionEquivalent('mannerisms', current, proposedRefined) ? current : proposedRefined;
            if (JSON.stringify(refined) !== JSON.stringify(current)) { npc.mannerisms = refined; changed = true; }
            const refinedChanged = JSON.stringify(refined) !== JSON.stringify(current);
            const acceptedMannerisms = refinedChanged ? refined : current;
            evidence.mannerisms = unresolvedCollectionEvidence('mannerisms', acceptedMannerisms, beforeEvidence.mannerisms || [], incomingEvidence.mannerisms || []);


        }
    }

    if (!manualFields.has('behaviorProfile') && incoming.behaviorProfileProvided) {
        const current = normalizeBehaviorProfile(npc.behaviorProfile || []);
        if (!current.length) {
            const behaviorEvidence = [...(beforeEvidence.behaviorProfile || []), ...(incomingEvidence.behaviorProfile || [])];
            const grounded = groundedBehaviorProfile(incoming.behaviorProfile || [], npc.personality, options.developmentContext, behaviorEvidence, {
                npc,
                evidence: behaviorEvidence,
                targeted: options.targeted === true,
                otherLabels: options.otherLabels || [],
            });
            npc.behaviorProfile = reconcileBehaviorProfileWithPersonality(grounded, npc.personality);
            if (npc.behaviorProfile.length) evidence.behaviorProfile = [];
            else evidence.behaviorProfile = mergeRecentProfileEvidence(evidence.behaviorProfile, incomingEvidence.behaviorProfile || [], 'behaviorProfile');
            changed = npc.behaviorProfile.length > 0 || changed;
        } else if (incoming.behaviorProfileState === 'evolve' && String(incoming.behaviorProfileReason || '').trim() && evolutionReady('behaviorProfile')) {
            const replacement = reconcileBehaviorProfileWithPersonality(incoming.behaviorProfile || [], npc.personality);
            if (JSON.stringify(replacement) !== JSON.stringify(current)) { npc.behaviorProfile = replacement; changed = true; }
            evidence.behaviorProfile = [];
        } else if (incoming.behaviorProfileState === 'refine') {
            const proposedRefined = mergeBehaviorProfileRefinements(current, incoming.behaviorProfile, {
                context: options.developmentContext,
                personality: npc.personality,
                rejected: incoming.nonLeverBehavior || [],
                evidenceItems: [...(beforeEvidence.behaviorProfile || []), ...(incomingEvidence.behaviorProfile || [])],
                binding: {
                    npc,
                    evidence: [...(beforeEvidence.behaviorProfile || []), ...(incomingEvidence.behaviorProfile || [])],
                    targeted: options.targeted === true,
                    otherLabels: options.otherLabels || [],
                },
            });
            const refined = durableProfileCollectionEquivalent('behaviorProfile', current, proposedRefined) ? current : proposedRefined;
            if (JSON.stringify(refined) !== JSON.stringify(current)) { npc.behaviorProfile = refined; changed = true; }
            const refinedChanged = JSON.stringify(refined) !== JSON.stringify(current);
            const acceptedBehaviorProfile = refinedChanged ? refined : current;
            evidence.behaviorProfile = unresolvedCollectionEvidence('behaviorProfile', acceptedBehaviorProfile, beforeEvidence.behaviorProfile || [], incomingEvidence.behaviorProfile || []);
        } else if (incoming.behaviorProfileState === 'keep') {
            const behaviorEvidence = [...(beforeEvidence.behaviorProfile || []), ...(incomingEvidence.behaviorProfile || [])];
            const recovered = recoverBehaviorProfileKeepAdditions(current, incoming.behaviorProfile, {
                context: options.developmentContext,
                rejected: incoming.nonLeverBehavior || [],
                evidenceItems: behaviorEvidence,
                binding: {
                    npc,
                    evidence: behaviorEvidence,
                    targeted: options.targeted === true,
                    otherLabels: options.otherLabels || [],
                },
            });
            if (JSON.stringify(recovered) !== JSON.stringify(current)) { npc.behaviorProfile = recovered; changed = true; }
            const acceptedBehaviorProfile = JSON.stringify(recovered) !== JSON.stringify(current) ? recovered : current;
            evidence.behaviorProfile = unresolvedCollectionEvidence('behaviorProfile', acceptedBehaviorProfile, beforeEvidence.behaviorProfile || [], incomingEvidence.behaviorProfile || []);
        }
    }

    // (cleanup step 5) The other durable facts a profile update carries (the scanner rule sends an
    // existing NPC's durable facts there) are applied by the same rules as in the NPC's npcs[] entry;
    // they used to be dropped without a word. Live state (mood, location, goal, status) stays npcs[]-only.
    for (const field of PROFILE_UPDATE_TEXT_FIELDS) {
        if (manualFields.has(field)) continue;
        const value = typeof incoming[field] === 'string' ? incoming[field].trim() : '';
        if (!value || value === String(npc[field] ?? '').trim()) continue;
        if (!durableTextAccepted(field, npc, incoming, value, options)) continue;
        npc[field] = value;
        changed = true;
    }
    const customFields = incomingCustomFields(npc, incoming, manualFields, options);
    if (customFields) {
        npc.customFields = customFields;
        changed = true;
    }
    if (incoming.keyRelationshipsProvided && !manualFields.has('keyRelationships')) {
        const bonds = incomingKeyRelationships(npc, incoming, manualFields);
        if (JSON.stringify(bonds) !== JSON.stringify(npc.keyRelationships || [])) {
            npc.keyRelationships = bonds;
            changed = true;
        }
    }

    // (1.2.19) A model that files a known NPC's new memory under profileUpdates (a durable fact,
    // which the rules send there) used to lose it: only the npcs[] entry merged memories. Merged
    // here the same way: added to the stored ones, deduplicated, capped, never replacing them.
    if ((incoming.memories || []).length && !manualFields.has('memories')) {
        const before = JSON.stringify(npc.memories || []);
        npc.memories = mergeImportantMemories(npc.memories, incoming.memories, incoming.memoryRetention, options.memoryInputLimit || 3, npc.manualMemories);
        if (JSON.stringify(npc.memories) !== before) changed = true;
    }

    const evidenceChanged = JSON.stringify(beforeEvidence) !== JSON.stringify(evidence);
    npc.profileEvidence = evidence;
    if (changed || evidenceChanged) npc.updatedAt = Date.now();
    return { changed, evidenceAdded: Math.max(0, profileEvidenceCount(evidence) - profileEvidenceCount(beforeEvidence)) };
}

export function applyDurableProfileUpdates(state, scanResult, excludeNames, report, options = {}) {
    const rawUpdates = Array.isArray(scanResult?.profileUpdates) ? scanResult.profileUpdates
        : (Array.isArray(scanResult?.profile_updates) ? scanResult.profile_updates : []);
    let applied = 0;
    let evidenceAdded = 0;
    for (const raw of rawUpdates) {
        if (!raw || typeof raw !== 'object') continue;
        const id = cleanText(raw.id, 100);
        const name = cleanText(raw.name, 120);
        let index = id ? state.npcs.findIndex(npc => String(npc.id || '') === id) : -1;
        if (index < 0 && name) index = state.npcs.findIndex(npc => npcMatchesLabel(npc, name));
        if (index < 0) continue;
        const npc = state.npcs[index];
        if (excludeNames.has(normalizeName(npc.name))) continue;
        const otherLabels = (Array.isArray(state.npcs) ? state.npcs : [])
            .filter(other => String(other?.id || '') !== String(npc?.id || ''))
            .flatMap(other => [other?.name, ...(Array.isArray(other?.aliases) ? other.aliases : [])])
            .filter(Boolean);
        const result = applyDurableProfileUpdate(npc, raw, { ...options, otherLabels });
        evidenceAdded += result.evidenceAdded;
        if (result.changed) {
            applied += 1;
            if (!report.updated.includes(npc.id)) report.updated.push(npc.id);
            if (!report.profileUpdated.includes(npc.id)) report.profileUpdated.push(npc.id);
        }
    }
    return { provided: rawUpdates.length, applied, evidenceAdded };
}

export function resolveInterimIdentityPromotions(scanResult, existingNpcs = [], candidates = []) {
    const clone = {
        ...(scanResult || {}),
        npcs: Array.isArray(scanResult?.npcs) ? scanResult.npcs.map(raw => ({ ...(raw || {}) })) : [],
    };
    const records = [
        ...(Array.isArray(existingNpcs) ? existingNpcs : []),
        ...(Array.isArray(candidates) ? candidates : []),
    ];
    for (const raw of clone.npcs) {
        const incoming = normalizeScanNpc(raw);
        if (!incoming.name || inferNpcIdentityKind(incoming.name, incoming.identityKind) !== 'proper_name') continue;
        const alreadyMatches = (Array.isArray(existingNpcs) ? existingNpcs : []).some(record =>
            (incoming.id && String(record?.id || '') === String(incoming.id))
            || npcMatchesLabel(record, incoming.name)
            || incoming.aliases.some(alias => npcMatchesLabel(record, alias)));
        if (alreadyMatches) continue;
        const matchIndex = findInterimIdentityPromotionIndex(records, incoming);
        if (matchIndex < 0) continue;
        const matched = records[matchIndex];
        // Candidate ids are intentionally not copied into dossier ids. Carry their old label as
        // an alias and let the normal candidate-promotion path create the dossier when appropriate.
        const isExistingDossier = (Array.isArray(existingNpcs) ? existingNpcs : []).some(record => record?.id === matched?.id);
        if (isExistingDossier) raw.id = matched.id;
        raw.aliases = mergeLists([matched.name, ...(matched.aliases || [])], raw.aliases, 8)
            .filter(alias => normalizeName(alias) !== normalizeName(incoming.name));
        raw.identityKind = 'proper_name';
        raw.sameIndividual = true;
    }
    return clone;
}
