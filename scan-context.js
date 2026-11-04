/* NPC State Delta: pure scan/backfill eligibility helpers. */

export const AUTOMATIC_BACKFILL_QUEUE_VERSION = 1;
export const AUTOMATIC_MISSED_PARTICIPANT_REPAIR_LIMIT = 1;
export const AUTOMATIC_BACKFILL_REASONS = Object.freeze(['missed-participant', 'new-admission']);
// With Story Suite's "Scan after every reply" switched off the automatic scan runs this often at the most.
export const AUTO_SCAN_EVERY_WITHOUT_EVERY_REPLY = 3;

/**
 * Whether the automatic scan is due after this reply. `sinceScan` counts the replies since the last scan, `scanEvery` is
 * the reader's "Scan every" setting, `full` is "Full scan every turn". `everyReply` is the "Scan after every reply"
 * switch (true when no Story Suite is present): off, a scan waits for three replies, or for "Scan every" when that is
 * larger, and "Full scan every turn" then makes that scan a full one instead of making every reply scan.
 */
export function autoScanDue({ autoScan, full, sinceScan, scanEvery, everyReply = true, replyChanges = false, catchUp = false } = {}) {
    if (!autoScan) return false;
    // The last scan could not read every waiting reply: the next reply scans at once, whatever the cadence, until caught up.
    if (catchUp) return true;
    // `replyChanges`: the cheap local check found a name or an NPC State line in the reply. A quiet reply waits for
    // the safety scan (every `scanEvery` replies); "Scan every" 1 therefore still scans every reply.
    if (everyReply !== false) return Boolean(full) || Boolean(replyChanges) || sinceScan >= scanEvery;
    // Off, only the cadence applies (no earlier than 1.7.4); the scan then reads every reply since the last one.
    return sinceScan >= Math.max(AUTO_SCAN_EVERY_WITHOUT_EVERY_REPLY, Number(scanEvery) || 1);
}

const NAME_STOP = new Set(['i', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'god', 'ok', 'okay', 'the', 'and', 'but', 'she', 'her', 'his', 'they', 'then', 'this', 'that', 'there', 'with', 'when', 'what', 'where', 'who', 'why', 'how', 'you', 'your', 'not', 'for', 'its', 'one', 'he', 'it', 'we', 'after', 'before', 'as', 'at', 'by', 'from', 'in', 'on', 'of', 'to', 'up', 'down', 'out', 'over', 'under', 'into', 'through', 'around', 'behind', 'beyond', 'while', 'if', 'though', 'although', 'because', 'since', 'until', 'so', 'yet', 'now', 'soon', 'later', 'again', 'still', 'just', 'only', 'even', 'perhaps', 'maybe', 'suddenly', 'slowly', 'quickly', 'finally', 'some', 'every', 'each', 'all', 'no', 'yes', 'nothing', 'something', 'everyone', 'someone', 'nobody', 'here', 'there', 'these', 'those', 'their', 'our', 'my', 'me', 'him', 'them', 'us', 'do', 'did', 'does', 'is', 'was', 'are', 'were', 'be', 'can', 'could', 'would', 'should', 'will', 'have', 'had', 'has', 'let', 'look', 'listen', 'well', 'oh', 'ah', 'hey', 'please', 'thank', 'thanks', 'sorry', 'good', 'morning', 'night', 'day', 'outside', 'inside', 'nearby', 'meanwhile', 'once', 'then', 'both', 'another', 'other', 'more', 'most', 'many', 'few', 'two', 'three', 'first', 'second', 'last', 'next', 'what', 'which', 'whose', 'whom', 'an', 'am', 'or', 'go', 'hi', 'us', 'if', 'oh', 'so', 'my']);
// Words that are also given names: a sentence-opening one followed by a person verb ("Will smiled") is a name.
const AMBIGUOUS_NAMES = new Set(['will', 'may', 'june', 'april', 'august', 'march', 'mark', 'rose', 'bill', 'grace', 'hope', 'faith', 'joy', 'pearl', 'ruby', 'dawn', 'summer', 'amber', 'iris', 'lily', 'holly', 'ivy', 'sue', 'pat', 'art', 'bob', 'jack', 'sage', 'river', 'storm']);
const PERSON_VERB = /^[ \t]+(?:said|says|asked|asks|replied|replies|nodded|nods|smiled|smiles|sighed|sighs|laughed|laughs|grinned|grins|frowned|frowns|shrugged|shrugs|whispered|whispers|muttered|mutters|stepped|steps|turned|turns|stood|stands|sat|sits|walked|walks|looked|looks|spoke|speaks|waved|waves|bowed|bows|shook|shakes|paused|pauses|hesitated|hesitates|glanced|glances|gasped|gasps|cried|cries|snorted|snorts|chuckled|chuckles)\b/iu;
// Scripts without capital letters: a name is told by what introduces or follows it, since the words are not spaced.
const CJK_ANY = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_NAME = [
    /[\p{Script=Katakana}\u30fc]{2,}/gu,
    /[\p{Script=Han}]{1,4}(?=さん|ちゃん|くん|君|様|氏|殿|先生|という|と言う|と申|と呼|の名は)/gu,
    /(?:名叫|名为|名字是|名字叫|叫做|叫|姓)[\p{Script=Han}]{1,4}/gu,
    /[\p{Script=Han}]{1,3}(?=先生|小姐|女士|大人|殿下|姑娘|公子)/gu,
    /[\p{Script=Hangul}]{2,4}(?=씨|님|이라는|라는|이라고|라고)/gu,
];
// Other uncased scripts (Arabic, Hebrew, Indic, Thai ...): no cheap name test, so any such text is looked at.
const OTHER_UNCASED = /(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Thai}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Georgian}\p{Script=Armenian}\p{Script=Ethiopic}\p{Script=Khmer}\p{Script=Lao}\p{Script=Myanmar}\p{Script=Gujarati}\p{Script=Gurmukhi}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}]/u;
const CAP_WORD = /\p{Lu}[\p{L}\p{M}'\u2019-]*/gu;

/**
 * A cheap local check, no model call: may this reply change a dossier? It scans when the reply names a tracked NPC (by name or
 * alias), carries an NPC State line or names someone new. A capitalised word counts as a new name when it is not the first
 * word of a sentence (or is followed by another capitalised word) and no roster name, alias or `ignore` name (the player, the
 * character) contains it; names of two letters count; a common word that is also a given name counts before a person verb
 * ("Will smiled"); a name-like word of a script without capitals (CJK by what introduces it, other scripts by their
 * presence) counts too. A reply that only continues with a pronoun ("She sighs") is quiet here: the next scan reads every
 * reply since the last one, so nothing is lost, only the call is saved.
 */
export function replyMayChangeDossiers({ texts = [], roster = [], ignore = [] } = {}) {
    const source = (Array.isArray(texts) ? texts : [texts]).map(item => (typeof item === 'string' ? item : '')).filter(Boolean).join('\n');
    if (!text(source)) return false;
    if (/\bNPC State\b/i.test(source)) return true;
    const people = Array.isArray(roster) ? roster : [];
    if (people.some(npc => npc && typeof npc === 'object' && npcParticipatesInExchange(npc, people, source))) return true;
    const labels = [];
    const known = new Set(NAME_STOP);
    for (const label of [...ignore, ...people.flatMap(npc => [npc?.name, ...(npc?.aliases || [])])]) {
        const folded = norm(label);
        if (folded) labels.push(folded);
        for (const word of folded.split(' ')) if (word) known.add(word);
    }
    const prose = participationText(source);
    if (CJK_ANY.test(prose)) {
        // Words are not spaced: a tracked name is found inside the text, a new one by its introducer or honorific.
        const flat = prose.normalize('NFKC');
        if (labels.some(label => CJK_ANY.test(label) && flat.includes(label.replace(/ /g, '')))) return true;
        for (const pattern of CJK_NAME) {
            for (const match of flat.matchAll(pattern)) {
                const word = match[0].replace(/^(?:名叫|名为|名字是|名字叫|叫做|叫|姓)/u, '');
                if (word && !labels.some(label => label.replace(/ /g, '').includes(word))) return true;
            }
        }
    }
    if (OTHER_UNCASED.test(prose)) return true;
    for (const match of prose.matchAll(CAP_WORD)) {
        const word = norm(match[0]);
        if (word.length < 2) continue;
        const after = prose.slice(match.index + match[0].length);
        const before = prose.slice(0, match.index).replace(/[\s*_"'\u201c\u201d\u2018\u2019\u00ab(\[]+$/u, '');
        const initial = !before || /[.!?\u2026:\n\u2014>]$/u.test(before);
        if (known.has(word)) {
            // "Will smiled": a given name that is also a common word, opening a sentence before a person verb.
            if (AMBIGUOUS_NAMES.has(word) && initial && PERSON_VERB.test(after) && !labels.some(label => label.split(' ').includes(word))) return true;
            continue;
        }
        if (!initial) return true;
        // A sentence's first word is a name unless the same word also shows up in lower case in the text.
        if (!new RegExp(`(?:^|[^\\p{L}])${match[0].toLowerCase()}(?![\\p{L}])`, 'u').test(prose)) return true;
        const next = after.match(/^[ \t]+(\p{Lu}[\p{L}\p{M}'\u2019-]*)/u);
        if (next && !known.has(norm(next[1])) && norm(next[1]).length >= 2) return true;
    }
    return false;
}

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}
function norm(value) {
    return text(value).normalize('NFKC').toLocaleLowerCase().replace(/<[^>]*>/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}
function hasPhrase(source, phrase) {
    const haystack = norm(source);
    const needle = norm(phrase);
    return Boolean(haystack && needle && ` ${haystack} `.includes(` ${needle} `));
}

function participationText(value) {
    let source = String(value || '');
    source = source
        .replace(/<Blocks\b[^>]*>[\s\S]*?<\/Blocks\s*>/gi, ' ')
        .replace(/<Blocks\b[^>]*>[\s\S]*$/gi, ' ')
        .replace(/<World_State\b[^>]*>[\s\S]*?<\/World_State\s*>/gi, ' ')
        .replace(/<NPC_Inner_Chatter\b[^>]*>[\s\S]*?<\/NPC_Inner_Chatter\s*>/gi, ' ')
        .replace(/<details\b[^>]*>([\s\S]*?)<\/details>/gi, (whole, inner) => {
            const summary = String(inner || '').match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i)?.[1] || '';
            const label = String(summary).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            return /\b(?:world\s*state|npc\s*inner\s*chatter)\b/i.test(label) ? ' ' : whole;
        });
    return source.split(/\r?\n/).map(line => {
        const marker = line.search(/\b(?:World State|NPC Inner Chatter)\s*:/i);
        return marker >= 0 ? line.slice(0, marker) : line;
    }).join('\n');
}
function uniqueFirstNames(roster) {
    const counts = new Map();
    for (const npc of roster || []) {
        for (const label of [npc?.name, ...(npc?.aliases || [])].filter(Boolean)) {
            const first = norm(label).split(' ')[0] || '';
            if (first.length >= 3) counts.set(first, (counts.get(first) || 0) + 1);
        }
    }
    return new Set([...counts].filter(([, count]) => count === 1).map(([name]) => name));
}

/** Return true only when the current exchange explicitly involves this NPC. */
export function npcParticipatesInExchange(target, roster = [], currentExchange = '', { includeRole = true } = {}) {
    const narrative = participationText(currentExchange);
    if (!target || typeof target !== 'object' || !text(narrative)) return false;
    const source = Array.isArray(roster) ? roster : [];
    const uniqueFirst = uniqueFirstNames(source);
    const labels = new Set();
    const canonical = norm(target.name);
    if (canonical) {
        labels.add(canonical);
        const first = canonical.split(' ')[0] || '';
        if (uniqueFirst.has(first)) labels.add(first);
    }
    for (const raw of target.aliases || []) {
        const alias = norm(raw);
        if (alias) labels.add(alias);
    }
    const role = norm(target.role);
    if (includeRole && role.length >= 5) labels.add(role);
    return [...labels].some(label => hasPhrase(narrative, label));
}

/**
 * A queued backfill is meaningful only while its target is still an active
 * member of the owning chat roster. Automatic backfill relevance is checked
 * by the caller so manual repair remains available even when the NPC is not
 * in the newest exchange.
 */
export function backfillNeedsRequest(target, roster = []) {
    if (!target || typeof target !== 'object' || target.archived === true) return false;
    const source = Array.isArray(roster) ? roster : [];
    const id = text(target.id);
    if (id) return source.some(item => text(item?.id) === id && item?.archived !== true);
    return source.includes(target);
}

export function normalizeAutomaticBackfillRequest(raw = {}) {
    if (!raw || typeof raw !== 'object') return null;
    if (Number(raw.queueVersion) !== AUTOMATIC_BACKFILL_QUEUE_VERSION) return null;
    const reason = text(raw.reason);
    if (!AUTOMATIC_BACKFILL_REASONS.includes(reason)) return null;
    const npcId = text(raw.npcId).slice(0, 100);
    const label = text(raw.label).slice(0, 120);
    if (!npcId || !label) return null;
    return {
        queueVersion: AUTOMATIC_BACKFILL_QUEUE_VERSION,
        reason,
        npcId,
        label,
        requestedMessageId: Number.isInteger(raw.requestedMessageId) ? raw.requestedMessageId : null,
        preserveLiveState: raw.preserveLiveState === true,
        silent: raw.silent === true,
        requestedAt: Math.max(0, Number(raw.requestedAt || 0) || 0),
        attempts: Math.max(0, Math.round(Number(raw.attempts) || 0)),
        lastAttemptAt: Math.max(0, Number(raw.lastAttemptAt || 0) || 0),
    };
}

export function automaticBackfillStillRelevant(request, target, roster = [], owningExchange = '') {
    const normalized = normalizeAutomaticBackfillRequest(request);
    if (!normalized || !backfillNeedsRequest(target, roster)) return false;
    if (normalized.reason === 'new-admission') return true;
    if (normalized.reason === 'missed-participant') {
        return npcParticipatesInExchange(target, roster, owningExchange, { includeRole: false });
    }
    return false;
}

/** The most "read ahead" replies a chat keeps; past it the oldest are forgotten (the marker then passes the oldest unread replies instead: a reply is never read twice). */
export const READ_AHEAD_MAX = 40;

/** The ids of the replies a scan already read that the marker has not passed yet (`state.readAhead`), cleaned: integers, ascending, unique. */
export function readAheadOf(state) {
    const list = Array.isArray(state?.readAhead) ? state.readAhead : [];
    return [...new Set(list.filter(id => Number.isInteger(id) && id >= 0))].sort((a, b) => a - b);
}

/** Whether the scan has already read reply `id`: the marker is at or past it, or it was read ahead. */
export function replyScanned(state, id) {
    return Number.isInteger(id) && (state?.lastScannedMessageId === id || readAheadOf(state).includes(id));
}

/**
 * Where a finished scan leaves the marker (`lastScannedMessageId`) and the replies read ahead, so every reply is read exactly once.
 *   marker      the chat's marker before the scan (a number, or null)
 *   readAhead   the replies read ahead before the scan
 *   readIds     the replies this scan read (a window's replies, the reply of a capture, the replies of a manual scan's recent text)
 *   target      where the scan would put the marker (the newest reply it was for)
 *   replyIds    every reply of the chat the story stands on, ascending
 *   fresh       the chat was never scanned (it reads from the start)
 * The marker moves to `target` only when no reply before it is still unread; otherwise it stays, and the replies this scan read are
 * remembered, so the next window skips exactly those. Whatever follows the marker and was read ahead is taken in. With no marker to keep
 * track against (not a new chat) it moves to `target` as before. → { marker, readAhead, deferred, waiting }.
 */
export function settleScan({ marker = null, readAhead = [], readIds = [], target, replyIds = [], fresh = false } = {}) {
    const base = Number.isInteger(marker) ? marker : (fresh ? -1 : null);
    if (base === null || !Number.isInteger(target)) return { marker: target, readAhead: [], deferred: false, waiting: 0 };
    const read = new Set([...readAheadOf({ readAhead }), ...(Array.isArray(readIds) ? readIds : []).filter(Number.isInteger)]);
    const replies = (Array.isArray(replyIds) ? replyIds : []).filter(id => id > base);
    const unread = replies.some(id => id <= target && !read.has(id));
    let next = unread ? base : Math.max(base, target);
    if (!unread) {
        // Take in the replies read ahead that now follow the marker without a gap.
        for (const id of replies) {
            if (id <= next) continue;
            if (!read.has(id)) break;
            next = id;
        }
    }
    let rest = [...read].filter(id => id > next).sort((a, b) => a - b);
    // Too many read ahead (a chat of captures with something old never read): the marker passes the oldest unread replies, as it did before.
    while (rest.length > READ_AHEAD_MAX) { next = rest.shift(); rest = rest.filter(id => id > next); }
    // `deferred`: the marker stayed behind replies that are still unread; `waiting`: how many (the cadence counts them, so the safety scan still comes).
    const waiting = unread ? replies.filter(id => id > next && !read.has(id)).length : 0;
    return { marker: next, readAhead: rest.slice(-READ_AHEAD_MAX), deferred: unread, waiting };
}
