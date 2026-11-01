// Story Suite v2: the `card` mount (SPEC §13.4). An inline card under each carrier message that gets
// cards (`hasCard`: the host leaves out the greeting and replies with no v2 record), drawn from **that
// reply's** state (`stateAt(index)`, never the head) and the paths its ops changed, so a template's
// `changed(path)` can show "only what changed".
//
// * Under a reply there is ONE card, "This reply", that holds every card screen the reader has on (Story Block's
//   "Changed this reply", any other module's). Cards are off until the reader turns them on,
//   per screen (`screens.setCards`); an off screen is simply not a section, and with one on the card is still "This reply".
//   The card starts collapsed: a header with the title and one line, each section's summary joined with " · " (the screens
//   in `deps.first` lead, the rest keep their order; the full line is the summary's title). Open, each section is its body
//   under a small heading (the screen's own title). The bodies are
//   drawn the first time the card is opened, all together.
// * Only messages on screen are drawn when IntersectionObserver exists; without it every carrier is.
// * Long chats (docs/v2/PERFORMANCE.md): SillyTavern keeps every message drawn in a session on the page, so
//   a pass over all of them on every change grew with the session. A change to the story (`committed`)
//   redraws the head carrier's cards alone (no earlier reply's state changes then); `head` (a rebuild)
//   goes over the last RECENT carriers and those on screen; a chat opened, more messages loaded or a delete
//   go over every drawn message once (to watch them), finding them with one query, not one per message.
//   With no card screen turned on nothing is looked up at all, and any box left over is removed.
// * Drawn cards are cached per (screen, index, swipe, rev, screens version): swiping back or scrolling
//   back reuses the card instead of drawing it again. An edit drops that message's cards; a delete or a
//   chat change drops them all (message indexes move).
//
// deps (see common.js) plus:
//   carriers        () → indexes of the carrier messages (required)
//   hasCard         (index) → whether that carrier gets cards (default: every carrier does)
//   messageElement  (index) → SillyTavern's `.mes[mesid=index]` element (default: a document query)
//   swipeAt         (index) → the message's swipe_id (default 0)
//   summary         (screen, { index, state, changes, before }) → the host's part of the header's line for a card that has no summary of its own
//                   (optional; Story Block's changes card). A card screen's own `summary` (a template read in the card's scope, like
//                   its body) wins; a card with neither adds nothing to the line.
//   first           ids of the card screens that lead the sections, in order (optional; Story Block's changes card)
//   opsAt           (index) → the carrier's own ops (optional; cards get them as `replyOps`)
//   IntersectionObserver  the class to use (default globalThis.IntersectionObserver; null turns it off)
//   eventSource, eventTypes   SillyTavern's, to follow swipes, edits, deletes and renders (optional)
//   replyCards      (index) → the reply cards a module put under that message, drawn after the changes card (optional; reply-cards.js)
//   cacheLimit      how many drawn cards to keep (default 200)
//   recent          how many of the last carriers a `head` pass goes over besides those on screen (default RECENT)
//
// → { mount(el, screenId, { index }) → handle, attachAll({ recent }), refresh(index, { force }), refreshAll({ force }),
//     toggle(index, open?), onSwipe(index), onEdit(index), onDelete(), onChatChanged(),
//     cacheSize(), destroy() }

import { STRINGS } from '../../strings.js';
import { THIS_REPLY_ID, mergeSummaries, orderSections, sectionHeading } from '../../reply-cards.js';
import { button, dispose, documentOf, drawScreen, icon, make, screensFor } from './common.js';

const THIS_REPLY_ICON = 'fa-list-check';

const META = /^\/meta(\/|$)/;

/** How many of the last carriers a redraw after a rebuild goes over, besides those on screen. */
export const RECENT = 30;

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

    const cache = new Map();            // key → { node, index }, oldest first
    const cards = new WeakMap();        // card node → { index, head, body, sections: [{ id, body }], drawn, handles }
    const expanded = new Set();         // indexes whose card is open
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
        // The first time the card opens every section is filled; one that cannot be drawn leaves the others alone.
        if (open && !info.drawn) {
            info.drawn = true;
            info.handles = info.sections.map(section => {
                try { return mount(section.body, section.id, { index: info.index }); } catch { return null; }
            });
        }
    }

    // A card screen's own part of the closed line: its `summary` template, read in the card's scope like its body (the same data, at that
    // reply's state), as plain text. null when the screen has none; '' when it cannot be read (it adds nothing, and stops no other).
    function ownSummary(entry, { index, state, changes, before }) {
        const template = entry.screen?.summary;
        if (typeof template !== 'string' || !template.trim()) return null;
        const span = make(doc, 'span', '');
        try {
            const drawn = drawScreen(span, entry.id, 'card', {
                deps, state, changes, index, extra: { before, replyOps: opsAt(index) ?? [], summary: true },
                screen: { id: entry.id, title: entry.screen.title, mounts: entry.screen.mounts, template },
            });
            return drawn.ok ? String(span.textContent ?? '').replace(/\s+/g, ' ').trim() : '';
        } catch {
            return '';
        } finally {
            dispose(span);
        }
    }

    // The one card: the sections (every card screen on, `entries`) in order, the header's line from each one's own summary.
    function buildCard(entries, index) {
        const state = deps.stateAt(index);
        const changes = changesAt(index) ?? [];
        // The state before the reply is read only for a host or a card that words a summary.
        const before = typeof deps.summary === 'function' || entries.some(entry => typeof entry.screen?.summary === 'string') ? beforeOf(index) : null;
        const node = make(doc, 'div', 'ss-card');
        node.setAttribute('data-ss-card', THIS_REPLY_ID);
        const head = button(doc, 'ss-card-head');
        head.setAttribute('aria-expanded', 'false');
        const parts = entries.map(entry => {
            const own = ownSummary(entry, { index, state, changes, before });
            if (own !== null) return own;
            try { return deps.summary?.(entry.screen, { index, state, changes, before }) ?? ''; } catch { return ''; }
        });
        const line = mergeSummaries(parts) || changeSummary(changes);
        const summary = make(doc, 'span', 'ss-card-summary', line);
        summary.setAttribute('data-slot', 'summary');
        if (line) summary.setAttribute('title', line);
        const chevron = icon(doc, 'fa-chevron-down');
        chevron.classList.add('ss-card-chevron');
        head.append(icon(doc, THIS_REPLY_ICON), make(doc, 'span', 'ss-card-title', STRINGS.thisReply.title), summary, chevron);
        const body = make(doc, 'div', 'ss-card-body');
        body.hidden = true;
        const sections = entries.map(entry => {
            const section = make(doc, 'section', 'ss-card-sec');
            section.setAttribute('data-ss-section', entry.id);
            const heading = make(doc, 'h4', 'ss-card-sec-title', sectionHeading(entry));
            const sectionBody = make(doc, 'div', 'ss-card-sec-body');
            section.append(heading, sectionBody);
            body.appendChild(section);
            return { id: entry.id, body: sectionBody };
        });
        node.append(head, body);
        cards.set(node, { index, head, body, sections, drawn: false, handles: [] });
        head.addEventListener('click', () => toggle(index));
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

    /**
     * Draws (or reuses) the cards under carrier `index`. A pass over many (attachAll) hands in what it
     * worked out once: `element` (the message), `carriers` (a Set) and `entries` (the card screens on).
     */
    function refresh(index, { force = false, element = null, carriers = null, entries: on = null } = {}) {
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
        if (observer) {
            if (!observed.has(message)) {
                observed.add(message);
                observer.observe(message);
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
            const node = hit ? hit.node : buildCard(entries, index);
            remember(key, node, index);
            setOpen(node, expanded.has(index));
            nodes.push(node);
        }
        if (!box) {
            box = make(doc, 'div', 'ss-cards');
            (message.querySelector('.mes_block') ?? message).appendChild(box);
        }
        box.setAttribute('data-ss-index', String(index));
        nodes.push(...replies);
        syncBox(box, nodes);
    }

    // The box shows `nodes`, changing only what differs: a node that stays is not moved, so the focus on it stays. A control that
    // was focused on a node that was drawn again (Later, Open, an action followed by `committed`) gets the focus back on the same
    // control of the card with the same key, else on the card's fold line or Later button, else on its first button.
    function syncBox(box, nodes) {
        const current = Array.from(box.children);
        if (current.length === nodes.length && current.every((node, i) => node === nodes[i])) return;
        const held = focusHeld(box);
        for (const node of current) if (!nodes.includes(node)) node.remove();
        nodes.forEach((node, i) => {
            if (box.children[i] !== node) box.insertBefore(node, box.children[i] ?? null);
        });
        if (held && doc.activeElement !== held.control) restoreFocus(box, held);
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
    function attachAll({ recent = false } = {}) {
        const entries = screensFor(deps, 'card');
        if (!entries.length && !repliesOn()) {
            // No card screen is on: nothing to draw anywhere; a box left from before goes.
            for (const box of Array.from(doc.querySelectorAll?.('.ss-cards') ?? [])) box.remove();
            return;
        }
        const list = deps.carriers();
        const carriers = new Set(list);
        let targets = list;
        if (recent && observer) {
            const near = new Set(list.slice(Math.max(0, list.length - recentCount)));
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

    // A change to the story only changes the head carrier's own state and ops. A reply card another message carries can end or move
    // with it, so the messages on screen are looked at again when the module's cards are on (`replyCards`).
    function onCommitted() {
        const index = typeof deps.headIndex === 'function' ? deps.headIndex() : null;
        if (Number.isInteger(index) && index >= 0) refresh(index);
        if (repliesOn()) refreshDrawnMessages();
    }
    function refreshDrawnMessages() {
        const drawn = drawnMessages();
        if (drawn) for (const [index, element] of drawn) refresh(index, { element });
    }

    /** Opens or closes the reply's one card (the header button does this). */
    function toggle(index, open = null) {
        const next = open === null ? !expanded.has(index) : !!open;
        if (next) expanded.add(index);
        else expanded.delete(index);
        const box = messageElement(index) && boxOf(messageElement(index));
        const node = Array.from(box?.children ?? []).find(child => child.getAttribute('data-ss-card') === THIS_REPLY_ID);
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

    const offs = [];
    if (typeof deps.on === 'function') {
        for (const [event, fn] of [['head', () => { attachAll({ recent: true }); if (repliesOn()) refreshDrawnMessages(); }], ['committed', onCommitted]]) {
            const off = deps.on(event, fn);
            if (typeof off === 'function') offs.push(off);
        }
    }
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
