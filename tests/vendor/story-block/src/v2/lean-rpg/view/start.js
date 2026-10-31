// A new chat with the RPG on and no character yet (mockup sections 7 and 7b), in two parts that share what the chat remembers (../start.js):
//   * the "Your character" card on Home: the host widget `story-block.rpg-start` (ui-host.js keeps the widget on Home's template and hands
//     it to this file once the RPG screens are loaded). It shows while the RPG is on and the story has no You, with "Create your character"
//     (opens the New character wizard) and "Not now" (hides the card for this chat, stored in the chat's metadata). The Party tab's own
//     "Create your character" stays either way.
//   * the first send: with the RPG on and no You, a normal Send (the Send button, or Enter in the message box; never a swipe, a regenerate, a
//     continue, an impersonation, a quiet or dry run, which do not go through them) is held and the dialog "Make your character first" opens
//     over the chat. The message never leaves the message box while it is held. "Send without the RPG for now" sends it as usual with no dice
//     for that reply and is never asked again in this chat; "Create your character, then send" opens the wizard and sends the message when
//     Create succeeds (the wizard cancelled: the text is back in the box, and the next Send asks again). Closing the dialog puts the text back.
// With the RPG off none of this is mounted (view/index.js is only loaded while the feature is on), so nothing is held.
// Every node is built with createElement and textContent.

import { h, shell } from '../../view/widgets/dom.js';
import { setStartNotes, startNotes } from '../start.js';
import { RPG_STRINGS } from '../strings.js';
import { readParty } from './party-data.js';

const S = RPG_STRINGS.start;
export const START_WIDGET = 'story-block.rpg-start';
export const HOLD_SCREEN_ID = 'story-block/rpg-hold';
export const HOLD_WIDGET = 'rpg.hold';

// How much of the held message the dialog quotes (the whole of it stays in the message box).
const QUOTE_MAX = 280;
const cut = (text, max) => { const chars = [...text]; return chars.length > max ? `${chars.slice(0, max).join('').trimEnd()}…` : text; };

/** The hold dialog's screen: one body, drawn by the hold widget. */
export function createHoldScreen() {
    return Object.freeze({
        id: HOLD_SCREEN_ID, title: S.holdTitle, icon: 'fa-user-plus', mounts: Object.freeze(['dialog']),
        template: `<ss-widget name="${HOLD_WIDGET}"></ss-widget>`,
    });
}

/**
 * The start pieces. `deps`: `doc`, `headState()`, `readerName()`, `featureOn()`, `roleOf(definition)`, `openDialog(id, { draft, onClose })`,
 * `wizard` (view/wizard.js createWizard: `open(prefill, { onEnd })`), `meta()` (the open chat's metadata object, or null),
 * `save()` (writes the chat's metadata), `redraw()` (draws Home again).
 * → { widget, holdWidget, holdScreen, attach(), detach(), hasYou(), session() }.
 */
export function createStart({ doc, headState = () => null, readerName = () => '', featureOn = () => true, roleOf, openDialog = null, wizard = null, meta = () => null, save = () => {}, redraw = () => {} } = {}) {
    let hold = null, bypass = false, attached = false;
    const live = new Set();
    const tell = () => { for (const draw of [...live]) draw(); try { redraw(); } catch { /* Home draws itself again on the next change */ } };
    const notes = () => { try { return startNotes(meta()); } catch { return startNotes(null); } };
    const remember = patch => { try { if (setStartNotes(meta(), patch)) save(); } catch { /* the choice lasts this page only */ } };

    // Whether the story has a character for the reader: one named like their persona (the Party tab's "you"). With no persona name known any
    // character at all counts, since nobody can be told apart.
    const hasYou = () => {
        const name = String(readerName() ?? '').replace(/\s+/g, ' ').trim();
        const party = readParty(headState(), { own: name, roleOf });
        return name ? party.some(character => character.own) : party.length > 0;
    };
    const create = () => { try { wizard?.open(); } catch { /* the dialog may not open here */ } };

    // ---- Home's card ----
    const widget = {
        props: {}, primary: null, validate: () => [],
        render: (el, _props, _api) => shell(el, 'section', 'rpg-start-host', ({ doc: d, root }) => {
            const draw = () => {
                root.replaceChildren();
                const show = featureOn() && !hasYou() && !notes().hidden;
                el.hidden = !show;
                if (!show) return;
                const card = h(d, 'section', 'panel rpg-start');
                card.setAttribute('aria-label', S.homeTitle);
                const head = h(d, 'h4', 'ss-section-label');
                const icon = h(d, 'i', 'fa-solid fa-user-plus');
                icon.setAttribute('aria-hidden', 'true');
                head.append(icon, d.createTextNode(` ${S.homeTitle}`));
                const actions = h(d, 'div', 'rpg-start-actions');
                const make = h(d, 'button', 'ss-button ss-button-primary rpg-start-create', S.homeCreate);
                make.setAttribute('type', 'button');
                make.addEventListener('click', create);
                const later = h(d, 'button', 'ss-button rpg-start-later', S.homeNotNow);
                later.setAttribute('type', 'button');
                later.addEventListener('click', () => { remember({ hidden: true }); tell(); });
                actions.append(make, later);
                card.append(head, h(d, 'p', 'rpg-start-text', S.homeText), actions);
                root.appendChild(card);
            };
            live.add(draw);
            draw();
            return { update() { draw(); }, destroy() { live.delete(draw); root.replaceChildren(); } };
        }),
    };

    // ---- the first send ----
    const box = () => doc.getElementById?.('send_textarea') ?? null;
    const sendButton = () => doc.getElementById?.('send_but') ?? null;
    // A generation is running (SillyTavern shows its Stop button): the Send button does not send then, so nothing is held.
    const generating = () => {
        const stop = doc.getElementById?.('mes_stop');
        if (!stop) return false;
        try { return (doc.defaultView?.getComputedStyle?.(stop)?.display ?? 'none') !== 'none'; } catch { return false; }
    };
    const restore = text => { const field = box(); if (field && !String(field.value ?? '').trim()) { field.value = text; field.dispatchEvent?.(new (doc.defaultView?.Event ?? globalThis.Event)('input', { bubbles: true })); } };
    const sendAgain = () => {
        const button = sendButton();
        if (!button) return;
        bypass = true;
        try { button.click(); } finally { bypass = false; }
    };
    const closeHold = decided => { if (hold) { hold.decided = decided; try { hold.handle?.close?.(); } catch { /* already closed */ } } };

    function openHold(text) {
        if (hold?.handle?.isOpen?.()) return;
        if (typeof openDialog !== 'function') return;
        const own = { text, handle: null, decided: false };
        hold = own;
        const handle = openDialog(HOLD_SCREEN_ID, { draft: {}, onClose: () => {
            if (hold === own) hold = null;
            // Closed without choosing (the window's own close, Escape, a chat change): the text is back in the message box.
            if (!own.decided) restore(own.text);
        } });
        if (!handle) { hold = null; return; }
        own.handle = handle;
    }

    // The first Send of a chat with no character: held. `kind` is 'click' or 'enter'; true when the send was held.
    function intercept(event, kind) {
        if (bypass) return false;
        if (kind === 'click' && !event.target?.closest?.('#send_but')) return false;
        if (!featureOn()) return false;
        const field = box();
        const text = String(field?.value ?? '');
        if (!text.trim() || text.trim().startsWith('/')) return false;
        if (notes().asked || hasYou() || generating()) return false;
        event.preventDefault?.();
        event.stopImmediatePropagation?.();
        event.stopPropagation?.();
        openHold(text);
        return true;
    }
    const onClick = event => { intercept(event, 'click'); };
    const onKey = event => {
        if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.isComposing) return;
        if (doc.activeElement !== box()) return;
        // SillyTavern sends on Enter only when its setting says so; otherwise Enter is a line break and nothing is held.
        let sends = true;
        try { sends = globalThis.SillyTavern?.getContext?.()?.shouldSendOnEnter?.() !== false; } catch { sends = true; }
        if (sends) intercept(event, 'enter');
    };

    /** Starts listening for the Send button and Enter (capture phase, so it comes before SillyTavern's own handlers). */
    function attach() {
        if (attached) return;
        attached = true;
        doc.addEventListener?.('click', onClick, true);
        doc.addEventListener?.('keydown', onKey, true);
    }
    function detach() {
        if (!attached) return;
        attached = false;
        doc.removeEventListener?.('click', onClick, true);
        doc.removeEventListener?.('keydown', onKey, true);
        closeHold(true);
    }

    // The dialog's body.
    const holdWidget = {
        props: {}, primary: null, validate: () => [],
        render: (el, _props, _api) => shell(el, 'section', 'rpg-hold', ({ doc: d, root }) => {
            root.appendChild(h(d, 'p', 'rpg-hold-text', S.holdText));
            const quote = h(d, 'blockquote', 'rpg-hold-quote', cut(hold?.text ?? '', QUOTE_MAX));
            quote.setAttribute('aria-label', S.holdLabel);
            root.appendChild(quote);
            const actions = h(d, 'div', 'rpg-hold-actions');
            const without = h(d, 'button', 'ss-button rpg-hold-without', S.holdWithout);
            without.setAttribute('type', 'button');
            without.addEventListener('click', () => {
                const text = hold?.text;
                if (text === undefined) return;
                // Asked once: never again in this chat. The next reply is sent with no dice.
                remember({ asked: true, skip: true });
                closeHold(true);
                tell();
                sendAgain();
            });
            const make = h(d, 'button', 'ss-button ss-button-primary rpg-hold-create', S.holdCreate);
            make.setAttribute('type', 'button');
            make.addEventListener('click', () => {
                const text = hold?.text;
                if (text === undefined) return;
                closeHold(true);
                // The wizard sends the message when Create succeeds; cancelled, the text is back in the box.
                const opened = wizard?.open(null, { onEnd: created => { if (created) sendAgain(); else restore(text); } });
                if (!opened) restore(text);
            });
            actions.append(without, make);
            root.appendChild(actions);
            return { update() {}, destroy() {} };
        }),
    };

    return { widget, holdWidget, holdScreen: createHoldScreen(), attach, detach, hasYou, session: () => hold };
}
