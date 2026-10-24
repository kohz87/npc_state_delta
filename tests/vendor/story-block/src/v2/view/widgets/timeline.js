// timeline: events top to bottom (oldest first, in the order given), with the current one marked; the
// ones before it are `ss-w-past`, after it `ss-w-future`. `current` is an event's `id`, or its index.

import { h, iconNode, num, setData, shell, str } from './dom.js';
import { defineWidget, resolveProps } from './props.js';

const MAX_EVENTS = 500;

const props = {
    events: { type: 'array', required: true, default: Object.freeze([]) },   // [{ id, time, title, text, kind, icon }]
    current: { type: ['string', 'number'], default: null },
    label: { type: 'string', default: 'Timeline' },
};

/** Clean events (at most 500). */
export function timelineEvents(list) {
    return (Array.isArray(list) ? list : []).slice(0, MAX_EVENTS).filter(item => item && typeof item === 'object').map(item => ({
        id: str(item.id),
        time: str(item.time),
        title: str(item.title),
        text: str(item.text),
        kind: str(item.kind),
        icon: str(item.icon),
    }));
}

/** The index of the current event: by id first, then a whole-number index; -1 when none. */
export function currentIndex(events, current) {
    if (current === null || current === undefined || current === '') return -1;
    const byId = events.findIndex(event => event.id && event.id === String(current));
    if (byId >= 0) return byId;
    const index = num(current, NaN);
    return Number.isInteger(index) && index >= 0 && index < events.length ? index : -1;
}

function render(el, input) {
    return shell(el, 'div', 'timeline', ({ doc, root }) => {
        const list = h(doc, 'ol', 'ss-w-tl-list');
        const empty = h(doc, 'p', 'ss-w-empty-note', 'Nothing has happened yet.');
        root.append(list, empty);

        function update(next) {
            const p = resolveProps(props, next);
            const events = timelineEvents(p.events);
            const at = currentIndex(events, p.current);
            list.setAttribute('aria-label', p.label || 'Timeline');
            list.replaceChildren(...events.map((event, index) => {
                const li = h(doc, 'li', 'ss-w-tl-event');
                setData(li, 'kind', event.kind);
                if (at >= 0) li.classList.add(index < at ? 'ss-w-past' : index > at ? 'ss-w-future' : 'ss-w-current');
                const dot = h(doc, 'span', 'ss-w-tl-dot');
                dot.setAttribute('aria-hidden', 'true');
                const glyph = iconNode(doc, event.icon);
                if (glyph) dot.appendChild(glyph);
                const body = h(doc, 'div', 'ss-w-tl-body');
                if (event.time) body.appendChild(h(doc, 'span', 'ss-w-tl-time', event.time));
                if (event.title) body.appendChild(h(doc, 'span', 'ss-w-tl-title', event.title));
                if (event.text) body.appendChild(h(doc, 'p', 'ss-w-tl-text', event.text));
                if (index === at) {
                    li.setAttribute('aria-current', 'step');
                    body.appendChild(h(doc, 'span', 'ss-w-tl-now', 'Now'));
                }
                li.append(dot, body);
                return li;
            }));
            list.hidden = events.length === 0;
            empty.hidden = events.length > 0;
        }

        update(input);
        return { update };
    });
}

export const timeline = defineWidget({ props, primary: 'events', render });
