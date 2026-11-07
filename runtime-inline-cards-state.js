/* NPC State Delta inline-card state records: recording, clearing, removing and purging the
   per-message inlineCards history, plus the present-card lookup helpers. Split from
   runtime-inline-cards.js with unchanged function bodies; the original factory closure is passed
   in explicitly and the original path keeps the public exports. */

import { chatContext as getContext } from './runtime-scan-helpers.js';
import { snapshotNpc } from './src/fields/registry.js';
import { npcMatchesLabel, normalizeName } from './core.js';
import { fingerprintMessage } from './branch.js';

export function createInlineCardsStatePart(deps) {
    const { chatHydrationStatus, currentLineageKeyForMessage, getChatKey, getChatState, INLINE_HISTORY_LIMIT } = deps;

    function recordInlineCardsInState(state, messageId, npcIds, reason = 'scan') {
        if (!Number.isInteger(messageId) || messageId < 0) return state;
        if (!Array.isArray(state.inlineCards)) state.inlineCards = [];
        const ids = [...new Set((npcIds || []).filter(Boolean))];
        const cards = ids.map(id => state.npcs.find(npc => npc.id === id)).filter(Boolean).map(snapshotNpc);
        if (!cards.length) return state;
        const messageFingerprint = fingerprintMessage((getContext().chat || [])[messageId] || {});
        const lineageKey = currentLineageKeyForMessage(messageId);
        let entry = state.inlineCards.find(item => lineageKey && item.lineageKey === lineageKey);
        if (!entry) {
            entry = { messageId, fingerprint: messageFingerprint, lineageKey, reason, createdAt: Date.now(), cards: [] };
            state.inlineCards.push(entry);
        }
        entry.messageId = messageId;
        entry.fingerprint = messageFingerprint;
        entry.lineageKey = lineageKey;
        entry.reason = reason || entry.reason;
        entry.createdAt = Date.now();
        for (const card of cards) {
            const index = entry.cards.findIndex(existing => existing.id === card.id);
            if (index >= 0) entry.cards[index] = card;
            else entry.cards.push(card);
        }
        state.inlineCards.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
        if (state.inlineCards.length > INLINE_HISTORY_LIMIT) state.inlineCards.splice(0, state.inlineCards.length - INLINE_HISTORY_LIMIT);
        return state;
    }

    function clearInlineCardsAtMessage(state, messageId) {
        if (!Array.isArray(state.inlineCards)) state.inlineCards = [];
        const lineageKey = currentLineageKeyForMessage(messageId);
        state.inlineCards = state.inlineCards.filter(entry => {
            if (lineageKey && entry?.lineageKey) return entry.lineageKey !== lineageKey;
            return !(Number(entry?.messageId) === Number(messageId) && entry?.fingerprint === fingerprintMessage((getContext().chat || [])[messageId] || {}));
        });
        return state;
    }

    function removeNpcInlineCardAtMessage(state, messageId, npcId) {
        if (!Array.isArray(state.inlineCards) || !Number.isInteger(messageId) || messageId < 0 || !npcId) return state;
        const lineageKey = currentLineageKeyForMessage(messageId);
        state.inlineCards = state.inlineCards.map(entry => {
            const matches = lineageKey && entry?.lineageKey
                ? entry.lineageKey === lineageKey
                : Number(entry?.messageId) === Number(messageId);
            if (!matches) return entry;
            return { ...entry, cards: (entry.cards || []).filter(card => card.id !== npcId) };
        }).filter(entry => (entry.cards || []).length);
        return state;
    }

    function purgeInlineCardsInState(state, npcId = null, name = '') {
        if (!Array.isArray(state.inlineCards)) state.inlineCards = [];
        state.inlineCards = state.inlineCards.map(entry => ({
            ...entry,
            cards: (entry.cards || []).filter(card => {
                if (npcId && card.id === npcId) return false;
                if (name && npcMatchesLabel(card, name)) return false;
                return true;
            }),
        })).filter(entry => entry.cards.length);
        return state;
    }

    function scanInlineNpcIds(_parsed, merged) {
        // mergeScanResult clears stale presence on ordinary scans and then reapplies the
        // latest scanner result. The merged state is therefore the authoritative source
        // for which NPCs belong under the current assistant message. Do not require a
        // second "touched" match here: that could leave the roster showing ● present
        // while no inline snapshot was recorded.
        return merged.state.npcs
            .filter(npc => !npc.archived && npc.present && !npc.minor)
            .map(npc => npc.id);
    }

    function currentNpcById(id) {
        if (chatHydrationStatus(getChatKey()) !== 'ready') return null;
        return getChatState().npcs.find(npc => npc.id === id) || null;
    }

    function findNpcByIdOrName(value) {
        const query = String(value || '').trim();
        if (!query || chatHydrationStatus(getChatKey()) !== 'ready') return null;
        const normalized = normalizeName(query);
        return getChatState().npcs.find(npc => npc.id === query || normalizeName(npc.name) === normalized) || null;
    }

    return { recordInlineCardsInState, clearInlineCardsAtMessage, removeNpcInlineCardAtMessage, purgeInlineCardsInState, scanInlineNpcIds, currentNpcById, findNpcByIdOrName };
}
