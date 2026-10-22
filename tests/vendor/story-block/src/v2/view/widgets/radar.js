// radar: a polygon chart over several axes (stats, affinities), with an optional "before" series drawn
// under the current one (a level-up preview, gear compared). The chart is SVG; a visually hidden list
// carries the same numbers for screen readers. The axis labels scale with the chart but never show
// smaller than LABEL_MIN_PX on screen (the chart's drawn width is watched where ResizeObserver exists).

import { clamp, fmt, h, num, s, setTone, shell, str } from './dom.js';
import { defineWidget, resolveProps } from './props.js';

const RADIUS = 100;
const LABEL_GAP = 14;
const MAX_AXES = 24;
const VIEW_WIDTH = 2 * RADIUS + 120;
export const LABEL_MIN_PX = 11;

/**
 * The axis label size in the chart's own units for a chart drawn `width` px wide: LABEL_MIN_PX units
 * (which grow with a big chart), more when the chart is drawn small, so a label never shows under
 * LABEL_MIN_PX on screen.
 */
export function labelUnits(width) {
    if (!(Number.isFinite(width) && width > 0)) return LABEL_MIN_PX;
    return Math.max(LABEL_MIN_PX, Math.ceil((LABEL_MIN_PX * VIEW_WIDTH / width) * 10) / 10);
}

const props = {
    axes: { type: 'array', required: true, default: Object.freeze([]) },   // [{ label, value, max, before }]
    before: { type: 'array', default: null },                             // numbers by axis index
    label: { type: 'string', default: '' },
    tone: { type: 'string', default: 'accent' },
    levels: { type: 'number', default: 4 },
    max: { type: 'number', default: 0 },          // shared max for axes without one (0: the largest value)
    showValues: { type: 'boolean', default: true },
};

/** Clean axes: label, value, max and optional before, at most 24. */
export function radarAxes(axes, before, sharedMax = 0) {
    const list = (Array.isArray(axes) ? axes : []).slice(0, MAX_AXES).map((axis, index) => {
        const item = axis && typeof axis === 'object' ? axis : { value: axis };
        const prior = item.before ?? (Array.isArray(before) ? before[index] : undefined);
        return {
            label: str(item.label) || str(item.name),
            value: Math.max(0, num(item.value, 0)),
            max: num(item.max, 0),
            before: prior === undefined || prior === null || !Number.isFinite(num(prior, NaN)) ? null : Math.max(0, num(prior, 0)),
        };
    });
    const top = Math.max(1, num(sharedMax, 0), ...list.map(axis => Math.max(axis.value, axis.before ?? 0)));
    for (const axis of list) if (!(axis.max > 0)) axis.max = num(sharedMax, 0) > 0 ? num(sharedMax, 0) : top;
    return list;
}

/** The point for a ratio on axis `index` of `count`, starting at the top and going clockwise. */
export function radarPoint(index, count, ratio, radius = RADIUS) {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / count;
    const r = clamp(ratio, 0, 1) * radius;
    return { x: Math.round(Math.cos(angle) * r * 100) / 100, y: Math.round(Math.sin(angle) * r * 100) / 100 };
}

/** The SVG `points` string of a series (ratios by axis). */
export function radarPoints(ratios) {
    return ratios.map((ratio, index) => {
        const point = radarPoint(index, ratios.length, ratio);
        return `${fmt(point.x)},${fmt(point.y)}`;
    }).join(' ');
}

function render(el, input) {
    return shell(el, 'figure', 'radar', ({ doc, root, cleanup }) => {
        const svg = s(doc, 'svg', {
            class: 'ss-w-radar-svg',
            viewBox: `${-RADIUS - 60} ${-RADIUS - 24} ${VIEW_WIDTH} ${2 * RADIUS + 48}`,
            'aria-hidden': 'true',
            focusable: 'false',
        });
        const list = h(doc, 'ul', 'ss-w-sr');
        const caption = h(doc, 'figcaption', 'ss-w-radar-caption');
        const empty = h(doc, 'p', 'ss-w-empty-note', 'Nothing to chart.');
        root.append(caption, svg, list, empty);
        // Readable labels at any size: the size in chart units follows the width the chart is drawn at.
        const fit = () => {
            const width = svg.getBoundingClientRect?.().width ?? 0;
            if (width > 0) svg.style?.setProperty?.('--ss-w-radar-label', String(labelUnits(width)));
        };
        const Observer = doc.defaultView?.ResizeObserver;
        if (typeof Observer === 'function') {
            const observer = new Observer(fit);
            observer.observe(svg);
            cleanup(() => observer.disconnect());
        }

        function update(next) {
            const p = resolveProps(props, next);
            const axes = radarAxes(p.axes, p.before, p.max);
            setTone(root, p.tone);
            caption.textContent = p.label;
            caption.hidden = !p.label;
            if (p.label) root.setAttribute('aria-label', p.label);
            else root.removeAttribute('aria-label');
            empty.hidden = axes.length > 0;
            svg.replaceChildren();
            list.replaceChildren();
            if (!axes.length) return;
            const count = axes.length;
            const levels = clamp(Math.floor(num(p.levels, 4)), 1, 10);
            const grid = s(doc, 'g', { class: 'ss-w-radar-grid' });
            for (let level = 1; level <= levels; level++) {
                grid.appendChild(s(doc, 'polygon', { class: 'ss-w-radar-ring', points: radarPoints(axes.map(() => level / levels)) }));
            }
            axes.forEach((axis, index) => {
                const end = radarPoint(index, count, 1);
                grid.appendChild(s(doc, 'line', { class: 'ss-w-radar-spoke', x1: 0, y1: 0, x2: fmt(end.x), y2: fmt(end.y) }));
            });
            svg.appendChild(grid);
            const hasBefore = axes.some(axis => axis.before !== null);
            if (hasBefore) {
                svg.appendChild(s(doc, 'polygon', {
                    class: 'ss-w-radar-before',
                    points: radarPoints(axes.map(axis => (axis.before ?? axis.value) / axis.max)),
                }));
            }
            svg.appendChild(s(doc, 'polygon', { class: 'ss-w-radar-area', points: radarPoints(axes.map(axis => axis.value / axis.max)) }));
            const labels = s(doc, 'g', { class: 'ss-w-radar-labels' });
            axes.forEach((axis, index) => {
                const dot = radarPoint(index, count, axis.value / axis.max);
                const changed = axis.before !== null && axis.before !== axis.value;
                const point = s(doc, 'circle', { class: 'ss-w-radar-dot', cx: fmt(dot.x), cy: fmt(dot.y), r: 3 });
                if (changed) point.classList.add(axis.value > axis.before ? 'ss-w-up' : 'ss-w-down');
                svg.appendChild(point);
                const at = radarPoint(index, count, 1, RADIUS + LABEL_GAP);
                const anchor = Math.abs(at.x) < 1 ? 'middle' : at.x > 0 ? 'start' : 'end';
                const text = s(doc, 'text', {
                    class: 'ss-w-radar-label',
                    x: fmt(at.x),
                    y: fmt(at.y),
                    'text-anchor': anchor,
                    'dominant-baseline': Math.abs(at.y) < 1 ? 'middle' : at.y > 0 ? 'hanging' : 'auto',
                });
                text.textContent = axis.label;
                if (p.showValues) {
                    const value = s(doc, 'tspan', { class: 'ss-w-radar-value', dx: 4 });
                    value.textContent = fmt(axis.value);
                    text.appendChild(value);
                }
                labels.appendChild(text);
                const item = h(doc, 'li', '', changed
                    ? `${axis.label}: ${fmt(axis.value)} of ${fmt(axis.max)} (was ${fmt(axis.before)})`
                    : `${axis.label}: ${fmt(axis.value)} of ${fmt(axis.max)}`);
                list.appendChild(item);
            });
            svg.appendChild(labels);
        }

        update(input);
        return { update };
    });
}

export const radar = defineWidget({ props, primary: 'axes', render });
