// The registry's feature lookups (features.js): declarations as registered, the on/off and needs
// checks, hypothetical reads and the feature-off predicate, extracted from registry.js.
// `createFeatureLookups` is given the registry's maps and the lifecycle lookups it calls.

import { NEEDS_HINT, featureOf } from '../features.js';
import { isObject } from '../registry-checks.js';

export function createFeatureLookups({ defs, declared, owners, fallbacks, canonical, featureValue, held, lifecycle }) {
    function featureDecl(id) {
        const owner = owners.feature.get(String(id ?? ''));
        if (!owner) return null;
        const def = defs.get(owner);
        const feature = declared.get(owner)?.find(item => item.id === id);
        if (!feature) return null;
        const { needs } = feature;
        // A feature of a module held back (dormant, restore barrier) is not available, whatever it needs.
        const heldOwner = held(owner);
        const available = !heldOwner && availableFor(needs);
        return Object.freeze({
            id: feature.id,
            moduleId: owner,
            moduleName: typeof def?.name === 'string' && def.name ? def.name : owner,
            label: feature.label,
            describe: feature.describe,
            default: feature.default,
            prompt: feature.prompt,
            ...(feature.presets === undefined ? {} : { presets: feature.presets }),
            needs,
            available,
            why: available ? '' : heldOwner ? lifecycle(owner).reason : needs.why,
        });
    }
    // `needs` in full: { kinds, commands, queries, why } (lists of names; why: the overlay's reason).
    function needsOf(feature) {
        const given = isObject(feature.needs) ? feature.needs : {};
        const list = key => (Array.isArray(given[key]) ? given[key].map(String) : []);
        const why = typeof given.why === 'string' && given.why.trim() ? given.why.trim() : NEEDS_HINT;
        return Object.freeze({ kinds: Object.freeze(list('kinds')), commands: Object.freeze(list('commands')), queries: Object.freeze(list('queries')), why });
    }
    // Available: every kind, command and query it needs is registered (by any module, whatever its
    // features say: a feature never waits on another's switch).
    // Held back, a module's kinds, commands and queries are not there for another's feature to need.
    const there = (table, name) => table.has(name) && !held(table.get(name));
    const availableFor = needs => needs.kinds.every(kind => canonical.has(kind.toLowerCase()) && !held(owners.kind.get(canonical.get(kind.toLowerCase()))))
        && needs.commands.every(type => there(owners.command, type))
        && needs.queries.every(name => there(owners.query, name) || there(fallbacks, name));
    // What a read would say with other switches (`withFeatures`): feature id → true | false, set only while that call runs.
    let asIf = null;
    // On: the reader's choice when there is one, else the feature's default; an id no module declares, or
    // a feature whose `needs` no module meets, is off.
    function featureOn(id) {
        const decl = featureDecl(id);
        if (!decl || !decl.available) return false;
        if (asIf?.has(decl.id)) return asIf.get(decl.id) === true;
        let value;
        try { value = featureValue(decl.id); } catch { value = undefined; }
        return typeof value === 'boolean' ? value : decl.default;
    }
    // Runs `read` (synchronously) as if the features in `switches` (a Map or an object, id → true | false) had those states and the
    // rest were as they are: what a preset would send, counted without switching anything. Nothing is stored or told, and the
    // reader's choices are back the moment `read` returns (or throws). An unavailable feature stays off, as it does in a real read.
    function withFeatures(switches, read) {
        const before = asIf;
        asIf = switches instanceof Map ? switches : new Map(Object.entries(isObject(switches) ? switches : {}));
        try { return read(); } finally { asIf = before; }
    }
    // True while a `withFeatures` read runs: what it asks is not the story as it is.
    const hypothetical = () => asIf !== null;
    // Is this item (a kind spec, a command, a hook, a tab…) under a feature that is off?
    const off = item => {
        const id = featureOf(item);
        return id !== null && !featureOn(id);
    };
    const offQuery = () => null;

    return { featureDecl, needsOf, featureOn, withFeatures, hypothetical, off, offQuery };
}
