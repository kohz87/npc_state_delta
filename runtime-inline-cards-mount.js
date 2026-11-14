/* NPC State Delta inline-card mounting: the chat MutationObserver, repair check, watchdog, renderer
   and debounced render queue. Split from runtime-inline-cards.js with unchanged function bodies; its
   timers and observer state remain per module instance in this factory, the original factory closure
   is passed in explicitly, and the original path keeps the public exports. */

import { fillPresentSceneText } from './present-scene.js';

export function createInlineCardsMountPart(rt, deps, { chatElementForInlineObserver, messageElement, inlineRosterHtml, inChatCastMode, inlineEntriesForRender, meguminIntegrationMessageId, meguminBlockCardForMessage, cleanupStaleMeguminIntegrations, inlineAnchorMessageId, mountNpcStateInsideMeguminBlock }) {
    const { chatHydrationStatus, getChatKey, getChatState, streamingMessageId = () => null } = deps;

    let inlineRenderTimer = null;
    let pendingStreamed = null;   // mesid of the streaming message when every render asked since the last one was that message's own growth
    let growth = { id: null, size: 0 };   // the streaming message's reply length at the last observer call
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
            const relevant = (mutations || []).filter(mutation => {
                if (mutation?.type && mutation.type !== 'childList') return false;
                const target = mutation?.target;
                if (typeof target?.closest === 'function' && target.closest('.npc-state-delta-inline-anchor, .npc-state-delta-megumin-pane')) return false;
                return true;
            });
            // (perf) Only the GROWTH of the message being streamed marks its render (the page-API notification is then coalesced).
            // Removals, replacements that do not lengthen the reply and any other message are ordinary renders.
            if (relevant.length) queueInlineRender(45, 0, streamedGrowth(relevant));
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

    // The streaming message's mesid when all `mutations` are additions inside it and its reply is longer than at the last call; else null.
    function streamedGrowth(mutations) {
        const streaming = streamingMessageId();
        if (streaming === null || streaming === undefined) { growth = { id: null, size: 0 }; return null; }
        const id = String(streaming);
        const mes = m => m.target?.closest?.('.mes');
        const inside = mutations.every(m => String(mes(m)?.getAttribute?.('mesid')) === id);
        const element = mes(mutations[0]);
        // The reply and, while a model is still thinking, its reasoning block (a sibling of the reply text) both grow the message.
        const parts = ['.mes_text', '.mes_reasoning'].map(selector => element?.querySelector?.(selector)).filter(Boolean);
        const size = (parts.length ? parts : [element]).reduce((sum, node) => sum + String(node?.textContent ?? '').length, 0);
        const before = growth.id === id ? growth.size : null;
        if (inside) growth = { id, size };
        const grew = inside && before !== null && size > before && mutations.some(m => m.addedNodes?.length > 0) && onlyAppends(mutations);
        return grew ? id : null;
    }

    // True growth: per changed parent, whatever was removed is the start of what was added (the host re-sets a text node while appending: "Hel" out,
    // "Hello" in). A longer replacement with other text, or a removal of something else in the same delivery, is not growth.
    function onlyAppends(mutations) {
        const text = list => Array.from(list || [], node => String(node?.textContent ?? '')).join('');
        const perTarget = new Map();
        for (const m of mutations) {
            const entry = perTarget.get(m.target) || { added: '', removed: '', bare: false };
            entry.added += text(m.addedNodes);
            entry.removed += text(m.removedNodes);
            if (Array.from(m.removedNodes || []).some(node => node?.nodeType !== 3 && !String(node?.textContent ?? ''))) entry.bare = true;   // an element without text went away
            perTarget.set(m.target, entry);
        }
        return [...perTarget.values()].every(e => !e.bare && e.added.startsWith(e.removed));
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

    // `streamedId` is a parameter of one queued invocation only: nothing is shared between calls, so a skipped or throwing render cannot mark a later direct one.
    // The mark is kept only while that same message is still the one streaming when the render runs.
    function renderInlineCardsOnce(streamedId) {
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
        document.dispatchEvent?.(new CustomEvent('npc-state-delta:cast-rendered', { detail: { streaming: streamedId != null && String(streamingMessageId()) === String(streamedId) } }));
        return { rendered, missing };
    }
    // The public/direct entry is always unmarked.
    function renderInlineCards() { return renderInlineCardsOnce(null); }

    const INLINE_RENDER_RETRY_DELAYS = [80, 180, 350, 700, 1400];
    function queueInlineRender(delay = 0, retryIndex = 0, streamedId = null) {
        pendingStreamed = streamedId != null && (inlineRenderTimer ? pendingStreamed === streamedId : true) ? streamedId : null;
        if (inlineRenderTimer) clearTimeout(inlineRenderTimer);
        inlineRenderTimer = setTimeout(() => {
            inlineRenderTimer = null;
            const streamedNow = pendingStreamed;
            pendingStreamed = null;
            try {
                const result = renderInlineCardsOnce(streamedNow);
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
