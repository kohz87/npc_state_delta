/* NPC State Delta inline cards (role: inline-cards-ui). The present-cast and speaker cards drawn in the chat, their record in
   the chat state, the Megumin block integration, the observer and watchdog that keep them mounted, and the display-mode
   choice. Display only: nothing here decides what the dossier says. Built by index.js once per module instance with the
   shared runtime state and the controller functions it calls, so each instance keeps its own timers. Bodies are moved
   from index.js without change. */

import { getContext } from '../../../extensions.js';
import { snapshotNpc } from './src/fields/registry.js';
import { npcMatchesLabel, normalizeName, formPortraitFor, currentPresentationText } from './core.js';
import { fingerprintMessage } from './branch.js';
import { portraitSrc } from './src/portrait-file.js';
import { areaOwner } from './suite-handshake.js';
import { chatterSlotsHtml, fillPresentSceneText, matchPresentCard, nowSlotHtml, othersSlotsHtml, presentSceneModel, rememberPresentScene, sceneAttr, speakerChatterHtml, speakerGroups, storyBlockTags, worldStatePeople } from './present-scene.js';
import { escapeHtml } from './src/util/html.js';
import { getSettings, normalizePresentCastDisplay } from './runtime-settings.js';

export function createInlineCardsPart(rt, deps) {
    const { chatHydrationStatus, currentLineageKeyForMessage, getChatKey, getChatState, INLINE_HISTORY_LIMIT, isKeyNpc, latestMessageId, scenePresenceView, storyBlockV2Hosted } = deps;

    let inlineRenderTimer = null;
    let inlineWatchdogTimer = null;

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

    // Like the dossier, the present cast shows the current form's own portrait when that form has one,
    // and the main portrait otherwise.
    function portraitMarkup(npc, displayName, placeholderClass = 'npc-state-delta-inline-avatar-placeholder') {
        const formImage = npc?.currentForm ? formPortraitFor(getChatState().formPortraitAssets, npc.id, npc.currentForm) : null;
        const portraitUrl = formImage?.dataUrl || portraitSrc(npc?.portrait);
        if (portraitUrl) return `<img src="${escapeHtml(portraitUrl)}" alt="${escapeHtml(displayName)} portrait">`;
        const initial = String(displayName || '?').trim().charAt(0).toUpperCase() || '?';
        return `<div class="${placeholderClass}" aria-hidden="true"><span>${escapeHtml(initial)}</span></div>`;
    }

    function inlineCardHtml(npc, messageId, scene = null) {
        if (!npc || npc.archived || !npc.present || npc.minor) return '';
        const displayName = npc.name || 'NPC';
        // With now lines (Mood, Condition, Outfit) the identity line keeps only the role. The text sits
        // under the portrait so the name and the now lines can wrap instead of being cut to one line.
        const now = nowSlotHtml(scene, npc.id);
        const identityLine = (now ? npc.role : [npc.role, npc.mood].filter(Boolean).join(' · ')) || 'Present NPC';
        const portrait = portraitMarkup(npc, displayName, 'npc-state-delta-present-card-placeholder');
        const card = `
      <button type="button" class="npc-state-delta-present-card" data-npc-id="${escapeHtml(npc.id)}" data-message-id="${messageId}" aria-label="Open ${escapeHtml(displayName)} dossier">
        <span class="npc-state-delta-present-card-portrait">${portrait}</span>
        <span class="npc-state-delta-present-card-text">
          <span class="npc-state-delta-present-card-head"><b class="npc-state-delta-present-card-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</b>${isKeyNpc(npc) ? '<span class="npc-state-delta-key-tag" title="Key person (Story Director)">★ Key</span>' : ''}<span class="npc-state-delta-present-card-stage"></span></span>
          <small class="npc-state-delta-present-card-role" title="${escapeHtml(identityLine)}">${escapeHtml(identityLine)}</small>${now}
        </span>
      </button>`;
        // One cell per NPC: the card, then what narrow panes show in the row's right half (1.2.4, see
        // style.css): the NPC's chatter if any, else the now lines (the same slots as on the card; the
        // wide grid shows them on the card and hides this copy, narrow panes the reverse), else the role
        // and "No changes this turn". Wide grids show the chatter under the card. Tapping anywhere in
        // the cell, the right half included, opens the dossier.
        const chatter = chatterSlotsHtml(scene, npc.id);
        const side = chatter ? chatter
            : (now ? `<div class="npc-state-delta-present-side npc-state-delta-present-side-now">${now}</div>`
                : `<div class="npc-state-delta-present-side npc-state-delta-present-side-idle"><small class="npc-state-delta-present-side-role">${escapeHtml(identityLine)}</small><small class="npc-state-delta-present-side-muted">No changes this turn</small></div>`);
        const kind = chatter ? 'chatter' : (now ? 'now' : 'idle');
        return `<div class="npc-state-delta-present-cell npc-state-delta-present-cell-${kind}" data-npc-id="${escapeHtml(npc.id)}" data-message-id="${messageId}">${card}${side}</div>`;
    }

    // A card for someone who speaks in the chatter but has no present card (1.2.7), in the same
    // card-and-bubble cell as a present NPC: a tracked NPC not marked present (or minor) gets their
    // portrait and opens their dossier; a name the dossiers do not know gets its initial, and the
    // name arrives through a text slot like the chatter itself.
    function speakerCellHtml(group, scene, messageId) {
        const chatter = speakerChatterHtml(scene, group);
        if (!chatter) return '';
        const roster = (getChatState().npcs || []).filter(npc => !npc.archived);
        const id = matchPresentCard(group.name, roster.map(npc => ({ id: npc.id, name: npc.name, aliases: npc.aliases || [] })), roster);
        const npc = id ? roster.find(item => item.id === id) : null;
        if (npc) {
            const displayName = npc.name || 'NPC';
            const role = npc.role || 'Not marked present';
            const card = `
      <button type="button" class="npc-state-delta-present-card" data-npc-id="${escapeHtml(npc.id)}" data-message-id="${messageId}" aria-label="Open ${escapeHtml(displayName)} dossier">
        <span class="npc-state-delta-present-card-portrait">${portraitMarkup(npc, displayName, 'npc-state-delta-present-card-placeholder')}</span>
        <span class="npc-state-delta-present-card-text">
          <b class="npc-state-delta-present-card-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</b>
          <small class="npc-state-delta-present-card-role" title="${escapeHtml(role)}">${escapeHtml(role)}</small>
        </span>
      </button>`;
            return `<div class="npc-state-delta-present-cell npc-state-delta-present-cell-chatter npc-state-delta-present-cell-speaker" data-npc-id="${escapeHtml(npc.id)}" data-message-id="${messageId}">${card}${chatter}</div>`;
        }
        const initial = String(group.name || '?').trim().charAt(0).toUpperCase() || '?';
        const card = `
      <div class="npc-state-delta-present-card npc-state-delta-present-card-untracked">
        <span class="npc-state-delta-present-card-portrait"><div class="npc-state-delta-present-card-placeholder" aria-hidden="true"><span>${escapeHtml(initial)}</span></div></span>
        <span class="npc-state-delta-present-card-text">
          <b class="npc-state-delta-present-card-name" data-delta-text="${Number(group.speaker)}"></b>
          <small class="npc-state-delta-present-card-role">Not in the dossiers yet</small>
        </span>
      </div>`;
        return `<div class="npc-state-delta-present-cell npc-state-delta-present-cell-chatter npc-state-delta-present-cell-speaker npc-state-delta-present-cell-untracked" data-message-id="${messageId}">${card}${chatter}</div>`;
    }

    function presentCastChipHtml(npc, messageId) {
        const displayName = npc.name || 'NPC';
        const portrait = portraitMarkup(npc, displayName, 'npc-state-delta-present-card-placeholder');
        return `<button type="button" class="npc-state-delta-present-chip" data-npc-id="${escapeHtml(npc.id)}" data-message-id="${messageId}" aria-label="Open ${escapeHtml(displayName)} dossier"><span class="npc-state-delta-present-chip-portrait">${portrait}</span><span>${escapeHtml(displayName)}</span></button>`;
    }

    // Story Block's block text for the latest assistant reply (that reply only, never an older copy),
    // or ''. Read through its public api: blockInText on that one message, else getBlock.
    function storyBlockTextForLatestReply(tags, messageId) {
        const storyBlock = globalThis.StoryBlock;
        const message = Number.isInteger(messageId) && messageId >= 0 ? getContext().chat?.[messageId] : null;
        if (!storyBlock || !message || message.is_user || message.is_system) return '';
        const texts = [];
        for (const tag of tags) {
            try {
                const found = typeof storyBlock.blockInText === 'function'
                    ? storyBlock.blockInText(String(message.mes ?? ''), tag)
                    : storyBlock.getBlock?.(tag, { beforeIndex: messageId + 1 });
                const text = found && (found.messageIndex === undefined || found.messageIndex === null || found.messageIndex === messageId) ? String(found.text ?? '').trim() : '';
                if (text) texts.push(text);
            } catch (error) {
                console.warn('[NPC State Delta] Story Block block could not be read', error);
            }
        }
        return texts.join('\n');
    }

    // (1.2.10) Who the reply's World State puts in the scene and off-screen at its end, or null
    // when the reply has none (or there is no Story Block to read it with): the scan then keeps the
    // model's own word.
    function scenePresentAt(messageId) {
        try {
            const blocks = typeof globalThis.StoryBlock?.listBlocks === 'function' ? globalThis.StoryBlock.listBlocks() : [];
            const text = storyBlockTextForLatestReply(storyBlockTags(blocks, 'scene'), messageId);
            const people = text ? worldStatePeople(text) : null;
            return people && (people.present || people.offscreen) ? people : null;
        } catch {
            return null;
        }
    }

    // Display only: the now line on each present card and Story Block's NPC Inner Chatter beside
    // them. World State is used for the now line only while Story Block keeps the scene.
    function presentSceneFor(visible, messageId) {
        try {
            const settings = getSettings();
            const blocks = typeof globalThis.StoryBlock?.listBlocks === 'function' ? globalThis.StoryBlock.listBlocks() : [];
            const sceneOwned = areaOwner('scene', settings.sourceOfTruth)?.id === 'story-block';
            const sceneText = sceneOwned ? storyBlockTextForLatestReply(storyBlockTags(blocks, 'scene'), messageId) : '';
            // Only enabled chatter blocks (Story Block's default one is tagged NPC_Inner_Chatter).
            const chatterText = storyBlockTextForLatestReply(storyBlockTags(blocks, 'chatter'), messageId);
            const cards = visible.map(npc => ({
                id: npc.id,
                name: npc.name,
                aliases: npc.aliases || [],
                mood: npc.mood,
                condition: npc.status,
                outfit: currentPresentationText(npc) || npc.currentForm || '',
            }));
            const roster = (getChatState().npcs || []).filter(npc => !npc.archived);
            return rememberPresentScene(presentSceneModel({ cards, roster, sceneText, sceneOwned, chatterText }));
        } catch (error) {
            console.warn('[NPC State Delta] present scene skipped', error);
            return null;
        }
    }

    function inlineRosterHtml(cards, messageId, mode = inChatCastMode(), { othersWithoutCast = false } = {}) {
        const currentById = new Map(getChatState().npcs.map(npc => [npc.id, npc]));
        const visible = (cards || []).map(card => currentById.get(card.id)).filter(npc => npc?.present && !npc.archived && !npc.minor);
        if (!visible.length && !othersWithoutCast) return '';
        if (mode === 'compact') {
            return `
      <section class="npc-state-delta-present-roster npc-state-delta-present-strip" data-message-id="${messageId}">
        <span class="npc-state-delta-kicker">PRESENT NPCS</span>
        <div class="npc-state-delta-present-chips">${visible.map(npc => presentCastChipHtml(npc, messageId)).join('')}</div>
      </section>`;
        }
        const scene = presentSceneFor(visible, messageId);
        // Named speakers without a present card get cards of their own after the present ones; only
        // lines with no speaker are left for the Others line.
        const speakerCells = speakerGroups(scene).map(group => speakerCellHtml(group, scene, messageId)).filter(Boolean);
        const speakers = speakerCells.join('');
        const others = othersSlotsHtml(scene, { speakerless: true });
        if (!visible.length && !speakers && !others) return '';
        const grid = visible.length || speakers ? `
        <div class="npc-state-delta-present-grid">${visible.map(npc => inlineCardHtml(npc, messageId, scene)).join('')}${speakers}</div>` : '';
        return `
      <section class="npc-state-delta-present-roster" data-message-id="${messageId}"${sceneAttr(scene)}>
        <div class="npc-state-delta-present-roster-head"><span class="npc-state-delta-kicker">PRESENT NPCS</span><small>${visible.length + speakerCells.length} shown</small></div>${grid}${others}
      </section>`;
    }

    function messageElement(messageId) {
        if (!Number.isInteger(messageId) || messageId < 0) return null;
        const selectors = [
            `#chat .mes[mesid="${messageId}"]`,
            `.mes[mesid="${messageId}"]`,
            `#chat .mes[data-mesid="${messageId}"]`,
            `.mes[data-mesid="${messageId}"]`,
            `#chat .mes[data-message-id="${messageId}"]`,
            `.mes[data-message-id="${messageId}"]`,
        ];
        for (const selector of selectors) {
            const found = document.querySelector?.(selector);
            if (found) return found;
        }

        // Defensive fallback for themes/plugins that clone message markup without SillyTavern's
        // mesid attribute. Only use DOM order when it lines up exactly with non-system chat rows.
        const domMessages = [...(document.querySelectorAll?.('#chat .mes') || [])];
        const visibleMessageIds = (getContext().chat || [])
            .map((message, index) => (!message?.is_system ? index : null))
            .filter(index => index !== null);
        if (domMessages.length && domMessages.length === visibleMessageIds.length) {
            const domIndex = visibleMessageIds.indexOf(messageId);
            if (domIndex >= 0) return domMessages[domIndex] || null;
        }
        return null;
    }

    function presentCastDisplayMode() {
        return normalizePresentCastDisplay(getSettings().presentCastDisplay);
    }

    // The floating launcher hides while Story Block carries Delta's tabs, or a Story Block v2 host
    // carries Delta (CSS in launcher-ui.js keys on these flags), unless the player keeps it.
    function applyLauncherFlag() {
        const data = document?.documentElement?.dataset;
        if (!data) return;
        data.npcStateDeltaLauncher = getSettings().launcherWithStoryBlock === true ? 'keep' : 'auto';
        data.npcStateDeltaLauncherV2 = getSettings().launcherWithStoryBlockV2 === true ? 'keep' : 'auto';
    }

    // Set by story-block-tabs.js once its Present NPCs and Dossiers tabs are registered with Story Block.
    function storyBlockTabsActive() {
        return document?.documentElement?.dataset?.npcStateDeltaStoryBlock === '1';
    }

    // Story Block shows Delta's present cast: v1's Present NPCs tab, or a v2 host's Cast tab.
    function storyBlockCarriesCast() {
        return storyBlockTabsActive() || storyBlockV2Hosted();
    }

    // The choice in effect. Until the player picks one, Full cards becomes "Only in Story Block" while
    // Story Block carries the cast, so it is not shown twice. Compact and Off are always deliberate.
    function effectivePresentCastChoice() {
        const mode = presentCastDisplayMode();
        const chosen = getSettings().presentCastDisplayChosen === true || mode !== 'full';
        return !chosen && storyBlockCarriesCast() ? 'storyblock' : mode;
    }

    // What the chat itself shows. "Only in Story Block" hides the in-chat cast while a Story Block tab
    // carries it, and falls back to full cards when Story Block is not installed.
    function inChatCastMode() {
        const mode = effectivePresentCastChoice();
        if (mode !== 'storyblock') return mode;
        return storyBlockCarriesCast() ? 'off' : 'full';
    }

    // The Story Block tab's cast: the live present NPCs as full cards, whatever the in-chat choice.
    function storyBlockCastHtml() {
        const key = getChatKey();
        if (key === 'no-chat' || chatHydrationStatus(key) !== 'ready') return '';
        const present = scenePresenceView(getChatState(key).npcs).filter(npc => !npc.archived && npc.present && !npc.minor);
        // With nobody present the tab still shows chatter (as Others), so none is lost.
        return inlineRosterHtml(present, latestMessageId(true), 'full', { othersWithoutCast: true });
    }

    function inlineEntriesForRender(state) {
        // Presentation only: Off renders nothing, while inlineCards history is still recorded below.
        if (inChatCastMode() === 'off') return [];
        // Visible NPC State Delta is a live present-cast view, not a historical dossier timeline.
        // Keep inlineCards internally for branch/rollback safety, but render only the latest
        // assistant message and only NPCs physically present in the current merged state.
        const latestAssistantId = latestMessageId(true);
        if (latestAssistantId < 0) return [];
        const presentCards = (state.npcs || [])
            .filter(npc => !npc.archived && npc.present && !npc.minor)
            .map(snapshotNpc);
        if (!presentCards.length) return [];
        return [{
            messageId: latestAssistantId,
            reason: 'live-present-grid',
            createdAt: Date.now(),
            cards: presentCards,
        }];
    }

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

    function chatElementForInlineObserver() {
        return document.querySelector?.('#chat') || null;
    }

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
            if (relevant) queueInlineRender(45);
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

    return { recordInlineCardsInState, clearInlineCardsAtMessage, removeNpcInlineCardAtMessage, purgeInlineCardsInState, scanInlineNpcIds, currentNpcById, findNpcByIdOrName, scenePresentAt, presentCastDisplayMode, applyLauncherFlag, effectivePresentCastChoice, storyBlockCastHtml, ensureInlineObserver, inlineMountNeedsRepair, startInlineWatchdog, renderInlineCards, queueInlineRender };
}
