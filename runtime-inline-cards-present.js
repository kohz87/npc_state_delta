/* NPC State Delta inline present-cast markup: portraits, cards, speaker cells, Story Block scene
   reads, roster HTML and chat message lookup. Split from runtime-inline-cards.js with unchanged
   function bodies; the original factory closure is passed in explicitly and the original path keeps
   the public exports. */

import { chatContext as getContext } from './runtime-scan-helpers.js';
import { currentPresentationText, formPortraitFor } from './core.js';
import { portraitSrc } from './src/portrait-file.js';
import { areaOwner } from './suite-handshake.js';
import { chatterSlotsHtml, matchPresentCard, nowSlotHtml, othersSlotsHtml, presentSceneModel, rememberPresentScene, sceneAttr, speakerChatterHtml, speakerGroups, storyBlockTags, worldStatePeople } from './present-scene.js';
import { escapeHtml } from './src/util/html.js';
import { getSettings } from './runtime-settings.js';

export function createInlineCardsPresentPart(deps, inChatCastMode) {
    const { getChatState, isKeyNpc, scenePresenceView } = deps;

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
        // Hosted, the scene says who is here (read time, nothing written), so a card and Story Block's list cannot disagree.
        const currentById = new Map((scenePresenceView?.(getChatState().npcs) ?? getChatState().npcs).map(npc => [npc.id, npc]));
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

    function chatElementForInlineObserver() {
        return document.querySelector?.('#chat') || null;
    }

    return { scenePresentAt, inlineRosterHtml, messageElement, chatElementForInlineObserver };
}
