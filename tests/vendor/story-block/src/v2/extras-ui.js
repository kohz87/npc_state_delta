// Story Block v2: Choices under a reply (src/v2/extras.js, MODULES §F115). ui-host.js creates one per page.
//
// * **Choices** (`story-block.choices`): the latest reply's `? choice` lines as a row of buttons, only
//   while no message of the reader's came after it (they are for the next move). A click puts the text
//   into SillyTavern's message box (after anything already typed there) and nothing else: it never
//   sends, never runs a command, never changes the story (MODULES §F95, §F96).
// * Inner chatter is no longer drawn under replies (the user, 2026-10-22): each thought shows next to the
//   person who had it, on Story Director's World → Now (`chatter.head`), or on Story Block's Scene screen
//   without it (`scene.chatter`, MODULES §F115).
//
// What is drawn is read from the reply's shown text every time (`display(mes)`, runtime.display), so the
// live reply, a Re-read, a swipe, a delete and a reload agree; nothing is kept. Every text is set with
// textContent; nothing the story wrote becomes markup. The texts are in strings.js.

import { readRecord, swipeOf } from './persist.js';
import { CHOICES_FEATURE } from './extras.js';
import { STRINGS } from './strings.js';

const X = STRINGS.extras;
export const EXTRAS_CLASS = 'story-suite-extras';
/** How many of the last drawn messages a redraw after a new message, a turn or a rebuild goes over. */
export const RECENT_MESSAGES = 30;

function byId(doc, id) {
    if (typeof doc?.getElementById === 'function') return doc.getElementById(id);
    return typeof doc?.querySelector === 'function' ? doc.querySelector(`#${id}`) : null;
}

// A phone or tablet: focusing the box would pop the keyboard and shove the page up.
function touchScreen(doc) {
    const matchMedia = doc?.defaultView?.matchMedia;
    if (typeof matchMedia !== 'function') return false;
    try { return Boolean(matchMedia.call(doc.defaultView, '(pointer: coarse), (hover: none)')?.matches); } catch { return false; }
}

/**
 * Puts `text` into SillyTavern's message box (#send_textarea), after what the reader already typed
 * (one space between, or their line break), and fires `input` so SillyTavern resizes the box. Never
 * sends: there is no send path here at all. → 'filled' | 'unavailable'.
 */
export function fillInput(text, { document: doc = globalThis.document } = {}) {
    const box = byId(doc, 'send_textarea');
    if (!box) return 'unavailable';
    const add = String(text ?? '').trim();
    const existing = String(box.value ?? '');
    const kept = existing.trimEnd();
    if (!kept) box.value = add;
    else if (add) box.value = `${kept}${existing.slice(kept.length).includes('\n') ? '\n' : ' '}${add}`;
    const EventType = doc?.defaultView?.Event ?? globalThis.Event;
    if (typeof box.dispatchEvent === 'function' && typeof EventType === 'function') box.dispatchEvent(new EventType('input', { bubbles: true }));
    if (!touchScreen(doc)) box.focus?.();
    try { box.setSelectionRange?.(box.value.length, box.value.length); } catch { /* the caret is a nicety */ }
    return 'filled';
}

/**
 * createReplyExtras({ ctx, doc?, display(mes) → { choice? }, featureOn(id) → bool, events?,
 * messageElement?(index), fill?(text) }) → { refresh(index), refreshAll({ recent }), extrasAt(index), destroy() }.
 * Long chats: a new message, a turn or a rebuild redraws the last RECENT_MESSAGES drawn messages only (it can
 * only change the latest reply's Choices); a chat opened, a delete, more messages loaded or a feature
 * switched go over every drawn message. Each pass finds the messages with one query.
 */
export function createReplyExtras({
    ctx, doc = globalThis.document, display, featureOn = () => false, events = null, messageElement = null, fill: fillBox = null,
} = {}) {
    const chat = () => (Array.isArray(ctx?.chat) ? ctx.chat : []);
    const elementOf = messageElement ?? (index => doc.querySelector(`.mes[mesid="${index}"]`));
    const keyOf = index => `${index}|${swipeOf(chat()[index])}`;
    const on = id => { try { return featureOn(id) === true; } catch { return false; } };

    // A reply Story Block read (its shown swipe has a record), after the reader's first message.
    function isReply(index) {
        const list = chat();
        const message = list[index];
        if (!message || message.is_user || message.is_system || !readRecord(message)) return false;
        const firstUser = list.findIndex(item => item?.is_user);
        return firstUser >= 0 && index > firstUser;
    }
    // The newest message, and no message of the reader's after it: its choices are the next move.
    const isLatest = index => index === chat().length - 1;

    /** What reply `index` shows now: { choices: [{ text }] } (never its chatter). */
    function extrasAt(index) {
        if (!isReply(index) || !on(CHOICES_FEATURE) || !isLatest(index)) return { choices: [] };
        let read = {};
        try { read = display(String(chat()[index]?.mes ?? '')) ?? {}; } catch { read = {}; }
        return { choices: (read.choice ?? []).map(item => ({ text: item.text })) };
    }

    function el(tag, className, text) {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }
    function glyph(name) {
        const node = el('i', `fa-solid ${name}`);
        node.setAttribute('aria-hidden', 'true');
        return node;
    }
    function button(className, text, title) {
        const node = el('button', className, text);
        node.type = 'button';
        node.setAttribute('type', 'button');
        if (title) node.setAttribute('title', title);
        return node;
    }

    // The strip is folded by default (the beta test's request): its summary says what is under it and how many
    // there are; opened, one option per row, each a full-width glass button that fills the message box.
    function build(index, shown) {
        const root = el('div', EXTRAS_CLASS);
        root.setAttribute('data-ss-index', String(index));
        if (shown.choices.length) {
            const fold = el('details', 'story-suite-choices-fold');
            const summary = el('summary', 'story-suite-choices-summary');
            const chevron = glyph('fa-chevron-down');
            chevron.classList.add('story-suite-choices-chevron');
            summary.append(glyph('fa-signs-post'), el('span', 'story-suite-choices-label', X.choices), el('span', 'story-suite-choices-count', String(shown.choices.length)), chevron);
            const row = el('div', 'story-suite-choices');
            row.setAttribute('role', 'group');
            row.setAttribute('aria-label', X.choices);
            for (const choice of shown.choices) {
                const node = button('story-suite-choice', choice.text, X.choiceTitle);
                node.addEventListener('click', event => {
                    event?.preventDefault?.();
                    event?.stopPropagation?.();
                    (fillBox ?? (text => fillInput(text, { document: doc })))(choice.text);
                });
                row.appendChild(node);
            }
            fold.append(summary, row);
            root.appendChild(fold);
        }
        return root;
    }

    // Under the reply's text (and its note), before the cards.
    function place(message, node) {
        const text = message.querySelector('.mes_text');
        const parent = text?.parentNode ?? message.querySelector('.mes_block') ?? message;
        const cards = Array.from(parent.children ?? []).find(child => String(child.className ?? '').split(/\s+/).includes('ss-cards'));
        if (node.parentNode === parent && (cards ? node.nextElementSibling === cards : true)) return;
        parent.insertBefore(node, cards ?? null);
    }

    /** Draws, updates or removes the extras under reply `index` (when SillyTavern has drawn it). */
    function refresh(index, element = null) {
        const message = element ?? elementOf(index);
        if (!message) return null;
        const old = message.querySelector(`.${EXTRAS_CLASS}`);
        const shown = extrasAt(index);
        if (!shown.choices.length) {
            old?.remove();
            return null;
        }
        const sign = JSON.stringify([keyOf(index), shown]);
        if (old && old.getAttribute('data-ss-sign') === sign) {
            place(message, old);
            return old;
        }
        const node = build(index, shown);
        node.setAttribute('data-ss-sign', sign);
        old?.remove();
        place(message, node);
        return node;
    }

    function refreshAll({ recent = false } = {}) {
        const drawn = Array.from(doc.querySelectorAll('.mes[mesid]'));
        for (const message of recent ? drawn.slice(Math.max(0, drawn.length - RECENT_MESSAGES)) : drawn) {
            const index = Number(message.getAttribute('mesid'));
            if (Number.isInteger(index)) refresh(index, messageElement ? null : message);
        }
    }

    // ---- following SillyTavern and the runtime ----------------------------------------------
    // A new message moves "the latest", so every change redraws them all (each is cheap: the reply's
    // own text is read, and an unchanged strip is kept as it is).
    const offs = [];
    const source = ctx?.eventSource;
    const types = ctx?.eventTypes ?? ctx?.event_types ?? {};
    if (typeof source?.on === 'function') {
        const all = () => refreshAll({ recent: true });
        const forget = () => refreshAll();
        const wire = [
            [types.CHARACTER_MESSAGE_RENDERED, all], [types.USER_MESSAGE_RENDERED, all], [types.MESSAGE_SWIPED, all],
            [types.MESSAGE_EDITED, all], [types.MESSAGE_UPDATED, all], [types.MESSAGE_SENT, all],
            [types.MESSAGE_DELETED, forget], [types.CHAT_CHANGED, forget], [types.MORE_MESSAGES_LOADED, () => refreshAll()],
        ].filter(([type]) => type);
        for (const [type, fn] of wire) source.on(type, fn);
        offs.push(() => {
            for (const [type, fn] of wire) (source.removeListener ?? source.off)?.call(source, type, fn);
        });
    }
    if (typeof events?.on === 'function') {
        for (const name of ['turn', 'head', 'feature']) {
            const off = events.on(name, () => refreshAll({ recent: name !== 'feature' }));
            if (typeof off === 'function') offs.push(off);
        }
    }

    return {
        refresh,
        refreshAll,
        extrasAt,
        destroy() {
            offs.splice(0).forEach(off => off());
            for (const node of doc.querySelectorAll(`.${EXTRAS_CLASS}`)) node.remove();
        },
    };
}
