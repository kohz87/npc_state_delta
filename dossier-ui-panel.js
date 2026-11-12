/* NPC State Delta dossier surface: panel lifecycle, shell, events, observers and portrait lightbox. */
import { escapeHtml } from './src/util/html.js';
import { OBSERVER_RETRY_LIMIT, OBSERVER_RETRY_MS, ROOT_ID, SETTINGS_ID, STYLE_ID } from './dossier-ui-constants.js';
import { createPortraitRefs } from './dossier-ui-html.js';
import { STYLES } from './dossier-ui-styles.js';
import { BOARD_STYLES } from './dossier-ui-styles-board.js';
import { SECTIONS_STYLES } from './dossier-ui-styles-sections.js';
import { bindSwipe, createScreenState, isNarrow, isNarrowWidth, observedWidth, escapeAction, goBack, normalizeSection, openNpc, openSection, SECTION_KEYS, setSection, showScreen, stepSection } from './dossier-ui-screens.js';

export class DossierUiPanel {
    constructor(api) {
        this.api = api;
        this.root = null;
        this.panelOpen = false;
        this.query = '';
        this.filter = 'all';
        this.selectedNpcId = '';
        this.screen = createScreenState();
        this.userName = '';
        this.pendingNpcId = '';
        this.projection = null;
        this.lastChatKey = '';
        this.lastScreenSignature = '';
        this.dirtyWhileClosed = true;
        this.refreshQueued = false;
        this.legacyObserver = null;
        this.observerRetryTimer = null;
        this.observerAttempts = 0;
        this.portraitRefs = createPortraitRefs();
        // The view token (api.dossierViewToken) the panel last drew from; '' when unknown (always draw).
        this.renderedToken = '';
        this.boundEscape = event => this.onDocumentKeydown(event);
        this.boundFocus = () => { if (this.panelOpen) this.scheduleRefresh(); };
        // The browser's back gesture steps one dossier screen back: one history entry per screen the dossier has pushed.
        this.navEntries = 0;
        this.ignorePop = false;
        this.boundPop = () => this.onPopState();
    }

    // Keeps the browser history as deep as the dossier's own screen history (only while the panel is open).
    syncNavEntries() {
        if (typeof history === 'undefined' || typeof history.pushState !== 'function') return;
        const want = this.panelOpen ? this.screen.history.length : 0;
        while (this.navEntries < want) { history.pushState({ npcStateDeltaScreen: true }, ''); this.navEntries += 1; }
        if (this.navEntries > want) {
            const back = this.navEntries - want;
            this.navEntries = want;
            this.ignorePop = true;
            history.go(-back);
        }
    }

    onPopState() {
        if (this.ignorePop) { this.ignorePop = false; return; }
        if (!this.panelOpen || this.navEntries <= 0) return;
        this.navEntries -= 1;
        this.setScreen(goBack(this.screen));
    }

    mount() {
        if (typeof document === 'undefined' || this.root?.isConnected) return this;
        this.injectStyles();
        let root = document.getElementById(ROOT_ID);
        if (!root) {
            root = document.createElement('div');
            root.id = ROOT_ID;
            root.innerHTML = this.shellHtml();
            document.body.appendChild(root);
        }
        this.root = root;
        this.bindEvents();
        this.attachLegacyObserver();
        this.startObserverRetry();
        return this;
    }

    destroy() {
        this.legacyObserver?.disconnect?.();
        this.legacyObserver = null;
        if (this.observerRetryTimer) clearInterval(this.observerRetryTimer);
        this.observerRetryTimer = null;
        document.removeEventListener?.('keydown', this.boundEscape);
        document.removeEventListener?.('click', this.boundOutside);
        this.sizeObserver?.disconnect?.();
        this.sizeObserver = null;
        window.removeEventListener?.('focus', this.boundFocus);
        window.removeEventListener?.('popstate', this.boundPop);
        this.unbindSwipe?.();
        this.portraitRefs.release();
        this.root?.remove?.();
        this.root = null;
    }

    shellHtml() {
        return `
            <button type="button" class="delta-launcher" aria-haspopup="dialog" aria-expanded="false" title="Open NPC dossiers">
                <span class="delta-launcher-mark" aria-hidden="true">D</span><span>Dossiers</span>
            </button>
            <section class="delta-panel ss-cards" role="dialog" aria-modal="true" aria-label="NPC State Delta dossiers" tabindex="-1" hidden>
                <header class="delta-topbar">
                    <div class="delta-brand"><span class="delta-kicker">NPC DOSSIER</span><strong>NPC State Delta</strong><span class="delta-chat-state"></span></div>
                    <div class="delta-top-actions">
                        <button type="button" class="delta-btn delta-open-settings">Settings</button>
                        <span class="delta-header-slot"></span>
                        <button type="button" class="delta-btn delta-close ss-tap-pill" aria-label="Close NPC dossiers">Close</button>
                    </div>
                </header>
                <div class="delta-notice" hidden></div>
                <div class="delta-panel-body">
                    <div class="delta-empty" hidden></div>
                    <div class="delta-stage" hidden>
                        <div class="delta-spread">
                            <main class="delta-document" tabindex="-1" aria-label="NPC dossiers"></main>
                        </div>
                    </div>
                </div>
            </section>`;
    }

    // Moves to another screen (the state machine is dossier-ui-screens.js) and draws it from the projection.
    setScreen(next) {
        if (!next || next === this.screen) return;
        this.screen = next;
        this.selectedNpcId = next.npcId || '';
        this.syncNavEntries();
        this.renderFromProjection({ force: true });
    }

    onScreenClick(target) {
        const name = target.dataset.deltaScreen;
        if (name === 'section') {
            const index = SECTION_KEYS.indexOf(target.dataset.deltaSection);
            return this.setScreen(openSection(this.screen, index < 0 ? 0 : index));
        }
        // A control that names the screen we came from is a real step back (history and the browser's entries shrink, they do not pile up).
        const last = this.screen.history[this.screen.history.length - 1];
        if ((name === 'board' || name === 'library') && last?.name === name && (name === 'library' || last.npcId === this.screen.npcId)) return this.setScreen(goBack(this.screen));
        if (name === 'profile' || name === 'board' || name === 'library') this.setScreen(showScreen(this.screen, name));
    }

    // Esc order: the lightbox, then a blocking editor or tools overlay (they keep Esc), then back a screen, then close.
    goBackOrClose() {
        const uiStatus = this.safeUiStatus();
        const blocked = Boolean(uiStatus?.editorMounted || uiStatus?.portraitGeneratorOpen || document.getElementById('npc_state_delta_tools_overlay'));
        const action = escapeAction(this.screen, { blocked });
        if (action === 'back') this.setScreen(goBack(this.screen));
        else if (action === 'close') this.close();
        return action;
    }

    bindEvents() {
        this.root.addEventListener('click', event => {
            const launcher = event.target.closest('.delta-launcher');
            if (launcher) return void this.open();
            if (event.target.closest('.delta-close')) return void this.close();
            if (event.target.closest('.delta-open-settings')) return void this.openSettings();
            if (event.target.closest('.delta-lightbox-close') || event.target.classList?.contains('delta-lightbox')) return void this.closeLightbox();
            if (event.target.closest('img.delta-profile-image')) return void this.openLightbox();
            const face = event.target.closest('.delta-library-face')?.dataset?.npcId;
            if (face) return void this.setScreen(openNpc(this.screen, face));
            const screen = event.target.closest('[data-delta-screen]');
            if (screen) return void this.onScreenClick(screen);
            const step = event.target.closest('[data-delta-section-step]');
            if (step) return void this.setScreen(stepSection(this.screen, Number(step.dataset.deltaSectionStep) || 0));
            const go = event.target.closest('[data-delta-section-go]')?.dataset?.deltaSectionGo;
            if (go) return void this.setScreen(setSection(this.screen, normalizeSection(SECTION_KEYS.indexOf(go))));
            const pin = event.target.closest('.delta-cast-pin');
            if (pin) { void this.pinKeyPerson(pin); return; }
            const edit = event.target.closest('.delta-edit');
            if (edit) {
                edit.closest('details.delta-header-menu')?.removeAttribute('open');
                this.openEditor(edit.dataset.npcId || this.selectedNpcId);
            }
        });
        // The dial is a button made of a div: Enter and Space open the profile like a tap.
        this.root.addEventListener('keydown', event => {
            const target = event.target.closest?.('[data-delta-screen][role="button"]');
            if (target && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); this.onScreenClick(target); }
        });
        this.root.addEventListener('input', event => {
            if (!event.target.matches?.('[data-delta-library-search]')) return;
            this.query = event.target.value || '';
            this.renderFromProjection({ force: true });
        });
        // A sideways swipe on a section screen goes to the next or previous section.
        this.unbindSwipe = bindSwipe(this.root.querySelector('.delta-document'), step => this.setScreen(stepSection(this.screen, step)));
        // The ⋯ menu closes on a tap outside it.
        this.boundOutside = event => {
            if (event.target.closest?.('.delta-header-menu')) return;
            this.root?.querySelector('details.delta-header-menu[open]')?.removeAttribute('open');
        };
        document.addEventListener('click', this.boundOutside);
        // The layout follows the panel's own width: when it crosses the one-column / two-pane line the screen is redrawn in the other layout.
        const panel = this.root.querySelector('.delta-panel');
        this.narrow = isNarrow(panel);
        if (panel && typeof ResizeObserver === 'function') {
            this.sizeObserver = new ResizeObserver(entries => {
                const narrow = isNarrowWidth(observedWidth(entries[entries.length - 1], panel));
                if (narrow === this.narrow) return;
                this.narrow = narrow;
                if (this.panelOpen) this.renderFromProjection({ force: true });
            });
            this.sizeObserver.observe(panel);
        }
        document.addEventListener('keydown', this.boundEscape);
        window.addEventListener('focus', this.boundFocus);
        window.addEventListener('popstate', this.boundPop);
    }

    injectStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = STYLES + BOARD_STYLES + SECTIONS_STYLES;
        document.head.appendChild(style);
    }

    startObserverRetry() {
        if (this.legacyObserver || this.observerRetryTimer) return;
        this.observerRetryTimer = setInterval(() => {
            this.observerAttempts += 1;
            if (this.attachLegacyObserver() || this.observerAttempts >= OBSERVER_RETRY_LIMIT) {
                clearInterval(this.observerRetryTimer);
                this.observerRetryTimer = null;
            }
        }, OBSERVER_RETRY_MS);
    }

    attachLegacyObserver() {
        if (typeof MutationObserver === 'undefined' || this.legacyObserver) return Boolean(this.legacyObserver);
        const target = document.getElementById(SETTINGS_ID);
        if (!target) return false;
        this.legacyObserver = new MutationObserver(() => {
            if (this.panelOpen) this.scheduleRefresh();
            else this.dirtyWhileClosed = true;
        });
        this.legacyObserver.observe(target, { subtree: true, childList: true, characterData: true, attributes: true });
        return true;
    }

    // (perf) A cheap string from the runtime (index.js dossierViewToken) that moves whenever anything the panel shows moves:
    // the chat and its load state, the stored revision, the latest reply, the configured fields, the host's views. '' when the
    // runtime has none (an older one), and then every refresh draws, as before.
    viewToken() {
        try { return typeof this.api?.dossierViewToken === 'function' ? String(this.api.dossierViewToken() ?? '') : ''; }
        catch { return ''; }
    }

    // A window focus, a settings-panel mutation or a pin asks for a refresh; it draws only when the view token moved since the
    // panel last drew (opening the panel always draws).
    scheduleRefresh() {
        if (this.refreshQueued) return;
        this.refreshQueued = true;
        queueMicrotask(() => {
            this.refreshQueued = false;
            const token = this.viewToken();
            if (token && token === this.renderedToken) return;
            void this.refresh();
        });
    }

    // After a draw: remember what it was drawn from, let go of pictures no dossier in the view shows any more, and drop the
    // settings-panel mutations queued up to now (the state was read after them, and the rest are this draw's own).
    drewFrom(token) {
        this.renderedToken = token;
        const projection = this.projection || {};
        const shown = new Set();
        for (const row of projection.index || []) if (row.portrait) shown.add(row.portrait);
        for (const npc of projection.npcs || []) {
            if (npc.portrait) shown.add(npc.portrait);
            for (const src of Object.values(npc.formPortraits || {})) if (src) shown.add(src);
        }
        this.portraitRefs.release(shown);
        this.legacyObserver?.takeRecords?.();
    }

    // Full-size portrait view: presentation only, reusing the already-projected portrait source.
    openLightbox() {
        const selected = this.projection?.npcs?.find(npc => npc.id === this.selectedNpcId);
        const panel = this.root?.querySelector('.delta-panel');
        if (!selected?.portrait || !panel) return;
        this.closeLightbox();
        const overlay = document.createElement('div');
        overlay.className = 'delta-lightbox';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', `${selected.name} portrait`);
        overlay.innerHTML = `<img alt="${escapeHtml(selected.name)} portrait"><button type="button" class="delta-btn delta-lightbox-close">Close</button>`;
        overlay.querySelector('img').src = selected.portrait;
        panel.appendChild(overlay);
        overlay.querySelector('.delta-lightbox-close')?.focus?.({ preventScroll: true });
    }

    closeLightbox() {
        const overlay = this.root?.querySelector('.delta-lightbox');
        if (!overlay) return false;
        overlay.remove();
        this.root.querySelector('.delta-profile-back')?.focus?.({ preventScroll: true });
        return true;
    }

    onDocumentKeydown(event) {
        if (this.panelOpen && event.key === 'Escape' && !event.defaultPrevented && this.root?.querySelector('.delta-lightbox')) {
            event.preventDefault();
            this.closeLightbox();
            return;
        }
        if (!this.panelOpen || event.key !== 'Escape' || event.defaultPrevented) return;
        if (this.goBackOrClose() !== 'none') event.preventDefault();
    }
}
