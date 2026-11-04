// The only part of packs that touches SillyTavern. Everything is read when called, never at
// import, so the rest of the part (and its tests) loads without SillyTavern.
//
// What it uses of `SillyTavern.getContext()`: `extensionSettings` and `saveSettingsDebounced`
// (the installed list), `characters` and `characterId` (the open card), and `loadWorldInfo`
// (the card's linked lorebook). A card whose lorebook was never imported still carries it
// embedded as `data.character_book`; that copy is read when no lorebook is linked, and its [storysuite:…] entries also when the linked
// one lacks them or cannot be loaded.

import { entryText, isPackTitle, isPortraitsTitle, isSettingsTitle } from './lorebook.js';
import { compareVersions, parseVersion } from './version.js';

const context = () => globalThis.SillyTavern?.getContext?.() ?? null;

// Without SillyTavern (tests, a page without the host) the list lives in memory only.
const memory = {};

/** `{ read, save }` over `extension_settings.storySuite`. */
export function stSettings() {
    return {
        read() {
            const settings = context()?.extensionSettings;
            if (!settings) return memory;
            if (!settings.storySuite || typeof settings.storySuite !== 'object') settings.storySuite = {};
            return settings.storySuite;
        },
        save() {
            context()?.saveSettingsDebounced?.();
        },
    };
}

/**
 * The open character's lorebook entries as plain objects:
 * `{ character, card, entries: [{ book, uid, title, keys, content }], problem }` (`problem` is '' or why
 * nothing could be read, in plain words).
 */
export async function readCharacterLorebook() {
    const ctx = context();
    if (!ctx) return { character: '', entries: [], problem: 'SillyTavern is not available.' };
    const character = ctx.characters?.[ctx.characterId];
    if (!character) return { character: '', entries: [], problem: 'Open a chat with a character first (group chats have no single card).' };
    const name = String(character.name ?? '');
    // Which card this is, for what is remembered about it (the card's own file name, else its name).
    const card = String(character.avatar || name);
    const linked = character.data?.extensions?.world;
    const book = character.data?.character_book;
    const embedded = book && Array.isArray(book.entries)
        ? book.entries.map((entry, index) => ({
            book: String(book.name || name),
            uid: entry?.id ?? index,
            title: String(entry?.comment || entry?.name || ''),
            keys: Array.isArray(entry?.keys) ? entry.keys.map(String) : [],
            content: String(entry?.content ?? ''),
        }))
        : null;
    if (linked && typeof ctx.loadWorldInfo === 'function') {
        let data = null;
        try {
            data = await ctx.loadWorldInfo(linked);
        } catch {
            data = null;
        }
        const entries = data ? Object.values(data.entries ?? {}).map(entry => ({
            book: linked,
            uid: entry?.uid ?? '',
            title: String(entry?.comment ?? ''),
            keys: Array.isArray(entry?.key) ? entry.key.map(String) : [],
            content: String(entry?.content ?? ''),
        })) : [];
        // A linked world that is stale, missing (SillyTavern may answer an empty one) or never imported from the card leaves the card's own
        // embedded copy unread: its [storysuite:…] entries are added for each tag the linked world lacks. The linked world still comes first
        // and everything else (market lines, the rest of the lorebook) is read from it exactly as before.
        const merged = embedded ? mergeStorysuite(entries, embedded) : { entries, extra: [] };
        // A linked world that cannot be loaded is still told as before (the market lines and the Packs panel say so); the card's own embedded
        // storysuite entries are offered all the same.
        return { character: name, card, entries: [...merged.entries, ...merged.extra], problem: data ? '' : `The lorebook "${linked}" could not be loaded.` };
    }
    if (embedded) return { character: name, card, entries: embedded, problem: '' };
    return { character: name, entries: [], problem: `${name || 'This character'} has no lorebook.` };
}

const TAGS = [isPackTitle, isPortraitsTitle, isSettingsTitle];
const packIdentity = entry => {
    try {
        const pack = JSON.parse(entryText(entry.content));
        return typeof pack?.id === 'string' ? { id: pack.id, version: parseVersion(pack.version) } : null;
    } catch { return null; }
};

/**
 * The linked world's entries and the embedded book's storysuite entries put together: `{ entries, extra }` (`entries`: the linked world's, a pack entry
 * left out where the embedded copy of the same pack id is a higher version; `extra`: the embedded storysuite entries to add after them).
 * Pack entries are matched by pack id and the higher version wins (a stale linked world never hides a card update; equal keeps the linked one);
 * the portraits and settings entries come from the embedded book only for a tag the linked world lacks.
 */
function mergeStorysuite(linkedEntries, embedded) {
    const linkedPacks = new Map();
    for (const entry of linkedEntries) if (isPackTitle(entry.title)) { const who = packIdentity(entry); if (who) linkedPacks.set(who.id, { entry, version: who.version }); }
    const dropped = new Set();
    const extra = [];
    for (const entry of embedded) {
        if (isPackTitle(entry.title)) {
            const who = packIdentity(entry);
            const there = who ? linkedPacks.get(who.id) : null;
            if (!there) { if (!who && linkedEntries.some(other => isPackTitle(other.title))) continue; extra.push(entry); continue; }
            if (who.version && there.version && compareVersions(who.version, there.version) > 0) { dropped.add(there.entry); extra.push(entry); }
            continue;
        }
        if (TAGS.some(test => test(entry.title) && !linkedEntries.some(other => test(other.title)))) extra.push(entry);
    }
    // An embedded pack that won (a newer card over a stale linked world) brings its own portraits and settings: the linked ones belong to the older
    // version (portraits are for one pack version), so they give way to the embedded ones where the embedded book has some.
    if (dropped.size) {
        for (const test of [isPortraitsTitle, isSettingsTitle]) {
            const own = embedded.filter(entry => test(entry.title));
            if (!own.length) continue;
            for (const entry of linkedEntries) if (test(entry.title)) dropped.add(entry);
            for (const entry of own) if (!extra.includes(entry)) extra.push(entry);
        }
    }
    return { entries: linkedEntries.filter(entry => !dropped.has(entry)), extra };
}

/**
 * Saves SillyTavern's settings now instead of after its debounce (about a second), and says whether it worked: `{ ok, message }`.
 * SillyTavern's context only offers the debounced save, so the page's own `saveSettings` (script.js) is used, found on the context if a
 * later version gives it there. It never throws: SillyTavern tells its own failure with a toast and no error, so success is its
 * `settings_updated` event; no event within `timeoutMs` is a failure. Where there is no SillyTavern page (tests) there is nothing to
 * flush and it answers ok.
 */
export async function saveSettingsNow({ timeoutMs = 8000 } = {}) {
    const ctx = context();
    if (!ctx) return { ok: true, message: '' };
    let timer = null;
    try {
        const save = typeof ctx.saveSettings === 'function' ? ctx.saveSettings.bind(ctx) : (await import('/script.js')).saveSettings;
        const source = ctx.eventSource;
        const type = (ctx.eventTypes ?? ctx.event_types)?.SETTINGS_UPDATED;
        if (typeof save !== 'function' || typeof source?.once !== 'function' || !type) return { ok: false, message: 'SillyTavern\'s settings could not be saved from here.' };
        const forget = fn => { try { (source.removeListener ?? source.off)?.call(source, type, fn); } catch { /* it is gone already */ } };
        const told = new Promise(resolve => {
            const onSaved = () => resolve(true);
            source.once(type, onSaved);
            // (a save that never answers is raced against the timer, and the listener is taken away when the timer wins)
            timer = setTimeout(() => { forget(onSaved); resolve(false); }, timeoutMs);
        });
        await Promise.race([Promise.resolve().then(() => save()), told]);
        const ok = await told;
        return ok ? { ok: true, message: '' } : { ok: false, message: 'SillyTavern did not confirm that its settings were saved.' };
    } catch (error) {
        return { ok: false, message: `SillyTavern's settings could not be saved (${error?.message ?? error}).` };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Capability names the running Story Block offers (module ids and their domain names), or
 * null while the sdk is not up, in which case requires.capabilities is not enforced.
 */
export function stCapabilities() {
    const sdk = globalThis.StoryBlock?.sdk;
    if (!sdk || typeof sdk.modules !== 'function') return null;
    const names = new Set();
    for (const module of sdk.modules() ?? []) {
        if (module?.id) names.add(String(module.id));
        // sdk.modules() lists domains as names; a definition's domains are an object keyed by name.
        const domains = module?.domains ?? {};
        for (const domain of Array.isArray(domains) ? domains : Object.keys(domains)) names.add(String(domain));
        for (const name of Array.isArray(module?.capabilities) ? module.capabilities : []) names.add(String(name));
    }
    return [...names];
}

/** Story Block's version as the sdk reports it, if it does. */
export function stHostVersion() {
    const version = globalThis.StoryBlock?.sdk?.version ?? globalThis.StoryBlock?.version;
    return typeof version === 'string' ? version : null;
}

// base64 of bytes, in slices so a long picture does not overflow the argument list.
function base64Of(bytes) {
    let text = '';
    for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    return btoa(text);
}

/**
 * Pack portraits on SillyTavern's user files (portraits.js): `{ put, remove, exists, url }`, or null where there is no
 * SillyTavern to ask. A file is written to `/api/files/upload` and shown at `/user/files/<name>`; the name is made by
 * portraits.js from the pack id and the picture's hash (letters, digits, dashes), which the server accepts as is.
 */
export function stPortraitFiles({ fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
    const ask = async (url, body) => {
        const ctx = context();
        if (typeof ctx?.getRequestHeaders !== 'function' || typeof fetchImpl !== 'function') throw new Error('SillyTavern is not available');
        return fetchImpl(url, { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify(body) });
    };
    return {
        async put(name, bytes) {
            const response = await ask('/api/files/upload', { name, data: base64Of(bytes) });
            if (!response?.ok) throw new Error(`the server answered ${response?.status ?? 'nothing'}`);
        },
        async remove(name) {
            const response = await ask('/api/files/delete', { path: `user/files/${name}` });
            if (!response?.ok && response?.status !== 404) throw new Error(`the server answered ${response?.status ?? 'nothing'}`);
        },
        async exists(names) {
            const response = await ask('/api/files/verify', { urls: names.map(name => `user/files/${name}`) });
            if (!response?.ok) throw new Error(`the server answered ${response?.status ?? 'nothing'}`);
            const found = await response.json();
            return Object.fromEntries(names.map(name => [name, found?.[`user/files/${name}`] !== false]));
        },
        url: name => `/user/files/${name}`,
    };
}
