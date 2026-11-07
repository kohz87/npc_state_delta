/* NPC State Delta native bundle merge: cross-chat dossier and graph import. Codec exports are re-exported. */
import { isTerminalNpcDeath, normalizeFormPortraitAssets, normalizeName, normalizeNpcRecord, protectTerminalNpc } from './core.js';
import { normalizeSocialGraph, remapSocialGraphNpcIds } from './social.js';
import { portraitHasImage } from './src/portrait-file.js';
import {
    filterGraphByIds, identityMatchIndex, initImportReport, npcKeys, preserveTargetManualLocks,
    rekeyCollidingImportedSlots, uniqueImportedId, withoutSourceReplyNumbers,
} from './bundle-import-helpers.js';

export { binaryToDataUrl, dataUrlToBinary, decodeNpcStateBundle, encodeNpcStateBundle } from './bundle-codec.js';

export function mergeImportedDossierState(currentState, importedState, { maxNpcs = 40, excludeNames = [], report = null, foreignOwnership = false } = {}) {
    const current = currentState && typeof currentState === 'object' ? currentState : {};
    const incoming = importedState && typeof importedState === 'object' ? importedState : {};
    const existing = Array.isArray(current.npcs) ? current.npcs.map(normalizeNpcRecord) : [];
    const targetTurn = Math.max(0, Math.round(Number(current.turn) || 0));
    const foreignActivity = foreignOwnership === true;
    const excluded = new Set((Array.isArray(excludeNames) ? excludeNames : []).map(normalizeName).filter(Boolean));
    const allImported = (Array.isArray(incoming.npcs) ? incoming.npcs : []).map(normalizeNpcRecord);
    const importReport = initImportReport(report);
    const rejectedSourceIds = new Set();
    const imported = [];
    for (const npc of allImported) {
        const sourceId = String(npc.id || '');
        if (npcKeys(npc).some(key => excluded.has(key))) {
            if (sourceId) rejectedSourceIds.add(sourceId);
            importReport?.skipped.push({ sourceId, name: npc.name, reason: 'excluded' });
            continue;
        }
        imported.push(npc);
    }

    // Preserve every existing dossier in-place. Imports may update an unambiguous match and
    // may fill genuinely available active slots, but they never evict an existing active NPC.
    const npcs = existing.map(npc => structuredClone(npc));
    const usedTargetIndexes = new Set();
    const importedIdMap = new Map();
    const usedIds = new Set(npcs.map(npc => String(npc?.id || '')).filter(Boolean));
    const tombstonedIds = new Set((Array.isArray(current.userDismissedGroups) ? current.userDismissedGroups : [])
        .flatMap(group => [...(Array.isArray(group?.ids) ? group.ids : []), group?.npcId])
        .map(value => String(value || '').trim())
        .filter(Boolean));
    const cap = Math.max(1, Math.min(100, Number(maxNpcs) || 40));
    let activeCount = npcs.filter(npc => !npc?.archived).length;
    const acceptedTargetIds = new Map();

    for (const rawNpc of imported) {
        const npc = structuredClone(rawNpc);
        if (foreignActivity) withoutSourceReplyNumbers(npc);
        const sourceId = String(npc.id || '');
        const index = identityMatchIndex(npcs, npc, { stableIdOnly: Boolean(sourceId && tombstonedIds.has(sourceId)) });
        if (index >= 0) {
            const old = npcs[index];
            const wasActive = !old?.archived;
            const targetId = old.id;
            if (usedTargetIndexes.has(index)) {
                importReport?.skipped.push({ sourceId, id: targetId, name: npc.name, reason: 'duplicate-identity' });
                // A skipped origin donates nothing: its identity-bound graph channels must not be
                // remapped onto the different dossier that was accepted for this target.
                if (sourceId && !acceptedTargetIds.has(sourceId)) rejectedSourceIds.add(sourceId);
                continue;
            }
            importedIdMap.set(sourceId, targetId);
            usedTargetIndexes.add(index);
            const lockAware = preserveTargetManualLocks(old, npc);
            const effectiveName = String(lockAware.name || npc.name || old.name || '').trim();
            const merged = normalizeNpcRecord({
                ...lockAware,
                id: targetId,
                // (cleanup step 7) Hand-locked aliases on the target take no imported additions.
                aliases: [...new Set((old.manualProfileFields || []).includes('aliases') ? [...(old.aliases || [])] : [
                    ...(old.aliases || []),
                    ...(npc.aliases || []),
                    old.name,
                    npc.name,
                ])]
                    .filter(Boolean)
                    .filter(alias => normalizeName(alias) !== normalizeName(effectiveName))
                    .slice(0, 8),
                portrait: portraitHasImage(npc.portrait) ? structuredClone(npc.portrait) : old.portrait || npc.portrait || null,
                // Activity counters are chat-local clocks. A foreign dossier may update durable
                // characterization, but cannot move an existing target record backward or forward
                // on an unrelated source turn axis.
                ...(foreignActivity ? {
                    lastSeenTurn: old.lastSeenTurn,
                    lastWorldActiveTurn: old.lastWorldActiveTurn,
                    fieldChanges: old.fieldChanges || {},
                    fieldChangeDays: old.fieldChangeDays || {},
                    fieldChangeMessages: old.fieldChangeMessages || {},
                } : {}),
            });
            const accepted = isTerminalNpcDeath(old) ? protectTerminalNpc(old, merged) : merged;
            npcs[index] = accepted;
            const isActive = !accepted?.archived;
            if (wasActive !== isActive) activeCount += isActive ? 1 : -1;
            importReport?.updated.push({ sourceId, id: targetId, name: accepted.name });
            importReport?.accepted.push({ sourceId, id: targetId, name: accepted.name, status: 'updated' });
            if (sourceId) acceptedTargetIds.set(sourceId, targetId);
            if (sourceId && sourceId !== targetId) importReport?.idRemaps.push({ from: sourceId, to: targetId, reason: 'matched-existing' });
            continue;
        }

        // If the imported id is already owned by a different identity, mint a fresh id before
        // graph reconciliation so portraits, inline cards, branches, and social edges cannot alias.
        let targetId = sourceId;
        if (!targetId || usedIds.has(targetId)) {
            targetId = uniqueImportedId(npc, usedIds);
            if (sourceId) importedIdMap.set(sourceId, targetId);
            importReport?.idRemaps.push({ from: sourceId, to: targetId, reason: sourceId ? 'id-collision' : 'missing-id' });
        }
        npc.id = targetId;
        if (foreignActivity) {
            // A newly admitted foreign dossier starts its inactivity clock at the target import
            // boundary. This is target-owned chronology only; no source-message provenance is
            // invented or copied across chats.
            npc.lastSeenTurn = targetTurn;
            npc.lastWorldActiveTurn = targetTurn;
            // Dossier change markers are turn-stamped on the source chat's clock.
            npc.fieldChanges = {};
            delete npc.fieldChangeDays;
        }

        if (!npc.archived && activeCount >= cap) {
            if (sourceId) rejectedSourceIds.add(sourceId);
            importReport?.skipped.push({ sourceId, id: targetId, name: npc.name, reason: 'capacity' });
            continue;
        }

        npcs.push(npc);
        usedTargetIndexes.add(npcs.length - 1);
        usedIds.add(targetId);
        if (!npc.archived) activeCount += 1;
        importReport?.added.push({ sourceId, id: targetId, name: npc.name, archived: Boolean(npc.archived) });
        importReport?.accepted.push({ sourceId, id: targetId, name: npc.name, status: 'added' });
        if (sourceId) acceptedTargetIds.set(sourceId, targetId);
    }

    const activeNames = new Set(npcs.flatMap(npcKeys));
    const dismissed = [...new Set([
        ...(Array.isArray(current.dismissed) ? current.dismissed : []),
        ...(Array.isArray(incoming.dismissed) ? incoming.dismissed : []),
    ].map(normalizeName).filter(Boolean))].filter(name => !activeNames.has(name));

    let importedGraph = normalizeSocialGraph(incoming.socialGraph);
    // Remove endpoints belonging to imports that were deliberately not admitted before any id
    // remap, otherwise a rejected source id that collides with an existing id could attach its
    // relationship edges to the wrong person.
    importedGraph = normalizeSocialGraph({
        edges: importedGraph.edges.filter(edge => !rejectedSourceIds.has(edge.aId) && !rejectedSourceIds.has(edge.bId)),
        unresolved: importedGraph.unresolved.filter(slot => !rejectedSourceIds.has(slot.ownerId)),
        suppressed: (importedGraph.suppressed || []).filter(entry => !rejectedSourceIds.has(entry.aId) && !rejectedSourceIds.has(entry.bId)),
    });
    importedGraph = remapSocialGraphNpcIds(importedGraph, importedIdMap);
    const validIds = new Set(npcs.map(npc => String(npc?.id || '')).filter(Boolean));
    importedGraph = filterGraphByIds(importedGraph, validIds);
    const currentGraph = filterGraphByIds(current.socialGraph, validIds);
    importedGraph = rekeyCollidingImportedSlots(importedGraph, currentGraph);
    const socialGraph = normalizeSocialGraph({
        edges: [...currentGraph.edges, ...importedGraph.edges],
        unresolved: [...currentGraph.unresolved, ...importedGraph.unresolved],
        // Manual removals of inferred sibling pairs stay honoured across import.
        suppressed: [...(currentGraph.suppressed || []), ...(importedGraph.suppressed || [])],
    });

    // Form portraits follow their accepted dossier to its target id. An imported image replaces the
    // target's image for that same form only; the target's other form portraits are kept.
    const formPortraitAssets = normalizeFormPortraitAssets(current.formPortraitAssets);
    const incomingForms = normalizeFormPortraitAssets(incoming.formPortraitAssets);
    for (const [sourceId, targetId] of acceptedTargetIds.entries()) {
        if (!incomingForms[sourceId] || !validIds.has(targetId)) continue;
        formPortraitAssets[targetId] = { ...(formPortraitAssets[targetId] || {}), ...structuredClone(incomingForms[sourceId]) };
    }

    return {
        ...current,
        npcs,
        socialGraph,
        dismissed,
        formPortraitAssets: normalizeFormPortraitAssets(formPortraitAssets),
        lastScannedMessageId: null,
        readAhead: [],
        assistantSinceScan: 0,
        // An import is never a chat that was not scanned yet: what the bundle holds was applied once, so the next scan
        // reads the latest reply only.
        scanCount: Math.max(Math.round(Number(current.scanCount) || 0), (Number(incoming.scanCount) > 0 || Number.isInteger(incoming.lastScannedMessageId) || imported.length) ? 1 : 0),
    };
}
