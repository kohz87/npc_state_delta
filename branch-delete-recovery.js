// Three-way recovery for a deleted or edited block: NPC field reversion, removal of introduced dossiers,
// social-graph undo and tombstone-safe cleanup. A pure part of branch.js (same owner, moved without change);
// branch.js re-exports every public name it exported before. Never imports branch.js.

import { isTerminalNpcDeath, normalizeNpcRecord } from './core.js';
import { normalizeSocialGraph, removeNpcFromSocialGraph, purgeNpcStructuredReferences } from './social.js';
import { NPC_REVERT_GROUPS, NPC_REVERT_LIST_FIELDS } from './src/fields/registry.js';
import { jsonEqual } from './branch-util.js';
import { lineageCheckpointKeys } from './branch-lineage.js';
import { restoreLinearBoundaryFromJournal } from './branch-recovery.js';

// Fields that describe one thing and must be reverted (or kept) together, so a partial revert
// never leaves an NPC in a state no scan could have produced.
// NPC_REVERT_GROUPS (keys reverted or kept together) and NPC_REVERT_LIST_FIELDS come from the field
// registry (src/fields/registry.js).
const NPC_REVERT_SKIP = new Set(['id', 'portrait', 'updatedAt', 'createdAt', 'manualProfileFields', 'manualProfileLocksExplicit']);
// Presence bookkeeping alone does not make an NPC "used" by later messages, and neither does manual
// image/retention metadata (a saved seed or prompt is not a narrative appearance).
const NPC_REMOVAL_IGNORED = new Set([...NPC_REVERT_SKIP, 'present', 'worldActive', 'lastWorldActiveTurn', 'fieldChanges', 'fieldChangeDays', 'fieldChangeMessages', 'memoryStamps', 'memoryFacts',
    'portraitSeed', 'portraitPromptPositive', 'portraitPromptNegative', 'portraitPromptReplace', 'retentionProtected', 'minor']);

function withoutKeys(record, ignored) {
    const out = {};
    for (const [key, value] of Object.entries(record || {})) if (!ignored.has(key)) out[key] = value;
    return out;
}

function setOrDelete(target, key, source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = structuredClone(source[key]);
    else delete target[key];
}

// Removes from `current` the list items the deleted block added (present in `after`, absent in
// `before`), leaving items later messages added.
function removeAddedItems(current, before, after) {
    if (!Array.isArray(current) || !Array.isArray(after)) return current;
    const had = new Set((Array.isArray(before) ? before : []).map(item => JSON.stringify(item)));
    const added = new Set(after.filter(item => !had.has(JSON.stringify(item))).map(item => JSON.stringify(item)));
    return added.size ? current.filter(item => !added.has(JSON.stringify(item))) : current;
}

// Three-way revert of one NPC: `before` is the record just before the deleted block, `after` just
// after its last scan, `npc` the live record. A field (group) the block changed and nothing later
// touched returns to `before`; list fields also drop the items the block added. Returns the
// reverted field names.
// `views` holds the three records in the current stored format: whether the block changed a field,
// and whether a later message did, is decided on them, while reverted values come from the raw
// snapshot (a later normalization converts them like any other stored record).
function revertNpcAgainstDeletedBlock(npc, before, after, protectedKeys = [], views = { npc, before, after }) {
    const locked = new Set([...(Array.isArray(npc.manualProfileFields) ? npc.manualProfileFields : []), ...protectedKeys]);
    const changed = [];
    const handled = new Set();
    const same = (key, left, right) => jsonEqual(left[key], right[key]);
    const blockChanged = key => !same(key, after, before) && !same(key, views.after, views.before);
    const untouchedSince = key => same(key, npc, after) || same(key, views.npc, views.after);
    const consider = (keys) => {
        const usable = keys.filter(key => !NPC_REVERT_SKIP.has(key) && !locked.has(key));
        if (!usable.length || usable.length !== keys.length) { keys.forEach(key => handled.add(key)); return; }
        keys.forEach(key => handled.add(key));
        if (!keys.some(blockChanged)) return;                                      // the block changed nothing here
        if (!keys.every(untouchedSince)) return;                                   // something later touched it
        for (const key of keys) setOrDelete(npc, key, before);
        changed.push(...keys.filter(blockChanged));
    };
    for (const group of NPC_REVERT_GROUPS) consider(group);
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
        if (handled.has(key) || NPC_REVERT_SKIP.has(key) || locked.has(key)) continue;
        if (!blockChanged(key)) continue;
        if (untouchedSince(key)) { setOrDelete(npc, key, before); changed.push(key); continue; }
        if (NPC_REVERT_LIST_FIELDS.includes(key)) {
            const next = removeAddedItems(npc[key], before[key], after[key]);
            if (next !== npc[key] && next.length !== npc[key].length) { npc[key] = next; changed.push(key); }
        } else if (key === 'profileEvidence' && npc[key] && typeof npc[key] === 'object') {
            for (const field of Object.keys(after[key] || {})) {
                const next = removeAddedItems(npc[key][field], before[key]?.[field], after[key][field]);
                if (next !== npc[key][field] && next.length !== npc[key][field].length) { npc[key][field] = next; changed.push(`profileEvidence.${field}`); }
            }
        }
    }
    return changed;
}

// A message deleted from the middle of the chat leaves retained descendants that cannot be
// replayed, so canonical dossiers are kept. What the deleted block itself did can still be undone
// exactly wherever nothing later touched it: compare the live state with the state just before the
// block and just after its last scan (both from the rollback journal, else retained checkpoints).
// Only one contiguous deleted block is handled, and confirmed deaths stay terminal unless the
// deleted block itself caused the death.
export function revertDeletedBlockEffects(state, currentState, checkpoints, previousLineage, currentLineage, divergence) {
    const empty = { reverted: [], removed: [], socialEdges: 0 };
    const removedCount = previousLineage.length - currentLineage.length;
    if (!Array.isArray(currentState?.npcs) || !Number.isInteger(divergence) || divergence < 0 || removedCount <= 0) return empty;
    for (let i = 0; i < divergence; i += 1) if (previousLineage[i] !== currentLineage[i]) return empty;
    for (let i = divergence; i < currentLineage.length; i += 1) if (previousLineage[i + removedCount] !== currentLineage[i]) return empty;

    const keys = lineageCheckpointKeys(previousLineage);
    const owned = (Array.isArray(checkpoints) ? checkpoints : [])
        .filter(item => item?.snapshot && keys[item.messageId] === item.lineageKey)
        .sort((a, b) => a.messageId - b.messageId);
    const journalState = boundary => restoreLinearBoundaryFromJournal(state, previousLineage, previousLineage, boundary)?.state || null;
    // Only the exact boundary just before the block proves what the block changed; an older
    // checkpoint would attribute every retained message in between to the deletion.
    const before = journalState(divergence)
        || owned.filter(item => item.messageId === divergence - 1).at(-1)?.snapshot
        || (divergence === 0 ? state?.branchRootSnapshot : null);
    const after = journalState(divergence + removedCount)
        || owned.filter(item => item.messageId >= divergence && item.messageId < divergence + removedCount).at(-1)?.snapshot;
    if (!before || !after) return empty;

    // Snapshots may predate a stored-format conversion (1.0.94 story days, 1.0.98 complete forms) that
    // the live records already went through; compare both in the current format so the conversion
    // alone never reads as a later change.
    const byId = list => new Map((Array.isArray(list) ? list : []).map(npc => [String(npc?.id || ''), npc]));
    const beforeNpcs = byId(before.npcs);
    const afterNpcs = byId(after.npcs);
    const normalizedView = record => (record ? normalizeNpcRecord(record) : record);
    const result = { reverted: [], removed: [], socialEdges: 0 };
    const survivors = [];
    for (const npc of currentState.npcs) {
        const id = String(npc?.id || '');
        const was = beforeNpcs.get(id);
        const then = afterNpcs.get(id);
        if (!id || !then) { survivors.push(npc); continue; }
        const views = { npc: normalizedView(npc), before: normalizedView(was), after: normalizedView(then) };
        if (!was) {
            // Introduced by the deleted block: gone with it unless a later message used the NPC. The
            // exact before-state proves it did not exist, so a death recorded in the block goes too.
            if (jsonEqual(withoutKeys(views.npc, NPC_REMOVAL_IGNORED), withoutKeys(views.after, NPC_REMOVAL_IGNORED))
                && !referencedAfterBlock(currentState.npcs, afterNpcs, npc)
                && !graphUsedAfterBlock(currentState.socialGraph, after.socialGraph, npc, currentState.npcs)) {
                result.removed.push({ id, name: String(npc.name || '') });
                continue;
            }
            survivors.push(npc);
            continue;
        }
        // A death the deleted block did not cause stays terminal, with its terminal relationship
        // record (v1.0.78); the block's other unchanged effects (mood, memories, ...) are still undone.
        let protectedKeys = [];
        if (isTerminalNpcDeath(npc)) {
            const deathGroup = NPC_REVERT_GROUPS[3];
            const causedByBlock = !isTerminalNpcDeath(was) && deathGroup.every(key => jsonEqual(npc[key], then[key]));
            if (!causedByBlock) protectedKeys = [...deathGroup, ...NPC_REVERT_GROUPS[0]];
        }
        const fields = revertNpcAgainstDeletedBlock(npc, was, then, protectedKeys, views);
        if (fields.length) {
            npc.updatedAt = Date.now();
            result.reverted.push({ id, name: String(npc.name || ''), fields });
        }
        survivors.push(npc);
    }
    currentState.npcs = survivors;

    if (currentState.socialGraph && before.socialGraph && after.socialGraph) {
        const graph = structuredClone(currentState.socialGraph);
        const edgeMap = list => new Map(normalizeSocialGraph({ edges: list }).edges.map(edge => [edge.id, edge]));
        const beforeEdges = edgeMap(before.socialGraph.edges);
        const afterEdges = edgeMap(after.socialGraph.edges);
        const liveIds = new Set(survivors.map(npc => String(npc?.id || '')));
        // Grouped bonds the block added and this revert removes, per endpoint and group: each one
        // may have consumed an unnamed-relative slot that must come back with it.
        const undoneGroupBonds = new Map();
        const countUndone = edge => {
            if (!edge?.groupId) return;
            for (const owner of [edge.aId, edge.bId]) {
                const key = `${owner}|${edge.groupId}`;
                undoneGroupBonds.set(key, (undoneGroupBonds.get(key) || 0) + 1);
            }
        };
        graph.edges = normalizeSocialGraph({ edges: graph.edges }).edges.flatMap(edge => {
            const id = String(edge?.id || '');
            const then = afterEdges.get(id);
            const was = beforeEdges.get(id);
            if (!id || !then || !jsonEqual(edge, then)) return [edge];
            if (!was) { result.socialEdges += 1; countUndone(edge); return []; }   // added by the block
            if (jsonEqual(was, then)) return [edge];
            result.socialEdges += 1;
            return [structuredClone(was)];                                // changed by the block
        }).filter(edge => {
            const kept = liveIds.has(String(edge?.aId || '')) && liveIds.has(String(edge?.bId || ''));
            // A bond to an NPC the block introduced goes with that NPC.
            if (!kept && afterEdges.has(edge.id) && !beforeEdges.has(edge.id)) countUndone(edge);
            return kept;
        });
        // Unresolved relative slots follow the same rule: a slot the block added and no retained
        // message touched goes with it; one the block changed reverts. Deleted family facts must
        // not survive as slots that a later scan would consume as evidence.
        const slotMap = list => new Map(normalizeSocialGraph({ unresolved: list }).unresolved.map(slot => [slot.id, slot]));
        const beforeSlots = slotMap(before.socialGraph.unresolved);
        const afterSlots = slotMap(after.socialGraph.unresolved);
        graph.unresolved = normalizeSocialGraph({ unresolved: graph.unresolved }).unresolved.flatMap(slot => {
            const id = String(slot?.id || '');
            const then = afterSlots.get(id);
            const was = beforeSlots.get(id);
            if (!id || !then || !jsonEqual(slot, then)) return [slot];
            if (!was) { result.socialEdges += 1; return []; }            // added by the block
            if (jsonEqual(was, then)) return [slot];
            result.socialEdges += 1;
            return [structuredClone(was)];                                // changed by the block
        }).filter(slot => liveIds.has(String(slot?.ownerId || '')));
        // A slot the block consumed (naming that relative) returns when the bond that named it is
        // undone; a bond a retained message kept keeps the slot consumed.
        const liveSlotIds = new Set(graph.unresolved.map(slot => slot.id));
        const consumed = [...beforeSlots.values()]
            .filter(slot => !afterSlots.has(slot.id) && !liveSlotIds.has(slot.id) && liveIds.has(String(slot.ownerId || '')))
            .sort((a, b) => a.id.localeCompare(b.id));
        for (const slot of consumed) {
            const key = `${slot.ownerId}|${slot.groupId}`;
            if (!(undoneGroupBonds.get(key) > 0)) continue;
            undoneGroupBonds.set(key, undoneGroupBonds.get(key) - 1);
            graph.unresolved.push(structuredClone(slot));
            result.socialEdges += 1;
        }
        currentState.socialGraph = graph;
    }
    currentState.candidates = removeAddedItems(currentState.candidates, before.candidates, after.candidates);
    currentState.pendingBackfills = removeAddedItems(currentState.pendingBackfills, before.pendingBackfills, after.pendingBackfills);
    return result;
}

// Whether another dossier started naming this NPC after the deleted block (a retained message used it).
function referencedAfterBlock(liveNpcs, afterNpcs, npc) {
    // Whole-word name or alias matches only: "Wayfarer" names the NPC, "dangerous" does not name Dan.
    const labels = [npc?.name, ...(Array.isArray(npc?.aliases) ? npc.aliases : [])]
        .map(label => String(label || '').trim()).filter(label => label.length >= 2);
    if (!labels.length) return false;
    const wordPattern = (label, flags = 'iu') => new RegExp(`(?<![\\p{L}\\p{N}])${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, flags);
    // Resolve against the roster: a label another dossier also carries names nobody, and a label
    // found inside another dossier's longer name ("Tomas" in "Tomas Hale") is that dossier's.
    const rosterLabels = (Array.isArray(liveNpcs) ? liveNpcs : [])
        .filter(other => other && other !== npc && other.id !== npc.id)
        .flatMap(other => [other.name, ...(Array.isArray(other.aliases) ? other.aliases : [])])
        .map(label => String(label || '').trim()).filter(Boolean);
    const rosterKeys = new Set(rosterLabels.map(label => label.toLowerCase()));
    const ownLabels = labels.filter(label => !rosterKeys.has(label.toLowerCase()));
    const mentionsIn = entry => ownLabels.some(label => {
        const masked = rosterLabels
            .filter(other => other.length > label.length && wordPattern(label).test(other))
            .sort((a, b) => b.length - a.length)
            .reduce((text, other) => text.replace(wordPattern(other, 'giu'), '#'), String(entry || ''));
        return wordPattern(label).test(masked);
    });
    const mentions = other => [...(Array.isArray(other?.keyRelationships) ? other.keyRelationships : []), ...(Array.isArray(other?.memories) ? other.memories : [])]
        .some(mentionsIn);
    return (Array.isArray(liveNpcs) ? liveNpcs : []).some(other => other && other !== npc && other.id !== npc.id
        && mentions(other) && !mentions(afterNpcs.get(String(other.id || ''))));
}

// Whether a retained message gave this NPC canonical social continuity: a live, non-inferred graph
// edge to another live NPC that the deleted block's end state did not already hold. The five-item
// bond projection is only a view, so a hidden edge counts as later use too.
function graphUsedAfterBlock(liveGraph, afterGraph, npc, liveNpcs) {
    const id = String(npc?.id || '');
    if (!id) return false;
    const liveIds = new Set((Array.isArray(liveNpcs) ? liveNpcs : []).map(other => String(other?.id || '')));
    const semantic = edge => edge ? [edge.aId, edge.bId, edge.aToB, edge.bToA, edge.aDynamic, edge.bDynamic, edge.confidence].map(value => String(value ?? '')) : null;
    const afterEdges = new Map((Array.isArray(afterGraph?.edges) ? afterGraph.edges : []).map(edge => [String(edge?.id || ''), edge]));
    return (Array.isArray(liveGraph?.edges) ? liveGraph.edges : []).some(edge => {
        if (!edge || edge.inferred === true) return false;
        const a = String(edge.aId || '');
        const b = String(edge.bId || '');
        if (a !== id && b !== id) return false;
        const other = a === id ? b : a;
        if (!other || other === id || !liveIds.has(other)) return false;
        return !jsonEqual(semantic(edge), semantic(afterEdges.get(String(edge.id || ''))));
    });
}

// References to an NPC that was removed together with the deleted block.
export function cleanupRemovedNpcs(restored, removed, previousNpcs) {
    for (const item of removed) {
        const record = (Array.isArray(previousNpcs) ? previousNpcs : []).find(npc => String(npc?.id || '') === item.id) || item;
        restored.socialGraph = removeNpcFromSocialGraph(restored.socialGraph, item.id);
        purgeNpcStructuredReferences(restored.npcs, record);
        restored.pendingBackfills = (Array.isArray(restored.pendingBackfills) ? restored.pendingBackfills : [])
            .filter(entry => String(entry?.npcId || '') !== item.id);
        restored.candidates = (Array.isArray(restored.candidates) ? restored.candidates : [])
            .filter(entry => String(entry?.id || '') !== item.id);
    }
    restored.socialGraph = normalizeSocialGraph(restored.socialGraph);
}
