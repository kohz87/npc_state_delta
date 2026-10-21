// Change lines (docs/v2/SPEC.md §4.4): the hidden <Changes> block a reply ends with, one proposal
// per line, `op kind Name[ — text][ | label: value]*`. Parsing is lenient because models drift
// (bullets, bold, code fences, either dash, a colon after the kind); a line that is not a change
// becomes a problem, never an exception. Each line is handed to the module that owns its kind
// (turn.js), which decides what it means. Pure: no DOM, no SillyTavern.

// + new or gained, - gone or lost, ~ changed, ! happened, ? asks code to decide.
export const OPS = Object.freeze(['+', '-', '~', '!', '?']);

// The HTML comment a captured block is kept in, so SillyTavern shows nothing of it and the
// prompt history can drop it (turn.js). `\b` keeps a longer marker from matching.
export const HIDDEN_MARKER = 'STORY_SUITE_V2';

const escapeRe = text => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// An open or a close tag. Attributes stay on the tag's own line and are short, so a tag cut off
// mid-way never reaches far ahead (and no tag costs more than its own few characters to read).
const tagRe = tag => new RegExp(`<(/?)${escapeRe(tag)}(?:[ \\t][^>\\n]{0,200})?[ \\t]*>`, 'gi');
const HIDDEN_RE = new RegExp(`<!--\\s*${HIDDEN_MARKER}\\b([\\s\\S]*?)-->`, 'g');

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
function findBlocks(mes, tag) {
    const text = String(mes ?? '');
    const blocks = [];
    const re = tagRe(tag);
    let depth = 0;
    let start = 0;
    let bodyStart = 0;
    let match;
    while ((match = re.exec(text))) {
        if (!match[1]) {
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

// A block left open ends where the reply stopped. Its last line is only whole when a line break
// follows it; otherwise it was cut off mid-way ("+ coin 2" of "+ coin 25") and is left out (B2-11).
// → { body, cut } (`cut`: the line left out, or '').
function wholeLines(block) {
    if (!block.open || block.body.endsWith('\n')) return { body: block.body, cut: '' };
    const nl = block.body.lastIndexOf('\n');
    return { body: nl < 0 ? '' : block.body.slice(0, nl + 1), cut: block.body.slice(nl + 1).trim() };
}

/**
 * The change line a reply stopped in the middle of (its block left open, the last line with no line
 * break after it), or null. extractBlock and hideBlock leave that line out; turn.js tells it as a Problem.
 * `at` (continuation()): only a Continue's own blocks are looked at.
 */
export function cutLine(mes, tag = 'Changes', at = null) {
    const last = (at ? laterBlocks(mes, tag, at) : findBlocks(withoutReasoning(mes), tag)).at(-1);
    const cut = last ? wholeLines(last).cut : '';
    return cut || null;
}

// Reasoning a model writes in the reply itself (<think>, <thinking>, <reasoning>), closed
// blocks only: a draft of the change block inside it is not the change block, so a reply that
// drafts it there and writes it again at the end is read once. An unclosed tag is left alone,
// so a reply cut off mid-thought never loses a block written before it. A pair that does not
// match (`<thinking>…</think>`, as some models write) is reasoning too.
const REASONING_RE = /<(?:think|thinking|reasoning)(?:[ \t][^>\n]{0,200})?>[\s\S]*?<\/(?:think|thinking|reasoning)\s*>/gi;

/** `mes` without its closed reasoning blocks. */
export function withoutReasoning(mes) {
    return String(mes ?? '').replace(REASONING_RE, '');
}

// `text` with its closed reasoning blocks blanked to spaces of the same length, so the
// positions of what is outside them stay where they are.
const maskReasoning = text => text.replace(REASONING_RE, match => ' '.repeat(match.length));
// The bare blocks of `mes` (not hidden in Story Suite's comment, not inside closed reasoning), at
// their places in `mes`.
const bareBlocks = (mes, tag) => findBlocks(maskReasoning(String(mes ?? '').replace(HIDDEN_RE, match => ' '.repeat(match.length))), tag);
// The bare blocks a Continue added: from the `skip`th bare block on, starting at or after `from`.
const laterBlocks = (mes, tag, { from = 0, skip = 0 } = {}) => bareBlocks(mes, tag).filter((block, i) => i >= skip && block.start >= from);

/**
 * Where a Continue's own text starts in `mes` (the reply after the Continue), given `base` (the reply
 * as it was before it) → { from, skip } for extractBlock, cutLine and hideBlock.
 * SillyTavern writes a continued reply again from its copy of the old text plus what was added, and
 * cleans the whole of it up (spaces at line ends and at the start dropped, blank lines collapsed when
 * that is set, the reader's regex scripts), so the old text can come back shorter than it was. A
 * place counted in the old text would then land inside the added text and its block be missed, left
 * bare for the reader to see. So `from` is found by following `base` through `mes` while passing over
 * whitespace on either side; where something else differs it stops there, early. `skip` is how many
 * whole bare blocks `base` already had (edited in by hand, never read): those are never read here,
 * even when `from` stopped early. Only bare blocks count: a hidden one was read before.
 */
export function continuation(base, mes, tag = 'Changes') {
    const before = String(base ?? '');
    const after = String(mes ?? '');
    const skip = bareBlocks(before, tag).filter(block => !block.open).length;
    if (after.startsWith(before)) return { from: before.length, skip };
    let i = 0;
    let j = 0;
    while (i < before.length) {
        if (isSpace(before[i])) { i += 1; continue; }
        while (j < after.length && isSpace(after[j])) j += 1;
        if (after[j] !== before[i]) break;
        i += 1;
        j += 1;
    }
    return { from: j, skip };
}

/**
 * The text inside the reply's <Changes> block (or `tag`), or null when there is none. Found
 * whether the block is bare or already hidden in Story Suite's comment; several blocks are
 * read as one, in order, so no line is lost. Blocks inside closed reasoning are not read.
 * `at` ({ from, skip }, from continuation()): only the bare blocks a Continue added are read.
 */
export function extractBlock(mes, tag = 'Changes', at = null) {
    const blocks = at ? laterBlocks(mes, tag, at) : findBlocks(withoutReasoning(mes), tag);
    if (!blocks.length) return null;
    return blocks.map(block => blockBody(wholeLines(block).body)).join('\n');
}

/**
 * `mes` without its <Changes> blocks (bare or hidden), for display and for the prompt history.
 * Whitespace left at the end is trimmed.
 */
export function stripBlock(mes, tag = 'Changes') {
    let text = String(mes ?? '').replace(HIDDEN_RE, (whole, body) => (findBlocks(body, tag).length ? '' : whole));
    const blocks = findBlocks(text, tag);
    for (const block of blocks.reverse()) text = text.slice(0, block.start) + text.slice(block.end);
    return trimEnd(text);
}

// Every `--` in a comment's body broken up, so neither `-->` nor `--!>` can end it early.
const commentSafe = text => text.replace(/-(?=-)/g, '- ');

/**
 * `mes` with its bare <Changes> blocks moved into one hidden comment at the end, so
 * SillyTavern shows nothing of them and Re-read can still find them. Already hidden: unchanged.
 * `from`, `skip` (continuation()): only blocks that start at or after `from`, from the `skip`th bare
 * block on (a Continue's own text), are moved; the ones before are left as they are.
 */
export function hideBlock(mes, tag = 'Changes', { from = 0, skip = 0 } = {}) {
    const text = String(mes ?? '');
    const bare = laterBlocks(text, tag, { from, skip });
    if (!bare.length) return text;
    let story = text;
    for (const block of [...bare].reverse()) story = story.slice(0, block.start) + story.slice(block.end);
    const kept = bare.map(block => `<${tag}>\n${commentSafe(blockBody(wholeLines(block).body))}\n</${tag}>`).join('\n');
    return `${trimEnd(story)}\n\n<!-- ${HIDDEN_MARKER}\n${kept}\n-->`;
}

// A bullet, number or quote mark in front of a line is decoration. A hyphen counts as one only
// when an op follows it: `- item Rope` is itself an op.
function stripDecoration(line) {
    return line
        .replace(/^>\s*/, '')
        .replace(/^(?:[*•·]\s+|\d+[.)]\s+)/, '')
        .replace(/^-\s+(?=[+\-~!?]\s)/, '');
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
 * Returns { lines: [{ op, kind, name, text, labels, raw, index }], problems: string[] }; `index`
 * is the line's place among the lines read (0-based), `raw` the line as written.
 */
export function parseChanges(text) {
    const lines = [];
    const problems = [];
    String(text ?? '').split(/\r?\n/).forEach((source, number) => {
        const raw = source.trim();
        if (!raw || raw.startsWith('```') || raw.startsWith('~~~') || /^<\/?[A-Za-z_]+\s*>$/.test(raw) || NOTHING.test(raw)) return;
        if (raw.length > MAX_LINE) {
            problems.push(`Line ${number + 1} "${raw.slice(0, 60)}…" is longer than ${MAX_LINE} characters, so it was not read.`);
            return;
        }
        const parsed = parseLine(raw);
        if (parsed.error) problems.push(`Line ${number + 1} "${raw}" is not a change line: ${parsed.error}.`);
        else lines.push({ ...parsed, raw, index: lines.length });
    });
    return { lines, problems };
}
