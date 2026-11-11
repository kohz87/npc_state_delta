// Story Suite v2: one command transaction: run a handler against a head state, diff its drafts into ops, attach the block,
// validate, and return { ok, ops, receipt, state } without storing anything. Also the carrier/chat values a transaction
// runs under. commands.js keeps createCommandBus and stores what this part plans.

import { apply, checkOps, clone, counterInside, deepFreeze, diff, escapeKey, isCounterPath, isDeepFrozen, isJson, valueAt } from '../ops.js';
import { DM_LIMITS } from '../data-modules/schema.js';
import { isSeed, rng as makeRng } from '../rng.js';
import { newRoot, occurrenceOf, receiptEvidence } from '../evidence.js';
import { isPlainJson } from '../replay.js';
import { ruleMarksOf } from '../turn/rule-marks.js';
import { CAUSES, ID_STREAM, asCommandError, fail, headReply, isRecord, replyOf } from './shared.js';

export function createTransact({ store, registry, resolve, internal, internalMessage, featureOff, invoke, currentState, sourceOf, originOf }) {
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
            // Appends to a list marked with ctx.unique carry it (`unique`, rule e).
            for (const change of changes) if (change.op === 'add' && change.path.endsWith('/-') && tx.unique.has(change.path.slice(0, -2))) change.unique = true;
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
    function transact(head, type, payload, { cause, seed: seedValue, receiptId, capture, carrier = null, chat = null, again = false, standing = null, standingReceipts = null, reply = null, planned = null, replacing = null, occurrence = null, reusing = null, receiptsBefore = null }) {
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
                standingReceipts: cause === 'story' && Array.isArray(standingReceipts) ? deepFreeze(clone(standingReceipts)) : null,
                receiptsBefore: cause === 'system' && Array.isArray(receiptsBefore) ? deepFreeze(clone(receiptsBefore)) : null,
                drafts: new Map(), meta: null, failure: null, closed: false, absolute: new Set(), within: new Set(), unique: new Set(),
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
        const out = { index: carrier.index, swipe, sid: typeof carrier.sid === 'string' ? carrier.sid : null, key, ...(carrier.practiceRule === 'rolls' ? { practiceRule: 'rolls' } : {}), ...(carrier.foeCap === 20 ? { foeCap: 20 } : {}), ...(ruleMarksOf(carrier.rules).length ? { rules: Object.freeze(ruleMarksOf(carrier.rules)) } : {}) };
        Object.defineProperty(out, 'toString', { value: () => key });
        return Object.freeze(out);
    }

    function chatOf(chat) {
        if (!isRecord(chat)) return null;
        return Object.freeze({ lastUser: String(chat.lastUser ?? ''), reply: String(chat.reply ?? '') });
    }

    return transact;
}
