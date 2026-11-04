// The public API, version 1 (docs/v2/PUBLIC-API.md): `StoryBlock.api`.
//
// A small frozen object for card authors and third-party scripts, separate from `sdk` (which is for modules and
// changes between releases): `version`, `host`, `ready`, `get(path)`, `paths()`, `on(event, fn)`. Read-only.
//
// Every value comes from the CURRENT head state through readers and queries that already exist (no state of its
// own): scene.* (the scene's `scene.place`, `scene.weather`, `scene.present` queries; the clock from Story
// Director's `director.time` when it answers), money (`inventory.wallet`, `inventory.currency`), items
// (`inventory.items`, the party's), party (the RPG's Character blocks, read.js, only while the RPG is on) and
// blocks (the pinned data-module blocks). Each value is a frozen plain copy.
//
// Hidden values are never returned, a hidden path reads as `undefined`:
//   * a data-module field the pack marks `prompt: false` (hidden from the story): in `blocks.*` and in `party.*`
//     (a hidden level, xp, bar or stat is left out of the member; a hidden Who is the block's name);
//   * a block shown nowhere (`show: { tab: false, card: false }`) and not an RPG role block: no `blocks.*` path;
//   * RPG role blocks while the RPG is off (off means fully off): no `party`, no `blocks.<role block>`.
//   Items, money and the scene have no hidden marks.
//
// Events (`story:changed`, `story:reply`, `story:rebuilt`, `story:chat`) are built on the internal `turn` and
// `head` events and delivered after Story Block has saved (a reply's state is written first). A listener that throws
// is caught and logged once; it never breaks a reply. The change list of `story:changed` is the difference of the
// public paths before and after the reply (store.before(index) against the head).
import { activeDefinition, actorsOf, instanceOf } from './data-modules/adapters.js';
import { dmHidden } from './data-modules/schema.js';
import { readSheet } from './lean-rpg/read.js';
import { rosterOf } from './lean-rpg/roster.js';
import { STAGES, STATS } from './lean-rpg/names.js';
import { barOf, spreadWord, wordsOf } from './lean-rpg/blocks.js';
import { formatAmount } from './domains/money.js';
import { cutAt } from '../text.js';

export const API_VERSION = 1;
export const API_EVENTS = Object.freeze(['story:changed', 'story:reply', 'story:rebuilt', 'story:chat']);
const LOG = '[Story Block API]';
// The most text the `summary` of `story:reply` holds.
const SUMMARY_MAX = 500;
// The head event's reasons that are announced as `story:rebuilt`.
const REBUILT = new Set(['swipe', 'delete', 'reread', 'repair', 'rewind', 'module']);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
const fold = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const item of Object.values(value)) deepFreeze(item);
    }
    return value;
}
/** A frozen plain copy of `value` (JSON data only). */
const frozenCopy = value => (value === undefined ? undefined : deepFreeze(structuredClone(value)));

/**
 * A value as one piece of text, for the macro and the summary: text and numbers as they are, true/false, a list as a comma list
 * (an item as "Name x2", a member by name), `null` for what has no text (nothing, an empty list, an object).
 */
export function plainText(value) {
    if (typeof value === 'string') return value.replace(/[\r\n\u2028\u2029]+/g, ' ').trim() || null;
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
    if (typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
        const parts = value.map(entry => {
            if (isObject(entry)) {
                const name = plainText(entry.name);
                return name === null ? null : Number.isFinite(entry.qty) ? `${name} x${entry.qty}` : name;
            }
            return plainText(entry);
        }).filter(part => part !== null);
        return parts.length ? parts.join(', ') : null;
    }
    return null;
}

// ---- the readers: one section of the public paths from a state -------------------------------------------------------------------------------

// A section is a Map of folded path → { path, value, leaf }: `leaf` entries are the values the diff compares; the others are groups (a list or an
// object that holds leaves). `alias` entries (party.me.*) point at a member's own path and are not diffed.
// An object value (a map field) is a group: its per-key leaves are what the diff compares, so a change is reported once.
function put(map, path, value, leaf = true, alias = false) {
    if (value === undefined) return;
    map.set(fold(path), { path, value, leaf: leaf && !isObject(value), alias });
}

// "06:40 am" in a calendar's own text, else the minute of the day as 24-hour time.
const CLOCK = /\b\d{1,2}:\d{2}(?:\s*[ap]\.?m\.?)?/i;
function clockParts(time) {
    if (!isObject(time) || !Number.isInteger(time.minutes)) return { time: undefined, date: undefined };
    const said = typeof time.text === 'string' ? time.text.trim() : '';
    const found = said.match(CLOCK);
    const minute = isObject(time.parts) && Number.isInteger(time.parts.minutes) ? time.parts.minutes : ((time.minutes % 1440) + 1440) % 1440;
    const clock = found ? found[0].trim() : `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
    const date = found ? said.replace(found[0], '').replace(/\s{2,}/g, ' ').replace(/^[\s,;·-]+|[\s,;·-]+$/g, '').replace(/,\s*,/g, ',') : said;
    return { time: clock, date: date || undefined };
}

function sceneSection(ask) {
    const map = new Map();
    const place = ask('scene.place', {});
    put(map, 'scene.place', text(place?.name) || undefined);
    put(map, 'scene.place.kind', text(place?.kind) || undefined);
    put(map, 'scene.place.region', text(place?.region) || undefined);
    const clock = clockParts(ask('director.time', {}));
    put(map, 'scene.time', clock.time);
    put(map, 'scene.date', clock.date);
    put(map, 'scene.weather', text(ask('scene.weather', {})?.text) || undefined);
    const present = ask('scene.present', {});
    if (Array.isArray(present)) put(map, 'scene.present', present.map(person => text(isObject(person) ? person.name : person)).filter(Boolean));
    return map;
}

function moneySection(ask, state) {
    const map = new Map();
    if (!isObject(state?.domains?.inventory)) return map;
    const wallet = ask('inventory.wallet', { owner: 'party' });
    const coin = Number.isSafeInteger(wallet?.coin) ? wallet.coin : 0;
    put(map, 'money', coin);
    const currency = ask('inventory.currency', {});
    put(map, 'money.text', formatAmount(coin, currency ?? undefined));
    return map;
}

function itemsSection(ask, state) {
    const map = new Map();
    if (!isObject(state?.domains?.inventory)) return map;
    const rows = ask('inventory.items', { owner: 'party' });
    if (!Array.isArray(rows)) return map;
    // One entry per name: the stacks of a name add up (a name is one thing to a reader).
    const byName = new Map();
    for (const row of rows) {
        const name = text(row?.name);
        if (!name || !Number.isSafeInteger(row.qty)) continue;
        const key = fold(name);
        const entry = byName.get(key) ?? { name, qty: 0, kind: text(row.kind), note: '' };
        entry.qty += row.qty;
        if (!entry.note) entry.note = text(row.note);
        byName.set(key, entry);
    }
    const list = [...byName.values()];
    put(map, 'items', list.map(item => ({ name: item.name, qty: item.qty, kind: item.kind, note: item.note })), false);
    for (const item of list) {
        put(map, `items.${item.name}`, { name: item.name, qty: item.qty, kind: item.kind, note: item.note }, false);
        put(map, `items.${item.name}.qty`, item.qty);
        put(map, `items.${item.name}.kind`, item.kind || undefined);
        put(map, `items.${item.name}.note`, item.note || undefined);
    }
    return map;
}

// A bar's word as the Party card reads it: a Standard block bar spreads the word over its size, a stage bar's own field names win, else the default words.
function barWord(key, definition, member) {
    const value = member[key];
    if (!Number.isSafeInteger(value)) return undefined;
    if (member.size && barOf(definition?.state?.[key])) return spreadWord(wordsOf(barOf(definition.state[key])), value, member.size[key]) || undefined;
    const named = definition?.state?.[key]?.names?.[String(value)];
    if (typeof named === 'string' && named) return named;
    return STAGES[key]?.[value] ?? String(value);
}

function partySection(state, persona) {
    const map = new Map();
    const sheet = readSheet(state);
    if (!sheet.characters.length) return map;
    const roster = rosterOf(state, persona).actors;
    const members = sheet.characters.map((member, at) => {
        const definition = activeDefinition(state, member.module);
        const hidden = new Set(member.hidden);
        const out = { name: member.who };
        if (!hidden.has(member.levelled ? 'level' : 'soul')) out.level = member.level;
        if (Number.isSafeInteger(member.xp) && !hidden.has('xp')) out.xp = member.xp;
        for (const key of ['health', 'mana', 'stamina']) {
            const word = hidden.has(key) ? undefined : barWord(key, definition, member);
            if (word !== undefined) out[key] = word;
        }
        const stats = Object.fromEntries(STATS.filter(stat => Number.isSafeInteger(member.stats[stat]) && !hidden.has(stat)).map(stat => [stat, member.stats[stat]]));
        if (Object.keys(stats).length) out.stats = stats;
        return { out, lead: roster[at]?.pc === true };
    });
    put(map, 'party', members.map(member => member.out), false);
    for (const { out, lead } of members) {
        // A member called "me" is not reachable by name (party.me is the reader's alias); it is still in the `party` list.
        const named = fold(out.name) !== 'me';
        const base = `party.${out.name}`;
        if (named) put(map, base, out, false);
        if (lead) put(map, 'party.me', out, false, true);
        for (const [field, value] of Object.entries(out)) {
            if (field === 'name') { if (named) put(map, `${base}.name`, value); if (lead) put(map, 'party.me.name', value, true, true); continue; }
            if (field === 'stats') {
                if (named) put(map, `${base}.stats`, value, false);
                if (lead) put(map, 'party.me.stats', value, false, true);
                for (const [stat, number] of Object.entries(value)) {
                    if (named) put(map, `${base}.stats.${stat}`, number);
                    if (lead) put(map, `party.me.stats.${stat}`, number, true, true);
                }
                continue;
            }
            if (named) put(map, `${base}.${field}`, value);
            if (lead) put(map, `party.me.${field}`, value, true, true);
        }
    }
    return map;
}

// A block is hidden the way the Blocks screen says "Hidden": no tab and no card (no `show` at all is the same), and no screens or layouts of its own.
// The RPG's role blocks are shown by the RPG's own screens.
const blockHidden = definition => !definition.role && !definition.show?.tab && !definition.show?.card
    && !(Array.isArray(definition.screens) && definition.screens.length) && !(Array.isArray(definition.layouts) && definition.layouts.length);

function blocksSection(state, rpgOn) {
    const map = new Map();
    const domain = state?.domains?.dataModules;
    if (!isObject(domain) || !isObject(domain.active)) return map;
    const ids = [];
    const actors = actorsOf(state);
    const visible = (definition, fields) => Object.fromEntries(Object.keys(isObject(definition.state) ? definition.state : {})
        .filter(key => Object.hasOwn(fields, key) && !dmHidden(definition.state[key])).map(key => [key, fields[key]]));
    const leaves = (prefix, shown) => {
        for (const [key, value] of Object.entries(shown)) {
            put(map, `${prefix}.${key}`, value);
            if (isObject(value)) for (const [inner, entry] of Object.entries(value)) put(map, `${prefix}.${key}.${inner}`, entry);
        }
    };
    for (const id of Object.keys(domain.active).sort()) {
        const definition = activeDefinition(state, id);
        if (!definition || blockHidden(definition) || (definition.role && !rpgOn)) continue;
        ids.push(id);
        if (definition.scope === 'character') {
            const people = {};
            // Subjects with the same display name are read by their ids.
            const subjects = (domain.active[id].subjects ?? []).filter(subject => isObject(instanceOf(state, id, subject)?.fields));
            const shownName = subject => text(actors[subject]?.name) || subject;
            const count = new Map();
            for (const subject of subjects) count.set(fold(shownName(subject)), (count.get(fold(shownName(subject))) ?? 0) + 1);
            for (const subject of subjects) {
                const fields = instanceOf(state, id, subject).fields;
                const who = count.get(fold(shownName(subject))) > 1 ? subject : shownName(subject);
                people[who] = visible(definition, fields);
                put(map, `blocks.${id}.${who}`, people[who], false);
                leaves(`blocks.${id}.${who}`, people[who]);
            }
            put(map, `blocks.${id}`, people, false);
        } else {
            const fields = instanceOf(state, id, 'chat')?.fields;
            if (!isObject(fields)) { ids.pop(); continue; }
            const shown = visible(definition, fields);
            put(map, `blocks.${id}`, shown, false);
            leaves(`blocks.${id}`, shown);
        }
    }
    put(map, 'blocks', ids, false);
    return map;
}

/**
 * The readers over a state: `{ get(path), paths(), leaves() }`. `deps`: { ask(state, name, args) → the query's answer or null (a query that is
 * not there or throws is null), rpgOn(), persona() }. Pure: it reads, never writes.
 */
export function createReaders({ ask, rpgOn = () => false, persona = () => '' }) {
    const safeAsk = state => (name, args) => { try { return ask(state, name, args) ?? null; } catch { return null; } };
    const flag = () => { try { return rpgOn() === true; } catch { return false; } };
    const who = () => { try { return String(persona() ?? ''); } catch { return ''; } };
    // The sections that read only the state (and the RPG switch and the persona) are kept per head-state object: a state is frozen and a new head is a
    // new object, so repeated gets on one head reuse them. The scene and money ask queries that depend on settings, so they are read each time.
    const kept = new WeakMap();
    function cached(state, root, signature, build) {
        let sections = kept.get(state);
        if (!sections) kept.set(state, sections = new Map());
        const hit = sections.get(root);
        if (hit && hit.signature === signature) return hit.map;
        const map = build();
        sections.set(root, { signature, map });
        return map;
    }
    function section(state, root) {
        if (!isObject(state) || !isObject(state.domains)) return new Map();
        if (root === 'scene') return sceneSection(safeAsk(state));
        if (root === 'money') return moneySection(safeAsk(state), state);
        if (root === 'items') return cached(state, root, '', () => itemsSection(safeAsk(state), state));
        if (root === 'party') { const on = flag(), name = who(); return on ? cached(state, root, name, () => partySection(state, name)) : new Map(); }
        if (root === 'blocks') { const on = flag(); return cached(state, root, String(on), () => blocksSection(state, on)); }
        return new Map();
    }
    const ROOTS = ['scene', 'money', 'items', 'party', 'blocks'];
    const entries = (state, roots = ROOTS) => {
        const all = new Map();
        for (const root of roots) for (const [key, entry] of section(state, root)) all.set(key, entry);
        return all;
    };
    return {
        get(state, path) {
            if (typeof path !== 'string') return undefined;
            const wanted = fold(path);
            const root = wanted.split('.')[0];
            if (!ROOTS.includes(root)) return undefined;
            return section(state, root).get(wanted)?.value;
        },
        paths(state) {
            return [...entries(state).values()].map(entry => entry.path);
        },
        /** path → value of every leaf (not the groups, not party.me's copies), for the diff. */
        leaves(state) {
            const out = new Map();
            for (const entry of entries(state).values()) if (entry.leaf && !entry.alias) out.set(entry.path, entry.value);
            return out;
        },
    };
}

/** The changes from the leaves `before` to the leaves `after` (Maps of path → value): [{ path, from, to }] by path, `null` for none. */
export function diffLeaves(before, after) {
    const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
    const changes = [];
    for (const path of paths) {
        const from = before.has(path) ? before.get(path) : null;
        const to = after.has(path) ? after.get(path) : null;
        if (JSON.stringify(from) !== JSON.stringify(to)) changes.push({ path, from, to });
    }
    return changes;
}

const summaryOf = changes => cutAt(changes.map(change => `${change.path}: ${plainText(change.to) ?? 'none'}`).join('; '), SUMMARY_MAX);

/**
 * createPublicApi(deps) → the frozen `StoryBlock.api`.
 * deps: { version, hostReady (a promise: the host is up), state() (the head state), before(index) (the state before reply `index`), ask(state, name, args),
 * rpgOn(), persona(), events (the internal createEvents), chatId(), saved() (a promise: what the store holds is written; never rejects), log? }.
 */
export function createPublicApi({ version, hostReady = Promise.resolve(), state, before = () => null, ask, rpgOn, persona, events, chatId = () => '', saved = async () => {}, log = console.warn, publicPaths = null, latestIndex = () => 0 }) {
    const readers = createReaders({ ask, rpgOn, persona });
    // Paths from modules (public-paths.js): read through the same guards as our own; their snapshot (`moduleSnap`) is what the last announcement saw.
    const fromModules = {
        get: path => (publicPaths && publicPaths.owns(path) ? publicPaths.get(path) : undefined),
        paths: () => (publicPaths ? publicPaths.paths() : []),
        leaves: () => (publicPaths ? publicPaths.leaves() : new Map()),
    };
    const headState = () => { try { return state() ?? null; } catch { return null; } };
    const listeners = new Map(API_EVENTS.map(name => [name, new Set()]));
    const told = new WeakSet();
    const heard = names => names.some(name => listeners.get(name).size > 0);

    function deliver(name, payload) {
        const frozen = deepFreeze(payload);
        for (const fn of [...listeners.get(name)]) {
            const failed = error => {
                if (told.has(fn)) return;
                told.add(fn);
                try { log(`${LOG} a "${name}" listener failed (told once)`, error); } catch { /* a missing console is not an error */ }
            };
            try {
                const result = fn(frozen);
                if (result && typeof result.then === 'function') result.then(undefined, failed);
            } catch (error) { failed(error); }
        }
    }
    // Events go out in order, each after the store has written what it holds.
    let chain = Promise.resolve();
    const later = jobs => {
        chain = chain.then(async () => {
            await saved();
            for (const [name, payload] of jobs) deliver(name, payload);
        }).catch(error => { try { log(`${LOG} an event could not be delivered`, error); } catch { /* nothing to tell it to */ } });
    };

    // What the last reply announced, so the lines a safety net adds to it are told as their own change.
    let announced = null;
    const leavesNow = () => new Map([...readers.leaves(headState()), ...fromModules.leaves()]);
    // The module paths' values at the last announcement (null while nobody listens: it is taken when a listener comes).
    let moduleSnap = null;

    function onTurn(turn) {
        if (!heard(['story:changed', 'story:reply'])) { announced = null; moduleSnap = null; return; }
        const type = turn?.type;
        if (type === 'reread' || !Number.isInteger(turn?.index)) return;
        const index = turn.index;
        const now = leavesNow();
        const start = announced?.index === index ? announced.leaves : new Map([...readers.leaves(before(index)), ...(moduleSnap ?? fromModules.leaves())]);
        const changes = diffLeaves(start, now);
        announced = { index, leaves: now };
        moduleSnap = fromModules.leaves();
        const jobs = [];
        if (changes.length) jobs.push(['story:changed', { index, changes }]);
        if (type !== 'late') jobs.push(['story:reply', { index, summary: summaryOf(changes) }]);
        if (jobs.length) later(jobs);
    }

    let lastChat = null;
    let firstRead = null;
    const firstReadDone = new Promise(resolve => { firstRead = resolve; });
    function onHead(info) {
        const reason = info?.reason;
        if (reason === 'chat') {
            const id = (() => { try { return String(chatId() ?? ''); } catch { return ''; } })();
            const same = lastChat !== null && lastChat === id;
            lastChat = id;
            announced = null;
            moduleSnap = heard(['story:changed', 'story:reply']) ? fromModules.leaves() : null;
            firstRead();
            const jobs = [['story:chat', { chatId: id }]];
            if (same) jobs.push(['story:rebuilt', { reason: 'reload' }]);
            if (heard(['story:chat', 'story:rebuilt'])) later(jobs);
        } else if (REBUILT.has(reason)) {
            announced = null;
            moduleSnap = heard(['story:changed', 'story:reply']) ? fromModules.leaves() : null;
            if (heard(['story:rebuilt'])) later([['story:rebuilt', { reason }]]);
        }
    }
    events.on('turn', onTurn);
    events.on('head', onHead);
    // A module's paths came or went: no change is told for that. A module whose values moved on their own (a scan that finished after the
    // reply) says so, and the difference to the last announcement is told as a `story:changed` of the last reply.
    publicPaths?.onChange(kind => {
        if (!heard(['story:changed', 'story:reply'])) { moduleSnap = null; return; }
        const now = fromModules.leaves();
        if (kind === 'registry' || moduleSnap === null) { moduleSnap = now; return; }
        const changes = diffLeaves(moduleSnap, now);
        moduleSnap = now;
        if (!changes.length) return;
        let index = 0;
        try { index = announced?.index ?? Number(latestIndex()); } catch { index = 0; }
        if (announced) announced = { index: announced.index, leaves: new Map([...announced.leaves].filter(([path]) => !publicPaths.owns(path)).concat([...now])) };
        later([['story:changed', { index: Number.isInteger(index) ? index : 0, changes }]]);
    });

    const api = {
        version: API_VERSION,
        host: String(version),
        ready: null,
        get: Object.freeze(path => frozenCopy(publicPaths?.owns(path) ? fromModules.get(path) : readers.get(headState(), path))),
        paths: Object.freeze(() => deepFreeze([...readers.paths(headState()), ...fromModules.paths()])),
        on: Object.freeze(function on(event, fn) {
            if (!listeners.has(event)) throw new Error(`Story Block API: there is no "${event}" event (known: ${API_EVENTS.join(', ')}).`);
            if (typeof fn !== 'function') throw new Error('Story Block API: on() needs a function.');
            const set = listeners.get(event);
            set.add(fn);
            if (moduleSnap === null && (event === 'story:changed' || event === 'story:reply')) moduleSnap = fromModules.leaves();
            return () => { set.delete(fn); };
        }),
    };
    api.ready = Object.freeze(Promise.resolve(hostReady).then(() => (headState() ? undefined : firstReadDone)).then(() => frozenApi));
    const frozenApi = Object.freeze(api);
    return frozenApi;
}
