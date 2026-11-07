// Story Suite v2: the context a command handler receives (SPEC §3, MODULES §F2): reads and drafts, the calls it may make,
// rolls, IDs, claims, settings, features, queries and hooks, guards, proof, clock markers and the source/cursor it runs
// under. commands.js keeps createCommandBus and passes its lookups in; this part never imports commands.js.

import { clone, deepFreeze, escapeKey, frozenCopy } from '../ops.js';
import { deriveId, epochOf, guardProblem, hashJson, isPlainJson } from '../replay.js';
import { roll as rollDice } from '../rng.js';
import { CLOCK_COMMANDS, markerHash } from '../timeline/boundary.js';
import { capture as captureSnapshot } from '../timeline/manifest.js';
import { stateHash } from '../timeline/host-block.js';
import { BASE36, CODE, CommandError, ID_PREFIX, MAX_DEPTH, asCommandError, fail, isRecord } from './shared.js';

export function createCtxTools({
    registry, settings, resolve, featureOn, internal, internalMessage, findQuery, guardHook,
    sourceOf, cursorOf, currentState, queryTools, readOf, draftOf, metaOf, giveProof,
}) {
    function allocateId(tx, prefix) {
        if (typeof prefix !== 'string' || !ID_PREFIX.test(prefix)) fail('INVALID', `An id prefix is lowercase letters and digits (like "it"), not "${prefix}".`);
        let out = '';
        for (let n = 0; n < 8; n += 1) out += BASE36[Math.floor(tx.idRandom() * 36) % 36];
        return `${prefix}_${out}`;
    }

    function invoke(tx, type, target, payload, depth, caller = null) {
        const ctx = makeCtx(tx, target.moduleId, depth, caller, type);
        const out = target.handler(ctx, deepFreeze(clone(payload)));
        if (out && typeof out.then === 'function') {
            out.then(null, () => {});   // nobody waits on it; keep a late rejection quiet
            fail('FAILED', `${type} must finish at once: command handlers cannot wait (no async).`);
        }
        return out;
    }

    function makeCtx(tx, moduleId, depth, caller, type) {
        const open = () => {
            if (tx.closed) throw new Error('This command has already finished; its ctx cannot be used any more.');
        };
        return Object.freeze({
            receiptId: tx.receiptId,
            // A Re-read's capture (turn.js): the reply's state as it stood before the Re-read, read-only, so
            // per-reply bookkeeping that the reply's kept blocks (its clicks) wrote can be counted; else null.
            standing: tx.standing,
            // The receipts the reply being read again recorded (turn.js), read-only, else null.
            standingReceipts: tx.standingReceipts,
            cause: tx.cause,
            module: moduleId,
            caller,
            rev: tx.rev,
            // The epoch of the timeline this block is made in: the savepoints domain's, else the genesis epoch (a pure function of the state before it).
            epoch: epochOf(tx.head),
            // The Cursor (RB contract) the block of this command starts at: { sid, swipeKey, block, op, rev }, the same the host stamps as the block's
            // first boundary, and the same when the command is run again by a Re-read of an unchanged line. A function: it reads the chat.
            cursor() {
                open();
                return cursorOf(tx);
            },
            carrier: tx.carrier,
            chat: tx.chat,
            reply: tx.reply,
            // The Source a guarded block of this command will carry ({ sid, swipeKey, evidence, ordinal }), or
            // null when there is no reply to hold it (REPLAY.md). Never a numeric message or swipe index.
            get source() {
                return sourceOf(tx);
            },
            id: prefix => { open(); return allocateId(tx, prefix); },
            clockBoundary(input) {
                open();
                if (moduleId !== 'story-director' || !CLOCK_COMMANDS.includes(type) || tx.cause === 'ui') fail('REFUSED', 'Only a trusted SD clock command may mark a midnight.');
                if (!isRecord(input) || Object.keys(input).some(key => !['minute', 'source'].includes(key))) fail('INVALID', 'clockBoundary takes { minute, source }.');
                const source = sourceOf(tx);
                if (!source || hashJson(input.source ?? null) !== hashJson(source)) fail('REFUSED', 'A clock marker must carry this root source.');
                const minute = input.minute;
                const before = tx.head.domains?.director?.time?.minutes;
                const current = currentState(tx).domains?.director?.time?.minutes;
                const previous = tx.clockBoundaries.at(-1)?.minute;
                const next = Math.floor((previous === undefined ? before : previous) / 1440) * 1440 + 1440;
                if (!Number.isSafeInteger(before) || !Number.isSafeInteger(minute) || minute !== next || current !== minute) fail('INVALID', 'A marker must be the next crossed midnight, with the draft clock at that minute.');
                // E5 assigns this root's occurrence; no second allocator for ambiguous Re-reads.
                const root = cursorOf(tx);
                const entry = captureSnapshot({ registry, state: currentState(tx), settings });
                const cursor = { ...root, block: deriveId('bl', `clock:${root.block}:${minute}:${hashJson(entry)}`), op: tx.clockBoundaries.length + 1, rev: tx.rev };
                const marker = { minute, source: clone(source), cursor, entry, baseHash: stateHash(tx.head) };
                marker.prefixHash = markerHash(marker);
                const made = giveProof(tx, moduleId, { kind: 'event', payload: { clockBoundary: minute, prefixHash: marker.prefixHash } });
                marker.proof = made.id;
                marker.pin = tx.meta.proofs[made.id];
                tx.clockBoundaries.push(marker);
                return deepFreeze({ cursor: clone(cursor), prefixHash: marker.prefixHash });
            },
            read(domain) {
                open();
                return readOf(tx, domain);
            },
            draft(domain) {
                open();
                const owner = registry.domainOwner(domain);
                if (!owner) fail('NOT_OWNER', `There is no domain called "${domain}" for ${moduleId} to change.`);
                if (owner !== moduleId) fail('NOT_OWNER', `${moduleId} cannot change ${domain}: only ${owner} writes it (ask it through a command).`);
                return draftOf(tx, domain);
            },
            // `options.as` ("event:<id>") names the step a host handler runs for, as the sub-command's
            // ctx.caller (the events part's steps run as `event:<id>`); otherwise the caller is this module.
            call(type, payload, options) {
                open();
                const as = typeof options?.as === 'string' && /^event:[A-Za-z0-9][A-Za-z0-9._/:-]{0,119}$/.test(options.as) ? options.as : null;
                if (depth >= MAX_DEPTH) {
                    tx.failure ??= new CommandError('FAILED', `Commands called each other more than ${MAX_DEPTH} levels deep (at ${type}).`);
                    throw tx.failure;
                }
                const target = resolve(type, tx.again);   // UNKNOWN_COMMAND here has changed nothing
                if (tx.cause === 'ui' && internal(type)) {
                    tx.failure ??= new CommandError('REFUSED', internalMessage(type));
                    throw tx.failure;
                }
                try {
                    return invoke(tx, type, target, payload, depth + 1, as ?? moduleId);
                } catch (error) {
                    tx.failure ??= asCommandError(type, error);
                    throw error;
                }
            },
            rng() {
                open();
                return tx.random();
            },
            roll(expression) {
                open();
                try {
                    return rollDice(tx.random, expression);
                } catch (error) {
                    return fail('INVALID', error.message);
                }
            },
            // A count this command sets to a number rather than moves (a clock set to a date; SPEC §2.2):
            // its write keeps no `was`, so replay applies it as written and later moves add on top. It is
            // written even when it holds that number already, so replay after a delete sets it too.
            absolute(domain, path) {
                open();
                const owner = registry.domainOwner(domain);
                if (owner !== moduleId) fail('NOT_OWNER', `${moduleId} cannot set a count in ${domain}: only its owner can.`);
                if (typeof path !== 'string' || !/^\/[^~]/.test(path)) fail('INVALID', `A count to set is a path inside the domain, like "/time/minutes", not "${path}".`);
                tx.absolute.add(`/domains/${escapeKey(domain)}${path}`);
            },
            // This command's writes inside a thing (a thread, `/threads/th_x`) only make sense while it is
            // there (SPEC §2.2 rule d): marked `within` it, they are passed over on replay when the reply
            // that made it was deleted, and the rest of the block still applies.
            ifThere(domain, path) {
                open();
                const owner = registry.domainOwner(domain);
                if (owner !== moduleId) fail('NOT_OWNER', `${moduleId} cannot mark changes in ${domain}: only its owner can.`);
                if (typeof path !== 'string' || !/^\/[^~]/.test(path)) fail('INVALID', `A thing to mark is a path inside the domain, like "/threads/th_x", not "${path}".`);
                tx.within.add(`/domains/${escapeKey(domain)}${path}`);
            },
            // This command's appends to the list at `path` (`add <path>/-`) are a set's: whoever is added is there
            // once. Marked `unique`, they are passed over on replay when the list holds that item already
            // (the reply that dropped it was deleted), instead of listing it twice (SPEC §2.2 rule e).
            unique(domain, path) {
                open();
                const owner = registry.domainOwner(domain);
                if (owner !== moduleId) fail('NOT_OWNER', `${moduleId} cannot mark changes in ${domain}: only its owner can.`);
                if (typeof path !== 'string' || !/^\/[^~]/.test(path)) fail('INVALID', `A list to mark is a path inside the domain, like "/present", not "${path}".`);
                tx.unique.add(`/domains/${escapeKey(domain)}${path}`);
            },
            // The Hash of the contract (§4): SHA-256 of normalized JSON (sorted keys, array order kept).
            hash(value) {
                open();
                if (!isPlainJson(value)) fail('INVALID', 'Only plain JSON can be hashed.');
                return hashJson(value);
            },
            // Attaches this module's guard to the command's root transaction (REPLAY.md, contract §6): on replay
            // the block is applied, with its claims, only while the owner's `hooks.replayGuard` says its guard
            // holds. The host stamps the source, the block id and the authority; the guard's owner must be the
            // module calling, which must have a replayGuard hook. Nested commands share the root's guard: the
            // same guard again is fine, another one is a CONFLICT. `recorded` (plain JSON, optional) is the
            // durable inputs and draws the hook is given back.
            replayGuard(guard, recorded) {
                open();
                const problem = guardProblem(guard);
                if (problem) fail('INVALID', `That is not a guard: ${problem}.`);
                if (guard.owner !== moduleId) fail('REFUSED', `${moduleId} cannot attach ${guard.owner}'s guard: a module attaches its own.`);
                if (!guardHook(moduleId)) fail('REFUSED', `${moduleId} has no replayGuard hook, so a guard of its own could not be checked on replay.`);
                if (recorded !== undefined && !isPlainJson(recorded)) fail('INVALID', 'A guard\'s recorded inputs must be plain JSON.');
                if (!sourceOf(tx)) fail('FAILED', 'There is no reply yet to hold a guarded block.');
                if (tx.guard) {
                    if (hashJson(tx.guard) !== hashJson(guard) || (recorded !== undefined && hashJson(tx.recorded) !== hashJson(recorded))) {
                        fail('CONFLICT', 'This command already has a guard; a nested command shares it and cannot attach another.');
                    }
                    return;
                }
                tx.guard = deepFreeze(clone(guard));
                tx.recorded = recorded === undefined ? null : deepFreeze(clone(recorded));
            },
            // Gives proof (contract §6, docs/v2/EVIDENCE.md): only the module that owns `kind` may, and only as part of
            // a command's root transaction; the host stamps the id, the Source and the payload hash. An identical
            // call again returns the same id; the same key with other contents is a CONFLICT. The proof is
            // published only when the root commits, on this command's block, and only while that block applies.
            proof(spec) {
                open();
                return giveProof(tx, moduleId, spec);
            },
            claim(key) {
                open();
                if (typeof key !== 'string' || !key) fail('INVALID', 'A claim key must be non-empty text.');
                const claims = metaOf(tx).claims;
                if (Object.hasOwn(claims, key)) return false;
                Object.defineProperty(claims, key, { value: true, enumerable: true, writable: true, configurable: true });
                return true;
            },
            query(name, args) {
                open();
                const fn = findQuery(name);
                if (!fn) fail('NOT_FOUND', `There is no query called "${name}".`);
                const state = currentState(tx);
                return frozenCopy(fn(state, deepFreeze(clone(args)), queryTools(tx, state)));
            },
            settings(id = moduleId) {
                return deepFreeze(clone(settings(id) ?? {}));
            },
            // Whether feature `id` is on for this reader (MODULES §F100); false for an id no module declares.
            // A Re-read run `again` sees every declared feature on, as it ran when the line was first read.
            feature(id) {
                return featureOn(id) || (tx.again === true && Boolean(registry.feature?.(id)));
            },
            // Every other module's answer to hook `name` on the state this command sees (MODULES §F126): each
            // module's `hooks[name]({ state, query }, args)`, synchronous. An answer that is null, a promise,
            // or a throw is left out, so asking is always safe: [{ module, answer }] in module order, frozen
            // copies. An example module asks `checkModifiers` before a check is resolved.
            gather(name, args) {
                open();
                if (typeof name !== 'string' || !name) fail('INVALID', 'gather needs a hook name.');
                const state = currentState(tx);
                const tools = queryTools(tx, state);
                const view = Object.freeze({ state, query: tools.query });
                const out = [];
                for (const entry of registry.hookEntries?.(name) ?? []) {
                    if (entry.moduleId === moduleId) continue;
                    let answer;
                    try {
                        answer = entry.fn(view, deepFreeze(clone(args ?? {})));
                        if (answer === undefined || answer === null || typeof answer?.then === 'function') continue;
                        out.push(Object.freeze({ module: entry.moduleId, answer: deepFreeze(clone(answer)) }));
                    } catch {
                        continue;
                    }
                }
                return Object.freeze(out);
            },
            // The Director's minutes: its `director.time` query when one is registered, else the
            // `director.time.minutes` of the state (SPEC §8), else null.
            time() {
                open();
                const fn = findQuery('director.time');
                const state = fn ? currentState(tx) : null;
                const value = fn ? fn(state, deepFreeze({}), queryTools(tx, state)) : readOf(tx, 'director')?.time;
                const minutes = isRecord(value) ? value.minutes : value;
                return Number.isInteger(minutes) ? minutes : null;
            },
            fail(code, message) {
                const known = typeof code === 'string' && CODE.test(code);
                throw new CommandError(known ? code : 'FAILED', String(message ?? 'The command was refused.'));
            },
        });
    }

    return { makeCtx, invoke };
}
