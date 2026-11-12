// Display helpers for Delta's Cast and Dossiers lists in the Story Suite v2 host (src/storysuite-v2.js loads them lazily):
// the dossier list rows and the empty-cast line. The v1 Story Block tab registration is gone (12 Nov): Story Block is v2 only.
// Display only: DOM built with textContent; nothing here writes state, prompts or messages.
import { escapeHtml } from './src/util/html.js';

// (1.2.13) An empty tab says why, and offers what would fill it.
const actionButton = (action, icon, label) => `<button type="button" class="menu_button npc-state-delta-story-action" data-npc-state-delta-action="${action}"><i class="fa-solid ${icon}"></i> ${label}</button>`;
export function emptyCastHtml(reason = null) {
    const text = String(reason?.text || 'No NPC is present in the latest scene.');
    const actions = reason?.scan ? `<div class="npc-state-delta-story-actions">${actionButton('scan', 'fa-wand-magic-sparkles', 'Scan now')}</div>` : '';
    return `<div class="npc-state-delta-story-empty-state"><p class="npc-state-delta-story-empty">${escapeHtml(text)}</p>${actions}</div>`;
}
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
function keyStarNode(doc) {
    const star = make(doc, 'span', 'npc-state-delta-key-star', ' ★');
    star.setAttribute('title', 'Key person');
    star.setAttribute('aria-label', 'Key person');
    return star;
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
    const title = make(doc, 'b', 'ss-listcard-title', row.name);
    // A key person (Story Director's key people) is marked with a ★ after the name.
    if (row.key === true) title.append(keyStarNode(doc));
    text.append(title, make(doc, 'small', 'ss-listcard-sub', [row.role, row.statusLabel].filter(Boolean).join(' · ')));
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
