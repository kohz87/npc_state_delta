// Practice for the skills a reply's rolls used, given by code (stage 50).
//
// Every skill used in a reply's rolls, an act's or a check's skill and a defender's skill, is practised: the setting's practice per use (1 to 5, recorded with the roll), summed per
// skill and held to PRACTICE.max (20) a reply, the same 1..20 the Skills block's own practice line takes. Only a roll made WITH the skill counts: an
// untrained roll (a skill the character lacks, or one whose resource was Empty) names no skill in its line and gives nothing. Rank-ups follow the
// block's own rules (a skill at 100 practice rises a rank and starts again).
//
// How. `practiceHook` (the part's afterCapture) reads the reply's own roll (the `rpg.resolve` receipt, from a payload that carries `practice`; a roll made before has none and gives none, so past replies replay as recorded) and asks for guarded `rpg.practice { uses }` steps of at most 40 distinct skills,
// `uses` = [{ who, skill, n }]: the character, the skill as the roll named it, and how many lines used it; `perUse`: the practice one use gives, the value the roll recorded. The step is a guarded block on the reply
// (replan: a swipe or a delete takes it away, a Re-read plans it again, REPLAY.md), like the fight's XP.
//
// No double count: in that reply the narrator's own practice lines for the same skills are not used. The first story line of the reply that practised a
// slot kept what the slot's practice and rank were before it (data-modules/part.js, the reply's scratch `practiceFrom`); the step puts those back before
// it adds the code's practice, and one Problems line says so. A narrator's practice line for a skill the rolls did not use is untouched.
//
// The record (the step's receipt `data.v2.result.practice`): { skills: [{ who, skill, slot, amount, held? }] }.
//
// Story checks (checks/): the same file holds the reply's check step. `checksHook` (afterCapture) reads the reply's `? roll` lines (their `capture.roll`
// receipts) and its recorded dice (the `rpg.dice` receipt, which also holds the rules and the practice per use the reply was offered under: never today's settings)
// and asks for one guarded `rpg.check` step. It works the lines and gives their skills practice together, so a replan cannot leave practice attached to an old
// result. The lines it refused are one Problems line. No XP. `checksOf(receipts)` reads the results back for the card.
import { createEvaluation } from '../data-modules/interpreter.js';
import { CHECK_STEP, DICE, LEAN_RPG_FEATURE, PRACTICE, PRACTICE_STEP, RESOLVE, practiceOf } from './names.js';
import { skillFieldSlots } from '../skill-slots.js';
import { fold, readSheet, sameWho } from './read.js';
import { actorIdOf } from './roster.js';
import { diceOf, tableOf } from './checks/dice.js';
import { workChecks } from './checks/result.js';

/** The replies whose rolls are practised (the same as the fight's: not a Continue's, nor the extractor's late lines). */
const PAID_TYPES = Object.freeze(['normal', 'swipe', 'regenerate', 'reread']);
const USES_PER_STEP = 40;
/** Said once in a reply where the narrator wrote practice for a skill its rolls used (a Problems line). */
export const PRACTICE_HELD = 'Practice for skills used in rolls is given by code; the narrator\'s practice line was not used.';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const whole = value => Number.isSafeInteger(value);
const text = value => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
const pairKey = source => `${source?.sid}/${source?.swipeKey}`;

/**
 * The skills a roll record used: [{ who, skill, n }] in a fixed order (character, then skill). A line counts when it names a skill (an untrained
 * roll names none); an area attack, which is one line per foe it hits, counts once for a round. `result`: `data.v2.result` of an `rpg.resolve` receipt.
 */
export function usesOf(result) {
    const count = new Map();
    const note = (line, area) => {
        const skill = text(line?.skill), who = text(line?.pc?.who);
        if (!skill || !who) return;
        const key = `${fold(who)}\u0000${fold(skill)}`;
        const found = count.get(key) ?? { who, skill, n: 0, rounds: new Set() };
        if (area === undefined) found.n += 1;
        else if (!found.rounds.has(area)) { found.rounds.add(area); found.n += 1; }
        count.set(key, found);
    };
    const lines = (list, round) => { for (const line of Array.isArray(list) ? list : []) note(line, line?.area === true ? round : undefined); };
    lines(result?.checks, 'checks');
    lines(result?.opening, 'opening');
    (Array.isArray(result?.rounds) ? result.rounds : []).forEach((round, at) => lines(round?.lines, `r${at}`));
    return [...count.values()].sort((a, b) => fold(a.who).localeCompare(fold(b.who)) || fold(a.skill).localeCompare(fold(b.skill))).map(({ who, skill, n }) => ({ who, skill, n }));
}

/** The reply's roll that carries a practice per use: the last `rpg.resolve` receipt among `receipts`, its result, else null. */
export function rollOf(receipts) {
    const found = (Array.isArray(receipts) ? receipts : []).findLast(receipt => receipt?.type === RESOLVE && isObject(receipt.data?.v2?.result) && receipt.data.v2.result.v === 1);
    return found && practiceOf(found.data.v2.result.practice) !== null ? found.data.v2.result : null;
}

/**
 * The part's afterCapture: the step for the skills this reply's rolls used, else nothing. `info.receipts`: the reply's own receipts (turn.js passes them,
 * live or in a Re-read).
 */
export function practiceHook(view, info) {
    if (!PAID_TYPES.includes(info?.type ?? 'normal') || view?.feature?.(LEAN_RPG_FEATURE) !== true) return undefined;
    const roll = rollOf(info?.receipts);
    const uses = roll ? usesOf(roll) : [];
    if (!uses.length) return undefined;
    const commands = [];
    for (let at = 0; at < uses.length; at += USES_PER_STEP) {
        // Counts above 99 already reach the per-skill cap even at one practice per use.
        const batch = uses.slice(at, at + USES_PER_STEP).map(use => ({ ...use, n: Math.min(use.n, 99) }));
        commands.push({ type: PRACTICE_STEP, payload: { uses: batch, perUse: roll.practice } });
    }
    return { commands };
}

// The payload's uses, checked: a list of { who, skill, n } with n whole and at least 1. → the clean list, or null.
function usesFrom(value) {
    if (!Array.isArray(value) || !value.length || value.length > USES_PER_STEP) return null;
    const out = [];
    for (const entry of value) {
        if (!isObject(entry) || !text(entry.who) || !text(entry.skill) || !whole(entry.n) || entry.n < 1 || entry.n > 99) return null;
        out.push({ who: text(entry.who), skill: text(entry.skill), n: entry.n });
    }
    return out;
}

// The Skills block of a character and the slot of a skill in it, as readSheet joins them (the first block with that Who that holds a skill), or null.
function slotOf(domain, who, skill) {
    for (const module of Object.keys(isObject(domain?.active) ? domain.active : {}).sort()) {
        const definition = domain.pins?.[domain.active[module]?.hash]?.definition;
        const fields = domain.instances?.[module]?.chat?.fields;
        if (definition?.role !== 'skills' || !isObject(fields) || fold(text(fields.who)) !== fold(who)) continue;
        for (let slot = 1; slot <= skillFieldSlots(fields); slot += 1) {
            if (text(fields[`skill${slot}`]) && fold(text(fields[`skill${slot}`])) === fold(skill)) return { module, slot, name: text(fields[`skill${slot}`]) };
        }
        if (Array.from({ length: skillFieldSlots(fields) }, (_, i) => text(fields[`skill${i + 1}`])).some(Boolean)) return null;
    }
    return null;
}

// What the reply's story lines kept of the slots they practised: `perReply[<sid>/<swipeKey>].practiceFrom` = { [module]: { [slot]: { practice, rank } } }.
function fromOf(domain, source) {
    const out = {};
    const kept = domain?.perReply?.[pairKey(source)]?.practiceFrom;
    if (!isObject(kept)) return out;
    for (const [module, slots] of Object.entries(kept)) {
        if (!isObject(slots)) continue;
        for (const [slot, was] of Object.entries(slots)) {
            if (isObject(was) && whole(was.practice) && whole(was.rank)) (out[module] ??= {})[slot] = { practice: was.practice, rank: was.rank };
        }
    }
    return out;
}

// The skills the uses name, joined by slot: [{ module, slot, who, skill, n, practice, rank }] (a skill no longer on a sheet is left out), practice summed per slot.
function itemsOf(domain, uses) {
    const items = new Map();
    for (const use of uses) {
        const found = slotOf(domain, use.who, use.skill);
        if (!found) continue;
        const key = `${found.module}\u0000${found.slot}`;
        const fields = domain.instances[found.module].chat.fields;
        const item = items.get(key) ?? { module: found.module, slot: found.slot, who: use.who, skill: found.name, n: 0, practice: fields[`practice${found.slot}`], rank: fields[`rank${found.slot}`] };
        item.n += use.n;
        items.set(key, item);
    }
    return [...items.values()];
}

const witnessOf = (domain, source, uses) => ({ items: itemsOf(domain, uses), from: fromOf(domain, source) });

// Apply practice to the slots found before the guarded step; also undo the narrator's practice on those same slots.
function givePractice(ctx, domain, items, perUse) {
    if (!items.length) return [];
    const from = fromOf(domain, ctx.source);
    const draft = ctx.draft('dataModules');
    const skills = [];
    for (const item of items) {
        const definition = draft.pins?.[draft.active?.[item.module]?.hash]?.definition;
        const instance = draft.instances?.[item.module]?.chat;
        const fields = instance?.fields;
        if (!isObject(fields) || !whole(fields[`practice${item.slot}`])) continue;
        const was = from[item.module]?.[String(item.slot)];
        // What the narrator added for this skill in this reply (its practice, and the rank it rose to) is not used.
        const held = Boolean(was) && (fields[`practice${item.slot}`] !== was.practice || fields[`rank${item.slot}`] !== was.rank);
        const amount = Math.min(PRACTICE.max, perUse * item.n);
        if (isObject(definition?.state) && Array.isArray(definition.rules)) {
            const evaluation = createEvaluation(definition, instance, { inputs: {}, source: {}, cursor: null, subject: 'chat' });
            if (held) evaluation.effects([{ op: 'set', path: [`practice${item.slot}`], value: was.practice }, { op: 'set', path: [`rank${item.slot}`], value: was.rank }]);
            evaluation.effects([{ op: 'add', path: [`practice${item.slot}`], value: amount, bounds: 'clamp' }]);
            evaluation.rules();
            evaluation.finish();
        } else {
            // A bare block (no pinned rules to run): practice only, held to 0–100.
            if (held) { fields[`practice${item.slot}`] = was.practice; fields[`rank${item.slot}`] = was.rank; }
            fields[`practice${item.slot}`] = Math.max(0, Math.min(100, fields[`practice${item.slot}`] + amount));
        }
        skills.push({ who: item.who, skill: item.skill, slot: item.slot, amount, ...(held ? { held: true } : {}) });
    }
    return skills;
}

/** `rpg.practice { uses }`: the fight's guarded practice step, or NO_LONGER_DONE if no named skills remain. */
export function practiceStep(ctx, payload = {}) {
    if (ctx.cause !== 'system' || ctx.caller !== null) ctx.fail('REFUSED', 'Practice for rolled skills is given by Story Block after a reply, not by an action.');
    const uses = usesFrom(payload?.uses), perUse = practiceOf(payload?.perUse);
    if (!uses || perUse === null) ctx.fail('INVALID', 'The practice step needs the skills the rolls used.');
    const domain = ctx.read('dataModules');
    const items = itemsOf(domain, uses);
    if (!items.length) ctx.fail('NO_LONGER_DONE', 'None of the skills the rolls used is on a sheet any more.');
    const predicate = { kind: PRACTICE_STEP };
    const witness = witnessOf(domain, ctx.source, uses);
    ctx.replayGuard({ owner: ctx.module, version: 2, epoch: ctx.epoch, rulesHash: null, predicate, inputHash: ctx.hash({ source: ctx.source, predicate, witness }) }, { uses, perUse });
    const skills = givePractice(ctx, domain, items, perUse);
    const held = skills.some(entry => entry.held);
    return {
        summary: `Practice: ${skills.map(entry => `${entry.who}'s ${entry.skill} +${entry.amount}`).join(', ') || 'none to give'}.`, narrate: false, replan: true,
        data: { v2: { result: { practice: { skills } } } },
        ...(held ? { problem: PRACTICE_HELD } : {}),
    };
}

/** The replay guard of `rpg.practice` (leanRpgGuard routes it here): the step stands while the sheet numbers it used are what the prefix holds. */
export function practiceGuard({ state, hash }, { guard, source, recorded }) {
    const bad = reason => ({ ok: false, reason });
    try {
        const predicate = guard?.predicate;
        if (guard?.version !== 2 || guard.rulesHash !== null || !isObject(predicate) || predicate.kind !== PRACTICE_STEP || !isObject(recorded)) return bad('Malformed practice guard.');
        const uses = usesFrom(recorded.uses);
        if (!uses || practiceOf(recorded.perUse) === null) return bad('The practice step\'s skills were damaged.');
        const witness = witnessOf(state.domains?.dataModules, source, uses);
        if (hash({ source, predicate, witness }) !== guard.inputHash) return bad('The sheet before this step changed; Re-read this reply.');
        return { ok: true };
    } catch { return bad('Damaged practice record.'); }
}

// ---- Story checks ----

const OUTCOMES = ['success', 'cost', 'fail'];
const CHECK_LINES = 12;
const keptNumber = value => Number.isSafeInteger(value);
const keptText = value => typeof value === 'string' && value.length > 0 && [...value].length <= 80;

/** The party as checks/line.js reads it: the sheet's characters with the names the party module knows them by (`party.actors`: the block's actor, else the same name, else an alias that means one Character). `host` has a `query`. */
export function membersOf(host, sheet) {
    let actors = [];
    try {
        // (`recorded`: answered whatever Gear's switch says today, so a replan reads the party as the first run did)
        const given = host.query?.('party.actors', { recorded: true });
        if (Array.isArray(given)) actors = given.filter(actor => typeof actor?.id === 'string' && actor.id !== 'party');
    } catch { /* a party with no actor list: names only */ }
    return sheet.characters.map(character => {
        const named = actors.find(actor => actor.id === actorIdOf(character.module)) ?? actors.find(actor => fold(actor.name) === character.key)
            ?? actors.find(actor => sameWho(character, actor.name, actor.aliases, sheet.characters));
        const aliases = [...(named ? [named.name, ...(Array.isArray(named.aliases) ? named.aliases : [])] : [])].filter(value => typeof value === 'string' && value.trim());
        return { name: character.who, aliases, stats: character.stats, level: character.level, soul: character.soul,
            skills: character.skills.map(skill => ({ name: skill.name, stat: skill.stat, rank: skill.rank, type: skill.type ?? 'combat' })) };
    });
}

/**
 * The part's afterCapture for story checks: the reply's `? roll` lines (their `capture.roll` receipts) with the dice recorded with it (the `rpg.dice` receipt: the dice,
 * the rules and the practice per use it was offered under; today's settings are never read). → { commands } (the `rpg.check` step) or undefined (no roll line,
 * or the RPG is off). A reply's Story checks switch is not asked: the reply's own rule mark decided its lines (factory.js).
 */
export function checksHook(view, info) {
    if (!PAID_TYPES.includes(info?.type ?? 'normal') || view?.feature?.(LEAN_RPG_FEATURE) !== true) return undefined;
    const receipts = Array.isArray(info?.receipts) ? info.receipts : [];
    const lines = receipts.filter(receipt => receipt?.type === 'capture.roll' && typeof receipt.data?.check?.raw === 'string').map(receipt => receipt.data.check.raw).slice(0, CHECK_LINES);
    if (!lines.length) return undefined;
    const kept = receipts.findLast(receipt => receipt?.type === DICE)?.data?.v2?.dice;
    const dice = diceOf(kept);
    // The note's table is the contract: the step works each check at the bonuses the table showed (recorded in `table`). A Re-read keeps what the reply was worked with:
    // a reply whose earlier check step has no `table` stays on the sheet's bonuses, as it was.
    const old = info?.type === 'reread' ? (info.previous ?? []).filter(receipt => receipt?.type === CHECK_STEP).map(receipt => receipt.replan?.payload).find(isObject) : undefined;
    const table = dice && Array.isArray(kept?.table) && (!old || Array.isArray(old.table)) ? tableOf(kept.table) : null;
    return { commands: [{ type: CHECK_STEP, payload: { lines, dice, practice: true, ...(table ? { table } : {}) } }] };
}

// One recorded result, checked: the same plain record workChecks makes, or null.
function resultFrom(entry) {
    if (!isObject(entry) || !['who', 'what', 'stat', 'rankName', 'difficulty'].every(key => keptText(entry[key])) || !OUTCOMES.includes(entry.outcome)) return null;
    if (!['rank', 'dc', 'die', 'bonus', 'total'].every(key => keptNumber(entry[key]))) return null;
    const unlisted = entry.unlisted === 'member' || entry.unlisted === 'skill' ? { unlisted: entry.unlisted } : {};
    const practice = isObject(entry.practice) && keptText(entry.practice.skill) && entry.practice.n === 1 && keptNumber(entry.practiceGained) ? { practice: { skill: entry.practice.skill, n: 1 }, practiceGained: entry.practiceGained } : {};
    return { who: entry.who, what: entry.what, stat: entry.stat, utility: entry.utility === true, rank: entry.rank, rankName: entry.rankName, difficulty: entry.difficulty, dc: entry.dc, die: entry.die,
        bonus: entry.bonus, total: entry.total, outcome: entry.outcome, decisive: entry.decisive === true, ...unlisted, ...practice };
}

// The step's input as recorded: { lines, dice } (the narrator's lines and the dice, rules and practice recorded with the reply; dice null: none was offered), or null.
function inputOf(payload) {
    const lines = payload?.lines;
    if (!Array.isArray(lines) || lines.length > CHECK_LINES || !lines.every(line => typeof line === 'string' && line.length > 0 && line.length <= 200)) return null;
    const dice = payload.dice === null ? null : diceOf(payload.dice);
    if (payload.dice !== null && !dice) return null;
    if (payload.table !== undefined && (!Array.isArray(payload.table) || !dice)) return null;
    return { lines: [...lines], dice, ...(payload.practice === true ? { practice: true } : {}), ...(payload.table ? { table: tableOf(payload.table) } : {}) };
}

// What the results were worked from: every member of the party as the sheet now holds them (stats, level or class, every skill's stat, rank and type), so a line the step
// refused ("unknown skill", "unknown person") is planned again too when an earlier reply adds what it named. The replay guard asks it again. (A name the party module
// knows a member by, `party.actors`, is not something a guard may ask: an alias change alone does not plan the step again.)
const membersWitness = sheet => sheet.characters.map(found => ({ who: found.who, stats: found.stats, level: found.level, soul: found.soul, skills: found.skills.map(skill => [skill.name, skill.stat, skill.rank, skill.type ?? 'combat']) }));

// A narrator's practice line can rank up a skill before the check step runs. That line is undone for a checked skill, so use its previous rank when working the check as well.
function sheetBeforePractice(sheet, domain, source) {
    const from = fromOf(domain, source);
    return { ...sheet, characters: sheet.characters.map(character => ({ ...character, skills: character.skills.map(skill => {
        const slot = slotOf(domain, character.who, skill.name), was = slot && from[slot.module]?.[String(slot.slot)];
        return was ? { ...skill, rank: was.rank } : skill;
    }) })) };
}

/** `rpg.check`: works the checks and their practice in one guarded step. Older records without `practice` keep their separate practice step. */
export function checkStep(ctx, payload = {}) {
    if (ctx.cause !== 'system' || ctx.caller !== null) ctx.fail('REFUSED', 'Story checks are recorded by Story Block after a reply, not by an action.');
    const input = inputOf(payload);
    if (!input) ctx.fail('INVALID', 'The check step needs the reply\'s roll lines and its recorded dice.');
    const domain = ctx.read('dataModules'), sheet = readSheet({ domains: { dataModules: domain } });
    const checked = input.practice ? sheetBeforePractice(sheet, domain, ctx.source) : sheet;
    const { results, notes, uses } = workChecks(membersOf({ query: (name, args) => ctx.query(name, args) }, checked), input.lines, input.dice, input.table ?? null);
    const predicate = { kind: CHECK_STEP, input: ctx.hash(input), ...(input.practice ? { uses } : {}) };
    const witness = input.practice ? { members: membersWitness(sheet), practice: witnessOf(domain, ctx.source, uses) } : membersWitness(sheet);
    ctx.replayGuard({ owner: ctx.module, version: 2, epoch: ctx.epoch, rulesHash: null, predicate, inputHash: ctx.hash({ source: ctx.source, predicate, witness }) }, input);
    const skills = input.practice ? givePractice(ctx, domain, itemsOf(domain, uses), input.dice?.perUse) : [];
    const note = [...[...notes, ...(skills.some(entry => entry.held) ? [PRACTICE_HELD] : [])].join(' ')].slice(0, 300).join('');
    return { summary: '', narrate: false, replan: true, data: { v2: { checks: { v: 1, results }, ...(input.practice ? { result: { practice: { skills } } } : {}) } }, ...(note ? { problem: note } : {}) };
}

/** The replay guard of `rpg.check` (leanRpgGuard routes it here): the results stand while the party's sheet is what the prefix held when they were worked. */
export function checkGuard({ state, hash }, { guard, source, recorded }) {
    const bad = reason => ({ ok: false, reason });
    try {
        const predicate = guard?.predicate;
        if (guard?.version !== 2 || guard.rulesHash !== null || !isObject(predicate) || predicate.kind !== CHECK_STEP || !isObject(recorded)) return bad('Malformed check guard.');
        const input = inputOf(recorded);
        if (!input || hash(input) !== predicate.input) return bad('The check step\'s record was damaged.');
        if (input.practice && !Array.isArray(predicate.uses)) return bad('The check step\'s practice record was damaged.');
        const sheet = readSheet(state), witness = input.practice ? { members: membersWitness(sheet), practice: witnessOf(state.domains?.dataModules, source, predicate.uses) } : membersWitness(sheet);
        if (hash({ source, predicate, witness }) !== guard.inputHash) return bad('The party or a skill before these checks changed; Re-read this reply.');
        return { ok: true };
    } catch { return bad('Damaged check record.'); }
}

/** The story-check results a reply's receipts hold, excluding blocks that replay skipped. */
export function checksOf(receipts, problems = []) {
    const skipped = new Set((Array.isArray(problems) ? problems : []).flatMap(problem => Array.isArray(problem?.receipts) ? problem.receipts : []));
    const found = (Array.isArray(receipts) ? receipts : []).findLast(receipt => receipt?.type === CHECK_STEP && !skipped.has(receipt.id) && receipt.data?.v2?.checks?.v === 1 && Array.isArray(receipt.data.v2.checks.results));
    return found ? found.data.v2.checks.results.map(resultFrom).filter(Boolean) : [];
}
