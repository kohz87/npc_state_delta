/* NPC State Delta sidecar file transport: upload of JSON payloads, existence probes and cast-portrait
   user-file save/verify/read helpers. Moved unchanged out of storage.js; storage.js re-exports every
   public name it exported before. Never imports storage.js. */
import { dataUrlOfBytes, isPortraitFileRecord, markPortraitFileMissing, markPortraitFilePresent, parseImageDataUrl, portraitFileRecordFor } from './src/portrait-file.js';
import { bytesToBase64 } from './storage-payload.js';

export async function uploadPayload({ name, json, fetchFn, headers }) {
    const data = bytesToBase64(new TextEncoder().encode(json));
    const response = await fetchFn('/api/files/upload', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name, data }),
    });
    if (!response?.ok) {
        const detail = typeof response?.text === 'function' ? await response.text() : '';
        const error = new Error(`NPC State Delta data file write failed${detail ? `: ${detail}` : ''}.`);
        error.status = Number(response?.status || 0);
        throw error;
    }
    const result = typeof response.json === 'function' ? await response.json() : {};
    if (!result?.path) throw new Error('NPC State Delta data-file endpoint returned no path.');
    return result;
}

// (beta) Whether a file exists, asked without fetching it (SillyTavern's /api/files/verify): true, false,
// or null when the server cannot say (no such route, an error, an answer of another shape); the caller
// then reads the file as before. A new chat has no data file yet, and fetching it only to be told so
// puts a red "404" in the browser console on every new chat.
export async function dataFileExists(path, { fetchFn = globalThis.fetch, headers = null } = {}) {
    if (!path || typeof fetchFn !== 'function' || !headers) return null;
    try {
        const response = await fetchFn('/api/files/verify', { method: 'POST', headers, body: JSON.stringify({ urls: [path] }) });
        if (!response?.ok || typeof response.json !== 'function') return null;
        const result = await response.json();
        const value = result && typeof result === 'object' ? result[path] : undefined;
        return typeof value === 'boolean' ? value : null;
    } catch {
        return null;
    }
}

// (cast portraits) Several files' existence in one request: { path: boolean }, or null when the server cannot say.
export async function dataFilesExist(paths, { fetchFn = globalThis.fetch, headers = null } = {}) {
    const list = [...new Set((paths || []).filter(Boolean))];
    if (!list.length || typeof fetchFn !== 'function' || !headers) return null;
    try {
        const response = await fetchFn('/api/files/verify', { method: 'POST', headers, body: JSON.stringify({ urls: list }) });
        if (!response?.ok || typeof response.json !== 'function') return null;
        const result = await response.json();
        if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
        return Object.fromEntries(list.filter(path => typeof result[path] === 'boolean').map(path => [path, result[path]]));
    } catch {
        return null;
    }
}

/**
 * (cast portraits) Keeps a picture (a raster data URL) once, as its own user file named by its content, and returns the record
 * { path, type, hash } that names it; null when it is not a stored type, is too big, or the file could not be written (the caller then keeps
 * the picture as it always did). The file is asked about first (dataFileExists: no 404) and written only when absent; nothing is ever deleted.
 */
export async function savePortraitFile(dataUrl, { fetchFn = globalThis.fetch, headers = null } = {}) {
    const image = parseImageDataUrl(dataUrl);
    if (!image || typeof fetchFn !== 'function') return null;
    const record = portraitFileRecordFor(image.bytes, image.type);
    if (!record) return null;
    try {
        if (await dataFileExists(record.path, { fetchFn, headers: headers || null }) !== true) {
            const response = await fetchFn('/api/files/upload', {
                method: 'POST',
                headers: headers || {},
                body: JSON.stringify({ name: record.path.slice(record.path.lastIndexOf('/') + 1), data: image.base64 }),
            });
            if (!response?.ok) return null;
        }
    } catch {
        return null;
    }
    markPortraitFilePresent(record.path);
    return record;
}

/** (cast portraits) Asks the server which of these records' files are there and remembers the ones that are gone; returns how many are gone. */
export async function verifyPortraitFiles(portraits, { fetchFn = globalThis.fetch, headers = null } = {}) {
    const paths = [...new Set((portraits || []).filter(isPortraitFileRecord).map(portrait => portrait.path))];
    const answer = await dataFilesExist(paths, { fetchFn, headers });
    if (!answer) return 0;
    let gone = 0;
    for (const [path, exists] of Object.entries(answer)) {
        if (exists) markPortraitFilePresent(path);
        else { markPortraitFileMissing(path); gone += 1; }
    }
    return gone;
}

/** (cast portraits) The picture of a file-form record as a data URL (an export carries it), or null when the file is gone or is not the record's bytes. */
export async function readPortraitFileDataUrl(portrait, { fetchFn = globalThis.fetch } = {}) {
    if (!isPortraitFileRecord(portrait) || typeof fetchFn !== 'function') return null;
    try {
        const response = await fetchFn(portrait.path, { cache: 'no-store' });
        if (response?.status === 404 || !response?.ok || typeof response.arrayBuffer !== 'function') return null;
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!bytes.length) return null;
        const record = portraitFileRecordFor(bytes, portrait.type);
        return record?.hash === portrait.hash ? dataUrlOfBytes(bytes, portrait.type) : null;
    } catch {
        return null;
    }
}

export async function deleteNpcStateDataFile(pointer, { fetchFn = globalThis.fetch, headers = {} } = {}) {
    if (!pointer?.path) return false;
    if (typeof fetchFn !== 'function') throw new Error('fetch() is unavailable for NPC State Delta data-file persistence.');
    const response = await fetchFn('/api/files/delete', {
        method: 'POST',
        headers,
        body: JSON.stringify({ path: pointer.path }),
    });
    if (response?.status === 404) return false;
    if (!response?.ok) {
        const detail = typeof response?.text === 'function' ? await response.text() : '';
        throw new Error(`NPC State Delta data file delete failed${detail ? `: ${detail}` : ''}.`);
    }
    return true;
}
