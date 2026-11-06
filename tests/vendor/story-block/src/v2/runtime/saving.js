// The runtime's saving helpers (moved out of runtime.js unchanged): createStore's save options, the
// save stamps and read-back copies, rescue lookup, the tainted mark and the page-unload save.

import { KEEPALIVE_MAX, createChatFile, utf8Bytes } from '../chat-file.js';
import { carryRecord } from '../persist.js';

/**
 * How the store saves (SPEC §3.3), for SillyTavern and the testkit alike:
 * * In SillyTavern the chat file is written directly (src/v2/chat-file.js), with the chat as it is in
 *   the same tick as the store's check that it is still the chat the change was made in; a refused
 *   save throws, so it stays unsaved, is told once and tried again. Where there is no such file (the
 *   testkit, a temporary chat) it is ctx.saveChat().
 * * A change left in a chat that is no longer open (rescue) is put into that chat's file as read back
 *   from the server: only its records, onto the same messages; nothing else in the file changes.
 * * The reader's actions are saved at once (sdk.command); the rest within 400 ms; when the page is
 *   closed with something unsaved, it is sent with keepalive, and the browser asks first if saves have
 *   been failing.
 * Returns the createStore() options for it.
 */
export function storeSaving({ ctx, live = () => ctx, fetch = null, onSaveError = null, storage = null }) {
    const context = () => {
        try { return live() ?? ctx; } catch { return ctx; }
    };
    const file = createChatFile({ context, ...(fetch ? { fetch } : {}) });
    // After a write timed out (persist.js createSaver): each later write of that chat carries a rising number
    // in its metadata (`stamp`), and this page keeps a copy of what it wrote (`kept`, by stamp, only until the
    // read-backs end) to put back when the file is found older and the chat is not the open one. Nothing is
    // stamped, kept or read without a timeout.
    let counter = 0;
    const kept = new Map();
    const seqOf = metadata => {
        const n = Number(isPlain(metadata) ? metadata[SAVE_SEQ_KEY] : NaN);
        return Number.isSafeInteger(n) ? n : 0;
    };
    function stampInto(metadata, messages) {
        counter = Math.max(counter, seqOf(metadata)) + 1;
        metadata[SAVE_SEQ_KEY] = counter;
        kept.set(counter, JSON.stringify({ metadata, messages }));
        while (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value);
        return counter;
    }
    const memoKey = chatId => `${MEMO_PREFIX}${chatId}`;
    return {
        /**
         * Would a save of the open chat now go out with keepalive (a body of at most KEEPALIVE_MAX bytes as
         * UTF-8, B-a3-1)? Measured only when asked (the page is closing). True where this page does not write the file itself.
         */
        keepaliveFits() {
            if (!file.where()) return true;
            try {
                return utf8Bytes(JSON.stringify({ chat: [context().chatMetadata ?? {}, ...(ctx.chat ?? [])] })) + 256 <= KEEPALIVE_MAX;
            } catch { return false; }
        },
        chat: () => ctx.chat,
        // The chat's metadata (SillyTavern's, saved with the chat file): the store keeps the source-map archive there.
        metadata: () => context().chatMetadata ?? null,
        chatId: () => (typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx.chatId),
        place: () => file.where(),
        save: (change, { keepalive = false, signal = null, stamp: wanted = false } = {}) => {
            markUsed(context().chatMetadata, ctx.chat);
            const place = file.where();
            let metadata = context().chatMetadata;
            if (!isPlain(metadata)) metadata = {};
            const stamp = wanted ? stampInto(metadata, ctx.chat) : null;
            const out = stamp === null ? null : { stamp };
            if (!place) return Promise.resolve(ctx.saveChat()).then(() => out);
            return file.write(place, ctx.chat, metadata, { keepalive, signal }).then(() => out);
        },
        confirm: {
            /** Does the file of `change`'s chat hold the write stamped `stamp`, or a newer one? */
            async holds(change, stamp) {
                const place = change?.place ?? null;
                if (!place) return true;     // no file this page can read (ctx.saveChat saved it)
                const [header] = await file.read(place);
                return seqOf(header?.chat_metadata) >= stamp;
            },
            /**
             * Does the open chat hold the write stamped `stamp`, or a newer one (not a copy read back after the
             * late write landed)? By the newest record of the copy kept of that write, found in the open chat by
             * its `sid` with at least its `rev`; else by the number in the open chat's metadata.
             */
            fresh(stamp) {
                const copy = kept.get(stamp);
                const head = copy ? newestRecord(JSON.parse(copy).messages) : null;
                const mine = head ? (ctx.chat ?? []).map(message => message?.extra?.storySuite).find(record => isPlain(record) && record.sid === head.sid) : null;
                if (mine) return Number(mine.rev) >= Number(head.rev);
                return seqOf(context().chatMetadata) >= stamp;
            },
            /** Writes the copy kept of the write stamped `stamp` into `change`'s chat file; false when none is kept. */
            async restore(change, stamp) {
                const copy = kept.get(stamp);
                if (!copy || !change?.place) return false;
                const { metadata, messages } = JSON.parse(copy);
                await file.write(change.place, messages, metadata);
                return true;
            },
            forget: stamp => { kept.delete(stamp); },
        },
        // A1-2: a suspect chat's read-backs, kept over a reload of the page (browser storage; a missing or
        // full one only loses that convenience).
        memo: storage ? {
            get(chatId) {
                try {
                    const text = storage.getItem(memoKey(chatId));
                    return text ? JSON.parse(text) : null;
                } catch { return null; }
            },
            set(chatId, value) {
                try {
                    if (value) storage.setItem(memoKey(chatId), JSON.stringify(value));
                    else storage.removeItem(memoKey(chatId));
                } catch { /* only a convenience */ }
            },
        } : null,
        async rescue(change, entries, { stamp: wanted = false } = {}) {
            if (!entries.length) return null;
            if (!change?.place) throw new Error('this page cannot write to that chat\'s file');
            const [header, ...messages] = await file.read(change.place);
            if (!header || !messages.length) throw new Error('its chat file is no longer on the server (deleted, or renamed elsewhere)');
            let wrote = false;
            for (const { message, index } of entries) {
                const at = rescueIndex(message, messages, index);
                if (at < 0) throw new Error(`its chat file no longer holds message ${index} as it was`);
                if (holdsRecord(messages[at], message)) continue;
                if (!carryRecord(message, messages[at])) throw new Error(`its chat file no longer holds message ${index} as it was`);
                wrote = true;
            }
            if (!wrote) return null;    // the file holds every change already (SillyTavern saved it itself)
            // C4-5: the rescued file is marked as used too (markUsed), as a save of the open chat is.
            const metadata = isPlain(header.chat_metadata) ? header.chat_metadata : {};
            markUsed(metadata, messages);
            // A1-5: after a timeout of a write of this chat, the rescue is stamped as a save is.
            const stamp = wanted ? stampInto(metadata, messages) : null;
            await file.write(change.place, messages, metadata);
            return stamp === null ? null : { stamp };
        },
        onSaveError,
    };
}

// chat_metadata key of the rising save number written after a save timed out (storeSaving confirm).
export const SAVE_SEQ_KEY = 'storySuiteSave';
// Browser-storage key prefix of a suspect chat's read-backs (createSaver memo), and the copies kept at most.
export const MEMO_PREFIX = 'storySuite.saveCheck:';
const MAX_KEPT = 8;
// The record of the last carrier that has one (with a `sid`), or null.
function newestRecord(messages) {
    for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
        const record = messages[i]?.extra?.storySuite;
        if (isPlain(record) && typeof record.sid === 'string') return record;
    }
    return null;
}
// The page's localStorage, or null (none, or blocked: reading it can throw).
export function pageStorage(page) {
    try { return page?.localStorage ?? null; } catch { return null; }
}
const isPlain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const sidOf = message => message?.extra?.storySuite?.sid;
// The story text before any tag (the change block, hidden or not, comes after it).
const storyText = message => String(message?.mes ?? '').split('<')[0].trimEnd();
const sameText = (a, b) => !!a && !!b && storyText(a) === storyText(b);

// C4-4: where the message a rescued change was written on is in its chat file now. The index it had
// when the record was written is a guess only (a message deleted before it shifts it, and SillyTavern
// saves the chat itself then): the message holding the same record (`sid`) comes first, then the one
// at that index with the same story text, then the only other one with it. carryRecord checks the
// swipe, the author and the date. → its index, or -1.
function rescueIndex(message, messages, index) {
    const sid = sidOf(message);
    if (typeof sid === 'string') {
        const at = messages.findIndex(other => sidOf(other) === sid);
        if (at >= 0) return at;
    }
    if (sameText(messages[index], message)) return index;
    const same = [];
    messages.forEach((other, at) => { if (sameText(other, message)) same.push(at); });
    return same.length === 1 ? same[0] : -1;
}

// The file's message already holds this record as it is (same `sid` and `rev`).
function holdsRecord(there, message) {
    const own = message?.extra?.storySuite;
    const kept = there?.extra?.storySuite;
    return isPlain(own) && isPlain(kept) && typeof own.sid === 'string' && kept.sid === own.sid && kept.rev === own.rev
        && JSON.stringify(kept.ops) === JSON.stringify(own.ops);
}

/**
 * Marks a chat holding story state as used (chat_metadata.tainted). SillyTavern treats an untainted chat
 * holding only the greeting as pristine and replaces that greeting (and the record on it) when the
 * character card is saved or the chat is renamed.
 */
export function markUsed(metadata, chat) {
    if (!metadata || typeof metadata !== 'object' || metadata.tainted) return;
    if ((chat ?? []).some(message => message?.extra?.storySuite)) metadata.tainted = true;
}

/**
 * On a page: the unsaved story goes out as early as the page lets it (see storeSaving).
 * * Hidden (`visibilitychange` to hidden: a tab switch, a phone putting the browser away) or `pagehide`:
 *   the newest state is saved at once, with keepalive, past a save still on its way. A page often goes
 *   from hidden to gone without another event, on a phone always.
 * * `beforeunload`: the same, and the browser asks first while saves fail, while one is still on its way,
 *   or when the body is too big to go out with keepalive (`fits()` false: more than 64 KiB, most real
 *   chats), since then the save is cut off with the page. SillyTavern 1.19 has no way to write part of a
 *   chat file, so a smaller keepalive request is not possible.
 */
export function saveOnUnload(store, page, { fits = () => true } = {}) {
    if (typeof page?.addEventListener !== 'function') return () => {};
    const doc = page.document ?? null;
    const urgent = (options = {}) => (store.saveUrgent ?? store.saveSoon)?.call(store, { keepalive: true, ...options });
    const onUnload = event => {
        // A1-4: a save still on its way (the server has not answered) would hold a queued one until the
        // page is gone: the newest state goes out at once past it.
        const inFlight = store.inFlight?.() === true;
        const dirty = store.dirty?.() === true;
        if (!dirty && !inFlight) return;
        if (dirty) urgent();
        let big = false;
        if (dirty) {
            try { big = fits() === false; } catch { big = true; }
        }
        if (store.failing?.() || inFlight || big) {
            event.preventDefault?.();
            event.returnValue = true;
        }
    };
    // The page may be going away (pagehide), so a save on its way is sent again with keepalive.
    const onHide = () => {
        if (store.dirty?.() === true) urgent({ force: true });
    };
    const onVisibility = () => {
        if (doc?.visibilityState === 'hidden' && store.dirty?.() === true) urgent();
    };
    page.addEventListener('beforeunload', onUnload);
    page.addEventListener('pagehide', onHide);
    doc?.addEventListener?.('visibilitychange', onVisibility);
    return () => {
        page.removeEventListener?.('beforeunload', onUnload);
        page.removeEventListener?.('pagehide', onHide);
        doc?.removeEventListener?.('visibilitychange', onVisibility);
    };
}
