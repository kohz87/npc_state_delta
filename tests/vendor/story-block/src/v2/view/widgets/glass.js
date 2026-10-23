// The building blocks of Story Suite's look (view/glass.css) as widgets, for templates and layouts:
//
// * ss.tile: an icon in a rounded square with a label under it, a number badge (a skill's level, a stack's
//   count; `countStyle: 'corner'` puts it in the corner, as a bag does), a tick (`state: 'ready'`) or a
//   lock (`state: 'locked'`, dimmed), a ring in a tone or a rarity, and `selected`. With `onSelect` it is a
//   button that runs that command with `{ tile: <id> }` (choosing a skill to read, an item to manage;
//   never a story action, F95/F96), pressed while `selected`; a locked tile is not a button.
// * ss.bar: a labelled progress bar (HP 50 / 82), `kind` hp, mp, sp or exp for the suite's bar colours
//   (else `tone`), the fill a custom property (`--ss-fill`, 0…1).
// * ss.status: a status effect as an icon in a tinted square with the time it has left in the corner:
//   "2t" (turns or rounds), "40m", "3h", "2d" (story minutes), "∞" (no set end); spoken in full words.
// * ss.pill: a short text in a pill (solid, soft or outline), with an optional icon.
//
// Built with createElement and textContent only, like every standard widget (dom.js).

import { clamp, fmt, h, iconNode, num, runCommand, setData, shell, str } from './dom.js';
import { defineWidget, resolveProps } from './props.js';
import { cutAt } from '../../../text.js';

/** Ring colours a tile or a status badge accepts (a class each, glass.css); anything else is neutral. */
export const GLASS_TONES = Object.freeze(['neutral', 'accent', 'good', 'warn', 'bad', 'info', 'uncommon', 'rare', 'epic', 'legendary']);
/** The suite's bar colours (tokens --ss-hp, --ss-mp, --ss-sp, --ss-exp). */
export const BAR_KINDS = Object.freeze(['hp', 'mp', 'sp', 'exp']);
export const PILL_STYLES = Object.freeze(['solid', 'soft', 'outline']);
export const TILE_STATES = Object.freeze(['none', 'ready', 'locked']);
/** Units a status's time left may be in; `minutes` are story minutes. */
export const STATUS_UNITS = Object.freeze(['turns', 'rounds', 'minutes']);

const LABEL_MAX = 60;
const COUNT_MAX = 6;

/** Exactly one `ss-tone-*` class on a node, from the allowed list (else neutral). */
export function setGlassTone(node, value, fallback = 'neutral') {
    for (const tone of GLASS_TONES) node.classList.remove(`ss-tone-${tone}`);
    const tone = GLASS_TONES.includes(value) ? value : fallback;
    if (tone) node.classList.add(`ss-tone-${tone}`);
}

const pick = (list, value, fallback) => (list.includes(value) ? value : fallback);
const short = (value, max) => cutAt(str(value).replace(/\s+/g, ' ').trim(), max);

// ---- tile ------------------------------------------------------------------------------------------

const tileProps = {
    label: { type: 'string', required: true, default: '' },
    icon: { type: 'string', default: '' },
    count: { type: 'string', default: '' },          // a number or a short text ("3", "–"); '' for none
    countStyle: { type: 'string', default: 'badge' }, // badge (under the icon) or corner
    state: { type: 'string', default: 'none' },       // none, ready (a tick) or locked (a lock)
    tone: { type: 'string', default: '' },            // the ring: a tone or a rarity ('' = the hairline)
    selected: { type: 'boolean', default: false },
    showLabel: { type: 'boolean', default: true },
    hint: { type: 'string', default: '' },             // said after the label ("Lv 3", "Uncommon")
    id: { type: 'string', default: '' },
    kind: { type: 'string', default: '' },
    onSelect: { type: 'string', default: '' },
};

/** What a tile says to a screen reader: "Moonlight Slash, Lv 3, ready" / "Death Soul, locked". */
export function tileSpoken(p) {
    const parts = [short(p.label, LABEL_MAX) || 'Tile'];
    if (p.hint) parts.push(short(p.hint, LABEL_MAX));
    else if (p.count !== '' && p.count !== null && p.count !== undefined) parts.push(short(p.count, COUNT_MAX));
    if (p.state === 'ready') parts.push('ready');
    if (p.state === 'locked') parts.push('locked');
    return parts.join(', ');
}

function renderTile(el, input, api) {
    let p = resolveProps(tileProps, input);
    let current = null;
    function build() {
        const state = pick(TILE_STATES, p.state, 'none');
        const clickable = Boolean(p.onSelect) && typeof api?.command === 'function' && state !== 'locked';
        current = shell(el, clickable ? 'button' : 'div', 'tile', ({ doc, root, listen }) => {
            root.classList.add('ss-tile');
            if (clickable) {
                root.setAttribute('type', 'button');
                listen(root, 'click', () => runCommand(api, p.onSelect, { tile: p.id || p.label }));
            } else root.setAttribute('role', 'group');
            const box = h(doc, 'span', 'ss-tile-box');
            const icon = h(doc, 'span', 'ss-tile-icon');
            const count = h(doc, 'span', 'ss-tile-count');
            const mark = h(doc, 'span', 'ss-tile-mark');
            const label = h(doc, 'span', 'ss-tile-label');
            for (const node of [icon, count, mark, label]) node.setAttribute('aria-hidden', 'true');
            box.append(icon, count, mark);
            root.append(box, label);
            function update() {
                const now = pick(TILE_STATES, p.state, 'none');
                setGlassTone(box, p.tone, '');
                root.classList.toggle('ss-tile-ready', now === 'ready');
                root.classList.toggle('ss-tile-locked', now === 'locked');
                setData(root, 'kind', p.kind);
                const glyph = iconNode(doc, p.icon);
                icon.replaceChildren(...(glyph ? [glyph] : []));
                if (!glyph) icon.textContent = Array.from(short(p.label, LABEL_MAX))[0] ?? '';
                const shown = short(p.count, COUNT_MAX);
                count.textContent = shown;
                count.hidden = !shown;
                count.classList.toggle('ss-tile-corner', p.countStyle === 'corner');
                mark.replaceChildren();
                if (now !== 'none') {
                    const sign = h(doc, 'i', `fa-solid ${now === 'ready' ? 'fa-check' : 'fa-lock'}`);
                    sign.setAttribute('aria-hidden', 'true');
                    mark.appendChild(sign);
                }
                mark.hidden = now === 'none';
                label.textContent = short(p.label, LABEL_MAX);
                label.hidden = !p.showLabel;
                const spoken = tileSpoken({ ...p, state: now });
                root.setAttribute('aria-label', spoken);
                root.setAttribute('title', spoken);
                if (clickable) root.setAttribute('aria-pressed', p.selected ? 'true' : 'false');
                else if (p.selected) root.setAttribute('aria-current', 'true');
                else root.removeAttribute('aria-current');
            }
            update();
            return { update };
        });
        current.clickable = clickable;
    }
    build();
    return {
        update(next) {
            if (!current) return;
            p = resolveProps(tileProps, next);
            const clickable = Boolean(p.onSelect) && typeof api?.command === 'function' && pick(TILE_STATES, p.state, 'none') !== 'locked';
            if (clickable !== current.clickable) {
                current.destroy();
                build();
            } else current.update();
        },
        destroy() {
            current?.destroy();
            current = null;
        },
    };
}

export const tile = defineWidget({ props: tileProps, primary: 'label', render: renderTile });

// ---- bar -------------------------------------------------------------------------------------------

const barProps = {
    value: { type: 'number', required: true, default: 0 },
    max: { type: 'number', default: 100 },
    label: { type: 'string', default: '' },
    kind: { type: 'string', default: '' },        // hp, mp, sp, exp
    text: { type: 'string', default: '' },        // the value as shown ("50 / 82" by default)
    showValue: { type: 'boolean', default: true },
};

/** The fill in [0, 1] (0 for an empty range). */
export function barRatio(value, max) {
    const top = num(max, 0);
    if (!(top > 0)) return 0;
    return clamp(num(value, 0) / top, 0, 1);
}

function renderBar(el, input) {
    let p = resolveProps(barProps, input);
    const view = shell(el, 'div', 'bar', ({ doc, root }) => {
        root.classList.add('ss-bar');
        root.setAttribute('role', 'meter');
        const head = h(doc, 'div', 'ss-bar-head');
        const label = h(doc, 'span', 'ss-bar-label');
        const value = h(doc, 'span', 'ss-bar-value');
        head.setAttribute('aria-hidden', 'true');
        head.append(label, value);
        const track = h(doc, 'div', 'ss-bar-track');
        track.appendChild(h(doc, 'div', 'ss-bar-fill'));
        root.append(head, track);
        function update() {
            for (const kind of BAR_KINDS) root.classList.remove(`ss-bar-${kind}`);
            if (BAR_KINDS.includes(p.kind)) root.classList.add(`ss-bar-${p.kind}`);
            const max = Math.max(0, num(p.max, 0));
            const now = clamp(num(p.value, 0), 0, max);
            const shown = p.text ? short(p.text, LABEL_MAX) : `${fmt(num(p.value, 0))} / ${fmt(max)}`;
            label.textContent = short(p.label, LABEL_MAX);
            label.hidden = !p.label;
            value.textContent = shown;
            value.hidden = !p.showValue;
            head.hidden = !p.label && !p.showValue;
            track.style.setProperty('--ss-fill', String(Math.round(barRatio(p.value, max) * 10000) / 10000));
            root.setAttribute('aria-label', short(p.label, LABEL_MAX) || 'Bar');
            root.setAttribute('aria-valuemin', '0');
            root.setAttribute('aria-valuemax', fmt(max));
            root.setAttribute('aria-valuenow', fmt(now));
            root.setAttribute('aria-valuetext', shown);
        }
        update();
        return { update };
    });
    return {
        update(next) {
            p = resolveProps(barProps, next);
            view.update();
        },
        destroy() { view.destroy(); },
    };
}

export const bar = defineWidget({ props: barProps, primary: 'value', render: renderBar });

// ---- status badge ----------------------------------------------------------------------------------

const statusProps = {
    label: { type: 'string', required: true, default: '' }, // "Bleeding"
    icon: { type: 'string', default: '' },
    left: { type: 'number', default: null },                // the time left; null: no set end (∞)
    unit: { type: 'string', default: 'turns' },             // turns, rounds or (story) minutes
    tone: { type: 'string', default: 'accent' },
    id: { type: 'string', default: '' },
    kind: { type: 'string', default: '' },
};

/**
 * The time left as shown in the corner: turns and rounds "2t" / "2r"; story minutes "40m", whole hours
 * "3h" (rounded down from 60 minutes), whole days "2d" (from 48 hours); none "∞"; more than 99 of a
 * unit "99+".
 */
export function leftText(left, unit = 'turns') {
    if (left === null || left === undefined || left === '' || !Number.isFinite(Number(left))) return '∞';
    const n = Math.max(0, Math.floor(Number(left)));
    const cap = (value, suffix) => (value > 99 ? `99+${suffix}` : `${value}${suffix}`);
    if (unit === 'minutes') {
        if (n < 60) return cap(n, 'm');
        if (n < 48 * 60) return cap(Math.floor(n / 60), 'h');
        return cap(Math.floor(n / 1440), 'd');
    }
    return cap(n, unit === 'rounds' ? 'r' : 't');
}

/** The time left in words: "2 turns left", "1 round left", "40 story minutes left", "no set end". */
export function leftSpoken(left, unit = 'turns') {
    if (left === null || left === undefined || left === '' || !Number.isFinite(Number(left))) return 'no set end';
    const n = Math.max(0, Math.floor(Number(left)));
    const word = unit === 'minutes' ? (n === 1 ? 'story minute' : 'story minutes') : unit === 'rounds' ? (n === 1 ? 'round' : 'rounds') : n === 1 ? 'turn' : 'turns';
    return `${fmt(n)} ${word} left`;
}

function renderStatus(el, input) {
    let p = resolveProps(statusProps, input);
    const view = shell(el, 'span', 'status', ({ doc, root }) => {
        root.classList.add('ss-status');
        root.setAttribute('role', 'img');
        const icon = h(doc, 'span', 'ss-status-icon');
        const left = h(doc, 'span', 'ss-status-left');
        icon.setAttribute('aria-hidden', 'true');
        left.setAttribute('aria-hidden', 'true');
        root.append(icon, left);
        function update() {
            const unit = pick(STATUS_UNITS, p.unit, 'turns');
            setGlassTone(root, p.tone, 'accent');
            setData(root, 'kind', p.kind);
            const glyph = iconNode(doc, p.icon);
            icon.replaceChildren(...(glyph ? [glyph] : []));
            if (!glyph) icon.textContent = Array.from(short(p.label, LABEL_MAX))[0] ?? '?';
            // A condition with no count (no set end) shows no counter at all, as the old badges did: the "∞" is only in the words.
            const counted = p.left !== null && p.left !== undefined && p.left !== '' && Number.isFinite(Number(p.left));
            left.hidden = !counted;
            left.textContent = counted ? leftText(p.left, unit) : '';
            const spoken = `${short(p.label, LABEL_MAX) || 'Status'}: ${leftSpoken(p.left, unit)}`;
            root.setAttribute('aria-label', spoken);
            root.setAttribute('title', spoken);
        }
        update();
        return { update };
    });
    return {
        update(next) {
            p = resolveProps(statusProps, next);
            view.update();
        },
        destroy() { view.destroy(); },
    };
}

export const status = defineWidget({ props: statusProps, primary: 'left', render: renderStatus });

// ---- pill ------------------------------------------------------------------------------------------

const pillProps = {
    text: { type: 'string', required: true, default: '' },
    icon: { type: 'string', default: '' },
    style: { type: 'string', default: 'solid' },   // solid, soft, outline
};

function renderPill(el, input) {
    let p = resolveProps(pillProps, input);
    const view = shell(el, 'span', 'pill', ({ doc, root }) => {
        root.classList.add('ss-pill');
        const icon = h(doc, 'span', 'ss-pill-icon');
        icon.setAttribute('aria-hidden', 'true');
        const text = h(doc, 'span', 'ss-pill-text');
        root.append(icon, text);
        function update() {
            const style = pick(PILL_STYLES, p.style, 'solid');
            root.classList.toggle('ss-pill-soft', style === 'soft');
            root.classList.toggle('ss-pill-outline', style === 'outline');
            const glyph = iconNode(doc, p.icon);
            icon.replaceChildren(...(glyph ? [glyph] : []));
            icon.hidden = !glyph;
            text.textContent = short(p.text, 120);
        }
        update();
        return { update };
    });
    return {
        update(next) {
            p = resolveProps(pillProps, next);
            view.update();
        },
        destroy() { view.destroy(); },
    };
}

export const pill = defineWidget({ props: pillProps, primary: 'text', render: renderPill });
