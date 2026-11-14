/* NPC State Delta inline-card mounting: the chat MutationObserver, repair check, watchdog, renderer
   and debounced render queue. Split from runtime-inline-cards.js with unchanged function bodies; its
   timers and observer state remain per module instance in this factory, the original factory closure
   is passed in explicitly, and the original path keeps the public exports. */

import { fillPresentSceneText } from './present-scene.js';

export function createInlineCardsMountPart(rt, deps, { chatElementForInlineObserver, messageElement, inlineRosterHtml, inChatCastMode, inlineEntriesForRender, meguminIntegrationMessageId, meguminBlockCardForMessage, cleanupStaleMeguminIntegrations, inlineAnchorMessageId, mountNpcStateInsideMeguminBlock }) {
    const { chatHydrationStatus, getChatKey, getChatState, generationActive = () => false } = deps;

    let inlineRenderTimer = null;
    let inlineWatchdogTimer = null;

    function ensureInlineObserver() {
        if (typeof globalThis.MutationObserver !== 'function') return false;
        const chat = chatElementForInlineObserver();
        if (!chat) return false;
        if (rt.inlineObserver && rt.inlineObserverChat === chat) return true;
        try { rt.inlineObserver?.disconnect?.(); } catch {}
        rt.inlineObserverChat = chat;
        rt.inlineObserver = new globalThis.MutationObserver(mutations => {
            // Ignore text-only mutations inside our own card. Host message redraws, removed
            // anchors, pagination and markdown replacements all arrive as child-list changes.
            const relevant = (mutations || []).some(mutation => {
                if (mutation?.type && mutation.type !== 'childList') return false;
                const target = mutation?.target;
                if (typeof target?.closest === 'function' && target.closest('.npc-state-delta-inline-anchor, .npc-state-delta-megumin-pane')) return false;
                return true;
            });
            // While a reply is being made its text grows by child-list changes in the chat: no render for each (one follows the generation's end).
            if (relevant && !generationActive()) queueInlineRender(45);
        });
        try {
            rt.inlineObserver.observe(chat, { childList: true, subtree: true });
            return true;
        } catch (error) {
            console.debug('[NPC State Delta] inline MutationObserver could not attach', error);
            rt.inlineObserver = null;
            rt.inlineObserverChat = null;
            return false;
        }
    }

    function inlineMountNeedsRepair() {
        let chatKey;
        try { chatKey = getChatKey(); } catch { return false; }
        if (chatKey === 'no-chat' || chatHydrationStatus(chatKey) !== 'ready') return false;
        const desired = inlineEntriesForRender(getChatState(chatKey)).filter(entry => (entry.cards || []).length);
        if (!desired.length) return false;
        const root = chatElementForInlineObserver() || document;
        const standaloneMounted = new Set(
            [...(root.querySelectorAll?.('.npc-state-delta-inline-anchor') || [])].map(inlineAnchorMessageId).filter(id => id !== null),
        );
        const meguminMounted = new Set(
            [...(root.querySelectorAll?.('.npc-state-delta-megumin-pane') || [])].map(meguminIntegrationMessageId).filter(id => id !== null),
        );
        return desired.some(entry => {
            const messageId = Number(entry.messageId);
            const message = messageElement(messageId);
            if (!message) return false;
            const block = meguminBlockCardForMessage(message);
            const canIntegrate = Boolean(block?.querySelector?.('.meg-blocks-tabs') && block?.querySelector?.('.meg-blocks-panel'));
            return canIntegrate ? !meguminMounted.has(messageId) : !standaloneMounted.has(messageId);
        });
    }

    function stopInlineWatchdog() {
        if (inlineWatchdogTimer) clearInterval(inlineWatchdogTimer);
        inlineWatchdogTimer = null;
        try { rt.inlineObserver?.disconnect?.(); } catch {}
        rt.inlineObserver = null;
        rt.inlineObserverChat = null;
    }

    function startInlineWatchdog() {
        // Off adds nothing to the chat, so nothing needs to watch host message redraws.
        if (inChatCastMode() === 'off') return stopInlineWatchdog();
        ensureInlineObserver();
        if (inlineWatchdogTimer || typeof setInterval !== 'function') return;
        inlineWatchdogTimer = setInterval(() => {
            try {
                ensureInlineObserver();
                if (inlineMountNeedsRepair()) queueInlineRender(0);
            } catch (error) {
                console.debug('[NPC State Delta] inline watchdog check failed', error);
            }
        }, 2200);
        inlineWatchdogTimer?.unref?.();
    }

    function renderInlineCards() {
        let chatKey;
        try { chatKey = getChatKey(); } catch { return { rendered: 0, missing: 0 }; }
        if (chatKey === 'no-chat' || chatHydrationStatus(chatKey) !== 'ready') return { rendered: 0, missing: 0 };
        if (inChatCastMode() !== 'off') ensureInlineObserver();

        const state = getChatState(chatKey);
        const desiredEntries = inlineEntriesForRender(state).filter(entry => (entry.cards || []).length);
        const desiredIds = new Set(desiredEntries.map(entry => Number(entry.messageId)));
        const existingById = new Map();
        const root = chatElementForInlineObserver() || document;
        cleanupStaleMeguminIntegrations(desiredIds, root);

        for (const anchor of [...(root.querySelectorAll?.('.npc-state-delta-inline-anchor') || [])]) {
            const messageId = inlineAnchorMessageId(anchor);
            if (messageId === null || !desiredIds.has(messageId)) {
                anchor.remove?.();
                continue;
            }
            if (existingById.has(messageId)) {
                anchor.remove?.();
                continue;
            }
            existingById.set(messageId, anchor);
        }

        let rendered = 0;
        let missing = 0;
        for (const entry of desiredEntries) {
            const messageId = Number(entry.messageId);
            const message = messageElement(messageId);
            if (!message) {
                missing += 1;
                continue;
            }

            const html = inlineRosterHtml(entry.cards || [], messageId);
            let anchor = existingById.get(messageId);
            if (mountNpcStateInsideMeguminBlock(message, messageId, html)) {
                anchor?.remove?.();
                existingById.delete(messageId);
                fillPresentSceneText(message.querySelector?.('.npc-state-delta-megumin-pane'));
                rendered += 1;
                continue;
            }
            if (!anchor) {
                anchor = document.createElement('div');
                anchor.className = 'npc-state-delta-inline-anchor';
                anchor.dataset.npcStateDeltaMessageId = String(messageId);
                anchor.innerHTML = html;
                anchor.__npcStateDeltaHtml = html;
                const text = message.querySelector?.('.mes_text');
                if (text?.insertAdjacentElement) text.insertAdjacentElement('afterend', anchor);
                else (message.querySelector?.('.mes_block') || message).appendChild?.(anchor);
                existingById.set(messageId, anchor);
            } else if (anchor.innerHTML !== html && (anchor.__npcStateDeltaHtml !== html || !String(anchor.innerHTML || '').trim())) {
                // Filled now/chatter slots make innerHTML differ from the source markup by design.
                anchor.innerHTML = html;
                anchor.__npcStateDeltaHtml = html;
            }
            fillPresentSceneText(anchor);
            rendered += 1;
        }
        document.dispatchEvent?.(new CustomEvent('npc-state-delta:cast-rendered'));
        return { rendered, missing };
    }

    const INLINE_RENDER_RETRY_DELAYS = [80, 180, 350, 700, 1400];
    function queueInlineRender(delay = 0, retryIndex = 0) {
        if (inlineRenderTimer) clearTimeout(inlineRenderTimer);
        inlineRenderTimer = setTimeout(() => {
            inlineRenderTimer = null;
            try {
                const result = renderInlineCards();
                if (result?.missing > 0 && retryIndex < INLINE_RENDER_RETRY_DELAYS.length) {
                    queueInlineRender(INLINE_RENDER_RETRY_DELAYS[retryIndex], retryIndex + 1);
                }
            } catch (error) {
                console.warn('[NPC State Delta] inline render failed', error);
            }
        }, Math.max(0, Number(delay) || 0));
    }

    return { ensureInlineObserver, inlineMountNeedsRepair, startInlineWatchdog, renderInlineCards, queueInlineRender };
}
