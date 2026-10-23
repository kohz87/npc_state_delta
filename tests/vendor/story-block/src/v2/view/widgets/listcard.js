// ss.listcard (view/glass.css): a glass card holding a list of rows: a title, a quieter line under it, and on
// the right a value ("4 silver") or a tag ("new", "turn in"), the tag in a tone. Quests ready to turn in, what
// can happen here, the people in a place.
//
// With `onSelect` every row is a button: a choice runs that command with `{ listcard: <row id> }` (open it,
// read it; never a story action, F95/F96) and the row shows as chosen at once; a screen that redraws with
// another `selected` wins. A row may lead with an icon or a picture (the same icons as everywhere, widgets/dom.js).
//
// Built with createElement and textContent only, like every standard widget (dom.js).

import { h, iconNode, runCommand, shell, str } from './dom.js';
import { defineWidget, resolveProps } from './props.js';
import { GLASS_TONES, setGlassTone } from './glass.js';
import { cutAt } from '../../../text.js';
import { focusNode } from '../scroll.js';

export const ROW_MAX = 100;

const listProps = {
    rows: { type: 'array', required: true, default: Object.freeze([]) },  // [{ id, title, sub, value, tag, tone, icon }]
    title: { type: 'string', default: '' },                                // the card's heading (a section label)
    selected: { type: 'string', default: '' },
    empty: { type: 'string', default: '' },                                // said when there are no rows
    onSelect: { type: 'string', default: '' },
    label: { type: 'string', default: '' },                                // the accessible name (default: the title)
};

const short = (value, max) => cutAt(str(value).replace(/\s+/g, ' ').trim(), max);

/** The rows as drawn: at most ROW_MAX, each { id, title, sub, value, tag, tone, icon }; a row with no text at all is left out. */
export function listRows(list) {
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
        if (!raw || typeof raw !== 'object') continue;
        const title = short(raw.title, 80);
        const sub = short(raw.sub, 120);
        const value = short(raw.value, 24);
        const tag = short(raw.tag, 24);
        if (!title && !sub && !value && !tag) continue;
        out.push({ id: short(raw.id, 64) || title, title, sub, value, tag, tone: GLASS_TONES.includes(raw.tone) ? raw.tone : '', icon: typeof raw.icon === 'string' ? raw.icon : '' });
        if (out.length >= ROW_MAX) break;
    }
    return out;
}

function renderListcard(el, input, api) {
    let p = resolveProps(listProps, input);
    let shown = p.selected;
    let lastProp = p.selected;
    return shell(el, 'section', 'listcard', ({ doc, root, listen }) => {
        root.classList.add('ss-listcard', 'ss-glass');
        const head = h(doc, 'p', 'ss-label ss-listcard-head');
        const list = h(doc, 'ul', 'ss-listcard-rows');
        const empty = h(doc, 'p', 'ss-listcard-empty');
        root.append(head, list, empty);
        let buttons = [];
        let shownRows = [];
        listen(list, 'click', event => {
            const at = buttons.findIndex(button => button === event.target || button.contains?.(event.target));
            if (at < 0) return;
            shown = shownRows[at].id;
            mark();
            runCommand(api, p.onSelect, { listcard: shown });
        });
        function mark() {
            for (const button of buttons) {
                if (button.getAttribute('data-id') === shown && shown) button.setAttribute('aria-current', 'true');
                else button.removeAttribute('aria-current');
            }
        }
        function update() {
            const rows = listRows(p.rows);
            const active = doc.activeElement;
            const keep = active && list.contains?.(active) ? active.getAttribute?.('data-id') : null;
            const clickable = Boolean(p.onSelect);
            const title = short(p.title, 60);
            head.textContent = title;
            head.hidden = !title;
            const name = short(p.label, 60) || title;
            if (name) root.setAttribute('aria-label', name);
            else root.removeAttribute('aria-label');
            list.replaceChildren();
            buttons = [];
            shownRows = clickable ? rows : [];
            for (const row of rows) {
                const item = h(doc, 'li', 'ss-listcard-row');
                const body = h(doc, clickable ? 'button' : 'div', 'ss-listcard-item');
                if (clickable) {
                    body.setAttribute('type', 'button');
                    body.setAttribute('data-id', row.id);
                    buttons.push(body);
                }
                const glyph = iconNode(doc, row.icon, 'ss-listcard-icon');
                if (glyph) body.appendChild(glyph);
                const main = h(doc, 'span', 'ss-listcard-main');
                if (row.title) main.appendChild(h(doc, 'span', 'ss-listcard-title', row.title));
                if (row.sub) main.appendChild(h(doc, 'span', 'ss-listcard-sub', row.sub));
                body.appendChild(main);
                if (row.value) body.appendChild(h(doc, 'span', 'ss-listcard-value', row.value));
                if (row.tag) {
                    const tag = h(doc, 'span', 'ss-listcard-tag', row.tag);
                    setGlassTone(tag, row.tone, '');
                    body.appendChild(tag);
                }
                item.appendChild(body);
                list.appendChild(item);
            }
            mark();
            if (keep) focusNode(buttons.find(button => button.getAttribute('data-id') === keep));
            list.hidden = rows.length === 0;
            const note = rows.length ? '' : short(p.empty, 120);
            empty.textContent = note;
            empty.hidden = !note;
        }
        update();
        return {
            update(next) {
                p = resolveProps(listProps, next);
                if (p.selected !== lastProp) shown = p.selected;
                lastProp = p.selected;
                update();
            },
        };
    });
}

export const listcard = defineWidget({ props: listProps, primary: 'rows', render: renderListcard });
