// (data-modules/, not lean-rpg/: act.js reads it at page start, before the RPG loads.)
// Recovery and XP rules of a marked Character (the one with `scale: 2` on its bars): what the narrator's lines may and may not do, and the notes
// the reader sees when one is not used. Pure: no state is written here. A pin without the mark never reaches these checks, so old chats are untouched.
//
//   * `add-xp` from the story: not used (XP comes from won fights, by code; the reader's own edit stays).
//   * `set-health`, `set-stamina`, `set-mana` may lower a bar, never raise it (a rest, a full rest or a heal does that).
//   * `full-rest` from the story: not twice within 6 story hours for one character (no story clock: allowed).
//   * The recovery line (restLine): one line after a marked Character's own lines, outside the prompt and grammar caps; each clause only when the pin offers that
//     kind as a story kind and its effects are the standard ones. The pin is never touched.
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

/** The two reader buttons an earlier marked Character was pinned with: never drawn now; their recorded lines still replay (part/act.js). */
export const hasRestButtons = definition => isMarkedCharacter(definition) && ['button-rest', 'button-full-rest'].every(kind => definition.kinds?.[kind]?.ui);

const refills = (kind, bars) => !Object.keys(kind.labels ?? {}).length && JSON.stringify(kind.effects) === JSON.stringify(bars.map(bar => ({ op: 'set', path: [bar], value: ['get', [`${bar}-blocks`]] })));
/** A recovery kind a pin offers as a story kind (a screen does not own it), or null. */
const storyKind = (definition, name) => (Object.hasOwn(definition?.kinds ?? {}, name) && definition.kinds[name]?.ui !== true ? definition.kinds[name] : null);
/** "1 to 3" from the heal kind's real label bounds when it only adds that amount to health; '' otherwise. */
const healBounds = kind => {
    const amount = kind?.labels?.amount, [effect, ...more] = kind?.effects ?? [];
    return kind && Object.keys(kind.labels).length === 1 && amount?.type === 'int' && Number.isSafeInteger(amount.min) && Number.isSafeInteger(amount.max) && amount.min >= 1 && amount.max >= amount.min
        && !more.length && JSON.stringify(effect) === JSON.stringify({ op: 'add', path: ['health'], value: ['arg', 'amount'], bounds: 'clamp' }) ? `${amount.min} to ${amount.max}` : '';
};

/** The one line that says what each recovery kind restores (views.js grammarFor adds it after a marked Character's lines); '' when no kind qualifies. */
export const restLine = definition => {
    const rest = storyKind(definition, 'rest'), full = storyKind(definition, 'full-rest'), heal = healBounds(storyKind(definition, 'heal'));
    const shortRest = rest && refills(rest, ['stamina', 'mana']), fullRest = full && refills(full, ['health', 'stamina', 'mana']);
    const clauses = [shortRest ? 'rest (an hour or two) refills mana and stamina' : '',
        fullRest ? `full-rest (a night's sleep, once in ${FULL_REST_HOURS} story hours) ${shortRest ? 'also health' : 'refills health, stamina and mana'}` : '',
        heal ? `heal (${heal}) only health` : ''].filter(Boolean);
    return clauses.length ? `Recovery: ${clauses.join('; ')}.` : '';
};

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
