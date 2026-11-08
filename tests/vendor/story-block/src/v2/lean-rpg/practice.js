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
import { createEvaluation } from '../data-modules/interpreter.js';
import { LEAN_RPG_FEATURE, PRACTICE, PRACTICE_STEP, RESOLVE, practiceOf } from './names.js';
import { skillFieldSlots } from '../skill-slots.js';
import { fold } from './read.js';

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

/**
 * `rpg.practice { uses }`: practises the skills the reply's rolls used (see the top). A system step after the reply's lines; NO_LONGER_DONE when none of
 * the skills is on a sheet any more.
 */
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
