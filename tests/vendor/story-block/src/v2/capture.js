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

// --- The hidden comment's body -----------------------------------------------------------------------
// `<!-- STORY_SUITE_V2[ open][ off:word,word]` then the blocks' bodies, each in <Changes>…</Changes>, then
// (when there are any) the change lines a capture left in the story, in <Changes-story>…</Changes-story>,
// so a Re-read leaves them too (strayLines), and an open block's unfinished last line in <Changes-cut>…
// </Changes-cut>, for a Continue that finishes it (continuation()), and the story lines that echoed a
// line of the blocks (C-1), taken out of the story but never read, in <Changes-echo>…</Changes-echo>.
// The lines a read took from the story are one body of their own, marked `<Changes story>…</Changes>`:
// read like any other, and known as the story's to a Continue, whose block lines that repeat one of them
// are its echo (FB-1, earlierLines): kept in that Continue's <Changes-echo>, never read.
// `open`: the reply was cut off inside its last block. `off:`: display kinds (written words) whose lines were read while their feature was
// off, so they are not shown when it is turned on later, until a Re-read reads them again (markOff).
//
// An HTML comment ends at `-->` (or `--!>`), so no `--` may stand in its body. Each `--` is written with a
// word joiner (U+2060) between, and a word joiner already there is written twice, so the body read back
// (commentText) is exactly what was read live (B-a1-11). Comments written before this broke `--` up with a
// space ("- -"); they hold no word joiner between dashes and read as they always did.
const JOIN = '\u2060';
const commentSafe = text => String(text).replace(/\u2060/g, JOIN + JOIN).replace(/-(?=-)/g, `-${JOIN}`);
const commentText = text => String(text).replace(/\u2060\u2060|(?<=-)\u2060(?=-)/g, found => (found.length === 2 ? JOIN : ''));

const sectionTags = tag => ({ story: `${tag}-story`, cut: `${tag}-cut`, echo: `${tag}-echo`, assist: `${tag}-assist`, next: `${tag}-assist-next` });

// The parts of a hidden pair's body beside its blocks: { head: Set of header words, off: Set, story:
// lines, cut: line | null, echo: lines, assist: lines, next: lines }. `assist` and `next` are the Assist
// extractor's stored output (assistSections): the lines it read on this reply, and the ones it read here
// after the reader had sent, which the next reply applies.
function commentParts(text, pair, tag = 'Changes') {
    const body = text.slice(pair.bodyStart, pair.bodyEnd);
    const nl = body.indexOf('\n');
    const head = (nl < 0 ? body : body.slice(0, nl)).trim().split(/\s+/).filter(Boolean);
    const off = new Set(head.filter(word => word.startsWith('off:')).flatMap(word => word.slice(4).split(',')).filter(Boolean));
    const names = sectionTags(tag);
    const story = [];
    const cut = [];
    const echo = [];
    const assist = [];
    const next = [];
    const into = { [`<${names.story}>`]: story, [`<${names.cut}>`]: cut, [`<${names.echo}>`]: echo, [`<${names.assist}>`]: assist, [`<${names.next}>`]: next };
    let list = null;
    if (Object.keys(into).some(open => body.includes(open))) {
        for (const line of body.split('\n')) {
            const trimmed = line.trim();
            if (into[trimmed]) list = into[trimmed];
            else if (Object.values(names).some(name => trimmed === `</${name}>`)) list = null;
            else if (list && trimmed) list.push(commentText(trimmed));
        }
    }
    return { head: new Set(head), off, story, cut: cut[0] ?? null, echo, assist, next };
}

/** True when `mes` holds Story Suite's hidden comment (whatever is in it). */
export function hasHidden(mes) {
    return hiddenPairs(String(mes ?? '')).length > 0;
}

/**
 * `mes` with the header of each hidden comment from `from` on saying which display kinds (written words,
 * `words`) were off when its lines were read (`off:choice,chatter`), or nothing when none: displayLines
 * then leaves those lines out (B-a1-5). A Re-read marks every comment of the reply anew.
 */
export function markOff(mes, words, from = 0) {
    const text = String(mes ?? '');
    const list = [...new Set(words ?? [])].map(word => String(word).toLowerCase()).filter(word => KIND_WORD.test(word)).sort();
    const pairs = hiddenPairs(text).filter(pair => pair.start >= from);
    return replacePairs(text, pairs, pair => {
        const body = text.slice(pair.bodyStart, pair.bodyEnd);
        const nl = body.indexOf('\n');
        const words = (nl < 0 ? body : body.slice(0, nl)).trim().split(/\s+/).filter(word => word && !word.startsWith('off:'));
        if (list.length) words.push(`off:${list.join(',')}`);
        return `${text.slice(pair.start, pair.bodyStart)}${words.map(word => ` ${word}`).join('')}${nl < 0 ? '' : body.slice(nl)}${text.slice(pair.bodyEnd, pair.end)}`;
    });
}

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
// ends at its matching close, not the first one. A close tag ends a block only at the start of a line,
// or at the end of a line that is a whole change line before it (C-3): one in a line (`note: the
// </Changes> tag`, `| who: </Changes>`) is part of that line, so the lines after it are still read (and anything that is not a change line among them
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
        // C-3: a close ends the block at the start of a line (alone, or with story after it, as a Continue
        // joins it), or at the end of a line that is a whole change line before it ("+ item Rope</Changes>");
        // one inside a line ("| note: </Changes>", "+ item Torch </Changes> and then") is part of that
        // line, so the block's later lines stay in it.
        if (!blankBefore(text, match.index) && !(blankAfter(text, re.lastIndex) && wholeBefore(text, match.index, bodyStart))) continue;
        depth -= 1;
        if (!depth) blocks.push({ start, end: re.lastIndex, body: text.slice(bodyStart, match.index) });
    }
    if (depth) blocks.push({ start, end: text.length, body: text.slice(bodyStart), open: true });
    return blocks;
}

// The line up to `at` (at most MAX_LINE characters looked at) is a whole change line (or "none"): it parses
// and does not end waiting for more (a label with no value, a dash, a bar).
function wholeBefore(text, at, floor = 0) {
    const start = Math.max(text.lastIndexOf('\n', at - 1) + 1, at - MAX_LINE, floor);
    const line = text.slice(start, at).trim();
    if (!line) return false;
    if (NOTHING.test(line)) return true;
    return /^[+\-~!?]/.test(line) && !/[|:—–-]$/.test(line) && !parseLine(line).error;
}

// The rest of the line from `at` (at most MAX_LINE characters looked at) is a change line.
function changeAfter(text, at) {
    const nl = text.indexOf('\n', at);
    const end = Math.min(nl < 0 ? text.length : nl, at + MAX_LINE);
    const rest = text.slice(at, end).trim();
    return !!rest && /^[+\-~!?]/.test(rest) && !parseLine(rest).error;
}

// A block left open ends where the reply stopped. Its last line is whole only when a line break follows
// it; with none it may be cut off mid-way ("+ item Ro" of "+ item Rope", by the reader's stop or by the
// length limit, B-a1-14), so it is never applied: it is left out, told (CUT_OFF), and kept in the hidden
// comment, where a Continue that goes on with it reads it joined to the Continue's first line
// (continuation()). A model that forgot the close tag loses its last line the same way (the Problem says
// how to get it back). `stopped` (the reader stopped the reply) no longer changes this.
// → { body, cut } (`cut`: the line left out, or '').
function wholeLines(block) {
    if (!block.open || block.body.endsWith('\n')) return { body: block.body, cut: '' };
    const nl = block.body.lastIndexOf('\n');
    const last = block.body.slice(nl + 1).trim();
    if (!last) return { body: block.body, cut: '' };
    return { body: nl < 0 ? '' : block.body.slice(0, nl + 1), cut: last };
}

/**
 * The change line a reply ended in the middle of (its block left open, the last line with no line break
 * after it), or null. extractBlock and hideBlock leave that line out; turn.js tells it as a Problem.
 * `at` (continuation()): only a Continue's own blocks are looked at (a line it finished is whole).
 */
export function cutLine(mes, tag = 'Changes', at = null) {
    const last = readBlocks(mes, tag, at).at(-1);
    return last ? wholeLines(last).cut || null : null;
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
// `cut` (B-a1-14): the block's unfinished last line, kept in the comment; the Continue's text up to its
// first line break finishes it ("+ item Ro" + "pe | qty: 2"), read as one line.
export function continuation(base, mes, tag = 'Changes') {
    const before = String(base ?? '');
    const after = String(mes ?? '');
    const skip = bareBlocks(before, tag).filter(block => !block.open).length;
    // B-a1-14: the unfinished last line the reply's hidden comment kept, which the Continue's first line finishes.
    const last = endsInOpenBlock(before) ? hiddenPairs(before).at(-1) : null;
    const cut = last ? commentParts(before, last, tag).cut : null;
    const at = from => (last && goesOn(after, tag, from, cut) ? { from, skip, tail: true, ...(cut ? { cut } : {}) } : { from, skip });
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

// Does the text from `from` go on with a block left open: a close tag first, or a change line first (with
// `cut`, the unfinished line it goes on with, joined to its first line)?
function goesOn(mes, tag, from, cut = null) {
    const first = bareBlocks(mes, tag, from)[0];
    if (!first) return false;
    if (!first.open) return true;
    // (A Continue that starts on a new line leaves the cut line as it was; its own first line decides.)
    const own = first.body.split('\n')[0];
    const line = (cut && own.trim() ? `${cut}${own}` : first.body.trimStart().split('\n')[0]).trim();
    return !!line && !parseLine(line).error;
}

/**
 * The Assist extractor's stored output in `mes` (MODULES §F100, §F123): { now, next }, the lines of every
 * hidden comment's <Changes-assist> section (applied on this reply) and <Changes-assist-next> section (read
 * from this reply after the reader had sent; the next reply applies them), in order. Never read as the
 * reply's own block (extractBlock leaves sections out), so Re-read and replay take them from here.
 */
export function assistSections(mes, tag = 'Changes') {
    const text = withoutReasoning(String(mes ?? ''));
    const now = [];
    const next = [];
    for (const pair of hiddenPairs(text)) {
        const parts = commentParts(text, pair, tag);
        now.push(...parts.assist);
        next.push(...parts.next);
    }
    return { now, next };
}

/**
 * `mes` with `lines` kept as the Assist extractor's output, in a hidden comment of their own at the end:
 * a <Changes-assist> section, or with `next` a <Changes-assist-next> one. Hidden like a block (stripBlock
 * takes it out of the shown text and the prompt history); no line is ever read from it as the reply's own.
 */
export function withAssist(mes, lines, { next = false, tag = 'Changes' } = {}) {
    const list = (lines ?? []).map(line => cutAt(String(line ?? '').replace(/[\r\n]+/g, ' ').trim(), MAX_LINE)).filter(Boolean);
    const text = String(mes ?? '');
    if (!list.length) return text;
    const name = sectionTags(tag)[next ? 'next' : 'assist'];
    return `${trimEnd(text)}\n\n<!-- ${HIDDEN_MARKER}\n<${name}>\n${commentSafe(list.join('\n'))}\n</${name}>\n-->`;
}

// C-1: a change line written in the story that the reply's blocks also hold (the model wrote it, then
// listed it) is one change: it is taken out of the story and kept in the hidden comment (<Changes-echo>),
// never read. Lines are the same when they are equal without decoration, bold and extra spaces.
const sameLine = line => stripDecoration(stripMarkdown(line).trim()).trim().replace(/\s+/g, ' ');
/** C-1's matching, for other readers (the Assist extractor): the key two change lines share when they are the same line. */
export const sameChangeLine = line => sameLine(String(line ?? ''));
// `earlier` (a Continue's read, earlierLines): the block lines the reply's earlier reads kept count as listed.
function splitEchoes(strays, bodies, earlier = null) {
    if (!strays.length) return { strays, echoes: [] };
    const listed = new Set(bodies.flatMap(body => body.split('\n')).map(sameLine).filter(Boolean));
    for (const key of earlier?.listed ?? []) listed.add(key);
    const echoes = strays.filter(line => listed.has(sameLine(line.line)));
    return echoes.length ? { strays: strays.filter(line => !echoes.includes(line)), echoes } : { strays, echoes };
}

// The open tag of the body that holds the lines a read took from the story (hideBlock).
const STORY_WORD = 'story';
const storyTag = (text, block, tag) => new RegExp(`^<${escapeRe(tag)}[ \\t]+${STORY_WORD}[ \\t]*>`, 'i')
    .test(text.slice(block.start, block.start + tag.length + 40));

// FB-1, C-1 across a Continue: the story line and the block line that lists it can come in different reads
// of one reply (it was cut off before or inside its block, and the Continue writes the block). What the
// hidden comments before `from` (the reply's earlier reads) hold, keyed by sameLine: `story`, how many of
// each line they took from the story (their `<Changes story>` bodies) that no later block line echoed yet
// (the comments' <Changes-echo> lines, in order), and `listed`, the lines of their other blocks.
// → null for a read that is not a Continue's, or a reply with no earlier comment.
function earlierLines(mes, tag, from) {
    if (!(from > 0)) return null;
    const text = String(mes ?? '');
    const pairs = hiddenPairs(text).filter(pair => pair.end <= from);
    if (!pairs.length) return null;
    const story = new Map();
    const listed = new Set();
    for (const pair of pairs) {
        const inner = text.slice(pair.bodyStart, pair.bodyEnd);
        for (const block of findBlocks(commentBlocks(inner, tag), tag)) {
            const keys = commentText(block.body).split('\n').map(sameLine).filter(Boolean);
            if (storyTag(inner, block, tag)) for (const key of keys) story.set(key, (story.get(key) ?? 0) + 1);
            else for (const key of keys) listed.add(key);
        }
        for (const key of commentParts(text, pair, tag).echo.map(sameLine)) {
            if (story.get(key) > 0) story.set(key, story.get(key) - 1);
        }
    }
    return { story, listed };
}

// A Continue's block lines (`bodies`, whole lines) that repeat a line an earlier read of the reply took
// from the story, one block line for each such story line: that line was read, so these are its echo,
// never read again. → { bodies (without them), echoes: lines }.
function dropEchoed(bodies, earlier) {
    if (!earlier?.story.size) return { bodies, echoes: [] };
    const left = new Map(earlier.story);
    const echoes = [];
    const out = bodies.map(body => body.split('\n').filter(line => {
        const key = sameLine(line);
        if (!key || !(left.get(key) > 0)) return true;
        left.set(key, left.get(key) - 1);
        echoes.push(line.trim());
        return false;
    }).join('\n'));
    return echoes.length ? { bodies: out, echoes } : { bodies, echoes };
}

// What one read of `mes` reads, the same for extractBlock and hideBlock: its blocks (readBlocks), their
// whole lines without the echoes of earlier story lines (`bodies`; `emptied`: a body left with no line by
// that), the story lines it reads (`strays`) and the ones that echo a block line (`echoes`), and the block
// lines that echo an earlier read's story line (`repeated`). `found`: strayLines' taken lines.
function readParts(mes, tag, at, found) {
    const blocks = readBlocks(mes, tag, at);
    const whole = blocks.map(block => wholeLines(block).body);
    const earlier = at ? earlierLines(mes, tag, at.from) : null;
    const { strays, echoes } = splitEchoes(found, whole, earlier);
    const { bodies, echoes: repeated } = dropEchoed(whole, earlier);
    const emptied = bodies.map((body, i) => body !== whole[i] && !body.trim());
    return { blocks, bodies, emptied, strays, echoes, repeated };
}

// The part of a hidden comment's body that holds its blocks: up to its first section (<Changes-story>,
// -cut, -echo; hideBlock writes them after the blocks), so a kept body with an open tag in it (a Continue's
// block that held a second open tag) never reads the sections' lines as its own.
function commentBlocks(inner, tag) {
    const names = Object.values(sectionTags(tag)).map(escapeRe).join('|');
    const found = new RegExp(`\\n[ \\t]*<(?:${names})>[ \\t]*(?=\\n|$)`).exec(inner);
    return found ? inner.slice(0, found.index + 1) : inner;
}

// The blocks of `mes` that extractBlock reads, in order: with `at`, the bare ones a Continue added (the
// first one joined to the unfinished line it goes on with, `at.cut`); else every block outside reasoning,
// one kept in a hidden comment read back as it was before it was made comment-safe (commentText), with
// the display kinds its comment marks as off (`off`).
function readBlocks(mes, tag, at) {
    if (at) {
        const blocks = laterBlocks(mes, tag, at);
        if (at.tail && at.cut && blocks.length) blocks[0] = { ...blocks[0], body: `${at.cut}${blocks[0].body}` };
        return blocks;
    }
    // Each hidden comment's blocks are read inside it (a tag nested in a kept body never runs past the
    // comment's end into what follows), the bare blocks with the comments blanked; in order.
    const text = withoutReasoning(mes);
    const pairs = hiddenPairs(text);
    const out = [];
    for (const pair of pairs) {
        const off = commentParts(text, pair, tag).off;
        for (const block of findBlocks(commentBlocks(text.slice(pair.bodyStart, pair.bodyEnd), tag), tag)) {
            out.push({ ...block, start: block.start + pair.bodyStart, end: block.end + pair.bodyStart, body: commentText(block.body), off });
        }
    }
    out.push(...findBlocks(replacePairs(text, pairs, blank), tag));
    return out.sort((x, y) => x.start - y.start);
}

// A display line whose kind its comment marks as off (markOff): counted as a line, never read.
const OFF_LINE = '(read while its feature was off)';

/**
 * The text inside the reply's <Changes> block (or `tag`), or null when there is none. Found
 * whether the block is bare or already hidden in Story Suite's comment; several blocks are
 * read as one, in order, so no line is lost. Blocks inside closed reasoning are not read.
 * `at` ({ from, skip, tail?, cut? }, from continuation()): only the bare blocks a Continue added are read,
 * without their lines that repeat a line an earlier read of the reply took from the story (FB-1).
 * An open block's unfinished last line is left out (wholeLines); `stopped` is accepted and changes nothing.
 * `heads` (grammarHeads): change lines written in the story near the block (strayLines) are read
 * too, after the blocks, and count as a block when there is none.
 * `display` (extras.js displayLines): a line of a kind its hidden comment marks as off is not read.
 */
export function extractBlock(mes, tag = 'Changes', at = null, { stopped = false, heads = null, display = false } = {}) {
    const found = heads ? strayLines(mes, heads, { tag, from: at?.from ?? 0, tail: at?.tail === true, stopped }).taken : [];
    const { blocks, bodies: whole, emptied, strays } = readParts(mes, tag, at, found);
    if (!blocks.length && !strays.length) return null;
    // (A Continue's block that held only echoes of the reply's story lines is read as an empty one.)
    const bodies = blocks.map((block, i) => {
        const body = blockBody(whole[i]);
        if (!display || !block.off?.size) return body;
        return body.split('\n').map(line => {
            const parsed = line.trim() ? parseLine(line) : { error: 'blank' };
            return !parsed.error && block.off.has(parsed.kind) ? OFF_LINE : line;
        }).join('\n');
    }).filter((body, i) => !emptied[i] || i === blocks.length - 1);
    return inOrder(bodies, strays, blocks.at(-1)?.open === true).join('\n');
}

/**
 * `mes` without its <Changes> blocks (bare or hidden), for display and for the prompt history.
 * Whitespace left at the end is trimmed.
 */
export function stripBlock(mes, tag = 'Changes', { heads = null } = {}) {
    const given = String(mes ?? '');
    // `heads` (grammarHeads): the change lines written in the story near the block go too.
    const raw = heads ? dropLines(given, strayLines(given, heads, { tag }).taken) : given;
    // A hidden comment goes when it holds a block, or only the lines left in the story or a cut line.
    const ours = pair => {
        const body = raw.slice(pair.bodyStart, pair.bodyEnd);
        if (findBlocks(body, tag).length) return true;
        const parts = commentParts(raw, pair, tag);
        return parts.story.length > 0 || parts.cut !== null || body.includes(`<${sectionTags(tag).echo}>`)
            || parts.assist.length > 0 || parts.next.length > 0;
    };
    let text = replacePairs(raw, hiddenPairs(raw), pair => (ours(pair) ? '' : raw.slice(pair.start, pair.end)));
    const blocks = findBlocks(text, tag);
    for (const block of blocks.reverse()) text = text.slice(0, block.start) + text.slice(block.end);
    return trimEnd(text);
}

/**
 * `mes` with its bare <Changes> blocks moved into one hidden comment at the end, so
 * SillyTavern shows nothing of them and Re-read can still find them. Already hidden: unchanged.
 * `from`, `skip`, `tail`, `cut` (continuation()): only blocks that end after `from`, from the `skip`th bare
 * block on (a Continue's own text), are moved; the ones before are left as they are. A block left
 * open is kept with the word `open` after the marker, so a Continue can tell it goes on with it, and its
 * unfinished last line is kept beside it (<Changes-cut>). With `heads`, the change lines a capture left in
 * the story are listed in it (<Changes-story>), so a Re-read leaves them too.
 */
export function hideBlock(mes, tag = 'Changes', { from = 0, skip = 0, tail = false, cut = null, stopped = false, heads = null } = {}) {
    const given = String(mes ?? '');
    // `heads` (grammarHeads): the change lines written in the story near the block (strayLines) are
    // taken out of the story and kept after the blocks, in a block of their own.
    const found = heads ? strayLines(given, heads, { tag, from, tail, stopped }) : { taken: [], problems: [] };
    const left = found.problems.filter(item => item.keep).map(item => item.line);
    // Taking whole lines out after `from` leaves `from`, `skip` and `tail` true of the text.
    const text = dropLines(given, found.taken);
    // (Echoes are judged as extractBlock judges them: against this read's blocks and, for a Continue, the
    // reply's earlier reads, readParts.)
    const { blocks: bare, bodies: whole, emptied, strays, echoes, repeated } = readParts(text, tag, { from, skip, tail, cut }, found.taken);
    if (!bare.length && !found.taken.length && !left.length) return text;
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
    // The lines taken from the story are their own body, marked as the story's (`<tag story>`); a body that
    // held only echoes of an earlier read's story lines (readParts) is left out.
    const body = (text, mark = '') => `<${tag}${mark}>\n${commentSafe(lineEnds(text))}\n</${tag}>`;
    const kept = bare.map((block, i) => (emptied[i] ? null : body(blockBody(whole[i])))).filter(part => part !== null);
    const taken = strays.length ? [body(strays.map(line => line.line).join('\n'), ` ${STORY_WORD}`)] : [];
    const parts = open ? [...taken, ...kept] : [...kept, ...taken];
    const names = sectionTags(tag);
    if (left.length) parts.push(`<${names.story}>\n${commentSafe(left.join('\n'))}\n</${names.story}>`);
    const echoed = [...echoes.map(line => line.line), ...repeated];
    if (echoed.length) parts.push(`<${names.echo}>\n${commentSafe(echoed.join('\n'))}\n</${names.echo}>`);
    // The unfinished line, unless a tag sits in it (then no Continue can finish it as a line).
    const unfinished = open ? wholeLines(bare.at(-1)).cut : '';
    if (unfinished && !unfinished.includes('<')) parts.push(`<${names.cut}>\n${commentSafe(unfinished)}\n</${names.cut}>`);
    // A block left open (the reply was cut off in it) is said so, for a Continue (continuation()).
    const mark = open ? ` ${CUT_MARK}` : '';
    return `${trimEnd(story)}\n\n<!-- ${HIDDEN_MARKER}${mark}\n${parts.join('\n')}\n-->`;
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
        if (found) {
            const label = found[0].trim().toLowerCase();
            if (kind === 'dm' && Object.hasOwn(labels, label)) return { error: `DM_LABEL: duplicate label ${label}` };
            addLabel(labels, label, found[1]);
        }
        else if (kind === 'dm') return { error: 'DM_LABEL: unused trailing text needs a declared label' };
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
