// Story Suite v2: the store's writes (append, before, replaceStory, reconcile, setNarrated, setPracticeRule, receipts, truncate, untold, work,
// rebuild, archived, archiveList, batch, renamed, touch, lifecycleChanged, saveIdle, saveLate, idleSaves), moved out of createStore unchanged: the methods of
// `api` that change the chat's records or its saving. `createWrite(s, deps)` returns them as one object and createStore puts each in `api` at
// the place it was. It is given the store's state holder `s`, the store's options it reads (rescue, place) and the store functions it calls
// (the other parts' come from their factories). It never imports store.js.
//
// The parts: write/saving.js touch, lifecycleChanged, saveIdle, saveLate, idleSaves; write/story.js append, before; write/replace.js
// replaceStory, reconcile; write/records.js setNarrated, setPracticeRule, receipts, truncate, untold, work; write/lifecycle.js
// rebuild, archived, archiveList, batch, renamed. This file composes them in the order the object had.

import { createSavingStart, createSavingEnd } from './write/saving.js';
import { createStory } from './write/story.js';
import { createReplace } from './write/replace.js';
import { createRecords } from './write/records.js';
import { createLifecycle } from './write/lifecycle.js';

export function createWrite(s, deps) {
    return {
        ...createSavingStart(s, deps),
        ...createStory(s, deps),
        ...createReplace(s, deps),
        ...createRecords(s, deps),
        ...createLifecycle(s, deps),
        ...createSavingEnd(s, deps),
    };
}
