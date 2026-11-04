// Story Suite v2: the registry's definition checks (moved out of registry.js unchanged; registry.js re-exports the public ones):
// the naming and shape rules, `definitionProblems` (what refuses a module) and `definitionWarnings` (what is only logged), the
// version a definition needs, and the capture heads and grammar a definition declares. Pure: no DOM, no SillyTavern, no state.

import { parseRange, parseVersion, compareVersions, formatVersion } from './packs/version.js';
import { HOST_DOMAIN } from './timeline/gate.js';
import { SLUG } from './packs/limits.js';
import { featureProblems, featureWarnings } from './features.js';

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
// The states of the restore barrier (setRestore); only 'pending' holds modules back.
export const RESTORE_STATES = Object.freeze(['idle', 'pending', 'failed']);
export const STANDARD_PREFIX = 'ss.';

// The settings fields this host knows, and the places a module's settings may ask for (`settings.place`,
// or a fold's `place`): 'diagnostics' draws it as a sub-fold of Settings → Diagnostics (SPEC §6).
const SETTINGS_KEYS = ['defaults', 'schema', 'section', 'render', 'folds', 'place', 'rules'];
export const SETTINGS_PLACES = Object.freeze(['diagnostics']);
export const placeOf = value => (SETTINGS_PLACES.includes(value) ? value : null);
const KNOWN_KEYS = ['id', 'name', 'version', 'description', 'requires', 'domains', 'commands', 'queries', 'replayQueries', 'capture', 'context', 'hooks', 'settings', 'tabs', 'screens', 'widgets', 'features', 'cards', 'participant', 'batchResults', 'capabilities'];
const CONTEXT_KEYS = ['static', 'tail', 'budget', 'feature', 'parts'];
// What `requires` may name: the Story Block it needs, and the peers (modules) it needs registered.
const REQUIRES_KEYS = ['storyBlock', 'peers'];
// How many capability names a module may declare (`capabilities`: what a pack's requires.capabilities can name).
export const MAX_CAPABILITIES = 32;
const COMMAND_KEYS = ['handler', 'internal', 'prelude', 'feature', 'enabled'];
export const FIELD_TYPES = Object.freeze(['bool', 'int', 'choice', 'text', 'list', 'profile']);

const MODULE_ID = /^[a-z0-9][a-z0-9._-]*$/;
// Domain names are JSON Pointer segments (/domains/<name>/…): no `/` or `~`.
const DOMAIN = /^[a-z][a-zA-Z0-9_-]*$/;
const COMMAND = /^[a-z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)*$/;
const KIND = /^[a-z][a-z0-9_-]*$/;
const TAB_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const FOLD_ID = /^[a-z0-9][a-z0-9_-]*$/;
// Screen ids are namespaced like `story-director/world` (§13.1); widget names like `story-director.world-card`.
const SCREEN_ID = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/;
const WIDGET_NAME = /^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)+$/;

export const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

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
    if (!Array.isArray(field) && typeof field === 'object' && field.readOnly !== undefined && typeof field.readOnly !== 'boolean' && typeof field.readOnly !== 'function') {
        return `${where}.readOnly is not true, false or a function of the values`;
    }
    if (!Array.isArray(field) && typeof field === 'object' && field.shows !== undefined && typeof field.shows !== 'function') {
        return `${where}.shows is not a function of the values`;
    }
    return '';
}

/** A schema field in its long form: { type, label?, help?, min?, max?, options?, of?, readOnly?, shows? }. */
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
    if (typeof def.id !== 'string' || !MODULE_ID.test(def.id)) problems.push('its id must be lowercase letters, digits, ".", "_" or "-" (like "story-director")');
    for (const key of ['name', 'version', 'description']) if (def[key] !== undefined && typeof def[key] !== 'string') problems.push(`${key} is not text`);
    if (def.requires !== undefined) {
        if (!isObject(def.requires)) problems.push('requires is not an object (like { storyBlock: ">=2.0.0" })');
        else if (def.requires.storyBlock !== undefined && (typeof def.requires.storyBlock !== 'string' || !parseRange(def.requires.storyBlock))) {
            problems.push('requires.storyBlock is not a version range (like ">=2.0.0" or "^2")');
        }
        if (def.requires.peers !== undefined) {
            if (!isObject(def.requires.peers)) problems.push('requires.peers is not an object (like { "story-director": "^2" })');
            else for (const [peer, range] of Object.entries(def.requires.peers)) {
                if (!MODULE_ID.test(peer)) problems.push(`requires.peers names "${peer}", which is not a module id (like "story-director")`);
                else if (typeof range !== 'string' || !parseRange(range)) problems.push(`requires.peers["${peer}"] is not a version range (like ">=2.0.0" or "^2")`);
            }
        }
    }

    if (def.capabilities !== undefined) {
        if (!Array.isArray(def.capabilities)) problems.push('capabilities is not a list of names (like ["custom-data"])');
        else if (def.capabilities.length > MAX_CAPABILITIES) problems.push(`capabilities lists more than ${MAX_CAPABILITIES} names`);
        else for (const name of def.capabilities) {
            if (typeof name !== 'string' || !SLUG.test(name)) problems.push(`capabilities names ${JSON.stringify(name)}, which is not a capability name (lowercase words joined by "-", like "custom-data")`);
        }
    }

    if (map(def.domains, 'domains')) {
        for (const [name, domain] of Object.entries(def.domains)) {
            if (!DOMAIN.test(name)) { problems.push(`the domain name "${name}" must start with a letter and use letters, digits, "_" or "-"`); continue; }
            if (name === HOST_DOMAIN) { problems.push(`the domain name "${name}" is the host's own (the timeline's save points); a module cannot declare it`); continue; }
            if (!isObject(domain)) { problems.push(`domain "${name}" is not an object`); continue; }
            fn(domain.initial, `domain "${name}" initial`);
            if (domain.deferred !== undefined && typeof domain.deferred !== 'boolean') problems.push(`domain "${name}" deferred must be true or false`);
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
                if (handler.prelude !== undefined && typeof handler.prelude !== 'boolean') problems.push(`command "${type}" prelude is not true or false`);
            } else fn(handler, `command "${type}"`);
        }
    }
    if (map(def.queries, 'queries')) {
        for (const [name, query] of Object.entries(def.queries)) {
            if (!COMMAND.test(name)) problems.push(`the query name "${name}" must be words joined by dots (like "party.actors")`);
            fn(query, `query "${name}"`);
        }
    }
    // The queries a guard may ask on replay (docs/v2/REPLAY.md): the module's own, named here, and a promise that each depends on
    // the state and its arguments alone.
    if (def.replayQueries !== undefined) {
        if (!Array.isArray(def.replayQueries)) problems.push('replayQueries is not a list of query names');
        else {
            for (const name of def.replayQueries) {
                if (typeof name !== 'string') problems.push('replayQueries names something that is not a query name');
                else if (typeof def.queries?.[name] !== 'function') problems.push(`replayQueries names "${name}", which is not one of this module's queries`);
            }
        }
    }
    if (map(def.capture, 'capture')) {
        const kinds = def.capture.kinds;
        if (!isObject(kinds) || !Object.keys(kinds).length) problems.push('capture.kinds names no kind');
        else {
            for (const [kind, spec] of Object.entries(kinds)) {
                if (!KIND.test(kind)) problems.push(`the capture kind "${kind}" must be lowercase letters, digits, "_" or "-"`);
                if (!isObject(spec)) { problems.push(`capture kind "${kind}" is not an object`); continue; }
                // `grammar` may be a function answering the line when the static part is built (a line that depends on what is
                // installed, such as an enabled pack: Story Block's `you`); it must answer one line of text.
                if (typeof spec.grammar === 'function') { /* read where it is used (grammarOf) */ }
                // (`heads`: a kind may send no grammar line and only name the heads a stray line of it is taken by, ['+ event', '~ event'].)
                else if (typeof spec.grammar === 'string' && !spec.grammar.trim() && headsOf(spec).length) { /* no line in the prompt, only heads */ }
                else if (typeof spec.grammar !== 'string' || !spec.grammar.trim()) problems.push(`capture kind "${kind}" has no grammar line`);
                else if (/\n/.test(spec.grammar.trim())) problems.push(`capture kind "${kind}" grammar is more than one line`);
                // Heads take stray lines for a kind, so each must name that kind (or an alias of it): another kind's head would take its lines.
                if (spec.heads !== undefined) {
                    const own = new Set([kind, ...(Array.isArray(spec.aliases) ? spec.aliases : [])]);
                    for (const head of Array.isArray(spec.heads) ? spec.heads : [spec.heads]) {
                        if (!own.has(typeof head === 'string' ? head.split(' ')[1] : undefined)) problems.push(`capture kind "${kind}" has a head "${String(head)}" that does not name the kind itself`);
                    }
                }
                if (spec.aliases !== undefined && (!Array.isArray(spec.aliases) || spec.aliases.some(alias => typeof alias !== 'string' || !KIND.test(alias)))) {
                    problems.push(`capture kind "${kind}" aliases must be a list of lowercase words`);
                }
                // A display kind (SPEC §4.4): read for the reader alone, no command runs (extras.js).
                if (spec.display !== undefined && spec.display !== false) {
                    const display = spec.display;
                    if (display !== true && !isObject(display)) problems.push(`capture kind "${kind}" display is not true or an object`);
                    else if (isObject(display)) {
                        if (display.perReply !== undefined && !(Number.isInteger(display.perReply) && display.perReply > 0)) problems.push(`capture kind "${kind}" display.perReply is not a positive whole number`);
                        if (display.read !== undefined && typeof display.read !== 'function') problems.push(`capture kind "${kind}" display.read is not a function`);
                        if (display.noun !== undefined && typeof display.noun !== 'string') problems.push(`capture kind "${kind}" display.noun is not text`);
                    }
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
    // Cards under replies (reply-cards.js): each is { for(state, message, ctx) }.
    if (map(def.cards, 'cards')) {
        for (const [id, card] of Object.entries(def.cards)) {
            if (!isObject(card)) problems.push(`card "${id}" is not an object`);
            else fn(card.for, `card "${id}" for`);
        }
    }
    if (map(def.settings, 'settings')) {
        const { defaults, schema, section, render, folds } = def.settings;
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
        // `folds`: panels of their own at the top of the settings, after Story Suite's (Story Block's Packs).
        if (folds !== undefined) {
            if (!Array.isArray(folds)) problems.push('settings.folds is not a list');
            else folds.forEach((item, index) => {
                const where = `settings fold ${index + 1}`;
                if (!isObject(item)) { problems.push(`${where} is not an object`); return; }
                if (typeof item.id !== 'string' || !FOLD_ID.test(item.id)) problems.push(`${where} has no usable id`);
                if (typeof item.title !== 'string' || !item.title.trim()) problems.push(`${where} has no title`);
                if (item.hint !== undefined && typeof item.hint !== 'string') problems.push(`${where}'s hint is not text`);
                fn(item.render, `${where} render`);
            });
        }
    }
    if (def.tabs !== undefined) {
        if (!Array.isArray(def.tabs)) problems.push('tabs is not a list');
        else def.tabs.forEach((tab, index) => {
            if (!isObject(tab)) { problems.push(`tab ${index + 1} is not an object`); return; }
            if (typeof tab.id !== 'string' || !TAB_ID.test(tab.id)) problems.push(`tab ${index + 1} has no usable id`);
            if (typeof tab.title !== 'string' || !tab.title.trim()) problems.push(`tab "${tab.id ?? index + 1}" has no title`);
            if (tab.icon !== undefined && typeof tab.icon !== 'string') problems.push(`tab "${tab.id}" icon is not text`);
            if (tab.bar !== undefined && typeof tab.bar !== 'boolean') problems.push(`tab "${tab.id}" bar is not true or false`);
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
        for (const key of Object.keys(def.requires)) if (!REQUIRES_KEYS.includes(key)) out.push(`"requires.${key}" is not a requires field this Story Block knows; it is ignored`);
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
        for (const key of Object.keys(def.settings)) if (!SETTINGS_KEYS.includes(key)) out.push(`"settings.${key}" is not a settings field this Story Block knows; it is ignored`);
        // `place`: where the module's fold (or one of its own folds) goes; only 'diagnostics' is known.
        const placeWarning = (value, where) => (value !== undefined && !SETTINGS_PLACES.includes(value) ? [`${where} is ${JSON.stringify(value)}, a place this Story Block does not know; the fold stays where it was`] : []);
        out.push(...placeWarning(def.settings.place, '"settings.place"'));
        if (Array.isArray(def.settings.folds)) def.settings.folds.forEach((item, index) => { if (isObject(item)) out.push(...placeWarning(item.place, `settings fold ${index + 1}'s place`)); });
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
export function neededVersion(range, version) {
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
/** The heads a kind names for stray lines (`heads`: ['+ event', '- event']): only well-formed "op kind" strings; [] for none. */
export function headsOf(spec) {
    return Array.isArray(spec?.heads) ? spec.heads.filter(head => typeof head === 'string' && /^[+\-~!?] \p{L}[\p{L}\p{N}_-]*$/u.test(head)) : [];
}

/**
 * A capture kind's grammar line: its text, or what its function answers now (one line of text; '' when it answers anything else).
 * `hint` (optional) is what the prompt being built tells the function (prompt.js assemble: { view, rolled }); without it the line is the full one.
 */
export function grammarOf(spec, hint) {
    let line = spec?.grammar;
    if (typeof line === 'function') {
        try { line = line(hint); } catch { line = ''; }
    }
    line = typeof line === 'string' ? line.trim() : '';
    return /\n/.test(line) ? '' : line;
}
