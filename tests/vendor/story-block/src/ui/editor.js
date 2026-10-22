// Settings panel and block editor.
//
// Block names, tags, prompts and imported JSON are typed by the reader or pasted from
// somewhere else, so every node here is built with createElement and filled through
// textContent / value. Nothing user-controlled ever goes through innerHTML.
//
// The panel keeps its own copy of the list and hands the full normalized list to
// onChange after every change, so the runtime only has to store what it is given.

import {
    DEFAULT_COLUMNS,
    DEFAULT_DISPLAY,
    DEFAULT_MAX_DEPTH,
    DIE_SIDES,
    MAX_ROLLS,
    DISPLAYS,
    FIELD_TYPES,
    FORMATS,
    KINDS,
    MAX_FIELDS,
    MAX_LAYOUT_LENGTH,
    MAX_MAX_DEPTH,
    MAX_PROMPT_LENGTH,
    MIN_MAX_DEPTH,
    RESERVED_TAGS,
    WHEN_MODES,
    newBlockId,
    normalizeBlock,
    normalizeBlocks,
    tagFromName,
    validateBlock,
} from '../schema.js';
import { TEMPLATES } from '../templates.js';
import { blockFromExample } from '../example.js';

export const EXPORT_VERSION = 1;
export const EXPORT_FILENAME = 'story-blocks.json';

const KIND_LABELS = { stateful: 'Stateful', turn: 'Per-turn', lead: 'First' };
const KIND_HINTS = {
    stateful: 'Kept: the model rewrites it every reply, carrying forward what did not change.',
    turn: 'This reply only, written after the story (choices, rolls).',
    lead: 'This reply only, written before the story.',
};
const KIND_BADGES = { stateful: 'Stateful', turn: 'Per-turn', lead: 'First' };
const FORMAT_LABELS = { rows: 'Rows', fields: 'Fields', text: 'Free text' };
const DISPLAY_LABELS = { plain: 'Plain text', tree: 'Tree (rows)', fields: 'Fields (meters, numbers, chips)', scene: 'Scene board (World State layout)', choices: 'Choice buttons (numbered list)', dice: 'Dice cards (roll lines)', chatter: 'Whisper thread (Name: line)' };
const FIELD_TYPE_LABELS = { meter: 'Meter', number: 'Number', text: 'Text', list: 'List' };
const WHEN_LABELS = { always: 'Every reply', every: 'Every N replies', keyword: 'When a keyword appears' };

// ---------------------------------------------------------------------------
// DOM helpers

function el(tag, { className, text, title, attrs } = {}, children = []) {
    const node = globalThis.document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    if (title) {
        node.title = title;
        node.setAttribute('aria-label', title);
    }
    for (const [name, value] of Object.entries(attrs ?? {})) node.setAttribute(name, value);
    for (const child of children) if (child) node.append(child);
    return node;
}

function icon(name) {
    return el('i', { className: `fa-solid ${name}`, attrs: { 'aria-hidden': 'true' } });
}

function button(label, className, { iconName, title, onClick } = {}) {
    const node = el('button', { className: `menu_button ${className}`, title });
    node.type = 'button';
    if (iconName) node.append(icon(iconName));
    if (label) node.append(el('span', { text: label }));
    if (onClick) node.addEventListener('click', onClick);
    return node;
}

function iconButton(className, iconName, title, onClick) {
    return button('', `story-block-icon-button ${className}`, { iconName, title, onClick });
}

function textInput(className, value, { placeholder, maxLength } = {}) {
    const node = el('input', { className: `text_pole ${className}` });
    node.type = 'text';
    node.value = value ?? '';
    if (placeholder) node.placeholder = placeholder;
    if (maxLength) node.maxLength = maxLength;
    return node;
}

function numberInput(className, value, min, max) {
    const node = el('input', { className: `text_pole ${className}` });
    node.type = 'number';
    node.min = String(min);
    node.max = String(max);
    node.value = String(value ?? '');
    return node;
}

function select(className, values, labels, value) {
    const node = el('select', { className: `text_pole ${className}` });
    for (const option of values) {
        const item = el('option', { text: labels[option] ?? option });
        item.value = String(option);
        node.append(item);
    }
    node.value = String(value);
    return node;
}

function checkbox(className, label, checked, title) {
    const input = el('input', { className });
    input.type = 'checkbox';
    input.checked = Boolean(checked);
    const wrapper = el('label', { className: 'checkbox_label story-block-check', title }, [input, el('span', { text: label })]);
    return { wrapper, input };
}

function labelled(labelText, control, hintText, className = '') {
    return el('label', { className: `story-block-editor-field ${className}`.trim() }, [
        el('span', { className: 'story-block-editor-label', text: labelText }),
        control,
        hintText ? el('small', { className: 'story-block-editor-hint', text: hintText }) : null,
    ]);
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const unique = list => [...new Set(list)];

// ---------------------------------------------------------------------------
// List helpers

function templateKey(template) {
    return String(template?.template || template?.id || '');
}

function prepareTemplates(templates) {
    return (Array.isArray(templates) ? templates : [])
        .filter(template => template && typeof template === 'object' && templateKey(template))
        .map(template => ({ key: templateKey(template), block: normalizeBlock({ ...template, template: templateKey(template) }) }));
}

/** A tag no block in `blocks` uses (case-insensitive) and that is not reserved. */
function uniqueTag(base, blocks) {
    const used = new Set(blocks.map(block => String(block?.tag ?? '').toLowerCase()));
    const root = (tagFromName(base) || 'Block').slice(0, 32);
    const free = tag => !used.has(tag.toLowerCase()) && !RESERVED_TAGS.includes(tag.toLowerCase());
    if (free(root)) return root;
    for (let n = 2; ; n += 1) {
        const suffix = `_${n}`;
        const tag = `${root.slice(0, 32 - suffix.length)}${suffix}`;
        if (free(tag)) return tag;
    }
}

/** A copy of `block` that can live next to `blocks`: fresh id and tag, same settings. */
function copyOf(block, blocks, name = `${block.name} (copy)`) {
    const copyName = name.slice(0, 40);
    return normalizeBlock({ ...block, name: copyName, id: newBlockId(copyName, blocks), tag: uniqueTag(block.tag, blocks) });
}

function move(list, index, offset) {
    const target = index + offset;
    if (index < 0 || target < 0 || target >= list.length) return list;
    const next = [...list];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
}

// ---------------------------------------------------------------------------
// Import / export

/** Pretty JSON for the whole list: `{ "version": 1, "blocks": [...] }`. */
export function exportBlocks(blocks) {
    return JSON.stringify({ version: EXPORT_VERSION, blocks: normalizeBlocks(blocks) }, null, 4);
}

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const looksLikeBlock = value => value && typeof value === 'object' && !Array.isArray(value)
    && ['name', 'tag', 'id', 'format', 'prompt'].some(key => key in value);

/**
 * Merge definitions from `json` (the export shape, a bare array or one definition, as a
 * string or already parsed) into `existing`. An imported id replaces the block with the
 * same id in place; anything else is appended. A definition that would break the list
 * (tag clash, reserved tag, no fields...) is skipped with one readable error. Never throws.
 */
export function importBlocks(json, existing = []) {
    const errors = [];
    let data = json;
    if (typeof json === 'string') {
        if (!json.trim()) return { blocks: normalizeBlocks(existing), errors: ['Paste some JSON or pick a file first.'], imported: 0 };
        try {
            data = JSON.parse(json);
        } catch (error) {
            return { blocks: normalizeBlocks(existing), errors: [`That is not valid JSON (${error.message}).`], imported: 0 };
        }
    }
    let entries;
    if (Array.isArray(data)) entries = data;
    else if (data && typeof data === 'object' && Array.isArray(data.blocks)) entries = data.blocks;
    else if (looksLikeBlock(data)) entries = [data];
    else return { blocks: normalizeBlocks(existing), errors: ['No block definitions found. Expected { "version": 1, "blocks": [...] }, a list, or one block.'], imported: 0 };

    const result = normalizeBlocks(existing);
    let imported = 0;
    entries.forEach((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            errors.push(`Entry ${index + 1} is not a block definition; skipped.`);
            return;
        }
        // Only an explicit id merges. A definition pasted without one gets a fresh id,
        // so a custom block that happens to be called "Inventory" never silently
        // replaces the reader's Inventory.
        const hasId = ID_PATTERN.test(String(entry.id ?? ''));
        const block = normalizeBlock(hasId ? entry : { ...entry, id: newBlockId(entry.name || 'block', result) });
        const at = result.findIndex(other => other.id === block.id);
        const others = at >= 0 ? result.filter((_, i) => i !== at) : result;
        const problems = validateBlock(block, others);
        if (problems.length) {
            errors.push(`"${block.name}" was not imported: ${problems.join(' ')}`);
            return;
        }
        if (at >= 0) result[at] = block;
        else result.push(block);
        imported += 1;
    });
    if (!entries.length) errors.push('The JSON holds no blocks.');
    return { blocks: normalizeBlocks(result), errors, imported };
}

function downloadJson(text) {
    const URLRef = globalThis.URL;
    if (typeof globalThis.Blob !== 'function' || typeof URLRef?.createObjectURL !== 'function') return false;
    try {
        const url = URLRef.createObjectURL(new globalThis.Blob([text], { type: 'application/json' }));
        const link = el('a');
        link.href = url;
        link.download = EXPORT_FILENAME;
        // Firefox only follows a download link that is in the document.
        globalThis.document.body?.append?.(link);
        link.click();
        link.remove?.();
        // Revoking straight away can cancel the download in some browsers.
        const timer = setTimeout(() => URLRef.revokeObjectURL?.(url), 1000);
        timer?.unref?.();
        return true;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Settings panel

/**
 * Render the whole Story Block settings panel into `container`. Returns
 * `{ root, getBlocks(), setBlocks(blocks) }` so the runtime can push a list it changed
 * elsewhere without rebuilding the drawer (which would collapse it).
 *
 * `dismissedTemplates`: template keys the "New built-in blocks" line no longer offers;
 * `onDismissTemplate(key)` is called when one joins them (Dismiss, or Add), to be stored.
 */
export function renderSettings(container, { blocks = [], templates = TEMPLATES, onChange, estimateTokens, dismissedTemplates = [], onDismissTemplate } = {}) {
    let current = normalizeBlocks(blocks);
    const templateList = prepareTemplates(templates);
    const dismissed = new Set((Array.isArray(dismissedTemplates) ? dismissedTemplates : []).map(String));
    // View state that has to survive a re-render of the list.
    let confirming = null; // { id, action: 'delete' | 'reset' }
    const expanded = new Set(); // rows whose "more" actions are open
    let addOpen = false;
    let editing = false;
    const io = { mode: null, text: '', errors: [], message: '', downloaded: false }; // mode: 'import' | 'export' | 'example' | null

    // Re-rendering into the same container keeps whatever the runtime last wrote
    // into the status line instead of blanking it until the next generation.
    const previousStatus = container.querySelector?.('#story_block_status')?.textContent ?? '';

    const status = el('div', { className: 'story-block-status', text: previousStatus });
    status.id = 'story_block_status';
    const view = el('div', { className: 'story-block-view' });
    const root = el('div', { className: 'story-block-settings' }, [
        el('div', { className: 'inline-drawer' }, [
            el('div', { className: 'inline-drawer-toggle inline-drawer-header' }, [
                el('b', { text: 'Story Block' }),
                el('div', { className: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' }),
            ]),
            el('div', { className: 'inline-drawer-content' }, [status, view]),
        ]),
    ]);
    container.replaceChildren(root);

    const templateFor = block => templateList.find(template => template.key === block.template) ?? null;
    const templatePresent = template => current.some(block => block.template === template.key || block.id === template.block.id);

    function cost(block) {
        if (typeof estimateTokens !== 'function') return null;
        try {
            const value = Number(estimateTokens(block));
            return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
        } catch {
            return null;
        }
    }

    function commit(next, message = '') {
        current = normalizeBlocks(next);
        confirming = null;
        io.downloaded = false;
        io.message = message;
        onChange?.(current);
        renderList();
    }

    function update(id, patch) {
        commit(current.map(block => (block.id === id ? { ...block, ...patch } : block)));
    }

    function resetToDefault(block) {
        const template = templateFor(block);
        if (!template) return;
        const others = current.filter(other => other.id !== block.id);
        const tagFree = !others.some(other => other.tag.toLowerCase() === template.block.tag.toLowerCase());
        // The definition goes back to the built-in, but the reader's on/off switches
        // stay, and the id stays so the block keeps its place and its stored state.
        // A copy keeps its own tag when the built-in tag is taken by another block.
        update(block.id, {
            ...template.block,
            id: block.id,
            enabled: block.enabled,
            visible: block.visible,
            tag: tagFree ? template.block.tag : block.tag,
        });
    }

    function addFromTemplate(template, { enabled = template.block.enabled, message } = {}) {
        const block = templatePresent(template) || current.some(other => other.id === template.block.id)
            ? copyOf({ ...template.block, enabled }, current, `${template.block.name} (copy)`)
            : normalizeBlock({ ...template.block, enabled, tag: uniqueTag(template.block.tag, current) });
        addOpen = false;
        commit([...current, block], message ?? `Added ${block.name}.`);
    }

    // A first install copies every template; afterwards the list is the reader's, so a template
    // a later version adds (NPC Inner Chatter) would never show up. Offered once each, here: Add
    // (switched off, so nothing changes until the reader turns it on) or Dismiss. Either way it
    // is never offered again, even if the reader deletes it later.
    const newTemplates = () => templateList.filter(template => !templatePresent(template) && !dismissed.has(template.key));

    function dismissTemplate(template) {
        dismissed.add(template.key);
        onDismissTemplate?.(template.key);
    }

    function renderNewTemplates() {
        const fresh = newTemplates();
        if (!fresh.length) return null;
        const line = el('div', { className: 'story-suite-notice story-block-new-templates' }, [el('span', { className: 'story-block-new-templates-label', text: 'New built-in blocks:' })]);
        for (const template of fresh) {
            const { name, icon: glyph } = template.block;
            const item = el('span', { className: 'story-block-new-template' });
            item.dataset.template = template.key;
            const add = button('Add', 'story-block-new-template-add', {
                title: `Add ${name} to your blocks, switched off: nothing changes until you turn it on`,
                onClick: () => {
                    dismissTemplate(template);
                    addFromTemplate(template, { enabled: false, message: `Added ${name}, switched off. Turn it on to use it.` });
                },
            });
            const dismiss = button('Dismiss', 'story-block-new-template-dismiss', {
                title: `Don't offer ${name} again (it stays under Add block)`,
                onClick: () => {
                    dismissTemplate(template);
                    renderList();
                },
            });
            item.append(el('span', { text: `${glyph} ${name} — ` }), add, el('span', { text: ' · ' }), dismiss);
            line.append(item);
        }
        return line;
    }

    // `block` null is a blank new block; `{ isNew: true }` opens a filled-in draft (from an
    // example) that is still added, not saved over anything.
    function openEditor(block, { isNew = !block } = {}) {
        editing = true;
        addOpen = false;
        confirming = null;
        io.message = '';
        openBlockEditor(block ?? { name: 'New Block', icon: '📄', format: 'text', kind: 'stateful', template: null }, {
            blocks: current,
            container: view,
            onSave: saved => {
                editing = false;
                commit(isNew ? [...current, saved] : current.map(other => (other.id === block.id ? saved : other)),
                    `${isNew ? 'Added' : 'Saved'} ${saved.name}.`);
            },
            onCancel: () => {
                editing = false;
                renderList();
            },
        });
    }

    function renderRow(block, index) {
        const row = el('div', { className: `story-block-row${block.enabled ? '' : ' story-block-row-disabled'}` });
        row.dataset.blockId = block.id;

        // Two lines: the name, then a quiet line with the tag, what kind of block it is and
        // its cost. On the right only the switch, Edit and a "more" toggle; the rest of the
        // actions fold away under it, so a phone-width drawer is not a wall of buttons.
        const tokens = block.enabled ? cost(block) : null;
        const dot = () => el('span', { className: 'story-block-row-sep', text: '·', attrs: { 'aria-hidden': 'true' } });
        const meta = el('div', { className: 'story-block-row-meta' }, [
            el('code', { className: 'story-block-row-tag', text: `<${block.tag}>`, attrs: { title: `<${block.tag}>` } }),
            dot(),
            el('span', { className: 'story-block-badge story-block-badge-kind', text: KIND_BADGES[block.kind] ?? block.kind }),
            dot(),
            el('span', { className: 'story-block-badge story-block-badge-format', text: FORMAT_LABELS[block.format] ?? block.format }),
            !block.enabled || tokens !== null ? dot() : null,
            el('span', {
                className: 'story-block-row-cost',
                text: !block.enabled ? 'off' : tokens === null ? '' : `~${tokens} tok`,
                title: block.enabled ? 'Estimated prompt tokens for this block' : 'Disabled blocks cost nothing',
            }),
            block.visible ? null : dot(),
            block.visible ? null : el('span', { className: 'story-block-row-notab', text: 'no tab', title: 'Prompted and stored, but not shown in the sidebar or card' }),
        ]);
        const main = el('div', { className: 'story-block-row-main' }, [
            el('span', { className: 'story-block-row-icon', text: block.icon, attrs: { 'aria-hidden': 'true' } }),
            el('div', { className: 'story-block-row-text' }, [
                el('div', { className: 'story-block-row-title' }, [el('span', { className: 'story-block-row-name', text: block.name })]),
                meta,
            ]),
        ]);

        const enabled = checkbox('story-block-enabled', '', block.enabled, block.enabled ? `${block.name} is on: prompted and parsed` : `${block.name} is off`);
        enabled.wrapper.classList.add('story-block-switch');
        enabled.input.setAttribute('role', 'switch');
        enabled.input.setAttribute('aria-label', `${block.name} enabled`);
        enabled.input.addEventListener('change', () => update(block.id, { enabled: enabled.input.checked }));

        const visible = checkbox('story-block-visible', 'Show tab', block.visible, 'Show a tab for this block in the sidebar and card');
        visible.input.addEventListener('change', () => update(block.id, { visible: visible.input.checked }));

        const up = button('Up', 'story-block-move-up', { iconName: 'fa-arrow-up', title: `Move ${block.name} up`, onClick: () => commit(move(current, index, -1)) });
        up.disabled = index === 0;
        const down = button('Down', 'story-block-move-down', { iconName: 'fa-arrow-down', title: `Move ${block.name} down`, onClick: () => commit(move(current, index, 1)) });
        down.disabled = index === current.length - 1;

        const more = el('div', { className: 'story-block-row-more' }, [
            visible.wrapper,
            el('div', { className: 'story-block-row-actions' }, [
                up,
                down,
                button('Duplicate', 'story-block-duplicate', {
                    iconName: 'fa-copy',
                    title: `Duplicate ${block.name}`,
                    onClick: () => {
                        const copy = copyOf(block, current);
                        commit([...current.slice(0, index + 1), copy, ...current.slice(index + 1)], `Added ${copy.name}.`);
                    },
                }),
                templateFor(block) ? button('Reset', 'story-block-reset', {
                    iconName: 'fa-rotate-left',
                    title: `Reset ${block.name} to default`,
                    onClick: () => { confirming = { id: block.id, action: 'reset' }; renderList(); },
                }) : null,
                button('Delete', 'story-block-delete', {
                    iconName: 'fa-trash-can',
                    title: `Delete ${block.name}`,
                    onClick: () => { confirming = { id: block.id, action: 'delete' }; renderList(); },
                }),
            ]),
        ]);
        more.id = `story-block-more-${block.id}`;
        const open = expanded.has(block.id) || confirming?.id === block.id;
        if (!open) more.setAttribute('hidden', '');

        const toggle = iconButton('story-block-more', 'fa-ellipsis', `More for ${block.name}`, () => {
            const show = more.hasAttribute('hidden');
            if (show) {
                more.removeAttribute('hidden');
                expanded.add(block.id);
            } else {
                more.setAttribute('hidden', '');
                expanded.delete(block.id);
            }
            toggle.setAttribute('aria-expanded', String(show));
        });
        toggle.setAttribute('aria-expanded', String(open));
        toggle.setAttribute('aria-controls', more.id);

        const controls = el('div', { className: 'story-block-row-controls' }, [
            enabled.wrapper,
            iconButton('story-block-edit', 'fa-pen-to-square', `Edit ${block.name}`, () => openEditor(block)),
            toggle,
        ]);
        row.append(el('div', { className: 'story-block-row-head' }, [main, controls]), more);

        // Confirmation is inline rather than window.confirm: it works the same in the
        // phone layout and in embedded webviews where native dialogs are blocked.
        if (confirming?.id === block.id) {
            const isDelete = confirming.action === 'delete';
            row.append(el('div', { className: 'story-block-confirm', attrs: { role: 'alert' } }, [
                el('span', {
                    className: 'story-block-confirm-text',
                    text: isDelete
                        ? `Delete ${block.name}? Its blocks already in the chat stay, but are no longer read.`
                        : `Reset ${block.name} to the built-in definition? Your changes to it are lost.`,
                }),
                button(isDelete ? 'Delete' : 'Reset', 'story-block-confirm-yes', {
                    iconName: isDelete ? 'fa-trash-can' : 'fa-rotate-left',
                    onClick: () => {
                        if (isDelete) commit(current.filter(other => other.id !== block.id), `Deleted ${block.name}.`);
                        else resetToDefault(block);
                    },
                }),
                button('Keep', 'story-block-confirm-no', { onClick: () => { confirming = null; renderList(); } }),
            ]));
        }
        return row;
    }

    function renderTotal() {
        const enabledBlocks = current.filter(block => block.enabled);
        const costs = enabledBlocks.map(cost);
        const known = costs.filter(value => value !== null);
        const total = el('div', { className: 'story-block-total' });
        if (typeof estimateTokens !== 'function' || !known.length) {
            total.textContent = `${plural(enabledBlocks.length, 'enabled block')}.`;
            return total;
        }
        const sum = known.reduce((a, b) => a + b, 0);
        total.append(
            el('span', { text: `${plural(enabledBlocks.length, 'enabled block')}, about ` }),
            el('span', { className: 'story-block-total-cost', text: `~${sum} tok` }),
            el('span', { text: ' per reply when all of them are prompted.' }),
        );
        return total;
    }

    function renderAddMenu() {
        const menu = el('div', { className: 'story-block-add-menu' });
        const blank = button('Blank block', 'story-block-add-option', { iconName: 'fa-file', onClick: () => openEditor(null) });
        blank.dataset.template = '';
        const example = button('From an example…', 'story-block-add-option', {
            iconName: 'fa-paste',
            title: 'Paste the block as the model should write it; the form is filled in from it',
            onClick: () => { addOpen = false; io.mode = 'example'; io.text = ''; io.errors = []; io.message = ''; renderList(); },
        });
        example.dataset.template = 'example';
        menu.append(blank, example);
        for (const template of templateList) {
            const present = templatePresent(template);
            const option = button(`${template.block.icon} ${template.block.name}${present ? ' (add a copy)' : ''}`, 'story-block-add-option', {
                title: `${KIND_BADGES[template.block.kind]} · ${FORMAT_LABELS[template.block.format]}`,
                onClick: () => addFromTemplate(template),
            });
            option.dataset.template = template.key;
            menu.append(option);
        }
        return menu;
    }

    function applyImport(text) {
        const result = importBlocks(text, current);
        io.errors = result.errors;
        if (!result.errors.length) io.text = '';
        if (result.imported) commit(result.blocks, `Imported ${plural(result.imported, 'block')}.`);
        else {
            io.message = '';
            renderList();
        }
    }

    function renderIo() {
        const panel = el('div', { className: 'story-block-io' });
        if (io.mode === 'import') {
            const area = el('textarea', { className: 'text_pole story-block-import-text', attrs: { rows: '6', spellcheck: 'false' } });
            area.placeholder = 'Paste exported Story Block JSON here';
            area.value = io.text;
            area.addEventListener('input', () => { io.text = area.value; });
            const file = el('input', { className: 'story-block-import-file', title: 'Import from a JSON file' });
            file.type = 'file';
            file.accept = '.json,application/json';
            file.addEventListener('change', async () => {
                const picked = file.files?.[0];
                if (!picked) return;
                try {
                    const text = await picked.text();
                    io.text = text;
                    applyImport(text);
                } catch {
                    io.errors = ['Could not read that file.'];
                    renderList();
                }
            });
            panel.append(
                el('div', { className: 'story-block-io-title', text: 'Import blocks' }),
                el('small', { className: 'story-block-editor-hint', text: 'Blocks with an id you already have replace that block; the rest are added at the end.' }),
                file,
                area,
                el('div', { className: 'story-block-io-actions' }, [
                    button('Import', 'story-block-import-apply', { iconName: 'fa-file-import', onClick: () => applyImport(io.text) }),
                    button('Close', 'story-block-io-close', { onClick: () => { io.mode = null; io.errors = []; renderList(); } }),
                ]),
            );
        } else if (io.mode === 'example') {
            const area = el('textarea', { className: 'text_pole story-block-example-text', attrs: { rows: '10', spellcheck: 'false' } });
            area.placeholder = '<Stats>\nHP: [0-100]/100 | Gold: [number]\nStatus: [short text]\n\n[Any rule for the model, written as a bracketed paragraph, goes into the instructions.]\n</Stats>';
            area.value = io.text;
            area.addEventListener('input', () => { io.text = area.value; });
            const fill = () => {
                const result = blockFromExample(io.text);
                if (result.error) {
                    io.errors = [result.error];
                    renderList();
                    return;
                }
                io.mode = null;
                io.text = '';
                io.errors = [];
                openEditor(result.block, { isNew: true });
            };
            panel.append(
                el('div', { className: 'story-block-io-title', text: 'New block from an example' }),
                el('small', { className: 'story-block-editor-hint', text: 'Paste the block the way the model should write it, tags included. The tag and name come from <Tag>, the lines inside become the layout the model fills in, and a bracketed paragraph of rules becomes the instructions. You can change everything before saving.' }),
                area,
                el('div', { className: 'story-block-io-actions' }, [
                    button('Fill in the form', 'story-block-example-apply', { iconName: 'fa-wand-magic-sparkles', onClick: fill }),
                    button('Close', 'story-block-io-close', { onClick: () => { io.mode = null; io.text = ''; io.errors = []; renderList(); } }),
                ]),
            );
        } else if (io.mode === 'export') {
            const area = el('textarea', { className: 'text_pole story-block-export-text', attrs: { rows: '8', readonly: 'readonly', spellcheck: 'false' } });
            area.value = io.text;
            area.addEventListener('focus', () => area.select?.());
            panel.append(
                el('div', { className: 'story-block-io-title', text: 'Export blocks' }),
                el('small', { className: 'story-block-editor-hint', text: 'Copy this JSON and keep it, or import it on another install.' }),
                area,
                el('div', { className: 'story-block-io-actions' }, [
                    button('Close', 'story-block-io-close', { onClick: () => { io.mode = null; renderList(); } }),
                ]),
            );
        }
        if (io.errors.length) {
            panel.append(el('ul', { className: 'story-block-io-errors', attrs: { role: 'alert' } },
                io.errors.map(error => el('li', { text: error }))));
        }
        return panel.children.length ? panel : null;
    }

    function exportNow() {
        const json = exportBlocks(current);
        io.errors = [];
        io.downloaded = downloadJson(json);
        if (io.downloaded) {
            io.mode = null;
            io.message = `Downloaded ${EXPORT_FILENAME}.`;
        } else {
            io.mode = 'export';
            io.text = json;
            io.message = '';
        }
        renderList();
    }

    function renderList() {
        editing = false;
        const list = el('div', { className: 'story-block-list' });
        if (!current.length) list.append(el('div', { className: 'story-block-empty', text: 'No blocks yet. Add one below.' }));
        current.forEach((block, index) => list.append(renderRow(block, index)));

        const toolbar = el('div', { className: 'story-block-toolbar' }, [
            button('Add block', 'story-block-add', { iconName: 'fa-plus', onClick: () => { addOpen = !addOpen; renderList(); } }),
            button('Import JSON', 'story-block-import', {
                iconName: 'fa-file-import',
                onClick: () => { if (io.mode === 'example') io.text = ''; io.mode = io.mode === 'import' ? null : 'import'; io.errors = []; io.message = ''; renderList(); },
            }),
            button('Export JSON', 'story-block-export', { iconName: 'fa-file-export', onClick: exportNow }),
        ]);

        // replaceChildren would turn a null into the text "null", so drop the gaps.
        view.replaceChildren(...[
            el('div', { className: 'story-block-section-head' }, [el('span', { text: 'Blocks' })]),
            renderNewTemplates(),
            list,
            renderTotal(),
            toolbar,
            addOpen ? renderAddMenu() : null,
            io.message ? el('div', { className: 'story-block-io-message', text: io.message }) : null,
            // Some phone webviews accept a Blob download and then never show the file,
            // so the text stays one click away.
            io.downloaded ? button('Show JSON to copy', 'story-block-export-show', {
                iconName: 'fa-code',
                onClick: () => { io.downloaded = false; io.mode = 'export'; io.text = exportBlocks(current); io.message = ''; renderList(); },
            }) : null,
            renderIo(),
        ].filter(Boolean));
    }

    renderList();

    return {
        root,
        getBlocks: () => current,
        setBlocks(next) {
            current = normalizeBlocks(next);
            confirming = null;
            // An open editor keeps its draft; the list shows the new blocks once it closes.
            if (!editing) renderList();
        },
    };
}

// ---------------------------------------------------------------------------
// Block editor

/** Problems the schema cannot see, because normalizeBlock quietly drops bad field rows. */
function fieldErrors(fields) {
    const errors = [];
    const seen = new Set();
    fields.forEach((field, index) => {
        const label = String(field.label ?? '').replace(/\s+/g, ' ').trim();
        if (!label) {
            errors.push(`Field ${index + 1} needs a label.`);
            return;
        }
        if (label.includes(':')) errors.push(`Field "${label}": labels cannot contain ":".`);
        const key = label.replace(/:/g, '').toLowerCase();
        if (seen.has(key)) errors.push(`Two fields are both called "${label}".`);
        seen.add(key);
    });
    if (fields.length > MAX_FIELDS) errors.push(`A block can have at most ${MAX_FIELDS} fields.`);
    return errors;
}

/**
 * Inline form for one definition, rendered into `container` in place of whatever was
 * there. Save validates the normalized draft against `blocks` and lists every error
 * without saving; a valid draft goes to onSave(normalizedBlock). Returns the form.
 */
export function openBlockEditor(def, { blocks = [], onSave, onCancel, container } = {}) {
    const list = Array.isArray(blocks) ? blocks : [];
    const base = normalizeBlock(def ?? {});
    const existing = Boolean(def?.id) && list.some(block => block?.id === def.id);
    // A new block without an id gets one from its final name at save time.
    const autoId = !def?.id;
    const originalTag = base.tag;

    // The draft keeps the rows and fields settings whatever the format, so switching
    // format back and forth does not lose them; normalizeBlock drops the unused ones on save.
    const draft = {
        ...base,
        when: { ...base.when, keywords: base.when.keywords.join(', ') },
        columns: [...(base.columns ?? DEFAULT_COLUMNS)],
        maxDepth: base.maxDepth ?? DEFAULT_MAX_DEPTH,
        updates: base.updates ?? 'full',
        fields: (base.fields ?? []).map(field => ({ label: field.label, type: field.type, max: field.max ?? 100, hint: field.hint ?? '' })),
    };
    // Renaming an existing block must not move its tag: the stored state is found by
    // tag, so a silent tag change would empty the block. New blocks follow their name
    // until the tag is edited by hand.
    let tagTouched = existing;
    let displayTouched = draft.display !== DEFAULT_DISPLAY[draft.format];

    const form = el('div', { className: 'story-block-editor', attrs: { role: 'form' } });
    if (!container?.closest?.('.story-block-settings')) form.classList.add('story-block-settings');

    const errorList = el('ul', { className: 'story-block-editor-errors', attrs: { role: 'alert' } });
    errorList.hidden = true;

    // Identity
    const name = textInput('story-block-input-name', draft.name, { maxLength: 40, placeholder: 'Block name' });
    const iconInput = textInput('story-block-input-icon', draft.icon, { maxLength: 8 });
    const tag = textInput('story-block-input-tag', draft.tag, { maxLength: 32 });
    const tagWarning = el('small', { className: 'story-block-editor-hint story-block-tag-warning' });
    tagWarning.hidden = true;
    const syncTagWarning = () => {
        tagWarning.hidden = !existing || draft.tag === originalTag;
        tagWarning.textContent = tagWarning.hidden ? '' : `Earlier replies wrote <${originalTag}>. Under a new tag the block starts empty.`;
    };
    name.addEventListener('input', () => {
        draft.name = name.value;
        if (!tagTouched) {
            draft.tag = tagFromName(name.value);
            tag.value = draft.tag;
        }
    });
    tag.addEventListener('input', () => {
        tagTouched = true;
        draft.tag = tag.value.trim();
        syncTagWarning();
    });
    iconInput.addEventListener('input', () => { draft.icon = iconInput.value; });
    const shortInput = textInput('story-block-input-short', draft.short ?? '', { placeholder: 'from the name' });
    shortInput.maxLength = 12;
    shortInput.addEventListener('input', () => { draft.short = shortInput.value; });

    // Behaviour
    const kind = select('story-block-input-kind', KINDS, KIND_LABELS, draft.kind);
    const kindHint = el('small', { className: 'story-block-editor-hint story-block-kind-hint', text: KIND_HINTS[draft.kind] ?? '' });
    kind.addEventListener('change', () => {
        draft.kind = kind.value;
        kindHint.textContent = KIND_HINTS[draft.kind] ?? '';
    });
    const format = select('story-block-input-format', FORMATS, FORMAT_LABELS, draft.format);
    const display = select('story-block-input-display', DISPLAYS, DISPLAY_LABELS, draft.display);
    format.addEventListener('change', () => {
        draft.format = format.value;
        if (!displayTouched && DEFAULT_DISPLAY[draft.format]) {
            draft.display = DEFAULT_DISPLAY[draft.format];
            display.value = draft.display;
        }
        syncSections();
    });
    display.addEventListener('change', () => {
        displayTouched = true;
        draft.display = display.value;
    });
    const enabled = checkbox('story-block-input-enabled', 'Enabled', draft.enabled, 'Off: not prompted, not parsed, costs nothing');
    enabled.input.addEventListener('change', () => { draft.enabled = enabled.input.checked; });
    const visible = checkbox('story-block-input-visible', 'Show a tab', draft.visible, 'Off: still prompted and stored, but no tab');
    visible.input.addEventListener('change', () => { draft.visible = visible.input.checked; });
    const optional = checkbox('story-block-input-optional', 'Optional', draft.optional, 'Written only when something calls for it (like Dice); a reply without it is not warned about');
    optional.input.addEventListener('change', () => { draft.optional = optional.input.checked; });
    const repeating = checkbox('story-block-input-repeating', 'Repeating', draft.repeating, 'The model may write several tags in one reply (one per roll); they are read as one block');
    repeating.input.addEventListener('change', () => { draft.repeating = repeating.input.checked; });

    // Dice rolled before each reply and handed over through {{rolls}}.
    draft.rolls = { count: draft.rolls?.count ?? 0, sides: draft.rolls?.sides ?? 20 };
    const rollCount = numberInput('story-block-input-roll-count', draft.rolls.count, 0, MAX_ROLLS);
    rollCount.addEventListener('input', () => { draft.rolls.count = rollCount.value; });
    const rollSides = select('story-block-input-roll-sides', DIE_SIDES.map(String), Object.fromEntries(DIE_SIDES.map(sides => [String(sides), `d${sides}`])), String(draft.rolls.sides));
    rollSides.addEventListener('change', () => { draft.rolls.sides = Number(rollSides.value); });
    const rollsSection = el('fieldset', { className: 'story-block-editor-section story-block-editor-rolls' }, [
        el('legend', { text: 'Dice' }),
        el('div', { className: 'story-block-editor-grid' }, [
            labelled('Roll before each reply', rollCount, '0 = no dice. The numbers go wherever the instructions or layout say {{rolls}}.'),
            labelled('Die', rollSides),
        ]),
    ]);

    // Prompt
    const prompt = el('textarea', { className: 'text_pole story-block-input-prompt', attrs: { rows: '5' } });
    prompt.maxLength = MAX_PROMPT_LENGTH;
    prompt.value = draft.prompt;
    prompt.addEventListener('input', () => { draft.prompt = prompt.value; });

    // Layout (free-text blocks): the skeleton the model fills in.
    const layout = el('textarea', { className: 'text_pole story-block-input-layout', attrs: { rows: '8', spellcheck: 'false' } });
    layout.maxLength = MAX_LAYOUT_LENGTH;
    layout.value = draft.layout ?? '';
    layout.addEventListener('input', () => { draft.layout = layout.value; });
    const layoutSection = labelled('Layout', layout, 'Optional. The model copies this skeleton and fills each [placeholder]. {{user}} and {{char}} are filled in. Leave empty for free-form text.', 'story-block-editor-layout');

    // When
    const whenMode = select('story-block-input-when', WHEN_MODES, WHEN_LABELS, draft.when.mode);
    const every = numberInput('story-block-input-every', draft.when.every, 2, 100);
    every.addEventListener('input', () => { draft.when.every = every.value; });
    const keywords = textInput('story-block-input-keywords', draft.when.keywords, { placeholder: 'shop, market, trade' });
    keywords.addEventListener('input', () => { draft.when.keywords = keywords.value; });
    const scanDepth = numberInput('story-block-input-scan-depth', draft.when.scanDepth, 1, 20);
    scanDepth.addEventListener('input', () => { draft.when.scanDepth = scanDepth.value; });
    const everyGroup = el('div', { className: 'story-block-editor-group story-block-when-every' }, [
        labelled('Every N replies', every, 'Prompted on every Nth assistant reply (2 to 100).'),
    ]);
    const keywordGroup = el('div', { className: 'story-block-editor-group story-block-when-keyword' }, [
        labelled('Keywords', keywords, 'Comma separated. Whole words, any case.'),
        labelled('Scan depth', scanDepth, 'How many recent messages to search (1 to 20).'),
    ]);
    whenMode.addEventListener('change', () => {
        draft.when.mode = whenMode.value;
        syncSections();
    });

    // Rows
    const columnInputs = draft.columns.map((value, index) => {
        const input = textInput('story-block-input-column', value, { maxLength: 24, placeholder: DEFAULT_COLUMNS[index] });
        input.addEventListener('input', () => { draft.columns[index] = input.value; });
        return input;
    });
    const depthValues = Array.from({ length: MAX_MAX_DEPTH - MIN_MAX_DEPTH + 1 }, (_, i) => MIN_MAX_DEPTH + i);
    const maxDepth = select('story-block-input-max-depth', depthValues, { 1: '1 (no nesting)' }, draft.maxDepth);
    maxDepth.addEventListener('change', () => { draft.maxDepth = Number(maxDepth.value); });
    // (0.9.16) How the model updates a stateful list: the whole block, or only what changed.
    const updates = select('story-block-input-updates', ['changes', 'full'], { changes: 'Only the changes', full: 'The whole list' }, draft.updates);
    updates.addEventListener('change', () => { draft.updates = updates.value; });
    const rowsSection = el('fieldset', { className: 'story-block-editor-section story-block-editor-rows' }, [
        el('legend', { text: 'Rows' }),
        el('div', { className: 'story-block-editor-columns' },
            columnInputs.map((input, index) => labelled(`Column ${index + 1}`, input))),
        labelled('Category depth', maxDepth, 'Levels of [A > B > C] category paths the model may use.'),
        labelled('The model writes', updates, 'Only the changes: + gained, - lost, ~ now reads; every other row stays exactly as it was. Stateful lists only.'),
    ]);

    // Fields
    const fieldList = el('div', { className: 'story-block-field-list' });
    const fieldCount = el('small', { className: 'story-block-editor-hint story-block-field-count' });
    const addField = button('Add field', 'story-block-field-add', {
        iconName: 'fa-plus',
        onClick: () => {
            if (draft.fields.length >= MAX_FIELDS) return;
            draft.fields.push({ label: '', type: 'text', max: 100, hint: '' });
            renderFields();
        },
    });
    function renderFields() {
        fieldList.replaceChildren();
        draft.fields.forEach((field, index) => {
            const label = textInput('story-block-field-label', field.label, { maxLength: 40, placeholder: 'Label' });
            label.addEventListener('input', () => { field.label = label.value; });
            const type = select('story-block-field-type', FIELD_TYPES, FIELD_TYPE_LABELS, field.type);
            const max = numberInput('story-block-field-max', field.max, 1, 1_000_000);
            max.title = 'Meter maximum';
            max.hidden = field.type !== 'meter';
            max.addEventListener('input', () => { field.max = max.value; });
            type.addEventListener('change', () => {
                field.type = type.value;
                max.hidden = field.type !== 'meter';
            });
            const hint = textInput('story-block-field-hint', field.hint, { maxLength: 80, placeholder: 'Hint for the model (optional)' });
            hint.addEventListener('input', () => { field.hint = hint.value; });
            const reorder = offset => () => {
                draft.fields = move(draft.fields, index, offset);
                renderFields();
            };
            const up = iconButton('story-block-field-up', 'fa-arrow-up', 'Move field up', reorder(-1));
            up.disabled = index === 0;
            const down = iconButton('story-block-field-down', 'fa-arrow-down', 'Move field down', reorder(1));
            down.disabled = index === draft.fields.length - 1;
            const remove = iconButton('story-block-field-remove', 'fa-xmark', 'Remove field', () => {
                draft.fields.splice(index, 1);
                renderFields();
            });
            fieldList.append(el('div', { className: 'story-block-field-row' }, [
                label, type, max, hint, el('div', { className: 'story-block-field-actions' }, [up, down, remove]),
            ]));
        });
        if (!draft.fields.length) fieldList.append(el('div', { className: 'story-block-empty', text: 'No fields yet.' }));
        addField.disabled = draft.fields.length >= MAX_FIELDS;
        fieldCount.textContent = `${draft.fields.length} / ${MAX_FIELDS} fields`;
    }
    const fieldsSection = el('fieldset', { className: 'story-block-editor-section story-block-editor-fields' }, [
        el('legend', { text: 'Fields' }),
        fieldList,
        el('div', { className: 'story-block-field-footer' }, [addField, fieldCount]),
    ]);

    function syncSections() {
        rowsSection.hidden = draft.format !== 'rows';
        layoutSection.hidden = draft.format !== 'text';
        fieldsSection.hidden = draft.format !== 'fields';
        everyGroup.hidden = draft.when.mode !== 'every';
        keywordGroup.hidden = draft.when.mode !== 'keyword';
    }

    function showErrors(errors) {
        errorList.replaceChildren(...errors.map(error => el('li', { text: error })));
        errorList.hidden = !errors.length;
    }

    function save() {
        const input = {
            ...draft,
            id: autoId ? newBlockId(draft.name, list) : draft.id,
            when: { ...draft.when },
            fields: draft.fields.map(field => ({ ...field })),
            rolls: { ...draft.rolls },
        };
        const normalized = normalizeBlock(input);
        // normalizeBlock repairs a blank name or a malformed tag on its own, which would
        // hide the mistake; validate with what the reader actually typed for those two.
        const errors = unique([
            ...validateBlock({ ...normalized, name: draft.name, tag: draft.tag }, list),
            ...(draft.format === 'fields' ? fieldErrors(draft.fields) : []),
        ]);
        showErrors(errors);
        if (errors.length) return null;
        onSave?.(normalized);
        return normalized;
    }

    const idNote = existing || def?.id
        ? `id: ${base.id}${base.template ? ` · from the ${base.template} template` : ''}`
        : 'New block';

    // A folding section of the form; `open` for the ones a new block needs first.
    const fold = (className, title, summaryHint, children, open = false) => {
        const details = el('details', { className: `story-block-editor-fold ${className}` }, [
            el('summary', { className: 'story-block-editor-fold-summary' }, [
                el('b', { text: title }),
                summaryHint ? el('small', { className: 'story-block-editor-hint', text: summaryHint }) : null,
            ]),
            el('div', { className: 'story-block-editor-fold-body' }, children),
        ]);
        if (open) details.open = true;
        return details;
    };

    form.append(
        el('div', { className: 'story-block-editor-header' }, [
            el('b', { className: 'story-block-editor-title', text: existing ? `Edit ${base.name}` : 'New block' }),
            el('small', { className: 'story-block-editor-hint story-block-editor-id', text: idNote }),
        ]),
        errorList,
        el('div', { className: 'story-block-editor-grid story-block-editor-basics' }, [
            labelled('Name', name, null, 'story-block-editor-name'),
            el('label', { className: 'story-block-editor-field story-block-editor-tag' }, [
                el('span', { className: 'story-block-editor-label', text: 'Tag' }),
                tag,
                el('small', { className: 'story-block-editor-hint', text: 'Written as <Tag>…</Tag>.' }),
                tagWarning,
            ]),
            labelled('Icon', iconInput, null, 'story-block-editor-icon'),
            labelled('Tab label', shortInput, null, 'story-block-editor-short'),
        ]),
        el('div', { className: 'story-block-editor-checks' }, [enabled.wrapper, visible.wrapper]),
        fold('is-writes', 'What the model writes', 'Instructions and the shape of the block', [
            labelled('Instructions', prompt, 'What the block tracks and how. {{user}} and {{char}} are filled in; {{rolls}} becomes this reply\'s dice.', 'story-block-editor-prompt'),
            labelled('Format', format, null, 'story-block-editor-format'),
            layoutSection,
            rowsSection,
            fieldsSection,
        ], true),
        fold('is-look', 'How it is shown', 'Display', [
            labelled('Display', display, null, 'story-block-editor-display'),
        ]),
        fold('is-when', 'When and how often', 'Kind, timing, dice', [
            el('div', { className: 'story-block-editor-field story-block-editor-kind' }, [
                el('span', { className: 'story-block-editor-label', text: 'Kind' }),
                kind,
                kindHint,
            ]),
            el('fieldset', { className: 'story-block-editor-section story-block-editor-when' }, [
                el('legend', { text: 'When' }),
                labelled('Prompt this block', whenMode),
                everyGroup,
                keywordGroup,
            ]),
            el('div', { className: 'story-block-editor-checks' }, [optional.wrapper, repeating.wrapper]),
            rollsSection,
        ]),
        el('div', { className: 'story-block-editor-actions' }, [
            button('Save', 'story-block-editor-save', { iconName: 'fa-floppy-disk', onClick: save }),
            button('Cancel', 'story-block-editor-cancel', { iconName: 'fa-xmark', onClick: () => onCancel?.() }),
        ]),
    );

    renderFields();
    syncSections();
    syncTagWarning();
    container?.replaceChildren(form);
    return form;
}
