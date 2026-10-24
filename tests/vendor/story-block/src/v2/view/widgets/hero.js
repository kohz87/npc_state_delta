// ss.hero (view/glass.css): the hero card, a character's one-glance sheet. A portrait (the persona avatar for
// the PC, the character card's image, or an NPC's from a query such as Delta's `npc.portrait`; the initial
// when there is none), the name, a level badge on the portrait (a star and the number), the class · title line, bars for HP, MP and SP and one for experience under the
// Terms' own word ("Soul growth"), a place / time / weather corner, and a row of status badges. `compact`
// is the one-row variant for the strip under a reply.
//
// The bars are ss.bar and the badges ss.status (glass.js), so each speaks as it does there. The picture is
// taken only from a safe URL (https, a base64 raster image or a same-origin path, widgets/dom.js); a
// `portraitQuery` is asked through the widget api (a read-only query, a name that looks like one), and what it
// answers is checked the same way. Nothing here runs a command: the card is read-only.
//
// Built with createElement and textContent only, like every standard widget (dom.js).

import { h, iconNode, initials, safeImageUrl, shell, str } from './dom.js';
import { defineWidget, resolveProps } from './props.js';
import { bar, status } from './glass.js';
import { cutAt } from '../../../text.js';
import { svgIcon } from '../icons/index.js';

export const BAR_MAX = 6;
export const STATUS_MAX = 12;
const QUERY_NAME = /^[a-z][a-zA-Z0-9_-]{0,39}(?:\.[a-zA-Z0-9_-]{1,40}){0,3}$/;

const heroProps = {
    name: { type: 'string', required: true, default: '' },
    portrait: { type: 'string', default: '' },          // the persona avatar or the card's image
    portraits: { type: 'array', default: Object.freeze([]) }, // more pictures, in the order to try them (after `portrait`'s own place: see pictureCandidates)
    portraitQuery: { type: 'string', default: '' },     // a query that answers a picture URL (`npc.portrait`); asked first
    portraitArgs: { type: 'object', default: null },    // its arguments ({ name })
    line: { type: 'string', default: '' },               // the line under the name, whole ("Soul Class II · Wayfarer")
    className: { type: 'string', default: '' },          // else it is built from the class
    title: { type: 'string', default: '' },              // and a title ("Wayfarer")
    level: { type: 'string', default: '' },              // the level ("Lv 12"): the badge on the portrait (a star and the number)
    bars: { type: 'array', default: Object.freeze([]) }, // [{ kind: hp|mp|sp|exp, label, value, max, text }]
    place: { type: 'string', default: '' },
    time: { type: 'string', default: '' },
    weather: { type: 'string', default: '' },
    statuses: { type: 'array', default: Object.freeze([]) }, // [{ id, label, icon, left, unit, tone }]
    compact: { type: 'boolean', default: false },
};

const short = (value, max) => cutAt(str(value).replace(/\s+/g, ' ').trim(), max);

/** The line under the name: `line`, else "Class · Title" from the parts that are given (the level is the portrait's badge). */
export function heroLine(p) {
    if (p.line) return short(p.line, 120);
    return [short(p.className, 40), short(p.title, 40)].filter(Boolean).join(' · ');
}

/**
 * The level badge: { number, label }. The label is the whole level for screen readers ("Lv 12"; a bare "12" → "Lv 12"),
 * the number the badge's short text: the level's last run of digits ("Level of the Ancients 73" → 73), else the level,
 * cut to 8. The level is taken whole (up to 60) before either is made, so a long one keeps its number.
 */
export function heroLevel(p) {
    const level = short(p.level, 60);
    if (!level) return { number: '', label: '' };
    const digits = level.match(/(\d+)\D*$/);
    const label = /^\d+$/.test(level) ? `Lv ${level}` : level;
    return { number: short(digits ? digits[1] : level, 8), label };
}

/** The bars as drawn: at most BAR_MAX, each { kind, label, value, max, text }; a bar with no max or no label is kept as given. */
export function heroBars(list) {
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
        if (!raw || typeof raw !== 'object') continue;
        out.push({ kind: typeof raw.kind === 'string' ? raw.kind : '', label: short(raw.label, 40), value: raw.value, max: raw.max, text: short(raw.text, 40) });
        if (out.length >= BAR_MAX) break;
    }
    return out;
}

function heroStatuses(list) {
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
        if (!raw || typeof raw !== 'object') continue;
        out.push({ label: short(raw.label, 60), icon: typeof raw.icon === 'string' ? raw.icon : '', left: raw.left, unit: typeof raw.unit === 'string' ? raw.unit : 'turns', tone: typeof raw.tone === 'string' ? raw.tone : 'accent', id: short(raw.id, 64), kind: typeof raw.kind === 'string' ? raw.kind : '' });
        if (out.length >= STATUS_MAX) break;
    }
    return out;
}

/** A picture's URL from a value that is a string or an answer `{ url }` / `{ src }`: a safe one, else ''. */
export function pictureUrl(value) {
    return safeImageUrl(typeof value === 'string' ? value : value?.url ?? value?.src ?? '');
}

/**
 * The pictures to try, in order, each a safe URL and once: the query's answer (`portraitQuery`), then `portraits`, then
 * `portrait`. A picture that fails to load is skipped by the widget (the next is tried), and the initial past the last.
 */
export function pictureCandidates(p, api) {
    const out = [];
    const add = value => { const url = pictureUrl(value); if (url && !out.includes(url)) out.push(url); };
    const name = typeof p.portraitQuery === 'string' ? p.portraitQuery : '';
    if (name && QUERY_NAME.test(name) && typeof api?.query === 'function') {
        try { add(api.query(name, p.portraitArgs && typeof p.portraitArgs === 'object' ? p.portraitArgs : undefined)); } catch {
            // The query is the host's to report; the card falls back to the next picture.
        }
    }
    for (const value of Array.isArray(p.portraits) ? p.portraits : []) add(value);
    add(p.portrait);
    return out;
}

/** The first picture to show (see pictureCandidates); '' for the initial. */
export function heroPicture(p, api) {
    return pictureCandidates(p, api)[0] ?? '';
}

function renderHero(el, input, api) {
    let p = resolveProps(heroProps, input);
    let handles = [];
    return shell(el, 'section', 'hero', ({ doc, root, listen, cleanup }) => {
        root.classList.add('ss-hero', 'ss-glass');
        root.setAttribute('role', 'group');
        const body = h(doc, 'div', 'ss-hero-body');
        const portrait = h(doc, 'div', 'ss-hero-portrait');
        portrait.setAttribute('role', 'img');
        const img = h(doc, 'img', 'ss-hero-img');
        img.setAttribute('draggable', 'false');
        img.setAttribute('loading', 'lazy');
        img.setAttribute('decoding', 'async');
        img.setAttribute('referrerpolicy', 'no-referrer');
        const letter = h(doc, 'span', 'ss-hero-initial');
        letter.setAttribute('aria-hidden', 'true');
        portrait.append(img, letter);
        const main = h(doc, 'div', 'ss-hero-main');
        const who = h(doc, 'div', 'ss-hero-who');
        const name = h(doc, 'h3', 'ss-hero-name');
        // the line under the name (class · title): plain muted text, it wraps (the class name stays for older styles and tests)
        const pill = h(doc, 'span', 'ss-hero-pill ss-hero-line');
        who.append(name, pill);
        // the level: a badge on the portrait's lower edge, a star and the number; the whole level is said to screen readers
        const badge = h(doc, 'span', 'ss-hero-level');
        const star = svgIcon(doc, 'ph-star:fill', { className: 'ss-hero-level-icon' });
        const levelNumber = h(doc, 'span', 'ss-hero-level-number');
        levelNumber.setAttribute('aria-hidden', 'true');
        const levelSaid = h(doc, 'span', 'ss-visually-hidden');
        badge.append(...(star ? [star] : []), levelNumber, levelSaid);
        const corner = h(doc, 'ul', 'ss-hero-corner');
        const statuses = h(doc, 'div', 'ss-hero-statuses');
        // the text block: the name, the class line, the place and weather, the statuses: one stacked group, which the portrait is
        // centred against (grid areas "portrait text", glass.css)
        const text = h(doc, 'div', 'ss-hero-text');
        text.append(who, corner, statuses);
        main.append(text);
        const vitals = h(doc, 'div', 'ss-hero-vitals');
        // the portrait and its badge in one cell: the badge hangs on the portrait's lower edge, inside the room the cell keeps
        const face = h(doc, 'div', 'ss-hero-face');
        face.append(portrait, badge);
        body.append(face, main, vitals);
        root.appendChild(body);
        // The pictures that failed to load (kept for this widget: a redraw does not ask for them again), the candidates for the
        // current props, and the picture on screen: an error moves on to the next candidate, the initial past the last.
        const broken = new Set();
        let shown = [];
        function showPicture() {
            const url = shown.find(candidate => !broken.has(candidate)) ?? '';
            if (url) {
                if (img.getAttribute('src') !== url) img.setAttribute('src', url);
                img.hidden = false;
                letter.hidden = true;
                portrait.classList.remove('ss-hero-fallback');
            } else {
                img.removeAttribute('src');
                img.hidden = true;
                letter.hidden = false;
                portrait.classList.add('ss-hero-fallback');
            }
        }
        listen(img, 'error', () => {
            const src = img.getAttribute('src') ?? '';
            if (src) broken.add(src);
            showPicture();
        });
        function clear() {
            for (const handle of handles) handle.destroy();
            handles = [];
            vitals.replaceChildren();
            statuses.replaceChildren();
        }
        cleanup(clear);
        function update() {
            clear();
            const label = short(p.name, 60);
            root.classList.toggle('ss-hero-compact', p.compact === true);
            root.setAttribute('aria-label', label ? `Character: ${label}` : 'Character');
            name.textContent = label;
            letter.textContent = initials(label);
            portrait.setAttribute('aria-label', label ? `Portrait of ${label}` : 'Portrait');
            img.setAttribute('alt', label ? `Portrait of ${label}` : '');
            shown = pictureCandidates(p, api);
            showPicture();
            const line = heroLine(p);
            pill.textContent = line;
            pill.hidden = !line;
            const level = heroLevel(p);
            levelNumber.textContent = level.number;
            levelSaid.textContent = level.label;
            badge.hidden = !level.number;
            corner.replaceChildren();
            for (const [kind, icon, text] of [['time', 'fa-clock', p.time], ['place', 'fa-location-dot', p.place], ['weather', 'fa-cloud-sun', p.weather]]) {
                const said = short(text, 40);
                if (!said) continue;
                const item = h(doc, 'li', 'ss-hero-corner-item');
                item.setAttribute('data-kind', kind);
                const glyph = iconNode(doc, icon, 'ss-hero-corner-icon');
                if (glyph) item.appendChild(glyph);
                item.appendChild(h(doc, 'span', 'ss-hero-corner-text', said));
                corner.appendChild(item);
            }
            corner.hidden = !corner.children.length;
            const bars = heroBars(p.bars);
            const pools = bars.filter(b => b.kind !== 'exp');
            const growth = bars.filter(b => b.kind === 'exp');
            const pooled = h(doc, 'div', 'ss-hero-pools');
            for (const spec of pools) handles.push(bar.render(pooled, spec, null));
            pooled.hidden = !pools.length;
            vitals.appendChild(pooled);
            for (const spec of growth) {
                const holder = h(doc, 'div', 'ss-hero-exp');
                handles.push(bar.render(holder, spec, null));
                vitals.appendChild(holder);
            }
            vitals.hidden = !bars.length;
            const badges = heroStatuses(p.statuses);
            for (const spec of badges) handles.push(status.render(statuses, spec, null));
            statuses.hidden = !badges.length;
        }
        update();
        return {
            update(next) {
                p = resolveProps(heroProps, next);
                update();
            },
        };
    });
}

export const hero = defineWidget({ props: heroProps, primary: 'name', render: renderHero });
