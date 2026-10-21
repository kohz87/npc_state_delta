// The module registry (docs/v2/SPEC.md §6, §12): every module's definition, checked when it
// registers, and the lookups the rest of the host asks it (who owns a domain, a command, a
// capture kind; the initial state; hooks, tabs, settings, prompt contexts). One writer per
// domain: a second owner for a domain, command, query, capture kind or tab is refused with a
// plain sentence, and nothing of the refused module is kept. Pure: no DOM, no SillyTavern.

// Commands the registry makes itself, so the command bus can run them like any other:
// `capture.<kind>` runs the owner's capture.apply on a change line (turn.js), and
// `module.init.<id>` adds a late module's initial slices (sdk.js). Modules cannot use these
// prefixes for their own commands.
export const CAPTURE_PREFIX = 'capture.';
export const INIT_PREFIX = 'module.init.';
// The host's module id and the namespace of its standard widgets (MODULES §F9).
export const HOST_MODULE = 'story-block';
export const STANDARD_PREFIX = 'ss.';

const KNOWN_KEYS = ['id', 'name', 'version', 'description', 'domains', 'commands', 'queries', 'capture', 'context', 'hooks', 'settings', 'tabs', 'screens', 'widgets'];
const FIELD_TYPES = ['bool', 'int', 'choice', 'text', 'list'];

const MODULE_ID = /^[a-z0-9][a-z0-9._-]*$/;
// Domain names are JSON Pointer segments (/domains/<name>/…): no `/` or `~`.
const DOMAIN = /^[a-z][a-zA-Z0-9_-]*$/;
const COMMAND = /^[a-z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)*$/;
const KIND = /^[a-z][a-z0-9_-]*$/;
const TAB_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
// Screen ids are namespaced like `rpg-battle/party` (§13.1); widget names like `rpg-battle.battle-board`.
const SCREEN_ID = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/;
const WIDGET_NAME = /^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)+$/;

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** '' when `value` is plain JSON (§2.1), else where it is not. */
export function jsonProblem(value, path = '') {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return '';
    if (typeof value === 'number') return Number.isFinite(value) ? '' : `${path || 'the value'} is not a finite number`;
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i += 1) {
            const problem = jsonProblem(value[i], `${path}/${i}`);
            if (problem) return problem;
        }
        return '';
    }
    const proto = isObject(value) ? Object.getPrototypeOf(value) : undefined;
    if (proto === Object.prototype || proto === null) {
        for (const [key, item] of Object.entries(value)) {
            const problem = jsonProblem(item, `${path}/${key}`);
            if (problem) return problem;
        }
        return '';
    }
    return `${path || 'the value'} is not plain JSON (${value === undefined ? 'undefined' : typeof value})`;
}

// One settings schema field: '' or what is wrong with it. A string is shorthand for its type and
// an array for a choice.
function fieldProblem(field, where) {
    const type = typeof field === 'string' ? field : Array.isArray(field) ? 'choice' : field?.type;
    if (!FIELD_TYPES.includes(type)) return `${where} has type "${type}"; use one of ${FIELD_TYPES.join(', ')}`;
    if (type === 'choice') {
        const options = Array.isArray(field) ? field : field.options;
        if (!Array.isArray(options) || !options.length) return `${where} is a choice with no options`;
    }
    if (type === 'list') {
        if (!isObject(field.of) || !Object.keys(field.of).length) return `${where} is a list with no fields in "of"`;
        for (const [key, sub] of Object.entries(field.of)) {
            if (sub?.type === 'list') return `${where}.${key} is a list inside a list, which the overlay cannot show`;
            const problem = fieldProblem(sub, `${where}.${key}`);
            if (problem) return problem;
        }
    }
    if (type === 'int') {
        for (const bound of ['min', 'max']) if (field[bound] !== undefined && !Number.isInteger(field[bound])) return `${where}.${bound} is not a whole number`;
    }
    return '';
}

/** A schema field in its long form: { type, label?, help?, min?, max?, options?, of? }. */
export function normalizeField(field) {
    if (typeof field === 'string') return { type: field };
    if (Array.isArray(field)) return { type: 'choice', options: field };
    return field;
}

/**
 * Checks a module definition (§6). Returns the list of problems, each a plain sentence part;
 * empty when it can register (clashes with other modules are checked by the registry).
 */
export function definitionProblems(def) {
    if (!isObject(def)) return ['the definition is not an object'];
    const problems = [];
    const fn = (value, where) => { if (typeof value !== 'function') problems.push(`${where} is not a function`); };
    const map = (value, where) => {
        if (value === undefined) return false;
        if (!isObject(value)) { problems.push(`${where} is not an object`); return false; }
        return true;
    };
    if (typeof def.id !== 'string' || !MODULE_ID.test(def.id)) problems.push('its id must be lowercase letters, digits, ".", "_" or "-" (like "rpg-battle")');
    for (const key of Object.keys(def)) if (!KNOWN_KEYS.includes(key)) problems.push(`"${key}" is not a module field (known: ${KNOWN_KEYS.join(', ')})`);
    for (const key of ['name', 'version', 'description']) if (def[key] !== undefined && typeof def[key] !== 'string') problems.push(`${key} is not text`);

    if (map(def.domains, 'domains')) {
        for (const [name, domain] of Object.entries(def.domains)) {
            if (!DOMAIN.test(name)) { problems.push(`the domain name "${name}" must start with a letter and use letters, digits, "_" or "-"`); continue; }
            if (!isObject(domain)) { problems.push(`domain "${name}" is not an object`); continue; }
            fn(domain.initial, `domain "${name}" initial`);
            if (domain.validate !== undefined) fn(domain.validate, `domain "${name}" validate`);
            if (typeof domain.initial === 'function') {
                let slice;
                try { slice = domain.initial(); } catch (error) { problems.push(`domain "${name}" initial() threw: ${error?.message ?? error}`); continue; }
                const problem = isObject(slice) ? jsonProblem(slice, `/domains/${name}`) : `domain "${name}" initial() does not return an object`;
                if (problem) problems.push(problem);
            }
        }
    }
    if (map(def.commands, 'commands')) {
        for (const [type, handler] of Object.entries(def.commands)) {
            if (!COMMAND.test(type)) problems.push(`the command name "${type}" must be words joined by dots (like "item.use")`);
            else if (type.startsWith(CAPTURE_PREFIX) || type.startsWith('module.')) problems.push(`the command name "${type}" uses a prefix Story Block keeps for itself ("capture." or "module.")`);
            fn(handler, `command "${type}"`);
        }
    }
    if (map(def.queries, 'queries')) {
        for (const [name, query] of Object.entries(def.queries)) {
            if (!COMMAND.test(name)) problems.push(`the query name "${name}" must be words joined by dots (like "party.actors")`);
            fn(query, `query "${name}"`);
        }
    }
    if (map(def.capture, 'capture')) {
        const kinds = def.capture.kinds;
        if (!isObject(kinds) || !Object.keys(kinds).length) problems.push('capture.kinds names no kind');
        else {
            for (const [kind, spec] of Object.entries(kinds)) {
                if (!KIND.test(kind)) problems.push(`the capture kind "${kind}" must be lowercase letters, digits, "_" or "-"`);
                if (!isObject(spec)) { problems.push(`capture kind "${kind}" is not an object`); continue; }
                if (typeof spec.grammar !== 'string' || !spec.grammar.trim()) problems.push(`capture kind "${kind}" has no grammar line`);
                else if (/\n/.test(spec.grammar.trim())) problems.push(`capture kind "${kind}" grammar is more than one line`);
                if (spec.aliases !== undefined && (!Array.isArray(spec.aliases) || spec.aliases.some(alias => typeof alias !== 'string' || !KIND.test(alias)))) {
                    problems.push(`capture kind "${kind}" aliases must be a list of lowercase words`);
                }
            }
        }
        fn(def.capture.apply, 'capture.apply');
    }
    if (map(def.context, 'context')) {
        if (def.context.static !== undefined) fn(def.context.static, 'context.static');
        if (def.context.tail !== undefined) fn(def.context.tail, 'context.tail');
        if (def.context.budget !== undefined && !(Number.isInteger(def.context.budget) && def.context.budget > 0)) problems.push('context.budget is not a positive whole number of tokens');
    }
    if (map(def.hooks, 'hooks')) for (const [name, hook] of Object.entries(def.hooks)) fn(hook, `hook "${name}"`);
    if (map(def.settings, 'settings')) {
        const { defaults, schema, section, render } = def.settings;
        if (defaults !== undefined) {
            if (!isObject(defaults)) problems.push('settings.defaults is not an object');
            else { const problem = jsonProblem(defaults, 'settings.defaults'); if (problem) problems.push(problem); }
        }
        if (schema !== undefined) {
            if (!isObject(schema)) problems.push('settings.schema is not an object');
            else for (const [key, field] of Object.entries(schema)) {
                const problem = fieldProblem(field, `settings field "${key}"`);
                if (problem) problems.push(problem);
            }
        }
        // `section` is either the custom panel itself, section(el, api), or its title with the panel
        // in `render(el, api)` (MODULES §A).
        if (section !== undefined && typeof section !== 'string') fn(section, 'settings.section');
        if (render !== undefined) fn(render, 'settings.render');
        for (const key of Object.keys(def.settings)) {
            if (!['defaults', 'schema', 'section', 'render'].includes(key)) problems.push(`"settings.${key}" is not a settings field (known: defaults, schema, section, render)`);
        }
    }
    if (def.tabs !== undefined) {
        if (!Array.isArray(def.tabs)) problems.push('tabs is not a list');
        else def.tabs.forEach((tab, index) => {
            if (!isObject(tab)) { problems.push(`tab ${index + 1} is not an object`); return; }
            if (typeof tab.id !== 'string' || !TAB_ID.test(tab.id)) problems.push(`tab ${index + 1} has no usable id`);
            if (typeof tab.title !== 'string' || !tab.title.trim()) problems.push(`tab "${tab.id ?? index + 1}" has no title`);
            if (tab.icon !== undefined && typeof tab.icon !== 'string') problems.push(`tab "${tab.id}" icon is not text`);
            fn(tab.render, `tab "${tab.id ?? index + 1}" render`);
        });
    }
    // Screens and widgets (§13): only what the registry needs (ids, a render function); the screen
    // renderer checks the rest of a screen when it shows it.
    if (def.screens !== undefined) {
        if (!Array.isArray(def.screens)) problems.push('screens is not a list');
        else def.screens.forEach((screen, index) => {
            if (!isObject(screen)) problems.push(`screen ${index + 1} is not an object`);
            else if (typeof screen.id !== 'string' || !SCREEN_ID.test(screen.id)) problems.push(`screen ${index + 1} has no usable id (like "${def.id ?? 'module'}/name")`);
        });
    }
    if (map(def.widgets, 'widgets')) {
        for (const [name, widget] of Object.entries(def.widgets)) {
            // Story Block's own standard widgets are `ss.<name>` (MODULES §F9); everyone else uses its id.
            const prefix = def.id === HOST_MODULE ? STANDARD_PREFIX : `${def.id}.`;
            if (!WIDGET_NAME.test(name) || (typeof def.id === 'string' && !name.startsWith(prefix))) problems.push(`the widget name "${name}" must start with the module id and a dot (like "${def.id}.${name.split('.').at(-1)}")`);
            if (!isObject(widget)) { problems.push(`widget "${name}" is not an object`); continue; }
            fn(widget.render, `widget "${name}" render`);
        }
    }
    return problems;
}

export function createRegistry() {
    const defs = new Map();
    const owners = { domain: new Map(), command: new Map(), query: new Map(), kind: new Map(), tab: new Map(), screen: new Map(), widget: new Map() };
    // Every capture kind and alias → its canonical kind.
    const canonical = new Map();

    const sorted = () => [...defs.values()].sort(byId);

    function refuse(id, reasons) {
        const list = reasons.length === 1 ? reasons[0] : reasons.map(reason => `\n- ${reason}`).join('');
        throw new Error(`Story Suite: the module "${id}" cannot be registered: ${list}${reasons.length === 1 ? '.' : ''}`);
    }

    // The names this definition claims, by table: [table, name, label].
    function claims(def) {
        const out = [];
        for (const name of Object.keys(def.domains ?? {})) out.push(['domain', name, `the domain "${name}"`]);
        for (const type of Object.keys(def.commands ?? {})) out.push(['command', type, `the command "${type}"`]);
        for (const name of Object.keys(def.queries ?? {})) out.push(['query', name, `the query "${name}"`]);
        for (const [kind, spec] of Object.entries(def.capture?.kinds ?? {})) {
            out.push(['kind', kind, `the capture kind "${kind}"`]);
            for (const alias of spec.aliases ?? []) out.push(['kind', alias, `the capture kind "${alias}" (an alias of "${kind}")`]);
        }
        for (const tab of def.tabs ?? []) out.push(['tab', tab.id, `the tab "${tab.id}"`]);
        for (const screen of def.screens ?? []) out.push(['screen', screen.id, `the screen "${screen.id}"`]);
        for (const name of Object.keys(def.widgets ?? {})) out.push(['widget', name, `the widget "${name}"`]);
        return out;
    }

    function register(def) {
        const id = isObject(def) && typeof def.id === 'string' ? def.id : '?';
        const problems = definitionProblems(def);
        if (problems.length) refuse(id, problems);
        if (defs.has(id)) refuse(id, ['a module with this id is already registered']);
        const clashes = [];
        const seen = new Set();
        for (const [table, name, label] of claims(def)) {
            const key = `${table}:${name}`;
            if (seen.has(key)) clashes.push(`${label} is named twice in it`);
            seen.add(key);
            const owner = owners[table].get(name);
            if (owner) clashes.push(`${label} already belongs to "${owner}"`);
        }
        if (clashes.length) refuse(id, clashes);
        for (const [table, name] of claims(def)) owners[table].set(name, id);
        for (const [kind, spec] of Object.entries(def.capture?.kinds ?? {})) {
            canonical.set(kind, kind);
            for (const alias of spec.aliases ?? []) canonical.set(alias, kind);
        }
        defs.set(id, def);
    }

    function captureEntry(word) {
        const kind = canonical.get(String(word ?? '').toLowerCase());
        if (!kind) return null;
        const def = defs.get(owners.kind.get(kind));
        return { moduleId: def.id, kind, grammar: def.capture.kinds[kind].grammar.trim(), apply: def.capture.apply };
    }

    // `module.init.<id>`: sets each of the module's domains to its initial() slice (§2.6).
    function initHandler(def) {
        return ctx => {
            for (const [name, domain] of Object.entries(def.domains ?? {})) {
                const draft = ctx.draft(name);
                if (!isObject(draft)) ctx.fail('FAILED', `The ${def.name ?? def.id} state could not be set up.`);
                for (const key of Object.keys(draft)) delete draft[key];
                Object.assign(draft, domain.initial());
            }
            return { summary: `${def.name ?? def.id} is set up.`, narrate: false, data: { module: def.id } };
        };
    }

    function command(type) {
        const name = String(type ?? '');
        if (name.startsWith(CAPTURE_PREFIX)) {
            const entry = captureEntry(name.slice(CAPTURE_PREFIX.length));
            return entry ? (ctx, line) => entry.apply(ctx, line) : null;
        }
        if (name.startsWith(INIT_PREFIX)) {
            const def = defs.get(name.slice(INIT_PREFIX.length));
            return def && Object.keys(def.domains ?? {}).length ? initHandler(def) : null;
        }
        const owner = owners.command.get(name);
        return owner ? defs.get(owner).commands[name] : null;
    }

    function commandOwner(type) {
        const name = String(type ?? '');
        if (name.startsWith(CAPTURE_PREFIX)) return captureEntry(name.slice(CAPTURE_PREFIX.length))?.moduleId ?? null;
        if (name.startsWith(INIT_PREFIX)) return command(name) ? name.slice(INIT_PREFIX.length) : null;
        return owners.command.get(name) ?? null;
    }

    function initialState() {
        const domains = {};
        const names = [...owners.domain.keys()].sort();
        for (const name of names) {
            const slice = defs.get(owners.domain.get(name)).domains[name].initial();
            const problem = isObject(slice) ? jsonProblem(slice, `/domains/${name}`) : `domain "${name}" initial() does not return an object`;
            if (problem) throw new Error(`Story Suite: the initial state cannot be built: ${problem}.`);
            domains[name] = structuredClone(slice);
        }
        return { v: 2, meta: { rev: 0, claims: {} }, domains };
    }

    return {
        register,
        has: id => defs.has(id),
        module: id => defs.get(id) ?? null,
        /** Every definition, sorted by id. */
        modules: sorted,
        domainOwner: name => owners.domain.get(name) ?? null,
        commandOwner,
        captureOwner: kind => captureEntry(kind)?.moduleId ?? null,
        queryOwner: name => owners.query.get(name) ?? null,
        /** The handler for a command type (module commands and the registry's own), or null. */
        command,
        /** { moduleId, kind, grammar, apply } for a capture kind or alias, or null. */
        capture: captureEntry,
        /** The canonical kind a written kind word stands for, or null. */
        kindOf: word => canonical.get(String(word ?? '').toLowerCase()) ?? null,
        validator(name) {
            const owner = owners.domain.get(name);
            return owner ? defs.get(owner).domains[name].validate ?? null : null;
        },
        query(name) {
            const owner = owners.query.get(name);
            return owner ? defs.get(owner).queries[name] : null;
        },
        initialState,
        /** The functions modules registered under hook `name`, in module-id order. */
        hooks: name => sorted().map(def => def.hooks?.[name]).filter(hook => typeof hook === 'function'),
        /** Same, with the module each comes from: [{ moduleId, fn }]. */
        hookEntries: name => sorted().filter(def => typeof def.hooks?.[name] === 'function').map(def => ({ moduleId: def.id, fn: def.hooks[name] })),
        /** [{ moduleId, id, title, icon, render }] in module-id order, each module's in its own order. */
        tabs: () => sorted().flatMap(def => (def.tabs ?? []).map(tab => ({ ...tab, moduleId: def.id }))),
        /** [{ moduleId, ...screen }] in module-id order, each module's in its own order (§13.1). */
        screens: () => sorted().flatMap(def => (def.screens ?? []).map(screen => ({ ...screen, moduleId: def.id }))),
        /** [{ moduleId, name, props, render }] in module-id order, then by name (§13.5). */
        widgets: () => sorted().flatMap(def => Object.keys(def.widgets ?? {}).sort().map(name => ({ ...def.widgets[name], name, moduleId: def.id }))),
        /** One widget by its namespaced name, or null. */
        widget(name) {
            const owner = owners.widget.get(name);
            return owner ? { ...defs.get(owner).widgets[name], name, moduleId: owner } : null;
        },
        /**
         * [{ moduleId, name, title, defaults, schema, section }] for modules with settings, in module-id
         * order. `section` is the custom panel function (from either form) or null; `title` the
         * section's title when one was given as text, else the module's name.
         */
        settingsDefs: () => sorted().filter(def => def.settings).map(def => ({
            moduleId: def.id,
            name: def.name ?? def.id,
            defaults: def.settings.defaults ?? {},
            schema: def.settings.schema ?? {},
            title: typeof def.settings.section === 'string' && def.settings.section.trim() ? def.settings.section.trim() : def.name ?? def.id,
            section: typeof def.settings.section === 'function' ? def.settings.section : def.settings.render ?? null,
        })),
        /** [{ moduleId, name, domains, kinds: [{ kind, grammar }], static, tail, budget }] in module-id order. */
        contexts: () => sorted().map(def => ({
            moduleId: def.id,
            name: def.name ?? def.id,
            domains: Object.keys(def.domains ?? {}),
            kinds: Object.keys(def.capture?.kinds ?? {}).sort().map(kind => ({ kind, grammar: def.capture.kinds[kind].grammar.trim() })),
            static: def.context?.static ?? null,
            tail: def.context?.tail ?? null,
            budget: def.context?.budget ?? null,
        })),
    };
}
