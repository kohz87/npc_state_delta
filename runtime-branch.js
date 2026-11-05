/* NPC State Delta branch tracking (role: branch-tracking). What a chat remembers about its own branch: the checkpoint a state change records and the
   lineage a chat is seeded with, the host's swipe state, the dossiers a new branch inherits from its explicit parent chat, and the stale-host mark that
   keeps a chat shorter than its adopted dossier from rolling that dossier back. Built by index.js once per module instance with the shared runtime
   state. Bodies are moved from index.js without change. */

import { getContext } from '../../../extensions.js';
import { BRANCH_LINEAGE_VERSION, bestAncestorState, chatLineage, firstLineageDivergence, recordBranchCheckpoint, setBranchProvenanceHint } from './branch.js';
import { currentWriterId } from './storage.js';
import { buildQualifiedChatKey, parseQualifiedChatKey } from './identity.js';
import { getSettings } from './runtime-settings.js';

export function createBranchPart(rt, deps) {
    const { ensureChatStateLoaded, evictDormantChatStates, freshChatState, getChatKey, getChatState, isCanonicalChatKey, queueStateFileWrite, setChatState } = deps;
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

    async function maybeInheritKnownBranch() {
        const key = getChatKey();
        if (key === 'no-chat' || !isCanonicalChatKey(key)) return false;
        try {
            await ensureChatStateLoaded(key);
            if (getChatKey() !== key) return false;
            const current = getChatState(key);
            const chat = getContext().chat || [];
            const lineageAtStart = chatLineage(chat);
            // (Message tracking alone, never saved to a file of the chat's own, does not make a branch a chat of its own: Story Block's save point
            // opens the branch for a moment and goes back, which can leave it seeded in memory, and "Return here" must still carry the dossiers.)
            const unsaved = !getSettings().dataFiles?.[key]?.path;
            const isEmptyState = !current.npcs.length && !current.candidates.length && !current.dismissed.length && !current.checkpoints.length && (!current.lineage.length || unsaved);
            if (!isEmptyState) { branchInheritanceChecked.add(key); return false; }

            const metadata = getContext().chatMetadata || getContext().chat_metadata || {};
            const mainChat = String(metadata?.main_chat || '').replace(/\.jsonl$/i, '').trim();
            const parsed = parseQualifiedChatKey(key);
            const explicitParentKey = mainChat && parsed ? buildQualifiedChatKey(parsed.kind, parsed.ownerId, mainChat) : '';
            const hasExplicitParent = Boolean(explicitParentKey && explicitParentKey !== key);
            if (!hasExplicitParent) branchInheritanceChecked.add(key);
            if (!hasExplicitParent) return false;

            await ensureChatStateLoaded(explicitParentKey).catch(error => console.debug(`[NPC State Delta] explicit branch parent ${explicitParentKey} could not be hydrated.`, error));
            if (getChatKey() !== key || firstLineageDivergence(lineageAtStart, chatLineage(getContext().chat || [])) !== -1) return false;
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
     * (timeline participant) Whether the open chat is a branch still waiting for its parent's dossiers: no dossier file of its own, its metadata
     * names a main chat, and branch inheritance has not run for it in this session. The participant mints no story line for such a chat.
     */
    function branchInheritancePending(key = getChatKey()) {
        if (!isCanonicalChatKey(key) || branchInheritanceChecked.has(key)) return false;
        if (!missingSidecarChats.has(key) || getSettings().dataFiles?.[key]?.path) return false;
        const metadata = getContext().chatMetadata || getContext().chat_metadata || {};
        return Boolean(String(metadata?.main_chat || '').replace(/\.jsonl$/i, '').trim());
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

    return { commitBranchCheckpoint, seedBranchTracking, hostSwipeState, isHostSwipeActive, maybeInheritKnownBranch, branchInheritancePending, noteAdoptedDossier, staleHostActive, staleHostPrefix };
}
