// The form engine's page-level field blocks: the settings search box and the glass heading section that groups
// other fields.

import { FORM_TEXT } from '../schema.js';
import { button, h, newId } from './shared.js';

// ---- search ----------------------------------------------------------------------------------------

/**
 * The search box: a `type=search` input named "Search settings" (a hidden label), a clear button while it holds
 * text, Escape clears it. `onInput(text)` is called as the reader types. → { el, input, get(), set(text), clear() }.
 */
export function searchField(doc, { label = FORM_TEXT.searchLabel, placeholder = FORM_TEXT.searchPlaceholder, onInput = () => {}, id = newId('search') } = {}) {
    const root = h(doc, 'div', 'ss-search');
    root.setAttribute('role', 'search');
    const name = h(doc, 'label', 'ss-visually-hidden', label);
    name.setAttribute('for', id);
    const input = h(doc, 'input', 'ss-input ss-search-input');
    input.type = 'search';
    input.id = id;
    input.placeholder = placeholder;
    input.autocomplete = 'off';
    input.spellcheck = false;
    const clear = button(doc, 'ss-search-clear', FORM_TEXT.clear);
    const x = h(doc, 'span', '', '×');
    x.setAttribute('aria-hidden', 'true');
    clear.appendChild(x);
    clear.hidden = true;
    root.append(name, input, clear);
    const sync = () => { clear.hidden = input.value === ''; };
    const handle = {
        el: root, input,
        get: () => input.value,
        set(text) { input.value = String(text ?? ''); sync(); },
        clear() {
            input.value = '';
            sync();
            onInput('');
        },
    };
    input.addEventListener('input', () => { sync(); onInput(input.value); });
    input.addEventListener('keydown', event => {
        if (event.key === 'Escape' && input.value !== '') {
            event.preventDefault?.();
            event.stopPropagation?.();
            handle.clear();
        }
    });
    clear.addEventListener('click', () => {
        handle.clear();
        input.focus?.({ preventScroll: true });
    });
    return handle;
}

// ---- a grouped section -----------------------------------------------------------------------------

/**
 * A grouped section: a glass card with a heading (a section label, an `h3`) and an optional quiet hint, its fields
 * in `body`. `collapsible` makes it a `details` that opens and closes (`open`); `level` is the heading's (3: `h3`).
 * → { el, body, title, setHidden(on) }.
 */
export function sectionBlock(doc, { title = '', hint = '', id = newId('section'), collapsible = false, open = true, level = 3 } = {}) {
    const root = h(doc, collapsible ? 'details' : 'section', 'ss-section ss-glass');
    root.id = id;
    if (collapsible) root.open = Boolean(open);
    const head = h(doc, collapsible ? 'summary' : 'div', 'ss-section-head');
    const name = h(doc, collapsible ? 'span' : `h${Math.min(6, Math.max(2, Number(level) || 3))}`, 'ss-label ss-section-title', title);
    if (!collapsible) name.id = `${id}-title`;
    head.appendChild(name);
    if (hint) head.appendChild(h(doc, 'small', 'ss-section-hint', hint));
    const body = h(doc, 'div', 'ss-section-body');
    root.append(head, body);
    if (!collapsible && title) root.setAttribute('aria-labelledby', name.id);
    head.hidden = !title;
    return { el: root, body, title: name, setHidden(on) { root.hidden = Boolean(on); } };
}
