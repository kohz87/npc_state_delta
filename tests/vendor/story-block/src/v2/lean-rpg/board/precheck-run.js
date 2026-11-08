// The foe pre-check's part that talks to the world (precheck.js is the pure reading): when a typed attack finds no foe standing, ask the Assist
// profile once (20 s at most) for the groups, hold them to the Foes rules, and build the opening the old planner's prelude recorded
// (`rpg.resolve` with `plan.open`), so replay, Re-read and rebuild read the recorded payload and never ask a model again.
// A timeout, an error, an unreadable answer or no group gives nothing: the send goes on as it does without the pre-check.
import { SETTING, withTimeout } from '../../assist/common.js';
import { DICE_VERSION, FLOW_VERSION } from '../resolve.js';
import { FIX_VERSION, LV_VERSION, PRACTICE, PRECHECK_LIMIT_MS, PRECHECK_SETTING, practiceOf, PRACTICE_SETTING } from '../names.js';
import { looksLikeAttack, parsePrecheck, precheckPrompt, vetGroups } from './precheck.js';

const ANSWER_TOKENS = 300;

/** Whether this message should be pre-checked at all: the setting, a typed attack, a standing foe or not. */
export const wantsPrecheck = (values, sheet, message) => values?.[PRECHECK_SETTING] !== false && sheet.characters.length > 0
    && !sheet.foes.some(foe => foe.filled && foe.hurt > 0) && looksLikeAttack(message);

/**
 * One Assist call → the vetted groups `[{ name, count, level? }]`, or [] (timeout, failure, nothing readable).
 * `callModel(prompt, { maxTokens, profile, helper, timeoutMs })` is the host's queued Assist call.
 */
export async function runPrecheck({ callModel, message, previous = '', sheet, values = {}, limit = PRECHECK_LIMIT_MS, timer }) {
    if (typeof callModel !== 'function') return [];
    try {
        const prompt = precheckPrompt({ message, previous, sheet });
        const answer = await withTimeout(() => callModel(prompt, { maxTokens: ANSWER_TOKENS, profile: String(values[SETTING.profile] ?? ''), helper: 'precheck', timeoutMs: limit }), limit, timer);
        return vetGroups(parsePrecheck(answer), { message, previous, sheet });
    } catch { return []; }
}

/** The opening to record: the groups only, no acts and no foes' turns (the board plays the fight). `lv` lets resolve settle a level the pre-check left out. */
export function openingPayload({ groups, key, rules, anchor, values = {} }) {
    return { key, plan: { formula: 'standard', pace: 'normal', open: groups, acts: [], foes: [], checks: [] }, rules, dice: DICE_VERSION, flow: FLOW_VERSION, fix: FIX_VERSION, lv: LV_VERSION,
        practice: practiceOf(values[PRACTICE_SETTING]) ?? PRACTICE.perUse, start: anchor };
}
