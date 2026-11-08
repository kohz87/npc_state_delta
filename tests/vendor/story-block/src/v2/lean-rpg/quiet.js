// The quiet reply (prompt diet, 3 Nov): the combat text, and the Foes grammar are told to the narrator only when they can be used,
// that is while a fight is open or when this reply has rolls (the board's, or an old planner record's). On any other reply they are left out of the static part:
//   * the Combat rules block (role `rules`): its text is not told, except its "XP guide:" line (what a deed is worth, that code gives XP for a won
//     fight, the practice range), which every reply keeps while the RPG is on;
//   * the Foes block (role `foes`): its description and the hurt and clear kinds are not told; the set-slot kind is, in one line, because a fight the
//     narrator opens on its own (the "No foes are set" note, cue.js OPEN_FIGHT_LINE) is written with it;
//   The `+ party` line is told on every reply (companions join in calm scenes).
// This is text only. Every kind stays declared in its block and every line is read as before (data-modules/part.js reads the definition, never the
// prompt), so a fight the narrator opens without a plan still parses, and so does a hurt or a clear line written on a quiet reply.
// An open fight is a filled foe group on the Foes block, standing or Down: a Down group stays there until the narrator clears it, and it needs the
// clear kind to do that. The prompt is made from the state the reply starts from (or, with rolls, the state they leave) and the rolls' answer,
// so the same reply rebuilt (a swipe that keeps its plan, a retried interceptor) gives the same prompt.
import { LEAN_RPG_FEATURE, ROLLS_SETTING } from './names.js';
import { readSheet } from './read.js';

/** What a quiet reply tells of a block, by its role: `skip` the whole block, else `prompt: false` leaves out its description and `only` keeps the kinds that match. */
export const QUIET_GRAMMAR = Object.freeze({
    rules: Object.freeze({ skip: true, keep: /XP guide:.*$/u }),
    foes: Object.freeze({ prompt: false, only: /^set-slot-\d+$/u }),
});

/** Whether a fight is open on the Foes block: a standing group. Down groups alone are a won fight: a new fight takes their slots (open.js), so they keep no combat text on a quiet reply. */
export const fightIsOpen = state => readSheet(state).foes.some(foe => foe.filled && foe.hurt > 0);

/**
 * Whether the prompt being built is a quiet reply. `hint` is what prompt.js assemble gives the static parts ({ view, rolled }); `values` the story module's
 * settings. Without a hint (a count, a tool) or with the RPG off it is never quiet; with Rolls off no rolls are made, so the fight is the
 * narrator's and the text stays.
 */
export function isQuiet(hint, state, values = {}) {
    const view = hint?.view;
    if (!hint || hint.rolled === true || typeof view?.feature !== 'function' || view.feature(LEAN_RPG_FEATURE) !== true) return false;
    if (values?.[ROLLS_SETTING] === 'off') return false;
    return !fightIsOpen(view.state ?? state);
}
