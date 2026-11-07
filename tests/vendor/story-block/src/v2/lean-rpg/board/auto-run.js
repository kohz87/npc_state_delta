// Plays Auto exchanges on the staged board session, one ordinary exchange at a time.
// Each pick set goes through stageExchange like a reader's own choice, so replay, the log and XP see nothing special.
// It stops at the cap, a won or lost fight, or a hero badly hurt, and says why in one plain line.

import { autoPicks, autoStop, hurtHeroes } from './auto.js';
import { equipmentForBoard, playBoard } from './engine.js';
import { boardSession, stageExchange } from './session.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The one-line note under the log for why Auto stopped; `waiting` says whether a reply is held for "Send with this fight". */
export function autoNote({ stop, done, who = [], waiting = false } = {}) {
    const played = `Auto played ${plural(done, 'exchange')}`;
    const next = waiting ? 'Send to tell them, or keep fighting.' : 'Your next message tells them, or keep fighting.';
    if (stop === 'won') return `${played} and the fight is won.`;
    if (stop === 'lost') return `${played} and the party is down.`;
    if (stop === 'hurt') return `${played}. ${who.length ? `${who.join(' and ')} ${who.length === 1 ? 'was' : 'were'}` : 'A hero was'} badly hurt. ${next}`;
    if (stop === 'cap') return `${played} (the cap). ${next}`;
    if (stop === 'none') return `Auto found nothing to do after ${plural(done, 'exchange')}. ${next}`;
    return `${played}.`;
}

/**
 * runAuto({ meta, state, rules, cap, stage })
 * `cap` is the most exchanges this run may play (Infinity for "until the end"). `state` is the live sheet the staging reads.
 * → { done, stop, who, error? }. `stop` is 'won', 'lost', 'hurt', 'cap', 'none' (no pick to make) or 'error'.
 */
export function runAuto({ meta, state, rules, cap = 3, stage = stageExchange } = {}) {
    let done = 0, last = null;
    for (;;) {
        const session = boardSession(meta);
        if (!session) return { done, stop: 'error', who: [], error: 'There is no fight to play.' };
        const now = playBoard(state, session.setup, session.exchanges);
        if (now.error) return { done, stop: 'error', who: [], error: now.error };
        if (now.result.stop !== 'open') return { done, stop: now.result.stop, who: [] };
        if (done >= cap) return { done, stop: 'cap', who: [] };
        const gear = session.setup.gear ? equipmentForBoard(now.state, session.setup.gear) : {};
        const number = session.setup.offset + session.exchanges.length + 1;
        const picks = autoPicks({ state: now.state, setup: { ...session.setup, ...gear }, members: now.result.members, number }, rules);
        if (!picks.length) return { done, stop: 'none', who: [] };
        const staged = stage(meta, state, picks);
        if (staged.error) return { done, stop: 'error', who: [], error: staged.error };
        done += 1;
        last = staged.preview.result;
        const stop = autoStop(last, { cap, done });
        if (stop === 'hurt') return { done, stop, who: hurtHeroes(last) };
        if (stop) return { done, stop, who: [] };
    }
}
