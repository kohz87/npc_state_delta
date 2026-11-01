// The installed pack list in `extension_settings.storySuite.packs` (pure apart from the
// injected settings access).
//
// Packs are a reader's library, not chat state: they live in extension settings, shared by
// every chat. What a pack gives a chat is copied into that chat's state when it is used (an
// item def when the story names the item, the start state when the chat begins), so
// switching a pack off later never rewrites a story already told.
//
// Stored entry: `{ id, version, enabled, source: 'file' | 'lorebook', origin, pack }` where
// `pack` is the pack as given (validated). It is checked again on read, so a hand-edited
// settings file cannot slip anything past the validator; a stored pack that no longer
// passes stays listed with its problem and gives no content.

import { HOST_CAPABILITIES, LIMITS } from './limits.js';
import { validatePack, HOST_VERSION } from './validate.js';
import { findPackEntries } from './lorebook.js';
import { byteLength } from './safety.js';
import { packTag } from './kind.js';

const SOURCES = ['file', 'lorebook'];

const countOf = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** What a normalized pack adds beside its content lists, in words: "coins", "a calendar", "3 weather tables"… */
export function extrasOf(pack) {
    const out = [];
    if (pack.currency) out.push(Array.isArray(pack.currency.coins) && pack.currency.coins.length ? `${countOf(pack.currency.coins.length, 'coin')}` : 'a money word');
    if (pack.economy) out.push('a money scale');
    if (pack.calendar) out.push('a calendar');
    if (pack.weather?.tables?.length) out.push(countOf(pack.weather.tables.length, 'weather table'));
    if (pack.screens?.length) out.push(countOf(pack.screens.length, 'screen'));
    if (pack.layouts?.length) out.push(countOf(pack.layouts.length, 'layout'));
    if (pack.theme && Object.keys(pack.theme).length) out.push('a theme');
    return out;
}

/**
 * `settings`: `{ read() → the storySuite settings object (created by the caller), save() }`.
 * `capabilities()`: the capability names this Story Block has, or null when unknown.
 * `hostVersion`: Story Block's version, or a function giving it (read at each install).
 * `portraits`: the pack portraits' store (portraits.js), or null: it takes the images picked with a pack and forgets them with it.
 */
export function createInstalled({ settings, hostVersion = HOST_VERSION, capabilities = () => null, limits = LIMITS, portraits = null } = {}) {
    if (!settings || typeof settings.read !== 'function') throw new Error('createInstalled needs settings.read().');
    const host = () => (typeof hostVersion === 'function' ? hostVersion() : hostVersion) || HOST_VERSION;
    // The capability names this Story Block has: the modules' (still null when unknown) and its own (limits.js HOST_CAPABILITIES).
    const have = () => {
        const names = capabilities();
        return Array.isArray(names) ? [...new Set([...names, ...HOST_CAPABILITIES])] : null;
    };
    // (a stored pack is not held to the strict `when` check of install: an installed pack with one unreadable condition keeps working, that event alone invalid)
    const checked = new WeakMap();  // stored pack object → validatePack result
    const listeners = new Set();

    const root = () => {
        const value = settings.read();
        if (!Array.isArray(value.packs)) value.packs = [];
        return value;
    };
    const entries = () => root().packs.filter(entry => entry && typeof entry === 'object');
    const check = entry => {
        if (!entry.pack || typeof entry.pack !== 'object') return { ok: false, errors: [{ code: 'NOT_OBJECT', path: '', message: 'The stored pack is missing.' }] };
        if (!checked.has(entry.pack)) checked.set(entry.pack, validatePack(entry.pack, { hostVersion: host(), limits, readableConditions: false }));
        return checked.get(entry.pack);
    };
    const changed = async () => {
        await settings.save?.();
        for (const fn of listeners) fn();
    };
    const sizeOf = entry => byteLength(JSON.stringify(entry.pack ?? null));
    // The pack's portraits after an install: `{ portraits: report }` when it names some or images came with it, else nothing.
    const portraitsOf = async (pack, files) => {
        const picked = Array.isArray(files) ? files : [];
        const names = (pack.content.cast ?? []).some(person => person.portrait);
        if (!portraits) return picked.length ? { portraits: { stored: [], refused: picked.map(item => ({ file: String(item?.name ?? ''), message: `${item?.name} could not be saved: pack portraits are not available here.` })), missing: [], dropped: 0 } } : {};
        const report = await portraits.apply(pack, picked);
        return names || picked.length || report.dropped ? { portraits: report } : {};
    };

    return {
        /** The installed packs for the settings list, in order. */
        list() {
            const names = have();
            return entries().map(entry => {
                const result = check(entry);
                const pack = result.ok ? result.pack : null;
                return {
                    id: String(entry.id ?? ''),
                    version: String(entry.version ?? ''),
                    name: pack?.name ?? String(entry.id ?? ''),
                    author: pack?.author ?? '',
                    description: pack?.description ?? '',
                    enabled: entry.enabled !== false,
                    source: SOURCES.includes(entry.source) ? entry.source : 'file',
                    origin: String(entry.origin ?? ''),
                    counts: pack ? Object.fromEntries(Object.entries(pack.content).map(([kind, list]) => [kind, list.length])) : {},
                    hasStart: Boolean(pack?.start),
                    // What else it adds, beside its content lists: its coins, a money scale, a calendar, weather tables, screens, a theme.
                    extras: pack ? extrasOf(pack) : [],
                    // Which module the pack is for, in words (kind.js): "World pack · Story Director", or "Pack" when it says neither.
                    tag: packTag(pack),
                    missing: pack && names ? pack.requires.capabilities.filter(name => !names.includes(name)) : [],
                    problem: result.ok ? '' : result.errors[0].message,
                };
            });
        },

        /** Normalized packs that are enabled and valid, in list order. */
        packs() {
            return entries().filter(entry => entry.enabled !== false).map(check).filter(result => result.ok).map(result => result.pack);
        },

        /**
         * Validates and installs a pack (text or parsed). A pack with an installed id replaces
         * it in place, keeping its place and its on/off switch. Nothing is saved on rejection.
         * `files`: the images picked with it, `[{ name, size, read() }]` (portraits.js). They are taken or refused one by one after the
         * pack is in, so a refused image never stops the pack.
         * → `{ ok: true, id, name, action: 'installed' | 'updated' | 'unchanged', portraits }` | `{ ok: false, errors }`, `portraits` being
         * portraits.js apply's report (`{ stored, refused, missing, dropped }`) whenever the pack names portraits or images were picked.
         */
        async install(input, { source = 'file', origin = '', files = [] } = {}) {
            const result = validatePack(input, { hostVersion: host(), capabilities: have(), limits });
            if (!result.ok) return result;
            const { pack, raw } = result;
            const list = root().packs;
            const index = list.findIndex(entry => entry?.id === pack.id);
            const entry = { id: pack.id, version: pack.version, enabled: index >= 0 ? list[index].enabled !== false : true, source: SOURCES.includes(source) ? source : 'file', origin: String(origin ?? ''), pack: raw };
            if (index >= 0 && JSON.stringify(list[index].pack) === JSON.stringify(raw)) return { ok: true, id: pack.id, name: pack.name, action: 'unchanged', ...(await portraitsOf(pack, files)) };
            if (index < 0 && list.length >= limits.installed) return { ok: false, errors: [{ code: 'TOO_MANY', path: '', message: `There are already ${limits.installed} packs installed; remove one first.` }] };
            const others = list.reduce((sum, other, at) => sum + (at === index ? 0 : sizeOf(other)), 0);
            if (others + sizeOf(entry) > limits.installedBytes) return { ok: false, errors: [{ code: 'TOO_LARGE', path: '', message: `Installed packs may take ${Math.round(limits.installedBytes / 1024 / 1024)} MB together; remove one first.` }] };
            checked.set(raw, result);
            if (index >= 0) list[index] = entry;
            else list.push(entry);
            await changed();
            return { ok: true, id: pack.id, name: pack.name, action: index >= 0 ? 'updated' : 'installed', ...(await portraitsOf(pack, files)) };
        },

        /**
         * Installs every pack in tagged lorebook entries (lorebook.js), each on its own: one bad
         * entry does not stop the others.
         * → `{ found, results: [{ origin, title, ok, id?, name?, action?, errors? }] }`
         */
        async importLorebook(entries) {
            const found = findPackEntries(entries);
            const results = [];
            for (const entry of found) {
                const result = await this.install(entry.text, { source: 'lorebook', origin: entry.origin });
                results.push({ origin: entry.origin, title: entry.title, ...result });
            }
            return { found: found.length, results };
        },

        /** Switches a pack on or off. False when no pack has that id. */
        async setEnabled(id, enabled) {
            const entry = entries().find(item => item.id === id);
            if (!entry) return false;
            if ((entry.enabled !== false) === Boolean(enabled)) return true;
            entry.enabled = Boolean(enabled);
            await changed();
            return true;
        },

        /** Removes a pack. False when no pack has that id. */
        async remove(id) {
            const list = root().packs;
            const index = list.findIndex(entry => entry?.id === id);
            if (index < 0) return false;
            list.splice(index, 1);
            await portraits?.forget(id);
            await changed();
            return true;
        },

        /** Calls `fn` after every change to the list; returns the unsubscribe function. */
        subscribe(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
    };
}
