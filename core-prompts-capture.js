/* NPC State Delta one-pass capture rules and hidden-note prompt fragments. Split from core-prompts.js without change;
   core-prompts.js re-exports every name it exported before. */
import { BEHAVIOR_LEVER_LABELS, PROMPT_CAPS } from './core-prompts-targeted.js';
export const NARRATION_CAPTURE_HEADER = `NPC STATE DELTA ONE-PASS CAPTURE. Write your complete in-character reply first, exactly as you otherwise would; nothing below changes the story, its length or its voice. Then end the message, after all story text, with one hidden block:
<!--npc_state_delta
{"npcs":[...],"profileUpdates":[...],"keyRelationshipEdges":[...]}
-->
Never mention the block in the story. Fill its JSON as this private NPC dossier scanner would for the user's latest message and your reply:`;
export const NARRATION_CAPTURE_STORY = 'Story context: the chat above. CURRENT exchange = the user\'s latest message plus the reply you are writing now; use only it for presence, live state and relationship deltas.';
// (1.2.11) The slow fields named at the end, where the model looks last: they fill only from
// evidence gathered over scenes, and a block written beside the story tended to leave them out.
export const NARRATION_CAPTURE_REMINDER = 'Reminder: after the story, end with the <!--npc_state_delta {valid JSON} --> block. Before closing it, check each NPC who acted in your reply for the slow fields, which build up over scenes: a habit or tic (profileUpdates mannerisms + evidence.mannerisms), how they decide or treat people (behaviorProfile "Label: level - effect" + evidence.behaviorProfile), a consequential event (memories: only the new one, in its npcs[] entry). Write the evidence whenever the reply shows one, even if the field itself must wait.'
    // (1.2.12) Relationships settled in the block, so no evaluator request is needed: a full row for
    // each existing NPC the reply names, and the model's own word on whether that covers everyone.
    + ' Relationships: give each existing NPC your story names an npcs row with relationshipImpact and all four relationshipDelta keys (0 = no change). Add top-level "relationshipsCovered": true when those rows hold everyone whose feelings toward the user could have changed in this reply, and list anyone you are unsure of in "relationshipReview": ["Name"].';

// (1.2.17) The one-pass rules in fewer words, for readers who opt in: every field, state keyword,
// gate and cap of rules 1-15 kept; the explanations shortened. No wording here is shared with the
// scanner's own prompt, which is unchanged. (cleanup step 12, I-11) The gates the first version
// dropped are back, written out here rather than patched in afterwards; (b5b r2-8) the rules name
// roles, not people, so they stay the same whoever speaks next (the names are in the context part).
export function compactCaptureRules(caps) {
    return `Rules (CURRENT exchange = the user's latest message + your reply; never invent):
1. Skip the player, the character you play and nameless extras. Match existing NPCs by id/name/alias/role and reuse the id; a role-labelled dossier that gets a grounded proper name keeps its id (old label into aliases, identityKind:"proper_name"); never duplicate or downgrade.
2. Return only NPCs observed or meaningfully changed in the exchange, as deltas: changed fields only; omitted fields persist.
3. NEW people: name, identityKind, dossierSignal, dossierReason, sameIndividual (true only when proven), directInteraction, present, worldActive, plus every grounded field. Candidates are not dossiers. Proper names from narration, World State or Inner Chatter must be returned even when the prose uses a role; Inner Chatter gives durable facts only, not monologue.
4. present = physically in the latest scene; worldActive = explicit current off-screen activity; World State or Inner Chatter alone never sets presence. Live goal/status/mood/location (+goalState/statusState/moodState/locationState): reassess each returned NPC; replace when changed, "clear" only when ended (location only when the old place is explicitly obsolete); never "Unknown".
5. profileUpdates {id, evidence:{field:[short quotes]}, …} for every grounded durable fact (several fields per scene allowed): personality/speech/mannerisms (FULL, max 4)/behaviorProfile (FULL, max 6 "Label: level - effect", Label=${BEHAVIOR_LEVER_LABELS}; habits go to mannerisms) with *State "refine" (correction/reveal) or "evolve"+reason; appearance = CURRENT outfit/gear/condition, overallAppearance = enduring body when no named forms; a grounded visual on an existing NPC MUST emit it + evidence.appearance; appearanceState "refine" or "change"+reason, FULL; speech evidence = voice style. Locked fields never change.
6. Mood, stress, intimacy, injury or relationship-specific behaviour never becomes global personality/speech/mannerisms/behaviorProfile; a fleeting pose is not identity; kindness stays general; necessary force != cruelty. developmentScale: gradual (your narration) | explicit/batch (the player's declarative canon, not quotes/questions/wishes; or a time skip) with developmentReason + the FULL changed candidate; a time skip alone invents nothing.
7. Bonds between non-player NPCs (kin/friend/rival/mentor/partner): top-level keyRelationshipEdges {aId,a,bId,b,aToB=b's role to a,bToA,reason}, one per pair; late/surviving, never dangling "(deceased)"; omission never erases a bond.
8. age = chronology only (birthday/exact elapsed => ageState:"advance"+reason; correction => "correct"+reason); apparentAge = visual cue "~N" (cue => MUST return it when age unknown; apparentAgeState:"evolve"+reason); species literal, no species-aging inference; gender male|female only if explicit (genderState:"correct"+reason); lifeState unknown|alive|deceased (explicit death: STAGE 4 below).
9. Relationship toward the player, from the CURRENT exchange only; currentRelationship is read-only: relationshipImpact none|ordinary|meaningful|major|extreme; relationshipDelta {trust,affection,desire,tension} (all 4 keys) within the delta caps (raw max ${caps.ordinary}/${caps.meaningful}/${caps.major}/${caps.extreme}), each axis max 1/2/3/4 by impact; relationshipEvidence for every non-zero axis; continuation/aftermath = 0; desire only for explicit attraction/intimacy; trust != obedience, affection != devotion, tension != jealousy.
10. memories, in npcs[] for existing NPCs too: only NEW events from this exchange (max 3), added to the stored (cap 5); never resend or paraphrase those (memoryRetention = top 5 when crowded); homeBase = durable home/workplace/haunt, never the scene location; keep unless homeBaseState:"update"+homeBaseReason. Compact text, caps: ${PROMPT_CAPS}.
11. JSON only: {"npcs":[...],"profileUpdates":[...],"keyRelationshipEdges":[...]}. Example: {"id":"npc_myla","evidence":{"speech":["formal"]},"speechState":"refine","speech":"Soft, formal."}.`;
}

const LAYERED_SECRETS_RULE = 'HIDDEN NOTES: for each NEW dossier-worthy NPC only (never an existing one), also return "secrets" in its npcs[] row: 2 to 5 layered hidden notes, light to deep, as many as the person is deep (a passing shopkeeper 2, someone central 4-5). Ground them in the established background; never contradict it or invent a rival backstory. Each {"title":"<=60 chars","text":"<=300 chars, one fact the player does not know yet","meter":"trust|affection|desire|tension","at":whole number 1..100, higher for deeper layers} or, for a layer that opens on a story event instead, {"title","text","when":"short event <=120 chars"}. Written once; never repeat or rewrite them later.';
// A targeted pass (backfill) is about one NEW dossier: the same notes, asked for that person.
const LAYERED_SECRETS_RULE_TARGET = LAYERED_SECRETS_RULE.replace('for each NEW dossier-worthy NPC only (never an existing one), also return "secrets" in its npcs[] row', 'this dossier is NEW: also return "secrets" in the npcs[] row of the target');
const watchItems = eventWatch => (Array.isArray(eventWatch) ? eventWatch : []).filter(item => item && item.key && item.event);
// `window`: the story given is a window of recent replies (a targeted pass), not only the current exchange.
function eventWatchRule(eventWatch, { window = false } = {}) {
    const watch = watchItems(eventWatch);
    if (!watch.length) return '';
    const where = window ? 'the supplied story shows happened' : 'the CURRENT exchange clearly shows happened (never from earlier history, never a guess)';
    return `STORY EVENTS to look for (present NPCs' hidden notes): ${watch.map(item => `${item.key} = ${item.name}: ${item.event}`).join(' | ')}. Return top-level "secretEvents":["<key>",...] with ONLY the keys whose event ${window ? where + ' (clearly, never a guess)' : where}; [] or omit when none.`;
}

/**
 * The scanner prompt's rules about hidden notes ('' when neither is asked), numbered from `start` after the last rule.
 * `layeredSecrets`: also write 2 to 5 layered notes for each NEW dossier-worthy NPC. `eventWatch`: [{ key, name, event }], the
 * story events of present NPCs' locked notes; the scan answers `secretEvents` with the keys of those the CURRENT exchange
 * clearly shows. `events: false` leaves the watch out (a one-pass capture carries it in its context part, where the list that
 * changes from reply to reply belongs: hiddenNoteEventParagraph).
 */
export function hiddenNotePromptRules({ layeredSecrets = false, eventWatch = null, start = 16, events = true } = {}) {
    const lines = [];
    if (layeredSecrets) lines.push(LAYERED_SECRETS_RULE);
    if (events) {
        const rule = eventWatchRule(eventWatch);
        if (rule) lines.push(rule);
    }
    return lines.length ? lines.map((line, index) => `\n${start + index}. ${line}`).join('') : '';
}

/** The story events to look for, as a paragraph of its own ('' with none): the dynamic part of a one-pass capture. */
export function hiddenNoteEventParagraph(eventWatch) {
    const rule = eventWatchRule(eventWatch);
    return rule ? `\n\n${rule}` : '';
}

/**
 * A targeted prompt (backfill, Refresh) with the hidden notes it was asked for, as paragraphs at its end. `layeredSecrets`
 * (a backfill of a NEW dossier only) and `eventWatch` (this one person's locked event notes) are the only options; given
 * neither, the prompt is returned as it is.
 */
export function appendHiddenNotePrompt(prompt, { layeredSecrets = false, eventWatch = null } = {}) {
    const parts = [];
    if (layeredSecrets) parts.push(LAYERED_SECRETS_RULE_TARGET);
    const rule = eventWatchRule(eventWatch, { window: true });
    if (rule) parts.push(rule);
    return parts.length ? `${prompt}\n\n${parts.join('\n\n')}` : prompt;
}
