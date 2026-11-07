/* NPC State Delta Megumin block integration: the foreign tab/pane mount, its close/dismiss bridge,
   snapshot signature and stale-integration cleanup. Split from runtime-inline-cards.js with
   unchanged function bodies; the original factory closure is passed in explicitly and the original
   path keeps the public exports. */

export function createInlineCardsMeguminPart({ storyBlockTabsActive, chatElementForInlineObserver }) {

    function meguminIntegrationMessageId(node) {
        const value = Number(node?.dataset?.npcStateDeltaMessageId);
        return Number.isInteger(value) && value >= 0 ? value : null;
    }

    function meguminBlockCardForMessage(message) {
        const card = message?.querySelector?.('.meg-blocks') || null;
        // Story Block's compatible card already carries Delta's own registered tab.
        return card && storyBlockTabsActive() && card.classList?.contains?.('story-block-card') ? null : card;
    }

    function setClassActive(node, active) {
        if (!node) return;
        if (node.classList?.toggle) node.classList.toggle('active', Boolean(active));
        else {
            const names = new Set(String(node.className || '').split(/\s+/).filter(Boolean));
            if (active) names.add('active'); else names.delete(active);
            node.className = [...names].join(' ');
        }
    }

    function meguminSnapshotSignature(html) {
        const text = String(html || '');
        let hash = 2166136261;
        for (let i = 0; i < text.length; i += 1) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return `${text.length}:${(hash >>> 0).toString(36)}`;
    }

    function closeMeguminNpcStatePane(card) {
        if (!card?.querySelectorAll) return;
        for (const pane of [...(card.querySelectorAll('.npc-state-delta-megumin-pane') || [])]) {
            if (pane?.style) pane.style.display = 'none';
        }
        for (const tab of [...(card.querySelectorAll('.npc-state-delta-megumin-tab') || [])]) {
            setClassActive(tab, false);
            tab.setAttribute?.('aria-expanded', 'false');
        }
    }

    function mountNpcStateInsideMeguminBlock(message, messageId, html) {
        const card = meguminBlockCardForMessage(message);
        if (!card?.querySelector) return false;
        const tabs = card.querySelector('.meg-blocks-tabs');
        const panel = card.querySelector('.meg-blocks-panel');
        if (!tabs || !panel) return false;

        let button = card.querySelector('.npc-state-delta-megumin-tab');
        let pane = card.querySelector('.npc-state-delta-megumin-pane');
        if (!button) {
            button = document.createElement('button');
            button.type = 'button';
            button.className = 'meg-blocks-tab npc-state-delta-megumin-tab';
            button.dataset.npcStateDeltaMessageId = String(messageId);
            button.dataset.key = `npc-state-delta:${messageId}`;
            button.title = 'Present NPCs';
            button.setAttribute?.('aria-expanded', 'false');
            button.innerHTML = '<span class="meg-blocks-tab-emoji">👥</span><span class="meg-blocks-tab-label">Present NPCs</span>';
            button.addEventListener?.('click', event => {
                // Inventory Ledger may deliberately restore this foreign tab from its own bridge.
                // In that case it prevents the click after restoring our pane; do not immediately
                // interpret the same click as a second toggle and close it again.
                if (event?.defaultPrevented) return;
                event?.stopPropagation?.();

                const isOpen = button.classList?.contains?.('active')
                    && pane?.style?.display !== 'none'
                    && !card.classList?.contains?.('meg-blocks-shut');
                if (isOpen) {
                    closeMeguminNpcStatePane(card);
                    card.classList?.add?.('meg-blocks-shut');
                    return;
                }

                // Megumin keeps its selected-tab key in a private closure. Merely changing the DOM
                // leaves that hidden state pointing at the previously selected native tab, which makes
                // the next click on that tab CLOSE it instead of opening it. Drive Megumin's own
                // collapse button until its native state reaches the shut/null state first. With a
                // resting CYOA tab the first click can open that resting tab, so a second click is the
                // deterministic fallback that returns the closure to null.
                const collapse = tabs.querySelector?.('.meg-blocks-collapse');
                if (typeof collapse?.click === 'function') {
                    collapse.click();
                    if (!card.classList?.contains?.('meg-blocks-shut')) collapse.click();
                }

                for (const nativePane of [...(card.querySelectorAll?.('.meg-block-body') || [])]) {
                    if (nativePane?.style) nativePane.style.display = nativePane === pane ? '' : 'none';
                }
                for (const tab of [...(card.querySelectorAll?.('.meg-blocks-tab') || [])]) setClassActive(tab, tab === button);
                if (panel?.style) panel.style.display = '';
                card.classList?.remove?.('meg-blocks-shut');
                button.setAttribute?.('aria-expanded', 'true');
            });
            const collapse = tabs.querySelector?.('.meg-blocks-collapse');
            if (collapse?.before) collapse.before(button);
            else tabs.appendChild?.(button);
        }

        if (!pane) {
            pane = document.createElement('div');
            pane.className = 'meg-block-body npc-state-delta-megumin-pane';
            pane.dataset.npcStateDeltaMessageId = String(messageId);
            if (pane.style) pane.style.display = 'none';
            panel.appendChild?.(pane);
        }
        // Keep the foreign tab/pane key pair compatible with other Megumin card integrations
        // (notably Inventory Ledger) so they can restore NPC State Delta as the prior active pane.
        pane.dataset.key = button.dataset.key;
        const snapshotSignature = meguminSnapshotSignature(html);
        // Do not compare pane.innerHTML with the source string. Browsers serialize an opened
        // <details> with an `open` attribute, so the old comparison treated normal expansion as
        // stale content and replaced the pane on the next repair render, instantly collapsing it.
        if (pane.dataset.npcStateDeltaSnapshotSignature !== snapshotSignature || !String(pane.innerHTML || '').trim()) {
            pane.innerHTML = html;
            pane.dataset.npcStateDeltaSnapshotSignature = snapshotSignature;
        }

        // Megumin owns its native tab state through private closure variables. Bind a small bridge
        // after those native listeners: choosing any native tab/collapse simply hides our foreign pane,
        // while choosing NPC State Delta hides Megumin's panes. No message.mes rewrite or Megumin import needed.
        for (const control of [...(card.querySelectorAll?.('.meg-blocks-tab, .meg-blocks-collapse') || [])]) {
            if (control === button || control?.dataset?.npcStateDeltaDismissBound === '1') continue;
            if (control?.dataset) control.dataset.npcStateDeltaDismissBound = '1';
            control?.addEventListener?.('click', () => closeMeguminNpcStatePane(card));
        }
        return true;
    }

    function cleanupStaleMeguminIntegrations(desiredIds, root = chatElementForInlineObserver() || document) {
        for (const node of [...(root.querySelectorAll?.('.npc-state-delta-megumin-pane, .npc-state-delta-megumin-tab') || [])]) {
            const messageId = meguminIntegrationMessageId(node);
            if (messageId === null || !desiredIds.has(messageId)) node.remove?.();
        }
    }

    function inlineAnchorMessageId(anchor) {
        const value = Number(anchor?.dataset?.npcStateDeltaMessageId);
        return Number.isInteger(value) && value >= 0 ? value : null;
    }

    return { meguminIntegrationMessageId, meguminBlockCardForMessage, mountNpcStateInsideMeguminBlock, cleanupStaleMeguminIntegrations, inlineAnchorMessageId };
}
