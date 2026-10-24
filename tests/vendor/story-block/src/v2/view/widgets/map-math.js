// Pure maths for the map widget: world bounds, the view rectangle (what part of the world is shown),
// zoom about a point, pan with limits, screen ↔ world conversion, the minimap's viewport box, and the
// deterministic auto-layout for nodes that have no coordinates.
//
// A view is `{ x, y, w, h }` in world units: the rectangle of the world the stage shows. Its aspect
// (w / h) always matches the stage's, so the SVG (preserveAspectRatio="none") and the HTML node layer
// line up exactly.

export const DEFAULT_ASPECT = 4 / 3;
export const ZOOM_IN_LIMIT = 8;       // at most 8× closer than "fit"
export const ZOOM_OUT_LIMIT = 0.5;    // at most 2× further than "fit"
const EMPTY_SPAN = 100;

const round = value => Math.round(value * 100) / 100;

/** World bounds of points, padded by 15% of the larger side (a lone point gets a 100-unit square first). */
export function worldBounds(points) {
    if (!points.length) return { x: -EMPTY_SPAN / 2, y: -EMPTY_SPAN / 2, w: EMPTY_SPAN, h: EMPTY_SPAN };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const { x, y } of points) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    if (maxX === minX && maxY === minY) {
        minX -= EMPTY_SPAN / 2; maxX += EMPTY_SPAN / 2;
        minY -= EMPTY_SPAN / 2; maxY += EMPTY_SPAN / 2;
    }
    const span = Math.max(maxX - minX, maxY - minY);
    const pad = span * 0.15;
    return { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
}

/** The view that shows the whole world at the given aspect, centred. */
export function fitView(world, aspect = DEFAULT_ASPECT) {
    const a = aspect > 0 && Number.isFinite(aspect) ? aspect : DEFAULT_ASPECT;
    const w = world.w / world.h > a ? world.w : world.h * a;
    const h = w / a;
    return { x: world.x + world.w / 2 - w / 2, y: world.y + world.h / 2 - h / 2, w, h };
}

/** The same view (same centre and width) at a new aspect. */
export function withAspect(view, aspect) {
    if (!(aspect > 0) || !Number.isFinite(aspect)) return view;
    const h = view.w / aspect;
    return { x: view.x, y: view.y + view.h / 2 - h / 2, w: view.w, h };
}

/** Zoom level relative to "fit": 1 shows the whole world, 2 is twice as close. */
export function zoomLevel(view, world, aspect) {
    return fitView(world, aspect).w / view.w;
}

/**
 * Zooms by `factor` (> 1 closer) keeping the world point (fx, fy) where it is on screen, clamped to the
 * zoom limits relative to the fitted view.
 */
export function zoomAt(view, factor, fx, fy, world) {
    const fit = fitView(world, view.w / view.h);
    const w = Math.min(fit.w / ZOOM_OUT_LIMIT, Math.max(fit.w / ZOOM_IN_LIMIT, view.w / factor));
    const scale = w / view.w;
    const h = view.h * scale;
    return clampView({ x: fx - (fx - view.x) * scale, y: fy - (fy - view.y) * scale, w, h }, world);
}

/** Moves the view by (dx, dy) world units, keeping its centre inside the world. */
export function panBy(view, dx, dy, world) {
    return clampView({ ...view, x: view.x + dx, y: view.y + dy }, world);
}

/** Keeps the view's centre inside the world rectangle. */
export function clampView(view, world) {
    const cx = Math.min(world.x + world.w, Math.max(world.x, view.x + view.w / 2));
    const cy = Math.min(world.y + world.h, Math.max(world.y, view.y + view.h / 2));
    return { x: cx - view.w / 2, y: cy - view.h / 2, w: view.w, h: view.h };
}

/** Centres the view on a world point (same size). */
export function centerOn(view, x, y, world) {
    return clampView({ ...view, x: x - view.w / 2, y: y - view.h / 2 }, world);
}

/** The world point under a client (pixel) position on the stage. */
export function clientToWorld(view, rect, clientX, clientY) {
    return {
        x: view.x + ((clientX - rect.left) / rect.width) * view.w,
        y: view.y + ((clientY - rect.top) / rect.height) * view.h,
    };
}

/** World units per pixel (horizontal and vertical) for a stage of `rect`. */
export function unitsPerPixel(view, rect) {
    return { x: view.w / rect.width, y: view.h / rect.height };
}

/** Where a world point sits on the stage, in percent of its width and height. */
export function toPercent(view, x, y) {
    return { left: round(((x - view.x) / view.w) * 100), top: round(((y - view.y) / view.h) * 100) };
}

/** The part of the view inside the world: the minimap's viewport box (w/h are 0 when outside). */
export function minimapBox(view, world) {
    const x = Math.max(view.x, world.x);
    const y = Math.max(view.y, world.y);
    const right = Math.min(view.x + view.w, world.x + world.w);
    const bottom = Math.min(view.y + view.h, world.y + world.h);
    return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) };
}

/**
 * The world point under a client position on the minimap, which shows the whole world letterboxed
 * (SVG preserveAspectRatio="xMidYMid meet").
 */
export function minimapToWorld(world, rect, clientX, clientY) {
    const scale = Math.min(rect.width / world.w, rect.height / world.h);
    const offsetX = (rect.width - world.w * scale) / 2;
    const offsetY = (rect.height - world.h * scale) / 2;
    return {
        x: world.x + (clientX - rect.left - offsetX) / scale,
        y: world.y + (clientY - rect.top - offsetY) / scale,
    };
}

const hasXY = node => Number.isFinite(node.x) && Number.isFinite(node.y);

/**
 * Positions for every node: nodes with x/y keep them; the others are placed deterministically. Without
 * edges to them they go on a grid (in the order given) beside the placed nodes; with edges, a fixed
 * number of force-directed steps (repulsion between all nodes, springs along edges, placed nodes pinned)
 * starts from that grid. No randomness: the same nodes and edges always give the same map.
 * Returns `{ [id]: { x, y } }`.
 */
export function autoLayout(nodes, edges = [], { spacing = 100, iterations = 150 } = {}) {
    const out = {};
    const fixed = nodes.filter(hasXY);
    const free = nodes.filter(node => !hasXY(node));
    for (const node of fixed) out[node.id] = { x: node.x, y: node.y };
    if (!free.length) return out;

    // Grid start: to the right of the placed nodes (or at the origin when none is placed).
    const cols = Math.ceil(Math.sqrt(free.length));
    let originX = 0, originY = 0;
    if (fixed.length) {
        originX = Math.max(...fixed.map(node => node.x)) + spacing;
        originY = Math.min(...fixed.map(node => node.y));
    }
    const pos = new Map();
    free.forEach((node, index) => {
        pos.set(node.id, { x: originX + (index % cols) * spacing, y: originY + Math.floor(index / cols) * spacing });
    });
    for (const node of fixed) pos.set(node.id, { x: node.x, y: node.y });

    const freeIds = new Set(free.map(node => node.id));
    const links = edges.filter(edge => pos.has(edge.from) && pos.has(edge.to) && edge.from !== edge.to);
    const moving = links.some(edge => freeIds.has(edge.from) || freeIds.has(edge.to));
    if (moving && pos.size <= 400) {
        const ids = [...pos.keys()];
        const k = spacing;
        for (let step = 0; step < iterations; step++) {
            const temperature = spacing * 0.5 * (1 - step / iterations);
            const force = new Map(ids.map(id => [id, { x: 0, y: 0 }]));
            for (let i = 0; i < ids.length; i++) {
                for (let j = i + 1; j < ids.length; j++) {
                    const a = pos.get(ids[i]), b = pos.get(ids[j]);
                    let dx = a.x - b.x, dy = a.y - b.y;
                    // Two nodes on the same spot: separate them along a fixed direction by index.
                    if (dx === 0 && dy === 0) { dx = (j - i) * 0.01; dy = (i + 1) * 0.01; }
                    const d2 = dx * dx + dy * dy;
                    const d = Math.sqrt(d2);
                    const push = (k * k) / d;
                    const fa = force.get(ids[i]), fb = force.get(ids[j]);
                    fa.x += (dx / d) * push; fa.y += (dy / d) * push;
                    fb.x -= (dx / d) * push; fb.y -= (dy / d) * push;
                }
            }
            for (const edge of links) {
                const a = pos.get(edge.from), b = pos.get(edge.to);
                const dx = a.x - b.x, dy = a.y - b.y;
                const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
                const pull = (d * d) / k;
                const fa = force.get(edge.from), fb = force.get(edge.to);
                fa.x -= (dx / d) * pull; fa.y -= (dy / d) * pull;
                fb.x += (dx / d) * pull; fb.y += (dy / d) * pull;
            }
            for (const id of freeIds) {
                const f = force.get(id);
                const length = Math.sqrt(f.x * f.x + f.y * f.y);
                if (!length) continue;
                const move = Math.min(length, temperature);
                const p = pos.get(id);
                p.x += (f.x / length) * move;
                p.y += (f.y / length) * move;
            }
        }
    }
    for (const node of free) {
        const p = pos.get(node.id);
        out[node.id] = { x: round(p.x), y: round(p.y) };
    }
    return out;
}
