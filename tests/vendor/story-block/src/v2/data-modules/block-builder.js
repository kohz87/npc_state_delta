// Build ordinary data-module definitions from the small in-chat editor; the interpreter is shared with packs.
import { oneLine } from '../../text.js';
import { slugify } from '../packs/validate.js';
import { DM_LIMITS as L } from './schema.js';
import { validateDataModules } from './check.js';
import { cleanList } from './interpreter.js';
import { STRINGS } from '../strings.js';
import { hashJson } from '../replay.js';

const B = STRINGS.blocks;
const problem = (path, message) => ({ ok: false, errors: [{ code: 'DM_SCHEMA', path, message }] });
const keyFor = (name, max = 40) => slugify(name).slice(0, max).replace(/-+$/, '');
const number = value => typeof value === 'number' ? value
    : typeof value === 'string' && value.trim() ? Number(value) : NaN;
export const blockKindCount = draft => (Array.isArray(draft?.fields) ? draft.fields.length : 0)
    + (Array.isArray(draft?.functions) ? draft.functions.filter(fn => fn?.type === 'button').length : 0);

export function uniqueBlockSlug(name, used = []) {
    const base = keyFor(name) || 'block';
    const taken = new Set(['chat', ...used.map(value => String(value).split('/').at(-1))]);
    if (!taken.has(base)) return base;
    for (let n = 2; n < 10000; n++) {
        const suffix = `-${n}`, next = `${base.slice(0, 40 - suffix.length).replace(/-+$/, '')}${suffix}`;
        if (!taken.has(next)) return next;
    }
    return '';
}

const effectOf = (effect, state) => {
    const schema = state[effect?.field];
    if (!schema || !['set', 'add'].includes(effect?.op)) return null;
    if (effect.op === 'add') return schema.type === 'int' && Number.isSafeInteger(number(effect.value))
        ? { op: 'add', path: [effect.field], value: number(effect.value), bounds: 'clamp' } : null;
    let value = effect.value;
    if (schema.type === 'int') {
        value = number(value);
        if (!Number.isSafeInteger(value)) return null;
    }
    if (schema.list === true) { try { value = cleanList(value, schema.max); } catch { return null; } }
    return { op: 'set', path: [effect.field], value };
};

/** The draft is plain form data; errors point at the field or function to show beside its control. */
export function buildBlock(draft, { used = [], definitions = [] } = {}) {
    const name = oneLine(draft?.name);
    if (!name || [...name].length > 60) return problem('name', B.blockName);
    const slug = draft.slug ? keyFor(draft.slug) : uniqueBlockSlug(name, used);
    if (!slug) return problem('name', B.blockName);
    if (!Array.isArray(draft.fields)) return problem('fields', B.fieldName);
    if (blockKindCount(draft) > L.kinds) return problem('fields', B.kindLimit);
    const state = {}, kinds = {};
    for (const [index, field] of draft.fields.entries()) {
        const path = `fields.${index}`, label = oneLine(field?.name), key = keyFor(field?.key || label, 32);
        if (!label || [...label].length > 60 || !key || Object.hasOwn(state, key)) return problem(`${path}.name`, B.fieldName);
        let schema;
        if (field.type === 'text') schema = { type: 'text', max: Number(field.max ?? 120), default: String(field.default ?? ''), label };
        else if (field.type === 'list') {
            let value;
            try { value = cleanList(field.default ?? '', 240); } catch { return problem(`${path}.default`, B.listLimit); }
            schema = { type: 'text', max: 240, default: value, list: true, label };
        } else if (field.type === 'number') schema = { type: 'int', min: number(field.min), max: number(field.max), default: number(field.default), label };
        else if (field.type === 'choice') {
            const values = Array.isArray(field.values) ? field.values.map(value => oneLine(value)) : String(field.values ?? '').split(',').map(value => oneLine(value));
            if (values.length < 2 || values.length > L.enumValues || values.some(value => !value) || new Set(values).size !== values.length) return problem(`${path}.values`, B.choiceLimit);
            schema = { type: 'enum', values, default: field.default || values[0], label };
        } else return problem(`${path}.type`, B.fieldType);
        state[key] = schema;
        const labelSchema = schema.type === 'int' ? { type: 'int', min: schema.min, max: schema.max }
            : schema.type === 'enum' ? { type: 'enum', values: schema.values } : { type: 'text', max: schema.max };
        kinds[`set-${key}`] = { op: '~', labels: { to: labelSchema }, effects: [{ op: 'set', path: [key], value: ['arg', 'to'] }] };
    }
    const functions = Array.isArray(draft.functions) ? draft.functions : [];
    if (functions.length > 8) return problem('functions', B.functionLimit);
    const rules = [], timers = [];
    for (const [index, fn] of functions.entries()) {
        const path = `functions.${index}`, effects = (Array.isArray(fn.effects) ? fn.effects : []).map(effect => effectOf(effect, state));
        if (!effects.length) return problem(`${path}.effects`, B.chooseFunction);
        for (const [effectIndex, effect] of effects.entries()) {
            const input = fn.effects[effectIndex];
            if (fn.type === 'timer' && (!effect || effect.op !== 'add')) return problem(`${path}.effects.${effectIndex}.value`, B.timerNumber);
            if (!effect) {
                const part = !state[input?.field] ? 'field' : !['set', 'add'].includes(input?.op) ? 'op' : 'value';
                return problem(`${path}.effects.${effectIndex}.${part}`, B.chooseFunction);
            }
        }
        const key = keyFor(fn.name || `${fn.type}-${index + 1}`, 32);
        if (!key) return problem(`${path}.name`, B.chooseFunction);
        if (fn.type === 'button') {
            const kind = `button-${key}`;
            if (Object.hasOwn(kinds, kind)) return problem(`${path}.name`, B.fieldName);
            kinds[kind] = { op: '!', ui: true, title: oneLine(fn.name || key), labels: {}, effects };
        } else if (fn.type === 'rule') {
            const condition = fn.when, schema = state[condition?.field];
            if (!schema || !['eq', 'ne', 'lt', 'gt', 'le', 'ge'].includes(condition?.op)) return problem(`${path}.when`, B.chooseField);
            const value = schema.type === 'int' ? number(condition.value) : condition.value;
            rules.push({ id: key, when: [condition.op, ['get', [condition.field]], value], then: effects });
        } else if (fn.type === 'timer') timers.push({ id: key, clock: 'clock', every: number(fn.every),
            effects: effects.map(effect => ({ ...effect, value: ['mul', ['timer', 'periods'], effect.value] })) });
        else return problem(`${path}.type`, B.chooseFunction);
    }
    const show = draft.show ?? { tab: true, card: false, tabName: '', icon: 'ph-bookmark-simple' };
    const output = { slug, name, schema: 1, stateVersion: 1, scope: 'chat', state, kinds,
        prompt: String(draft.prompt ?? ''), show: { ...show, tabName: oneLine(show.tabName) || [...name].slice(0, 24).join('') },
        rules, timers, ...(timers.length ? { imports: { clock: { query: 'director.time', mode: 'prefix', projection: ['minutes'] } } } : {}) };
    const checked = validateDataModules([output], { packId: 'chat', capabilities: ['data-modules-v1', 'story-director'], definitions });
    return checked.ok ? { ok: true, definition: output, checked: checked.definitions[0] } : { ...checked, definition: output };
}

/** Reopens an editor-built definition without storing a second representation of the block. */
export function blockDraft(definition) {
    const fields = Object.entries(definition?.state ?? {}).map(([key, schema]) => ({ key, name: schema.label ?? key,
        type: schema.type === 'int' ? 'number' : schema.type === 'enum' ? 'choice' : schema.list ? 'list' : 'text',
        ...(schema.type === 'int' ? { min: schema.min, max: schema.max } : {}),
        ...(schema.type === 'text' ? { max: schema.max } : {}), ...(schema.type === 'enum' ? { values: [...schema.values] } : {}), default: schema.default }));
    const effects = list => (list ?? []).map(effect => {
        const value = effect.value;
        const timerSet = effect.op === 'add' && Array.isArray(value) && value[0] === 'sub' && Array.isArray(value[2])
            && value[2][0] === 'get' && JSON.stringify(value[2][1]) === JSON.stringify(effect.path);
        return { field: effect.path?.[0], op: timerSet ? 'set' : effect.op, value: timerSet ? value[1]
            : Array.isArray(value) && value[0] === 'mul' && Array.isArray(value[1]) && value[1][0] === 'timer' ? value[2] : value };
    });
    const functions = [
        ...Object.entries(definition?.kinds ?? {}).filter(([, kind]) => kind.ui).map(([key, kind]) => ({ type: 'button', name: kind.title ?? key.replace(/^button-/, ''), effects: effects(kind.effects) })),
        ...(definition?.rules ?? []).map(rule => ({ type: 'rule', name: rule.id, when: { op: rule.when?.[0], field: rule.when?.[1]?.[1]?.[0], value: rule.when?.[2] }, effects: effects(rule.then) })),
        ...(definition?.timers ?? []).map(timer => ({ type: 'timer', name: timer.id, every: timer.every, effects: effects(timer.effects) })),
    ];
    return { slug: definition?.slug, name: definition?.name ?? '', fields, functions, prompt: definition?.prompt ?? '',
        show: definition?.show ?? { tab: true, card: false, tabName: definition?.name ?? '', icon: 'ph-bookmark-simple' } };
}

/** Open only definitions the form can write back without losing their behavior. */
export function editableBlockDraft(definition) {
    const { id, pack, ...raw } = definition ?? {};
    const original = validateDataModules([raw], { packId: 'chat', capabilities: ['data-modules-v1', 'story-director'] });
    const draft = blockDraft(definition), rebuilt = buildBlock(draft);
    if (!original.ok || !rebuilt.ok) return null;
    if (hashJson(rebuilt.checked) === hashJson(original.definitions[0])) return draft;
    // Earlier editor versions generated one additional numeric change kind. Recognize only that
    // exact form, so opening an old block does not discard unrelated authored behavior.
    const legacy = { ...rebuilt.definition, kinds: { ...rebuilt.definition.kinds } };
    for (const [key, schema] of Object.entries(legacy.state)) if (schema.type === 'int') {
        const extent = Math.abs(schema.max);
        legacy.kinds[`change-${key}`] = { op: '~', labels: { by: { type: 'int', min: -extent, max: extent } },
            effects: [{ op: 'add', path: [key], value: ['arg', 'by'], bounds: 'clamp' }] };
    }
    const checkedLegacy = validateDataModules([legacy], { packId: 'chat', capabilities: ['data-modules-v1', 'story-director'] });
    return checkedLegacy.ok && hashJson(checkedLegacy.definitions[0]) === hashJson(original.definitions[0]) ? draft : null;
}
