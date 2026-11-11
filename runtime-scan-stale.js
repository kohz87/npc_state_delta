/* NPC State Delta reply-scan stale lifecycle (role: reply-scan-stale). The protected references a scan result keeps
   from stale cleanup and the stale archive/delete pass run around a merge. Split unchanged from runtime-scan.js. */

import { applyStaleNpcLifecycle, normalizeName, npcMatchesLabel } from './core.js';

export function collectStaleCleanupProtectedIds(state, scanResult, transcript = '') {
    const ids = new Set();
    const npcs = Array.isArray(state?.npcs) ? state.npcs : [];
    const addReference = (id, label) => {
        const directId = String(id || '').trim();
        if (directId && npcs.some(npc => npc.id === directId)) ids.add(directId);
        const name = String(label || '').trim();
        if (!name) return;
        const matched = npcs.find(npc => npcMatchesLabel(npc, name));
        if (matched) ids.add(matched.id);
    };

    for (const raw of Array.isArray(scanResult?.npcs) ? scanResult.npcs : []) addReference(raw?.id, raw?.name);
    for (const raw of Array.isArray(scanResult?.profileUpdates) ? scanResult.profileUpdates : []) addReference(raw?.id, raw?.name);
    for (const edge of Array.isArray(scanResult?.keyRelationshipEdges) ? scanResult.keyRelationshipEdges : []) {
        addReference(edge?.aId, edge?.a);
        addReference(edge?.bId, edge?.b);
    }

    // Conservative local guard: if the current scan text explicitly names a stale NPC,
    // never prune that dossier even if the model omitted its delta object.
    const haystack = ` ${normalizeName(transcript)} `;
    if (haystack.trim()) {
        for (const npc of npcs) {
            const labels = [npc.name, ...(npc.aliases || [])]
                .map(normalizeName)
                .filter(label => label.length >= 3);
            if (labels.some(label => haystack.includes(` ${label} `))) ids.add(npc.id);
        }
    }
    return ids;
}

export function applyStaleLifecycleAfterScan(state, scanResult, transcript, settings, { onlyWhenAtCap = false, keepIds = [], noDelete = false, now = null } = {}) {
    if (settings.autoPruneStale === false) return { state, archived: [], removed: [] };
    const activeCount = (state.npcs || []).filter(npc => !npc?.archived).length;
    if (onlyWhenAtCap && activeCount < Number(settings.maxNpcs || 40)) return { state, archived: [], removed: [] };
    return applyStaleNpcLifecycle(state, {
        turn: state.turn,
        archiveAfter: settings.staleArchiveAfter,
        deleteAfter: settings.staleDeleteAfter,
        keepIds, noDelete, now, baseline: settings.relationshipBaseline,
        protectedIds: [...collectStaleCleanupProtectedIds(state, scanResult, transcript)],
    });
}
