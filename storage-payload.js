/* NPC State Delta sidecar payload format: format markers, base64 encoding, retained portrait-asset
   pruning, compact state preparation and JSON encode/decode. Moved unchanged out of storage.js;
   storage.js re-exports every public name it exported before. Never imports storage.js. */
import { isPortraitFileRecord } from './src/portrait-file.js';
import { lineageCheckpointKeys } from './branch-lineage.js';
import { packCheckpoints, unpackCheckpoints } from './checkpoint-pack.js';

export const NPC_STATE_FILE_FORMAT = 'npc_state_delta_chat_data';
// Format 2 packs state.checkpoints on disk only (checkpoint-pack.js); the in-memory state is unchanged. Format 1 is still read, and is
// written when packing fails (the escape hatch) and by retired markers. An older build refuses a version it does not know.
export const NPC_STATE_FILE_FORMAT_VERSION = 2;
export const LEGACY_FORMAT_VERSION = 1;
export const NPC_STATE_FILE_READ_VERSIONS = Object.freeze([1, 2]);

// One String.fromCharCode call per 32 KB chunk (as vault.js and portrait-file.js do): building each chunk a
// character at a time cost hundreds of milliseconds per save of a large sidecar on the main thread.
export function bytesToBase64(bytes) {
    const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const chunkSize = 0x8000;
    const parts = [];
    for (let i = 0; i < input.length; i += chunkSize) {
        parts.push(String.fromCharCode.apply(null, input.subarray(i, Math.min(i + chunkSize, input.length))));
    }
    return globalThis.btoa(parts.join(''));
}

export function retainedPortraitAssetIds(state = {}) {
    const retained = new Set();
    const addNpcs = value => {
        for (const npc of Array.isArray(value) ? value : []) {
            const id = String(npc?.id || '').trim();
            if (id) retained.add(id);
        }
    };
    addNpcs(state.npcs);
    for (const checkpoint of Array.isArray(state.checkpoints) ? state.checkpoints : []) addNpcs(checkpoint?.snapshot?.npcs);
    addNpcs(state.branchRootSnapshot?.npcs);
    // The reversible rollback journal can be the only remaining proof that an NPC
    // existed before a deep tail deletion once byte-budgeted full checkpoints have
    // been pruned. Keep that NPC's portrait asset reachable until the journal entry
    // itself expires; the journal stores no portrait binary.
    for (const entry of Array.isArray(state.rollbackJournal) ? state.rollbackJournal : []) {
        const npcUndo = entry?.undo?.npcs;
        addNpcs(npcUndo?.full);
        for (const change of Array.isArray(npcUndo?.changes) ? npcUndo.changes : []) {
            if (change?.restore && typeof change.restore === 'object') addNpcs([change.restore]);
        }
    }
    const blocked = new Set((Array.isArray(state.userDismissedGroups) ? state.userDismissedGroups : [])
        .flatMap(group => [...(Array.isArray(group?.ids) ? group.ids : []), group?.npcId])
        .map(value => String(value || '').trim()).filter(Boolean));
    for (const id of blocked) retained.delete(id);
    return retained;
}

export function prunePortraitAssetsForState(state = {}) {
    const assets = state?.portraitAssets && typeof state.portraitAssets === 'object' ? state.portraitAssets : {};
    const retained = retainedPortraitAssetIds(state);
    return Object.fromEntries(Object.entries(assets).filter(([id, portrait]) => retained.has(String(id)) && portrait?.dataUrl));
}

// Form portraits share the main portrait retention rule: they stay while any live, checkpointed
// or journal-restorable record of that NPC can still show them.
export function pruneFormPortraitAssetsForState(state = {}) {
    const assets = state?.formPortraitAssets && typeof state.formPortraitAssets === 'object' ? state.formPortraitAssets : {};
    const retained = retainedPortraitAssetIds(state);
    const out = {};
    for (const [id, forms] of Object.entries(assets)) {
        if (!retained.has(String(id)) || !forms || typeof forms !== 'object') continue;
        const kept = Object.entries(forms).filter(([, portrait]) => portrait?.dataUrl).slice(0, 8);
        if (kept.length) out[id] = Object.fromEntries(kept);
    }
    return out;
}

export function prunePortraitAssetsInPlace(state = {}) {
    if (!state || typeof state !== 'object') return state;
    state.portraitAssets = prunePortraitAssetsForState(state);
    if (state.formPortraitAssets && typeof state.formPortraitAssets === 'object') state.formPortraitAssets = pruneFormPortraitAssetsForState(state);
    return state;
}

function compactStateForFile(state) {
    const snapshot = structuredClone(state || {});
    snapshot.portraitAssets = prunePortraitAssetsForState(snapshot);
    snapshot.formPortraitAssets = pruneFormPortraitAssetsForState(snapshot);
    for (const npc of Array.isArray(snapshot.npcs) ? snapshot.npcs : []) {
        if (!npc?.id) continue;
        if (npc.portrait?.dataUrl) snapshot.portraitAssets[npc.id] = structuredClone(npc.portrait);
        if (snapshot.portraitAssets[npc.id]?.dataUrl && !(isPortraitFileRecord(npc.portrait) && !npc.portrait.dataUrl)) npc.portrait = null;
    }
    return snapshot;
}

// Packing is the last step (after compactStateForFile), so portrait retention above still sees full snapshots. Any packing error
// writes the whole payload as format 1 with full checkpoints. `packing` sits before `state` so decodeStateFileHead still works.
// The pack memo (unchanged snapshot pairs skip the diff and its check) is kept for the last two chats only; one generation each.
const packMemos = new Map();
function packedStateForFile(snapshot, chatKey) {
    if (!Array.isArray(snapshot.checkpoints)) return null;
    try {
        const memo = packMemos.get(chatKey) || null;
        const { entries, packing, memo: next } = packCheckpoints(snapshot.checkpoints, { activeKeys: lineageCheckpointKeys(snapshot.lineage), memo });
        packMemos.delete(chatKey);
        packMemos.set(chatKey, next);
        if (packMemos.size > 2) packMemos.delete(packMemos.keys().next().value);
        return { packing, state: { ...snapshot, checkpoints: entries } };
    } catch { packMemos.delete(chatKey); return null; }
}

export function encodeStateFilePayload(chatKey, state, appVersion = '', metadata = {}, writerId = '') {
    const snapshot = compactStateForFile(state);
    const packed = packedStateForFile(snapshot, String(chatKey || ''));
    const payload = {
        format: NPC_STATE_FILE_FORMAT,
        formatVersion: packed ? NPC_STATE_FILE_FORMAT_VERSION : LEGACY_FORMAT_VERSION,
        appVersion: String(appVersion || ''),
        chatKey: String(chatKey || ''),
        updatedAt: String(metadata?.updatedAt || new Date().toISOString()),
        revision: Math.max(0, Math.trunc(Number(metadata?.revision) || 0)),
        writerId: String(metadata?.writerId || writerId),
        ...(packed ? { packing: packed.packing } : {}),
        state: packed ? packed.state : snapshot,
    };
    return JSON.stringify(payload);
}

export function encodeRetiredStateFilePayload(chatKey, reason = 'retired', appVersion = '', metadata = {}, writerId = '') {
    return JSON.stringify({
        format: NPC_STATE_FILE_FORMAT,
        formatVersion: LEGACY_FORMAT_VERSION,
        appVersion: String(appVersion || ''),
        chatKey: String(chatKey || ''),
        updatedAt: new Date().toISOString(),
        revision: Math.max(0, Math.trunc(Number(metadata?.revision) || 0)),
        writerId: String(metadata?.writerId || writerId),
        retired: true,
        retiredAt: new Date().toISOString(),
        retireReason: String(reason || 'retired').slice(0, 120),
        // A Detach marker names the verified copy of the bytes it replaced, so any session that
        // later finds the marker can register that backup instead of the empty marker.
        ...(metadata?.recoveryPath ? { recoveryPath: String(metadata.recoveryPath), recoveryName: String(metadata.recoveryName || '') } : {}),
        state: {},
    }, null, 2);
}

export function decodeStateFilePayload(text) {
    let payload;
    try { payload = JSON.parse(String(text ?? '')); }
    catch { throw new Error('NPC State Delta data file contains invalid JSON.'); }
    if (!payload || payload.format !== NPC_STATE_FILE_FORMAT) throw new Error('Not an NPC State Delta chat data file.');
    if (!NPC_STATE_FILE_READ_VERSIONS.includes(payload.formatVersion)) {
        // A coded, non-retryable error: storage.js must not loop on a file a newer build wrote.
        throw Object.assign(new Error(`Unsupported NPC State Delta data file version: ${payload.formatVersion} (saved by a newer NPC State Delta; update the extension).`), { code: 'NPC_STATE_UNSUPPORTED_FORMAT' });
    }
    if (!payload.state || typeof payload.state !== 'object' || Array.isArray(payload.state)) throw new Error('NPC State Delta data file is missing its state object.');
    if (payload.formatVersion === 2) {
        if (!payload.packing || typeof payload.packing !== 'object') throw new Error('NPC State Delta data file is missing its packing header.');
        if (Array.isArray(payload.state.checkpoints)) {
            try { payload.state.checkpoints = unpackCheckpoints(payload.state.checkpoints, payload.packing); }
            catch (error) { throw new Error(`NPC State Delta data file checkpoint history could not be rebuilt: ${error?.message || error}`); }
        }
        delete payload.packing;
    }
    payload.retired = payload.retired === true;
    payload.revision = Math.max(0, Math.trunc(Number(payload.revision) || 0));
    payload.writerId = String(payload.writerId || '');
    return payload;
}

// (inspection hot path) A boundary check wants only the revision, writer, chat key, time and retired flag. encodeStateFilePayload writes those
// scalar keys first and `state` last, and a quote inside a string value is always escaped, so the first `,"state":` is the real one: the head
// alone is parsed (a few hundred bytes) instead of the whole file (megabytes of checkpoints). Any file that does not look like that (older
// layout, pretty-printed, damaged) answers null and the caller decodes the whole file exactly as before. The state itself is not read here.
const HEAD_LIMIT = 4096;
export function decodeStateFileHead(text) {
    const raw = String(text ?? '');
    if (raw.charCodeAt(0) !== 123 || raw.charCodeAt(1) !== 34) return null;   // `{"`: compact JSON object
    const at = raw.indexOf(',"state":{');
    if (at < 1 || at > HEAD_LIMIT) return null;
    let head;
    try { head = JSON.parse(`${raw.slice(0, at)}}`); } catch { return null; }
    if (!head || head.format !== NPC_STATE_FILE_FORMAT || !NPC_STATE_FILE_READ_VERSIONS.includes(head.formatVersion)) return null;
    if (raw.charCodeAt(raw.length - 1) !== 125) return null;   // a cut-off file is decoded in full (and refused there)
    // A writer that adds `retired` after the state (another session's tool) is read by the full decode: one cheap scan, not a parse.
    if (raw.indexOf('"retired"', at) !== -1) return null;
    head.retired = head.retired === true;
    head.revision = Math.max(0, Math.trunc(Number(head.revision) || 0));
    head.writerId = String(head.writerId || '');
    return head;
}
