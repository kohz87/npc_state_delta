/* NPC State Delta scan helpers (role: scan-helpers). Stateless readers of the open chat and small helpers the scan, injection, editor and mutation code share:
   the latest message and reply positions, the lineage key of a message, whether a chat moved between two lineages, the relationship number clamp,
   a manual edit's change stamp, the scan and dossier-scan indicators, the capture setting, and the user-dismissed suppression clear. Nothing here
   holds state. Bodies are moved from index.js without change. */

import { getContext } from '../../../extensions.js';
import { storyDayAt } from './src/transcript.js';
import { stampNpcChanges } from './src/relationship-pass.js';
import { normalizeName } from './core.js';
import { chatLineage, firstLineageDivergence, lineageCheckpointKey, clearUserDismissedGroupsFor } from './branch.js';
import { getSettings } from './runtime-settings.js';

// ---- history replay scope ----
// While a history replay reads one missed reply, `replay` is the scope of that reply (one at a time: the scan operation of the replay holds the chat
// busy, and sending is held): { key, chat (the messages up to the reply), state (the engine's private copy), sink, now(), receipts, captures,
// catchUp }. Everything the live scan path reads of "now" goes through chatContext()/clockNow()/replayScope(), and every outward write through
// notify()/the scope's sink; with no scope (live) they are the real getContext, Date.now and toastr, byte for byte.
let replay = null;
export const replayScope = () => replay;
export function chatContext() {
    const real = getContext();
    return replay ? Object.create(real, { chat: { value: replay.chat } }) : real;
}
export const clockNow = () => (replay ? replay.now() : Date.now());
export async function inReplay(scope, fn) {
    replay = scope;
    try { return await fn(); } finally { replay = null; }
}
// Story Block as a replay sees it: reads answer from the state after reply `index` (sdk.query { asOf }, adapter.at), writes are not sent.
const HOSTED_WRITES = new Set(['adjust', 'setMeters', 'refresh', 'applyEditor', 'openByEvent', 'tick', 'pinKeyPerson']);
export function scopedAdapter(adapter, index, sink) {
    return new Proxy(adapter, {
        get(target, name) {
            const value = target[name];
            if (typeof value !== 'function') return value;
            if (HOSTED_WRITES.has(name)) return (...args) => { sink.hostedWrite(name, args); return Promise.resolve(null); };
            return (...args) => (typeof target.at === 'function' ? target.at(index, () => value(...args)) : value(...args));
        },
    });
}
/** A toast: shown live, recorded in the sink during a replay. */
export function notify(kind, text) {
    if (replay) replay.sink.toast(kind, text);
    else globalThis.toastr?.[kind]?.(text);
}

export function setNpcDossierScanIndicator(npcId, busy) {
    const id = String(npcId || '');
    document.querySelectorAll?.(`.npc-state-delta-scan-dossier[data-npc-id="${globalThis.CSS?.escape ? globalThis.CSS.escape(id) : id.replace(/"/g, '\\"')}"]`)?.forEach?.(button => {
        button.classList?.toggle?.('npc-state-delta-busy', Boolean(busy));
        if (button.setAttribute) button.setAttribute('aria-busy', busy ? 'true' : 'false');
    });
}

export function setNpcChatRefreshIndicator(npcId, busy) {
    const id = String(npcId || '');
    const selectorId = globalThis.CSS?.escape ? globalThis.CSS.escape(id) : id.replace(/"/g, '\\"');
    document.querySelectorAll?.(`.npc-state-delta-refresh-chat[data-npc-id="${selectorId}"]`)?.forEach?.(button => {
        button.classList?.toggle?.('npc-state-delta-busy', Boolean(busy));
        if (button.setAttribute) button.setAttribute('aria-busy', busy ? 'true' : 'false');
        if (button.innerHTML !== undefined) button.innerHTML = busy
            ? '<i class="fa-solid fa-spinner fa-spin"></i> Refreshing from chat...'
            : '<i class="fa-solid fa-arrows-rotate"></i> Refresh from Chat';
    });
}

// The stamps for one of the reader's own edits: Delta's turn and the latest reply.
export function stampManualEdit(state, npc, before) {
    const reply = latestReplyIndex();
    return stampNpcChanges(npc, before, { turn: state.turn, message: reply >= 0 ? reply : null, storyDay: storyDayAt(reply >= 0 ? reply : undefined) });
}

export function narrationCaptureEnabled(settings = getSettings()) {
    return Boolean(settings.enabled && settings.narrationCapture && settings.autoScan && !settings.fullScanEveryTurn);
}

// A change between two lineages other than the reply at `messageId` rewritten in place.
export function lineageMoved(previous, current, messageId) {
    const at = firstLineageDivergence(previous, current);
    if (at === -1) return false;
    if (!Number.isInteger(messageId) || at !== messageId || previous.length !== current.length) return true;
    return previous.slice(messageId + 1).some((entry, index) => entry !== current[messageId + 1 + index]);
}

export function setScanIndicator(busy) {
    if (replay) return;
    const button = $('#npc_state_delta_scan_now');
    if (!button.length) return;
    button.toggleClass('npc-state-delta-busy', busy);
    button.html(busy ? '<i class="fa-solid fa-spinner fa-spin"></i> Scanning dossier...' : '<i class="fa-solid fa-wand-magic-sparkles"></i> Scan dossier now');
}

export function relationshipNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(Math.max(-100, Math.min(100, number))) : 0;
}

// The chat message index of the latest assistant reply (the greeting is 0), or -1: the number Story
// Block shows as "reply #N" and the dossiers show for changes recorded since 1.2.3.
export function latestReplyIndex() {
    const chat = chatContext().chat || [];
    for (let i = chat.length - 1; i >= 0; i -= 1) {
        if (chat[i] && !chat[i].is_system && !chat[i].is_user) return i;
    }
    return -1;
}

export function latestMessageId(preferAssistant = false) {
    const chat = chatContext().chat || [];
    if (preferAssistant) {
        for (let i = chat.length - 1; i >= 0; i -= 1) {
            if (chat[i] && !chat[i].is_system && !chat[i].is_user) return i;
        }
    }
    for (let i = chat.length - 1; i >= 0; i -= 1) {
        if (chat[i] && !chat[i].is_system) return i;
    }
    return -1;
}


export function currentLineageKeyForMessage(messageId) {
    const lineage = chatLineage(chatContext().chat || []);
    return lineageCheckpointKey(lineage, messageId);
}

export function clearUserDismissedSuppression(state, target) {
    if (!state || typeof state !== 'object') return state;
    const cleared = clearUserDismissedGroupsFor(state.userDismissedGroups, target, { modernByIdOnly: true });
    state.userDismissedGroups = cleared.groups;
    if (cleared.removedLabels.length) {
        const removed = new Set(cleared.removedLabels.map(normalizeName).filter(Boolean));
        state.dismissed = (Array.isArray(state.dismissed) ? state.dismissed : [])
            .filter(label => !removed.has(normalizeName(label)));
    }
    return state;
}
