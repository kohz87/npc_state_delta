/* NPC State Delta optional full-cast scanning owner. */
import { extension_settings, getContext } from '../../../extensions.js';
import { npcParticipatesInExchange } from './scan-context.js';

const EXTENSION_NAME = 'npc_state_delta';
const FULL_CAST_KEY = 'fullCastScanEveryTurn';
const CONTROL_ID = 'npc_state_delta_full_cast_scan';
const SCAN_BUTTON_ID = 'npc_state_delta_full_cast_scan_now';
const WAIT_LIMIT_MS = 120000;
let initialized = false;
let sequence = 0;
let userSnapshot = null;
let userSnapshotChatKey = '';

const api = () => globalThis.NPCStateDelta || null;
const cfg = () => {
    const root = extension_settings[EXTENSION_NAME] ||= {};
    if (root[FULL_CAST_KEY] === undefined) root[FULL_CAST_KEY] = false;
    return root;
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function saveSettings() {
    try { getContext().saveSettingsDebounced?.(); } catch {}
}

function latestAssistantId() {
    const chat = getContext()?.chat || [];
    for (let i = chat.length - 1; i >= 0; i -= 1) {
        if (chat[i] && !chat[i].is_system && !chat[i].is_user && String(chat[i].mes || '').trim()) return i;
    }
    return -1;
}

function currentExchange(messageId = null) {
    const chat = getContext()?.chat || [];
    let assistantId = Number.isInteger(messageId) ? messageId : latestAssistantId();
    while (assistantId >= 0 && (chat[assistantId]?.is_system || chat[assistantId]?.is_user)) assistantId -= 1;
    if (assistantId < 0) return { assistantId: -1, text: '' };
    let userId = -1;
    for (let i = assistantId - 1; i >= 0; i -= 1) {
        if (chat[i]?.is_system) continue;
        if (chat[i]?.is_user) userId = i;
        break;
    }
    return {
        assistantId,
        text: [userId >= 0 ? chat[userId]?.mes : '', chat[assistantId]?.mes].filter(Boolean).join('\n'),
    };
}

function fingerprint(npc) {
    try {
        return JSON.stringify({
            present: !!npc.present,
            worldActive: !!npc.worldActive,
            archived: !!npc.archived,
            role: npc.role || '',
            species: npc.species || '',
            age: npc.age || '',
            apparentAge: npc.apparentAge || '',
            personality: npc.personality || '',
            speech: npc.speech || '',
            appearance: npc.appearance || '',
            background: npc.background || '',
            behaviorProfile: npc.behaviorProfile || [],
            keyRelationships: npc.keyRelationships || [],
            relationshipSummary: npc.relationshipSummary || '',
            relationship: npc.relationship || {},
            memories: npc.memories || [],
            mood: npc.mood || '',
            location: npc.location || '',
            goal: npc.goal || '',
            status: npc.status || '',
            lifeState: npc.lifeState || 'unknown',
        });
    } catch {
        return '';
    }
}

function snapshot() {
    try {
        return new Map((api()?.getState?.()?.npcs || []).map(npc => [npc.id, fingerprint(npc)]));
    } catch {
        return new Map();
    }
}

function fullCastTargets(state, exchangeText, before = null) {
    const npcs = state?.npcs || [];
    const ids = new Set();
    for (const npc of npcs) {
        if (!npc?.id || npc.archived) continue;
        if (npc.present) ids.add(npc.id);
        if (npcParticipatesInExchange(npc, npcs, exchangeText)) ids.add(npc.id);
        if (before?.has(npc.id) && before.get(npc.id) !== fingerprint(npc)) ids.add(npc.id);
    }
    return [...ids];
}

async function waitIdle(chatKey, token) {
    const started = Date.now();
    let idleAt = 0;
    while (Date.now() - started < WAIT_LIMIT_MS) {
        if (token !== sequence) return false;
        const status = api()?.uiStatus?.() || {};
        if (status.chatKey !== chatKey) return false;
        if (!status.scanBusyForChat && String(status.swipeState || 'none') === 'none') {
            idleAt ||= Date.now();
            if (Date.now() - idleAt >= 250) return true;
        } else {
            idleAt = 0;
        }
        await sleep(100);
    }
    console.warn('[NPC State Delta] full cast scan timed out waiting for scanner idle.');
    return false;
}

export async function runFullCastScan(messageId = null, before = null, { manual = false } = {}) {
    const npcApi = api();
    const initial = npcApi?.uiStatus?.() || {};
    if (!npcApi || !initial.chatKey || initial.chatKey === 'no-chat' || initial.hydrationStatus !== 'ready') return false;
    const exchange = currentExchange(messageId);
    if (exchange.assistantId < 0) return false;
    const chatKey = initial.chatKey;
    const token = ++sequence;
    if (!await waitIdle(chatKey, token)) return false;
    if (latestAssistantId() !== exchange.assistantId || api()?.uiStatus?.().chatKey !== chatKey) return false;
    let state = npcApi.getState();
    if (Number(state.lastScannedMessageId) !== exchange.assistantId) {
        await npcApi.scan();
        if (!await waitIdle(chatKey, token)) return false;
        if (latestAssistantId() !== exchange.assistantId || api()?.uiStatus?.().chatKey !== chatKey) return false;
        state = npcApi.getState();
    }
    const targets = fullCastTargets(state, exchange.text, before);
    let refreshed = 0;
    for (const id of targets) {
        if (token !== sequence || api()?.uiStatus?.().chatKey !== chatKey || latestAssistantId() !== exchange.assistantId) return false;
        if (!await waitIdle(chatKey, token)) return false;
        if (await npcApi.refreshFromChat(id)) refreshed += 1;
    }
    console.info('[NPC State Delta] full exchange/present cast scan complete', { targets: targets.length, refreshed });
    if (manual) globalThis.toastr?.success?.(`NPC State Delta: full-scanned ${targets.length} exchange/present dossier${targets.length === 1 ? '' : 's'}.`);
    return true;
}

function mountControls() {
    const panel = document.querySelector?.('#npc_state_delta_settings');
    if (!panel) return false;
    if (!document.getElementById(CONTROL_ID)) {
        const anchor = panel.querySelector('#npc_state_delta_full_scan_every_turn')?.closest?.('.npc-state-delta-setting-row');
        anchor?.insertAdjacentHTML?.('afterend', `<label class="npc-state-delta-setting-row" for="${CONTROL_ID}"><span><b>Full cast scan</b><small>Optional expensive mode. After each assistant reply, fully refresh every tracked NPC who participated anywhere in the current user/assistant exchange plus every NPC physically present at the end. Physical presence itself is not changed by this extra pass.</small></span><input id="${CONTROL_ID}" type="checkbox"></label>`);
    }
    const control = document.getElementById(CONTROL_ID);
    if (control && control.dataset.npcStateDeltaBound !== '1') {
        control.checked = cfg()[FULL_CAST_KEY] === true;
        control.dataset.npcStateDeltaBound = '1';
        control.addEventListener('change', () => {
            cfg()[FULL_CAST_KEY] = Boolean(control.checked);
            saveSettings();
        });
    }
    const actions = panel.querySelector('.npc-state-delta-actions');
    if (actions && !document.getElementById(SCAN_BUTTON_ID)) {
        const button = document.createElement('div');
        button.id = SCAN_BUTTON_ID;
        button.className = 'menu_button';
        button.innerHTML = '<i class="fa-solid fa-users-viewfinder"></i> Full scan current cast';
        button.addEventListener('click', () => void runFullCastScan(latestAssistantId(), snapshot(), { manual: true }));
        actions.appendChild(button);
    }
    return true;
}

function registerEvents() {
    const ctx = getContext();
    const source = ctx?.eventSource;
    const events = ctx?.eventTypes || ctx?.event_types || {};
    if (!source?.on) return;
    if (events.MESSAGE_SENT) {
        source.on(events.MESSAGE_SENT, () => {
            userSnapshotChatKey = api()?.uiStatus?.().chatKey || '';
            userSnapshot = snapshot();
        });
    }
    if (events.MESSAGE_RECEIVED) {
        source.on(events.MESSAGE_RECEIVED, messageId => {
            if (cfg()[FULL_CAST_KEY] !== true) return;
            const chatKey = api()?.uiStatus?.().chatKey || '';
            const before = userSnapshotChatKey === chatKey ? userSnapshot : snapshot();
            void runFullCastScan(Number.isInteger(messageId) ? messageId : latestAssistantId(), before);
        });
    }
    if (events.CHAT_CHANGED) {
        source.on(events.CHAT_CHANGED, () => {
            sequence += 1;
            userSnapshot = null;
            userSnapshotChatKey = '';
            setTimeout(mountControls, 50);
        });
    }
    for (const name of ['CHAT_LOADED', 'APP_READY', 'EXTENSION_SETTINGS_LOADED']) {
        if (events[name]) source.on(events[name], () => setTimeout(mountControls, 50));
    }
}

function init() {
    if (initialized) return void mountControls();
    initialized = true;
    cfg();
    registerEvents();
    mountControls();
    let attempts = 0;
    const timer = setInterval(() => {
        attempts += 1;
        if (mountControls() || attempts >= 40) clearInterval(timer);
    }, 250);
}

if (typeof globalThis.$ === 'function') globalThis.$(init);
else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();

export const NPC_STATE_FULL_CAST = Object.freeze({ runFullCastScan });
