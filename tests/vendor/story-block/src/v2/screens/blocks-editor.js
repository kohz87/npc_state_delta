// The in-chat block form uses the same controls as Settings; it writes no story state until Save.
import { textField, numberField, selectField } from '../view/form/fields.js';
import { h, iconNode } from '../view/widgets/dom.js';
import { hasIcon } from '../view/icons/index.js';
import { blockKindCount, buildBlock } from '../data-modules/block-builder.js';
import { fullModuleGrammar } from '../data-modules/grammar.js';
import { DM_LIMITS } from '../data-modules/schema.js';
import { slugify } from '../packs/validate.js';
import { STRINGS, fill } from '../strings.js';

const S = STRINGS.blocks;
const TYPES = [{ value: 'text', label: S.text }, { value: 'number', label: S.number }, { value: 'choice', label: S.choice }, { value: 'list', label: S.list }];
const COMPARISONS = [{ value: 'eq', label: S.is }, { value: 'ne', label: S.isNot }, { value: 'lt', label: S.below },
    { value: 'gt', label: S.above }, { value: 'le', label: S.atMost }, { value: 'ge', label: S.atLeast }];
const ICONS = ['ph-bookmark-simple', 'ph-scroll', 'ph-heart', 'ph-lightning', 'ph-star', 'ph-sparkle', 'ph-sword', 'ph-skull'].filter(hasIcon);

export function renderBlockEditor(root, { draft, used = [], directorOn = true, onSave, onCancel }) {
    const doc = root.ownerDocument ?? globalThis.document;
    let controls = [], spots = new Map(), busy = false, alive = true, updateCount = () => {};
    const node = (tag, cls = '', text = '', parent = null) => { const out = h(doc, tag, cls, text); parent?.appendChild(out); return out; };
    const button = (parent, label, action, cls = 'ss-button') => {
        const out = node('button', cls, label, parent); out.setAttribute('type', 'button'); out.addEventListener('click', action); return out;
    };
    function control(parent, label, value, field, assign, path) {
        const row = node('label', 'ss-block-control', '', parent);
        node('span', 'ss-block-control-label', label, row);
        const error = node('small', 'ss-block-control-error', '', row); error.setAttribute('role', 'alert');
        const ctx = { doc, field: field.type === 'text' ? { ...field, codepoints: true } : field, value, ariaLabel: label,
            onChange: assign, invalid: message => { error.textContent = message; }, note() {} };
        const handle = field.type === 'choice' ? selectField(ctx) : field.type === 'int' ? numberField(ctx) : textField(ctx);
        handle.input.addEventListener('input', () => updateCount());
        handle.input.addEventListener('change', () => updateCount());
        row.insertBefore(handle.el, error);
        controls.push({ handle, assign });
        if (path) spots.set(path, error);
        return handle;
    }
    const collect = () => { for (const entry of controls) entry.assign(entry.handle.get()); };
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
        for (const fn of draft.functions) {
            if (fn.when?.field === old) fn.when.field = next;
            for (const effect of fn.effects ?? []) if (effect.field === old) effect.field = next;
        }
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
        for (const spot of spots.values()) spot.textContent = '';
        const result = buildBlock(draft, { used });
        if (!result.ok) {
            const error = result.errors[0], location = error.path ?? '';
            const match = /(?:fields\.(\d+)|state\.([a-z0-9-]+)|functions\.(\d+)|\.show|\.prompt)/.exec(location);
            const kind = /\.kinds\.(?:set|change)-([a-z0-9-]+)/.exec(location);
            const buttonKind = /\.kinds\.button-([a-z0-9-]+)/.exec(location);
            const rule = /\.rules\[(\d+)\]/.exec(location), timer = /\.timers\[(\d+)\]/.exec(location);
            const functionIndex = (type, index) => {
                const selected = draft.functions.filter(fn => fn.type === type)[Number(index)];
                return draft.functions.indexOf(selected);
            };
            const path = match?.[1] !== undefined ? `field:${match[1]}` : match?.[2] ? `field:${draft.fields.findIndex(field => field.key === match[2])}`
                : match?.[3] !== undefined ? `function:${match[3]}` : kind ? `field:${draft.fields.findIndex(field => field.key === kind[1])}`
                    : buttonKind ? `function:${draft.functions.findIndex((fn, index) => fn.type === 'button'
                        && slugify(fn.name || `button-${index + 1}`).slice(0, 32).replace(/-+$/, '') === buttonKind[1])}`
                        : rule ? `function:${functionIndex('rule', rule[1])}` : timer ? `function:${functionIndex('timer', timer[1])}`
                        : /\.show/.test(location) ? 'show' : /prompt/.test(location) ? 'prompt' : location === 'name' ? 'name' : 'form';
            const part = /\.(min|max|default|values|type|every|when|effects)(?:\.|\[|$)/.exec(location)?.[1];
            const effect = /\.(?:effects|then)(?:\.(\d+)|\[(\d+)\])(?:\.(field|op|value))?/.exec(location);
            const effectSpot = effect ? spots.get(`${path}:effect:${effect[1] ?? effect[2]}:${effect[3] ?? 'value'}`) : null;
            (effectSpot ?? spots.get(`${path}:${part}`) ?? spots.get(path) ?? spots.get('form')).textContent = error.message;
            return;
        }
        busy = true;
        let answer;
        try { answer = await onSave(result.definition); } catch (error) { answer = { ok: false, message: String(error?.message ?? error) }; }
        busy = false;
        if (alive && !answer?.ok) spots.get('form').textContent = answer?.message ?? STRINGS.editable.failed;
    }
    function draw() {
        updateCount = () => {};
        for (const entry of controls) entry.handle.destroy();
        controls = []; spots = new Map();
        root.replaceChildren();
        const form = node('section', 'ss-block-editor ss-glass', '', root);
        node('h3', 'ss-section-label', S.editBlock, form);
        control(form, S.name, draft.name, { type: 'text', max: 60 }, value => { draft.name = value; }, 'name');
        const show = node('section', 'ss-block-show', '', form);
        node('h4', 'ss-section-label', S.showAs, show);
        const group = node('div', 'ss-block-chips', '', show);
        for (const [label, tab, card] of [[S.ownTab, true, false], [S.card, false, true], [S.both, true, true]]) {
            const selected = draft.show.tab === tab && draft.show.card === card;
            const item = button(group, label, () => { collect(); draft.show.tab = tab; draft.show.card = card; draw(); }, `ss-button ss-chip${selected ? ' ss-chip-on' : ''}`);
            item.setAttribute('aria-pressed', String(draft.show.tab === tab && draft.show.card === card));
        }
        control(show, S.tabName, draft.show.tabName, { type: 'text', max: 24 }, value => { draft.show.tabName = value; }, 'show');
        const icons = node('div', 'ss-block-icons', '', show); icons.setAttribute('aria-label', S.icon);
        for (const icon of ICONS) {
            const pick = button(icons, '', () => { collect(); draft.show.icon = icon; draw(); }, 'ss-iconbutton');
            pick.setAttribute('aria-label', S.icons[icon]); pick.setAttribute('aria-pressed', String(draft.show.icon === icon));
            const glyph = iconNode(doc, icon); if (glyph) pick.appendChild(glyph);
        }
        const fields = node('section', 'ss-block-fields-editor', '', form);
        node('h4', 'ss-section-label', S.fields, fields);
        const kindCount = node('p', 'ss-block-kind-count', fill(S.kindCount, { n: blockKindCount(draft) }), fields);
        kindCount.setAttribute('aria-live', 'polite');
        const limitError = node('p', 'ss-block-control-error', '', fields); limitError.setAttribute('role', 'alert');
        const hasKindRoom = () => {
            if (blockKindCount(draft) < DM_LIMITS.kinds) return true;
            limitError.textContent = S.kindLimit;
            return false;
        };
        for (const [index, field] of draft.fields.entries()) {
            const row = node('div', 'ss-block-field-editor ss-glass', '', fields);
            const fieldName = control(row, S.fieldNameLabel, field.name, { type: 'text', max: 60 }, value => renameField(field, value), `field:${index}`);
            fieldName.input.addEventListener('change', refresh);
            const type = control(row, S.fieldTypeLabel, field.type, { type: 'choice', options: TYPES }, value => { field.type = value; }, `field:${index}:type`);
            type.input.addEventListener('change', refresh);
            if (field.type === 'number') {
                control(row, S.min, field.min ?? 0, { type: 'int', min: -DM_LIMITS.integer, max: DM_LIMITS.integer }, value => { field.min = value; }, `field:${index}:min`);
                control(row, S.max, field.max ?? 10, { type: 'int', min: -DM_LIMITS.integer, max: DM_LIMITS.integer }, value => { field.max = value; }, `field:${index}:max`);
                control(row, S.defaultValue, field.default ?? 0, { type: 'int', min: -DM_LIMITS.integer, max: DM_LIMITS.integer }, value => { field.default = value; }, `field:${index}:default`);
            } else if (field.type === 'choice') {
                control(row, S.choices, Array.isArray(field.values) ? field.values.join(', ') : field.values ?? '', { type: 'text', max: 500 }, value => { field.values = String(value).split(',').map(part => part.trim()); }, `field:${index}:values`);
                control(row, S.defaultValue, field.default ?? '', { type: 'text', max: 240 }, value => { field.default = value; }, `field:${index}:default`);
            } else {
                if (field.type === 'text') control(row, S.max, field.max ?? 120, { type: 'int', min: 1, max: 240 }, value => { field.max = value; }, `field:${index}:max`);
                control(row, S.defaultValue, field.default ?? '', { type: 'text', max: 240 }, value => { field.default = value; }, `field:${index}:default`);
            }
            const actions = node('div', 'ss-block-field-actions', '', row);
            const up = button(actions, S.up, () => { collect(); [draft.fields[index - 1], draft.fields[index]] = [draft.fields[index], draft.fields[index - 1]]; draw(); }); up.disabled = index === 0;
            const down = button(actions, S.down, () => { collect(); [draft.fields[index + 1], draft.fields[index]] = [draft.fields[index], draft.fields[index + 1]]; draw(); }); down.disabled = index === draft.fields.length - 1;
            button(actions, S.remove, () => { collect(); draft.fields.splice(index, 1); draw(); });
        }
        button(fields, S.addField, () => { collect(); if (!hasKindRoom()) return;
            let n = draft.fields.length + 1; while (draft.fields.some(field => field.key === `field-${n}`)) n++;
            draft.fields.push({ key: `field-${n}`, name: fill(S.newFieldName, { n }), type: 'text', max: 120, default: '' }); draw(); });
        const purpose = node('section', 'ss-block-purpose', '', form);
        const prompt = control(purpose, S.purpose, draft.prompt, { type: 'text', multiline: true, max: 600 }, value => { draft.prompt = value; }, 'prompt');
        const total = node('small', 'ss-block-static-count', '', purpose);
        updateCount = () => {
            collect();
            const result = buildBlock(draft, { used });
            const definition = result.definition;
            const n = definition ? [...fullModuleGrammar(definition, `pack.chat/${definition.slug}`)].length : [...draft.prompt].length;
            total.textContent = fill(S.staticCount, { n });
        };
        updateCount();
        const functions = node('section', 'ss-block-functions', '', form);
        node('h4', 'ss-section-label', S.functions, functions);
        const actions = node('div', 'ss-block-function-actions', '', functions);
        for (const [type, label] of [['button', S.addButton], ['rule', S.addRule], ['timer', S.addTimer]]) {
            const add = button(actions, label, () => { collect(); if (type === 'button' && !hasKindRoom()) return;
                const n = draft.functions.length + 1;
                const kind = type === 'button' ? S.button : type === 'rule' ? S.rule : S.timer;
                draft.functions.push({ type, name: fill(S.newFunctionName, { type: kind, n }), ...(type === 'rule' ? { when: { field: draft.fields[0]?.key ?? '', op: 'eq', value: '' } } : {}),
                    ...(type === 'timer' ? { every: 60 } : {}), effects: [newEffect(type)] }); draw(); });
            add.disabled = draft.functions.length >= 8 || (type === 'timer' && !directorOn);
        }
        if (!directorOn) node('p', 'ss-block-hint', S.timerNeeds, functions);
        for (const [index, fn] of draft.functions.entries()) {
            const row = node('div', 'ss-block-function ss-glass', '', functions);
            node('span', 'ss-pill', fn.type === 'button' ? S.button : fn.type === 'rule' ? S.rule : S.timer, row);
            control(row, S.functionName, fn.name, { type: 'text', max: 60 }, value => { fn.name = value; }, `function:${index}`);
            if (fn.type === 'rule') {
                control(row, S.whenField, fn.when.field, { type: 'choice', options: fieldOptions() }, value => { fn.when.field = value; }, null);
                control(row, S.comparison, fn.when.op, { type: 'choice', options: COMPARISONS }, value => { fn.when.op = value; }, null);
                control(row, S.whenValue, fn.when.value, { type: 'text', max: 240 }, value => { fn.when.value = value; }, `function:${index}:when`);
            } else if (fn.type === 'timer') control(row, S.every, fn.every, { type: 'int', min: 1, max: 525600 }, value => { fn.every = value; }, `function:${index}:every`);
            paintEffects(row, fn, index);
            button(row, S.remove, () => { collect(); draft.functions.splice(index, 1); draw(); });
        }
        const footer = node('div', 'ss-block-editor-actions', '', form);
        button(footer, S.save, submit, 'ss-button ss-button-primary');
        button(footer, S.cancel, () => onCancel());
        node('small', 'ss-block-hint', S.savedWithReply, form);
        const error = node('p', 'ss-block-control-error', '', form); error.setAttribute('role', 'alert'); spots.set('form', error);
        form.addEventListener('keydown', event => {
            if (event.key === 'Escape') { event.preventDefault?.(); event.stopPropagation?.(); onCancel(); }
            else if (event.key === 'Enter') { event.preventDefault?.(); event.stopPropagation?.(); submit(); }
        });
    }
    draw();
    return { collect, destroy() { alive = false; for (const entry of controls) entry.handle.destroy(); controls = []; } };
}
