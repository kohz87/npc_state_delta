// The block editor's form state and controls (extracted from screens/blocks-editor.js; blocks-editor.js
// re-exports renderBlockEditor): the draft's fields, starters, effects, save and error placement. The drawing of
// the layout/preview and the form's sections live in layout.js and draw.js.

import { textField, numberField, selectField } from '../../view/form/fields.js';
import { h } from '../../view/widgets/dom.js';
import { buildBlock, partKey } from '../../data-modules/block-builder.js';
import { BLOCK_STARTERS } from '../../data-modules/block-starters.js';
import { cardRoles, layoutShape } from '../../data-modules/block-layout.js';
import { DM_LIMITS } from '../../data-modules/schema.js';
import { slugify } from '../../packs/validate.js';
import { STRINGS, fill } from '../../strings.js';
import { S, PART_TYPES, PART_NAMES, LAYOUT_NAMES } from './constants.js';
import { createLayoutPart } from './layout.js';
import { createDrawPart } from './draw.js';

// `starters`: New block offers the starters. `tabs`: [{ id, title }], the tabs this chat already has (Show in tab). `renderPreview(parent, { definition, values,
// layout })`: how the host draws a block in the new layouts (the preview calls it; without it a plain sketch is drawn).
export function renderBlockEditor(root, { draft, used = [], directorOn = true, onSave, onCancel, starters = false, tabs = [], renderPreview = null, meta = {} }) {
    const doc = root.ownerDocument ?? globalThis.document;
    const state = { controls: [], spots: new Map(), updateCount: () => {}, renamed: new Map() };
    let busy = false, alive = true;
    // What the form says beside the layout (where the layout came from, a fall-back line, the starter's fill) lives in `meta`, which the page keeps while the form is redrawn.
    meta.layoutBy ??= draft.layout ? 'stored' : 'shape'; meta.layoutNote ??= ''; meta.starterNote ??= ''; meta.pickedStarter ??= starters ? 'empty' : '';
    meta.layoutAtOpen ??= draft.layout ?? '';
    meta.rolesAuthor ??= false; meta.rolesGuessed ??= false; meta.starterName ??= '';
    const node = (tag, cls = '', text = '', parent = null) => { const out = h(doc, tag, cls, text); parent?.appendChild(out); return out; };
    const button = (parent, label, action, cls = 'ss-button') => {
        const out = node('button', cls, label, parent); out.setAttribute('type', 'button'); out.addEventListener('click', action); return out;
    };
    function control(parent, label, value, field, assign, path, extra = {}) {
        const row = node('label', 'ss-block-control', '', parent);
        node('span', 'ss-block-control-label', label, row);
        const error = node('small', 'ss-block-control-error', '', row); error.setAttribute('role', 'alert');
        const ctx = { doc, field: field.type === 'text' ? { ...field, codepoints: true } : field, value, ariaLabel: label,
            onChange: assign, invalid: message => { error.textContent = message; }, note() {}, ...extra };
        const handle = field.type === 'choice' ? selectField(ctx) : field.type === 'int' ? numberField(ctx) : textField(ctx);
        handle.input.addEventListener('input', () => state.updateCount());
        handle.input.addEventListener('change', () => state.updateCount());
        row.insertBefore(handle.el, error);
        state.controls.push({ handle, assign });
        if (path) state.spots.set(path, error);
        return handle;
    }
    const collect = () => { for (const entry of state.controls) entry.assign(entry.handle.get()); };
    const refresh = () => { collect(); draw(); };
    function fieldOptions(numbersOnly = false) {
        return draft.fields.filter(field => !numbersOnly || field.type === 'number')
            .map(field => ({ value: field.key, label: field.name || field.key }));
    }
    function newEffect(type) {
        return { field: fieldOptions(type === 'timer')[0]?.value ?? '', op: type === 'timer' ? 'add' : 'set', value: '' };
    }
    function renameField(field, name) {
        const old = field.key, next = slugify(name).slice(0, 32).replace(/-+$/, '');
        field.name = name;
        if (next === old) return;
        field.key = next;
        if (draft.roles && draft.roles.field === old) draft.roles.field = next;
        for (const fn of draft.functions) {
            if (fn.when?.field === old) fn.when.field = next;
            for (const effect of fn.effects ?? []) if (effect.field === old) effect.field = next;
        }
    }
    // A part of an entry is keyed by one lowercase word of its name; the card roles that name it follow the rename.
    function renamePart(field, part, name) {
        const old = part.key, next = partKey(name);
        part.name = name;
        if (!next || next === old) return;
        part.key = next;
        if (draft.roles?.field === field.key) for (const role of ['title', 'status', 'step']) if (draft.roles[role] === old) draft.roles[role] = next;
    }
    // Changing a field's type to or from a List of entries brings or takes its parts and its most entries.
    function setType(field, type) {
        if (type === 'entries' && field.type !== 'entries') {
            field.of = [{ key: 'title', name: 'Title', type: 'text', max: 60, default: '' }];
            field.max = 30; delete field.default; delete field.min; delete field.values; delete field.names;
        } else if (type !== 'entries' && field.type === 'entries') {
            delete field.of; field.max = type === 'number' ? 10 : 120; field.default = type === 'number' ? 0 : '';
        }
        field.type = type;
    }
    // How the block will be drawn, worked out from the form as it is now (nothing is stored here): the layout (the author's while it still fits the fields, else
    // the shape's suggestion), the card roles for a list of cards, and whether the roles were guessed.
    function resolve() {
        const shape = layoutShape(draft);
        const stored = draft.layout && shape.fits[draft.layout]?.ok ? draft.layout : null;
        const effective = stored ?? shape.suggested;
        const info = effective === 'cards' ? cardRoles(draft) : { roles: null, guessed: false };
        return { shape, effective, ...info, fell: draft.layout && !stored && shape.suggested ? shape.suggested : null };
    }
    const confirmReplace = () => { const win = doc.defaultView ?? globalThis; return typeof win.confirm === 'function' ? win.confirm(S.replaceFields) : true; };
    function applyStarter(item) {
        collect();
        if (draft.fields.length && !confirmReplace()) return;
        const next = item.id === 'empty' ? { fields: [], functions: [], prompt: '', show: { tab: true, card: false, tabName: '', icon: 'ph-bookmark-simple' } } : item.draft();
        if (!draft.name || BLOCK_STARTERS.some(each => each.draft().name === draft.name)) draft.name = next.name ?? '';
        // (every field has a key from its name, as the form's own Add field gives it)
        for (const field of next.fields) field.key ??= slugify(field.name).slice(0, 32).replace(/-+$/, '');
        for (const key of ['fields', 'functions', 'prompt', 'show']) draft[key] = next[key];
        for (const key of ['layout', 'roles', 'tones']) { if (next[key]) draft[key] = next[key]; else delete draft[key]; }
        meta.pickedStarter = item.id; meta.starterName = item.name; meta.rolesAuthor = false;
        meta.layoutBy = item.id === 'empty' ? 'shape' : 'starter'; meta.layoutNote = '';
        meta.starterNote = item.id === 'empty' ? '' : fill(S.starterFilled, { fields: `${next.fields.length} ${next.fields.length === 1 ? 'field' : 'fields'}`,
            layout: LAYOUT_NAMES[next.layout] ?? '', roles: next.roles ? S.starterRoles : '' });
        draw();
    }
    // The parts of one entry in a List of entries: a small form of its own for each (name, kind, its limits), at most eight.
    function paintParts(row, field, index) {
        control(row, S.entriesMaxLabel, field.max ?? 30, { type: 'int', min: 1, max: DM_LIMITS.entriesMax }, value => { if (field.type === 'entries') field.max = value; }, `field:${index}:max`);
        const parts = node('div', 'ss-block-parts', '', row);
        node('h5', 'ss-block-parts-title', S.partsOf, parts);
        for (const [at, part] of field.of.entries()) {
            const spot = `field:${index}:part:${at}`;
            const card = node('div', 'ss-block-part', '', parts);
            const name = control(card, S.partName, part.name, { type: 'text', max: 60 }, value => renamePart(field, part, value), spot);
            name.input.addEventListener('change', refresh);
            const type = control(card, S.fieldTypeLabel, part.type, { type: 'choice', options: PART_TYPES }, value => { part.type = value; }, `${spot}:type`);
            type.input.addEventListener('change', refresh);
            if (part.type === 'number') {
                control(card, S.min, part.min ?? 0, { type: 'int', min: -DM_LIMITS.integer, max: DM_LIMITS.integer }, value => { part.min = value; }, `${spot}:min`);
                control(card, S.max, part.max ?? 10, { type: 'int', min: -DM_LIMITS.integer, max: DM_LIMITS.integer }, value => { part.max = value; }, `${spot}:max`);
                control(card, S.defaultValue, part.default ?? 0, { type: 'int', min: -DM_LIMITS.integer, max: DM_LIMITS.integer }, value => { part.default = value; }, `${spot}:default`);
            } else if (part.type === 'choice') {
                control(card, S.choices, Array.isArray(part.values) ? part.values.join(', ') : part.values ?? '', { type: 'text', max: 500 }, value => { part.values = String(value).split(',').map(each => each.trim()); }, `${spot}:values`);
                control(card, S.defaultValue, part.default ?? '', { type: 'text', max: 240 }, value => { part.default = value; }, `${spot}:default`);
            } else {
                control(card, S.max, part.max ?? 120, { type: 'int', min: 1, max: 240 }, value => { part.max = value; }, `${spot}:max`);
                control(card, S.defaultValue, part.default ?? '', { type: 'text', max: 240 }, value => { part.default = value; }, `${spot}:default`);
            }
            const gone = button(card, S.remove, () => { collect(); field.of.splice(at, 1); draw(); });
            gone.disabled = field.of.length <= 1;
        }
        const add = button(parts, S.addPart, () => {
            collect();
            const taken = new Set(field.of.map(part => part.key));
            const name = PART_NAMES.find(each => !taken.has(partKey(each))) ?? `Part ${String.fromCharCode(97 + field.of.length)}`;
            field.of.push({ key: partKey(name), name, type: 'text', max: 120, default: '' });
            draw();
        });
        add.disabled = field.of.length >= DM_LIMITS.entrySubs;
    }
    function paintEffects(parent, fn, functionIndex) {
        const timer = fn.type === 'timer';
        if (timer && !fieldOptions(true).length) node('p', 'ss-block-hint', S.timerNumber, parent);
        for (const [index, effect] of fn.effects.entries()) {
            const row = node('div', 'ss-block-effect', '', parent);
            control(row, S.effectField, effect.field, { type: 'choice', options: fieldOptions(timer) }, value => { effect.field = value; }, `function:${functionIndex}:effect:${index}:field`);
            control(row, S.effectAction, effect.op, { type: 'choice', options: timer ? [{ value: 'add', label: S.add }]
                : [{ value: 'set', label: S.setTo }, { value: 'add', label: S.add }] }, value => { effect.op = value; }, `function:${functionIndex}:effect:${index}:op`);
            control(row, S.effectValue, effect.value, { type: 'text', max: 240 }, value => { effect.value = value; }, `function:${functionIndex}:effect:${index}:value`);
            button(row, S.remove, () => { collect(); fn.effects.splice(index, 1); draw(); });
        }
        button(parent, S.addStep, () => { collect(); fn.effects.push(newEffect(fn.type)); draw(); });
    }
    async function submit() {
        if (busy || !alive) return;
        collect();
        for (const spot of state.spots.values()) spot.textContent = '';
        // The layout the form shows is the one saved, except where saving it would only write down what the block already is: the default (plain rows, no key),
        // and an old block with no layout the author has not touched (it keeps its bytes, and is drawn as before).
        const live = resolve();
        const keepsBytes = !meta.layoutAtOpen && draft.slug && meta.layoutBy === 'shape' && !draft.fields.some(field => field.type === 'entries');
        const save = !live.effective ? null : live.effective === meta.layoutAtOpen ? live.effective : live.effective === 'fields' || keepsBytes ? null : live.effective;
        if (save) draft.layout = save; else delete draft.layout;
        if (live.roles) draft.roles = live.roles; else delete draft.roles;
        const result = buildBlock(draft, { used });
        if (!result.ok) {
            const error = result.errors[0], location = error.path ?? '';
            const match = /(?:fields\.(\d+)|state\.([a-z0-9-]+)|functions\.(\d+)|\.show|\.prompt)/.exec(location);
            const kind = /\.kinds\.(?:set|add|drop|change)-([a-z0-9-]+)/.exec(location);
            const partAt = /(?:fields\.(\d+)\.of\.(\d+)|state\.([a-z0-9-]+)\.of\.([a-z]+))/.exec(location);
            const buttonKind = /\.kinds\.button-([a-z0-9-]+)/.exec(location);
            const rule = /\.rules\[(\d+)\]/.exec(location), timer = /\.timers\[(\d+)\]/.exec(location);
            const card = /\.cards\[(\d+)\]/.exec(location), replyEnd = /\.replyEnd\[(\d+)\]/.exec(location);
            const functionIndex = (type, index) => {
                const selected = draft.functions.filter(fn => fn.type === type)[Number(index)];
                return draft.functions.indexOf(selected);
            };
            const partIndex = partAt ? (partAt[1] !== undefined ? [partAt[1], partAt[2]] : (() => {
                const at = draft.fields.findIndex(field => field.key === partAt[3]);
                return [String(at), String(draft.fields[at]?.of?.findIndex(part => part.key === partAt[4]) ?? -1)];
            })()) : null;
            const path = partIndex && partIndex[0] !== '-1' && partIndex[1] !== '-1' ? `field:${partIndex[0]}:part:${partIndex[1]}`
                : /\.(?:layout|roles|tones)(?:\.|\[|$)/.test(location) ? 'layout'
                : match?.[1] !== undefined ? `field:${match[1]}` : match?.[2] ? `field:${draft.fields.findIndex(field => field.key === match[2])}`
                : match?.[3] !== undefined ? `function:${match[3]}` : kind ? `field:${draft.fields.findIndex(field => field.key === kind[1])}`
                    : buttonKind ? `function:${draft.functions.findIndex((fn, index) => fn.type === 'button'
                        && slugify(fn.name || `button-${index + 1}`).slice(0, 32).replace(/-+$/, '') === buttonKind[1])}`
                        : rule ? `function:${functionIndex('rule', rule[1])}` : timer ? `function:${functionIndex('timer', timer[1])}`
                        : card ? `function:${functionIndex('card', card[1])}` : replyEnd ? `function:${functionIndex('reply-end', replyEnd[1])}`
                        : /\.show/.test(location) ? 'show' : /prompt/.test(location) ? 'prompt' : location === 'name' ? 'name' : 'form';
            const part = /\.(min|max|default|values|names|type|every|when|button|tone|title|text|effects)(?:\.|\[|$)/.exec(location)?.[1];
            const effect = /\.(?:effects|then)(?:\.(\d+)|\[(\d+)\])(?:\.(field|op|value))?/.exec(location);
            const effectSpot = effect ? state.spots.get(`${path}:effect:${effect[1] ?? effect[2]}:${effect[3] ?? 'value'}`) : null;
            (effectSpot ?? state.spots.get(`${path}:${part}`) ?? state.spots.get(path) ?? state.spots.get('form')).textContent = error.message;
            return;
        }
        busy = true;
        let answer;
        try { answer = await onSave(result.definition); } catch (error) { answer = { ok: false, message: String(error?.message ?? error) }; }
        busy = false;
        if (alive && !answer?.ok) state.spots.get('form').textContent = answer?.message ?? STRINGS.editable.failed;
    }
    function draw() { drawer.draw(); }
    const layout = createLayoutPart({
        node, button, control, collect, refresh, draw, setSpot: (key, value) => state.spots.set(key, value),
        draft, meta, renderPreview, tabs, used, resolve,
    });
    const drawer = createDrawPart({
        doc, node, button, control, collect, refresh, draft, meta, root, state, resolve, onCancel, submit,
        used, fieldOptions, newEffect, renameField, renamePart, setType, paintParts, paintEffects, paintLayout: layout.paintLayout, paintPreview: layout.paintPreview,
        starters, directorOn, tabs, applyStarter, draw,
    });
    draw();
    return { collect, destroy() { alive = false; for (const entry of state.controls) entry.handle.destroy(); state.controls = []; } };
}
