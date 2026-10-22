// The assist part of Story Block (MODULES §A, SPEC §0.5, §4.5): two optional helpers that each make
// one extra, cheap model call, both off by default (Story Block's features `story-block.preroll` and
// `story-block.extractor`, MODULES §F100; the profile is in the settings section "Assist").
//
// * Pre-roll classifier (classifier.js), in `beforeGenerate`: the reader's new message → at most one
//   check line → `assist.precheck` (claim, capture.check, check.roll) committed before the reply, so
//   the reply narrates the roll.
// * After-reply extractor, the safety net (extractor.js, safety.js), in the `afterReply` hook the host
//   calls after each captured reply: the reply and its own lines → only the lines it missed, through the
//   value wall (never coin, new items, XP, loot or heals) → the host's capture, marked as Assist's.
//
// No domain of its own: a pre-roll is a claim in `meta.claims` plus the check's own changes; the run
// log behind `assist.status` lives in memory and is never state. Model calls go through the injected
// `callModel(prompt, { maxTokens, profile, helper }) → text` (st-adapter.js by default; the runtime gives
// sdk.callModel's rules and its queue per connection, model-call.js); tests and the host can replace
// every dependency.

import { DEFAULTS, SCHEMA, SETTING, TIMEOUT_MS, createRunLog } from './common.js';
import { PRECHECK, createClassifier, precheck } from './classifier.js';
import { createExtractor } from './extractor.js';
import { renderAssistSection } from './section.js';
import { stCallModel, stChat, stChatId } from './st-adapter.js';

export { DEFAULTS, FEATURE_TEXT, SCHEMA, SETTING, TIMEOUT_MS, createRunLog, estimateTokens, hashText, withTimeout } from './common.js';
export {
    ANSWER_TOKENS as CLASSIFIER_ANSWER_TOKENS, CHECK_KIND, CLASSIFIER_HEAD, MESSAGE_LIMIT, PRECHECK, PROMPT_BUDGET, ROLLED_LINE, ROLL_COMMAND,
    checkLine, claimKey, classifierPrompt, createClassifier, normalizeDc, parseClassifierAnswer, pendingCheckId, precheck,
} from './classifier.js';
export { EXTRACTOR_FOOT, EXTRACTOR_HEAD, MAX_LINES, REPLY_HEAD, REPLY_LIMIT, WRITTEN_HEAD, allowedGrammar, createExtractor, extractorPrompt, grammarKind, notWritten, parseExtractorAnswer } from './extractor.js';
export { DEFAULT_KINDS, allowedKinds, refusedWhy, safeLines } from './safety.js';
export { renderAssistSection, runLine } from './section.js';
export { answerText, findProfile, stCallModel, stChat, stChatId } from './st-adapter.js';

export const STATUS_QUERY = 'assist.status';
// The module this part is merged into (its settings bucket).
export const HOST_MODULE_ID = 'story-block';

const sdk = () => globalThis.StoryBlock?.sdk ?? null;

/** Whether a registered module keeps change lines of `kind` (through the public sdk). */
export function sdkHasKind(kind) {
    const modules = sdk()?.modules?.();
    return Array.isArray(modules) && modules.some(module => Array.isArray(module?.kinds) && module.kinds.includes(kind));
}

/**
 * The assist part. `deps` (all optional):
 *   callModel(prompt, { maxTokens, profile }) → text   (default: st-adapter's stCallModel)
 *   settings(view?) → this module's settings            (default: view.settings(moduleId), else the sdk's)
 *   chat() → SillyTavern's chat array, chatId() → its id (default: st-adapter)
 *   hasKind(kind) → boolean                             (default: the sdk's module list)
 *   grammar() → the kinds' one-line grammars            (default: none; the host passes the registry's)
 *   capture(text, { index, swipe })                     (default: none; the host passes it per reply)
 *   moduleId = 'story-block', timeoutMs = 20000, timer, warn(text)
 */
export function createAssistPart({
    callModel = stCallModel,
    settings = null,
    chat = stChat,
    chatId = stChatId,
    hasKind = sdkHasKind,
    grammar = () => [],
    capture = null,
    moduleId = HOST_MODULE_ID,
    timeoutMs = TIMEOUT_MS,
    timer,
    warn = text => console.warn(`[Story Suite] assist: ${text}`),
} = {}) {
    const read = view => {
        let values = null;
        try {
            if (typeof settings === 'function') values = settings(view);
            else if (typeof view?.settings === 'function') values = view.settings(moduleId);
            else values = sdk()?.settings?.(moduleId);
        } catch {
            values = null;
        }
        return { ...DEFAULTS, ...(values && typeof values === 'object' ? values : {}) };
    };
    const log = createRunLog();
    const shared = { callModel, log, warn, timeoutMs, timer, chatId };
    const classifier = createClassifier({ ...shared, settings: read, chat, hasKind });
    const extractor = createExtractor({ ...shared, settings: () => read(null), grammar, capture });

    /** assist.status: { classifier: { on, last }, extractor: { on, last }, profile, runs }. */
    function status() {
        const values = read(null);
        return {
            classifier: { on: values[SETTING.classifier] === true, last: log.last('classifier') },
            extractor: { on: values[SETTING.extractor] === true, last: log.last('extractor') },
            profile: String(values[SETTING.profile] ?? '').trim(),
            runs: log.list(),
        };
    }

    return {
        domains: {},
        commands: { [PRECHECK]: precheck },
        queries: { [STATUS_QUERY]: () => status() },
        kinds: {},
        hooks: {
            beforeGenerate: (view, info) => classifier.beforeGenerate(view, info),
            afterReply: reply => extractor.afterReply(reply),
        },
        settings: {
            section: 'Assist',
            defaults: { ...DEFAULTS },
            schema: { ...SCHEMA },
            render: (el, api) => renderAssistSection(el, () => {
                if (typeof api?.query === 'function') {
                    try { return api.query(STATUS_QUERY); } catch { /* the part's own status below */ }
                }
                return status();
            }),
        },
        tabs: [],
    };
}

export const part = createAssistPart();
