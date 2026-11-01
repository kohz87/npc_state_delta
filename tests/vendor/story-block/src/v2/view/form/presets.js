// "How much to track" (Settings → Features, UI cleanup item 3): three tiles, Lean / Standard / Full, over the module groups.
// A radio group of buttons (`role=radiogroup`, `role=radio`, `aria-checked`) that only draws what it is told and tells the
// form which tile was picked; the form (features.js) owns the feature store, so this holds no state of its own:
//
//   const picker = renderPresetPicker(doc, { onPick: name => {} });
//   picker.paint({ selected: 'standard' | 'lean' | 'full' | null, tokens: { lean: 740, standard: 1310, full: 1390 }, said: '' });
//
// The selected tile is whatever the switches match (features.js `selectedPreset`), never stored: none selected shows a
// "Custom" tag. A tile's number is the narrator's fixed prompt for that preset, `null` leaves it out (it could not be
// counted). Arrow keys move the focus between the tiles (one Tab stop); Space, Enter or a click picks, because a pick
// changes the reader's switches and a key passing over a tile should not. Built with createElement and textContent only.

import { newId } from './fields.js';
import { PRESET_NAMES } from '../../features.js';

export const PRESET_TEXT = Object.freeze({
    title: 'How much to track',
    fine: 'Fine-tune',
    custom: 'Custom',
    note: 'Change any switch below and this shows Custom. Your saved story is never deleted.',
    tokens: 'tokens of rules each reply',
    names: Object.freeze({ lean: 'Lean', standard: 'Standard', full: 'Full' }),
    about: Object.freeze({
        lean: 'Inventory, money, place, people, quests and time. No world-building threads or travel.',
        standard: 'Today\'s defaults.',
        full: 'Standard plus Choices, Inner chatter and a check roll before each reply.',
    }),
});

const h = (doc, tag, className = '', text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null && text !== '') node.textContent = String(text);
    return node;
};
const count = n => Number(n).toLocaleString('en-US');

/**
 * Draws the picker. `onPick(name)` runs when the reader picks a tile. → { el, paint({ selected, tokens, said }), tile(name),
 * setDisabled(on), setHidden(on) }. `el` is the block (title, tiles, the note under them); `fine` is the "Fine-tune" label that
 * goes under it, a sibling for the caller to place.
 */
export function renderPresetPicker(doc, { onPick = () => {}, disabled = false } = {}) {
    const id = newId('presets');
    const el = h(doc, 'section', 'ss-preset');
    el.setAttribute('data-presets', '');
    el.setAttribute('aria-labelledby', `${id}-title`);
    const head = h(doc, 'div', 'ss-preset-head');
    const title = h(doc, 'h4', 'ss-label ss-preset-title', PRESET_TEXT.title);
    title.id = `${id}-title`;
    // A polite live region: "Custom" when no tile matches, empty (and hidden) when one does.
    const state = h(doc, 'span', 'ss-preset-state');
    state.setAttribute('role', 'status');
    head.append(title, state);
    const group = h(doc, 'div', 'ss-preset-tiles');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-labelledby', title.id);
    group.setAttribute('aria-describedby', `${id}-note`);
    const note = h(doc, 'p', 'ss-preset-note', PRESET_TEXT.note);
    note.id = `${id}-note`;
    // The one-slower-reply note after a pick that changed the fixed prompt.
    const said = h(doc, 'p', 'ss-preset-said');
    said.setAttribute('role', 'status');
    let locked = Boolean(disabled);

    const tiles = new Map();
    for (const name of PRESET_NAMES) {
        const tile = h(doc, 'button', 'ss-preset-tile');
        tile.setAttribute('type', 'button');
        tile.setAttribute('role', 'radio');
        tile.setAttribute('data-preset', name);
        tile.setAttribute('aria-checked', 'false');
        const top = h(doc, 'span', 'ss-preset-top');
        const label = h(doc, 'span', 'ss-preset-name', PRESET_TEXT.names[name]);
        label.id = `${id}-${name}-name`;
        const dot = h(doc, 'span', 'ss-preset-dot');
        dot.setAttribute('aria-hidden', 'true');
        top.append(label, dot);
        const about = h(doc, 'span', 'ss-preset-about', PRESET_TEXT.about[name]);
        about.id = `${id}-${name}-about`;
        const size = h(doc, 'span', 'ss-preset-size');
        size.id = `${id}-${name}-size`;
        size.hidden = true;
        const num = h(doc, 'b', 'ss-preset-num');
        const unit = h(doc, 'span', 'ss-preset-unit');
        size.append(num, unit);
        tile.append(top, about, size);
        tile.setAttribute('aria-labelledby', label.id);
        tile.setAttribute('aria-describedby', `${about.id} ${size.id}`);
        tile.addEventListener('click', () => { if (!locked) onPick(name); });
        group.appendChild(tile);
        tiles.set(name, { tile, size, num, unit });
    }
    // One Tab stop (the picked tile, else the first); the arrow keys move the focus, Home and End go to the ends.
    group.addEventListener('keydown', event => {
        const names = [...tiles.keys()];
        const at = names.findIndex(name => tiles.get(name).tile === event.target || tiles.get(name).tile.contains?.(event.target));
        let next = null;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (at + 1) % names.length;
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (at - 1 + names.length) % names.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = names.length - 1;
        if (next === null || at < 0) return;
        event.preventDefault?.();
        tiles.get(names[next]).tile.focus?.({ preventScroll: true });
    });
    el.append(head, group, note, said);
    const fine = h(doc, 'p', 'ss-label ss-preset-fine', PRESET_TEXT.fine);

    return {
        el,
        tile: name => tiles.get(name)?.tile,
        paint({ selected = null, tokens = {}, said: told = '' } = {}) {
            const first = selected ?? PRESET_NAMES[0];
            for (const [name, entry] of tiles) {
                const on = name === selected;
                entry.tile.setAttribute('aria-checked', String(on));
                entry.tile.setAttribute('tabindex', name === first ? '0' : '-1');
                entry.tile.classList.toggle('ss-preset-on', on);
                const n = tokens?.[name];
                entry.size.hidden = !Number.isFinite(n);
                entry.num.textContent = Number.isFinite(n) ? `≈ ${count(n)}` : '';
                entry.unit.textContent = Number.isFinite(n) ? ` ${PRESET_TEXT.tokens}` : '';
            }
            state.textContent = selected ? '' : PRESET_TEXT.custom;
            said.textContent = told;
        },
        setDisabled(on) {
            locked = Boolean(on);
            for (const entry of tiles.values()) {
                entry.tile.disabled = locked;
                if (locked) entry.tile.setAttribute('aria-disabled', 'true'); else entry.tile.removeAttribute('aria-disabled');
            }
        },
        setHidden(on) { el.hidden = Boolean(on); fine.hidden = Boolean(on); },
        fine,
    };
}
