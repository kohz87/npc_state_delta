// The pre-call (SPEC_RPG §2R A3): before a reply, one short model call reads the reader's latest message and a compact
// summary of the party and the foes, and answers a plan (plan.js) in a few fixed lines, or "none". Code then rolls it
// (resolve.js). It is the only planner: on by default, off with Settings → RPG → Rolls = off.
//
// It runs only when the feature is on, Rolls is automatic and the chat has a Character block; for a normal send, a
// regenerate or a swipe (never a Continue, an impersonation, a quiet prompt or a dry run); with a message to read. A
// timeout, a failed call or an answer that cannot be read means no rolls for this reply: a quiet line in the Problems
// list (Settings → Diagnostics), never a popup, and, while a fight is on, a tail line so the narrator keeps it undecided.
// The model call is Assist's (assist/st-adapter.js, or the host's queued one the runtime passes in) with Assist's
// connection profile and time limit; the answer is a plan, never a number.
import { SETTING, TIMEOUT_MS, clip, estimateTokens, hashText, normalizeType, withTimeout } from '../assist/common.js';
import { stripBlock } from '../capture.js';
import { GEAR_VERSION, gearIsOn, gearMarkOf } from './gear.js';
import { CLASS_NAMES, LEAN_RPG_FEATURE, LV_VERSION, PRACTICE, PRACTICE_SETTING, RANK_NAMES, practiceOf, RESOLVE, ROLLS_SETTING, STAGES, STATS, stageWord } from './names.js';
import { isStandard, packRulesOf, plannerNoteOf, rulesFromSettings } from './rules.js';
import { NO_ROLLS_LINE, OPEN_FIGHT_LINE } from './cue.js';
import { openLinesOf, parsePlanAnswer } from './plan.js';
import { openFoes, vetOpen, FIX_VERSION } from './open.js';
import { averageLevel, foeLabel, foeRandom, partyLevels, pickLevel } from './foes.js';
import { DICE_VERSION, FLOW_VERSION, claimKey, prepare } from './resolve.js';
import { dropOf } from './ambush.js';
import { readSheet } from './read.js';
import { plannerWanted } from './gate.js';
import { SOUL_LABEL, soulShortOf } from './soul.js';

// The query that names a level's rank (LV-C: `rpg.rank { level }` → `{ name } | null`); without it a level has no rank.
const RANK_QUERY = 'rpg.rank';
const averageOf = sheet => averageLevel(partyLevels(sheet));

// (The query the roll record is read through: index.js ROLLS_QUERY, named here too so this file need not import its parent.)
const ROLLS_QUERY = 'rpg.rolls';

/** What the reader's instructions are called in the prompt. */
export const NOTE_LABEL = 'Reader\'s instructions:';
export const ANSWER_TOKENS = 250;
export const MESSAGE_LIMIT = 800;
export const EXCERPT_LIMIT = 600;
/** The most of a skill's own description the planner is shown. */
export const ABOUT_LIMIT = 70;

const STAT_LIST = STATS.map(stat => stat.toUpperCase()).join('|');
const DIFFICULTY = 'difficulty: easy|normal|hard|very hard';
const EDGE = 'edge: <-3 to +3, reason>?';
const THEN_ELSE = 'then: <skill>? | else: <skill>? | guard: <skill>?';
// (Prompt diet: one line shape per kind and one short line per rule. The shapes are what plan.js reads; the words around them only tell the model when to use them.)
const OPENING = 'Plan dice for one message of an interactive story. Reply with these lines only:';
const SHARED_RULES = [
    '- Roll only what is uncertain; talk and safe actions: none.',
    '- In a fight each party member not Down acts (companions alone), each foe targets or holds.',
    '- A foe the message or scene names but the list lacks: new (never invent); level or rank only if the story says.',
];
const TAIL_RULES = [
    '- Defending with a skill (evade, dodge, parry, block): guard: that skill on the act; else leave it out.',
    '- Skills ordered "A, then B": skill: A, then: B (B from round 2).',
    '- pace: careful if the reader is careful, all if they fight it out. edge: trap -2.',
    '- A skill used before a fight to get the drop (hide, sneak, lure, distract, slip behind; judge by its description) is a check with that skill and ambush, in the same plan as the attack. No ambush edge without one.',
    '- Outside a fight a risky attempt (sneak, persuade, climb) is a check.',
];
const FOE_NEW = 'foe <name> | new | count: <1-12> | level: <1-99>? | rank: <name>?';

// The same text for every message of every chat, first in the prompt, so a provider's prompt cache can keep it.
export const PRECALL_HEAD = [
    OPENING,
    'pace: careful|normal|all',
    `act <who> | skill: <skill>? | stat: ${STAT_LIST}? | target: <foe> | ${EDGE} | ${THEN_ELSE}`,
    'foe <foe> | target: <who> | defend: <stat> | skill: <skill>?',
    'foe <foe> | hold',
    FOE_NEW,
    `check <who> | skill: <skill>? | stat: <stat>? | ${DIFFICULTY} | ambush?`,
    'none',
    'Rules:',
    ...SHARED_RULES,
    '- Use listed names only. A skill brings its stat: give a stat only for a skill the character lacks, or none.',
    ...TAIL_RULES,
].join('\n');

// The same for the Standard formula (formula.js): the roll type decides the stat, so a line asks for a type, not a stat. Classic keeps PRECALL_HEAD above.
export const PRECALL_HEAD_STANDARD = [
    OPENING,
    'pace: careful|normal|all',
    `act <who> | skill: <skill>? | type: physical|magic|social|check | target: <foe or ally> | ${EDGE} | area? | support: easy|normal|hard? | ${THEN_ELSE}`,
    'foe <foe> | target: <who> | skill: <skill>? | magic?',
    'foe <foe> | hold',
    FOE_NEW,
    `check <who> | skill: <skill>? | type: social|check | fit: ${STAT_LIST}? | ${DIFFICULTY} | ambush?`,
    'none',
    'Rules:',
    ...SHARED_RULES,
    '- Use listed names only. A skill brings its own stat; leave the stat out.',
    '- type: physical (blades), magic (spells, mana), social (talk, bluff), check (rest). area: all foes. support: heals or helps. magic on a foe: a spell.',
    '- fit: the stat a check leans on (STR climb, AGI sneak, INT lore).',
    '- else: the skill to use when the first runs out of Mana or Stamina.',
    ...TAIL_RULES,
].join('\n');

const word = (list, at) => (Number.isInteger(at) && at >= 0 && at < list.length ? list[at] : '?');

/** The party and foes in a few short lines for the pre-call. */
// A value the pack hides (`hidden` on an entry, review 160) still counts for the dice but is left out of these lines.
export function sheetText(sheet, { standard = false, rankAt = null } = {}) {
    // The Standard formula's bars are blocks: the narrator-facing word is the block count spread over the bar's size (names.js stageWord).
    // (A bar is read as the block itself holds it: a block of the Standard formula says its size and the value is blocks left; a Classic block's
    // value is the stage itself, whichever formula the chat plays, so the word is never worked out from a size the block does not have.)
    const barWord = (key, words, entry) => (entry.size ? stageWord(words, entry[key], entry.size[key]) : word(words, entry[key]));
    const party = sheet.characters.map(entry => {
        const shown = key => !(entry.hidden ?? []).includes(key);
        const stats = STATS.filter(shown).map(stat => `${stat.toUpperCase()} ${entry.stats[stat] ?? '?'}`).join(' ');
        const skillText = skill => {
            const open = part => !(skill.hidden ?? []).includes(part);
            const parts = [open('rank') ? word(RANK_NAMES, skill.rank) : '', skill.stat && open('stat') ? skill.stat.toUpperCase() : '', skill.uses === 'mana' && open('uses') ? 'mana' : ''].filter(Boolean);
            // What the skill does, cut short: the planner judges from it whether a skill sets up a fight (an ambush check).
            const about = skill.about && open('about') ? clip(skill.about.replace(/\s+/g, ' ').trim(), ABOUT_LIMIT) : '';
            const inside = [parts.join(', '), about].filter(Boolean).join(': ');
            return inside ? `${skill.name} (${inside})` : skill.name;
        };
        const skills = entry.skills.length ? entry.skills.map(skillText).join(', ') : 'none';
        const down = entry.alive === false || (entry.health === 0 && shown('health')) ? ' DOWN' : '';
        // (A block with a Level field: "Astra (Lv 14)". An earlier block keeps its Soul Class.)
        const head = entry.levelled ? (shown('level') ? `Lv ${entry.level}` : '') : [shown('soul') ? `${soulShortOf(entry.soulLabel ?? SOUL_LABEL, 'class')} ${entry.soul >= 1 && entry.soul <= CLASS_NAMES.length && entry.soulWord ? entry.soulWord : word(CLASS_NAMES, entry.soul - 1)}` : ''].filter(Boolean).join('');
        const bars = [['health', 'Health', STAGES.health], ['mana', 'Mana', STAGES.mana], ['stamina', 'Stamina', STAGES.stamina]]
            .filter(([key]) => shown(key)).map(([key, label, words]) => `${label} ${barWord(key, words, entry)}`).join(', ');
        return `${entry.who}${head || down ? ` (${head}${down})` : ''}: ${[stats, bars].filter(Boolean).join('; ')}; skills: ${skills}`;
    });
    // (Down groups are beaten and left out: the planner lists a new group of that name as new, and it takes the slot, open.js)
    const foes = sheet.foes.filter(foe => foe.filled && foe.hurt > 0).map(foe => {
        const shown = part => !(foe.hidden ?? []).includes(part);
        const about = [(foe.levelled ? shown('level') : shown('class')) ? foeLabel(foe.level, rankAt) : '', shown('hurt') ? (foe.size ? stageWord(STAGES.health, foe.hurt, foe.size) : word(STAGES.health, foe.hurt)) : ''].filter(Boolean).join(', ');
        return `${foe.slot}. ${foe.name}${foe.count > 1 && shown('count') ? ` x${foe.count}` : ''}${about ? ` (${about})` : ''}`;
    });
    return `Party:\n${party.join('\n')}\nFoes: ${foes.length ? `\n${foes.join('\n')}` : 'none'}`;
}

/**
 * The pre-call's prompt: the static head, the reader's own instructions when they wrote any (`note`, Settings → RPG; after the
 * fixed part, which they cannot change), the sheet, the end of the last reply, then the reader's message.
 */
export function precallPrompt({ sheet, message, excerpt = '', note = '', standard = false, rankAt = null }) {
    const tail = String(excerpt ?? '').trim(), extra = String(note ?? '').trim();
    return `${standard ? PRECALL_HEAD_STANDARD : PRECALL_HEAD}${extra ? `\n\n${NOTE_LABEL} ${extra}` : ''}\n\n${sheetText(sheet, { standard, rankAt })}\n${tail ? `\nThe last reply ended:\n"""\n${tail.slice(-EXCERPT_LIMIT)}\n"""\n` : ''}\nThe reader's message:\n"""\n${clip(message, MESSAGE_LIMIT)}\n"""`;
}

// How far back a fight's turn order is looked for, in messages.
const ORDER_LOOKBACK = 12;

/**
 * The drop a successful ambush check gave in the reply right before this one, when that reply's roll had no fight to use it in (ambush.js): read from that
 * reply's own receipt, so a replay and a swipe see the same. It goes on in the payload and is spent on this roll's acts, once; if this reply has no roll
 * the next one looks at a reply without a drop, so it is gone.
 */
export function carriedDrop(view, index) {
    let found = null;
    try { found = view.query?.(ROLLS_QUERY, { index: index - 1 }) ?? null; } catch { found = null; }
    return dropOf(found?.result);
}

/**
 * The turn order of the fight this reply goes on with: the order recorded by the nearest earlier reply that has rolls (a roll with no order,
 * checks only, is passed over), as the short list resolve.js takes; null when there is none. `index`: the reader's message this reply answers.
 */
export function carriedOrder(view, index) {
    for (let at = index - 1; at >= 0 && at >= index - ORDER_LOOKBACK; at -= 1) {
        let found = null;
        try { found = view.query?.(ROLLS_QUERY, { index: at }) ?? null; } catch { found = null; }
        const order = found?.result?.order;
        if (Array.isArray(order) && order.length) return order.map(({ id, name, total, die, bonus, agi, party, left }) => ({ id, name, total, ...(Number.isSafeInteger(die) ? { die } : {}), ...(Number.isSafeInteger(bonus) ? { bonus } : {}), agi, party, ...(Number.isSafeInteger(left) && left >= 0 ? { left } : {}) }));
        if (found) return null;
    }
    return null;
}

const readSettings = (view, moduleId) => {
    try {
        const values = typeof view?.settings === 'function' ? view.settings(moduleId) : null;
        return values && typeof values === 'object' ? values : {};
    } catch { return {}; }
};

/** Whether `state` already holds this message's rolls (its claim). */
export const claimed = (state, key) => state?.meta?.claims?.[claimKey(key)] === true;

/**
 * The pre-call. `deps`: { callModel(prompt, { maxTokens, profile, helper }) → text, chat() → SillyTavern's chat array,
 * chatId() → the open chat's id, hold (plan.js createPlanHold), problem(entry) (the turn's Problems list), moduleId,
 * timeoutMs, timer, skip { peek() → whether the next reply is to go out with no dice, clear() } (start.js: "Send without the RPG for now") }. Returns { beforeGenerate(view, info) → { commands, lines? } | { lines } | null, afterCapture(view) }.
 */
export function createPrecall({ callModel, chat, chatId, hold, problem = null, moduleId = 'story-block', timeoutMs = TIMEOUT_MS, timer, skip: noDice = { peek: () => false, clear: () => {} } }) {
    const skip = (sheet, message) => {
        try { problem?.({ module: moduleId, code: 'ROLLS_SKIPPED', quiet: true, message: `Rolls skipped for this reply: ${message} Swipe to try again.` }); } catch { /* the Problems list is optional */ }
        // While a fight is on the narrator is told to keep it undecided; outside one there is nothing to hold back.
        if (sheet.foes.some(foe => foe.filled && foe.hurt > 0)) return { lines: [NO_ROLLS_LINE] };
        return noFight(sheet);
    };
    // No foe is filled in and nothing was rolled: if a fight starts in this reply, the narrator sets the Foes line and stops at the first clash.
    // (a block of Down groups only is a won fight: no fight is on)
    const noFight = sheet => (sheet.foes.length && !sheet.foes.some(foe => foe.filled && foe.hurt > 0) ? { lines: [OPEN_FIGHT_LINE] } : null);

    async function plan(view, sheet, message, excerpt, rules) {
        const values = readSettings(view, moduleId);
        const standard = isStandard(rules);
        // The ranks a pack names (`rpg.rank`, `{ level }` → `{ name } | null`), when something answers it: the foes' lines say "Rank E · Lv 14", a new foe's rank has a band.
        const rankAt = level => { try { return view.query?.(RANK_QUERY, { level }) ?? null; } catch { return null; } };
        const prompt = precallPrompt({ sheet, message, excerpt, note: plannerNoteOf(values), standard, rankAt });
        let answer;
        try {
            answer = await withTimeout(() => callModel(prompt, { maxTokens: ANSWER_TOKENS, profile: String(values[SETTING.profile] ?? ''), helper: 'rolls' }), timeoutMs, timer);
        } catch (error) {
            return { failed: error?.code === 'TIMEOUT' ? 'the planning call timed out.' : `the planning call failed (${String(error?.message ?? error).slice(0, 120)}).` };
        }
        // Foes the planner lists as new (open.js): the ones the reader's message or the reply before names are put on a copy of the Foes block, and the
        // plan is read against that copy, so its lines may target them. They are added for real only when the plan is rolled (resolve.js).
        const wanted = openLinesOf(answer);
        let open = [], looked = sheet;
        if (wanted.length && view.state?.domains?.dataModules) {
            const vetted = vetOpen(wanted, sheet, [message, excerpt], { rankAt }).open;
            // (The foes are put on the copy at a provisional level, only so the plan can be read against them; the level they are rolled at is drawn from the reply's seed.)
            const domain = structuredClone(view.state.domains.dataModules);
            const placed = openFoes(domain, vetted.map((entry, at) => ({ name: entry.name, count: entry.count, level: pickLevel(entry, averageOf(sheet), foeRandom(0, at)) })));
            if (placed.length) {
                const kept = new Set(placed.map(entry => entry.name));
                open = vetted.filter(entry => kept.has(entry.name));
                looked = readSheet({ domains: { dataModules: domain } });
            }
        }
        const parsed = parsePlanAnswer(answer, looked, { formula: standard ? 'standard' : 'classic' });
        if (parsed.error) return { failed: `the answer could not be read (${parsed.error}).` };
        if (parsed.none) return { plan: null, tokens: estimateTokens(prompt) };
        // A plan that names nothing this sheet can roll is the same as no plan.
        const ready = prepare(parsed.plan, looked, rules);
        if (!ready.acts.length && !ready.foes.length && !ready.checks.length) return { plan: null, tokens: estimateTokens(prompt) };
        return { plan: open.length ? { ...parsed.plan, open } : parsed.plan, tokens: estimateTokens(prompt) };
    }

    async function beforeGenerate(view, info = {}) {
        if (view?.feature?.(LEAN_RPG_FEATURE) !== true) return null;
        if (info?.commit === false) return null;
        if (!['normal', 'regenerate', 'swipe'].includes(normalizeType(info?.type))) return null;
        // The reader chose to send the first message without the RPG: that reply has no dice (the flag goes when the reply is captured).
        if (normalizeType(info?.type) === 'normal' && noDice.peek()) return null;
        if (readSettings(view, moduleId)[ROLLS_SETTING] === 'off') return null;
        const sheet = readSheet(view.state);
        if (!sheet.characters.length) return null;
        // The reader's message: the last one for a send or a regenerate, the one before the reply for a swipe.
        const messages = chat() ?? [];
        if (!messages.some(message => message && !message.is_user)) return null;
        const index = normalizeType(info?.type) === 'swipe' ? messages.length - 2 : messages.length - 1;
        const last = messages[index];
        if (!last?.is_user) return null;
        const text = String(last.mes ?? '').trim();
        if (!text) return null;
        const key = `${index}-${hashText(text)}`;
        if (claimed(view.state, key)) return null;
        const where = String(chatId() ?? '');
        // The numbers the dice are rolled with are fixed here, from the settings of this moment, and travel in the payload: the roll
        // (and every Re-read of it) uses these, whatever the settings say later (rules.js).
        // (A pack may say which formula its story plays on and its numbers; the reader's own settings win over it.)
        let pack = null;
        try { pack = packRulesOf(view.query?.('packs.content', { kind: 'rpg' })); } catch { pack = null; }
        const rules = rulesFromSettings(readSettings(view, moduleId), pack);
        // A retried interceptor (the same generation, never captured) keeps its plan; any new generation plans anew.
        const held = info?.again === true ? hold.peek(where, key) : null;
        let planned;
        if (held) planned = { plan: held.plan };
        else if (!plannerWanted(sheet, text, messages[index - 1] && !messages[index - 1].is_user ? stripBlock(String(messages[index - 1].mes ?? '')) : '')) {
            // (The planner gate, gate.js: a quiet message with no fight open asks nothing. The decision depends only on the sheet and the message, so a
            // swipe or a retry reaches the same one; it is held like an answer of "none".)
            hold.clear();
            hold.put(where, key, null);
            planned = { plan: null };
        } else {
            hold.clear();
            const before = messages[index - 1];
            const excerpt = before && !before.is_user ? stripBlock(String(before.mes ?? '')) : '';
            planned = await plan(view, sheet, text, excerpt, rules);
            if (planned.failed) return skip(sheet, planned.failed);
            hold.put(where, key, planned.plan);
        }
        // A Standard fight keeps its turn order across replies: the nearest earlier reply's order goes on in the payload (resolve.js), so a swipe of
        // this reply rolls this reply's dice again and keeps the order the fight began with.
        const order = isStandard(rules) && planned.plan ? carriedOrder(view, index) : null;
        // Gear in fights (gear.js): while the switch is on the roll carries only the version mark (and the reader's name as `lead`); `rpg.resolve` works out what each member has on and carries
        // from the state before the roll, so a change before it (a reply deleted or edited) changes its gear.
        const drop = planned.plan ? carriedDrop(view, index) : null;
        const gear = planned.plan && gearIsOn(sheet, (name, args) => view.query?.(name, args)) ? gearMarkOf({ v: GEAR_VERSION, lead: String(last.name ?? '') }) : null;
        return planned.plan ? { commands: [{ type: RESOLVE, payload: { key, plan: planned.plan, rules, dice: DICE_VERSION, flow: FLOW_VERSION, fix: FIX_VERSION, lv: LV_VERSION, practice: practiceOf(readSettings(view, moduleId)[PRACTICE_SETTING]) ?? PRACTICE.perUse, ...(order ? { order } : {}), ...(drop ? { ambush: drop } : {}), ...(gear ? { gear } : {}) } }] } : noFight(sheet);
    }

    // The reply is captured: its plan has been used, so the hold is let go (best effort; a new generation clears it anyway). Whether
    // the feature is still on does not matter: a reader may switch it off while the reply is on its way, and clearing a hold that is
    // not there writes nothing.
    function afterCapture() {
        hold.clear();
        noDice.clear();
    }

    return { beforeGenerate, afterCapture };
}
