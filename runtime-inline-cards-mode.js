/* NPC State Delta inline-card display mode: the present-cast choice, launcher flags, Story Block
   carry rules, Story Block cast HTML and the live entries selected for rendering. Split from
   runtime-inline-cards.js with unchanged function bodies; the original factory closure is passed in
   explicitly and the original path keeps the public exports. */

import { snapshotNpc } from './src/fields/registry.js';
import { getSettings, normalizePresentCastDisplay } from './runtime-settings.js';

export function createInlineCardsModePart(deps, inlineRosterHtml) {
    const { chatHydrationStatus, getChatKey, getChatState, latestMessageId, scenePresenceView, storyBlockV2Hosted } = deps;

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

    return { presentCastDisplayMode, applyLauncherFlag, effectivePresentCastChoice, inChatCastMode, storyBlockTabsActive, storyBlockCastHtml, inlineEntriesForRender };
}
