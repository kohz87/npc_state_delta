// Draws or reuses the cards under a carrier, syncs their strip without moving unchanged nodes, and finds
// the carriers to visit for a full, recent or forced pass.

import { THIS_REPLY_ID, orderSections } from '../../../reply-cards.js';
import { make, screensFor } from '../common.js';

export function createDrawer(context, builders, follow) {
    const { deps, doc, cache, messageElement, drawnMessages, swipeAt, hasCard, repliesOn, cacheLimit, visible, expanded } = context;

    function remember(key, node, index) {
        cache.delete(key);
        cache.set(key, { node, index });
        while (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
    }

    function dropIndex(index) {
        for (const [key, item] of cache) if (item.index === index) cache.delete(key);
    }

    function boxOf(message) {
        return message.querySelector('.ss-cards');
    }

    /**
     * Draws (or reuses) the cards under carrier `index`. A pass over many (attachAll) hands in what it
     * worked out once: `element` (the message), `carriers` (a Set) and `entries` (the card screens on).
     */
    function refresh(index, options = {}) {
        return follow.follow(() => drawCards(index, options));
    }
    function drawCards(index, { force = false, element = null, carriers = null, entries: on = null } = {}) {
        if (force) dropIndex(index);
        const message = element ?? messageElement(index);
        if (!message) return;
        let box = boxOf(message);
        const isCarrier = carriers ? carriers.has(index) : deps.carriers().includes(index);
        const entries = isCarrier && hasCard(index) ? orderSections(on ?? screensFor(deps, 'card'), deps.first) : [];
        if (!entries.length && !repliesOn()) {
            box?.remove();
            return;
        }
        if (context.observer) {
            if (!context.observed.has(message)) {
                context.observed.add(message);
                context.observer.observe(message);
            }
            if (!visible.has(index)) return;
        }
        // The cards a module put under this reply (reply-cards.js): drawn after the changes card, in the same strip. They are not
        // gated on the reply's own record: the first assistant message (the greeting too) can carry one.
        const replies = isCarrier && repliesOn() ? deps.replyCards(index) : [];
        if (!entries.length && !replies.length) {
            box?.remove();
            return;
        }
        const state = deps.stateAt(index);
        const rev = Number.isInteger(state?.meta?.rev) ? state.meta.rev : 0;
        const swipe = swipeAt(index) ?? 0;
        const version = deps.screens.version?.() ?? 0;
        // One card for the whole set: the sections on are part of its key, so turning a screen on or off draws it again.
        const nodes = [];
        if (entries.length) {
            const key = `${THIS_REPLY_ID}|${entries.map(entry => entry.id).join(',')}|${index}|${swipe}|${rev}|${version}`;
            const hit = cache.get(key);
            const node = hit ? hit.node : builders.buildCard(entries, index);
            remember(key, node, index);
            follow.beforeChange(message);
            if (builders.setOpen(node, expanded.has(index))) follow.changed(message);
            nodes.push(node);
        }
        follow.beforeChange(message);
        if (!box) {
            box = make(doc, 'div', 'ss-cards');
            (message.querySelector('.mes_block') ?? message).appendChild(box);
        }
        box.setAttribute('data-ss-index', String(index));
        nodes.push(...replies);
        if (syncBox(box, nodes)) follow.changed(message);
    }

    // The box shows `nodes`, changing only what differs (→ whether it changed): a node that stays is not moved, so the focus on it stays. A control that
    // was focused on a node that was drawn again (Later, Open, an action followed by `committed`) gets the focus back on the same
    // control of the card with the same key, else on the card's fold line or Later button, else on its first button.
    function syncBox(box, nodes) {
        const current = Array.from(box.children);
        if (current.length === nodes.length && current.every((node, i) => node === nodes[i])) return false;
        const held = focusHeld(box);
        for (const node of current) if (!nodes.includes(node)) node.remove();
        nodes.forEach((node, i) => {
            if (box.children[i] !== node) box.insertBefore(node, box.children[i] ?? null);
        });
        if (held && doc.activeElement !== held.control) restoreFocus(box, held);
        return true;
    }

    const cardKeyOf = node => node.getAttribute?.('data-ss-reply-card') ?? node.getAttribute?.('data-ss-card') ?? null;
    function focusHeld(box) {
        const control = doc.activeElement;
        if (!control || !box.contains?.(control)) return null;
        let owner = control;
        while (owner && owner.parentNode !== box) owner = owner.parentNode;
        const key = owner ? cardKeyOf(owner) : null;
        return key === null ? null : { control, key, focus: control.getAttribute?.('data-focus') ?? null };
    }
    function restoreFocus(box, { key, focus }) {
        const node = Array.from(box.children).find(child => cardKeyOf(child) === key);
        if (!node) return;
        const spots = Array.from(node.querySelectorAll('[data-focus]'));
        const by = name => spots.find(spot => spot.getAttribute('data-focus') === name);
        const target = (focus && by(focus)) || by('line') || by('later') || node.querySelector('button:not([disabled])') || null;
        target?.focus?.();
    }

    /**
     * Finds every carrier's message and draws the cards of those on screen. `recent: true` (after a
     * rebuild) goes over the last `recent` carriers and those on screen only: the others were watched when
     * they were drawn, and are drawn when they come into view.
     */
    function attachAll(options = {}) {
        return follow.follow(() => attachPass(options), { pass: true });
    }
    function attachPass({ recent = false } = {}) {
        const entries = screensFor(deps, 'card');
        if (!entries.length && !repliesOn()) {
            // No card screen is on: nothing to draw anywhere; a box left from before goes.
            for (const box of Array.from(doc.querySelectorAll?.('.ss-cards') ?? [])) box.remove();
            return;
        }
        const list = deps.carriers();
        const carriers = new Set(list);
        let targets = list;
        if (recent && context.observer) {
            const near = new Set(list.slice(Math.max(0, list.length - context.recentCount)));
            for (const index of visible) if (carriers.has(index)) near.add(index);
            targets = [...near];
        }
        const elements = drawnMessages();
        for (const index of targets) {
            const element = elements ? elements.get(index) ?? null : null;
            if (elements && !element) continue;
            refresh(index, { element, carriers, entries });
        }
    }

    function refreshAll({ force = false } = {}) {
        if (force) cache.clear();
        attachAll();
    }

    return { refresh, drawCards, syncBox, attachAll, attachPass, refreshAll, boxOf };
}
