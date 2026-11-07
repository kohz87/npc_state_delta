// Story Suite v2: the store's two story writes: append (a command's ops and receipt, and the guarded block's span, on
// the last reply) and before (the state a Re-read of a carrier starts from). Moved out of createWrite unchanged;
// createWrite puts them in api at the places they were.

import { lastCarrier } from '../../persist.js';
import { isObject, touchesHostDomain, hostBlock, revOf } from '../constants.js';
import { clockWriteProblem } from '../../timeline/boundary.js';
import { gateProblem } from '../../timeline/gate.js';

export function createStory(s, deps) {
    const { advanced, asOps, baseFor, blockParts, carrierAt, current, guardHolds, list, ORPHAN, quarantined, retain, saver, spansFor, stamp, step, take, withSource, writable, write } = deps;

    return {
        // `block` (what the command bus hands over for a guarded transaction, REPLAY.md): { module, source, guard,
        // operation, recorded, result }. The host stamps the block id, the claims its ops make and the boundary
        // it starts at, and the record keeps all of it on the block's span, written together with the ops.
        append({ ops, receipt = null, block = null } = {}) {
            const arr = list();
            const index = lastCarrier(arr);
            if (index < 0) throw new Error('There is no reply in this chat to hold the change yet.');
            writable();
            const base = current().state;
            if (!base) throw new Error('This chat has no story state yet.');
            const added = asOps(ops);
            if (receipt !== null && !isObject(receipt)) throw new TypeError('A receipt must be an object.');
            if (block !== null && !isObject(block)) throw new TypeError('A block must be an object.');
            if (!added.length && !receipt) return;
            const clock = clockWriteProblem(block, added);
            if (clock) throw new Error(clock);
            if (added.some(touchesHostDomain) && !hostBlock(block?.module, block?.operation?.type)) throw new Error('The savepoints are the host\'s own; only its blocks write them.');
            if (block?.guard) {
                // A guard that replay would turn away (another epoch, other rules) is not stored: live and replay agree.
                const gate = gateProblem(base, block.guard);
                if (gate) throw new Error(`The guarded change cannot be stored: ${gate}.`);
            }
            const next = step(base, added);       // throws on a bad op: nothing is written
            const taken = take(arr, index, base);
            // (what a quarantined record would hold is never applied: a change put on it would be lost on the next replay)
            if (!taken.fresh && quarantined(taken.record)) throw new Error(`This reply's story record is kept as it is and nothing is added to it: ${ORPHAN}.`);
            const { message } = taken;
            const record = withSource(message, taken.record);
            if (typeof receipt?.id === 'string' && record.receipts.some(known => known?.id === receipt.id)) {
                throw new Error(`Receipt ${receipt.id} is already stored on this reply.`);
            }
            const spans = spansFor(record);
            const story = receipt?.cause === 'story';
            const span = block
                ? stamp(arr, index, record, block, added, receipt, blockParts({ ...record, spans, ops: record.ops }), record.ops.length)
                : null;
            if (span) guardHolds(base, span, message);
            write(message, {
                ...record,
                ops: [...record.ops, ...added],
                receipts: receipt ? [...record.receipts, structuredClone(receipt)] : record.receipts,
                spans: [...spans, { n: added.length, story, ...(span ?? {}) }],
                ...(span ? { source: advanced(record.source, [span]) } : {}),
                rev: revOf(next),
            });
            saver.touch();
            retain(arr, next, undefined, s.cache?.applied && span?.evidence?.length
                ? [...s.cache.applied, ...span.evidence.map(proof => Object.freeze({ proof, block: span.id, index }))] : undefined);
        },

        // The state a Re-read of carrier `index` runs its lines on: its own checkpoint when it starts
        // one, else the state after the carrier before it (null without one). Frozen.
        before(index) {
            const arr = list();
            const message = carrierAt(arr, index);
            return baseFor(arr, index);
        },
    };
}
