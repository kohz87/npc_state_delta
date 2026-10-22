// What both assist helpers share (docs/v2/SPEC.md §0.5, §4.5): their settings, a time limit for a
// model call, a short stable hash for keys, and the small run log `assist.status` reports. Pure: no
// DOM, no SillyTavern, no clock in state (the log counts runs, it does not time them).

import { cutAt } from '../../text.js';

// The settings live in Story Block's own module settings (the parts' defaults share one bucket, so
// each key carries the part's name). Both helpers are off until the reader turns them on.
export const SETTING = Object.freeze({
    classifier: 'assistClassifier',
    extractor: 'assistExtractor',
    profile: 'assistProfile',
});

export const DEFAULTS = Object.freeze({
    [SETTING.classifier]: false,
    [SETTING.extractor]: false,
    [SETTING.profile]: '',
});

// The two switches are features of Story Block (MODULES §F100, Settings → Features): their texts are
// here, the reader's choice is extension_settings.storySuite.features (the runtime gives the helpers
// these two keys from it). A value an older version stored under the keys is that choice until the
// reader changes the feature.
export const FEATURE_TEXT = Object.freeze({
    classifier: Object.freeze({
        label: 'Roll checks before the reply',
        describe: 'One small extra model call per message: when you try something risky, the check is rolled first and the reply tells how it went.',
    }),
    extractor: Object.freeze({
        label: 'Read changes from replies that forgot them',
        describe: 'One small extra model call when a reply comes without its change lines: the items, coins, places and other changes it told are kept anyway.',
    }),
});

// The overlay's field types (registry.js: bool, int, choice, text, list).
export const SCHEMA = Object.freeze({
    [SETTING.profile]: Object.freeze({
        type: 'text',
        label: 'Connection profile for these calls',
        help: 'The name of a Connection Manager profile (a cheaper model, say). Blank: the current connection.',
        max: 80,
    }),
});

// How long a helper waits for the model before it gives up (and the reply goes on without it).
export const TIMEOUT_MS = 20000;

// Generation types the helpers never run for (SPEC §4.1: they get nothing and capture nothing).
export const BACKGROUND = Object.freeze(['quiet', 'impersonate']);

export const normalizeType = type => String(type ?? 'normal').trim().toLowerCase() || 'normal';

/** Tokens as the prompt budget counts them (§5): about four characters each. */
export const estimateTokens = text => Math.ceil(String(text ?? '').length / 4);

/** A short, stable hash of `text` (FNV-1a, 32 bits) in base36: the same text gives the same key. */
export function hashText(text) {
    let hash = 0x811c9dc5;
    const source = String(text ?? '');
    for (let i = 0; i < source.length; i += 1) {
        hash ^= source.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
}

/** `text` cut to at most `limit` characters, on a word when one is near, with an ellipsis. */
export function clip(text, limit) {
    const source = String(text ?? '').trim();
    if (source.length <= limit) return source;
    const cut = cutAt(source, limit - 1);
    const space = cut.lastIndexOf(' ');
    return `${(space > limit * 0.8 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export class AssistTimeout extends Error {
    constructor(ms) {
        super(`The model gave no answer within ${ms >= 1000 ? `${Math.round(ms / 100) / 10} s` : `${ms} ms`}.`);
        this.name = 'AssistTimeout';
        this.code = 'TIMEOUT';
    }
}

const realTimer = Object.freeze({
    set: (fn, ms) => setTimeout(fn, ms),
    clear: handle => clearTimeout(handle),
});

/**
 * `run()`'s answer, or an AssistTimeout after `ms`. A late answer is dropped. `timer` ({ set, clear })
 * stands in for setTimeout in tests.
 */
export function withTimeout(run, ms = TIMEOUT_MS, timer = realTimer) {
    return new Promise((resolve, reject) => {
        let done = false;
        const handle = timer.set(() => {
            if (done) return;
            done = true;
            reject(new AssistTimeout(ms));
        }, ms);
        const finish = (fn, value) => {
            if (done) return;
            done = true;
            timer.clear(handle);
            fn(value);
        };
        Promise.resolve()
            .then(run)
            .then(value => finish(resolve, value), error => finish(reject, error));
    });
}

const LOG_LIMIT = 30;

/**
 * The helpers' run log, newest last: { add(entry) → entry, list(), last(helper) }. Each entry gets a
 * `seq` (1, 2, …) so the status can say which run came last without a clock.
 */
export function createRunLog(limit = LOG_LIMIT) {
    const entries = [];
    let seq = 0;
    return {
        add(entry) {
            seq += 1;
            const item = Object.freeze({ seq, ...entry });
            entries.push(item);
            if (entries.length > limit) entries.splice(0, entries.length - limit);
            return item;
        },
        list: () => entries.map(entry => ({ ...entry })),
        last(helper) {
            const found = entries.findLast(entry => entry.helper === helper);
            return found ? { ...found } : null;
        },
    };
}
