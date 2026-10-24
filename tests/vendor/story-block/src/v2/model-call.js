// sdk.callModel (MODULES §G, §F124): a module's own model call, on the chat's connection or on one of
// SillyTavern's Connection Manager profiles. It never posts to the chat and never touches its history,
// and it never switches the reader's connection: a profile's call goes straight to that profile's API
// with its settings (ConnectionManagerRequestService.sendRequest, SillyTavern 1.19), so there is nothing
// to switch back. The chat's connection is called with generateRaw, which sends the prompt as it is (no
// chat, card or extension prompts) and leaves the chat alone.
//
// The rules (createModelCalls): one call in flight per module (a second is refused with BUSY), a time
// limit and the caller's AbortSignal, FEATURE_OFF while the module's feature is off, and every failure as
// { ok: false, error, message }, never a throw. The log line holds the module, the profile's name, the
// time taken and the outcome code: never the prompt, the answer, an error's words or anything of the
// profile's (its address, key or model).
//
// The reader's reply always comes first on the chat's connection (generateRaw runs SillyTavern's
// prompt-ready events, which the turn reads): a call there waits while a reply is being built or awaited
// (the `gate`, turn.js whenIdle), and its prompt is marked as our own (createOwnCalls) so the turn never
// takes it for the reply's. A profile's call (sendRequest) runs none of that and goes at once.
//
// One queue per connection (createCallQueue, MODULES §G): Delta's scan, the arc planner and Assist can ask
// at the same moment, and a single-slot local server answers one at a time (or not at all). Calls on the
// same named profile run one at a time, in the order they came, each with its own time limit and signal
// (a call that runs out of time or is cancelled while it waits leaves the queue and never runs); calls on
// different profiles still run side by side. The chat's connection ('' / 'chat', generateRaw) has a lane
// of its own too, entered only after the turn's whenIdle wait, so a reply in progress never holds it.
// The host setting `callQueue` (default on) turns the queue off; Diagnostics shows its length and waits.
//
// Everything of SillyTavern is read when called, never at import.

import { answerText, findProfile } from './assist/st-adapter.js';
import { cutAt } from '../text.js';

/** The default time limit of one call (ms), and the bounds a caller's `timeoutMs` is kept inside. */
export const MODEL_CALL_TIMEOUT_MS = 60_000;
export const MODEL_CALL_TIMEOUT_MIN = 1_000;
export const MODEL_CALL_TIMEOUT_MAX = 600_000;
/** maxTokens when a caller gives none, and the most it may ask. */
export const MODEL_CALL_TOKENS = 300;
export const MODEL_CALL_TOKENS_MAX = 8_000;
/** A profile name is kept to this many characters (settings and calls alike). */
export const PROFILE_NAME_MAX = 100;
/** What `profile` may say for the chat's own connection (besides ''). */
export const CHAT_PROFILE = 'chat';

export const MODEL_CALL_ERRORS = Object.freeze({
    FEATURE_OFF: 'FEATURE_OFF',
    BUSY: 'BUSY',
    TIMEOUT: 'TIMEOUT',
    ABORTED: 'ABORTED',
    BAD_REQUEST: 'BAD_REQUEST',
    NO_PROFILE: 'NO_PROFILE',
    UNAVAILABLE: 'UNAVAILABLE',
    EMPTY: 'EMPTY',
    FAILED: 'FAILED',
});

export const MODEL_CALL_TEXT = Object.freeze({
    featureOff: 'The feature "{feature}" is turned off, so its model call was not made.',
    busy: '{module} already has a model call on its way; this one was not made.',
    timeout: 'The model did not answer within {seconds} s.',
    aborted: 'The model call was cancelled.',
    noPrompt: 'A model call needs a prompt (text).',
    noSystem: 'A model call\'s system text must be text.',
    unavailable: 'Model calls are not available here.',
    empty: 'The model answered with nothing.',
    failed: 'The model call failed: {why}',
    noSt: 'SillyTavern is not available.',
    noRaw: 'This SillyTavern cannot make a separate model call (no generateRaw).',
    cmOff: 'Connection Profiles is turned off in SillyTavern\'s extensions, so the profile "{name}" cannot be used.',
    noCm: 'This SillyTavern has no Connection Manager, so the profile "{name}" cannot be used.',
    noProfile: 'There is no connection profile called "{name}" in SillyTavern\'s Connection Manager.',
    listCmOff: 'Connection Profiles is turned off in SillyTavern\'s extensions, so every call uses the chat\'s connection.',
    listNoCm: 'This SillyTavern has no Connection Manager, so every call uses the chat\'s connection.',
});

const context = () => globalThis.SillyTavern?.getContext?.() ?? null;
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (all, key) => (Object.hasOwn(values, key) ? String(values[key]) : all));

/** A profile setting or argument as stored: trimmed, cut at PROFILE_NAME_MAX; '' (the chat's) for 'chat' or nothing. */
export function profileName(value) {
    if (typeof value !== 'string') return '';
    const name = cutAt(value.trim(), PROFILE_NAME_MAX).trim();
    return name.toLowerCase() === CHAT_PROFILE ? '' : name;
}

const cmDisabled = ctx => ctx?.extensionSettings?.disabledExtensions?.includes?.('connection-manager') === true;

/**
 * The Connection Manager's profiles for a dropdown: { usable, why, profiles: [{ id, name }] }, by name.
 * `usable` is false (with `why`) when SillyTavern has no Connection Manager or it is turned off. Only the
 * profiles that can make a text call (its isProfileSupported), and only their id and name: never an
 * address, key or other field.
 */
export function listProfiles(ctx = context()) {
    if (!ctx) return { usable: false, why: MODEL_CALL_TEXT.noSt, profiles: [] };
    if (cmDisabled(ctx)) return { usable: false, why: MODEL_CALL_TEXT.listCmOff, profiles: [] };
    const service = ctx.ConnectionManagerRequestService;
    if (typeof service?.sendRequest !== 'function') return { usable: false, why: MODEL_CALL_TEXT.listNoCm, profiles: [] };
    const list = ctx.extensionSettings?.connectionManager?.profiles;
    const profiles = [];
    for (const profile of Array.isArray(list) ? list : []) {
        if (typeof profile?.id !== 'string' || !profile.id.trim()) continue;
        try {
            if (typeof service.isProfileSupported === 'function' && !service.isProfileSupported(profile)) continue;
        } catch { continue; }
        const name = String(profile.name || profile.id);
        if (profiles.some(item => item.id === profile.id)) continue;
        profiles.push({ id: profile.id, name });
    }
    profiles.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase(), 'en'));
    return { usable: true, why: '', profiles };
}

// A failure the call itself raised, with a plain sentence (st's own words stay out of it when they
// may say more than they should: only the first line, cut short, with anything key-like masked).
class CallError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

const KEYLIKE = /\b(?:sk|pk|key|api|bearer)[-_ ]?[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{32,}/gi;
/** An error's words as safe to show: its first line (or its cause's), cut at 160, key-like runs masked. */
export function safeReason(error) {
    const raw = error?.cause?.message ?? error?.message ?? (typeof error === 'string' ? error : '');
    const line = String(raw ?? '').split(/\r?\n/)[0].replace(KEYLIKE, '…').trim();
    return cutAt(line || 'no reason given', 160);
}

/**
 * The SillyTavern call behind sdk.callModel: `prompt` → the model's text (throws a CallError or an
 * error). `options`: { maxTokens, profile ('' = the chat's connection, else a Connection Manager profile's
 * name or id), system, signal }. A named profile that is missing is an error (the reader chose that
 * model on purpose, so the chat's is not used in its place).
 */
export async function stModelCall(prompt, { maxTokens = MODEL_CALL_TOKENS, profile = '', system = '', signal = null } = {}) {
    const ctx = context();
    if (!ctx) throw new CallError(MODEL_CALL_ERRORS.UNAVAILABLE, MODEL_CALL_TEXT.noSt);
    const name = profileName(profile);
    const text = String(prompt);
    if (name) {
        if (cmDisabled(ctx)) throw new CallError(MODEL_CALL_ERRORS.NO_PROFILE, fill(MODEL_CALL_TEXT.cmOff, { name }));
        const service = ctx.ConnectionManagerRequestService;
        if (typeof service?.sendRequest !== 'function') throw new CallError(MODEL_CALL_ERRORS.NO_PROFILE, fill(MODEL_CALL_TEXT.noCm, { name }));
        const found = findProfile(ctx, name) ?? ctx.extensionSettings?.connectionManager?.profiles?.find?.(item => item?.id === name) ?? null;
        if (!found?.id) throw new CallError(MODEL_CALL_ERRORS.NO_PROFILE, fill(MODEL_CALL_TEXT.noProfile, { name }));
        const messages = system ? [{ role: 'system', content: String(system) }, { role: 'user', content: text }] : [{ role: 'user', content: text }];
        return answerText(await service.sendRequest(found.id, messages, maxTokens, { stream: false, signal, extractData: true }));
    }
    const raw = ctx.generateRaw;
    if (typeof raw !== 'function') throw new CallError(MODEL_CALL_ERRORS.UNAVAILABLE, MODEL_CALL_TEXT.noRaw);
    // generateRaw takes no signal: an abandoned call's answer is dropped (createModelCalls).
    const out = raw.length >= 2
        ? await raw.call(ctx, text, '', false, false, String(system ?? ''), maxTokens)
        : await raw.call(ctx, { prompt: text, systemPrompt: String(system ?? ''), responseLength: maxTokens });
    return answerText(out);
}

// The part of a prompt that SillyTavern's macro pass (substituteParams) leaves as it is: its longest
// stretch between macros, trimmed ('' when there is none worth matching).
const MACRO = /\{\{[\s\S]*?\}\}|<(?:USER|BOT|CHAR|CHARIFNOTGROUP|GROUP)>/gi;
export function promptKey(prompt) {
    const pieces = String(prompt ?? '').split(MACRO).flatMap(piece => piece.split(/\r?\n/)).map(piece => piece.trim());
    const longest = pieces.reduce((best, piece) => (piece.length > best.length ? piece : best), '');
    return longest.length >= 8 ? cutAt(longest, 400) : '';
}
const contentOf = content => (typeof content === 'string' ? content
    : Array.isArray(content) ? content.map(part => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '')).join('\n') : '');

/**
 * Our own calls on the chat's connection, so the turn can tell their prompt from the reply's:
 * { around(prompt, fn) → fn()'s result (the call is ours while fn runs), owns(eventData) → true for the
 * prompt-ready event (CHAT_COMPLETION_PROMPT_READY { chat } or GENERATE_AFTER_COMBINE_PROMPTS { prompt })
 * of one of them, size() }. Each call's prompt is matched once: a raw call's chat is at most three
 * messages (system, user, prefill) and holds the prompt's key (promptKey); a text prompt holds it. A prompt
 * too short for a key is taken by position, as the first such short chat after it started (never a text
 * prompt, which may be the reply's).
 */
export function createOwnCalls() {
    const live = new Map();
    let next = 0;
    return {
        async around(prompt, fn) {
            next += 1;
            const id = next;
            live.set(id, { key: promptKey(prompt), seen: false });
            try {
                return await fn();
            } finally {
                live.delete(id);
            }
        },
        owns(eventData) {
            if (!live.size || !eventData || eventData.dryRun === true) return false;
            const chat = Array.isArray(eventData.chat) ? eventData.chat : null;
            const text = chat ? (chat.length <= 3 ? chat.map(message => contentOf(message?.content)).join('\n') : null)
                : typeof eventData.prompt === 'string' ? eventData.prompt : null;
            if (text === null) return false;
            for (const call of live.values()) {
                if (call.seen) continue;
                if (call.key ? text.includes(call.key) : chat !== null) {
                    call.seen = true;
                    return true;
                }
            }
            return false;
        },
        size: () => live.size,
    };
}

const now = () => (typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now());

class QueueLeft extends Error {
    constructor() {
        super('The call left the queue before its turn.');
        this.code = 'QUEUE_LEFT';
    }
}

/**
 * The per-connection queue. `deps`: { enabled() → bool (the host's `callQueue` setting; default on),
 * clock() → ms (for the waits' report only, never state) }. Returns { run(key, fn, { signal }) → fn()'s
 * result, stats() → { on, waiting, running, waited, waitedMs, longestMs, lanes: { [key]: waiting } } }.
 * `key` is the profile's stored name ('' the chat's). A call waits while another of its key runs; one
 * whose `signal` aborts while it waits leaves the queue and rejects (code QUEUE_LEFT) without running.
 * A running call frees its key when it settles or when its signal aborts (a timed-out chat call cannot be
 * stopped; the next one does not wait for its late answer).
 */
export function createCallQueue({ enabled = () => true, clock = now } = {}) {
    const lanes = new Map();
    let waited = 0;
    let waitedMs = 0;
    let longestMs = 0;
    const lane = key => {
        let found = lanes.get(key);
        if (!found) {
            found = { running: false, waiting: [] };
            lanes.set(key, found);
        }
        return found;
    };
    const isOn = () => {
        try { return enabled() !== false; } catch { return true; }
    };
    function next(key) {
        const item = lanes.get(key);
        if (!item || item.running) return;
        const first = item.waiting.shift();
        if (!first) {
            lanes.delete(key);
            return;
        }
        item.running = true;
        first.start();
    }
    async function run(key, fn, { signal = null } = {}) {
        if (!isOn()) return fn();
        const name = String(key ?? '');
        const item = lane(name);
        if (signal?.aborted) throw new QueueLeft();
        if (item.running || item.waiting.length) {
            const asked = clock();
            await new Promise((resolve, reject) => {
                const entry = {
                    start: () => {
                        signal?.removeEventListener?.('abort', leave);
                        const ms = Math.max(0, clock() - asked);
                        waited += 1;
                        waitedMs += ms;
                        longestMs = Math.max(longestMs, ms);
                        resolve();
                    },
                };
                const leave = () => {
                    const at = item.waiting.indexOf(entry);
                    if (at >= 0) item.waiting.splice(at, 1);
                    reject(new QueueLeft());
                };
                signal?.addEventListener?.('abort', leave, { once: true });
                item.waiting.push(entry);
                next(name);
            });
        } else item.running = true;
        let freed = false;
        const free = () => {
            if (freed) return;
            freed = true;
            signal?.removeEventListener?.('abort', free);
            item.running = false;
            next(name);
        };
        signal?.addEventListener?.('abort', free, { once: true });
        try {
            return await fn();
        } finally {
            free();
        }
    }
    function stats() {
        let waiting = 0;
        let running = 0;
        const byLane = {};
        for (const [key, item] of lanes) {
            waiting += item.waiting.length;
            if (item.running) running += 1;
            if (item.waiting.length) byLane[key || CHAT_PROFILE] = item.waiting.length;
        }
        return { on: isOn(), waiting, running, waited, waitedMs: Math.round(waitedMs), longestMs: Math.round(longestMs), lanes: byLane };
    }
    return { run, stats };
}
const intIn = (value, min, max, fallback) => (Number.isFinite(value) && value > 0 ? Math.min(max, Math.max(min, Math.round(value))) : fallback);

/**
 * The rules around a model call. `deps`: { call(prompt, { maxTokens, profile, system, signal }) → text
 * (stModelCall by default; the runtime's `callModel` option, the testkit's fake), featureOn(id) → bool,
 * featureModule(id) → the module id that declares it (or null), timeoutMs (MODEL_CALL_TIMEOUT_MS), log(line),
 * timer ({ setTimeout, clearTimeout }), gate?: { whenIdle() → Promise } (a call on the chat's connection
 * waits for it: no reply in progress; a profile's call does not), queue?: createCallQueue() (one call at a time
 * per connection; default: a queue of its own) }.
 * Returns { callModel(request), busy(module) }: `callModel({ profile, system, prompt, maxTokens, signal,
 * feature, module, timeoutMs })` → Promise<{ ok: true, text, error: null } | { ok: false, text: '', error
 * (a MODEL_CALL_ERRORS code), message }>, never rejecting. The module is `module`, else the owner of
 * `feature`, else '' (callers that name neither share one slot).
 */
export function createModelCalls({ call = stModelCall, featureOn = () => true, featureModule = () => null, timeoutMs = MODEL_CALL_TIMEOUT_MS, log = line => console.info(line), timer = globalThis, gate = null, queue = createCallQueue() } = {}) {
    const inFlight = new Set();
    const defaultTimeout = intIn(timeoutMs, MODEL_CALL_TIMEOUT_MIN, MODEL_CALL_TIMEOUT_MAX, MODEL_CALL_TIMEOUT_MS);
    const fail = (error, message) => ({ ok: false, text: '', error, message });
    const tell = (module, profile, started, outcome) => {
        try {
            log(`[Story Suite] model call: ${module || 'a module'}, ${profile || 'the chat\'s connection'}, ${Math.max(0, Math.round(now() - started))} ms, ${outcome}`);
        } catch { /* a log that fails changes nothing */ }
    };

    // `internal` (the host's own calls, never the sdk's): { idle: false } skips the whenIdle wait (the
    // pre-roll asks while the reply is being prepared).
    async function callModel(request = {}, internal = {}) {
        const started = now();
        const req = request && typeof request === 'object' ? request : {};
        const feature = typeof req.feature === 'string' && req.feature.trim() ? req.feature.trim() : null;
        let owner = '';
        try { owner = typeof req.module === 'string' && req.module.trim() ? req.module.trim() : feature ? String(featureModule(feature) ?? '') : ''; } catch { owner = ''; }
        const profile = profileName(req.profile);
        const done = (result, outcome = result.ok ? 'ok' : result.error) => {
            tell(owner, profile, started, outcome);
            return result;
        };
        if (typeof req.prompt !== 'string' || !req.prompt.trim()) return done(fail(MODEL_CALL_ERRORS.BAD_REQUEST, MODEL_CALL_TEXT.noPrompt));
        if (req.system !== undefined && req.system !== null && typeof req.system !== 'string') return done(fail(MODEL_CALL_ERRORS.BAD_REQUEST, MODEL_CALL_TEXT.noSystem));
        let on = true;
        if (feature) {
            try { on = featureOn(feature) === true; } catch { on = false; }
        }
        if (!on) return done(fail(MODEL_CALL_ERRORS.FEATURE_OFF, fill(MODEL_CALL_TEXT.featureOff, { feature })));
        const signal = req.signal ?? null;
        if (signal?.aborted) return done(fail(MODEL_CALL_ERRORS.ABORTED, MODEL_CALL_TEXT.aborted));
        if (inFlight.has(owner)) return done(fail(MODEL_CALL_ERRORS.BUSY, fill(MODEL_CALL_TEXT.busy, { module: owner || 'This module' })));

        const limit = intIn(req.timeoutMs, MODEL_CALL_TIMEOUT_MIN, MODEL_CALL_TIMEOUT_MAX, defaultTimeout);
        const maxTokens = intIn(req.maxTokens, 1, MODEL_CALL_TOKENS_MAX, MODEL_CALL_TOKENS);
        const inner = new AbortController();
        inFlight.add(owner);
        let handle = null;
        let onAbort = null;
        try {
            const stop = new Promise(resolve => {
                handle = timer.setTimeout(() => resolve(fail(MODEL_CALL_ERRORS.TIMEOUT, fill(MODEL_CALL_TEXT.timeout, { seconds: Math.round(limit / 100) / 10 }))), limit);
                if (signal && typeof signal.addEventListener === 'function') {
                    onAbort = () => resolve(fail(MODEL_CALL_ERRORS.ABORTED, MODEL_CALL_TEXT.aborted));
                    signal.addEventListener('abort', onAbort, { once: true });
                }
            });
            const answer = (async () => {
                try {
                    // The chat's connection waits for a reply in progress (the time limit and signal still hold).
                    if (!profile && internal?.idle !== false && typeof gate?.whenIdle === 'function') {
                        await Promise.race([gate.whenIdle(), new Promise(resolve => inner.signal.addEventListener('abort', resolve, { once: true }))]);
                        if (inner.signal.aborted) return fail(MODEL_CALL_ERRORS.ABORTED, MODEL_CALL_TEXT.aborted);
                    }
                    // One at a time per connection (the queue); a call that runs out of time or is cancelled
                    // while it waits leaves it (inner.signal) and is never made.
                    const text = await queue.run(profile, () => call(req.prompt, { maxTokens, profile, system: typeof req.system === 'string' ? req.system : '', signal: inner.signal }), { signal: inner.signal });
                    const out = typeof text === 'string' ? text : answerText(text);
                    return out.trim() ? { ok: true, text: out, error: null } : fail(MODEL_CALL_ERRORS.EMPTY, MODEL_CALL_TEXT.empty);
                } catch (error) {
                    if (error?.code === 'QUEUE_LEFT') return fail(MODEL_CALL_ERRORS.ABORTED, MODEL_CALL_TEXT.aborted);
                    if (error instanceof CallError) return fail(error.code, error.message);
                    return fail(MODEL_CALL_ERRORS.FAILED, fill(MODEL_CALL_TEXT.failed, { why: safeReason(error) }));
                }
            })();
            const result = await Promise.race([answer, stop]);
            // Timed out or cancelled: the call is told to stop (a profile's request is cut off; the chat's
            // connection cannot be, and its late answer is dropped).
            if (!result.ok && (result.error === MODEL_CALL_ERRORS.TIMEOUT || result.error === MODEL_CALL_ERRORS.ABORTED)) inner.abort();
            return done(result);
        } catch (error) {
            return done(fail(MODEL_CALL_ERRORS.FAILED, fill(MODEL_CALL_TEXT.failed, { why: safeReason(error) })));
        } finally {
            inFlight.delete(owner);
            if (handle !== null) timer.clearTimeout(handle);
            if (onAbort) signal.removeEventListener?.('abort', onAbort);
        }
    }

    return { callModel, busy: module => inFlight.has(String(module ?? '')), queue };
}
