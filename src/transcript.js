// The story text Delta's scans and prompts read from the chat: recent windows, the current exchange
// (the latest reply and the user message it answers), the World State story day and the names that
// are never NPCs. (cleanup step 10) Moved out of index.js unchanged; index.js wires in the host's
// chat context and the Scan context setting once, with useTranscriptSource.
import { storyDayFromText, storyProse, stripUiNoise } from '../core.js';

let readContext = () => ({ chat: [] });
let readScanDepth = () => 6;
export function useTranscriptSource({ context, scanDepth }) {
    if (typeof context === 'function') readContext = context;
    if (typeof scanDepth === 'function') readScanDepth = scanDepth;
}

// (timeline participant) Which of the chat's messages the story still stands on. After a restore Story Block fades the replies of the dead
// timeline and hides them with SillyTavern's own flag (`is_system`), which every reader below already skips, so a prompt needs no filtering of
// its own. The gate is the second look, for a message the host could not hide and for the moment before it has: `gate` = { refresh():
// Promise<boolean[] | null>, settled(): Promise<boolean> } from the Story Suite adapter, or none (the chat as it is, byte for byte).
// `refresh` answers Story Block's one active-history filter (`sdk.timeline.history`), one entry per message of the chat as it stood when it
// was asked; the faded messages are remembered by identity, so a delete or a swipe after it cannot move the mark onto another message. A faded
// message reads as a system message: skipped by every walk below, and its index is kept.
let gate = null;
let faded = null;   // WeakSet of the chat's message objects the story no longer stands on, as of the last refresh; null: none known
export function useMessageGate(next) {
    gate = next && typeof next.refresh === 'function' ? next : null;
    if (!gate) faded = null;
}
/** Asks the host which messages are faded now. Awaited before any prompt is built from the chat (a scan, a refresh, an import, a backfill). */
export async function refreshMessageGate() {
    if (!gate) return;
    const chat = [...(readContext().chat || [])];
    let flags = null;
    try { flags = await gate.refresh(); } catch { flags = null; }
    const list = Array.isArray(flags) && flags.length === chat.length ? chat.filter((message, at) => flags[at] === false && message && typeof message === 'object') : [];
    faded = list.length ? new WeakSet(list) : null;
}
/**
 * Whether the host's head-selection barrier is down and Delta stands on the checkpoint of the selected head (Story Block's barrier;
 * participants.md). Awaited before a scan, a targeted pass, a branch reconcile or a generation reads or writes the dossiers. true without a gate.
 */
export async function messageGateSettled() {
    if (typeof gate?.settled !== 'function') return true;
    try { return (await gate.settled()) !== false; } catch { return true; }
}
/** The chat as the story stands on it: the faded messages read as system messages; the same array when none is faded. */
export function activeChat(chat = readContext().chat || []) {
    if (!faded) return chat;
    return chat.map(message => (message && faded.has(message) ? { ...message, is_system: true } : message));
}

export function cleanMessage(message) {
    if (!message || message.is_system) return '';
    const speaker = message.name || (message.is_user ? readContext().name1 : readContext().name2) || '';
    const body = stripUiNoise(message.mes || '');
    return body ? `${speaker}: ${body}` : '';
}

export function recentTranscript(limit = null, { messageIds = false } = {}) {
    const chat = activeChat(readContext().chat || []);
    const count = Math.max(2, Math.min(30, Number(limit ?? readScanDepth()) || 6));
    const lines = [];
    // Walk backward and stop as soon as the requested meaningful window is full.
    // Long chats no longer pay to clean every historical message on each scan/injection.
    for (let i = chat.length - 1; i >= 0 && lines.length < count; i -= 1) {
        if (!chat[i] || chat[i].is_system) continue;
        const line = cleanMessage(chat[i]);
        if (line) lines.push(messageIds ? `[m${i}] ${line}` : line);
    }
    return lines.reverse().join('\n');
}

export function recentUserDevelopmentContext(limit = null, { messageIds = true } = {}) {
    const chat = activeChat(readContext().chat || []);
    const count = Math.max(2, Math.min(30, Number(limit ?? readScanDepth()) || 6));
    const selected = [];
    let meaningful = 0;
    for (let i = chat.length - 1; i >= 0 && meaningful < count; i -= 1) {
        const message = chat[i];
        if (!message || message.is_system) continue;
        const line = cleanMessage(message);
        if (!line) continue;
        meaningful += 1;
        if (message.is_user) selected.push(messageIds ? `[m${i}] ${line}` : line);
    }
    return selected.reverse().join('\n');
}

export function currentExchangeUserDevelopmentContext(messageId = null) {
    const ctx = readContext();
    const chat = activeChat(ctx.chat || []);
    let assistantId = Number.isInteger(messageId) ? messageId : chat.length - 1;
    while (assistantId >= 0 && (chat[assistantId]?.is_system || chat[assistantId]?.is_user)) assistantId -= 1;
    if (assistantId < 0) return '';
    for (let i = assistantId - 1; i >= 0; i -= 1) {
        if (chat[i]?.is_system) continue;
        if (chat[i]?.is_user) {
            const line = cleanMessage(chat[i]);
            return line ? `[m${i}] ${line}` : '';
        }
        break;
    }
    return '';
}

// The current exchange's messages: the assistant reply at (or before) `messageId` and the user
// message it answers, oldest first; null when there is no reply.
export function currentExchangeMessages(messageId = null) {
    const ctx = readContext();
    const chat = activeChat(ctx.chat || []);
    let assistantId = Number.isInteger(messageId) ? messageId : chat.length - 1;
    while (assistantId >= 0 && (chat[assistantId]?.is_system || chat[assistantId]?.is_user)) assistantId -= 1;
    if (assistantId < 0) return null;
    let userId = -1;
    for (let i = assistantId - 1; i >= 0; i -= 1) {
        if (chat[i]?.is_system) continue;
        if (chat[i]?.is_user) { userId = i; break; }
        // Do not walk across an older assistant turn looking for a distant user message.
        if (!chat[i]?.is_user) break;
    }
    return [userId >= 0 ? chat[userId] : null, chat[assistantId]].filter(Boolean);
}

export function currentExchangeTranscript(messageId = null) {
    const messages = currentExchangeMessages(messageId);
    if (!messages) return recentTranscript(2);
    return messages.map(cleanMessage).filter(Boolean).join('\n');
}

// (1.2.12) The current exchange's story alone (narration and dialogue, no World State or blocks):
// who a relationship moment involves, and what the relationship evaluator is sent.
export function currentExchangeProse(messageId = null) {
    const ctx = readContext();
    return (currentExchangeMessages(messageId) || []).map(message => {
        const body = storyProse(message.mes || '');
        const speaker = message.name || (message.is_user ? ctx.name1 : ctx.name2) || '';
        return body ? `${speaker}: ${body}` : '';
    }).filter(Boolean).join('\n');
}

// Story day of a message: its own dated World State block, else the nearest earlier dated message
// (user turns and brief replies carry none). Null when nothing nearby is dated; callers then use turns.
export const STORY_DAY_LOOKBACK = 12;

export function storyDayAt(messageId) {
    const chat = activeChat(readContext().chat || []);
    const start = Number.isInteger(messageId) ? Math.min(messageId, chat.length - 1) : chat.length - 1;
    for (let i = start; i >= 0 && i > start - STORY_DAY_LOOKBACK; i -= 1) {
        // A hidden message (a faded reply is one) dates nothing: the prompts do not carry it, the story does not stand on it.
        if (chat[i]?.is_system) continue;
        const day = storyDayFromText(chat[i]?.mes || '');
        if (day !== null) return day;
    }
    return null;
}

export function storyDaysForTranscript(transcript) {
    const days = {};
    for (const match of String(transcript || '').matchAll(/^\[m(\d+)\]/gm)) {
        const id = Number(match[1]);
        const day = storyDayAt(id);
        if (Number.isInteger(id) && day !== null) days[id] = day;
    }
    return days;
}

export function currentExclusions() {
    const ctx = readContext();
    return [ctx.name1, ctx.name2].filter(Boolean);
}
