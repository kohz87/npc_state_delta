// Change lines (docs/v2/SPEC.md §4.4): the hidden <Changes> block a reply ends with, one proposal
// per line, `op kind Name[ — text][ | label: value]*`. Parsing is lenient because models drift
// (bullets, bold, code fences, either dash, a colon after the kind); a line that is not a change
// becomes a problem, never an exception. Each line is handed to the module that owns its kind
// (turn.js), which decides what it means. Pure: no DOM, no SillyTavern.

import { strayLines, inOrder, dropLines } from './capture/stray.js';
import { readParts, STORY_WORD } from './capture/echo.js';
import {
    blockBody, findBlocks, commentParts, sectionTags, replacePairs, hiddenPairs, reasoningPairs, blank,
    commentSafe, wholeLines, CUT_MARK, HIDDEN_MARKER,
} from './capture/blocks.js';
import { parseLine, trimEnd } from './capture/lines.js';
import { stripLegacy, LEGACY_MARK } from './capture/legacy.js';
export { OPS, MAX_LINE, lineBody, parseChanges, grammarHeads } from './capture/lines.js';
export { HIDDEN_MARKER, hasHidden, markOff, markCaps, capsOf, cutLine, withoutReasoning, defangMarker, continuation } from './capture/blocks.js';
export { assistSections, withAssist, sameChangeLine } from './capture/echo.js';
export { LEGACY_PROBLEM, hasLegacy, stripLegacy, adoptLegacy, legacyRead } from './capture/legacy.js';
export { STRAY_PARAGRAPHS, strayLines } from './capture/stray.js';


// Every function here is linear in the length of the reply: a looping model can write a run of
// thousands of spaces or blank lines, and the text is read again for every later prompt (turn.js).
// So there are no regexes that can retry from each place in a run (`\s+$`, `\n\s*$`, `\s*x|\s+y`);
// those spots are plain loops.

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
    // (A v1 envelope goes too: it is never shown or sent, adoptLegacy.)
    const given = stripLegacy(mes);
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
 * the story are listed in it (<Changes-story>), so a Re-read leaves them too. `legacy`: the block was read from a v1
 * envelope (adoptLegacy), which the comment says.
 */
export function hideBlock(mes, tag = 'Changes', { from = 0, skip = 0, tail = false, cut = null, stopped = false, heads = null, legacy = false } = {}) {
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
    // `legacy`: the block was read from a v1 envelope (adoptLegacy), said so a Re-read tells it again (legacyRead).
    const mark = `${open ? ` ${CUT_MARK}` : ''}${legacy && bare.length ? ` ${LEGACY_MARK}` : ''}`;
    return `${trimEnd(story)}\n\n<!-- ${HIDDEN_MARKER}${mark}\n${parts.join('\n')}\n-->`;
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
