// Story Suite v2: finding the hidden block in a reply (moved out of capture.js unchanged; capture.js re-exports the public names): the
// HTML comment a captured block is kept in, the paired-tag and comment scanners, blank-line trimming, `findBlocks` and `readBlocks`,
// the reasoning spans left out of a scan, an open block cut off by Continue, and the section tags. Imports only capture/lines.js.

import { escapeRe, KIND_WORD, MAX_LINE, NOTHING, parseLine, isSpace } from './lines.js';

// The HTML comment a captured block is kept in, so SillyTavern shows nothing of it and the
// prompt history can drop it (turn.js). `\b` keeps a longer marker from matching.
export const HIDDEN_MARKER = 'STORY_SUITE_V2';
// An open or a close tag. Attributes stay on the tag's own line and are short, so a tag cut off
// mid-way never reaches far ahead (and no tag costs more than its own few characters to read).
const tagRe = tag => new RegExp(`<(/?)${escapeRe(tag)}(?:[ \\t][^>\\n]{0,200})?[ \\t]*>`, 'gi');
// The hidden comment's open and its end, found apart (closedPairs): a lazy `<!--…[\s\S]*?-->` tried
// again from every unclosed open costs the square of the text (B-b5b-robust-r2-4).
const HIDDEN_OPEN = new RegExp(`<!--\\s*${HIDDEN_MARKER}\\b`, 'g');
export const HIDDEN_CLOSE = /-->/g;

/**
 * Every closed pair in `text` in one pass: an open (`openRe`, global), then the first close after it
 * (`closeRe`, global), then on from there. An open with no close after it ends the search, since no
 * later open has one either. → [{ start, end, bodyStart, bodyEnd }].
 */
export function closedPairs(text, openRe, closeRe) {
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
export function replacePairs(text, pairs, fn) {
    let out = '';
    let at = 0;
    for (const pair of pairs) {
        out += text.slice(at, pair.start) + fn(pair);
        at = pair.end;
    }
    return out + text.slice(at);
}

export const hiddenPairs = text => closedPairs(text, HIDDEN_OPEN, HIDDEN_CLOSE);
export const blank = pair => ' '.repeat(pair.end - pair.start);

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
export const commentSafe = text => String(text).replace(/\u2060/g, JOIN + JOIN).replace(/-(?=-)/g, `-${JOIN}`);
export const commentText = text => String(text).replace(/\u2060\u2060|(?<=-)\u2060(?=-)/g, found => (found.length === 2 ? JOIN : ''));

export const sectionTags = tag => ({ story: `${tag}-story`, cut: `${tag}-cut`, echo: `${tag}-echo`, assist: `${tag}-assist`, next: `${tag}-assist-next` });

// The parts of a hidden pair's body beside its blocks: { head: Set of header words, off: Set, story:
// lines, cut: line | null, echo: lines, assist: lines, next: lines }. `assist` and `next` are the Assist
// extractor's stored output (assistSections): the lines it read on this reply, and the ones it read here
// after the reader had sent, which the next reply applies.
export function commentParts(text, pair, tag = 'Changes') {
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

/**
 * `mes` with the header of each hidden comment from `from` on saying how many lines of a display kind a reply
 * could show when its lines were read (`cap:chatter=5`), for a kind whose cap is the reader's setting: the same
 * reply shows the same lines whatever the setting is later. `caps`: { [written word]: whole number }; a kind not
 * in it loses its mark (a Re-read marks every comment of the reply anew).
 */
export function markCaps(mes, caps, from = 0) {
    const text = String(mes ?? '');
    const list = Object.entries(caps ?? {}).filter(([word, n]) => KIND_WORD.test(String(word).toLowerCase()) && Number.isInteger(n) && n > 0).map(([word, n]) => `cap:${String(word).toLowerCase()}=${n}`).sort();
    const pairs = hiddenPairs(text).filter(pair => pair.start >= from);
    if (!pairs.length) return text;
    return replacePairs(text, pairs, pair => {
        const body = text.slice(pair.bodyStart, pair.bodyEnd);
        const nl = body.indexOf('\n');
        const words = (nl < 0 ? body : body.slice(0, nl)).trim().split(/\s+/).filter(word => word && !word.startsWith('cap:'));
        words.push(...list);
        return `${text.slice(pair.start, pair.bodyStart)}${words.map(word => ` ${word}`).join('')}${nl < 0 ? '' : body.slice(nl)}${text.slice(pair.bodyEnd, pair.end)}`;
    });
}

/** The caps a reply's hidden comments carry (markCaps): { [kind word]: n }, the largest where comments differ. */
export function capsOf(mes) {
    const text = String(mes ?? '');
    const out = {};
    for (const pair of hiddenPairs(text)) {
        for (const word of commentParts(text, pair).head) {
            const found = /^cap:([a-z][a-z0-9_-]*)=(\d{1,4})$/.exec(word);
            if (found && Number(found[2]) > 0) out[found[1]] = Math.max(out[found[1]] ?? 0, Number(found[2]));
        }
    }
    return out;
}
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
export const blockBody = body => dropBlankTail(dropBlankHead(body));

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
export function findBlocks(mes, tag, openAt = -1) {
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
export function wholeLines(block) {
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
export function reasoningPairs(text) {
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
export const maskReasoning = text => replacePairs(text, reasoningPairs(text), blank);

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
export const bareBlocks = (mes, tag, openAt = -1) => {
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
export const CUT_MARK = 'open';
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

// The part of a hidden comment's body that holds its blocks: up to its first section (<Changes-story>,
// -cut, -echo; hideBlock writes them after the blocks), so a kept body with an open tag in it (a Continue's
// block that held a second open tag) never reads the sections' lines as its own.
export function commentBlocks(inner, tag) {
    const names = Object.values(sectionTags(tag)).map(escapeRe).join('|');
    const found = new RegExp(`\\n[ \\t]*<(?:${names})>[ \\t]*(?=\\n|$)`).exec(inner);
    return found ? inner.slice(0, found.index + 1) : inner;
}

// The blocks of `mes` that extractBlock reads, in order: with `at`, the bare ones a Continue added (the
// first one joined to the unfinished line it goes on with, `at.cut`); else every block outside reasoning,
// one kept in a hidden comment read back as it was before it was made comment-safe (commentText), with
// the display kinds its comment marks as off (`off`).
export function readBlocks(mes, tag, at) {
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
