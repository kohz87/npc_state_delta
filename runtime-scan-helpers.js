/* NPC State Delta scan helpers (role: scan-helpers). Stateless readers of the open chat and small helpers the scan, injection, editor and mutation code share:
   the latest message and reply positions, the lineage key of a message, whether a chat moved between two lineages, the relationship number clamp,
   a manual edit's change stamp, the scan and dossier-scan indicators, the capture setting, and the user-dismissed suppression clear. Nothing here
   holds state. Bodies are moved from index.js without change. */

import { getContext } from '../../../extensions.js';
import { storyDayAt } from './src/transcript.js';
import { stampNpcChanges } from './src/relationship-pass.js';
import { normalizeName, normalizeRelationshipBaseline, npcMatchesLabel } from './core.js';
import { rejectedOverallLook } from './appearance-update.js';
import { moodNumbers } from './npc-mood.js';
import { chatLineage, firstLineageDivergence, lineageCheckpointKey, clearUserDismissedGroupsFor } from './branch.js';
import { getSettings } from './runtime-settings.js';
import { setScannerWaitAround } from './scanner-routing.js';

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
// While the replay's scan waits for the model (minutes), nothing of the replay runs: the scope steps aside, so the dossier panel, token counts,
// injection and the editor read and write the installed state (an edit there moves the head's fingerprint, the catch-up finds itself stale and
// retries on top of it). The scope is back before the replay's next line runs.
export async function awayFromReplay(promise) {
    const mine = replay;
    replay = null;
    try { return await promise; } finally { replay = mine; }
}
setScannerWaitAround(awayFromReplay);
// Story Block as a replay sees it: reads answer from the state after reply `index` (sdk.query { asOf }, adapter.at), writes are not sent.
const HOSTED_WRITES = new Set(['adjust', 'setMeters', 'refresh', 'applyEditor', 'openByEvent', 'tick']);
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

// Whether the message a chatHeadMark was taken at is still there: the same object at the same place with the same swipe (a reply taken back by a
// swipe, a delete or another chat is not). The reply a held host command was meant for (src/adapter/queries.js), unlike chatHeadUnchanged it stays
// true when later replies come.
export function markStands(mark) {
    const chat = chatContext().chat || [];
    const message = mark ? chat[(mark.length ?? 0) - 1] ?? null : null;
    return Boolean(mark) && message === mark.message && (Number.isInteger(message?.swipe_id) ? message.swipe_id : null) === mark.swipe;
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

// What a committed scan tells the slice, read from the people before and after it (moved from runtime-hosted.js, bodies unchanged).
// Each person's relationship moves since the scan began, as npc.adjust payloads; the tier the scanner gave the scan's newest event rides along
// (one event however many meters it moved); none known: sent without one, and not counted. `onePassRows` (a one-pass block's own rows, else null): each
// person's relationshipEvidence for the axes the row moved rides along as `why`, also with no move of its own (the slice uses it only as the reason
// of the same reply's story line that gave none; the sidecar drops a one-pass delta, which carries no relationshipChangeReason).
export function relationshipChanges(prior, after, baseline, messageId, onePassRows = null) {
    const changes = [];
    for (const npc of after || []) {
        if (!npc?.id || npc.archived) continue;
        const from = prior.has(npc.id) ? normalizeRelationshipBaseline(prior.get(npc.id).relationship) : baseline;
        const to = normalizeRelationshipBaseline(npc.relationship);
        const meters = Object.fromEntries(Object.keys(to).filter(key => to[key] !== from[key]).map(key => [key, to[key] - from[key]]));
        const last = npc.lastRelationshipChange;
        const fresh = last && JSON.stringify(last) !== JSON.stringify(prior.get(npc.id)?.lastRelationshipChange);
        const why = onePassRows ? onePassEvidence(onePassRows, npc) : null;
        if (Object.keys(meters).length || why) changes.push({ name: npc.name, meters, start: from, reply: messageId, ...(fresh && typeof last.impact === 'string' ? { impact: last.impact } : {}), ...(why ? { why } : {}) });
    }
    return changes;
}

// A one-pass row's evidence for each axis it moved (non-zero delta, non-empty words): { trust: 'words' }, or null.
function onePassEvidence(rows, npc) {
    const row = (Array.isArray(rows) ? rows : []).find(item => item && ((item.id && item.id === npc.id) || (item.name && npcMatchesLabel(npc, item.name))));
    const delta = row?.relationshipDelta ?? row?.relationship_delta;
    const words = row?.relationshipEvidence ?? row?.relationship_evidence;
    if (!delta || typeof delta !== 'object' || !words || typeof words !== 'object') return null;
    const why = Object.fromEntries(['trust', 'affection', 'desire', 'tension'].filter(axis => Number(delta[axis]) && typeof words[axis] === 'string' && words[axis].trim()).map(axis => [axis, words[axis].trim().slice(0, 240)]));
    return Object.keys(why).length ? why : null;
}

// A durable look the scan refused (the story did not explain a change): one entry per person, for a Problem and a next-reply cue.
export function refusedLooks(prior, after, updates = []) {
    const refused = [];
    const afterBy = new Map((after || []).map(npc => [npc?.id, npc]));
    for (const row of Array.isArray(updates) ? updates : []) {
        const was = prior.get(row?.id);
        const now = afterBy.get(row?.id);
        if (!was || !now || now.archived) continue;
        const rejected = rejectedOverallLook(was.overallAppearance, now.overallAppearance, row);
        if (rejected && !refused.some(item => item.id === now.id)) refused.push({ id: now.id, name: now.name, before: was.overallAppearance, incoming: rejected.incoming });
    }
    return refused;
}

// The three mood numbers the scan gave with a person's mood word (its row's moodV / moodA / moodD, only with a mood text), or null.
export function scanMoodNumbers(rows, npc, moodOf) {
    const row = (Array.isArray(rows) ? rows : []).find(item => item && ((item.id && item.id === npc.id) || (item.name && npcMatchesLabel(npc, item.name))));
    return moodOf(row) ? moodNumbers(row) : null;
}

// A person worth a slice entry: not the dead and not incidental extras (the slice holds 80 people; a long chat must not fill it with people who never matter).
export const worth = npc => !['dead', 'deceased'].includes(String(npc.lifeState ?? '').toLowerCase()) && npc.dossierSignal !== 'incidental';
