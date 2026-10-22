// meter: a labelled bar for a value out of a maximum (HP 77/82, XP to next level, a clock's segments).
//
// The fill width is the custom property `--ss-w-ratio` (0…1) on the track, so a screen's CSS decides how
// it looks. With `segments`, the bar is drawn as that many cells, the filled ones marked `ss-w-on`
// (and the one partly filled `ss-w-part`), e.g. charges, pips or a four-part clock.

import { clamp, fmt, h, iconNode, num, setTone, shell, str } from './dom.js';
import { defineWidget, resolveProps } from './props.js';

const MAX_SEGMENTS = 64;

const props = {
    value: { type: 'number', required: true, default: 0 },
    max: { type: 'number', default: 100 },
    min: { type: 'number', default: 0 },
    label: { type: 'string', default: '' },
    tone: { type: 'string', default: 'neutral' },
    segments: { type: 'number', default: 0 },
    icon: { type: 'string', default: '' },
    text: { type: 'string', default: '' },        // the value as shown ("77 / 82" by default)
    showValue: { type: 'boolean', default: true },
};

/** The fill ratio in [0, 1] (0 when the range is empty). */
export function meterRatio(value, min, max) {
    const span = max - min;
    if (!(span > 0)) return 0;
    return clamp((value - min) / span, 0, 1);
}

/** How many of `segments` cells are full, and whether the next one is partly full. */
export function meterCells(ratio, segments) {
    const exact = ratio * segments;
    const full = Math.floor(exact + 1e-9);
    return { full, part: full < segments && exact - full > 1e-9 };
}

function render(el, input) {
    return shell(el, 'div', 'meter', ({ doc, root }) => {
        root.setAttribute('role', 'meter');
        const head = h(doc, 'div', 'ss-w-meter-head');
        const iconSlot = h(doc, 'span', 'ss-w-meter-icon');
        const label = h(doc, 'span', 'ss-w-meter-label');
        const value = h(doc, 'span', 'ss-w-meter-value');
        value.setAttribute('aria-hidden', 'true');
        head.append(iconSlot, label, value);
        const track = h(doc, 'div', 'ss-w-meter-track');
        const fill = h(doc, 'div', 'ss-w-meter-fill');
        const cells = h(doc, 'div', 'ss-w-meter-cells');
        track.append(fill, cells);
        root.append(head, track);

        function update(next) {
            // A bound pool (`hp: { cur, max }`) arrives unfolded as `cur` and `max`.
            const given = next && typeof next === 'object' && next.value === undefined && next.cur !== undefined ? { ...next, value: next.cur } : next;
            const p = resolveProps(props, given);
            const max = num(p.max, 100);
            const min = Math.min(num(p.min, 0), max);
            const current = num(p.value, 0);
            const ratio = meterRatio(current, min, max);
            const shown = str(p.text) || `${fmt(current)} / ${fmt(max)}`;
            setTone(root, p.tone);
            root.classList.toggle('ss-w-full', ratio >= 1);
            root.classList.toggle('ss-w-empty', ratio <= 0);
            root.setAttribute('aria-valuemin', fmt(min));
            root.setAttribute('aria-valuemax', fmt(max));
            root.setAttribute('aria-valuenow', fmt(clamp(current, min, max)));
            root.setAttribute('aria-valuetext', shown);
            if (p.label) root.setAttribute('aria-label', p.label);
            else root.removeAttribute('aria-label');
            const glyph = iconNode(doc, p.icon);
            iconSlot.replaceChildren(...(glyph ? [glyph] : []));
            iconSlot.hidden = !glyph;
            label.textContent = p.label;
            label.hidden = !p.label;
            value.textContent = shown;
            value.hidden = !p.showValue;
            track.style.setProperty('--ss-w-ratio', String(Math.round(ratio * 10000) / 10000));
            const segments = clamp(Math.floor(num(p.segments, 0)), 0, MAX_SEGMENTS);
            root.classList.toggle('ss-w-segmented', segments > 0);
            track.style.setProperty('--ss-w-segments', String(segments || 1));
            const { full, part } = meterCells(ratio, segments);
            const nodes = [];
            for (let i = 0; i < segments; i++) {
                const cell = h(doc, 'span', 'ss-w-meter-cell');
                if (i < full) cell.classList.add('ss-w-on');
                else if (i === full && part) cell.classList.add('ss-w-part');
                nodes.push(cell);
            }
            cells.replaceChildren(...nodes);
        }

        update(input);
        return { update };
    });
}

export const meter = defineWidget({ props, primary: 'value', render });
