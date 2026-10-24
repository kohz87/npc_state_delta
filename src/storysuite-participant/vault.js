// NPC State Delta, where the participant keeps what it persists (contract §8: the participant "persists full native state/history/
// evidence/identity map"): immutable checkpoints by id, and one small index per chat (the live np_ map, the applied deaths, the ids ever
// issued, the restores in flight). Two kinds of vault, one interface (all asynchronous):
//
//   put(id, doc)         keeps a checkpoint; the same id again is the same bytes (the id is derived from the hash)
//   get(id)              the checkpoint, or null when its bytes are gone
//   getIndex(chatKey)    the chat's index or null; putIndex(chatKey, index) replaces it
//
// `memoryVault` is for tests (with `lose(id)` to forget bytes, `fail` to make a write throw). `fileVault` writes SillyTavern's user files
// the way Delta's own sidecar does (storage.js: POST /api/files/upload, read back from /user/files/<name>), one file per checkpoint.

const fnv1a = text => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
};

export function memoryVault() {
    const docs = new Map();
    const indexes = new Map();
    return {
        kind: 'memory',
        docs,
        indexes,
        fail: new Set(),
        async put(id, doc) {
            if (this.fail.has('put')) throw new Error('The vault could not write (test).');
            if (!docs.has(id)) docs.set(id, JSON.stringify(doc));
        },
        async get(id) {
            return docs.has(id) ? JSON.parse(docs.get(id)) : null;
        },
        async getIndex(chatKey) {
            return indexes.has(chatKey) ? JSON.parse(indexes.get(chatKey)) : null;
        },
        async putIndex(chatKey, index) {
            if (this.fail.has('putIndex')) throw new Error('The vault could not write the index (test).');
            indexes.set(chatKey, JSON.stringify(index));
        },
        lose(id) {
            docs.delete(id);
        },
    };
}

export function fileVault({ fetchFn = globalThis.fetch, headers = {}, base = '/user/files' } = {}) {
    // `headers` may be a function: SillyTavern's request headers (a token) are read when a request is made, not when the vault is.
    const headersNow = () => (typeof headers === 'function' ? headers() : headers) ?? {};
    const nameOf = id => `npc-state-delta-checkpoint-${id}.json`;
    const indexName = chatKey => `npc-state-delta-participant-${fnv1a(String(chatKey))}${fnv1a([...String(chatKey)].reverse().join(''))}.json`;
    const bytesToBase64 = bytes => {
        const parts = [];
        for (let i = 0; i < bytes.length; i += 0x8000) parts.push(String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length))));
        return globalThis.btoa(parts.join(''));
    };
    async function upload(name, json) {
        if (typeof fetchFn !== 'function') throw new Error('fetch() is unavailable for the participant\'s files.');
        const response = await fetchFn('/api/files/upload', { method: 'POST', headers: headersNow(), body: JSON.stringify({ name, data: bytesToBase64(new TextEncoder().encode(json)) }) });
        if (!response?.ok) throw new Error(`The participant's file ${name} could not be written (${response?.status ?? 'no answer'}).`);
    }
    async function read(name) {
        if (typeof fetchFn !== 'function') throw new Error('fetch() is unavailable for the participant\'s files.');
        const response = await fetchFn(`${base}/${name}`, { cache: 'no-store' });
        if (response?.status === 404) return null;
        if (!response?.ok) throw new Error(`The participant's file ${name} could not be read (${response?.status ?? 'no answer'}).`);
        try { return JSON.parse(await response.text()); } catch { return null; }
    }
    return {
        kind: 'file',
        async put(id, doc) {
            const name = nameOf(id);
            if (await read(name)) return;
            await upload(name, JSON.stringify(doc));
        },
        get: id => read(nameOf(id)),
        getIndex: chatKey => read(indexName(chatKey)),
        putIndex: (chatKey, index) => upload(indexName(chatKey), JSON.stringify(index)),
    };
}
