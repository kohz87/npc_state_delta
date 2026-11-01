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
import { CLASS_NAMES, LEAN_RPG_FEATURE, RANK_NAMES, RESOLVE, ROLLS_SETTING, STAGES, STATS, stageWord } from './names.js';
import { isStandard, packRulesOf, plannerNoteOf, rulesFromSettings } from './rules.js';
import { NO_ROLLS_LINE } from './cue.js';
import { parsePlanAnswer } from './plan.js';
import { DICE_VERSION, claimKey, prepare } from './resolve.js';
import { readSheet } from './read.js';
import { SOUL_LABEL, soulShortOf } from './soul.js';

// (The query the roll record is read through: index.js ROLLS_QUERY, named here too so this file need not import its parent.)
const ROLLS_QUERY = 'rpg.rolls';

/** What the reader's instructions are called in the prompt. */
export const NOTE_LABEL = 'Reader\'s instructions:';
export const ANSWER_TOKENS = 250;
export const MESSAGE_LIMIT = 800;
export const EXCERPT_LIMIT = 600;

// The same text for every message of every chat, first in the prompt, so a provider's prompt cache can keep it.
export const PRECALL_HEAD = [
    'You plan the dice for one message in an interactive story. Answer with these fixed lines only, no other words:',
    'pace: careful | normal | all',
    `act <who> | skill: <skill> | stat: ${STATS.map(stat => stat.toUpperCase()).join('|')}? | target: <foe> | edge: <-3 to +3 and a short reason>?`,
    `act <who> | stat: ${STATS.map(stat => stat.toUpperCase()).join('|')} | target: <foe> | edge: <-3 to +3 and a short reason>?`,
    'foe <foe> | target: <who> | defend: <stat> | skill: <skill>?',
    'foe <foe> | hold',
    'check <who> | skill: <skill> | stat: <stat>? | difficulty: easy|normal|hard|very hard',
    'check <who> | stat: <stat> | difficulty: easy|normal|hard|very hard',
    'none',
    'Rules:',
    '- Roll only what is uncertain. Talk, questions, plans and safe actions: answer none.',
    '- In a fight, give every party member who is not Down an act (companions act on their own) and every foe a target or hold.',
    '- Use only the names listed. A skill brings its own stat and what it uses, so write no stat for a skill the character has; for a skill they lack, or with no skill, write the stat.',
    '- A foe line may name a skill of the defender, only when one plausibly fits defending (a parry, a dodge, a shield, a counter-draw); otherwise write no skill. It brings its own stat.',
    '- pace: careful when the reader moves slowly or carefully, all when they fight it out, else normal.',
    '- An edge is a small bonus or penalty the situation earns (an ambush +2, a trap -2).',
    '- Outside a fight a risky attempt (sneaking, persuading, climbing, lying) is a check with a difficulty.',
].join('\n');

// The same for the Standard formula (formula.js): the roll type decides the stat, so a line asks for a type, not a stat; the planner is told only
// what it must write. Classic keeps PRECALL_HEAD above, word for word.
export const PRECALL_HEAD_STANDARD = [
    'You plan the dice for one message in an interactive story. Answer with these fixed lines only, no other words:',
    'pace: careful | normal | all',
    'act <who> | skill: <skill>? | type: physical|magic|social|check | target: <foe, or an ally> | edge: <-3 to +3 and a short reason>? | area? | support: easy|normal|hard?',
    'foe <foe> | target: <who> | skill: <skill>? | magic?',
    'foe <foe> | hold',
    `check <who> | skill: <skill>? | type: social|check | fit: ${STATS.map(stat => stat.toUpperCase()).join('|')}? | difficulty: easy|normal|hard|very hard`,
    'none',
    'Rules:',
    '- Roll only what is uncertain. Talk, questions, plans and safe actions: answer none.',
    '- In a fight, give every party member who is not Down an act (companions act on their own) and every foe a target or hold.',
    '- Use only the names listed. A skill brings its own stat and what it uses: write no stat.',
    '- type: physical (blades, force), magic (spells, a skill that uses Mana), social (talk, bluff), check (the rest). area: hits every foe. support: heals or helps an ally. magic on a foe line: a spell.',
    '- fit: the stat a check leans on (STR climb, AGI sneak, DEX locks, INT lore, VIT endure).',
    '- A foe line may name a defender\'s skill only when it plausibly fits defending (a parry, a dodge, a shield); otherwise no skill.',
    '- pace: careful when the reader moves slowly or carefully, all when they fight it out, else normal.',
    '- An edge is a small bonus or penalty the situation earns (an ambush +2, a trap -2).',
    '- Outside a fight a risky attempt (sneaking, persuading, climbing, lying) is a check with a difficulty.',
].join('\n');

const word = (list, at) => (Number.isInteger(at) && at >= 0 && at < list.length ? list[at] : '?');

/** The party and foes in a few short lines for the pre-call. */
// A value the pack hides (`hidden` on an entry, review 160) still counts for the dice but is left out of these lines.
export function sheetText(sheet, { standard = false } = {}) {
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
            return parts.length ? `${skill.name} (${parts.join(', ')})` : skill.name;
        };
        const skills = entry.skills.length ? entry.skills.map(skillText).join(', ') : 'none';
        const down = entry.alive === false || (entry.health === 0 && shown('health')) ? ' DOWN' : '';
        const head = [shown('soul') ? `${soulShortOf(entry.soulLabel ?? SOUL_LABEL, 'class')} ${entry.soul >= 1 && entry.soul <= CLASS_NAMES.length && entry.soulWord ? entry.soulWord : word(CLASS_NAMES, entry.soul - 1)}` : ''].filter(Boolean).join('');
        const bars = [['health', 'Health', STAGES.health], ['mana', 'Mana', STAGES.mana], ['stamina', 'Stamina', STAGES.stamina]]
            .filter(([key]) => shown(key)).map(([key, label, words]) => `${label} ${barWord(key, words, entry)}`).join(', ');
        return `${entry.who}${head || down ? ` (${head}${down})` : ''}: ${[stats, bars].filter(Boolean).join('; ')}; skills: ${skills}`;
    });
    const foes = sheet.foes.filter(foe => foe.filled).map(foe => {
        const shown = part => !(foe.hidden ?? []).includes(part);
        const about = [shown('class') ? `class ${word(CLASS_NAMES, foe.class - 1)}` : '', shown('hurt') ? (foe.size ? stageWord(STAGES.health, foe.hurt, foe.size) : word(STAGES.health, foe.hurt)) : ''].filter(Boolean).join(', ');
        return `${foe.slot}. ${foe.name}${foe.count > 1 && shown('count') ? ` x${foe.count}` : ''}${about ? ` (${about})` : ''}`;
    });
    return `Party:\n${party.join('\n')}\nFoes: ${foes.length ? `\n${foes.join('\n')}` : 'none'}`;
}

/**
 * The pre-call's prompt: the static head, the reader's own instructions when they wrote any (`note`, Settings → RPG; after the
 * fixed part, which they cannot change), the sheet, the end of the last reply, then the reader's message.
 */
export function precallPrompt({ sheet, message, excerpt = '', note = '', standard = false }) {
    const tail = String(excerpt ?? '').trim(), extra = String(note ?? '').trim();
    return `${standard ? PRECALL_HEAD_STANDARD : PRECALL_HEAD}${extra ? `\n\n${NOTE_LABEL} ${extra}` : ''}\n\n${sheetText(sheet, { standard })}\n${tail ? `\nThe last reply ended:\n"""\n${tail.slice(-EXCERPT_LIMIT)}\n"""\n` : ''}\nThe reader's message:\n"""\n${clip(message, MESSAGE_LIMIT)}\n"""`;
}

// How far back a fight's turn order is looked for, in messages.
const ORDER_LOOKBACK = 12;

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
        return sheet.foes.some(foe => foe.filled) ? { lines: [NO_ROLLS_LINE] } : null;
    };

    async function plan(view, sheet, message, excerpt, rules) {
        const values = readSettings(view, moduleId);
        const standard = isStandard(rules);
        const prompt = precallPrompt({ sheet, message, excerpt, note: plannerNoteOf(values), standard });
        let answer;
        try {
            answer = await withTimeout(() => callModel(prompt, { maxTokens: ANSWER_TOKENS, profile: String(values[SETTING.profile] ?? ''), helper: 'rolls' }), timeoutMs, timer);
        } catch (error) {
            return { failed: error?.code === 'TIMEOUT' ? 'the planning call timed out.' : `the planning call failed (${String(error?.message ?? error).slice(0, 120)}).` };
        }
        const parsed = parsePlanAnswer(answer, sheet, { formula: standard ? 'standard' : 'classic' });
        if (parsed.error) return { failed: `the answer could not be read (${parsed.error}).` };
        if (parsed.none) return { plan: null, tokens: estimateTokens(prompt) };
        // A plan that names nothing this sheet can roll is the same as no plan.
        const ready = prepare(parsed.plan, sheet, rules);
        if (!ready.acts.length && !ready.foes.length && !ready.checks.length) return { plan: null, tokens: estimateTokens(prompt) };
        return { plan: parsed.plan, tokens: estimateTokens(prompt) };
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
        else {
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
        return planned.plan ? { commands: [{ type: RESOLVE, payload: { key, plan: planned.plan, rules, dice: DICE_VERSION, ...(order ? { order } : {}) } }] } : null;
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
