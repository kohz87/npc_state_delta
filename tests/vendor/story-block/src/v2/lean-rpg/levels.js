// Levels and ranks (Levels release). A character and a foe have a level, 1..99. A pack may name bands of levels, its ranks
// (`content.rpg.ranks`: [{ name, from, to }], packs/validate.js), and cap the level (`content.rpg.levelCap`).
//
//   packLevelsOf(records)         the `ranks` record of a pack's `packs.content` list of kind rpg → { ranks, levelCap, playerRank } (each may be absent), or null
//   rankOf(level, ranks)          the rank whose band holds the level → { name, from, to } | null
//   levelLabel(level, ranks)      "Rank E · Lv 14", or "Lv 14" when no rank holds the level (or there are none)
//   RANK_QUERY `rpg.rank`         { level } → { name } | null (the story's pack, or `ranks` in the arguments)
import { LEAN_RPG_FEATURE, LEVEL, LEVEL_CAP_SETTING } from './names.js';

/** A level runs from 1 to 99 (names.js LEVEL: the character's `level`, a foe's `level{n}`, a pack's rank bands and level cap). */
export const LEVEL_MIN = LEVEL.min;
export const LEVEL_MAX = LEVEL.max;

/** The part's settings schema: the level cap (Settings → RPG: a whole number from 1 to 99, 99 unset). */
export const SETTINGS_SCHEMA = Object.freeze({
    [LEVEL_CAP_SETTING]: Object.freeze({ type: 'int', min: LEVEL.min, max: LEVEL.max, group: 'RPG', label: 'Level cap', feature: LEAN_RPG_FEATURE,
        help: 'The highest level a new character can reach, from 1 to 99. A character made keeps the cap it was made with; the pack may name one.' }),
});

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const whole = value => Number.isSafeInteger(value);

/** The query `rpg.rank { level }` → { name } | null. */
export const RANK_QUERY = 'rpg.rank';

/** A level held to 1..99 (a number that is not whole, or not a number, is 1). */
export const clampLevel = value => (whole(value) ? Math.max(LEVEL_MIN, Math.min(LEVEL_MAX, value)) : LEVEL_MIN);

/** `ranks` as a clean list: the entries that are whole bands with a name, ascending by `from` (a damaged list gives what is whole). */
export function bandsOf(ranks) {
    if (!Array.isArray(ranks)) return [];
    return ranks.filter(rank => isObject(rank) && typeof rank.name === 'string' && rank.name && whole(rank.from) && whole(rank.to) && rank.from >= LEVEL_MIN && rank.to <= LEVEL_MAX && rank.from <= rank.to)
        .map(({ name, from, to }) => ({ name, from, to })).sort((a, b) => a.from - b.from);
}

/** The rank whose band holds `level`: { name, from, to }, or null. */
export function rankOf(level, ranks) {
    if (!whole(level)) return null;
    return bandsOf(ranks).find(rank => level >= rank.from && level <= rank.to) ?? null;
}

/**
 * The label for a level. Without `playerRank` (a foe, or a character with no player-rank source): "Rank E · Lv 14" with a rank for the level, else "Lv 14".
 * With the pack's `playerRank` { module, field, label } (a party member): "Lv 14 · Guild F" when `value` (the field's current value, playerRankValue) is
 * filled, else "Lv 14" alone.
 */
export function levelLabel(level, ranks, { playerRank = null, value } = {}) {
    const shown = clampLevel(level);
    if (isObject(playerRank)) {
        const text = typeof value === 'string' || typeof value === 'number' ? String(value).replace(/\s+/g, ' ').trim() : '';
        const label = typeof playerRank.label === 'string' ? playerRank.label.trim() : '';
        return text ? `Lv ${shown} · ${label ? `${label} ` : ''}${text}` : `Lv ${shown}`;
    }
    const rank = rankOf(shown, ranks);
    return rank ? `Rank ${rank.name} · Lv ${shown}` : `Lv ${shown}`;
}

/**
 * The current value of the pack's player-rank field: the chat block whose slug is `playerRank.module`, read through the data-modules view
 * (`query('dataModules.view', { module })`, a chat block's `{ chat: fields }`; without `query` the state's own instance), else null; null too while the block has `registered: false`.
 */
export function playerRankValue(state, playerRank, query) {
    try {
        if (!isObject(playerRank) || typeof playerRank.module !== 'string' || typeof playerRank.field !== 'string') return null;
        const wanted = playerRank.module.trim().toLowerCase();
        const id = Object.keys(state?.domains?.dataModules?.active ?? {}).find(key => key === wanted || key.split('/')[1] === wanted);
        if (!id) return null;
        const view = typeof query === 'function' ? query('dataModules.view', { module: id }) : { chat: state.domains.dataModules.instances?.[id]?.chat?.fields };
        // A rank block that says it has not been joined yet (a boolean `registered` that is false: Ersveil's Guild before anyone registers) names no rank: its letter is a default, not a standing.
        if (view?.chat?.registered === false) return null;
        const value = view?.chat?.[playerRank.field];
        return typeof value === 'string' || typeof value === 'number' ? value : null;
    } catch { return null; }
}

/** A rank by name (case and spacing folded) → { name, from, to } | null. */
export function rankNamed(name, ranks) {
    const key = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().toLowerCase() : '';
    return key ? bandsOf(ranks).find(rank => rank.name.toLowerCase() === key) ?? null : null;
}

/** What a pack says of levels, from its `content.rpg` records (the one with the slug `ranks`): { ranks?, levelCap? }, or null. */
export function packLevelsOf(records) {
    const found = (Array.isArray(records) ? records : []).find(record => isObject(record) && record.slug === 'ranks');
    if (!found) return null;
    const ranks = bandsOf(found.ranks);
    return { ...(ranks.length ? { ranks } : {}), ...(whole(found.levelCap) && found.levelCap >= LEVEL_MIN && found.levelCap <= LEVEL_MAX ? { levelCap: found.levelCap } : {}),
        ...(isObject(found.playerRank) && ['module', 'field', 'label'].every(key => typeof found.playerRank[key] === 'string' && found.playerRank[key]) ? { playerRank: { module: found.playerRank.module, field: found.playerRank.field, label: found.playerRank.label } } : {}) };
}

/** The query function: `rpg.rank { level, ranks? }` → { name } | null. Without `ranks` in the arguments it reads the packs' (`packs.content` of kind rpg). */
export function rankQuery(_state, args, tools) {
    let ranks = args?.ranks;
    if (ranks === undefined) {
        let found = null;
        try { found = packLevelsOf(tools?.query?.('packs.content', { kind: 'rpg' })); } catch { found = null; }
        ranks = found?.ranks;
    }
    const rank = rankOf(args?.level, ranks);
    return rank ? { name: rank.name } : null;
}

// ---- the XP rate (Levels release) ------------------------------------------------------------------------------------------------
// The setting `rpgXpRate` (Story Block's own bucket, Settings → RPG; the row is the settings view's): every XP gain to a character, the fight XP given by code
// and the narrator's XP lines, is multiplied by it. A percent from 50 to 300 in steps of 25, 100 unset. The gain is rounded down and is at least 1 when the
// raw gain was 1 or more (0 stays 0). The rate in force is recorded with the reply that used it (the fight step's payload `rate`, the XP line's decision `xpRate`),
// only when it is not 100, so a later change of the setting never moves a past reply and a record without it is 100.
export const XP_RATE_SETTING = 'rpgXpRate';
export const XP_RATE = Object.freeze({ min: 50, max: 300, step: 25, default: 100 });

/** `value` as a rate: a whole number from 50 to 300 on a step of 25, else null. */
export const xpRateOf = value => (Number.isInteger(value) && value >= XP_RATE.min && value <= XP_RATE.max && (value - XP_RATE.min) % XP_RATE.step === 0 ? value : null);

/** The rate the settings say (100 when unset or not a rate; a number off the step is brought to the nearest step inside 50..300). */
export function xpRateFrom(values) {
    const raw = values?.[XP_RATE_SETTING];
    if (xpRateOf(raw) !== null) return raw;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return XP_RATE.default;
    const stepped = XP_RATE.min + Math.round((Math.max(XP_RATE.min, Math.min(XP_RATE.max, raw)) - XP_RATE.min) / XP_RATE.step) * XP_RATE.step;
    return xpRateOf(stepped) ?? XP_RATE.default;
}

/** An XP gain at `rate` per cent: floor(gain × rate / 100), at least 1 when the gain was 1 or more; a gain below 1 (or damaged) is 0. A missing rate is 100. */
export function scaleXp(gain, rate = XP_RATE.default) {
    if (!Number.isSafeInteger(gain) || gain < 1) return Number.isSafeInteger(gain) ? gain : 0;
    const used = xpRateOf(rate) ?? XP_RATE.default;
    return Math.max(1, Math.floor(gain * used / 100));
}
