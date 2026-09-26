import { isTerminalNpcDeath, normalizeName, normalizeNpcRecord, protectTerminalNpc } from './core.js';
import { normalizeSocialGraph, remapSocialGraphNpcId } from './social.js';

const MAGIC = new Uint8Array([0x4e, 0x50, 0x43, 0x53, 0x54, 0x42, 0x30, 0x31]); // NPCSTB01
const HEADER_SIZE = 12;
const FORMAT_VERSION = 1;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;

function toUint8Array(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new Error('NPC State Delta bundle must be binary data.');
}

function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
    return true;
}

function decodeBase64(text) {
    const clean = String(text || '').replace(/\s+/g, '');
    const binary = globalThis.atob(clean);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
}

function encodeBase64(bytes) {
    const input = toUint8Array(bytes);
    const chunk = 0x8000;
    let binary = '';
    for (let i = 0; i < input.length; i += chunk) {
        const slice = input.subarray(i, Math.min(i + chunk, input.length));
        let part = '';
        for (let j = 0; j < slice.length; j += 1) part += String.fromCharCode(slice[j]);
        binary += part;
    }
    return globalThis.btoa(binary);
}

export function dataUrlToBinary(dataUrl) {
    const match = String(dataUrl || '').match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/i);
    if (!match) throw new Error('Portrait data is not a valid data URL.');
    const mime = match[1] || 'application/octet-stream';
    const bytes = match[2]
        ? decodeBase64(match[3])
        : new TextEncoder().encode(decodeURIComponent(match[3]));
    return { mime, bytes };
}

export function binaryToDataUrl(bytes, mime = 'application/octet-stream') {
    return `data:${mime};base64,${encodeBase64(bytes)}`;
}

function cloneRecordForManifest(npc, binaryOffsetRef, imageParts) {
    const record = structuredClone(npc);
    const portrait = record.portrait;
    if (!portrait?.dataUrl) {
        if (portrait) delete portrait.dataUrl;
        return record;
    }

    const parsed = dataUrlToBinary(portrait.dataUrl);
    delete portrait.dataUrl;
    portrait.mime = portrait.mime || parsed.mime;
    portrait.binary = {
        offset: binaryOffsetRef.value,
        length: parsed.bytes.length,
    };
    binaryOffsetRef.value += parsed.bytes.length;
    imageParts.push(parsed.bytes);
    return record;
}

export function encodeNpcStateBundle(state, { appVersion = 'unknown', chatKey = '' } = {}) {
    const source = state && typeof state === 'object' ? state : {};
    const imageParts = [];
    const binaryOffsetRef = { value: 0 };
    const npcs = Array.isArray(source.npcs)
        ? source.npcs.map(npc => cloneRecordForManifest(npc, binaryOffsetRef, imageParts))
        : [];

    const manifest = {
        format: 'npc_state_delta_bundle',
        formatVersion: FORMAT_VERSION,
        appVersion: String(appVersion || 'unknown'),
        exportedAt: new Date().toISOString(),
        sourceChatKey: String(chatKey || ''),
        state: {
            npcs,
            socialGraph: normalizeSocialGraph(source.socialGraph),
            dismissed: Array.isArray(source.dismissed) ? [...source.dismissed] : [],
        },
    };

    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new Error('NPC State Delta bundle manifest is too large.');

    const totalBytes = HEADER_SIZE + manifestBytes.length + binaryOffsetRef.value;
    if (totalBytes > MAX_BUNDLE_BYTES) throw new Error('NPC State Delta bundle exceeds the 32 MB safety limit.');

    const output = new Uint8Array(totalBytes);
    output.set(MAGIC, 0);
    new DataView(output.buffer).setUint32(MAGIC.length, manifestBytes.length, true);
    output.set(manifestBytes, HEADER_SIZE);
    let cursor = HEADER_SIZE + manifestBytes.length;
    for (const part of imageParts) {
        output.set(part, cursor);
        cursor += part.length;
    }
    return output;
}

function validateManifest(manifest) {
    // Bound subsequent recursive cloning/scrubbing and reject prototype-shaped metadata
    // before any imported value reaches canonical object maps.
    const queue = [{ value: manifest, depth: 0 }];
    while (queue.length) {
        const { value, depth } = queue.pop();
        if (!value || typeof value !== 'object') continue;
        if (depth > 64) throw new Error('NPC State Delta bundle nesting exceeds the 64-level safety limit.');
        for (const [key, item] of Object.entries(value)) {
            if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('NPC State Delta bundle contains unsafe object metadata.');
            if (item && typeof item === 'object') queue.push({ value: item, depth: depth + 1 });
        }
    }
    if (!manifest || manifest.format !== 'npc_state_delta_bundle') throw new Error('Not an NPC State Delta bundle.');
    if (manifest.formatVersion !== FORMAT_VERSION) throw new Error(`Unsupported NPC State Delta bundle version: ${manifest.formatVersion}.`);
    if (!manifest.state || !Array.isArray(manifest.state.npcs)) throw new Error('NPC State Delta bundle is missing its dossier registry.');
    const ids = new Set();
    for (const npc of manifest.state.npcs) {
        if (!npc || typeof npc !== 'object' || Array.isArray(npc)) throw new Error('Every Delta dossier must be an object.');
        for (const key of ['id', 'name']) {
            if (key in npc && typeof npc[key] !== 'string') throw new Error(`Dossier ${key} must be text.`);
        }
        for (const key of ['relationship', 'relationshipProgress', 'portrait']) {
            const value = npc[key];
            if (value != null && (typeof value !== 'object' || Array.isArray(value))) throw new Error(`Dossier ${key} must be an object.`);
        }
        for (const key of ['relationship', 'relationshipProgress']) {
            for (const value of Object.values(npc[key] || {})) {
                if (!['number', 'string'].includes(typeof value) || !String(value).trim() || !Number.isFinite(Number(value))) {
                    throw new Error(`Dossier ${key} contains a non-numeric value.`);
                }
            }
        }
        const id = String(npc?.id || '').trim();
        if (['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error('NPC State Delta dossier id is reserved.');
        if (!id) continue;
        if (ids.has(id)) throw new Error(`NPC State Delta bundle contains duplicate NPC id: ${id}.`);
        ids.add(id);
    }
}

export function decodeNpcStateBundle(input) {
    const bytes = toUint8Array(input);
    if (bytes.length < HEADER_SIZE) throw new Error('NPC State Delta bundle is truncated.');
    if (bytes.length > MAX_BUNDLE_BYTES) throw new Error('NPC State Delta bundle exceeds the 32 MB safety limit.');
    if (!bytesEqual(bytes.subarray(0, MAGIC.length), MAGIC)) throw new Error('Invalid NPC State Delta bundle signature.');

    const manifestLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(MAGIC.length, true);
    if (!manifestLength || manifestLength > MAX_MANIFEST_BYTES) throw new Error('NPC State Delta bundle has an invalid manifest length.');
    const manifestStart = HEADER_SIZE;
    const binaryStart = manifestStart + manifestLength;
    if (binaryStart > bytes.length) throw new Error('NPC State Delta bundle manifest is truncated.');

    let manifest;
    try {
        manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(manifestStart, binaryStart)));
    } catch {
        throw new Error('NPC State Delta bundle manifest is invalid JSON.');
    }
    validateManifest(manifest);

    const portraitRanges = [];
    const npcs = manifest.state.npcs.map(npc => {
        const record = structuredClone(npc);
        const bin = record.portrait?.binary;
        if (!bin) return record;
        const offset = Number(bin.offset);
        const length = Number(bin.length);
        if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length <= 0) {
            throw new Error(`NPC State Delta bundle has invalid portrait metadata for ${record.name || 'an NPC'}.`);
        }
        const start = binaryStart + offset;
        const end = start + length;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || end > bytes.length) {
            throw new Error(`NPC State Delta bundle portrait is truncated for ${record.name || 'an NPC'}.`);
        }
        portraitRanges.push({ start, end, name: record.name || 'an NPC' });
        const mime = record.portrait.mime || 'application/octet-stream';
        record.portrait.dataUrl = binaryToDataUrl(bytes.subarray(start, end), mime);
        delete record.portrait.binary;
        return record;
    });
    portraitRanges.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < portraitRanges.length; i += 1) {
        if (portraitRanges[i].start < portraitRanges[i - 1].end) {
            throw new Error(`NPC State Delta bundle contains overlapping portrait data for ${portraitRanges[i].name}.`);
        }
    }

    return {
        metadata: {
            appVersion: manifest.appVersion || '',
            exportedAt: manifest.exportedAt || '',
            sourceChatKey: manifest.sourceChatKey || '',
            formatVersion: manifest.formatVersion,
        },
        state: {
            npcs,
            socialGraph: normalizeSocialGraph(manifest.state.socialGraph),
            dismissed: Array.isArray(manifest.state.dismissed) ? [...manifest.state.dismissed] : [],
        },
    };
}

function npcKeys(npc) {
    return [...new Set([npc?.name, ...(Array.isArray(npc?.aliases) ? npc.aliases : [])]
        .map(normalizeName)
        .filter(Boolean))];
}

function identityMatchIndex(records, npc, { stableIdOnly = false } = {}) {
    const available = records.map((candidate, index) => ({ candidate, index }));
    const incomingKeys = new Set(npcKeys(npc));
    const incomingName = normalizeName(npc?.name);
    const sameId = npc?.id
        ? available.find(entry => String(entry.candidate?.id || '') === String(npc.id))
        : null;
    if (sameId) {
        const candidateKeys = npcKeys(sameId.candidate);
        const labelsAgree = candidateKeys.some(key => incomingKeys.has(key));
        if (labelsAgree || !incomingKeys.size || !candidateKeys.length) return sameId.index;
        // Same stable id with wholly disjoint identity labels is treated as an id collision,
        // not proof that two unrelated dossiers are the same person.
    }
    // An ID-backed deletion tombstone proves that this imported stable id belongs to an older
    // identity. Never collapse it into a different current homonym merely because the names match.
    if (stableIdOnly && npc?.id) return -1;

    if (incomingName) {
        const canonical = available.filter(entry => normalizeName(entry.candidate?.name) === incomingName);
        if (canonical.length === 1) return canonical[0].index;
        if (canonical.length > 1) return -1;
    }

    const aliasMatches = available.filter(entry => npcKeys(entry.candidate).some(key => incomingKeys.has(key)));
    return aliasMatches.length === 1 ? aliasMatches[0].index : -1;
}

function uniqueImportedId(npc, usedIds) {
    const stem = normalizeName(npc?.name || 'npc')
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'npc';
    let counter = 1;
    let id = `npc_import_${stem}`;
    while (usedIds.has(id)) {
        counter += 1;
        id = `npc_import_${stem}_${counter}`;
    }
    return id.slice(0, 100);
}

function filterGraphByIds(graph, validIds, rejectedSourceIds = new Set()) {
    const normalized = normalizeSocialGraph(graph);
    return normalizeSocialGraph({
        edges: normalized.edges.filter(edge => !rejectedSourceIds.has(edge.aId)
            && !rejectedSourceIds.has(edge.bId)
            && validIds.has(edge.aId)
            && validIds.has(edge.bId)),
        unresolved: normalized.unresolved.filter(slot => !rejectedSourceIds.has(slot.ownerId) && validIds.has(slot.ownerId)),
    });
}

function initImportReport(report) {
    if (!report || typeof report !== 'object') return null;
    report.updated = [];
    report.added = [];
    report.skipped = [];
    report.idRemaps = [];
    report.accepted = [];
    return report;
}

const IMPORT_LOCKED_FIELD_KEYS = Object.freeze({
    name: ['name', 'identityKind'],
    role: ['role'],
    species: ['species'],
    gender: ['gender'],
    homeBase: ['homeBase'],
    age: ['age'],
    apparentAge: ['apparentAge'],
    appearance: ['appearance', 'overallAppearance', 'unclassifiedAppearance', 'appearanceForms', 'currentForm', 'currentFormUnknown', 'appearanceModelVersion'],
    personality: ['personality'],
    speech: ['speech'],
    behaviorProfile: ['behaviorProfile'],
    background: ['background'],
    mannerisms: ['mannerisms'],
    keyRelationships: ['keyRelationships'],
});

function preserveTargetManualLocks(oldNpc, importedNpc) {
    const targetLocks = new Set(Array.isArray(oldNpc?.manualProfileFields) ? oldNpc.manualProfileFields : []);
    const sourceLocks = new Set(Array.isArray(importedNpc?.manualProfileFields) ? importedNpc.manualProfileFields : []);
    const merged = { ...oldNpc, ...importedNpc };
    for (const field of targetLocks) {
        for (const key of IMPORT_LOCKED_FIELD_KEYS[field] || []) {
            if (Object.prototype.hasOwnProperty.call(oldNpc || {}, key)) merged[key] = structuredClone(oldNpc[key]);
            else delete merged[key];
        }
    }
    merged.manualProfileFields = [...new Set([...targetLocks, ...sourceLocks])];
    merged.manualProfileLocksExplicit = Boolean(
        oldNpc?.manualProfileLocksExplicit || importedNpc?.manualProfileLocksExplicit || merged.manualProfileFields.length,
    );
    return merged;
}

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

    for (const rawNpc of imported) {
        const npc = structuredClone(rawNpc);
        const sourceId = String(npc.id || '');
        const index = identityMatchIndex(npcs, npc, { stableIdOnly: Boolean(sourceId && tombstonedIds.has(sourceId)) });
        if (index >= 0) {
            const old = npcs[index];
            const wasActive = !old?.archived;
            const targetId = old.id;
            importedIdMap.set(sourceId, targetId);
            if (usedTargetIndexes.has(index)) {
                importReport?.skipped.push({ sourceId, id: targetId, name: npc.name, reason: 'duplicate-identity' });
                continue;
            }
            usedTargetIndexes.add(index);
            const lockAware = preserveTargetManualLocks(old, npc);
            const effectiveName = String(lockAware.name || npc.name || old.name || '').trim();
            const merged = normalizeNpcRecord({
                ...lockAware,
                id: targetId,
                aliases: [...new Set([
                    ...(old.aliases || []),
                    ...(npc.aliases || []),
                    old.name,
                    npc.name,
                ])]
                    .filter(Boolean)
                    .filter(alias => normalizeName(alias) !== normalizeName(effectiveName))
                    .slice(0, 8),
                portrait: npc.portrait?.dataUrl ? structuredClone(npc.portrait) : old.portrait || npc.portrait || null,
                // Activity counters are chat-local clocks. A foreign dossier may update durable
                // characterization, but cannot move an existing target record backward or forward
                // on an unrelated source turn axis.
                ...(foreignActivity ? {
                    lastSeenTurn: old.lastSeenTurn,
                    lastWorldActiveTurn: old.lastWorldActiveTurn,
                    fieldChanges: old.fieldChanges || {},
                } : {}),
            });
            const accepted = isTerminalNpcDeath(old) ? protectTerminalNpc(old, merged) : merged;
            npcs[index] = accepted;
            const isActive = !accepted?.archived;
            if (wasActive !== isActive) activeCount += isActive ? 1 : -1;
            importReport?.updated.push({ sourceId, id: targetId, name: accepted.name });
            importReport?.accepted.push({ sourceId, id: targetId, name: accepted.name, status: 'updated' });
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
    });
    for (const [fromId, toId] of importedIdMap.entries()) {
        if (fromId && toId && fromId !== toId) importedGraph = remapSocialGraphNpcId(importedGraph, fromId, toId);
    }
    const validIds = new Set(npcs.map(npc => String(npc?.id || '')).filter(Boolean));
    importedGraph = filterGraphByIds(importedGraph, validIds);
    const currentGraph = filterGraphByIds(current.socialGraph, validIds);
    const socialGraph = normalizeSocialGraph({
        edges: [...currentGraph.edges, ...importedGraph.edges],
        unresolved: [...currentGraph.unresolved, ...importedGraph.unresolved],
    });

    return {
        ...current,
        npcs,
        socialGraph,
        dismissed,
        lastScannedMessageId: null,
        assistantSinceScan: 0,
    };
}
