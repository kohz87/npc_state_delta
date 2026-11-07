// The per-reply cast step and portrait backfill: decides whether npc.tick is needed, syncs made cast dossiers, and asks for
// a missing portrait only when the host says one is due. Keeps the same send ordering and lastTick promise.

import { metWithEntry } from '../../cast-dossier.js';

export function createTurnPart(session, deps) {
    const {
        castMade, castPeople, castPortraitDue, castSync, enabled, keyAwayMemory, keyPeopleAnswer, part, send, TICK_TURNS, warn,
    } = deps;

    // ---- the per-reply step (npc.tick) ----

    function onTurn(turn) {
        if (!session.hosted || !TICK_TURNS.includes(turn?.type) || !enabled()) return;
        let wanted = false;
        try { wanted = part.tickWanted(); } catch { wanted = false; }
        // Key people (Story Director's): the step also keeps the memory of their last absence up to date.
        if (!wanted) wanted = (keyPeopleAnswer()?.length ?? 0) > 0 || Object.keys(keyAwayMemory()).length > 0;
        // The living cast: someone met whose dossier is not yet made, or a made one with a stage ladder of their own.
        if (!wanted) wanted = castWanted();
        if (!wanted) {
            // Nothing for the step to do: a cast dossier made while its picture was missing may still get it now.
            portraitFill();
            return;
        }
        session.lastTick = send('npc.tick', {}, { own: true }).then(async out => {
            await madeCastSync();
            return out;
        });
    }
    function castWanted() {
        const made = castMade();
        if (Object.values(made).some(record => record?.rungs > 0)) return true;
        const people = castPeople();
        return Array.isArray(people) && metWithEntry(people).some(person => !Object.hasOwn(made, person.key));
    }
    // After the step: Delta makes the dossiers of the people it has just recorded (index.js castSync), never twice at once.
    async function madeCastSync() {
        if (typeof castSync !== 'function') return;
        try { await castSync(); } catch (error) { warn('Story Suite v2 cast dossiers were not made', error); }
    }
    // A cast dossier made while its picture was missing gets the picture once Story Block answers for it (a pack imported without its pictures,
    // the pictures imported later). Asked when it can be: the step, the head changing, the host accepting Delta, the Dossiers tab drawn
    // (and the chat opening, index.js). Only when there is a picture to give, so nothing else is sent or saved.
    function portraitFill() {
        if (!session.hosted || typeof castSync !== 'function' || typeof castPortraitDue !== 'function') return;
        let due = false;
        try { due = castPortraitDue() === true; } catch { due = false; }
        if (due) void madeCastSync();
    }

    return { onTurn, portraitFill };
}
