// map: places and routes, with layers (floors, surface/underground), the reader's position, fog over
// undiscovered places, pan (pointer drag, arrow keys), zoom (wheel, pinch, +/− buttons and keys, reset),
// a minimap with the viewport box, and a legend of the kinds on show.
//
// Routes are drawn in an SVG in world units; places are HTML elements over it, positioned by the custom
// properties `--ss-w-x` / `--ss-w-y` (percent of the stage), so their icons can be Font Awesome glyphs,
// their names stay crisp at any zoom, and each selectable place is a real button (focus, Enter, Space).
// Clicking a place runs `onSelect` with `{ node: <id> }` when the screen gives a command.

import { docOf, h, humanize, iconNode, num, runCommand, s, setData, shell, str } from './dom.js';
import {
    DEFAULT_ASPECT, autoLayout, centerOn, clampView, clientToWorld, fitView, minimapBox, minimapToWorld,
    panBy, toPercent, unitsPerPixel, withAspect, worldBounds, zoomAt, zoomLevel,
} from './map-math.js';
import { defineWidget, resolveProps } from './props.js';

const MAX_NODES = 2000;
const MAX_EDGES = 4000;
const DRAG_THRESHOLD = 4;     // pixels before a press becomes a drag (and the click on a place is dropped)
const BUTTON_ZOOM = 1.25;
const KEY_PAN = 0.1;          // share of the view an arrow key moves
const WHEEL_RATE = 0.002;

const props = {
    nodes: { type: 'array', required: true, default: Object.freeze([]) },   // [{ id, name, x, y, icon, layer, kind }]
    edges: { type: 'array', default: Object.freeze([]) },                   // [{ from, to, kind }]
    layers: { type: 'array', default: null },                               // ['surface'] or [{ id, name }]
    layer: { type: 'string', default: '' },                                 // the layer to show first
    current: { type: 'string', default: '' },                               // the reader's place
    discovered: { type: 'array', default: null },                           // ids; null: everything is known
    fog: { type: 'string', default: 'hide' },                               // 'hide' | 'unknown'
    kinds: { type: 'object', default: null },                               // { kind: { label, icon } }
    onSelect: { type: 'string', default: '' },                              // command run with { node }
    label: { type: 'string', default: 'Map' },
    minimap: { type: 'boolean', default: true },
    legend: { type: 'boolean', default: true },
};

const fmt4 = value => String(Math.round(value * 10000) / 10000);

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

function render(el, input, api) {
    return shell(el, 'div', 'map', ({ doc, root, listen, cleanup }) => {
        root.setAttribute('role', 'group');

        const bar = h(doc, 'div', 'ss-w-map-bar');
        const layersBar = h(doc, 'div', 'ss-w-map-layers');
        layersBar.setAttribute('role', 'toolbar');
        layersBar.setAttribute('aria-label', 'Map layers');
        const zoomBar = h(doc, 'div', 'ss-w-map-zoom');
        zoomBar.setAttribute('role', 'toolbar');
        zoomBar.setAttribute('aria-label', 'Zoom');
        const zoomButton = (cls, text, title) => {
            const button = h(doc, 'button', `ss-w-map-btn ${cls}`, text);
            button.setAttribute('type', 'button');
            button.setAttribute('title', title);
            button.setAttribute('aria-label', title);
            zoomBar.appendChild(button);
            return button;
        };
        const zoomIn = zoomButton('ss-w-map-zoom-in', '+', 'Zoom in');
        const zoomOut = zoomButton('ss-w-map-zoom-out', '−', 'Zoom out');
        const reset = zoomButton('ss-w-map-reset', '↺', 'Show the whole map');
        bar.append(layersBar, zoomBar);

        const body = h(doc, 'div', 'ss-w-map-body');
        const stage = h(doc, 'div', 'ss-w-map-stage');
        stage.setAttribute('tabindex', '0');
        stage.setAttribute('role', 'group');
        stage.setAttribute('aria-roledescription', 'map');
        stage.setAttribute('aria-label', 'Map view. Drag or use the arrow keys to move; scroll, pinch, or plus and minus to zoom; 0 shows the whole map.');
        const svg = s(doc, 'svg', { class: 'ss-w-map-svg', preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false' });
        const edgeLayer = s(doc, 'g', { class: 'ss-w-map-edges' });
        svg.appendChild(edgeLayer);
        const nodeLayer = h(doc, 'div', 'ss-w-map-nodes');
        nodeLayer.setAttribute('role', 'group');
        nodeLayer.setAttribute('aria-label', 'Places');
        stage.append(svg, nodeLayer);

        const side = h(doc, 'div', 'ss-w-map-side');
        const mini = s(doc, 'svg', { class: 'ss-w-map-mini', preserveAspectRatio: 'xMidYMid meet', 'aria-hidden': 'true', focusable: 'false' });
        const miniEdges = s(doc, 'g', { class: 'ss-w-map-mini-edges' });
        const miniNodes = s(doc, 'g', { class: 'ss-w-map-mini-nodes' });
        const viewport = s(doc, 'rect', { class: 'ss-w-map-viewport', 'vector-effect': 'non-scaling-stroke' });
        mini.append(miniEdges, miniNodes, viewport);
        // The legend is a strong-glass list card (cards over busy art use the strong glass; the ss.listcard classes): a label, then one row per kind on show.
        const legend = h(doc, 'div', 'ss-w-map-legend ss-glass-strong ss-listcard');
        const legendTitle = h(doc, 'p', 'ss-w-map-legend-title', 'Legend');
        const legendList = h(doc, 'ul', 'ss-listcard-rows ss-w-map-legend-list');
        legend.append(legendTitle, legendList);
        side.append(mini, legend);
        body.append(stage, side);
        const empty = h(doc, 'p', 'ss-w-empty-note', 'No places to show yet.');
        root.append(bar, body, empty);

        let p = resolveProps(props, input);
        let all = { nodes: [], edges: [], positions: {}, layers: [] };
        let layer = '';
        let shown = { nodes: [], edges: [] };
        let world = worldBounds([]);
        let aspect = DEFAULT_ASPECT;
        let view = fitView(world, aspect);
        let placed = [];                     // [{ el, node }] for the HTML places
        const elementIds = new Map();        // place element → node id
        const layerButtons = new Map();      // button → layer id

        const position = node => all.positions[node.id];

        function measure() {
            const rect = stage.getBoundingClientRect?.();
            if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
            const next = rect.width / rect.height;
            if (Math.abs(next - aspect) > 1e-3) {
                aspect = next;
                view = clampView(withAspect(view, aspect), world);
                paintView();
            }
            return rect;
        }

        function setView(next) {
            view = next;
            paintView();
        }

        // Everything that depends on the view only: cheap enough to run on every pointer move.
        function paintView() {
            svg.setAttribute('viewBox', `${fmt4(view.x)} ${fmt4(view.y)} ${fmt4(view.w)} ${fmt4(view.h)}`);
            for (const { el: node, node: data } of placed) {
                const at = toPercent(view, position(data).x, position(data).y);
                node.style.setProperty('--ss-w-x', String(at.left));
                node.style.setProperty('--ss-w-y', String(at.top));
            }
            const box = minimapBox(view, world);
            viewport.setAttribute('x', fmt4(box.x));
            viewport.setAttribute('y', fmt4(box.y));
            viewport.setAttribute('width', fmt4(box.w));
            viewport.setAttribute('height', fmt4(box.h));
            const zoom = zoomLevel(view, world, aspect);
            stage.style.setProperty('--ss-w-zoom', String(Math.round(zoom * 100) / 100));
            stage.setAttribute('data-zoom', String(Math.round(zoom * 100) / 100));
        }

        function defaultLayer() {
            const layers = all.layers;
            if (!layers.length) return '';
            const fromProp = layers.find(item => item.id === p.layer);
            if (fromProp) return fromProp.id;
            const here = all.nodes.find(node => node.id === p.current);
            if (here?.layer && layers.some(item => item.id === here.layer)) return here.layer;
            return layers[0].id;
        }

        function drawLayers() {
            layerButtons.clear();
            const buttons = all.layers.map(item => {
                const button = h(doc, 'button', 'ss-w-map-layer', item.name);
                button.setAttribute('type', 'button');
                button.setAttribute('aria-pressed', String(item.id === layer));
                setData(button, 'layer', item.id);
                if (item.id === layer) button.classList.add('ss-w-active');
                layerButtons.set(button, item.id);
                return button;
            });
            layersBar.replaceChildren(...buttons);
            layersBar.hidden = buttons.length < 2;
        }

        function kindInfo(kind) {
            const entry = p.kinds && typeof p.kinds === 'object' ? p.kinds[kind] : null;
            return entry && typeof entry === 'object' ? { label: str(entry.label), icon: str(entry.icon) } : { label: '', icon: '' };
        }

        function drawShown() {
            elementIds.clear();
            const selectable = Boolean(p.onSelect) && typeof api?.command === 'function';
            edgeLayer.replaceChildren(...shown.edges.map(edge => {
                const a = all.positions[edge.from], b = all.positions[edge.to];
                const line = s(doc, 'line', {
                    class: 'ss-w-map-edge', x1: fmt4(a.x), y1: fmt4(a.y), x2: fmt4(b.x), y2: fmt4(b.y), 'vector-effect': 'non-scaling-stroke',
                });
                setData(line, 'kind', edge.kind);
                const fogged = shown.nodes.some(node => node.unknown && (node.id === edge.from || node.id === edge.to));
                if (fogged) line.classList.add('ss-w-unknown');
                return line;
            }));
            placed = shown.nodes.map(node => {
                const here = node.id === p.current;
                const clickable = selectable && !node.unknown;
                const item = h(doc, clickable ? 'button' : 'div', 'ss-w-map-node');
                if (clickable) item.setAttribute('type', 'button');
                if (!clickable) item.setAttribute('role', 'img');
                setData(item, 'kind', node.kind);
                setData(item, 'layer', node.layer);
                item.setAttribute('data-id', node.id);
                const glyph = node.unknown ? null : iconNode(doc, node.icon || kindInfo(node.kind).icon, 'ss-w-icon ss-w-map-icon');
                item.appendChild(glyph ?? h(doc, 'span', 'ss-w-map-dot', node.unknown ? '?' : ''));
                if (!node.unknown) item.appendChild(h(doc, 'span', 'ss-w-map-name', node.name));
                const kindText = kindInfo(node.kind).label || humanize(node.kind);
                const spoken = node.unknown ? 'Unexplored place' : [node.name, kindText && `(${kindText})`].filter(Boolean).join(' ');
                item.setAttribute('aria-label', here ? `${spoken}, you are here` : spoken);
                if (node.unknown) item.classList.add('ss-w-unknown');
                if (here) {
                    item.classList.add('ss-w-current');
                    item.setAttribute('aria-current', 'location');
                }
                if (clickable) item.classList.add('ss-w-selectable');
                elementIds.set(item, node.id);
                return { el: item, node };
            });
            nodeLayer.replaceChildren(...placed.map(entry => entry.el));

            mini.setAttribute('viewBox', `${fmt4(world.x)} ${fmt4(world.y)} ${fmt4(world.w)} ${fmt4(world.h)}`);
            miniEdges.replaceChildren(...shown.edges.map(edge => {
                const a = all.positions[edge.from], b = all.positions[edge.to];
                return s(doc, 'line', { class: 'ss-w-map-mini-edge', x1: fmt4(a.x), y1: fmt4(a.y), x2: fmt4(b.x), y2: fmt4(b.y), 'vector-effect': 'non-scaling-stroke' });
            }));
            const dot = Math.max(world.w, world.h) * 0.015;
            miniNodes.replaceChildren(...shown.nodes.map(node => {
                const at = position(node);
                const circle = s(doc, 'circle', { class: 'ss-w-map-mini-node', cx: fmt4(at.x), cy: fmt4(at.y), r: fmt4(dot) });
                if (node.id === p.current) circle.classList.add('ss-w-current');
                if (node.unknown) circle.classList.add('ss-w-unknown');
                return circle;
            }));
            side.hidden = !p.minimap && !p.legend;
            mini.style.setProperty('display', p.minimap ? '' : 'none');
            drawLegend();
            empty.hidden = shown.nodes.length > 0;
            body.hidden = shown.nodes.length === 0;
        }

        function drawLegend() {
            const entries = [];
            const entry = (sample, text) => {
                const li = h(doc, 'li', 'ss-listcard-row ss-w-map-legend-item');
                const item = h(doc, 'div', 'ss-listcard-item');
                item.append(sample, h(doc, 'span', 'ss-w-map-legend-text', text));
                li.appendChild(item);
                entries.push(li);
            };
            const kinds = [];
            for (const node of shown.nodes) if (node.kind && !kinds.includes(node.kind)) kinds.push(node.kind);
            for (const kind of kinds) {
                const info = kindInfo(kind);
                const iconSource = info.icon || shown.nodes.find(node => node.kind === kind && node.icon)?.icon;
                const sample = h(doc, 'span', 'ss-w-map-legend-sample ss-w-map-node-sample');
                setData(sample, 'kind', kind);
                const glyph = iconNode(doc, iconSource);
                sample.appendChild(glyph ?? h(doc, 'span', 'ss-w-map-dot'));
                entry(sample, info.label || humanize(kind));
            }
            const edgeKinds = [];
            for (const edge of shown.edges) if (edge.kind && !edgeKinds.includes(edge.kind)) edgeKinds.push(edge.kind);
            for (const kind of edgeKinds) {
                const sample = h(doc, 'span', 'ss-w-map-legend-sample ss-w-map-edge-sample');
                setData(sample, 'kind', kind);
                entry(sample, kindInfo(kind).label || humanize(kind));
            }
            if (shown.nodes.some(node => node.id === p.current)) entry(h(doc, 'span', 'ss-w-map-legend-sample ss-w-map-here-sample'), 'You are here');
            if (shown.nodes.some(node => node.unknown)) entry(h(doc, 'span', 'ss-w-map-legend-sample ss-w-map-unknown-sample', '?'), 'Unexplored');
            legendList.replaceChildren(...entries);
            legend.hidden = !p.legend || entries.length === 0;
        }

        function computeShown() {
            const discovered = Array.isArray(p.discovered) ? new Set(p.discovered.map(str)) : null;
            shown = visibleOnLayer({ nodes: all.nodes, edges: all.edges, layer, discovered, current: p.current, fog: p.fog });
            world = worldBounds(shown.nodes.map(position));
        }

        function setLayer(id, { refit = true } = {}) {
            layer = id;
            computeShown();
            drawLayers();
            if (refit) view = fitView(world, aspect);
            else view = clampView(withAspect(view, aspect), world);
            drawShown();
            paintView();
        }

        function load(next, first) {
            const previousLayerProp = p.layer;
            p = resolveProps(props, next);
            root.setAttribute('aria-label', p.label || 'Map');
            const nodes = mapNodes(p.nodes);
            const ids = new Set(nodes.map(node => node.id));
            const edges = mapEdges(p.edges, ids);
            all = { nodes, edges, positions: autoLayout(nodes, edges), layers: mapLayers(p.layers, nodes) };
            let nextLayer = layer;
            if (first || p.layer !== previousLayerProp || !all.layers.some(item => item.id === layer)) nextLayer = defaultLayer();
            setLayer(nextLayer, { refit: first || nextLayer !== layer });
        }

        // Pointer pan and pinch zoom.
        const pointers = new Map();
        let moved = 0;
        let captured = null;
        let dropClick = false;
        listen(stage, 'pointerdown', event => {
            if (event.pointerType === 'mouse' && event.button !== undefined && event.button !== 0) return;
            measure();
            if (!pointers.size) {
                moved = 0;
                dropClick = false;
            }
            pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        });
        listen(stage, 'pointermove', event => {
            const before = pointers.get(event.pointerId);
            if (!before) return;
            const rect = stage.getBoundingClientRect?.();
            if (!rect || !(rect.width > 0) || !(rect.height > 0)) return;
            if (pointers.size === 1) {
                const dx = event.clientX - before.x, dy = event.clientY - before.y;
                moved += Math.abs(dx) + Math.abs(dy);
                pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
                if (moved > DRAG_THRESHOLD && captured === null) {
                    // Capture only once it is a drag: capturing on press would retarget the click on a place.
                    captured = event.pointerId;
                    try { stage.setPointerCapture?.(event.pointerId); } catch { /* not capturable */ }
                    stage.classList.add('ss-w-dragging');
                }
                const unit = unitsPerPixel(view, rect);
                setView(panBy(view, -dx * unit.x, -dy * unit.y, world));
                return;
            }
            const [a, b] = [...pointers.values()];
            const oldMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            const oldDistance = Math.hypot(a.x - b.x, a.y - b.y);
            pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
            const [c, d] = [...pointers.values()];
            const newMid = { x: (c.x + d.x) / 2, y: (c.y + d.y) / 2 };
            const newDistance = Math.hypot(c.x - d.x, c.y - d.y);
            moved = Infinity;
            const at = clientToWorld(view, rect, oldMid.x, oldMid.y);
            let next = oldDistance > 0 && newDistance > 0 ? zoomAt(view, newDistance / oldDistance, at.x, at.y, world) : view;
            const unit = unitsPerPixel(next, rect);
            next = panBy(next, -(newMid.x - oldMid.x) * unit.x, -(newMid.y - oldMid.y) * unit.y, world);
            setView(next);
        });
        const release = event => {
            if (!pointers.delete(event.pointerId)) return;
            if (pointers.size) return;
            if (moved > DRAG_THRESHOLD) dropClick = true;
            if (captured !== null) {
                try { stage.releasePointerCapture?.(captured); } catch { /* already released */ }
                captured = null;
            }
            stage.classList.remove('ss-w-dragging');
        };
        listen(stage, 'pointerup', release);
        listen(stage, 'pointercancel', release);
        // A drag that ends on a place must not select it.
        listen(stage, 'click', event => {
            if (!dropClick) return;
            dropClick = false;
            event.stopPropagation();
            event.preventDefault?.();
        }, true);

        listen(stage, 'wheel', event => {
            const rect = measure();
            if (!rect) return;
            event.preventDefault?.();
            const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * rect.height : event.deltaY;
            const at = clientToWorld(view, rect, event.clientX, event.clientY);
            setView(zoomAt(view, Math.exp(-num(delta, 0) * WHEEL_RATE), at.x, at.y, world));
        }, { passive: false });

        const zoomCentre = factor => {
            measure();
            setView(zoomAt(view, factor, view.x + view.w / 2, view.y + view.h / 2, world));
        };
        const fit = () => {
            measure();
            setView(fitView(world, aspect));
        };
        listen(zoomIn, 'click', () => zoomCentre(BUTTON_ZOOM));
        listen(zoomOut, 'click', () => zoomCentre(1 / BUTTON_ZOOM));
        listen(reset, 'click', fit);

        listen(stage, 'keydown', event => {
            const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
            if (step) {
                setView(panBy(view, step[0] * view.w * KEY_PAN, step[1] * view.h * KEY_PAN, world));
            } else if (event.key === '+' || event.key === '=') zoomCentre(BUTTON_ZOOM);
            else if (event.key === '-' || event.key === '_') zoomCentre(1 / BUTTON_ZOOM);
            else if (event.key === '0' || event.key === 'Home') fit();
            else return;
            event.preventDefault?.();
        });

        listen(nodeLayer, 'click', event => {
            for (let node = event.target; node && node !== nodeLayer; node = node.parentNode) {
                if (!elementIds.has(node)) continue;
                const id = elementIds.get(node);
                const data = shown.nodes.find(item => item.id === id);
                if (data && !data.unknown && node.tagName?.toLowerCase() === 'button') runCommand(api, p.onSelect, { node: id });
                return;
            }
        });

        listen(layersBar, 'click', event => {
            for (let node = event.target; node && node !== layersBar; node = node.parentNode) {
                if (!layerButtons.has(node)) continue;
                const id = layerButtons.get(node);
                if (id !== layer) setLayer(id);
                return;
            }
        });

        listen(mini, 'pointerdown', event => {
            const rect = mini.getBoundingClientRect?.();
            if (!rect || !(rect.width > 0) || !(rect.height > 0)) return;
            const at = minimapToWorld(world, rect, event.clientX, event.clientY);
            setView(centerOn(view, at.x, at.y, world));
        });

        const Observer = docOf(el).defaultView?.ResizeObserver ?? globalThis.ResizeObserver;
        if (typeof Observer === 'function') {
            const observer = new Observer(() => measure());
            observer.observe(stage);
            cleanup(() => observer.disconnect());
        }

        load(input, true);
        if (measure()) setView(fitView(world, aspect));
        return { update: next => load(next, false) };
    });
}

export const map = defineWidget({ props, primary: 'nodes', render });
