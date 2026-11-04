// Gear in the rolls (`story-block.gear`, docs/v2/GEAR.md "In the rolls"). Pure, apart from the questions put to `query`.
//
// What it does. While the switch is on, the planner (precall.js) asks the inventory what each party member has on and carries (`planGear`),
// and the roll carries only the version mark in its payload (`gear: { v: 1 }`); `rpg.resolve` works the gear out from the state before the roll (`planGear`
// over the inventory's own answers) into the record `gear: { v: 1, who: { <member key>: { own, add?, enc?, items? } } }`:
//   own    the inventory owners the member's gear is filed under (their party actor, and `party` for the reader's lead: the first character);
//   add    { str…cha: +n } what the worn pieces give (broken ones give none), summed;
//   enc    the penalty (-2) to AGI and DEX while they carry more than they can;
//   items  [{ name, stats }] the pieces that give something, for the log.
// The roll reads the sheet through `applyGear`: effective stat = stat + add, held to 30, then AGI and DEX + enc (never under 1). The record is in the
// guard's predicate and the result, so a rebuild and a reload roll with it, and equipping something later never moves a roll that was made. The guard
// asks the state before the roll for the same pieces and load (`gearMatches`): a change before the roll (the reply that gave and equipped the gear deleted
// or edited) no longer matches, and the roll stands off until it is Re-read, which works its gear out again. A roll with no `gear` (made before) is read
// exactly as before. Off means no `gear`, and nothing here runs.
//
// Wear (`wearGear`): a decisive hit taken wears the member's body armour (else their off-hand) one step; a decisive miss wears their weapon one step
// (inventory `gear.wear`, the same condition events as everything else, so the roll's receipt carries them and a swipe, a delete or a Re-read takes them back).
import { fold, readSheet, sameWho } from './read.js';
import { actorIdOf } from './roster.js';
import { STATS } from './names.js';
import { gearAnswer } from '../domains/gear.js';
import { condOf, defCarry, ENCUMBERED_PENALTY } from '../domains/inventory.js';
import { mountRows } from '../domains/mounts.js';

export { sameWho };

export const GEAR_VERSION = 1;
/** A stat with gear added up may pass 20 but never this (GEAR.effectiveMax of the inventory side). */
export const STAT_MAX = 30;
/** The penalty to AGI and DEX while a member carries more than they can (the inventory's ENCUMBERED_PENALTY). */
export const ENCUMBERED = -2;
export const ENCUMBERED_STATS = Object.freeze(['agi', 'dex']);
/** How many levels above the party's highest a foe group must stand for a win to earn a legendary find. */
export const GAP = 10;
const MEMBERS_MAX = 24, OWN_MAX = 3, ITEMS_MAX = 8, NAME_MAX = 80;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ask = (query, name, args) => { try { return query(name, args) ?? null; } catch { return null; } };
const lower = stats => Object.fromEntries(Object.entries(isObject(stats) ? stats : {}).filter(([stat, n]) => STATS.includes(stat.toLowerCase()) && Number.isSafeInteger(n) && n !== 0).map(([stat, n]) => [stat.toLowerCase(), n]));

/**
 * What the owners `own` of one member give: { add?, enc?, items? } from the inventory's answers (`answerOf(owner)`; `party` is the shared bag's, which also
 * says whether the load is too much). Shared by the planner (the live queries) and the guard (the state before the roll), so both read it the same way.
 */
function dressOf(own, party, answerOf) {
    const add = {}, items = [];
    let enc = party.carry?.encumbered === true ? (Number.isSafeInteger(party.carry.penalty) && party.carry.penalty < 0 ? party.carry.penalty : ENCUMBERED) : 0;
    for (const answer of own.map(answerOf)) {
        if (!isObject(answer)) continue;
        for (const [stat, n] of Object.entries(lower(answer.statBonus))) add[stat] = (add[stat] ?? 0) + n;
        for (const piece of Object.values(isObject(answer.slots) ? answer.slots : {})) {
            const stats = piece && piece.broken !== true ? lower(piece.stats) : {};
            if (Object.keys(stats).length && typeof piece.name === 'string') items.push({ name: piece.name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX), stats });
        }
        if (answer.carry?.encumbered === true && !enc) enc = Number.isSafeInteger(answer.carry.penalty) && answer.carry.penalty < 0 ? answer.carry.penalty : ENCUMBERED;
    }
    return { ...(Object.keys(add).length ? { add } : {}), ...(enc ? { enc } : {}), ...(items.length ? { items: items.slice(0, ITEMS_MAX) } : {}) };
}

/**
 * The mark a roll's payload carries while gear is on: `{ v: 1 }` or `{ v: 1, lead: '<reader name>' }`, or undefined. `lead` is a stable fact about the roll (who the
 * shared bag `party` meant: the reader's name, used when no party module names the main character), not a gear record; the roll works its gear out itself (resolve.js).
 */
export function gearMarkOf(value) {
    if (!isObject(value) || value.v !== GEAR_VERSION) return undefined;
    const lead = typeof value.lead === 'string' ? value.lead.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : '';
    return lead ? { v: GEAR_VERSION, lead } : { v: GEAR_VERSION };
}

/** Whether gear is on for a planner: the inventory answers (`query(name, args)`) and there is a Character to dress. */
export function gearIsOn(sheet, query) {
    return typeof query === 'function' && Boolean(sheet?.characters?.length) && ask(query, 'inventory.gear', { owner: 'party' })?.on === true;
}

/**
 * Whether the pieces and the load `gear` (a roll's record) was worked out from are what the state before the roll holds: the same owners' worn pieces
 * (their stats and condition) and the same load. The state alone is asked (a guard sees no more); whether mounts counted is not in the state, so the
 * record may match with or without them. False when something before the roll changed (a reply that gave or equipped gear deleted, edited, swiped).
 */
export function gearMatches(state, gear, hash) {
    try {
        const stats = { condOf, carryOf: defCarry, penalty: ENCUMBERED_PENALTY };
        const withMounts = [[], mountRows(state)];
        // (whose the pieces were: an owner that is a Character block's actor must be the actor of the block the entry is for; the owners of a roster of another make cannot be told here)
        const mine = new Map(readSheet(state).characters.map(character => [actorIdOf(character.module), character.key]));
        const owned = (key, entry) => (entry?.own ?? []).every(owner => !mine.has(owner) || mine.get(owner) === key);
        return Object.entries(gear?.who ?? {}).every(([key, entry]) => owned(key, entry) && withMounts.some(mounts => {
            const answerOf = owner => gearAnswer(state, { owner }, { ...stats, mounts });
            const now = dressOf(entry.own, answerOf('party'), answerOf);
            return hash({ add: now.add ?? null, enc: now.enc ?? null, items: now.items ?? null }) === hash({ add: entry.add ?? null, enc: entry.enc ?? null, items: entry.items ?? null });
        }));
    } catch { return false; }
}

/**
 * The gear of every member of `sheet` (readSheet's), as the inventory reports it through `query(name, args)`: the record a roll keeps, or null
 * while gear is off (the inventory answers nothing) or there is no one to dress.
 */
export function planGear(sheet, query, reader = '') {
    if (typeof query !== 'function' || !sheet?.characters?.length) return null;
    const party = ask(query, 'inventory.gear', { owner: 'party' });
    if (!isObject(party) || party.on !== true) return null;
    const actors = ask(query, 'party.actors', {});
    const members = Array.isArray(actors) ? actors.filter(actor => typeof actor?.id === 'string' && actor.id !== 'party') : [];
    // The shared bag (`party`) is the reader's own Character's: the one the party module names (`party.pc`: its actor is the block's, or, for a module of another
    // make, the one of that name), else the one named like the reader (`reader`: the name a roll made by 2.18.0 carries as `lead`); only when none matches the
    // first block (a companion who sorts first is not the reader).
    const pc = ask(query, 'party.pc', {});
    const pcName = typeof pc?.id === 'string' ? members.find(actor => actor.id === pc.id)?.name : '';
    const matching = name => (name ? sheet.characters.findIndex(character => sameWho(character, name, [], sheet.characters)) : -1);
    const lead = Math.max(0, [typeof pc?.id === 'string' ? sheet.characters.findIndex(character => actorIdOf(character.module) === pc.id) : -1, matching(pcName), matching(reader)].find(at => at >= 0) ?? 0);
    const who = {};
    for (const [at, character] of sheet.characters.slice(0, MEMBERS_MAX).entries()) {
        // (their actor is the one whose ID is the block's; for a roster of another make an exact name wins, then a first name or an alias that means this Character alone: sameWho)
        const named = members.find(actor => actor.id === actorIdOf(character.module))
            ?? members.find(actor => fold(actor.name) === character.key)
            ?? members.find(actor => sameWho(character, actor.name, actor.aliases, sheet.characters));
        const own = [...(named ? [named.id] : []), ...(at === lead ? ['party'] : [])];
        who[character.key] = { own: own.slice(0, OWN_MAX), ...dressOf(own, party, (owner) => (owner === 'party' ? party : ask(query, 'inventory.gear', { owner }))) };
    }
    return { v: GEAR_VERSION, who };
}

/** Whether `gear` (from a payload, a record) is a record this version reads: damaged ones are not guessed at. */
export function gearValid(gear) {
    if (!isObject(gear) || gear.v !== GEAR_VERSION || !isObject(gear.who) || Object.keys(gear).some(key => !['v', 'who'].includes(key))) return false;
    const entries = Object.entries(gear.who);
    if (entries.length > MEMBERS_MAX) return false;
    const stats = value => isObject(value) && Object.entries(value).every(([stat, n]) => STATS.includes(stat) && Number.isSafeInteger(n) && n >= -30 && n <= 30);
    return entries.every(([key, entry]) => typeof key === 'string' && key.length > 0 && key.length <= NAME_MAX && isObject(entry)
        && Array.isArray(entry.own) && entry.own.length <= OWN_MAX && entry.own.every(owner => typeof owner === 'string' && owner.length > 0 && owner.length <= NAME_MAX)
        && (entry.add === undefined || stats(entry.add)) && (entry.enc === undefined || (Number.isSafeInteger(entry.enc) && entry.enc < 0 && entry.enc >= -10))
        && (entry.items === undefined || (Array.isArray(entry.items) && entry.items.length <= ITEMS_MAX && entry.items.every(item => isObject(item) && typeof item.name === 'string' && item.name.length <= NAME_MAX && stats(item.stats)))));
}

/** The gear a payload carries when it is one this version reads, else undefined (a roll made before, or a damaged record, is rolled without it). */
export const gearOf = value => (gearValid(value) ? value : undefined);

/**
 * The sheet with the gear laid over the stats: each member's stats are stat + gear (held to 30), AGI and DEX then + the encumbered penalty (never under 1).
 * `base` keeps the stats as the block holds them (the bars' sizes follow those, never the gear). Without gear the sheet itself.
 */
export function applyGear(sheet, gear) {
    if (!gear || !sheet?.characters) return sheet;
    return {
        ...sheet,
        characters: sheet.characters.map(character => {
            const entry = gear.who?.[character.key];
            if (!entry || (!entry.add && !entry.enc)) return character;
            const stats = { ...character.stats };
            for (const [stat, n] of Object.entries(entry.add ?? {})) if (Number.isInteger(stats[stat])) stats[stat] = n > 0 ? Math.max(stats[stat], Math.min(STAT_MAX, stats[stat] + n)) : stats[stat] + n;
            if (entry.enc) for (const stat of ENCUMBERED_STATS) if (Number.isInteger(stats[stat])) stats[stat] = Math.max(1, stats[stat] + entry.enc);
            return { ...character, stats, base: character.base ?? character.stats };
        }),
    };
}

/** The stats a Line rolled with (Classic's one, Standard's pair). */
const statsOfLine = line => [line.pc?.stat, line.pc?.second].filter((stat, at, all) => typeof stat === 'string' && all.indexOf(stat) === at);

/**
 * What the gear added to one Line, for the log: [{ name, stat, n }] ("Cane Sword", "dex", 2), with the encumbered penalty as { name: 'Encumbered', stat, n: -2 }.
 * Only the stats the roll used are named. [] when there was none.
 */
export function gearOfLine(line, gear) {
    const entry = gear?.who?.[fold(line?.pc?.who)];
    if (!entry) return [];
    const used = statsOfLine(line), out = [];
    for (const item of entry.items ?? []) for (const [stat, n] of Object.entries(item.stats)) if (used.includes(stat)) out.push({ name: item.name, stat, n });
    if (entry.enc) for (const stat of ENCUMBERED_STATS) if (used.includes(stat)) out.push({ name: 'Encumbered', stat, n: entry.enc });
    return out;
}

/** Writes each Line's `pc.gear` (the gear that was in its roll), for the log; a line that had none is left as it is. */
export function noteGear(lines, gear) {
    for (const line of lines) {
        if (!isObject(line?.pc)) continue;
        const used = gearOfLine(line, gear);
        if (used.length) line.pc = { ...line.pc, gear: used };
    }
}

/** Whether a told Line was decisive: Standard's lines say so; a Classic line is a natural 1 or 20 on either die or a margin either way (resolve.js `rolled`). */
export function isDecisive(line, rules) {
    if (typeof line?.decisive === 'boolean') return line.decisive;
    if (!line?.foe || !Number.isFinite(line.pc?.die) || !Number.isFinite(line.foe.die)) return false;
    return [line.pc.die, line.foe.die].some(die => die === 1 || die === 20) || Math.abs(line.pc.total - line.foe.total) >= (rules?.decisiveMargin ?? Infinity);
}

/**
 * The wear the told rounds cost: a decisive hit taken wears the one hit's body armour (else off-hand), a decisive miss of an act their weapon, one step each
 * (`ctx.call('gear.wear')`; a piece already broken, or no piece, wears nothing). `opening` lines come before round 1. → [{ n, who, item, from, to }], recorded in the result.
 * `condWord(cond)` names a condition. Nothing happens while the inventory answers no gear (the switch went off).
 */
export function wearGear(ctx, gear, { opening = [], rounds = [], rules, condWord, stepDown = null }) {
    const events = [];
    // `stepDown(cond)` given: a dry run (nothing is called; the conditions are walked down here), what the cue is fitted with so the wear lines count in its budget.
    const dry = typeof stepDown === 'function', conds = new Map();
    // (decided by the record the roll carries, not by today's switch: a roll made with gear keeps the wear it made when it is read again with the switch off)
    if (!gear) return events;
    const told = [...opening.map(line => ({ n: rounds[0]?.n ?? 1, line })), ...rounds.flatMap(round => round.lines.map(line => ({ n: round.n, line })))];
    for (const { n, line } of told) {
        if (!['act', 'foe'].includes(line.kind) || line.support || line.outcome !== 'fail' || !isDecisive(line, rules)) continue;
        const slots = line.kind === 'foe' ? ['body', 'off-hand'] : ['weapon'];
        for (const owner of gear.who?.[fold(line.pc.who)]?.own ?? []) {
            const worn = ctx.query('inventory.gear', { owner, recorded: true })?.slots ?? {};
            // (what a hit taken wears is the body armour, else the off-hand, as `gear.wear defence` picks it)
            const place = line.kind === 'foe' ? (worn.body ? 'body' : worn['off-hand'] ? 'off-hand' : null) : (worn.weapon ? 'weapon' : null);
            const mark = `${owner}/${place}`;
            if (!place || (dry ? (conds.get(mark) ?? worn[place].cond) <= 0 : worn[place].broken === true)) continue;
            let data;
            if (dry) { const before = conds.get(mark) ?? worn[place].cond; data = { before, now: stepDown(before, 1) }; conds.set(mark, data.now); }
            else data = ctx.call('gear.wear', { owner, slot: line.kind === 'foe' ? 'defence' : 'weapon', steps: 1, recorded: true })?.data ?? {};
            events.push({ n, who: line.pc.who, item: worn[place].name, from: condWord(data.before), to: condWord(data.now) });
            break;
        }
    }
    return events;
}

/**
 * Whether this roll won a fight against a foe group at least 10 levels above the party's highest (`legend` in the result): what the narrator's legendary
 * item lines wait for (`story.legendaryEarned`). Only a roll of the Levels rules (`levelled`) has levels to compare; the fight must have ended `won`.
 */
export function earnedLegend(dice, sheet, levelled) {
    if (!levelled || dice.stop !== 'won') return false;
    const party = Math.max(0, ...(sheet?.characters ?? []).map(character => character.level ?? 0));
    const lines = [...(dice.opening ?? []), ...dice.rounds.flatMap(round => round.lines)];
    const foes = Math.max(0, ...lines.filter(line => line.foe).map(line => line.foe.classValue ?? 0));
    return party > 0 && foes >= party + GAP;
}
