// Packs carried in a character card's lorebook (pure).
//
// A creator puts pack.json into a lorebook entry and tags the entry's title (SillyTavern's
// "Title/Memo", the entry's `comment`) with `[storysuite:pack]`. The entry should be disabled
// so SillyTavern never puts the JSON into a prompt; disabled entries are read all the same.
// The SillyTavern side (which book, loading it) is in st-adapter.js; this file only picks
// the tagged entries out of plain entry objects and unwraps their text.

export const PACK_TAG = '[storysuite:pack]';
const TAG = /\[\s*storysuite\s*:\s*pack\s*\]/i;

/** Is this title tagged as a pack? */
export const isPackTitle = title => TAG.test(String(title ?? ''));

/**
 * The pack JSON inside an entry's content: as is, or inside a ```json fence (creators often
 * paste it that way so the lorebook editor shows it readably).
 */
export function entryText(content) {
    const text = String(content ?? '').trim();
    const fenced = /^```[a-z]*\s*\n([\s\S]*?)\n?```\s*$/i.exec(text);
    return fenced ? fenced[1].trim() : text;
}

/**
 * The tagged entries of a list, in lorebook order:
 * entries `[{ book, uid, title, content }]` → `[{ origin, title, text }]`.
 * `origin` names where the pack came from (`lorebook:<book>#<uid>`), shown in the list.
 */
export function findPackEntries(entries) {
    const out = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
        if (!entry || !isPackTitle(entry.title)) continue;
        out.push({
            origin: `lorebook:${entry.book ?? ''}#${entry.uid ?? ''}`,
            title: String(entry.title).replace(TAG, '').trim(),
            text: entryText(entry.content),
        });
    }
    return out;
}

// ---------------------------------------------------------------------------------------
// Market lines (PACKS.md "Markets"): a lorebook entry about a place may say what kind of market it is
// with one plain line of its content,
//
//   market: town; coastal, port
//   market: village; river; buy 0.9, sell 0.85
//
// the settlement type, then its environment tags (comma separated, may be left out), then, optionally,
// the place's own buy and sell factors (0.25 to 4). The place is the entry's title (SillyTavern's
// "Title/Memo"), else its first key; its other keys are other names for it. Entries the line is not in
// are passed over; the entry stays an ordinary lorebook entry for the story. A line that does not read
// is passed over too. Code reads the line; the story's own words never set a price.

const MARKET_LINE = /^\s*market\s*:\s*(.+?)\s*$/im;
const WORD = /^[a-z][a-z0-9]*(?:-[a-z0-9]+){0,3}$/;
const FACTOR = { min: 0.25, max: 4 };
const MAX_TAGS = 8;
const oneLine = (text, max = 80) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max).trim();
const word = text => oneLine(text, 40).toLowerCase().replace(/\s+/g, '-');

/** `market: town; coastal, port; buy 1.1` → { type, tags, buy?, sell? }, or null when it does not read. */
export function readMarketLine(text) {
    const found = MARKET_LINE.exec(String(text ?? ''));
    if (!found) return null;
    const [typePart, tagPart = '', pricePart = ''] = found[1].split(';').map(part => part.trim());
    const type = word(typePart);
    if (!WORD.test(type)) return null;
    const tags = [...new Set(tagPart.split(',').map(word).filter(tag => WORD.test(tag)))].slice(0, MAX_TAGS);
    const out = { type, tags };
    for (const pair of pricePart.split(',')) {
        const at = /^\s*(buy|sell)\s*:?\s*(\d+(?:\.\d+)?)\s*$/i.exec(pair);
        const n = at ? Number(at[2]) : NaN;
        if (at && n >= FACTOR.min && n <= FACTOR.max) out[at[1].toLowerCase()] = n;
    }
    return out;
}

/**
 * The places lorebook entries give a market line for, in lorebook order, one per place (the first
 * entry naming it wins): entries `[{ book, uid, title, keys?, content }]` →
 * `[{ place, aliases, type, tags, buy?, sell?, origin }]`.
 */
export function marketEntries(entries) {
    const out = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
        if (!entry || isPackTitle(entry.title)) continue;
        const market = readMarketLine(entry.content);
        if (!market) continue;
        const keys = (Array.isArray(entry.keys) ? entry.keys : []).map(key => oneLine(key)).filter(Boolean);
        const place = oneLine(entry.title) || keys[0] || '';
        if (!place || out.some(other => other.place.toLowerCase() === place.toLowerCase())) continue;
        const aliases = [...new Set(keys.filter(key => key.toLowerCase() !== place.toLowerCase()))].slice(0, 12);
        out.push({ place, aliases, ...market, origin: `lorebook:${entry.book ?? ''}#${entry.uid ?? ''}` });
    }
    return out;
}
