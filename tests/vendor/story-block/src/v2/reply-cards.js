// Cards under replies (fix 8e): the socket a module uses to put a card under an assistant message (WIDGETS.md, "Cards under
// replies"; the README's "How modules connect" table). A module declares `cards: { <id>: { for(state, message, ctx) → card | null } }`.
// `for` is asked once per card, about the HEAD reply (the newest assistant message; in a chat that holds only the greeting, the
// greeting), with the head's state, its SillyTavern message object and `ctx.head === true`. When it answers, the card is drawn under
// the head reply with its actions enabled; older replies carry no module cards. So a card follows the story: a start card goes when
// the character exists, and a second fight's battle card sits under the newest reply, not the first fight's. A card the module
// stops returning goes away on the next draw (a character made, a fight ended); a swipe or a delete moves it with the head.
//
// A card: { tone: 'accent'|'bad'|'good'|'info', icon: 'ph-…' | 'fa-…', title, text?, rows?: [{ icon?, text, tag?, tagTone? }] (at most 4),
// actions?: [{ id, label, icon?, primary?, command?, payload?, open? }] (at most 3), later?: true|false }. An action runs its `command`
// (sdk.command, recorded with the reply) or opens its `open` screen in the game view; `later` adds a Later button that folds the card
// into one line. Text is plain: the host prints it, never parses it. `normalizeCard` drops what it cannot read; a card without a title
// is no card.
//
// The Later state is the viewer's (localStorage, per chat and card key): it is not game state, so it is never in a command or a save.
// It is cleared when the card stops being drawn, so a later card of the same id starts unfolded.
// Pure except for the storage that `laterStore` takes; no DOM.

import { oneLine } from '../text.js';
import { STRINGS, fill } from './strings.js';

export const CARD_TONES = Object.freeze(['accent', 'bad', 'good', 'info']);
export const CARD_ROWS_MAX = 4;
export const CARD_ACTIONS_MAX = 3;
const ICON = /^(ph-[a-z0-9-]+(:fill)?|fa-[a-z0-9-]+)$/;
const COMMAND = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9_-]+)+$/i;
const LATER_KEY = 'story-block.replyCards.later';

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const iconOf = (value, fallback) => (typeof value === 'string' && ICON.test(value.trim()) ? value.trim() : fallback);

function rowOf(raw) {
    if (!isRecord(raw)) return null;
    const text = oneLine(raw.text ?? '', 120);
    if (!text) return null;
    const tag = oneLine(raw.tag ?? '', 24);
    return { icon: iconOf(raw.icon, ''), text, tag, tagTone: CARD_TONES.includes(raw.tagTone) ? raw.tagTone : 'info' };
}

// A payload as plain JSON (what a command or a dialog's draft takes), or {} when it cannot be copied (a loop, a BigInt, a getter that throws).
function payloadOf(value) {
    if (!isRecord(value)) return {};
    try {
        const copy = JSON.parse(JSON.stringify(value));
        return isRecord(copy) ? copy : {};
    } catch {
        return {};
    }
}

function actionOf(raw, at) {
    if (!isRecord(raw)) return null;
    const label = oneLine(raw.label ?? '', 32);
    const command = typeof raw.command === 'string' && COMMAND.test(raw.command) ? raw.command : '';
    const open = typeof raw.open === 'string' && /^[A-Za-z0-9._\-/]{1,120}$/.test(raw.open) ? raw.open : '';
    if (!label || (!command && !open)) return null;
    const id = oneLine(raw.id ?? '', 40) || `action-${at}`;
    return {
        id,
        label,
        icon: iconOf(raw.icon, ''),
        primary: raw.primary === true,
        command,
        payload: payloadOf(raw.payload),
        open,
    };
}

/** A module's card, read: { tone, icon, title, text, rows, actions, later } or null when it has no title. */
export function normalizeCard(raw) {
    if (!isRecord(raw)) return null;
    const title = oneLine(raw.title ?? '', 60);
    if (!title) return null;
    const rows = (Array.isArray(raw.rows) ? raw.rows : []).map(rowOf).filter(Boolean).slice(0, CARD_ROWS_MAX);
    const actions = (Array.isArray(raw.actions) ? raw.actions : []).map(actionOf).filter(Boolean).slice(0, CARD_ACTIONS_MAX);
    return {
        tone: CARD_TONES.includes(raw.tone) ? raw.tone : 'info',
        icon: iconOf(raw.icon, 'ph-star'),
        title,
        text: oneLine(raw.text ?? '', 200),
        rows,
        actions,
        later: raw.later === true,
    };
}

/**
 * The cards under the head reply: `entries` are the registry's [{ moduleId, id, fn }] (id: "<module>/<card>"), `head` the head
 * reply's index, `messageAt(index)` the message, `stateAt(index)` the state after it (asked once, shared by every card),
 * `query(name, args, state)` the queries. Each `fn(state, message, { index, head: true, chatId, query })` is asked once; a card that
 * throws (or whose words cannot be read) is left out and never stops the others. `onEnded(id)` hears of each card that answered
 * without a card. → Map head index → [{ key, card }] (empty when there is no head).
 */
export function scanReplyCards(entries, { head = -1, messageAt = () => null, stateAt = () => null, query = () => null, chatId = '', onEnded = null } = {}) {
    const out = new Map();
    if (!Number.isInteger(head) || head < 0) return out;
    const list = (Array.isArray(entries) ? entries : []).filter(entry => typeof entry?.fn === 'function');
    if (!list.length) return out;
    let state;
    let message = null;
    try {
        state = stateAt(head);
        message = messageAt(head);
    } catch {
        return out;
    }
    const found = [];
    for (const { id, fn } of list) {
        try {
            const card = normalizeCard(fn(state, message, { index: head, head: true, chatId, query: (name, args) => query(name, args, state) }));
            if (card) found.push({ key: id, card });
            else {
                try { onEnded?.(id); } catch { /* the caller's note never stops the scan */ }
            }
        } catch {
            // One module's card never stops the others.
        }
    }
    if (found.length) out.set(head, found);
    return out;
}

/**
 * The viewer's Later state: `laterStore(storage)` with storage { getItem, setItem } (localStorage by default). This page keeps its own
 * copy (read once), and each change is written to the storage when there is one; a storage that throws or holds junk is read as
 * nothing folded, and a change the storage refuses lasts this page only. Never throws.
 */
export function laterStore(storage) {
    let kept = null;
    // The default storage is read inside a try: a browser that refuses site data throws on `localStorage` itself.
    const area = () => {
        try { return storage === undefined ? globalThis.localStorage : storage; } catch { return null; }
    };
    const load = () => {
        if (kept) return kept;
        try {
            const parsed = JSON.parse(area()?.getItem?.(LATER_KEY) ?? '{}');
            kept = isRecord(parsed) ? parsed : {};
        } catch {
            kept = {};
        }
        return kept;
    };
    return {
        /** Whether the card (`${chatId}|${key}`: a chat and a card key, never a message index) is folded. */
        has: key => load()[key] === true,
        /** Folds (on) or opens the card. */
        set(key, on) {
            const all = load();
            if (on) all[key] = true;
            else delete all[key];
            try { area()?.setItem?.(LATER_KEY, JSON.stringify(all)); } catch { /* the choice lasts this page only */ }
        },
    };
}

/** Applied reader edits on one reply, in receipt order. Skipped replay blocks do not describe changes. */
export function replyEdits(record, problems = [], index = null) {
    const skipped = new Set((Array.isArray(problems) ? problems : []).filter(problem => index === null || problem?.index === index)
        .flatMap(problem => Array.isArray(problem?.receipts) ? problem.receipts : []));
    return (Array.isArray(record?.receipts) ? record.receipts : [])
        .filter(receipt => receipt?.data?.edit === true && !skipped.has(receipt.id))
        .map(receipt => ({ text: oneLine(receipt.summary ?? '', 200) })).filter(row => row.text);
}

/** Rules reported by a data-module action on this reply. */
export function replyRules(record, problems = [], index = null) {
    const skipped = new Set((Array.isArray(problems) ? problems : []).filter(problem => index === null || problem?.index === index)
        .flatMap(problem => Array.isArray(problem?.receipts) ? problem.receipts : []));
    return (Array.isArray(record?.receipts) ? record.receipts : []).filter(receipt => !skipped.has(receipt.id))
        .flatMap(receipt => (Array.isArray(receipt?.data?.v2?.result?.rules) ? receipt.data.v2.result.rules : [])
            .map(rule => oneLine(rule, 80)).filter(Boolean).map(rule => ({ text: fill(STRINGS.card.rule, { name: rule }), summary: fill(STRINGS.card.rule, { name: rule }), kind: 'line', tone: 'accent', icon: 'fa-bolt', flag: '', note: '', check: null })));
}
