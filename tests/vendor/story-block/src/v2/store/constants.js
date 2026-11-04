// Story Suite v2: the store's constants and small pure helpers (moved out of store.js unchanged; store.js re-exports
// the public ones). Checkpoint thresholds, the replan code an owner answers with, the host's savepoint-block test,
// the reader-setup test, and deepFreeze (every state the store hands out is deep-frozen).

import { reachesBranch } from '../evidence.js';
import { HOST_DOMAIN } from '../timeline/gate.js';

export const CHECKPOINT_EVERY = 100;
export const CHECKPOINT_BYTES = 128 * 1024;
// The bytes rule never puts checkpoints closer than this many carriers, and waits for at least twice
// the last checkpoint's own size of ops: one domain that rewrites a large list whole on every reply
// cannot make every few replies write the whole state again (b6-soak).
export const CHECKPOINT_MIN_GAP = 10;
/** The code an owner's replan answers with when the step is no longer done (REPLAY.md): only this removes a block. */
export const NO_LONGER_DONE = 'NO_LONGER_DONE';

// The host's savepoints domain (timeline/gate.js): written only by the host's own blocks (module story-block, operation savepoint.*).
// A write reaches it when its path or `from` is the domain, anything below it, or anything that holds it (/domains, the root): any op.
const HOST_BRANCH = ['domains', HOST_DOMAIN];
export const touchesHostDomain = op => !op || typeof op !== 'object' || reachesBranch(op.path, HOST_BRANCH) || reachesBranch(op.from, HOST_BRANCH);
export const hostBlock = (module, type) => module === 'story-block' && typeof type === 'string' && type.startsWith('savepoint.');
// The reader's own chat-block click (Story Block's data-module setup: define, redefine, remove, pin, attach, migrate, Add to party; cause `ui`)
// is an action on the reply, not the reply's story: a Re-read of that reply keeps it, as it keeps the reader's other actions (a swipe or a delete still takes it).
export const readerSetup = (span, receipts) => span?.guard?.owner === 'story-block' && String(span.guard.predicate?.kind ?? '').startsWith('dm.')
    && receipts.length > 0 && receipts.every(receipt => receipt?.cause === 'ui');

export const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const utf8 = new TextEncoder();
export const jsonBytes = value => utf8.encode(JSON.stringify(value)).length;

export function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const item of Object.values(value)) deepFreeze(item);
    }
    return value;
}

export const revOf = state => (Number.isInteger(state?.meta?.rev) ? state.meta.rev : 0);
