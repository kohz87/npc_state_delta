// The card offer (no DOM): what the open character card brings, asked once when a chat opens and answered with one click.
//
// A card may carry a pack (`[storysuite:pack]`), its portraits (`[storysuite:portraits]`) and recommended settings
// (`[storysuite:settings]`) in disabled lorebook entries (lorebook.js, card.js). When a chat with a single character opens, the
// controller reads those entries with the existing reader, checks them with the same checker an import uses, and keeps one offer per
// pack that is new or newer than the installed one (at most three). Nothing is installed without the player's click.
//
// Install is the existing install (installed.js) with the portraits handed in as zip-import files; then the pack's data modules are
// turned on in THIS chat at once (an update keeps the chat's own choice), then the ticked settings are applied through the owners
// that registered them (card-settings.js); the notice that follows says only what was done. "Not now" is remembered per card, pack id
// and version in Story Block's settings. A refused pack, a skipped picture or key, and each "Not now" write one line for Diagnostics.

import { findPackEntries, findPortraitEntries, findSettingsEntries } from './lorebook.js';
import { portraitsPackOf, readPortraitsEntry, readSettingsEntry } from './card.js';
import { OWNER_NEEDS } from './card-settings.js';
import { compareVersions, parseVersion } from './version.js';

export const MAX_OFFERS = 3;
const REMEMBER_MAX = 200;

/** A capability a pack may need, said by who gives it (the checker's own words are used for any other). */
export const CAPABILITY_NEEDS = Object.freeze({
    'chronicle-lasting': 'Needs Story Director for world events',
});

const SHOWN_KINDS = [['places', 'places'], ['cast', 'cast'], ['items', 'items'], ['events', 'events'], ['creatures', 'creatures'], ['shops', 'shops'],
    ['recipes', 'recipes'], ['quests', 'quests'], ['ranks', 'ranks'], ['routes', 'routes'], ['races', 'races'], ['talents', 'talents'], ['skills', 'skills']];

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const joinWords = list => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);

/** What a pack brings, in a few words: "places, cast, items, 12 portraits" (or "adds Reputation" for data modules alone). */
export function bringsLine(pack, portraits = 0) {
    const content = pack.content ?? {};
    const parts = SHOWN_KINDS.filter(([kind]) => Array.isArray(content[kind]) && content[kind].length).slice(0, 3).map(([, word]) => word);
    const modules = Array.isArray(content.dataModules) ? content.dataModules : [];
    const named = modules.slice(0, 3).map(module => String(module?.name ?? '')).filter(Boolean);
    const head = parts.length ? parts.join(', ') : modules.length ? `adds ${named.length ? joinWords(named) : plural(modules.length, 'data module')}` : '';
    return [head, portraits ? plural(portraits, 'portrait') : ''].filter(Boolean).join(', ');
}

/** What an install did to the settings, in words: "RPG and Gear are on; NSD portraits set to Natural." */
export function settingsDone(applied) {
    const parts = [];
    for (const state of ['on', 'off']) {
        const labels = applied.filter(item => item.text === `${item.label} ${state}`).map(item => item.label);
        if (labels.length) parts.push(`${joinWords(labels)} ${labels.length === 1 ? 'is' : 'are'} ${state}`);
    }
    for (const item of applied) {
        if (item.text === `${item.label} on` || item.text === `${item.label} off`) continue;
        parts.push(`${item.label} set to ${item.text.slice(item.label.length + 1)}`);
    }
    return parts.length ? `${parts.join('; ')}.` : '';
}

/**
 * Turns on the data modules of pack `packId` in this chat, one by one, as Settings → Data modules' "Enable for this chat" does (`dm.pin`
 * with the hashes the offer shows), and saves the chat at once so the choice is on disk and the tab shows without a reply or a reload.
 * `sdk`: query and command; `save()`: the store's save now; `still()`: false once the chat the click was made in is not the open one (nothing more is
 * pinned then). → `{ pinned, failed: [message], total, moved }`.
 */
export async function enableDataModules({ sdk, packId, save = null, still = () => true }) {
    let rows = [];
    try { rows = sdk.query('dataModules.setup') ?? []; } catch { rows = []; }
    const mine = rows.filter(row => row?.packId === packId);
    const out = { pinned: 0, failed: [], total: mine.length, moved: false };
    for (const row of mine) {
        if (row.pinned) continue;
        // Checked before each pin: the chat may have changed while the earlier ones were on their way.
        if (!still()) { out.moved = true; break; }
        if (row.available === false) { out.failed.push(`${row.definition?.name ?? row.module} is waiting: ${row.reason || 'not ready'}`); continue; }
        let result = null;
        try { result = await sdk.command('dm.pin', { module: row.module, hash: row.hash, packHash: row.packHash, subjects: [] }); } catch (error) { result = { ok: false, message: error?.message ?? String(error) }; }
        if (result?.ok) out.pinned += 1;
        else out.failed.push(`${row.definition?.name ?? row.module}: ${result?.message ?? 'not enabled'}`);
    }
    if (out.pinned && typeof save === 'function') { try { await save(); } catch { /* the store tells a failed save and tries again */ } }
    return out;
}

/**
 * `readLorebook()` → `{ character, card, entries, problem }`; `packs`: installed.js; `cardSettings`: card-settings.js;
 * `remember`: `{ read() → { [key]: true }, write(map) }` for "Not now"; `single()`: true in a single-character chat;
 * `enableModules(packId, { still })` → `{ pinned, failed, total, moved }` (`still()`: false once the chat changed: nothing more is pinned); `flushSettings()` → `{ ok, message }` (SillyTavern's settings saved now, not after its debounce); `chatId()`: the open chat's id; `notify(text)`: a toast; `report({ code, message })`: Diagnostics.
 * → `{ refresh, offers, waiting, install, notNow, dismiss, clearDone, subscribe }`.
 */
export function createCardOffer({ readLorebook, packs, cardSettings, remember, single = () => true, enableModules = async () => ({ pinned: 0, failed: [], total: 0, moved: false }), flushSettings = async () => ({ ok: true, message: '' }), chatId = () => '', notify = () => {}, report = () => {} } = {}) {
    let token = 0;
    let list = [];
    let card = '';
    const told = new Set();
    const listeners = new Set();
    const tell = () => { for (const fn of [...listeners]) { try { fn(); } catch { /* a listener never stops the others */ } } };
    // A line for Diagnostics, once for a given card and text.
    const line = (code, message, { always = false } = {}) => {
        const id = `${card}|${code}|${message}`;
        if (!always && told.has(id)) return;
        told.add(id);
        if (told.size > 200) told.delete(told.values().next().value);
        try { report({ code, message }); } catch { /* the report never stops the offer */ }
    };
    const noteKey = (id, version) => `${card}|${id}|${version}`;
    const declined = (id, version) => Boolean(remember?.read?.()?.[noteKey(id, version)]);

    async function refresh() {
        const mine = ++token;
        // An offer whose install is running is not thrown away by a chat change: its notice is told when it ends.
        const working = list.filter(offer => offer.state === 'working');
        list = working;
        tell();
        if (!single()) return;
        let read = null;
        try { read = await readLorebook(); } catch { return; }
        // The answer of a read that another chat's open overtook is dropped (as the market lines are).
        if (mine !== token || !read) return;   // (a `problem` with entries is a linked world that did not load while the embedded book still offers)
        card = String(read.card ?? read.character ?? '');
        const entries = read.entries ?? [];
        const found = findPackEntries(entries);
        if (!found.length) return;
        const installed = new Map(packs.list().map(entry => [entry.id, entry.version]));
        const offers = [];
        const cardIds = new Set();
        for (const entry of found) {
            const label = entry.title || entry.origin;
            const checked = packs.inspect(entry.text);
            if (!checked.ok) { line('CARD_REFUSED', `Card pack ${label} was not offered: ${checked.errors?.[0]?.message ?? 'it did not pass the checker.'}`); continue; }
            const pack = checked.pack;
            cardIds.add(pack.id);
            const have = installed.get(pack.id);
            const cardVersion = parseVersion(pack.version);
            const haveVersion = have === undefined ? null : parseVersion(have);
            if (have !== undefined && cardVersion && haveVersion && compareVersions(cardVersion, haveVersion) <= 0) continue;
            if (declined(pack.id, pack.version)) continue;
            if (offers.some(offer => offer.packId === pack.id)) { line('CARD_REFUSED', `Card pack ${label} was not offered: another entry of this card already offers ${pack.id}.`); continue; }
            offers.push({ entry, pack, raw: checked.raw, installedVersion: have ?? null });
        }
        for (const extra of offers.splice(MAX_OFFERS)) line('CARD_REFUSED', `Card pack ${extra.pack.name} was not offered: a card offers at most ${MAX_OFFERS} packs.`);
        if (!offers.length) return;
        // Portraits: one entry for each offered pack; an entry for a pack the card does not offer is told.
        const portraitEntries = findPortraitEntries(entries);
        for (const entry of portraitEntries) {
            const forId = portraitsPackOf(entry.text);
            if (!cardIds.has(forId)) line('CARD_REFUSED', `Card portraits ${entry.title || entry.origin} were not used: no pack on this card has the id ${String(forId ?? '?').slice(0, 60)}.`);
        }
        for (const offer of offers) {
            const entry = portraitEntries.find(item => portraitsPackOf(item.text) === offer.pack.id);
            offer.files = [];
            if (!entry) continue;
            const got = readPortraitsEntry(entry.text, offer.pack);
            for (const text of got.lines) line(got.ok ? 'CARD_PORTRAIT_SKIPPED' : 'CARD_REFUSED', text);
            if (got.ok) offer.files = got.files;
        }
        // Recommended settings are the card's, shown with each pack's notice (what already matches is left out when it is drawn).
        let values = {};
        const settingEntries = findSettingsEntries(entries);
        settingEntries.forEach((entry, at) => {
            if (at > 0) { line('CARD_REFUSED', `The card's second settings entry ${entry.title || entry.origin} was not used.`); return; }
            const got = readSettingsEntry(entry.text);
            for (const text of got.lines) line(got.ok ? 'CARD_KEY_SKIPPED' : 'CARD_REFUSED', text);
            if (got.ok) values = got.values;
        });
        const fresh = offers.map(offer => ({
            id: `${offer.pack.id}@${offer.pack.version}`,
            packId: offer.pack.id,
            name: offer.pack.name,
            version: offer.pack.version,
            installedVersion: offer.installedVersion,
            update: offer.installedVersion !== null,
            pack: offer.pack,
            text: offer.entry.text,
            origin: offer.entry.origin,
            files: offer.files,
            values,
            state: 'offer',
            result: '',
        }));
        list = [...working, ...fresh.filter(offer => !working.some(item => item.id === offer.id))];
        tell();
    }

    // What an offer shows now: read at each draw, so a module or extension that registers later changes it.
    function view(offer) {
        const checked = offer.state === 'offer' ? packs.inspect(offer.text) : null;
        const missing = checked?.ok ? checked.missing : [];
        const known = missing.filter(name => CAPABILITY_NEEDS[name]);
        const other = missing.filter(name => !CAPABILITY_NEEDS[name]);
        const needs = [...new Set(known.map(name => CAPABILITY_NEEDS[name]))];
        if (other.length) needs.push(`This pack needs ${other.join(', ')}, which no installed module provides.`);
        const planned = cardSettings.plan(offer.values);
        for (const text of planned.lines) line('CARD_KEY_SKIPPED', text);
        const owners = planned.missing.map(owner => cardSettings.has(owner) ? '' : (OWNER_NEEDS[owner] ?? `Needs ${owner} for its recommended settings`)).filter(Boolean);
        return {
            id: offer.id, packId: offer.packId, name: offer.name, version: offer.version, installedVersion: offer.installedVersion, update: offer.update,
            state: offer.state, result: offer.result,
            brings: bringsLine(offer.pack, offer.files.length),
            settings: planned.items,
            notes: [...needs, ...owners],
            blocked: missing.length > 0,
        };
    }

    const find = id => list.find(offer => offer.id === id);

    async function install(id, { settings = true } = {}) {
        const offer = find(id);
        if (!offer || offer.state !== 'offer') return null;
        const now = view(offer);
        if (now.blocked) return null;
        // The chat and the read this click was made in: what is pinned goes only into that chat.
        const here = chatId(), readToken = token;
        const still = () => token === readToken && chatId() === here;
        offer.state = 'working';
        tell();
        const done = [];
        let unsaved = false;
        try {
            const result = await packs.install(offer.text, { source: 'lorebook', origin: offer.origin, files: offer.files });
            if (!result.ok) {
                offer.state = 'failed';
                offer.result = `${offer.name} was not installed: ${result.errors?.[0]?.message ?? 'the checker refused it.'}`;
                line('CARD_REFUSED', offer.result, { always: true });
                tell();
                return result;
            }
            const stored = result.portraits?.stored?.length ?? 0;
            const refused = result.portraits?.refused ?? [];
            for (const item of refused) line('CARD_PORTRAIT_SKIPPED', `Card portrait ${item.file} was not stored: ${item.message}`, { always: true });
            done.push(`${result.action === 'updated' ? 'Updated' : result.action === 'unchanged' ? 'Already installed:' : 'Installed'} ${result.name} ${offer.version}${stored ? ` with ${plural(stored, 'portrait')}` : ''}.`);
            if (refused.length) done.push(`${plural(refused.length, 'portrait')} not used.`);
            // The pack list and the portrait index go to disk before anything is pinned in the chat: a reload now never finds modules
            // pinned for a pack that was not kept. A failed save does not stop the install (the pack is in): the notice warns at the end.
            const first = await flushSettings();
            if (!first.ok) { unsaved = true; line('CARD_REFUSED', `${offer.name}: ${first.message || 'the settings could not be saved'}`, { always: true }); }
            if (!offer.update) {
                // A chat switch since the click leaves the modules unpinned: they would go into the wrong chat, or none.
                const modules = still() ? await enableModules(offer.packId, { still }) : { pinned: 0, failed: [], total: 0, moved: true };
                if (modules.pinned) done.push(`${plural(modules.pinned, 'data module')} turned on in this chat.`);
                if (modules.moved) {
                    done.push('The chat changed, so its data modules were not turned on (Settings, Tabs & Packs, Data modules).');
                    line('CARD_REFUSED', `Card data modules of ${offer.name} were not turned on: the chat changed during the install.`, { always: true });
                    try { notify(`${offer.name} is installed. Turn its modules on in Settings → Data modules for that chat.`); } catch { /* a missing toast is not an error */ }
                }
                if (modules.failed.length) {
                    done.push(`${plural(modules.failed.length, 'data module')} could not be turned on (Settings, Tabs & Packs, Data modules).`);
                    for (const text of modules.failed) line('CARD_REFUSED', `Card data module not turned on: ${text}`, { always: true });
                }
            }
            if (settings) {
                const fresh = cardSettings.plan(offer.values).items;
                if (fresh.length) {
                    const applied = await cardSettings.apply(fresh);
                    const text = settingsDone(applied.applied);
                    if (text) done.push(text);
                    if (applied.failed.length) done.push(`${joinWords(applied.failed.map(item => item.id))} could not be applied.`);
                    for (const item of applied.failed) line('CARD_KEY_SKIPPED', `Card setting ${item.id} was not applied: ${item.message}`, { always: true });
                }
            }
            // The applied settings go to disk too, before the notice says it is done.
            const last = await flushSettings();
            if (!last.ok) { unsaved = true; line('CARD_REFUSED', `${offer.name}: ${last.message || 'the settings could not be saved'}`, { always: true }); }
            if (unsaved) done.push(`Settings may not have been saved; if ${offer.name} is missing after a reload, import it from Settings → Tabs & Packs.`);
            offer.state = 'done';
            offer.result = done.join(' ');
        } catch (error) {
            offer.state = 'failed';
            offer.result = `${offer.name} could not be installed (${error?.message ?? error}).`;
            line('CARD_REFUSED', offer.result, { always: true });
        }
        tell();
        return { ok: offer.state === 'done', text: offer.result };
    }

    function notNow(id) {
        const offer = find(id);
        if (!offer || offer.state !== 'offer') return false;
        const map = { ...(remember?.read?.() ?? {}) };
        delete map[noteKey(offer.packId, offer.version)];
        map[noteKey(offer.packId, offer.version)] = true;
        const keys = Object.keys(map);
        for (const key of keys.slice(0, Math.max(0, keys.length - REMEMBER_MAX))) delete map[key];
        remember?.write?.(map);
        list = list.filter(item => item !== offer);
        line('CARD_NOT_NOW', `Card pack ${offer.name} ${offer.version} was declined with Not now; it is not offered again for this version.`, { always: true });
        tell();
        return true;
    }

    function dismiss(id) {
        const before = list.length;
        list = list.filter(offer => !(offer.id === id && (offer.state === 'done' || offer.state === 'failed')));
        if (list.length !== before) tell();
    }
    /** The "Installed …" notices go with the next reply. */
    function clearDone() {
        const before = list.length;
        list = list.filter(offer => offer.state !== 'done');
        if (list.length !== before) tell();
    }

    return {
        refresh,
        offers: () => list.map(view),
        waiting: () => list.some(offer => offer.state === 'offer' || offer.state === 'working'),
        install,
        notNow,
        dismiss,
        clearDone,
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    };
}
