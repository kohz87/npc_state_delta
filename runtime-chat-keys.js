/* NPC State Delta chat keys (role: chat-keys). Which chat a state belongs to: the owner-qualified key of the open chat, the keys a rename or delete
   event can mean (checked against what the host still lists), the loaded-chat cache's touch and eviction, and the ownership epoch that lets a late
   completion find out its chat was deleted, renamed or detached meanwhile. Built by index.js once per module instance with the shared runtime state.
   Bodies are moved from index.js without change. */

import { getContext } from '../../../extensions.js';
import { getCharacterOwnerId, getChatIdentityFromContext, isQualifiedChatKey, parseQualifiedChatKey } from './identity.js';
import { liveLifecycleCandidateKeys, resolveDeletedLifecycleKeyFromPresence, resolveOwnedLifecycleKey } from './hardening-core.js';
import { getSettings } from './runtime-settings.js';

export function createChatKeysPart(rt, deps) {
    const { isScanBusy, requestHeaders } = deps;
    const { chatStateCache, hydratedChatKeys, hydratedStateMeta, freshnessChecks, missingSidecarChats, loadingChatStates, hydrationErrors, pendingAutoScans, assistantReceipts, stateWriteTimers, stateWritePromises, stateVersions, persistedVersions, ownershipEpochs, chatCacheTouches } = rt;

    const CHAT_CACHE_LIMIT = 6;

    function getChatIdentity(ctx = getContext()) {
        return getChatIdentityFromContext(ctx);
    }

    function getChatKey() {
        return getChatIdentity().key;
    }

    function isCanonicalChatKey(key = getChatKey()) {
        return isQualifiedChatKey(key);
    }

    function resolveOwnedChatKey(rawId, kind = 'chat', ownerId = undefined) {
        const id = String(rawId ?? '').replace(/\.jsonl$/i, '').trim();
        if (!id) return '';
        const ownerWasProvided = ownerId !== undefined;
        const resolvedOwner = String(ownerWasProvided ? (ownerId || '') : (kind === 'group' ? getContext().groupId || '' : getCharacterOwnerId(getContext()))).trim();
        const settings = getSettings();
        const candidates = liveLifecycleCandidateKeys(settings, chatStateCache.keys(), kind, id);
        const resolved = resolveOwnedLifecycleKey(candidates, kind, id, resolvedOwner, ownerWasProvided);
        if (!resolved && candidates.length > 1) {
            console.warn(`[NPC State Delta] refused ambiguous ${kind} lifecycle lookup for ${id}; ${candidates.length} live owner-qualified states share that chat id.`);
        }
        return resolved;
    }

    function lifecycleCandidateKeys(rawId, kind = 'chat') {
        const id = String(rawId ?? '').replace(/\.jsonl$/i, '').trim();
        return liveLifecycleCandidateKeys(getSettings(), chatStateCache.keys(), kind, id);
    }

    async function hostCharacterChatPresence(ownerId, rawId) {
        const owner = String(ownerId || '').trim();
        const id = String(rawId ?? '').replace(/\.jsonl$/i, '').trim();
        if (!owner || !id) return null;
        try {
            const response = await globalThis.fetch?.('/api/characters/chats', {
                method: 'POST',
                headers: requestHeaders(),
                body: JSON.stringify({ avatar_url: owner, simple: true }),
            });
            if (!response?.ok) return null;
            const data = typeof response.json === 'function' ? await response.json() : null;
            if (!data || typeof data !== 'object') return null;
            const chats = Array.isArray(data) ? data : Object.values(data);
            return chats.some(item => String(item?.file_name ?? item?.fileName ?? item?.name ?? '').replace(/\.jsonl$/i, '').trim() === id);
        } catch (error) {
            console.debug(`[NPC State Delta] host ownership probe failed for ${owner}/${id}.`, error);
            return null;
        }
    }

    function hostGroupChatPresence(ownerId, rawId) {
        const owner = String(ownerId || '').trim();
        const id = String(rawId ?? '').replace(/\.jsonl$/i, '').trim();
        const groups = getContext()?.groups;
        if (!owner || !id || !Array.isArray(groups)) return null;
        const group = groups.find(item => String(item?.id ?? '').trim() === owner);
        if (!group) return false;
        const chats = [
            ...(Array.isArray(group?.chats) ? group.chats : []),
            group?.chat_id,
        ].map(value => String(value ?? '').replace(/\.jsonl$/i, '').trim()).filter(Boolean);
        return chats.includes(id);
    }

    async function resolveDeletedChatKey(rawId, kind = 'chat', ownerId = '') {
        const id = String(rawId ?? '').replace(/\.jsonl$/i, '').trim();
        if (!id) return '';
        const hint = String(ownerId || '').trim();
        if (hint) return resolveOwnedChatKey(id, kind, hint);
        const candidates = lifecycleCandidateKeys(id, kind);
        if (!candidates.length) return '';

        const presence = [];
        for (const key of candidates) {
            const parsed = parseQualifiedChatKey(key);
            if (!parsed) continue;
            const value = kind === 'group'
                ? hostGroupChatPresence(parsed.ownerId, id)
                : await hostCharacterChatPresence(parsed.ownerId, id);
            presence.push({ key, value });
        }
        if (presence.some(item => item.value === null)) {
            const error = new Error(`NPC State Delta could not prove deleted ${kind} ${id} ownership because the SillyTavern ownership probe was unavailable.`);
            error.code = 'NPC_STATE_DELETE_OWNERSHIP_UNAVAILABLE';
            throw error;
        }
        const resolved = resolveDeletedLifecycleKeyFromPresence(candidates, presence);
        if (resolved) {
            console.info(`[NPC State Delta] resolved deleted ${kind} ${id} from authoritative host ownership: ${resolved}.`);
            return resolved;
        }
        console.warn(`[NPC State Delta] preserved deleted ${kind} ${id}; host ownership did not prove one unique removed owner.`);
        return '';
    }

    function touchChatCache(key) {
        if (!isCanonicalChatKey(key)) return;
        chatCacheTouches.set(key, Date.now());
    }

    function forgetCachedChat(key) {
        if (!key || key === getChatKey()) return false;
        if (stateWriteTimers.has(key) || stateWritePromises.has(key) || loadingChatStates.has(key) || isScanBusy(key)) return false;
        chatStateCache.delete(key);
        hydratedChatKeys.delete(key);
        hydratedStateMeta.delete(key);
        freshnessChecks.delete(key);
        missingSidecarChats.delete(key);
        hydrationErrors.delete(key);
        pendingAutoScans.delete(key);
        assistantReceipts.delete(key);
        stateVersions.delete(key);
        persistedVersions.delete(key);
        chatCacheTouches.delete(key);
        return true;
    }

    function evictDormantChatStates(activeKey = getChatKey(), limit = CHAT_CACHE_LIMIT) {
        const cap = Math.max(2, Number(limit) || CHAT_CACHE_LIMIT);
        const loaded = [...chatStateCache.keys()].filter(isCanonicalChatKey);
        if (loaded.length <= cap) return 0;
        const candidates = loaded
            .filter(key => key !== activeKey)
            .sort((a, b) => Number(chatCacheTouches.get(a) || 0) - Number(chatCacheTouches.get(b) || 0));
        let removed = 0;
        for (const key of candidates) {
            if (chatStateCache.size <= cap) break;
            if (forgetCachedChat(key)) removed += 1;
        }
        return removed;
    }

    function ownershipEpoch(key) {
        return Number(ownershipEpochs.get(String(key || '')) || 0);
    }

    function bumpOwnershipEpoch(key) {
        const normalized = String(key || '');
        if (!normalized || normalized === 'no-chat') return 0;
        const next = ownershipEpoch(normalized) + 1;
        ownershipEpochs.set(normalized, next);
        loadingChatStates.delete(normalized);
        missingSidecarChats.delete(normalized);
        return next;
    }

    function ownershipEpochCurrent(key, epoch) {
        return ownershipEpoch(key) === Number(epoch || 0);
    }

    function staleOwnershipError(key) {
        const error = new Error(`NPC State Delta ownership changed while loading ${key}; stale completion was discarded.`);
        error.code = 'NPC_STATE_STALE_OWNERSHIP';
        return error;
    }

    function assertOwnershipEpoch(key, epoch) {
        if (!ownershipEpochCurrent(key, epoch)) throw staleOwnershipError(key);
    }

    return { getChatKey, isCanonicalChatKey, resolveOwnedChatKey, resolveDeletedChatKey, touchChatCache, evictDormantChatStates, ownershipEpoch, bumpOwnershipEpoch, ownershipEpochCurrent, staleOwnershipError, assertOwnershipEpoch };
}
