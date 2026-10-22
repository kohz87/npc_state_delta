// Chatter display: an NPC Inner Chatter block as a whisper thread or a pull quote.
// Ported from Megumin Suite's Whisper Thread / Interior (GPL-3.0, renderChatter in
// src/blocks/treatments.js), rebuilt from elements and text nodes instead of HTML strings.
//
// Two or more speakers: chat bubbles in one column (sidebars are narrow, so no
// left/right alternation), the speaker's name above each run of consecutive lines, and
// a colour per speaker that stays the same across replies (speakerHue). One speaker: a
// pull quote with the name under it, because a private thought is not dialogue.
//
// The text stays the state: parseChatter reads it on every render, and anything it will
// not read as speaker lines goes to the plain display, so nothing the model wrote is
// lost to the bubbles.

import { parseChatter, speakerHue } from '../../chatter.js';
import { blockName, el, emptyText, plural, renderEmpty, renderFrame } from '../dom.js';
import { appendInline, plainTextOf, render as renderPlain } from './plain.js';

const key = name => String(name ?? '').toLowerCase();

function appendLines(parent, text) {
    String(text ?? '').split('\n').forEach((line, index) => {
        if (index) parent.appendChild(el('br'));
        appendInline(parent, line);
    });
    return parent;
}

// One said (or thought) line, with its stage note ("whispering to Brenn") as a small
// label first, so it is read before the words it qualifies.
function lineNode(tag, line) {
    const node = el(tag, 'story-block-chatter-line');
    if (line.note) node.appendChild(el('span', 'story-block-chatter-note', line.note));
    node.appendChild(appendLines(el('span', 'story-block-chatter-text'), line.text));
    return node;
}

// Consecutive lines from the same speaker share one bubble and one name.
function runsOf(lines) {
    const runs = [];
    for (const line of lines) {
        const last = runs[runs.length - 1];
        if (last && key(last.speaker) === key(line.speaker)) last.lines.push(line);
        else runs.push({ speaker: line.speaker, lines: [line] });
    }
    return runs;
}

function renderThread(def, lines) {
    const thread = el('ol', 'story-block-chatter-thread');
    thread.setAttribute('aria-label', blockName(def));
    for (const run of runsOf(lines)) {
        const item = el('li', `story-block-chatter-run is-hue-${speakerHue(run.speaker)}`);
        // The initial is decoration: the name is right beside it in the bubble.
        const initial = (run.speaker.match(/\p{L}|\p{N}/u) ?? ['?'])[0].toUpperCase();
        const avatar = el('span', 'story-block-chatter-avatar', initial);
        avatar.setAttribute('aria-hidden', 'true');
        const bubble = el('div', 'story-block-chatter-bubble');
        bubble.appendChild(el('div', 'story-block-chatter-name', run.speaker));
        for (const line of run.lines) bubble.appendChild(lineNode('div', line));
        item.append(avatar, bubble);
        thread.appendChild(item);
    }
    return thread;
}

function renderThought(lines) {
    const speaker = lines[0].speaker;
    const figure = el('figure', `story-block-chatter-thought is-hue-${speakerHue(speaker)}`);
    const quote = el('blockquote', 'story-block-chatter-quote');
    for (const line of lines) quote.appendChild(lineNode('p', line));
    figure.append(quote, el('figcaption', 'story-block-chatter-who', speaker));
    return figure;
}

export function render(pane, { def, state, error = null, truncated = false, onEdit = null, uiKey = null } = {}) {
    void uiKey; // Accepted like the other displays; nothing here is remembered per card.
    const text = plainTextOf(state).replace(/\r\n?/g, '\n').trim();
    const parsed = text ? parseChatter(text) : null;
    // Not text, or text that is not speaker lines: the plain display draws every word.
    if ((state && typeof state.text !== 'string') || (text && !parsed)) {
        pane.classList.remove('story-block-display-chatter');
        renderPlain(pane, { def, state, error, truncated, onEdit });
        return;
    }
    pane.classList.remove('story-block-display-plain');

    const speakers = parsed ? new Set(parsed.lines.map(line => key(line.speaker))).size : 0;
    renderFrame(pane, {
        def, error, truncated, onEdit,
        display: 'chatter',
        summary: speakers ? plural(speakers, 'speaker') : '',
    });
    if (!parsed) {
        renderEmpty(pane, emptyText(def, state));
        return;
    }

    const body = el('div', `story-block-display-body story-block-chatter is-${parsed.mode}`);
    if (parsed.mode === 'thread') {
        body.appendChild(renderThread(def, parsed.lines));
        body.appendChild(el('div', 'story-block-chatter-aside', 'Not heard by you'));
    } else {
        body.setAttribute('aria-label', blockName(def));
        body.appendChild(renderThought(parsed.lines));
    }
    pane.appendChild(body);
}
