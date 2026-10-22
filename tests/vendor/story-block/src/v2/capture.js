// Change lines (docs/v2/SPEC.md §4.4): the hidden <Changes> block a reply ends with, one proposal
// per line, `op kind Name[ — text][ | label: value]*`. Parsing is lenient because models drift
// (bullets, bold, code fences, either dash, a colon after the kind); a line that is not a change
// becomes a problem, never an exception. Each line is handed to the module that owns its kind
// (turn.js), which decides what it means. Pure: no DOM, no SillyTavern.

import { cutAt } from '../text.js';

// + new or gained, - gone or lost, ~ changed, ! happened, ? asks code to decide.
export const OPS = Object.freeze(['+', '-', '~', '!', '?']);

// The HTML comment a captured block is kept in, so SillyTavern shows nothing of it and the
// prompt history can drop it (turn.js). `\b` keeps a longer marker from matching.
export const HIDDEN_MARKER = 'STORY_SUITE_V2';

const escapeRe = text => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// An open or a close tag. Attributes stay on the tag's own line and are short, so a tag cut off
// mid-way never reaches far ahead (and no tag costs more than its own few characters to read).
const tagRe = tag => new RegExp(`<(/?)${escapeRe(tag)}(?:[ \\t][^>\\n]{0,200})?[ \\t]*>`, 'gi');
// The hidden comment's open and its end, found apart (closedPairs): a lazy `<!--…[\s\S]*?-->` tried
// again from every unclosed open costs the square of the text (B-b5b-robust-r2-4).
const HIDDEN_OPEN = new RegExp(`<!--\\s*${HIDDEN_MARKER}\\b`, 'g');
const HIDDEN_CLOSE = /-->/g;

/**
 * Every closed pair in `text` in one pass: an open (`openRe`, global), then the first close after it
 * (`closeRe`, global), then on from there. An open with no close after it ends the search, since no
 * later open has one either. → [{ start, end, bodyStart, bodyEnd }].
 */
function closedPairs(text, openRe, closeRe) {
    const out = [];
    let at = 0;
    while (at < text.length) {
        openRe.lastIndex = at;
        const open = openRe.exec(text);
        if (!open) break;
        closeRe.lastIndex = openRe.lastIndex;
        const close = closeRe.exec(text);
        if (!close) break;
        out.push({ start: open.index, end: closeRe.lastIndex, bodyStart: openRe.lastIndex, bodyEnd: close.index });
        at = closeRe.lastIndex;
    }
    return out;
}

// `text` with each pair put back as `fn(pair)` gives.
function replacePairs(text, pairs, fn) {
    let out = '';
    let at = 0;
    for (const pair of pairs) {
        out += text.slice(at, pair.start) + fn(pair);
        at = pair.end;
    }
    return out + text.slice(at);
}

const hiddenPairs = text => closedPairs(text, HIDDEN_OPEN, HIDDEN_CLOSE);
const blank = pair => ' '.repeat(pair.end - pair.start);

// Every function here is linear in the length of the reply: a looping model can write a run of
// thousands of spaces or blank lines, and the text is read again for every later prompt (turn.js).
// So there are no regexes that can retry from each place in a run (`\s+$`, `\n\s*$`, `\s*x|\s+y`);
// those spots are plain loops.

// A change line longer than this is not read (a Problem says so): no real change needs it.
export const MAX_LINE = 2000;

const SPACE = /\s/;
const isSpace = char => char !== undefined && SPACE.test(char);
// `text` without the whitespace at its end (String#trimEnd is linear; `/\s+$/` is not in V8).
const trimEnd = text => text.trimEnd();
// `text` without a last line that holds only whitespace: what `/\n\s*$/` removed, in one pass.
function dropBlankTail(text) {
    const nl = text.indexOf('\n', text.trimEnd().length);
    return nl < 0 ? text : text.slice(0, nl);
}
// `text` without a first line that holds only whitespace (`/^\s*\n/`).
function dropBlankHead(text) {
    const start = text.length - text.trimStart().length;
    const nl = text.lastIndexOf('\n', start - 1);
    return nl < 0 ? text : text.slice(nl + 1);
}
const blockBody = body => dropBlankTail(dropBlankHead(body));

// The separator between the name and the text: an em or en dash (with or without spaces) or a
// spaced hyphen, so `Jean-Luc` stays one name. → its index, or -1.
function textDash(first) {
    for (let i = 0; i < first.length; i += 1) {
        const char = first[i];
        if (char === '—' || char === '–') return i;
        if (char === '-' && i > 0 && isSpace(first[i - 1]) && (i + 1 === first.length || isSpace(first[i + 1]))) return i;
    }
    return -1;
}

// `label: value`: the label is words starting with a letter (so `09:00` is not one), lowercased by
// the parser. Without a space after the colon (`qty:3`, a common drift) the label must be one word
// of letters, so `at 09:00` stays text, and a colon followed by `//` is a link, not a label.
const LABEL_WORDS = /^\p{L}[\p{L}\p{N}'’ _-]*$/u;
const LABEL_WORD = /^\p{L}[\p{L}_-]*$/u;
function labelled(part) {
    const colon = part.indexOf(':');
    if (colon < 1) return null;
    const label = trimEnd(part.slice(0, colon));
    const rest = part.slice(colon + 1);
    if (!label || label.length > 60) return null;
    const spaced = rest === '' || isSpace(rest[0]);
    if (spaced ? !LABEL_WORDS.test(label) : !LABEL_WORD.test(label) || rest.startsWith('//')) return null;
    return [label, rest.trim()];
}
// What a model writes when it had nothing to change; dropped quietly.
const NOTHING = /^\(?\s*(?:none|no changes?|nothing(?: changed)?|n\/a)\s*\)?\.?$/i;

function stripMarkdown(text) {
    return String(text ?? '').replace(/\*\*|__|`/g, '');
}

// Only spaces or tabs between `from` and the line's start (going back) or end (going on).
function blankBefore(text, at) {
    for (let i = at - 1; i >= 0; i -= 1) {
        const char = text[i];
        if (char === '\n') return true;
        if (char !== ' ' && char !== '\t' && char !== '\r') return false;
    }
    return true;
}
function blankAfter(text, at) {
    for (let i = at; i < text.length; i += 1) {
        const char = text[i];
        if (char === '\n') return true;
        if (char !== ' ' && char !== '\t' && char !== '\r') return false;
    }
    return true;
}

// Every <tag>…</tag> in `mes`, in order: { start, end, body }. A block left open (the reply was
// cut off) runs to the end of the text. Opens and closes are counted, so a block opened twice
// ends at its matching close, not the first one. A close tag ends a block only at the start or
// the end of a line: one in the middle of a line (`note: the </Changes> tag`) is part of that
// line, so the lines after it are still read (and anything that is not a change line among them
// becomes a Problem), never dropped without a word.
// `openAt` (a Continue of a reply cut off inside its block, see continuation()): the search starts
// there, inside a block already open (its `start` and body start there).
function findBlocks(mes, tag, openAt = -1) {
    const text = String(mes ?? '');
    const blocks = [];
    const re = tagRe(tag);
    let depth = 0;
    let start = 0;
    let bodyStart = 0;
    if (openAt >= 0) {
        re.lastIndex = openAt;
        depth = 1;
        start = openAt;
        bodyStart = openAt;
    }
    let match;
    while ((match = re.exec(text))) {
        if (!match[1]) {
            // C2-6: an open tag in the middle of story text ("a <Changes> word in it") is a mention, not
            // a block: it opens one only at the start or end of a line, or with a change line after it.
            if (!blankBefore(text, match.index) && !blankAfter(text, re.lastIndex) && !changeAfter(text, re.lastIndex)) continue;
            if (!depth) {
                start = match.index;
                bodyStart = re.lastIndex;
            }
            depth += 1;
            continue;
        }
        if (!depth) continue;   // a stray close outside a block
        if (!blankBefore(text, match.index) && !blankAfter(text, re.lastIndex)) continue;
        depth -= 1;
        if (!depth) blocks.push({ start, end: re.lastIndex, body: text.slice(bodyStart, match.index) });
    }
    if (depth) blocks.push({ start, end: text.length, body: text.slice(bodyStart), open: true });
    return blocks;
}

// The rest of the line from `at` (at most MAX_LINE characters looked at) is a change line.
function changeAfter(text, at) {
    const nl = text.indexOf('\n', at);
    const end = Math.min(nl < 0 ? text.length : nl, at + MAX_LINE);
    const rest = text.slice(at, end).trim();
    return !!rest && /^[+\-~!?]/.test(rest) && !parseLine(rest).error;
}

// A block left open ends where the reply stopped. Its last line is whole when a line break follows
// it; with none (SillyTavern trims every reply, so a block the model forgot to close ends that way) it
// is still read, unless the reader stopped the reply (`stopped`: it was cut off mid-way, "+ coin 2" of
// "+ coin 25", B2-11), the line is not a change line, or a tag sits in it (a close in mid-line, story
// text after it) (r2-2); then it is left out.
// → { body, cut } (`cut`: the line left out, or '').
function wholeLines(block, stopped = false) {
    if (!block.open || block.body.endsWith('\n')) return { body: block.body, cut: '' };
    const nl = block.body.lastIndexOf('\n');
    const last = block.body.slice(nl + 1).trim();
    if (!stopped && (!last || (!last.includes('</') && !parseLine(last).error))) return { body: block.body, cut: '' };
    return { body: nl < 0 ? '' : block.body.slice(0, nl + 1), cut: last };
}

/**
 * The change line a reply stopped in the middle of (its block left open, the last line with no line
 * break after it, and the reply `stopped` by the reader or the line no change line), or null.
 * extractBlock and hideBlock leave that line out; turn.js tells it as a Problem.
 * `at` (continuation()): only a Continue's own blocks are looked at.
 */
export function cutLine(mes, tag = 'Changes', at = null, { stopped = false } = {}) {
    const last = (at ? laterBlocks(mes, tag, at) : findBlocks(withoutReasoning(mes), tag)).at(-1);
    const cut = last ? wholeLines(last, stopped).cut : '';
    return cut || null;
}

// Reasoning a model writes in the reply itself (<think>, <thinking>, <reasoning>): a draft of the
// change block inside it is not the change block, so a reply that drafts it there and writes it
// again at the end is read once. A pair that does not match (`<thinking>…</think>`, as some models
// write) is reasoning too. C2-3: an open tag with no close after it (a reply cut off mid-thought)
// is reasoning to the end of the reply, so nothing drafted inside it applies; a block written
// before it is kept. The end is Story Suite's own hidden comment when one comes after it (hideBlock
// writes it at the end, after the reasoning; a model's copy of the marker is defanged when the reply
// is read, defangMarker), so Re-read reads what was kept.
// Opens and closes found apart, in one pass (closedPairs), so many unclosed tags cost no more than
// the text's length (B-b5b-robust-r2-4).
const REASONING_OPEN = /<(?:think|thinking|reasoning)(?:[ \t][^>\n]{0,200})?>/gi;
const REASONING_CLOSE = /<\/(?:think|thinking|reasoning)\s*>/gi;
function reasoningPairs(text) {
    const pairs = closedPairs(text, REASONING_OPEN, REASONING_CLOSE);
    REASONING_OPEN.lastIndex = pairs.length ? pairs.at(-1).end : 0;
    const open = REASONING_OPEN.exec(text);
    if (!open) return pairs;
    const hidden = hiddenPairs(text).find(pair => pair.start >= REASONING_OPEN.lastIndex);
    const end = hidden ? hidden.start : text.length;
    return [...pairs, { start: open.index, end, bodyStart: REASONING_OPEN.lastIndex, bodyEnd: end, open: true }];
}

/** `mes` without its reasoning (closed blocks, and an unclosed one to the end). */
export function withoutReasoning(mes) {
    const text = String(mes ?? '');
    return replacePairs(text, reasoningPairs(text), () => '');
}

// `text` with its reasoning blanked to spaces of the same length, so the positions of what is
// outside it stay where they are.
const maskReasoning = text => replacePairs(text, reasoningPairs(text), blank);

/**
 * C2-7: `mes` with every copy of Story Suite's hidden marker from `from` on defanged (an `_` after it),
 * so text a model wrote that looks like the hidden comment is read as the plain comment it is, live
 * and on Re-read alike. Only the comment hideBlock writes carries the marker.
 */
export function defangMarker(mes, from = 0) {
    const text = String(mes ?? '');
    const at = Math.max(0, Math.min(text.length, from | 0));
    return text.slice(0, at) + text.slice(at).replace(HIDDEN_OPEN, found => `${found}_`);
}
// The bare blocks of `mes` (not hidden in Story Suite's comment, not inside closed reasoning), at
// their places in `mes`.
const bareBlocks = (mes, tag, openAt = -1) => {
    const text = String(mes ?? '');
    return findBlocks(maskReasoning(replacePairs(text, hiddenPairs(text), blank)), tag, openAt);
};
// The bare blocks a Continue added: from the `skip`th bare block on, ending after `from` (C2-2: a
// block whose open tag was cut, "<Chan" + "ges>…", starts before the Continue's text). With `tail`
// the Continue's text starts inside the block the reply was cut off in (continuation()).
const laterBlocks = (mes, tag, { from = 0, skip = 0, tail = false } = {}) => (tail
    ? bareBlocks(mes, tag, from)
    : bareBlocks(mes, tag).filter((block, i) => i >= skip && block.end > from));

// The word after the hidden comment's marker when the reply was cut off inside its (last) block.
const CUT_MARK = 'open';
// `text` ends with a hidden comment written for a block left open (hideBlock).
function endsInOpenBlock(text) {
    const last = hiddenPairs(text).at(-1);
    if (!last || text.slice(last.end).trim()) return false;
    return new RegExp(`^[ \\t]+${CUT_MARK}\\b`).test(text.slice(last.bodyStart, last.bodyEnd));
}

/**
 * Where a Continue's own text starts in `mes` (the reply after the Continue), given `base` (the reply
 * as it was before it) → { from, skip, tail? } for extractBlock, cutLine and hideBlock.
 * SillyTavern writes a continued reply again from its copy of the old text plus what was added, and
 * cleans the whole of it up (spaces at line ends and at the start dropped, blank lines collapsed when
 * that is set, the reader's regex scripts), so the old text can come back shorter than it was. A
 * place counted in the old text would then land inside the added text and its block be missed, left
 * bare for the reader to see. So `from` is found by following `base` through `mes` while passing over
 * whitespace on either side; where something else differs it stops there, early. `skip` is how many
 * whole bare blocks `base` already had (edited in by hand, never read): those are never read here,
 * even when `from` stopped early. Only bare blocks count: a hidden one was read before.
 */
//
// C2-2: when the reply was cut off inside its block (its hidden comment says so, see hideBlock) and the
// Continue's text goes on with it (a close tag comes before any open one, or its first line is a change
// line), `tail` is set: that text is the rest of the block. Story text that goes on is left as it is.
export function continuation(base, mes, tag = 'Changes') {
    const before = String(base ?? '');
    const after = String(mes ?? '');
    const skip = bareBlocks(before, tag).filter(block => !block.open).length;
    const at = from => (endsInOpenBlock(before) && goesOn(after, tag, from) ? { from, skip, tail: true } : { from, skip });
    if (after.startsWith(before)) return at(before.length);
    let i = 0;
    let j = 0;
    while (i < before.length) {
        if (isSpace(before[i])) { i += 1; continue; }
        while (j < after.length && isSpace(after[j])) j += 1;
        if (after[j] !== before[i]) break;
        i += 1;
        j += 1;
    }
    return i < before.length ? { from: j, skip } : at(j);
}

// Does the text from `from` go on with a block left open: a close tag first, or a change line first?
function goesOn(mes, tag, from) {
    const first = bareBlocks(mes, tag, from)[0];
    if (!first) return false;
    if (!first.open) return true;
    const line = first.body.trimStart().split('\n')[0].trim();
    return !!line && !parseLine(line).error;
}

/**
 * The text inside the reply's <Changes> block (or `tag`), or null when there is none. Found
 * whether the block is bare or already hidden in Story Suite's comment; several blocks are
 * read as one, in order, so no line is lost. Blocks inside closed reasoning are not read.
 * `at` ({ from, skip }, from continuation()): only the bare blocks a Continue added are read.
 * `stopped`: the reader stopped the reply, so an open block's unfinished last line is left out.
 * `heads` (grammarHeads): change lines written in the story near the block (strayLines) are read
 * too, after the blocks, and count as a block when there is none.
 */
export function extractBlock(mes, tag = 'Changes', at = null, { stopped = false, heads = null } = {}) {
    const blocks = at ? laterBlocks(mes, tag, at) : findBlocks(withoutReasoning(mes), tag);
    const strays = heads ? strayLines(mes, heads, { tag, from: at?.from ?? 0, tail: at?.tail === true, stopped }).taken : [];
    if (!blocks.length && !strays.length) return null;
    return inOrder(blocks.map(block => blockBody(wholeLines(block, stopped).body)), strays, blocks.at(-1)?.open === true).join('\n');
}

/**
 * `mes` without its <Changes> blocks (bare or hidden), for display and for the prompt history.
 * Whitespace left at the end is trimmed.
 */
export function stripBlock(mes, tag = 'Changes', { heads = null } = {}) {
    const given = String(mes ?? '');
    // `heads` (grammarHeads): the change lines written in the story near the block go too.
    const raw = heads ? dropLines(given, strayLines(given, heads, { tag }).taken) : given;
    let text = replacePairs(raw, hiddenPairs(raw), pair => (findBlocks(raw.slice(pair.bodyStart, pair.bodyEnd), tag).length ? '' : raw.slice(pair.start, pair.end)));
    const blocks = findBlocks(text, tag);
    for (const block of blocks.reverse()) text = text.slice(0, block.start) + text.slice(block.end);
    return trimEnd(text);
}

// Every `--` in a comment's body broken up, so neither `-->` nor `--!>` can end it early.
const commentSafe = text => text.replace(/-(?=-)/g, '- ');

/**
 * `mes` with its bare <Changes> blocks moved into one hidden comment at the end, so
 * SillyTavern shows nothing of them and Re-read can still find them. Already hidden: unchanged.
 * `from`, `skip`, `tail` (continuation()): only blocks that end after `from`, from the `skip`th bare
 * block on (a Continue's own text), are moved; the ones before are left as they are. A block left
 * open is kept with the word `open` after the marker, so a Continue can tell it goes on with it.
 */
export function hideBlock(mes, tag = 'Changes', { from = 0, skip = 0, tail = false, stopped = false, heads = null } = {}) {
    const given = String(mes ?? '');
    // `heads` (grammarHeads): the change lines written in the story near the block (strayLines) are
    // taken out of the story and kept after the blocks, in a block of their own.
    const strays = heads ? strayLines(given, heads, { tag, from, tail, stopped }).taken : [];
    // Taking whole lines out after `from` leaves `from`, `skip` and `tail` true of the text.
    const text = dropLines(given, strays);
    const bare = laterBlocks(text, tag, { from, skip, tail });
    if (!bare.length && !strays.length) return text;
    // C2-6: the bodies were found in the text with reasoning blanked (what extractBlock reads), so
    // reasoning inside a block is left in the story where it stood, never written back as spaces.
    const thoughts = reasoningPairs(replacePairs(text, hiddenPairs(text), blank));
    let story = text;
    for (const block of [...bare].reverse()) {
        const inside = thoughts.filter(pair => pair.start >= block.start && pair.end <= block.end).map(pair => text.slice(pair.start, pair.end));
        story = story.slice(0, block.start) + inside.join('\n') + story.slice(block.end);
    }
    // (Spaces left at line ends, where reasoning was blanked, go.)
    const lineEnds = body => body.split('\n').map(line => line.trimEnd()).join('\n');
    const open = bare.at(-1)?.open === true;
    const kept = inOrder(bare.map(block => blockBody(wholeLines(block, stopped).body)), strays, open)
        .map(body => `<${tag}>\n${commentSafe(lineEnds(body))}\n</${tag}>`).join('\n');
    // A block left open (the reply was cut off in it) is said so, for a Continue (continuation()).
    const mark = open ? ` ${CUT_MARK}` : '';
    return `${trimEnd(story)}\n\n<!-- ${HIDDEN_MARKER}${mark}\n${kept}\n-->`;
}

// A bullet, number or quote mark in front of a line is decoration. A hyphen counts as one only
// when an op follows it: `- item Rope` is itself an op.
function stripDecoration(line) {
    return line
        .replace(/^>\s*/, '')
        .replace(/^(?:[*•·]\s+|\d+[.)]\s+)/, '')
        .replace(/^-\s+(?=[+\-~!?]\s)/, '');
}

/**
 * A change line's text after its op and kind, as written (bold, backticks and a bullet in front are
 * decoration; a colon after the kind is drift): the whole of what a display kind shows (extras.js).
 */
export function lineBody(raw) {
    const line = stripDecoration(stripMarkdown(raw).trim()).trim();
    return line.replace(/^[+\-~!?]\s*\p{L}[\p{L}\p{N}_-]*\s*:?\s*/u, '');
}

function addLabel(labels, label, value) {
    const had = Object.hasOwn(labels, label) ? labels[label] : '';
    const next = had && value ? `${had}; ${value}` : (had || value);
    // "__proto__" would set the prototype even of a prototype-less object: define it as a key.
    Object.defineProperty(labels, label, { value: next, enumerable: true, writable: true, configurable: true });
}

// One line → { op, kind, name, text, labels } or { error }.
function parseLine(source) {
    const line = stripDecoration(stripMarkdown(source).trim()).trim();
    const opMatch = /^([+\-~!?])\s*(.*)$/s.exec(line);
    if (!opMatch) return { error: 'it does not start with + - ~ ! or ?' };
    const op = opMatch[1];
    const kindMatch = /^(\p{L}[\p{L}\p{N}_-]*)\s*:?(?:\s+|$)(.*)$/su.exec(opMatch[2].trim());
    if (!kindMatch) return { error: 'there is no kind after the op' };
    const kind = kindMatch[1].toLowerCase();
    const [first, ...rest] = kindMatch[2].split('|');
    const dash = textDash(first);
    const name = (dash < 0 ? first : first.slice(0, dash)).trim();
    const texts = [dash < 0 ? '' : first.slice(dash + 1).trim()];
    if (!name) return { error: `the ${kind} has no name` };
    // No prototype: a label named "constructor" or "toString" is the line's own, never inherited.
    const labels = Object.create(null);
    for (const part of rest) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const found = labelled(trimmed);
        // A part with no label is more text, so nothing written is lost.
        if (found) addLabel(labels, found[0].trim().toLowerCase(), found[1]);
        else texts.push(trimmed);
    }
    return { op, kind, name, text: texts.filter(Boolean).join('; '), labels };
}

/**
 * Parses change lines, one per line. Blank lines, code fences, the block's own tags and "none"
 * are skipped; any other line that is not a change goes to `problems` as a plain sentence.
 * Returns { lines: [{ op, kind, name, text, labels, raw, index }], problems: string[], over? }; `index`
 * is the line's place among the lines read (0-based), `raw` the line as written. With `max`, at most
 * that many written lines (change lines or not) are read; `over` = { count, total, first } tells the rest.
 */
export function parseChanges(text, { max = Infinity } = {}) {
    const lines = [];
    const problems = [];
    const sources = String(text ?? '').split(/\r?\n/);
    let read = 0;
    let over = null;
    for (let number = 0; number < sources.length; number += 1) {
        const raw = sources[number].trim();
        if (!raw || raw.startsWith('```') || raw.startsWith('~~~') || /^<\/?[A-Za-z_]+\s*>$/.test(raw) || NOTHING.test(raw)) continue;
        // Every line written counts against `max`, read or not (B-b5b-robust-r2-5): past it the rest are
        // counted, not read, and told once (`over`).
        read += 1;
        if (read > max) {
            over ??= { first: raw, count: 0 };
            over.count += 1;
            continue;
        }
        if (raw.length > MAX_LINE) {
            problems.push(`Line ${number + 1} "${cutAt(raw, 60)}…" is longer than ${MAX_LINE} characters, so it was not read.`);
            continue;
        }
        const parsed = parseLine(raw);
        if (parsed.error) problems.push(`Line ${number + 1} "${raw}" is not a change line: ${parsed.error}.`);
        else lines.push({ ...parsed, raw, index: lines.length });
    }
    return over ? { lines, problems, over: { ...over, total: read } } : { lines, problems };
}

// --- Change lines written in the story (fix-encounter) ---------------------------------------------
// Models put a change line in the story now and then, on its own line just before the block (or with
// no block at all): "! encounter 8 Weir Rat — cellar pack | tier: weak". Such a line is read as one of
// the reply's changes and hidden like the block, but narrowly: only a whole line that starts exactly
// as a kind's grammar line does (its `heads`, grammarHeads: the op, one space, the kind in lower case),
// parses, and sits near the end of the reply: in its last STRAY_PARAGRAPHS story paragraphs before the
// first block, or after it. A paragraph made only of change lines is not counted, so taking its lines
// out never brings an earlier line into reach (Re-read reads what the live capture left). A line with
// `-` (a Markdown bullet too) is taken only from a paragraph of change lines. A line close to one but
// not taken (another op, a capital, a colon, too far up) is told as a Problem, never dropped quietly.
// The lines taken are read after the blocks, and hideBlock keeps them after the blocks in the hidden
// comment, so the live capture and every Re-read read them in the same order.

/** How many story paragraphs before the block a change line written in the story is looked for in. */
export const STRAY_PARAGRAPHS = 3;

const KIND_WORD = /^\p{L}[\p{L}\p{N}_-]*$/u;

/**
 * The heads each kind's grammar line writes, from [{ kind, grammar }] (registry.contexts()' kinds):
 * a Set of "op kind" ("! encounter", "+ present", "- present").
 */
export function grammarHeads(kinds) {
    const heads = new Set();
    for (const entry of Array.isArray(kinds) ? kinds : []) {
        const word = String(entry?.kind ?? '').toLowerCase();
        if (!KIND_WORD.test(word)) continue;
        const re = new RegExp(`(?:^|[\\s(;,])([+\\-~!?]) ${escapeRe(word)}(?![\\p{L}\\p{N}_-])`, 'gu');
        for (const found of String(entry?.grammar ?? '').matchAll(re)) heads.add(`${found[1]} ${word}`);
    }
    return heads;
}

// A story line as a change line: 'C' (a known head, exactly, and it parses), 'N' (close to one: an op
// and a known kind word, but not as the grammar writes it, or it does not parse), or null.
function strayClass(raw, heads, words) {
    if (raw.length > MAX_LINE) return null;
    const line = stripDecoration(stripMarkdown(raw).trim()).trim();
    const found = /^([+\-~!?])([ \t]*)(\p{L}[\p{L}\p{N}_-]*)(.?)/u.exec(line);
    if (!found || !words.has(found[3].toLowerCase())) return null;
    const [, op, gap, word, next] = found;
    const parsed = parseLine(line);
    const exact = gap === ' ' && heads.has(`${op} ${word}`) && (next === ' ' || next === '\t');
    return { type: exact && !parsed.error ? 'C' : 'N', op, word: word.toLowerCase(), error: parsed.error ?? null };
}

const STRAY_HINT = 'change lines go inside the <Changes> block at the end of the reply';

/**
 * The change lines written in the story of `mes` (see above): { taken: [{ start, end, line }], problems:
 * [{ line, reason }] }, `start`/`end` the line's place in `mes` (without its line break), `line` trimmed.
 * `heads` from grammarHeads. `from`, `tail` (continuation()): only a Continue's own text is looked at.
 * `stopped`: the reader stopped the reply, so a last line with no line break after it is left out.
 */
export function strayLines(mes, heads, { tag = 'Changes', from = 0, tail = false, stopped = false } = {}) {
    const text = String(mes ?? '');
    const known = heads instanceof Set ? heads : new Set(heads ?? []);
    const words = new Map();
    for (const head of known) {
        const word = head.slice(2);
        if (!words.has(word)) words.set(word, []);
        words.get(word).push(head);
    }
    if (!words.size || !text) return { taken: [], problems: [] };
    const at = Math.max(0, Math.min(text.length, from | 0));
    // The story alone: reasoning, hidden comments and bare blocks blanked, places kept.
    const spans = [...hiddenPairs(text), ...(tail ? bareBlocks(text, tag, at) : bareBlocks(text, tag))].sort((a, b) => a.start - b.start);
    const scan = replacePairs(maskReasoning(text), spans, blank);
    const later = spans.filter(span => span.end > at);
    const anchor = later.length ? later[0].start : text.length;
    // A stopped reply's last line, when no line break follows it, may be cut.
    const lastEnd = text.trimEnd().length;
    const cutStart = stopped && text.indexOf('\n', lastEnd) < 0 ? text.lastIndexOf('\n', lastEnd - 1) + 1 : -1;

    // Paragraphs: runs of lines with something on them, in order; lines before `from` are story.
    const paragraphs = [];
    let current = null;
    for (let start = 0; start <= scan.length;) {
        const nl = scan.indexOf('\n', start);
        const end = nl < 0 ? scan.length : nl;
        const raw = scan.slice(start, end).trim();
        if (!raw) current = null;
        else {
            if (!current) paragraphs.push(current = { start, lines: [] });
            // (A line reasoning was blanked in is not taken: its text is not the line alone.)
            const kind = start >= at && text.slice(start, end).trim() === raw ? strayClass(raw, known, words) : null;
            current.lines.push({ start, end, raw, kind });
        }
        if (nl < 0) break;
        start = nl + 1;
    }
    const inRegion = new Set();
    let counted = 0;
    for (const paragraph of paragraphs) {
        paragraph.changes = paragraph.lines.every(line => line.kind);
        if (paragraph.start >= anchor) inRegion.add(paragraph);
    }
    for (let i = paragraphs.length - 1; i >= 0; i -= 1) {
        const paragraph = paragraphs[i];
        if (paragraph.start >= anchor) continue;
        if (paragraph.lines.at(-1).start < at) break;
        if (!paragraph.changes) {
            counted += 1;
            if (counted > STRAY_PARAGRAPHS) break;
        }
        inRegion.add(paragraph);
    }

    const taken = [];
    const problems = [];
    const refuse = (line, reason) => problems.push({ line: line.raw, reason });
    for (const paragraph of paragraphs) {
        const near = inRegion.has(paragraph);
        for (const line of paragraph.lines) {
            const kind = line.kind;
            if (!kind) continue;
            if (kind.type === 'N') {
                if (!near && !paragraph.changes) continue;
                const how = (words.get(kind.word) ?? []).map(head => `"${head} …"`).join(' or ');
                refuse(line, kind.error ? `it is not a change line: ${kind.error}; ${STRAY_HINT}` : `it is in the story and does not start the way a ${kind.word} line does (${how}); ${STRAY_HINT}`);
            } else if (line.start === cutStart) {
                refuse(line, 'the reply stopped in the middle of it');
            } else if (near && (paragraph.changes || kind.op !== '-')) {
                taken.push({ start: line.start, end: line.end, line: line.raw });
            } else if (near) {
                refuse(line, `it is part of a story paragraph, so it was read as story; ${STRAY_HINT}`);
            } else if (paragraph.changes || kind.op !== '-') {
                refuse(line, `it is in the story, far from the end of the reply, so it was read as story; ${STRAY_HINT}`);
            }
        }
    }
    return { taken, problems };
}

// The bodies to read, in the order extractBlock reads them and hideBlock keeps them: the blocks' bodies,
// then the lines taken from the story as one body; before the blocks when the last block was left open
// (the reply was cut off in it), so the block a Continue goes on with stays last.
function inOrder(bodies, strays, open) {
    if (!strays.length) return bodies;
    const lines = strays.map(line => line.line).join('\n');
    return open ? [lines, ...bodies] : [...bodies, lines];
}

// `text` without the whole lines `taken` (strayLines, places in `text`); a blank line left doubled
// where a paragraph of them stood goes too.
function dropLines(text, taken) {
    if (!taken.length) return text;
    const drop = new Set(taken.map(line => line.start));
    const out = [];
    let lastBlank = true;
    let dropped = false;
    for (let start = 0; start <= text.length;) {
        const nl = text.indexOf('\n', start);
        const end = nl < 0 ? text.length : nl;
        const line = text.slice(start, end);
        if (drop.has(start)) dropped = true;
        else {
            const isBlank = !line.trim();
            if (!(dropped && isBlank && lastBlank)) {
                out.push(line);
                lastBlank = isBlank;
            }
            dropped = false;
        }
        if (nl < 0) break;
        start = nl + 1;
    }
    return out.join('\n');
}
