// Ops (SPEC §2.3): the changes a committed command made, as a subset of JSON Patch (`add`, `replace`,
// `remove`) with JSON Pointer paths into the State. Story Block's commit step makes them with `diff`
// from what a handler drafted; replay rebuilds a state with `apply`; `checkOps` holds every op to the
// generic rules of §2.5 before anything is saved. Pure.
//
// How `diff` writes changes, so the same pair of states always gives the same ops:
// * Objects are compared key by key in sorted order: a key only in `before` is a `remove`, a key only
//   in `after` an `add`, a key in both is compared again one level down.
// * Arrays are compared whole. Unchanged: nothing. `after` is `before` with items added at the end: one
//   `add` per new item at its index. Anything else (an item changed, removed or moved): one `replace` of
//   the whole array. Lists in v2 state are short (records are keyed by ID, never by position), so this
//   stays small and never has to reason about index shifts.
// * Any other change (a number, a string, a type change) is a `replace` of that value.
// Values in ops are copies, never shared with the states they came from.
//
// The implementation is split under src/v2/ops/: paths, plain-JSON helpers, freezing, diff, apply,
// counters, rebase and checkOps. This file keeps its path and re-exports every public name.

import { isId } from './check.js';

export { escapeKey, parsePath, valueAt } from './ops/paths.js';
export { isJson, clone, equal } from './ops/json.js';
export { deepFreeze, isDeepFrozen, frozenCopy } from './ops/freeze.js';
export { diff } from './ops/diff.js';
export { apply } from './ops/apply.js';
export { isCounterPath, counterInside } from './ops/counters.js';
export { scratchRoot, rebaseOps } from './ops/rebase.js';
export { FORBIDDEN_KEYS, checkOps } from './ops/check.js';
