// Module lifecycle for the public sdk: announce lifecycle changes, add missing initial domains, and
// preflight a chat's stored data without writing. The timeline map is shared with createSdk.

import { INIT_PREFIX } from '../registry.js';
import { KEY as RECORD_KEY, isCarrier, recordFault } from '../persist.js';
import { isObject } from './shared.js';
import { missingModules } from './queries.js';
import { DOMAIN_TEXT, MODULE_ID_TEXT, RULES_DOMAIN, STORE_VERSION } from './constants.js';

// The timeline a registry's sdk was made with (createSdk), so ensureModules can recover it.
const timelines = new WeakMap();

/** Remembers the timeline a registry's sdk was made with. */
export function rememberTimeline(registry, timeline) {
    timelines.set(registry, timeline);
}

// What each registry's modules were last announced as (`modules` event): id → "status\u0000reason".
const announced = new WeakMap();

/**
 * Tells the `modules` event what changed in the modules' lifecycle (registry.lifecycles()) since the
 * last time: a module that turned ready, dormant or restore-pending, or one that appeared dormant
 * (a new module that is ready is not news). Each change is announced once. Returns the changes
 * ([{ id, status, reason, from }]); the event carries them as { changes }.
 */
export function announceModules(registry, events = null) {
    if (typeof registry?.lifecycles !== 'function') return [];
    if (!announced.has(registry)) announced.set(registry, new Map());
    const known = announced.get(registry);
    const changes = [];
    for (const { id, status, reason } of registry.lifecycles()) {
        const before = known.get(id);
        const now = `${status}\u0000${reason ?? ''}`;
        if (before === now) continue;
        known.set(id, now);
        if (before === undefined && status === 'ready') continue;
        changes.push({ id, status, reason, from: before === undefined ? null : before.split('\u0000')[0] });
    }
    if (changes.length) events?.emit('modules', { changes });
    return changes;
}

// Set-up failures already logged, per registry: a domain whose initial() keeps failing is tried
// again at every turn, and told once.
const toldFailures = new WeakMap();

/**
 * Adds the missing initial slices of each module (only those: a domain the chat already has keeps
 * its data) with a `system` receipt on the head carrier (§2.6). Does nothing without a head carrier
 * or before the chat has its state (a module registering at boot, before CHAT_CHANGED). Returns the
 * command results.
 */
export async function ensureModules({ store, bus, registry, events = null }) {
    announceModules(registry, events);
    // A save point or a restore the last run left half way is finished or aborted before anything else (docs/v2/TIMELINE.md); a
    // chat that never used the timeline has nothing to recover and costs one look.
    const line = timelines.get(registry);
    line?.settle?.();
    if (line?.needsRecovery()) await line.recover();
    // A restore barrier changes nothing until every part agrees (registry.setRestore).
    if (registry.restore?.().state === 'pending') return [];
    if (store.headIndex() < 0 || !store.head()) return [];
    if (!toldFailures.has(registry)) toldFailures.set(registry, new Set());
    const told = toldFailures.get(registry);
    const results = [];
    for (const { def, missing } of missingModules(registry, store.head())) {
        const result = await bus.command(`${INIT_PREFIX}${def.id}`, { domains: missing }, { cause: 'system' });
        if (result?.ok) events?.emit('committed', { receipt: result.receipt });
        else {
            const message = `${def.name ?? def.id} could not be set up in this chat: ${result?.message ?? 'unknown error'}`;
            if (!told.has(message)) console.warn(`[Story Suite] ${message}`);
            told.add(message);
        }
        results.push(result);
    }
    return results;
}

// ---- sdk.preflight (docs/v2/LIFECYCLE.md) --------------------------------------

/**
 * What Story Block can tell about a chat before `module` registers, with nothing written (no set-up,
 * receipt, record repair or save): `{ hostApi, hostVersion, storeVersion, classification, domains,
 * rulesVersion, rulesHash, peers, restore }` (docs/v2/LIFECYCLE.md has each field).
 *
 * `options`: { module (id), rulesVersion? (a whole number ≥ 1: the rules generation the caller runs),
 * domains? (the module's domain names), peers? (module ids it needs) }. A module marks its rules
 * generation by `rulesVersion` (a whole number) and `rulesHash` (text) at the root of any of its domain
 * slices; Story Block only reads them. Data it cannot read is `damaged`, never `empty`.
 */
export function preflight({ store, registry, chat = () => [], apiVersion = 2 }, options) {
    if (!isObject(options) || typeof options.module !== 'string' || !MODULE_ID_TEXT.test(options.module)) {
        throw new TypeError('Story Suite: preflight needs { module } with a module id (like "story-director").');
    }
    const wanted = options.rulesVersion;
    if (wanted !== undefined && wanted !== null && !(Number.isInteger(wanted) && wanted >= 1)) {
        throw new TypeError('Story Suite: preflight rulesVersion is a whole number from 1, or left out.');
    }
    const id = options.module;
    const def = registry.module?.(id) ?? null;
    // `domains` and `peers`, when given, are lists of valid names; a bad one throws, it is never left out
    // (a list that lost a name would read `empty`).
    const listed = (name, pattern) => {
        const list = options[name];
        if (list === undefined || list === null) return null;
        if (!Array.isArray(list) || list.some(item => typeof item !== 'string' || !pattern.test(item))) {
            throw new TypeError(`Story Suite: preflight ${name} is a list of ${name === 'domains' ? 'domain names (like "party")' : 'module ids (like "story-director")'}.`);
        }
        return list;
    };
    const domainNames = listed('domains', DOMAIN_TEXT) ?? (def ? Object.keys(def.domains ?? {}) : []);
    const peerIds = listed('peers', MODULE_ID_TEXT) ?? (def ? registry.peers(id).map(peer => peer.module) : []);

    const result = {
        hostApi: apiVersion,
        deferredDomains: true,
        hostVersion: registry.hostVersion?.() ?? '',
        storeVersion: null,
        classification: 'empty',
        domains: [],
        rulesVersion: null,
        rulesHash: null,
        peers: peerIds.map(peer => {
            const other = registry.module?.(peer) ?? null;
            return { module: peer, version: typeof other?.version === 'string' && other.version ? other.version : null, enabled: Boolean(other) && registry.lifecycle?.(peer)?.status !== 'dormant' };
        }),
        restore: registry.restore?.().state ?? 'idle',
    };
    const done = classification => Object.assign(result, { classification });

    // The chat's records, read as they are. Anything that cannot be read is damaged.
    let messages;
    let state;
    try {
        messages = chat();
        if (messages === undefined || messages === null) messages = [];
        if (!Array.isArray(messages)) return done('damaged');
        state = store.head();
    } catch {
        return done('damaged');
    }
    let version = null;
    let damaged = false;
    for (const message of messages) {
        if (!isCarrier(message)) continue;
        let record;
        try { record = message.extra?.[RECORD_KEY]; } catch { damaged = true; continue; }
        if (record === undefined) continue;
        if (!isObject(record) || !Number.isInteger(record.v) || record.v < STORE_VERSION) { damaged = true; continue; }
        version = Math.max(version ?? 0, record.v);
        if (record.v === STORE_VERSION && recordFault(message)) damaged = true;
    }
    if (state !== null && state !== undefined) {
        if (!isObject(state) || !Number.isInteger(state.v) || !isObject(state.domains)) damaged = true;
        else version = Math.max(version ?? 0, state.v);
    } else if (version === STORE_VERSION) damaged = true;   // records that did not replay into a state
    result.storeVersion = version;
    if (damaged) return done('damaged');
    if (version !== null && version > STORE_VERSION) return done('future');
    if (!state) return done('empty');

    // The module's own slices, and its rules marker: the `rules` slice's `rulesVersion` and `rulesHash` at its
    // root. Only that slice says which rules generation the data is; another slice that carries a marker is
    // read only to see whether it disagrees. A module without a `rules` domain has no marker to look for,
    // unless the caller asks for a generation.
    const has = name => Object.hasOwn(state.domains, name) && state.domains[name] !== undefined && state.domains[name] !== null;
    const present = domainNames.filter(has);
    const marked = domainNames.includes(RULES_DOMAIN) || (wanted !== undefined && wanted !== null);
    result.domains = present;
    if (!present.length) return done('empty');
    const markOf = name => {
        const slice = state.domains[name];
        if (!isObject(slice)) return undefined;
        if (!Object.hasOwn(slice, 'rulesVersion') && !Object.hasOwn(slice, 'rulesHash')) return null;
        const { rulesVersion, rulesHash = null } = slice;
        if (!(Number.isInteger(rulesVersion) && rulesVersion >= 1) || !(rulesHash === null || (typeof rulesHash === 'string' && rulesHash))) return undefined;
        return { rulesVersion, rulesHash };
    };
    const marks = new Map(present.map(name => [name, markOf(name)]));
    if ([...marks.values()].includes(undefined)) return done('damaged');
    if (!marked) return done('current');
    const rules = marks.get(RULES_DOMAIN) ?? null;   // none when the module has no such slice here
    if (!rules) return done('legacy');
    result.rulesVersion = rules.rulesVersion;
    result.rulesHash = rules.rulesHash;
    const conflict = [...marks.entries()].some(([name, mark]) => name !== RULES_DOMAIN && mark && (mark.rulesVersion !== rules.rulesVersion || (mark.rulesHash && rules.rulesHash && mark.rulesHash !== rules.rulesHash)));
    if (conflict) return done('mixed');
    if (wanted === undefined || wanted === null) return done('current');
    if (rules.rulesVersion > wanted) return done('future');
    return done(rules.rulesVersion < wanted ? 'legacy' : 'current');
}
