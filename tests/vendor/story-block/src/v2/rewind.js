// Return in time (MODULES §F17): `sdk.rewind({ index, beforeRev })`.
//
// The chat is branched at carrier `index` with SillyTavern's own branch (the old timeline stays as it
// was, in its own chat file), the branch is opened, and on the branch that carrier's receipts with
// rev >= beforeRev are dropped together with their ops (store.truncate). The head is then the state just
// before the first dropped receipt, and the next command commits on that carrier.
//
// How the branch is made, first that works:
// 1. `ctx.branchChat(index)` when the context has it (the testkit's fake does; SillyTavern 1.19 does not
//    put it on getContext());
// 2. `branchChat(index)` from SillyTavern's own /scripts/bookmarks.js (1.19: creates the branch file from
//    chat[0..index], saves it, opens it; resolves to the file name or null);
// 3. the `/branch-create <index>` slash command through ctx.executeSlashCommandsWithOptions (same function
//    behind it).
// Each of them leaves the branch open as the current chat (CHAT_CHANGED fires, the turn rebuilds).
//
// Nothing is branched unless the changes can be taken back (B-b2-timeline-8): the truncation is worked
// out on the chat as it is first (store.truncate's dry run). If it still fails on the branch, the chat
// the reader was in is opened again (`reopen`, SillyTavern's openCharacterChat / openGroupChat).

import { newId } from './sdk.js';
import { oneLine } from '../text.js';
import { CORE_FEATURE } from './features.js';

const BOOKMARKS = '/scripts/bookmarks.js';

/** SillyTavern's branch function for `ctx`: (index) → Promise<branch name | null>. */
export function stBranch(ctx, { importer = path => import(path) } = {}) {
    return async index => {
        if (typeof ctx?.branchChat === 'function') return ctx.branchChat(index);
        try {
            const bookmarks = await importer(BOOKMARKS);
            if (typeof bookmarks?.branchChat === 'function') return bookmarks.branchChat(index);
        } catch { /* not a SillyTavern page, or a version that moved it: try the slash command */ }
        if (typeof ctx?.executeSlashCommandsWithOptions === 'function') {
            const out = await ctx.executeSlashCommandsWithOptions(`/branch-create ${index}`, { handleExecutionErrors: true });
            const name = typeof out?.pipe === 'string' ? out.pipe.trim() : '';
            return name || null;
        }
        throw new Error('This SillyTavern has no way to branch a chat that Story Block knows of.');
    };
}

/** SillyTavern's way back to chat `name`: (name) → Promise. */
export function stReopen(ctx, { live = () => globalThis.SillyTavern?.getContext?.() ?? ctx } = {}) {
    return async name => {
        const c = live() ?? ctx;
        if (c?.groupId !== undefined && c?.groupId !== null && c?.groupId !== '' && typeof c.openGroupChat === 'function') return c.openGroupChat(c.groupId, name);
        if (typeof c?.openCharacterChat === 'function') return c.openCharacterChat(name);
        throw new Error('This SillyTavern has no way to open a chat again that Story Block knows of.');
    };
}

const fail = (code, message) => ({ ok: false, code, message });

/**
 * createRewind({ ctx, store, events?, branch?, reopen? }) → rewind({ index, beforeRev }) → Promise<
 * { ok: true, branch, index, rev, dropped, unsaved? } | { ok: false, code, message }>. `unsaved`: why the branch
 * is not saved yet (the store tries again).
 */
export function createRewind({ ctx, store, events = null, branch = stBranch(ctx), reopen = stReopen(ctx) }) {
    let running = false;
    return async function rewind({ index, beforeRev } = {}) {
        if (running) return fail('STALE', 'The story is already going back in time.');
        const chat = ctx?.chat ?? [];
        if (!Number.isInteger(index) || index < 0 || index >= chat.length || chat[index]?.is_user) {
            return fail('INVALID', 'Say which reply to go back to (the index of a message that keeps the story).');
        }
        if (!Number.isInteger(beforeRev) || beforeRev < 1) return fail('INVALID', 'Say which change to go back to (beforeRev, a whole number of 1 or more).');
        const record = chat[index]?.extra?.storySuite;
        if (!record || !Array.isArray(record.receipts)) return fail('NOT_FOUND', 'That reply holds no story changes to go back from.');
        running = true;
        try {
            // Worked out first on the messages the branch will hold (chat[0..index]); nothing is written.
            let plan;
            try {
                plan = store.truncate(index, beforeRev, { dryRun: true, chat: chat.slice(0, index + 1) });
            } catch (error) {
                return fail('FAILED', `The changes could not be taken back, so no branch was made: ${error?.message ?? error}`);
            }
            if (!plan.dropped.length) return fail('NOT_FOUND', 'That reply holds no changes from there on to take back; no branch was made.');
            // The branch is made from the chat file: the story must be in it first (C1-2: a save that
            // fails is told, never thrown at the reader).
            try { await store.flush(); } catch (error) {
                return fail('FAILED', `The story could not be saved first, so no branch was made: ${error?.message ?? error}`);
            }
            const from = typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx.chatId;
            let name;
            try { name = await branch(index); } catch (error) {
                return fail('FAILED', `The chat could not be branched: ${error?.message ?? error}`);
            }
            if (!name) return fail('FAILED', 'SillyTavern did not create the branch.');
            // On the branch something still went wrong: back to the chat the reader was in.
            const back = async why => {
                let where = `the branch "${name}" is open`;
                try {
                    if (from) {
                        await reopen(from);
                        where = `you are back in "${from}" (the branch "${name}" was kept)`;
                    }
                } catch (error) {
                    where = `the branch "${name}" is open; "${from}" could not be opened again: ${error?.message ?? error}`;
                }
                return fail('FAILED', `${why}; nothing was taken back, and ${where}.`);
            };
            // The branch is the current chat now; its last message is the carrier we branched at.
            const at = (ctx.chat ?? []).length - 1;
            if (at !== index) return back(`The branch ends at message ${at}, not ${index}`);
            store.rebuild();
            let result;
            try { result = store.truncate(index, beforeRev); } catch (error) {
                return back(`The changes could not be taken back on the branch: ${error?.message ?? error}`);
            }
            // Taken back on the branch; a save that fails now is tried again (and told) by the store.
            let unsaved = '';
            try { await store.flush(); } catch (error) { unsaved = String(error?.message ?? error); }
            store.rebuild();
            events?.emit('head', { index: store.headIndex() });
            return { ok: true, branch: name, index, rev: result.rev, dropped: result.dropped, ...(unsaved ? { unsaved } : {}) };
        } finally {
            running = false;
        }
    };
}

// ---- save points (MODULES §F93) -------------------------------------------------------------------
//
// A save point is a SillyTavern branch of the chat at the current reply, made with the same machinery as
// rewind (but left closed: the reader stays where they are), and a named entry in the chat's own
// metadata: `chatMetadata.storySuite.savePoints[id] = { id, name, index, branch, at, rev }`. Return here
// opens that branch (the story there is the story as it was: its records came along with the messages).
//
// Why chat metadata and not story state: a save point is about the reader's chat files, not about the
// story. Story state is replayed per line of history, so a save point kept there would be taken back by
// a swipe, a deleted reply or a rewind (the very moments a reader wants to go back from), would cost a
// receipt and a rev of its own, and would be part of the branch it names (made at the moment before it).
// Metadata belongs to the chat file: it stays put through swipes and deletes, and nothing in the story
// (the prompt, the replay, the rev) changes because a save point was made. Branches made from the chat
// carry a copy of its list as it was then (SillyTavern copies the metadata into the branch file).

export const SAVEPOINTS_FEATURE = CORE_FEATURE.savepoints;
export const SAVEPOINT_LIMITS = Object.freeze({ name: 60, count: 50 });

/** SillyTavern's "make a branch, stay here": (index) → Promise<branch name | null>. */
export function stCreateBranch(ctx, { importer = path => import(path), branch = stBranch(ctx, { importer }), reopen = stReopen(ctx), live = () => globalThis.SillyTavern?.getContext?.() ?? ctx } = {}) {
    return async index => {
        if (typeof ctx?.createBranch === 'function') return ctx.createBranch(index);
        try {
            const bookmarks = await importer(BOOKMARKS);
            if (typeof bookmarks?.createBranch === 'function') return bookmarks.createBranch(index);
        } catch { /* not a SillyTavern page, or a version that moved it: branch and come back */ }
        // Only a way that opens the branch is left: make it, then open the chat the reader was in again.
        const c = live() ?? ctx;
        const from = typeof c?.getCurrentChatId === 'function' ? c.getCurrentChatId() : c?.chatId;
        const name = await branch(index);
        if (name && from) await reopen(from);
        return name;
    };
}

const flat = (text, max) => oneLine(text, max).trimEnd();
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ID = /^sp_[a-z0-9]{8}$/;

/** A stored entry as the list shows it, or null when it is not one Story Block wrote. */
function readPoint(id, value) {
    if (!ID.test(id) || !isRecord(value) || typeof value.branch !== 'string' || !value.branch) return null;
    return {
        id,
        name: flat(value.name, SAVEPOINT_LIMITS.name) || value.branch,
        index: Number.isInteger(value.index) && value.index >= 0 ? value.index : null,
        branch: value.branch,
        at: typeof value.at === 'string' ? value.at : '',
        rev: Number.isInteger(value.rev) ? value.rev : null,
    };
}

/**
 * createSavePoints({ ctx, store, live?, createBranch?, open?, now?, id? }) → {
 *   list() → [{ id, name, index, branch, at, rev }], newest first (the chat open now);
 *   save({ name? }) → Promise<{ ok: true, point } | { ok: false, code, message }>;
 *   returnTo(id) → Promise<{ ok: true, branch, here? } | { ok: false, code, message }>;
 *   forget(id) → Promise<{ ok: true } | { ok: false, code, message }> (the branch itself is kept);
 *   chatId() → the chat open now }.
 * `live()`: SillyTavern's live context (its chatMetadata and saveMetadata follow the chat open now);
 * `createBranch(index)`: stCreateBranch; `open(name)`: stReopen; `now()`: the time a save point is
 * stamped with (only shown to the reader; nothing is ordered by it).
 */
export function createSavePoints({
    ctx, store, live = () => globalThis.SillyTavern?.getContext?.() ?? ctx,
    createBranch = stCreateBranch(ctx, { live }), open = stReopen(ctx, { live }), now = () => Date.now(), id = () => newId('sp'),
}) {
    let running = false;
    const context = () => {
        try { return live() ?? ctx; } catch { return ctx; }
    };
    const chatId = () => {
        const c = context();
        return typeof c?.getCurrentChatId === 'function' ? c.getCurrentChatId() : c?.chatId;
    };
    // The chat's entries: chatMetadata.storySuite.savePoints, made on the way when `make`.
    function table({ make = false } = {}) {
        const c = context();
        if (!isRecord(c?.chatMetadata)) {
            if (!make || !c) return null;
            c.chatMetadata = {};
        }
        const meta = c.chatMetadata;
        if (!isRecord(meta.storySuite)) {
            if (!make) return null;
            meta.storySuite = {};
        }
        if (!isRecord(meta.storySuite.savePoints)) {
            if (!make) return null;
            meta.storySuite.savePoints = {};
        }
        return meta.storySuite.savePoints;
    }
    async function persist() {
        const c = context();
        if (typeof c?.saveMetadata === 'function') return c.saveMetadata();
        if (typeof c?.saveMetadataDebounced === 'function') return c.saveMetadataDebounced();
        return store?.saveSoon?.();
    }
    function list() {
        const entries = Object.entries(table() ?? {}).map(([key, value]) => readPoint(key, value)).filter(Boolean);
        // Newest first by the reply they were made at, then by the order they were added (key order).
        return entries.map((point, at) => ({ point, at })).sort((a, b) => (b.point.index ?? -1) - (a.point.index ?? -1) || b.at - a.at).map(item => item.point);
    }

    async function save({ name = '' } = {}) {
        if (running) return fail('STALE', 'A save point is already being made.');
        const chat = context()?.chat ?? ctx?.chat ?? [];
        let index;
        try { index = store.headIndex(); } catch { index = -1; }
        if (!Number.isInteger(index) || index < 0 || index >= chat.length || chat[index]?.is_user) {
            return fail('NOT_FOUND', 'There is no reply to keep yet: a save point is made at the latest reply that keeps the story.');
        }
        const points = list();
        if (points.length >= SAVEPOINT_LIMITS.count) {
            return fail('LIMITED', `This chat has ${SAVEPOINT_LIMITS.count} save points, the most it keeps; forget one first.`);
        }
        const label = flat(name, SAVEPOINT_LIMITS.name) || `Save point ${points.length + 1}`;
        running = true;
        try {
            const from = chatId();
            const rev = store.head?.()?.meta?.rev;
            try { await store.flush?.(); } catch { /* the store tries again; the branch takes the chat as it is in memory */ }
            let branch;
            try { branch = await createBranch(index); } catch (error) {
                return fail('FAILED', `The chat could not be branched: ${error?.message ?? error}`);
            }
            if (typeof branch !== 'string' || !branch) return fail('FAILED', 'SillyTavern did not create the branch.');
            if (chatId() !== from) {
                return fail('FAILED', `Another chat was opened while the save point was made; the branch "${branch}" was kept in SillyTavern but is not listed.`);
            }
            const key = id();
            const point = { id: key, name: label, index, branch, at: new Date(now()).toISOString(), rev: Number.isInteger(rev) ? rev : null };
            table({ make: true })[key] = { name: point.name, index, branch, at: point.at, rev: point.rev };
            try { await persist(); } catch (error) {
                return { ok: true, point, warning: `The save point is listed, but the chat could not be saved yet: ${error?.message ?? error}` };
            }
            return { ok: true, point };
        } finally {
            running = false;
        }
    }

    async function returnTo(key) {
        const point = list().find(item => item.id === key);
        if (!point) return fail('NOT_FOUND', 'That save point is not in this chat\'s list.');
        if (chatId() === point.branch) return { ok: true, branch: point.branch, here: true };
        if (running) return fail('STALE', 'A save point is being made; try again in a moment.');
        running = true;
        try {
            try { await store?.flush?.(); } catch { /* kept unsaved; the store tries again */ }
            try { await open(point.branch); } catch (error) {
                return fail('FAILED', `The branch "${point.branch}" could not be opened (it may have been renamed or deleted in SillyTavern): ${error?.message ?? error}`);
            }
            return { ok: true, branch: point.branch };
        } finally {
            running = false;
        }
    }

    async function forget(key) {
        const entries = table();
        if (!entries || !Object.hasOwn(entries, key)) return fail('NOT_FOUND', 'That save point is not in this chat\'s list.');
        delete entries[key];
        try { await persist(); } catch (error) {
            return { ok: true, warning: `Taken off the list, but the chat could not be saved yet: ${error?.message ?? error}` };
        }
        return { ok: true };
    }

    return { list, save, returnTo, forget, chatId };
}
