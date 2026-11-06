// The fight board's fixed prompt pieces that need no RPG library: lean-rpg/board/prompt.js (the library) and part.js (which may
// preview the prompt before the library has loaded) both read these, so the two can never word them differently.
const RULES = Object.freeze({ skip: true, keep: /XP guide:.*$/u });
const FOES = Object.freeze({ prompt: false, only: /^set-slot-\d+$/u });

/** What the board keeps of a data module's grammar, by role (rules: only the XP guide line; foes: only the set-slot kind), or null. */
export const boardGrammar = role => role === 'rules' ? RULES : role === 'foes' ? FOES : null;

/** The XP guide line as the board tells it (code gives the XP, so the narrator writes none). */
export const boardXpGuide = text => String(text ?? '')
    .replace(/XP guide: code gives XP for a won fight(?: and practises rolled skills)?; write none for (?:them|it)\.\s*/u, 'XP guide: ');
