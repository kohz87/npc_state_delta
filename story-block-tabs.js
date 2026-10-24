// Optional Story Block integration. When Story Block's public tab API is present, the present cast
// and the dossier list appear as two tabs in its sidebar and card, beside the story's own blocks.
// Display only: it reads the runtime API and opens dossiers through it; it never writes state,
// prompts or messages, and nothing changes when Story Block is not installed.
import { dossierIndexProjection, filterDossierIndex } from './dossier-ui.js';
import { storyBlockIsV2 } from './suite-handshake.js';
import { escapeHtml } from './src/util/html.js';

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


// UI 4c: each dossier is a row of Story Block's listcard (ss.listcard's classes): the portrait, the name, the role and
// status line, the stage as a pill and the NPC's meters as thin ss.bar bars (the widget's markup). The stage and the
// bars come from npc.cast (storysuite-v2.js). The bars are at most DOSSIER_BAR_MAX: ss.hero's BAR_MAX (Story Block,
// src/v2/view/widgets/hero.js). The rows are not capped: the list is Delta's, and a dossier is never hidden.
// Built with DOM APIs: every name, role, stage and meter label is set with textContent, never parsed as markup.
export const DOSSIER_BAR_MAX = 6;
const make = (doc, tag, className = '', text = null) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== null && text !== undefined) node.textContent = String(text);
    return node;
};
const barFraction = bar => {
    const min = Number.isFinite(Number(bar.min)) ? Number(bar.min) : 0;
    const max = Number.isFinite(Number(bar.max)) ? Number(bar.max) : 100;
    const value = Number(bar.value);
    if (!Number.isFinite(value) || max <= min) return 0;
    return Math.min(1, Math.max(0, (value - min) / (max - min)));
};
function barNode(doc, bar) {
    const item = make(doc, 'span', 'ss-bar');
    const head = make(doc, 'span', 'ss-bar-head');
    head.append(make(doc, 'span', 'ss-bar-label', bar.label || bar.id || ''), make(doc, 'span', 'ss-bar-value', bar.text ?? bar.value ?? ''));
    const track = make(doc, 'span', 'ss-bar-track');
    const fill = make(doc, 'span', 'ss-bar-fill');
    fill.setAttribute('style', `--ss-fill: ${barFraction(bar).toFixed(3)}`);
    track.append(fill);
    item.append(head, track);
    return item;
}
function rowNode(doc, row) {
    const item = make(doc, 'li', 'ss-listcard-row');
    const button = make(doc, 'button', 'ss-listcard-item npc-state-delta-story-row');
    button.dataset.npcId = String(row.id ?? '');
    button.setAttribute('aria-label', `Open ${row.name} dossier`);
    button.setAttribute('type', 'button');
    const thumb = make(doc, 'span', 'npc-state-delta-story-thumb ss-listcard-icon');
    if (row.portrait) {
        const img = make(doc, 'img');
        img.setAttribute('src', row.portrait);
        img.setAttribute('alt', '');
        img.setAttribute('loading', 'lazy');
        thumb.append(img);
    } else {
        thumb.append(make(doc, 'span', '', Array.from(String(row.name ?? '').trim())[0]?.toUpperCase() || '?'));
    }
    const text = make(doc, 'span', 'npc-state-delta-story-text ss-listcard-main');
    text.append(make(doc, 'b', 'ss-listcard-title', row.name), make(doc, 'small', 'ss-listcard-sub', [row.role, row.statusLabel].filter(Boolean).join(' · ')));
    const bars = (Array.isArray(row.bars) ? row.bars : []).filter(bar => bar && typeof bar === 'object').slice(0, DOSSIER_BAR_MAX);
    if (bars.length) {
        const wrap = make(doc, 'span', 'npc-state-delta-story-bars');
        wrap.setAttribute('aria-hidden', 'true');
        for (const bar of bars) wrap.append(barNode(doc, bar));
        text.append(wrap);
    }
    button.append(thumb, text);
    if (row.stage) button.append(make(doc, 'span', 'ss-pill ss-listcard-value npc-state-delta-story-stage', row.stage));
    item.append(button);
    return item;
}
function actionNode(doc, action, icon, label) {
    const button = make(doc, 'button', 'menu_button npc-state-delta-story-action');
    button.dataset.npcStateDeltaAction = action;
    button.setAttribute('type', 'button');
    button.append(make(doc, 'i', `fa-solid ${icon}`), textNodeOf(doc, ` ${label}`));
    return button;
}
const textNodeOf = (doc, text) => doc.createTextNode ? doc.createTextNode(text) : make(doc, 'span', '', text);
/** The dossier list's nodes: the rows, or the one line that says why there are none (with the actions that fill it). */
export function dossierRowNodes(rows = [], doc = globalThis.document, { query = '', total = null } = {}) {
    const needle = String(query).trim();
    if (!rows.length && needle) return [make(doc, 'p', 'npc-state-delta-story-empty', `No dossier matches “${needle}”.`)];
    if (!rows.length && total === 0) {
        const box = make(doc, 'div', 'npc-state-delta-story-empty-state');
        box.append(make(doc, 'p', 'npc-state-delta-story-empty', 'No dossiers yet. An NPC gets one when a scan finds them in the story, or you can add one yourself.'));
        const actions = make(doc, 'div', 'npc-state-delta-story-actions');
        actions.append(actionNode(doc, 'add', 'fa-user-plus', 'Add NPC'), actionNode(doc, 'scan', 'fa-wand-magic-sparkles', 'Scan now'));
        box.append(actions);
        return [box];
    }
    if (!rows.length) return [make(doc, 'p', 'npc-state-delta-story-empty', 'No dossier matches.')];
    return rows.map(row => rowNode(doc, row));
}

// Story Block re-renders external tabs on every refresh, so both panes keep their own DOM and
// only replace what changed; the search box keeps focus and its text across refreshes.
// A Story Block v2 host (apiVersion 2) gets Delta's Cast tab through its sdk instead
// (src/storysuite-v2.js), so these v1 tabs are not offered to it.
export function connectStoryBlock(api, storyBlock) {
    if (!api || storyBlockIsV2(storyBlock) || typeof storyBlock?.registerTab !== 'function') return null;
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
            view.list.replaceChildren(...dossierRowNodes(visible, view.list.ownerDocument, { query, total: rows.length }));
            view.key = key;
        }
    };
    // (1.2.15) The tabs are there only while Delta is on: switched off, they leave at once (other
    // extensions' tabs do), and come back when it is switched on again.
    const tabs = [
        { id: STORY_BLOCK_TAB_IDS.cast, label: 'Present NPCs', short: 'Present', icon: '🎭', order: 200, render: renderCast },
        { id: STORY_BLOCK_TAB_IDS.dossiers, label: 'Dossiers', short: 'Dossiers', icon: '📇', order: 201, render: renderDossiers },
    ];
    let shown = false;
    const syncTabs = () => {
        const on = api.isEnabled?.() !== false;
        if (on === shown) return false;
        if (!on && typeof storyBlock.unregisterTab !== 'function') return false;
        for (const tab of tabs) {
            if (on) storyBlock.registerTab(tab);
            else storyBlock.unregisterTab(tab.id);
        }
        shown = on;
        return true;
    };
    syncTabs();
    if (globalThis.document?.documentElement?.dataset) globalThis.document.documentElement.dataset[CONNECTED_FLAG] = '1';
    // A new reply, swipe or edit in Story Block can change the World State and chatter the cast
    // shows; the in-chat cards follow (the tab re-renders with Story Block itself).
    try { storyBlock.onUpdate?.(() => api.renderInline?.()); } catch { /* optional */ }
    return {
        syncTabs,
        // A v2 host took over the page: the v1 tabs leave (when Story Block can take them back) and
        // the in-chat cast no longer counts them as carried by Story Block.
        disconnect() {
            if (shown && typeof storyBlock.unregisterTab === 'function') {
                for (const tab of tabs) {
                    try { storyBlock.unregisterTab(tab.id); } catch { /* already gone */ }
                }
            }
            shown = false;
            if (globalThis.document?.documentElement?.dataset) delete globalThis.document.documentElement.dataset[CONNECTED_FLAG];
        },
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

// Sent by src/storysuite-v2.js when Delta registers with a Story Block v2 host, and when that host goes away.
export const V2_HOST_EVENT = 'npc-state-delta:v2-host';

let connection = null;
function startStoryBlockTabs(attempt = 0) {
    if (connection) return;
    const api = globalThis.NPCStateDelta;
    const storyBlock = globalThis.StoryBlock;
    if (storyBlockIsV2(storyBlock)) return;
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
    document.addEventListener('npc-state-delta:enabled-changed', () => connection?.syncTabs());
    document.addEventListener(V2_HOST_EVENT, event => {
        if (event?.detail?.hosted === true) {
            connection?.disconnect();
            connection = null;
            globalThis.NPCStateDelta?.renderInline?.();
        } else if (!connection) {
            startStoryBlockTabs();
        }
    });
    queueMicrotask(() => startStoryBlockTabs());
}
