// The host's check of a guard's epoch and rules hash (contract §6 and §8; docs/v2/REPLAY.md left it to the timeline
// package; docs/v2/TIMELINE.md). Pure: it looks at the state before a block and at the guard the block carries.
//
// * epoch: the savepoints domain (host-owned, made by the first save point) names the epoch of the timeline. A
//   guarded block recorded under another epoch was made on a timeline that a restore has since replaced (or one that
//   never had the restore it leans on), so it stays off. A chat with no savepoints domain has not had a restore:
//   nothing to compare, and every epoch is as good as another (old stores and modules that never use the timeline
//   behave as they did).
// * rulesHash: the `rules` slice of the state carries the frozen ruleset's hash at its root (the same marker
//   sdk.preflight reads). A guard that names a hash must meet that hash when the state has one. A state with
//   no rules marker has nothing to compare it with.

import { GENESIS_EPOCH, epochOf } from '../replay.js';

export const HOST_DOMAIN = 'savepoints';
export const RULES_DOMAIN = 'rules';
// (the genesis epoch and the epoch of a state are replay.js's: ctx.epoch reads the same function)
export { GENESIS_EPOCH, epochOf };

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

/** The frozen ruleset's hash the state carries (its `rules` slice), else null. */
export function rulesHashOf(state) {
    const slice = state?.domains?.[RULES_DOMAIN];
    return isObject(slice) && typeof slice.rulesHash === 'string' && slice.rulesHash ? slice.rulesHash : null;
}

/** '' when `guard` may be asked on `state`, else the sentence that says why it stays off. */
export function gateProblem(state, guard) {
    if (!isObject(guard)) return '';
    const domain = state?.domains?.[HOST_DOMAIN];
    // (only what the guard names is compared: a guard without an epoch, or without rules, has nothing to meet there)
    if (isObject(domain) && typeof domain.epoch === 'string' && domain.epoch && guard.epoch !== undefined && guard.epoch !== null && guard.epoch !== domain.epoch) {
        return `it was recorded in epoch ${guard.epoch}, and this timeline is in epoch ${domain.epoch}`;
    }
    const rules = rulesHashOf(state);
    if (guard.rulesHash !== null && guard.rulesHash !== undefined && rules !== null && guard.rulesHash !== rules) {
        return 'it was recorded under other rules than the ones this timeline has frozen';
    }
    return '';
}
