/* NPC State Delta Stage 1 launcher refinement: movable, mobile-safe, UI-only position state. */

const ROOT_ID = 'npc_state_delta_dossier_root';
const LAUNCHER_ID = 'npc_state_delta_dossier_launcher';
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
        this.launcher = root?.querySelector?.('.delta-launcher') || document.getElementById(LAUNCHER_ID) || null;
        this.backdrop = null;
        this.drag = null;
        this.suppressClickUntil = 0;
        this.panelWasOpen = false;
        this.observer = null;
        this.boundResize = () => this.clampCurrentPosition();
        this.boundPointerDown = event => this.onPointerDown(event);
        this.boundPointerMove = event => this.onPointerMove(event);
        this.boundPointerUp = event => this.onPointerUp(event);
        this.boundPointerCancel = event => this.onPointerCancel(event);
        this.boundLauncherClick = event => this.onLauncherClick(event);
        this.boundBackdropClick = event => this.onBackdropClick(event);
    }

    mount() {
        if (!this.root || !this.launcher || !document.body) return null;
        this.injectStyles();
        this.launcher.id = LAUNCHER_ID;
        this.launcher.title = 'Drag to move; click to open NPC dossiers';
        this.launcher.setAttribute('aria-label', 'NPC dossiers. Drag to move; activate to open.');
        this.decorateLauncher();

        // Keep the floating launcher outside the dossier root so host/mobile stacking
        // contexts cannot bury it. The refinement owns its open bridge explicitly.
        if (this.launcher.parentElement !== document.body) document.body.appendChild(this.launcher);

        this.launcher.addEventListener('pointerdown', this.boundPointerDown);
        this.launcher.addEventListener('pointermove', this.boundPointerMove);
        this.launcher.addEventListener('pointerup', this.boundPointerUp);
        this.launcher.addEventListener('pointercancel', this.boundPointerCancel);
        this.launcher.addEventListener('click', this.boundLauncherClick);
        globalThis.addEventListener?.('resize', this.boundResize);
        globalThis.visualViewport?.addEventListener?.('resize', this.boundResize);
        globalThis.visualViewport?.addEventListener?.('scroll', this.boundResize);

        this.ensureBackdrop();
        this.normalizeDossierChrome();
        this.observeDossierRenders();
        requestAnimationFrame(() => this.restoreStoredPosition());
        return this;
    }

    destroy() {
        this.observer?.disconnect?.();
        this.observer = null;
        this.backdrop?.removeEventListener?.('click', this.boundBackdropClick);
        this.launcher?.removeEventListener?.('pointerdown', this.boundPointerDown);
        this.launcher?.removeEventListener?.('pointermove', this.boundPointerMove);
        this.launcher?.removeEventListener?.('pointerup', this.boundPointerUp);
        this.launcher?.removeEventListener?.('pointercancel', this.boundPointerCancel);
        this.launcher?.removeEventListener?.('click', this.boundLauncherClick);
        globalThis.removeEventListener?.('resize', this.boundResize);
        globalThis.visualViewport?.removeEventListener?.('resize', this.boundResize);
        globalThis.visualViewport?.removeEventListener?.('scroll', this.boundResize);
        this.backdrop?.remove?.();
        this.backdrop = null;
        this.launcher?.remove?.();
        this.launcher = null;
    }

    decorateLauncher() {
        const mark = this.launcher?.querySelector?.('.delta-launcher-mark');
        if (!mark) return;
        mark.replaceChildren();
        const npc = document.createElement('span');
        npc.className = 'delta-launcher-npc';
        npc.textContent = 'npc';
        const state = document.createElement('span');
        state.className = 'delta-launcher-state';
        state.textContent = 'state';
        mark.append(npc, state);

        // The button's aria-label carries its accessible name. Keep only the
        // compact stacked wordmark visually so the hit target can remain square.
        for (const child of Array.from(this.launcher.children)) {
            if (child !== mark) child.remove();
        }
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
#${ROOT_ID} .delta-document-head > .delta-edit { display: none !important; }
#${ROOT_ID} .delta-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  display: block;
  background: rgba(0, 0, 0, .72);
  pointer-events: auto;
}
#${ROOT_ID} .delta-backdrop[hidden] { display: none !important; }
#${ROOT_ID} .delta-panel {
  z-index: 2147483647 !important;
  box-shadow: 0 20px 70px rgba(0, 0, 0, .55) !important;
}
#${LAUNCHER_ID} {
  position: fixed !important;
  right: 18px !important;
  bottom: 74px !important;
  left: auto;
  top: auto;
  z-index: 2147483647 !important;
  display: inline-flex !important;
  align-items: center;
  justify-content: center;
  width: 48px;
  min-width: 48px;
  height: 48px;
  min-height: 48px;
  max-width: 48px;
  padding: 3px;
  border: 1px solid rgba(70, 145, 235, .78);
  border-radius: 13px;
  color: #eef5ff !important;
  background: #182a43 !important;
  box-shadow: 0 5px 18px rgba(0, 0, 0, .42) !important;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  visibility: visible !important;
  opacity: 1 !important;
  pointer-events: auto !important;
  touch-action: none !important;
  user-select: none;
  -webkit-user-select: none;
  cursor: grab;
}
#${LAUNCHER_ID}:hover { background: #203754 !important; }
#${LAUNCHER_ID}.delta-launcher-dragging { cursor: grabbing; }
#${LAUNCHER_ID} .delta-launcher-mark {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  width: 100%;
  height: 100%;
  border: 0;
  border-radius: 10px;
  line-height: .88;
}
#${LAUNCHER_ID} .delta-launcher-npc {
  color: #f7fbff;
  font-size: 14px;
  font-weight: 850;
  letter-spacing: -.065em;
  text-transform: lowercase;
}
#${LAUNCHER_ID} .delta-launcher-state {
  color: #3e9cff;
  font-size: 10px;
  font-weight: 850;
  letter-spacing: -.045em;
  text-transform: lowercase;
}
#${LAUNCHER_ID}[data-positioned="true"] {
  right: auto !important;
  bottom: auto !important;
  transform: none !important;
}
#${LAUNCHER_ID}[data-panel-open="true"] {
  visibility: hidden !important;
  opacity: 0 !important;
  pointer-events: none !important;
}
@media (max-width: 1100px) {
  #${LAUNCHER_ID}:not([data-positioned="true"]) {
    right: max(12px, env(safe-area-inset-right)) !important;
    top: 50% !important;
    bottom: auto !important;
    transform: translateY(-50%) !important;
  }
  #${ROOT_ID} .delta-panel {
    left: 0 !important;
    top: 0 !important;
    right: auto !important;
    bottom: auto !important;
    transform: none !important;
    width: 100vw !important;
    max-width: none !important;
    height: 100vh !important;
    height: 100dvh !important;
    max-height: none !important;
    border-radius: 0 !important;
    border-left: 0 !important;
    border-right: 0 !important;
    overscroll-behavior: contain;
  }
  #${ROOT_ID} .delta-topbar {
    position: sticky;
    top: 0;
    z-index: 20;
    min-height: 56px;
    padding-top: max(8px, env(safe-area-inset-top));
    padding-right: max(10px, env(safe-area-inset-right));
    padding-left: max(10px, env(safe-area-inset-left));
  }
  #${ROOT_ID} .delta-close {
    flex: 0 0 auto;
    min-width: 44px;
    min-height: 44px;
  }
  #${ROOT_ID} .delta-cast {
    padding-bottom: max(8px, env(safe-area-inset-bottom));
  }
}
@media (min-width: 651px) and (max-width: 900px) {
  #${ROOT_ID} .delta-library {
    grid-template-rows: minmax(0, 1fr) 178px;
  }
  #${ROOT_ID} .delta-cast-tools {
    align-items: center;
    flex-direction: row;
  }
  #${ROOT_ID} .delta-search-label {
    flex: 1 1 0;
    min-width: 0;
    max-width: none;
  }
  #${ROOT_ID} .delta-filters {
    flex: 0 0 auto;
    flex-wrap: nowrap;
  }
  #${ROOT_ID} .delta-cast-list {
    min-height: 92px;
  }
}
@media (max-width: 650px) {
  #${ROOT_ID} .delta-library {
    grid-template-rows: minmax(0, 1fr) clamp(224px, 30dvh, 260px);
  }
  #${ROOT_ID} .delta-cast {
    padding-bottom: max(10px, env(safe-area-inset-bottom));
  }
  #${ROOT_ID} .delta-cast-list {
    min-height: 94px;
  }
}
`;
        document.head.appendChild(style);
    }

    controller() {
        return this.root?.__npcStateDeltaStage1Ui || null;
    }

    ensureBackdrop() {
        const panel = this.root?.querySelector?.('.delta-panel');
        if (!panel) return null;
        let backdrop = this.root.querySelector('.delta-backdrop');
        if (!backdrop) {
            backdrop = document.createElement('div');
            backdrop.className = 'delta-backdrop';
            backdrop.hidden = true;
            backdrop.setAttribute('aria-hidden', 'true');
            this.root.insertBefore(backdrop, panel);
        }
        if (this.backdrop !== backdrop) {
            this.backdrop?.removeEventListener?.('click', this.boundBackdropClick);
            this.backdrop = backdrop;
            this.backdrop.addEventListener('click', this.boundBackdropClick);
        }
        return backdrop;
    }

    normalizeDossierChrome() {
        if (!this.root) return;
        for (const button of this.root.querySelectorAll('.delta-open-settings')) button.remove();
        for (const button of this.root.querySelectorAll('.delta-document-head > .delta-edit')) button.remove();
        this.ensureBackdrop();
        this.syncPanelState();
    }

    syncPanelState() {
        const panel = this.root?.querySelector?.('.delta-panel');
        const backdrop = this.ensureBackdrop();
        const open = Boolean(panel && !panel.hidden);
        if (backdrop && backdrop.hidden === open) backdrop.hidden = !open;
        if (this.launcher) {
            this.launcher.setAttribute('aria-expanded', String(open));
            this.launcher.dataset.panelOpen = String(open);
        }
        if (!open && this.panelWasOpen && this.launcher?.isConnected) {
            this.launcher.focus?.({ preventScroll: true });
        }
        this.panelWasOpen = open;
    }

    observeDossierRenders() {
        if (typeof MutationObserver === 'undefined') return;
        this.observer = new MutationObserver(() => this.normalizeDossierChrome());
        this.observer.observe(this.root, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['hidden'],
        });
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

    onLauncherClick(event) {
        if (Date.now() < this.suppressClickUntil) {
            event.preventDefault?.();
            event.stopImmediatePropagation?.();
            return;
        }
        event.preventDefault?.();
        const controller = this.controller();
        if (typeof controller?.open === 'function') void controller.open();
        else globalThis.toastr?.warning?.('NPC State Delta dossier UI is still mounting.');
    }

    onBackdropClick(event) {
        if (event.target !== this.backdrop) return;
        event.preventDefault?.();
        const controller = this.controller();
        if (typeof controller?.close === 'function') controller.close({ restoreFocus: false });
        this.launcher?.focus?.({ preventScroll: true });
    }
}

export function mountNpcStateDeltaLauncherRefinement(root = globalThis.document?.getElementById?.(ROOT_ID)) {
    if (typeof document === 'undefined' || !root) return null;
    if (root.__npcStateDeltaLauncherRefinement) return root.__npcStateDeltaLauncherRefinement;
    const refinement = new DeltaLauncherRefinement(root).mount();
    if (refinement) root.__npcStateDeltaLauncherRefinement = refinement;
    return refinement;
}

function start(attempt = 0) {
    if (typeof document === 'undefined') return;
    const root = document.getElementById(ROOT_ID);
    const controller = root?.__npcStateDeltaStage1Ui;
    const launcher = root?.querySelector?.('.delta-launcher') || document.getElementById(LAUNCHER_ID);
    if (root && controller && launcher) {
        mountNpcStateDeltaLauncherRefinement(root);
        return;
    }
    if (attempt < START_RETRY_LIMIT) setTimeout(() => start(attempt + 1), START_RETRY_MS);
    else console.error('[NPC State Delta] launcher refinement could not find the mounted Stage 1 dossier UI.');
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => start(), { once: true });
    else queueMicrotask(() => start());
}