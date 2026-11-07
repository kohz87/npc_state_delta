/* NPC State Delta development episodes: targeted/bounded batch windows, NPC ownership and
   developmentScaleReady. Split from core-development.js as a line-for-line part; the original keeps
   the public exports. */

import { cleanText, normalizeName } from './core-text.js';
import { DURABLE_PROFILE_LIMITS, durableRefinementTokens } from './core-relationship.js';
import { BATCH_EPISODE_MAX_CHARS, developmentBindingLabels, developmentContextSegments, normalizedPhrasePresent, scopedEpisodeText } from './core-durable.js';
import { BATCH_DEVELOPMENT_CUE_RE, contextWindowGroundsReason, declarativeUserDevelopmentSegment, developmentReasonGrounded, explicitDevelopmentContextGrounded, hasNarratedTimeSkip, isBareTimePassageDevelopmentReason } from './core-development-time.js';

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
