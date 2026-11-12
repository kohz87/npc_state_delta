/* NPC State Delta batch durable-profile updates and interim identity promotion: applyDurableProfileUpdates
   and resolveInterimIdentityPromotions. Split from core-development.js as a line-for-line part; the
   original keeps the public exports. */

import { cleanText, normalizeName } from './core-text.js';
import { mergeLists, normalizeScanNpc, npcMatchesLabel } from './core-record.js';
import { findInterimIdentityPromotionIndex, inferNpcIdentityKind } from './core-identity.js';
import { applyDurableProfileUpdate } from './core-development-update.js';
import { resolveNpcId } from './social.js';

export function applyDurableProfileUpdates(state, scanResult, excludeNames, report, options = {}) {
    const rawUpdates = Array.isArray(scanResult?.profileUpdates) ? scanResult.profileUpdates
        : (Array.isArray(scanResult?.profile_updates) ? scanResult.profile_updates : []);
    let applied = 0;
    let evidenceAdded = 0;
    for (const raw of rawUpdates) {
        if (!raw || typeof raw !== 'object') continue;
        const id = cleanText(raw.id, 100);
        const name = cleanText(raw.name, 120);
        // (ONEPASSCAP-3) The exact id, else the one dossier whose id matches with '-', '_' and case folded (a block keys a person it admits
        // in the same reply by the id the model guessed: "npc_sister_temiwa" for npc_sister-temiwa), then the name as before.
        const byId = id ? resolveNpcId(state.npcs, id) : null;
        let index = byId ? state.npcs.indexOf(byId) : -1;
        if (index < 0 && name) index = state.npcs.findIndex(npc => npcMatchesLabel(npc, name));
        if (index < 0) continue;
        const npc = state.npcs[index];
        if (excludeNames.has(normalizeName(npc.name))) continue;
        const otherLabels = (Array.isArray(state.npcs) ? state.npcs : [])
            .filter(other => String(other?.id || '') !== String(npc?.id || ''))
            .flatMap(other => [other?.name, ...(Array.isArray(other?.aliases) ? other.aliases : [])])
            .filter(Boolean);
        const result = applyDurableProfileUpdate(npc, raw, { ...options, otherLabels });
        evidenceAdded += result.evidenceAdded;
        if (result.changed) {
            applied += 1;
            if (!report.updated.includes(npc.id)) report.updated.push(npc.id);
            if (!report.profileUpdated.includes(npc.id)) report.profileUpdated.push(npc.id);
        }
    }
    return { provided: rawUpdates.length, applied, evidenceAdded };
}

export function resolveInterimIdentityPromotions(scanResult, existingNpcs = [], candidates = []) {
    const clone = {
        ...(scanResult || {}),
        npcs: Array.isArray(scanResult?.npcs) ? scanResult.npcs.map(raw => ({ ...(raw || {}) })) : [],
    };
    const records = [
        ...(Array.isArray(existingNpcs) ? existingNpcs : []),
        ...(Array.isArray(candidates) ? candidates : []),
    ];
    for (const raw of clone.npcs) {
        const incoming = normalizeScanNpc(raw);
        if (!incoming.name || inferNpcIdentityKind(incoming.name, incoming.identityKind) !== 'proper_name') continue;
        const alreadyMatches = (Array.isArray(existingNpcs) ? existingNpcs : []).some(record =>
            (incoming.id && String(record?.id || '') === String(incoming.id))
            || npcMatchesLabel(record, incoming.name)
            || incoming.aliases.some(alias => npcMatchesLabel(record, alias)));
        if (alreadyMatches) continue;
        const matchIndex = findInterimIdentityPromotionIndex(records, incoming);
        if (matchIndex < 0) continue;
        const matched = records[matchIndex];
        // Candidate ids are intentionally not copied into dossier ids. Carry their old label as
        // an alias and let the normal candidate-promotion path create the dossier when appropriate.
        const isExistingDossier = (Array.isArray(existingNpcs) ? existingNpcs : []).some(record => record?.id === matched?.id);
        if (isExistingDossier) raw.id = matched.id;
        raw.aliases = mergeLists([matched.name, ...(matched.aliases || [])], raw.aliases, 8)
            .filter(alias => normalizeName(alias) !== normalizeName(incoming.name));
        raw.identityKind = 'proper_name';
        raw.sameIndividual = true;
    }
    return clone;
}
