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
// Attributes stay on the tag's own line, so a tag cut off mid-way never reaches far ahead.
const openRe = tag => new RegExp(`<${escapeRe(tag)}(?:[ \\t][^>\\n]*)?>`, 'gi');
const closeRe = tag => new RegExp(`</${escapeRe(tag)}\\s*>`, 'gi');
const HIDDEN_RE = new RegExp(`<!--\\s*${HIDDEN_MARKER}\\b([\\s\\S]*?)-->`, 'g');

// The separator between the name and the text: an em or en dash (with or without spaces) or a
// spaced hyphen, so `Jean-Luc` stays one name.
const TEXT_DASH = /\s*[—–]\s*|\s+-(?:\s+|$)/;
// `label: value`: the label is words (so `09:00` is not one), lowercased by the parser.
const LABELLED = /^(\p{L}[\p{L}\p{N}'’ _-]*?)\s*:(?:\s+|$)(.*)$/su;
// What a model writes when it had nothing to change; dropped quietly.
const NOTHING = /^\(?\s*(?:none|no changes?|nothing(?: changed)?|n\/a)\s*\)?\.?$/i;

function stripMarkdown(text) {
    return String(text ?? '').replace(/\*\*|__|`/g, '');
}

// Every <tag>…</tag> in `mes`, in order: { start, end, body }. A block left open (the reply was
// cut off) runs to the end of the text.
function findBlocks(mes, tag) {
    const text = String(mes ?? '');
    const blocks = [];
    const open = openRe(tag);
    let match;
    while ((match = open.exec(text))) {
        const close = closeRe(tag);
        close.lastIndex = open.lastIndex;
        const end = close.exec(text);
        const bodyEnd = end ? end.index : text.length;
        const blockEnd = end ? end.index + end[0].length : text.length;
        blocks.push({ start: match.index, end: blockEnd, body: text.slice(open.lastIndex, bodyEnd) });
        open.lastIndex = blockEnd;
        if (!end) break;
    }
    return blocks;
}

/**
 * The text inside the reply's <Changes> block (or `tag`), or null when there is none. Found
 * whether the block is bare or already hidden in Story Suite's comment; several blocks are
 * read as one, in order, so no line is lost.
 */
export function extractBlock(mes, tag = 'Changes') {
    const blocks = findBlocks(mes, tag);
    if (!blocks.length) return null;
    return blocks.map(block => block.body.replace(/^\s*\n/, '').replace(/\n\s*$/, '')).join('\n');
}

/**
 * `mes` without its <Changes> blocks (bare or hidden), for display and for the prompt history.
 * Whitespace left at the end is trimmed.
 */
export function stripBlock(mes, tag = 'Changes') {
    let text = String(mes ?? '').replace(HIDDEN_RE, (whole, body) => (findBlocks(body, tag).length ? '' : whole));
    const blocks = findBlocks(text, tag);
    for (const block of blocks.reverse()) text = text.slice(0, block.start) + text.slice(block.end);
    return text.replace(/\s+$/, '');
}

/**
 * `mes` with its bare <Changes> blocks moved into one hidden comment at the end, so
 * SillyTavern shows nothing of them and Re-read can still find them. Already hidden: unchanged.
 */
export function hideBlock(mes, tag = 'Changes') {
    const text = String(mes ?? '');
    const bare = findBlocks(text.replace(HIDDEN_RE, match => ' '.repeat(match.length)), tag);
    if (!bare.length) return text;
    let story = text;
    for (const block of [...bare].reverse()) story = story.slice(0, block.start) + story.slice(block.end);
    // `-->` inside the block would end the comment early.
    const kept = bare.map(block => `<${tag}>\n${block.body.replace(/^\s*\n/, '').replace(/\n\s*$/, '').replace(/--\s*>/g, '-- >')}\n</${tag}>`).join('\n');
    return `${story.replace(/\s+$/, '')}\n\n<!-- ${HIDDEN_MARKER}\n${kept}\n-->`;
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
    labels[label] = Object.hasOwn(labels, label) && labels[label] && value ? `${labels[label]}; ${value}` : (labels[label] || value);
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
    const dash = TEXT_DASH.exec(first);
    const name = (dash ? first.slice(0, dash.index) : first).trim();
    const texts = [dash ? first.slice(dash.index + dash[0].length).trim() : ''];
    if (!name) return { error: `the ${kind} has no name` };
    const labels = {};
    for (const part of rest) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const labelled = LABELLED.exec(trimmed);
        // A part with no label is more text, so nothing written is lost.
        if (labelled) addLabel(labels, labelled[1].trim().toLowerCase(), labelled[2].trim());
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
        const parsed = parseLine(raw);
        if (parsed.error) problems.push(`Line ${number + 1} "${raw}" is not a change line: ${parsed.error}.`);
        else lines.push({ ...parsed, raw, index: lines.length });
    });
    return { lines, problems };
}
