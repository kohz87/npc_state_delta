// NPC State Delta, where the participant keeps what it persists (contract §8: the participant "persists full native state/history/
// evidence/identity map"): immutable checkpoints by id, and one small index per lineage (the restores in flight, the acknowledged deaths, the checkpoint
// the story stands on). Two kinds of vault, one interface (all asynchronous):
//
//   put(id, doc)         keeps a checkpoint; the same id again is the same bytes (the id is derived from the hash)
//   get(id)              the checkpoint, or null when its bytes are gone
//   getIndex(lineage)    the lineage's index or null; putIndex(lineage, index) replaces it (a lineage id is in the chat's state, not its key)
//   list()               { files: [{ id, size, modifiedAt }], complete } for the clean-up report (vault-sweep.js). SillyTavern has no call that lists
//                        the user's files without side effects (its Data Maid report replaces the user's own Data Maid token, so it is never used),
//                        so the file vault lists what it wrote itself (a small registry file) and says `complete: false`: files written before
//                        the registry existed are not known by name, so they are never offered, and the totals are "at least".
//   remove(id, { referenced })  deletes one checkpoint; false (and nothing deleted) when `id` is in `referenced` (a Set or list) or is not there
//

// `memoryVault` is for tests (with `lose(id)` to forget bytes, `fail` to make a write throw). `fileVault` writes SillyTavern's user files
// the way Delta's own sidecar does (storage.js: POST /api/files/upload, read back from /user/files/<name>), one file per checkpoint.
// A first write (a new checkpoint, a new lineage's index) asks SillyTavern whether the file exists (storage.js `dataFileExists`) before it
// reads it, so a file that is not there yet makes no 404 request (a red line in the browser's console); a server that cannot say is read as before.
import { dataFileExists, deleteNpcStateDataFile } from '../../storage.js';
import { CHECKPOINT_ID } from './checkpoint.js';

const REGISTRY_NAME = 'npc-state-delta-checkpoint-registry.json';

/** True when `id` is in the referenced set the caller passed (a Set, a list or nothing). A vault never removes such a checkpoint. */
const isReferenced = (referenced, id) => (referenced instanceof Set ? referenced.has(id) : Array.isArray(referenced) && referenced.includes(id));

const fnv1a = text => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
};

export function memoryVault({ now = () => Date.now() } = {}) {
    const docs = new Map();
    const meta = new Map();
    const indexes = new Map();
    return {
        kind: 'memory',
        docs,
        indexes,
        fail: new Set(),
        async put(id, doc) {
            if (this.fail.has('put')) throw new Error('The vault could not write (test).');
            // The same id again is the same bytes but a new reference may follow: it counts as written now, so it is never "old".
            if (docs.has(id)) { meta.get(id).modifiedAt = now(); return; }
            docs.set(id, JSON.stringify(doc));
            meta.set(id, { size: docs.get(id).length, modifiedAt: now() });
        },
        async list() {
            return { files: [...meta].map(([id, entry]) => ({ id, ...entry })), complete: true };
        },
        async remove(id, { referenced } = {}) {
            if (isReferenced(referenced, id) || !docs.has(id)) return false;
            docs.delete(id);
            meta.delete(id);
            return true;
        },
        /** Test helper: make a checkpoint look `ms` older. */
        age(id, ms) {
            if (meta.has(id)) meta.get(id).modifiedAt -= ms;
        },
        async get(id) {
            return docs.has(id) ? JSON.parse(docs.get(id)) : null;
        },
        async getIndex(lineage) {
            return indexes.has(lineage) ? JSON.parse(indexes.get(lineage)) : null;
        },
        async putIndex(lineage, index) {
            if (this.fail.has('putIndex')) throw new Error('The vault could not write the index (test).');
            indexes.set(lineage, JSON.stringify(index));
        },
        lose(id) {
            docs.delete(id);
        },
    };
}

export function fileVault({ fetchFn = globalThis.fetch, headers = {}, base = '/user/files', timeoutMs = 15000, now = () => Date.now() } = {}) {
    // `headers` may be a function: SillyTavern's request headers (a token) are read when a request is made, not when the vault is.
    const headersNow = () => (typeof headers === 'function' ? headers() : headers) ?? {};
    const nameOf = id => `npc-state-delta-checkpoint-${id}.json`;
    const indexName = lineage => `npc-state-delta-participant-${fnv1a(String(lineage))}${fnv1a([...String(lineage)].reverse().join(''))}.json`;
    const bytesToBase64 = bytes => {
        const parts = [];
        for (let i = 0; i < bytes.length; i += 0x8000) parts.push(String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length))));
        return globalThis.btoa(parts.join(''));
    };
    // A request that gets no answer in `timeoutMs` is an error, not a wait: the timeline's one queue must not hang on a stuck file request.
    async function request(url, options) {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
        try {
            return await fetchFn(url, { ...options, ...(controller ? { signal: controller.signal } : {}) });
        } catch (error) {
            if (controller?.signal.aborted) throw new Error(`The participant's file request ${url} did not answer in ${timeoutMs} ms.`);
            throw error;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
    async function upload(name, json) {
        if (typeof fetchFn !== 'function') throw new Error('fetch() is unavailable for the participant\'s files.');
        const response = await request('/api/files/upload', { method: 'POST', headers: headersNow(), body: JSON.stringify({ name, data: bytesToBase64(new TextEncoder().encode(json)) }) });
        if (!response?.ok) throw new Error(`The participant's file ${name} could not be written (${response?.status ?? 'no answer'}).`);
    }
    async function read(name) {
        if (typeof fetchFn !== 'function') throw new Error('fetch() is unavailable for the participant\'s files.');
        const response = await request(`${base}/${name}`, { cache: 'no-store' });
        if (response?.status === 404) return null;
        if (!response?.ok) throw new Error(`The participant's file ${name} could not be read (${response?.status ?? 'no answer'}).`);
        try { return JSON.parse(await response.text()); } catch { return null; }
    }
    // The registry: {v:1, files:{id:[size, writtenAtMs]}}, kept beside the checkpoints. Changes to it run one after another in this vault.
    let registryChain = Promise.resolve();
    const readRegistry = async () => {
        if ((await absent(REGISTRY_NAME))) return {};
        const doc = await read(REGISTRY_NAME);
        if (doc === null) {
            // Present but unreadable: never start over from nothing (that would forget files); callers treat the throw as "cannot list".
            if (!(await absent(REGISTRY_NAME))) throw new Error('The dossier file registry could not be read.');
            return {};
        }
        return doc && typeof doc === 'object' && doc.files && typeof doc.files === 'object' ? { ...doc.files } : {};
    };
    const changeRegistry = change => {
        const run = registryChain.then(async () => {
            const files = await readRegistry();
            if (change(files) !== false) await upload(REGISTRY_NAME, JSON.stringify({ v: 1, files }));
        });
        registryChain = run.catch(() => {});
        return run;
    };
    async function listCheckpoints() {
        const files = await registryChain.then(readRegistry);
        const out = Object.entries(files).flatMap(([id, entry]) => (CHECKPOINT_ID.test(id) && Array.isArray(entry) ? [{ id, size: entry[0], modifiedAt: entry[1] }] : []));
        return { files: out, complete: false };
    }
    /** True only when the server says the file is not there; false when it is, or when it cannot say (the caller then reads it). */
    const absent = async name => (await dataFileExists(`${base}/${name}`, { fetchFn: request, headers: headersNow() })) === false;
    return {
        kind: 'file',
        async put(id, doc) {
            const name = nameOf(id);
            const json = JSON.stringify(doc);
            if (!(await absent(name)) && await read(name)) {
                // Already kept: a new reference may follow, so a registered file counts as written now. An unregistered one stays unknown.
                try { await changeRegistry(files => { if (!files[id]) return false; files[id][1] = now(); }); } catch { /* the file itself is kept */ }
                return;
            }
            await upload(name, json);
            // The registry is only a list for the clean-up, written after the checkpoint and not waited for: the checkpoint's own write path is
            // unchanged, and a failure to record only means the (young) file is not offered. Re-registering below waits, because it is the proof of age.
            const entry = [new TextEncoder().encode(json).length, now()];
            void changeRegistry(files => { files[id] = entry; }).catch(() => {});
        },
        list: listCheckpoints,
        async remove(id, { referenced } = {}) {
            if (!CHECKPOINT_ID.test(String(id)) || isReferenced(referenced, id)) return false;
            const removed = await deleteNpcStateDataFile({ path: `${base}/${nameOf(id)}` }, { fetchFn: request, headers: headersNow() });
            if (removed) { try { await changeRegistry(files => { if (!files[id]) return false; delete files[id]; }); } catch { /* a stale entry only fails to remove later */ } }
            return removed;
        },
        get: id => read(nameOf(id)),
        async getIndex(lineage) {
            const name = indexName(lineage);
            return (await absent(name)) ? null : read(name);
        },
        putIndex: (lineage, index) => upload(indexName(lineage), JSON.stringify(index)),
    };
}
