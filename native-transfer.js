/* NPC State Delta native transfer envelope. Keeps the established binary codec and adds declared Stage 8 metadata. */
import { decodeNpcStateBundle, encodeNpcStateBundle } from './bundle.js';
import { PORTRAIT_STYLE_PROMPT_LIMIT, PORTRAIT_COMPOSITION_PROMPT_LIMIT } from './core-mechanics.js';

const MAGIC_BYTES = 8;
const HEADER_BYTES = 12;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_NATIVE_BYTES = 32 * 1024 * 1024;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const PORTABLE_SETTING_SCHEMA = Object.freeze({
    portraitGenerationEnabled: { type: 'boolean' },
    portraitThemePreset: { type: 'string', max: 80 },
    portraitStylePositive: { type: 'string', max: PORTRAIT_STYLE_PROMPT_LIMIT },
    portraitStyleNegative: { type: 'string', max: PORTRAIT_STYLE_PROMPT_LIMIT },
    portraitComposition: { type: 'string', max: PORTRAIT_COMPOSITION_PROMPT_LIMIT },
    portraitPromptFormat: { type: 'string', max: 40 },
    portraitUseMood: { type: 'boolean' },
    portraitUseLocation: { type: 'boolean' },
    portraitSaveToGallery: { type: 'boolean' },
});
const DECLARED_BOOLEAN_FIELDS = Object.freeze([
    'dossiers', 'portraits', 'socialGraph', 'dismissedIdentitySuppression',
    'portablePortraitSettings', 'sourceHistoryAudit',
]);

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
function validateDeclaredContents(value) {
    if (value === undefined) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('NPC State Delta native bundle has invalid declared-contents metadata.');
    for (const field of DECLARED_BOOLEAN_FIELDS) {
        if (field in value && typeof value[field] !== 'boolean') throw new Error(`NPC State Delta native bundle has invalid declared field ${field}.`);
    }
    if ('historyRestorePolicy' in value && value.historyRestorePolicy !== 'target-safe-baseline') {
        throw new Error(`NPC State Delta native bundle requests unsupported history restore policy: ${String(value.historyRestorePolicy || 'empty')}.`);
    }
    return structuredClone(value);
}
function validatePortableSettings(value) {
    if (value === undefined) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('NPC State Delta native bundle has invalid portable settings.');
    const output = {};
    for (const [key, item] of Object.entries(value)) {
        const rule = Object.hasOwn(PORTABLE_SETTING_SCHEMA, key) ? PORTABLE_SETTING_SCHEMA[key] : null;
        if (!rule) throw new Error(`NPC State Delta native bundle contains unsupported portable setting: ${key}.`);
        if (rule.type === 'boolean') {
            if (typeof item !== 'boolean') throw new Error(`NPC State Delta native portable setting ${key} must be boolean.`);
            output[key] = item;
            continue;
        }
        if (typeof item !== 'string' || item.length > rule.max) throw new Error(`NPC State Delta native portable setting ${key} is invalid or exceeds ${rule.max} characters.`);
        output[key] = item;
    }
    return output;
}
function validateHistoryArchive(value) {
    if (value === undefined) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('NPC State Delta native bundle has invalid source-history metadata.');
    if (value.policy !== 'audit-only-source-history') throw new Error('NPC State Delta native bundle declares an unsupported source-history policy.');
    for (const field of ['lineage', 'checkpoints', 'inlineCards']) {
        if (field in value && !Array.isArray(value[field])) throw new Error(`NPC State Delta native history field ${field} must be an array.`);
    }
    if ('branchRootSnapshot' in value && value.branchRootSnapshot !== null && (typeof value.branchRootSnapshot !== 'object' || Array.isArray(value.branchRootSnapshot))) {
        throw new Error('NPC State Delta native branchRootSnapshot is invalid.');
    }
    if ('truncated' in value && typeof value.truncated !== 'boolean') throw new Error('NPC State Delta native history truncated flag must be boolean.');
    return structuredClone(value);
}

export function buildHistoryArchive(state = {}) {
    return withoutPortraitPayload({
        policy: 'audit-only-source-history',
        turn: Number(state.turn || 0),
        lastScannedMessageId: Number.isInteger(state.lastScannedMessageId) ? state.lastScannedMessageId : null,
        lineage: Array.isArray(state.lineage) ? state.lineage : [],
        checkpoints: Array.isArray(state.checkpoints) ? state.checkpoints : [],
        branchLineageVersion: Number(state.branchLineageVersion || 0),
        branchParent: state.branchParent && typeof state.branchParent === 'object' ? state.branchParent : null,
        branchForkMessageId: Number.isInteger(state.branchForkMessageId) ? state.branchForkMessageId : null,
        branchRootSnapshot: state.branchRootSnapshot && typeof state.branchRootSnapshot === 'object' ? state.branchRootSnapshot : null,
        inlineCards: Array.isArray(state.inlineCards) ? state.inlineCards : [],
    });
}

function compactHistoryArchive(historyArchive) {
    const checked = validateHistoryArchive(historyArchive);
    if (!checked) return null;
    return {
        policy: 'audit-only-source-history',
        turn: Number(checked.turn || 0),
        lastScannedMessageId: Number.isInteger(checked.lastScannedMessageId) ? checked.lastScannedMessageId : null,
        lineage: [],
        checkpoints: [],
        branchLineageVersion: Number(checked.branchLineageVersion || 0),
        branchParent: null,
        branchForkMessageId: Number.isInteger(checked.branchForkMessageId) ? checked.branchForkMessageId : null,
        branchRootSnapshot: null,
        inlineCards: [],
        truncated: true,
        truncationReason: 'export-size-limit',
        omittedCounts: {
            lineage: Array.isArray(checked.lineage) ? checked.lineage.length : 0,
            checkpoints: Array.isArray(checked.checkpoints) ? checked.checkpoints.length : 0,
            inlineCards: Array.isArray(checked.inlineCards) ? checked.inlineCards.length : 0,
            branchRootSnapshot: checked.branchRootSnapshot ? 1 : 0,
        },
    };
}
function writeOptionalManifestFields(manifest, checkedSettings, checkedHistory) {
    manifest.declaredContents = {
        dossiers: true,
        portraits: true,
        socialGraph: true,
        dismissedIdentitySuppression: true,
        portablePortraitSettings: Boolean(checkedSettings),
        sourceHistoryAudit: Boolean(checkedHistory),
        historyRestorePolicy: 'target-safe-baseline',
    };
    if (checkedSettings) manifest.portableSettings = checkedSettings;
    else delete manifest.portableSettings;
    if (checkedHistory) manifest.historyArchive = checkedHistory;
    else delete manifest.historyArchive;
}
function encodeAugmentedEnvelope(value, manifest, binary) {
    const manifestBytes = textEncoder.encode(JSON.stringify(manifest));
    const total = HEADER_BYTES + manifestBytes.length + binary.length;
    return { manifestBytes, total, build() {
        const output = new Uint8Array(total);
        output.set(value.subarray(0, MAGIC_BYTES), 0);
        new DataView(output.buffer).setUint32(MAGIC_BYTES, manifestBytes.length, true);
        output.set(manifestBytes, HEADER_BYTES);
        output.set(binary, HEADER_BYTES + manifestBytes.length);
        return output;
    } };
}

export function augmentNativeBundle(input, { portableSettings = null, historyArchive = null } = {}) {
    const { value, manifest, binary } = parseEnvelope(input);
    decodeNpcStateBundle(value);
    const checkedSettings = portableSettings === null ? null : validatePortableSettings(portableSettings);
    const checkedHistory = historyArchive === null ? null : validateHistoryArchive(historyArchive);
    const historyCandidates = checkedHistory
        ? [checkedHistory, compactHistoryArchive(checkedHistory), null]
        : [null];
    let lastManifestBytes = 0;
    let lastTotal = 0;
    for (const candidate of historyCandidates) {
        writeOptionalManifestFields(manifest, checkedSettings, candidate);
        const encoded = encodeAugmentedEnvelope(value, manifest, binary);
        lastManifestBytes = encoded.manifestBytes.length;
        lastTotal = encoded.total;
        if (lastManifestBytes <= MAX_MANIFEST_BYTES && lastTotal <= MAX_NATIVE_BYTES) return encoded.build();
    }
    if (lastManifestBytes > MAX_MANIFEST_BYTES) throw new Error('NPC State Delta native bundle manifest exceeds the 2 MB safety limit even without source-history audit data.');
    throw new Error('NPC State Delta native bundle exceeds the 32 MB safety limit even without source-history audit data.');
}

export function decodeDeltaNativeBundle(input) {
    const canonical = decodeNpcStateBundle(input);
    const { manifest } = parseEnvelope(input);
    const declaredContents = validateDeclaredContents(manifest.declaredContents);
    const portableSettings = validatePortableSettings(manifest.portableSettings);
    const historyArchive = validateHistoryArchive(manifest.historyArchive);
    if (declaredContents?.portablePortraitSettings === true && !portableSettings) throw new Error('NPC State Delta native bundle declares portable portrait settings but does not contain them.');
    if (declaredContents?.sourceHistoryAudit === true && !historyArchive) throw new Error('NPC State Delta native bundle declares source history but does not contain it.');
    return { ...canonical, declaredContents, portableSettings, historyArchive };
}

function scrubSourceMessageOwnership(value) {
    if (Array.isArray(value)) return value.map(scrubSourceMessageOwnership);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
        const normalizedKey = String(key || '').replace(/_/g, '').toLowerCase();
        if (['speechdevelopment', 'personalitydevelopment'].includes(normalizedKey)
            && item && typeof item === 'object' && !Array.isArray(item)) {
            const ledger = scrubSourceMessageOwnership(item);
            // Pending durable-profile observations are chronological source-chat evidence,
            // not portable characterization. Keep the accepted epoch/baseline text but rebase
            // pending Personality/Speech provenance onto the target chat's safe history baseline.
            out[key] = { ...ledger, baselineTurn: null, baselineSourceMessageId: null, concepts: [] };
            continue;
        }
        if (/^(?:.*SourceMessageIds?|requestedMessageId|restoredFromMessageId)$/i.test(key)) {
            out[key] = Array.isArray(item) ? [] : null;
        } else out[key] = scrubSourceMessageOwnership(item);
    }
    return out;
}

export function nativeStateForTarget(decoded, targetChatKey) {
    const target = String(targetChatKey || '').trim();
    if (!target || target === 'no-chat') throw new Error('Open the target chat before importing NPC State Delta data.');
    return decoded.metadata.sourceChatKey !== target ? scrubSourceMessageOwnership(decoded.state) : decoded.state;
}

export function prepareNativeImport(input, targetChatKey) {
    const decoded = decodeDeltaNativeBundle(input);
    const target = String(targetChatKey || '').trim();
    if (!target || target === 'no-chat') throw new Error('Open the target chat before importing NPC State Delta data.');
    const foreignOwnership = decoded.metadata.sourceChatKey !== target;
    const safeState = nativeStateForTarget(decoded, target);
    const base = encodeNpcStateBundle(safeState, {
        appVersion: decoded.metadata.appVersion || 'unknown',
        // Preserve the declared source identity until the canonical importer applies the
        // prepared bundle. Re-labeling it as the target here would erase the proof that
        // activity counters and other chronology came from a different chat.
        chatKey: decoded.metadata.sourceChatKey || target,
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
