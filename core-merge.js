/* NPC State Delta scan merge: alias-linked duplicate consolidation, applyScenePresence and mergeScanResult, with the NPC
   name-in-text matcher they read. A pure part of core-mechanics.js (same owner, moved without change); core-mechanics.js
   re-exports every name it exported before. Never imports core-mechanics.js or core.js. */
import { cleanText, normalizeName } from './core-text.js';
import { DEFAULT_RELATIONSHIP, DEFAULT_RELATIONSHIP_CAPS, DEFAULT_RELATIONSHIP_PROGRESS, normalizeRelationshipBaseline, normalizeRelationshipCaps, RELATIONSHIP_KEYS } from './core-relationship.js';
import { findInterimIdentityPromotionIndex, inferNpcIdentityKind, isInterimNpcLabel, isRoleDescriptionLabel, normalizeGender } from './core-identity.js';
import { candidateMatches, createNpcRecord, IMPORTANT_MEMORY_LIMIT, makeNpcCandidate, mergeLists, normalizeCustomFieldNames, normalizeCustomFields, normalizeNpcAdmissionMode, normalizeNpcCandidate, normalizeNpcRecord, normalizePortraitSeed, normalizeScanNpc, normalizeStoredMemories, NPC_CANDIDATE_LIMIT, NPC_CANDIDATE_TTL_TURNS, scanLabelsMatch, shouldCreateDossierImmediately, shouldPromoteCandidate } from './core-record.js';
import { ALIAS_MERGE_TEXT_FIELDS } from './src/fields/registry.js';
import { normalizeMannerisms } from './core-durable.js';
import { normalizeBehaviorProfile } from './core-behavior.js';
import { applyKeyRelationshipEdges, mergeKeyRelationshipUpdates } from './core-keyrel.js';
import { normalizeProfileEvidence } from './core-evidence.js';
import { portraitHasImage } from './src/portrait-file.js';
import { PORTRAIT_NPC_PROMPT_LIMIT } from './core-portrait.js';
import { canonicalizeNpcKeyRelationships, reconcileSocialState, remapSocialGraphNpcId } from './social.js';
import { isTerminalNpcDeath } from './terminal-lifecycle.js';
import { applyIncoming } from './core-merge-incoming.js';
import { applyDurableProfileUpdates } from './core-development.js';

function explicitAliasLink(a, b) {
    if (!a || !b || a.id === b.id) return false;
    const aName = normalizeName(a.name);
    const bName = normalizeName(b.name);
    if (!aName || !bName) return false;
    const aAliases = new Set((a.aliases || []).map(normalizeName).filter(Boolean));
    const bAliases = new Set((b.aliases || []).map(normalizeName).filter(Boolean));
    return aAliases.has(bName) || bAliases.has(aName);
}

function duplicateRelationshipWeight(npc) {
    const rel = normalizeRelationshipBaseline(npc?.relationship || DEFAULT_RELATIONSHIP);
    return (npc?.relationshipEventHistory?.length || 0) * 20
        + RELATIONSHIP_KEYS.reduce((sum, key) => sum + Math.abs(Number(rel[key] || 0)), 0)
        + Number(npc?.seenCount || 0);
}

function chooseDuplicateCanonicalName(a, b) {
    const aName = normalizeName(a?.name);
    const bName = normalizeName(b?.name);
    const aClaimsB = (a?.aliases || []).some(alias => normalizeName(alias) === bName);
    const bClaimsA = (b?.aliases || []).some(alias => normalizeName(alias) === aName);
    // A record that explicitly carries the other record's label as its alias is the
    // strongest deterministic signal that its own name is the later canonical identity.
    if (aClaimsB !== bClaimsA) return aClaimsB ? a.name : b.name;
    const aInterim = isInterimNpcLabel(a?.name, a?.identityKind);
    const bInterim = isInterimNpcLabel(b?.name, b?.identityKind);
    if (aInterim !== bInterim) return aInterim ? b.name : a.name;
    const aUpdated = Number(a?.updatedAt || 0);
    const bUpdated = Number(b?.updatedAt || 0);
    return bUpdated > aUpdated ? b.name : a.name;
}

// (cleanup step 7) The live fields an alias merge takes from the most recently updated record.
const ALIAS_MERGE_LIVE_FIELDS = Object.freeze(['mood', 'location', 'goal', 'status']);

// Two custom-field maps as one, case-insensitive by name, `newer` winning.
function mergeCustomFieldMaps(older, newer) {
    const out = normalizeCustomFields(older);
    for (const [name, value] of Object.entries(normalizeCustomFields(newer))) {
        const existing = Object.keys(out).find(key => key.toLowerCase() === name.toLowerCase());
        if (existing && existing !== name) delete out[existing];
        out[name] = value;
    }
    return out;
}

function mergeAliasLinkedNpcPair(a, b) {
    const canonicalName = cleanText(chooseDuplicateCanonicalName(a, b), 120) || a.name || b.name;
    const canonicalRecord = normalizeName(a?.name) === normalizeName(canonicalName) ? a
        : (normalizeName(b?.name) === normalizeName(canonicalName) ? b : null);
    const fallbackRecord = canonicalRecord === a ? b : a;
    const older = Number(a?.createdAt || Infinity) <= Number(b?.createdAt || Infinity) ? a : b;
    const newer = older === a ? b : a;
    const relationshipSource = duplicateRelationshipWeight(a) >= duplicateRelationshipWeight(b) ? a : b;
    const aLocks = new Set(Array.isArray(a?.manualProfileFields) ? a.manualProfileFields : []);
    const bLocks = new Set(Array.isArray(b?.manualProfileFields) ? b.manualProfileFields : []);
    const lockedSourceFor = field => {
        const aLocked = aLocks.has(field);
        const bLocked = bLocks.has(field);
        if (aLocked && bLocked) return older;
        if (aLocked) return a;
        if (bLocked) return b;
        return null;
    };
    const lockedNameSource = lockedSourceFor('name');
    const merged = structuredClone(older);
    merged.name = lockedNameSource ? (cleanText(lockedNameSource.name, 120) || canonicalName) : canonicalName;
    merged.identityKind = inferNpcIdentityKind(merged.name, lockedNameSource?.identityKind || 'proper_name');
    // Dedupe must not erase stable identity learned on the proper-name record. Prefer
    // the record whose label became canonical, then preserve a grounded value from its duplicate.
    const lockedGenderSource = lockedSourceFor('gender');
    const lockedHomeBaseSource = lockedSourceFor('homeBase');
    merged.gender = lockedGenderSource
        ? normalizeGender(lockedGenderSource.gender)
        : (normalizeGender(canonicalRecord?.gender) || normalizeGender(fallbackRecord?.gender));
    merged.homeBase = lockedHomeBaseSource
        ? cleanText(lockedHomeBaseSource.homeBase, 300)
        : (cleanText(canonicalRecord?.homeBase, 300) || cleanText(fallbackRecord?.homeBase, 300));
    const lockedAppearanceSource = lockedSourceFor('appearance');
    if (lockedAppearanceSource) {
        for (const key of ['appearance', 'overallAppearance', 'unclassifiedAppearance', 'appearanceForms', 'currentForm', 'currentFormUnknown', 'appearanceModelVersion']) {
            if (Object.prototype.hasOwnProperty.call(lockedAppearanceSource, key)) merged[key] = structuredClone(lockedAppearanceSource[key]);
            else delete merged[key];
        }
    }
    // (cleanup step 7) Hand-locked aliases take nothing from the duplicate but its name, which must
    // stay a label of the merged dossier so later mentions still find it.
    const lockedAliasSource = lockedSourceFor('aliases');
    const absorbed = lockedAliasSource === a ? b : a;
    merged.aliases = (lockedAliasSource
        ? mergeLists([...(lockedAliasSource.aliases || []), absorbed.name], [], 8)
        : mergeLists([a.name, ...(a.aliases || []), b.name, ...(b.aliases || [])], [], 8))
        .filter(alias => normalizeName(alias) !== normalizeName(merged.name));
    // The live state is the most recently updated record's; the durable texts keep the fuller one.
    const liveSource = Number(a?.updatedAt || 0) >= Number(b?.updatedAt || 0) ? a : b;
    const liveOther = liveSource === a ? b : a;
    for (const field of ALIAS_MERGE_TEXT_FIELDS) {
        if (field === 'appearance' && lockedAppearanceSource) continue;
        const lockedSource = lockedSourceFor(field);
        if (lockedSource) {
            merged[field] = cleanText(lockedSource?.[field], field === 'appearance' ? 1800 : 1200);
            continue;
        }
        if (ALIAS_MERGE_LIVE_FIELDS.includes(field)) {
            merged[field] = cleanText(liveSource?.[field], 1200) || cleanText(liveOther?.[field], 1200);
            continue;
        }
        const av = cleanText(a?.[field], field === 'appearance' ? 1800 : 1200);
        const bv = cleanText(b?.[field], field === 'appearance' ? 1800 : 1200);
        merged[field] = bv.length > av.length ? bv : av;
    }
    // Custom fields: both records' values, the newer record's winning (a lock keeps its source's).
    const lockedCustomSource = lockedSourceFor('customFields');
    const customFields = lockedCustomSource
        ? normalizeCustomFields(lockedCustomSource.customFields)
        : mergeCustomFieldMaps(older.customFields, newer.customFields);
    if (Object.keys(customFields).length) merged.customFields = customFields;
    else delete merged.customFields;
    merged.memories = normalizeStoredMemories([...(a.memories || []), ...(b.memories || [])]);
    merged.manualMemories = [...(a.manualMemories || []), ...(b.manualMemories || [])];
    const mannerismLock = lockedSourceFor('mannerisms');
    const behaviorLock = lockedSourceFor('behaviorProfile');
    const relationshipLock = lockedSourceFor('keyRelationships');
    merged.mannerisms = mannerismLock
        ? structuredClone(mannerismLock.mannerisms || [])
        : normalizeMannerisms([...(a.mannerisms || []), ...(b.mannerisms || [])]);
    merged.behaviorProfile = behaviorLock
        ? structuredClone(behaviorLock.behaviorProfile || [])
        : normalizeBehaviorProfile([...(a.behaviorProfile || []), ...(b.behaviorProfile || [])]);
    merged.keyRelationships = relationshipLock
        ? structuredClone(relationshipLock.keyRelationships || [])
        : mergeKeyRelationshipUpdates(a.keyRelationships || [], b.keyRelationships || []);
    merged.profileEvidence = normalizeProfileEvidence({
        personality: [...(a.profileEvidence?.personality || []), ...(b.profileEvidence?.personality || [])],
        speech: [...(a.profileEvidence?.speech || []), ...(b.profileEvidence?.speech || [])],
        appearance: [...(a.profileEvidence?.appearance || []), ...(b.profileEvidence?.appearance || [])],
        mannerisms: [...(a.profileEvidence?.mannerisms || []), ...(b.profileEvidence?.mannerisms || [])],
        behaviorProfile: [...(a.profileEvidence?.behaviorProfile || []), ...(b.profileEvidence?.behaviorProfile || [])],
    });
    merged.relationship = structuredClone(relationshipSource.relationship || DEFAULT_RELATIONSHIP);
    merged.relationshipProgress = structuredClone(relationshipSource.relationshipProgress || DEFAULT_RELATIONSHIP_PROGRESS);
    merged.relationshipMilestones = structuredClone(relationshipSource.relationshipMilestones || []);
    merged.relationshipEventHistory = structuredClone(relationshipSource.relationshipEventHistory || []);
    merged.lastRelationshipChange = structuredClone(relationshipSource.lastRelationshipChange || merged.lastRelationshipChange);
    const lifecycleSource = Number(a?.updatedAt || 0) >= Number(b?.updatedAt || 0) ? a : b;
    for (const field of ['present','worldActive','lifeState','lifeStateCertainty','archived','archiveReason','archivedAt','archiveSourceMessageId']) merged[field] = structuredClone(lifecycleSource?.[field]);
    merged.portrait = portraitHasImage(a?.portrait) ? structuredClone(a.portrait) : (portraitHasImage(b?.portrait) ? structuredClone(b.portrait) : (a?.portrait || b?.portrait || null));
    merged.portraitPromptPositive = cleanText(newer?.portraitPromptPositive || older?.portraitPromptPositive, PORTRAIT_NPC_PROMPT_LIMIT);
    merged.portraitPromptNegative = cleanText(newer?.portraitPromptNegative || older?.portraitPromptNegative, PORTRAIT_NPC_PROMPT_LIMIT);
    merged.portraitPromptReplace = Boolean(newer?.portraitPromptReplace || older?.portraitPromptReplace);
    merged.portraitSeed = normalizePortraitSeed(newer?.portraitSeed) ?? normalizePortraitSeed(older?.portraitSeed);
    merged.seenCount = Math.max(Number(a?.seenCount || 0), Number(b?.seenCount || 0));
    merged.lastSeenTurn = Math.max(Number(a?.lastSeenTurn || 0), Number(b?.lastSeenTurn || 0));
    merged.lastWorldActiveTurn = Math.max(Number(a?.lastWorldActiveTurn || 0), Number(b?.lastWorldActiveTurn || 0));
    merged.createdAt = Math.min(Number(a?.createdAt || Date.now()), Number(b?.createdAt || Date.now()));
    merged.updatedAt = Math.max(Number(a?.updatedAt || 0), Number(b?.updatedAt || 0), Date.now());
    merged.manualProfileFields = [...new Set([...(a?.manualProfileFields || []), ...(b?.manualProfileFields || [])])];
    merged.retentionProtected = Boolean(a?.retentionProtected || b?.retentionProtected);
    merged.minor = Boolean(a?.minor && b?.minor);
    return normalizeNpcRecord(merged);
}

function consolidateAliasLinkedNpcDuplicates(next, report) {
    if (!Array.isArray(next?.npcs) || next.npcs.length < 2) return;
    if (!Array.isArray(report.deduplicated)) report.deduplicated = [];
    let changed = true;
    while (changed) {
        changed = false;
        outer: for (let i = 0; i < next.npcs.length; i += 1) {
            for (let j = i + 1; j < next.npcs.length; j += 1) {
                const a = next.npcs[i]; const b = next.npcs[j];
                if (!explicitAliasLink(a, b)) continue;
                const aKind = inferNpcIdentityKind(a.name, a.identityKind);
                const bKind = inferNpcIdentityKind(b.name, b.identityKind);
                if (aKind === 'proper_name' && bKind === 'proper_name'
                    && !((a.aliases || []).some(alias => normalizeName(alias) === normalizeName(b.name))
                        || (b.aliases || []).some(alias => normalizeName(alias) === normalizeName(a.name)))) continue;
                const survivor = Number(a?.createdAt || Infinity) <= Number(b?.createdAt || Infinity) ? a : b;
                const removed = survivor === a ? b : a;
                const merged = mergeAliasLinkedNpcPair(a, b);
                merged.id = survivor.id;
                next.socialGraph = remapSocialGraphNpcId(next.socialGraph, removed.id, survivor.id);
                next.npcs[i] = merged;
                next.npcs.splice(j, 1);
                report.deduplicated.push({ keptId: survivor.id, removedId: removed.id, name: merged.name });
                if (!report.updated.includes(survivor.id)) report.updated.push(survivor.id);
                changed = true;
                break outer;
            }
        }
    }
}

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
            next.npcs[existingIndex] = applyIncoming(next.npcs[existingIndex], incoming, turn, relationshipCaps, sourceMessageId, { ...lifecycleOptions, presentationOtherLabels });
            report.updated.push(next.npcs[existingIndex].id);
            if (normalizeName(previousName) !== normalizeName(next.npcs[existingIndex].name)) {
                report.renamed.push({ id: next.npcs[existingIndex].id, from: previousName, to: next.npcs[existingIndex].name });
            }
            next.candidates = next.candidates.filter(candidate => !scanLabelsMatch(candidate, incoming));
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

    // Final canonicalization is a hard guard against append-only drift from either
    // normal NPC deltas or the independent profile/social channels.
    next.npcs = next.npcs.map(npc => {
        const current = { ...npc };
        return normalizeNpcRecord(current);
    });

    next.npcs.sort((a, b) => Number(b.lastSeenTurn || 0) - Number(a.lastSeenTurn || 0));
    next.candidates.sort((a, b) => Number(b.lastSeenTurn || 0) - Number(a.lastSeenTurn || 0));
    return { state: next, report };
}

// Name/alias match used to bring an off-screen dossier into the next generation when the recent
// story names that NPC. It never changes presence.
// Titles and forms of address never identify one person on their own ("Lady", "Captain", "Capt.").
const NAME_TITLE_TOKENS = new Set([
    'lady', 'lord', 'sir', 'dame', 'madam', 'madame', 'mister', 'miss', 'mistress', 'master', 'captain',
    'commander', 'general', 'lieutenant', 'sergeant', 'major', 'colonel', 'admiral', 'doctor', 'professor',
    'father', 'mother', 'brother', 'sister', 'elder', 'king', 'queen', 'prince', 'princess', 'duke', 'duchess',
    'count', 'countess', 'baron', 'baroness', 'lady-in-waiting', 'saint', 'young', 'old', 'little', 'big',
    'capt', 'lt', 'sgt', 'cpl', 'col', 'gen', 'adm', 'cmdr', 'dr', 'mr', 'mrs', 'ms', 'mx', 'prof', 'rev', 'st', 'sr', 'jr',
    'of', 'the', 'von', 'van', 'de', 'del', 'della', 'der', 'den', 'du', 'la', 'le', 'al', 'bin', 'ibn',
]);
// Names that are also everyday words ("I will go"): matched only when written with a capital.
const COMMON_WORD_NAMES = new Set([
    'will', 'hope', 'grace', 'rose', 'mark', 'faith', 'joy', 'hunter', 'page', 'rich', 'bill', 'frank', 'sage', 'june',
    'dawn', 'summer', 'iris', 'lily', 'ruby', 'pearl', 'amber', 'jade', 'stone', 'black', 'white', 'brown', 'green',
    'wolf', 'bear', 'hawk', 'crow', 'raven', 'chase', 'drew', 'grant', 'honor', 'angel', 'star', 'rain', 'storm',
    'river', 'lake', 'glen', 'dale', 'forest', 'wood', 'hill', 'field', 'ford', 'mason', 'cook', 'baker', 'smith',
    'archer', 'fisher', 'miller', 'carter', 'cooper', 'porter', 'parker', 'taylor', 'sterling', 'rowan', 'ash',
]);

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// True when `word` stands as a whole word in the raw text starting with a capital letter.
function capitalisedWordIn(text, word) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(word)}(?![\\p{L}\\p{N}])`, 'giu');
    for (const match of String(text || '').matchAll(re)) {
        const first = match[0].charAt(0);
        if (first !== first.toLocaleLowerCase()) return true;
    }
    return false;
}

// A full name or alias always counts (a one-word alias only when capitalised); role descriptions
// ("the innkeeper") never count. Any other word of the name ("Hask" or "Orrin" for "Capt. Orrin
// Hask") counts when it has 4+ letters, is not a title, no other dossier's label carries it, and
// it is written with a capital (a first name may be lower-case unless it is an everyday word).
export function npcNamedInText(npc, text, roster = []) {
    const haystack = normalizeName(text);
    if (!haystack || !npc?.name) return false;
    const others = (Array.isArray(roster) ? roster : []).filter(other => other && other !== npc && other.id !== npc.id);
    const otherLabels = others.flatMap(other => [other.name, ...(other.aliases || [])]).map(normalizeName).filter(Boolean);
    const labels = [npc.name, ...(npc.aliases || [])].filter(label => label && !isRoleDescriptionLabel(label));
    for (const label of labels) {
        const needle = normalizeName(label);
        if (!needle || countNormalizedPhrase(haystack, needle) === 0) continue;
        // A label another dossier also carries ("Tomas") names nobody on its own, and a label
        // found only inside another dossier's longer name ("Mira" in "Lady Mira") is theirs.
        if (otherLabels.includes(needle)) continue;
        if (!needle.includes(' ') && label !== npc.name && !capitalisedWordIn(text, needle)) continue;
        // Mask every span of those longer labels (longest first, so overlapping labels such as
        // "Lady Mira Valen" and "Mira Valen" consume one span), then look for an independent mention.
        const masked = otherLabels
            .filter(other => other.length > needle.length && countNormalizedPhrase(other, needle) > 0)
            .sort((a, b) => b.length - a.length)
            .reduce((textSoFar, other) => textSoFar.replace(new RegExp(`(?<=^|\\s)${escapeRegExp(other)}(?=\\s|$)`, 'gu'), '#'), haystack);
        if (countNormalizedPhrase(masked, needle) === 0) continue;
        return true;
    }
    if (isRoleDescriptionLabel(npc.name)) return false;
    const tokens = normalizeName(npc.name).split(/\s+/).filter(Boolean);
    if (tokens.length < 2) return false;
    const firstPart = tokens.find(token => !NAME_TITLE_TOKENS.has(token)) || '';
    const otherTokens = new Set(otherLabels.flatMap(label => label.split(/\s+/)));
    for (const token of tokens) {
        if (token.length < 4 || NAME_TITLE_TOKENS.has(token)) continue;
        if (token === firstPart) {
            // A first name another dossier's label also starts with is ambiguous, and an occurrence
            // inside another dossier's named span ("Mira" in "Lady Mira Valen") is theirs.
            if (otherLabels.some(label => label.split(/\s+/)[0] === token)) continue;
            const masked = otherLabels
                .filter(other => other.length > token.length && countNormalizedPhrase(other, token) > 0)
                .sort((a, b) => b.length - a.length)
                .reduce((textSoFar, other) => textSoFar.replace(new RegExp(`(?<=^|\\s)${escapeRegExp(other)}(?=\\s|$)`, 'gu'), '#'), haystack);
            if (countNormalizedPhrase(masked, token) > 0 && (!COMMON_WORD_NAMES.has(token) || capitalisedWordIn(text, token))) return true;
            continue;
        }
        // Any other part (a surname) must be unique to this NPC and written with a capital.
        if (!otherTokens.has(token) && capitalisedWordIn(text, token)) return true;
    }
    return false;
}

export function countNormalizedPhrase(haystack, phrase) {
    if (!haystack || !phrase) return 0;
    const needle = ` ${phrase} `;
    let count = 0;
    let offset = 0;
    const padded = ` ${haystack} `;
    while ((offset = padded.indexOf(needle, offset)) !== -1) {
        count += 1;
        offset += Math.max(1, needle.length - 1);
    }
    return count;
}
