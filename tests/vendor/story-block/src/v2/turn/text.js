// Story Suite v2: the turn's pure text helpers (moved out of turn.js unchanged; turn.js re-exports the public ones). How a prompt's
// message content is read and rewritten (string or multimodal parts), names filled in for {{user}} / {{char}}, macros defused so
// SillyTavern leaves a story-introduced name alone, the battle-log marker lines dropped from history, the context room the
// prompt has, a quiet generation's mark, and putting back static / tail text SillyTavern left out. None of it reads the turn's state.

import { STATIC_MARKER } from '../prompt.js';
import { cutAt } from '../../text.js';

// A quiet generation is told apart by its instruction (GENERATION_STARTED's quiet_prompt): the longest line of it that holds no
// macro, at least this long (a shorter one could be anywhere). At most QUIET_KEEP are remembered, each for QUIET_WAIT_MS after its
// interceptor ran (its prompt is built well within that; one that never came, an aborted generation's, is forgotten).
export const QUIET_MARK_MIN = 12;
export const QUIET_KEEP = 8;
export const QUIET_WAIT_MS = 2 * 60_000;
export const TIMED_OUT = Symbol('timed out');

// `value`, or TIMED_OUT when it is a promise that has not settled within `ms`.
export async function within(value, ms) {
    if (!value || typeof value.then !== 'function') return value;
    let timer;
    try {
        return await Promise.race([value, new Promise(resolve => { timer = setTimeout(resolve, ms, TIMED_OUT); })]);
    } finally {
        clearTimeout(timer);
    }
}
// A name filled in for {{user}} / {{char}} is one line of at most this many characters.
export const MAX_NAME = 80;
// The RPG's battle-log marker: a line `[battle]` of its own in a reply (src/v2/lean-rpg/view/battle-log.js draws the panel there).
// It is for the reader's eyes only, so it leaves the prompt history like the change blocks do: the narrator never sees its own old
// markers. The line goes with one blank line after it, so no gap is left.
const BATTLE_MARKER = /^[ \t]*\[battle\][ \t]*(?:\r?\n|$)(?:[ \t]*\r?\n)?/gim;
const HAS_BATTLE = /\[battle\]/i;
/** `text` without its `[battle]` marker lines. */
export function stripBattleMarker(text) {
    return typeof text === 'string' && HAS_BATTLE.test(text) ? text.replace(BATTLE_MARKER, '') : text;
}

/**
 * The room the prompt has, from the interceptor's `size` and SillyTavern's context `c`: { size (the
 * context size the reader set), reply (the reply's length, or null), room (tokens the prompt may take) }
 * or null. SillyTavern 1.19 hands the interceptor its context size less the reply's length
 * (getMaxContextSize); the API settings tell the context size the reader set and the reply's length, and
 * take the reply off a size that still holds it. Without a size, the settings alone (the settings' prompt
 * size before a reply).
 */
export function contextRoom(c, size = null) {
    const n = value => {
        const x = Number(value);
        return Number.isFinite(x) && x > 0 ? Math.round(x) : null;
    };
    const cc = c?.mainApi === 'openai' ? c?.chatCompletionSettings : null;
    const full = n(cc ? cc.openai_max_context : c?.maxContext);
    const reply = n(cc ? cc.openai_max_tokens : c?.amount_gen ?? c?.amountGen);
    const given = n(size);
    if (given) {
        if (full && reply && given === full - reply) return { size: full, reply, room: given };
        if (full && reply && given === full && reply < full) return { size: full, reply, room: full - reply };
        return { size: given, reply: null, room: given };
    }
    if (full) return { size: full, reply, room: reply && reply < full ? full - reply : full };
    return null;
}

/**
 * SillyTavern runs its macros over extension prompts, which would rewrite a `{{user}}` or
 * `<USER>` inside a name the story introduced. A zero-width space keeps them as written.
 */
export function defuseMacros(text) {
    return String(text ?? '')
        .replace(/\{(?=\{)/g, '{​')
        .replace(/<(USER|BOT|CHAR|CHARIFNOTGROUP|GROUP)>/gi, '<​$1>');
}

// A persona or character name as it goes into a prompt: one line (no line breaks or other control
// characters, so it cannot start a [Happened] or <Changes> line of its own), at most MAX_NAME long.
export function flatName(value) {
    const flat = String(value ?? '').replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').replace(/ {2,}/g, ' ').trim();
    return flat.length > MAX_NAME ? `${cutAt(flat, MAX_NAME - 1).trimEnd()}…` : flat;
}

/**
 * `{{user}}` and `{{char}}` in the static and tail text become the persona's and the character's
 * names (SillyTavern's substituteParams when the context has it, else name1 / name2), flattened to
 * one short line (flatName); any other macro is left for defuseMacros. Both names are fixed for a
 * chat, so the static text stays byte-identical reply after reply.
 */
export function substituteNames(text, ctx) {
    const cache = new Map();
    const name = macro => {
        const key = macro.toLowerCase();
        if (!cache.has(key)) {
            let value = null;
            try { value = typeof ctx?.substituteParams === 'function' ? ctx.substituteParams(`{{${key}}}`) : null; } catch { value = null; }
            if (typeof value !== 'string' || value === `{{${key}}}`) value = key === 'user' ? ctx?.name1 : ctx?.name2;
            const flat = typeof value === 'string' ? flatName(value) : '';
            cache.set(key, flat || null);
        }
        return cache.get(key);
    };
    return String(text ?? '').replace(/\{\{\s*(user|char)\s*\}\}/gi, (whole, macro) => name(macro) ?? whole);
}

// Message content is a string or, for multimodal prompts, a list of parts.
export function mapContent(content, transform) {
    if (typeof content === 'string') return transform(content);
    if (!Array.isArray(content)) return content;
    return content.map(part => {
        if (typeof part === 'string') return transform(part);
        if (part && typeof part === 'object' && typeof part.text === 'string') return { ...part, text: transform(part.text) };
        return part;
    });
}
export function contentText(content) {
    const texts = [];
    mapContent(content, text => { texts.push(text); return text; });
    return texts.join('\n');
}
export const firstLine = text => String(text ?? '').split('\n').find(line => line.trim())?.trim() ?? '';

/**
 * What a quiet generation's instruction is found by in its prompt: its longest line without a macro (SillyTavern runs its macros over
 * it after GENERATION_STARTED tells it, and NovelAI's form drops its brackets), or '' when no line of it is QUIET_MARK_MIN long.
 */
export function quietMark(text) {
    const pieces = String(text ?? '').split(/\{\{[\s\S]*?\}\}|<(?:USER|BOT|CHAR|CHARIFNOTGROUP|GROUP)>|[[\]\r\n]/i).map(piece => piece.trim());
    const best = pieces.reduce((longest, piece) => (piece.length > longest.length ? piece : longest), '');
    return best.length >= QUIET_MARK_MIN ? best : '';
}

// `text` wherever it is in a prompt, however SillyTavern spaced it (it trims an extension prompt, and may collapse new lines).
export function textPattern(text) {
    const words = String(text ?? '').trim().split(/\s+/).filter(Boolean).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return words.length ? new RegExp(`\\s*${words.join('\\s+')}`, 'g') : null;
}

/**
 * Chat completion, the story's own prompt: puts back what SillyTavern left out. When the static
 * text is missing (the preset has no Main Prompt) it goes at the start of this reply's part;
 * when that is missing too, both go in as one system message right before the reply (before a
 * trailing assistant message, a Continue's own text). Returns what it did: '' | 'static' | 'both'.
 */
export function restoreMissing(chat, staticText, tailText) {
    if (!Array.isArray(chat) || !staticText) return '';
    const has = text => {
        const marker = firstLine(text);
        return marker ? chat.findIndex(message => contentText(message?.content).includes(marker)) : -1;
    };
    if (has(STATIC_MARKER) >= 0 || has(staticText) >= 0) return '';
    const at = tailText ? has(tailText) : -1;
    if (at >= 0) {
        const message = chat[at];
        let done = false;
        message.content = mapContent(message.content, part => {
            if (done || !part.includes(firstLine(tailText))) return part;
            done = true;
            const index = part.indexOf(firstLine(tailText));
            return `${part.slice(0, index)}${staticText}\n\n${part.slice(index)}`;
        });
        return 'static';
    }
    const index = chat.length && chat.at(-1)?.role === 'assistant' ? chat.length - 1 : chat.length;
    chat.splice(index, 0, { role: 'system', content: [staticText, tailText].filter(Boolean).join('\n\n') });
    return 'both';
}

// The most a module's hook may keep whole in the tail (`{ text, keep: true }` lines): two meeting cues and a rumor fit; more is droppable.
export const KEPT_LINES_MAX = 4;
export const KEPT_CHARS_MAX = 4000;

// A hook's lines as the tail gets them. A hook may give a line as `{ text, keep: true }`: kept whole whatever the budget says (prompt.js
// `pinned`), like the no-rolls line. A module keeps at most KEPT_LINES_MAX lines and KEPT_CHARS_MAX characters this way (code points); a
// kept line over that is passed as an ordinary line, which the budget may drop, so one module can never spend the whole tail.
export function keptGiven(lines, noRollsLine) {
    let keptLines = 0, keptChars = 0;
    return lines.map(line => {
        if (typeof line === 'string') return line === noRollsLine ? { text: line, keep: true } : line;
        if (!(line && typeof line === 'object' && typeof line.text === 'string' && line.text.trim())) return null;
        if (line.keep !== true) return line.text;
        const size = [...line.text].length;
        if (keptLines >= KEPT_LINES_MAX || keptChars + size > KEPT_CHARS_MAX) return line.text;
        keptLines += 1; keptChars += size;
        return { text: line.text, keep: true };
    }).filter(line => line !== null);
}
