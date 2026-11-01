// The RPG (suite-notes/SPEC_RPG.md): an optional part of Story Block's core module, behind the feature
// `story-block.rpg` (off by default; off means fully off, features.js). It reads the chat's
// RPG blocks (custom blocks whose definition has a `role`, see ROLES) and adds:
// - automatic rolls: a pre-call before the reply plans the actions, `rpg.resolve` rolls them as a
//   prelude block on the generated reply (a swipe rolls again, a Re-read keeps the dice);
// - the Party tab, the stat distribution view and the battle log (view/, loaded only when the feature is on);
// - "Changed this reply" lines for rolls and automatic level-ups.
//
// This file holds the shared interfaces the pieces build against and the part itself. The names live in
// names.js, the plan in plan.js, the sheet reader in read.js, the pre-call in precall.js, the roll in resolve.js
// (its header documents the `data.v2.result` record the battle log draws from) and the cue text in cue.js.
import { stCallModel, stChat, stChatId } from '../assist/st-adapter.js';
import { TIMEOUT_MS } from '../assist/common.js';
import { LEAN_RPG_FEATURE, RESOLVE, ROLLS, ROLLS_SETTING } from './names.js';
import { createPlanHold } from './plan.js';
import { JOIN_NO, joinCard, joinOffers, partyOf } from './join.js';
import { createPrecall } from './precall.js';
import { leanRpgGuard, resolve, rollsOf } from './resolve.js';
import { skipOf } from './start.js';

export * from './names.js';
export { CUSTOM_SETTING, DIFFICULTIES, DIFFICULTY_SETTING, FORMULA_SETTING, NOTE_MAX, NOTE_SETTING, PRESETS, RULE_KEYS, RULE_RANGES, STANDARD, STANDARD_FORMULA, STANDARD_PRESETS, STANDARD_RANGES, STANDARD_RULE_KEYS, STANDARD_SETTING, STAT_ABOVE, difficultyOf, formulaOf, isStandard, normalizeRules, packInForce, packRulesOf, normalizeStandard, oddsFor, oddsSubject, plannerNoteOf, presetOf, rulesFromSettings, sameRules, statShare, subjectOdds } from './rules.js';
export { createPlanHold, parsePlanAnswer, planIsEmpty, validatePlan } from './plan.js';
export { characterOf, fold, matchCharacter, matchFoe, matchName, matchSkill, readSheet } from './read.js';
export { NO_ROLLS_LINE, OUTCOME_WORD, cueText, fitCue, lineText } from './cue.js';
export { JOIN_ADD, JOIN_NO, checkJoin, joinCard, joinDefinitions, joinDraft, joinGrammar, joinMode, joinOffers, partyCap, partyOf, readJoin, soulOf } from './join.js';
export { setStartNotes, skipOf, startNotes } from './start.js';
export { PRECALL_HEAD, claimed, createPrecall, precallPrompt, sheetText } from './precall.js';
export { DICE_VERSION, RESULT_VERSION, claimKey, leanRpgGuard, outcomeOf, positionalDice, prepare, resolve, rollPrepared, rollsOf } from './resolve.js';

// How much longer the hook may take than the planner's call, for the work around it.
const HOOK_MARGIN_MS = 2000;

/** The part's setting (Story Block's own bucket): when the pre-call plans the rolls. */
export const DEFAULT_SETTINGS = Object.freeze({ [ROLLS_SETTING]: ROLLS[0] });

/** The offers a reply's `+ party` lines made under Ask (the card under the reply reads them): `rpg.joins { index? }` → [{ name, about, soul, best }] on the head reply (or the reply `index`). */
export const JOINS_QUERY = 'rpg.joins';

/** The query B reads a reply's rolls through: `rpg.rolls { index? }` → { receipt, result, summary } | null (the head reply by default). */
export const ROLLS_QUERY = 'rpg.rolls';

/**
 * The part merged into Story Block's core module (domains/index.js). `deps` (all optional):
 *   callModel(prompt, { maxTokens, profile, helper }) → text   (default: Assist's st-adapter; the runtime passes its queued call)
 *   chat() → SillyTavern's chat array, chatId() → its id        (default: st-adapter)
 *   metadata() → the chat's metadata object, for the held plan   (default: held in memory)
 *   problem(entry)                                              (the turn's Problems list; default: none)
 *   moduleId = 'story-block' (whose settings it reads), timeoutMs, timer
 * → { commands, queries, hooks, settings: { defaults }, guard }; `guard` is the replay guard for `rpg.resolve` blocks
 * (domains/index.js routes the guards of that predicate to it).
 */
export function createLeanRpgPart({ callModel = stCallModel, chat = stChat, chatId = stChatId, metadata = () => null, problem = null, moduleId = 'story-block', timeoutMs, timer } = {}) {
    const precall = createPrecall({ callModel, chat, chatId, hold: createPlanHold({ metadata }), problem, moduleId, timeoutMs, timer, skip: skipOf(metadata) });
    return {
        // A prelude: previewed before the reply and stored on it before its story lines (turn.js). Not tied to the
        // feature, so a Re-read of a reply that has rolls keeps them whatever the feature says now.
        commands: {
            [RESOLVE]: Object.assign((ctx, payload) => resolve(ctx, payload), { prelude: true, internal: true }),
            // "No" on a companion's card (join.js): the reader's answer, kept in the reply's own receipt like the offer it answers.
            [JOIN_NO]: Object.assign((ctx, payload) => {
                if (ctx.cause !== 'ui') ctx.fail('REFUSED', 'Only the reader answers a companion\'s card.');
                const name = typeof payload?.name === 'string' ? payload.name.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
                if (!name) ctx.fail('INVALID', 'Which companion?');
                return { summary: `No to ${name} joining the party.`, narrate: false, data: { join: { op: 'no', name } } };
            }, { feature: LEAN_RPG_FEATURE }),
        },
        // The card under the head reply for a companion who may join (join.js): read from the reply's own receipts, so it goes with the reply.
        cards: { 'rpg-join': { feature: LEAN_RPG_FEATURE, for: (state, _message, ctx) => joinCard(ctx?.query?.(JOINS_QUERY, Number.isInteger(ctx?.index) ? { index: ctx.index } : {}) ?? [], state) } },
        queries: {
            [JOINS_QUERY]: Object.assign((state, args, tools) => joinOffers(tools?.receipts?.() ?? [], Number.isInteger(args?.index) ? args.index : tools?.reply?.index, partyOf(state)), { feature: LEAN_RPG_FEATURE }),
            [ROLLS_QUERY]: Object.assign((_state, args, tools) => rollsOf(tools?.receipts?.() ?? [], Number.isInteger(args?.index) ? args.index : tools?.reply?.index), { feature: LEAN_RPG_FEATURE }) },
        // The planner's model call has its own limit (timeoutMs, Assist's 20 s by default); the hook is given a little longer, so
        // its own skip path (quiet ROLLS_SKIPPED, the no-rolls cue) runs on a slow answer and the turn's generic limit never cuts in.
        hooks: {
            beforeGenerate: Object.assign((view, info) => precall.beforeGenerate(view, info), { timeoutMs: (Number.isFinite(timeoutMs) ? timeoutMs : TIMEOUT_MS) + HOOK_MARGIN_MS }),
            afterCapture: view => { precall.afterCapture(view); },
            // Every reply, whatever else answers afterCapture and with or without change lines: the plan it used is let go.
            afterReceive: view => { precall.afterCapture(view); },
        },
        settings: { defaults: { ...DEFAULT_SETTINGS } },
        guard: leanRpgGuard,
    };
}
