/* NPC State Delta dossier surface: draws the current screen (library | board | profile | section) from the projection.
   The screen state machine is dossier-ui-screens.js; the screens' markup is library / board / sections / profile. */
import { escapeHtml } from './src/util/html.js';
import { portraitMark } from './dossier-ui-html.js';
import { replyHeaderLabel } from './dossier-ui-model.js';
import { DossierUiPanel } from './dossier-ui-panel.js';
import { boardHtml } from './dossier-ui-board.js';
import { libraryCountHtml, libraryFootHtml, libraryHtml, libraryRows, librarySearchHtml, librarySignature } from './dossier-ui-library.js';
import { dossierProfileHtml } from './dossier-ui-profile.js';
import { SECTION_KEYS, createScreenState, isNarrow, layoutFor, screenSignature } from './dossier-ui-screens.js';
import { sectionScreenHtml } from './dossier-ui-sections.js';

function pane(name, html) {
    return `<div data-pane="${name}">${html}</div>`;
}

export class DossierUiRender extends DossierUiPanel {
    // The player's name for "With {{user}}": the persona of the chat, from the host when it offers one.
    personaName() {
        try { return String(globalThis.SillyTavern?.getContext?.()?.name1 ?? '').trim(); }
        catch { return ''; }
    }

    renderFromProjection({ force = false, forceRail = false, forceDetail = false } = {}) {
        if (!this.root || !this.projection) return;
        const panel = this.root.querySelector('.delta-panel');
        const empty = this.root.querySelector('.delta-empty');
        const stage = this.root.querySelector('.delta-stage');
        const notice = this.root.querySelector('.delta-notice');
        const chatState = this.root.querySelector('.delta-chat-state');
        const projection = this.projection;
        const hasChat = projection.chatKey && projection.chatKey !== 'no-chat';

        const replyLabel = replyHeaderLabel(projection);
        if (chatState.textContent !== replyLabel) chatState.textContent = replyLabel;
        notice.hidden = true;
        if (notice.textContent) notice.textContent = '';

        if (!hasChat || projection.hydrationStatus !== 'ready') this.clearHeaderMenu();
        if (!hasChat) {
            empty.hidden = false;
            stage.hidden = true;
            empty.innerHTML = `<div class="delta-empty-mark" aria-hidden="true">D</div><h2>Open a chat to view its cast</h2><p>Dossiers belong to the active conversation. Settings remain available without a chat.</p><button type="button" class="delta-btn delta-primary delta-open-settings">Open settings</button>`;
            return;
        }
        if (projection.hydrationStatus !== 'ready') {
            empty.hidden = false;
            stage.hidden = true;
            const detail = projection.hydrationError ? `<p class="delta-error-copy">${escapeHtml(projection.hydrationError)}</p>` : '<p>The dossier state is still loading.</p>';
            empty.innerHTML = `<div class="delta-empty-mark" aria-hidden="true">…</div><h2>${projection.hydrationStatus === 'error' ? 'Dossier state unavailable' : 'Loading dossiers'}</h2>${detail}<button type="button" class="delta-btn delta-primary delta-open-settings">Open settings</button>`;
            return;
        }

        empty.hidden = true;
        stage.hidden = false;
        // A dossier that vanished (rewind, delete, another chat) sends the view back to the library.
        const known = projection.index.some(row => row.id === this.selectedNpcId);
        if (this.selectedNpcId && !known) {
            this.selectedNpcId = '';
            this.screen = createScreenState();
        }
        const shown = this.renderScreen({ force: force || forceRail || forceDetail });
        this.setHeaderTitle();
        panel?.setAttribute('data-has-results', shown ? 'true' : 'false');
        this.root.dispatchEvent?.(new CustomEvent('npc-state-delta:dossier-rendered', { bubbles: true }));
    }

    // The header names the screen as the mockup does: "Dossiers" in the library, the person's name everywhere else.
    setHeaderTitle() {
        const title = this.root.querySelector('.delta-brand strong');
        const npc = this.screen.name === 'library' ? null : this.projection.npcs.find(item => item.id === this.screen.npcId);
        const text = npc ? npc.name : 'Dossiers';
        if (title && title.textContent !== text) title.textContent = text;
    }

    // The ⋯ menu sits outside the redrawn pane: with no chat, or while one loads, the last chat's buttons must not stay live.
    clearHeaderMenu() {
        const slot = this.root?.querySelector?.('.delta-header-slot');
        if (!slot) return;
        slot.innerHTML = '';
        if (slot.dataset) slot.dataset.deltaExperienceActions = '';
    }

    // The library: the search box stays put while the faces below it are redrawn, so typing keeps its focus.
    renderLibrary(doc, { force }) {
        const refs = this.portraitRefs;
        const rows = libraryRows(this.projection.index, { query: this.query, filter: 'all', keepId: this.selectedNpcId });
        const signature = `library|${this.query}|${librarySignature(rows, { selectedId: this.selectedNpcId, refs })}`;
        if (!force && signature === this.lastScreenSignature) return rows.length;
        this.lastScreenSignature = signature;
        if (doc.dataset.screen !== 'library' || !doc.querySelector('[data-delta-library-list]')) {
            doc.innerHTML = `<div class="delta-panes" data-screen="library"><div data-pane="library" class="delta-library-screen">${librarySearchHtml(this.query, this.projection.index.length)}<div data-delta-library-list></div></div></div>${libraryCountHtml(this.projection.index.length)}`;
            doc.dataset.screen = 'library';
            if (doc.firstElementChild) doc.firstElementChild.scrollTop = 0;
        }
        // the layout mark follows the panel's width on every draw (the panes are kept when only the width crossed the line)
        doc.querySelector('.delta-panes')?.setAttribute('data-layout', isNarrow(this.root.querySelector('.delta-panel')) ? 'phone' : 'desktop');
        const search = doc.querySelector('[data-delta-library-search]');
        const total = this.projection.index.length;
        if (search) search.placeholder = `Search ${total > 0 ? `${total} people` : 'people'}…`;
        const count = doc.querySelector('.delta-library-foot[data-static]');
        if (count) count.outerHTML = libraryCountHtml(this.projection.index.length);
        const list = doc.querySelector('[data-delta-library-list]');
        const focusedId = document.activeElement?.closest?.('.delta-library-face')?.dataset?.npcId || '';
        const deadHidden = !this.query && this.projection.index.some(row => row.bucket === 'dead');
        const emptyHint = deadHidden ? 'The dead are hidden from the list; search by name to find them.' : 'Change the search to bring the cast back.';
        list.innerHTML = libraryHtml(rows, { selectedId: this.selectedNpcId, refs, emptyHint });
        refs.fill(list);
        if (focusedId) list.querySelector(`.delta-library-face[data-npc-id="${CSS.escape(focusedId)}"]`)?.focus?.({ preventScroll: true });
        return rows.length;
    }

    // Board, profile or one section of one dossier. Phone: that screen alone. Desktop: the board beside a section; the
    // profile is its own two-column page. Redrawn only when the screen, the width or the dossier changed.
    renderScreen({ force = false } = {}) {
        const doc = this.root.querySelector('.delta-document');
        const screen = this.screen;
        if (screen.name === 'library') return this.renderLibrary(doc, { force });
        const npc = this.projection.npcs.find(item => item.id === screen.npcId);
        if (!npc) {
            this.screen = createScreenState();
            return this.renderLibrary(doc, { force: true });
        }
        const phone = isNarrow(this.root.querySelector('.delta-panel'));
        const userName = this.userName = this.personaName();
        const refs = this.portraitRefs;
        const formPortraits = Object.fromEntries(Object.entries(npc.formPortraits || {}).map(([name, src]) => [name, portraitMark(src, refs)]));
        // Faces in the Ties tile come from the people who have a dossier of their own; their portrait marks are part of the signature.
        const peers = new Map(this.projection.index.filter(row => row.portrait).map(row => [String(row.name).toLowerCase(), row.portrait]));
        const peerMarks = [...peers].map(([name, src]) => `${name}=${portraitMark(src, refs)}`).join(',');
        const signature = `${screenSignature(screen)}|${phone}|${userName}|${this.projection.index.length}|${peerMarks}|${JSON.stringify({ ...npc, portrait: portraitMark(npc.portrait, refs), formPortraits, updatedAt: undefined, reply: this.projection.reply })}`;
        if (!force && signature === this.lastScreenSignature) return 1;
        this.lastScreenSignature = signature;
        const key = `${screen.npcId}|${screen.name}`;
        const scroll = doc.dataset.screenKey === key ? (doc.querySelector('.delta-panes')?.scrollTop || 0) : 0;
        const layout = layoutFor(screen, { phone });
        const board = pane('board', boardHtml(npc, { refs, userName: userName || 'you', peers }));
        const section = () => pane('section', sectionScreenHtml(SECTION_KEYS[screen.section], npc, { userName }));
        let html;
        if (screen.name === 'profile') html = pane('profile', dossierProfileHtml(npc, { layout: phone ? 'phone' : 'desktop', portraitRefs: refs }));
        else if (screen.name === 'section') html = phone ? section() : board + section();
        else html = board;
        this.root.querySelector('.delta-lightbox')?.remove();
        doc.innerHTML = `<div class="delta-panes" data-layout="${layout.mode}" data-screen="${screen.name}">${html}</div>${libraryFootHtml(this.projection.index.length)}`;
        doc.dataset.screen = screen.name;
        doc.dataset.screenKey = key;
        refs.fill(doc);
        const panes = doc.querySelector('.delta-panes');
        if (panes) panes.scrollTop = scroll;
        return 1;
    }
}
