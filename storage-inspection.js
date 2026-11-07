/* NPC State Delta sidecar inspection: read-concurrency slots, the bounded ETag/Last-Modified inspection
   cache, revision checks, decoded-payload getters and pointer adoption. Moved out of storage.js as a
   factory so each separately imported storage instance keeps its own read slots and cache. Never
   imports storage.js. */
export function createStorageInspection({ dataFileExists, decodeStateFilePayload, makeNpcStateDataFileName }) {
    const READ_CONCURRENCY_LIMIT = 4;
    let activeReads = 0;
    const readWaiters = [];

    async function withReadSlot(task) {
        if (activeReads >= READ_CONCURRENCY_LIMIT) await new Promise(resolve => readWaiters.push(resolve));
        activeReads += 1;
        try { return await task(); }
        finally {
            activeReads = Math.max(0, activeReads - 1);
            readWaiters.shift()?.();
        }
    }

    const MISSING_FILE = Object.freeze({ revision: 0, writerId: '', exists: false, retired: false, updatedAt: 0, payload: null });

    // (1.10.1) What the last read of each sidecar path found: its ETag and Last-Modified, the file's text and the
    // few fields a boundary check needs. A boundary check runs several times per turn and only needs the revision
    // and writer; when the server's revalidated answer is the same file (304, or the same validators), those come
    // from here instead of reading and parsing the whole file (portraits, checkpoints) on the main thread again.
    // The request itself is unchanged ('no-cache': every check still asks the server), so another tab's or
    // device's write is seen exactly as before. The full state is decoded only when a caller reads `payload`.
    const inspectedFiles = new Map();
    const INSPECTED_FILES_LIMIT = 4;

    function responseHeader(response, name) {
        try { return String(response?.headers?.get?.(name) || ''); } catch { return ''; }
    }

    function rememberInspectedFile(path, entry) {
        inspectedFiles.delete(path);
        inspectedFiles.set(path, entry);
        while (inspectedFiles.size > INSPECTED_FILES_LIMIT) inspectedFiles.delete(inspectedFiles.keys().next().value);
    }

    function fileMeta(payload) {
        return {
            chatKey: String(payload.chatKey || ''),
            revision: payload.revision,
            writerId: payload.writerId,
            retired: Boolean(payload.retired),
            updatedAtText: String(payload.updatedAt || ''),
        };
    }

    // The inspection result. `payload` is the decoded file: given (a fresh read), or decoded from the remembered
    // text the first time a caller reads it, once per result, so no two callers ever share one decoded object.
    function inspectionResult(meta, text, payload = null) {
        const parsedUpdatedAt = Date.parse(meta.updatedAtText);
        const result = {
            revision: meta.revision,
            writerId: meta.writerId,
            exists: true,
            retired: meta.retired,
            updatedAt: Number.isFinite(parsedUpdatedAt) ? parsedUpdatedAt : 0,
        };
        if (payload) {
            result.payload = payload;
            return result;
        }
        let decoded = null;
        Object.defineProperty(result, 'payload', {
            enumerable: true,
            configurable: true,
            get() { return decoded || (decoded = decodeStateFilePayload(text)); },
            set(value) { decoded = value; },
        });
        return result;
    }

    // `writtenText`: the exact JSON this session just uploaded to this path. When the server returns those bytes,
    // their fields are the ones written (`writtenMeta`) and the file is not parsed again to learn them.
    async function inspectSidecar(pointer, { fetchFn = globalThis.fetch, expectedChatKey = '', probeHeaders = null, writtenText = null, writtenMeta = null } = {}) {
        if (!pointer?.path) return { inspected: { ...MISSING_FILE }, updatedAtText: '' };
        if (typeof fetchFn !== 'function') throw new Error('fetch() is unavailable for NPC State Delta data-file inspection.');
        const path = pointer.path;
        if (probeHeaders && await dataFileExists(path, { fetchFn, headers: probeHeaders }) === false) {
            inspectedFiles.delete(path);
            return { inspected: { ...MISSING_FILE }, updatedAtText: '' };
        }
        // Always revalidated with the server ('no-cache'), never read stale; but an unchanged sidecar
        // comes back as "304 Not Modified" from SillyTavern's file route instead of re-downloading the
        // whole file. A boundary check runs several times per turn, which on a slow remote/mobile link
        // otherwise re-transfers the full dossier (portraits, checkpoints) each time.
        const response = await withReadSlot(() => fetchFn(path, { method: 'GET', cache: 'no-cache' }));
        if (response?.status === 404) {
            inspectedFiles.delete(path);
            return { inspected: { revision: 0, writerId: '', exists: false, retired: false, updatedAt: 0, payload: null }, updatedAtText: '' };
        }
        const known = inspectedFiles.get(path);
        const etag = responseHeader(response, 'etag');
        const lastModified = responseHeader(response, 'last-modified');
        const unchanged = Boolean(known) && (response?.status === 304
            || (Boolean(response?.ok) && Boolean(etag) && etag === known.etag && lastModified === known.lastModified));
        let meta;
        let text;
        let payload = null;
        if (unchanged) {
            ({ meta, text } = known);
            try { void response?.body?.cancel?.()?.catch?.(() => {}); } catch { /* the body is simply not read */ }
            rememberInspectedFile(path, known);
        } else {
            if (!response?.ok) {
                const error = new Error(`NPC State Delta data file revision check failed with HTTP ${response?.status || 'error'}.`);
                error.status = Number(response?.status || 0);
                throw error;
            }
            text = typeof response.text === 'function' ? await response.text() : '';
            if (writtenText !== null && writtenMeta && text === writtenText) meta = { ...writtenMeta };
            else {
                payload = decodeStateFilePayload(text);
                meta = fileMeta(payload);
            }
            if (etag) rememberInspectedFile(path, { etag, lastModified, text, meta });
            else inspectedFiles.delete(path);
        }
        if (expectedChatKey && meta.chatKey !== String(expectedChatKey)) throw new Error('NPC State Delta data file belongs to a different chat.');
        return { inspected: inspectionResult(meta, text, payload), updatedAtText: meta.updatedAtText };
    }

    // `probeHeaders` (request headers): ask whether the file exists first (dataFileExists) and, when
    // the server says it does not, answer "missing" without fetching it. Used where a missing file is
    // expected (a chat's first look for its file); everywhere else the file is fetched directly.
    async function inspectNpcStateDataFile(pointer, { fetchFn = globalThis.fetch, expectedChatKey = '', probeHeaders = null } = {}) {
        return (await inspectSidecar(pointer, { fetchFn, expectedChatKey, probeHeaders })).inspected;
    }

    function adoptNpcStateDataFileMetadata(pointer, inspected) {
        if (!pointer || typeof pointer !== 'object' || !inspected?.exists) return pointer;
        pointer.revision = Math.max(0, Math.trunc(Number(inspected.revision) || 0));
        pointer.writerId = String(inspected.writerId || pointer.writerId || '');
        pointer.updatedAt = Math.max(0, Number(inspected.updatedAt) || Number(pointer.updatedAt) || Date.now());
        pointer.retired = Boolean(inspected.retired);
        return pointer;
    }

    async function remoteRevision(pointer, chatKey, fetchFn, probeHeaders = null, written = null) {
        const { inspected, updatedAtText } = await inspectSidecar(pointer, { fetchFn, expectedChatKey: chatKey, probeHeaders, writtenText: written?.text ?? null, writtenMeta: written?.meta ?? null });
        return {
            revision: inspected.revision,
            writerId: inspected.writerId,
            exists: inspected.exists,
            retired: inspected.retired,
            updatedAtText,
        };
    }

    // A pointer is only a cached route to the deterministic sidecar. A session that hydrated before
    // another session created the file has no pointer, so it must still probe the deterministic path
    // instead of treating "no pointer" as "no canonical file".
    function probeNpcStateDataFilePointer(chatKey, pointer = null) {
        if (pointer?.path) return pointer;
        const name = pointer?.name || makeNpcStateDataFileName(chatKey);
        return { name, path: `/user/files/${name}` };
    }

    return { adoptNpcStateDataFileMetadata, inspectNpcStateDataFile, probeNpcStateDataFilePointer, remoteRevision };
}
