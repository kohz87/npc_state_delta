// The `{{sb::path}}` macro (docs/v2/PUBLIC-API.md "The macro"): SillyTavern's prompts, regex scripts and status bars read the
// public API's paths through it. `{{sb::path}}` is the value as text; `{{sb::path|fallback}}` is the fallback when the path is
// empty or hidden (the same rule as api.get: a hidden value reads as nothing). A list is a comma list; an object has no text (use a
// leaf path). At most MACRO_MAX characters, line breaks turned into spaces. Read-only: no expressions, no functions.
//
// Registered once, through SillyTavern's own macro API:
//   * SillyTavern 1.19 and later (the macro engine, the default): `context.macros.register('sb', …)`, one macro with the path as its argument;
//     taken out again with `context.macros.registry.unregisterMacro('sb')`.
//   * The old macro engine (a context without `macros`, or with the experimental engine switched off): `context.registerMacro`, which only
//     knows exact names, so one `{{sb::path}}` for each path of LEGACY_PATHS (no fallback, no other path); `context.unregisterMacro`.
// Our own injected prompt text is not touched by this: turn.js writes every `{{` of it with a zero-width space (defuseMacros), so a macro
// in a name the story introduced stays text. The value this macro returns is protected the same way.
import { plainText } from './public-api.js';
import { defuseMacros } from './turn.js';
import { cutAt } from '../text.js';

export const MACRO_NAME = 'sb';
export const MACRO_MAX = 300;
// What the old macro engine can read (one registration each, no fallback).
export const LEGACY_PATHS = Object.freeze(['scene.place', 'scene.time', 'scene.date', 'scene.weather', 'scene.present', 'money', 'money.text',
    'party.me.name', 'party.me.level', 'party.me.xp', 'party.me.health', 'party.me.mana', 'party.me.stamina']);

/**
 * The text of `{{sb::<raw>}}` for the api: `raw` is "path" or "path|fallback". A path with no text (missing, hidden, empty, an object) gives
 * the fallback, or nothing without one.
 */
export function macroText(api, raw) {
    // `path|fallback` and `path::fallback` (the safe form: SillyTavern's engine reads `|` in a few places of its own); the first of the two splits.
    const text = String(raw ?? '');
    const found = [text.indexOf('|'), text.indexOf('::')].filter(at => at >= 0).sort((a, b) => a - b)[0];
    const path = (found === undefined ? text : text.slice(0, found)).trim();
    const fallback = found === undefined ? '' : text.slice(found + (text.startsWith('::', found) ? 2 : 1)).trim();
    let value = null;
    try { value = plainText(api.get(path)); } catch { value = null; }
    if (value === null) return fallback;
    // Cut after defusing, so the result is at most MACRO_MAX characters.
    return cutAt(defuseMacros(value), MACRO_MAX);
}

/**
 * Registers the macro in `ctx` (SillyTavern's getContext()) → { engine: 'new' | 'legacy', off() }, or null where the context has no macro API.
 * `off()` takes it out again.
 */
export function registerSbMacro({ ctx, api, log = console.warn }) {
    const modern = ctx?.macros?.register && ctx.macros.registry?.unregisterMacro && ctx.powerUserSettings?.experimental_macro_engine !== false;
    try {
        if (modern) {
            // A copy of Story Block that was loaded before this one is replaced (the newer code is the one that runs).
            if (ctx.macros.registry.hasMacro?.(MACRO_NAME)) ctx.macros.registry.unregisterMacro(MACRO_NAME);
            const made = ctx.macros.register(MACRO_NAME, {
                category: 'extension',
                unnamedArgs: [{ name: 'path', description: 'A Story Block path, like scene.place or party.me.health; add |fallback for when it is empty or hidden.' }],
                list: true,
                strictArgs: false,
                description: 'A value of the story state (Story Block public API): {{sb::scene.place}}, {{sb::money.text|nothing}}.',
                returns: 'The value as text (a list as a comma list), the fallback, or nothing.',
                exampleUsage: ['{{sb::scene.place}}', '{{sb::party.me.health|unknown}}'],
                handler: ({ args }) => macroText(api, (Array.isArray(args) ? args : []).join('::')),
            });
            if (made) return { engine: 'new', off: () => { try { ctx.macros.registry.unregisterMacro(MACRO_NAME); } catch { /* already gone */ } } };
            // The engine refused it (it logs its own reason and returns null): the old way, told once.
            try { log('[Story Block v2] the macro engine did not take {{sb::…}}; trying the old macro API'); } catch { /* nothing to tell it to */ }
        }
        if (typeof ctx?.registerMacro === 'function') {
            for (const path of LEGACY_PATHS) ctx.registerMacro(`${MACRO_NAME}::${path}`, () => macroText(api, path));
            return { engine: 'legacy', off: () => { for (const path of LEGACY_PATHS) { try { ctx.unregisterMacro?.(`${MACRO_NAME}::${path}`); } catch { /* already gone */ } } } };
        }
    } catch (error) {
        try { log('[Story Block v2] the {{sb::…}} macro could not be registered', error); } catch { /* nothing to tell it to */ }
    }
    return null;
}
