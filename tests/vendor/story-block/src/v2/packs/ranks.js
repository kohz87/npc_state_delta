// The reader's rank ladder (MODULES §F86, §F91; PACKS.md "Ranks"): the names a world gives its ranks,
// lowest first, typed in Story Block's settings (Terms: Rank ladder), one per line ("Soul Class I" …
// "Soul Class IX", or "F", "E" … "SSS"). Pure.
//
// The ladder is read where every module reads ranks: Story Block's `packs.content({ kind: 'ranks' })`
// answers with the reader's ladder when it is set, instead of the packs', so Story Director's quest ranks,
// RPG Battle's party and foe ranks and Story Block's own coin budget all follow it, whichever of them is
// installed. Empty: the first enabled pack's ladder, else each module's built-in one.
//
// * A line is a rank's name, or its name and the first level it starts at ("Soul Class II: 11"). The
//   levels are kept only when every line gives one and they rise; then a rank reaches up to the level
//   before the next one starts (the last one to RANK_TOP_LEVEL). Otherwise the ranks have no levels of
//   their own and each module bands them as it does any ladder (RPG Battle by its tiers or its
//   built-in bands).
// * The numbers otherwise stay the pack's: a rank at the place of one of the first pack's ranks keeps
//   that rank's levels (when the lines give none) and its reward range, so renaming a ladder never
//   changes what quests pay. A rank past the pack's ladder has no reward of its own; modules give one by
//   place, times the money scale.
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
export function readerRanks(rows, pack = []) {
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
    const rising = lines.every((line, index) => line.from !== null && (index === 0 || line.from > lines[index - 1].from));
    const theirs = Array.isArray(pack) ? pack : [];
    return lines.map((line, index) => {
        const own = rising ? [line.from, index + 1 < lines.length ? lines[index + 1].from - 1 : RANK_TOP_LEVEL] : null;
        const at = theirs[index];
        const levels = own ?? (Array.isArray(at?.levels) ? [...at.levels] : null);
        const reward = Array.isArray(at?.reward) ? [...at.reward] : null;
        return { id: ids[index], title: line.title, ...(levels ? { levels } : {}), ...(reward ? { reward } : {}), pack: null, reader: true };
    });
}

/** The first pack's ranks out of `packs.content({ kind: 'ranks' })`'s list (every pack's, one after another). */
export function firstPackRanks(list) {
    const records = Array.isArray(list) ? list.filter(record => record && typeof record === 'object') : [];
    const first = records[0]?.pack;
    return first === undefined ? [] : records.filter(record => record.pack === first);
}
