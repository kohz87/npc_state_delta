// The recovery kinds of the marked Character (the one templates-bars.js makes): the narrator's `add-xp` is gone (XP comes from won fights), Rest is the narrator's alone
// (no Short rest or Full rest button; a pin made with them keeps them for replay, shown nowhere), and the story gets `rest`, `full-rest` (not twice within 6 story hours: data-modules/part/act.js
// asks recovery.js) and `heal` (amount 1 to 3, one line per reply). Raising a bar by `set-*` is refused in act.js, not here (a size expression nests too deep).
// Pure: it only reshapes the definition it is given. A hidden field keeps the story minute of the last full rest.
import { RESTED_FIELD, RESTED_KNOWN } from '../data-modules/recovery.js';

const get = field => ['get', [field]];
const refill = bars => bars.map(bar => ({ op: 'set', path: [bar], value: get(`${bar}-blocks`) }));

const PROMPT = 'One character: who they are, health, stamina and mana (words, shown as bars), seven stats 1 to 20, points, Level 1 to 99 and XP to 100. The narrator may lower health, mana and stamina, '
    + 'never raise them: rest, full-rest (once in 6 story hours) and heal (amount 1 to 3) do. They die only when Down before a reply and still Down at its end. The reader sets stats and points; at 100 XP the Level rises, and every third Level gives a point.';

/** The Character definition (already scaled) with the recovery kinds, without `add-xp`. */
export function withRecovery(scaled) {
    const definition = structuredClone(scaled);
    delete definition.kinds['add-xp'];
    delete definition.kinds['button-rest'];
    Object.assign(definition.kinds, {
        rest: { op: '~', labels: {}, effects: refill(['stamina', 'mana']) },
        'full-rest': { op: '~', labels: {}, effects: refill(['health', 'stamina', 'mana']) },
        heal: { op: '~', labels: { amount: { type: 'int', min: 1, max: 3 } }, effects: [{ op: 'add', path: ['health'], value: ['arg', 'amount'], bounds: 'clamp' }] },
    });
    definition.state[RESTED_FIELD] = { type: 'int', min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER, default: 0, label: 'Last full rest', prompt: false, edit: false };
    definition.state[RESTED_KNOWN] = { type: 'bool', default: false, label: 'Full rest recorded', prompt: false, edit: false };
    definition.prompt = PROMPT;
    return definition;
}
