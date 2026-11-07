/* NPC State Delta launcher position helpers: viewport clamping, compact position records, saved
   position reads/writes and the visual-viewport size. Split from launcher-ui.js without change;
   launcher-ui.js keeps its public exports. */

const VIEWPORT_MARGIN_PX = 8;

export function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

export function clampLauncherPosition(position = {}, viewport = {}, size = {}, margin = VIEWPORT_MARGIN_PX) {
    const safeMargin = Math.max(0, finite(margin, VIEWPORT_MARGIN_PX));
    const width = Math.max(0, finite(viewport.width));
    const height = Math.max(0, finite(viewport.height));
    const itemWidth = Math.max(0, finite(size.width));
    const itemHeight = Math.max(0, finite(size.height));
    const maxLeft = Math.max(safeMargin, width - itemWidth - safeMargin);
    const maxTop = Math.max(safeMargin, height - itemHeight - safeMargin);
    return {
        left: Math.min(maxLeft, Math.max(safeMargin, finite(position.left, maxLeft))),
        top: Math.min(maxTop, Math.max(safeMargin, finite(position.top, maxTop))),
    };
}

export function launcherPositionRecord(position = {}) {
    return {
        left: Math.round(finite(position.left)),
        top: Math.round(finite(position.top)),
    };
}

export function readStoredPosition(storage = globalThis.localStorage, storageKey = '') {
    try {
        const parsed = JSON.parse(storage?.getItem?.(storageKey) || 'null');
        if (!parsed || !Number.isFinite(Number(parsed.left)) || !Number.isFinite(Number(parsed.top))) return null;
        return launcherPositionRecord(parsed);
    } catch {
        return null;
    }
}

export function saveStoredPosition(position, storage = globalThis.localStorage, storageKey = '') {
    try { storage?.setItem?.(storageKey, JSON.stringify(launcherPositionRecord(position))); }
    catch { /* UI position persistence is best-effort only. */ }
}

export function viewportSize() {
    const visual = globalThis.visualViewport;
    return {
        width: Math.max(0, finite(visual?.width, globalThis.innerWidth || document.documentElement?.clientWidth || 0)),
        height: Math.max(0, finite(visual?.height, globalThis.innerHeight || document.documentElement?.clientHeight || 0)),
    };
}
