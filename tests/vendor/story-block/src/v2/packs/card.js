// What a character card carries besides its pack: the two formats of its other tagged lorebook entries (pure).
//
// `[storysuite:portraits]`: `{ "v": 1, "pack": "<pack id>", "version": "<pack version>", "files": { "<file name>": "data:image/webp;base64,…" } }`
// `[storysuite:settings]`:  `{ "v": 1, "settings": { "<owner>.<key>": value } }`
//
// Both are read as data and checked before anything is offered: a rejected entry, a skipped picture and a skipped key each give one
// plain line (`lines`) for Diagnostics, so an author can see why something was not offered. Nothing here installs or writes anything.

import { sniffImage } from './portraits.js';

export const CARD_LIMITS = Object.freeze({
    files: 24,                      // pictures in one portraits entry
    fileBytes: 200 * 1024,          // one picture, decoded
    totalBytes: 3 * 1024 * 1024,    // all pictures, decoded
});

/** The settings a card may recommend. The list grows only with a release. */
export const CARD_SETTING_KEYS = Object.freeze([
    'story-block.rpg', 'story-block.gear', 'story-block.rpgXpRate',
    'npc-state-delta.portraitPromptFormat', 'npc-state-delta.scanEvery',
]);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const TYPES = Object.freeze({ webp: 'webp', png: 'png', jpg: 'jpg', jpeg: 'jpg' });
const DATA_URI = /^data:image\/(webp|png|jpe?g);base64,([A-Za-z0-9+/]+={0,2})$/i;

const parse = text => {
    try {
        return JSON.parse(String(text ?? '').replace(/^﻿/, ''));
    } catch {
        return undefined;
    }
};

const bytesOf = b64 => {
    const raw = atob(b64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
};

const kb = bytes => `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** The pack id a portraits entry says it is for, or null when the entry is not readable JSON with one. */
export function portraitsPackOf(text) {
    const data = parse(text);
    return isObject(data) && typeof data.pack === 'string' ? data.pack : null;
}

/**
 * The portraits entry's text, checked against the pack it is for (a normalized pack: id, version, content.cast).
 * → `{ ok: true, files: [{ name, size, read() }], lines }` or `{ ok: false, files: [], lines }`; `lines` are Diagnostics lines (skipped
 * pictures on a good entry, the reason on a rejected one). `files` are what installed.js `install` takes as `files`.
 */
export function readPortraitsEntry(text, pack, { limits = CARD_LIMITS } = {}) {
    const lines = [];
    const refuse = message => ({ ok: false, files: [], lines: [`Card portraits for ${pack?.id ?? '?'} were not used: ${message}`] });
    const data = parse(text);
    if (!isObject(data)) return refuse('the entry is not JSON.');
    if (data.v !== 1) return refuse('its "v" is not 1.');
    if (data.pack !== pack.id) return refuse(`they are for the pack "${String(data.pack).slice(0, 60)}", not "${pack.id}".`);
    if (data.version !== pack.version) return refuse(`they are for version ${String(data.version).slice(0, 30)} and the pack is ${pack.version}.`);
    if (!isObject(data.files)) return refuse('"files" is missing.');
    const names = Object.keys(data.files);
    if (names.length > limits.files) return refuse(`there are ${names.length} pictures; at most ${limits.files}.`);
    const named = new Set((pack.content?.cast ?? []).map(person => person.portrait).filter(Boolean));
    const files = [];
    let total = 0;
    for (const name of names) {
        const skip = message => lines.push(`Card portrait ${name.slice(0, 80)} skipped: ${message}`);
        if (!named.has(name)) { skip('no cast member of the pack names that file.'); continue; }
        const given = data.files[name];
        // The size is read from the text's length, before anything is decoded or matched: a huge entry costs nothing to refuse.
        if (typeof given === 'string' && given.length > Math.ceil(limits.fileBytes * 4 / 3) + 64) { skip(`it is about ${kb(Math.floor(given.length * 3 / 4))}; at most ${kb(limits.fileBytes)}.`); continue; }
        const found = typeof given === 'string' ? DATA_URI.exec(given) : null;
        if (!found) { skip('it is not a base64 data: address of a webp, png or jpeg picture.'); continue; }
        // (the encoded length is held to the limit again here, with the data: prefix off)
        const decoded = Math.floor(found[2].length * 3 / 4) - (found[2].match(/=+$/)?.[0].length ?? 0);
        if (decoded > limits.fileBytes) { skip(`it is ${kb(decoded)}; at most ${kb(limits.fileBytes)}.`); continue; }
        let bytes;
        try { bytes = bytesOf(found[2]); } catch { skip('its base64 could not be read.'); continue; }
        if (bytes.length > limits.fileBytes) { skip(`it is ${kb(bytes.length)}; at most ${kb(limits.fileBytes)}.`); continue; }
        const type = sniffImage(bytes);
        if (!type) { skip('its bytes are not a webp, png or jpeg picture.'); continue; }
        if (TYPES[found[1].toLowerCase()] !== type) { skip('its bytes are not the type its address says.'); continue; }
        total += bytes.length;
        if (total > limits.totalBytes) return refuse(`the pictures are more than ${kb(limits.totalBytes)} together.`);
        files.push({ name, size: bytes.length, read: async () => bytes.slice() });
    }
    return { ok: true, files, lines };
}

/**
 * The settings entry's text → `{ ok: true, values: { 'owner.key': value }, lines }` or `{ ok: false, values: {}, lines }`. Keys that are
 * not on the allow-list are skipped with a line; whether a value fits is for the owner that registered the key (card-settings.js).
 */
export function readSettingsEntry(text) {
    const lines = [];
    const refuse = message => ({ ok: false, values: {}, lines: [`The card's recommended settings were not used: ${message}`] });
    const data = parse(text);
    if (!isObject(data)) return refuse('the entry is not JSON.');
    if (data.v !== 1) return refuse('its "v" is not 1.');
    if (!isObject(data.settings)) return refuse('"settings" is missing.');
    const values = {};
    for (const [key, value] of Object.entries(data.settings)) {
        if (!CARD_SETTING_KEYS.includes(key)) { lines.push(`Card setting ${key.slice(0, 80)} skipped: it is not one a card may recommend.`); continue; }
        values[key] = value;
    }
    return { ok: true, values, lines };
}
