/* NPC State Delta native transfer envelope. Keeps the established binary codec and adds declared Stage 8 metadata. */
import { decodeNpcStateBundle, encodeNpcStateBundle } from './bundle.js';

const MAGIC_BYTES = 8;
const HEADER_BYTES = 12;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_NATIVE_BYTES = 32 * 1024 * 1024;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function bytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new Error('NPC State Delta native import must be binary data.');
}
function parseEnvelope(input) {
    const value = bytes(input);
    if (value.byteLength < HEADER_BYTES) throw new Error('NPC State Delta bundle is truncated.');
    const manifestLength = new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(MAGIC_BYTES, true);
    const binaryStart = HEADER_BYTES + manifestLength;
    if (!manifestLength || manifestLength > MAX_MANIFEST_BYTES || binaryStart > value.byteLength) throw new Error('NPC State Delta bundle manifest is truncated or exceeds the 2 MB safety limit.');
    let manifest;
    try { manifest = JSON.parse(textDecoder.decode(value.subarray(HEADER_BYTES, binaryStart))); }
    catch { throw new Error('NPC State Delta bundle manifest is invalid JSON.'); }
    return { value, manifest, binaryStart, binary: value.subarray(binaryStart) };
}
function withoutPortraitPayload(value) {
    if (Array.isArray(value)) return value.map(withoutPortraitPayload);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
        if (key === 'portraitAssets') continue;
        if (key === 'portrait' && item && typeof item === 'object') {
            out[key] = { ...item };
            delete out[key].dataUrl;
            continue;
        }
        out[key] = withoutPortraitPayload(item);
    }
    return out;
}

export function buildHistoryArchive(state = {}) {
    return withoutPortraitPayload({
        policy: 'audit-only-source-history',
        turn: Number(state.turn || 0),
        lastScannedMessageId: Number.isInteger(state.lastScannedMessageId) ? state.lastScannedMessageId : null,
        lineage: Array.isArray(state.lineage) ? structuredClone(state.lineage) : [],
        checkpoints: Array.isArray(state.checkpoints) ? structuredClone(state.checkpoints) : [],
        branchLineageVersion: Number(state.branchLineageVersion || 0),
        branchParent: state.branchParent && typeof state.branchParent === 'object' ? structuredClone(state.branchParent) : null,
        branchForkMessageId: Number.isInteger(state.branchForkMessageId) ? state.branchForkMessageId : null,
        branchRootSnapshot: state.branchRootSnapshot && typeof state.branchRootSnapshot === 'object' ? structuredClone(state.branchRootSnapshot) : null,
        inlineCards: Array.isArray(state.inlineCards) ? structuredClone(state.inlineCards) : [],
    });
}

export function augmentNativeBundle(input, { portableSettings = null, historyArchive = null } = {}) {
    const { value, manifest, binary } = parseEnvelope(input);
    // Run the canonical decoder first so malformed/foreign bundles fail before metadata is added.
    decodeNpcStateBundle(value);
    manifest.declaredContents = {
        dossiers: true,
        portraits: true,
        socialGraph: true,
        dismissedIdentitySuppression: true,
        portablePortraitSettings: Boolean(portableSettings),
        sourceHistoryAudit: Boolean(historyArchive),
        historyRestorePolicy: 'target-safe-baseline',
    };
    if (portableSettings && typeof portableSettings === 'object') manifest.portableSettings = structuredClone(portableSettings);
    else delete manifest.portableSettings;
    if (historyArchive && typeof historyArchive === 'object') manifest.historyArchive = structuredClone(historyArchive);
    else delete manifest.historyArchive;
    const manifestBytes = textEncoder.encode(JSON.stringify(manifest));
    if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new Error('NPC State Delta native source-history metadata exceeds the 2 MB manifest safety limit. Reduce retained chat history before exporting.');
    const total = HEADER_BYTES + manifestBytes.length + binary.length;
    if (total > MAX_NATIVE_BYTES) throw new Error('NPC State Delta native bundle exceeds the 32 MB safety limit after adding source history.');
    const output = new Uint8Array(total);
    output.set(value.subarray(0, MAGIC_BYTES), 0);
    new DataView(output.buffer).setUint32(MAGIC_BYTES, manifestBytes.length, true);
    output.set(manifestBytes, HEADER_BYTES);
    output.set(binary, HEADER_BYTES + manifestBytes.length);
    return output;
}

export function decodeDeltaNativeBundle(input) {
    const canonical = decodeNpcStateBundle(input);
    const { manifest } = parseEnvelope(input);
    const declared = manifest.declaredContents;
    if (declared !== undefined && (!declared || typeof declared !== 'object' || Array.isArray(declared))) {
        throw new Error('NPC State Delta native bundle has invalid declared-contents metadata.');
    }
    const portableSettings = manifest.portableSettings;
    if (portableSettings !== undefined && (!portableSettings || typeof portableSettings !== 'object' || Array.isArray(portableSettings))) {
        throw new Error('NPC State Delta native bundle has invalid portable settings.');
    }
    const historyArchive = manifest.historyArchive;
    if (historyArchive !== undefined && (!historyArchive || typeof historyArchive !== 'object' || Array.isArray(historyArchive))) {
        throw new Error('NPC State Delta native bundle has invalid source-history metadata.');
    }
    return {
        ...canonical,
        declaredContents: declared ? structuredClone(declared) : null,
        portableSettings: portableSettings ? structuredClone(portableSettings) : null,
        historyArchive: historyArchive ? structuredClone(historyArchive) : null,
    };
}

function scrubSourceMessageOwnership(value) {
    if (Array.isArray(value)) return value.map(scrubSourceMessageOwnership);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
        if (/^(?:sourceMessageId|archiveSourceMessageId|requestedMessageId)$/i.test(key)) out[key] = null;
        else out[key] = scrubSourceMessageOwnership(item);
    }
    return out;
}

export function prepareNativeImport(input, targetChatKey) {
    const decoded = decodeDeltaNativeBundle(input);
    const target = String(targetChatKey || '').trim();
    if (!target || target === 'no-chat') throw new Error('Open the target chat before importing NPC State Delta data.');
    const foreignOwnership = Boolean(decoded.metadata.sourceChatKey && decoded.metadata.sourceChatKey !== target);
    const safeState = foreignOwnership ? scrubSourceMessageOwnership(decoded.state) : structuredClone(decoded.state);
    const base = encodeNpcStateBundle(safeState, {
        appVersion: decoded.metadata.appVersion || 'unknown',
        chatKey: target,
    });
    const importBytes = augmentNativeBundle(base, {
        portableSettings: decoded.portableSettings,
        historyArchive: decoded.historyArchive,
    });
    return {
        decoded,
        importBytes,
        ownershipPolicy: foreignOwnership ? 'source-message ownership cleared; target history baseline retained' : 'same-chat ownership retained by canonical importer',
        historyPolicy: decoded.historyArchive ? 'source history included for audit only; target checkpoints/lineage are not replaced' : 'no source history archive declared; target checkpoints/lineage are not replaced',
    };
}
