// Settings → Diagnostics: one plain-text report a reader copies or saves for a bug report.
//
// What it holds: the versions (SillyTavern, Story Block, each module), the features that are on, each
// module's settings, the prompt size panel's numbers and the context size, the last 20 Problems, how
// saving is going, the chat's reply and record counts and its size, the recent Story Suite errors
// from the console (when they were caught), and each module's own section (its optional
// `hooks.diagnostics()`, MODULES §F118).
//
// What it never holds: API keys, tokens, passwords, addresses and other secrets (a settings key that
// names one is left out, and a value that looks like one is replaced), and no chat text: no message is
// read for its words, Problems are listed by code, module and reply (their messages name what the
// story wrote), and quoted text in an error line is replaced by its length. The
// reader sees the whole report before copying it.
//
// Pure apart from `captureConsole` (wraps console.error once) and `noteSaveError`: the report is built
// from a `source` the settings host gives (ui-host.js).

import { promptSize } from './host-ui.js';
import { cutAt } from '../text.js';

export const PROBLEMS_SHOWN = 20;
export const ERRORS_KEPT = 20;
export const HOOK_TIMEOUT_MS = 2000;
const TEXT_MAX = 200;
const LIST_MAX = 20;
const DEPTH_MAX = 4;

// ---- removing secrets --------------------------------------------------------------------------

// A settings key holding any of these words (split at camelCase, _, -, .) is left out whole.
const SECRET_WORDS = new Set(['key', 'keys', 'apikey', 'secret', 'secrets', 'password', 'passwd', 'pwd', 'pass', 'passphrase', 'token',
    'auth', 'authorization', 'credential', 'credentials', 'cookie', 'cookies', 'bearer', 'endpoint', 'url', 'uri', 'session', 'private']);
const wordsOf = key => String(key ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** True when a settings key names a secret (apiKey, auth_token, endpointUrl, password…); "maxTokens" is not one. */
export function isSecretKey(key) {
    const words = wordsOf(key);
    return words.some(word => SECRET_WORDS.has(word)) || /api_?key/i.test(String(key ?? ''));
}

// Text that looks like a secret or an address: replaced whole.
const SECRET_VALUE = [
    /\b[a-z][a-z0-9+.-]*:\/\/\S+/i,                    // an address (http://, wss://…), with whatever it carries
    /\bbearer\s+\S+/i,
    /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/,               // sk-…, pk-…, rk-… keys, short ones too (B-a3-3)
    /\b(?:xox[abpr]-|gh[pousr]_|glpat-|AIza)[A-Za-z0-9_-]{16,}/,
    /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[0-9A-Z]{16}\b/,   // an AWS access key id
    /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]*)?/,  // a JWT ("eyJ" is '{"' in base64)
    /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,  // JWT-like: three long dotted parts
    /\b(?:[A-Fa-f0-9]{32,}|[A-Za-z0-9+/_-]{40,}={0,2})\b/,     // a long key-like run
    /\b(?:api[_-]?key|token|secret|password|passwd|auth)\s*[:=]\s*\S+/i,
];
// A long run of letters and digits with both in it ("Xq7Lm2Pz9Rt4…", most providers' keys): replaced. Found
// as a run, then tested, so a long run costs its length once (no lookahead tried from every place).
const KEY_RUN = /[A-Za-z0-9_-]{20,}/g;
const keyLike = run => /\d/.test(run) && /[A-Za-z]/.test(run);
export const REMOVED = '[removed]';

/** `text` with anything that looks like a secret or an address replaced (the rest kept). */
export function scrubSecrets(text) {
    let out = String(text ?? '');
    for (const pattern of SECRET_VALUE) out = out.replace(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`), REMOVED);
    return out.replace(KEY_RUN, run => (keyLike(run) ? REMOVED : run));
}

// Quote marks that start or end a run of a reply's words.
const QUOTE_MARK = /["“”«»„]/;

// From the first quote mark on a line to its last one, the line's quoted text (the reply's words) goes,
// only its length kept, so a quote mark inside a quoted name ('"Bob's "Lucky" mug"') leaves nothing of it
// between (B-a3-2). A quote mark with no other after it: the rest of the line goes.
function unquote(flat) {
    const marks = [...flat.matchAll(new RegExp(QUOTE_MARK.source, 'g'))];
    if (!marks.length) return flat;
    const first = marks[0].index;
    const last = marks.length > 1 ? marks.at(-1).index + 1 : flat.length;
    const inner = [...flat.slice(first + 1, marks.length > 1 ? last - 1 : last)].length;
    return `${flat.slice(0, first)}"[${inner} characters]"${flat.slice(last)}`;
}

/** A log line made safe: no quoted text (its length instead), no secrets, one line, at most `max` characters. */
export function scrubLine(text, max = 300) {
    const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
    return cutAt(scrubSecrets(unquote(flat)), max);
}

/**
 * A settings object made safe to share: secret keys left out (listed by name in `removed`), secret-looking
 * text replaced, long text cut, long lists cut with "+N more". Plain JSON in, plain JSON out.
 */
export function scrubSettings(value, removed = [], path = '', depth = 0) {
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
        const clean = scrubSecrets(value);
        return [...clean].length > TEXT_MAX ? `${cutAt(clean, TEXT_MAX)}… (${[...value].length} characters)` : clean;
    }
    if (depth >= DEPTH_MAX) return Array.isArray(value) ? `[${value.length} items]` : '{…}';
    if (Array.isArray(value)) {
        const out = value.slice(0, LIST_MAX).map((item, at) => scrubSettings(item, removed, `${path}[${at}]`, depth + 1));
        if (value.length > LIST_MAX) out.push(`+${value.length - LIST_MAX} more`);
        return out;
    }
    if (typeof value === 'object') {
        const out = {};
        for (const [key, inner] of Object.entries(value)) {
            const where = path ? `${path}.${key}` : key;
            if (isSecretKey(key)) { removed.push(where); continue; }
            if (typeof inner === 'function' || inner === undefined) continue;
            out[key] = scrubSettings(inner, removed, where, depth + 1);
        }
        return out;
    }
    return null;
}

// ---- what is caught while the page runs ----------------------------------------------------------

const PREFIXES = ['[Story Suite', '[Story Block', '[NPC State Delta', '[Story Director'];
const FOLDERS = ['Story_block', 'story_block', 'npc_state_delta', 'Story_director', 'story_director'];
const caught = { errors: [], saves: [], saveFailures: 0, seq: 0 };

const textOf = part => (part instanceof Error ? `${part.name}: ${part.message}` : typeof part === 'string' ? part : (() => {
    try { return JSON.stringify(part); } catch { return String(part); }
})());

function keep(list, entry, limit) {
    caught.seq += 1;
    list.push({ seq: caught.seq, ...entry });
    if (list.length > limit) list.splice(0, list.length - limit);
}

/** A Story Suite console error (one of its prefixes), kept for the report: one line, made safe. */
export function noteError(parts) {
    const list = Array.isArray(parts) ? parts : [parts];
    const head = textOf(list[0] ?? '');
    if (!PREFIXES.some(prefix => head.startsWith(prefix))) return false;
    keep(caught.errors, { text: scrubLine(list.map(textOf).join(' ')) }, ERRORS_KEPT);
    return true;
}

/** A save that failed (index.js's onSaveError): counted, its message kept. */
export function noteSaveError(error) {
    caught.saveFailures += 1;
    keep(caught.saves, { text: scrubLine(error?.message ?? error, 200) }, 5);
}

let consoleWrapped = null;
/**
 * Catches Story Suite's console errors (and page errors from its files) for the report, once per page.
 * The original console.error still runs first. → stop().
 */
export function captureConsole(target = globalThis.console, win = globalThis) {
    if (consoleWrapped || !target || typeof target.error !== 'function') return () => {};
    const original = target.error;
    const wrapped = function (...parts) {
        original.apply(this, parts);
        try { noteError(parts); } catch { /* the report is never worth an error */ }
    };
    target.error = wrapped;
    const onError = event => {
        const file = String(event?.filename ?? '');
        if (!FOLDERS.some(folder => file.includes(`/${folder}/`))) return;
        keep(caught.errors, { text: scrubLine(`[page] ${event?.message ?? 'error'} (${file.split('/').slice(-2).join('/')}:${event?.lineno ?? 0})`) }, ERRORS_KEPT);
    };
    win?.addEventListener?.('error', onError);
    consoleWrapped = () => {
        if (target.error === wrapped) target.error = original;
        win?.removeEventListener?.('error', onError);
        consoleWrapped = null;
    };
    return consoleWrapped;
}

/** What was caught so far (copies). */
export const caughtSoFar = () => ({ errors: caught.errors.map(item => ({ ...item })), saves: caught.saves.map(item => ({ ...item })), saveFailures: caught.saveFailures });
/** Tests: forget what was caught. */
export function resetCaught() {
    caught.errors.length = 0;
    caught.saves.length = 0;
    caught.saveFailures = 0;
}

// ---- the report ----------------------------------------------------------------------------------

const yes = value => (value === true ? 'yes' : value === false ? 'no' : 'unknown');
const num = n => (Number.isFinite(n) ? Number(n).toLocaleString('en-US') : 'unknown');

/** The chat's counts: { messages, replies, records, bytes } (bytes: the messages as JSON, about the file's size). */
export function chatCounts(chat) {
    const list = Array.isArray(chat) ? chat : [];
    let replies = 0;
    let records = 0;
    let bytes = 0;
    const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
    for (const message of list) {
        if (message && !message.is_user && !message.is_system) replies += 1;
        if (message?.extra?.storySuite && typeof message.extra.storySuite === 'object') records += 1;
        let line = '';
        try { line = JSON.stringify(message) ?? ''; } catch { line = ''; }
        bytes += (encoder ? encoder.encode(line).length : line.length) + 1;
    }
    return { messages: list.length, replies, records, bytes };
}

const sizeText = bytes => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`);

// A module's own section, from what its hook gave: text, a list of lines, or an object (key: value lines).
function hookLines(value) {
    if (value === null || value === undefined) return [];
    if (typeof value === 'string') return value.split(/\r?\n/).map(line => scrubLine(line)).filter(Boolean).slice(0, 60);
    if (Array.isArray(value)) return value.slice(0, 60).map(line => scrubLine(typeof line === 'string' ? line : textOf(line)));
    if (typeof value === 'object') {
        const lines = Array.isArray(value.lines) ? hookLines(value.lines) : [];
        const data = value.lines !== undefined ? value.data : value;
        if (data && typeof data === 'object') {
            const removed = [];
            const clean = scrubSettings(data, removed);
            for (const [key, inner] of Object.entries(clean)) lines.push(scrubLine(`${key}: ${typeof inner === 'string' ? inner : JSON.stringify(inner)}`, 400));
            if (removed.length) lines.push(`(left out: ${removed.join(', ')})`);
        }
        return lines;
    }
    return [scrubLine(String(value))];
}

function withLimit(run, ms) {
    return new Promise(resolve => {
        let done = false;
        const timer = setTimeout(() => { if (!done) { done = true; resolve({ late: true }); } }, ms);
        Promise.resolve().then(run).then(value => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ value });
        }, error => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ error });
        });
    });
}

/**
 * The queue line (model-call.js createCallQueue().stats()): "One at a time per connection: on. Waiting now: 1
 * (chat: 1). Calls that waited: 3, 2.4 s in all, longest 1.2 s." Only counts and times, never a profile's details.
 */
export function callsLine(calls) {
    if (!calls || typeof calls !== 'object') return 'One at a time per connection: unknown (no queue here).';
    const secs = ms => `${Math.round((Number(ms) || 0) / 100) / 10} s`;
    const lanes = Object.entries(calls.lanes ?? {}).length;
    const head = `One at a time per connection: ${calls.on === false ? 'off' : 'on'}. Waiting now: ${num(calls.waiting ?? 0)}${lanes ? ` on ${lanes} connection${lanes === 1 ? '' : 's'}` : ''}. Running: ${num(calls.running ?? 0)}.`;
    return `${head} Calls that waited: ${num(calls.waited ?? 0)}, ${secs(calls.waitedMs)} in all, longest ${secs(calls.longestMs)}.`;
}

/**
 * The report, as text. `source` (every part optional; a part that throws is named, the rest goes on):
 *   stVersion?() → text (or a promise), hostVersion, modules?() → [{ id, name, version }], refusals?(),
 *   features?() → [{ id, on, available }], settingsOf?(moduleId) → values, hostSettings?() → values,
 *   promptParts?() → parts or { parts, fit } (as the prompt size panel), tailBudget?,
 *   problems?() → [{ module, code, message, index, line }], save?() → { failing, dirty, suspect, pending },
 *   calls?() → the model-call queue's stats (callsLine),
 *   caught?() → caughtSoFar(), chat?() → the chat array, chatOpen?() → boolean,
 *   hooks?() → [{ moduleId, fn }] (each module's `hooks.diagnostics`), now?() → a Date (the stamp only).
 * → Promise<string>.
 */
export async function buildReport(source = {}) {
    const out = [];
    const section = title => { out.push('', `== ${title} ==`); };
    const tryPart = (title, run) => {
        try { run(); } catch (error) { out.push(`(${title} could not be read: ${scrubLine(error?.message ?? error, 160)})`); }
    };
    const stamp = (() => { try { return (source.now?.() ?? new Date()).toISOString(); } catch { return ''; } })();
    out.push('Story Suite diagnostics', stamp ? `Made ${stamp}` : '');

    section('Versions');
    let st = '';
    try { st = String(await source.stVersion?.() ?? ''); } catch { st = ''; }
    out.push(`SillyTavern: ${scrubLine(st || 'unknown', 120)}`);
    out.push(`Story Block: ${scrubLine(source.hostVersion ?? 'unknown', 60)}`);
    const modules = (() => { try { return source.modules?.() ?? []; } catch { return []; } })();
    tryPart('the modules', () => {
        for (const module of modules) {
            if (module?.id === 'story-block') continue;
            out.push(`${scrubLine(module?.name ?? module?.id, 60)} (${scrubLine(module?.id, 60)}): ${scrubLine(module?.version ?? 'unknown', 40)}`);
        }
        for (const refusal of source.refusals?.() ?? []) out.push(`Not loaded: ${scrubLine(refusal?.id ?? refusal?.moduleId ?? '?', 60)}: ${scrubLine(refusal?.reason ?? refusal?.message ?? '', 200)}`);
    });

    section('Features');
    tryPart('the features', () => {
        const list = source.features?.() ?? [];
        const on = list.filter(feature => feature?.on === true && feature.available !== false);
        out.push(`${on.length} of ${list.length} on.`);
        if (on.length) out.push(`On: ${on.map(feature => feature.id).join(', ')}`);
        const off = list.filter(feature => !(feature?.on === true && feature.available !== false));
        if (off.length) out.push(`Off: ${off.map(feature => `${feature.id}${feature.available === false ? ' (unavailable)' : ''}`).join(', ')}`);
    });

    section('Settings');
    out.push('Keys that name a key, token, password, address or other secret are left out.');
    tryPart('Story Suite\'s settings', () => {
        const removed = [];
        out.push(`Story Suite: ${JSON.stringify(scrubSettings(source.hostSettings?.() ?? {}, removed))}`);
        if (removed.length) out.push(`  left out: ${removed.join(', ')}`);
    });
    for (const module of modules) {
        tryPart(`${module?.id}'s settings`, () => {
            const removed = [];
            const values = scrubSettings(source.settingsOf?.(module.id) ?? {}, removed);
            out.push(`${module.id}: ${JSON.stringify(values)}`);
            if (removed.length) out.push(`  left out: ${removed.join(', ')}`);
        });
    }

    section('Prompt size');
    tryPart('the prompt size', () => {
        const got = source.promptParts?.();
        const parts = Array.isArray(got) ? got : got?.parts;
        const fit = Array.isArray(got) ? null : got?.fit ?? null;
        if (!Array.isArray(parts)) { out.push('No chat open (nothing to count).'); return; }
        const budget = Number.isInteger(fit?.budget) ? fit.budget : Number.isInteger(source.tailBudget) ? source.tailBudget : undefined;
        const size = promptSize(parts, budget ? { budget } : {});
        out.push(`Estimated at four characters a token. Instructions: ${num(size.static)}. This reply's part: ${num(size.tail)} of ${num(size.budget)}. In all: ${num(size.total)}.`);
        for (const row of size.modules) out.push(`  ${scrubLine(row.id, 60)}: instructions ${num(row.static)}, this reply ${num(row.tail)}`);
        if (fit) out.push(`Context size: ${num(fit.size)} tokens${fit.reply ? ` (${num(fit.reply)} for the reply)` : ''}. Story Suite's share: ${num(fit.share)} of ${num(fit.room)} (${fit.percent}%)${fit.tooSmall ? '; the context is too small' : ''}.`);
        else out.push('Context size: shown after the next reply.');
    });

    section(`Problems (the last ${PROBLEMS_SHOWN})`);
    tryPart('the problems', () => {
        const list = (source.problems?.() ?? []).slice(-PROBLEMS_SHOWN);
        if (!list.length) out.push('None.');
        // By code, module and reply only: a Problem's message names what the story wrote (an item, a person,
        // the line itself), so no message is copied (B-a3-2).
        for (const item of list) {
            const where = [item?.module ? scrubLine(item.module, 60) : 'story-block', Number.isInteger(item?.index) ? `reply ${item.index}` : ''].filter(Boolean).join(', ');
            out.push(`- [${scrubLine(item?.code ?? 'PROBLEM', 40)}] ${where}`);
        }
        const counts = new Map();
        for (const item of list) counts.set(scrubLine(item?.code ?? 'PROBLEM', 40), (counts.get(scrubLine(item?.code ?? 'PROBLEM', 40)) ?? 0) + 1);
        if (list.length) out.push(`By code: ${[...counts].map(([code, count]) => `${code} ${count}`).join(', ')}.`);
    });

    section('Saving');
    tryPart('the save status', () => {
        const save = source.save?.() ?? {};
        const seen = source.caught?.() ?? { saves: [], saveFailures: 0 };
        out.push(`Failing now: ${yes(save.failing)}. Unsaved changes: ${yes(save.dirty)}. Waiting to read the file back after a timed-out save: ${yes(save.suspect)}.`);
        out.push(`Failed saves this page load: ${num(seen.saveFailures ?? 0)}.`);
        for (const item of seen.saves ?? []) out.push(`- ${item.text}`);
    });

    section('Model calls');
    tryPart('the model calls', () => {
        const calls = source.calls?.() ?? null;
        out.push(callsLine(calls));
    });

    section('This chat');
    tryPart('the chat', () => {
        if (source.chatOpen && source.chatOpen() === false) { out.push('No chat open.'); return; }
        const counts = chatCounts(source.chat?.() ?? []);
        out.push(`Messages: ${num(counts.messages)}. Replies: ${num(counts.replies)}. Replies with a Story Suite record: ${num(counts.records)}. Size: about ${sizeText(counts.bytes)}.`);
    });

    section('Recent Story Suite errors');
    tryPart('the errors', () => {
        const errors = source.caught?.()?.errors ?? [];
        if (!errors.length) out.push('None caught since the page loaded.');
        for (const item of errors) out.push(`- ${item.text}`);
    });

    for (const { moduleId, fn } of (() => { try { return source.hooks?.() ?? []; } catch { return []; } })()) {
        const name = modules.find(module => module?.id === moduleId)?.name ?? moduleId;
        section(`${scrubLine(name, 60)} (its own)`);
        const got = await withLimit(() => fn(), HOOK_TIMEOUT_MS);
        if (got.late) out.push(`(no answer within ${HOOK_TIMEOUT_MS / 1000} s)`);
        else if (got.error) out.push(`(could not be read: ${scrubLine(got.error?.message ?? got.error, 160)})`);
        else {
            const lines = hookLines(got.value);
            out.push(...(lines.length ? lines : ['Nothing to say.']));
        }
    }
    return `${out.filter((line, at) => line !== '' || at > 0).join('\n').trim()}\n`;
}

/** The file name a saved report gets: story-suite-diagnostics-2026-10-22-0930.txt. */
export function reportFileName(date = new Date()) {
    const pad = n => String(n).padStart(2, '0');
    return `story-suite-diagnostics-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.txt`;
}
