// The module registry (docs/v2/SPEC.md §6, §12): every module's definition, checked when it
// registers, and the lookups the rest of the host asks it (who owns a domain, a command, a
// capture kind; the initial state; hooks, tabs, settings, prompt contexts). One writer per
// domain: a second owner for a domain, command, query, capture kind or tab is refused with a
// plain sentence, and nothing of the refused module is kept. Pure: no DOM, no SillyTavern.
//
// Old and new versions meet (SPEC §6): a module may say which Story Block it needs
// (`requires: { storyBlock: '>=2.0.0' }`) and is refused with "needs Story Block ≥ x" when this
// one is older; a field this host does not know (a newer module's) is logged and ignored, never a
// refusal. A domain's initial() that throws when a chat starts costs that domain only.
//
// Features (MODULES §F100, features.js): what a module marks `feature: '<id>'` is left out of the
// lookups while the reader has that feature off: its capture kinds' grammar and its context (contexts),
// its hooks, tabs, screens and widgets; its queries answer null (query); its commands are known but
// refused by the bus (commandFeature); a change line of its kinds is told quietly (capture().off).
// `featureValue(id)` gives the reader's stored choice (true, false or undefined for the default).

import { compareVersions, formatVersion, parseRange, parseVersion, satisfies } from './packs/version.js';
import { affectsStatic, featureOf, featureProblems, featureWarnings } from './features.js';

// Commands the registry makes itself, so the command bus can run them like any other:
// `capture.<kind>` runs the owner's capture.apply on a change line (turn.js), and
// `module.init.<id>` adds a late module's initial slices (sdk.js). Modules cannot use these
// prefixes for their own commands.
//
// Internal commands (`isInternal(type)`): those two families, and any module command marked
// `internal: true` (the events part's `events.fire`). They are steps the host takes itself (a change
// line, a module's set-up, a due event): the command bus refuses them with cause 'ui', from the top or
// through ctx.call, and the public sdk refuses to send them at all, so no button, screen, widget or
// layout can name one. A command is marked either as `{ handler, internal: true }` in `commands`, or
// as a handler function that carries `internal === true` itself.
export const CAPTURE_PREFIX = 'capture.';
export const INIT_PREFIX = 'module.init.';
// The host's module id and the namespace of its standard widgets (MODULES §F9).
export const HOST_MODULE = 'story-block';
export const STANDARD_PREFIX = 'ss.';

const KNOWN_KEYS = ['id', 'name', 'version', 'description', 'requires', 'domains', 'commands', 'queries', 'capture', 'context', 'hooks', 'settings', 'tabs', 'screens', 'widgets', 'features'];
const CONTEXT_KEYS = ['static', 'tail', 'budget', 'feature', 'parts'];
const COMMAND_KEYS = ['handler', 'internal', 'feature'];
export const FIELD_TYPES = Object.freeze(['bool', 'int', 'choice', 'text', 'list']);

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

const fieldType = field => (typeof field === 'string' ? field : Array.isArray(field) ? 'choice' : field?.type);

// One settings schema field: '' or what is wrong with it. A string is shorthand for its type and
// an array for a choice. A type this Story Block does not know (a newer module's) is no problem: the
// field is hidden and its value kept as it is (definitionWarnings says so).
function fieldProblem(field, where) {
    const type = fieldType(field);
    if (typeof type === 'string' && type && !FIELD_TYPES.includes(type)) return '';
    if (!FIELD_TYPES.includes(type)) return `${where} has no type; use one of ${FIELD_TYPES.join(', ')}`;
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
    for (const key of ['name', 'version', 'description']) if (def[key] !== undefined && typeof def[key] !== 'string') problems.push(`${key} is not text`);
    if (def.requires !== undefined) {
        if (!isObject(def.requires)) problems.push('requires is not an object (like { storyBlock: ">=2.0.0" })');
        else if (def.requires.storyBlock !== undefined && (typeof def.requires.storyBlock !== 'string' || !parseRange(def.requires.storyBlock))) {
            problems.push('requires.storyBlock is not a version range (like ">=2.0.0" or "^2")');
        }
    }

    if (map(def.domains, 'domains')) {
        for (const [name, domain] of Object.entries(def.domains)) {
            if (!DOMAIN.test(name)) { problems.push(`the domain name "${name}" must start with a letter and use letters, digits, "_" or "-"`); continue; }
            if (!isObject(domain)) { problems.push(`domain "${name}" is not an object`); continue; }
            fn(domain.initial, `domain "${name}" initial`);
            if (domain.validate !== undefined) fn(domain.validate, `domain "${name}" validate`);
            if (domain.counters !== undefined && (!Array.isArray(domain.counters) || domain.counters.some(path => typeof path !== 'string' || !/^[^/~][^~]*$/.test(path)))) {
                problems.push(`domain "${name}" counters must be a list of paths inside the domain, like "wallets/*/coin"`);
            }
            if (domain.scratch !== undefined && (!Array.isArray(domain.scratch) || domain.scratch.some(key => typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)))) {
                problems.push(`domain "${name}" scratch must be a list of field names in the domain, like "perReply"`);
            }
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
            if (isObject(handler)) {
                fn(handler.handler, `command "${type}" handler`);
                if (handler.internal !== undefined && typeof handler.internal !== 'boolean') problems.push(`command "${type}" internal is not true or false`);
            } else fn(handler, `command "${type}"`);
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
        // A context part: static and/or tail text of its own, usually under a feature (MODULES §F100).
        if (def.context.parts !== undefined) {
            if (!Array.isArray(def.context.parts)) problems.push('context.parts is not a list');
            else def.context.parts.forEach((part, index) => {
                const where = `context part ${index + 1}`;
                if (!isObject(part)) { problems.push(`${where} is not an object`); return; }
                if (part.static === undefined && part.tail === undefined) problems.push(`${where} has neither static nor tail`);
                if (part.static !== undefined) fn(part.static, `${where} static`);
                if (part.tail !== undefined) fn(part.tail, `${where} tail`);
            });
        }
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
    problems.push(...featureProblems(def));
    return problems;
}

/**
 * The fields of a definition this host does not know (a newer module's, like MODULES §F100's
 * `features`): plain sentences. They are logged when the module registers and otherwise ignored.
 */
export function definitionWarnings(def) {
    if (!isObject(def)) return [];
    const out = Object.keys(def).filter(key => !KNOWN_KEYS.includes(key)).map(key => `"${key}" is not a module field this Story Block knows; it is ignored`);
    if (isObject(def.requires)) {
        for (const key of Object.keys(def.requires)) if (key !== 'storyBlock') out.push(`"requires.${key}" is not a requires field this Story Block knows; it is ignored`);
    }
    // One level down the same (R2-b7-2): a newer module's command option, settings part or field type.
    if (isObject(def.commands)) {
        for (const [type, handler] of Object.entries(def.commands)) {
            if (isObject(handler)) for (const key of Object.keys(handler)) if (!COMMAND_KEYS.includes(key)) out.push(`"${key}" on command "${type}" is not a command field this Story Block knows; it is ignored`);
        }
    }
    if (isObject(def.context)) {
        for (const key of Object.keys(def.context)) if (!CONTEXT_KEYS.includes(key)) out.push(`"context.${key}" is not a context field this Story Block knows; it is ignored`);
    }
    out.push(...featureWarnings(def));
    if (isObject(def.settings)) {
        for (const key of Object.keys(def.settings)) if (!['defaults', 'schema', 'section', 'render'].includes(key)) out.push(`"settings.${key}" is not a settings field this Story Block knows; it is ignored`);
        const fields = isObject(def.settings.schema) ? Object.entries(def.settings.schema) : [];
        for (const [key, field] of fields) {
            const subs = fieldType(field) === 'list' && isObject(field?.of) ? Object.entries(field.of).map(([sub, inner]) => [`${key}.${sub}`, inner]) : [];
            for (const [where, inner] of [[key, field], ...subs]) {
                const type = fieldType(inner);
                if (typeof type === 'string' && type && !FIELD_TYPES.includes(type)) out.push(`settings field "${where}" has the type "${type}", which this Story Block does not know; it is hidden and its value kept`);
            }
        }
    }
    return out;
}


// What a refused module needs, for the reader: "≥ 2.1.0" when every alternative of the range starts
// at a version above `version`, else the range as written ("<2", "^1.4").
function neededVersion(range, version) {
    const v = parseVersion(version);
    const alternatives = parseRange(range);
    if (!v || !alternatives) return range;
    const lows = alternatives.map(checks => checks
        .filter(([op]) => op === '>=' || op === '=')
        .map(([, target]) => target)
        .reduce((best, target) => (!best || compareVersions(target, best) > 0 ? target : best), null));
    if (lows.some(low => !low)) return range;
    const lowest = lows.reduce((a, b) => (compareVersions(a, b) <= 0 ? a : b));
    return compareVersions(lowest, v) > 0 ? `≥ ${formatVersion(lowest)}` : range;
}

/**
 * `hostVersion`: this Story Block's version (runtime.js VERSION), checked against each module's
 * `requires.storyBlock`; null skips that check (a registry built outside the host).
 * `warn(message)`: where definition warnings and failed initial() calls go (default console.warn).
 */
export function createRegistry({ hostVersion = null, warn = message => console.warn(`[Story Suite] ${message}`), featureValue = () => undefined } = {}) {
    const defs = new Map();
    const owners = { domain: new Map(), command: new Map(), query: new Map(), kind: new Map(), tab: new Map(), screen: new Map(), widget: new Map(), feature: new Map() };
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
        for (const feature of def.features ?? []) out.push(['feature', feature.id, `the feature "${feature.id}"`]);
        return out;
    }

    function register(def) {
        const id = isObject(def) && typeof def.id === 'string' ? def.id : '?';
        const problems = definitionProblems(def);
        if (problems.length) refuse(id, problems);
        const range = def.requires?.storyBlock;
        if (hostVersion && typeof range === 'string' && !satisfies(hostVersion, range)) {
            throw new Error(`Story Suite: ${def.name ?? id} needs Story Block ${neededVersion(range, hostVersion)}; this is ${hostVersion}. Update Story Block to use it.`);
        }
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
        for (const message of definitionWarnings(def)) warn(`${def.name ?? id}: ${message}.`);
    }

    // ---- features (features.js) -----------------------------------------------------------------

    function featureDecl(id) {
        const owner = owners.feature.get(String(id ?? ''));
        if (!owner) return null;
        const def = defs.get(owner);
        const feature = def.features.find(item => item.id === id);
        return Object.freeze({
            id: feature.id,
            moduleId: def.id,
            moduleName: def.name ?? def.id,
            label: feature.label.trim(),
            describe: typeof feature.describe === 'string' ? feature.describe.trim() : '',
            default: feature.default !== false,
            prompt: affectsStatic(def, feature.id),
        });
    }
    // On: the reader's choice when there is one, else the feature's default; an id no module declares is off.
    function featureOn(id) {
        const decl = featureDecl(id);
        if (!decl) return false;
        let value;
        try { value = featureValue(decl.id); } catch { value = undefined; }
        return typeof value === 'boolean' ? value : decl.default;
    }
    // Is this item (a kind spec, a command, a hook, a tab…) under a feature that is off?
    const off = item => {
        const id = featureOf(item);
        return id !== null && !featureOn(id);
    };
    const offQuery = () => null;

    // A context with its parts folded in: one static() and one tail(view) of what is on.
    function contextOf(def) {
        const context = isObject(def.context) ? def.context : {};
        const whole = !off(context);
        const parts = whole ? [{ static: context.static, tail: context.tail }, ...(Array.isArray(context.parts) ? context.parts : []).filter(part => !off(part))] : [];
        const statics = parts.map(part => part.static).filter(item => typeof item === 'function');
        const tails = parts.map(part => part.tail).filter(item => typeof item === 'function');
        const joined = statics.length <= 1 ? statics[0] ?? null
            : () => statics.map(item => item()).filter(text => typeof text === 'string' && text.trim()).map(text => text.trim()).join('\n');
        const tail = tails.length <= 1 ? tails[0] ?? null : view => {
            const lines = [];
            const optional = [];
            for (const item of tails) {
                const out = item(view) ?? {};
                if (Array.isArray(out.lines)) lines.push(...out.lines);
                if (Array.isArray(out.optional)) optional.push(...out.optional);
            }
            return { lines, optional };
        };
        return { static: joined, tail };
    }

    function captureEntry(word) {
        const kind = canonical.get(String(word ?? '').toLowerCase());
        if (!kind) return null;
        const def = defs.get(owners.kind.get(kind));
        const spec = def.capture.kinds[kind];
        return { moduleId: def.id, kind, grammar: spec.grammar.trim(), apply: def.capture.apply, feature: featureOf(spec), off: off(spec) };
    }

    // The feature a command belongs to (a capture.<kind> command: its kind's), or null.
    function commandFeature(type) {
        const name = String(type ?? '');
        if (name.startsWith(CAPTURE_PREFIX)) return captureEntry(name.slice(CAPTURE_PREFIX.length))?.feature ?? null;
        if (name.startsWith(INIT_PREFIX)) return null;
        return featureOf(commandEntry(name));
    }

    // One domain's initial() slice, a plain copy; null when it throws or is not plain JSON. Each
    // failure is logged once (until that domain works again), so a broken domain costs only itself
    // and the retry at every later turn stays quiet.
    const failing = new Map();
    function initialSlice(name) {
        const owner = owners.domain.get(name);
        const def = defs.get(owner);
        let problem = '';
        let slice = null;
        try {
            slice = def.domains[name].initial();
            problem = isObject(slice) ? jsonProblem(slice, `/domains/${name}`) : `initial() does not return an object`;
        } catch (error) {
            problem = `initial() threw: ${error?.message ?? error}`;
        }
        if (!problem) {
            failing.delete(name);
            return structuredClone(slice);
        }
        if (failing.get(name) !== problem) {
            failing.set(name, problem);
            warn(`${def.name ?? owner}: the domain "${name}" could not be set up (${problem}); the rest of the story goes on without it, and it is tried again later.`);
        }
        return null;
    }

    // `module.init.<id>`: sets the module's domains the state lacks to their initial() slices (§2.6).
    // The payload names them ({ domains: [...] }, from sdk.js ensureModules); without it, every
    // domain of the module. Either way a domain the chat already holds is never reset (a module that
    // gains a domain keeps the data of the others). A domain whose initial() fails is skipped; the
    // command fails only when none could be set up.
    function initHandler(def) {
        return (ctx, payload) => {
            const own = Object.keys(def.domains ?? {});
            const lacking = name => typeof ctx.read !== 'function' || ctx.read(name) == null;
            const named = own.filter(name => (!Array.isArray(payload?.domains) || payload.domains.includes(name)) && lacking(name));
            const done = [];
            for (const name of named) {
                const slice = initialSlice(name);
                if (!slice) continue;
                const draft = ctx.draft(name);
                if (!isObject(draft)) ctx.fail('FAILED', `The ${def.name ?? def.id} state could not be set up.`);
                for (const key of Object.keys(draft)) delete draft[key];
                Object.assign(draft, slice);
                done.push(name);
            }
            if (named.length && !done.length) ctx.fail('FAILED', `The ${def.name ?? def.id} state could not be set up: ${named.map(name => failing.get(name) ?? '').filter(Boolean).join('; ')}.`);
            return { summary: `${def.name ?? def.id} is set up.`, narrate: false, data: { module: def.id, domains: done } };
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
        const entry = commandEntry(name);
        return entry ? (isObject(entry) ? entry.handler : entry) : null;
    }

    function commandEntry(name) {
        const owner = owners.command.get(name);
        return owner ? defs.get(owner).commands[name] : null;
    }

    // Steps the host takes itself (see the top): never a reader's action.
    function isInternal(type) {
        const name = String(type ?? '');
        if (name.startsWith(CAPTURE_PREFIX) || name.startsWith(INIT_PREFIX)) return true;
        const entry = commandEntry(name);
        return Boolean(entry) && entry.internal === true;
    }

    function commandOwner(type) {
        const name = String(type ?? '');
        if (name.startsWith(CAPTURE_PREFIX)) return captureEntry(name.slice(CAPTURE_PREFIX.length))?.moduleId ?? null;
        if (name.startsWith(INIT_PREFIX)) return command(name) ? name.slice(INIT_PREFIX.length) : null;
        return owners.command.get(name) ?? null;
    }

    // A domain whose initial() fails is left out (logged once); sdk.js ensureModules adds it later.
    function initialState() {
        const domains = {};
        const names = [...owners.domain.keys()].sort();
        for (const name of names) {
            const slice = initialSlice(name);
            if (slice) domains[name] = slice;
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
        /** True for a command only the host runs (capture.*, module.init.*, commands marked internal). */
        isInternal,
        /** { moduleId, kind, grammar, apply, feature, off } for a capture kind or alias, or null. */
        capture: captureEntry,
        /** The canonical kind a written kind word stands for, or null. */
        kindOf: word => canonical.get(String(word ?? '').toLowerCase()) ?? null,
        validator(name) {
            const owner = owners.domain.get(name);
            return owner ? defs.get(owner).domains[name].validate ?? null : null;
        },
        /** The fields a domain keeps per-reply bookkeeping in (`scratch`, ops.js), [] when none. */
        scratch(name) {
            const owner = owners.domain.get(name);
            const list = owner ? defs.get(owner).domains[name].scratch : null;
            return Array.isArray(list) ? [...list] : [];
        },
        /** The number paths a domain keeps as counts (`counters`, ops.js), [] when none. */
        counters(name) {
            const owner = owners.domain.get(name);
            const list = owner ? defs.get(owner).domains[name].counters : null;
            return Array.isArray(list) ? [...list] : [];
        },
        /** The query function; one answering null while its feature is off. */
        query(name) {
            const owner = owners.query.get(name);
            if (!owner) return null;
            const fn = defs.get(owner).queries[name];
            return off(fn) ? offQuery : fn;
        },
        initialState,
        /** The functions modules registered under hook `name`, in module-id order. */
        // Hooks, tabs, screens and widgets under a feature that is off are left out of these lists.
        hooks: name => sorted().map(def => def.hooks?.[name]).filter(hook => typeof hook === 'function' && !off(hook)),
        /** Same, with the module each comes from: [{ moduleId, fn }]. */
        hookEntries: name => sorted().filter(def => typeof def.hooks?.[name] === 'function' && !off(def.hooks[name])).map(def => ({ moduleId: def.id, fn: def.hooks[name] })),
        /** [{ moduleId, id, title, icon, render }] in module-id order, each module's in its own order. */
        tabs: () => sorted().flatMap(def => (def.tabs ?? []).filter(tab => !off(tab)).map(tab => ({ ...tab, moduleId: def.id }))),
        /** [{ moduleId, ...screen }] in module-id order, each module's in its own order (§13.1). */
        screens: () => sorted().flatMap(def => (def.screens ?? []).filter(screen => !off(screen)).map(screen => ({ ...screen, moduleId: def.id }))),
        /** [{ moduleId, name, props, render }] in module-id order, then by name (§13.5). */
        widgets: () => sorted().flatMap(def => Object.keys(def.widgets ?? {}).sort().filter(name => !off(def.widgets[name])).map(name => ({ ...def.widgets[name], name, moduleId: def.id }))),
        /** One widget by its namespaced name, or null (also while its feature is off). */
        widget(name) {
            const owner = owners.widget.get(name);
            return owner && !off(defs.get(owner).widgets[name]) ? { ...defs.get(owner).widgets[name], name, moduleId: owner } : null;
        },
        /** True when a module's screen `id` is under a feature that is off (whoever restyled it). */
        screenOff(id) {
            const owner = owners.screen.get(id);
            return Boolean(owner) && off(defs.get(owner).screens.find(screen => screen.id === id));
        },
        /** The names of the widgets whose feature is off. */
        widgetsOff: () => sorted().flatMap(def => Object.keys(def.widgets ?? {}).sort().filter(name => off(def.widgets[name]))),
        /** Every declared feature: [{ id, moduleId, moduleName, label, describe, default, prompt }], module-id order. */
        features: () => sorted().flatMap(def => (def.features ?? []).map(feature => featureDecl(feature.id))),
        /** One declared feature, or null. */
        feature: featureDecl,
        /** Whether feature `id` is on (the reader's choice, else its default); false for an id no module declares. */
        featureOn,
        /** The feature command `type` belongs to, or null; the bus refuses it with FEATURE_OFF while that is off. */
        commandFeature,
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
        // Kinds and context (parts) under a feature that is off are left out (MODULES §F100).
        contexts: () => sorted().map(def => {
            const context = contextOf(def);
            return {
                moduleId: def.id,
                name: def.name ?? def.id,
                domains: Object.keys(def.domains ?? {}),
                kinds: Object.keys(def.capture?.kinds ?? {}).sort().filter(kind => !off(def.capture.kinds[kind])).map(kind => ({ kind, grammar: def.capture.kinds[kind].grammar.trim() })),
                static: context.static,
                tail: context.tail,
                budget: def.context?.budget ?? null,
            };
        }),
    };
}
