/* NPC State Delta dossier surface: controller actions, refresh orchestration, editor and settings bridges. */
import { plain } from './dossier-ui-model.js';
import { projectDossierState } from './dossier-ui-catalog.js';
import { visibleElement } from './dossier-ui-html.js';
import { SETTINGS_ID } from './dossier-ui-constants.js';
import { DossierUiRender } from './dossier-ui-render.js';
import { createScreenState, openNpc, showScreen } from './dossier-ui-screens.js';

export class DeltaDossierUi extends DossierUiRender {
    async open() {
        if (!this.root) return;
        this.panelOpen = true;
        this.syncNavEntries();
        this.root.querySelector('.delta-panel').hidden = false;
        this.root.querySelector('.delta-launcher')?.setAttribute('aria-expanded', 'true');
        try { await this.api?.ensureFresh?.({ reason: 'dossier-ui-open' }); }
        catch (error) { console.warn('[NPC State Delta] dossier view freshness check failed safely.', error); }
        await this.refresh({ force: true });
        // Focus the panel, never the search box: focusing a text field raises the phone/tablet
        // keyboard over the dossier. Search is focused only when the user taps it.
        this.root.querySelector('.delta-panel')?.focus?.({ preventScroll: true });
    }

    // Open the panel on one NPC's board (present-cast cards in chat use this). The request is applied
    // after any chat-change reset in refresh(), and clears the search so the NPC is visible.
    async openNpc(npcId) {
        this.pendingNpcId = plain(npcId);
        await this.open();
    }

    // Select one dossier the way a library face does: its board opens (the relationship map uses this). The search is
    // cleared so the library, the board and the map agree.
    select(npcId) {
        const id = plain(npcId);
        if (!this.root || !id || !this.projection?.index?.some(row => row.id === id)) return false;
        this.query = '';
        this.filter = 'all';
        this.lastScreenSignature = '';
        this.setScreen(showScreen(this.screen, this.screen.name === 'library' ? 'board' : this.screen, id));
        return true;
    }

    close({ restoreFocus = true } = {}) {
        this.root?.querySelector('.delta-lightbox')?.remove();
        if (!this.root) return;
        this.panelOpen = false;
        this.syncNavEntries();
        this.root.querySelector('.delta-panel').hidden = true;
        this.root.querySelector('.delta-launcher')?.setAttribute('aria-expanded', 'false');
        if (restoreFocus) this.root.querySelector('.delta-launcher')?.focus?.({ preventScroll: true });
    }

    // What a refresh needs (chat key and load state), without the diagnostics uiStatus builds (a copy of the branch state).
    safeViewStatus() {
        if (typeof this.api?.dossierViewStatus !== 'function') return this.safeUiStatus();
        try { return this.api.dossierViewStatus(); }
        catch (error) { return { chatKey: 'no-chat', hydrationStatus: 'error', hydrationError: error?.message || String(error) }; }
    }

    safeUiStatus() {
        try { return typeof this.api?.uiStatus === 'function' ? this.api.uiStatus() : {}; }
        catch (error) { return { chatKey: 'no-chat', hydrationStatus: 'error', hydrationError: error?.message || String(error) }; }
    }

    async refresh({ force = false } = {}) {
        if (!this.root || (!this.panelOpen && !force)) {
            this.dirtyWhileClosed = true;
            return;
        }
        const token = this.viewToken();
        const status = this.safeViewStatus();
        const chatKey = plain(status?.chatKey, 'no-chat');
        const chatChanged = chatKey !== this.lastChatKey;
        if (chatChanged) {
            this.lastChatKey = chatKey;
            this.selectedNpcId = '';
            this.screen = createScreenState();
            this.query = '';
            this.filter = 'all';
            this.lastScreenSignature = '';
        }
        if (this.pendingNpcId) {
            // An NPC asked for from outside (a present-cast card): its board opens, whatever screen was showing.
            this.screen = openNpc(createScreenState(), this.pendingNpcId);
            this.selectedNpcId = this.screen.npcId || '';
            this.pendingNpcId = '';
            this.query = '';
            this.filter = 'all';
            this.lastScreenSignature = '';
        }

        if (chatKey === 'no-chat') {
            this.projection = projectDossierState({}, status);
            this.dirtyWhileClosed = false;
            this.renderFromProjection({ force: true });
            this.drewFrom(token);
            return;
        }
        if (status?.hydrationStatus && status.hydrationStatus !== 'ready') {
            this.projection = projectDossierState({}, status);
            this.dirtyWhileClosed = false;
            this.renderFromProjection({ force: true });
            this.drewFrom(token);
            return;
        }
        try {
            const state = typeof this.api?.getDossierState === 'function' ? this.api.getDossierState() : this.api?.getState?.() || { npcs: [] };
            this.projection = projectDossierState(state, status);
            this.dirtyWhileClosed = false;
            this.renderFromProjection({ force: force || chatChanged });
            this.drewFrom(token);
        } catch (error) {
            this.projection = projectDossierState({}, { ...status, hydrationStatus: 'error', hydrationError: error?.message || String(error) });
            this.renderFromProjection({ force: true });
            this.drewFrom('');
        }
    }

    // (the living cast) "Pin as Key people": Story Director's own command, asked through Delta's api; the button is drawn only while it is offered.
    async pinKeyPerson(button) {
        const id = button?.dataset?.deltaCastPin || this.selectedNpcId;
        if (!id || typeof this.api?.pinKeyPerson !== 'function') return;
        button.disabled = true;
        let out = null;
        try { out = await this.api.pinKeyPerson(id); } catch (error) { out = { ok: false, message: String(error?.message || error) }; }
        if (out?.ok) globalThis.toastr?.success?.(`NPC State Delta: ${out.message || 'Pinned as a key person.'}`);
        else { button.disabled = false; globalThis.toastr?.warning?.(`NPC State Delta: ${out?.message || 'Could not pin.'}`); }
        this.scheduleRefresh();
    }

    async openEditor(npcId) {
        const id = plain(npcId);
        if (!id || typeof this.api?.openEditor !== 'function') {
            globalThis.toastr?.warning?.('NPC State Delta: dossier editor is unavailable.');
            return;
        }
        try {
            const opened = await this.api.openEditor(id);
            if (opened === false) globalThis.toastr?.warning?.('NPC State Delta: dossier editor could not open this NPC.');
        } catch (error) {
            console.error('[NPC State Delta] Stage 1 editor bridge failed', error);
            globalThis.toastr?.error?.(`NPC State Delta editor failed: ${error?.message || error}`);
        }
    }

    openSettings() {
        const settings = document.getElementById(SETTINGS_ID);
        if (!settings) {
            globalThis.toastr?.info?.('NPC State Delta settings are still mounting.');
            return;
        }
        this.close({ restoreFocus: false });
        for (let node = settings.parentElement; node; node = node.parentElement) {
            if (node.tagName === 'DETAILS') node.open = true;
        }
        const menuSelectors = [
            '#extensionsMenuButton',
            '#extensions_menu_button',
            '#extensionsMenu .drawer-toggle',
            '[data-target="extensions_settings"]',
        ];
        if (!visibleElement(settings)) {
            for (const selector of menuSelectors) {
                const trigger = document.querySelector(selector);
                if (trigger && !trigger.disabled) { trigger.click?.(); break; }
            }
        }
        settings.classList.add('npc-state-delta-stage1-settings-target');
        setTimeout(() => {
            // UI 4c: only the settings' own scroller moves (the nearest one that scrolls), never the window or the page.
            let box = settings.parentElement;
            while (box && box !== document.body && !(/(auto|scroll)/.test(getComputedStyle(box).overflowY) && box.scrollHeight > box.clientHeight)) box = box.parentElement;
            if (box && box !== document.body) box.scrollTop += settings.getBoundingClientRect().top - box.getBoundingClientRect().top;
            setTimeout(() => settings.classList.remove('npc-state-delta-stage1-settings-target'), 1800);
        }, 0);
    }
}
