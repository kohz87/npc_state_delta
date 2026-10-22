// Story Suite v2: the `card` mount (SPEC §13.4). An inline card under each carrier message that gets
// cards (`hasCard`: the host leaves out the greeting and replies with no v2 record), drawn from **that
// reply's** state (`stateAt(index)`, never the head) and the paths its ops changed, so a template's
// `changed(path)` can show "only what changed".
//
// * Cards are off until the reader turns them on, per screen (`screens.setCards`). Each card starts
//   collapsed: a header with the screen's title and a one-line summary slot. Its body is drawn the first
//   time it is opened.
// * Only messages on screen are drawn when IntersectionObserver exists; without it every carrier is.
// * Drawn cards are cached per (screen, index, swipe, rev, screens version): swiping back or scrolling
//   back reuses the card instead of drawing it again. An edit drops that message's cards; a delete or a
//   chat change drops them all (message indexes move).
//
// deps (see common.js) plus:
//   carriers        () → indexes of the carrier messages (required)
//   hasCard         (index) → whether that carrier gets cards (default: every carrier does)
//   messageElement  (index) → SillyTavern's `.mes[mesid=index]` element (default: a document query)
//   swipeAt         (index) → the message's swipe_id (default 0)
//   summary         (screen, { index, state, changes, before }) → the header's one-line text (optional)
//   opsAt           (index) → the carrier's own ops (optional; cards get them as `replyOps`)
//   IntersectionObserver  the class to use (default globalThis.IntersectionObserver; null turns it off)
//   eventSource, eventTypes   SillyTavern's, to follow swipes, edits, deletes and renders (optional)
//   cacheLimit      how many drawn cards to keep (default 200)
//
// → { mount(el, screenId, { index }) → handle, attachAll(), refresh(index, { force }), refreshAll({ force }),
//     toggle(index, screenId, open?), onSwipe(index), onEdit(index), onDelete(), onChatChanged(),
//     cacheSize(), destroy() }

import { button, dispose, documentOf, drawScreen, icon, make, onHead, screensFor } from './common.js';

const META = /^\/meta(\/|$)/;

/**
 * The default header summary, from the carrier's changed paths: "No changes" when nothing but the meta
 * moved, else nothing (a count of changed paths means nothing to a reader; a screen that wants a line
 * gets one from the mount's `summary`).
 */
export function changeSummary(changes) {
    const count = (changes ?? []).filter(path => !META.test(path)).length;
    return count === 0 ? 'No changes' : '';
}

const indexOf = value => (typeof value === 'number' ? value : Number(value?.messageId ?? value?.index ?? value));

export function createCardMount(deps) {
    if (typeof deps?.render !== 'function') throw new TypeError('The card mount needs a render(el, screen, scope) function.');
    if (typeof deps.carriers !== 'function') throw new TypeError('The card mount needs carriers() → message indexes.');
    if (typeof deps.stateAt !== 'function') throw new TypeError('The card mount needs stateAt(index).');
    const doc = documentOf(deps);
    const messageElement = deps.messageElement ?? (index => doc.querySelector(`.mes[mesid="${index}"]`));
    const swipeAt = deps.swipeAt ?? (() => 0);
    const changesAt = deps.changesAt ?? (() => []);
    const opsAt = deps.opsAt ?? (() => []);
    const hasCard = deps.hasCard ?? (() => true);
    // The state at the carrier before `index` (null for the first carrier).
    const beforeOf = index => {
        const earlier = deps.carriers().filter(at => at < index);
        if (!earlier.length) return null;
        try { return deps.stateAt(earlier.at(-1)); } catch { return null; }
    };
    const cacheLimit = deps.cacheLimit ?? 200;
    const Observer = deps.IntersectionObserver === undefined ? globalThis.IntersectionObserver : deps.IntersectionObserver;

    const cache = new Map();            // key → { node, index }, oldest first
    const cards = new WeakMap();        // card node → { index, screenId, open(), drawn }
    const expanded = new Set();         // `${index}|${screenId}`
    const visible = new Set();          // indexes on screen (used only with an observer)
    let observed = new WeakSet();
    let observer = null;

    if (typeof Observer === 'function') {
        observer = new Observer(entries => {
            for (const entry of entries) {
                const index = Number(entry.target?.getAttribute?.('mesid'));
                if (!Number.isInteger(index)) continue;
                if (entry.isIntersecting) {
                    visible.add(index);
                    refresh(index);
                } else visible.delete(index);
            }
        }, { rootMargin: '200px 0px' });
    }

    /** Draws the body of card screen `screenId` for carrier `opts.index` into `el`. */
    function mount(el, screenId, opts = {}) {
        const index = opts.index ?? (typeof deps.headIndex === 'function' ? deps.headIndex() : null);
        if (!Number.isInteger(index)) throw new TypeError('A card mount needs the message index it belongs to.');
        const merged = { ...deps, ...opts };
        const draw = () => drawScreen(el, screenId, 'card', {
            deps: merged,
            state: merged.stateAt(index),
            changes: changesAt(index) ?? [],
            index,
            // What the reply took away is gone from its state: the state before it and its ops say what.
            extra: { before: beforeOf(index), replyOps: opsAt(index) ?? [] },
        });
        let result = draw();
        return {
            el,
            screenId,
            index,
            get result() { return result; },
            update() { result = draw(); return result; },
            unmount() { dispose(el); el.replaceChildren(); },
        };
    }

    function setOpen(node, open) {
        const info = cards.get(node);
        node.classList.toggle('ss-card-open', open);
        info.head.setAttribute('aria-expanded', open ? 'true' : 'false');
        info.body.hidden = !open;
        if (open && !info.drawn) {
            info.drawn = true;
            info.handle = mount(info.body, info.screenId, { index: info.index });
        }
    }

    function buildCard(entry, index) {
        const state = deps.stateAt(index);
        const changes = changesAt(index) ?? [];
        const node = make(doc, 'div', 'ss-card');
        node.setAttribute('data-ss-card', entry.id);
        const head = button(doc, 'ss-card-head');
        head.setAttribute('aria-expanded', 'false');
        const summary = make(doc, 'span', 'ss-card-summary', deps.summary?.(entry.screen, { index, state, changes, before: beforeOf(index) }) ?? changeSummary(changes));
        summary.setAttribute('data-slot', 'summary');
        const chevron = icon(doc, 'fa-chevron-down');
        chevron.classList.add('ss-card-chevron');
        head.append(icon(doc, entry.screen.icon), make(doc, 'span', 'ss-card-title', entry.screen.title ?? entry.id), summary, chevron);
        const body = make(doc, 'div', 'ss-card-body');
        body.hidden = true;
        node.append(head, body);
        cards.set(node, { index, screenId: entry.id, head, body, drawn: false, handle: null });
        head.addEventListener('click', () => toggle(index, entry.id));
        return node;
    }

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

    /** Draws (or reuses) the cards under carrier `index`. */
    function refresh(index, { force = false } = {}) {
        if (force) dropIndex(index);
        const message = messageElement(index);
        if (!message) return;
        let box = boxOf(message);
        const entries = deps.carriers().includes(index) && hasCard(index) ? screensFor(deps, 'card') : [];
        if (!entries.length) {
            box?.remove();
            return;
        }
        if (observer) {
            if (!observed.has(message)) {
                observed.add(message);
                observer.observe(message);
            }
            if (!visible.has(index)) return;
        }
        const state = deps.stateAt(index);
        const rev = Number.isInteger(state?.meta?.rev) ? state.meta.rev : 0;
        const swipe = swipeAt(index) ?? 0;
        const version = deps.screens.version?.() ?? 0;
        const nodes = entries.map(entry => {
            const key = `${entry.id}|${index}|${swipe}|${rev}|${version}`;
            const hit = cache.get(key);
            const node = hit ? hit.node : buildCard(entry, index);
            remember(key, node, index);
            setOpen(node, expanded.has(`${index}|${entry.id}`));
            return node;
        });
        if (!box) {
            box = make(doc, 'div', 'ss-cards');
            (message.querySelector('.mes_block') ?? message).appendChild(box);
        }
        box.setAttribute('data-ss-index', String(index));
        const current = Array.from(box.children);
        if (current.length !== nodes.length || current.some((node, i) => node !== nodes[i])) box.replaceChildren(...nodes);
    }

    /** Finds every carrier's message and draws the cards of those on screen. */
    function attachAll() {
        for (const index of deps.carriers()) refresh(index);
    }

    function refreshAll({ force = false } = {}) {
        if (force) cache.clear();
        attachAll();
    }

    /** Opens or closes one card (the header button does this). */
    function toggle(index, screenId, open = null) {
        const key = `${index}|${screenId}`;
        const next = open === null ? !expanded.has(key) : !!open;
        if (next) expanded.add(key);
        else expanded.delete(key);
        const box = messageElement(index) && boxOf(messageElement(index));
        const node = Array.from(box?.children ?? []).find(child => child.getAttribute('data-ss-card') === screenId);
        if (node) setOpen(node, next);
        return next;
    }

    // Indexes move after a delete or a chat change: forget everything tied to an index.
    function forgetAll() {
        cache.clear();
        expanded.clear();
        visible.clear();
        observer?.disconnect();
        observed = new WeakSet();
    }

    const onSwipe = value => refresh(indexOf(value));
    const onEdit = value => refresh(indexOf(value), { force: true });
    const onDelete = () => { forgetAll(); attachAll(); };
    const onChatChanged = () => { forgetAll(); attachAll(); };
    const onRendered = value => refresh(indexOf(value));

    const offs = [onHead(deps, () => attachAll())];
    if (deps.eventSource && deps.eventTypes) {
        const types = deps.eventTypes;
        const wire = [
            [types.MESSAGE_SWIPED, onSwipe], [types.MESSAGE_EDITED, onEdit], [types.MESSAGE_UPDATED, onEdit],
            [types.MESSAGE_DELETED, onDelete], [types.CHAT_CHANGED, onChatChanged],
            [types.CHARACTER_MESSAGE_RENDERED, onRendered], [types.MORE_MESSAGES_LOADED, attachAll],
        ].filter(([type]) => type);
        for (const [type, fn] of wire) deps.eventSource.on(type, fn);
        offs.push(() => {
            for (const [type, fn] of wire) (deps.eventSource.removeListener ?? deps.eventSource.off)?.call(deps.eventSource, type, fn);
        });
    }

    return {
        mount,
        attachAll,
        refresh,
        refreshAll,
        toggle,
        onSwipe,
        onEdit,
        onDelete,
        onChatChanged,
        cacheSize: () => cache.size,
        destroy() {
            offs.forEach(off => off());
            forgetAll();
            observer = null;
        },
    };
}
