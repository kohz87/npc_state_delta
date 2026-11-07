/* NPC State Delta scanner criteria and rubric compaction: default relationship/impact/memory/behavior criteria,
   rolling-relationship stripping, full-window payload preparation, prompt-name flattening and rubric compaction.
   Split from core-prompts.js without change; core-prompts.js re-exports every name it exported before. */
export const DEFAULT_RELATIONSHIP_CRITERIA = `All relationship stats use a bipolar -100 to +100 scale with 0 as neutral. Positive and negative values are durable relationship states, not percentages or per-turn rewards. Score genuinely new directional evidence; do not replay the same event or its aftermath.
LOW-BAND FAMILIARITY: while the CURRENT magnitude of an axis is below 25, a fresh mundane interaction may score ordinary +/-1 on ONE supported axis when it newly demonstrates relationship direction. Examples include voluntarily spending time together, a small personal favor, considerate treatment, keeping a small promise, mild rudeness, or a modest disagreement. A mere greeting, neutral transaction, repeated routine, or continuation of an already-scored beat is still 0. Ordinary evidence may reach 25, but cannot deepen beyond that boundary until a meaningful event unlocks the milestone.
Trust: confidence, reliance, safety, and willingness to be vulnerable. Increase for newly demonstrated dependability, kept promises, protection, honest support, entrusted vulnerability, or comparable evidence. In the low band, a small newly demonstrated act of reliability may be ordinary +1. Decrease for betrayal, deception, abandonment, unreliability, violated confidence, or comparable distrust evidence. Trust is not obedience.
Affection: fondness, attachment, warmth, and personal care. Increase for newly demonstrated kindness, chosen companionship, comfort, bonding, or comparable emotional attachment. In the low band, a fresh modest warm interaction may be ordinary +1. Decrease for supported dislike, resentment, cruelty, rejection, humiliation, neglect, or emotional injury. Affection is not devotion, clinginess, jealousy, or self-erasure.
Desire: attraction or pull toward romantic/intimate/physical closeness. Positive Desire REQUIRES explicit attraction/romantic/intimate/physical evidence in the current exchange. Friendliness, gratitude, admiration, rescue, affection, proximity, repeated contact, or trust alone are never Desire evidence. Negative Desire means explicit aversion to that kind of closeness, not mere absence of attraction.
Tension: unresolved interpersonal pressure, conflict, fear, suspicion, awkward pressure, rivalry, resentment, or exceptional ease/release when negative. In the low band, a fresh modest friction/ease beat may be ordinary +/-1 when it actually changes interpersonal pressure; simple continuation is 0.
RELATIONSHIP WEIGHT: the farther an established score is from 0, the harder it becomes to deepen further. New evidence accumulates fractionally behind the integer display. Near-extreme scores therefore require repeated fresh evidence even when each event is valid. Minor contrary evidence also meets some established-relationship resistance; major/extreme betrayal, reconciliation, or comparable turning points can overcome more of it.
Most ordinary events affect zero or one axis. Meaningful events may affect two axes only with separate evidence. Major events may affect up to three; four axes are reserved for extreme events with distinct support for every moved axis. Every non-zero axis must carry its own grounded evidence.`;
export const DEFAULT_IMPACT_CRITERIA = `none: no NEW directional relationship evidence, insufficient evidence, repeated routine, or aftermath of an already-scored event; all deltas must be 0.
ordinary: a fresh modest relationship-relevant beat. Maximum raw weight 1 on one axis. While the affected axis magnitude is below 25, mundane but directional interaction may qualify: chosen companionship, a small personal favor, minor reliability, modest kindness, mild disrespect, a small disagreement, or similar fresh evidence. Mere greetings, neutral transactions, automatic politeness, and repetition of the same established routine are none. Ordinary evidence may reach 25, but cannot deepen beyond it until the milestone is unlocked by meaningful evidence.
meaningful: clearly new evidence with noticeable emotional weight. Maximum raw weight 2 per supported axis, at most two axes. This is the minimum tier that can unlock/cross 25.
major: an important turning point with lasting consequences such as serious betrayal, costly rescue, explicit romantic advance/rejection, major reconciliation, or deep personal revelation. Maximum raw weight 5 per supported axis, at most three axes.
extreme: a rare relationship-defining event such as catastrophic betrayal, self-sacrifice, irreversible loss, or explicit decisive commitment. Maximum raw weight 10 per supported axis. Extreme is still raw evidence before score resistance, so a near-extreme relationship does not automatically jump ten visible points.`;
export const DEFAULT_MEMORY_CRITERIA = `Store only durable, story-relevant events the NPC would reasonably recall in a later scene and that could affect future decisions, attitude, relationship, goals, obligations, fears, knowledge, or circumstances. Prefer concrete events such as promises, betrayals, rescues, confessions, consequential discoveries, major conflicts, meaningful gifts or favors, losses, or commitments. Do not store routine dialogue, ordinary transactions, repeated summaries of existing dossier facts, transient emotions, moment-to-moment NPC Inner Chatter, or trivial scene details. A memory should say what happened and why it matters in one short grounded sentence. Avoid duplicates or near-duplicates of memories already stored for that NPC.`;
export const DEFAULT_BEHAVIOR_CRITERIA = `IDENTITY DOMINANCE: First determine behavior from personality, values, morality, speech, mannerisms, goals, duties, current mood/status, independence, and other bonds. Only then let the player relationship make a secondary adjustment. Relationship scores are a tint on established behavior, never the character's main personality.
RELATIONSHIP SCOPE: Scores modify how the NPC weighs and responds to the player only; they do not replace the person, make the player a universal priority, reduce kindness/empathy toward others, or need to surface in every scene.
Trust: confidence, safety, reliance, and willingness to expose vulnerability. Trust can permit candor or reliance when context calls for it; it is not obedience.
Affection: emotional importance, fondness, attachment, and care. Affection may bias attention, patience, interpretation, or willingness to accept some inconvenience through the NPC's established care style. It is not devotion, clinginess, jealousy, softness, or self-erasure.
Desire: attraction or pull toward romantic/intimate/physical closeness when established. Desire does not prescribe flirting, blushing, stammering, possessiveness, sexual behavior, or constant romantic attention; expression passes through personality, expressiveness, consent, and context.
Tension: unresolved interpersonal pressure. It may be conflict, awkwardness, fear, rivalry, uncertainty, resentment, or charged restraint only when context supports that form. Never infer jealousy, embarrassment, hostility, or tsundere-style denial from tension alone.
Strong feelings should usually alter small choices, interpretation, openness, attention, or willingness before altering voice or overt behavior. A duty-bound, reserved, kind, blunt, proud, or independent NPC remains recognizably so at every relationship score. Runtime narration receives only a compact qualitative relationship lens; raw meter numbers are bookkeeping, not characterization instructions.`;

function stripRollingRelationshipFields(raw, { explicitZero = false } = {}) {
    if (!raw || typeof raw !== 'object') return raw;
    delete raw.relationship;
    delete raw.relationship_delta;
    delete raw.relationshipDelta;
    delete raw.relationshipImpact;
    delete raw.relationship_impact;
    delete raw.relationshipChangeReason;
    delete raw.relationship_change_reason;
    delete raw.relationshipEvidence;
    delete raw.relationship_evidence;
    if (explicitZero) {
        raw.relationshipImpact = 'none';
        raw.relationshipDelta = { trust: 0, affection: 0, desire: 0, tension: 0 };
        raw.relationshipEvidence = { trust: '', affection: '', desire: '', tension: '' };
        raw.relationshipChangeReason = '';
    }
    return raw;
}

export function prepareFullWindowRelationshipPayload(parsed, existingNpcs = []) {
    void existingNpcs; // retained API parameter for compatibility; every rolling row is scrubbed.
    const evaluation = structuredClone(parsed || { npcs: [] });
    const mergeSafe = structuredClone(parsed || { npcs: [] });
    const count = Math.max(evaluation.npcs?.length || 0, mergeSafe.npcs?.length || 0);
    for (let i = 0; i < count; i += 1) {
        const evalRaw = evaluation.npcs?.[i];
        const safeRaw = mergeSafe.npcs?.[i];
        if (evalRaw) stripRollingRelationshipFields(evalRaw, { explicitZero: false });
        if (safeRaw) stripRollingRelationshipFields(safeRaw, { explicitZero: true });
    }
    return { evaluation, mergeSafe };
}

// The persona's and the character's names as the prompts write them: on one line and at most
// PROMPT_NAME_MAX characters (code points, so a pair is never split), as Story Block writes
// {{user}} and {{char}}. A name with no line break, control character or excess length comes back
// exactly as given, so ordinary prompts are byte-identical; a name that flattens to nothing gives
// `fallback`. Anything but a string is returned as it is (the builders' defaults then apply).
export const PROMPT_NAME_MAX = 80;
export function flatPromptName(value, fallback = '') {
    if (typeof value !== 'string') return value;
    let name = value;
    if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(name)) name = name.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').replace(/ {2,}/g, ' ').trim();
    const points = Array.from(name);
    if (points.length > PROMPT_NAME_MAX) name = `${points.slice(0, PROMPT_NAME_MAX - 1).join('').trimEnd()}…`;
    return name || fallback;
}

function compactScannerWhitespace(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function compactRelationshipRubric(value) {
    const configured = compactScannerWhitespace(value);
    const stock = compactScannerWhitespace(DEFAULT_RELATIONSHIP_CRITERIA);
    if (!configured || configured === stock) {
        return 'Axes independent; 0 neutral; unsupported axes stay 0. Trust=reliance/safety, Affection=care, Desire=established attraction, Tension=pressure. Routine continuation is no change.';
    }
    return configured;
}

export function compactImpactRubric(value) {
    const configured = compactScannerWhitespace(value);
    const stock = compactScannerWhitespace(DEFAULT_IMPACT_CRITERIA);
    if (!configured || configured === stock) {
        return 'none=no new evidence/continuation; ordinary=new modest beat; meaningful=clear new event; major=lasting turning point; extreme=rare defining event.';
    }
    return configured;
}

export function compactMemoryRubric(value) {
    const configured = compactScannerWhitespace(value);
    const stock = compactScannerWhitespace(DEFAULT_MEMORY_CRITERIA);
    if (!configured || configured === stock) {
        return 'Store durable story-relevant events affecting later decisions/relationships/goals/obligations/fears/knowledge. Favor promises, betrayals, rescues, confessions, major discoveries/conflicts/losses/commitments. Reject routine dialogue/transactions, transient/repeated facts/raw Inner Chatter/trivia/duplicates.';
    }
    return configured;
}
