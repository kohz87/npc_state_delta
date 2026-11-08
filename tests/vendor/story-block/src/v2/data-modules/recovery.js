// (data-modules/, not lean-rpg/: act.js reads it at page start, before the RPG loads.)
// Recovery and XP rules of a marked Character (the one with `scale: 2` on its bars): what the narrator's lines may and may not do, and the notes
// the reader sees when one is not used. Pure: no state is written here. A pin without the mark never reaches these checks, so old chats are untouched.
//
//   * `add-xp` from the story: not used (XP comes from won fights, by code; the reader's own edit stays).
//   * `set-health`, `set-stamina`, `set-mana` may lower a bar, never raise it (a rest, a full rest or a heal does that).
//   * `full-rest` from the story: not twice within 6 story hours for one character (no story clock: allowed).
const BAR_FIELDS = ['health', 'stamina', 'mana'];

/** Story hours between two full rests of one character. */
export const FULL_REST_HOURS = 6;
/** The hidden fields that keep the story minute of the character's last full rest. */
export const RESTED_FIELD = 'rested-at';
export const RESTED_KNOWN = 'rested-known';
/** The upward-set kinds and the bar each writes. */
export const SET_KINDS = Object.freeze({ 'set-health': 'health', 'set-stamina': 'stamina', 'set-mana': 'mana' });

/** Whether a Character definition carries the mark (all three bars `scale: 2`). */
export const isMarkedCharacter = definition => definition?.role === 'character'
    && BAR_FIELDS.every(bar => definition.state?.[bar]?.scale === 2);

const NAME = { health: 'Health', stamina: 'Stamina', mana: 'Mana' };
/** The notes (Problems lines), named for the character. */
export const recoveryNote = {
    xp: who => `${who}: XP comes from fights only, so this line was not used.`,
    raised: (who, bar) => (bar === 'health' ? `${who}: Health was not raised. It needs a full rest or a heal.`
        : `${who}: ${NAME[bar]} was not raised. A short rest refills it.`),
    fullRest: who => `${who}: full rest refused. The last one was under ${FULL_REST_HOURS} story hours ago.`,
};

/** Whether a story full rest is too soon: the clock reads `now` (story minutes, null = no clock) and `last` is the stored mark. */
export const fullRestTooSoon = (now, last, known = undefined) => Number.isSafeInteger(now) && Number.isSafeInteger(last)
    && (known === undefined ? last > 0 && now - (last - 1) < FULL_REST_HOURS * 60 : known === true && now - last < FULL_REST_HOURS * 60);
