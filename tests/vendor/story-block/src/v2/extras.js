// Choices and Inner chatter (MODULES §F115): two things a reply may carry for the reader alone, as
// change lines in its <Changes> block, that change no story state.
//
// * `? choice Climb the wall`: one of 2–4 short next moves for the reader's character. The latest
//   reply shows them as buttons; a click only puts the text into SillyTavern's message box (the
//   reader still sends it, edits it or ignores it). Code never acts on a choice (MODULES §F95, §F96).
// * `~ chatter Minke: …he'd better not die down there`: an NPC's unspoken thought (at most 3 a
//   reply). Shown in a folded "Inner chatter" strip under the reply, never in the story text, and
//   never sent back to the model unless the reader's setting says so (then only the last reply's,
//   as one optional tail line).
//
// Both are **display kinds** (SPEC §4.4, §6): no command runs for them and nothing is stored. Their
// lines stay in the reply's hidden comment, and what is shown is read from there (the shown swipe's
// text) every time it is drawn, so the live reply, a Re-read, a swipe, a delete and a reload show the
// same thing. Each is a feature (Story Block's `story-block.choices` and `story-block.chatter`, off by
// default): off, its grammar line leaves the static prompt and a line of it gets a quiet Problem.
//
// The cap per reply and the cuts are code's: the first lines in reply order are kept, the rest get a
// Problem; a text is cut by code points (never inside a character), flattened to one line, and drawn
// as text only (ui-host's extras, textContent). Pure: no DOM, no SillyTavern.

import { extractBlock, lineBody, parseChanges } from './capture.js';
import { CORE_FEATURE } from './features.js';

export const CHOICES_FEATURE = CORE_FEATURE.choices;
export const CHATTER_FEATURE = CORE_FEATURE.chatter;

/** At most this many choices a reply, each at most CHOICE_CHARS code points. */
export const CHOICE_MAX = 4;
export const CHOICE_CHARS = 80;
/** At most this many chatter lines a reply; a thought at most CHATTER_CHARS code points, a name NAME_CHARS. */
export const CHATTER_MAX = 3;
export const CHATTER_CHARS = 140;
export const NAME_CHARS = 40;

const ELLIPSIS = '…';
const HAS_WORD = /[\p{L}\p{N}]/u;

/**
 * `text` as one plain line: invisible format and control characters out (zero-width, bidi marks),
 * Unicode NFC, runs of whitespace as one space, trimmed.
 */
export function flatten(text) {
    return String(text ?? '').replace(/[\p{Cf}\p{Cc}]+/gu, ' ').normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** `text` cut to at most `max` code points (an ellipsis in the last place when it was longer). */
export function cutPoints(text, max) {
    const points = Array.from(String(text ?? ''));
    if (points.length <= max) return points.join('');
    return `${points.slice(0, Math.max(0, max - 1)).join('').trimEnd()}${ELLIPSIS}`;
}

// A thought wrapped in one pair of `*` or `_` (italics, as models write thoughts) loses the pair.
const unwrap = text => {
    const found = /^([*_])([^*_][\s\S]*?)\1$/u.exec(text);
    return found ? found[2].trim() : text;
};

/** A `? choice` line → { value: { text } } | { error }. */
export function readChoice(line) {
    const text = flatten(lineBody(line?.raw ?? ''));
    if (!HAS_WORD.test(text)) return { error: 'the choice has no text (write "? choice What to do next")' };
    return { value: { text: cutPoints(text, CHOICE_CHARS) } };
}

// The speaker's name ends at the first colon, or at a dash with a space before it, within the first
// NAME_CHARS + 20 characters (a long title, "Captain of the Watch").
const SPEAKER = /^(.{1,60}?)\s*(?::|：|\s[—–-])\s*(.*)$/su;

/** A `~ chatter` line → { value: { name, text } } | { error }. */
export function readChatter(line) {
    const body = flatten(lineBody(line?.raw ?? ''));
    const found = SPEAKER.exec(body);
    if (!found) return { error: 'it names no one (write "~ chatter Name: the thought")' };
    const name = flatten(found[1].replace(/^[*_"“”'‘’]+|[*_"“”'‘’]+$/g, ''));
    const text = unwrap(flatten(found[2]));
    if (!HAS_WORD.test(name)) return { error: 'it names no one (write "~ chatter Name: the thought")' };
    if (!HAS_WORD.test(text)) return { error: `there is no thought after ${cutPoints(name, NAME_CHARS)}` };
    return { value: { name: cutPoints(name, NAME_CHARS), text: cutPoints(text, CHATTER_CHARS) } };
}

// Their kinds as Story Block declares them (src/v2/domains/index.js CORE_KINDS): one grammar line each,
// shown only while the feature is on. No names, counts or dice: the static part stays byte-identical.
export const EXTRA_KINDS = Object.freeze({
    choice: Object.freeze({
        grammar: `? choice Climb the wall (2 to ${CHOICE_MAX} lines at the end: short next moves the reader's character could make, at most ${CHOICE_CHARS} characters each; the reader picks, code never acts on them)`,
        feature: CHOICES_FEATURE,
        display: Object.freeze({ perReply: CHOICE_MAX, noun: 'choices', read: readChoice }),
    }),
    chatter: Object.freeze({
        grammar: `~ chatter Name: …a short unspoken thought (at most ${CHATTER_MAX}, only NPCs in the scene, at most ${CHATTER_CHARS} characters; nobody hears it, so the story never reacts to it)`,
        feature: CHATTER_FEATURE,
        display: Object.freeze({ perReply: CHATTER_MAX, noun: 'chatter lines', read: readChatter }),
    }),
});

/**
 * One display line's verdict (turn.js at capture, displayLines when drawing: the same rule both
 * ways). `entry`: the registry's capture entry ({ kind, display: { perReply?, noun?, read? } });
 * `counts`: a Map kind → lines kept so far in this reply. → { ok: true, value } | { ok: false, code, message }.
 */
export function readDisplayLine(entry, line, counts) {
    const display = entry?.display;
    let answer;
    try {
        answer = typeof display?.read === 'function' ? display.read(line) : { value: { text: flatten(lineBody(line?.raw ?? '')) } };
    } catch (error) {
        answer = { error: error?.message ?? String(error) };
    }
    if (!answer || typeof answer.error === 'string' || answer.value === undefined) {
        return { ok: false, code: 'INVALID', message: typeof answer?.error === 'string' ? answer.error : 'it could not be read' };
    }
    const seen = counts.get(entry.kind) ?? 0;
    const max = Number.isInteger(display?.perReply) && display.perReply > 0 ? display.perReply : Infinity;
    if (seen >= max) {
        const noun = typeof display?.noun === 'string' && display.noun ? display.noun : `${entry.kind} lines`;
        return { ok: false, code: 'LIMITED', message: `a reply shows at most ${max} ${noun}, and this one had more` };
    }
    counts.set(entry.kind, seen + 1);
    return { ok: true, value: answer.value };
}

/**
 * What a reply's display lines show, read from its text as SillyTavern holds it (the hidden comment
 * the reply's block was kept in): { [kind]: value[] } in reply order, only for kinds that are display
 * kinds and on now. `entryOf(word)` → the registry's capture entry (registry.capture); `max`: the
 * host's maxChangeLines (the same lines the capture read).
 */
export function displayLines(mes, { entryOf, max = Infinity } = {}) {
    const out = {};
    // (A line its hidden comment marks as read while its feature was off is left out, B-a1-5.)
    const block = extractBlock(String(mes ?? ''), 'Changes', null, { display: true });
    if (block === null || typeof entryOf !== 'function') return out;
    const lines = parseChanges(block, { max }).lines.slice(0, Number.isFinite(max) ? max : undefined);
    const counts = new Map();
    for (const line of lines) {
        let entry = null;
        try { entry = entryOf(line.kind); } catch { entry = null; }
        if (!entry?.display || entry.off) continue;
        const read = readDisplayLine(entry, line, counts);
        if (read.ok) (out[entry.kind] ??= []).push(read.value);
    }
    return out;
}

/**
 * The reply whose chatter goes back to the story when the reader asks for it (chatterTail): the last
 * reply before the reader's latest message, the one that message answered. A swipe, a regenerate and a
 * Continue of the newest reply therefore use the reply before it, never the one being written again.
 * → its index in `chat`, or -1.
 */
export function answeredReply(chat) {
    const list = Array.isArray(chat) ? chat : [];
    const user = list.findLastIndex(message => message?.is_user);
    if (user < 0) return -1;
    for (let i = user - 1; i >= 0; i -= 1) {
        const message = list[i];
        if (message && !message.is_user && !message.is_system) return i;
    }
    return -1;
}

/** The one optional tail line for the reader's "send it back" setting, or '' when there is nothing. */
export function chatterTail(chatter) {
    const list = (Array.isArray(chatter) ? chatter : []).filter(item => item?.name && item?.text);
    if (!list.length) return '';
    return `[Inner chatter last reply, unspoken: only the thinker knows] ${list.map(item => `${item.name}: ${item.text}`).join(' / ')}`;
}
