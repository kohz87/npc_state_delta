// Story Suite v2: the assist sections and the echoed change lines (moved out of capture.js unchanged; capture.js re-exports the public
// names): `<Changes-assist>` sections and `withAssist`, a line a reply repeats from an earlier block, and `readParts`, which joins the
// block, the whole lines and the echoes. Imports capture/lines.js and capture/blocks.js.

import { cutAt } from '../../text.js';
import {
    withoutReasoning, hiddenPairs, commentParts, sectionTags, HIDDEN_MARKER, commentSafe, findBlocks,
    commentBlocks, commentText, readBlocks, wholeLines,
} from './blocks.js';
import { MAX_LINE, trimEnd, stripDecoration, stripMarkdown, escapeRe } from './lines.js';

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
export const sameLine = line => stripDecoration(stripMarkdown(line).trim()).trim().replace(/\s+/g, ' ');
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
export const STORY_WORD = 'story';
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
export function readParts(mes, tag, at, found) {
    const blocks = readBlocks(mes, tag, at);
    const whole = blocks.map(block => wholeLines(block).body);
    const earlier = at ? earlierLines(mes, tag, at.from) : null;
    const { strays, echoes } = splitEchoes(found, whole, earlier);
    const { bodies, echoes: repeated } = dropEchoed(whole, earlier);
    const emptied = bodies.map((body, i) => body !== whole[i] && !body.trim());
    return { blocks, bodies, emptied, strays, echoes, repeated };
}
