// Which native checkpoints the chats of this install still refer to (docs/v2/TIMELINE.md, checkpoint clean-up).
//
// "In use" means named by a chat SillyTavern LISTS now: every character and group chat. Each is read in full as a raw
// export (so a damaged line is seen, not dropped); the timeline archive in the header is walked for checkpoint ids, and
// the open chat's live metadata is read as well. Chats left behind by a deleted character are not listed and are out of
// scope: they do not make the answer incomplete. Any LISTED chat or group record that cannot be read, a damaged chat
// file, or an open-chat switch during the read gives complete:false and is named in `unreadable`. It never deletes.
//
// The timeline fields that can name a native checkpoint include the journal (make, restore, native change and head
// selection entries), the prefix map's before/after records, the selected and baseline records, snapshot and payload
// participants, pins and any nested `checkpoint`/`checkpoints` field. The walk below covers all of them without naming
// another module's checkpoint format.

export const TIMELINE_SCHEMA = 1;

const EXT = /\.jsonl$/i;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const reasonOf = error => String(error?.message || error || 'could not be read');

function liveContext() {
    try { return globalThis.SillyTavern?.getContext?.() ?? null; } catch { return null; }
}

function fetchNow(...args) {
    return globalThis.fetch(...args);
}

function checkpointKey(name) {
    return /checkpoints?(?:ids?)?$/i.test(String(name ?? ''));
}

/** Add every checkpoint id under a `checkpoint`/`checkpoints` field in a timeline archive (a Set). */
export function collectCheckpointReferences(timeline) {
    const found = new Set();
    const seen = new WeakSet();
    const stringsUnder = value => {
        if (typeof value === 'string') {
            const id = value.trim();
            if (id) found.add(id);
            return;
        }
        if (Array.isArray(value)) {
            for (const item of value) stringsUnder(item);
            return;
        }
        if (!isRecord(value)) return;
        if (seen.has(value)) return;
        seen.add(value);
        for (const item of Object.values(value)) {
            stringsUnder(item);
        }
    };
    const walk = value => {
        if (Array.isArray(value)) {
            for (const item of value) walk(item);
            return;
        }
        if (!isRecord(value)) return;
        if (seen.has(value)) return;
        seen.add(value);
        for (const [key, item] of Object.entries(value)) {
            if (checkpointKey(key)) stringsUnder(item);
            else walk(item);
        }
    };
    walk(timeline);
    return found;
}

/** The archive in one chat's first file row, or a refusal that makes the whole scan incomplete. */
function timelineOfChat(payload) {
    if (Array.isArray(payload)) {
        if (!payload.length) throw new Error('the chat file is empty');
        if (!isRecord(payload[0])) throw new Error('the chat file has no header');
        if (!['chat_metadata', 'user_name', 'character_name'].some(key => Object.hasOwn(payload[0], key))) throw new Error('the chat file has no header');
        const metadata = payload[0].chat_metadata;
        if (metadata === undefined || metadata === null) return null;
        if (!isRecord(metadata)) throw new Error('the chat metadata is not an object');
        return timelineOfMetadata(metadata);
    }
    if (isRecord(payload) && Object.hasOwn(payload, 'chat_metadata')) {
        const metadata = payload.chat_metadata;
        if (metadata === undefined || metadata === null) return null;
        if (!isRecord(metadata)) throw new Error('the chat metadata is not an object');
        return timelineOfMetadata(metadata);
    }
    throw new Error('the chat file could not be parsed');
}

function timelineOfMetadata(metadata) {
    const suite = metadata.storySuite;
    if (suite === undefined || suite === null) return null;
    if (!isRecord(suite)) throw new Error('the Story Suite metadata is not an object');
    const timeline = suite.timeline;
    if (timeline === undefined || timeline === null) return null;
    if (!isRecord(timeline)) throw new Error('the timeline archive is not an object');
    if (timeline.v !== undefined) {
        if (!Number.isInteger(timeline.v) || timeline.v < 1) throw new Error('the timeline archive version is not valid');
        if (timeline.v > TIMELINE_SCHEMA) throw new Error(`timeline archive version ${timeline.v} is from a newer version`);
    }
    return timeline;
}

async function postJson(fetchFn, context, url, body) {
    if (typeof fetchFn !== 'function') throw new Error('SillyTavern cannot be reached');
    if (typeof context?.getRequestHeaders !== 'function') throw new Error('SillyTavern request headers are not available');
    const response = await fetchFn(url, {
        method: 'POST',
        headers: context.getRequestHeaders(),
        cache: 'no-cache',
        body: JSON.stringify(body),
    });
    if (!response?.ok) throw new Error(`the server answered ${response?.status ?? 'nothing'}`);
    try { return await response.json(); } catch { throw new Error('the server answer was not JSON'); }
}

function chatFileId(file) {
    return String(file?.file_id ?? file?.file_name ?? file?.fileName ?? file?.name ?? '').replace(EXT, '').trim();
}

/** The chat list of this install: character chat files, then group chat files. */
async function sillyTavernChatList({ context, fetchFn }) {
    const chats = [];
    const unreadable = [];
    const seen = new Set();
    const add = chat => {
        const key = `${chat.kind}|${chat.avatar ?? ''}|${chat.id}`;
        if (seen.has(key)) return;
        seen.add(key);
        chats.push(chat);
    };
    const characters = Array.isArray(context?.characters) ? context.characters : null;
    const groups = Array.isArray(context?.groups) ? context.groups : null;
    if (!characters) unreadable.push({ chat: 'character list', reason: 'SillyTavern did not provide its characters' });
    if (!groups) unreadable.push({ chat: 'group list', reason: 'SillyTavern did not provide its groups' });
    if (characters) {
        for (const character of characters) {
            const avatar = String(character?.avatar ?? '').trim();
            const name = String(character?.name ?? avatar).trim();
            if (!avatar) {
                unreadable.push({ chat: `character ${name || '(unnamed)'}`, reason: 'it has no avatar file to list chats with' });
                continue;
            }
            let answer;
            try {
                answer = await postJson(fetchFn, context, '/api/characters/chats', { avatar_url: avatar, simple: true });
            } catch (error) {
                unreadable.push({ chat: `character ${name}`, reason: reasonOf(error) });
                continue;
            }
            if (isRecord(answer) && answer.error) {
                unreadable.push({ chat: `character ${name}`, reason: 'SillyTavern could not list its chats' });
                continue;
            }
            const list = Array.isArray(answer) ? answer : isRecord(answer) ? Object.values(answer) : null;
            if (!list) {
                unreadable.push({ chat: `character ${name}`, reason: 'the chat list was not a list' });
                continue;
            }
            for (const file of list) {
                const id = chatFileId(file);
                if (!id) {
                    unreadable.push({ chat: `character ${name}`, reason: 'a listed chat has no file name' });
                    continue;
                }
                add({ kind: 'character', label: `${name} / ${id}`, name, avatar, id });
            }
        }
    }
    if (groups) {
        for (const group of groups) {
            const groupName = String(group?.name ?? group?.id ?? 'group');
            if (!Array.isArray(group?.chats)) {
                unreadable.push({ chat: `group ${groupName}`, reason: 'its chat list is not available' });
                continue;
            }
            const ids = [
                ...group.chats,
                group?.chat_id,
            ].map(value => String(value ?? '').replace(EXT, '').trim()).filter(Boolean);
            for (const id of new Set(ids)) add({ kind: 'group', label: `${groupName} / ${id}`, id });
        }
    }
    return { chats, unreadable };
}

async function readSillyTavernChat(chat, { context, fetchFn }) {
    // The normal get endpoints silently drop invalid JSONL rows. Read the raw file so a damaged header or
    // message cannot turn an unreadable chat into a successful scan with its references missing.
    const file = `${chat.id}.jsonl`;
    const answer = await postJson(fetchFn, context, '/api/chats/export', {
        file, exportfilename: file, format: 'jsonl', is_group: chat.kind === 'group',
        ...(chat.kind === 'group' ? {} : { avatar_url: chat.avatar }),
    });
    if (typeof answer?.result !== 'string' || !answer.result.trim()) throw new Error('the chat file is empty or could not be read');
    try {
        return answer.result.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
    } catch {
        throw new Error('the chat file could not be parsed');
    }
}

/**
 * Checkpoint ids still named by every chat's timeline, through SillyTavern's chat list and chat read.
 * `list`/`read` are seams for tests; without them the SillyTavern endpoints are used.
 * → `{ complete, referenced: string[], unreadable: [{ chat, reason }] }`. `complete` is false if ANY chat or
 * list could not be read, parsed or carries a newer timeline schema.
 */
export async function referencedCheckpoints({ context = liveContext, fetchFn = fetchNow, list = null, read = null } = {}) {
    const found = new Set();
    const unreadable = [];
    const ctx = typeof context === 'function' ? context() : context;
    const initialMetadata = ctx?.chatMetadata;
    if (!ctx) unreadable.push({ chat: 'SillyTavern', reason: 'its context is not available' });
    let listed = null;
    try {
        listed = typeof list === 'function'
            ? await list({ context: ctx, fetchFn })
            : await sillyTavernChatList({ context: ctx, fetchFn });
    } catch (error) {
        unreadable.push({ chat: 'chat list', reason: reasonOf(error) });
    }
    let chats = null;
    if (Array.isArray(listed)) chats = listed;
    else if (listed && typeof listed === 'object') {
        if (Array.isArray(listed.unreadable)) unreadable.push(...listed.unreadable);
        if (Array.isArray(listed.chats)) chats = listed.chats;
        else unreadable.push({ chat: 'chat list', reason: 'the chat list could not be read' });
    } else if (!unreadable.some(item => item.chat === 'chat list')) unreadable.push({ chat: 'chat list', reason: 'the chat list could not be read' });
    for (const chat of chats ?? []) {
        try {
            const payload = await (typeof read === 'function' ? read(chat, { context: ctx, fetchFn }) : readSillyTavernChat(chat, { context: ctx, fetchFn }));
            const timeline = timelineOfChat(payload);
            if (timeline) for (const id of collectCheckpointReferences(timeline)) found.add(id);
        } catch (error) {
            unreadable.push({ chat: chat?.label ?? chat?.id ?? 'chat', reason: reasonOf(error) });
        }
    }
    // The open chat can be newer than its file (an unsaved turn); never leave its live references out.
    let latest = ctx;
    try { if (typeof context === 'function') latest = context(); } catch { latest = null; }
    if (!latest || latest.chatMetadata !== initialMetadata) unreadable.push({ chat: 'open chat', reason: 'the open chat changed during the check' });
    if (latest?.chatMetadata && typeof latest.chatMetadata === 'object') {
        try {
            const timeline = timelineOfMetadata(latest.chatMetadata);
            if (timeline) for (const id of collectCheckpointReferences(timeline)) found.add(id);
        } catch (error) {
            unreadable.push({ chat: 'open chat', reason: reasonOf(error) });
        }
    }
    return { complete: unreadable.length === 0, referenced: [...found].sort(), unreadable };
}
