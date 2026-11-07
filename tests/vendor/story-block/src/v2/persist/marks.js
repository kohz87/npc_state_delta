// Story Suite v2: swipe marks and payload text. A mark says which swipe a record was written for without
// trusting a numeric index alone; payload text is the reply up to its change block, used by replay evidence.

import { isObject } from './carrier.js';

// 32-bit FNV-1a, as 8 hex digits: enough to tell two swipes' openings apart (and two change lines).
export function hash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

const MARK_CHARS = 40;
// (trimmed at the end: hiding the change block puts a blank line before it)
const opening = message => String(message?.mes ?? '').split('<')[0].trimEnd();
/**
 * The text of the shown swipe a guarded block takes as its evidence payload: the reply as written, up to its
 * <Changes> block (or the hidden comment that holds it once it is read), without trailing space. Markup in the
 * prose (a status panel, reasoning tags) is part of it. It changes when the reply is edited or continued, which
 * is what makes a stored payload hash stale (store.js sourceAt, REPLAY.md). Cached per message by its text.
 */
export function payloadText(message) {
    const mes = String(message?.mes ?? '');
    const at = mes.search(/<Changes\b|<!--\s*STORY_SUITE_V2\b/i);
    return (at < 0 ? mes : mes.slice(0, at)).trimEnd();
}
const dateOf = value => {
    if (value === undefined || value === null || value === '') return '';
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
    return String(value);
};

// B-b2-timeline-r2-3: a new swipe being written still shows the swipe it was made from. SillyTavern's
// swipe() moves swipe_id past the swipes it has and leaves the old text and send_date until the reply
// is saved (saveReply sets them just before MESSAGE_RECEIVED, and the swipe's own slot after it).
// So while the shown swipe has no slot of its own and its text is another swipe's (or none), it has
// no text of its own to mark.
function borrowed(message) {
    const swipes = message?.swipes;
    const id = message?.swipe_id;
    if (!Array.isArray(swipes) || !Number.isInteger(id) || id < 0 || swipes[id] !== undefined) return false;
    const mes = String(message.mes ?? '');
    return !mes.trim() || swipes.some(text => text === mes);
}

/**
 * The shown swipe's mark, or null while its text has not started (a reply still being written, or a
 * new swipe still showing the old one's text, see `borrowed`):
 * `t` = "<hash>:<n>", the hash of the first n (at most 40) characters before any tag (a Continue only
 * adds after them, and the hidden change block comes after them), and `d` = its send_date ('' if none).
 */
export function swipeMark(message) {
    if (borrowed(message)) return null;
    const text = opening(message).slice(0, MARK_CHARS);
    if (!text.trim()) return null;
    return { t: `${hash(text)}:${text.length}`, d: dateOf(message?.send_date) };
}

// Each part of a stored mark against the shown swipe: true (agrees), false (differs), null (one side
// does not know it).
function markParts(mark, message) {
    const [h, n] = String(mark.t ?? '').split(':');
    const length = Number(n);
    const text = opening(message);
    const date = dateOf(message?.send_date);
    return {
        t: Number.isInteger(length) && length > 0 && text.length ? text.length >= length && hash(text.slice(0, length)) === h : null,
        d: typeof mark.d === 'string' && mark.d && date ? mark.d === date : null,
    };
}

/**
 * Does a stored mark fit the shown swipe? It does not only when both its text and its date are known on
 * both sides and both differ: a Continue changes the date, an edit the text, and neither makes the reply
 * another swipe. A record without a mark fits.
 */
export function markFits(mark, message) {
    if (!isObject(mark) || typeof mark.t !== 'string') return true;
    const { t, d } = markParts(mark, message);
    return !(t === false && d === false);
}

/** True when one part of a fitting mark no longer agrees (an edit, a Continue): write it again. */
export function markStale(record, message) {
    if (!isObject(record.mark) || typeof record.mark.t !== 'string' || !swipeMark(message)) return false;
    const { t, d } = markParts(record.mark, message);
    return t === false || d === false;
}
