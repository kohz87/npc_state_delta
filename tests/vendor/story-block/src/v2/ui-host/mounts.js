// Wires the page's screen, card, HUD and dialog mounts to the live runtime and navigation.
// Get the RPG view at render time because it can load or unload while the page remains mounted.

import { createMounts } from '../view/mounts/index.js';
import { gameHeroProps, headerControlItems, readHeroContext } from '../view/game-header.js';
import { formatStoryTime, storyCalendar } from '../view/clock.js';
import { isHiddenNav, isInBar } from '../view/tab-order.js';
import { CHANGES_CARD_SCREEN_ID, changesSummary } from '../screens/index.js';
import { CORE_FEATURE } from '../features.js';

export function createUiMounts({ screens, renderer, registry, ctx, store, sdk, queryAt, notes, assistedAt, cardLines, replyCardsAt, branchNow, coreOn, api, events, carriers, hasCard, tabOrder, navPresent, barDeclared, extraTabs, doc, getRpg }) {
    return createMounts({
        screens,
        render: renderer.render,
        replyCards: index => replyCardsAt(index),
        hasReplyCards: () => (registry.cardEntries?.().length ?? 0) > 0,
        chatScope: () => ({ chat: String(ctx.getCurrentChatId?.() ?? ctx.chatId ?? ''), branch: branchNow() }),
        // A chat with no carrier has head index -1 (and a stale index can point past the end): no
        // state there, so the mounts show nothing instead of failing on store.at's RangeError.
        stateAt: index => (Number.isInteger(index) && index >= 0 && index < (ctx.chat?.length ?? 0) ? store.at(index) : null),
        headIndex: () => store.headIndex(),
        query: queryAt,
        changesAt: index => store.changesAt(index),
        opsAt: index => store.opsAt(index),
        // The card under a reply is one card; its closed line is each card's own summary, Changes first (this hook is the changes card's).
        first: [CHANGES_CARD_SCREEN_ID],
        summary(screen, { index, state, before, changes }) {
            if (screen?.id !== CHANGES_CARD_SCREEN_ID) return null;
            let currency = null;
            try { currency = sdk.query('inventory.currency'); } catch { currency = null; }
            return changesSummary({ state, before, changes, currency, refused: notes.refusedAt(index).length, assisted: assistedAt(index).length, lines: cardLines(index, state, changes, before) });
        },
        settings: screenId => {
            const owner = String(screenId ?? '').split('/')[0];
            const current = sdk.settings(registry.has(owner) ? owner : 'story-block');
            return owner === 'story-block' ? { ...current, _weatherEnabled: coreOn(CORE_FEATURE.weather) } : current;
        },
        // Cards: the reader's switch per card screen, under Story Block's `story-block.cards` feature.
        enabled: (mount, screenId) => (mount === 'card' ? coreOn(CORE_FEATURE.cards) && screens.cardsOn(screenId) : true),
        api,
        // The game view's header (UI stage 5a): the lead and the scene, read through the queries, the story time through
        // the host's own calendar formatter (the same one the screens' fmt.time uses).
        heroOf: state => gameHeroProps({
            state,
            query: (name, args) => queryAt(name, args, state),
            context: readHeroContext(),
            formatTime: minutes => formatStoryTime(minutes, storyCalendar((name, args) => (registry.query(name) ? sdk.query(name, args) : null))),
            weatherOn: coreOn(CORE_FEATURE.weather),
            // The RPG keeps its character in a block, not behind `party.pc`: its stage bars are the header's (lean-rpg/view/hero-data.js).
            rpgLead: getRpg()?.heroLead?.(state) ?? null,
        }),
        // A module's header toggle (registry `headerControls`): the pill's state is the module's own query, read at the same head state.
        headerControls: state => headerControlItems({ controls: registry.headerControls?.() ?? [], query: (name, args) => queryAt(name, args, state) }),
        // (the same held `committed` as the panel's: a form's combined Save redraws the game view once, after its last step)
        on: api.on,
        carriers,
        hasCard,
        swipeAt: index => ctx.chat?.[index]?.swipe_id ?? 0,
        eventSource: ctx.eventSource,
        eventTypes: ctx.eventTypes ?? ctx.event_types,
        // The game view's navigation leaves out the screens the reader hid (they still open by name).
        inNav: screenId => !isHiddenNav(tabOrder.choice(), screenId, navPresent),
        // Which screens sit in the bar, as against under More (the reader's choice, else the default bar).
        inBar: screenId => isInBar(tabOrder.choice(), screenId, barDeclared(screenId)),
        addTab(tab) {
            extraTabs.push(tab);
            return () => {
                const at = extraTabs.indexOf(tab);
                if (at >= 0) extraTabs.splice(at, 1);
            };
        },
        document: doc,
    });
}
