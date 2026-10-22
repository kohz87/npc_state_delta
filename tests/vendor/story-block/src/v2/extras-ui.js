// Story Block v2: Choices and Inner chatter under a reply (src/v2/extras.js, MODULES §F115). ui-host.js
// creates one per page.
//
// * **Choices** (`story-block.choices`): the latest reply's `? choice` lines as a row of buttons, only
//   while no message of the reader's came after it (they are for the next move). A click puts the text
//   into SillyTavern's message box (after anything already typed there) and nothing else: it never
//   sends, never runs a command, never changes the story (MODULES §F95, §F96).
// * **Inner chatter** (`story-block.chatter`): each reply's `~ chatter` lines in a strip that starts
//   folded ("Inner chatter (2)"), one per thinker: the name, then the thought. With NPC State Delta
//   installed and knowing the name (`npc.dossier` answers), the name is a chip that opens that dossier;
//   without it, the plain name (MODULES §F11).
//
// What is drawn is read from the reply's shown text every time (`display(mes)`, runtime.display), so the
// live reply, a Re-read, a swipe, a delete and a reload agree; nothing is kept but which strips the
// reader opened in this session. Every text is set with textContent; nothing the story wrote becomes
// markup. The texts are in strings.js.

import { readRecord, swipeOf } from './persist.js';
import { CHATTER_FEATURE, CHOICES_FEATURE } from './extras.js';
import { STRINGS, fill } from './strings.js';

const X = STRINGS.extras;
export const EXTRAS_CLASS = 'story-suite-extras';

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
 * createReplyExtras({ ctx, doc?, display(mes) → { choice?, chatter? }, featureOn(id) → bool,
 * query?(name, args), openDossier?(name) → any, events?, messageElement?(index), fill?(text) })
 * → { refresh(index), refreshAll(), extrasAt(index), destroy() }.
 * `openDossier` defaults to NPC State Delta's own (`globalThis.NPCStateDelta.openDossier`) when present.
 */
export function createReplyExtras({
    ctx, doc = globalThis.document, display, featureOn = () => false, query = null, events = null,
    openDossier = name => globalThis.NPCStateDelta?.openDossier?.(name), messageElement = null, fill: fillBox = null,
} = {}) {
    const chat = () => (Array.isArray(ctx?.chat) ? ctx.chat : []);
    const elementOf = messageElement ?? (index => doc.querySelector(`.mes[mesid="${index}"]`));
    const opened = new Set();   // `${index}|${swipe}` of the chatter strips the reader opened
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

    /** What reply `index` shows now: { choices: [{ text }], chatter: [{ name, text, dossier }] }. */
    function extrasAt(index) {
        const empty = { choices: [], chatter: [] };
        if (!isReply(index)) return empty;
        const wantChoices = on(CHOICES_FEATURE) && isLatest(index);
        const wantChatter = on(CHATTER_FEATURE);
        if (!wantChoices && !wantChatter) return empty;
        let read = {};
        try { read = display(String(chat()[index]?.mes ?? '')) ?? {}; } catch { read = {}; }
        const known = name => {
            if (typeof query !== 'function' || typeof openDossier !== 'function') return false;
            try { return query('npc.dossier', { name }) != null; } catch { return false; }
        };
        return {
            choices: wantChoices ? (read.choice ?? []).map(item => ({ text: item.text })) : [],
            chatter: wantChatter ? (read.chatter ?? []).map(item => ({ name: item.name, text: item.text, dossier: known(item.name) })) : [],
        };
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

    function build(index, shown) {
        const root = el('div', EXTRAS_CLASS);
        root.setAttribute('data-ss-index', String(index));
        if (shown.choices.length) {
            const row = el('div', 'story-suite-choices');
            row.setAttribute('role', 'group');
            row.setAttribute('aria-label', X.choices);
            row.appendChild(glyph('fa-signs-post'));
            for (const choice of shown.choices) {
                const node = button('story-suite-choice', choice.text, X.choiceTitle);
                node.addEventListener('click', event => {
                    event?.preventDefault?.();
                    event?.stopPropagation?.();
                    (fillBox ?? (text => fillInput(text, { document: doc })))(choice.text);
                });
                row.appendChild(node);
            }
            root.appendChild(row);
        }
        if (shown.chatter.length) {
            const strip = el('div', 'story-suite-chatter');
            const head = button('story-suite-chatter-head');
            const body = el('ul', 'story-suite-chatter-list');
            head.append(glyph('fa-comment-dots'), el('span', 'story-suite-chatter-title', X.chatter), el('span', 'story-suite-chatter-count', `(${shown.chatter.length})`), glyph('fa-chevron-down'));
            const key = keyOf(index);
            const setOpen = open => {
                head.setAttribute('aria-expanded', open ? 'true' : 'false');
                strip.classList?.toggle?.('story-suite-chatter-open', open);
                body.hidden = !open;
                if (open) opened.add(key);
                else opened.delete(key);
            };
            head.addEventListener('click', event => {
                event?.stopPropagation?.();
                setOpen(body.hidden);
            });
            for (const item of shown.chatter) {
                const row = el('li', 'story-suite-chatter-line');
                let name;
                if (item.dossier) {
                    name = button('story-suite-chatter-name story-suite-chatter-dossier', item.name, fill(X.dossierTitle, { name: item.name }));
                    name.addEventListener('click', event => {
                        event?.stopPropagation?.();
                        try { openDossier(item.name); } catch { /* NPC State Delta went away: nothing to open */ }
                    });
                } else name = el('span', 'story-suite-chatter-name', item.name);
                row.append(name, el('span', 'story-suite-chatter-text', item.text));
                body.appendChild(row);
            }
            strip.append(head, body);
            setOpen(opened.has(key));
            root.appendChild(strip);
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
    function refresh(index) {
        const message = elementOf(index);
        if (!message) return null;
        const old = message.querySelector(`.${EXTRAS_CLASS}`);
        const shown = extrasAt(index);
        if (!shown.choices.length && !shown.chatter.length) {
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

    function refreshAll() {
        for (const message of doc.querySelectorAll('.mes[mesid]')) {
            const index = Number(message.getAttribute('mesid'));
            if (Number.isInteger(index)) refresh(index);
        }
    }

    // ---- following SillyTavern and the runtime ----------------------------------------------
    // A new message moves "the latest", so every change redraws them all (each is cheap: the reply's
    // own text is read, and an unchanged strip is kept as it is).
    const offs = [];
    const source = ctx?.eventSource;
    const types = ctx?.eventTypes ?? ctx?.event_types ?? {};
    if (typeof source?.on === 'function') {
        const all = () => refreshAll();
        const forget = () => { opened.clear(); refreshAll(); };
        const wire = [
            [types.CHARACTER_MESSAGE_RENDERED, all], [types.USER_MESSAGE_RENDERED, all], [types.MESSAGE_SWIPED, all],
            [types.MESSAGE_EDITED, all], [types.MESSAGE_UPDATED, all], [types.MESSAGE_SENT, all],
            [types.MESSAGE_DELETED, forget], [types.CHAT_CHANGED, forget], [types.MORE_MESSAGES_LOADED, all],
        ].filter(([type]) => type);
        for (const [type, fn] of wire) source.on(type, fn);
        offs.push(() => {
            for (const [type, fn] of wire) (source.removeListener ?? source.off)?.call(source, type, fn);
        });
    }
    if (typeof events?.on === 'function') {
        for (const name of ['turn', 'head', 'feature']) {
            const off = events.on(name, () => refreshAll());
            if (typeof off === 'function') offs.push(off);
        }
    }

    return {
        refresh,
        refreshAll,
        extrasAt,
        destroy() {
            offs.splice(0).forEach(off => off());
            opened.clear();
            for (const node of doc.querySelectorAll(`.${EXTRAS_CLASS}`)) node.remove();
        },
    };
}
