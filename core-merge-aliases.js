/* NPC State Delta alias-linked duplicate consolidation: canonical-name choice, locked-field and
   relationship merging, and the alias-pair pass. Split from core-merge.js without change;
   core-merge.js keeps the public scan-merge exports. Never imports core-merge.js. */
import { cleanText, normalizeName } from './core-text.js';
import { DEFAULT_RELATIONSHIP, DEFAULT_RELATIONSHIP_PROGRESS, normalizeRelationshipBaseline, RELATIONSHIP_KEYS } from './core-relationship.js';
import { inferNpcIdentityKind, isInterimNpcLabel, normalizeGender } from './core-identity.js';
import { mergeLists, normalizeCustomFields, normalizeNpcRecord, normalizePortraitSeed, normalizeStoredMemories } from './core-record.js';
import { ALIAS_MERGE_TEXT_FIELDS } from './src/fields/registry.js';
import { normalizeMannerisms } from './core-durable.js';
import { normalizeBehaviorProfile } from './core-behavior.js';
import { mergeKeyRelationshipUpdates } from './core-keyrel.js';
import { normalizeProfileEvidence } from './core-evidence.js';
import { portraitHasImage } from './src/portrait-file.js';
import { PORTRAIT_NPC_PROMPT_LIMIT } from './core-portrait.js';
import { remapSocialGraphNpcId } from './social.js';
import { identityConflict, partialNamePair } from './core-merge-names.js';

function explicitAliasLink(a, b) {
    if (!a || !b || a.id === b.id) return false;
    const aName = normalizeName(a.name);
    const bName = normalizeName(b.name);
    if (!aName || !bName) return false;
    const aAliases = new Set((a.aliases || []).map(normalizeName).filter(Boolean));
    const bAliases = new Set((b.aliases || []).map(normalizeName).filter(Boolean));
    if (!(aAliases.has(bName) || bAliases.has(aName))) return false;
    // An alias that is only a surname or a title-less name does not join people of different gender or role.
    return !(partialNamePair(a.name, b.name) && identityConflict(a, b));
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
        for (const key of ['appearance', 'overallAppearance', 'unclassifiedAppearance', 'appearanceForms', 'currentForm', 'currentFormUnknown', 'appearanceModelVersion', 'lookGuess']) {
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
    merged.memoryStamps = { ...(b.memoryStamps || {}), ...(a.memoryStamps || {}) };
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

export function consolidateAliasLinkedNpcDuplicates(next, report) {
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
