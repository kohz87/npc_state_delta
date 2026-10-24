// The Tabs card of the Tabs & Packs page (UI stage, step 3e): every tab and screen of every installed module once, in the reader's
// order, as a row with a show/hide switch and Up and Down buttons (no dragging: every control is a button the keyboard reaches),
// then "Reset to default". It writes through the same tabs control as before (`tabs`: rows(), move(id, delta), setHidden(id, hidden),
// reset(), isDefault(); ui-host.js keeps the choice in extension_settings.storySuite.tabs), so the Story panel's tab strip and the
// game view's navigation follow at once.
//
// * Home is always first and always shown. Hiding is refused with a message when it would leave no tab shown (Home counts, so the
//   refusal can only be another tab's; Home's own switch is locked: drawn on and disabled, with "Always shown" beside it).
// * A change redraws this list only; the focus stays on the same control of the same row, or its neighbour when that one is now
//   disabled (Up on the first row). A status line says what changed, for screen readers too.
//
// Built with createElement and textContent only: tab names come from modules.

import { TABS_FOLD, TABS_TEXT } from '../../host-ui.js';
import { fill } from '../../strings.js';
import { newId, sectionBlock, switchField } from '../form/fields.js';
import { revealIn, showAndFocus } from '../scroll.js';
import { iconNode } from '../widgets/dom.js';
import { iconFor } from '../icons/index.js';

const h = (doc, tag, className = '', text = '') => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== '' && text !== null && text !== undefined) node.textContent = String(text);
    return node;
};
const press = (doc, className, label, icon, word = '') => {
    const node = h(doc, 'button', className);
    node.type = 'button';
    node.title = label;
    node.setAttribute('aria-label', label);
    const glyph = h(doc, 'i', `fa-solid ${icon}`);
    glyph.setAttribute('aria-hidden', 'true');
    node.appendChild(glyph);
    if (word) node.appendChild(h(doc, 'span', 'ss-button-word', word));
    return node;
};

/**
 * Draws the card into `parent`. `tabs` is ui-host.js's tabs control (without it the card says there are no tabs); `onChange()` is
 * told after any change (the footer and the other pages follow). → { el, refresh(), filter(text), destroy(), focus(), count() }.
 */
export function renderTabsCard(parent, { doc, tabs, onChange = null }) {
    const T = TABS_TEXT;
    const card = sectionBlock(doc, { title: T.title, hint: T.hint, id: newId('tabs-card') });
    card.el.classList.add('ss-tabs-card');
    card.el.dataset.fold = TABS_FOLD;
    const help = h(doc, 'p', 'ss-card-help', T.help);
    const list = h(doc, 'ol', 'ss-tabrows');
    list.setAttribute('aria-label', T.listLabel);
    const foot = h(doc, 'div', 'ss-tabrows-foot');
    const reset = h(doc, 'button', 'ss-button ss-tabrows-reset', T.reset);
    reset.type = 'button';
    reset.title = T.resetTitle;
    reset.setAttribute('aria-label', T.resetTitle);
    const status = h(doc, 'span', 'ss-tabrows-status');
    status.setAttribute('role', 'status');
    foot.append(reset, status);
    // A refusal is said at the top of the list, where the reader is looking, as an alert, until the next change.
    const refusal = h(doc, 'p', 'ss-field-error ss-tabrows-refusal');
    refusal.setAttribute('role', 'alert');
    refusal.hidden = true;
    card.body.append(help, refusal, list, foot);
    parent.appendChild(card.el);
    // A real button clicks itself on Enter; SillyTavern's page-wide Enter handler clicks a `.menu_button` again (keyboard.js), which
    // would move a tab two places. The Enter stays with the button.
    card.body.addEventListener('keydown', event => {
        if (event.key === 'Enter' && String(event.target?.tagName ?? '').toLowerCase() === 'button') event.stopPropagation?.();
    });
    const canRows = () => Boolean(tabs && typeof tabs.rows === 'function');
    const rowsNow = () => (canRows() ? tabs.rows() : []);
    const say = (text, name = '') => {
        status.textContent = fill(text, { name });
        refusal.hidden = true;
        refusal.textContent = '';
    };
    const refuse = text => {
        status.textContent = '';
        refusal.textContent = text;
        refusal.hidden = false;
        revealIn(null, refusal, 'nearest');
    };
    const rowNode = id => [...list.querySelectorAll('.ss-tabrow')].find(node => node.dataset.tabId === id);
    const after = (id, control) => {
        draw();
        const row = rowNode(id);
        const wanted = row?.querySelector(`.ss-tabrow-${control}`);
        const other = row?.querySelector(`.ss-tabrow-${control === 'up' ? 'down' : 'up'}`);
        (wanted && !wanted.disabled ? wanted : other && !other.disabled ? other : wanted)?.focus?.({ preventScroll: true });
    };
    let shownRows = [];
    function draw() {
        list.replaceChildren();
        const rows = rowsNow();
        shownRows = rows;
        if (!rows.length) list.appendChild(h(doc, 'li', 'ss-tabrows-empty', T.none));
        const movable = rows.filter(row => !row.fixed);
        rows.forEach(row => {
            const item = h(doc, 'li', `ss-tabrow${row.hidden ? ' ss-tabrow-hidden' : ''}`);
            item.dataset.tabId = row.id;
            // the suite's own icon for its screens (view/icons), else the tab's: a Font Awesome name or a short glyph; the default icon otherwise
            const glyph = iconNode(doc, iconFor(row.id, row.icon), 'ss-tabrow-icon') ?? iconNode(doc, 'fa-table-columns', 'ss-tabrow-icon');
            const name = h(doc, 'span', 'ss-tabrow-name');
            const nameId = newId('tab');
            const title = h(doc, 'b', 'ss-tabrow-title', row.title);
            title.id = nameId;
            const where = row.where?.includes('tab') && row.where?.includes('screen') ? T.both : row.where?.includes('tab') ? T.tab : T.screen;
            name.append(title, h(doc, 'small', 'ss-tabrow-where', row.hidden ? `${where} · ${T.hidden}` : where));
            // Home cannot be hidden: its switch is locked, and the reason is said beside it (as a locked row says why).
            let lockId = '';
            if (row.fixed) {
                const lock = h(doc, 'small', 'ss-field-tag ss-field-tag-why ss-tabrow-lock', T.alwaysShown);
                lock.id = newId('tab-lock');
                lockId = lock.id;
                name.appendChild(lock);
            }
            const at = movable.indexOf(row);
            const up = press(doc, 'ss-iconbutton ss-tabrow-up', fill(T.upTitle, { name: row.title }), 'fa-arrow-up');
            const down = press(doc, 'ss-iconbutton ss-tabrow-down', fill(T.downTitle, { name: row.title }), 'fa-arrow-down');
            up.disabled = row.fixed || at <= 0;
            down.disabled = row.fixed || at < 0 || at >= movable.length - 1;
            up.addEventListener('click', () => { tabs.move(row.id, -1); say(T.movedUp, row.title); onChange?.(); after(row.id, 'up'); });
            down.addEventListener('click', () => { tabs.move(row.id, 1); say(T.movedDown, row.title); onChange?.(); after(row.id, 'down'); });
            const toggle = switchField({
                doc, id: newId('tab-shown'), key: row.id, field: { type: 'bool' }, value: !row.hidden, labelledBy: nameId, disabled: false, readOnly: row.fixed,
                onChange: on => {
                    // Hiding is refused when nothing would stay shown.
                    if (!on && rows.filter(other => !other.hidden && other.id !== row.id).length === 0) { toggle.set(true); refuse(fill(T.lastOne, { name: row.title })); return; }
                    tabs.setHidden(row.id, !on);
                    say(on ? T.nowShown : T.nowHidden, row.title);
                    onChange?.();
                    draw();
                    rowNode(row.id)?.querySelector('[role="switch"]')?.focus?.({ preventScroll: true });
                },
            });
            toggle.el.title = row.fixed ? T.homeTitle : fill(T.shownTitle, { name: row.title });
            if (lockId) toggle.el.setAttribute('aria-describedby', lockId);
            toggle.el.classList.add('ss-tabrow-shown');
            // A tab shown only while active has no switch: its note says when it shows (the screen's own, or the default).
            if (row.activeNote) {
                const note = h(doc, 'small', 'ss-tabrow-note', row.activeNote);
                item.append(glyph, name, up, down, note);
            } else {
                item.append(glyph, name, up, down, toggle.el);
            }
            list.appendChild(item);
        });
        reset.disabled = typeof tabs?.isDefault === 'function' ? tabs.isDefault() : true;
    }
    reset.addEventListener('click', () => {
        tabs.reset();
        say(T.wasReset);
        onChange?.();
        draw();
        reset.focus?.({ preventScroll: true });
    });
    draw();
    return {
        el: card.el,
        refresh() {
            draw();
        },
        // The card is found by its title, its help and the tabs' names.
        filter(text) {
            const query = String(text ?? '').trim().toLowerCase();
            if (!query) {
                card.setHidden(false);
                for (const row of list.querySelectorAll('.ss-tabrow')) row.hidden = false;
                return 0;
            }
            const matches = id => {
                const row = shownRows.find(item => item.id === id);
                return `${row?.title ?? ''} ${row?.id ?? ''}`.toLowerCase().includes(query);
            };
            let found = 0;
            for (const node of list.querySelectorAll('.ss-tabrow')) {
                node.hidden = !matches(node.dataset.tabId);
                if (!node.hidden) found += 1;
            }
            const own = `${T.title} ${T.hint} ${T.help}`.toLowerCase().includes(query);
            if (own) for (const node of list.querySelectorAll('.ss-tabrow')) node.hidden = false;
            card.setHidden(!found && !own);
            return own ? shownRows.length || 1 : found;
        },
        destroy() {
            card.el.remove();
        },
        focus() {
            const first = list.querySelector('[role="switch"]') ?? [...list.querySelectorAll('button')].find(node => !node.disabled) ?? null;
            return showAndFocus(first, 'center');
        },
        count: () => shownRows.length,
    };
}
