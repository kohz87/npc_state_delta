// Data-module timer and reply-end costs (moved out of data-modules/part.js unchanged): when a
// clock has moved, which reply types settle, and the roots/visits their settle steps may take.
import { DM_LIMITS as L } from '../schema.js';
import { activeDefinition } from '../adapters.js';
import { subjectsOf } from './shared.js';

// A timer whose clock has moved past its cursor.
const timerDue = (timer, inputs, instance) => {
    const minute = inputs[timer.clock]?.minutes, last = instance?.timers?.[timer.id]?.lastMinute;
    return minute !== null && minute !== undefined && (last === null || last === undefined || minute > last);
};
// A reply's lines are settled by the reply-end functions on these generations only (not a Continue's, nor the extractor's late lines).
const SETTLED_TYPES = Object.freeze(['normal', 'swipe', 'regenerate', 'reread']);
// Every node an evaluation could visit in this piece of a definition (each list, each leaf): the most its visits can come to.
const nodesOf = value => Array.isArray(value) ? 1 + value.reduce((sum, item) => sum + nodesOf(item), 0)
    : value && typeof value === 'object' ? Object.values(value).reduce((sum, item) => sum + nodesOf(item), 0) : 1;
// What the settle steps of a reply can cost: one root for each subject of each pinned block that has reply-end functions, and for the
// visits, what that block's own reply-end functions, rules and reward templates can come to (counted, not a flat share), at most one
// root's worth for a subject.
export function settleReserve(state) {
    const total = { roots: 0, visits: 0 };
    for (const module of Object.keys(state?.domains?.dataModules?.active ?? {})) {
        const definition = activeDefinition(state, module);
        if (!definition?.replyEnd?.length) continue;
        const subjects = subjectsOf(state, module).length;
        total.roots += subjects;
        total.visits += subjects * Math.min(L.rootVisits, 1 + nodesOf(definition.replyEnd) + nodesOf(definition.rules ?? []) + nodesOf(definition.rewards ?? {}));
    }
    return total;
};

export { timerDue, SETTLED_TYPES, nodesOf };
