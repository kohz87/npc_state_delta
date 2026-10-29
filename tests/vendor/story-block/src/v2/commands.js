// The command bus (SPEC §3): every change to v2 state is a command. A handler reads frozen copies,
// writes mutable drafts of the domains its module owns, may call other modules' commands inside the
// same transaction, and returns { summary, narrate, data }. The bus then diffs the drafts into ops,
// checks them (generic rules, then each touched domain's validator), bumps `meta.rev` as one more op
// and hands ops + receipt to the store. Anything that throws on the way rejects the whole command and
// leaves the store untouched. Synchronous: handlers cannot await, so neither does the bus (the public
// sdk may wrap the results in promises).
//
// Transaction rules worth knowing:
// * One set of drafts per command: a sub-command that drafts the same domain writes the same draft,
//   and `ctx.read` / `ctx.query` see the transaction's drafts, not just the head.
// * A sub-command that throws fails the whole command, even if the caller catches the error (its
//   half-written drafts cannot be told apart from the caller's). A `ctx.call` to a command that does
//   not exist throws UNKNOWN_COMMAND without failing the command, since nothing ran: a handler may
//   catch it to treat the other module as absent.
// * Every committed receipt bumps `meta.rev` by one, even when it changed nothing else, so each
//   receipt has its own rev.
// * What a handler is told about where it runs (MODULES §F2, the capture context): `ctx.caller` is the
//   module whose handler made this ctx.call (null at the top), `ctx.rev` the meta.rev this receipt will
//   have, `ctx.id(prefix)` a new `<prefix>_<8 base36>` drawn from the receipt's seed (so the same seed
//   gives the same IDs, and ctx.rng() is not disturbed), and, for capture runs, `ctx.carrier`
//   ({ index, swipe, key }) and `ctx.chat` ({ lastUser, reply }); both are null for other commands.
//   `ctx.reply` ({ index, sid }) is the reply the command's changes are stored on, for every command:
//   the capture's carrier, else the head carrier (the last reply, where store.append puts a click's
//   ops, SPEC §2.2); null when the chat has no reply yet. Queries get the same as `tools.reply`, so
//   per-reply bookkeeping (a budget tally under the reply's sid) can be read and kept for a click too.
// * Internal commands (registry.isInternal: capture.*, module.init.*, events.fire) are refused with
//   REFUSED when the cause is 'ui', whether named at the top or through ctx.call.
// * Guarded blocks (docs/v2/REPLAY.md, contract §6): `ctx.replayGuard(guard, recorded?)` attaches the owner's
//   requirements to the command's root transaction (nested commands share it). The bus stamps the
//   receipt's `data.v2` with the host's Source and the guard, and hands the store a `block` (module,
//   source, guard, operation, recorded, result) to keep on the block's span; the store adds the block id,
//   the claims the ops make and the boundary. On replay the owner's `hooks.replayGuard` is asked
//   (`replayGuardCheck`); a throw or a malformed answer fails closed. `ctx.source` is the Source the block
//   will carry (null without a reply), `ctx.hash(value)` the contract's Hash.
// * Proof (docs/v2/EVIDENCE.md, contract §6): `ctx.proof({ kind, payload, parents? })` → `{ id, payloadHash }`, for
//   the module that owns the kind, inside the root transaction (evidence.js `submitProof` does the checks). The
//   proof is kept on the block's span (a command that gives proof makes a block even without a guard) and
//   pinned in `meta.proofs` by the same ops, so a block that does not apply, or a rolled-back root, publishes
//   nothing. A nested command reads the root's pending proof through `story.evidence` (the query's tools have
//   `pendingProofs`); a public query sees what is stored and pinned.
// * A command under a feature the reader turned off (MODULES §F100, registry.commandFeature) is refused
//   with FEATURE_OFF, at the top or through ctx.call; like UNKNOWN_COMMAND, nothing has run, so a
//   ctx.call caller may catch it. `ctx.feature(id)` says whether a feature is on.

import { apply, checkOps, clone, counterInside, deepFreeze, diff, escapeKey, frozenCopy, isCounterPath, isDeepFrozen, isJson, valueAt } from './ops.js';
import { DM_LIMITS } from './data-modules/schema.js';
import { isSeed, rng as makeRng, roll as rollDice, seed as freshSeed } from './rng.js';
import { blockIdOf, deriveId, epochOf, guardProblem, hashJson, isPlainJson } from './replay.js';
import { CLOCK_COMMANDS, markerHash } from './timeline/boundary.js';
import { capture as captureSnapshot } from './timeline/manifest.js';
import { stateHash } from './timeline/host-block.js';
import { newRoot, occurrenceOf, operationKey, receiptEvidence, submitProof } from './evidence.js';

export const MAX_DEPTH = 8;
const CAUSES = ['ui', 'story', 'system'];
const CODE = /^[A-Z][A-Z0-9_]*$/;
const MAX_PREVIEWS = 16;
const ID_PREFIX = /^[a-z][a-z0-9]*$/;
const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
// Mixed into the receipt's seed for ctx.id's own stream (any odd constant; fixed, so IDs replay).
const ID_STREAM = 0x5bd1e995;

/** The error `ctx.fail` throws; the bus turns it into { ok: false, code, message }. */
export class CommandError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'CommandError';
        this.code = code;
    }
}

function fail(code, message) {
    throw new CommandError(code, message);
}

function asCommandError(type, error) {
    if (error instanceof CommandError) return error;
    return new CommandError('FAILED', `Something went wrong in ${type}: ${error?.message ?? String(error)}`);
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// `{ index, sid }` frozen, or null without a usable sid.
function replyOf(index, sid) {
    return Number.isInteger(index) && index >= 0 && typeof sid === 'string' && sid ? Object.freeze({ index, sid }) : null;
}

/**
 * The reply a command outside a capture is stored on (`ctx.reply`): the head carrier, store.append's,
 * with the record ID its record has or will get (store.carrierSid). null for a store that cannot say.
 */
export function headReply(store) {
    try {
        const index = typeof store?.headIndex === 'function' ? store.headIndex() : -1;
        return typeof store?.carrierSid === 'function' && Number.isInteger(index) && index >= 0 ? replyOf(index, store.carrierSid(index)) : null;
    } catch {
        return null;
    }
}

/** `<prefix>_<8 base36>` from crypto (SPEC §2.1), for receipt IDs when no `id` option is given. */
export function newId(prefix, cryptoApi = globalThis.crypto) {
    if (typeof cryptoApi?.getRandomValues !== 'function') throw new Error('This browser has no crypto random source for IDs.');
    const chars = [];
    const bytes = new Uint8Array(16);
    while (chars.length < 8) {
        cryptoApi.getRandomValues(bytes);
        // 252 = 7 × 36: bytes at or above it are thrown away so every character is equally likely.
        for (const byte of bytes) if (byte < 252 && chars.length < 8) chars.push((byte % 36).toString(36));
    }
    return `${prefix}_${chars.join('')}`;
}

/**
 * createCommandBus({ store, registry, settings, onCommitted?, id?, seed? })
 * `store` and `registry` as in SPEC §12; `settings(moduleId)` → that module's settings object;
 * `onCommitted({ receipt, ops })` runs after each commit; `id(prefix)` and `seed()` replace the crypto
 * sources (tests).
 */
export function createCommandBus({ store, registry, settings = () => ({}), onCommitted = null, id = newId, seed = freshSeed } = {}) {
    const previews = new Map();
    let previewCount = 0;

    // `again` (a Re-read of a line that made a change before, turn.js): its features are not checked.
    function resolve(type, again = false) {
        // A module held back (dormant, or a restore is pending; registry.refusal) is refused with its reason, at
        // the top, through ctx.call and on commit; like UNKNOWN_COMMAND nothing has run, so a caller may catch it.
        const held = typeof type === 'string' && type && typeof registry.refusal === 'function' ? registry.refusal(type) : null;
        if (held) fail(held.code, held.message);
        const handler = typeof type === 'string' && type ? registry.command(type) : null;
        const moduleId = typeof handler === 'function' ? registry.commandOwner(type) : null;
        if (typeof handler !== 'function' || !moduleId) fail('UNKNOWN_COMMAND', `There is no command called "${type}".`);
        const feature = typeof registry.commandFeature === 'function' ? registry.commandFeature(type) : null;
        if (feature && !again && !featureOn(feature)) featureOff(type, feature);
        return { moduleId, handler };
    }

    const featureOn = id => typeof registry.featureOn === 'function' && registry.featureOn(id) === true;
    function featureOff(type, feature) {
        const label = registry.feature?.(feature)?.label ?? feature;
        fail('FEATURE_OFF', `"${type}" is part of ${label}, which is turned off in the Features settings.`);
    }

    // Internal commands (registry.js) are the host's own steps: never with cause 'ui'.
    const internal = type => typeof registry.isInternal === 'function' && registry.isInternal(type);
    const internalMessage = type => `"${type}" is a step Story Block takes itself (a change line, a module's set-up or an event); a button, screen or module action cannot run it.`;

    function findQuery(name) {
        if (typeof registry.query === 'function') {
            const fn = registry.query(name);
            if (typeof fn === 'function') return fn;
        }
        for (const def of registry.modules?.() ?? []) {
            const fn = def?.queries?.[name];
            if (typeof fn === 'function' && fn.enabled !== false) return fn;
        }
        return null;
    }

    // ---- guards (REPLAY.md) ------------------------------------------------------------------

    // The module's own `hooks.replayGuard`, whatever its features say: replaying a chat must not depend on
    // what the reader turned off since.
    function guardHook(moduleId) {
        for (const def of registry.modules?.() ?? []) if (def?.id === moduleId) return typeof def.hooks?.replayGuard === 'function' ? def.hooks.replayGuard : null;
        return null;
    }

    // The context a guard is asked in on replay (REPLAY.md "Guards are pure"): the state before its block and what it recorded,
    // nothing else. `query` answers only the queries its owner module declares as replay-safe (`replayQueries: [names]`: they
    // depend on the state and their arguments alone, not on settings, the clock or other messages); anything else, and
    // `receipts()` (the chat after the block is not part of what it was recorded over), throws, which fails the guard closed.
    // What a guard needs from outside (a setting, a currency rule) is read when the block is planned and handed to
    // `ctx.replayGuard(guard, recorded)`, and comes back from the record.
    // `story.evidence` is the host's own and is always allowed: it reads the state's pins and the proof of the blocks that applied
    // before the block (the prefix), and nothing else (docs/v2/EVIDENCE.md).
    function replayQuery(owner, name) {
        if (name === 'story.evidence') return findQuery(name);
        for (const def of registry.modules?.() ?? []) {
            if (def?.id === owner && typeof def.queries?.[name] === 'function' && Array.isArray(def.replayQueries) && def.replayQueries.includes(name)) return def.queries[name];
        }
        return null;
    }
    function replayTools(owner, state) {
        const tools = Object.freeze({
            reply: null,
            query(name, args) {
                const fn = replayQuery(owner, name);
                if (!fn) throw new Error(`"${name}" is not a query a guard may ask on replay: ${owner} lists the ones that depend on the state alone in replayQueries; anything else it needs it records`);
                return frozenCopy(fn(state, deepFreeze(clone(args)), tools));
            },
            receipts() {
                throw new Error('a guard does not see receipts on replay: only the state before its block and what it recorded');
            },
        });
        return tools;
    }

    // What the store asks on replay: `hooks.replayGuard({ state, query, hash }, { guard, source, block,
    // operation, recorded, payload: { saved, current } })` of the guard's owner, on the state before the block. { ok: true } or { ok: false,
    // reason }; no hook, a throw, a promise or a malformed answer is { ok: false } (fails closed).
    function replayGuardCheck(state, info) {
        const owner = info?.guard?.owner;
        const hook = typeof owner === 'string' ? guardHook(owner) : null;
        if (!hook) return { ok: false, reason: `${owner} has no replayGuard hook to check it` };
        // A module that is held back (dormant, or the restore barrier is up) is not asked: its blocks stay off
        // until it is ready, and are asked again then (the store looks again when the mark changes).
        if (registry.held?.(owner) === true) return { ok: false, reason: `${owner} is not ready` };
        let answer;
        try {
            const tools = replayTools(owner, state);
            const view = Object.freeze({ state, query: tools.query, hash: hashJson });
            answer = hook(view, deepFreeze(clone({ guard: info.guard, source: info.source, block: info.block, operation: info.operation, recorded: info.recorded ?? null, payload: info.payload ?? null })));
        } catch (error) {
            // The store records thrown guards even when this is a tentative plan that will not be stored.
            throw error;
        }
        if (answer && typeof answer.then === 'function') {
            answer.then(null, () => {});
            return { ok: false, reason: `${owner}'s replayGuard did not answer at once` };
        }
        if (isRecord(answer) && answer.ok === true) return { ok: true };
        if (isRecord(answer) && answer.ok === false && typeof answer.reason === 'string' && answer.reason) return { ok: false, reason: answer.reason };
        return { ok: false, reason: `${owner}'s replayGuard gave an answer that is neither { ok: true } nor { ok: false, reason }` };
    }

    // Changes when a module with a guard hook registers, goes, or turns ready or dormant: the store looks again at
    // its guarded blocks.
    // A checkpoint over guarded blocks keeps the mark it was made under (store.js chain): a different owner set, or a new
    // version of an owner (its guard code may answer otherwise), makes it fail and the prefix replays with the guards asked.
    // (the host's own hook, `hostOwned`, answers from the story alone, whoever is ready: it is no owner whose readiness changes an answer)
    const guardMark = () => (registry.modules?.() ?? [])
        .filter(def => typeof def?.hooks?.replayGuard === 'function' && def.hooks.replayGuard.hostOwned !== true && registry.held?.(def.id) !== true).map(def => `${def.id}@${def.version ?? ''}`).join(',');
    if (typeof store.attachGuard === 'function') store.attachGuard(replayGuardCheck, guardMark);

    // The Source this transaction's block will carry: its reply's canonical pair and ordinal (store.sourceAt).
    function sourceOf(tx) {
        if (tx.source === undefined) {
            let found = null;
            if (Number.isInteger(tx.reply?.index) && typeof store.sourceAt === 'function') {
                try { found = store.sourceAt(tx.reply.index, { pending: tx.pending, ordinal: tx.ordinal }); } catch { found = null; }
            }
            tx.source = found ? Object.freeze(found) : null;
        }
        return tx.source;
    }

    // What a block is for the ids of its proof: its command and line, and its occurrence among the blocks of its reply that did the same
    // (given once and kept in the block's span: the caller that plans a block again passes the one it has, else the reply's next unused
    // one). Two blocks of a reply differ in it.
    function originOf(tx) {
        if (tx.origin === null) {
            try { tx.operation = operationKey(tx.call.type, tx.call.payload); } catch { tx.operation = null; }
            // (never invented here: the caller that plans a block gives it, else the store's allocator does; with neither the proof is refused)
            let rank = tx.occurrence;
            if (rank === null) {
                try { rank = Number.isInteger(tx.reply?.index) && tx.operation ? store.allocateOccurrence?.(tx.reply.index, tx.operation) : null; } catch { rank = null; }
            }
            if (!Number.isInteger(rank) || rank < 0) throw new Error('No occurrence could be given to this proof.');
            tx.rank = rank;
            tx.origin = `${tx.operation}:${rank}`;
        }
        return tx.origin;
    }

    // The Cursor this transaction's block starts at (ctx.cursor): who the block is (the reply's canonical pair and the id named by its operation and its
    // occurrence, which is the one the host stamps: replay.js blockIdOf) and where it sits now (the changes before it on the reply, the rev before it).
    // A block the reply holds already (a step planned again: its ordinal) is told by the id it has.
    function cursorOf(tx) {
        if (tx.cursor === undefined) {
            let found = null;
            const source = sourceOf(tx);
            if (source && Number.isInteger(tx.reply?.index)) {
                try {
                    originOf(tx);
                    const held = Number.isInteger(tx.ordinal) ? store.blockAt?.(tx.reply.index, tx.ordinal) ?? null : null;
                    const block = tx.reusing ? tx.reusing.id : held ? held.block : tx.operation ? blockIdOf({ sid: source.sid, swipeKey: source.swipeKey, key: tx.operation, rank: tx.rank }) : null;
                    const op = Number.isInteger(tx.opsBefore) ? tx.opsBefore : held ? held.op : store.opsAt(tx.reply.index).length;
                    if (block) found = { sid: source.sid, swipeKey: source.swipeKey, block, op, rev: Math.max(0, tx.rev - 1) };
                } catch { found = null; }
            }
            tx.cursor = found ? Object.freeze(found) : null;
        }
        if (!tx.cursor) fail('FAILED', 'There is no reply yet to hold a block, so it has no cursor.');
        return tx.cursor;
    }

    // ---- one transaction ----------------------------------------------------------------------

    function draftOf(tx, domain) {
        if (!tx.drafts.has(domain)) {
            const slice = tx.head.domains?.[domain];
            tx.drafts.set(domain, slice === undefined ? {} : clone(slice));
        }
        return tx.drafts.get(domain);
    }

    function metaOf(tx) {
        if (!tx.meta) tx.meta = clone(tx.head.meta ?? {});
        if (!isRecord(tx.meta.claims)) tx.meta.claims = {};
        return tx.meta;
    }

    // Reads hand out frozen values without copying the state: the head is deep-frozen (transact), and a
    // drafted domain is read as frozenCopy gives it, the head's own branches wherever the draft has not
    // changed them (B-b1r2-4: a copy of the whole slice per read made each line cost the state's size).
    function readOf(tx, domain) {
        if (tx.drafts.has(domain)) return frozenCopy(tx.drafts.get(domain), tx.head.domains?.[domain]);
        if (!isRecord(tx.head.domains) || !Object.hasOwn(tx.head.domains, domain)) return null;
        return tx.head.domains[domain];
    }

    // The state as this transaction has it so far, frozen: the head with every draft (and claim) laid
    // over it; the head itself while nothing is drafted.
    function currentState(tx) {
        if (!tx.drafts.size && !tx.meta && isRecord(tx.head.domains)) return tx.head;
        const domains = { ...(tx.head.domains ?? {}) };
        for (const [name, draft] of tx.drafts) domains[name] = frozenCopy(draft, tx.head.domains?.[name]);
        const meta = tx.meta ? frozenCopy(tx.meta, tx.head.meta) : tx.head.meta;
        return Object.freeze({ ...tx.head, meta, domains: Object.freeze(domains) });
    }

    // A query's third argument (MODULES §F3): other queries over the same transaction state, and the
    // stored receipts in chat order.
    function queryTools(tx, state = currentState(tx)) {
        const tools = Object.freeze({
            reply: tx.reply,
            query(name, args) {
                const fn = findQuery(name);
                if (!fn) fail('NOT_FOUND', `There is no query called "${name}".`);
                return frozenCopy(fn(state, deepFreeze(clone(args)), tools));
            },
            receipts: () => store.receipts?.() ?? [],
            // The proof this root has given so far (not stored yet), for story.evidence (evidence.js).
            pendingProofs: () => [...(tx.planned ?? []), ...(tx.proofs?.list ?? [])].map(proof => ({ proof, block: null })),
        });
        return tools;
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

    function giveProof(tx, moduleId, spec) {
        const made = submitProof(spec, {
            who: moduleId, cause: tx.cause, chat: tx.chat, source: sourceOf(tx), origin: originOf(tx), state: () => currentState(tx),
            stored: () => store.proofs?.() ?? [], taken: () => store.proofs?.({ all: true }) ?? [], planned: tx.planned, root: tx.proofs, fail, replacing: tx.replacing,
        });
        if (made.created) {
            const meta = metaOf(tx);
            if (!isRecord(meta.proofs)) meta.proofs = {};
            meta.proofs[made.proof.id] = made.pin;
        }
        return Object.freeze({ id: made.proof.id, payloadHash: made.proof.payloadHash });
    }

    function allocateId(tx, prefix) {
        if (typeof prefix !== 'string' || !ID_PREFIX.test(prefix)) fail('INVALID', `An id prefix is lowercase letters and digits (like "it"), not "${prefix}".`);
        let out = '';
        for (let n = 0; n < 8; n += 1) out += BASE36[Math.floor(tx.idRandom() * 36) % 36];
        return `${prefix}_${out}`;
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

    function resultOf(type, out, cause) {
        const result = out ?? {};
        if (!isRecord(result)) fail('FAILED', `${type} returned something other than { summary, narrate, data }.`);
        const summary = result.summary ?? '';
        const narrate = result.narrate ?? cause === 'ui';
        const data = result.data ?? {};
        if (typeof summary !== 'string') fail('FAILED', `${type} returned a summary that is not text.`);
        if (typeof narrate !== 'boolean') fail('FAILED', `${type} returned a narrate flag that is not true or false.`);
        if (!isRecord(data) || !isJson(data)) fail('FAILED', `${type} returned data that is not a plain JSON object.`);
        // `problem`: the command was done, but not all of what was asked (a clamp); a capture's
        // problem goes to the Problems list (turn.js). Not stored in the receipt.
        const problem = typeof result.problem === 'string' && result.problem.trim() ? result.problem.trim() : null;
        // `replan: true` (a system step only, B-a1-13): what it did is planned from the story state it ran
        // on (an example module's story-time heal), so a Re-read of the reply it is kept on runs it again on the
        // new story changes instead of applying what it did before (store.replaceStory).
        const replan = cause === 'system' && result.replan === true;
        return { summary, narrate, data: clone(data), problem, replan };
    }

    function opsOf(tx) {
        const ops = [];
        const touched = [];
        for (const name of [...tx.drafts.keys()].sort()) {
            const before = tx.head.domains?.[name];
            const path = `/domains/${escapeKey(name)}`;
            const draft = tx.drafts.get(name);
            const changes = before === undefined ? [{ op: 'add', path, value: clone(draft) }] : diff(before, draft, path);
            // A count the domain keeps by adding and taking away remembers what it replaced (ops.js
            // counters), so a replay after a deleted reply adds this change instead of writing the number.
            // A thing removed that held a count (an emptied stack) remembers how much it held then.
            const counters = typeof registry.counters === 'function' ? registry.counters(name) : null;
            if (counters?.length) {
                for (const change of changes) {
                    if (change.op === 'remove') {
                        const count = counterInside(change.path, counters);
                        if (count && tx.absolute.has(`${change.path}${count}`)) continue;   // a reset (ctx.absolute): no `was`
                        const was = count ? valueAt(tx.head, `${change.path}${count}`) : undefined;
                        if (typeof was === 'number') Object.assign(change, { was, count });
                        continue;
                    }
                    if (change.op !== 'replace' || typeof change.value !== 'number' || !isCounterPath(change.path, counters)) continue;
                    if (tx.absolute.has(change.path)) continue;   // a set (ctx.absolute): no `was`
                    const was = valueAt(tx.head, change.path);
                    if (typeof was === 'number') change.was = was;
                }
            }
            // A set that left the count as it was is still written, as a set.
            for (const at of tx.absolute) {
                if (!at.startsWith(`${path}/`) || changes.some(change => change.path === at)) continue;
                const value = valueAt(tx.head, at);
                if (typeof value === 'number' && valueAt(draft, at.slice(path.length)) === value) changes.push({ op: 'replace', path: at, value });
            }
            // Changes inside a thing marked with ctx.ifThere carry it (`within`, rule d).
            for (const change of changes) {
                for (const at of tx.within) if (change.path === at || change.path.startsWith(`${at}/`)) { change.within = at; break; }
            }
            if (changes.length) touched.push(name);
            ops.push(...changes);
        }
        if (tx.meta) ops.push(...diff(tx.head.meta ?? {}, tx.meta, '/meta'));
        const meta = tx.head.meta;
        const rev = (Number.isInteger(meta?.rev) ? meta.rev : 0) + 1;
        ops.push({ op: isRecord(meta) && Object.hasOwn(meta, 'rev') ? 'replace' : 'add', path: '/meta/rev', value: rev });
        return { ops, touched, rev };
    }

    // Runs one command against `head` and returns { ok, ops, receipt, state } without storing anything.
    function transact(head, type, payload, { cause, seed: seedValue, receiptId, capture, carrier = null, chat = null, again = false, standing = null, reply = null, planned = null, replacing = null, occurrence = null, reusing = null }) {
        let tx = null;
        try {
            if (!CAUSES.includes(cause)) fail('INVALID', `"${cause}" is not a cause (ui, story or system).`);
            if (!isSeed(seedValue)) fail('INVALID', 'The seed must be a whole number from 0 to 4294967295.');
            if (!isRecord(head)) fail('FAILED', 'There is no state to change yet.');
            const target = capture
                ? { moduleId: capture.moduleId, handler: capture.apply }
                : resolve(type, again);
            if (cause === 'ui' && internal(type)) fail('REFUSED', internalMessage(type));
            if (typeof target.handler !== 'function' || !target.moduleId) fail('UNKNOWN_COMMAND', `There is no capture handler for "${type}".`);
            if (capture?.off === true) featureOff(type, capture.feature);
            // Reads share the head's branches (readOf), so it must be frozen all the way down; a state
            // that is not (a caller's own object) is copied first rather than frozen in place.
            if (!isDeepFrozen(head)) head = deepFreeze(clone(head));
            const headRev = Number.isInteger(head.meta?.rev) ? head.meta.rev : 0;
            tx = {
                head, cause, receiptId, random: makeRng(seedValue), idRandom: makeRng((seedValue ^ ID_STREAM) >>> 0),
                rev: headRev + 1, carrier: carrierOf(carrier), chat: chatOf(chat), again: again === true && cause === 'story',
                standing: cause === 'story' && isRecord(standing) ? (isDeepFrozen(standing) ? standing : deepFreeze(clone(standing))) : null,
                drafts: new Map(), meta: null, failure: null, closed: false, absolute: new Set(), within: new Set(),
                clockBoundaries: [], guard: null, recorded: null, source: undefined, pending: 0, ordinal: undefined, proofs: newRoot(), cursor: undefined, opsBefore: null, reusing,
                // The proof a Re-read's earlier lines gave (planned, not stored yet), for parents and story.evidence.
                planned: Array.isArray(planned) ? planned : [],
                // The proof of the blocks being replaced (a Re-read's lines and steps, a step planned again): a proof of the same kind and key, at the same place among those, keeps the id.
                replacing: Array.isArray(replacing) ? replacing : [],
                // What this root is (its command and line) and its rank among blocks of the reply that did the same: its proof ids come from it.
                origin: null, rank: null, operation: null, occurrence: Number.isInteger(occurrence) && occurrence >= 0 ? occurrence : null,
            };
            tx.call = { type, payload };
            // `reply` (run, a system step only): the reply a Re-read's step is kept on, which need not be the head.
            const given = cause === 'system' && isRecord(reply) ? replyOf(reply.index, reply.sid) : null;
            tx.reply = tx.carrier ? replyOf(tx.carrier.index, tx.carrier.sid ?? tx.carrier.key) : given ?? headReply(store);
            // A Re-read plans blocks it has not stored yet: `pending` of them come before this one, or `ordinal`
            // names the block's own (a block planned again keeps it). Only the Source's ordinal, nothing else.
            const place = tx.carrier ? carrier : given ? reply : null;
            if (Number.isInteger(place?.pending) && place.pending > 0) tx.pending = place.pending;
            if (Number.isInteger(place?.ordinal) && place.ordinal >= 0) tx.ordinal = place.ordinal;
            // Where the block sits, for ctx.cursor: in a Re-read, the changes of the blocks planned before this one (the store has not stored them yet).
            if (Number.isInteger(place?.opsBefore) && place.opsBefore >= 0) tx.opsBefore = place.opsBefore;
            const out = invoke(tx, type, target, payload, 0);
            if (tx.failure) throw tx.failure;
            if (tx.clockBoundaries.length) {
                const last = tx.clockBoundaries.at(-1).minute;
                const end = currentState(tx).domains?.director?.time?.minutes;
                if (!Number.isSafeInteger(end) || end < last || end >= last + 1440) fail('INVALID', 'Every crossed midnight needs its own logical marker.');
            }
            const done = resultOf(type, out, cause);
            const { summary, narrate, problem, replan } = done;
            let { data } = done;
            tx.closed = true;
            // A guarded transaction: the receipt's data.v2 carries the host's Source and the guard (the owner's
            // own fields stay, but never a source or guard of its own making), and the store gets the block.
            let block = null;
            // A cursor names a block that is stored: a command that read one makes a guarded block (or one that gives proof) or it fails (no id is handed out that is never used).
            if (tx.cursor && !tx.guard && !tx.proofs.list.length) fail('FAILED', `${type} read its cursor but made no guarded block (ctx.replayGuard), so there is no block for it to name.`);
            if (tx.guard || tx.proofs.list.length) {
                const source = sourceOf(tx);
                if (!source) fail('FAILED', 'There is no reply yet to hold a guarded block.');
                if (!isRecord(data.v2 ?? {})) fail('FAILED', `${type} returned data.v2 that is not a record.`);
                const owned = { ...(data.v2 ?? {}) };
                delete owned.evidence;
                // The host alone stamps the source, the guard and the evidence; a block that gives proof but
                // attaches no guard has none (guard: null) and no epoch of its own (the owner's, if it names one).
                const proofs = tx.proofs.list;
                data = { ...data, v2: {
                    schema: 2, ...owned, ...(tx.guard ? { epoch: owned.epoch ?? tx.guard.epoch } : {}),
                    rulesHash: tx.guard ? tx.guard.rulesHash : null, source, guard: tx.guard ?? null,
                } };
                const operation = payload ?? {};
                if (!isPlainJson(operation)) fail('INVALID', `${type} is guarded, so its payload must be plain JSON.`);
                block = {
                    ...(tx.clockBoundaries.length ? { clockBoundaries: clone(tx.clockBoundaries) } : {}),
                    module: target.moduleId, source, guard: tx.guard ?? null, operation: { type, payload: clone(operation) }, recorded: tx.recorded,
                    result: Object.hasOwn(data.v2, 'result') ? clone(data.v2.result) : clone(data),
                    ...(proofs.length ? { evidence: clone(proofs) } : {}),
                    // The occurrence the block takes among the reply's blocks of its operation: given once, kept in its span, and what its id (and its proofs') come from.
                    // A supported old proofless span keeps its bytes, including its absent occurrence. If it starts giving proof,
                    // originOf uses the plan's shared allocator, just as a new block does.
                    ...(reusing && occurrenceOf(reusing) === null && !proofs.length ? {} : { occurrence: (originOf(tx), tx.rank) }),
                    ...(reusing ? { id: reusing.id } : {}),
                    // A cursor the command read is the one its block is stored at: the host stamps that id and checks the rest.
                    ...(tx.cursor ? { id: tx.cursor.block, cursor: tx.cursor } : {}),
                };
                // The receipt shows the proof too (contract Receipt.data.v2.evidence); the span's is what the host reads.
                if (proofs.length) data = { ...data, v2: { ...data.v2, evidence: receiptEvidence(proofs) } };
            }

            const { ops, touched, rev } = opsOf(tx);
            if (block?.module === 'story-block' && String(block.guard?.predicate?.kind ?? '').startsWith('dm.')) {
                const setup = block.guard.replyBound === true;
                // Include the host's durable span envelope, not just receipt display data. The store
                // supplies the final boundary hashes; their wire size is fixed for this interpreter.
                const span = { ...block, id: block.id ?? 'bl_00000000', n: ops.length, story: cause === 'story',
                    claims: [...(tx.meta ? Object.keys(tx.meta.claims).filter(key => !Object.hasOwn(tx.head.meta?.claims ?? {}, key)) : [])],
                    boundaries: [{ cursor: tx.cursor ?? { sid: tx.source.sid, swipeKey: tx.source.swipeKey, block: 'bl_00000000', op: 0, rev },
                        prefixHash: '0'.repeat(64), payloadHash: '0'.repeat(64) }] };
                if (ops.length > DM_LIMITS.patchOps || new TextEncoder().encode(JSON.stringify(span)).length > (setup ? DM_LIMITS.pinBytes : DM_LIMITS.actionBytes)) {
                    fail('DM_BUDGET', 'Data module patch or durable span storage budget exhausted; nothing applied.');
                }
            }
            const problems = checkOps(ops, head);
            if (problems.length) fail('INVALID', `This change breaks the state's rules: ${problems.join(' ')}`);
            let next;
            try {
                next = deepFreeze(apply(head, ops));
            } catch (error) {
                fail('FAILED', `The change could not be applied: ${error.message}`);
            }
            for (const name of touched) {
                const validate = registry.validator(name);
                if (typeof validate !== 'function') continue;
                let errors;
                try {
                    errors = validate(next.domains[name], next);
                } catch (error) {
                    fail('FAILED', `The ${name} check itself failed: ${error.message}`);
                }
                if (Array.isArray(errors) && errors.length) fail('INVALID', `The ${name} would not be valid: ${errors.join('; ')}.`);
            }
            const receipt = deepFreeze({
                id: receiptId, type, module: target.moduleId, cause, seed: seedValue, summary, narrate, data, rev,
                // What to run it again with on a Re-read (resultOf `replan`): its payload.
                ...(replan && isJson(payload ?? {}) ? { replan: { payload: clone(payload ?? {}) } } : {}),
                // The host's own mark that this was a guarded block (a module cannot set it; data.v2 is the module's to fill).
                ...(block ? { guarded: true } : {}),
            });
            return { ok: true, ops: deepFreeze(ops), receipt, state: next, ...(block ? { block: deepFreeze(block) } : {}), ...(problem ? { problem } : {}) };
        } catch (error) {
            const reason = asCommandError(type, tx?.failure ?? error);
            return { ok: false, code: reason.code, message: reason.message };
        } finally {
            if (tx) tx.closed = true;
        }
    }

    // The reply a capture runs for, frozen; `key` (and String(carrier)) is "<index>:<swipe>". `sid` is the
    // reply's record ID (null when unknown): unlike the index it stays with the reply when an earlier
    // message is deleted, so a claim keyed on it still matches.
    function carrierOf(carrier) {
        if (!isRecord(carrier) || !Number.isInteger(carrier.index)) return null;
        const swipe = Number.isInteger(carrier.swipe) ? carrier.swipe : 0;
        const key = `${carrier.index}:${swipe}`;
        const out = { index: carrier.index, swipe, sid: typeof carrier.sid === 'string' ? carrier.sid : null, key };
        Object.defineProperty(out, 'toString', { value: () => key });
        return Object.freeze(out);
    }

    function chatOf(chat) {
        if (!isRecord(chat)) return null;
        return Object.freeze({ lastUser: String(chat.lastUser ?? ''), reply: String(chat.reply ?? '') });
    }

    // ---- storing ------------------------------------------------------------------------------

    function storeResult(ops, receipt, block = null) {
        try {
            store.append({ ops, receipt, ...(block ? { block } : {}) });
        } catch (error) {
            return { ok: false, code: 'FAILED', message: `The change could not be stored: ${error?.message ?? error}` };
        }
        store.scheduleSave();
        if (typeof onCommitted === 'function') {
            try {
                onCommitted({ receipt, ops });
            } catch (error) {
                console.warn('[Story Block] A committed listener failed:', error);
            }
        }
        return { ok: true, receipt };
    }

    function fresh(cause, seedValue) {
        return { cause, seed: seedValue ?? seed(), receiptId: id('rc') };
    }

    function guarded(fn) {
        try {
            return fn();
        } catch (error) {
            const reason = asCommandError('the command bus', error);
            return { ok: false, code: reason.code, message: reason.message };
        }
    }

    function fingerprint(head) {
        return { rev: head?.meta?.rev, index: store.headIndex?.(), json: JSON.stringify(head) };
    }

    // C3-3: which declared features are on, so a preview taken before the reader turned one off (or on)
    // is not committed as it was: the handler, or a command it called, may have read it.
    const featureMarks = () => (typeof registry.features === 'function' ? registry.features() : [])
        .map(feature => `${feature.id}:${featureOn(feature.id) ? 1 : 0}`).join(',');

    return {
        /** command(type, payload, { cause = 'ui' }) → { ok: true, receipt } | { ok: false, code, message } */
        command(type, payload, { cause = 'ui' } = {}) {
            return guarded(() => {
                const result = transact(store.head(), type, payload, fresh(cause));
                return result.ok ? storeResult(result.ops, result.receipt, result.block) : result;
            });
        },

        /** preview(type, payload) → { ok: true, receipt, token, ops }: the handler's result, nothing stored. */
        preview(type, payload, { cause = 'ui' } = {}) {
            return guarded(() => {
                const head = store.head();
                const result = transact(head, type, payload, fresh(cause));
                if (!result.ok) return result;
                const token = `pv_${++previewCount}`;
                previews.set(token, { type, ops: result.ops, receipt: result.receipt, block: result.block ?? null, seen: fingerprint(head), features: featureMarks() });
                while (previews.size > MAX_PREVIEWS) previews.delete(previews.keys().next().value);
                return { ok: true, receipt: result.receipt, token, ops: result.ops };
            });
        },

        /**
         * commit(token): stores exactly what the preview showed, or STALE when the head moved since.
         * The command's feature is checked again (FEATURE_OFF), and a preview from before any feature
         * was turned on or off is STALE.
         */
        commit(token) {
            return guarded(() => {
                const saved = previews.get(token);
                if (!saved) return { ok: false, code: 'NOT_FOUND', message: 'That preview is gone; try the action again.' };
                previews.delete(token);
                resolve(saved.type);
                if (featureMarks() !== saved.features) {
                    return { ok: false, code: 'STALE', message: 'A feature was turned on or off since this preview; try the action again.' };
                }
                const now = fingerprint(store.head());
                if (now.rev !== saved.seen.rev || now.index !== saved.seen.index || now.json !== saved.seen.json) {
                    return { ok: false, code: 'STALE', message: 'The story changed since this preview; try the action again.' };
                }
                return storeResult(saved.ops, saved.receipt, saved.block);
            });
        },

        /**
         * run(type, payload, { cause = 'story', seed, state, capture }) → { ok, ops, receipt, state }:
         * the command's result without storing it (capture). `state` is the state to run against
         * (default: the head), so lines of one reply can chain; `capture` = registry.capture(kind)'s
         * { moduleId, apply } runs that capture handler as command `type`; `carrier` ({ index, swipe, sid? })
         * and `chat` ({ lastUser, reply }) become ctx.carrier and ctx.chat. `again` (story only): a Re-read
         * of a line that made a change before, run with its features as on (C3-4). `standing` (story only): a
         * Re-read's reply state as it stood before it, ctx.standing (a2-3). `reply` ({ index, sid }, system only):
         * ctx.reply for a step kept on a reply that is not the head (a Re-read's afterCapture and replan steps).
         * `carrier` and `reply` may also say `pending` (guarded blocks a Re-read has planned before this one) or
         * `ordinal` (this block's own, when it is planned again): only ctx.source's ordinal follows them. `planned`
         * (the Proofs the lines of a Re-read have given so far): parents and story.evidence see them like stored ones.
         * `replacing` (the proof of the blocks being replaced): a proof of the same kind and key at the same place among those keeps the id of its old one.
         * A guarded transaction's result has a `block` too (REPLAY.md), which store.append or replaceStory keeps.
         */
        run(type, payload, { cause = 'story', seed: seedValue, state, capture, carrier = null, chat = null, again = false, standing = null, reply = null, planned = null, replacing = null, occurrence = null, reusing = null } = {}) {
            return guarded(() => transact(state ?? store.head(), type, payload, { ...fresh(cause, seedValue), capture, carrier, chat, again: again === true && cause === 'story', standing, reply, planned, replacing, occurrence, reusing }));
        },
    };
}
