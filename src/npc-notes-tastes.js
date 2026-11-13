// NPC notes, tastes: the `taste` line's record (one JSON text leaf per NPC, bounded), the fixed rule (first mention wins; a change
// needs why:), the deterministic mirror check (a taste that echoes the user's last message is kept and marked, never refused) and the
// wording of the Problem, the next-reply cue and the optional tail line. Pure; never imports npc-meters.js.
import { clean, slug } from './npc-meters-config.js';
import { stripMessageCitations } from '../core-text.js';

export const TASTE_LIMITS = Object.freeze({ likes: 6, dislikes: 4, item: 60, from: 240, why: 120, text: 12000, reply: 80 });
export const TASTE_RULE = 1;
const LIKE = '+';
const DISLIKE = '-';
const STOP_WORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'i', 'in', 'is', 'it', 'its', 'my', 'of', 'on', 'or',
    'our', 'she', 'he', 'they', 'the', 'their', 'this', 'that', 'to', 'was', 'we', 'were', 'with', 'you', 'your', 'his', 'her',
]);

// A taste's words never carry the scanner's message citations ("[m2]"). New words are written clean (addTaste) and every display
// read is clean (readTastes), but the stored leaf is never reshaped: the write path reads with { cite: false }, which keeps each old
// row exactly as stored, so a leaf valid before stays valid (tastesOk) and replay and Re-read keep old rows byte-identical.
const tidy = (value, max) => clean(stripMessageCitations(clean(value, Infinity)), max);
// Cut only newly written or displayed words. An unbroken word longer than the limit contributes no fragment.
export function tasteWords(value, max) {
    const chars = [...tidy(value, Infinity)];
    if (chars.length <= max) return chars.join('');
    const head = chars.slice(0, max - 1).join('');
    return `${(/\s/u.test(chars[max - 1]) ? head : head.replace(/\S+$/u, '')).trimEnd()}…`;
}
const isSign = sign => sign === LIKE || sign === DISLIKE;
const verb = sign => (sign === LIKE ? 'likes' : 'dislikes');
const noun = sign => (sign === LIKE ? 'liking' : 'dislike');
const limitOf = sign => (sign === LIKE ? TASTE_LIMITS.likes : TASTE_LIMITS.dislikes);
const wholeDay = day => (Number.isInteger(Number(day)) && Number(day) >= 0 ? Number(day) : 0);
const replyTag = r => (typeof r === 'string' || typeof r === 'number' ? clean(r, TASTE_LIMITS.reply) || null : null);

/** A taste's identity: its words joined by "-", so "Burnt  Sugar" and "burnt sugar" are one taste. '' when nothing is left. */
export const tasteKey = item => slug(clean(item, TASTE_LIMITS.item), TASTE_LIMITS.item);

/** Lowercase letter and number words of a text, stop words dropped. Unicode letters count, so Cyrillic and Greek words match too. */
export function contentWords(text) {
    return (clean(text, Infinity).normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
        .filter(word => !STOP_WORDS.has(word));
}

// One stored row, or null when it is not a valid taste.
function readRow(entry, cite) {
    const words = cite ? tasteWords : clean;
    if (!entry || typeof entry !== 'object' || !isSign(entry.sign)) return null;
    const item = words(entry.item, TASTE_LIMITS.item);
    if (!tasteKey(item)) return null;
    const day = Number(entry.day);
    if (!Number.isInteger(day) || day < 0) return null;
    const row = { sign: entry.sign, item };
    const from = words(entry.from, TASTE_LIMITS.from);
    if (from) row.from = from;
    row.day = day;
    row.r = replyTag(entry.r);
    if (entry.mirrored === true) row.mirrored = true;
    if (entry.rule === TASTE_RULE) row.rule = TASTE_RULE;
    return row;
}

// Keeps the newest rows of each sign, in their original order.
function capped(rows) {
    const counts = { [LIKE]: 0, [DISLIKE]: 0 };
    const kept = [];
    for (let i = rows.length - 1; i >= 0; i -= 1) {
        const row = rows[i];
        if (counts[row.sign] < limitOf(row.sign)) {
            counts[row.sign] += 1;
            kept.push(row);
        }
    }
    return kept.reverse();
}

/**
 * The NPC's tastes from a JSON text leaf or an array: valid rows only, first mention of an item wins, caps kept newest-first.
 * Default: citations stripped (display). { cite: false }: words exactly as stored (validity check and the write path).
 */
export function readTastes(raw, { cite = true } = {}) {
    let list = raw;
    if (typeof raw === 'string') {
        if (raw.length > TASTE_LIMITS.text) return [];
        try {
            list = JSON.parse(raw);
        } catch {
            return [];
        }
    }
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const rows = [];
    for (const entry of list) {
        const row = readRow(entry, cite);
        const key = row && tasteKey(row.item);
        if (!row || seen.has(key)) continue;
        seen.add(key);
        rows.push(row);
    }
    return capped(rows);
}

/** The leaf text for a list of tastes (what readTastes reads back; stored rows are kept as they are, see readTastes). */
export function tastesText(list) {
    return JSON.stringify(readTastes(list, { cite: false }));
}

// Rule marks: rows mark writes; receipts also mark no-op lines, so a Re-read of a duplicate uses the same item rule.
export function tasteRuleFor(standing, key, reply, item, receipts = []) {
    if (!standing) return TASTE_RULE;
    const raw = tidy(item, Infinity);
    const keys = [tasteKey(clean(raw, TASTE_LIMITS.item)), tasteKey(tasteWords(raw, TASTE_LIMITS.item))];
    if (Array.isArray(receipts) && receipts.some(receipt => receipt?.type === 'capture.taste' && receipt.data?.key === key
        && receipt.data?.tasteRule === TASTE_RULE && receipt.data?.tasteItem === keys[1])) return TASTE_RULE;
    const rows = readTastes(standing.domains?.npc?.npcs?.[key]?.tastes, { cite: false });
    return rows.some(row => row.r === reply && row.rule === TASTE_RULE && keys.includes(tasteKey(tidy(row.item, Infinity)))) ? TASTE_RULE : 0;
}

export const markTasteResult = (result, item, rule) => rule === TASTE_RULE
    ? { ...result, data: { ...result.data, tasteRule: TASTE_RULE, tasteItem: tasteKey(tasteWords(item, TASTE_LIMITS.item)) } } : result;

/**
 * The deterministic echo check. True when the taste's words (at least half of them) appear in the user's last message, the taste
 * has no why: or from:, and no earlier taste shares a word with it (so an area she already had is not "new"). Never blocks.
 */
export function mirrorCheck({ userText = '', item = '', from = '', why = '', existing = [] } = {}) {
    const words = [...new Set(contentWords(item))];
    const none = { mirrored: false, matched: 0, total: words.length };
    if (!words.length || clean(from, TASTE_LIMITS.from) || clean(why, TASTE_LIMITS.why)) return none;
    const heard = new Set(contentWords(userText));
    if (!heard.size) return none;
    const area = readTastes(existing).some(row => contentWords(row.item).some(word => words.includes(word)));
    if (area) return none;
    const matched = words.filter(word => heard.has(word)).length;
    return { mirrored: matched * 2 >= words.length, matched, total: words.length };
}

/** The Problem and the one-reply cue for a mirrored taste. Names and items are shown as text; {{user}} is the host's macro. */
export function mirrorWording(name, sign, item) {
    const who = clean(name, 60) || 'The NPC';
    const said = `${who}'s ${noun(sign)} for ${clean(item, TASTE_LIMITS.item)} echoes {{user}}'s words`;
    return {
        problem: `${said}; kept and marked.`,
        cue: `${said}; keep ${who}'s own taste unless the story gives a reason.`,
    };
}

const outcome = (tastes, status, problem = '', cue = '', entry = null) => ({ tastes, status, problem, cue, entry });

/**
 * Captures one taste line. Statuses: 'added' (new item), 'changed' (the opposite sign, allowed only with why:), 'same' (already
 * there, a no-op), 'refused' (no item or sign, or an opposite sign without why:; the list is unchanged and problem says why).
 * A mirrored taste is still stored (mirrored: true) with its problem and cue. The entry keeps its reply tag r, so a re-read replaces it.
 */
export function addTaste(current, { name = '', sign, item, from = '', why = '', day = 0, r = null, userText = '', rule = TASTE_RULE } = {}) {
    const list = readTastes(current, { cite: false });
    const words = rule === TASTE_RULE ? tasteWords : tidy;
    const text = words(item, TASTE_LIMITS.item);
    const key = tasteKey(text);
    const who = clean(name, 60) || 'The NPC';
    if (!isSign(sign) || !key) return outcome(list, 'refused', 'A taste line needs a likes: or dislikes: item.');
    const oldKey = tasteKey(tidy(item, TASTE_LIMITS.item));
    const same = list.find(row => [key, oldKey].includes(tasteKey(tidy(row.item, TASTE_LIMITS.item))));
    if (same?.sign === sign) return outcome(list, 'same');
    if (same && !clean(why, TASTE_LIMITS.why)) {
        return outcome(list, 'refused', `${who} already ${verb(same.sign)} ${tidy(same.item, TASTE_LIMITS.item)}; a change needs a why: reason.`);
    }
    const fromText = words(from, rule === TASTE_RULE ? TASTE_LIMITS.from : 60); // old rule: the original 60 cut
    const mirror = mirrorCheck({ userText, item: text, from: fromText, why, existing: list });
    const entry = {
        sign,
        item: text,
        ...(fromText ? { from: fromText } : {}),
        day: wholeDay(day),
        r: replyTag(r),
        ...(mirror.mirrored ? { mirrored: true } : {}),
        ...(rule === TASTE_RULE ? { rule: TASTE_RULE } : {}),
    };
    const tastes = capped([...list.filter(row => row !== same), entry]);
    const status = same ? 'changed' : 'added';
    if (!mirror.mirrored) return outcome(tastes, status, '', '', entry);
    const wording = mirrorWording(who, sign, text);
    return outcome(tastes, status, wording.problem, wording.cue, entry);
}

/**
 * A Refresh's tastes (rows { sign, item, from }) merged into the stored list like `~ taste` lines: same caps and dedupe, first mention
 * wins. A taste already there (either sign) is kept as it is, and a sign whose list is full takes nothing more, so a narrator's or the
 * player's taste is never changed or pushed out. → { text, added } (`added`: how many rows were new; `text` is the whole new leaf).
 */
export function mergeRefreshTastes(current, rows, { name = '', day = 0, r = null } = {}) {
    let list = readTastes(current, { cite: false });
    let added = 0;
    for (const row of (Array.isArray(rows) ? rows : []).slice(0, TASTE_LIMITS.likes + TASTE_LIMITS.dislikes)) {
        const sign = row?.sign === 'like' ? LIKE : (row?.sign === 'dislike' ? DISLIKE : row?.sign);
        if (!isSign(sign) || list.filter(item => item.sign === sign).length >= limitOf(sign)) continue;
        const out = addTaste(list, { name, sign, item: row.item, from: row.from, day, r });
        if (out.status !== 'added') continue;
        list = out.tastes;
        added += 1;
    }
    return { text: tastesText(list), added };
}

/** The optional tail line for a present NPC: the newest like and the newest dislike, mirrored ones left out. '' when none. */
export function tasteTail(name, tastes) {
    const list = readTastes(tastes).filter(row => !row.mirrored);
    const newest = sign => [...list].reverse().find(row => row.sign === sign);
    const like = newest(LIKE);
    const dislike = newest(DISLIKE);
    const parts = [like && `likes ${like.item}`, dislike && `dislikes ${dislike.item}`].filter(Boolean);
    if (!parts.length) return '';
    return `${clean(name, 60) || 'The NPC'} ${parts.join('; ')}.`;
}
