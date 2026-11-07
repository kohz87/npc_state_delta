/* NPC State Delta branch tracking (role: branch-tracking). What a chat remembers about its own branch: the checkpoint a state change records and the
   lineage a chat is seeded with, the host's swipe state, the dossiers a new branch inherits from its explicit parent chat, and the stale-host mark that
   keeps a chat shorter than its adopted dossier from rolling that dossier back. Built by index.js once per module instance with the shared runtime
   state. Bodies are moved from index.js without change. */

import { chatContext as getContext } from './runtime-scan-helpers.js';
import { BRANCH_LINEAGE_VERSION, bestAncestorState, chatLineage, firstLineageDivergence, recordBranchCheckpoint, setBranchProvenanceHint } from './branch.js';
import { currentWriterId } from './storage.js';
import { buildQualifiedChatKey, parseQualifiedChatKey } from './identity.js';
import { getSettings } from './runtime-settings.js';

export function createBranchPart(rt, deps) {
    const { ensureChatStateLoaded, evictDormantChatStates, freshChatState, getChatKey, getChatState, isCanonicalChatKey, queueStateFileWrite, requestHeaders, setChatState } = deps;
    const { chatStateCache, missingSidecarChats, branchInheritanceChecked, staleHostChats, openingHostChats } = rt;

    function commitBranchCheckpoint(state, messageId, reason = 'state') {
        // A checkpoint records the local chat as the lineage; on a stale chat that would truncate the
        // adopted dossier's newer history.
        if (staleHostActive()) return state;
        recordBranchCheckpoint(state, getContext().chat || [], messageId, reason);
        return state;
    }

    function seedBranchTracking(state = getChatState()) {
        const lineage = chatLineage(getContext().chat || []);
        if (!Array.isArray(state.lineage) || state.lineage.length === 0) state.lineage = lineage;
        if (!Array.isArray(state.checkpoints)) state.checkpoints = [];
        state.branchLineageVersion = BRANCH_LINEAGE_VERSION;
        return state;
    }

    function hostSwipeState() {
        try {
            const state = getContext().swipe?.state?.();
            return typeof state === 'string' && state ? state : 'none';
        } catch {
            return 'none';
        }
    }

    function isHostSwipeActive() {
        return hostSwipeState() !== 'none';
    }

    // A nonempty array can still be the first chunk of a loading chat. Only the host's complete file can prove an automatic
    // destructive reconcile or a branch inheritance has the whole chat; an unavailable or changing file fails closed.
    async function hostChatComplete(key, { absentOk = false } = {}) {
        const place = parseQualifiedChatKey(key);
        if (!place || getChatKey() !== key) return false;
        const context = getContext();
        const sequence = rt.chatOpenSequence || 0;
        const lineage = chatLineage(context.chat || []);
        const parent = String((context.chatMetadata || context.chat_metadata || {}).main_chat || '').replace(/\.jsonl$/i, '').trim();
        const character = context.characters?.[context.characterId];
        const body = place.kind === 'group' ? { id: place.chatId } : { ch_name: String(character?.name || ''), file_name: place.chatId, avatar_url: place.ownerId };
        const controller = new AbortController();
        let timer;
        try {
            const read = (async () => {
                const response = await globalThis.fetch(place.kind === 'group' ? '/api/chats/group/get' : '/api/chats/get', {
                    method: 'POST', headers: requestHeaders(), cache: 'no-cache', body: JSON.stringify(body), signal: controller.signal,
                });
                // A host that has no file for this chat (404) cannot disagree with the array it loaded; only a rollback with a non-empty chat accepts that.
                if (!response?.ok) return absentOk && response?.status === 404 && lineage.length > 0 && getChatKey() === key && (rt.chatOpenSequence || 0) === sequence;
                const data = await response.json();
                if (!Array.isArray(data) || !data[0] || typeof data[0] !== 'object' || !Object.hasOwn(data[0], 'chat_metadata')
                    || !data[0].chat_metadata || typeof data[0].chat_metadata !== 'object' || Array.isArray(data[0].chat_metadata)) return false;
                if (data.slice(1).some(message => !message || typeof message !== 'object' || Array.isArray(message))) return false;
                const diskParent = String(data[0].chat_metadata?.main_chat || '').replace(/\.jsonl$/i, '').trim();
                const now = getContext();
                const nowParent = String((now.chatMetadata || now.chat_metadata || {}).main_chat || '').replace(/\.jsonl$/i, '').trim();
                return getChatKey() === key && (rt.chatOpenSequence || 0) === sequence && parent === nowParent && parent === diskParent
                    && firstLineageDivergence(lineage, chatLineage(now.chat || [])) === -1
                    && firstLineageDivergence(lineage, chatLineage(data.slice(1))) === -1;
            })();
            const timeout = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(false); }, 2000); });
            return await Promise.race([read, timeout]);
        } catch {
            return false;
        } finally {
            clearTimeout(timer);
        }
    }

    async function maybeInheritKnownBranch() {
        const key = getChatKey();
        const sequence = rt.chatOpenSequence || 0;
        if (key === 'no-chat' || !isCanonicalChatKey(key)) return false;
        try {
            await ensureChatStateLoaded(key);
            if (getChatKey() !== key || (rt.chatOpenSequence || 0) !== sequence) return false;
            const current = getChatState(key);
            const chat = getContext().chat || [];
            const lineageAtStart = chatLineage(chat);
            // (Message tracking alone, never saved to a file of the chat's own, does not make a branch a chat of its own: Story Block's save point
            // opens the branch for a moment and goes back, which can leave it seeded in memory, and "Return here" must still carry the dossiers.)
            const unsaved = !getSettings().dataFiles?.[key]?.path;
            const isEmptyState = !current.npcs.length && !current.candidates.length && !current.dismissed.length && !current.checkpoints.length && (!current.lineage.length || unsaved);
            if (!isEmptyState) { branchInheritanceChecked.add(key); return false; }
            const stillEmpty = () => getChatState(key) === current && !current.npcs.length && !current.candidates.length && !current.dismissed.length
                && !current.checkpoints.length && (!current.lineage.length || !getSettings().dataFiles?.[key]?.path);

            // Even the parent metadata may still be loading. Do not decide inheritance, or let the participant mint a line, until the host file agrees.
            if (!await hostChatComplete(key)) return false;
            if (getChatKey() !== key || (rt.chatOpenSequence || 0) !== sequence || !stillEmpty() || firstLineageDivergence(lineageAtStart, chatLineage(getContext().chat || [])) !== -1) return false;

            const metadata = getContext().chatMetadata || getContext().chat_metadata || {};
            const mainChat = String(metadata?.main_chat || '').replace(/\.jsonl$/i, '').trim();
            const parsed = parseQualifiedChatKey(key);
            const explicitParentKey = mainChat && parsed ? buildQualifiedChatKey(parsed.kind, parsed.ownerId, mainChat) : '';
            const hasExplicitParent = Boolean(explicitParentKey && explicitParentKey !== key);
            if (!hasExplicitParent) branchInheritanceChecked.add(key);
            if (!hasExplicitParent) return false;

            try { await ensureChatStateLoaded(explicitParentKey); }
            catch (error) { console.debug(`[NPC State Delta] explicit branch parent ${explicitParentKey} could not be hydrated.`, error); return false; }
            const currentMetadata = getContext().chatMetadata || getContext().chat_metadata || {};
            if (getChatKey() !== key || (rt.chatOpenSequence || 0) !== sequence || !stillEmpty() || String(currentMetadata.main_chat || '').replace(/\.jsonl$/i, '').trim() !== mainChat
                || firstLineageDivergence(lineageAtStart, chatLineage(getContext().chat || [])) !== -1) return false;
            const parentState = chatStateCache.get(explicitParentKey);
            // The branch's own provenance: the hint was installed for the chat open at startup only, so a branch opened later (a save point's
            // "Return here") was matched against the wrong main chat and inherited nothing.
            setBranchProvenanceHint({ mainChat, currentKey: key });
            const inherited = bestAncestorState(parentState ? { [explicitParentKey]: parentState } : {}, key, chat);
            // (decided: inherited or nothing to inherit; a return because another chat was opened meanwhile decides nothing)
            branchInheritanceChecked.add(key);
            if (!inherited) return false;
            setChatState(key, { ...freshChatState(), ...inherited });
            queueStateFileWrite(key, 0);
            return true;
        } finally {
            evictDormantChatStates(key);
        }
    }

    /**
     * (timeline participant) An unverified chat without a dossier file may be a branch whose metadata is still loading. The participant waits
     * until inheritance has been decided, so it cannot mint a line before the parent's dossiers are carried over.
     */
    function branchInheritancePending(key = getChatKey()) {
        if (!isCanonicalChatKey(key) || branchInheritanceChecked.has(key)) return false;
        if (!missingSidecarChats.has(key) || getSettings().dataFiles?.[key]?.path) return false;
        return true;
    }


    // After adopting another session's newer dossier, the local chat is stale when it does not contain
    // that dossier's whole history: an older prefix, or older history plus a turn typed locally since.
    function noteAdoptedDossier(key, state, writerId = '') {
        if (key !== getChatKey() || openingHostChats.has(key)) return;
        if (writerId && String(writerId) === currentWriterId()) return;
        const stored = Array.isArray(state?.lineage) ? state.lineage : [];
        const divergence = firstLineageDivergence(stored, chatLineage(getContext().chat || []));
        if (stored.length && divergence !== -1 && divergence < stored.length) staleHostChats.add(key);
    }

    // Messages this browser adds locally (a new turn, a reply) do not load the missing remote history,
    // so only a host reload or a local chat that contains the whole adopted lineage clears the mark.
    function staleHostActive(key = getChatKey()) {
        if (!staleHostChats.has(key) || key !== getChatKey()) return false;
        const stored = Array.isArray(getChatState(key)?.lineage) ? getChatState(key).lineage : [];
        const live = chatLineage(getContext().chat || []);
        if (live.length >= stored.length && [-1, stored.length].includes(firstLineageDivergence(stored, live))) {
            staleHostChats.delete(key);
            return false;
        }
        return true;
    }

    function staleHostPrefix(key, operation, explicitDivergence) {
        if (String(operation || 'auto') !== 'auto' || Number.isInteger(explicitDivergence)) return false;
        return staleHostActive(key);
    }

    return { commitBranchCheckpoint, seedBranchTracking, hostSwipeState, isHostSwipeActive, hostChatComplete, maybeInheritKnownBranch, branchInheritancePending, noteAdoptedDossier, staleHostActive, staleHostPrefix };
}
