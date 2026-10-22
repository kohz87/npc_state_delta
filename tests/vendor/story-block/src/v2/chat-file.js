// Story Suite v2: writing the chat file itself (SPEC §3.3), the way SillyTavern's own saveChat does.
//
// Why not ctx.saveChat? In SillyTavern 1.19 it is saveChatConditional, which
// * waits at least 100 ms before it reads the chat, so a chat opened in that time is the one it writes
//   (SillyTavern opens a chat by emptying the shared `chat` array, then naming the new file, then
//   reading it: a save that lands in between writes an empty chat over the new chat's file);
// * catches every error and gives up quietly on a timeout, so a save the server refused looks saved.
// Here the request body is made from the chat in the same tick as the caller's check that the chat is
// still the one the change was made in, and a refused save rejects.
//
// createChatFile({ context, fetch }):
//   context() → SillyTavern's live context (getContext(), asked anew each time: characterId, groupId and
//               chatMetadata in a context taken earlier are stale).
//   where()                          → place | null: the open chat's file ({ chatId, name, avatar } or
//                                      { chatId, group }), null where this page has no such file (no
//                                      SillyTavern, a temporary chat): the caller falls back to ctx.saveChat.
//   write(place, messages, metadata, { keepalive, signal }) → Promise: the request is sent before this
//                                      returns; rejects with a plain-words error when the server refuses
//                                      it. `signal` (an AbortSignal) gives the request up (persist.js
//                                      createSaver's timeout).
//   read(place)                      → Promise<[header, ...messages]>: the file as the server has it.

const SAVE = { character: '/api/chats/save', group: '/api/chats/group/save' };
const GET = { character: '/api/chats/get', group: '/api/chats/group/get' };
// Browsers send a keepalive request (one that outlives the page) only up to 64 KiB.
const KEEPALIVE_MAX = 60 * 1024;

export function createChatFile({ context, fetch = (...args) => globalThis.fetch(...args) } = {}) {
    if (typeof context !== 'function') throw new TypeError('createChatFile needs a context() function.');

    function where() {
        const c = context();
        if (typeof c?.getRequestHeaders !== 'function' || typeof fetch !== 'function') return null;
        const chatId = typeof c.getCurrentChatId === 'function' ? c.getCurrentChatId() : null;
        if (typeof chatId !== 'string' || !chatId) return null;
        if (c.groupId !== undefined && c.groupId !== null && c.groupId !== '') return { chatId, group: String(c.groupId) };
        const character = c.characters?.[c.characterId];
        if (!character || typeof character.avatar !== 'string' || !character.avatar) return null;
        return { chatId, name: String(character.name ?? ''), avatar: character.avatar };
    }

    function post(url, body, { keepalive = false, signal = null } = {}) {
        const text = JSON.stringify(body);
        return fetch(url, {
            method: 'POST',
            headers: context().getRequestHeaders(),
            cache: 'no-cache',
            body: text,
            ...(keepalive && text.length <= KEEPALIVE_MAX ? { keepalive: true } : {}),
            ...(signal ? { signal } : {}),
        });
    }

    async function refused(response) {
        let error = null;
        try { error = (await response.json())?.error ?? null; } catch { /* not JSON */ }
        if (error === 'integrity') {
            return new Error('the chat file on the server was replaced since it was opened (another tab or device?); reload the chat');
        }
        return new Error(`the server answered ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
    }

    function write(place, messages, metadata = {}, options = {}) {
        if (!place) return Promise.reject(new Error('there is no chat file to write'));
        const header = { chat_metadata: metadata ?? {}, user_name: 'unused', character_name: 'unused' };
        const chat = [header, ...messages];
        const body = place.group
            ? { id: place.chatId, chat, force: false }
            : { ch_name: place.name, file_name: place.chatId, chat, avatar_url: place.avatar, force: false };
        let request;
        try {
            request = post(place.group ? SAVE.group : SAVE.character, body, options);
        } catch (error) {
            return Promise.reject(error);
        }
        return Promise.resolve(request).then(async response => {
            if (!response?.ok) throw await refused(response ?? { status: 0 });
        }, error => {
            throw new Error(`the server could not be reached (${error?.message ?? error})`);
        });
    }

    async function read(place) {
        if (!place) throw new Error('there is no chat file to read');
        const body = place.group ? { id: place.chatId } : { ch_name: place.name, file_name: place.chatId, avatar_url: place.avatar };
        let response;
        try {
            response = await post(place.group ? GET.group : GET.character, body);
        } catch (error) {
            throw new Error(`the server could not be reached (${error?.message ?? error})`);
        }
        if (!response?.ok) throw await refused(response ?? { status: 0 });
        const data = await response.json();
        return Array.isArray(data) ? data : [];
    }

    return { where, write, read };
}
