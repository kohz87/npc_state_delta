// Pure data-modules-v1 checker. The pack validator and Studio share these entry points.
import { DM_DESCRIPTORS as D, DM_LIMITS as L, DATA_MODULES_CAPABILITY, dmObject, dmOwn, dmSlug, dmInt, dmId, dmKindWritesHidden } from './schema.js';
import { ROLES } from '../lean-rpg/index.js';
import { HASH_BASIS_V1 } from './hash-basis-v1.js';
import { fieldType, compatible, expressionType, conditionType, pathType } from './expressions.js';
import { byteLength, checkPlain } from '../packs/safety.js';
import { LIMITS as PACK_LIMITS } from '../packs/limits.js';
import { validateLayout } from '../layout/validate.js';
import { validateScreen } from '../view/screens.js';
import { parseHtml } from '../view/template/html.js';
import { checkScreens } from '../packs/validate.js';
import { sha256Hex as sha256 } from '../domains/digest.js';
import { STRINGS, fill } from '../strings.js';
import { oneLine } from '../../text.js';
import { fullModuleGrammar } from './grammar.js';
import { hasIcon } from '../view/icons/index.js';

const E = STRINGS.editMessages;

export { DM_DESCRIPTORS, DM_LIMITS, DM_DIAGNOSTICS, DATA_MODULES_CAPABILITY } from './schema.js';
export { expressionType, conditionType } from './expressions.js';
const copy = value => JSON.parse(JSON.stringify(value));
const entries = value => dmObject(value) ? Object.entries(value) : [];
const array = value => Array.isArray(value) ? value : [];
const stable = value => value === null || typeof value !== 'object' ? value : Array.isArray(value) ? value.map(stable)
    : Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const defId = (packId, slug) => `pack.${packId}/${typeof slug === 'string' ? slug : 'invalid'}`;

function shape(value, descriptor, path, add, code = 'DM_SCHEMA') {
    if (!dmObject(value)) { add(code, path, 'Expected an object with the declared fields.'); return false; }
    const required = Array.isArray(descriptor) ? descriptor : descriptor.required;
    const allowed = [...required, ...(descriptor.optional ?? [])];
    for (const key of Object.keys(value)) if (!allowed.includes(key)) add(code, `${path}.${key}`, `Unknown field "${key}"; expected ${allowed.join(', ')}.`);
    for (const key of required) if (!Object.hasOwn(value, key)) add(code, `${path}.${key}`, `Missing required field "${key}".`);
    return true;
}
function sized(value, max, path, add, { min = 0, list = false } = {}) {
    if (!(list ? Array.isArray(value) : dmObject(value))) {
        add('DM_SCHEMA', path, list ? 'Expected a list.' : 'Expected a named object.');
        return false;
    }
    const length = list ? value.length : Object.keys(value).length;
    if (length < min) add('DM_SCHEMA', path, `Expected at least ${min} entries.`);
    if (length > max) add('DM_BUDGET', path, `Version 1 permits at most ${max} entries here.`);
    return true;
}
function named(value, max, path, add, { label = false, min = 0 } = {}) {
    if (!sized(value, max, path, add, { min })) return [];
    for (const key of Object.keys(value)) {
        if (!dmSlug(key) || (label && !/^[a-z]+$/.test(key))) add(label ? 'DM_LABEL' : 'DM_SCHEMA', `${path}.${key}`, label
            ? 'Labels are one lowercase word of at most 40 characters.' : 'Names are safe lowercase slugs of at most 40 characters.');
    }
    return Object.entries(value);
}
function distinct(values, path, add, { max = L.enumValues, keys = false } = {}) {
    if (!Array.isArray(values) || !values.length || values.length > max || values.some(value => keys ? !dmSlug(value)
        : !(value === null || typeof value === 'string' || typeof value === 'boolean' || dmInt(value)))) {
        add('DM_SCHEMA', path, `Expected 1 to ${max} distinct ${keys ? 'safe key slugs' : 'JSON scalar literals'}.`);
        return false;
    }
    if (new Set(values.map(value => JSON.stringify(typeof value === 'string' ? value.normalize('NFKC') : value))).size !== values.length) add('DM_SCHEMA', path, 'Values must be distinct after Unicode normalization.');
    return true;
}
function normalizedKeys(value, path, add) {
    if (!value || typeof value !== 'object') return;
    if (!Array.isArray(value)) {
        const seen = new Set();
        for (const key of Object.keys(value)) {
            const folded = key.normalize('NFKC');
            if (seen.has(folded)) add('DM_SCHEMA', `${path}.${key}`, 'Object keys collide after Unicode normalization.');
            seen.add(folded);
        }
    }
    for (const [key, child] of Object.entries(value)) normalizedKeys(child, Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`, add);
}

function scalar(schema, path, add, { label = false, map = true } = {}) {
    const schemas = label ? D.labels : D.fields;
    const descriptor = dmOwn(schemas, schema?.type) && schemas[schema.type];
    if (!descriptor || (!map && schema.type === 'map')) { add(label ? 'DM_LABEL' : 'DM_SCHEMA', path, fill(E.declaredSchema, { schema: label ? E.labelSchema : E.fieldSchema })); return; }
    if (!shape(schema, descriptor, path, add, label ? 'DM_LABEL' : 'DM_SCHEMA')) return;
    if (!label && schema.edit !== undefined && typeof schema.edit !== 'boolean') add('DM_SCHEMA', `${path}.edit`, E.editBoolean);
    if (!label && schema.label !== undefined) {
        if (typeof schema.label !== 'string' || !oneLine(schema.label) || [...schema.label].length > 60) add('DM_SCHEMA', `${path}.label`, STRINGS.blocks.labelLimit);
        else schema.label = oneLine(schema.label);
    }
    // `prompt: false` hides a field from the story's tail and grammar; `names` gives a number's values display names. Neither belongs on a
    // label, or on the value type of a map.
    if (!label && schema.prompt !== undefined && (typeof schema.prompt !== 'boolean' || !map)) add('DM_SCHEMA', `${path}.prompt`, STRINGS.blocks.hiddenFlag);
    if (!label && schema.names !== undefined && !map) add('DM_SCHEMA', `${path}.names`, STRINGS.blocks.namesKey);
    if (schema.type === 'int') {
        if (!dmInt(schema.min) || !dmInt(schema.max) || schema.min > schema.max) add('DM_BOUNDS', path, 'Integer bounds must be ordered safe integers.');
        if (!label && !dmInt(schema.default, schema.min, schema.max)) add('DM_BOUNDS', `${path}.default`, 'The integer default must be inside its inclusive bounds.');
        if (!label && schema.names !== undefined && map) names(schema, path, add);
    }
    if (schema.type === 'bool' && !label && typeof schema.default !== 'boolean') add('DM_SCHEMA', `${path}.default`, 'A bool default must be a boolean.');
    if (schema.type === 'enum') {
        distinct(schema.values, `${path}.values`, add);
        if (!label && !array(schema.values).includes(schema.default)) add('DM_BOUNDS', `${path}.default`, 'The enum default must be one of its literal values.');
    }
    if (schema.type === 'text') {
        if (!dmInt(schema.max, 1, L.text)) add('DM_BOUNDS', `${path}.max`, `Text max must be 1 to ${L.text}.`);
        if (!label && schema.list !== undefined && typeof schema.list !== 'boolean') add('DM_SCHEMA', `${path}.list`, STRINGS.blocks.listOnlyText);
        if (!label && (typeof schema.default !== 'string' || !dmInt(schema.max, 1, L.text) || [...schema.default].length > schema.max
            || (schema.list === true && schema.default && schema.default.split(';').length > 12))) add('DM_BOUNDS', `${path}.default`, 'Text defaults must be literal text within max.');
    }
    if (schema.type === 'map') {
        distinct(schema.keys, `${path}.keys`, add, { max: L.mapKeys, keys: true });
        scalar(schema.values, `${path}.values`, add, { map: false });
    }
}

const foldedName = text => String(text).normalize('NFKC').toLowerCase();
// Display names for an int field: { "<value>": "<name>" }, whole values inside min..max, short distinct names that are not numbers.
function names(schema, path, add) {
    const given = schema.names;
    if (!dmObject(given) || !Object.keys(given).length || Object.keys(given).length > L.names) { add('DM_BOUNDS', `${path}.names`, STRINGS.blocks.namesLimit); return; }
    const seen = new Set();
    for (const [key, name] of Object.entries(given)) {
        const at = `${path}.names.${key}`;
        if (!/^-?\d+$/.test(key) || String(Number(key)) !== key || !dmInt(Number(key), schema.min, schema.max)) add('DM_BOUNDS', at, STRINGS.blocks.namesKey);
        const text = typeof name === 'string' ? oneLine(name) : '';
        if (!text || [...text].length > L.nameText || /^-?\d+$/.test(text)) { add('DM_SCHEMA', at, STRINGS.blocks.namesText); continue; }
        given[key] = text;
        if (seen.has(foldedName(text))) add('DM_SCHEMA', at, STRINGS.blocks.namesSame);
        seen.add(foldedName(text));
    }
}

export function dataModuleDefaults(state) {
    return Object.fromEntries(entries(state).map(([key, schema]) => [key, schema.type === 'map'
        ? Object.fromEntries(schema.keys.map(key => [key, schema.values.default])) : schema.default]));
}

function rewardTypes(reward, path, add) {
    const out = {};
    for (const [key, value] of named(reward.values, L.fields, `${path}.values`, add)) {
        let ranges = [value];
        if (dmOwn(value, 'table') || dmOwn(value, 'binding')) {
            shape(value, D.rangeTable, `${path}.values.${key}`, add);
            const binding = dmOwn(reward.bindings, value.binding) && reward.bindings[value.binding];
            if (binding?.type !== 'enum') add('DM_SCHEMA', `${path}.values.${key}.binding`, 'A range table must select a declared enum binding.');
            if (!dmObject(value.table) || !same(Object.keys(value.table).sort(), array(binding?.values).map(String).sort())) add('DM_SCHEMA', `${path}.values.${key}.table`, 'A range table must cover every enum binding value exactly once.');
            ranges = entries(value.table).map(([, range]) => range);
        }
        for (const [i, range] of ranges.entries()) {
            const at = `${path}.values.${key}${ranges[0] === value ? '' : `.table[${i}]`}`;
            if (!shape(range, D.range, at, add)) continue;
            if (!dmInt(range.min) || !dmInt(range.max) || range.min > range.max) add('DM_BOUNDS', at, 'Reward ranges must have ordered safe integer bounds.');
            if (!D.pick.includes(range.pick)) add('DM_SCHEMA', `${at}.pick`, 'A reward picker is min, max or midpoint.');
        }
        // An invalid range must never let NaN reach the interval checker.
        const valid = ranges.filter(r => dmInt(r?.min) && dmInt(r?.max) && r.min <= r.max);
        out[key] = valid.length ? { type: 'int', min: Math.min(...valid.map(r => r.min)), max: Math.max(...valid.map(r => r.max)) } : { type: 'invalid' };
    }
    return out;
}

function effects(list, env, path, add, { timer = false, reward = false, plain = false } = {}) {
    if (!sized(list, L.effects, path, add, { list: true })) return;
    list.forEach((effect, i) => {
        const at = `${path}[${i}]`;
        if (D.v11Effects.includes(effect?.op)) { add('DM_SCHEMA', at, `${effect.op} needs data-modules v1.1.`); return; }
        const descriptor = dmOwn(D.effects, effect?.op) && D.effects[effect.op];
        if (!descriptor || !shape(effect, descriptor, at, add)) { if (!descriptor) add('DM_SCHEMA', at, 'Unknown effect; arbitrary commands and patches are not allowed.'); return; }
        if (timer && effect.op !== 'add') add('DM_SCHEMA', at, 'Timer effects must be additive field changes, optionally clamped; no checks, rewards or offers.');
        if (reward && ['reward', 'offer', 'award'].includes(effect.op)) add('DM_SCHEMA', at, 'Reward templates cannot dispatch rewards, offers or awards recursively.');
        if (plain && ['reward', 'offer', 'award'].includes(effect.op)) add('DM_SCHEMA', at, STRINGS.blocks.replyEndPlain);
        if (['set', 'add', 'clamp'].includes(effect.op)) {
            const target = pathType(effect.path, { ...env, writing: true }, `${at}.path`, add, (v, p) => expressionType(v, env, p, add));
            if (effect.op === 'clamp') {
                if (target.type !== 'invalid' && target.type !== 'int') add('DM_SCHEMA', at, 'Only integer fields can be clamped.');
                if (!dmInt(effect.min) || !dmInt(effect.max) || effect.min > effect.max || (target.type === 'int' && (effect.min < target.min || effect.max > target.max))) add('DM_BOUNDS', at, 'Clamp literals must be ordered and inside the target field bounds.');
            } else {
                if (effect.bounds !== undefined && !['reject', 'clamp'].includes(effect.bounds)) add('DM_SCHEMA', `${at}.bounds`, 'bounds must be reject or clamp.');
                if (effect.op === 'add') effect.bounds ??= 'reject';
                if (target.type === 'text') {
                    const argName = Array.isArray(effect.value) && effect.value.length === 2 && effect.value[0] === 'arg' ? effect.value[1]
                        : dmObject(effect.value) && Object.keys(effect.value).length === 1 ? effect.value.arg : null;
                    const arg = typeof argName === 'string' ? env.args?.[argName] : null;
                    const literal = typeof effect.value === 'string' && [...effect.value].length <= target.max
                        && (target.list !== true || !effect.value || effect.value.split(';').length <= 12);
                    const textArg = arg?.type === 'text' && arg.max <= target.max;
                    if (effect.op !== 'set' || !(literal || textArg)) add('DM_SCHEMA', `${at}.value`, E.textEffect);
                    else if (textArg && dmObject(effect.value)) effect.value = ['arg', argName];
                    return;
                }
                let type = expressionType(effect.value, env, `${at}.value`, add);
                if (effect.op === 'add') {
                    if (target.type !== 'invalid' && target.type !== 'int') add('DM_SCHEMA', at, 'add requires an integer target.');
                    if (!['int', 'invalid'].includes(type.type)) add('DM_SCHEMA', `${at}.value`, 'add requires an integer amount.');
                    if (target.type === 'int' && type.type === 'int') {
                        type = { type: 'int', min: target.min + type.min, max: target.max + type.max };
                        if (type.min > L.integer || type.max < -L.integer) add('DM_BOUNDS', at, 'The add has no safe arithmetic result before clamping.');
                        if (effect.bounds === 'clamp') return;
                    }
                }
                if (!compatible(target, type, { overlap: true })) add('DM_BOUNDS', `${at}.value`, 'The value cannot fit the declared target field type or interval.');
            }
        } else if (effect.op === 'reward' || effect.op === 'offer') {
            const template = dmOwn(env.templates, effect.template) && env.templates[effect.template];
            if (!template) { add('DM_SCHEMA', `${at}.template`, 'Unknown local reward template.'); return; }
            if (effect.op === 'offer' && !dmSlug(effect.key)) add('DM_SCHEMA', `${at}.key`, 'An offer key must be a literal bounded safe slug.');
            if (!dmObject(effect.bind)) add('DM_SCHEMA', `${at}.bind`, 'Reward bind must contain every typed binding.');
            const bindings = template.bindings ?? {};
            for (const key of Object.keys(effect.bind ?? {})) if (!dmOwn(bindings, key)) add('DM_SCHEMA', `${at}.bind.${key}`, 'Unknown reward binding.');
            for (const [key, schema] of entries(bindings)) {
                if (!dmOwn(effect.bind, key)) add('DM_SCHEMA', `${at}.bind.${key}`, 'Missing reward binding.');
                else if (!compatible(fieldType(schema), expressionType(effect.bind[key], env, `${at}.bind.${key}`, add))) add('DM_BOUNDS', `${at}.bind.${key}`, 'Every binding value must fit its declared schema.');
            }
        } else if (!dmSlug(effect.offer) || !env.offerKeys.has(effect.offer)) add('DM_SCHEMA', `${at}.offer`, 'award must name a declared local offer key.');
    });
}

function imports(definition, path, add) {
    const inputs = {};
    for (const [alias, entry] of named(definition.imports, L.imports, `${path}.imports`, add)) {
        const at = `${path}.imports.${alias}`;
        inputs[alias] = {};
        if (!shape(entry, D.import, at, add)) continue;
        const adapter = dmOwn(D.adapters, entry.query) && D.adapters[entry.query];
        if (!adapter) { add('DM_SCHEMA', `${at}.query`, 'This public query has no reviewed data-modules v1 adapter.'); continue; }
        if (!adapter.modes.includes(entry.mode)) add('DM_SCHEMA', `${at}.mode`, 'Import mode must be prefix or recorded.');
        if (entry.args !== undefined && !dmObject(entry.args)) add('DM_SCHEMA', `${at}.args`, 'Adapter args must be a literal object.');
        for (const key of Object.keys(entry.args ?? {})) if (!adapter.args.includes(key)) add('DM_SCHEMA', `${at}.args.${key}`, 'Unsupported adapter argument.');
        if (!Array.isArray(entry.projection) || !entry.projection.length || new Set(entry.projection).size !== entry.projection.length || entry.projection.some(field => typeof field !== 'string')) add('DM_SCHEMA', `${at}.projection`, 'Projection must contain distinct advertised public field names.');
        if (adapter.projection) for (const field of array(entry.projection)) if (!adapter.projection.includes(field)) add('DM_SCHEMA', `${at}.projection`, `Only ${adapter.projection.join(', ')} may be projected from ${entry.query}.`);
        if (entry.query === 'director.time' && array(entry.projection).includes('minutes')) inputs[alias].minutes = { type: 'int', min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER };
        if (entry.query === 'dataModules.public') {
            if (!dmId(entry.args?.module) || !dmSlug(entry.args?.export)) add('DM_SCHEMA', `${at}.args`, 'A data import requires a full module ID and a named export.');
            if (entry.args?.who !== undefined && (typeof entry.args.who !== 'string' || !/^ca_[A-Za-z0-9_-]+$/.test(entry.args.who))) add('DM_SCHEMA', `${at}.args.who`, 'A character import requires an explicit canonical SD ca_ actor ID.');
        }
    }
    return inputs;
}

function collectOffers(value, keys = new Set()) {
    if (!value || typeof value !== 'object') return keys;
    if (value.op === 'offer' && dmSlug(value.key)) keys.add(value.key);
    for (const child of Object.values(value)) collectOffers(child, keys);
    return keys;
}

function migrations(definition, path, add) {
    if (!sized(definition.migrations, L.migrations, `${path}.migrations`, add, { list: true })) return;
    const seen = new Set();
    const fields = new Set();
    definition.migrations.forEach((step, i) => {
        const at = `${path}.migrations[${i}]`;
        if (!shape(step, D.migration, at, add)) return;
        if (!dmInt(step.from, 1, Number.MAX_SAFE_INTEGER - 1) || step.to !== step.from + 1 || step.to > definition.stateVersion) add('DM_SCHEMA', at, 'Migrations must move forward one adjacent stateVersion, up to this definition version.');
        if (seen.has(step.from) || (i && definition.migrations[i - 1]?.to !== step.from)) add('DM_SCHEMA', at, 'Migrations must form one ordered chain without cycles or branches.');
        seen.add(step.from);
        for (const [field, schema] of named(step.add, L.fields, `${at}.add`, add, { min: 1 })) {
            scalar(schema, `${at}.add.${field}`, add);
            if (fields.has(field) || !dmOwn(definition.state, field) || !same(definition.state[field], schema)) add('DM_SCHEMA', `${at}.add.${field}`, 'A migration adds a field once, with exactly its current schema and default.');
            fields.add(field);
        }
    });
    if (definition.migrations.length && definition.migrations.at(-1)?.to !== definition.stateVersion) add('DM_SCHEMA', `${path}.migrations`, 'The migration chain must end at this stateVersion.');
}

// An editable in data-module presentation may address only this pin and an editable declared field.
function editableProps(definition, props, at, add) {
    if (!dmObject(props) || props.command !== 'dm.set' || (props.valueKey !== undefined && props.valueKey !== 'value')) {
        add('DM_SCHEMA', at, E.editableCommand); return;
    }
    const payload = props.payload;
    if (!dmObject(payload) || Object.keys(payload).some(key => !['module', 'field', 'key', 'who'].includes(key))
        || payload.module !== definition.id || !dmOwn(definition.state, payload.field)) {
        add('DM_SCHEMA', at, E.editableField); return;
    }
    const field = definition.state[payload.field];
    if (field.edit === false) add('DM_SCHEMA', at, E.editableLocked);
    if (field.type === 'map') {
        if (typeof payload.key !== 'string' || (!field.keys.includes(payload.key) && !payload.key.startsWith('$item.'))) add('DM_SCHEMA', at, E.mapKeyDeclared);
    } else if (payload.key !== undefined) add('DM_SCHEMA', at, E.scalarKey);
    if (definition.scope === 'chat' && payload.who !== undefined) add('DM_SCHEMA', at, E.chatCharacter);
}

function presentation(definition, path, add) {
    // Reuse the shipped presentation validators. Ordinary packs keep their current acceptance.
    checkScreens(definition.screens, 'data-module', (code, at, message) => add('DM_SCHEMA', `${path}.${at}`, message));
    const rendererCheck = (fn, at) => {
        try { for (const message of fn()) add('DM_SCHEMA', at, message); }
        catch { add('DM_SCHEMA', at, 'Presentation must satisfy the existing renderer contract.'); }
    };
    if (!Array.isArray(definition.layouts)) add('DM_SCHEMA', `${path}.layouts`, 'layouts must be a list of existing renderer layouts.');
    const seen = new Set();
    array(definition.layouts).forEach((layout, i) => {
        rendererCheck(() => validateLayout(layout), `${path}.layouts[${i}]`);
        if (seen.has(layout?.id)) add('DM_SCHEMA', `${path}.layouts[${i}].id`, 'Duplicate module layout ID.');
        seen.add(layout?.id);
    });
    const check = (value, at) => {
        if (!value || typeof value !== 'object') return;
        if (dmOwn(value, 'query')) {
            if (value.query === 'dataModules.view') {
                shape(value.args, { required: ['module'], optional: [] }, `${at}.args`, add);
                if (value.args?.module !== definition.id) add('DM_SCHEMA', `${at}.args.module`, 'Module UI may read its own view; other modules require a declared public export.');
                if (value.path !== undefined) viewPath(definition, value.path, `${at}.path`, add);
            } else if (!entries(definition.imports).some(([, entry]) => entry?.query === value.query && same(entry.args ?? {}, value.args ?? {}))) add('DM_SCHEMA', `${at}.query`, 'Module presentation queries must use its own view or an explicitly declared public import.');
        }
        if (dmOwn(value, 'command')) {
            if (value.command !== 'dm.act') add('DM_SCHEMA', `${at}.command`, 'Data module actions may call only dm.act.');
            else actionPayload(definition, value.payload, `${at}.payload`, add);
            // The payload is data, checked above as a whole: a label may be called "query" or "command" and hold any text.
            for (const [key, child] of Object.entries(value)) if (key !== 'payload') check(child, Array.isArray(value) ? `${at}[${key}]` : `${at}.${key}`);
            return;
        }
        for (const [key, child] of Object.entries(value)) check(child, Array.isArray(value) ? `${at}[${key}]` : `${at}.${key}`);
    };
    array(definition.screens).forEach((screen, i) => {
        const at = `${path}.screens[${i}]`;
        if (dmObject(screen)) rendererCheck(() => validateScreen({ ...screen, mounts: screen.mounts ?? ['tab'] }), at);
        if (screen?.layout) rendererCheck(() => validateLayout(screen.layout, { meta: false }), `${at}.layout`);
        const template = (text, where) => {
            if (typeof text !== 'string') return;
            // Read the same HTML tree as the renderer, including decoded attributes.
            const visit = nodes => { for (const node of nodes) {
                const attrs = new Map(node.attrs ?? []);
                if (node.tag === 'ss-widget' && attrs.get('name') === 'ss.editable') {
                    editableProps(definition, templatePayload(attrs.get('data-props')), `${where}.data-props`, add);
                }
                if (node.tag === 'ss-widget' && attrs.get('name') === 'story-block.inventory-add') add('DM_SCHEMA', where, E.noInventoryControl);
                if (attrs.has('data-inline-control')) {
                    if (node.tag !== 'span' || attrs.get('data-inline-control') !== 'ss.editable') add('DM_SCHEMA', where, E.onlyEditableControl);
                    else editableProps(definition, templatePayload(attrs.get('data-props')), `${where}.data-props`, add);
                }
                if (attrs.has('data-submit')) add('DM_SCHEMA', where, 'A data module template button uses data-command="dm.act" with a closed data-payload; a form cannot carry one.');
                if (attrs.has('data-command')) {
                    if (attrs.get('data-command').trim() !== 'dm.act') add('DM_SCHEMA', where, 'Data module template actions may call only dm.act.');
                    else {
                        const payload = attrs.has('data-payload') ? templatePayload(attrs.get('data-payload')) : null;
                        if (!payload) add('DM_SCHEMA', where, 'A dm.act button needs a data-payload that is one JSON record: module, kind and the declared labels.');
                        else actionPayload(definition, payload, `${where}.data-payload`, add);
                    }
                }
                visit(node.children ?? []);
            } };
            visit(parseHtml(text));
        };
        template(screen?.template, `${at}.template`);
        array(screen?.steps).forEach((step, j) => {
            if (step?.layout) rendererCheck(() => validateLayout(step.layout, { meta: false }), `${at}.steps[${j}].layout`);
            template(step?.template, `${at}.steps[${j}].template`);
        });
    });
    check(definition.screens, `${path}.screens`);
    check(definition.layouts, `${path}.layouts`);
}

// The closed shape of a screen action: dm.act of this module, a local kind that allows screens, its declared labels with typed
// literals (or a renderer row reference), and `who` only for character scope. `payload` is data, never a binding or an action.
function actionPayload(definition, payload, at, add) {
    shape(payload, { required: ['module', 'kind'], optional: ['who', 'labels'] }, at, add);
    if (!dmObject(payload)) return;
    if (payload.module !== definition.id || !dmOwn(definition.kinds, payload.kind) || definition.kinds[payload.kind]?.ui !== true) {
        add('DM_SCHEMA', at, 'A screen action must name this module and a local kind with ui: true.');
        return;
    }
    const labels = payload.labels ?? {};
    const declared = definition.kinds[payload.kind].labels;
    if (!dmObject(labels)) add('DM_LABEL', `${at}.labels`, 'Screen action labels must be a named object.');
    else {
        for (const key of Object.keys(labels)) if (!dmOwn(declared, key)) add('DM_LABEL', `${at}.labels.${key}`, 'Unknown local kind label.');
        for (const [key, schema] of entries(declared)) {
            const where = `${at}.labels.${key}`;
            if (!dmOwn(labels, key)) add('DM_LABEL', where, 'Missing local kind label.');
            else if (!(typeof labels[key] === 'string' && /^\$(?:item|index)(?:\.|$)/.test(labels[key]))) {
                if (labels[key] !== null && typeof labels[key] === 'object') add('DM_LABEL', where, 'Screen labels are typed literals or renderer row references.');
                else if (!compatible(fieldType(schema), expressionType(labels[key], {}, where, add))) add('DM_LABEL', where, 'Screen label literal is outside its declared type or bounds.');
            }
        }
    }
    if (definition.scope === 'chat' && payload.who !== undefined) add('DM_LABEL', `${at}.who`, 'Chat-scoped actions cannot select a character.');
    if (payload.who !== undefined && typeof payload.who !== 'string') add('DM_LABEL', `${at}.who`, 'who names one attached character.');
}

// A template button's `data-payload` as the renderer will compile it: holes ({{ }}) become row references, so what is left is the
// closed payload shape or nothing at all. Anything that does not parse to a record is not a payload.
function templatePayload(text) {
    const source = String(text ?? '');
    let out = '', inString = false;
    for (let i = 0; i < source.length; i += 1) {
        if (source.startsWith('{{', i)) {
            const close = source.indexOf('}}', i + 2);
            if (close >= 0) { out += inString ? '$item.hole' : '"$item.hole"'; i = close + 1; continue; }
        }
        if (inString && source[i] === '\\') { out += source[i] + (source[i + 1] ?? ''); i += 1; continue; }
        if (source[i] === '"') inString = !inString;
        out += source[i];
    }
    try { const value = JSON.parse(out); return dmObject(value) ? value : null; } catch { return null; }
}

function viewPath(definition, path, at, add) {
    if (typeof path !== 'string') return;
    const parts = path.split('.');
    if ((definition.scope === 'chat' && parts.shift() !== 'chat') || (definition.scope === 'character' && parts.shift() !== 'characters')) return add('DM_SCHEMA', at, 'View paths must use this module scope.');
    if (definition.scope === 'character' && parts.length && /^\d+$/.test(parts[0])) parts.shift();
    if (!parts.length) return;
    if (definition.scope === 'character' && ['id', 'name'].includes(parts[0]) && parts.length === 1) return;
    const field = dmOwn(definition.state, parts[0]) && definition.state[parts[0]];
    if (!field || parts.length > (field.type === 'map' ? 2 : 1) || (parts.length === 2 && !array(field.keys).includes(parts[1]))) add('DM_SCHEMA', at, 'Unknown module view field or fixed map key.');
}

// The RPG draws a role block's health, mana, stamina and foe-health fields as stage bars, one cell and one choice for each stage, so
// those fields stay small: at most ten stages counted up from empty (0), whatever else the block holds.
const STAGE_FIELD = /^(health|mana|stamina|hurt[1-4])$/;
function stageFields(definition, at, add) {
    for (const [key, schema] of entries(definition.state)) {
        if (!STAGE_FIELD.test(key) || !dmObject(schema) || schema.type !== 'int' || !dmInt(schema.min) || !dmInt(schema.max)) continue;
        if (schema.max - schema.min >= L.stages || schema.max > L.stages) add('DM_BOUNDS', `${at}.state.${key}`, fill(STRINGS.blocks.stagesLimit, { max: L.stages }));
    }
}

// The cards a block draws under the head reply, the rules it settles once at the end of each reply, and the hidden fields only
// a Button may write. All three are declarations: a card is derived from the state, never stored.
function blockFunctions(definition, env, at, add) {
    if (definition.cards !== undefined) {
        if (definition.scope !== 'chat') add('DM_SCHEMA', `${at}.cards`, STRINGS.blocks.cardsChat);
        if (sized(definition.cards, L.cards, `${at}.cards`, add, { list: true })) {
            const ids = new Set();
            definition.cards.forEach((card, i) => {
                const path = `${at}.cards[${i}]`;
                if (!shape(card, D.card, path, add)) return;
                if (card.type !== undefined && card.type !== 'card') add('DM_SCHEMA', `${path}.type`, STRINGS.blocks.functionType);
                if (card.id !== undefined) {
                    if (!dmSlug(card.id) || ids.has(card.id)) add('DM_SCHEMA', `${path}.id`, 'Card IDs must be unique safe slugs.');
                    ids.add(card.id);
                }
                // A card is asked about the head state alone: no import, no label.
                conditionType(card.when, { ...env, inputs: {} }, `${path}.when`, add);
                if (!D.cardTones.includes(card.tone)) add('DM_SCHEMA', `${path}.tone`, `A card tone is ${D.cardTones.join(', ')}.`);
                const title = typeof card.title === 'string' ? oneLine(card.title) : '';
                if (!title || [...title].length > L.cardTitle) add('DM_BOUNDS', `${path}.title`, STRINGS.blocks.cardTitle);
                else card.title = title;
                const text = typeof card.text === 'string' ? oneLine(card.text) : null;
                if (text === null || [...text].length > L.cardText) add('DM_BOUNDS', `${path}.text`, STRINGS.blocks.cardText);
                else card.text = text;
                if (card.button !== undefined) {
                    const kind = typeof card.button === 'string' && dmOwn(definition.kinds, card.button) ? definition.kinds[card.button] : null;
                    if (!kind || kind.ui !== true || Object.keys(kind.labels ?? {}).length) add('DM_SCHEMA', `${path}.button`, STRINGS.blocks.cardButton);
                }
            });
        }
    }
    if (definition.replyEnd !== undefined && sized(definition.replyEnd, L.replyEnd, `${at}.replyEnd`, add, { list: true })) {
        const ids = new Set();
        definition.replyEnd.forEach((entry, i) => {
            const path = `${at}.replyEnd[${i}]`;
            if (!shape(entry, D.replyEnd, path, add)) return;
            if (entry.type !== undefined && entry.type !== 'reply-end') add('DM_SCHEMA', `${path}.type`, STRINGS.blocks.functionType);
            if (entry.id !== undefined) {
                if (!dmSlug(entry.id) || ids.has(entry.id)) add('DM_SCHEMA', `${path}.id`, 'Reply-end IDs must be unique safe slugs.');
                ids.add(entry.id);
            }
            conditionType(entry.when, env, `${path}.when`, add);
            if (Array.isArray(entry.effects) && !entry.effects.length) add('DM_SCHEMA', `${path}.effects`, 'A reply-end function needs at least one effect.');
            effects(entry.effects, env, `${path}.effects`, add, { plain: true });
        });
    }
    // The narrator cannot set a hidden field: only a Button (the reader's) may write one directly.
    for (const [name, kind] of entries(definition.kinds)) {
        if (dmObject(kind) && kind.ui !== true && dmKindWritesHidden(definition, kind)) add('DM_SCHEMA', `${at}.kinds.${name}`, STRINGS.blocks.hiddenKind);
    }
}

/** Checked definitions plus an optional catalog for imports from other packs. No state is read. */
export function validateDataModules(value, { packId, capabilities = [], definitions = [] } = {}) {
    const errors = [];
    const add = (code, path, message) => { if (errors.length < L.errors) errors.push({ code, path, message }); };
    if (!dmSlug(packId)) return { ok: false, errors: [{ code: 'DM_SCHEMA', path: 'id', message: 'Data definitions require a valid pack ID.' }] };
    // Include the envelope depth even when Studio invokes the definition checker directly.
    const plain = checkPlain({ content: { dataModules: value } });
    if (plain.length) return { ok: false, errors: plain };
    if (!Array.isArray(value)) return { ok: false, errors: [{ code: 'DM_SCHEMA', path: 'content.dataModules', message: 'dataModules must be a list of definitions.' }] };
    if (value.length > L.definitions) add('DM_BUDGET', 'content.dataModules', `A pack permits at most ${L.definitions} data modules.`);
    if (!array(capabilities).includes(DATA_MODULES_CAPABILITY)) add('DM_SCHEMA', 'requires.capabilities', `content.dataModules requires ${DATA_MODULES_CAPABILITY}.`);
    const normalized = [];
    const seen = new Set();
    value.forEach((given, i) => {
        const at = `content.dataModules[${i}]`;
        if (!shape(given, D.definition, at, add)) return;
        normalizedKeys(given, at, add);
        if (!dmSlug(given.slug)) add('DM_SCHEMA', `${at}.slug`, 'A module slug must be safe lowercase text of at most 40 characters.');
        if (seen.has(given.slug)) add('DM_SCHEMA', `${at}.slug`, 'Module slugs must be unique within a pack.');
        seen.add(given.slug);
        if (typeof given.name !== 'string' || !given.name.trim() || [...given.name].length > PACK_LIMITS.name || /[\r\n\u0000-\u001f\u007f]/.test(given.name)) add('DM_SCHEMA', `${at}.name`, `A module name must be one line of 1 to ${PACK_LIMITS.name} safe characters.`);
        if (given.schema !== 1) add('DM_SCHEMA', `${at}.schema`, 'Only data module schema 1 is supported.');
        if (!dmInt(given.stateVersion, 1, Number.MAX_SAFE_INTEGER)) add('DM_SCHEMA', `${at}.stateVersion`, 'stateVersion must be a positive safe integer.');
        if (!D.scope.includes(given.scope)) add('DM_SCHEMA', `${at}.scope`, 'scope must be chat or character.');
        const definition = { ...copy(D.defaults), ...copy(given), id: defId(packId, given.slug), pack: packId };
        if (definition.prompt !== undefined) {
            if (typeof definition.prompt !== 'string' || [...definition.prompt].length > L.prompt) add('DM_BOUNDS', `${at}.prompt`, STRINGS.blocks.promptLimit);
            else definition.prompt = oneLine(definition.prompt);
        }
        if (definition.role !== undefined && !ROLES.includes(definition.role)) add('DM_SCHEMA', `${at}.role`, STRINGS.blocks.roleInvalid);
        else if (definition.role !== undefined && definition.scope === 'character') add('DM_SCHEMA', `${at}.role`, STRINGS.blocks.roleChat);
        if (definition.show !== undefined) {
            const show = definition.show;
            if (!dmObject(show) || Object.keys(show).some(key => !['tab', 'card', 'tabName', 'icon'].includes(key))
                || typeof show.tab !== 'boolean' || typeof show.card !== 'boolean'
                || typeof show.tabName !== 'string' || !show.tabName.trim() || [...show.tabName].length > 24 || !hasIcon(show.icon)) add('DM_SCHEMA', `${at}.show`, STRINGS.blocks.showOptions);
            else show.tabName = oneLine(show.tabName);
        }
        if (byteLength(JSON.stringify(definition)) > L.definitionBytes) add('DM_BUDGET', at, `A definition must fit ${L.definitionBytes} UTF-8 JSON bytes.`);
        for (const [key, schema] of named(definition.state, L.fields, `${at}.state`, add)) scalar(schema, `${at}.state.${key}`, add);
        if (definition.role !== undefined) stageFields(definition, at, add);
        imports(definition, at, add); // forms first, linking before expression analysis below
        migrations(definition, at, add);
        normalized.push(definition);
    });
    if (errors.length) return { ok: false, errors };
    // Catalog entries are checked normalized definitions. They never become content in this pack.
    const catalog = new Map(array(definitions).map(def => [def.id, def]));
    for (const definition of normalized) catalog.set(definition.id, definition);
    for (const [i, definition] of normalized.entries()) {
        const at = `content.dataModules[${i}]`;
        const inputs = {};
        for (const [alias, entry] of entries(definition.imports)) {
            if (!dmObject(entry)) continue;
            entry.args ??= {};
            inputs[alias] = {};
            if (entry.query === 'director.time' && array(entry.projection).includes('minutes')) inputs[alias].minutes = { type: 'int', min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER };
            if (entry.query !== 'dataModules.public') continue;
            const target = catalog.get(entry.args?.module);
            const exported = dmOwn(target?.exports, entry.args?.export) && target.exports[entry.args.export];
            if (!target || !exported) { add('DM_SCHEMA', `${at}.imports.${alias}.args`, 'Unknown data module/export; supply checked dependency definitions when importing another pack.'); continue; }
            if (target.scope === 'character' && !entry.args?.who) add('DM_SCHEMA', `${at}.imports.${alias}.args.who`, 'A character export requires an explicit canonical subject.');
            if (target.scope === 'chat' && entry.args?.who !== undefined) add('DM_SCHEMA', `${at}.imports.${alias}.args.who`, 'A chat export has no character subject.');
            for (const field of array(entry.projection)) {
                if (!array(exported.fields).includes(field) || !dmOwn(target.state, field)) add('DM_SCHEMA', `${at}.imports.${alias}.projection`, 'Projection must select fields of the named public export.');
                else inputs[alias][field] = target.state[field].type === 'map' ? { type: 'map' } : fieldType(target.state[field]);
            }
        }
        const env = { state: definition.state, inputs, templates: definition.rewards, offerKeys: collectOffers(definition) };
        for (const [name, reward] of named(definition.rewards, L.templates, `${at}.rewards`, add)) {
            const path = `${at}.rewards.${name}`;
            if (!shape(reward, D.reward, path, add)) continue;
            for (const [key, schema] of named(reward.bindings, L.fields, `${path}.bindings`, add)) scalar(schema, `${path}.bindings.${key}`, add, { label: true });
            const rewardEnv = { ...env, bindings: reward.bindings, rewards: rewardTypes(reward, path, add) };
            if (reward.when !== undefined) conditionType(reward.when, rewardEnv, `${path}.when`, add);
            reward.when ??= true;
            effects(reward.effects, rewardEnv, `${path}.effects`, add, { reward: true });
        }
        for (const [name, kind] of named(definition.kinds, L.kinds, `${at}.kinds`, add)) {
            const path = `${at}.kinds.${name}`;
            if (!shape(kind, D.kind, path, add)) continue;
            if (kind.check !== undefined) add('DM_SCHEMA', `${path}.check`, 'SD checks inside a dm root need data-modules v1.1; this definition needs data-modules v1.1.');
            if (!D.ops.includes(kind.op)) add('DM_SCHEMA', `${path}.op`, `A kind op must be ${D.ops.join(', ')}.`);
            if (kind.ui !== undefined && typeof kind.ui !== 'boolean') add('DM_SCHEMA', `${path}.ui`, 'ui must be a boolean.');
            if (kind.title !== undefined) {
                if (typeof kind.title !== 'string' || !oneLine(kind.title) || [...kind.title].length > 60) add('DM_SCHEMA', `${path}.title`, STRINGS.blocks.labelLimit);
                else kind.title = oneLine(kind.title);
            }
            if (kind.refusal !== undefined && (typeof kind.refusal !== 'string' || !kind.refusal.trim() || kind.refusal.length > L.text || /[\u0000-\u001f\u007f]/.test(kind.refusal))) add('DM_SCHEMA', `${path}.refusal`, `A refusal is bounded safe text of at most ${L.text} characters.`);
            for (const [key, schema] of named(kind.labels, L.fields, `${path}.labels`, add, { label: true })) {
                if (['kind', 'who'].includes(key)) add('DM_LABEL', `${path}.labels.${key}`, 'kind and who are host-reserved labels.');
                scalar(schema, `${path}.labels.${key}`, add, { label: true });
            }
            const claims = kind.oncePerReply ?? [];
            if (!Array.isArray(claims) || new Set(claims).size !== claims.length || claims.some(key => !dmOwn(kind.labels, key) || kind.labels[key]?.type !== 'enum')) add('DM_LABEL', `${path}.oncePerReply`, 'oncePerReply must list distinct declared enum labels.');
            const kindEnv = { ...env, args: kind.labels };
            if (kind.when !== undefined) conditionType(kind.when, kindEnv, `${path}.when`, add);
            effects(kind.effects, kindEnv, `${path}.effects`, add);
            kind.oncePerReply = claims;
            kind.when ??= true;
            kind.ui ??= false;
        }
        blockFunctions(definition, env, at, add);
        if (!errors.length && (definition.prompt !== undefined || definition.show !== undefined || packId === 'chat')) {
            const lines = fullModuleGrammar(definition, definition.id);
            if ([...lines].length > L.staticCharacters) add('DM_BUDGET', `${at}.prompt`, STRINGS.blocks.staticLimit);
        }
        const ids = new Set();
        if (sized(definition.rules, L.rules, `${at}.rules`, add, { list: true })) definition.rules.forEach((rule, j) => {
            const path = `${at}.rules[${j}]`;
            if (!shape(rule, D.rule, path, add)) return;
            if (!dmSlug(rule.id) || ids.has(rule.id)) add('DM_SCHEMA', `${path}.id`, 'Rule IDs must be unique safe slugs.');
            ids.add(rule.id);
            conditionType(rule.when, env, `${path}.when`, add);
            effects(rule.then, env, `${path}.then`, add);
        });
        ids.clear();
        if (sized(definition.timers, L.timers, `${at}.timers`, add, { list: true })) definition.timers.forEach((timer, j) => {
            const path = `${at}.timers[${j}]`;
            if (!shape(timer, D.timer, path, add)) return;
            if (!dmSlug(timer.id) || ids.has(timer.id)) add('DM_SCHEMA', `${path}.id`, 'Timer IDs must be unique safe slugs.');
            ids.add(timer.id);
            const clock = dmOwn(definition.imports, timer.clock) && definition.imports[timer.clock];
            if (!clock || clock.query !== 'director.time' || clock.mode !== 'prefix' || !array(clock.projection).includes('minutes')) add('DM_SCHEMA', `${path}.clock`, 'A timer clock must be a declared prefix SD minute import.');
            if (!dmInt(timer.every, 1, L.elapsedMinutes)) add('DM_BOUNDS', `${path}.every`, `every must be 1 to ${L.elapsedMinutes} minutes.`);
            effects(timer.effects, { ...env, timer: { every: dmInt(timer.every, 1) ? timer.every : 1 } }, `${path}.effects`, add, { timer: true });
        });
        for (const [key, exported] of named(definition.exports, L.fields, `${at}.exports`, add)) {
            const path = `${at}.exports.${key}`;
            if (!shape(exported, D.export, path, add)) continue;
            if (!Array.isArray(exported.fields) || !exported.fields.length || new Set(exported.fields).size !== exported.fields.length || exported.fields.some(field => !dmOwn(definition.state, field))) add('DM_SCHEMA', `${path}.fields`, 'An export lists distinct declared fields only.');
        }
        presentation(definition, at, add);
        if (byteLength(JSON.stringify(definition)) > L.definitionBytes) add('DM_BUDGET', at, `A normalized definition must fit ${L.definitionBytes} UTF-8 JSON bytes.`);
        // Only form-valid schemas can have defaults calculated.
        if (!errors.length) {
            const instance = { fields: dataModuleDefaults(definition.state), timers: {}, offers: {}, settled: {} };
            if (byteLength(JSON.stringify(instance)) > L.instanceBytes) add('DM_BUDGET', `${at}.state`, `Default instance exceeds ${L.instanceBytes} UTF-8 JSON bytes.`);
        }
    }
    // Bounded DFS over the checked catalog. Cross-pack cycles use the same algorithm.
    const visiting = new Set(), visited = new Set();
    const visit = definition => {
        if (visiting.has(definition.id)) { add('DM_SCHEMA', 'content.dataModules', `Public data module imports form a cycle at ${definition.id}.`); return; }
        if (visited.has(definition.id)) return;
        visiting.add(definition.id);
        for (const [, entry] of entries(definition.imports)) {
            const target = entry?.query === 'dataModules.public' && catalog.get(entry.args?.module);
            if (target) visit(target);
        }
        visiting.delete(definition.id);
        visited.add(definition.id);
    };
    normalized.forEach(visit);
    return errors.length ? { ok: false, errors } : { ok: true, definitions: normalized };
}

/** Hash checked normalized definitions only; envelope identity is deliberately separate. */
export function dataModuleHash(definition) {
    return sha256(JSON.stringify(stable({ definition, ...HASH_BASIS_V1 })));
}

/** Whole normalized pack identity; added only for packs containing dataModules. */
export function dataModulesPackHash(pack) {
    return sha256(JSON.stringify(stable(pack)));
}

/** Compare two CHECKED definitions. New fields/defaults are the only mechanical changes. */
export function validateDataMigration(oldDefinition, target) {
    const errors = [];
    const add = (path, message) => { if (errors.length < L.errors) errors.push({ code: 'DM_SCHEMA', path, message }); };
    if (!dmObject(oldDefinition) || !dmObject(target)) return { ok: false, errors: [{ code: 'DM_SCHEMA', path: '', message: 'Migration requires two checked definitions.' }] };
    if (oldDefinition.id !== target.id || !dmInt(oldDefinition.stateVersion, 1) || !dmInt(target.stateVersion, oldDefinition.stateVersion + 1)) add('stateVersion', 'Migration must advance the same module to a higher stateVersion; downgrade refuses.');
    const mutable = new Set(['state', 'stateVersion', 'migrations', 'name', 'screens', 'layouts']);
    for (const key of new Set([...Object.keys(oldDefinition), ...Object.keys(target)])) if (!mutable.has(key) && !same(oldDefinition[key], target[key])) add(key, 'Existing mechanics must retain identical semantics; this change needs a new timeline.');
    for (const [field, schema] of entries(oldDefinition.state)) if (!dmOwn(target.state, field) || !same(schema, target.state[field])) add(`state.${field}`, 'Old fields cannot be removed, retyped, reset or have changed bounds/defaults.');
    let version = oldDefinition.stateVersion;
    const additions = {};
    for (const step of array(target.migrations)) {
        if (step.from !== version) continue;
        version = step.to;
        for (const [field, schema] of entries(step.add)) {
            if (dmOwn(oldDefinition.state, field) || dmOwn(additions, field)) add(`migrations.${field}`, 'A migration may add only new fields once.');
            additions[field] = schema;
        }
    }
    const expected = Object.fromEntries(entries(target.state).filter(([key]) => !dmOwn(oldDefinition.state, key)));
    if (version !== target.stateVersion || !same(expected, additions)) add('migrations', 'An adjacent additive migration chain must account for every new field and default.');
    return errors.length ? { ok: false, errors } : { ok: true, add: copy(additions) };
}
