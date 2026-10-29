// The all-domain payload and version manifest (contract §8; docs/v2/TIMELINE.md). A snapshot captures every domain the
// state holds, found by looking at the registry and the state themselves: there is no list of domains kept by hand, so a
// module that registers a domain tomorrow is captured tomorrow. A restore installs the captured slices absolutely and says,
// domain by domain, where each came from.
//
// Pure: the registry and the state in, a payload or a plan out; nothing is stored here.

import { apply, checkOps, escapeKey } from '../ops.js';
import { hashJson, isHash } from '../replay.js';
import { GENESIS_EPOCH, HOST_DOMAIN } from './gate.js';
import { fail, isObject } from './util.js';

export const SCHEMA = 2;

/** The domain definition a registered domain is declared with, or null (unregistered: an orphan, or the host's own). */
export function domainDef(registry, name) {
    const owner = registry.domainOwner?.(name);
    return owner ? registry.module?.(owner)?.domains?.[name] ?? null : null;
}

/** A domain's version: `version` on its definition (a whole number from 1), else 1. */
export function versionOf(def) {
    return Number.isInteger(def?.version) && def.version >= 1 ? def.version : 1;
}

/** Every domain the registry knows, [{ name, owner, version }] sorted by name. */
export function registered(registry) {
    const out = [];
    for (const def of registry.modules?.() ?? []) {
        for (const name of Object.keys(def.domains ?? {})) out.push({ name, owner: def.id, version: versionOf(def.domains[name]) });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The payload of contract §8 for `state`: `{ schema: 2, domains, storyClaims, effectiveSettings, domainVersions,
 * participants }`, with the proof pins the story held beside it (`proofs`), and the manifest of what was found:
 * `{ registered, held, absent, orphans }`. `participants` is left empty: the coordinator fills it from the
 * checkpoints it asks for.
 * * every domain of the state is captured (a registered one, an orphan whose module is gone, the host's savepoints);
 * * a registered domain the state does not hold (not set up yet) is listed as absent and is not invented;
 * * `effectiveSettings`: for each module that names the settings that are rules (`settings.rules`, a list of keys), their
 *   values as they are now.
 */
export function capture({ registry, state, settings = () => ({}) }) {
    const domains = structuredClone(state?.domains ?? {});
    // Opt-in deferred domains leave no snapshot metadata before first use. Other domains keep
    // their existing absent/default contract, including deferred domains without this flag.
    const names = registered(registry).filter(item => domainDef(registry, item.name)?.snapshot !== 'when-present' || Object.hasOwn(domains, item.name));
    const known = new Set(names.map(item => item.name));
    const domainVersions = {};
    for (const name of Object.keys(domains).sort()) domainVersions[name] = versionOf(domainDef(registry, name));
    const effectiveSettings = {};
    for (const def of registry.modules?.() ?? []) {
        const keys = def.settings?.rules;
        if (!Array.isArray(keys) || !keys.length) continue;
        let values = {};
        try { values = settings(def.id) ?? {}; } catch { values = {}; }
        const picked = {};
        for (const key of keys) if (typeof key === 'string' && Object.hasOwn(values, key)) picked[key] = structuredClone(values[key]);
        effectiveSettings[def.id] = picked;
    }
    const claims = isObject(state?.meta?.claims) ? state.meta.claims : {};
    const storyClaims = {};
    for (const key of Object.keys(claims).sort()) storyClaims[key] = true;
    const payload = { schema: SCHEMA, domains, storyClaims, effectiveSettings, domainVersions, participants: [] };
    const proofs = isObject(state?.meta?.proofs) ? structuredClone(state.meta.proofs) : {};
    const manifest = {
        registered: names,
        held: names.filter(item => Object.hasOwn(domains, item.name)).map(item => item.name),
        absent: names.filter(item => !Object.hasOwn(domains, item.name)).map(item => item.name),
        orphans: Object.keys(domains).filter(name => !known.has(name) && name !== HOST_DOMAIN).sort(),
    };
    return { payload, proofs, manifest };
}

/** '' when `payload` is a snapshot payload of this schema, else why not. */
export function payloadProblem(payload) {
    if (!isObject(payload)) return 'the saved payload is not a record';
    if (payload.schema !== SCHEMA) return `the saved payload is schema ${payload.schema}, not ${SCHEMA}`;
    if (!isObject(payload.domains) || Object.values(payload.domains).some(slice => !isObject(slice))) return 'its domains are not records';
    if (!isObject(payload.storyClaims) || !isObject(payload.effectiveSettings) || !isObject(payload.domainVersions)) return 'it lacks its claims, settings or versions';
    if (!Array.isArray(payload.participants)) return 'it lacks its participants';
    return '';
}

/** The sentences that say why a savepoints domain is not whole; [] when it is. */
export function savepointsProblems(domain) {
    if (!isObject(domain)) return ['The savepoints are not a record.'];
    const out = [];
    if (domain.schema !== SCHEMA) out.push('The savepoints are not schema 2.');
    if (typeof domain.epoch !== 'string' || !domain.epoch) out.push('The savepoints name no epoch.');
    for (const key of ['points', 'dayStarts', 'returns', 'ruleSettings']) if (!isObject(domain[key])) out.push(`The savepoints' ${key} are not a record.`);
    if (domain.previousDay !== null && typeof domain.previousDay !== 'string') out.push('The savepoints\' previousDay is not an id or null.');
    for (const [id, point] of Object.entries(isObject(domain.points) ? domain.points : {})) {
        if (!isObject(point) || point.id !== id || !isHash(point.payloadHash)) out.push(`The save point ${id} is not whole.`);
    }
    return out;
}

/** A fresh savepoints domain: schema 2, the given epoch, no points, no returns. */
export const initialSavepoints = (epoch = GENESIS_EPOCH) => ({ schema: SCHEMA, epoch, points: {}, dayStarts: {}, previousDay: null, returns: {}, ruleSettings: {} });

/** The start of the day before the newest day that has one (contract §8 step 1), else null. `dayStarts` is day -> snapshot id. */
export function previousDayOf(dayStarts) {
    const days = Object.keys(isObject(dayStarts) ? dayStarts : {}).map(Number).filter(Number.isSafeInteger);
    if (!days.length) return null;
    const before = dayStarts[String(Math.max(...days) - 1)];
    return typeof before === 'string' ? before : null;
}

/**
 * Plans a restore: the ops that install the payload of `entry` on `state` absolutely, and the manifest that says where each
 * domain came from. → `{ ok: true, ops, manifest, manifestHash, next }` or a failure (`SNAPSHOT_UNAVAILABLE` for bytes,
 * versions or slices that cannot be used). Nothing is applied.
 * * every captured domain is installed as saved (`add` at the domain: whatever is there is replaced, and a domain that is
 *   not there yet is made, so replaying the block on another state gives the same slice, never a difference);
 * * a domain saved at an older version goes through its definition's `migrate(slice, { from, to })`; one saved by a newer
 *   version cannot be used;
 * * a registered domain the state holds and the payload does not (it came after the save) is brought to its definition's
 *   `absent()` slice; without one the restore cannot be done. An unregistered domain the payload lacks is removed: nothing
 *   after the save is kept;
 * * the story claims go back to the saved set and the proof pins to the saved pins (the proof of the faded story is no
 *   longer active); a saved pin the story no longer has cannot be put back;
 * * the savepoints domain is the saved one, in the new epoch, with the selected point's descriptor and the return added
 *   (earlier returns stay: they are the audit);
 * * every registered validator is asked of the result, and each must pass.
 */
export function planRestore({ registry, state, entry, descriptor, returnRecord, newEpoch, deathEvents, batchResult }) {
    const payload = entry?.payload;
    const bad = payloadProblem(payload);
    if (bad) return fail('SNAPSHOT_UNAVAILABLE', `The save point's bytes cannot be used: ${bad}.`);
    // The proof pins the story held are part of what the save is (its payloadHash covers them): bytes without them are not bytes.
    if (!isObject(entry.proofs)) return fail('SNAPSHOT_UNAVAILABLE', 'The save point\'s proof pins are missing from its bytes.');
    const pins = entry.proofs;
    const ops = [];
    const listing = {};
    const have = isObject(state?.domains) ? state.domains : {};
    // Every domain there is: the registry's (whether or not the state holds it), the state's and the save's.
    const names = [...new Set([...registered(registry).map(item => item.name), ...Object.keys(payload.domains), ...Object.keys(have)])].filter(name => name !== HOST_DOMAIN).sort();
    for (const name of names) {
        const path = `/domains/${escapeKey(name)}`;
        const def = domainDef(registry, name);
        const saved = Object.hasOwn(payload.domains, name);
        const here = Object.hasOwn(have, name);
        const now = versionOf(def);
        if (saved) {
            let slice = payload.domains[name];
            let from = Number.isInteger(payload.domainVersions[name]) && payload.domainVersions[name] >= 1 ? payload.domainVersions[name] : 1;
            let source = def ? 'saved' : 'orphan';
            if (def && from > now) return fail('SNAPSHOT_UNAVAILABLE', `The domain ${name} was saved by a newer version (${from}) than this one reads (${now}).`);
            if (def && from < now) {
                if (typeof def.migrate !== 'function') return fail('SNAPSHOT_UNAVAILABLE', `The domain ${name} was saved at version ${from}, this is ${now}, and it has no migrate() to bring the save forward.`);
                try { slice = def.migrate(structuredClone(slice), { from, to: now }); } catch (error) {
                    return fail('SNAPSHOT_UNAVAILABLE', `The domain ${name} could not be migrated from version ${from}: ${error?.message ?? error}`);
                }
                if (!isObject(slice)) return fail('SNAPSHOT_UNAVAILABLE', `The migration of the domain ${name} gave no record.`);
                source = 'migrated';
            } else if (!def) from = Number.isInteger(from) ? from : 1;
            ops.push({ op: 'add', path, value: structuredClone(slice) });
            listing[name] = { version: def ? now : from, source, hash: hashJson(slice) };
        } else if (def || here) {
            if (def?.deferred === true && def.snapshot === 'when-present') {
                if (here) { ops.push({ op: 'remove', path }); listing[name] = { version: now, source: 'removed', hash: null }; }
                continue;
            }
            if (def) {
                if (typeof def.absent !== 'function') return fail('SNAPSHOT_UNAVAILABLE', `The domain ${name} came after this save and says nothing of how to restore without it (no absent() on its definition).`);
                let slice;
                try { slice = def.absent(); } catch (error) { return fail('SNAPSHOT_UNAVAILABLE', `The default of the domain ${name} could not be made: ${error?.message ?? error}`); }
                if (!isObject(slice)) return fail('SNAPSHOT_UNAVAILABLE', `The default of the domain ${name} is no record.`);
                ops.push({ op: 'add', path, value: structuredClone(slice) });
                listing[name] = { version: now, source: 'default', hash: hashJson(slice) };
            } else {
                ops.push({ op: 'remove', path });
                listing[name] = { version: 1, source: 'removed', hash: null };
            }
        }
    }

    // The savepoints domain: the saved one, in the new epoch, with the selected point and the return.
    const base = isObject(payload.domains[HOST_DOMAIN]) ? structuredClone(payload.domains[HOST_DOMAIN]) : initialSavepoints();
    const earlier = isObject(have[HOST_DOMAIN]?.returns) ? have[HOST_DOMAIN].returns : {};
    const points = { ...(isObject(base.points) ? base.points : {}), [descriptor.id]: structuredClone(descriptor) };
    // The save was captured before its own descriptor existed, so the anchor index lacks its entry: it is overlaid, and the
    // start of the previous day is worked out again from the index (an entry whose point is not there goes).
    const dayStarts = Object.fromEntries(Object.entries(isObject(base.dayStarts) ? base.dayStarts : {}).filter(([, id]) => Object.hasOwn(points, id)));
    if (descriptor.kind === 'day-start' && Number.isSafeInteger(descriptor.day)) dayStarts[String(descriptor.day)] = descriptor.id;
    const host = {
        schema: SCHEMA, epoch: newEpoch, points, dayStarts, previousDay: previousDayOf(dayStarts),
        returns: { ...structuredClone(earlier), [returnRecord.id]: structuredClone(returnRecord) },
        // The rule settings the save was made under become the chat's (the overlay modules read in preference to the global ones).
        ruleSettings: structuredClone(payload.effectiveSettings),
    };
    ops.push({ op: 'add', path: `/domains/${escapeKey(HOST_DOMAIN)}`, value: host });
    listing[HOST_DOMAIN] = { version: 1, source: 'host', hash: hashJson(host) };

    // Story claims back to the saved set: the ones the faded story made go, the saved ones the story lacks are put back.
    const claims = isObject(state?.meta?.claims) ? state.meta.claims : null;
    const saved = Object.keys(payload.storyClaims).sort();
    if (claims === null) {
        if (saved.length) ops.push({ op: 'add', path: '/meta/claims', value: Object.fromEntries(saved.map(key => [key, true])) });
    } else {
        for (const key of Object.keys(claims).sort()) if (!Object.hasOwn(payload.storyClaims, key)) ops.push({ op: 'remove', path: `/meta/claims/${escapeKey(key)}` });
        for (const key of saved) if (!Object.hasOwn(claims, key)) ops.push({ op: 'add', path: `/meta/claims/${escapeKey(key)}`, value: true });
    }

    // Proof pins back to the saved pins: the proof the faded story gave is not active any more.
    const current = isObject(state?.meta?.proofs) ? state.meta.proofs : {};
    for (const id of Object.keys(pins).sort()) {
        if (current[id] !== pins[id]) return fail('SNAPSHOT_UNAVAILABLE', `The proof ${id} the save held is not pinned by the story any more, and a restore cannot give it back.`);
    }
    for (const id of Object.keys(current).sort()) if (!Object.hasOwn(pins, id)) ops.push({ op: 'remove', path: `/meta/proofs/${escapeKey(id)}` });

    // Every registered validator is asked of what the restore would leave.
    let next;
    const all = [...ops, { op: 'replace', path: '/meta/rev', value: (Number.isInteger(state?.meta?.rev) ? state.meta.rev : 0) + 1 }];
    const rules = checkOps(all);
    if (rules.length) return fail('SNAPSHOT_UNAVAILABLE', `The save point breaks the state's generic rules, so it is not restored: ${rules.join(' ')}`);
    try {
        next = apply(state, all);
    } catch (error) {
        return fail('FAILED', `The save could not be installed: ${error?.message ?? error}`);
    }
    const problems = [];
    for (const item of registered(registry)) {
        if (!Object.hasOwn(next.domains, item.name)) continue;
        const validate = registry.validator?.(item.name);
        if (typeof validate !== 'function') continue;
        try {
            const errors = validate(next.domains[item.name], next);
            if (Array.isArray(errors)) problems.push(...errors.map(String));
        } catch (error) {
            problems.push(`The ${item.name} check itself failed: ${error?.message ?? error}`);
        }
    }
    problems.push(...savepointsProblems(next.domains[HOST_DOMAIN]));
    if (problems.length) return fail('SNAPSHOT_UNAVAILABLE', `The save point does not pass today's checks, so it is not restored: ${problems.join(' ')}`);

    const manifest = {
        schema: SCHEMA, snapshot: descriptor.id, payloadHash: descriptor.payloadHash, return: returnRecord.id,
        oldEpoch: state?.domains?.[HOST_DOMAIN]?.epoch ?? GENESIS_EPOCH, newEpoch,
        target: descriptor.target, restoreAt: returnRecord.restoreAt, deathEvents: [...deathEvents], batchResult: { ...batchResult },
        domains: listing, claims: hashJson(payload.storyClaims), proofs: hashJson(pins), settings: hashJson(payload.effectiveSettings),
        participants: [...descriptor.participants].sort((a, b) => (a.module < b.module ? -1 : a.module > b.module ? 1 : 0)),
    };
    return { ok: true, ops, manifest, manifestHash: hashJson(manifest), next };
}
