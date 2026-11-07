// Story Block's part merger: one module definition from the core, packs, events and optional parts,
// preserving part order for hooks, statics, tails, tabs and settings sections.

import { hookTimeout } from '../../turn.js';

const TIMED_OUT = Symbol('timed out');
// `value`, or TIMED_OUT when it is a promise that has not settled within `ms`.
async function withinLimit(value, ms) {
    if (!value || typeof value.then !== 'function') return value;
    let timer;
    try {
        return await Promise.race([value, new Promise(resolve => { timer = setTimeout(resolve, ms, TIMED_OUT); })]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * The parts merged into one module definition (MODULES §A): domains, commands and queries side by
 * side (a name in two parts throws), capture by `line.kind`, statics joined in part order, tails
 * concatenated, budgets summed, a hook name shared by parts called in part order (beforeGenerate
 * lines and commands added up; for any other hook the first answer that is not null/undefined),
 * and each part's settings section drawn as its own block in the module's settings panel (or, with
 * `settings.fold`, as a fold of its own at the top of the settings: `folds`; with `settings.place:
 * 'diagnostics'`, a fold of its own in Settings → Diagnostics, its id `settings.fold.id` else its title
 * in lowercase: the Events).
 */
export function mergeParts(parts) {
    const out = { domains: {}, commands: {}, queries: {}, kinds: {}, cards: {}, hooks: {}, tabs: [], statics: [], tails: [], budget: 0, sections: [], folds: [], defaults: {}, schema: {} };
    const put = (table, name, value, what) => {
        if (Object.hasOwn(out[table], name)) throw new Error(`Story Block: two parts both define the ${what} "${name}".`);
        out[table][name] = value;
    };
    const hookLists = {};
    for (const part of parts) {
        for (const [name, value] of Object.entries(part.domains ?? {})) put('domains', name, value, 'domain');
        for (const [name, value] of Object.entries(part.commands ?? {})) put('commands', name, value, 'command');
        for (const [name, value] of Object.entries(part.queries ?? {})) put('queries', name, value, 'query');
        for (const [name, value] of Object.entries(part.kinds ?? {})) put('kinds', name, value, 'change-line kind');
        for (const [name, value] of Object.entries(part.cards ?? {})) put('cards', name, value, 'card under replies');
        for (const [name, fn] of Object.entries(part.hooks ?? {})) if (typeof fn === 'function') (hookLists[name] ??= []).push(fn);
        if (typeof part.context?.static === 'function') out.statics.push(part.context.static);
        if (typeof part.context?.tail === 'function') out.tails.push(part.context.tail);
        if (Number.isInteger(part.context?.budget)) out.budget += part.context.budget;
        out.tabs.push(...(part.tabs ?? []));
        const settings = part.settings ?? {};
        for (const [key, value] of Object.entries(settings.defaults ?? {})) put('defaults', key, value, 'setting');
        Object.assign(out.schema, settings.schema ?? {});
        const render = typeof settings.render === 'function' ? settings.render : typeof settings.section === 'function' ? settings.section : null;
        const title = typeof settings.section === 'string' ? settings.section : '';
        // A part whose panel is a fold of its own (`settings.fold: { id, hint? }`, the Packs) goes to the top
        // of the settings instead of the module's section.
        // A part whose panel is debug information (`settings.place: 'diagnostics'`, the Events) is a fold of
        // its own in Settings → Diagnostics.
        if (render && settings.place === 'diagnostics') {
            const id = typeof settings.fold?.id === 'string' ? settings.fold.id : title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            out.folds.push({ id, title: title || id, hint: settings.fold?.hint ?? '', render, place: 'diagnostics' });
        } else if (render && settings.fold && typeof settings.fold.id === 'string') out.folds.push({ id: settings.fold.id, title: title || settings.fold.id, hint: settings.fold.hint ?? '', render });
        else if (render) out.sections.push({ title, render });
    }
    for (const [name, fns] of Object.entries(hookLists)) {
        out.hooks[name] = fns.length === 1 ? fns[0] : name === 'beforeGenerate'
            ? Object.defineProperty(async (...args) => {
                const lines = [];
                const commands = [];
                const problems = [];
                let fightStart = null;
                // Each part has its own time limit (turn.js hookTimeout): a part that fails or is too slow is reported, and the
                // answers of the parts that did answer are kept.
                for (const fn of fns) {
                    const limit = hookTimeout(fn);
                    let answer;
                    try { answer = await withinLimit(fn(...args), limit); } catch (error) {
                        problems.push({ code: 'FAILED', message: `beforeGenerate failed: ${error?.message ?? error}` });
                        continue;
                    }
                    if (answer === TIMED_OUT) {
                        problems.push({ code: 'TIMEOUT', message: `beforeGenerate did not answer within ${limit / 1000} s; the reply went on without its notes.` });
                        continue;
                    }
                    if (Array.isArray(answer)) lines.push(...answer);
                    else {
                        lines.push(...(Array.isArray(answer?.lines) ? answer.lines : []));
                        commands.push(...(Array.isArray(answer?.commands) ? answer.commands : []));
                        if (answer?.fightStart) fightStart = answer.fightStart;
                    }
                }
                return { lines, commands, ...(fightStart ? { fightStart } : {}), ...(problems.length ? { problems } : {}) };
            }, 'timeoutMs', { enumerable: true, get: () => fns.reduce((sum, fn) => sum + hookTimeout(fn), 500) })
            // afterCapture: every part's steps are run, in part order (the data blocks' timers and reply-end steps, then the RPG's fight XP).
            : name === 'afterCapture' ? (...args) => {
                const answers = fns.map(fn => fn(...args));
                const join = list => {
                    const commands = list.flatMap(answer => (Array.isArray(answer?.commands) ? answer.commands : []));
                    return commands.length ? { commands } : list.find(answer => answer !== undefined && answer !== null);
                };
                return answers.some(answer => typeof answer?.then === 'function') ? Promise.all(answers).then(join) : join(answers);
            }
            : (...args) => {
                for (const fn of fns) {
                    const answer = fn(...args);
                    if (answer !== undefined && answer !== null) return answer;
                }
                return undefined;
            };
    }
    return out;
}
