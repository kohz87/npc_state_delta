// The state inspector's data (MODULES §F92): read-only views of what the chat's story records hold,
// for the Inspector screen (src/v2/screens/inspector.js). Nothing here writes: it reads the store's
// replay (`at`, `before`, `opsAt`) and the records on the messages.
//
//   replyList(chat, { head })              the replies that keep the story, newest first
//   inspectReply({ store, chat, index, problems })
//                                          one reply: its state, the state before it, what changed
//                                          (diffStates), its ops, its receipts and its problems
//   diffStates(before, after)              [{ kind: 'add' | 'remove' | 'change', path, before, after }]
//   matchPaths(value, query)               the JSON Pointers a search finds, and the ones on the way
//   pointer(parent, key), preview(value)   helpers the screen shares
//
// Everything a reply holds came, at one remove, from the model's text, so the screen shows it with
// textContent only; here it is only read and cut to size.

import { carrierIndexes, readRecord } from './persist.js';
import { cutAt, oneLine } from '../text.js';

export const LIMITS = Object.freeze({
    diff: 300,       // changed paths listed for one reply
    matches: 200,    // search hits in one state
    snippet: 60,     // characters of a reply's text in the picker
    preview: 120,    // characters of a value written on one line
});

const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isBranch = value => value !== null && typeof value === 'object';

/** A JSON Pointer one step down (RFC 6901: `~` → `~0`, `/` → `~1`). */
export function pointer(parent, key) {
    return `${parent}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

/** A value written on one line, cut at `max` characters: `"text"`, `3`, `{4 keys}`, `[2 items]`. */
export function preview(value, max = LIMITS.preview) {
    if (value === undefined) return '—';
    if (Array.isArray(value)) return `[${value.length} ${value.length === 1 ? 'item' : 'items'}]`;
    if (isPlain(value)) {
        const n = Object.keys(value).length;
        return `{${n} ${n === 1 ? 'key' : 'keys'}}`;
    }
    let text;
    try { text = JSON.stringify(value); } catch { text = String(value); }
    text = oneLine(text ?? String(value));
    return text.length > max ? `${cutAt(text, max - 1)}…` : text;
}

/**
 * What changed from `before` to `after`, path by path, in key order of `after` (removed keys after the
 * kept ones): `{ entries: [{ kind, path, before, after }], more }` with at most `limit` entries (`more`:
 * how many were left out). A list that changed is compared element by element; an object that came or
 * went is one entry, not one per key inside it.
 */
export function diffStates(before, after, { limit = LIMITS.diff } = {}) {
    const entries = [];
    let more = 0;
    const push = entry => {
        if (entries.length < limit) entries.push(entry);
        else more += 1;
    };
    const walk = (a, b, path) => {
        if (Object.is(a, b)) return;
        const bothLists = Array.isArray(a) && Array.isArray(b);
        const bothObjects = isPlain(a) && isPlain(b);
        if (!bothLists && !bothObjects) {
            push({ kind: 'change', path, before: a, after: b });
            return;
        }
        const keys = bothLists
            ? Array.from({ length: Math.max(a.length, b.length) }, (_, i) => i)
            : [...Object.keys(b), ...Object.keys(a).filter(key => !Object.hasOwn(b, key))];
        for (const key of keys) {
            const has = { a: bothLists ? key < a.length : Object.hasOwn(a, key), b: bothLists ? key < b.length : Object.hasOwn(b, key) };
            const at = pointer(path, key);
            if (has.a && !has.b) push({ kind: 'remove', path: at, before: a[key], after: undefined });
            else if (!has.a && has.b) push({ kind: 'add', path: at, before: undefined, after: b[key] });
            else walk(a[key], b[key], at);
        }
    };
    if (before === null || before === undefined) {
        if (after !== null && after !== undefined) push({ kind: 'add', path: '', before: undefined, after });
    } else if (after === null || after === undefined) {
        push({ kind: 'remove', path: '', before, after: undefined });
    } else {
        walk(before, after, '');
    }
    return { entries, more };
}

/**
 * A search over a state: every node whose key or plain value holds `query` (any case), as JSON
 * Pointers. `{ matches: Set, ways: Set (every node on the way to a match), keep: Set (both), count,
 * capped }`;
 * at most `limit` matches are kept (`capped` says the search stopped there). An empty query finds nothing.
 */
export function matchPaths(value, query, { limit = LIMITS.matches } = {}) {
    const needle = String(query ?? '').trim().toLowerCase();
    const matches = new Set();
    const ways = new Set();
    const keep = new Set();
    let capped = false;
    if (!needle) return { matches, ways, keep, count: 0, capped };
    const hit = text => String(text).toLowerCase().includes(needle);
    const visit = (node, path, key, trail) => {
        if (capped) return;
        const own = (key !== null && hit(key)) || (!isBranch(node) && node !== undefined && hit(node === null ? 'null' : node));
        if (own) {
            if (matches.size >= limit) {
                capped = true;
                return;
            }
            matches.add(path);
            for (const step of trail) {
                ways.add(step);
                keep.add(step);
            }
            keep.add(path);
        }
        if (isBranch(node)) {
            const next = [...trail, path];
            for (const [k, v] of Object.entries(node)) visit(v, pointer(path, k), k, next);
        }
    };
    visit(value, '', null, []);
    return { matches, ways, keep, count: matches.size, capped };
}

/**
 * The replies that keep the story (carriers with a record for their shown swipe), newest first:
 * [{ index, name, snippet, rev, receipts, ops, checkpoint, head }]. `head`: the head carrier's index.
 */
export function replyList(chat, { head = null } = {}) {
    const messages = Array.isArray(chat) ? chat : [];
    const out = [];
    for (const index of carrierIndexes(messages)) {
        const record = readRecord(messages[index]);
        if (!record) continue;
        const receipts = Array.isArray(record.receipts) ? record.receipts : [];
        const lastRev = receipts.reduce((best, receipt) => (Number.isInteger(receipt?.rev) && receipt.rev > best ? receipt.rev : best), 0);
        out.push({
            index,
            name: oneLine(messages[index]?.name ?? '', 40),
            // Cut before comments (the hidden change block) and tags are taken out, so a long reply full
            // of `<` costs no more than its start.
            snippet: oneLine(cutAt(String(messages[index]?.mes ?? ''), LIMITS.snippet * 10).replace(/<!--[\s\S]*?(?:-->|$)/g, ' ').replace(/<[^<>]*>/g, ' '), LIMITS.snippet),
            rev: Number.isInteger(record.rev) ? record.rev : lastRev,
            receipts: receipts.length,
            ops: Array.isArray(record.ops) ? record.ops.length : 0,
            checkpoint: Boolean(record.checkpoint),
            head: index === head,
        });
    }
    return out.reverse();
}

const receiptView = receipt => ({
    id: String(receipt?.id ?? ''),
    type: String(receipt?.type ?? ''),
    module: String(receipt?.module ?? ''),
    cause: String(receipt?.cause ?? ''),
    rev: Number.isInteger(receipt?.rev) ? receipt.rev : null,
    summary: oneLine(receipt?.summary ?? '', 300),
    narrate: receipt?.narrate !== false,
});

/**
 * One reply as the inspector shows it, or `{ ok: false, index, message }` when it holds no story:
 * `{ ok: true, index, name, rev, checkpoint, head, state, before, diff: { entries, more }, ops, receipts,
 * problems: [{ code, message }] }`. `problems(index)` → the problems the host knows of for that reply
 * (replay, the turn's, the refused change lines). `state` and `before` are the store's frozen copies.
 */
export function inspectReply({ store, chat, index, problems = () => [] }) {
    const messages = Array.isArray(chat) ? chat : [];
    const record = Number.isInteger(index) ? readRecord(messages[index]) : null;
    if (!record) return { ok: false, index, message: 'That message holds no story record (a reader\'s message, or a reply from before the story).' };
    let state;
    let before;
    try {
        state = store.at(index);
        before = store.before?.(index) ?? null;
    } catch (error) {
        return { ok: false, index, message: `The state at that reply could not be worked out: ${error?.message ?? error}` };
    }
    const head = store.headIndex?.();
    const receipts = (Array.isArray(record.receipts) ? record.receipts : []).map(receiptView);
    let found = [];
    try { found = problems(index) ?? []; } catch { found = []; }
    return {
        ok: true,
        index,
        name: oneLine(messages[index]?.name ?? '', 40),
        rev: state?.meta?.rev ?? null,
        checkpoint: Boolean(record.checkpoint),
        head: index === head,
        state,
        before,
        diff: diffStates(before, state),
        ops: store.opsAt?.(index) ?? [],
        receipts,
        problems: found.map(item => ({ code: String(item?.code ?? item?.why ?? ''), message: oneLine(item?.message ?? item?.reason ?? item?.line ?? item, 400) })),
    };
}

/**
 * What the Inspector widget reads (screens/inspector.js createInspectorWidget), over the host's store:
 * `createInspectorSource({ store, chat: () => messages, chatId?: () => id, problems?: index => [...] })` →
 * `{ replies(), reply(index), headIndex(), memory }`. `memory` keeps the reader's picks between redraws
 * for as long as the page is open: `index` (null follows the newest reply), `search`, `open` (the paths
 * folded open; the domains start open). It is the reader's view only, never saved.
 */
export function createInspectorSource({ store, chat = () => [], chatId = () => '', problems = () => [] }) {
    const memory = { index: null, search: '', open: new Set(['/domains']) };
    let seen = null;
    const headIndex = () => {
        try { return store.headIndex(); } catch { return null; }
    };
    return {
        memory,
        headIndex,
        replies() {
            // Another chat opened: a reply picked in the last one means nothing here.
            const id = String(chatId() ?? '');
            if (seen !== null && seen !== id) memory.index = null;
            seen = id;
            return replyList(chat(), { head: headIndex() });
        },
        reply: index => inspectReply({ store, chat: chat(), index, problems }),
    };
}
