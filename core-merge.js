/* NPC State Delta scan merge: applyScenePresence and mergeScanResult, with the alias-duplicate and
   NPC name-in-text parts split into core-merge-aliases.js and core-merge-names.js. A pure part of
   core-mechanics.js (same owner, moved without change); core-mechanics.js re-exports every name it
   exported before. Never imports core-mechanics.js or core.js. */
import { cleanText, normalizeName } from './core-text.js';
import { DEFAULT_RELATIONSHIP, DEFAULT_RELATIONSHIP_CAPS, normalizeRelationshipBaseline, normalizeRelationshipCaps } from './core-relationship.js';
import { findInterimIdentityPromotionIndex, inferNpcIdentityKind, isDescriptivePhrase, normalizeGender } from './core-identity.js';
import { applySheetLevels, withoutSheetLevels, candidateMatches, createNpcRecord, IMPORTANT_MEMORY_LIMIT, makeNpcCandidate, mergeLists, normalizeCustomFieldNames, normalizeNpcAdmissionMode, normalizeNpcCandidate, normalizeNpcRecord, normalizeScanNpc, NPC_CANDIDATE_LIMIT, NPC_CANDIDATE_TTL_TURNS, scanLabelsMatch, shouldCreateDossierImmediately, shouldPromoteCandidate } from './core-record.js';
import { applyKeyRelationshipEdges, recordTieMentions, tieRoster } from './core-keyrel.js';
import { canonicalizeNpcKeyRelationships, reconcileSocialState } from './social.js';
import { isTerminalNpcDeath } from './terminal-lifecycle.js';
import { applyIncoming } from './core-merge-incoming.js';
import { applyDurableProfileUpdates } from './core-development.js';
import { consolidateAliasLinkedNpcDuplicates } from './core-merge-aliases.js';
import { npcNamedInText } from './core-merge-names.js';
import { withSettledGuess } from './appearance-physical.js';

export { npcNamedInText, countNormalizedPhrase } from './core-merge-names.js';

/**
 * (1.2.10) Presence put right by the reply's World State (`scene`: present names, `none`, and
 * off-screen names; see present-scene.js worldStatePeople). Listed as present: present. Listed
 * off-screen, or the scene says nobody is present: not present. Anyone else keeps what the scan
 * said, since a World State often leaves people out. Nobody dead or archived is made present.
 * Changes `npcs` in place; returns { cleared: [ids], added: [ids] }.
 */
export function applyScenePresence(npcs, scene) {
    const list = Array.isArray(npcs) ? npcs : [];
    const cleared = [];
    const added = [];
    const names = value => (Array.isArray(value) ? value : []).map(String).filter(Boolean);
    const present = names(scene?.present);
    const offscreen = names(scene?.offscreen);
    const named = (npc, labels) => {
        const own = [npc.name, ...(npc.aliases || [])].map(normalizeName).filter(Boolean);
        return labels.some(label => own.includes(normalizeName(label))) || labels.some(label => npcNamedInText(npc, label, list));
    };
    for (const npc of list) {
        if (!npc) continue;
        let next = npc.present;
        if (present.length && named(npc, present)) next = true;
        else if (scene?.none === true || (offscreen.length && named(npc, offscreen))) next = false;
        if (next && (npc.archived || isTerminalNpcDeath(npc))) next = false;
        if (npc.present && !next) cleared.push(npc.id);
        if (!npc.present && next) added.push(npc.id);
        npc.present = Boolean(next);
        if (npc.present) npc.worldActive = false;
    }
    return { cleared, added };
}

export function mergeScanResult(state, scanResult, options = {}) {
    scanResult = withoutSheetLevels(scanResult, state?.npcs, options.partyLevels);   // (hosted) the sheet, not the scanner, sets an active member's Level
    const maxNpcs = Math.max(1, Math.min(100, Number(options.maxNpcs) || 40));
    const excludeNames = new Set((options.excludeNames || []).map(normalizeName).filter(Boolean));
    const turn = Number(options.turn ?? state.turn ?? 0);
    const relationshipCaps = normalizeRelationshipCaps(options.relationshipCaps || DEFAULT_RELATIONSHIP_CAPS);
    const relationshipBaseline = normalizeRelationshipBaseline(options.relationshipBaseline || DEFAULT_RELATIONSHIP);
    const admissionMode = normalizeNpcAdmissionMode(options.admissionMode);
    const preservePresence = Boolean(options.preservePresence);
    const preserveWorldActive = preservePresence || Boolean(options.preserveWorldActive);
    const sourceMessageId = Number.isInteger(options.sourceMessageId) ? options.sourceMessageId : null;
    const memoryInputLimit = Math.max(1, Math.min(IMPORTANT_MEMORY_LIMIT, Math.round(Number(options.memoryInputLimit) || 3)));
    const lifecycleOptions = {
        autoArchiveDeaths: options.autoArchiveDeaths !== false,
        autoReactivateArchived: options.autoReactivateArchived !== false,
        skipRelationshipUpdate: Boolean(options.skipRelationshipUpdate),
        developmentContext: String(options.developmentContext || ''),
        allowTargetedDurableSeed: options.allowTargetedDurableSeed === true,
        memoryInputLimit,
        customFieldNames: normalizeCustomFieldNames(options.customFieldNames),
    };
    if (Object.prototype.hasOwnProperty.call(options, 'userDevelopmentContext')) {
        lifecycleOptions.userDevelopmentContext = String(options.userDevelopmentContext || '');
    }
    // `storyTexts` (optional): the story's own texts, never the card greeting; omitted = no check.
    const storyTexts = Array.isArray(options.storyTexts) ? options.storyTexts.map(text => String(text || '')).filter(Boolean) : null;
    const incomingList = Array.isArray(scanResult?.npcs) ? scanResult.npcs : [];
    const normalizedCandidates = (Array.isArray(state?.candidates) ? state.candidates : [])
        .map(normalizeNpcCandidate)
        .filter(Boolean);
    const expiredCandidates = normalizedCandidates.filter(candidate => turn - Number(candidate.lastSeenTurn || 0) > NPC_CANDIDATE_TTL_TURNS);
    const presentBeforeScan = new Set((Array.isArray(state?.npcs) ? state.npcs : []).filter(n => n?.present).map(n => n.id));
    const next = {
        ...state,
        npcs: Array.isArray(state?.npcs) ? state.npcs.map(n => ({
            ...n,
            present: preservePresence ? Boolean(n.present) : false,
            worldActive: preserveWorldActive ? Boolean(n.worldActive) : false,
        })) : [],
        candidates: normalizedCandidates.filter(candidate => turn - Number(candidate.lastSeenTurn || 0) <= NPC_CANDIDATE_TTL_TURNS),
        socialGraph: state?.socialGraph && typeof state.socialGraph === 'object' ? structuredClone(state.socialGraph) : { version: 1, edges: [], unresolved: [] },
    };
    const report = { created: [], updated: [], profileUpdated: [], renamed: [], deduplicated: [], candidates: [], promoted: [], expired: expiredCandidates.map(c => c.name), skipped: [], profileUpdateStats: { provided: 0, applied: 0, evidenceAdded: 0 } };

    const createFromIncoming = incoming => {
        if (next.npcs.filter(npc => !npc?.archived).length >= maxNpcs) {
            report.skipped.push(incoming.name);
            return null;
        }
        const ids = next.npcs.map(n => n.id);
        const record = createNpcRecord(incoming.name, ids, relationshipBaseline);
        const merged = applyIncoming(record, incoming, turn, relationshipCaps, sourceMessageId, lifecycleOptions);
        next.npcs.push(merged);
        report.created.push(merged.id);
        return merged;
    };

    for (const raw of incomingList) {
        const incoming = normalizeScanNpc(raw, { memoryInputLimit });
        let existingIndex = incoming.id ? next.npcs.findIndex(existing => existing.id === incoming.id) : -1;
        if (existingIndex >= 0 && !incoming.name) incoming.name = next.npcs[existingIndex].name;
        const key = normalizeName(incoming.name);
        if (!key || excludeNames.has(key)) {
            report.skipped.push(incoming.name || incoming.id || '(unnamed)');
            continue;
        }

        if (existingIndex < 0) existingIndex = next.npcs.findIndex(existing => candidateMatches(existing, incoming, presentBeforeScan));
        if (existingIndex < 0) existingIndex = findInterimIdentityPromotionIndex(next.npcs, incoming);
        if (existingIndex >= 0) {
            const previousName = next.npcs[existingIndex].name;
            const presentationOtherLabels = next.npcs
                .filter((npc, index) => index !== existingIndex && npc)
                .flatMap(npc => [npc.name, ...(Array.isArray(npc.aliases) ? npc.aliases : [])])
                .filter(Boolean);
            next.npcs[existingIndex] = withSettledGuess(next.npcs[existingIndex], applyIncoming(next.npcs[existingIndex], incoming, turn, relationshipCaps, sourceMessageId, { ...lifecycleOptions, presentationOtherLabels }));
            report.updated.push(next.npcs[existingIndex].id);
            if (normalizeName(previousName) !== normalizeName(next.npcs[existingIndex].name)) {
                report.renamed.push({ id: next.npcs[existingIndex].id, from: previousName, to: next.npcs[existingIndex].name });
            }
            next.candidates = next.candidates.filter(candidate => !scanLabelsMatch(candidate, incoming));
            continue;
        }

        // A description read as a proper name is not a person ("leader in the gambeson", live run 3): never admitted, as a dossier or a
        // candidate. A real name and a role label, with or without a linking word ("the captain of the guard", "woman in red"), go on to the
        // candidate and promotion path as before; people already in the registry were matched above.
        if (inferNpcIdentityKind(incoming.name, incoming.identityKind) === 'proper_name' && isDescriptivePhrase(incoming.name)) {
            report.skipped.push(incoming.name);
            continue;
        }

        // A person new to the registry must appear in the story (a reply or the player's text). A name found only in the
        // character card's greeting (its World State roster) is background, never admitted. Existing dossiers are untouched.
        if (storyTexts && inferNpcIdentityKind(incoming.name, incoming.identityKind) === 'proper_name'
            && !storyTexts.some(text => npcNamedInText({ name: incoming.name, aliases: incoming.aliases || [] }, text))) {
            report.skipped.push(incoming.name);
            continue;
        }

        let candidateIndex = next.candidates.findIndex(candidate => scanLabelsMatch(candidate, incoming));
        if (candidateIndex < 0) candidateIndex = findInterimIdentityPromotionIndex(next.candidates, incoming);
        if (shouldCreateDossierImmediately(incoming, admissionMode)) {
            if (candidateIndex >= 0) {
                const priorCandidate = next.candidates[candidateIndex];
                if (!incoming.gender && priorCandidate?.gender) incoming.gender = priorCandidate.gender;
                if (incoming.sameIndividual && inferNpcIdentityKind(incoming.name, incoming.identityKind) === 'proper_name'
                    && normalizeName(priorCandidate?.name) !== normalizeName(incoming.name)) {
                    incoming.aliases = mergeLists([priorCandidate.name, ...(priorCandidate.aliases || [])], incoming.aliases, 8)
                        .filter(alias => normalizeName(alias) !== normalizeName(incoming.name));
                }
                next.candidates.splice(candidateIndex, 1);
            }
            const created = createFromIncoming(incoming);
            if (created && candidateIndex >= 0) report.promoted.push(created.id);
            continue;
        }

        if (candidateIndex >= 0) {
            const candidate = next.candidates[candidateIndex];
            if (incoming.sameIndividual) {
                candidate.aliases = mergeLists(candidate.aliases, incoming.aliases, 6);
                candidate.identityKind = incoming.identityKind || candidate.identityKind;
                candidate.dossierSignal = incoming.dossierSignal || candidate.dossierSignal;
                candidate.dossierReason = incoming.dossierReason || candidate.dossierReason;
                candidate.role = cleanText(incoming.role || candidate.role, 180);
                candidate.gender = normalizeGender(incoming.gender || candidate.gender);
                candidate.location = cleanText(incoming.location || candidate.location, 220);
                candidate.seenCount = Math.min(99, Number(candidate.seenCount || 1) + 1);
                candidate.lastSeenTurn = turn;
                        if (shouldPromoteCandidate(candidate, incoming, admissionMode)) {
                    if (!incoming.gender && candidate.gender) incoming.gender = candidate.gender;
                    next.candidates.splice(candidateIndex, 1);
                    const created = createFromIncoming(incoming);
                    if (created) report.promoted.push(created.id);
                    continue;
                }
            }
            report.candidates.push(candidate.id);
            continue;
        }

        if (next.candidates.length >= NPC_CANDIDATE_LIMIT) {
            report.skipped.push(incoming.name);
            continue;
        }
        const candidate = makeNpcCandidate(incoming, turn, next.candidates.map(c => c.id));
        next.candidates.push(candidate);
        report.candidates.push(candidate.id);
    }

    // Durable-profile decisions are independent of ordinary NPC delta admission. This lets
    // Personality/Speech/Appearance/Mannerisms accumulate evidence and refine even when the
    // scanner had no live-state delta worth returning for that NPC.
    const profileUpdateOptions = {
        developmentContext: options.developmentContext || '',
        memoryInputLimit,
        sourceMessageId,
        targeted: options.allowTargetedDurableSeed === true || options.developmentSingleTarget === true,
        customFieldNames: options.customFieldNames,
    };
    if (Object.prototype.hasOwnProperty.call(options, 'userDevelopmentContext')) {
        profileUpdateOptions.userDevelopmentContext = String(options.userDevelopmentContext || '');
    }
    report.profileUpdateStats = applyDurableProfileUpdates(next, scanResult, excludeNames, report, profileUpdateOptions);

    // Social edges are independent of NPC delta admission. This lets an explicit relationship
    // reveal update a stored dossier even when the scanner returned no ordinary NPC object.
    applyKeyRelationshipEdges(next, scanResult, excludeNames, report);

    // Canonical identity promotion is global: once an interim label becomes a proper name,
    // structured references in neighboring dossiers and the hidden social graph must follow
    // the stable NPC id rather than fossilizing both labels as separate people.
    consolidateAliasLinkedNpcDuplicates(next, report);
    for (const id of canonicalizeNpcKeyRelationships(next.npcs)) if (!report.updated.includes(id)) report.updated.push(id);
    const social = reconcileSocialState(next, {
        scanResult,
        transcript: options.developmentContext || '',
        provenance: 'scanner',
        confidence: 'explicit',
        sourceMessageId,
        turn,
    });
    next.socialGraph = social.socialGraph;
    next.npcs = social.state.npcs;
    for (const id of social.updatedIds || []) if (!report.updated.includes(id)) report.updated.push(id);

    // (1.2.10) The reply's World State says who is in the scene as it ends and who is off-screen:
    // a model that names someone met earlier in the reply ("Brecht lay in the mud" before the walk
    // to the Guild) no longer keeps them on the Present cards once the scene lists them off-screen.
    if (options.scenePresent && typeof options.scenePresent === 'object' && !preservePresence) {
        report.scenePresence = applyScenePresence(next.npcs, options.scenePresent);
    }

    // (hosted) An active party member's Level is the sheet's, whatever the scanner stated for them in this scan.
    report.sheetLevels = applySheetLevels(next.npcs, options.partyLevels, options.customFieldNames);
    for (const { id } of report.sheetLevels) if (!report.updated.includes(id)) report.updated.push(id);

    // Final canonicalization is a hard guard against append-only drift from either
    // normal NPC deltas or the independent profile/social channels.
    const before = new Map((Array.isArray(state?.npcs) ? state.npcs : []).map(npc => [npc.id, npc]));
    const tieNames = tieRoster(next.npcs);
    next.npcs = next.npcs.map(npc => {
        const current = { ...npc };
        // Ties' last mention (story day of the reply, reply prose, and ties this scan added or changed), so replay and swipes restore it with the NPC.
        const prior = before.get(current.id)?.keyRelationships || [];
        const seen = recordTieMentions(current, { day: Number.isInteger(options.tieDay) ? options.tieDay : (Number.isInteger(options.storyDay) ? options.storyDay : null), roster: tieNames, text: options.calendarSource,
            named: (current.keyRelationships || []).filter(entry => !prior.includes(entry)) });
        if (seen) current.tieSeen = seen;
        return normalizeNpcRecord(current);
    });

    next.npcs.sort((a, b) => Number(b.lastSeenTurn || 0) - Number(a.lastSeenTurn || 0));
    next.candidates.sort((a, b) => Number(b.lastSeenTurn || 0) - Number(a.lastSeenTurn || 0));
    return { state: next, report };
}
