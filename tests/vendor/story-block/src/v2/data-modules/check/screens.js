// Data-modules checker, screens part: the presentation a definition declares (editable props, screens, action payloads,
// template payloads and view paths). Pure: no state is read. check.js keeps the public path of each export.

import { E, array, entries, named, names, same, shape } from './shape.js';
import { compatible, expressionType, fieldType } from '../expressions.js';
import { BLOCK_NODE_WIDGETS, FIELDS_WIDGET, fieldsNodeProblems } from '../fields-widget.js';
import { dmObject, dmOwn } from '../schema.js';
import { validateLayout } from '../../layout/validate.js';
import { checkScreens } from '../../packs/validate/theme.js';
import { validateScreen } from '../../view/screens.js';
import { parseHtml } from '../../view/template/html.js';

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

export function presentation(definition, path, add) {
    // Reuse the shipped presentation validators. Ordinary packs keep their current acceptance.
    checkScreens(definition.screens, 'data-module', (code, at, message) => add('DM_SCHEMA', `${path}.${at}`, message));
    const rendererCheck = (fn, at) => {
        try { for (const message of fn()) add('DM_SCHEMA', at, message); }
        catch { add('DM_SCHEMA', at, 'Presentation must satisfy the existing renderer contract.'); }
    };
    if (!Array.isArray(definition.layouts)) add('DM_SCHEMA', `${path}.layouts`, 'layouts must be a list of existing renderer layouts.');
    const seen = new Set();
    array(definition.layouts).forEach((layout, i) => {
        rendererCheck(() => validateLayout(layout, { widgets: BLOCK_NODE_WIDGETS }), `${path}.layouts[${i}]`);
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
        if (value.type === FIELDS_WIDGET) for (const { at: where, message } of fieldsNodeProblems(definition, value.props)) add('DM_SCHEMA', `${at}.props${where}`, message);
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
        if (screen?.layout) rendererCheck(() => validateLayout(screen.layout, { meta: false, widgets: BLOCK_NODE_WIDGETS }), `${at}.layout`);
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
