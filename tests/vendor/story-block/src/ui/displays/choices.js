// Choices display: a CYOA block's options as numbered buttons that fill SillyTavern's
// message box. Ported from Megumin Suite's choice buttons (GPL-3.0).
//
// The only block the reader ACTS on. Anything parseChoices will not read as a clean
// list (prose, notes, an unfilled template) falls back to the plain display, so a
// model that ignored the format still reads fine, it just gets no buttons.
//
// Input: click fills the box, Shift+click (or Shift+Enter on a focused button) sends.
// Touch has no Shift, so every row also carries a small "Send" button. It is a real,
// labelled button rather than a long-press: long-press is invisible, collides with the
// OS text-selection and context menus, and has no keyboard or switch-access equivalent.
// The stylesheet shows it only where a coarse pointer exists or hovering is impossible
// (`any-pointer: coarse`, `hover: none`) and swaps the hint text to match; on a mouse-
// only desktop it stays in the DOM but hidden, since Shift covers it there.

import { fillInput, isSlashCommand, parseChoices } from '../../choices.js';
import { blockName, button, el, emptyText, renderEmpty, renderFrame, stop } from '../dom.js';
import { plainTextOf, render as renderPlain } from './plain.js';

const POINTER_HINT = 'Click fills the message box · Shift-click sends';
const TOUCH_HINT = 'Tap fills the message box · Send sends it';
const SLASH_TITLE = 'Starts with "/", which SillyTavern runs as a command: it is only put in the message box, never sent';

// aria-describedby needs a document-unique id; the same block can be on screen twice
// (card and sidebar), so a counter rather than the block id.
let hintSequence = 0;

function choiceRow(choice, index, hintId) {
    const slash = isSlashCommand(choice);
    const row = el('li', 'story-block-choice');

    const fill = el('button', 'story-block-choice-button');
    fill.type = 'button';
    fill.dataset.choice = choice;
    // The visible choice text is the accessible name (the number is decoration, read
    // from list position); the hint is its description.
    fill.setAttribute('aria-describedby', hintId);
    fill.title = slash ? SLASH_TITLE : choice;
    const number = el('span', 'story-block-choice-number', String(index + 1));
    number.setAttribute('aria-hidden', 'true');
    const arrow = el('i', 'fa-solid fa-arrow-right story-block-choice-arrow');
    arrow.setAttribute('aria-hidden', 'true');
    fill.append(number, el('span', 'story-block-choice-text', choice), arrow);
    fill.addEventListener('click', stop(event => {
        event.preventDefault?.();
        fillInput(choice, { send: Boolean(event.shiftKey) });
    }));
    // A keyboard Enter on a button becomes a click, but whether that click carries
    // shiftKey differs between browsers. Handle Shift+Enter here and cancel the
    // default so the synthetic click does not fill a second copy.
    fill.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || !event.shiftKey) return;
        event.preventDefault?.();
        event.stopPropagation?.();
        fillInput(choice, { send: true });
    });
    row.appendChild(fill);

    // No touch Send for a slash command: it would only fill, which the row already does.
    if (!slash) {
        const send = button('story-block-choice-send', { text: 'Send', title: `Send: ${choice}`, icon: 'fa-paper-plane' });
        send.addEventListener('click', stop(event => {
            event.preventDefault?.();
            fillInput(choice, { send: true });
        }));
        row.appendChild(send);
    }
    return row;
}

export function render(pane, { def, state, error = null, truncated = false, onEdit = null } = {}) {
    const text = plainTextOf(state).replace(/\r\n?/g, '\n').trim();
    if (!text) {
        renderFrame(pane, { def, error, truncated, onEdit, display: 'choices' });
        renderEmpty(pane, emptyText(def, state));
        return;
    }
    // A cut-off block is exactly where a list parser is confidently wrong: the last
    // option may stop mid-sentence and would be sent as if whole. Show it as text.
    const choices = truncated ? null : parseChoices(text);
    if (!choices) {
        renderPlain(pane, { def, state, error, truncated, onEdit });
        return;
    }

    renderFrame(pane, { def, error, truncated, onEdit, display: 'choices' });
    const body = el('div', 'story-block-display-body story-block-choices');
    const hintId = `story-block-choices-hint-${++hintSequence}`;

    const list = el('ol', 'story-block-choices-list');
    list.setAttribute('aria-label', blockName(def));
    choices.forEach((choice, index) => list.appendChild(choiceRow(choice, index, hintId)));

    const hint = el('div', 'story-block-choices-hint');
    hint.id = hintId;
    hint.append(
        el('span', 'story-block-choices-hint-pointer', POINTER_HINT),
        el('span', 'story-block-choices-hint-touch', TOUCH_HINT),
    );
    body.append(hint, list);
    pane.appendChild(body);
}
