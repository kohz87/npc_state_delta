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
