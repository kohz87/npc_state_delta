// Optional Story Block integration. When Story Block's public tab API is present, the present cast
// and the dossier list appear as two tabs in its sidebar and card, beside the story's own blocks.
// Display only: it reads the runtime API and opens dossiers through it; it never writes state,
// prompts or messages, and nothing changes when Story Block is not installed.
import { dossierIndexProjection, filterDossierIndex } from './dossier-ui.js';

export const STORY_BLOCK_TAB_IDS = Object.freeze({ cast: 'npc-state-delta-cast', dossiers: 'npc-state-delta-dossiers' });
const CONNECTED_FLAG = 'npcStateDeltaStoryBlock';
// (1.2.13) An empty tab says why, and offers what would fill it.
const actionButton = (action, icon, label) => `<button type="button" class="menu_button npc-state-delta-story-action" data-npc-state-delta-action="${action}"><i class="fa-solid ${icon}"></i> ${label}</button>`;
export function emptyCastHtml(reason = null) {
    const text = String(reason?.text || 'No NPC is present in the latest scene.');
    const actions = reason?.scan ? `<div class="npc-state-delta-story-actions">${actionButton('scan', 'fa-wand-magic-sparkles', 'Scan now')}</div>` : '';
    return `<div class="npc-state-delta-story-empty-state"><p class="npc-state-delta-story-empty">${escapeHtml(text)}</p>${actions}</div>`;
}
// Story Block's panes add no padding of their own around another extension's content.
const paneHtml = html => `<div class="npc-state-delta-story-pane">${html}</div>`;

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function dossierTabRowsHtml(rows = [], { query = '', total = null } = {}) {
    if (!rows.length && String(query).trim()) return `<p class="npc-state-delta-story-empty">No dossier matches “${escapeHtml(String(query).trim())}”.</p>`;
    if (!rows.length && total === 0) {
        return `<div class="npc-state-delta-story-empty-state"><p class="npc-state-delta-story-empty">No dossiers yet. An NPC gets one when a scan finds them in the story, or you can add one yourself.</p><div class="npc-state-delta-story-actions">${actionButton('add', 'fa-user-plus', 'Add NPC')}${actionButton('scan', 'fa-wand-magic-sparkles', 'Scan now')}</div></div>`;
    }
    if (!rows.length) return '<p class="npc-state-delta-story-empty">No dossier matches.</p>';
    return rows.map(row => {
        const initial = escapeHtml((row.name || '?').trim().charAt(0).toUpperCase() || '?');
        const portrait = row.portrait
            ? `<img src="${escapeHtml(row.portrait)}" alt="" loading="lazy">`
            : `<span>${initial}</span>`;
        const detail = [row.role, row.statusLabel].filter(Boolean).join(' · ');
        return `<button type="button" class="npc-state-delta-story-row" data-npc-id="${escapeHtml(row.id)}" aria-label="Open ${escapeHtml(row.name)} dossier"><span class="npc-state-delta-story-thumb">${portrait}</span><span class="npc-state-delta-story-text"><b>${escapeHtml(row.name)}</b><small>${escapeHtml(detail)}</small></span></button>`;
    }).join('');
}

// Story Block re-renders external tabs on every refresh, so both panes keep their own DOM and
// only replace what changed; the search box keeps focus and its text across refreshes.
export function connectStoryBlock(api, storyBlock) {
    if (!api || typeof storyBlock?.registerTab !== 'function') return null;
    let revision = null;
    let rows = [];
    let query = '';
    let refreshedRevision = null;
    const currentRows = () => {
        const next = String(api.dossierRevision?.() ?? '');
        if (next !== revision) {
            const state = api.getDossierState?.() || { npcs: [] };
            rows = (state.npcs || []).map(npc => dossierIndexProjection(npc, state.portraitAssets || {}));
            revision = next;
        }
        return rows;
    };
    // One click listener per pane, whatever it shows next: a dossier row, or an empty state's button.
    const bindActions = pane => {
        if (pane.__npcStateDeltaActions) return;
        pane.__npcStateDeltaActions = true;
        pane.addEventListener?.('click', event => {
            const action = event.target?.closest?.('[data-npc-state-delta-action]')?.dataset?.npcStateDeltaAction;
            if (action === 'scan') return void api.scan?.();
            if (action === 'add') return void api.addNpc?.();
            const row = event.target?.closest?.('.npc-state-delta-story-row');
            if (row?.dataset?.npcId) api.openDossier?.(row.dataset.npcId);
        });
    };
    const renderCast = pane => {
        bindActions(pane);
        const html = paneHtml(String(api.presentCastHtml?.() || '') || emptyCastHtml(api.castEmptyReason?.()));
        if (pane.__npcStateDeltaCast !== html) {
            pane.innerHTML = html;
            pane.__npcStateDeltaCast = html;
            // The now lines and chatter bubbles get their text through textContent, never markup.
            api.fillPresentCast?.(pane);
        }
    };
    const renderDossiers = pane => {
        if (!pane.__npcStateDeltaDossiers) {
            pane.innerHTML = paneHtml('<div class="npc-state-delta-story-dossiers"><input type="search" class="text_pole npc-state-delta-story-search" placeholder="Search dossiers" aria-label="Search dossiers"><div class="npc-state-delta-story-list"></div></div>');
            const input = pane.querySelector('.npc-state-delta-story-search');
            if (input) input.value = query;
            input?.addEventListener?.('input', () => {
                query = input.value;
                renderDossiers(pane);
            });
            bindActions(pane);
            pane.__npcStateDeltaDossiers = { list: pane.querySelector('.npc-state-delta-story-list'), key: '' };
        }
        const view = pane.__npcStateDeltaDossiers;
        const visible = filterDossierIndex(currentRows(), { query });
        const key = `${revision}|${query}`;
        if (view.list && view.key !== key) {
            view.list.innerHTML = dossierTabRowsHtml(visible, { query, total: rows.length });
            view.key = key;
        }
    };
    storyBlock.registerTab({ id: STORY_BLOCK_TAB_IDS.cast, label: 'Present NPCs', icon: '👥', order: 200, render: renderCast });
    storyBlock.registerTab({ id: STORY_BLOCK_TAB_IDS.dossiers, label: 'Dossiers', icon: '📇', order: 201, render: renderDossiers });
    if (globalThis.document?.documentElement?.dataset) globalThis.document.documentElement.dataset[CONNECTED_FLAG] = '1';
    // A new reply, swipe or edit in Story Block can change the World State and chatter the cast
    // shows; the in-chat cards follow (the tab re-renders with Story Block itself).
    try { storyBlock.onUpdate?.(() => api.renderInline?.()); } catch { /* optional */ }
    return {
        // Called after Delta redraws its cast; Story Block redraws only when Delta's state moved.
        refresh() {
            const next = String(api.dossierRevision?.() ?? '');
            if (next === refreshedRevision) return false;
            refreshedRevision = next;
            storyBlock.refresh?.();
            return true;
        },
    };
}

let connection = null;
function startStoryBlockTabs(attempt = 0) {
    if (connection) return;
    const api = globalThis.NPCStateDelta;
    const storyBlock = globalThis.StoryBlock;
    if (api && typeof storyBlock?.registerTab === 'function') {
        connection = connectStoryBlock(api, storyBlock);
        // The in-chat cast follows the "Story Block" display choice once the tabs exist.
        api.renderInline?.();
        connection?.refresh();
        return;
    }
    if (attempt < 40) setTimeout(() => startStoryBlockTabs(attempt + 1), 250);
}

if (typeof document !== 'undefined') {
    document.addEventListener('npc-state-delta:cast-rendered', () => (connection ? connection.refresh() : startStoryBlockTabs(40)));
    queueMicrotask(() => startStoryBlockTabs());
}
