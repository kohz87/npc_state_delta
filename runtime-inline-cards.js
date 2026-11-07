/* NPC State Delta inline cards (role: inline-cards-ui). The present-cast/speaker cards drawn in the
   chat, their chat-state record, the Megumin block integration, the observer/watchdog and the display
   choice. Display only: nothing here decides what the dossier says. Built by index.js once per module
   instance with the shared runtime state and controller functions it calls, so each instance keeps its
   own timers. The implementation is split across runtime-inline-cards/; this path keeps the original
   public factory/export and existing importers unchanged. */

import { createInlineCardsStatePart } from './runtime-inline-cards/state.js';
import { createInlineCardsPresentPart } from './runtime-inline-cards/present.js';
import { createInlineCardsModePart } from './runtime-inline-cards/mode.js';
import { createInlineCardsMeguminPart } from './runtime-inline-cards/megumin.js';
import { createInlineCardsMountPart } from './runtime-inline-cards/mount.js';

export function createInlineCardsPart(rt, deps) {
    let inChatCastMode = () => 'full';
    const present = createInlineCardsPresentPart(deps, () => inChatCastMode());
    const mode = createInlineCardsModePart(deps, present.inlineRosterHtml);
    inChatCastMode = mode.inChatCastMode;
    const state = createInlineCardsStatePart(deps);
    const megumin = createInlineCardsMeguminPart({
        storyBlockTabsActive: mode.storyBlockTabsActive,
        chatElementForInlineObserver: present.chatElementForInlineObserver,
    });
    const mount = createInlineCardsMountPart(rt, deps, {
        chatElementForInlineObserver: present.chatElementForInlineObserver,
        messageElement: present.messageElement,
        inlineRosterHtml: present.inlineRosterHtml,
        inChatCastMode: mode.inChatCastMode,
        inlineEntriesForRender: mode.inlineEntriesForRender,
        meguminIntegrationMessageId: megumin.meguminIntegrationMessageId,
        meguminBlockCardForMessage: megumin.meguminBlockCardForMessage,
        cleanupStaleMeguminIntegrations: megumin.cleanupStaleMeguminIntegrations,
        inlineAnchorMessageId: megumin.inlineAnchorMessageId,
        mountNpcStateInsideMeguminBlock: megumin.mountNpcStateInsideMeguminBlock,
    });

    return { recordInlineCardsInState: state.recordInlineCardsInState, clearInlineCardsAtMessage: state.clearInlineCardsAtMessage, removeNpcInlineCardAtMessage: state.removeNpcInlineCardAtMessage, purgeInlineCardsInState: state.purgeInlineCardsInState, scanInlineNpcIds: state.scanInlineNpcIds, currentNpcById: state.currentNpcById, findNpcByIdOrName: state.findNpcByIdOrName, scenePresentAt: present.scenePresentAt, presentCastDisplayMode: mode.presentCastDisplayMode, applyLauncherFlag: mode.applyLauncherFlag, effectivePresentCastChoice: mode.effectivePresentCastChoice, storyBlockCastHtml: mode.storyBlockCastHtml, ensureInlineObserver: mount.ensureInlineObserver, inlineMountNeedsRepair: mount.inlineMountNeedsRepair, startInlineWatchdog: mount.startInlineWatchdog, renderInlineCards: mount.renderInlineCards, queueInlineRender: mount.queueInlineRender };
}
