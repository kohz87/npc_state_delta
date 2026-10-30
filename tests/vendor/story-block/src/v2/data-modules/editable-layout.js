// Add an editor beside a displayed local field in a data-module layout. Authored templates opt in with ss.editable.
import { validateLayout } from '../layout/validate.js';
import { standardWidgets } from '../view/widgets/index.js';

function propsFor(module, field, key, schema, label) {
    const scalar = schema.type === 'map' ? schema.values : schema;
    if (schema.edit === false || scalar.edit === false) return null;
    const props = { valueKey: 'value', displayValue: false, label, command: 'dm.set', payload: { module, field, ...(key ? { key } : {}) } };
    if (scalar.type === 'int') Object.assign(props, { kind: 'number', min: scalar.min, max: scalar.max });
    else if (scalar.type === 'enum') Object.assign(props, { kind: 'choice', options: scalar.values });
    else if (scalar.type === 'bool') Object.assign(props, { kind: 'choice', options: [true, false] });
    else if (scalar.type === 'text') Object.assign(props, { kind: 'text', maxLength: scalar.max });
    else return null;
    return props;
}

export function editableLayout(layout, definition) {
    if (!layout?.root) return layout;
    function visit(node, characterRow = false) {
        if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
        const next = { ...node };
        if (Array.isArray(node.children)) next.children = node.children.map(child => visit(child, characterRow));
        const characters = definition.scope === 'character' && node.type === 'list' && node.bind?.query === 'dataModules.view'
            && node.bind.args?.module === definition.id && node.bind.path === 'characters';
        if (node.item) next.item = visit(node.item, characters);
        if (Array.isArray(node.pages)) next.pages = node.pages.map(page => ({ ...page, node: visit(page.node, characterRow) }));
        if (!['text', 'badge', 'meter'].includes(node.type)) return next;
        const bind = node.bind ?? node.value;
        let parts;
        if (definition.scope === 'chat' && bind?.query === 'dataModules.view' && bind.args?.module === definition.id && typeof bind.path === 'string') {
            parts = bind.path.split('.');
            if (parts.shift() !== 'chat') return next;
        } else if (characterRow && typeof bind === 'string' && bind.startsWith('$item.')) parts = bind.slice(6).split('.');
        else return next;
        const [field, key] = parts;
        const schema = Object.hasOwn(definition.state, field) ? definition.state[field] : null;
        if (!schema || parts.length !== (schema.type === 'map' ? 2 : 1) || (schema.type === 'map' && !schema.keys.includes(key))) return next;
        const props = propsFor(definition.id, field, key, schema, typeof node.label === 'string' ? node.label : field);
        if (!props) return next;
        if (characterRow) props.payload.who = '$item.id';
        return { type: 'row', children: [next, { type: 'ss.editable', bind: typeof bind === 'string' ? bind : { ...bind }, props }] };
    }
    const result = { ...layout, root: visit(layout.root) };
    // Existing valid layouts can already be at the renderer's size limit. Never make them fail to draw.
    return validateLayout(result, { widgets: standardWidgets, meta: false }).length ? layout : result;
}
