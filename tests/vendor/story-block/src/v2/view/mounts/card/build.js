// Builds one reply card and its sections, draws a standalone card body, and opens or closes a card while
// filling every section the first time it opens.

import { STRINGS } from '../../../strings.js';
import { THIS_REPLY_ID, mergeSummaries, sectionHeading } from '../../../reply-cards.js';
import { button, dispose, drawScreen, icon, make } from '../common.js';
import { changeSummary } from './summary.js';

const THIS_REPLY_ICON = 'fa-list-check';

export function createBuilders({ doc, deps, cards, changesAt, opsAt, beforeOf, toggle }) {
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

    // → whether the card changed: it opened or closed, or its sections were drawn.
    function setOpen(node, open) {
        const info = cards.get(node);
        const was = info.body.hidden === false;
        node.classList.toggle('ss-card-open', open);
        info.head.setAttribute('aria-expanded', open ? 'true' : 'false');
        info.body.hidden = !open;
        let drew = false;
        // The first time the card opens every section is filled; one that cannot be drawn leaves the others alone.
        if (open && !info.drawn) {
            info.drawn = true;
            drew = true;
            info.handles = info.sections.map(section => {
                try { return mount(section.body, section.id, { index: info.index }); } catch { return null; }
            });
        }
        return was !== open || drew;
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

    return { mount, setOpen, ownSummary, buildCard };
}
