// The events part of Story Block (MODULES §A, §E): pack events checked before each reply.
//
// No domain of its own: whether an event happened is a claim in `meta.claims` (`event:<id>`), its cue a
// `system` receipt, its effects other modules' commands. The coordinator's module.js merges this part;
// `createEventsPart` takes the three dependencies so tests (and the coordinator, if it prefers) can
// inject them. The default `part` reaches them lazily through the public sdk (SPEC §6):
//   events  → view.query('packs.content', { kind: 'events' })   (SB-packs)
//   command → globalThis.StoryBlock.sdk.command
//   query   → globalThis.StoryBlock.sdk.query                  (for events.status outside a view)

import { FIRE, createEngine, createFireEvent } from './engine.js';
import { renderEventsSection } from './section.js';

export { CALLS, LIMITS, compile, evaluate, evaluateCondition, parse, tokenize } from './condition.js';
export { FIRE, claimKey, createEngine, createFireEvent, fireEvent, inspect, normalizeEvents, repeatKey } from './engine.js';
export { renderEventsSection, summaryLine } from './section.js';

const sdk = () => globalThis.StoryBlock?.sdk ?? null;

/** Event definitions from the enabled packs. */
export function packEvents(view) {
    if (typeof view?.query !== 'function') return [];
    const list = view.query('packs.content', { kind: 'events' });
    return Array.isArray(list) ? list : [];
}

export function createEventsPart({
    events = packEvents,
    command = (type, payload, options) => {
        const host = sdk();
        if (!host) return { ok: false, code: 'FAILED', message: 'Story Block is not ready.' };
        return host.command(type, payload, options);
    },
    query = (name, args) => {
        const host = sdk();
        if (!host) throw new Error('Story Block is not ready.');
        return host.query(name, args);
    },
} = {}) {
    const engine = createEngine({ events, command, query });
    // A query is called (state, args, tools) with tools.query over the same state (MODULES §F.3);
    // without tools it asks through the injected query.
    const status = (state, args, tools) => engine.status(state, typeof tools?.query === 'function' ? { state, query: tools.query } : null);
    return {
        domains: {},
        commands: { [FIRE]: createFireEvent(events) },
        queries: { 'events.status': status },
        kinds: {},
        hooks: { beforeGenerate: (view, info) => engine.beforeGenerate(view, info) },
        settings: {
            section: 'Events',
            defaults: {},
            schema: {},
            // The custom debug panel (SPEC §6 `section(el, api)`); `api.query` when the host offers it.
            render: (el, api) => renderEventsSection(el, () => {
                if (typeof api?.query === 'function') return api.query('events.status');
                const host = sdk();
                return typeof host?.query === 'function' ? host.query('events.status') : status(null);
            }),
        },
        tabs: [],
    };
}

export const part = createEventsPart();
