// The pre-roll classifier (SPEC §4.5 "Optional classifier", MODULES §F16): when it is on and the
// reader's new message tries something whose outcome is uncertain, one cheap model call turns the
// message into a check line, and the check is made and rolled BEFORE the reply, so the reply tells
// the result instead of stopping at it.
//
// The model only proposes `? check <skill> — <what> | dc: …` or `none`; code reads the line with
// Story Block's capture parser and commits one `system` command, `assist.precheck`, whose single
// transaction:
//   1. claims `assist:precheck:<key>` (the key is the reader's message: its index and a hash of its
//      text), so the same message is never checked twice on this line of history; swiping or
//      deleting the carrier the claim is on takes it back, like any other change;
//   2. runs `capture.check` with the line, exactly as if the reply had written it (RPG Battle's
//      `check` kind: it makes the pending check, or, before pending checks exist, resolves it);
//   3. rolls it with `check.roll { id }` when step 2 left a pending check (its id in the capture's
//      `data.check`), with the automatic modifiers (MODULES §F16);
//   4. returns the roll's summary as this receipt's summary (narrate: true), so the next reply is
//      told the result under [Happened].
// Anything that fails rejects the whole transaction: no claim, no check, nothing saved.

import { extractBlock, parseChanges } from '../capture.js';
import { BACKGROUND, SETTING, TIMEOUT_MS, clip, estimateTokens, hashText, normalizeType, withTimeout } from './common.js';

export const PRECHECK = 'assist.precheck';
export const CHECK_KIND = 'check';
export const ROLL_COMMAND = 'check.roll';
export const claimKey = key => `assist:precheck:${key}`;

// The classifier's whole prompt stays within this many tokens (chars/4): the static head below plus
// the reader's message, cut to MESSAGE_LIMIT characters.
export const PROMPT_BUDGET = 400;
export const MESSAGE_LIMIT = 800;
export const ANSWER_TOKENS = 60;

// The same text for every message of every chat, first in the prompt, so a provider's prompt cache
// can keep it; only the reader's message (last) changes.
export const CLASSIFIER_HEAD = [
    'You sort one message a reader wrote in an interactive story.',
    'If it attempts an action whose outcome is uncertain (it could fail: sneaking, persuading, lying, climbing, forcing a lock, searching, recalling lore), answer with exactly one line:',
    '? check <skill> — <what is attempted> | dc: easy|normal|hard|<number 5-30>',
    '<skill> is one or two plain words, such as stealth, persuasion, athletics, perception, lore.',
    'For talk, questions, plans, safe or trivial actions, a fight, or an outcome the message already settles, answer: none',
    'Answer with that one line only.',
    '',
    'The message:',
].join('\n');

/** The classifier's prompt for the reader's `message`: the static head, then the message. */
export function classifierPrompt(message) {
    return `${CLASSIFIER_HEAD}\n"""\n${clip(message, MESSAGE_LIMIT)}\n"""`;
}

// The tail line that goes with a pre-roll: the static instruction asks for a check line on every
// uncertain action (F16), so the reply is told this one is done. Worded so it holds even when the
// pre-roll could not be committed.
export const ROLLED_LINE = 'If [Happened] already shows a check for the reader\'s latest attempt, tell that result in the scene and write no new check line for it.';

// `none`, `None.`, `none (just talk)`: the first word decides.
const NONE = /^\W*(?:none|no check)\b/i;
const SKILL = /^\p{L}[\p{L}'’ -]{0,39}$/u;
const WORD_DC = ['easy', 'normal', 'hard'];

/** The difficulty as the check grammar takes it: 'easy' | 'normal' | 'hard' | '<1-40>', or null. */
export function normalizeDc(value) {
    const text = String(value ?? '').trim().toLowerCase().replace(/\.$/, '');
    if (WORD_DC.includes(text)) return text;
    if (/^\d{1,2}$/.test(text)) {
        const number = Number(text);
        return number >= 1 && number <= 40 ? String(number) : null;
    }
    return null;
}

/**
 * A check line in the shape capture hands a module ({ op, kind, name, text, labels, raw }), checked
 * and cut to size, or null. Only the labels the check kind reads are kept (dc, stat, who).
 */
export function checkLine(line) {
    if (!line || typeof line !== 'object' || line.op !== '?' || String(line.kind ?? '').toLowerCase() !== CHECK_KIND) return null;
    const name = String(line.name ?? '').trim().replace(/\s+/g, ' ');
    if (!SKILL.test(name) || name.split(' ').length > 3) return null;
    const dc = normalizeDc(line.labels?.dc);
    if (!dc) return null;
    const text = clip(line.text ?? '', 160);
    const labels = { dc };
    for (const key of ['stat', 'who']) {
        const value = clip(line.labels?.[key] ?? '', 40);
        if (value) labels[key] = value;
    }
    const extra = Object.entries(labels).filter(([key]) => key !== 'dc').map(([key, value]) => ` | ${key}: ${value}`).join('');
    const raw = `? ${CHECK_KIND} ${name}${text ? ` — ${text}` : ''} | dc: ${dc}${extra}`;
    return { op: '?', kind: CHECK_KIND, name, text, labels, raw };
}

/**
 * The classifier's answer read with Story Block's change-line parser:
 * { line } (the first check line), { none: true }, or { error } (a plain sentence) for anything else.
 */
export function parseClassifierAnswer(answer) {
    const text = String(answer ?? '').trim();
    if (!text) return { error: 'the answer was empty' };
    const body = extractBlock(text) ?? text;
    const { lines } = parseChanges(body);
    for (const parsed of lines) {
        if (parsed.op !== '?' || parsed.kind !== CHECK_KIND) continue;
        const line = checkLine(parsed);
        if (line) return { line };
        return { error: `"${parsed.raw}" is not a usable check line (a skill word and dc: easy, normal, hard or a number)` };
    }
    const first = body.split(/\r?\n/).map(part => part.replace(/\*\*|`/g, '').trim()).find(Boolean) ?? '';
    if (NONE.test(first)) return { none: true };
    return { error: `"${clip(first, 80)}" is neither a check line nor none` };
}

/** Whether `state` already holds this message's pre-roll claim. */
export function claimed(state, key) {
    const claims = state?.meta?.claims;
    return Boolean(claims) && Object.hasOwn(claims, claimKey(key)) && claims[claimKey(key)] === true;
}

const KEY = /^\d{1,7}-[0-9a-z]{1,7}$/;

// The pending check a capture made, from its data: `data.check` (or `pending`, `id`) as an id. A
// capture that already resolved the check (its data has an outcome) left nothing to roll.
export function pendingCheckId(data) {
    if (!data || typeof data !== 'object' || data.outcome !== undefined) return null;
    for (const key of ['check', 'pending', 'id']) if (typeof data[key] === 'string' && data[key]) return data[key];
    return null;
}

/**
 * `assist.precheck { key, line }`: the command the classifier's answer is committed through (see
 * the top of this file). Synchronous and pure apart from ctx, like every handler (SPEC §3.2).
 */
export function precheck(ctx, payload = {}) {
    const key = String(payload?.key ?? '');
    if (!KEY.test(key)) ctx.fail('INVALID', 'A pre-rolled check needs the key of the message it was made for.');
    const line = checkLine(payload?.line);
    if (!line) ctx.fail('INVALID', 'A pre-rolled check needs one check line with a skill and a difficulty.');
    if (!ctx.claim(claimKey(key))) ctx.fail('CLAIMED', 'This message has already been turned into a check.');
    const made = ctx.call(`capture.${CHECK_KIND}`, { ...line, index: 0, word: CHECK_KIND }) ?? {};
    const pending = pendingCheckId(made.data);
    let rolled = null;
    if (pending) {
        try {
            rolled = ctx.call(ROLL_COMMAND, { id: pending }) ?? {};
        } catch (error) {
            // Nothing ran: the check stays pending for the reader (and RPG Battle's own roll).
            if (error?.code !== 'UNKNOWN_COMMAND') throw error;
        }
    }
    const out = rolled ?? made;
    const summary = String(out.summary ?? '').trim() || String(made.summary ?? '').trim() || `A ${line.name} check is made.`;
    const outcome = out.data?.outcome;
    return {
        summary,
        narrate: true,
        data: {
            key,
            skill: line.name,
            dc: line.labels.dc,
            check: pending,
            rolled: Boolean(rolled),
            outcome: typeof outcome === 'string' ? outcome : null,
        },
    };
}

/**
 * The classifier. `deps`: { callModel(prompt, { maxTokens, profile }) → text, settings(view) → the
 * module's settings, chat() → SillyTavern's chat array, chatId() → the open chat's id,
 * hasKind(kind) → whether a module keeps that change-line kind, log (createRunLog), warn(text),
 * timeoutMs, timer }. Returns { beforeGenerate(view, info?) }.
 */
export function createClassifier({ callModel, settings, chat, chatId, hasKind, log, warn, timeoutMs = TIMEOUT_MS, timer }) {
    // Messages already asked about in this session (whatever the answer), by chat and key, so a
    // swipe, a regenerate or a failed call never asks again.
    const asked = new Set();

    function note(outcome, entry = {}) {
        const item = log.add({ helper: 'classifier', outcome, ...entry });
        if (['failed', 'timeout', 'unreadable'].includes(outcome)) warn(`the pre-roll check was skipped: ${entry.message}`);
        return item;
    }

    /**
     * beforeGenerate(view, info?): { lines, commands: [{ type: 'assist.precheck', payload }] } when the
     * reader's new message is an uncertain attempt, else null. `info.type` (when the host passes it) is
     * the generation type; only a new message (normal, or a regenerate of its reply) is asked about.
     */
    async function beforeGenerate(view, info = {}) {
        const values = settings(view);
        if (values?.[SETTING.classifier] !== true) return null;
        const type = normalizeType(info?.type);
        if (BACKGROUND.includes(type) || !['normal', 'regenerate'].includes(type)) return null;
        // A swipe or continue has no new message; nor has a reply asked for without one.
        const messages = chat() ?? [];
        const index = messages.length - 1;
        const last = messages[index];
        if (!last?.is_user) return null;
        const text = String(last.mes ?? '').trim();
        if (!text) return null;
        const key = `${index}-${hashText(text)}`;
        const memo = `${chatId() ?? ''}|${key}`;
        if (asked.has(memo)) return null;
        if (claimed(view?.state, key)) {
            asked.add(memo);
            return null;
        }
        if (!hasKind(CHECK_KIND)) {
            note('skipped', { key, message: 'no module keeps checks (RPG Battle is not on)' });
            return null;
        }
        asked.add(memo);
        const prompt = classifierPrompt(text);
        let answer;
        try {
            answer = await withTimeout(() => callModel(prompt, { maxTokens: ANSWER_TOKENS, profile: String(values?.[SETTING.profile] ?? '') }), timeoutMs, timer);
        } catch (error) {
            note(error?.code === 'TIMEOUT' ? 'timeout' : 'failed', { key, message: error?.message ?? String(error) });
            return null;
        }
        const parsed = parseClassifierAnswer(answer);
        if (parsed.none) {
            note('none', { key, tokens: estimateTokens(prompt) });
            return null;
        }
        if (parsed.error) {
            note('unreadable', { key, message: `the model's answer was not used: ${parsed.error}` });
            return null;
        }
        note('check', { key, line: parsed.line.raw, tokens: estimateTokens(prompt) });
        return { lines: [ROLLED_LINE], commands: [{ type: PRECHECK, payload: { key, line: parsed.line } }] };
    }

    return { beforeGenerate };
}
