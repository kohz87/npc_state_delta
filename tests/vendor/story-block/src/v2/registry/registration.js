// The registry's registration checks and ownership claims, extracted from registry.js: a
// refused definition is noted and throws, and a registered one reserves its names and frozen features.

import { affectsStatic, presetsOf } from '../features.js';
import { satisfies } from '../packs/version.js';
import { isObject, definitionProblems, neededVersion, definitionWarnings } from '../registry-checks.js';

export function createRegistration({ defs, declared, owners, fallbacks, canonical, refusals, hostVersion, warn, needsOf, setPeers }) {
    const isFallback = (def, name) => def.queries?.[name]?.fallback === true;

    function noteRefusal(def, id, message, { forVersion = false } = {}) {
        refusals.set(id, {
            id,
            name: typeof def?.name === 'string' && def.name ? def.name : id,
            version: typeof def?.version === 'string' ? def.version : '',
            requires: typeof def?.requires?.storyBlock === 'string' ? def.requires.storyBlock : '',
            forVersion,
            message: message.replace(/^Story Suite: /, ''),
        });
    }

    function refuse(id, reasons, def = null) {
        const list = reasons.length === 1 ? reasons[0] : reasons.map(reason => `\n- ${reason}`).join('');
        const message = `Story Suite: the module "${id}" cannot be registered: ${list}${reasons.length === 1 ? '.' : ''}`;
        noteRefusal(def, id, message);
        throw new Error(message);
    }

    // The names this definition claims, by table: [table, name, label].
    function claims(def) {
        const out = [];
        for (const name of Object.keys(def.domains ?? {})) out.push(['domain', name, `the domain "${name}"`]);
        for (const type of Object.keys(def.commands ?? {})) out.push(['command', type, `the command "${type}"`]);
        for (const name of Object.keys(def.queries ?? {})) out.push([isFallback(def, name) ? 'fallback' : 'query', name, `the query "${name}"`]);
        for (const [kind, spec] of Object.entries(def.capture?.kinds ?? {})) {
            out.push(['kind', kind, `the capture kind "${kind}"`]);
            for (const alias of spec.aliases ?? []) out.push(['kind', alias, `the capture kind "${alias}" (an alias of "${kind}")`]);
        }
        for (const tab of def.tabs ?? []) out.push(['tab', tab.id, `the tab "${tab.id}"`]);
        for (const screen of def.screens ?? []) out.push(['screen', screen.id, `the screen "${screen.id}"`]);
        for (const name of Object.keys(def.widgets ?? {})) out.push(['widget', name, `the widget "${name}"`]);
        for (const feature of def.features ?? []) out.push(['feature', feature.id, `the feature "${feature.id}"`]);
        return out;
    }

    function register(def) {
        const id = isObject(def) && typeof def.id === 'string' ? def.id : '?';
        const problems = definitionProblems(def);
        if (problems.length) refuse(id, problems, def);
        const range = def.requires?.storyBlock;
        if (hostVersion && typeof range === 'string' && !satisfies(hostVersion, range)) {
            const message = `Story Suite: ${def.name ?? id} needs Story Block ${neededVersion(range, hostVersion)}; this is ${hostVersion}. Update Story Block to use it.`;
            noteRefusal(def, id, message, { forVersion: true });
            throw new Error(message);
        }
        if (defs.has(id)) refuse(id, ['a module with this id is already registered'], def);
        const clashes = [];
        const seen = new Set();
        for (const [table, name, label] of claims(def)) {
            const key = `${table}:${name}`;
            if (seen.has(key)) clashes.push(`${label} is named twice in it`);
            seen.add(key);
            const owner = (table === 'fallback' ? fallbacks : owners[table]).get(name);
            if (owner) clashes.push(`${label} already belongs to "${owner}"`);
        }
        if (clashes.length) refuse(id, clashes, def);
        for (const [table, name] of claims(def)) (table === 'fallback' ? fallbacks : owners[table]).set(name, id);
        for (const [kind, spec] of Object.entries(def.capture?.kinds ?? {})) {
            canonical.set(kind, kind);
            for (const alias of spec.aliases ?? []) canonical.set(alias, kind);
        }
        defs.set(id, def);
        setPeers(id, Object.freeze(Object.entries(isObject(def.requires?.peers) ? def.requires.peers : {}).map(([peer, range]) => Object.freeze({ peer, range }))));
        declared.set(id, Object.freeze((def.features ?? []).map(feature => Object.freeze({
            id: feature.id,
            label: feature.label.trim(),
            describe: typeof feature.describe === 'string' ? feature.describe.trim() : '',
            default: feature.default !== false,
            prompt: affectsStatic(def, feature.id),
            // Only a feature that says it carries `presets` (features.js): one that does not follows its default in every preset.
            ...(feature.presets === undefined ? {} : { presets: presetsOf(feature) }),
            needs: needsOf(feature),
        }))));
        refusals.delete(id);
        for (const message of definitionWarnings(def)) warn(`${def.name ?? id}: ${message}.`);
    }

    return { register };
}
