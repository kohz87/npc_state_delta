// Optional Story Block integration. When Story Block's public tab API is present, the present cast
// and the dossier list appear as two tabs in its sidebar and card, beside the story's own blocks.
// Display only: it reads the runtime API and opens dossiers through it; it never writes state,
// prompts or messages, and nothing changes when Story Block is not installed.
import { dossierIndexProjection, filterDossierIndex } from './dossier-ui.js';

export const STORY_BLOCK_TAB_IDS = Object.freeze({ cast: 'npc-state-delta-cast', dossiers: 'npc-state-delta-dossiers' });
const CONNECTED_FLAG = 'npcStateDeltaStoryBlock';
const EMPTY_CAST = '<p class="npc-state-delta-story-empty">No NPC is present in the latest scene.</p>';
// Story Block's panes add no padding of their own around another extension's content.
const paneHtml = html => `<div class="npc-state-delta-story-pane">${html}</div>`;

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function dossierTabRowsHtml(rows = []) {
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
    const renderCast = pane => {
        const html = paneHtml(String(api.presentCastHtml?.() || '') || EMPTY_CAST);
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
            pane.addEventListener?.('click', event => {
                const row = event.target?.closest?.('.npc-state-delta-story-row');
                if (row?.dataset?.npcId) api.openDossier?.(row.dataset.npcId);
            });
            pane.__npcStateDeltaDossiers = { list: pane.querySelector('.npc-state-delta-story-list'), key: '' };
        }
        const view = pane.__npcStateDeltaDossiers;
        const visible = filterDossierIndex(currentRows(), { query });
        const key = `${revision}|${query}`;
        if (view.list && view.key !== key) {
            view.list.innerHTML = dossierTabRowsHtml(visible);
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
