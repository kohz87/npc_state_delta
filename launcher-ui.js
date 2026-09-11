/* NPC State Delta Stage 1 launcher refinement: movable, mobile-safe, UI-only position state. */

const ROOT_ID = 'npc_state_delta_dossier_root';
const STYLE_ID = 'npc_state_delta_launcher_refinement_styles';
const STORAGE_KEY = 'npc_state_delta_launcher_position_v1';
const DRAG_THRESHOLD_PX = 5;
const VIEWPORT_MARGIN_PX = 8;
const START_RETRY_MS = 100;
const START_RETRY_LIMIT = 50;

function finite(value, fallback = 0) {
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

function readStoredPosition(storage = globalThis.localStorage) {
    try {
        const parsed = JSON.parse(storage?.getItem?.(STORAGE_KEY) || 'null');
        if (!parsed || !Number.isFinite(Number(parsed.left)) || !Number.isFinite(Number(parsed.top))) return null;
        return launcherPositionRecord(parsed);
    } catch {
        return null;
    }
}

function saveStoredPosition(position, storage = globalThis.localStorage) {
    try { storage?.setItem?.(STORAGE_KEY, JSON.stringify(launcherPositionRecord(position))); }
    catch { /* UI position persistence is best-effort only. */ }
}

function viewportSize() {
    const visual = globalThis.visualViewport;
    return {
        width: Math.max(0, finite(visual?.width, globalThis.innerWidth || document.documentElement?.clientWidth || 0)),
        height: Math.max(0, finite(visual?.height, globalThis.innerHeight || document.documentElement?.clientHeight || 0)),
    };
}

class DeltaLauncherRefinement {
    constructor(root) {
        this.root = root;
        this.launcher = root?.querySelector?.('.delta-launcher') || null;
        this.drag = null;
        this.suppressClickUntil = 0;
        this.observer = null;
        this.boundResize = () => this.clampCurrentPosition();
        this.boundPointerDown = event => this.onPointerDown(event);
        this.boundPointerMove = event => this.onPointerMove(event);
        this.boundPointerUp = event => this.onPointerUp(event);
        this.boundPointerCancel = event => this.onPointerCancel(event);
        this.boundClickCapture = event => this.onClickCapture(event);
    }

    mount() {
        if (!this.root || !this.launcher) return null;
        this.injectStyles();
        this.removeEmbeddedSettingsAccess();
        this.launcher.title = 'Drag to move · click to open NPC dossiers';
        this.launcher.setAttribute('aria-label', 'NPC dossiers. Drag to move; activate to open.');
        this.launcher.addEventListener('pointerdown', this.boundPointerDown);
        this.launcher.addEventListener('pointermove', this.boundPointerMove);
        this.launcher.addEventListener('pointerup', this.boundPointerUp);
        this.launcher.addEventListener('pointercancel', this.boundPointerCancel);
        this.launcher.addEventListener('click', this.boundClickCapture, true);
        globalThis.addEventListener?.('resize', this.boundResize);
        globalThis.visualViewport?.addEventListener?.('resize', this.boundResize);
        globalThis.visualViewport?.addEventListener?.('scroll', this.boundResize);
        this.observeDossierRenders();
        requestAnimationFrame(() => this.restoreStoredPosition());
        return this;
    }

    destroy() {
        this.observer?.disconnect?.();
        this.observer = null;
        this.launcher?.removeEventListener?.('pointerdown', this.boundPointerDown);
        this.launcher?.removeEventListener?.('pointermove', this.boundPointerMove);
        this.launcher?.removeEventListener?.('pointerup', this.boundPointerUp);
        this.launcher?.removeEventListener?.('pointercancel', this.boundPointerCancel);
        this.launcher?.removeEventListener?.('click', this.boundClickCapture, true);
        globalThis.removeEventListener?.('resize', this.boundResize);
        globalThis.visualViewport?.removeEventListener?.('resize', this.boundResize);
        globalThis.visualViewport?.removeEventListener?.('scroll', this.boundResize);
    }

    injectStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
#${ROOT_ID} {
  position: static !important;
  z-index: auto !important;
}
#${ROOT_ID} .delta-open-settings { display: none !important; }
#${ROOT_ID} .delta-launcher {
  position: fixed !important;
  z-index: 2147483400 !important;
  display: inline-flex !important;
  visibility: visible !important;
  opacity: 1 !important;
  pointer-events: auto !important;
  touch-action: none !important;
  user-select: none;
  -webkit-user-select: none;
  max-width: calc(100vw - 16px);
  cursor: grab;
}
#${ROOT_ID} .delta-launcher.delta-launcher-dragging { cursor: grabbing; }
#${ROOT_ID} .delta-launcher[data-positioned="true"] {
  right: auto !important;
  bottom: auto !important;
}
@media (max-width: 650px) {
  #${ROOT_ID} .delta-launcher:not([data-positioned="true"]) {
    right: max(10px, env(safe-area-inset-right)) !important;
    bottom: max(84px, calc(74px + env(safe-area-inset-bottom))) !important;
  }
}
`;
        document.head.appendChild(style);
    }

    removeEmbeddedSettingsAccess() {
        for (const button of this.root.querySelectorAll('.delta-open-settings')) button.remove();
    }

    observeDossierRenders() {
        if (typeof MutationObserver === 'undefined') return;
        this.observer = new MutationObserver(() => this.removeEmbeddedSettingsAccess());
        this.observer.observe(this.root, { subtree: true, childList: true });
    }

    restoreStoredPosition() {
        const stored = readStoredPosition();
        if (!stored || !this.launcher?.isConnected) return;
        this.applyPosition(stored);
    }

    applyPosition(position) {
        if (!this.launcher?.isConnected) return null;
        const rect = this.launcher.getBoundingClientRect();
        const clamped = clampLauncherPosition(position, viewportSize(), { width: rect.width, height: rect.height });
        this.launcher.style.left = `${clamped.left}px`;
        this.launcher.style.top = `${clamped.top}px`;
        this.launcher.dataset.positioned = 'true';
        return clamped;
    }

    clampCurrentPosition() {
        if (!this.launcher?.isConnected || this.launcher.dataset.positioned !== 'true') return;
        const rect = this.launcher.getBoundingClientRect();
        const clamped = this.applyPosition({ left: rect.left, top: rect.top });
        if (clamped) saveStoredPosition(clamped);
    }

    onPointerDown(event) {
        if (!this.launcher || event.isPrimary === false || (event.pointerType === 'mouse' && event.button !== 0)) return;
        const rect = this.launcher.getBoundingClientRect();
        this.drag = {
            pointerId: event.pointerId,
            startX: finite(event.clientX),
            startY: finite(event.clientY),
            left: rect.left,
            top: rect.top,
            moved: false,
        };
        try { this.launcher.setPointerCapture?.(event.pointerId); } catch { /* optional */ }
    }

    onPointerMove(event) {
        if (!this.drag || event.pointerId !== this.drag.pointerId) return;
        const dx = finite(event.clientX) - this.drag.startX;
        const dy = finite(event.clientY) - this.drag.startY;
        if (!this.drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        this.drag.moved = true;
        event.preventDefault?.();
        this.launcher.classList.add('delta-launcher-dragging');
        this.applyPosition({ left: this.drag.left + dx, top: this.drag.top + dy });
    }

    onPointerUp(event) {
        if (!this.drag || event.pointerId !== this.drag.pointerId) return;
        const moved = this.drag.moved;
        this.finishPointer(event.pointerId);
        if (!moved) return;
        event.preventDefault?.();
        const rect = this.launcher.getBoundingClientRect();
        const clamped = this.applyPosition({ left: rect.left, top: rect.top });
        if (clamped) saveStoredPosition(clamped);
        this.suppressClickUntil = Date.now() + 450;
    }

    onPointerCancel(event) {
        if (!this.drag || event.pointerId !== this.drag.pointerId) return;
        this.finishPointer(event.pointerId);
    }

    finishPointer(pointerId) {
        try { this.launcher.releasePointerCapture?.(pointerId); } catch { /* optional */ }
        this.launcher.classList.remove('delta-launcher-dragging');
        this.drag = null;
    }

    onClickCapture(event) {
        if (Date.now() >= this.suppressClickUntil) return;
        event.preventDefault?.();
        event.stopImmediatePropagation?.();
    }
}

export function mountNpcStateDeltaLauncherRefinement(root = document.getElementById(ROOT_ID)) {
    if (typeof document === 'undefined' || !root) return null;
    if (root.__npcStateDeltaLauncherRefinement) return root.__npcStateDeltaLauncherRefinement;
    const refinement = new DeltaLauncherRefinement(root).mount();
    if (refinement) root.__npcStateDeltaLauncherRefinement = refinement;
    return refinement;
}

function start(attempt = 0) {
    if (typeof document === 'undefined') return;
    const root = document.getElementById(ROOT_ID);
    if (root?.querySelector?.('.delta-launcher')) {
        mountNpcStateDeltaLauncherRefinement(root);
        return;
    }
    if (attempt < START_RETRY_LIMIT) setTimeout(() => start(attempt + 1), START_RETRY_MS);
    else console.error('[NPC State Delta] launcher refinement could not find the Stage 1 dossier root.');
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => start(), { once: true });
    else queueMicrotask(() => start());
}
