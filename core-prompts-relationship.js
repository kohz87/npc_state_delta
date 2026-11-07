/* NPC State Delta focused relationship-pass prompt. Split from core-prompts.js without change; core-prompts.js
   re-exports every name it exported before. */
import { DEFAULT_RELATIONSHIP, DEFAULT_RELATIONSHIP_CAPS, DURABLE_PROFILE_LIMITS, normalizeRelationshipBaseline, normalizeRelationshipCaps, normalizeRelationshipEventHistory, normalizeRelationshipEvidence } from './core-relationship.js';
import { cleanList, cleanText, cleanWords } from './core-text.js';
import { orderedBehaviorProfile } from './core-behavior.js';

import { compactImpactRubric, compactRelationshipRubric, DEFAULT_IMPACT_CRITERIA, DEFAULT_RELATIONSHIP_CRITERIA, flatPromptName } from './core-prompts-criteria.js';
export function buildRelationshipPassPrompt({
    transcript,
    targets = [],
    userName: rawUserName = 'User',
    relationshipCriteria = DEFAULT_RELATIONSHIP_CRITERIA,
    impactCriteria = DEFAULT_IMPACT_CRITERIA,
    relationshipCaps = DEFAULT_RELATIONSHIP_CAPS,
    window = false,
}) {
    const userName = flatPromptName(rawUserName, 'User');
    const caps = normalizeRelationshipCaps(relationshipCaps);
    const compactTargets = (Array.isArray(targets) ? targets : []).slice(0, 4).map(npc => ({
        id: cleanText(npc?.id, 100),
        name: cleanText(npc?.name, 120),
        currentRelationship: normalizeRelationshipBaseline(npc?.relationship || DEFAULT_RELATIONSHIP),
        // (cleanup step 12, I-7) The whole stored summary: "COPY IT EXACTLY" must copy all of it.
        relationshipSummary: cleanWords(npc?.relationshipSummary, DURABLE_PROFILE_LIMITS.relationshipSummary),
        personality: cleanText(npc?.personality, 180),
        behaviorProfile: orderedBehaviorProfile(npc?.behaviorProfile).slice(0, 4).map(item => cleanText(item, 120)),
        speech: cleanText(npc?.speech, 120),
        mannerisms: cleanList(npc?.mannerisms, 2, 100),
        goal: cleanText(npc?.goal, 140),
        keyRelationships: cleanList(npc?.keyRelationships, 3, 140),
        recentRelationshipEvents: normalizeRelationshipEventHistory(npc?.relationshipEventHistory).slice(-4).map(event => ({
            impact: cleanText(event.impact, 20),
            reason: cleanText(event.reason, 180),
            evidence: normalizeRelationshipEvidence(event.evidence),
            sourceMessageId: Number.isInteger(event.sourceMessageId) ? event.sourceMessageId : null,
        })),
    })).filter(npc => npc.id);
    const relationshipRubric = compactRelationshipRubric(relationshipCriteria);
    const impactRubric = compactImpactRubric(impactCriteria);
    const prompt = `You are NPC State Delta's focused relationship evaluator. Assess ONLY how each target NPC's relationship toward ${userName} changes because of the supplied CURRENT exchange.

Rules:
1. Return exactly one result for EACH target id. Never omit a target.
2. currentRelationship is read-only. Output signed DELTAS, never absolute scores.
3. relationshipDelta is REQUIRED with ALL FOUR numeric keys: trust, affection, desire, tension. relationshipEvidence is REQUIRED with ALL FOUR string keys; every non-zero axis needs its own short CURRENT-exchange evidence, while zero axes use an empty string.
4. Count actions and consequences, not just dialogue, but score NEW relationship evidence only. Routine continuation, expected friendliness/care, ordinary companionship, or ongoing aftermath of recentRelationshipEvents are normally ZERO. Do not reward the same rescue, confession, bargain, intimacy, argument, or favor again just because later messages continue it.
5. Use relationshipImpact none|ordinary|meaningful|major|extreme. none requires four zeros. Raw maxima are ordinary 1 / meaningful 2 / major 5 / extreme 10 per supported axis. Most events move 0-1 axes; meaningful max2, major max3, extreme max4, each with distinct evidence. These are evidence weights before score resistance, not guaranteed visible points.
6. IDENTITY FIRST: personality/behaviorProfile/speech/mannerisms/goal/other bonds remain the person; the player is not their only motive or relationship. Trust is not obedience; Affection is not devotion; Desire is not implied by affection; Tension is not automatically jealousy/embarrassment. High scores are secondary and need not surface every scene.
7. relationshipSummary is REQUIRED: durable prose Relationship field toward ${userName}, not event log/personality replacement. If still accurate, COPY IT EXACTLY; otherwise rewrite concisely. Keep intensity proportional to current scores/evidence; avoid absolute devotion/dependence language unless truly established. major/extreme turning point MUST rewrite an old summary.
8. Keep deltas within cap. Every non-zero axis needs grounded relationshipEvidence from CURRENT exchange and the overall event needs one short relationshipChangeReason. Desire requires explicit attraction/romantic/intimate/physical evidence; rescue, gratitude, affection, trust, or proximity alone never supports Desire. If evidence is insufficient, zero that axis; if all axes zero use impact none and empty reason.
9. JSON only, no markdown: {"npcs":[{"id":"...","relationshipImpact":"major","relationshipDelta":{"trust":-5,"affection":-2,"desire":0,"tension":5},"relationshipEvidence":{"trust":"the player exposed her private confidence","affection":"the betrayal hurt her attachment","desire":"","tension":"the confrontation created unresolved strain"},"relationshipSummary":"She feels betrayed and guarded toward the player, while former warmth leaves the conflict emotionally complicated.","relationshipChangeReason":"The player publicly exposed her private confidence."}]}

Relationship rubric: ${relationshipRubric || '(none)'}
Impact rubric: ${impactRubric || '(none)'}
Caps: ordinary ${caps.ordinary}; meaningful ${caps.meaningful}; major ${caps.major}; extreme ${caps.extreme}.
Targets: ${JSON.stringify(compactTargets)}
Current exchange:
${String(transcript || '').trim()}`;
    if (!window) return prompt;
    // Several exchanges, each read once: a change is scored in the exchange it happened in, with that exchange's own evidence.
    return prompt
        .replace('because of the supplied CURRENT exchange.', 'because of the supplied exchanges. They are in order, the latest last; each was read once, so score a change in the exchange where it happened.')
        .replace('its own short CURRENT-exchange evidence', 'its own short evidence from the exchange it happened in')
        .replace('grounded relationshipEvidence from CURRENT exchange', 'grounded relationshipEvidence from the exchange it happened in')
        .replace('\nCurrent exchange:\n', '\nExchanges:\n');
}
