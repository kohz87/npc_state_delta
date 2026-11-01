// What the RPG settings page reads from the story, as plain data (no DOM): the chat's Combat rules block, the text it is reset
// to, the definition a changed text is saved as, the odds for the reader's own character under some numbers, and the roll
// planner's full prompt as it is built for this chat. The page (settings.js) draws them.

import { oneLine } from '../../../text.js';
import { CLASS_NAMES, RANK_NAMES } from '../names.js';
import { DIFFICULTIES, PRESETS, STANDARD_PRESETS, STANDARD_SETTING, formulaOf, isStandard, normalizeRules, normalizeStandard, oddsSubject, presetOf, rulesFromSettings, subjectOdds, CUSTOM_SETTING, DIFFICULTY_SETTING, difficultyOf } from '../rules.js';
import { fold, readSheet } from '../read.js';
import { precallPrompt } from '../precall.js';
import { COMBAT_PROMPT, COMBAT_PROMPT_STANDARD, templatesFor } from '../templates.js';
import { RPG_STRINGS, fill } from '../strings.js';
import { rpgBlocks } from './party-data.js';
import { SOUL_LABEL, soulShortOf } from '../soul.js';

const S = RPG_STRINGS.settings;

/** The most characters the Combat rules text may have (a block's "What it is for", data-modules/schema.js DM_LIMITS.prompt). */
export const COMBAT_MAX = 1200;

/** The text a Combat rules block starts with, as a block keeps it (one line). */
export const COMBAT_DEFAULT = oneLine(COMBAT_PROMPT);

/** The same for a chat on the Standard formula (its roll types and the bars code moves). */
export const COMBAT_DEFAULT_STANDARD = oneLine(COMBAT_PROMPT_STANDARD);

/** The default text under a formula's name ('standard' | 'classic'). */
export const combatDefault = formula => (formula === 'classic' ? COMBAT_DEFAULT : COMBAT_DEFAULT_STANDARD);

/** The chat's Combat rules block (the first block with the role `rules`): { module, definition, prompt } or null. */
export function combatBlock(state, { roleOf } = {}) {
    const block = rpgBlocks(state, { roleOf }).find(item => item.role === 'rules');
    return block ? { module: block.module, definition: block.definition, prompt: typeof block.definition.prompt === 'string' ? block.definition.prompt : '' } : null;
}

/**
 * The definition a changed text is saved as: the block's own pinned definition with a new `prompt` and nothing else changed
 * (the pin carries an `id` and a `pack` that a definition sent to `dm.redefine` must not have).
 */
export function withPrompt(definition, prompt) {
    const next = structuredClone(definition);
    delete next.id;
    delete next.pack;
    next.prompt = prompt;
    return next;
}

/** A fresh Combat rules definition for the formula (the Standard templates' text explains the roll types), for the "Add the Combat rules block" button. */
export const combatTemplate = (templates, formula = 'classic') => {
    // (`templates` is the Classic list a caller already holds; a Standard chat is made from the Standard list.)
    const entry = (formula === 'classic' ? templates : templatesFor(formula)).find(item => item.definition.role === 'rules');
    return entry ? structuredClone(entry.definition) : null;
};

/**
 * The Custom numbers as stored (each held to its range), else the numbers of the difficulty now (so a switch to Custom starts where the reader is).
 * Each formula keeps its own: Classic's six in `rpgCustom`, Standard's in `rpgStandard`.
 */
export const customOf = (values, pack = null) => (formulaOf(values, pack) === 'standard'
    ? normalizeStandard(values?.[STANDARD_SETTING] ?? (difficultyOf(values) === 'custom' ? null : rulesFromSettings(values, pack)))
    : normalizeRules(values?.[CUSTOM_SETTING] ?? (difficultyOf(values) === 'custom' ? null : rulesFromSettings({ ...values, rpgFormula: 'classic' }, pack))));

/**
 * The odds shown: `{ label, now: { success, cost, fail }, compare: [{ name, success, cost, fail }] }` for the reader's own
 * character (`own`, else the first Character block; their best skill) against a foe of their Soul Class, under `rules`, and the
 * same fight under each preset the reader has not chosen (all three for Custom). Null while the story has no character.
 */
export function oddsView(state, own, rules) {
    const sheet = readSheet(state);
    const standard = isStandard(rules);
    const subject = oddsSubject(sheet, own, { rankNames: RANK_NAMES, soulNames: CLASS_NAMES, fold, standard });
    if (!subject) return null;
    const words = { who: subject.who, stat: subject.stat.toUpperCase(), value: subject.statValue, dex: subject.stats?.dex ?? '?', soul: subject.soulName, rank: subject.rankName, label: soulLabelOfSheet(sheet, own), short: soulShortOf(soulLabelOfSheet(sheet, own), 'Class') };
    const chosen = presetOf(rules), presets = standard ? STANDARD_PRESETS : PRESETS;
    const text = standard ? (subject.skill ? S.oddsForStandard : S.oddsForStandardUntrained) : (subject.skill ? S.oddsFor : S.oddsForUntrained);
    return {
        label: fill(text, words),
        now: pick(subjectOdds(rules, subject)),
        compare: DIFFICULTIES.slice(0, 3).filter(name => name !== chosen).map(name => ({ name, ...pick(subjectOdds(presets[name], subject)) })),
    };
}

/** What the reader's own character calls the Soul Class (their name's Character block, else the first), else "Soul Class". */
export function soulLabelFor(state, own) {
    return soulLabelOfSheet(readSheet(state), own);
}
const soulLabelOfSheet = (sheet, own) => {
    const characters = sheet?.characters ?? [];
    const mine = own ? characters.find(entry => fold(entry.who) === fold(own)) : null;
    return (mine ?? characters[0])?.soulLabel ?? SOUL_LABEL;
};

const pick = ({ success, cost, fail }) => ({ success, cost, fail });

/** The roll planner's prompt as it is built for this chat now: the fixed part, the reader's words, the party and foes, and a stand-in for the next message. */
export function plannerPrompt(state, note, { standard = false } = {}) {
    return precallPrompt({ sheet: readSheet(state), message: S.plannerMessage, note, standard });
}
