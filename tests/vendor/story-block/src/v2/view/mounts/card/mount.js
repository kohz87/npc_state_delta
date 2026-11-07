// Wires the card mount's context, builders, drawing and event parts, and returns the public controller.

import { createBuilders } from './build.js';
import { createCardContext } from './context.js';
import { createDrawer } from './draw.js';
import { createEvents } from './events.js';
import { createFollow } from './follow.js';

export function createCardMount(deps) {
    const context = createCardContext(deps);
    const follow = createFollow();
    let events = null;
    const builders = createBuilders({
        doc: context.doc,
        deps,
        cards: context.cards,
        changesAt: context.changesAt,
        opsAt: context.opsAt,
        beforeOf: context.beforeOf,
        toggle: index => events.toggle(index),
    });
    const drawer = createDrawer(context, builders, follow);
    context.refresh = drawer.refresh;
    events = createEvents(context, drawer, builders, follow);

    return {
        mount: builders.mount,
        attachAll: drawer.attachAll,
        refresh: drawer.refresh,
        refreshAll: drawer.refreshAll,
        toggle: events.toggle,
        onSwipe: events.onSwipe,
        onEdit: events.onEdit,
        onDelete: events.onDelete,
        onChatChanged: events.onChatChanged,
        cacheSize: () => context.cache.size,
        destroy() {
            events.destroy();
        },
    };
}
