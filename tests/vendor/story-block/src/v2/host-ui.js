// Story Suite v2's two hosts for module UI (docs/v2/SPEC.md §6):
//
// - the settings host: one centred column of folds: the modules' own folds (Story Block's Packs), Features, one fold per module
//   with settings, Versions. Inside a module's fold: one line saying how many of its
//   features are on (it opens the Features fold there), its custom `section` right there (no sub-fold of
//   its own), then a sub-fold per settings group (a field's `group`, else its label's "Group: …" prefix,
//   else General). Versions is last. (Diagnostics, the report and what a module places there with `settings.place: 'diagnostics'`, is the
//   settings window's page now: view/settings/diagnostics-page.js.) Fields are rows (bool, int,
//   choice, text, list of {…}; a list one compact line per item, or, when its fields are text and whole
//   numbers, a textarea with one item per line: `form: 'lines'` starts there); values are read and
//   written through createSettings() (extension_settings.storySuite.modules[id]). Open folds stay open
//   across redraws. The settings window (view/settings/window.js, UI step 3a) shows it in sections: `renderSettingsHost`
//   with `sections` ({ ids, place(id), route(piece), defaultOpen(key), show(id), open(foldKey),
//   afterRefresh() }) draws each fold, and for Story Block's own fold each of its parts (Money, Assist), into the page of
//   the section it belongs to (view/settings/sections.js), and lists what a search can find (`entries()`). A section
//   with no pane (one the form engine draws: Look, Features, Money, Assist, Tabs & Packs) is not drawn here. The Story Suite
//   fold (the budgets, the prompt size, Tabs) is gone: the Tabs & Packs page draws them (view/settings/tabs-packs.js).
//   Features (MODULES §F100): the Features fold has a filter box and one sub-fold per module (by name,
//   "N of M on"), a switch per feature with its label and description; a feature that changes the
//   static prompt part says so (PROMPT_HINT). A settings field (`{ …, feature }`) or custom panel (a
//   function with `feature`) of a feature that is off is not drawn; a switch redraws. A feature whose
//   `needs` no installed module meets is drawn off and disabled, with its reason. The choices are the
//   reader's (createFeatureStore, extension_settings.storySuite.features), not the chat's.
// - the tab host: a tab bar with every module tab, each rendered from the head state's view.
//
// Every node is built with textContent; module names, labels and values are never markup.
// `doc` is the document to build in (tests pass a fake one).

import { FIELD_TYPES, normalizeField } from './registry.js';
import { SETTING_LIST_ROWS } from './sdk.js';
import { PROMPT_HINT, featureOf } from './features.js';
import { compatReport, renderCompat } from './compat.js';
import { createScreenBar, pinAlerts } from './view/screen-bar.js';
import { iconFor } from './view/icons/index.js';
import { DEFAULT_TAIL_BUDGET, contextNotice, estimateTokens } from './prompt.js';
import { STRINGS, fill } from './strings.js';
import { cutAt } from '../text.js';
import { profileNote, profileSelect } from './profile-field.js';
import { focusNode, revealIn } from './view/scroll.js';
import { dispose } from './view/mounts/common.js';

const S = STRINGS;

export const OPEN_CLASS = 'story-suite-open';
export const HOST_FOLD = 'story-suite';
export const FEATURES_FOLD = 'story-suite-features';
export const VERSIONS_FOLD = 'story-suite-versions';
export const DIAGNOSTICS_FOLD = 'story-suite-diagnostics';
// "Show what's sent", a sub-fold of Story Suite's own under the prompt size.
export const SENT_FOLD = 'story-suite::sent';
// Tabs (the reader's order for the Story panel's tabs and the game view's screens), a sub-fold of Story Suite's own.
export const TABS_FOLD = 'story-suite::tabs';
// Story Block's Packs fold (its `settings.folds`), second after Story Suite's; Home's "Import a pack" opens it.
export const PACKS_FOLD = 'story-block/packs';
// Story Block's Events (the events part's debug panel), a sub-fold of Diagnostics (its `place`).
export const EVENTS_FOLD = 'story-block/events';
// A sub-fold's key: its module's id, this, and the part ("rpg-battle::features", "story-director::group:Calendar").
export const SUB_FOLD = '::';
// A module's sub-fold in the Features fold ("story-suite-features::rpg-battle"); its fold's line opens it.
export const featuresFoldOf = moduleId => `${FEATURES_FOLD}${SUB_FOLD}${moduleId}`;
export const SETTINGS_TEXT = Object.freeze({
    hostHint: 'prompt and its size',
    general: 'General',
    more: 'More',
    settings: '{n} settings',
    oneSetting: '1 setting',
    featuresOn: '{on} of {n} on',
    listItem: 'item {n}',
    remove: 'Remove {name}',
    add: 'Add',
    addTitle: 'Add to {field}',
    // A list's text form (`form: 'lines'`, or "Edit as text"): one item per line, its fields split by ":".
    asText: 'Edit as text',
    asRows: 'Edit as rows',
    asTextTitle: 'Edit {field} as text, one per line',
    asRowsTitle: 'Edit {field} as rows',
    linesHelp: 'One per line, as {form}. Any number of lines, up to {max}.',
    lineError: 'Line {n} ("{line}"): {why} The list is kept as it was until every line reads.',
    lineParts: 'it needs {form}.',
    lineExtra: 'it has more than {n} parts split by ":".',
    lineWhole: '{field} is not a whole number.',
    lineMin: '{field} must be at least {min}.',
    lineMax: '{field} must be at most {max}.',
    lineCount: 'a list holds at most {max} lines.',
    size: Object.freeze({
        title: 'Prompt size',
        help: 'What Story Suite adds to the prompt of the next reply in this chat, counted now. Nothing is sent.',
        none: 'Open a chat to see what Story Suite adds to its prompt.',
        static: 'Instructions (the same every reply)',
        tail: 'This reply\'s part',
        total: 'In all',
        about: 'about {n} tokens',
        exact: '{n} tokens',
        ofBudget: '{size} of {budget}',
        perModule: 'Per module, in tokens',
        module: 'Module',
        staticShort: 'Instructions',
        tailShort: 'This reply',
        howAbout: 'Estimated at four characters a token. The budget is Notes per reply, above, or less when the context is small.',
        howExact: 'Counted with SillyTavern\'s tokenizer. The budget is Notes per reply, above, or less when the context is small.',
        context: 'Context size',
        contextValue: '{n} tokens',
        contextReply: '{n} tokens ({reply} of them for the reply)',
        share: 'Story Suite\'s share',
        shareValue: '{share} of {room} tokens ({percent}%)',
        contextUnknown: 'The context size is shown after the next reply.',
        // A module's own prompt (its `ownPrompt` hook): sent by the module itself, counted here and in the share.
        own: '{name}, sent by itself',
    }),
    // "Show what's sent": the exact text the next reply would get, per module, with Copy. Read-only.
    sent: Object.freeze({
        title: 'Show what\'s sent',
        hint: 'the exact text',
        help: 'The exact text Story Suite would add to the prompt of the next reply, built now from this chat. Nothing is sent from here.',
        static: 'Instructions (the same every reply)',
        tail: 'This reply\'s part',
        own: 'Sent by the modules themselves',
        part: '{name}: {label}',
        tokens: '{n} tokens',
        about: 'about {n} tokens',
        dropped: '{n} lines left out to fit the budget.',
        droppedOne: '1 line left out to fit the budget.',
        nothing: 'Nothing (no module adds text here now).',
        copy: 'Copy',
        copyTitle: 'Copy all of the text below',
        copied: 'Copied.',
        copyFailed: 'It could not be copied here: the text is selected, so copy it by hand (Ctrl+C, or long-press on a phone).',
        textLabel: 'What is sent: {part}',
    }),
});
// Settings → Tabs & Packs → Tabs (view/tab-order.js keeps the choice).
export const TABS_TEXT = Object.freeze({
    title: 'Tabs',
    hint: 'order, show or hide',
    help: 'The order of the Story panel\'s tabs and the game view\'s screens, one list for both. Up and Down move one; a hidden one leaves the tabs and the game view and stays here to show again. Home is always first and always shown. Scene starts hidden while Story Director\'s World is installed (its Now shows the same place, time and people).',
    none: 'No module has a tab or a screen yet.',
    listLabel: 'Tabs and screens, in order',
    up: 'Up',
    down: 'Down',
    upTitle: 'Move {name} up',
    downTitle: 'Move {name} down',
    shown: 'Shown',
    shownTitle: 'Show {name} in the tabs and the game view',
    homeTitle: 'Home is always first and always shown',
    hidden: 'hidden',
    activeNote: 'Shown only while it is active (during a battle, for example).',
    both: 'Story panel and game view',
    tab: 'Story panel',
    screen: 'game view',
    reset: 'Reset to default',
    resetTitle: 'Put every tab back in the default order and show them all',
    movedUp: '{name} moved up.',
    movedDown: '{name} moved down.',
    nowHidden: '{name} is hidden.',
    nowShown: '{name} is shown.',
    wasReset: 'Back to the default order, all shown.',
    // Home's switch is locked; hiding is refused when no tab would stay shown.
    alwaysShown: 'Always shown',
    lastOne: 'At least one tab has to stay shown, so {name} stays.',
});
// The Diagnostics page (diagnostics.js builds the report; view/settings/diagnostics-page.js draws it).
export const DIAGNOSTICS_TEXT = Object.freeze({
    title: 'Diagnostics',
    // The report's fold: its summary line says what the report holds (the fold is closed until it is opened).
    reportTitle: 'Report',
    reportHint: 'versions, modules, settings',
    checksHint: 'checks for packs and modules',
    help: 'A plain report of what Story Suite sees: versions, features, settings, the prompt size, the last problems, saving and the size of this chat, and what each module adds. It holds no API keys, passwords or addresses and no chat text. Read it before you share it.',
    copy: 'Copy report',
    save: 'Save report',
    refresh: 'Refresh',
    reportLabel: 'The diagnostics report',
    building: 'Building the report…',
    copied: 'Copied the report.',
    copyFailed: 'The report could not be copied here: it is selected above, so copy it by hand (Ctrl+C, or long-press on a phone).',
    saved: 'Saved the report as {name}.',
    saveFailed: 'The report could not be saved: {why}',
    failed: 'The report could not be built: {why}',
    sample: 'Show the UI sample',
    sampleTitle: 'Every building block of Story Suite\'s look, in light and dark, for checking a theme and for screenshots',
    sampleFailed: 'The UI sample could not be shown: {why}',
    credits: 'Icons: Phosphor Icons (phosphoricons.com), MIT License.',
});
export const FEATURE_TEXT = Object.freeze({
    title: 'Features',
    overviewHint: 'every module',
    filter: 'Find a feature',
    filterPlaceholder: 'Name or description',
    filterNone: 'No feature matches "{text}".',
    link: 'Features: {on} of {n} on — change',
    linkTitle: 'Features of {name}: {on} of {n} on. Change them in the Features fold.',
    overviewHelp: 'Every optional part of every module. It applies to you, in every chat; turning one off keeps what the story holds for it, so turning it on again brings it all back.',
});

function el(doc, tag, className = '', text = '') {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== '' && text !== null && text !== undefined) node.textContent = String(text);
    return node;
}

function button(doc, className, text, title = '') {
    const node = el(doc, 'button', className, text);
    node.type = 'button';
    if (title) {
        node.title = title;
        node.setAttribute('aria-label', title);
    }
    return node;
}

const humanize = key => String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, char => char.toUpperCase());
const optionsOf = field => (field.options ?? []).map(option => (option && typeof option === 'object' ? { value: String(option.value), label: String(option.label ?? option.value) } : { value: String(option), label: String(option) }));

/** The value a field starts from when it has no default. */
export function emptyValue(field) {
    const f = normalizeField(field);
    if (f.type === 'bool') return false;
    if (f.type === 'int') return Number.isInteger(f.min) ? f.min : 0;
    if (f.type === 'choice') return optionsOf(f)[0]?.value ?? '';
    if (f.type === 'list') return [];
    return '';
}

/** A whole number from what was typed, kept inside min/max; null when it is not one. */
export function readInt(text, field) {
    const value = Number(String(text).trim());
    if (!String(text).trim() || !Number.isFinite(value)) return null;
    let out = Math.round(value);
    if (Number.isInteger(field.min)) out = Math.max(field.min, out);
    if (Number.isInteger(field.max)) out = Math.min(field.max, out);
    return out;
}

// One control for one field; `onChange(value)` gets the new value.
function control(doc, field, value, onChange, id, memo = null) {
    const f = normalizeField(field);
    if (f.type === 'bool') {
        const input = el(doc, 'input');
        input.type = 'checkbox';
        input.checked = Boolean(value);
        input.addEventListener('change', () => onChange(Boolean(input.checked)));
        return input;
    }
    if (f.type === 'choice') {
        const select = el(doc, 'select', 'text_pole');
        for (const option of optionsOf(f)) {
            const node = el(doc, 'option', '', option.label);
            node.value = option.value;
            select.appendChild(node);
        }
        select.value = String(value ?? '');
        select.addEventListener('change', () => onChange(select.value));
        return select;
    }
    // A Connection Manager profile's name, or '' for the chat's connection (profile-field.js).
    if (f.type === 'profile') return profileSelect(doc, value, onChange);
    if (f.type === 'int') {
        const input = el(doc, 'input', 'text_pole');
        input.type = 'number';
        if (Number.isInteger(f.min)) input.min = String(f.min);
        if (Number.isInteger(f.max)) input.max = String(f.max);
        input.step = '1';
        input.inputMode = 'numeric';
        input.value = String(value ?? '');
        input.addEventListener('change', () => {
            const next = readInt(input.value, f);
            // Not a number: the stored value stays, and is shown again.
            if (next === null) { input.value = String(value ?? ''); return; }
            input.value = String(next);
            value = next;
            onChange(next);
        });
        return input;
    }
    if (f.type === 'list') return listControl(doc, f, Array.isArray(value) ? value : [], onChange, id, memo);
    const input = el(doc, f.multiline ? 'textarea' : 'input', 'text_pole');
    if (!f.multiline) input.type = 'text';
    // A text field's `max` holds for typing and pasting alike (settings.set cuts it there too).
    const max = Number.isInteger(f.max) && f.max >= 0 ? f.max : null;
    if (max !== null) input.maxLength = max;
    input.value = String(value ?? '');
    input.addEventListener('change', () => {
        if (max !== null && input.value.length > max) input.value = cutAt(input.value, max);
        onChange(input.value);
    });
    return input;
}

// What an item of a list is called on its Remove button: its first text field ("January"), else its place.
function itemName(item, subs, index) {
    for (const [key, sub] of subs) {
        const value = item?.[key];
        if (sub.type === 'text' && typeof value === 'string' && value.trim()) return cutAt(value.trim().replace(/\s+/g, ' '), 40);
    }
    return fill(SETTINGS_TEXT.listItem, { n: index + 1 });
}

const subLabel = (key, sub) => sub.label ?? humanize(key);

/**
 * A list field's sub-fields when it has a text form ([[key, field]], in order), else null: every field
 * of its `of` is text or a whole number (a list holding a switch or a choice has rows only).
 */
export function listTextFields(field) {
    const f = normalizeField(field);
    if (f?.type !== 'list' || !f.of || typeof f.of !== 'object') return null;
    const subs = Object.entries(f.of).map(([key, sub]) => [key, normalizeField(sub)]);
    return subs.length && subs.every(([, sub]) => sub?.type === 'text' || sub?.type === 'int') ? subs : null;
}

// "Name: Days": how one line of a list's text form is written.
const lineForm = subs => subs.map(([key, sub]) => subLabel(key, sub)).join(': ');

/** A list's items as its text form: one per line, the fields in order joined by ": " ("Frostmoon: 30"). */
export function listToLines(field, items) {
    const subs = listTextFields(field) ?? [];
    return (Array.isArray(items) ? items : []).map(item => subs.map(([key, sub]) => {
        const value = item && Object.hasOwn(item, key) ? item[key] : emptyValue(sub);
        return String(value ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
    }).join(': ')).join('\n');
}

/**
 * The text form read back: → { ok: true, items } or { ok: false, line (1-based), text, error } for the
 * first line that does not read. Blank lines are skipped. A line holds the fields in order split by ":";
 * when there are more parts than fields and the list has one text field, the extra colons are that
 * field's ("Day: of Ash: 30" → name "Day: of Ash"). A whole number must be one and inside its min/max
 * (refused, not moved: "Days must be at least 1"). At most SETTING_LIST_ROWS items; any number below.
 */
export function linesToList(field, text) {
    const subs = listTextFields(field);
    if (!subs) return { ok: false, line: 0, text: '', error: 'this list has no text form' };
    const form = lineForm(subs);
    const texts = subs.map(([, sub], at) => (sub.type === 'text' ? at : -1)).filter(at => at >= 0);
    const items = [];
    const lines = String(text ?? '').split(/\r\n|\r|\n/);
    for (let at = 0; at < lines.length; at += 1) {
        const line = lines[at].trim();
        if (!line) continue;
        const fail = error => ({ ok: false, line: at + 1, text: line, error });
        if (items.length >= SETTING_LIST_ROWS) return fail(fill(SETTINGS_TEXT.lineCount, { max: SETTING_LIST_ROWS }));
        let parts = line.split(':');
        if (parts.length < subs.length) return fail(fill(SETTINGS_TEXT.lineParts, { form }));
        if (parts.length > subs.length) {
            if (texts.length !== 1) return fail(fill(SETTINGS_TEXT.lineExtra, { n: subs.length }));
            const t = texts[0];
            const after = subs.length - t - 1;
            parts = [...parts.slice(0, t), parts.slice(t, parts.length - after).join(':'), ...parts.slice(parts.length - after)];
        }
        const item = {};
        for (let i = 0; i < subs.length; i += 1) {
            const [key, sub] = subs[i];
            const part = parts[i].trim();
            if (sub.type === 'int') {
                const name = subLabel(key, sub);
                if (!/^[+-]?\d+$/.test(part)) return fail(fill(SETTINGS_TEXT.lineWhole, { field: name }));
                const n = Number(part);
                if (Number.isInteger(sub.min) && n < sub.min) return fail(fill(SETTINGS_TEXT.lineMin, { field: name, min: sub.min }));
                if (Number.isInteger(sub.max) && n > sub.max) return fail(fill(SETTINGS_TEXT.lineMax, { field: name, max: sub.max }));
                item[key] = n;
            } else {
                const max = Number.isInteger(sub.max) && sub.max >= 0 ? sub.max : null;
                item[key] = max !== null && part.length > max ? cutAt(part, max) : part;
            }
        }
        items.push(item);
    }
    return { ok: true, items };
}

// A list of {…}, compact: one line per item with its fields side by side (`[January ] [31] ×`), each
// input named by its field for screen readers (the column heads above say it for the eye), a small
// × to remove the item, and Add at the end. A sub-field of a type this Story Block does not know is
// not drawn; its value stays in the item.
// A list of text and whole-number fields also has a text form: a textarea, one item per line
// ("Frostmoon: 30"), read when it changes (on blur); a line that does not read is named under it and
// the stored list stays as it was. `form: 'lines'` starts in it; "Edit as text" / "Edit as rows" switch,
// and the choice is kept in `memo` (the settings' open state) across redraws.
function listControl(doc, field, items, onChange, id, memo = null) {
    const root = el(doc, 'div', 'story-suite-list');
    root.setAttribute('role', 'group');
    let list = structuredClone(items);
    const subs = Object.entries(field.of ?? {})
        .map(([key, sub]) => [key, normalizeField(sub)])
        .filter(([, sub]) => FIELD_TYPES.includes(sub?.type) && sub.type !== 'list');
    const labelOf = subLabel;
    const textFields = listTextFields(field);
    const formKey = `list-form:${id}`;
    let asText = textFields !== null && (memo?.has(formKey) ? memo.get(formKey) === true : field.form === 'lines');
    const fieldName = field.label ?? SETTINGS_TEXT.add;
    function toggleButton() {
        const toggle = button(doc, 'menu_button story-suite-list-toggle', '', fill(asText ? SETTINGS_TEXT.asRowsTitle : SETTINGS_TEXT.asTextTitle, { field: fieldName }));
        toggle.appendChild(el(doc, 'span', '', asText ? SETTINGS_TEXT.asRows : SETTINGS_TEXT.asText));
        toggle.setAttribute('aria-pressed', String(asText));
        return toggle;
    }
    function switchForm(next) {
        asText = next;
        memo?.set(formKey, asText);
        draw();
        root.querySelector('.story-suite-list-toggle')?.focus?.();
    }
    function drawText() {
        const area = el(doc, 'textarea', 'text_pole story-suite-list-text');
        area.id = `${id}-text`;
        area.rows = Math.max(4, Math.min(list.length + 1, 16));
        area.spellcheck = false;
        area.value = listToLines(field, list);
        area.setAttribute('aria-labelledby', `${id}-label`);
        const help = el(doc, 'small', 'story-suite-muted story-suite-list-help', fill(SETTINGS_TEXT.linesHelp, { form: lineForm(textFields), max: SETTING_LIST_ROWS }));
        help.id = `${id}-help`;
        const error = el(doc, 'p', 'story-suite-list-error');
        error.id = `${id}-error`;
        error.setAttribute('role', 'alert');
        error.hidden = true;
        area.setAttribute('aria-describedby', help.id);
        // Reads the text; true when it read (stored, written back tidy), false with the bad line named.
        const read = () => {
            const result = linesToList(field, area.value);
            if (!result.ok) {
                error.textContent = fill(SETTINGS_TEXT.lineError, { n: result.line, line: cutAt(result.text, 40), why: result.error });
                error.hidden = false;
                area.setAttribute('aria-invalid', 'true');
                area.setAttribute('aria-describedby', `${help.id} ${error.id}`);
                return false;
            }
            error.textContent = '';
            error.hidden = true;
            area.removeAttribute('aria-invalid');
            area.setAttribute('aria-describedby', help.id);
            list = result.items;
            area.value = listToLines(field, list);
            onChange(structuredClone(list));
            return true;
        };
        area.addEventListener('change', read);
        const foot = el(doc, 'div', 'story-suite-list-foot');
        const toggle = toggleButton();
        // Back to rows only when the text reads (else the error says which line, and the text stays).
        toggle.addEventListener('click', () => { if (read()) switchForm(false); else area.focus?.(); });
        foot.appendChild(toggle);
        root.append(area, help, error, foot);
    }
    const draw = (focusAt = null) => {
        root.replaceChildren();
        root.dataset.form = asText ? 'lines' : 'rows';
        if (asText) { drawText(); return; }
        if (list.length && subs.length) {
            const head = el(doc, 'div', 'story-suite-list-head');
            head.setAttribute('aria-hidden', 'true');
            for (const [key, sub] of subs) {
                const cell = el(doc, 'span', 'story-suite-list-cell', labelOf(key, sub));
                cell.dataset.type = sub.type;
                head.appendChild(cell);
            }
            head.appendChild(el(doc, 'span', 'story-suite-list-spacer'));
            root.appendChild(head);
        }
        const removes = [];
        list.forEach((item, index) => {
            const row = el(doc, 'div', 'story-suite-list-item');
            row.dataset.index = String(index);
            for (const [key, sub] of subs) {
                const cell = el(doc, 'span', 'story-suite-list-cell');
                cell.dataset.field = key;
                cell.dataset.type = sub.type;
                const value = item && Object.hasOwn(item, key) ? item[key] : emptyValue(sub);
                const inputId = `${id}-${index}-${key}`.replace(/[^\w-]/g, '_');
                const input = control(doc, sub, value, next => {
                    list[index] = { ...list[index], [key]: next };
                    onChange(structuredClone(list));
                }, inputId);
                input.id = inputId;
                input.setAttribute('aria-label', `${labelOf(key, sub)}, ${fill(SETTINGS_TEXT.listItem, { n: index + 1 })}`);
                if (sub.type === 'text' || sub.type === 'int') input.placeholder = labelOf(key, sub);
                cell.appendChild(input);
                row.appendChild(cell);
            }
            const name = fill(SETTINGS_TEXT.remove, { name: itemName(item, subs, index) });
            const remove = button(doc, 'menu_button story-suite-list-remove', '', name);
            remove.appendChild(el(doc, 'span', '', '×')).setAttribute('aria-hidden', 'true');
            remove.addEventListener('click', () => {
                list = list.filter((_, at) => at !== index);
                onChange(structuredClone(list));
                // The focus goes to the next item's ×, else to Add, never to the page behind.
                draw(Math.min(index, list.length - 1));
            });
            removes.push(remove);
            row.appendChild(remove);
            root.appendChild(row);
        });
        const add = button(doc, 'menu_button story-suite-list-add', '', field.label ? fill(SETTINGS_TEXT.addTitle, { field: field.label }) : SETTINGS_TEXT.add);
        add.appendChild(el(doc, 'span', '', SETTINGS_TEXT.add));
        add.addEventListener('click', () => {
            list = [...list, Object.fromEntries(subs.map(([key, sub]) => [key, emptyValue(sub)]))];
            onChange(structuredClone(list));
            draw();
            [...root.querySelectorAll('.story-suite-list-item')].at(-1)?.querySelector('input, select, textarea')?.focus?.();
        });
        if (textFields) {
            const foot = el(doc, 'div', 'story-suite-list-foot');
            const toggle = toggleButton();
            toggle.addEventListener('click', () => switchForm(true));
            foot.append(add, toggle);
            root.appendChild(foot);
        } else root.appendChild(add);
        if (focusAt !== null) (removes[focusAt] ?? add).focus?.();
    };
    draw();
    return root;
}

/**
 * Whether a schema field is read-only now (SPEC §6): its `readOnly` is `true`, or a function of the
 * module's current values (`settings(id)`) that returns true. A function that throws counts as false.
 */
export function fieldReadOnly(field, values) {
    const flag = normalizeField(field)?.readOnly;
    if (typeof flag !== 'function') return flag === true;
    try { return Boolean(flag(values)); } catch { return false; }
}

/**
 * The value a settings row shows: the stored value (else the default, else the field's empty value); a
 * read-only field with `shows(values)` shows what that returns instead, for display only (the stored value
 * is kept, so it is back when the field is editable again). A `shows` that throws or returns undefined
 * shows the stored value.
 */
export function rowValue(key, field, values) {
    const stored = Object.hasOwn(values, key) ? values[key] : emptyValue(field);
    const shows = normalizeField(field)?.shows;
    if (typeof shows !== 'function' || !fieldReadOnly(field, values)) return stored;
    try {
        const value = shows(values);
        return value === undefined ? stored : value;
    } catch {
        return stored;
    }
}

// `label.story-suite-row`: the label and its help on the left, the control on the right (stacked on a
// phone, host.css). A list's row is a `div` whose list group is named by the label. A read-only row
// shows its value and help with every control in it disabled, and stores nothing.
function fieldRow(doc, key, field, value, onChange, prefix, memo = null, readOnly = false) {
    const f = normalizeField(field);
    // A type this Story Block does not know (a newer module's): hidden, its value left alone.
    if (!FIELD_TYPES.includes(f?.type)) {
        const hidden = el(doc, 'div', 'story-suite-row');
        hidden.dataset.field = key;
        hidden.hidden = true;
        return hidden;
    }
    const id = `${prefix}-${key}`.replace(/[^\w-]/g, '_');
    const row = el(doc, f.type === 'list' ? 'div' : 'label', 'story-suite-row');
    row.dataset.field = key;
    row.dataset.type = f.type;
    if (f.type !== 'list') row.setAttribute('for', id);
    const text = el(doc, 'span', 'story-suite-row-label');
    const name = el(doc, 'b', '', f.label ?? humanize(key));
    name.id = `${id}-label`;
    text.appendChild(name);
    if (f.help) text.appendChild(el(doc, 'small', '', f.help));
    const note = f.type === 'profile' ? profileNote(doc, value) : null;
    if (note) text.appendChild(note);
    row.appendChild(text);
    const input = control(doc, f, value, readOnly ? () => {} : onChange, id, memo);
    (input.focusTarget ?? input).id = id;
    if (f.type === 'list') input.setAttribute('aria-labelledby', name.id);
    row.appendChild(input);
    if (readOnly) {
        row.classList.add('story-suite-row-readonly');
        row.dataset.readonly = 'true';
        for (const node of [input, ...input.querySelectorAll('input, select, textarea, button')]) {
            node.disabled = true;
            node.setAttribute('aria-disabled', 'true');
        }
    }
    return row;
}

// A fold: `details` with its summary (title, then a quiet hint). The chevron is CSS (host.css), so the
// summary's text is only the title and the hint. `className` tells the top folds from the sub-folds.
function fold(doc, key, title, hint = '', className = 'story-suite-fold') {
    const details = el(doc, 'details', className);
    details.dataset.fold = key;
    const summary = el(doc, 'summary');
    summary.appendChild(el(doc, 'b', '', title));
    if (hint) summary.appendChild(el(doc, 'small', '', hint));
    details.appendChild(summary);
    const body = el(doc, 'div', `${className}-body`);
    details.appendChild(body);
    return { details, body };
}

// "Calendar: Era (written before the year)" → group "Calendar", label "Era (…)". The part before the
// first ": " is a group only when it is short and has no brackets ("Money scale (0: the pack's)" has none).
const LABEL_PREFIX = /^([^:()[\]{}]{1,48}?):\s+(\S[\s\S]*)$/;

/**
 * A schema's fields in settings groups, in the order they first appear: [{ name, fields: [{ key, field }] }].
 * A field's group is its `group` (text), else its label's prefix ("Calendar: Era" → "Calendar", the label
 * then "Era"), else General. A label that starts with its own `group` loses that prefix too.
 */
export function groupFields(schema) {
    const groups = new Map();
    for (const [key, raw] of Object.entries(schema ?? {})) {
        const field = normalizeField(raw);
        const label = typeof field?.label === 'string' ? field.label.trim() : null;
        const match = label ? LABEL_PREFIX.exec(label) : null;
        const given = typeof field?.group === 'string' ? field.group.trim() : '';
        let name = SETTINGS_TEXT.general;
        let shown = label;
        if (given) {
            name = given;
            if (match && match[1].trim().toLowerCase() === given.toLowerCase()) shown = match[2];
        } else if (match) {
            name = match[1].trim();
            shown = match[2];
        }
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push({ key, field: shown === label ? raw : { ...field, label: shown } });
    }
    return [...groups].map(([name, fields]) => ({ name, fields }));
}

/**
 * What Story Suite adds to the prompt, counted per module: `parts` as prompt.js assemble() gives them
 * ({ module, place, text }), `tokensOf(text)` → a number, `own` what modules send on their own (turn.js
 * previewFit's `own`: { module, label, text }). → { modules: [{ id, name, static, tail }], static, tail,
 * own: [{ id, name, tokens }], total, budget }. The totals count the texts as sent (joined), the rows
 * their own parts; `total` takes in the modules' own prompts.
 */
export function promptSize(parts, { tokensOf = estimateTokens, names = id => id, budget = DEFAULT_TAIL_BUDGET, own = [] } = {}) {
    const list = Array.isArray(parts) ? parts.filter(part => part && typeof part.text === 'string') : [];
    const rows = new Map();
    for (const part of list) {
        const id = String(part.module ?? '');
        if (!rows.has(id)) rows.set(id, { id, name: names(id), static: 0, tail: 0 });
        rows.get(id)[part.place === 'static' ? 'static' : 'tail'] += tokensOf(part.text);
    }
    const staticText = list.filter(part => part.place === 'static').map(part => part.text).join('\n\n');
    const tailText = list.filter(part => part.place !== 'static').map(part => part.text).filter(Boolean).join('\n');
    const stat = staticText ? tokensOf(staticText) : 0;
    const tail = tailText ? tokensOf(tailText) : 0;
    const ownRows = new Map();
    for (const part of ownParts(own)) {
        const id = String(part.module ?? '');
        if (!ownRows.has(id)) ownRows.set(id, { id, name: names(id), tokens: 0 });
        ownRows.get(id).tokens += tokensOf(part.text);
    }
    const ownTotal = [...ownRows.values()].reduce((sum, row) => sum + row.tokens, 0);
    return { modules: [...rows.values()], static: stat, tail, own: [...ownRows.values()], total: stat + tail + ownTotal, budget };
}

// turn.js previewFit's `own` list, its parts with text only.
const ownParts = own => (Array.isArray(own) ? own.filter(part => part && typeof part.text === 'string' && part.text) : []);

/**
 * The texts the next reply would get, as "Show what's sent" lists them: { static: [part], tail: [part],
 * own: [part] } (each part { module, label, text, dropped }, empty texts left out unless lines were
 * dropped), and `copy`, all of it as one text: each section's heading, then its parts as sent (the
 * static ones joined by a blank line, the tail's by a line break, as prompt.js joins them).
 */
export function sentText(parts, own = [], { names = id => id } = {}) {
    const list = Array.isArray(parts) ? parts.filter(part => part && typeof part.text === 'string') : [];
    const T = SETTINGS_TEXT.sent;
    const stat = list.filter(part => part.place === 'static' && part.text);
    const tail = list.filter(part => part.place !== 'static' && (part.text || part.dropped));
    const titled = part => ({ module: String(part.module ?? ''), title: String(part.label ?? names(part.module)), text: part.text, dropped: Number(part.dropped) || 0 });
    const mine = ownParts(own).map(part => ({ ...titled(part), title: fill(T.part, { name: names(part.module), label: String(part.label ?? '') }) }));
    const sections = [
        [T.static, stat.map(part => part.text).join('\n\n')],
        [T.tail, tail.map(part => part.text).filter(Boolean).join('\n')],
        ...mine.map(part => [part.title, part.text]),
    ].filter(([, text]) => text);
    return { static: stat.map(titled), tail: tail.map(titled), own: mine, copy: sections.map(([head, text]) => `[${head}]\n${text}`).join('\n\n') };
}

// One feature's row: its switch, label, description and (when it changes the static prompt) the hint.
// A feature is drawn twice, so each switch's id is its place (`overview` or `module`) plus the feature id
// encoded whole (encodeURIComponent never makes two ids one, as flattening "a.b_c" and "a.b.c" would);
// its row labels that switch.
export const featureInputId = (place, id) => `story_suite_feature_${place}_${encodeURIComponent(String(id))}`;
function featureRow(doc, feature, onChange, place) {
    const id = featureInputId(place, feature.id);
    const row = el(doc, 'label', 'story-suite-row story-suite-feature');
    row.dataset.feature = feature.id;
    row.dataset.type = 'bool';
    row.setAttribute('for', id);
    const text = el(doc, 'span', 'story-suite-row-label');
    text.appendChild(el(doc, 'b', '', feature.label));
    if (feature.describe) text.appendChild(el(doc, 'small', '', feature.describe));
    if (feature.prompt) text.appendChild(el(doc, 'small', 'story-suite-feature-hint', PROMPT_HINT));
    // A feature whose `needs` no module meets: shown off, not switchable, with the reason.
    const unavailable = feature.available === false;
    if (unavailable) {
        row.classList.add('story-suite-feature-unavailable');
        text.appendChild(el(doc, 'small', 'story-suite-feature-why', feature.why));
    }
    row.appendChild(text);
    const input = el(doc, 'input');
    input.type = 'checkbox';
    input.id = id;
    input.setAttribute('role', 'switch');
    input.checked = feature.on === true && !unavailable;
    input.disabled = unavailable;
    input.setAttribute('aria-checked', String(input.checked));
    if (unavailable) input.setAttribute('aria-disabled', 'true');
    input.addEventListener('change', () => onChange(Boolean(input.checked)));
    row.appendChild(input);
    return row;
}

const FOLD_SELECTOR = 'details.story-suite-fold, details.story-suite-subfold';

/**
 * Renders the settings into `root` (emptied first), as one centred column of folds: the modules' own folds (Story Block's
 * Packs), Features (a sub-fold per module), one fold per module with settings (a line to its features, its custom panel, then a
 * sub-fold per settings group) and Versions. Story Suite's own
 * fold (the budgets, the prompt size, Tabs) is gone: the settings window's Tabs & Packs page draws them (view/settings/).
 *
 * `options`: { registry, settings (createSettings), doc?, sdk?, features? (createFeatureStore; without
 * it no Features are shown), openState? (a Map of fold key → open, kept across redraws; a new one by default),
 *  * sections? (the settings window's placing, above) }.
 * A module's `section(el, api)` gets api = { get(key), set(key, value), values(), sdk } (a section
 * given as a title plus render(el, api) is the same panel). Returns { refresh(), entries() }.
 */
export function renderSettingsHost(root, { registry, settings, doc = globalThis.document, sdk = null, features = null, openState = new Map(), sections = null }) {
    // What a search can find: every settings row, feature and panel drawn, `{ kind, key, field: { label, help }, group,
    // node }` (`node` is where it is now: a row drawn again replaces it). Rebuilt with each draw; `entries()` gives it.
    let found = [];
    const note = (kind, key, field, group, node) => {
        const entry = { kind, key, field, group, node };
        found.push(entry);
        return entry;
    };
    const featureList = () => (features && typeof features.list === 'function' ? features.list() : []);
    // A settings field or panel under a feature that is off is not drawn (its stored value is kept).
    const hiddenByFeature = item => {
        const id = featureOf(item);
        return id !== null && typeof registry.featureOn === 'function' && !registry.featureOn(id);
    };
    // A fold opens as the reader left it (this redraw or an earlier one), else as `open` says.
    function remember(details, open = false) {
        const key = details.dataset.fold;
        details.open = openState.has(key) ? openState.get(key) === true : open || sections?.defaultOpen?.(key) === true;
        details.addEventListener('toggle', () => { if (!details.dataset.filtered) openState.set(key, details.open === true); });
        return details;
    }
    // The Features fold's filter text, kept across redraws.
    let featureFilter = '';
    let clearFilter = () => { featureFilter = ''; };
    const panelApi = moduleId => Object.freeze({
        get: key => settings(moduleId)[key],
        set: (key, value) => settings.set(moduleId, key, value),
        values: () => settings(moduleId),
        sdk,
    });
    // A switch changed: stored, then everything is drawn again (the fields of that feature come or go, both
    // rows of it show the choice, the prompt size follows), open folds stay open and the switch keeps the focus.
    function setFeature(id, on, inputId) {
        features.set(id, on);
        refresh();
        const again = [...root.querySelectorAll('.story-suite-feature input')].find(input => input.id === inputId);
        again?.focus?.();
    }
    // The Features fold: a filter box, then one sub-fold per module (by name), its summary "N of M on".
    // The filter (by name and description, across modules) hides the rows and sub-folds that do not match
    // and opens the ones that do while it holds text; cleared, they are as the reader left them. It is
    // kept across redraws (a switch redraws everything).
    function featuresFold(list) {
        const { details, body } = fold(doc, FEATURES_FOLD, FEATURE_TEXT.title, FEATURE_TEXT.overviewHint);
        body.appendChild(el(doc, 'p', 'story-suite-muted', FEATURE_TEXT.overviewHelp));
        const find = el(doc, 'label', 'story-suite-row story-suite-feature-filter');
        find.dataset.type = 'text';
        const findId = 'story_suite_feature_filter';
        find.setAttribute('for', findId);
        const findText = el(doc, 'span', 'story-suite-row-label');
        findText.appendChild(el(doc, 'b', '', FEATURE_TEXT.filter));
        find.appendChild(findText);
        const input = el(doc, 'input', 'text_pole');
        input.type = 'search';
        input.id = findId;
        input.placeholder = FEATURE_TEXT.filterPlaceholder;
        input.autocomplete = 'off';
        input.value = featureFilter;
        find.appendChild(input);
        body.appendChild(find);
        const byModule = new Map();
        for (const feature of list) {
            if (!byModule.has(feature.moduleId)) byModule.set(feature.moduleId, []);
            byModule.get(feature.moduleId).push(feature);
        }
        const groups = [...byModule].map(([moduleId, own]) => ({ moduleId, own, name: String(own[0].moduleName ?? moduleId) }))
            .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase(), 'en') || (a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : 0));
        const subs = groups.map(({ moduleId, own, name }) => {
            const on = own.filter(feature => feature.on === true && feature.available !== false).length;
            const inner = fold(doc, featuresFoldOf(moduleId), name, fill(SETTINGS_TEXT.featuresOn, { on, n: own.length }), 'story-suite-subfold');
            inner.details.dataset.module = moduleId;
            inner.details.classList.add('story-suite-feature-group');
            for (const feature of own) {
                const row = featureRow(doc, feature, next => setFeature(feature.id, next, featureInputId('overview', feature.id)), 'overview');
                note('feature', feature.id, { label: feature.label, help: feature.describe }, `${name} Features`, row);
                inner.body.appendChild(row);
            }
            body.appendChild(remember(inner.details, groups.length === 1));
            return { details: inner.details, rows: [...inner.body.querySelectorAll('.story-suite-feature')], own };
        });
        const none = el(doc, 'p', 'story-suite-muted story-suite-feature-none');
        none.setAttribute('role', 'status');
        none.hidden = true;
        body.appendChild(none);
        const apply = () => {
            const query = featureFilter.trim().toLowerCase();
            let shown = 0;
            for (const sub of subs) {
                let matches = 0;
                sub.rows.forEach((row, at) => {
                    const feature = sub.own[at];
                    const hit = !query || `${feature.label ?? ''}\n${feature.describe ?? ''}`.toLowerCase().includes(query);
                    row.hidden = !hit;
                    if (hit) matches += 1;
                });
                shown += matches;
                sub.details.hidden = Boolean(query) && matches === 0;
                if (query) {
                    // Opened for the filter only: how the reader left it is kept first, and the filter's
                    // opening is not remembered (remember() and refresh() skip a filtered fold).
                    if (!sub.details.dataset.filtered) openState.set(sub.details.dataset.fold, sub.details.open === true);
                    sub.details.dataset.filtered = 'true';
                    sub.details.open = matches > 0;
                } else if (sub.details.dataset.filtered) {
                    delete sub.details.dataset.filtered;
                    const key = sub.details.dataset.fold;
                    sub.details.open = openState.has(key) ? openState.get(key) === true : subs.length === 1;
                }
            }
            none.hidden = !query || shown > 0;
            none.textContent = none.hidden ? '' : fill(FEATURE_TEXT.filterNone, { text: cutAt(featureFilter.trim(), 40) });
        };
        const update = () => { featureFilter = String(input.value ?? ''); apply(); };
        input.addEventListener('input', update);
        input.addEventListener('change', update);
        clearFilter = () => { input.value = ''; update(); };
        apply();
        return remember(details);
    }
    // A module's fold says how many of its features are on, with a button to the Features fold at its sub-fold.
    function openFeaturesAt(moduleId) {
        const key = featuresFoldOf(moduleId);
        const nodes = [...root.querySelectorAll(FOLD_SELECTOR)];
        const sub = nodes.find(node => node.dataset.fold === key);
        if (!sub) return;
        // A filter hiding that module goes, so its sub-fold shows.
        if (sub.hidden) clearFilter();
        for (const node of [nodes.find(item => item.dataset.fold === FEATURES_FOLD), sub]) {
            if (!node) continue;
            node.open = true;
            if (!node.dataset.filtered) openState.set(node.dataset.fold, true);
        }
        revealIn(null, sub, 'start');
        focusNode(sub.querySelector('summary'));
    }
    function featureLink(def, own) {
        const on = own.filter(feature => feature.on === true && feature.available !== false).length;
        const line = el(doc, 'p', 'story-suite-feature-line');
        const go = button(doc, 'story-suite-feature-link', fill(FEATURE_TEXT.link, { on, n: own.length }), fill(FEATURE_TEXT.linkTitle, { name: def.name, on, n: own.length }));
        // In the settings window the Features page is the form engine's: the window opens that module's group there.
        go.addEventListener('click', () => (sections?.open ? sections.open(featuresFoldOf(def.moduleId)) : openFeaturesAt(def.moduleId)));
        line.appendChild(go);
        return line;
    }
    const settingsCount = n => fill(n === 1 ? SETTINGS_TEXT.oneSetting : SETTINGS_TEXT.settings, { n });
    // A module's settings drawn in parts, not yet placed: its features line, its custom panel and one sub-fold
    // per settings group. `moduleFold` puts them in a fold of the module's own; the settings window (`sections`) may
    // send a part to another section (Story Block's money and Assist settings) and keep the rest in the fold.
    function moduleParts(def, own = []) {
        const values = settings(def.moduleId);
        const subs = [];
        // The rows whose `readOnly` is a function of the values: drawn again (value, help, disabled) after
        // any other field of this module changes, so switching Calendar to Custom makes its fields editable.
        const follows = [];
        const rowOf = (key, field, now) => fieldRow(doc, key, field, rowValue(key, field, now), next => {
            settings.set(def.moduleId, key, next);
            if (!follows.length) return;
            const fresh = settings(def.moduleId);
            for (const item of follows) {
                if (item.key === key || !item.row.parentNode) continue;
                const row = rowOf(item.key, item.field, fresh);
                item.row.before(row);
                item.row.remove();
                item.row = row;
            }
        }, `story_suite_${def.moduleId}`, openState, fieldReadOnly(field, now));
        // Its features are switched in the Features fold; here one line says how many are on and goes there.
        const link = own.length ? featureLink(def, own) : null;
        const shown = Object.fromEntries(Object.entries(def.schema).filter(([, field]) => !hiddenByFeature(field)));
        for (const group of groupFields(shown)) {
            const visible = group.fields.filter(({ field }) => FIELD_TYPES.includes(normalizeField(field)?.type));
            if (!visible.length) continue;
            subs.push({
                group: group.name,
                key: `group:${group.name}`,
                title: group.name,
                hint: settingsCount(visible.length),
                draw: into => {
                    for (const { key, field } of group.fields) {
                        const item = { key, field, row: rowOf(key, field, values) };
                        if (typeof normalizeField(field)?.readOnly === 'function' || typeof normalizeField(field)?.shows === 'function') follows.push(item);
                        const f = normalizeField(field);
                        if (FIELD_TYPES.includes(f?.type)) {
                            const entry = note('row', key, { label: f.label ?? humanize(key), help: f.help }, `${def.name} ${group.name}`, item.row);
                            Object.defineProperty(entry, 'node', { get: () => item.row, enumerable: true });
                        }
                        into.appendChild(item.row);
                    }
                },
            });
        }
        // Its custom panel sits in the module's fold itself, right under the features line (never in a
        // sub-fold: a module's own panel may have folds of its own, and three levels is too deep). A
        // titled section ("Assist") gets its title as a heading.
        let panel = null;
        if (def.section && !hiddenByFeature(def.section)) {
            const section = el(doc, 'div', 'story-suite-section');
            section.dataset.module = def.moduleId;
            panel = [...(def.title !== def.name ? [el(doc, 'h4', 'story-suite-section-title', def.title)] : []), section];
            try { def.section(section, panelApi(def.moduleId)); } catch (error) {
                section.replaceChildren(el(doc, 'p', 'story-suite-muted', `This part of ${def.name}'s settings could not be shown: ${error?.message ?? error}`));
            }
            note('panel', `${def.moduleId}${SUB_FOLD}panel`, { label: def.title, help: '' }, def.name, section);
        }
        // The schema's groups below it, each in a sub-fold of its own; one alone opens with its module.
        const lone = subs.length === 1 && !panel;
        const details = subs.map(sub => {
            const inner = fold(doc, `${def.moduleId}${SUB_FOLD}${sub.key}`, sub.title, sub.hint, 'story-suite-subfold');
            sub.draw(inner.body);
            return remember(inner.details, lone);
        });
        return { link, panel, subs: subs.map((sub, at) => ({ group: sub.group, details: details[at] })) };
    }
    // The module's fold: the parts given (all of them by default) under its title.
    function moduleFold(def, own = [], className = 'story-suite-fold', parts = moduleParts(def, own)) {
        const { details, body } = fold(doc, def.moduleId, def.name, def.title !== def.name ? def.title : def.moduleId, className);
        body.append(...[parts.link, ...(parts.panel ?? []), ...parts.subs.map(sub => sub.details)].filter(Boolean));
        return remember(details);
    }
    // A module's own top-level folds (`settings.folds`: Story Block's Packs), drawn even with nothing in them.
    function ownFolds(def, folds = def.folds, className = 'story-suite-fold') {
        return folds.map(item => {
            const { details, body } = fold(doc, `${def.moduleId}/${item.id}`, item.title, item.hint, className);
            details.classList.add(`story-suite-fold-${item.id}`);
            try { item.render(body, panelApi(def.moduleId)); } catch (error) {
                body.replaceChildren(el(doc, 'p', 'story-suite-muted', `This part of ${def.name}'s settings could not be shown: ${error?.message ?? error}`));
            }
            note('panel', `${def.moduleId}/${item.id}`, { label: item.title, help: item.hint }, def.name, details);
            return remember(details);
        });
    }

    // Versions (compat.js): each module, its version, the Story Block it needs, and what is out of step.
    function versionsFold() {
        const report = compatReport({ hostVersion: registry.hostVersion?.() ?? '', modules: registry.modules(), refusals: registry.refusals?.() ?? [] });
        const { details, body } = fold(doc, VERSIONS_FOLD, 'Versions', report.outOfStep ? `${report.outOfStep} out of step` : 'all in step');
        if (report.outOfStep) details.classList.add('story-suite-fold-warn');
        note('panel', VERSIONS_FOLD, { label: 'Versions', help: report.outOfStep ? `${report.outOfStep} out of step` : 'all in step' }, 'Modules', details);
        renderCompat(body, report, { doc });
        return remember(details);
    }
    function refresh() {
        for (const node of root.querySelectorAll(FOLD_SELECTOR)) if (!node.dataset.filtered) openState.set(node.dataset.fold, node.open === true);
        found = [];
        const all = featureList();
        const ownOf = moduleId => all.filter(feature => feature.moduleId === moduleId);
        // A module with features and no settings has no fold of its own: its features are in the Features fold.
        const defs = registry.settingsDefs().map(def => ({ ...def, folds: Array.isArray(def.folds) ? def.folds : [] }));
        const byId = (a, b) => (a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : 0);
        // A module fold or own fold placed in Diagnostics (`place: 'diagnostics'`, debug information like Story Block's Events)
        // is not drawn here: the settings window's Diagnostics page draws it (view/settings/diagnostics-page.js).
        const inDiagnostics = item => item.place === 'diagnostics';
        // Where each piece goes: one column of folds (the default), or the settings window's sections
        // (`sections.route(piece)` → a section id; the nodes of each are put in `sections.place(id)`).
        const placed = new Map();
        const put = (piece, ...nodes) => {
            const id = sections ? sections.route(piece) : '';
            if (!placed.has(id)) placed.set(id, []);
            placed.get(id).push(...nodes.filter(Boolean));
        };
        // A piece whose section a body of its own draws (Story Block's Packs: the Tabs & Packs page; every module's settings: the
        // Modules page; Versions) is not drawn here, and not even built.
        const hasPane = piece => !sections || Boolean(sections.place(sections.route(piece)));
        const wantsModule = def => !sections || [{ type: 'module' }, { type: 'panel' }, ...groupFields(def.schema).map(group => ({ type: 'group', group: group.name }))].some(piece => hasPane({ ...piece, moduleId: def.moduleId }));
        const shown = [...defs].filter(def => Object.keys(def.schema).length || def.section).sort(byId);
        const modules = shown.filter(def => !inDiagnostics(def) && wantsModule(def)).map(def => ({ def, parts: moduleParts(def, ownOf(def.moduleId)) }));
        const own = [...defs].sort(byId).flatMap(def => (hasPane({ type: 'own-fold', moduleId: def.moduleId }) ? ownFolds(def, def.folds.filter(item => !inDiagnostics(item))) : []).map(node => ({ def, node })));
        for (const { def, node } of own) put({ type: 'own-fold', moduleId: def.moduleId }, node);
        // The settings window draws Features itself (the form engine) when its page is not given to this host.
        if (all.length && (!sections || sections.place(sections.route({ type: 'features' })))) put({ type: 'features' }, featuresFold(all));
        for (const { def, parts } of modules) {
            if (!sections) {
                put({ type: 'module', moduleId: def.moduleId }, moduleFold(def, ownOf(def.moduleId), 'story-suite-fold', parts));
                continue;
            }
            // A module's custom panel or settings group may belong to a section of its own (Story Block's
            // Money and Assist); what stays goes in the module's fold in its home section.
            const home = sections.route({ type: 'module', moduleId: def.moduleId });
            const panelAt = parts.panel ? sections.route({ type: 'panel', moduleId: def.moduleId }) : home;
            const kept = { link: parts.link, panel: panelAt === home ? parts.panel : null, subs: [] };
            if (panelAt !== home) put({ type: 'panel', moduleId: def.moduleId }, ...parts.panel);
            for (const sub of parts.subs) {
                const at = sections.route({ type: 'group', moduleId: def.moduleId, group: sub.group });
                if (at === home) kept.subs.push(sub);
                else put({ type: 'group', moduleId: def.moduleId, group: sub.group }, sub.details);
            }
            if (kept.link || kept.panel || kept.subs.length) put({ type: 'module', moduleId: def.moduleId }, moduleFold(def, ownOf(def.moduleId), 'story-suite-fold', kept));
        }
        if (hasPane({ type: 'versions' })) put({ type: 'versions' }, versionsFold());
        if (!sections) {
            root.replaceChildren(...(placed.get('') ?? []));
            root.classList.add('story-suite-folds');
            return;
        }
        for (const id of sections.ids) sections.place(id)?.replaceChildren(...(placed.get(id) ?? []));
        sections.afterRefresh?.();
    }
    refresh();
    return { refresh, entries: () => found.slice() };
}

/** The fold keys a module placed in Settings → Diagnostics (`place: 'diagnostics'`): "story-block/events". */
export function diagnosticsKeys(registry) {
    const defs = typeof registry?.settingsDefs === 'function' ? registry.settingsDefs() : [];
    return defs.flatMap(def => [
        ...(def.place === 'diagnostics' ? [def.moduleId] : []),
        ...(Array.isArray(def.folds) ? def.folds : []).filter(item => item.place === 'diagnostics').map(item => `${def.moduleId}/${item.id}`),
    ]);
}

/**
 * The story panel's tab host, drawn into `root`: one pane, the chosen tab's, rendered with `tab.render(pane, view(), api)`,
 * and the screen bar (view/screen-bar.js) at the foot of the panel, in `barHost` (the panel itself; `root` if none): four
 * tabs and More, as the game view's bar (More holds the rest). The tabs are `registry.tabs()`, in its order (Story Block's
 * panel gives the module tabs and the tab screens in the reader's order, without the hidden ones). A tab that is gone falls
 * back to the first. The pane scrolls inside `root`; the bar stays where it is.
 * `options`: { registry, view: () => view, api (the sdk), doc?, active?, barHost? }. Tabs read the head state's view only,
 * never message text. Returns { refresh(), select(id), active(), bar }.
 */
export function createTabHost(root, { registry, view, api = null, doc = globalThis.document, active = null, barHost = null }) {
    let current = active;
    let release = null;       // what the last drawing of the pane left behind (a dispose function or { destroy }), taken down on the next draw
    const pane = el(doc, 'div', 'story-suite-pane');
    root.replaceChildren(pane);
    // The panel's own names on each tab's button and its More tile: `story-suite-tab` and `data-tab-id` (the tests and the
    // modules use them), and the full label as the title (the bar cuts a long one).
    const bar = createScreenBar(doc, barHost ?? root, {
        label: S.panel.tabs,
        className: 'story-suite-sheet-bar',
        onSelect: id => select(id),
        decorate(node, item) {
            node.classList.add('story-suite-tab');
            node.setAttribute('data-tab-id', item.id);
        },
    });

    function draw() {
        const tabs = registry.tabs();
        if (!tabs.some(tab => tab.id === current)) current = tabs[0]?.id ?? null;
        // An active tab's alert (a red dot) takes the last pinned slot while it has something to show (screen-bar.js pinAlerts).
        bar.update({ items: pinAlerts(tabs.map(tab => ({ id: tab.id, label: tab.title, icon: iconFor(tab.id, tab.icon), alert: tab.alert === true, alertText: tab.alertText ?? '' }))), current: current ?? '' });
        // The pane's widgets go before the pane is drawn again (a redraw of the same tab too): their listeners and observers.
        dispose(pane);
        if (typeof release === 'function') { try { release(); } catch { /* a tab's cleanup failing must not block the redraw */ } }
        release = null;
        pane.replaceChildren();
        const tab = tabs.find(item => item.id === current);
        pane.dataset.tabId = tab?.id ?? '';
        if (!tab) {
            pane.appendChild(el(doc, 'p', 'story-suite-muted', 'No module has a tab yet.'));
            return;
        }
        try {
            const out = tab.render(pane, view(), api);
            if (typeof out === 'function') release = out;
            else if (out && typeof out.destroy === 'function') release = () => out.destroy();
        } catch (error) {
            pane.replaceChildren(el(doc, 'p', 'story-suite-muted', `${tab.title} could not be shown: ${error?.message ?? error}`));
        }
    }
    function select(id) {
        current = id;
        draw();
    }
    draw();
    return {
        refresh: draw,
        select,
        active: () => current,
        bar,
        /** Takes the open tab's widgets down (its pane disposed, and what its render returned). */
        destroy() {
            dispose(pane);
            if (typeof release === 'function') { try { release(); } catch { /* a tab's cleanup failing must not block teardown */ } }
            release = null;
        },
    };
}
