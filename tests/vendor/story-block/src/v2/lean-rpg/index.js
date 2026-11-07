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
import { stChat } from '../assist/st-adapter.js';
import { AUTO_CAP, AUTO_CAP_SETTING, BOARD_SKILL, FIGHT, LEAN_RPG_FEATURE, LEVEL, LEVEL_CAP_SETTING, NOROLL, PRACTICE, PRACTICE_SETTING, PRACTICE_STEP, RESOLVE, ROLLS, ROLLS_SETTING } from './names.js';
import { noRoll } from './noroll.js';
import { fightHook, fightXp } from './fight.js';
import { RANK_QUERY, SETTINGS_SCHEMA, XP_RATE, XP_RATE_SETTING, rankQuery } from './levels.js';
import { practiceHook, practiceStep } from './practice.js';
import { JOIN_NO, joinCard, joinOffers, partyOf } from './join.js';
import { createPrecall } from './precall.js';
import { leanRpgGuard, resolve, rollsOf } from './resolve.js';
import { skipOf } from './start.js';
import { rosterQueries } from './roster.js';
import { createBoardPart } from './board/overrides.js';

export * from './names.js';
export { DIFFICULTIES, DIFFICULTY_SETTING, EARLIER_RULES, STANDARD, STANDARD_FORMULA, STANDARD_PRESETS, STANDARD_RANGES, STANDARD_RULE_KEYS, STANDARD_SETTING, difficultyOf, isStandard, normalizeRules, packInForce, packRulesOf, normalizeStandard, oddsFor, oddsSubject, presetOf, rulesFromSettings, sameRules, subjectOdds } from './rules.js';
export { classTerm, divisorOf, hasLevels, levelCapFor } from './rules.js';
export { classOfLevel, levelBonus, levelOfClass } from './formula.js';
export { planIsEmpty, validatePlan } from './plan.js';
export { characterOf, fold, matchCharacter, matchFoe, matchName, matchSkill, readSheet } from './read.js';
export { RANK_QUERY, SETTINGS_SCHEMA, XP_RATE, XP_RATE_SETTING, bandsOf, clampLevel, levelLabel, packLevelsOf, playerRankValue, rankNamed, rankOf, scaleXp, xpRateFrom, xpRateOf } from './levels.js';
export { FIGHT_XP_HELD, fightOf, memberXp, standingSlots } from './fight.js';
export { PRACTICE_HELD, practiceStep, usesOf } from './practice.js';
export { NO_ROLLS_LINE, OPEN_FIGHT_LINE, OUTCOME_WORD, cueOfResult, cueText, fitCue, lineText, receiptCue } from './cue.js';
export { QUIET_GRAMMAR, fightIsOpen, isQuiet } from './quiet.js';
export { JOIN_ADD, JOIN_NO, checkJoin, joinCard, joinDefinitions, joinDraft, joinGrammar, joinMode, joinOffers, partyCap, partyOf, readJoin, soulNaming, soulOf } from './join.js';
// What the data modules' companion steps (data-modules/part.js) reach through the loaded library (rpg-lazy.js).
export { RPG_EXTRAS, extraDefinitions, extraName, extrasPlan } from './view/wizard-data.js';
export { RPG_STRINGS } from './strings.js';
export { grownSkills } from './templates.js';
export { setStartNotes, skipOf, startNotes } from './start.js';
export { claimed, createPrecall } from './precall.js';
export { boardInputError } from './board/commit.js';
export { dropOf } from './ambush.js';
export { narratedFoeGrammar } from './board/narrated-grammar.js';
export { boardGrammar, boardReplyGrammar, boardXpGuide } from './board/prompt.js';
export { DICE_VERSION, FLOW_VERSION, RESULT_VERSION, claimKey, leanRpgGuard, outcomeOf, positionalDice, prepare, resolve, rollPrepared, rollsOf } from './resolve.js';

/** The part's setting (Story Block's own bucket): when the pre-call plans the rolls. */
export const DEFAULT_SETTINGS = Object.freeze({ [ROLLS_SETTING]: ROLLS[0], [PRACTICE_SETTING]: PRACTICE.perUse, [XP_RATE_SETTING]: XP_RATE.default, [LEVEL_CAP_SETTING]: LEVEL.max, [AUTO_CAP_SETTING]: AUTO_CAP.default });

/** The offers a reply's `+ party` lines made under Ask (the card under the reply reads them): `rpg.joins { index? }` → [{ name, about, soul, best }] on the head reply (or the reply `index`). */
export const JOINS_QUERY = 'rpg.joins';

/** The query B reads a reply's rolls through: `rpg.rolls { index? }` → { receipt, result, summary } | null (the head reply by default). */
export const ROLLS_QUERY = 'rpg.rolls';

/**
 * The part merged into Story Block's core module (domains/index.js). `deps` (all optional):
 *   chat() → SillyTavern's chat array                           (default: st-adapter)
 *   metadata() → the chat's metadata object, for the board's session and start notes   (default: none)
 *   moduleId = 'story-block' (whose settings it reads)
 *   rosterOn() → whether the RPG and Gear in fights are both on (the roster is answered only then, or when asked for `recorded`)
 *   persona() → the reader's name, for `party.pc` (default: none, the first block)
 * → { commands, queries, hooks, settings: { defaults }, guard }; `guard` is the replay guard for `rpg.resolve` blocks
 * (domains/index.js routes the guards of that predicate to it).
 */
export function createLeanRpgPart({ chat = stChat, metadata = () => null, moduleId = 'story-block', persona = () => '', rosterOn } = {}) {
    const precall = createPrecall({ chat, metadata, moduleId, skip: skipOf(metadata) });
    const board = createBoardPart();
    return {
        // A prelude: previewed before the reply and stored on it before its story lines (turn.js). Not tied to the
        // feature, so a Re-read of a reply that has rolls keeps them whatever the feature says now.
        commands: {
            ...board.commands,
            [RESOLVE]: Object.assign((ctx, payload) => resolve(ctx, payload), { prelude: true, internal: true }),
            // The note that a live fight's planner gave nothing usable, kept with the reply (noroll.js). Not tied to the feature either.
            [NOROLL]: Object.assign((ctx, payload) => noRoll(ctx, payload), { prelude: true, internal: true }),
            // XP for a won fight, a step after the reply's lines (fight.js). Not tied to the feature either: a Re-read keeps it.
            [FIGHT]: Object.assign((ctx, payload) => fightXp(ctx, payload), { internal: true }),
            // Practice for the skills a reply's rolls used, a step after the reply's lines (practice.js). Not tied to the feature either.
            [PRACTICE_STEP]: Object.assign((ctx, payload) => practiceStep(ctx, payload), { internal: true }),
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
            // The rank a level falls in, by the story's pack (levels.js): { level } → { name } | null.
            [RANK_QUERY]: Object.assign(rankQuery, { feature: LEAN_RPG_FEATURE }),
            [ROLLS_QUERY]: Object.assign((_state, args, tools) => rollsOf(tools?.receipts?.() ?? [], Number.isInteger(args?.index) ? args.index : tools?.reply?.index), { feature: LEAN_RPG_FEATURE }),
            // The party's members and the reader's own Character, from the Character blocks (roster.js; fallbacks: a module that answers them itself is asked instead).
            ...rosterQueries({ persona, on: rosterOn }) },
        hooks: {
            canGenerate: Object.assign((view, info) => precall.canGenerate(view, info), { feature: LEAN_RPG_FEATURE }),
            beforeGenerate: (view, info) => precall.beforeGenerate(view, info),
            afterCapture: (view, info) => {
                precall.afterCapture(view);
                // The fight's XP, then the rolled skills' practice: two steps after the reply's lines.
                const commands = [fightHook(view, info), practiceHook(view, info)].flatMap(out => out?.commands ?? []);
                return commands.length ? { commands } : undefined;
            },
            // Every reply, whatever else answers afterCapture and with or without change lines: the one-time "send without the RPG" flag goes.
            afterReceive: (view, info) => { precall.afterCapture(view); precall.afterReceive(info, view.state, (name, args) => view.query(name, { ...args, recorded: true })); },
        },
        settings: { defaults: { ...DEFAULT_SETTINGS }, schema: SETTINGS_SCHEMA },
        guard: leanRpgGuard,
    };
}
