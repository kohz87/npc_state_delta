// Dossier field copies and portrait URL helpers for the Story Suite v2 adapter. A pure part of
// src/adapter/queries.js (same owner, moved without change); queries.js re-exports every public name it exported before.
import { DOSSIER_FIELDS } from '../fields/registry.js';
import { portraitFileSrc } from '../portrait-file.js';

const RELATIONSHIP_KEYS = ['trust', 'affection', 'desire', 'tension'];

// A JSON round trip: plain objects, arrays, strings, finite numbers, booleans and null only.
function plainCopy(value) {
    if (value === undefined) return undefined;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return undefined;
    }
}

/** One NPC record's dossier fields (DOSSIER_FIELDS) as a fresh plain copy. Missing fields are left out. */
export function dossierFields(npc, { customFieldNames } = {}) {
    if (!npc || typeof npc !== 'object') return null;
    const out = {};
    for (const field of DOSSIER_FIELDS) {
        if (field === 'customFields' && Array.isArray(customFieldNames)) {
            // (cleanup step 7) Only the configured custom fields, as the dossier and the injection show.
            const configured = customFieldNames.map(name => String(name ?? '').trim().toLowerCase()).filter(Boolean);
            const kept = Object.entries(npc.customFields && typeof npc.customFields === 'object' ? npc.customFields : {})
                .filter(([name]) => configured.includes(String(name).trim().toLowerCase()));
            if (kept.length) out.customFields = Object.fromEntries(kept.map(([name, value]) => [name, String(value ?? '')]));
            continue;
        }
        if (field === 'relationship') {
            const rel = npc.relationship && typeof npc.relationship === 'object' ? npc.relationship : null;
            if (rel) out.relationship = Object.fromEntries(RELATIONSHIP_KEYS.map(key => [key, Number.isFinite(Number(rel[key])) ? Number(rel[key]) : 0]));
            continue;
        }
        const value = plainCopy(npc[field]);
        if (value !== undefined) out[field] = value;
    }
    return out;
}

// ---- portraits (MODULES §F11: a companion or NPC's portrait comes from Delta) ----

// The raster image types Delta accepts for a portrait (index.js setNpcPortrait); compressed
// portraits are stored as data:image/webp.
const DATA_IMAGE = /^data:image\/(?:png|jpeg|jpg|webp|gif|avif|bmp);base64,[a-z0-9+/=]+$/i;
const URL_BASE = 'https://npc-state-delta.invalid/';

/**
 * `value` when it is safe to hand to another module as an image URL, else null: a data: URL of a
 * raster image, an https: URL, or a same-origin relative URL (a path, never `//host`). Anything
 * else (javascript:, http:, blob:, svg data, control characters) is null.
 */
export function safeImageUrl(value) {
    if (typeof value !== 'string') return null;
    const url = value.trim();
    if (!url || /[\u0000-\u001f\u007f\\]/.test(url)) return null;
    if (/^data:/i.test(url)) return DATA_IMAGE.test(url) ? url : null;
    let parsed;
    try {
        parsed = new URL(url, URL_BASE);
    } catch {
        return null;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return /^https:\/\//i.test(url) && parsed.protocol === 'https:' && parsed.hostname ? url : null;
    // A path on the page's own server (SillyTavern's /user/images/…), never `//host` or a bare ?query or #hash.
    return !/^[?#]/.test(url) && parsed.origin === new URL(URL_BASE).origin ? url : null;
}

/**
 * The portrait Delta shows for one NPC record, as its dossier and present cast do: the current
 * appearance form's own image when that form has one, else the main portrait. `formPortraits` is
 * Delta's { [form name]: { dataUrl } }. A safe URL (safeImageUrl) or null.
 */
export function portraitUrl(npc, formPortraits = {}) {
    if (!npc || typeof npc !== 'object') return null;
    const candidates = [];
    const form = typeof npc.currentForm === 'string' ? npc.currentForm.trim().toLocaleLowerCase() : '';
    if (form && formPortraits && typeof formPortraits === 'object') {
        const image = Object.entries(formPortraits).find(([name]) => String(name).trim().toLocaleLowerCase() === form)?.[1];
        if (image && typeof image === 'object') candidates.push(image.dataUrl);
    }
    const main = npc.portrait && typeof npc.portrait === 'object' ? npc.portrait : {};
    candidates.push(main.dataUrl, portraitFileSrc(main), main.url, main.src);
    for (const candidate of candidates) {
        const url = safeImageUrl(candidate);
        if (url) return url;
    }
    return null;
}

export { RELATIONSHIP_KEYS };
