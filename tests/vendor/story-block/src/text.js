// Small text helpers shared by the parsers, the schema and the displays (pure).

/**
 * `text` cut to at most `max` UTF-16 units without cutting a character in half: a surrogate pair
 * (an emoji, a rare letter) that would straddle the cut goes whole or not at all (B-b5b-robust-r2-6).
 */
export function cutAt(text, max) {
    const value = String(text ?? '');
    if (!(max >= 0) || value.length <= max) return value;
    const code = value.charCodeAt(max - 1);
    return value.slice(0, code >= 0xD800 && code <= 0xDBFF ? max - 1 : max);
}

/** One line: runs of whitespace (newlines included) as one space, trimmed; cut at `max` if given. */
export function oneLine(value, max) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return max === undefined ? text : cutAt(text, max);
}

/** A comparison key: NFKC-normalized, trimmed, lower case ("Ｐotion " and "potion" match). */
export const foldKey = value => String(value ?? '').normalize('NFKC').trim().toLowerCase();

/** How many whitespace-separated words a text has. */
export const countWords = text => String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
