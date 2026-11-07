/* NPC State Delta dossier surface: panel lifecycle, shell, events, observers and portrait lightbox. */
import { escapeHtml } from './src/util/html.js';
import { OBSERVER_RETRY_LIMIT, OBSERVER_RETRY_MS, ROOT_ID, SETTINGS_ID, STYLE_ID } from './dossier-ui-constants.js';
import { createPortraitRefs } from './dossier-ui-html.js';
import { STYLES } from './dossier-ui-styles.js';

export class DossierUiPanel {
    constructor(api) {
        this.api = api;
        this.root = null;
        this.panelOpen = false;
        this.query = '';
        this.filter = 'all';
        this.selectedNpcId = '';
        this.pendingNpcId = '';
        this.projection = null;
        this.lastChatKey = '';
        this.lastRailSignature = '';
        this.lastDetailSignature = '';
        this.lastHeroSignature = '';
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
        window.removeEventListener?.('focus', this.boundFocus);
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
                        <button type="button" class="delta-btn delta-close" aria-label="Close NPC dossiers">Close</button>
                    </div>
                </header>
                <div class="delta-notice" hidden></div>
                <div class="delta-panel-body">
                    <div class="delta-empty" hidden></div>
                    <div class="delta-library" hidden>
                        <div class="delta-stage">
                            <div class="delta-spread">
                                <aside class="delta-hero"></aside>
                                <main class="delta-document" tabindex="-1"></main>
                            </div>
                        </div>
                        <section class="delta-cast" aria-label="NPC cast">
                            <div class="delta-cast-tools">
                                <label class="delta-search-label"><span class="sr-only">Search NPC dossiers</span><input type="search" class="delta-search" placeholder="Search cast, role, species, gender, location…" autocomplete="off"></label>
                                <div class="delta-filters" role="group" aria-label="Dossier filters">
                                    ${['all', 'active', 'archived'].map(key => `<button type="button" class="delta-filter${key === 'all' ? ' active' : ''}" data-filter="${key}" aria-pressed="${key === 'all'}">${key.charAt(0).toUpperCase() + key.slice(1)} <span data-count="${key}">0</span></button>`).join('')}
                                </div>
                            </div>
                            <div class="delta-cast-list" role="listbox" aria-label="NPC dossiers"></div>
                        </section>
                    </div>
                </div>
            </section>`;
    }

    bindEvents() {
        this.root.addEventListener('click', event => {
            const launcher = event.target.closest('.delta-launcher');
            if (launcher) return void this.open();
            if (event.target.closest('.delta-close')) return void this.close();
            if (event.target.closest('.delta-open-settings')) return void this.openSettings();
            const filter = event.target.closest('.delta-filter')?.dataset?.filter;
            if (filter) {
                this.filter = filter;
                this.renderFromProjection({ forceRail: true, forceDetail: true });
                return;
            }
            const cast = event.target.closest('.delta-cast-card');
            if (cast?.dataset?.npcId) {
                this.selectedNpcId = cast.dataset.npcId;
                this.renderFromProjection({ forceRail: true, forceDetail: true });
                return;
            }
            if (event.target.closest('.delta-lightbox-close') || event.target.classList?.contains('delta-lightbox')) return void this.closeLightbox();
            if (event.target.closest('.delta-portrait-expand') || event.target.closest('.delta-hero-media img.delta-hero-portrait')) return void this.openLightbox();
            const jump = event.target.closest('.delta-section-jump')?.dataset?.deltaJump;
            if (jump) {
                // UI 4c: the document is the only thing that moves (a phone never scrolls the window or the page behind it).
                const scroller = this.root.querySelector('.delta-document');
                const target = scroller?.querySelector(`[data-delta-section="${CSS.escape(jump)}"]`);
                if (scroller && target) {
                    const cover = scroller.querySelector('.delta-section-nav')?.getBoundingClientRect().height ?? 0;
                    scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - cover;
                }
                return;
            }
            const pin = event.target.closest('.delta-cast-pin');
            if (pin) { void this.pinKeyPerson(pin); return; }
            const edit = event.target.closest('.delta-edit');
            if (edit) this.openEditor(edit.dataset.npcId || this.selectedNpcId);
        });
        this.root.querySelector('.delta-search')?.addEventListener('input', event => {
            this.query = event.currentTarget.value || '';
            this.renderFromProjection({ forceRail: true, forceDetail: true });
        });
        document.addEventListener('keydown', this.boundEscape);
        window.addEventListener('focus', this.boundFocus);
    }

    injectStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = STYLES;
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
        this.root.querySelector('.delta-portrait-expand')?.focus?.({ preventScroll: true });
        return true;
    }

    onDocumentKeydown(event) {
        if (this.panelOpen && event.key === 'Escape' && !event.defaultPrevented && this.root?.querySelector('.delta-lightbox')) {
            event.preventDefault();
            this.closeLightbox();
            return;
        }
        if (!this.panelOpen || event.key !== 'Escape' || event.defaultPrevented
            || document.getElementById('npc_state_delta_tools_overlay')) return;
        const uiStatus = this.safeUiStatus();
        if (uiStatus?.editorMounted || uiStatus?.portraitGeneratorOpen) return;
        event.preventDefault();
        this.close();
    }
}
