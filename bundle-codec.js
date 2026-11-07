/* NPC State Delta native bundle codec: manifest framing, portrait binary encoding, and bundle decoding. */
import { formPortraitKey, isTerminalNpcDeath, normalizeFormPortraitAssets, normalizeName, normalizeNpcRecord, protectTerminalNpc } from './core.js';
import { normalizeSocialGraph, remapSocialGraphNpcIds } from './social.js';
import { LOCKED_FIELD_KEYS } from './src/dossier-edit.js';
import { portraitHasImage } from './src/portrait-file.js';

const MAGIC = new Uint8Array([0x4e, 0x50, 0x43, 0x53, 0x54, 0x42, 0x30, 0x31]); // NPCSTB01
const HEADER_SIZE = 12;
const FORMAT_VERSION = 1;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;

function toUint8Array(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new Error('NPC State Delta bundle must be binary data.');
}

function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
    return true;
}

function decodeBase64(text) {
    const clean = String(text || '').replace(/\s+/g, '');
    const binary = globalThis.atob(clean);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
}

function encodeBase64(bytes) {
    const input = toUint8Array(bytes);
    const chunk = 0x8000;
    let binary = '';
    for (let i = 0; i < input.length; i += chunk) {
        const slice = input.subarray(i, Math.min(i + chunk, input.length));
        let part = '';
        for (let j = 0; j < slice.length; j += 1) part += String.fromCharCode(slice[j]);
        binary += part;
    }
    return globalThis.btoa(binary);
}

export function dataUrlToBinary(dataUrl) {
    const match = String(dataUrl || '').match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/i);
    if (!match) throw new Error('Portrait data is not a valid data URL.');
    const mime = match[1] || 'application/octet-stream';
    const bytes = match[2]
        ? decodeBase64(match[3])
        : new TextEncoder().encode(decodeURIComponent(match[3]));
    return { mime, bytes };
}

export function binaryToDataUrl(bytes, mime = 'application/octet-stream') {
    return `data:${mime};base64,${encodeBase64(bytes)}`;
}

function cloneRecordForManifest(npc, binaryOffsetRef, imageParts) {
    const record = structuredClone(npc);
    const portrait = record.portrait;
    if (!portrait?.dataUrl) {
        if (portrait) delete portrait.dataUrl;
        return record;
    }

    const parsed = dataUrlToBinary(portrait.dataUrl);
    delete portrait.dataUrl;
    portrait.mime = portrait.mime || parsed.mime;
    portrait.binary = {
        offset: binaryOffsetRef.value,
        length: parsed.bytes.length,
    };
    binaryOffsetRef.value += parsed.bytes.length;
    imageParts.push(parsed.bytes);
    return record;
}

// Optional additive manifest section: one binary image per (NPC, appearance form). Readers that
// predate it ignore the key; the main portrait encoding above is unchanged.
function formPortraitsForManifest(source, npcs, binaryOffsetRef, imageParts) {
    const ids = new Set(npcs.map(npc => String(npc?.id || '')).filter(Boolean));
    const out = [];
    for (const [npcId, forms] of Object.entries(normalizeFormPortraitAssets(source.formPortraitAssets))) {
        if (!ids.has(npcId)) continue;
        for (const portrait of Object.values(forms)) {
            const record = cloneRecordForManifest({ portrait }, binaryOffsetRef, imageParts).portrait;
            if (record?.binary) out.push({ npcId, form: portrait.form, portrait: record });
        }
    }
    return out;
}

export function encodeNpcStateBundle(state, { appVersion = 'unknown', chatKey = '' } = {}) {
    const source = state && typeof state === 'object' ? state : {};
    const imageParts = [];
    const binaryOffsetRef = { value: 0 };
    const npcs = Array.isArray(source.npcs)
        ? source.npcs.map(npc => cloneRecordForManifest(npc, binaryOffsetRef, imageParts))
        : [];
    const formPortraits = formPortraitsForManifest(source, npcs, binaryOffsetRef, imageParts);

    const manifest = {
        format: 'npc_state_delta_bundle',
        formatVersion: FORMAT_VERSION,
        appVersion: String(appVersion || 'unknown'),
        exportedAt: new Date().toISOString(),
        sourceChatKey: String(chatKey || ''),
        state: {
            npcs,
            socialGraph: normalizeSocialGraph(source.socialGraph),
            dismissed: Array.isArray(source.dismissed) ? [...source.dismissed] : [],
            ...(formPortraits.length ? { formPortraits } : {}),
            // (timeline participant) The story line's np_ map travels with the dossiers it names.
            ...(source.timeline && typeof source.timeline === 'object' && !Array.isArray(source.timeline) ? { timeline: structuredClone(source.timeline) } : {}),
        },
    };

    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new Error('NPC State Delta bundle manifest is too large.');

    const totalBytes = HEADER_SIZE + manifestBytes.length + binaryOffsetRef.value;
    if (totalBytes > MAX_BUNDLE_BYTES) throw new Error('NPC State Delta bundle exceeds the 32 MB safety limit.');

    const output = new Uint8Array(totalBytes);
    output.set(MAGIC, 0);
    new DataView(output.buffer).setUint32(MAGIC.length, manifestBytes.length, true);
    output.set(manifestBytes, HEADER_SIZE);
    let cursor = HEADER_SIZE + manifestBytes.length;
    for (const part of imageParts) {
        output.set(part, cursor);
        cursor += part.length;
    }
    return output;
}

function validateManifest(manifest) {
    // Bound subsequent recursive cloning/scrubbing and reject prototype-shaped metadata
    // before any imported value reaches canonical object maps.
    const queue = [{ value: manifest, depth: 0 }];
    while (queue.length) {
        const { value, depth } = queue.pop();
        if (!value || typeof value !== 'object') continue;
        if (depth > 64) throw new Error('NPC State Delta bundle nesting exceeds the 64-level safety limit.');
        for (const [key, item] of Object.entries(value)) {
            if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('NPC State Delta bundle contains unsafe object metadata.');
            if (item && typeof item === 'object') queue.push({ value: item, depth: depth + 1 });
        }
    }
    if (!manifest || manifest.format !== 'npc_state_delta_bundle') throw new Error('Not an NPC State Delta bundle.');
    if (manifest.formatVersion !== FORMAT_VERSION) throw new Error(`Unsupported NPC State Delta bundle version: ${manifest.formatVersion}.`);
    if (!manifest.state || !Array.isArray(manifest.state.npcs)) throw new Error('NPC State Delta bundle is missing its dossier registry.');
    const ids = new Set();
    for (const npc of manifest.state.npcs) {
        if (!npc || typeof npc !== 'object' || Array.isArray(npc)) throw new Error('Every Delta dossier must be an object.');
        for (const key of ['id', 'name']) {
            if (key in npc && typeof npc[key] !== 'string') throw new Error(`Dossier ${key} must be text.`);
        }
        for (const key of ['relationship', 'relationshipProgress', 'portrait']) {
            const value = npc[key];
            if (value != null && (typeof value !== 'object' || Array.isArray(value))) throw new Error(`Dossier ${key} must be an object.`);
        }
        for (const key of ['relationship', 'relationshipProgress']) {
            for (const value of Object.values(npc[key] || {})) {
                if (!['number', 'string'].includes(typeof value) || !String(value).trim() || !Number.isFinite(Number(value))) {
                    throw new Error(`Dossier ${key} contains a non-numeric value.`);
                }
            }
        }
        const id = String(npc?.id || '').trim();
        if (['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error('NPC State Delta dossier id is reserved.');
        if (!id) continue;
        if (ids.has(id)) throw new Error(`NPC State Delta bundle contains duplicate NPC id: ${id}.`);
        ids.add(id);
    }
}

export function decodeNpcStateBundle(input) {
    const bytes = toUint8Array(input);
    if (bytes.length < HEADER_SIZE) throw new Error('NPC State Delta bundle is truncated.');
    if (bytes.length > MAX_BUNDLE_BYTES) throw new Error('NPC State Delta bundle exceeds the 32 MB safety limit.');
    if (!bytesEqual(bytes.subarray(0, MAGIC.length), MAGIC)) throw new Error('Invalid NPC State Delta bundle signature.');

    const manifestLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(MAGIC.length, true);
    if (!manifestLength || manifestLength > MAX_MANIFEST_BYTES) throw new Error('NPC State Delta bundle has an invalid manifest length.');
    const manifestStart = HEADER_SIZE;
    const binaryStart = manifestStart + manifestLength;
    if (binaryStart > bytes.length) throw new Error('NPC State Delta bundle manifest is truncated.');

    let manifest;
    try {
        manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(manifestStart, binaryStart)));
    } catch {
        throw new Error('NPC State Delta bundle manifest is invalid JSON.');
    }
    validateManifest(manifest);

    const portraitRanges = [];
    const npcs = manifest.state.npcs.map(npc => {
        const record = structuredClone(npc);
        const bin = record.portrait?.binary;
        if (!bin) return record;
        const offset = Number(bin.offset);
        const length = Number(bin.length);
        if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length <= 0) {
            throw new Error(`NPC State Delta bundle has invalid portrait metadata for ${record.name || 'an NPC'}.`);
        }
        const start = binaryStart + offset;
        const end = start + length;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || end > bytes.length) {
            throw new Error(`NPC State Delta bundle portrait is truncated for ${record.name || 'an NPC'}.`);
        }
        portraitRanges.push({ start, end, name: record.name || 'an NPC' });
        const mime = record.portrait.mime || 'application/octet-stream';
        record.portrait.dataUrl = binaryToDataUrl(bytes.subarray(start, end), mime);
        delete record.portrait.binary;
        return record;
    });
    const npcIds = new Set(npcs.map(npc => String(npc?.id || '')).filter(Boolean));
    const formPortraitAssets = {};
    const declaredForms = manifest.state.formPortraits;
    if (declaredForms !== undefined && !Array.isArray(declaredForms)) throw new Error('NPC State Delta bundle has invalid form portrait metadata.');
    for (const entry of Array.isArray(declaredForms) ? declaredForms : []) {
        const npcId = typeof entry?.npcId === 'string' ? entry.npcId : '';
        const form = typeof entry?.form === 'string' ? entry.form.trim().slice(0, 120) : '';
        const bin = entry?.portrait?.binary;
        const offset = Number(bin?.offset);
        const length = Number(bin?.length);
        if (!npcId || !form || !entry.portrait || typeof entry.portrait !== 'object' || Array.isArray(entry.portrait)
            || !Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length <= 0) {
            throw new Error('NPC State Delta bundle has invalid form portrait metadata.');
        }
        const start = binaryStart + offset;
        const end = start + length;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || end > bytes.length) {
            throw new Error(`NPC State Delta bundle form portrait is truncated for ${form}.`);
        }
        portraitRanges.push({ start, end, name: `${form} form portrait` });
        if (!npcIds.has(npcId)) continue;
        const portrait = structuredClone(entry.portrait);
        delete portrait.binary;
        portrait.dataUrl = binaryToDataUrl(bytes.subarray(start, end), portrait.mime || 'application/octet-stream');
        portrait.form = form;
        formPortraitAssets[npcId] = { ...(formPortraitAssets[npcId] || {}), [formPortraitKey(form)]: portrait };
    }
    portraitRanges.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < portraitRanges.length; i += 1) {
        if (portraitRanges[i].start < portraitRanges[i - 1].end) {
            throw new Error(`NPC State Delta bundle contains overlapping portrait data for ${portraitRanges[i].name}.`);
        }
    }

    return {
        metadata: {
            appVersion: manifest.appVersion || '',
            exportedAt: manifest.exportedAt || '',
            sourceChatKey: manifest.sourceChatKey || '',
            formatVersion: manifest.formatVersion,
        },
        state: {
            npcs,
            socialGraph: normalizeSocialGraph(manifest.state.socialGraph),
            dismissed: Array.isArray(manifest.state.dismissed) ? [...manifest.state.dismissed] : [],
            formPortraitAssets: normalizeFormPortraitAssets(formPortraitAssets),
            ...(manifest.state.timeline && typeof manifest.state.timeline === 'object' && !Array.isArray(manifest.state.timeline) ? { timeline: structuredClone(manifest.state.timeline) } : {}),
        },
    };
}
