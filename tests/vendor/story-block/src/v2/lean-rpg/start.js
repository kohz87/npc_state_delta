// A new chat with the RPG on and no character yet (mockup sections 7 and 7b): what the chat remembers about it, in the chat's own metadata
// (`chatMetadata.storySuite.rpgStart`, saved with the chat; never game state, so a swipe or a rewind does not touch it).
//   hidden  the Home card's "Not now": the card stays away from this chat
//   asked   the reader has chosen "Send without the RPG for now": the first send is never held again in this chat
//   skip    the reply that follows that choice is sent with no dice; the pre-call takes it (skipOf) and the flag goes
// Pure over the metadata object it is given (null: nothing is read, nothing is written).

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** What the chat remembers: { hidden, asked, skip } (all false for a chat that has never been asked). */
export function startNotes(meta) {
    const notes = isRecord(meta) && isRecord(meta.storySuite) && isRecord(meta.storySuite.rpgStart) ? meta.storySuite.rpgStart : {};
    return { hidden: notes.hidden === true, asked: notes.asked === true, skip: notes.skip === true };
}

/** Writes some of them into `meta` (made on the way); → whether anything was written. */
export function setStartNotes(meta, patch) {
    if (!isRecord(meta)) return false;
    if (!isRecord(meta.storySuite)) meta.storySuite = {};
    if (!isRecord(meta.storySuite.rpgStart)) meta.storySuite.rpgStart = {};
    const notes = meta.storySuite.rpgStart;
    for (const key of ['hidden', 'asked', 'skip']) if (patch?.[key] !== undefined) {
        if (patch[key] === true) notes[key] = true;
        else delete notes[key];
    }
    if (!Object.keys(notes).length) delete meta.storySuite.rpgStart;
    return true;
}

/** What the pre-call asks: whether the next reply goes out with no dice (the reader chose "Send without the RPG for now"), and the flag let go once that reply is captured. */
export const skipOf = metadata => ({
    peek: () => { try { return startNotes(metadata()).skip; } catch { return false; } },
    clear: () => { try { const meta = metadata(); if (startNotes(meta).skip) setStartNotes(meta, { skip: false }); } catch { /* nothing to clear */ } },
});
