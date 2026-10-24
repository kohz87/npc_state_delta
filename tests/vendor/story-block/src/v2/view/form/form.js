// The form engine (UI stage 1b, PR B): renders a whole module's settings from its schema (the registry's
// `settingsDefs()` entry: `{ moduleId, schema, defaults, title }`; the host's own schema with `moduleId: null`) with the
// field renderers of fields.js, and writes through the same settings store the overlay writes through
// (`settings.set(moduleId, key, value)`, sdk.js createSettings: text cut, numbers kept in their range, a choice
// that is one of its options). It does NOT replace the settings window (step 3); the UI sample shows it as a demo form.
//
//   const form = renderSettingsForm(parent, { moduleId, schema, settings, featureOn, profiles, search, onChange });
//   form.filter('coin');   form.refresh();   form.setDisabled(true);   form.destroy();
//
// What it takes from the schema, as the overlay does: the fields' types and bounds, `form: 'lines'` (a list starts as one
// line per item), `form: 'slider'` and `form: 'chips'`, `group` or a label's "Group: …" prefix (a grouped section each),
// `readOnly` (true, or a function of the module's values; the control is locked and says "Read only"), `shows(values)` (what
// a read-only row displays, the stored value kept), `feature` (a field of a feature that is off is not shown) and
// `profile` (the Connection Manager select). A type it does not know is not drawn and its value is left alone.
//
// Every row has its label, help, validation message (role=alert, aria-invalid on the control, said again by
// aria-describedby), disabled and read-only states. A value the store did not keep as typed (a number moved into its
// range, a text cut, a refused one) says so under the field and shows what is stored. Nothing here writes markup.

import {
    FIELD_TYPES, FORM_TEXT, changeNote, emptyValue, fieldKind, fieldReadOnly, fill, groupFields, labelOf, matchesSearch, normalizeField, rowValue,
} from './schema.js';
import { RENDERERS, newId, searchField, sectionBlock } from './fields.js';

const h = (doc, tag, className = '', text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null && text !== '') node.textContent = String(text);
    return node;
};
// Controls the label may name by `for` (a button is labelable too); the rest are named by aria-labelledby.
const LABELABLE = new Set(['text', 'number', 'select', 'profile', 'slider', 'switch']);
// A switch sits beside its text; the rest sit under it on a phone and beside it on a wide box (CSS).
const INLINE = new Set(['switch']);
// What a field's own `check(value)` says about a value the store kept (a plain sentence, or nothing): the part of it the
// module will not use, which the store cannot know ("Two coins are called silver").
function checkNote(field, value) {
    if (typeof field.check !== 'function') return '';
    try {
        const text = field.check(value);
        return typeof text === 'string' ? text : '';
    } catch {
        return '';
    }
}

/**
 * Renders the settings of one module into `parent`. Options: `moduleId` (null: the host's), `schema`, `settings` (the
 * store: `settings(id)` → values, `settings.set(id, key, value)` → stored value or undefined), `doc`, `title`, `hint`,
 * `featureOn(featureId)` (a field with `feature` shows while it says true; default: always), `profiles()` (the
 * Connection Manager answer for profile fields; default: the page's), `search` (a search box on top), `onChange({ moduleId,
 * key, value })` (after a value was stored), `memo` (a Map keeping a list's rows/lines choice across redraws), `disabled`,
 * `sources` ({ key: { get(), set(value) } }: a field whose value lives elsewhere, a feature's switch or a host setting),
 * `quiet` (no "N settings shown" or "No settings match" line: a window around it says it), `className` (another class on the form),
 * `fold` ({ prefix, state?, openFirst? }: with more than one group, each group is a fold (a `details`) whose key is `prefix + group name`;
 * `state` is a Map of key → open kept across redraws, the first group opens unless the state says otherwise; a search opens the
 * groups that have a match and the reader's choice comes back when it is cleared).
 * → { el, filter(text), refresh(), setDisabled(on), field(key), keys(), groups(), openGroup(name), destroy() }.
 */
export function renderSettingsForm(parent, options) {
    const {
        moduleId = null, schema = {}, settings, doc = parent?.ownerDocument ?? globalThis.document, title = '', hint = '', featureOn = null, profiles = null, search = false,
        onChange = null, memo = new Map(), quiet = false, className = '', sources = null, fold = null,
    } = options ?? {};
    if (typeof settings !== 'function' || typeof settings.set !== 'function') throw new TypeError('The settings form needs the settings store (settings(id) and settings.set(id, key, value)).');
    let disabled = Boolean(options?.disabled);
    const root = h(doc, 'div', className ? `ss-form ${className}` : 'ss-form');
    root.setAttribute('data-module', String(moduleId ?? 'story-suite'));
    if (title) root.setAttribute('aria-label', title);
    const rows = new Map();          // key → { row, f, group, handle, setError, kind, volatile }
    const sections = [];
    let filterText = '';

    // ---- the top: title, search, what is shown
    if (title) root.appendChild(h(doc, 'h2', 'ss-form-title', title));
    if (hint) root.appendChild(h(doc, 'p', 'ss-form-hint', hint));
    const status = h(doc, 'p', 'ss-form-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;
    let searchBox = null;
    if (search) {
        searchBox = searchField(doc, { onInput: text => api.filter(text) });
        root.appendChild(searchBox.el);
    }
    root.appendChild(status);
    const empty = h(doc, 'p', 'ss-form-empty');
    empty.hidden = true;
    root.appendChild(empty);

    const values = () => settings(moduleId);
    // A field whose value lives elsewhere than the module's settings (a feature's switch, a host setting): `sources[key]` is
    // { get() → the value, set(value) → what was stored, or undefined for a refusal }.
    const sourceOf = key => (sources && Object.hasOwn(sources, key) ? sources[key] : null);
    const valueOf = (key, f, now) => {
        const source = sourceOf(key);
        if (!source) return rowValue(key, f, now);
        try { return source.get(); } catch { return emptyValue(f); }
    };

    // ---- one row
    function buildRow(key, field, group) {
        const f = normalizeField(field);
        const kind = fieldKind(f);
        if (!kind || !FIELD_TYPES.includes(f.type)) return null;
        const id = newId(`${moduleId ?? 'host'}-${key}`);
        const row = h(doc, 'div', `ss-field${INLINE.has(kind) ? ' ss-field-inline' : ''}`);
        row.setAttribute('data-field', key);
        row.setAttribute('data-kind', kind);
        // A row that wants the whole width of a card laid out in columns (a list, chips, a text area).
        if (kind === 'lines' || kind === 'chips' || kind === 'chipset' || (kind === 'text' && f.multiline === true)) row.setAttribute('data-wide', 'true');
        row.setAttribute('data-type', f.type);
        const text = h(doc, 'div', 'ss-field-text');
        const labelTag = LABELABLE.has(kind) ? 'label' : 'span';
        const label = h(doc, labelTag, 'ss-field-label', labelOf(key, f));
        label.id = `${id}-label`;
        if (labelTag === 'label') label.setAttribute('for', `${id}-control`);
        text.appendChild(label);
        const described = [];
        if (f.help) {
            const help = h(doc, 'small', 'ss-field-help', f.help);
            help.id = `${id}-help`;
            text.appendChild(help);
            described.push(help.id);
        }
        const note = h(doc, 'small', 'ss-field-note');
        note.id = `${id}-note`;
        note.hidden = true;
        text.appendChild(note);
        const tag = h(doc, 'small', 'ss-field-tag', FORM_TEXT.readOnly);
        tag.id = `${id}-readonly`;
        tag.hidden = true;
        text.appendChild(tag);
        const control = h(doc, 'div', 'ss-field-control');
        const error = h(doc, 'p', 'ss-field-error');
        error.id = `${id}-error`;
        error.setAttribute('role', 'alert');
        error.hidden = true;

        let handle = null;
        const describe = () => {
            const ids = [...described];
            if (!note.hidden) ids.push(note.id);
            if (!tag.hidden) ids.push(tag.id);
            if (!error.hidden) ids.push(error.id);
            if (ids.length) handle.input.setAttribute('aria-describedby', ids.join(' '));
            else handle.input.removeAttribute('aria-describedby');
            if (error.hidden) handle.input.removeAttribute('aria-invalid');
            else handle.input.setAttribute('aria-invalid', 'true');
        };
        const setError = message => {
            error.textContent = message;
            error.hidden = !message;
            describe();
        };
        const entry = { row, f, group, kind, key, setError, tag, handle: null, volatile: typeof f.readOnly === 'function' || typeof f.shows === 'function' || typeof f.format === 'function' };
        // What the store keeps of a value the reader chose: shown, with a note when it is not what was typed.
        const commit = (value, meta) => {
            const source = sourceOf(key);
            let stored;
            try { stored = source ? source.set(value) : settings.set(moduleId, key, value); } catch { stored = undefined; }
            if (stored === undefined) {
                const now = valueOf(key, f, values());
                handle.set(now);
                setError(fill(FORM_TEXT.refused, { value: Array.isArray(now) ? `${now.length} items` : String(now ?? '') }));
                return;
            }
            handle.set(stored);
            setError([meta?.note, changeNote(f, meta?.typed, stored), checkNote(f, stored)].filter(Boolean).join(' '));
            refreshDependents(key);
            if (typeof onChange === 'function') {
                try { onChange({ moduleId, key, value: stored }); } catch { /* the caller's own problem */ }
            }
        };
        const now = values();
        const readOnly = fieldReadOnly(f, now);
        const ctx = {
            doc, id, key, field: f, value: valueOf(key, f, now), label: labelOf(key, f), labelledBy: label.id, disabled, readOnly, memo, profiles,
            onChange: commit, invalid: message => setError(message), note: message => { note.textContent = message ?? ''; note.hidden = !message; if (handle) describe(); },
        };
        handle = RENDERERS[kind](ctx);
        entry.handle = handle;
        handle.input.id = `${id}-control`;
        control.appendChild(handle.el);
        row.append(text, control, error);
        entry.describe = describe;
        paintLock(entry, readOnly);
        return entry;
    }
    function paintLock(entry, readOnly) {
        // The tag says "Read only", or, for a field with `lockText` (a sentence, or a function of the values), why it is locked.
        const why = readOnly && entry.f.lockText !== undefined ? (typeof entry.f.lockText === 'function' ? entry.f.lockText(values()) : entry.f.lockText) : '';
        entry.tag.textContent = why ? String(why) : FORM_TEXT.readOnly;
        entry.tag.classList.toggle('ss-field-tag-why', Boolean(why));
        entry.tag.hidden = !readOnly;
        entry.row.classList.toggle('ss-field-readonly', readOnly);
        entry.row.classList.toggle('ss-field-disabled', disabled);
        entry.row.setAttribute('data-readonly', String(readOnly));
        entry.handle.setReadOnly(readOnly);
        entry.describe();
    }
    // After a value changed: the rows that depend on the values (a read-only that is a function, `shows`) follow.
    function refreshDependents(except = null) {
        const now = values();
        for (const entry of rows.values()) {
            if (!entry.volatile || entry.key === except) continue;
            const readOnly = fieldReadOnly(entry.f, now);
            entry.handle.set(valueOf(entry.key, entry.f, now));
            paintLock(entry, readOnly);
        }
        paintVisibility();
    }
    function featureHidden(entry) {
        const id = entry.f.feature;
        if (!id || typeof featureOn !== 'function') return false;
        try { return !featureOn(id); } catch { return false; }
    }
    function paintVisibility() {
        let shown = 0;
        for (const entry of rows.values()) {
            const visible = !featureHidden(entry) && matchesSearch(entry.key, entry.f, entry.group, filterText);
            entry.row.hidden = !visible;
            if (visible) shown += 1;
        }
        const searching = filterText.trim() !== '';
        for (const section of sections) {
            const any = section.keys.some(key => rows.get(key) && !rows.get(key).row.hidden);
            section.setHidden(!any);
            // A fold with a match is open while the search is on; the reader's own choice comes back after it.
            if (section.fold) {
                section.el.open = searching ? any : section.userOpen;
                section.el.classList.toggle('ss-section-fold-open', section.el.open === true);
            }
        }
        // `quiet`: a window around the form says how many matched (all its pages together), so the form does not.
        if (quiet) {
            status.hidden = true;
            status.textContent = '';
            empty.hidden = true;
            empty.textContent = '';
            return shown;
        }
        status.hidden = !searching;
        status.textContent = searching && shown ? (shown === 1 ? FORM_TEXT.shownOne : fill(FORM_TEXT.shown, { n: shown })) : '';
        empty.hidden = !(searching && shown === 0);
        empty.textContent = searching && shown === 0 ? fill(FORM_TEXT.none, { text: filterText.trim() }) : '';
        return shown;
    }

    // ---- the groups
    const groups = groupFields(schema);
    const single = groups.length === 1;
    for (const group of groups) {
        const entries = [];
        for (const { key, field } of group.fields) {
            const entry = buildRow(key, field, group.name);
            if (entry) {
                rows.set(key, entry);
                entries.push(entry);
            }
        }
        if (!entries.length) continue;
        // One group alone needs no heading of its own (and is never folded).
        const folded = Boolean(fold) && !single;
        const foldKey = `${fold?.prefix ?? ''}${group.name}`;
        const wasOpen = fold?.state instanceof Map && fold.state.has(foldKey) ? fold.state.get(foldKey) === true : fold?.openFirst !== false && sections.length === 0;
        const section = sectionBlock(doc, { title: single ? '' : group.name, id: newId(`${moduleId ?? 'host'}-group`), collapsible: folded, open: wasOpen });
        for (const entry of entries) section.body.appendChild(entry.row);
        if (!folded && !single) section.title.tabIndex = -1;   // a group's heading can take the focus (a fold id opens it)
        section.keys = entries.map(entry => entry.key);
        section.group = group.name;
        section.fold = folded;
        section.userOpen = wasOpen;
        section.foldKey = foldKey;
        if (folded) {
            section.el.classList.add('ss-section-fold');
            section.el.classList.toggle('ss-section-fold-open', wasOpen);
            section.el.dataset.fold = foldKey;
            section.el.addEventListener('toggle', () => {
                if (filterText.trim() !== '') return;
                section.el.classList.toggle('ss-section-fold-open', section.el.open === true);
                section.userOpen = section.el.open === true;
                if (fold.state instanceof Map) fold.state.set(foldKey, section.userOpen);
            });
        }
        sections.push(section);
        root.appendChild(section.el);
    }
    paintVisibility();
    parent?.appendChild?.(root);

    const api = {
        el: root,
        /** Shows the fields matching `text` (label, help, group, key); '' shows all. Returns how many are shown. */
        filter(text) {
            filterText = String(text ?? '');
            if (searchBox && searchBox.get() !== filterText) searchBox.set(filterText);
            return paintVisibility();
        },
        /** Reads every value again from the store (after something else changed one) and the features. */
        refresh() {
            const now = values();
            for (const entry of rows.values()) {
                entry.handle.set(valueOf(entry.key, entry.f, now));
                paintLock(entry, fieldReadOnly(entry.f, now));
                entry.setError('');
            }
            paintVisibility();
        },
        setDisabled(on) {
            disabled = Boolean(on);
            for (const entry of rows.values()) {
                entry.handle.setDisabled(disabled);
                entry.handle.setReadOnly(fieldReadOnly(entry.f, values()));
                entry.row.classList.toggle('ss-field-disabled', disabled);
            }
        },
        /** One row: { row, handle, kind, f, setError }, or undefined. */
        field: key => rows.get(key),
        keys: () => [...rows.keys()],
        /** The groups drawn, in order: [{ name, key, fold, open, el }]. */
        groups: () => sections.map(section => ({ name: section.group, key: section.foldKey, fold: section.fold, open: section.fold ? section.el.open === true : true, el: section.el })),
        /** Opens a group's fold (and the reader's choice with it) and returns its element, or null when there is no such group. */
        openGroup(name) {
            const section = sections.find(item => item.group === name);
            if (!section) return null;
            if (section.fold) {
                section.el.open = true;
                section.el.classList.add('ss-section-fold-open');
                section.userOpen = true;
                if (fold.state instanceof Map) fold.state.set(section.foldKey, true);
            }
            return section.el;
        },
        destroy() {
            // The form leaves the page first: a box that still holds the focus then says its `change` (the browser's blur) while the
            // rows are still here, so what the reader typed last is kept, and nothing is asked of a form already emptied.
            root.remove();
            for (const entry of rows.values()) entry.handle.destroy();
            rows.clear();
        },
    };
    return api;
}

/** A module's form from its registry entry (`registry.settingsDefs()[i]`): its schema and its title. */
export const renderModuleForm = (parent, def, options = {}) => renderSettingsForm(parent, { moduleId: def.moduleId ?? null, schema: def.schema ?? {}, title: def.title ?? '', ...options });
