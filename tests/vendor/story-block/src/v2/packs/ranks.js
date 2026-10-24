// The reader's rank ladder (MODULES §F86, §F91, §F105; PACKS.md "Ranks"): the names a world gives its
// ranks, lowest first, one per line ("Soul Class I" … "Soul Class IX", or "F", "E" … "SSS"). Pure.
//
// The lines are a module's setting (RPG Battle's Terms: Rank ladder and Levels per rank; levels are what
// a ladder bands, so it lives with the levels), handed to Story Block by that module's `ranks.reader`
// hook. Story Block's `packs.content({ kind: 'ranks' })` answers with this ladder instead of the packs',
// so Story Director's quest ranks, RPG Battle's party and foe ranks and Story Block's own coin budget
// all follow it. No such module (or no lines): the first enabled pack's ladder, else each module's own.
//
// * A line is a rank's name, or its name and the first level it starts at ("Soul Class II: 11").
//   With Levels per rank (`perRank`, e.g. 10): a line's own first level wins when it rises above the
//   rank before; any other rank starts `perRank` levels after the one before (the first at 1), so
//   "Soul Class I" is levels 1–10 and "Soul Class II" 11–20. Without it, the levels are kept only when
//   every line gives one and they rise. Either way a rank reaches up to the level before the next one
//   starts (the last one to RANK_TOP_LEVEL). Otherwise the ranks have no levels of their own and each
//   module bands them as it does any ladder (RPG Battle by its tiers or evenly to its cap).
// * The numbers otherwise stay the pack's: a rank at the place of one of the first pack's ranks keeps
//   that rank's levels (when the lines give none). Its reward range is the pack's at its first level
//   (the pack rank that starts at or below it last, B-a2-1), so renaming a ladder never changes what
//   quests pay, and a longer ladder of narrower ranks never pays more at a level. A rank with no levels
//   past the pack's ladder has no reward of its own; modules give one by level.
// * A record is `{ id, title, levels?, reward?, pack: null, reader: true }`: `title` is the line as
//   written (at most 30 characters, without `| : # < >`), `id` the short word the story writes ("IX",
//   "SSS"): the line itself when it is one short word, else its last word when that is short and no
//   other rank has it, else R1, R2 … by place. At most RANKS_LIMITS.records ranks.

import { RANKS_LIMITS, TERM_SEPARATORS } from './limits.js';

// What a rank id may be (RPG Battle's and Story Director's ladders read the same).
const SHORT_ID = /^[A-Za-z0-9+-]{1,8}$/;
// The highest level a reader's last rank reaches (RPG Battle holds it to its level cap).
export const RANK_TOP_LEVEL = 999;

const cleanTitle = text => String(text ?? '').replace(new RegExp(TERM_SEPARATORS.source, 'g'), ' ').replace(/\s+/g, ' ').trim()
    .slice(0, RANKS_LIMITS.title).trim();

/** One line of the setting → `{ title, from }` (`from`: the first level it gave, or null), or null when it holds no name. */
export function rankLine(text) {
    const raw = String(text ?? '').trim();
    const at = /^(.*?)\s*:\s*(\d{1,3})\s*$/.exec(raw);
    const title = cleanTitle(at ? at[1] : raw);
    if (!title) return null;
    const from = at ? Number(at[2]) : null;
    return { title, from: Number.isInteger(from) && from >= 1 ? from : null };
}

/** The setting's rows (`[{ rank: 'Soul Class I' }]`, or plain lines) as `{ title, from }`, at most RANKS_LIMITS.records. */
export function rankLines(rows) {
    const out = [];
    for (const row of Array.isArray(rows) ? rows : []) {
        const line = rankLine(typeof row === 'string' ? row : row?.rank);
        if (line && !out.some(other => other.title.toLowerCase() === line.title.toLowerCase())) out.push(line);
        if (out.length >= RANKS_LIMITS.records) break;
    }
    return out;
}

/**
 * The reader's ladder as rank records (see above), lowest first, or [] when the setting is empty.
 * `pack`: the first enabled pack's ranks (packs.content records of one pack), for their numbers.
 */
export function readerRanks(rows, pack = [], { perRank = 0 } = {}) {
    const lines = rankLines(rows);
    if (!lines.length) return [];
    const ids = [];
    for (const [index, line] of lines.entries()) {
        const words = line.title.split(' ');
        const taken = id => ids.some(other => other.toLowerCase() === id.toLowerCase());
        const last = words.at(-1);
        const id = words.length === 1 && SHORT_ID.test(line.title) && !taken(line.title) ? line.title
            : SHORT_ID.test(last) && !taken(last) && !lines.some((other, at) => at !== index && other.title.split(' ').at(-1).toLowerCase() === last.toLowerCase()) ? last
                : `R${index + 1}`;
        ids.push(taken(id) ? `R${index + 1}` : id);
    }
    const starts = rankStarts(lines, perRank);
    const theirs = Array.isArray(pack) ? pack : [];
    return lines.map((line, index) => {
        const own = starts ? [starts[index], index + 1 < lines.length ? starts[index + 1] - 1 : RANK_TOP_LEVEL] : null;
        const at = theirs[index];
        const levels = own ?? (Array.isArray(at?.levels) ? [...at.levels] : null);
        const paid = levels ? packRankAt(theirs, levels[0]) : null;
        const reward = Array.isArray(paid?.reward) ? [...paid.reward] : null;
        return { id: ids[index], title: line.title, ...(levels ? { levels } : {}), ...(reward ? { reward } : {}), pack: null, reader: true };
    });
}

/** The pack rank a reader's rank starting at `level` is paid as: the last one (in order) that starts at or below it, else the lowest; null for none with levels. */
function packRankAt(pack, level) {
    const banded = pack.filter(rank => Array.isArray(rank?.levels) && Number.isInteger(rank.levels[0]));
    let found = banded[0] ?? null;
    for (const rank of banded) if (rank.levels[0] <= level) found = rank;
    return found;
}

/**
 * The first level of each line (see above), rising, or null when the lines give no levels: with
 * `perRank` every line has one (its own when it rises, else `perRank` after the one before); without
 * it, only when every line gives one and they rise.
 */
export function rankStarts(lines, perRank = 0) {
    const per = Number.isInteger(perRank) && perRank > 0 ? Math.min(perRank, RANK_TOP_LEVEL) : 0;
    if (!per) {
        const rising = lines.length > 0 && lines.every((line, index) => line.from !== null && (index === 0 || line.from > lines[index - 1].from));
        return rising ? lines.map(line => line.from) : null;
    }
    const out = [];
    for (const [index, line] of lines.entries()) {
        const before = out[index - 1];
        const own = line.from !== null && (index === 0 || line.from > before) ? line.from : null;
        out.push(Math.min(RANK_TOP_LEVEL, own ?? (index === 0 ? 1 : before + per)));
    }
    // Held at the top, a rank would start where the one before it does: the ladder stops below it.
    return out.every((start, index) => index === 0 || start > out[index - 1]) ? out : out.map((start, index) => Math.min(start, RANK_TOP_LEVEL - lines.length + index + 1));
}

/** The first pack's ranks out of `packs.content({ kind: 'ranks' })`'s list (every pack's, one after another). */
export function firstPackRanks(list) {
    const records = Array.isArray(list) ? list.filter(record => record && typeof record === 'object') : [];
    const first = records[0]?.pack;
    return first === undefined ? [] : records.filter(record => record.pack === first);
}
