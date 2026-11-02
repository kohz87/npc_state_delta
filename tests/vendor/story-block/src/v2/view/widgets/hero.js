// ss.hero (view/glass.css): the hero card, a character's one-glance sheet. A portrait (the persona avatar for
// the PC, the character card's image, or an NPC's from a query such as Delta's `npc.portrait`; the initial
// when there is none), the name, a level badge on the portrait (a star and the number), the class · title line, bars for HP, MP and SP and one for experience under the
// Terms' own word ("Soul growth"), a time / place / weather corner, and a row of status badges. `compact`
// is the one-row variant for the strip under a reply. With `you` (the game view's header while `story-block.you` is
// on), a Rank, a Wearing and a Condition row under the place line; without `you` the card draws no such row. With `travel` (Story Director's trip line)
// a Travel row follows them. With `where` (the game view's header) the corner is the scene's one place, and a "Here: names" item (the people present)
// follows the weather. The lines are plain text; with `where` the card has ONE "Edit" button (top-right; beside the name on a phone) that opens one
// editor in the card (view/hero-edit.js: the fields and the commands a Save runs, through the widget api; an `ss.editable` of kind `fields`, with
// the story clock when `clock` is given). Without `where` the card is read-only and the corner has no Here item.
//
// The bars are ss.bar and the badges ss.status (glass.js), so each speaks as it does there. The picture is
// taken only from a safe URL (https, a base64 raster image or a same-origin path, widgets/dom.js); a
// `portraitQuery` is asked through the widget api (a read-only query, a name that looks like one), and what it
// answers is checked the same way. The card is read-only; only its editor runs commands.
//
// Built with createElement and textContent only, like every standard widget (dom.js).

import { h, iconNode, initials, safeImageUrl, shell, str } from './dom.js';
import { defineWidget, resolveProps } from './props.js';
import { bar, status } from './glass.js';
import { editable } from './editable.js';
import { STRINGS } from '../../strings.js';
import { cutAt } from '../../../text.js';
import { svgIcon } from '../icons/index.js';
import { focusNode } from '../scroll.js';
import { heroEditFields, heroEditPlan } from '../hero-edit.js';

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
    where: { type: 'object', default: null },          // { present: [names], places: [place names or { name }], weatherOn: bool (the feature is on), place, weatherText (the whole words the editor starts from) }: the corner's Here item and the Edit button
    you: { type: 'object', default: null },             // { rank?, rankLabel?, wearing, condition, command }: the rows under the place line (and the editor's Character group)
    clock: { type: 'object', default: null },           // { parts: { year, month, day, minutes } | null, era, months: [{ name, days }] }: the editor's date and time fields (Story Director's clock); none without it
    travel: { type: 'string', default: '' },            // the trip's line (Story Director's `atlas.trip` row): a Travel row under the `you` rows
    compact: { type: 'boolean', default: false },
};

const short = (value, max) => cutAt(str(value).replace(/\s+/g, ' ').trim(), max);

// The corner's items in the order drawn: [kind, icon].
const CORNER = Object.freeze([['time', 'fa-clock'], ['place', 'fa-location-dot'], ['weather', 'fa-cloud-sun'], ['here', 'fa-user-group']]);
const HERE_MAX = 120;
const namesOf = list => (Array.isArray(list) ? list : []).map(item => short(typeof item === 'string' ? item : item?.name, 80)).filter(Boolean).slice(0, 12);

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
        // the name, and the one Edit button beside it (a phone) or in the card's top-right corner (CSS)
        const head = h(doc, 'div', 'ss-hero-head');
        const name = h(doc, 'h3', 'ss-hero-name');
        head.appendChild(name);
        // the line under the name (class · title): plain muted text, it wraps (the class name stays for older styles and tests)
        const pill = h(doc, 'span', 'ss-hero-pill ss-hero-line');
        who.append(head, pill);
        // the level: a badge on the portrait's lower edge, a star and the number; the whole level is said to screen readers
        const badge = h(doc, 'span', 'ss-hero-level');
        const star = svgIcon(doc, 'ph-star:fill', { className: 'ss-hero-level-icon' });
        const levelNumber = h(doc, 'span', 'ss-hero-level-number');
        levelNumber.setAttribute('aria-hidden', 'true');
        const levelSaid = h(doc, 'span', 'ss-visually-hidden');
        badge.append(...(star ? [star] : []), levelNumber, levelSaid);
        const corner = h(doc, 'ul', 'ss-hero-corner');
        const statuses = h(doc, 'div', 'ss-hero-statuses');
        // The corner's items, made when first asked for and kept: a redraw only changes their words.
        const cornerItems = new Map();
        let cornerShown = '';
        function cornerItem(kind, icon) {
            let entry = cornerItems.get(kind);
            if (entry) return entry;
            const item = h(doc, 'li', 'ss-hero-corner-item');
            item.setAttribute('data-kind', kind);
            const glyph = iconNode(doc, icon, 'ss-hero-corner-icon');
            if (glyph) item.appendChild(glyph);
            const words = h(doc, 'span', 'ss-hero-corner-text');
            item.appendChild(words);
            entry = { item, words };
            cornerItems.set(kind, entry);
            return entry;
        }
        // The Rank, Wearing and Condition rows (`you`): made when first asked for, so a card without them has no trace of them.
        let youRow = null;
        let travelRow = null;
        const youParts = [];
        const S = STRINGS.scene;
        function drawYou() {
            const you = p.you && typeof p.you === 'object' ? p.you : null;
            if (!you) {
                if (youRow) youRow.hidden = true;
                return;
            }
            if (!youRow) {
                youRow = h(doc, 'div', 'ss-hero-you');
                for (const [part, label] of [['rank', S.rank], ['wearing', S.wearing], ['condition', S.condition]]) {
                    const item = h(doc, 'span', 'ss-hero-you-part');
                    item.setAttribute('data-part', part);
                    const text = h(doc, 'span', 'ss-hero-you-text');
                    const name = h(doc, 'b', 'ss-hero-you-label', label);
                    item.append(name, text);
                    youRow.appendChild(item);
                    youParts.push({ part, item, name, text });
                }
                text.insertBefore(youRow, travelRow ?? statuses);
            }
            youRow.hidden = false;
            for (const entry of youParts) {
                // The Rank is a part only while the game gives it a word (`rankLabel`, from a pack): the label is that word.
                const rankLabel = entry.part === 'rank' ? short(you.rankLabel, 30) : '';
                entry.item.hidden = entry.part === 'rank' && !rankLabel;
                if (entry.item.hidden) continue;
                if (rankLabel) entry.name.textContent = rankLabel;
                const value = typeof you[entry.part] === 'string' ? you[entry.part] : '';
                entry.text.textContent = value || '\u2014';
                entry.text.classList.toggle('ss-hero-you-empty', !value);
            }
        }
        // The Travel row (`travel`): made when first asked for, hidden while there is no trip.
        let travelText = null;
        function drawTravel() {
            const said = short(p.travel, 200);
            if (!said) {
                if (travelRow) travelRow.hidden = true;
                return;
            }
            if (!travelRow) {
                travelRow = h(doc, 'div', 'ss-hero-travel');
                travelText = h(doc, 'span', 'ss-hero-travel-text');
                travelRow.append(h(doc, 'b', 'ss-hero-you-label', STRINGS.scene.travel), travelText);
                text.insertBefore(travelRow, statuses);
            }
            travelRow.hidden = false;
            travelText.textContent = said;
        }
        // The one editor (`where`): the Edit button beside the name, and the form in the text block, made when first asked for. While it is open the
        // lines it edits are hidden (CSS, `ss-hero-editing`) and it takes their place; a redraw changes its fields' starting values only for the next opening.
        let editButton = null;
        let editor = null;
        let editing = false;
        const editorProps = () => ({ kind: 'fields', bare: true, open: editing, label: STRINGS.scene.editAll, help: STRINGS.scene.editHelp, fields: heroEditFields(p), plan: heroEditPlan(p), onClose: closeEditor });
        function setEditing(on) {
            editing = on;
            root.classList.toggle('ss-hero-editing', on);
            editButton?.setAttribute('aria-expanded', on ? 'true' : 'false');
        }
        function closeEditor() {
            setEditing(false);
            editor?.handle.update(editorProps());
            focusNode(editButton);
        }
        function openEditor() {
            if (editing) return;
            if (!editor) {
                const slot = h(doc, 'div', 'ss-hero-editor');
                text.insertBefore(slot, corner);
                editor = { slot, handle: editable.render(slot, editorProps(), api) };
            }
            setEditing(true);
            editor.handle.update(editorProps());
        }
        function drawEdit() {
            const on = p.where !== null && typeof p.where === 'object';
            if (!on) {
                if (editing) setEditing(false);
                editor?.handle.destroy();
                editor?.slot.remove();
                editor = null;
                editButton?.remove();
                editButton = null;
                root.classList.remove('ss-hero-has-edit');
                return;
            }
            root.classList.add('ss-hero-has-edit');
            if (!editButton) {
                editButton = h(doc, 'button', 'ss-hero-edit');
                editButton.setAttribute('type', 'button');
                editButton.setAttribute('data-ss-hit', '');
                editButton.setAttribute('aria-label', STRINGS.scene.editAll);
                editButton.setAttribute('title', STRINGS.scene.editAll);
                editButton.setAttribute('aria-expanded', editing ? 'true' : 'false');
                const glyph = iconNode(doc, 'ph-pencil-simple', 'ss-hero-edit-icon');
                if (glyph) editButton.appendChild(glyph);
                editButton.appendChild(h(doc, 'span', 'ss-hero-edit-text', STRINGS.scene.editButton));
                listen(editButton, 'click', openEditor);
                head.appendChild(editButton);
            }
            editor?.handle.update(editorProps());
        }
        cleanup(() => editor?.handle.destroy());
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
        // The corner: time, place, weather and (with `where`) Here. With `where` an empty place, weather or Here still shows (with a dash or the
        // place's own empty word); the weather is left out when its feature is off.
        function drawCorner() {
            const where = p.where && typeof p.where === 'object' ? p.where : null;
            const present = namesOf(where?.present);
            const S = STRINGS.scene;
            const shown = [];
            for (const [kind, icon] of CORNER) {
                let said = '';
                if (kind === 'time') said = short(p.time, 40);
                else if (kind === 'place') said = short(p.place, 40);
                else if (kind === 'weather') said = where && where.weatherOn === false ? '' : short(p.weather, 40);
                else if (where) said = present.join(', ');
                const always = where !== null && kind !== 'time' && !(kind === 'weather' && where.weatherOn === false);
                const empty = !said;
                if (empty && !always) continue;
                const entry = cornerItem(kind, icon);
                const text = kind === 'here' ? `${STRINGS.home.here} ${said ? short(said, HERE_MAX) : '\u2014'}` : said || (kind === 'place' ? S.unnamed : '\u2014');
                entry.words.textContent = text;
                entry.item.classList.toggle('ss-hero-corner-empty', empty);
                shown.push(kind);
            }
            // The items are put in order only when the set that shows changes.
            const key = shown.join(',');
            if (key !== cornerShown) {
                corner.replaceChildren(...shown.map(kind => cornerItems.get(kind).item));
                cornerShown = key;
            }
            corner.hidden = !shown.length;
        }
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
            drawCorner();
            drawYou();
            drawEdit();
            drawTravel();
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
