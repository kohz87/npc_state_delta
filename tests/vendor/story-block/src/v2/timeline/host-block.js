// A block the host stores itself (docs/v2/TIMELINE.md): a save point made, forgotten, a restore installed, a return
// completed. It is not a module's command, so it does not go through the command bus; it is stored the way the bus stores
// a guarded block (a receipt and a block handed to store.append), and is held to the same rules on replay:
// * its guard names the host as owner and carries `inputHash = hash({ predicate, stateHash })`, the hash of the story it was
//   made on. The host's replayGuard (guard.js) asks it again on the state before the block, so a block whose story changed
//   (an earlier reply deleted, a Re-read that came out differently) stays off instead of being applied to another story.
// * its ops are absolute where they install saved state (no `was`), so a replay never turns a reset into a change.

import { checkOps } from '../ops.js';
import { hashJson } from '../replay.js';
import { seed as freshSeed } from '../rng.js';
import { epochOf, rulesHashOf } from './gate.js';
import { HOST, fail, makeId } from './util.js';

/** The hash of the story as a host block sees it: every domain, the claims and the proof pins. */
export const stateHash = state => hashJson({ domains: state?.domains ?? {}, claims: state?.meta?.claims ?? {}, proofs: state?.meta?.proofs ?? {} });

/** The guard of a host block made on `state`. */
export function guardFor(state, predicate) {
    return { owner: HOST, version: 2, epoch: epochOf(state), rulesHash: rulesHashOf(state), inputHash: hashJson({ predicate, stateHash: stateHash(state) }), predicate };
}

/**
 * Stores a host block on the head reply. `head` is the timeline's head (state and boundary); `ops` do not include the rev
 * (it is added). → `{ ok: true, receipt, tell }` or a failure; nothing is stored on a failure. `tell()` announces the block
 * (the `committed` event, as the command bus tells it): the caller calls it once the chat file has the block, never before.
 * `here()` is false when the chat the caller began in is not the open one (nothing is stored then: STALE).
 * `spec`: { type, cause, summary, key, predicate, payload, recorded, result, blockId }.
 */
export function appendHostBlock({ store, head, ops, spec, announce = null, here = () => true }) {
    if (!here()) return fail('STALE', 'Another chat was opened; nothing was stored in the chat that is open now.');
    const state = head.state;
    const source = store.sourceAt(head.boundary.index);
    if (!source) return fail('FAILED', 'There is no reply to hold the change.');
    const guard = guardFor(state, spec.predicate);
    const rev = (Number.isInteger(state.meta?.rev) ? state.meta.rev : 0) + 1;
    const all = [...ops, { op: Object.hasOwn(state.meta ?? {}, 'rev') ? 'replace' : 'add', path: '/meta/rev', value: rev }];
    const problems = checkOps(all);
    if (problems.length) return fail('INVALID', `This change breaks the state's rules: ${problems.join(' ')}`);
    const receipt = {
        id: makeId('rc'), type: spec.type, module: HOST, cause: spec.cause, seed: freshSeed(), summary: spec.summary, narrate: false,
        data: { v2: { schema: 2, key: spec.key, epoch: guard.epoch, rulesHash: guard.rulesHash, source, guard, result: structuredClone(spec.result) } },
        rev, guarded: true,
    };
    const block = {
        id: spec.blockId, module: HOST, source, guard, operation: { type: spec.type, payload: structuredClone(spec.payload) },
        recorded: structuredClone(spec.recorded ?? null), result: structuredClone(spec.result),
    };
    try {
        store.append({ ops: all, receipt, block });
    } catch (error) {
        return fail('FAILED', `The change could not be stored: ${error?.message ?? error}`);
    }
    store.scheduleSave?.();
    const tell = () => {
        if (typeof announce !== 'function') return;
        try { announce(receipt); } catch (error) { console.warn('[Story Block] A committed listener failed:', error); }
    };
    return { ok: true, receipt, tell };
}
