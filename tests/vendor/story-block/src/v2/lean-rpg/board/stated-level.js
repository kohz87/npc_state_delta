// A foe's stated level: a person the owner or the story has marked. When a foe group's name equals an NPC State Delta dossier's name or one of its aliases EXACTLY (case, surrounding spaces and a leading "the" ignored; "Ash wolf", "Vorn's bodyguard" and "Branch Master Vorn" are not "Ash"/"Vorn" unless an alias) whose
// custom field "Level" (any case) holds a whole number 1..99 ("30", "Lv 30", "level 30") or one or two of the story's own rank names ("C", "rank C", "C-D",
// "C or D"), that is the foe's level: it passes the party + 20 cap that guessed levels keep, and it wins over any level or rank the pre-check or the narrator gave.
// Anything else (empty, "high", a rank the pack does not name, no ranks at all) is ignored and the normal rules apply.
// REPLAY: the dossier is NSD's sidecar, not chat state. This file is only READ by the host's pre-check step (precheck-run.js), BEFORE the opening is recorded:
// the result goes into the recorded `plan.open` (a `level`, or a rank band `rank`/`from`/`to` that resolve.js draws from the reply's seed and records), so replay,
// Re-read, swipe and rebuild read the recorded opening and no command or reducer asks NSD. Pure functions; `query` is the host's query function.
import { FOE_LEVEL, bandOfRank } from '../foes.js';

const ask = (query, name, args) => { try { return typeof query === 'function' ? query(name, args) : null; } catch { return null; } };
// A name as compared: case folded, spaces collapsed and trimmed, a leading "the" dropped. Nothing else is ignored, so "Ash wolf" is not "Ash".
const plain = text => String(text ?? '').normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim().replace(/^the\s+/u, '');
const RANK_MAX = 12; // the longest rank name a recorded opening may carry (open.js)

/**
 * The text of a Level field as `{ level }` (a whole number 1..99), `{ rank, from, to }` (one rank's band, or the span of two), or null. `rankAt(level)` → `{ name } | null`
 * is the `rpg.rank` query. Rank names are matched whole and without case, so "S" and "SS" are two names, and "Sage" is no rank "S".
 */
export function parseStatedLevel(text, rankAt = null) {
    const raw = String(text ?? '').replace(/\s+/gu, ' ').trim();
    if (!raw || raw.length > 60) return null;
    const number = /^(?:(?:level|lv)\.?\s*)?(\d{1,3})$/iu.exec(raw);
    if (number) { const level = Number(number[1]); return level >= FOE_LEVEL.min && level <= FOE_LEVEL.max ? { level } : null; }
    const body = raw.replace(/^rank\s+/iu, '');
    // the whole text as one rank name first (a name may hold "-" or " or "), then two names split by "-", "to", "or" or "/"
    const whole = bandOfRank(body, rankAt);
    if (whole) return { rank: body.slice(0, RANK_MAX), from: whole.from, to: whole.to };
    const parts = body.split(/\s*(?:[-–—/]|\b(?:or|to)\b)\s*/iu).map(part => part.replace(/^rank\s+/iu, '').trim());
    if (parts.length !== 2 || !parts.every(Boolean)) return null;
    const [low, high] = parts.map(part => bandOfRank(part, rankAt));
    if (!low || !high) return null;
    const from = Math.min(low.from, high.from), to = Math.max(low.to, high.to);
    return { rank: parts[0].slice(0, RANK_MAX), from, to };
}

/**
 * The stated level of the foe group `name`, or null: the first dossier (`npc.known`, `npc.dossier`) whose name or an alias equals the group's name exactly (plain) and
 * whose "Level" custom field reads (parseStatedLevel). No NSD, no match, no field, a throwing query: null, so the normal rules stand.
 */
export function statedLevel(query, name) {
    const names = ask(query, 'npc.known', {});
    if (!Array.isArray(names)) return null;
    const seen = plain(name), rankAt = level => ask(query, 'rpg.rank', { level });
    for (const known of names.slice(0, 80)) {
        if (typeof known !== 'string') continue;
        const dossier = ask(query, 'npc.dossier', { name: known });
        if (!dossier || typeof dossier !== 'object') continue;
        const aliases = Array.isArray(dossier.aliases) ? dossier.aliases.filter(alias => typeof alias === 'string') : [];
        if (![known, ...aliases].some(label => seen !== '' && plain(label) === seen)) continue;
        const fields = dossier.customFields && typeof dossier.customFields === 'object' ? dossier.customFields : {};
        const key = Object.keys(fields).find(field => field.trim().toLowerCase() === 'level');
        const found = key === undefined ? null : parseStatedLevel(fields[key], rankAt);
        if (found) return found;
    }
    return null;
}
