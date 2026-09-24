import { buildQualifiedChatKey, chatOwnerScope, parseQualifiedChatKey } from './identity.js';

export function resolveGroupOwnerId(groups = [], chatId = '') {
    const id = String(chatId ?? '').replace(/\.jsonl$/i, '').trim();
    if (!id) return '';
    const matches = (Array.isArray(groups) ? groups : []).filter(group => {
        const chats = Array.isArray(group?.chats) ? group.chats : [];
        return chats.some(chat => String(chat ?? '').replace(/\.jsonl$/i, '').trim() === id)
            || String(group?.chat_id ?? '').replace(/\.jsonl$/i, '').trim() === id;
    }).map(group => String(group?.id ?? '').trim()).filter(Boolean);
    return [...new Set(matches)].length === 1 ? matches[0] : '';
}

export function allSettingsKeys(settings = {}) {
    const maps = ['dataFiles', 'sidecarTombstones', 'recoveryFiles'];
    const keys = new Set();
    for (const mapName of maps) for (const key of Object.keys(settings?.[mapName] || {})) keys.add(key);
    return [...keys];
}

export function qualifiedKeysForOwner(settings = {}, kind = 'chat', ownerId = '') {
    const owner = String(ownerId || '').trim();
    return allSettingsKeys(settings).filter(key => {
        const parsed = parseQualifiedChatKey(key);
        return parsed?.kind === kind && parsed.ownerId === owner;
    });
}

export function uniqueQualifiedKeyForChat(settings = {}, kind = 'chat', chatId = '', ownerIdHint = '') {
    const id = String(chatId ?? '').replace(/\.jsonl$/i, '').trim();
    if (!id) return '';
    const hint = String(ownerIdHint || '').trim();
    const candidates = allSettingsKeys(settings).filter(key => {
        const parsed = parseQualifiedChatKey(key);
        return parsed?.kind === kind && parsed.chatId === id;
    });
    if (hint) {
        const direct = buildQualifiedChatKey(kind, hint, id);
        if (candidates.includes(direct)) return direct;
    }
    if (candidates.length === 1) return candidates[0];
    return '';
}

export function destinationKeyForOwnerRename(oldKey, newOwnerId) {
    const parsed = parseQualifiedChatKey(oldKey);
    if (!parsed || parsed.kind !== 'chat') return '';
    return buildQualifiedChatKey('chat', newOwnerId, parsed.chatId);
}


export function applyCanonicalOwnershipMove(config = {}, { oldKey = '', newKey = '', newPointer = null, recoveryPointer = null, reason = 'renamed' } = {}) {
    if (!oldKey || !newKey || oldKey === newKey) return config;
    for (const name of ['dataFiles', 'sidecarTombstones', 'recoveryFiles']) {
        if (!config[name] || typeof config[name] !== 'object') config[name] = {};
    }
    if (recoveryPointer) config.recoveryFiles[oldKey] = recoveryPointer;
    config.sidecarTombstones[oldKey] = { reason: `${String(reason || 'renamed')}:${newKey}`, at: Date.now() };
    const predecessorTombstone = config.sidecarTombstones?.[oldKey] || null;
    if (newPointer) {
        config.dataFiles[newKey] = newPointer;
        // Only a verified live sidecar may supersede a previous retirement marker. Tombstone-only
        // history must never clear an unrelated destination tombstone during an owner rename.
        delete config.sidecarTombstones[newKey];
    } else if (predecessorTombstone && !config.dataFiles?.[newKey] && !config.sidecarTombstones[newKey]) {
        config.sidecarTombstones[newKey] = {
            ...structuredClone(predecessorTombstone),
            reason: `${String(reason || 'renamed')}-retired:${oldKey}`,
            at: Date.now(),
        };
    }    delete config.dataFiles[oldKey];    return config;
}


export function liveLifecycleCandidateKeys(settings = {}, cacheKeys = [], kind = 'chat', chatId = '') {
    const id = String(chatId ?? '').replace(/\.jsonl$/i, '').trim();
    if (!id) return [];
    const keys = new Set([
        ...Object.keys(settings?.dataFiles || {}),
        ...(cacheKeys ? [...cacheKeys] : []),
    ]);
    return [...keys].filter(key => {
        if (settings?.sidecarTombstones?.[key]) return false;
        const parsed = parseQualifiedChatKey(key);
        return parsed?.kind === kind && parsed.chatId === id;
    });
}

export function resolveOwnedLifecycleKey(candidates = [], kind = 'chat', chatId = '', ownerId = '', ownerWasProvided = false) {
    const id = String(chatId ?? '').replace(/\.jsonl$/i, '').trim();
    const owner = String(ownerId || '').trim();
    if (!id) return '';
    const unique = [...new Set(Array.isArray(candidates) ? candidates : [])];
    const direct = buildQualifiedChatKey(kind, owner, id);
    if (ownerWasProvided) return direct && unique.includes(direct) ? direct : '';
    if (direct && unique.includes(direct)) return direct;
    return unique.length === 1 ? unique[0] : '';
}

export function resolveDeletedLifecycleKeyFromPresence(candidates = [], presence = []) {
    const unique = [...new Set(Array.isArray(candidates) ? candidates : [])];
    if (!unique.length) return '';
    const byKey = new Map((Array.isArray(presence) ? presence : []).map(item => [String(item?.key || ''), item?.value]));
    if (unique.some(key => !byKey.has(key) || ![true, false].includes(byKey.get(key)))) return '';
    const absent = unique.filter(key => byKey.get(key) === false);
    const present = unique.filter(key => byKey.get(key) === true);
    return absent.length === 1 && present.length === unique.length - 1 ? absent[0] : '';
}

export function lifecycleRenameStateIsEmpty(state) {
    if (!state || typeof state !== 'object') return true;
    const graph = state.socialGraph && typeof state.socialGraph === 'object' ? state.socialGraph : {};
    const root = state.branchRootSnapshot && typeof state.branchRootSnapshot === 'object'
        ? Object.keys(state.branchRootSnapshot).length > 0
        : false;
    const portraits = state.portraitAssets && typeof state.portraitAssets === 'object'
        ? Object.keys(state.portraitAssets).length > 0
        : false;
    return !(state.npcs?.length
        || state.candidates?.length
        || state.dismissed?.length
        || state.checkpoints?.length
        || state.inlineCards?.length
        || state.userDismissedGroups?.length
        || state.pendingBackfills?.length
        || graph.edges?.length
        || graph.unresolved?.length
        || root
        || portraits);
}
