// The public sdk's event bus: named events, listeners, and a failing listener logged rather than thrown.

import { EVENTS } from './constants.js';

/** { on(name, fn) → off, emit(name, payload) }; a listener that throws is logged, not passed on. */
export function createEvents() {
    const listeners = new Map(EVENTS.map(name => [name, new Set()]));
    const known = name => {
        if (!listeners.has(name)) throw new Error(`Story Suite: there is no "${name}" event (known: ${EVENTS.join(', ')}).`);
        return listeners.get(name);
    };
    return {
        on(name, fn) {
            if (typeof fn !== 'function') throw new Error('Story Suite: on() needs a function.');
            const set = known(name);
            set.add(fn);
            return () => set.delete(fn);
        },
        emit(name, payload) {
            for (const fn of [...known(name)]) {
                try { fn(payload); } catch (error) { console.warn(`[Story Suite] a "${name}" listener failed`, error); }
            }
        },
    };
}
