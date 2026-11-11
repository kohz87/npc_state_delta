/* NPC State Delta dossier surface: the halo dial for the Board screen (four meter arcs from -100..100, ticks, labels) with the portrait img under it. */
import { escapeHtml } from './src/util/html.js';
import { plain, relationshipValue } from './dossier-ui-model.js';
import { portraitHtml } from './dossier-ui-html.js';

// Geometry in the SVG's own 240-unit square. The arc track sits on the radius below; the ticks at the
// four cardinal points sit just outside it. Angles are degrees clockwise from 12 o'clock.
const VIEW = 240;
const CENTRE = 120;
const ARC_RADIUS = 100;
const TRACK_RADII = Object.freeze([104, 96]);

// One quadrant per axis, clockwise from 12 o'clock: trust, affection, desire, tension (the mockup's order).
// A full-scale value (±100) fills its quadrant (90°); the sign shows as a solid (+) or dashed (−) arc. The sweep follows the square root of the
// value, so the small numbers a story starts with are visible (+11 draws about a third of its quadrant, as the mockup's arcs do) and 100 still fills it.
// Each label sits in the quadrant's outer corner (the mockup's spots): value centred over the axis name.
const DIAL_AXES = Object.freeze([
    { axis: 'trust', label: 'TRUST', start: 0, colour: '#8fb4d9', anchor: 'middle', x: 212, valueY: 20, keyY: 28 },
    { axis: 'affection', label: 'AFFECTION', start: 90, colour: '#d99aaa', anchor: 'middle', x: 212, valueY: 207, keyY: 215 },
    { axis: 'desire', label: 'DESIRE', start: 180, colour: '#b7a3cf', anchor: 'middle', x: 51, valueY: 231, keyY: 239 },
    { axis: 'tension', label: 'TENSION', start: 270, colour: '#d9a273', anchor: 'middle', x: 21, valueY: 36, keyY: 44 },
]);

// Point on a circle of radius r at an angle measured clockwise from 12 o'clock.
function pointAt(radius, degrees) {
    const radians = (degrees * Math.PI) / 180;
    return [CENTRE + radius * Math.sin(radians), CENTRE - radius * Math.cos(radians)];
}

function roundPoint([x, y]) {
    return `${Math.round(x * 100) / 100} ${Math.round(y * 100) / 100}`;
}

// The arcs for the four meters: one per axis, with its clamped value, signed label and SVG path (empty at 0).
// Sweep is sqrt(|value| / 100) of the quadrant, so 25 draws half the quadrant and -100 a full one (dashed).
export function dialArcs(relationship = {}) {
    const rel = relationship && typeof relationship === 'object' ? relationship : {};
    return DIAL_AXES.map(meter => {
        const value = relationshipValue(rel[meter.axis]);
        const sweep = Math.sqrt(Math.abs(value) / 100) * 90;
        const path = sweep
            ? `M${roundPoint(pointAt(ARC_RADIUS, meter.start))} A${ARC_RADIUS} ${ARC_RADIUS} 0 0 1 ${roundPoint(pointAt(ARC_RADIUS, meter.start + sweep))}`
            : '';
        const shown = value > 0 ? `+${value}` : value < 0 ? `−${Math.abs(value)}` : '0';
        return { axis: meter.axis, label: meter.label, value, shown, colour: meter.colour, negative: value < 0, path, meter };
    });
}

// The ring: two faint tracks, the four cardinal ticks, each quadrant's full-scale track, the arcs and the labels.
function dialSvgBody(arcs) {
    const tracks = TRACK_RADII.map(r => `<circle cx="${CENTRE}" cy="${CENTRE}" r="${r}" fill="none" stroke="var(--dial, #4a4650)" stroke-width="1"/>`).join('');
    const ticks = [0, 90, 180, 270].map(deg => {
        const [x1, y1] = pointAt(108, deg);
        const [x2, y2] = pointAt(100, deg);
        return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
    }).join('');
    const full = DIAL_AXES.map(meter => `<path d="M${roundPoint(pointAt(ARC_RADIUS, meter.start))} A${ARC_RADIUS} ${ARC_RADIUS} 0 0 1 ${roundPoint(pointAt(ARC_RADIUS, meter.start + 90))}" fill="none" stroke="var(--dial, #4a4650)" stroke-width="5" stroke-linecap="round"/>`).join('');
    const drawn = arcs.filter(arc => arc.path).map(arc => `<path class="dial-arc${arc.negative ? ' dial-arc-neg' : ''}" d="${arc.path}" fill="none" stroke="${arc.colour}" stroke-width="5" stroke-linecap="round"${arc.negative ? ' stroke-dasharray="2 7"' : ''}/>`).join('');
    const labels = arcs.map(arc => {
        const meter = arc.meter;
        return `<text class="dial-label" text-anchor="${meter.anchor}" fill="${arc.colour}"><tspan class="dial-value" x="${meter.x}" y="${meter.valueY}">${escapeHtml(arc.shown)}</tspan><tspan class="dial-key" x="${meter.x}" y="${meter.keyY}">${escapeHtml(arc.label)}</tspan></text>`;
    }).join('');
    return `${tracks}<g stroke="var(--tick, #5c5762)" stroke-width="1">${ticks}</g>${full}${drawn}${labels}`;
}

// The SVG alone (no portrait): viewBox 240 square, scaled by CSS, labelled for screen readers with the four values.
export function dialSvg(relationship = {}) {
    const arcs = dialArcs(relationship);
    const summary = arcs.map(arc => `${arc.label.toLowerCase()} ${arc.shown}`).join(', ');
    return `<svg class="dossier-dial-svg" viewBox="0 0 ${VIEW} ${VIEW}" role="img" aria-label="${escapeHtml(`Meter dial: ${summary}`)}">${dialSvgBody(arcs)}</svg>`;
}

// The Board's dial: the portrait <img> (through portraitHtml, so refs.fill keeps its data URL out of the
// markup) sits under the SVG ring, and both are placed in one relative box. Pass the render's refs.
export function dialHtml(npc = {}, { refs = null } = {}) {
    const name = plain(npc?.name, 'NPC');
    return `<div class="dossier-dial" data-npc-id="${escapeHtml(plain(npc?.id))}" aria-label="${escapeHtml(`${name} meters`)}">`
        + `<div class="dossier-dial-portrait">${portraitHtml(npc, 'dossier-dial-img', { refs })}</div>`
        + `${dialSvg(npc?.relationship)}</div>`;
}
