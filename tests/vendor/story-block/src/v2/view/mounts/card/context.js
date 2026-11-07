// Sets up the card mount's document lookup, shared carrier readers, caches, open/visible sets and observer.
// The controller fills in `refresh` after its drawing functions exist; the observer only calls it later.

import { documentOf } from '../common.js';
import { RECENT } from './summary.js';

export function createCardContext(deps) {
    if (typeof deps?.render !== 'function') throw new TypeError('The card mount needs a render(el, screen, scope) function.');
    if (typeof deps.carriers !== 'function') throw new TypeError('The card mount needs carriers() → message indexes.');
    if (typeof deps.stateAt !== 'function') throw new TypeError('The card mount needs stateAt(index).');
    const doc = documentOf(deps);
    const ownLookup = typeof deps.messageElement !== 'function';
    const messageElement = deps.messageElement ?? (index => doc.querySelector(`.mes[mesid="${index}"]`));
    const recentCount = Number.isInteger(deps.recent) && deps.recent >= 0 ? deps.recent : RECENT;
    // Every drawn message by index, from one query (only where the mount finds the messages itself).
    const drawnMessages = () => {
        if (!ownLookup) return null;
        const out = new Map();
        for (const el of doc.querySelectorAll('.mes[mesid]')) {
            const index = Number(el.getAttribute('mesid'));
            if (Number.isInteger(index)) out.set(index, el);
        }
        return out;
    };
    const swipeAt = deps.swipeAt ?? (() => 0);
    const changesAt = deps.changesAt ?? (() => []);
    const opsAt = deps.opsAt ?? (() => []);
    const hasCard = deps.hasCard ?? (() => true);
    // The state at the carrier before `index` (null for the first carrier).
    const beforeOf = index => {
        const list = deps.carriers();
        let prev = -1;
        for (const at of list) if (at < index && at > prev) prev = at;
        if (prev < 0) return null;
        try { return deps.stateAt(prev); } catch { return null; }
    };
    const cacheLimit = deps.cacheLimit ?? 200;
    // Reply cards are looked for only when a module declares some (`hasReplyCards`); without one nothing is looked up for them.
    const repliesOn = () => Boolean(deps.replyCards && (typeof deps.hasReplyCards !== 'function' || deps.hasReplyCards()));
    const Observer = deps.IntersectionObserver === undefined ? globalThis.IntersectionObserver : deps.IntersectionObserver;

    const context = {
        deps, doc, messageElement, recentCount, drawnMessages, swipeAt, changesAt, opsAt, hasCard, beforeOf, cacheLimit, repliesOn, Observer,
        cache: new Map(),            // key → { node, index }, oldest first
        cards: new WeakMap(),        // card node → { index, head, body, sections: [{ id, body }], drawn, handles }
        expanded: new Set(),         // indexes whose card is open
        visible: new Set(),          // indexes on screen (used only with an observer)
        observed: new WeakSet(),
        observer: null,
        refresh: () => {},
    };

    if (typeof Observer === 'function') {
        context.observer = new Observer(entries => {
            for (const entry of entries) {
                const index = Number(entry.target?.getAttribute?.('mesid'));
                if (!Number.isInteger(index)) continue;
                if (entry.isIntersecting) {
                    context.visible.add(index);
                    context.refresh(index);
                } else context.visible.delete(index);
            }
        }, { rootMargin: '200px 0px' });
    }

    return context;
}
