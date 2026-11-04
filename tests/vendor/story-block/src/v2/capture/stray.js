// Story Suite v2: change-looking lines left in the prose (moved out of capture.js unchanged; capture.js re-exports the public names):
// telling a stray line from speech and from a line shown on purpose (quotes, fences), `strayLines`, `inOrder` and `dropLines`.
// Imports capture/lines.js and capture/blocks.js.

import { escapeRe, MAX_LINE, stripDecoration, stripMarkdown, parseLine } from './lines.js';
import { hiddenPairs, bareBlocks, replacePairs, maskReasoning, blank, commentParts } from './blocks.js';

/** How many story paragraphs before the block a change line written in the story is looked for in. */
export const STRAY_PARAGRAPHS = 3;

// A story line as a change line: 'C' (a known head, exactly, it parses, and nothing in it reads as prose),
// 'N' (close to one: an op or an op look-alike and a known kind word or its plural, but not as the grammar
// writes it, it does not parse, or it reads as a sentence, speech or a mention of the block's tag), or
// null. `why`: for an 'N', the reason told.
// The op look-alikes models write ("– coin 5", "− coin 5", "＋ coin 5"): a near miss, never taken (B-a1-9).
const STRAY_OP = /^([+\-~!?\p{Pd}−➕➖﹢﹣＋－～])([ \t]*)(\p{L}[\p{L}\p{N}_-]*)(.?)/u;
// Marks that open or close a quotation (an apostrophe is not one: "Bob's").
const QUOTE_MARKS = /["“”„«»「」『』]/;
const QUOTE_MARKS_ALL = /["“”„«»「」『』]/g;
// A comma and a word that goes on as speech or a sentence ("+ coin 5, she said", "…, and not one more").
const SPEECH = /,\s*(?:she|he|they|i|we|you|it|said|says|asked|asks|replied|whispered|muttered|shouted|called|added|laughed|and|but|or|then|so)(?![\p{L}\p{N}])/iu;
function prose(line, tag) {
    if (new RegExp(`</?${escapeRe(tag)}(?![\\p{L}\\p{N}_])`, 'iu').test(line)) return `a <${tag}> tag sits in it`;
    if (QUOTE_MARKS.test(line)) return 'it holds a quotation, so it reads as speech';
    if (/[.!?…][\s"”’)\]*_]*$/u.test(line) || /[.!?…]["”’)\]]*\s+\p{L}/u.test(line) || SPEECH.test(line)) return 'it reads as a sentence, not a change line';
    return null;
}
function strayClass(raw, heads, words, tag) {
    if (raw.length > MAX_LINE) return null;
    const line = stripDecoration(stripMarkdown(raw).trim()).trim();
    const found = STRAY_OP.exec(line);
    if (!found) return null;
    const [, op, gap, word, next] = found;
    const lower = word.toLowerCase();
    // "+ coins 5": the kind in the plural is a near miss of "+ coin".
    const plural = !words.has(lower) && lower.endsWith('s') && words.has(lower.slice(0, -1));
    if (!words.has(lower) && !plural) return null;
    const kind = plural ? lower.slice(0, -1) : lower;
    const ascii = /^[+\-~!?]$/.test(op);
    const parsed = ascii ? parseLine(line) : { error: `it starts with "${op}", not one of + - ~ ! ?` };
    const exact = ascii && !plural && gap === ' ' && heads.has(`${op} ${word}`) && (next === ' ' || next === '\t');
    // (What follows the op and the kind: the op itself is no sentence's end.)
    const why = parsed.error || !exact ? null : prose(line.slice(found[0].length - next.length), tag);
    const type = exact && !parsed.error && !why ? 'C' : 'N';
    return { type, op, word: kind, error: parsed.error ?? null, why: why ?? (plural ? `the kind is written "${word}", not "${kind}"` : null) };
}

const STRAY_HINT = 'change lines go inside the <Changes> block at the end of the reply';

// Lines of `scan` that are something shown, not the story's own words (B-a1-2): a fenced code block
// (``` or ~~~, one left open to the end), an indented code block (4 spaces or a tab, after a blank line), a
// quote (`>`), and HTML elements a reply shows or hides (<details>, <style>, <pre>, <script>, <code>,
// <textarea>, a <!-- comment -->, one left open to the end). → a Set of line starts. Linear.
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const SHOWN_OPEN = /<(details|style|pre|script|code|textarea)\b|<!--/gi;
function shownRanges(scan) {
    const lower = scan.toLowerCase();
    const ranges = [];
    SHOWN_OPEN.lastIndex = 0;
    let match;
    while ((match = SHOWN_OPEN.exec(scan))) {
        const close = match[1] ? `</${match[1].toLowerCase()}` : '-->';
        const end = lower.indexOf(close, SHOWN_OPEN.lastIndex);
        // A single-line element ("a <code>x</code> word") is part of its line's text, not a block of its own.
        const stop = end < 0 ? scan.length : end + close.length;
        if (end >= 0 && !scan.slice(match.index, stop).includes('\n')) { SHOWN_OPEN.lastIndex = stop; continue; }
        ranges.push([match.index, stop]);
        if (end < 0) break;
        SHOWN_OPEN.lastIndex = stop;
    }
    return ranges;
}
function shownLines(scan) {
    const out = new Set();
    const ranges = shownRanges(scan);
    let r = 0;
    let fence = null;
    let prevBlank = true;
    let indented = false;
    for (let start = 0; start <= scan.length;) {
        const nl = scan.indexOf('\n', start);
        const end = nl < 0 ? scan.length : nl;
        const line = scan.slice(start, end);
        const isBlank = !line.trim();
        while (r < ranges.length && ranges[r][1] <= start) r += 1;
        const inRange = r < ranges.length && ranges[r][0] < end && ranges[r][1] > start;
        if (fence) {
            out.add(start);
            const close = FENCE.exec(line);
            if (close && close[1][0] === fence.char && close[1].length >= fence.size && !line.slice(close[0].length).trim()) fence = null;
        } else if (!isBlank && FENCE.test(line)) {
            const open = FENCE.exec(line);
            out.add(start);
            fence = { char: open[1][0], size: open[1].length };
        } else if (!isBlank && /^(?: {4}|\t)/.test(line) && (prevBlank || indented)) {
            out.add(start);
            indented = true;
        } else if (!isBlank && /^ {0,3}>/.test(line)) {
            out.add(start);
        } else if (!isBlank && inRange) {
            out.add(start);
        }
        if (!isBlank && !(indented && out.has(start) && /^(?: {4}|\t)/.test(line))) indented = false;
        prevBlank = isBlank;
        if (nl < 0) break;
        start = nl + 1;
    }
    return out;
}

/**
 * The change lines written in the story of `mes` (see above): { taken: [{ start, end, line }], problems:
 * [{ line, reason, keep? }] }, `start`/`end` the line's place in `mes` (without its line break), `line`
 * trimmed. `keep`: a line that has a change line's shape but is left in the story, which hideBlock lists in
 * the hidden comment so a Re-read leaves it too. `heads` from grammarHeads. `from`, `tail`
 * (continuation()): only a Continue's own text is looked at. `stopped`: the reader stopped the reply, so a
 * last line with no line break after it is left out.
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
    const hidden = hiddenPairs(text);
    const spans = [...hidden, ...(tail ? bareBlocks(text, tag, at) : bareBlocks(text, tag))].sort((a, b) => a.start - b.start);
    const scan = replacePairs(maskReasoning(text), spans, blank);
    const later = spans.filter(span => span.end > at);
    const anchor = later.length ? later[0].start : text.length;
    // A stopped reply's last line, when no line break follows it, may be cut.
    const lastEnd = text.trimEnd().length;
    const cutStart = stopped && text.indexOf('\n', lastEnd) < 0 ? text.lastIndexOf('\n', lastEnd - 1) + 1 : -1;
    const shown = shownLines(scan);

    // Paragraphs: runs of lines with something on them, in order; lines before `from` are story. `quoted`:
    // a quotation was left open before the paragraph (a paragraph that starts with a quote mark opens a
    // new one, as speech over several paragraphs is written), so its lines are someone's words.
    const paragraphs = [];
    let current = null;
    let open = false;
    for (let start = 0; start <= scan.length;) {
        const nl = scan.indexOf('\n', start);
        const end = nl < 0 ? scan.length : nl;
        const raw = scan.slice(start, end).trim();
        if (!raw) current = null;
        else {
            if (!current) {
                if (/^["“«「『]/.test(raw)) open = false;
                paragraphs.push(current = { start, lines: [], quoted: open });
            }
            const isShown = shown.has(start);
            // A line a tag or reasoning was blanked in is not the line alone (`partial`).
            const kind = start >= at ? strayClass(raw, known, words, tag) : null;
            current.lines.push({ start, end, raw, kind, shown: isShown, partial: text.slice(start, end).trim() !== raw });
            if (!isShown) open = ((raw.match(QUOTE_MARKS_ALL)?.length ?? 0) % 2 === 1) !== open;
        }
        if (nl < 0) break;
        start = nl + 1;
    }
    // The lines an earlier read of this reply left in the story, which its hidden comment lists: each one is
    // the nearest line of that text above the comment that no earlier comment claimed (a comment lists only
    // lines of the text before it), so they are left again, on every later read.
    const left = new Set();
    const byText = new Map();
    for (const paragraph of paragraphs) for (const line of paragraph.lines) {
        if (!byText.has(line.raw)) byText.set(line.raw, []);
        byText.get(line.raw).push(line.start);
    }
    for (const pair of hidden) {
        for (const raw of commentParts(text, pair, tag).story) {
            const starts = byText.get(raw) ?? [];
            const found = starts.findLast(start => start < pair.start && !left.has(start));
            if (found !== undefined) left.add(found);
        }
    }
    const inRegion = new Set();
    let counted = 0;
    for (const paragraph of paragraphs) {
        paragraph.changes = paragraph.lines.every(line => line.kind && !line.shown && !line.partial);
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
    // `keep`: the line is left in the story with a change line's shape; hideBlock lists it (see above).
    const refuse = (line, reason, keep = false) => problems.push({ line: line.raw, reason, ...(keep ? { keep: true } : {}) });
    for (const paragraph of paragraphs) {
        const near = inRegion.has(paragraph);
        for (const line of paragraph.lines) {
            const kind = line.kind;
            if (!kind) continue;
            if (kind.type === 'N') {
                if (line.shown || (!near && !paragraph.changes)) continue;
                const how = (words.get(kind.word) ?? []).map(head => `"${head} …"`).join(' or ');
                const reason = kind.error ? `it is not a change line: ${kind.error}` : kind.why ?? `it is in the story and does not start the way a ${kind.word} line does (${how})`;
                refuse(line, `${reason}; ${STRAY_HINT}`);
            } else if (left.has(line.start)) {
                if (near || paragraph.changes || kind.op !== '-') refuse(line, `it was read as story when the reply came, so it stays story; ${STRAY_HINT}`);
            } else if (line.start === cutStart) {
                refuse(line, 'the reply stopped in the middle of it', true);
            } else if (line.partial) {
                if (near) refuse(line, `a tag or a thought shares its line, so it was read as story; ${STRAY_HINT}`, true);
            } else if (line.shown) {
                if (near) refuse(line, `it is in a code block, a quote or an HTML block, so it was read as something shown; ${STRAY_HINT}`, true);
            } else if (paragraph.quoted) {
                if (near) refuse(line, `it is inside someone's words (a quotation left open above it), so it was read as story; ${STRAY_HINT}`, true);
            } else if (near && paragraph.changes) {
                taken.push({ start: line.start, end: line.end, line: line.raw });
            } else if (near) {
                refuse(line, `it is part of a story paragraph, so it was read as story; ${STRAY_HINT}`, true);
            } else if (paragraph.changes || kind.op !== '-') {
                refuse(line, `it is in the story, far from the end of the reply, so it was read as story; ${STRAY_HINT}`, true);
            }
        }
    }
    return { taken, problems };
}

// The bodies to read, in the order extractBlock reads them and hideBlock keeps them: the blocks' bodies,
// then the lines taken from the story as one body; before the blocks when the last block was left open
// (the reply was cut off in it), so the block a Continue goes on with stays last.
export function inOrder(bodies, strays, open) {
    if (!strays.length) return bodies;
    const lines = strays.map(line => line.line).join('\n');
    return open ? [lines, ...bodies] : [...bodies, lines];
}

// `text` without the whole lines `taken` (strayLines, places in `text`); a blank line left doubled
// where a paragraph of them stood goes too.
export function dropLines(text, taken) {
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
