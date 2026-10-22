// meter: a labelled bar for a value out of a maximum (HP 77/82, XP to next level, a clock's segments).
//
// The fill width is the custom property `--ss-w-ratio` (0…1) on the track, so a screen's CSS decides how
// it looks. With `segments`, the bar is drawn as that many cells, the filled ones marked `ss-w-on`
// (and the one partly filled `ss-w-part`), e.g. charges, pips or a four-part clock.
//
// Marks on the track, each placed by a custom property (0…1 of the range) so CSS decides how it looks:
// * `ceiling`: a notch where the value can go no higher for now (max HP lowered by a wound); the part
//   of the track above it is shaded (`--ss-w-ceiling`).
// * `ticks: [{ at, label }]`: stage marks (a relationship's Wary / Friendly / Close); the stage reached is
//   the last tick at or below the value, named in the head (`ss-w-meter-stage`).
// * `delta`: the change since the last reply, ▲3 or ▼5 in the head (`ss-w-up` / `ss-w-down`).
// * `warnBelow` / `warnAbove`: the critical bands at either end (`--ss-w-warn-lo`, `--ss-w-warn-hi`);
//   a value inside one marks the meter `ss-w-critical` (and the band it is in `ss-w-in`).
// Each is left out when not given or outside the range; the spoken value names them in words.

import { clamp, fmt, h, iconNode, num, setTone, shell, str } from './dom.js';
import { defineWidget, resolveProps } from './props.js';
import { oneLine } from '../../../text.js';

const MAX_SEGMENTS = 64;
const MAX_TICKS = 16;
const TICK_LABEL = 40;

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
    ceiling: { type: 'number', default: null },   // the highest the value can go for now
    ticks: { type: 'array', default: null },      // [{ at, label }] stage marks
    delta: { type: 'number', default: null },     // the change since the last reply
    warnBelow: { type: 'number', default: null }, // a value below this is critical
    warnAbove: { type: 'number', default: null }, // a value above this is critical
};

// A number given as a prop, or null when it is not one (null, '', a word): the mark is left out.
const numberOr = value => (value === null || value === undefined || value === '' ? null : num(value, null));
const ratio4 = value => String(Math.round(value * 10000) / 10000);
// A custom property taken off (an empty value removes it too, where a page has no removeProperty).
const unset = (node, name) => (typeof node.style.removeProperty === 'function' ? node.style.removeProperty(name) : node.style.setProperty(name, ''));

/** The fill ratio in [0, 1] (0 when the range is empty). */
export function meterRatio(value, min, max) {
    const span = max - min;
    if (!(span > 0)) return 0;
    return clamp((value - min) / span, 0, 1);
}

/**
 * The stage marks inside [min, max], in value order: [{ at, ratio, label }] (at most 16; a label is one
 * line of up to 40 characters, '' when not given). Entries without a number `at` are dropped.
 */
export function meterTicks(ticks, min, max) {
    if (!Array.isArray(ticks) || !(max > min)) return [];
    const out = [];
    for (const tick of ticks) {
        if (out.length >= MAX_TICKS) break;
        const at = numberOr(tick && typeof tick === 'object' ? tick.at : null);
        if (at === null || at < min || at > max) continue;
        out.push({ at, ratio: meterRatio(at, min, max), label: oneLine(typeof tick.label === 'string' ? tick.label : str(tick.label), TICK_LABEL) });
    }
    return out.sort((a, b) => a.at - b.at);
}

/** The stage reached: the last tick at or below `value` (null below the first). */
export function meterStage(ticks, value) {
    let stage = null;
    for (const tick of ticks) if (tick.at <= value) stage = tick;
    return stage;
}

/**
 * Where the value stands against the critical bands: 'low' (below `warnBelow`), 'high' (above
 * `warnAbove`) or null. A bound that is not a number is no band.
 */
export function meterWarning(value, warnBelow, warnAbove) {
    const low = numberOr(warnBelow);
    const high = numberOr(warnAbove);
    if (low !== null && value < low) return 'low';
    if (high !== null && value > high) return 'high';
    return null;
}

/** The change since the last reply as shown: '▲3', '▼5', or '' for none (0, not a number). */
export function deltaText(delta) {
    const n = numberOr(delta);
    if (n === null || fmt(n) === '0') return '';
    return `${n > 0 ? '▲' : '▼'}${fmt(Math.abs(n))}`;
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
        const stage = h(doc, 'span', 'ss-w-meter-stage');
        stage.setAttribute('aria-hidden', 'true');
        const change = h(doc, 'span', 'ss-w-meter-delta');
        change.setAttribute('aria-hidden', 'true');
        head.append(iconSlot, label, stage, change, value);
        const track = h(doc, 'div', 'ss-w-meter-track');
        const low = h(doc, 'div', 'ss-w-meter-band ss-w-lo');
        const high = h(doc, 'div', 'ss-w-meter-band ss-w-hi');
        const fill = h(doc, 'div', 'ss-w-meter-fill');
        const cells = h(doc, 'div', 'ss-w-meter-cells');
        const above = h(doc, 'div', 'ss-w-meter-above');
        const ceiling = h(doc, 'div', 'ss-w-meter-ceiling');
        const marks = h(doc, 'div', 'ss-w-meter-ticks');
        track.append(low, high, fill, cells, above, ceiling, marks);
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
            // The marks: each only when given and inside the range.
            const cap = numberOr(p.ceiling);
            const hasCap = cap !== null && cap >= min && cap < max && max > min;
            const ticks = meterTicks(p.ticks, min, max);
            const reached = meterStage(ticks, current);
            const moved = deltaText(p.delta);
            const lo = numberOr(p.warnBelow);
            const hi = numberOr(p.warnAbove);
            const hasLo = lo !== null && lo > min && lo <= max && max > min;
            const hasHi = hi !== null && hi >= min && hi < max && max > min;
            const warning = meterWarning(current, hasLo ? lo : null, hasHi ? hi : null);
            const spoken = [shown];
            if (reached?.label) spoken.push(reached.label);
            if (moved) spoken.push(`${p.delta > 0 ? 'up' : 'down'} ${fmt(Math.abs(p.delta))} since the last reply`);
            if (hasCap) spoken.push(`can go up to ${fmt(cap)} for now`);
            if (warning) spoken.push(warning === 'low' ? 'critically low' : 'critically high');
            setTone(root, p.tone);
            root.classList.toggle('ss-w-full', ratio >= 1);
            root.classList.toggle('ss-w-empty', ratio <= 0);
            root.setAttribute('aria-valuemin', fmt(min));
            root.setAttribute('aria-valuemax', fmt(max));
            root.setAttribute('aria-valuenow', fmt(clamp(current, min, max)));
            root.setAttribute('aria-valuetext', spoken.join(', '));
            if (p.label) root.setAttribute('aria-label', p.label);
            else root.removeAttribute('aria-label');
            const glyph = iconNode(doc, p.icon);
            iconSlot.replaceChildren(...(glyph ? [glyph] : []));
            iconSlot.hidden = !glyph;
            label.textContent = p.label;
            label.hidden = !p.label;
            value.textContent = shown;
            value.hidden = !p.showValue;
            track.style.setProperty('--ss-w-ratio', ratio4(ratio));
            // Ceiling notch, and the part of the track above it shaded.
            ceiling.hidden = !hasCap;
            above.hidden = !hasCap;
            if (hasCap) {
                track.style.setProperty('--ss-w-ceiling', ratio4(meterRatio(cap, min, max)));
                ceiling.setAttribute('title', `Up to ${fmt(cap)} for now`);
            } else {
                unset(track, '--ss-w-ceiling');
                ceiling.removeAttribute('title');
            }
            root.classList.toggle('ss-w-capped', hasCap);
            // Stage ticks, and the stage reached named in the head.
            marks.replaceChildren(...ticks.map(tick => {
                const mark = h(doc, 'span', 'ss-w-meter-tick');
                mark.style.setProperty('--ss-w-at', ratio4(tick.ratio));
                mark.setAttribute('title', tick.label ? `${tick.label} (${fmt(tick.at)})` : fmt(tick.at));
                if (tick === reached) mark.classList.add('ss-w-on');
                return mark;
            }));
            marks.hidden = ticks.length === 0;
            stage.textContent = reached?.label ?? '';
            stage.hidden = !reached?.label;
            // The change since the last reply.
            change.textContent = moved;
            change.hidden = !moved;
            change.classList.toggle('ss-w-up', moved.startsWith('▲'));
            change.classList.toggle('ss-w-down', moved.startsWith('▼'));
            // Critical bands at either end.
            low.hidden = !hasLo;
            high.hidden = !hasHi;
            if (hasLo) track.style.setProperty('--ss-w-warn-lo', ratio4(meterRatio(lo, min, max)));
            else unset(track, '--ss-w-warn-lo');
            if (hasHi) track.style.setProperty('--ss-w-warn-hi', ratio4(meterRatio(hi, min, max)));
            else unset(track, '--ss-w-warn-hi');
            low.classList.toggle('ss-w-in', warning === 'low');
            high.classList.toggle('ss-w-in', warning === 'high');
            root.classList.toggle('ss-w-critical', warning !== null);
            if (warning) root.setAttribute('data-warn', warning);
            else root.removeAttribute('data-warn');
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
