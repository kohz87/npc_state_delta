// Story Suite v2: guarded blocks on replay (REPLAY.md), moved out of createStore unchanged: how a block's guard is asked and its
// thrown answers kept, what a guarded block must be on its own (blockIntact), replaying one (replayGuarded, replayLegacy), whether a
// guard would hold when a block is stored (guardHolds), and attachGuard. `createGuards(s, deps)` is given the store's state holder `s`
// and the few store functions it calls; it never imports store.js.

import { claimKeys, hashJson, isMetaSpan, spanProblem } from '../replay.js';
import { isObject, touchesHostDomain, hostBlock } from './constants.js';
import { payloadHashOf } from './digest.js';
import { evidenceDigest, evidenceProblem, pinOps, touchesProof } from '../evidence.js';
import { clockWriteProblem, markerPrefixProblem } from '../timeline/boundary.js';
import { gateProblem } from '../timeline/gate.js';

export function createGuards(s, deps) {
    const { chatId, metadata, list, step, forgetMemos } = deps;

    // ---- guarded blocks: asking the guard, stamping a block -------------------------------------------

    const prerequisite = message => Object.assign(new Error(message), { code: 'REPLAY_PREREQUISITE' });

    // What the guards could answer differently on (a module registered or went): looked at on each read once a
    // guarded block has been replayed or written here, never for a chat that has none.
    function markNow() {
        try { return typeof s.guardMark === 'function' ? String(s.guardMark()) : ''; } catch { return ''; }
    }
    function seeGuards() {
        if (s.guardSeen) return;
        s.guardSeen = true;
        s.lastMark = markNow();
    }

    // Rejected plans have no stored block to replay a Problem from. Keep thrown-guard diagnostics in
    // this chat only, at the one point where every guard is checked; successful checks clear that exact fault.
    function faultsNow() {
        const arr = list(), id = chatId(), holder = metadata();
        if (!s.guardFaults || s.guardFaults.arr !== arr || s.guardFaults.id !== id || s.guardFaults.holder !== holder) {
            s.guardFaults = { arr, id, holder, entries: new Map() };
        }
        return s.guardFaults.entries;
    }
    const guardFaultKey = span => `${span.id}:${hashJson(span.guard)}`;
    function thrownGuard(span, message, error) {
        const kind = isObject(span.guard?.predicate) && typeof span.guard.predicate.kind === 'string' ? span.guard.predicate.kind : '<missing>';
        const why = `${span.guard.owner}'s replayGuard kind ${kind} failed (${error?.message ?? error})`;
        faultsNow().set(guardFaultKey(span), { message, source: span.source, block: span.id, why });
        return { ok: false, reason: why };
    }

    // The owner's answer for a guarded block on `state` (the state before it): { ok: true } or { ok: false,
    // reason }. Nothing to ask, a throw, a promise or any other shape fails closed.
    function askGuard(state, span, message) {
        seeGuards();
        if (typeof s.guardCheck !== 'function') return { ok: false, reason: 'nothing here can check its guard, so it stays off' };
        let answer;
        try {
            // `payload`: the hash of the reply's text when the block was stored, and now (REPLAY.md): an edit shows as a difference.
            const payload = { saved: span.boundaries?.[0]?.payloadHash ?? null, current: message ? payloadHashOf(message) : null };
            answer = s.guardCheck(state, { guard: span.guard, source: span.source, block: span.id, operation: span.operation, recorded: span.recorded ?? null, payload });
        } catch (error) {
            return thrownGuard(span, message, error);
        }
        if (answer && typeof answer.then === 'function') {
            answer.then(null, () => {});
            return { ok: false, reason: 'its guard did not answer at once' };
        }
        if (isObject(answer) && answer.ok === true) { faultsNow().delete(guardFaultKey(span)); return { ok: true }; }
        if (isObject(answer) && answer.ok === false && typeof answer.reason === 'string' && answer.reason) return { ok: false, reason: answer.reason };
        return { ok: false, reason: 'its guard gave an answer that is neither { ok: true } nor { ok: false, reason }' };
    }

    // The blocks before a guarded block, as its boundary's prefix hash has them: each one's id and changes, and the proof it
    // gave (ids, kinds, owners, payload hashes, parents). One function, so the hash stamped and the hash checked agree.
    function blocksBefore(earlier) {
        return earlier.map(part => [isMetaSpan(part.span) ? part.span.id : null, hashJson(part.ops), ...(isMetaSpan(part.span) && evidenceDigest(part.span.evidence) ? [evidenceDigest(part.span.evidence)] : [])]);
    }

    // A block with no metadata (a legacy block) never pins proof: only a guarded or proof block that holds the proof it
    // pins does (replayGuarded), so a hand-edited record cannot publish a proof by writing its pin on another block.
    function replayLegacy(state, ops) {
        const clock = clockWriteProblem(null, ops);
        if (clock) throw prerequisite(clock);
        if (ops.some(op => op && typeof op === 'object' && touchesProof(op))) throw prerequisite('it changes the record of proof pins (or the state around it), and a block with no proof of its own cannot');
        if (ops.some(touchesHostDomain)) throw prerequisite('it writes the host\'s savepoints, and only the host\'s own blocks do');
        return step(state, ops, { replayed: true });
    }

    // A guarded block is stored only if its guard holds on the state before it when replayed (the context a replay asks in:
    // the state and what it recorded). What a replay would refuse is refused here, so a state that was built live and one that
    // is built again by replay cannot disagree about it. Nothing is asked of a store with no guard check attached.

    function guardHolds(state, span, message) {
        const clockPrefix = markerPrefixProblem(span, state);
        if (clockPrefix) throw prerequisite(clockPrefix);
        if (typeof s.guardCheck !== 'function' || !isMetaSpan(span) || !span.guard) return;
        // (the epoch and rules gate first, as a replay does: docs/v2/TIMELINE.md)
        const gate = gateProblem(state, span.guard);
        if (gate) throw new Error(`Its guard would not hold when this is replayed, so it is not stored: ${gate}`);
        const answer = askGuard(state, span, message);
        if (!answer.ok) throw new Error(`Its guard would not hold when this is replayed, so it is not stored: ${answer.reason}`);
    }

    // A guarded block on replay (and in a Re-read's kept blocks): its record must be whole, from this
    // carrier, make the claims it lists, and pass its owner's guard on `state`; then its ops (claims among
    // them) are applied together. Throws a REPLAY_PREREQUISITE error otherwise, with nothing applied.
    // What a guarded block must be on its own, whatever the state: its record whole, the guard its receipt kept the one it holds, the
    // reply and swipe it was recorded for, the claims its ops make. Throws a REPLAY_PREREQUISITE otherwise. A block that is not
    // intact is not planned again either: planning would bring back what replay keeps off.
    function blockIntact(record, ops, span, receipt) {
        const bad = spanProblem(span);
        if (bad) throw prerequisite(`its saved guard record is damaged: ${bad}`);
        // A guard the receipt kept (data.v2, set by the host) must be the one the span holds.
        if (receipt?.guarded === true && receipt.data?.v2?.guard && hashJson(receipt.data.v2.guard) !== hashJson(span.guard)) {
            throw prerequisite('the guard its receipt kept is not the one saved with the block');
        }
        const entry = record.source;
        if (!isObject(entry) || span.source.sid !== entry.logical || span.source.swipeKey !== entry.swipeKey || span.source.evidence !== entry.evidence) {
            throw prerequisite('it was recorded for another reply or swipe');
        }
        const claims = claimKeys(ops);
        if (claims.length !== span.claims.length || !claims.every(key => span.claims.includes(key))) {
            throw prerequisite('the claims it saved are not the claims its changes make');
        }
        if (ops.some(touchesHostDomain) && !hostBlock(span.module, span.operation?.type)) throw prerequisite('it writes the host\'s savepoints, and only the host\'s own blocks do');
        const clock = clockWriteProblem(span, ops);
        if (clock) throw prerequisite(clock);
        const proof = evidenceProblem(span, ops);
        if (proof) throw prerequisite(`the proof it saved is not the proof its changes pin: ${proof}`);
    }

    function replayGuarded(state, record, ops, span, message = null, receipt = null) {
        blockIntact(record, ops, span, receipt);
        // Some setup choices must retract even when deletion of the earliest replies carries their
        // other state forward (carriedTo replays the formerly known prefix). Never carry this choice.
        if (span.guard?.replyBound === true && message && !list().includes(message)) throw prerequisite('its reply was deleted');
        const clockPrefix = markerPrefixProblem(span, state);
        if (clockPrefix) throw prerequisite(clockPrefix);
        // A proof id belongs to the block that applied with it first: a later block that gives the same id collides and does not apply.
        const owned = state?.meta?.proofs;
        const collides = isObject(owned) ? span.evidence.find(each => Object.hasOwn(owned, each.id)) : undefined;
        if (collides !== undefined) throw prerequisite(`proof ${collides.id} already belongs to a block that applied`);
        // A claim someone else holds already (a retried settlement, a block that woke up after its twin was stored)
        // is never paid twice: the block stays off.
        const held = state?.meta?.claims;
        const taken = isObject(held) ? span.claims.find(key => Object.hasOwn(held, key)) : undefined;
        if (taken !== undefined) throw prerequisite(`claim already held (${taken})`);
        if (span.guard) {
            // The host's own check of the guard's epoch and rules hash against the timeline (docs/v2/TIMELINE.md), then the owner's.
            const gate = gateProblem(state, span.guard);
            if (gate) throw prerequisite(`its guard no longer holds: ${gate}`);
            const answer = askGuard(state, span, message);
            if (!answer.ok) throw prerequisite(`its guard no longer holds: ${answer.reason}`);
        }
        const next = step(state, span.evidence.length ? pinOps(state, ops) : ops, { replayed: true, strict: true });
        if (s.applying && span.evidence.length) for (const each of span.evidence) s.applying.list.push(Object.freeze({ proof: each, block: span.id, index: s.applying.index }));
        return next;
    }

    /**
     * Tells the store how a guarded block is asked on replay (the command bus does this when it is made):
     * `check(state, { guard, source, block, operation, recorded })` → `{ ok: true } | { ok: false, reason }`
     * (a throw, a promise or any other answer fails closed), and `mark()` → text that changes when the
     * answer could (a module with a guard hook registered or went). The head is replayed again.
     */
    function attachGuard(check, mark = null) {
        s.guardCheck = typeof check === 'function' ? check : null;
        s.guardMark = typeof mark === 'function' ? mark : null;
        s.lastMark = markNow();
        s.cache = null;
        forgetMemos();
    }

    return { markNow, seeGuards, faultsNow, blocksBefore, replayLegacy, guardHolds, blockIntact, replayGuarded, attachGuard };
}
