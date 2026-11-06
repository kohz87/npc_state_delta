// XP for a won fight, given by code (stage 49; by level from the Levels release).
//
// When a reply's story takes the fight from "at least one filled foe group is standing" to "every filled foe group is Down" (by the dice, which write the
// foes' bars under the Standard formula, or by the narrator's own foe lines), the party is paid once, for that fight: every party member who has not Left
// (a Down member too; a dead one is not paid) gets XP of their own, from their level against each group's (names.js FIGHT_XP: count × max(1, ceil(foe level / 10)) × 2,
// times 100% plus 10% for each level the foe is above the member (and minus 10% for each level below), held between 0% and 200%; summed and rounded down, held to 1..60, and
// nothing at 0, with no receipt line; level 5 against six level 5 foes gives 12, level 25 against them gives 0). The groups of the fight are the ones that were standing when the reply began and are still on the Foes
// block; a group the narrator cleared is not Down, it is gone (fled, yielded), and a fight with none of its groups left is not won. A later reply that fills
// the slots again and wins is a new fight, since the groups it starts from are the standing ones. A group that arrives in the reply itself (the pre-call's
// opened foes, or the narrator's own set-slot line) is part of that reply's fight, so a fight opened and won in one reply is paid.
// A sheet entry without a `level` (a block of the older templates, which has a Soul Class / foe class 1..9) counts as that class as its level.
//
// How. `fightHook` (the part's afterCapture) compares the reply's state with the one before it (view.before) and, only for a won fight, asks for the step
// `rpg.fight { was }`: `was` = the slots standing before the reply. The step is a guarded block on the reply (replan: a swipe or a delete takes it away, a
// Re-read and a middle delete plan it again on the new story, REPLAY.md), so the live state, a rebuild and a reload agree. It runs the character block's own
// rules (the level rises at 100 XP) through the block interpreter, as the narrator's `add-xp` line does.
//
// No double count: in that reply the narrator's XP for a party member is not used. The first story line of the reply that wrote a character's XP kept what
// that character's xp, soul and points were before it (data-modules/part.js, the reply's scratch `xpFrom`); the step puts those back before it adds the
// code's XP, so the narrator's line and the rise it brought are gone, and one Problems line says so. XP in any other reply (a quest, a discovery) is
// untouched: the step exists only in the reply that won the fight.
//
// The record (the step's receipt `data.v2.result.fight`): { lv: 1, groups: [{ slot, name, count, level }], awards: [{ who, module, xp, held? }] } (xp is the member's own). A record without `lv` is an
// older one (groups carry `class`); it is read as it is and replays as recorded.
import { createEvaluation } from '../data-modules/interpreter.js';
import { FIGHT, FIGHT_XP, FOE_SLOTS, LEAN_RPG_FEATURE, RESOLVE } from './names.js';
import { XP_RATE, clampLevel, scaleXp, xpRateFrom, xpRateOf } from './levels.js';
import { levelOfClass } from './formula.js';
import { fold, readSheet } from './read.js';
import { boardWin } from './board/awards.js';

/** The replies whose story is paid for (the same as the reply-end steps of the blocks: not a Continue's, nor the extractor's late lines). */
const PAID_TYPES = Object.freeze(['normal', 'swipe', 'regenerate', 'reread']);
/** Said once in a reply where the narrator wrote XP for a won fight (a Problems line). */
export const FIGHT_XP_HELD = 'XP for the fight is given by code; the narrator\'s XP line was not used.';

/** What the reply's XP lines may have moved on a member's block: XP, the level (older blocks: Soul Class) and the points the level brings. */
const RISES = Object.freeze(['xp', 'soul', 'level', 'points']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const whole = value => Number.isSafeInteger(value);
/** The level a foe group stands at: its `level`, else (an older Foes block) its class 1..9 as the level. */
export const foeLevel = foe => clampLevel(whole(foe?.level) ? foe.level : whole(foe?.class) ? levelOfClass(foe.class) : 1);
/** The level a party member stands at: their `level`, else (an older Character block) its Soul Class 1..9 as the level. */
export const memberLevel = character => clampLevel(whole(character?.level) ? character.level : whole(character?.soul) ? levelOfClass(character.soul) : 1);
const slotsOf = value => (Array.isArray(value) ? [...new Set(value.filter(slot => whole(slot) && slot >= 1 && slot <= 99))].sort((a, b) => a - b) : []);

/** The foe slots that are filled and not Down (their Health above 0). */
export const standingSlots = sheet => sheet.foes.filter(foe => foe.filled && foe.hurt > 0).map(foe => foe.slot);

/**
 * Whether the fight that began with the groups in `was` is won on `sheet`: some of those groups are still on the block and every filled group is Down.
 * → { won, groups: [{ slot, name, count, level }] (the fight's groups still there) }.
 */
export function fightOf(sheet, was) {
    const filled = sheet.foes.filter(foe => foe.filled);
    const groups = filled.filter(foe => was.includes(foe.slot)).map(foe => ({ slot: foe.slot, name: foe.name, count: foe.count, level: foeLevel(foe) }));
    return { won: groups.length > 0 && filled.every(foe => foe.hurt === 0), groups };
}

/** The XP a member of level `level` gets for the fight's `groups` (see FIGHT_XP): the groups' bases scaled by the level gap, added, rounded down; 0, or 1..60. */
export function memberXp(groups, level) {
    const percent = groups.reduce((total, group) => {
        const scale = Math.max(0, Math.min(FIGHT_XP.maxPercent, 100 + FIGHT_XP.gapPercent * (group.level - level)));
        return total + group.count * Math.max(1, Math.ceil(group.level / FIGHT_XP.perLevels)) * FIGHT_XP.perBand * scale;
    }, 0);
    const xp = Math.floor(percent / 100);
    return xp > 0 ? Math.max(FIGHT_XP.min, Math.min(FIGHT_XP.max, xp)) : 0;
}

// The numbers a character's rise moves, and the reply's scratch keeps (`level` is the Level field of a block made from 2.17.0 on, `soul` the Soul Class of an earlier one).

// The party members the fight pays: not Left (readSheet leaves those out), not dead.
const paidOf = sheet => sheet.characters.filter(character => character.alive !== false);

// The reply's scratch (data-modules/part.js finish): `perReply[<sid>/<swipeKey>].xpFrom` = { [module]: { xp, soul, points } }, what a character had before the
// first story line of this reply that wrote XP. → the numbers that are whole, by block.
const pairKey = source => `${source?.sid}/${source?.swipeKey}`;
function fromOf(domain, source) {
    const out = {};
    const kept = domain?.perReply?.[pairKey(source)]?.xpFrom;
    if (!isObject(kept)) return out;
    for (const [module, rises] of Object.entries(kept)) {
        if (isObject(rises) && whole(rises.xp) && (whole(rises.soul) || whole(rises.level))) out[module] = { xp: rises.xp, ...(whole(rises.soul) ? { soul: rises.soul } : {}), ...(whole(rises.level) ? { level: rises.level } : {}), ...(whole(rises.points) ? { points: rises.points } : {}) };
    }
    return out;
}

/** The numbers the step depends on (the replay guard asks them again): the fight's groups and every filled group's Health, each paid member's rises, and what the reply's XP lines started from. */
export function fightWitness(sheet, domain, source, decision) {
    // (`level` joins an entry only when the sheet has one of its own (a Foes block of the Levels rules), so the witness of an older Foes block, and the guard hash of its receipt, are what they were)
    const foes = sheet.foes.filter(foe => foe.filled).map(({ slot, name, count, class: soul, hurt, level, levelled }) => ({ slot, name, count, class: soul, hurt, ...(levelled && whole(level) ? { level } : {}) }));
    return { foes, was: slotsOf(decision?.was), from: fromOf(domain, source),
        members: paidOf(sheet).map(character => ({ module: character.module, who: character.who, xp: character.xp, soul: character.soul, ...(character.levelled ? { level: character.level } : {}), points: character.points })) };
}

/** The foe slots this reply's roll put a group in (its `rpg.resolve` receipt's `result.opened`, open.js): a group that took a Down group's slot is a new one. */
export function openedSlots(receipts) {
    const roll = (Array.isArray(receipts) ? receipts : []).findLast(receipt => receipt?.type === RESOLVE && isObject(receipt.data?.v2?.result));
    const opened = roll?.data?.v2?.result?.opened;
    return Array.isArray(opened) ? opened.map(entry => entry?.slot).filter(slot => Number.isSafeInteger(slot) && slot >= 1) : [];
}

/**
 * The part's afterCapture: the step for a fight this reply won, else nothing. `view.before()` is the state before the reply (sdk.js makeView); without it
 * (a view that cannot say) nothing is asked for.
 */
export function fightHook(view, info) {
    if (!PAID_TYPES.includes(info?.type ?? 'normal') || view?.feature?.(LEAN_RPG_FEATURE) !== true) return undefined;
    const board = boardWin(info?.receipts);
    if (board && !board.won) return undefined;
    const sheet = readSheet(view.state);
    const filled = sheet.foes.filter(foe => foe.filled);
    // (cheap first: a fight can only be won now if every filled group is Down)
    if (!filled.length || !filled.every(foe => foe.hurt === 0)) return undefined;
    const earlier = typeof view.before === 'function' ? view.before() : null;
    if (!earlier) return undefined;
    const before = readSheet(earlier);
    // The groups the fight began with: the ones standing before the reply, and the ones that arrived in it (the pre-call's opened foes, put on the block by the
    // reply's roll, or the narrator's own set-slot line): a slot that was empty before, or held another group, and is filled now.
    const filledBefore = new Map(before.foes.filter(foe => foe.filled).map(foe => [foe.slot, fold(foe.name)]));
    const arrived = filled.filter(foe => filledBefore.get(foe.slot) !== fold(foe.name)).map(foe => foe.slot);
    // (a group the reply's roll opened in a Down group's slot, even one of the same name, is new: it is paid; a stale Down group never is)
    const opened = openedSlots(info?.receipts).filter(slot => filled.some(foe => foe.slot === slot));
    const was = [...new Set(board ? board.groups : [...standingSlots(before), ...arrived, ...opened])].sort((a, b) => a - b);
    if (!was.length || !fightOf(sheet, was).won) return undefined;
    // The XP rate in force, recorded with the step (a payload without `rate` is 100): a later change of the setting never moves a reply that has it.
    let rate = XP_RATE.default;
    try { rate = xpRateFrom(typeof view.settings === 'function' ? view.settings('story-block') : null); } catch { rate = XP_RATE.default; }
    return { commands: [{ type: FIGHT, payload: { was, ...(rate !== XP_RATE.default ? { rate } : {}) } }] };
}

/**
 * `rpg.fight { was }`: pays the party for the fight (see the top). A system step after the reply's lines; NO_LONGER_DONE when the story it is planned on
 * no longer holds a won fight (a delete or a Re-read changed it), and the block then goes.
 */
export function fightXp(ctx, payload = {}) {
    if (ctx.cause !== 'system' || ctx.caller !== null) ctx.fail('REFUSED', 'The XP for a fight is given by Story Block after a reply, not by an action.');
    const was = slotsOf(payload?.was);
    const rate = payload?.rate === undefined ? XP_RATE.default : xpRateOf(payload.rate);
    if (rate === null) ctx.fail('INVALID', 'The XP rate of the fight was damaged.');
    if (!was.length) ctx.fail('INVALID', 'The XP for a fight needs the groups it was fought against.');
    const domain = ctx.read('dataModules');
    const sheet = readSheet({ domains: { dataModules: domain } });
    const fight = fightOf(sheet, was);
    if (!fight.won) ctx.fail('NO_LONGER_DONE', 'No won fight is left to give XP for on this story.');
    const from = fromOf(domain, ctx.source);
    const witness = fightWitness(sheet, domain, ctx.source, { was });
    const predicate = { kind: FIGHT };
    ctx.replayGuard({ owner: ctx.module, version: 2, epoch: ctx.epoch, rulesHash: null, predicate, inputHash: ctx.hash({ source: ctx.source, predicate, witness }) }, { was, ...(rate !== XP_RATE.default ? { rate } : {}) });
    const draft = ctx.draft('dataModules');
    const awards = [];
    for (const character of paidOf(sheet)) {
        const definition = draft.pins?.[draft.active?.[character.module]?.hash]?.definition;
        const fields = draft.instances?.[character.module]?.chat?.fields;
        if (!isObject(fields) || !whole(fields.xp)) continue;
        // What the story added to this member's xp, soul and points in this reply (the narrator's XP line and its rise) is not used.
        const kept = from[character.module];
        const keys = RISES.filter(key => whole(kept?.[key]) && key in fields);
        const held = Boolean(kept) && keys.some(key => fields[key] !== kept[key]);
        const instance = draft.instances[character.module].chat;
        // The fight pays at the level the member had before this reply's own (held back) XP line raised it.
        const before = held ? (whole(kept.level) ? clampLevel(kept.level) : whole(kept.soul) ? levelOfClass(kept.soul) : null) : null;
        const xp = scaleXp(memberXp(fight.groups, before ?? memberLevel(character)), rate);
        if (isObject(definition?.state) && Array.isArray(definition.rules)) {
            const evaluation = createEvaluation(definition, instance, { inputs: {}, source: {}, cursor: null, subject: 'chat' });
            if (held) evaluation.effects(keys.map(key => ({ op: 'set', path: [key], value: kept[key] })));
            if (xp > 0) evaluation.effects([{ op: 'add', path: ['xp'], value: xp, bounds: 'clamp' }]);
            evaluation.rules();
            evaluation.finish();
        } else {
            // A bare block (no pinned rules to run): XP only, held to 0–100.
            if (held) Object.assign(fields, Object.fromEntries(keys.map(key => [key, kept[key]])));
            fields.xp = Math.max(0, Math.min(100, fields.xp + xp));
        }
        if (xp > 0 || held) awards.push({ who: character.who, module: character.module, xp, ...(held ? { held: true } : {}) });
    }
    const held = awards.some(award => award.held);
    return {
        summary: `Fight won: ${awards.filter(award => award.xp > 0).map(award => `${award.who} +${award.xp} XP`).join(', ') || 'no XP to give'}.`, narrate: false, replan: true,
        data: { v2: { result: { fight: { lv: 1, ...(rate !== XP_RATE.default ? { rate } : {}), groups: fight.groups, awards } } } },
        ...(held ? { problem: FIGHT_XP_HELD } : {}),
    };
}

/** The replay guard of `rpg.fight` (leanRpgGuard routes it here): the step stands while the sheet numbers it used are what the prefix holds. */
export function fightGuard({ state, hash }, { guard, source, recorded }) {
    const bad = reason => ({ ok: false, reason });
    try {
        const predicate = guard?.predicate;
        if (guard?.version !== 2 || guard.rulesHash !== null || !isObject(predicate) || predicate.kind !== FIGHT || !isObject(recorded)) return bad('Malformed fight guard.');
        const was = slotsOf(recorded.was);
        if (!was.length || was.length !== recorded.was.length || was.some(slot => slot > FOE_SLOTS * 25)) return bad('The fight\'s groups were damaged.');
        if (recorded.rate !== undefined && xpRateOf(recorded.rate) === null) return bad('The fight\'s XP rate was damaged.');
        const witness = fightWitness(readSheet(state), state.domains?.dataModules, source, { was });
        if (hash({ source, predicate, witness }) !== guard.inputHash) return bad('The sheet before this step changed; Re-read this reply.');
        return { ok: true };
    } catch { return bad('Damaged fight record.'); }
}
