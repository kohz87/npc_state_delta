// Owns the callbacks that drive the card mount: open/close, commits, swipes, edits, deletes, chat changes
// and SillyTavern's subscriptions, with the same unsubscribe and reset order as before.

import { indexOf } from './summary.js';
import { THIS_REPLY_ID } from '../../../reply-cards.js';

export function createEvents(context, drawer, builders, follow) {
    const { deps, messageElement, expanded, visible, cache } = context;

    // A change to the story only changes the head carrier's own state and ops. A reply card another message carries can end or move
    // with it, so the messages on screen are looked at again when the module's cards are on (`replyCards`).
    function onCommitted() {
        follow.follow(() => {
            const index = typeof deps.headIndex === 'function' ? deps.headIndex() : null;
            if (Number.isInteger(index) && index >= 0) drawer.refresh(index);
            if (context.repliesOn()) refreshDrawnMessages();
        }, { pass: true });
    }
    function refreshDrawnMessages() {
        follow.follow(() => {
            const drawn = context.drawnMessages();
            if (drawn) for (const [index, element] of drawn) drawer.refresh(index, { element });
        }, { pass: true });
    }

    /** Opens or closes the reply's one card (the header button does this). */
    function toggle(index, open = null) {
        const next = open === null ? !expanded.has(index) : !!open;
        if (next) expanded.add(index);
        else expanded.delete(index);
        const message = messageElement(index);
        const box = message && drawer.boxOf(message);
        const node = Array.from(box?.children ?? []).find(child => child.getAttribute('data-ss-card') === THIS_REPLY_ID);
        // The card grows when it opens: under the newest reply, a reader at the bottom of the chat keeps seeing the end of it.
        if (node) follow.follow(() => { follow.beforeChange(message); if (builders.setOpen(node, next)) follow.changed(message); });
        return next;
    }

    // Indexes move after a delete or a chat change: forget everything tied to an index.
    function forgetAll() {
        cache.clear();
        expanded.clear();
        visible.clear();
        context.observer?.disconnect();
        context.observed = new WeakSet();
    }

    const onSwipe = value => drawer.refresh(indexOf(value));
    const onEdit = value => drawer.refresh(indexOf(value), { force: true });
    const onDelete = () => { forgetAll(); drawer.attachAll(); };
    const onChatChanged = () => { forgetAll(); drawer.attachAll(); };
    const onRendered = value => drawer.refresh(indexOf(value));

    const offs = [];
    if (typeof deps.on === 'function') {
        for (const [event, fn] of [['head', () => follow.follow(() => { drawer.attachAll({ recent: true }); if (context.repliesOn()) refreshDrawnMessages(); }, { pass: true })], ['committed', onCommitted]]) {
            const off = deps.on(event, fn);
            if (typeof off === 'function') offs.push(off);
        }
    }
    if (deps.eventSource && deps.eventTypes) {
        const types = deps.eventTypes;
        const wire = [
            [types.MESSAGE_SWIPED, onSwipe], [types.MESSAGE_EDITED, onEdit], [types.MESSAGE_UPDATED, onEdit],
            [types.MESSAGE_DELETED, onDelete], [types.CHAT_CHANGED, onChatChanged],
            [types.CHARACTER_MESSAGE_RENDERED, onRendered], [types.MORE_MESSAGES_LOADED, drawer.attachAll],
        ].filter(([type]) => type);
        for (const [type, fn] of wire) deps.eventSource.on(type, fn);
        offs.push(() => {
            for (const [type, fn] of wire) (deps.eventSource.removeListener ?? deps.eventSource.off)?.call(deps.eventSource, type, fn);
        });
    }

    return {
        toggle, onSwipe, onEdit, onDelete, onChatChanged,
        destroy() {
            offs.forEach(off => off());
            forgetAll();
            context.observer = null;
        },
    };
}
