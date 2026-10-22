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
 * { ok: true, branch, index, rev, dropped } | { ok: false, code, message }>.
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
            await store.flush();
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
            await store.flush();
            store.rebuild();
            events?.emit('head', { index: store.headIndex() });
            return { ok: true, branch: name, index, rev: result.rev, dropped: result.dropped };
        } finally {
            running = false;
        }
    };
}
