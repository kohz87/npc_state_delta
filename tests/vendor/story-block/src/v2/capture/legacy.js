// Story Suite v2: the v1 envelope (moved out of capture.js unchanged; capture.js re-exports the public names): finding, reading,
// adopting and stripping the block the first version of Story Block wrote. Imports capture/lines.js, blocks.js and echo.js.

import { closedPairs, HIDDEN_CLOSE, readBlocks, replacePairs, blank, hiddenPairs, commentParts } from './blocks.js';
import { isSpace, MAX_LINE, parseLine } from './lines.js';
import { sameLine } from './echo.js';

// --- Story Block v1's envelope -----------------------------------------------------------------------
// v1 kept a reply's blocks in `<!-- STORY_BLOCKS_V1 … -->` (also STORY_BLOCKS_V1_CUT, and Inventory Block's
// INVENTORY_BLOCK_V05; src/envelope.js). v2 never writes one, but a card greeting or an old reply may hold one,
// and a model that sees it in the history copies it, change lines and all. So it is never sent to the model
// (stripBlock, and turn.js for the prompt), and a reply that wrote its changes only there has them read
// (adoptLegacy). `\b` keeps STORY_BLOCKS_V1_CONTEXT_* out; the cut marker is listed first so it wins.
const LEGACY_OPEN = /<!--\s*(?:STORY_BLOCKS_V1_CUT|STORY_BLOCKS_V1|INVENTORY_BLOCK_V05)\b/gi;
const HAS_LEGACY = /<!--\s*(?:STORY_BLOCKS_V1|INVENTORY_BLOCK_V05)/i;
/** The one Problem a reply that wrote its changes only in a v1 envelope gets. */
export const LEGACY_PROBLEM = 'The narrator wrote its changes in an old format; they were read anyway.';
// The word after the hidden comment's marker when its block was read from a v1 envelope, so a Re-read tells it again.
export const LEGACY_MARK = 'legacy';

// Every v1 envelope of `text`: closed ones, and one left open (the reply was cut off in it) to the end.
function legacyPairs(text) {
    const pairs = closedPairs(text, LEGACY_OPEN, HIDDEN_CLOSE);
    LEGACY_OPEN.lastIndex = pairs.length ? pairs.at(-1).end : 0;
    const open = LEGACY_OPEN.exec(text);
    if (open) pairs.push({ start: open.index, end: text.length, bodyStart: LEGACY_OPEN.lastIndex, bodyEnd: text.length, open: true });
    return pairs;
}

// `text` with each pair taken out with the whitespace before it (not before `from`), or put back as what `put(pair, i)` gives.
function cutPairs(text, pairs, from = 0, put = () => '') {
    let out = '';
    let at = 0;
    pairs.forEach((pair, i) => {
        let start = pair.start;
        while (start > Math.max(at, from) && isSpace(text[start - 1])) start -= 1;
        const kept = put(pair, i);
        out += text.slice(at, start) + (kept ? `${start > 0 ? '\n\n' : ''}${kept}` : '');
        at = pair.end;
    });
    return out + text.slice(at);
}

/** True when `mes` holds a v1 envelope. */
export function hasLegacy(mes) {
    return HAS_LEGACY.test(String(mes ?? '')) && legacyPairs(String(mes)).length > 0;
}

/** `mes` without its v1 envelopes (and the whitespace before each). Unchanged when it has none. */
export function stripLegacy(mes) {
    const text = String(mes ?? '');
    return HAS_LEGACY.test(text) ? cutPairs(text, legacyPairs(text)) : text;
}

/**
 * A reply's v1 envelopes, from `at.from` on (a Continue's own text), before it is read: when the reply has no block of
 * its own (bare or kept; with `at`, none the Continue added), the change lines in them become its block, in the place
 * of the first one, each once; otherwise they are taken out and never read. → { text, legacy }: legacy 'read' (lines
 * were taken), 'ignored' (envelopes taken out), or null (none; `text` is `mes`).
 */
export function adoptLegacy(mes, { tag = 'Changes', at = null } = {}) {
    const text = String(mes ?? '');
    if (!HAS_LEGACY.test(text)) return { text, legacy: null };
    const from = Math.max(0, Math.min(text.length, at?.from ?? 0));
    const pairs = legacyPairs(text).filter(pair => pair.start >= from);
    if (!pairs.length) return { text, legacy: null };
    const own = readBlocks(replacePairs(text, pairs, blank), tag, at).length > 0;
    const lines = new Map();
    if (!own) {
        for (const pair of pairs) {
            const body = text.slice(pair.bodyStart, pair.bodyEnd);
            // (An envelope left open may end in the middle of its last line: that one is left out.)
            const rows = body.split('\n').slice(0, pair.open && !body.endsWith('\n') ? -1 : undefined);
            for (const row of rows) {
                const line = row.trim();
                if (line && line.length <= MAX_LINE && !parseLine(line).error && !lines.has(sameLine(line))) lines.set(sameLine(line), line);
            }
        }
    }
    if (!lines.size) return { text: cutPairs(text, pairs, from), legacy: 'ignored' };
    const block = `<${tag}>\n${[...lines.values()].join('\n')}\n</${tag}>`;
    return { text: cutPairs(text, pairs, from, (_, i) => (i === 0 ? block : '')), legacy: 'read' };
}

/** True when a hidden comment of `mes` says its block was read from a v1 envelope (hideBlock's `legacy`). */
export function legacyRead(mes) {
    const text = String(mes ?? '');
    return hiddenPairs(text).some(pair => commentParts(text, pair).head.has(LEGACY_MARK));
}
