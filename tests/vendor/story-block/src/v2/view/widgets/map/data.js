// Map data cleaning and layer visibility: string ids, finite positions, known edges, ordered layers, and
// what is shown on a layer under the current fog. Pure; map.js re-exports these beside the widget.

import { humanize, num, str } from '../dom.js';

const MAX_NODES = 2000;
const MAX_EDGES = 4000;

/** Clean nodes: string ids (first of each id kept), numbers or null for x/y. */
export function mapNodes(list) {
    const seen = new Set();
    const out = [];
    for (const item of Array.isArray(list) ? list : []) {
        if (!item || typeof item !== 'object') continue;
        const id = str(item.id);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const x = num(item.x, NaN), y = num(item.y, NaN);
        out.push({
            id,
            name: str(item.name) || id,
            x: Number.isFinite(x) && Number.isFinite(y) ? x : null,
            y: Number.isFinite(x) && Number.isFinite(y) ? y : null,
            icon: str(item.icon),
            layer: str(item.layer),
            kind: str(item.kind),
        });
        if (out.length >= MAX_NODES) break;
    }
    return out;
}

/** Clean edges between known nodes. */
export function mapEdges(list, ids) {
    const out = [];
    for (const item of Array.isArray(list) ? list : []) {
        if (!item || typeof item !== 'object') continue;
        const from = str(item.from), to = str(item.to);
        if (!ids.has(from) || !ids.has(to) || from === to) continue;
        out.push({ from, to, kind: str(item.kind) });
        if (out.length >= MAX_EDGES) break;
    }
    return out;
}

/** Layers from the prop (strings or { id, name }), else from the nodes' `layer` values in order. */
export function mapLayers(list, nodes) {
    const out = [];
    const seen = new Set();
    const add = (id, name) => {
        if (!id || seen.has(id)) return;
        seen.add(id);
        out.push({ id, name: name || humanize(id) || id });
    };
    if (Array.isArray(list) && list.length) {
        for (const item of list) {
            if (typeof item === 'string') add(item, '');
            else if (item && typeof item === 'object') add(str(item.id), str(item.name));
        }
    } else {
        for (const node of nodes) add(node.layer, '');
    }
    return out;
}

/**
 * What the map shows on a layer: discovered places on it (or on no layer), plus — with fog 'unknown' —
 * undiscovered places next to a discovered one, shown without their names. Edges join shown places.
 */
export function visibleOnLayer({ nodes, edges, layer, discovered, current, fog }) {
    const known = id => !discovered || discovered.has(id) || id === current;
    const onLayer = node => !layer || !node.layer || node.layer === layer;
    const shown = new Map();
    for (const node of nodes) if (onLayer(node) && known(node.id)) shown.set(node.id, { ...node, unknown: false });
    if (fog === 'unknown' && discovered) {
        const byId = new Map(nodes.map(node => [node.id, node]));
        for (const edge of edges) {
            for (const [a, b] of [[edge.from, edge.to], [edge.to, edge.from]]) {
                const other = byId.get(b);
                if (shown.has(a) && !shown.has(b) && !shown.get(a).unknown && onLayer(other)) {
                    shown.set(b, { ...other, name: '', icon: '', kind: '', unknown: true });
                }
            }
        }
    }
    const order = nodes.filter(node => shown.has(node.id)).map(node => shown.get(node.id));
    const links = edges.filter(edge => shown.has(edge.from) && shown.has(edge.to)
        && !(shown.get(edge.from).unknown && shown.get(edge.to).unknown));
    return { nodes: order, edges: links };
}
