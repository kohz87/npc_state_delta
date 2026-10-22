// The after-reply extractor (SPEC §0.5, §4.2): when it is on and a reply arrived with no <Changes>
// block (or an empty one), one cheap model call reads the reply with the current kinds' grammar and
// writes the change lines the reply forgot. They go to the normal capture (the host's `capture`
// function, the same path a written block takes), so every line is still checked by its owner and
// a line nobody keeps lands in the Problems list. Never for quiet or impersonate generations, never
// for a continue (its reply was read when it first arrived), once per carrier and swipe.

import { OPS, extractBlock, parseChanges, stripBlock, withoutReasoning } from '../capture.js';
import { BACKGROUND, SETTING, TIMEOUT_MS, clip, estimateTokens, normalizeType, withTimeout } from './common.js';

export const REPLY_LIMIT = 6000;
export const MAX_LINES = 24;
export const ANSWER_TOKENS = 400;

// Static for a chat: the head, then the kinds' grammar (fixed while the same modules are on), then
// the reply last.
export const EXTRACTOR_HEAD = [
    'You read one reply from an interactive story and list what changed in it as change lines, one per line:',
    'op kind Name[ — text][ | label: value]',
    'op: + new or gained, - gone or lost, ~ changed, ! happened, ? asks code to decide (a check the reply stopped at).',
    'Use only these kinds:',
].join('\n');
export const EXTRACTOR_FOOT = [
    'Write a line only for what the reply clearly tells, with numbers only where it gives them. If nothing changed, answer: none',
    'Answer with the lines only, between <Changes> and </Changes>.',
    '',
    'The reply:',
].join('\n');

/** The kind word a grammar line is about (`+ item Name | qty: 1` → 'item'), or null. */
export function grammarKind(line) {
    const match = /^\s*[+\-~!?]\s*(\p{L}[\p{L}\p{N}_-]*)/u.exec(String(line ?? ''));
    return match ? match[1].toLowerCase() : null;
}

/** The extractor's prompt for `reply` (the story text, block removed) and the kinds' grammar lines. */
export function extractorPrompt(reply, grammar) {
    const kinds = grammar.map(line => `- ${String(line).trim()}`).join('\n');
    return `${EXTRACTOR_HEAD}\n${kinds}\n${EXTRACTOR_FOOT}\n"""\n${clip(reply, REPLY_LIMIT)}\n"""`;
}

/**
 * The extractor's answer read with Story Block's change-line parser: { lines: raw[], dropped } where
 * `lines` are the change lines of a kind in `kinds` (at most MAX_LINES) and `dropped` counts the rest
 * (unknown kinds, lines that are not change lines).
 */
export function parseExtractorAnswer(answer, kinds) {
    const known = new Set(kinds);
    const text = String(answer ?? '');
    const { lines, problems } = parseChanges(extractBlock(text) ?? text);
    const kept = [];
    let dropped = problems.length;
    for (const line of lines) {
        if (!OPS.includes(line.op) || !known.has(line.kind) || kept.length >= MAX_LINES) dropped += 1;
        else kept.push(line.raw);
    }
    return { lines: kept, dropped };
}

/**
 * The extractor. `deps`: { callModel(prompt, { maxTokens, profile }) → text, settings() → the module's
 * settings, grammar() → the kinds' one-line grammars (module-id order), capture(text, { index, swipe })
 * → the host's capture of extra change lines for that carrier, chatId(), log, warn, timeoutMs, timer }.
 * Returns { afterReply(reply) }.
 */
export function createExtractor({ callModel, settings, grammar, capture, chatId, log, warn, timeoutMs = TIMEOUT_MS, timer }) {
    // Carriers and swipes already read (whatever came of it), by chat.
    const done = new Set();

    // Each entry names its chat (`chat`), so a reply's note can tell the extractor failed on it.
    function note(outcome, entry = {}) {
        let chat = '';
        try { chat = String(chatId?.() ?? ''); } catch { chat = ''; }
        const item = log.add({ helper: 'extractor', outcome, chat, ...entry });
        if (['failed', 'timeout'].includes(outcome)) warn(`the reply's changes were not read: ${entry.message}`);
        return item;
    }

    /**
     * afterReply({ index, swipe, type, mes, capture? }): `mes` is the reply as stored (its block
     * bare or hidden). Runs when the reply has no block or an empty one; resolves to what `capture`
     * returned, or null when it did not run. `reply.capture` (the host's, per reply) wins over the
     * one given at creation. Never throws.
     */
    async function afterReply(reply = {}) {
        try {
            const values = settings();
            if (values?.[SETTING.extractor] !== true) return null;
            const type = normalizeType(reply.type);
            if (BACKGROUND.includes(type) || type === 'continue') return null;
            const index = Number(reply.index);
            const swipe = Number.isInteger(reply.swipe) ? reply.swipe : 0;
            if (!Number.isInteger(index) || index < 0) return null;
            const mes = String(reply.mes ?? reply.text ?? '');
            const block = extractBlock(mes);
            if (block !== null && block.trim()) return null;
            // The story as capture reads it: closed reasoning (<think>…</think>) is not story.
            const story = stripBlock(withoutReasoning(mes)).trim();
            if (!story) return null;
            const key = `${chatId() ?? ''}|${index}|${swipe}`;
            if (done.has(key)) return null;
            done.add(key);
            const at = { index, swipe };
            const lines = (grammar() ?? []).map(line => String(line ?? '').trim()).filter(line => grammarKind(line));
            if (!lines.length) {
                note('skipped', { ...at, message: 'no change-line kinds are known' });
                return null;
            }
            const feed = typeof reply.capture === 'function' ? reply.capture : capture;
            if (typeof feed !== 'function') {
                note('failed', { ...at, message: 'Story Block offers no capture for extra lines' });
                return null;
            }
            const prompt = extractorPrompt(story, lines);
            let answer;
            try {
                answer = await withTimeout(() => callModel(prompt, { maxTokens: ANSWER_TOKENS, profile: String(values?.[SETTING.profile] ?? '') }), timeoutMs, timer);
            } catch (error) {
                note(error?.code === 'TIMEOUT' ? 'timeout' : 'failed', { ...at, message: error?.message ?? String(error) });
                return null;
            }
            const parsed = parseExtractorAnswer(answer, [...new Set(lines.map(grammarKind))]);
            if (!parsed.lines.length) {
                note('nothing', { ...at, dropped: parsed.dropped, tokens: estimateTokens(prompt) });
                return null;
            }
            const result = await feed(parsed.lines.join('\n'), at);
            note('lines', { ...at, lines: parsed.lines.length, dropped: parsed.dropped, tokens: estimateTokens(prompt) });
            return result ?? null;
        } catch (error) {
            note('failed', { index: reply?.index ?? null, swipe: reply?.swipe ?? null, message: error?.message ?? String(error) });
            return null;
        }
    }

    return { afterReply };
}
