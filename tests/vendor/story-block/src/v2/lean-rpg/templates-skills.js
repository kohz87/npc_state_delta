// The Skills block with the two types of skill ("combat" and "utility"): `typedSkills` turns the Skills definition as it was (templates.js `standardSkills`, eight slots, which stays
// frozen and has no `type` field) into the new one: three more slots (9 to 11, the utility ones), a `type<n>` field on every slot ("Used for"), the learn lines' optional `type` label
// (left out: combat) and the matching rank-up rules. A block with no `type1` field is read as all combat and keeps its eight slots; only a block made from this definition carries the
// types. Pure: no state, no randomness. (It does not import templates.js, which imports it.)
import { SKILL_FIELDS_MAX, SKILL_TYPES, SIGNATURE_FIELD } from '../skill-slots.js';

const PARTS = ['skill', 'about', 'stat', 'uses', 'rank', 'practice'];
const FROM_ONE = new RegExp(`"(${PARTS.join('|')})1"`, 'gu');
const slotted = (value, n) => JSON.parse(JSON.stringify(value).replace(FROM_ONE, `"$1${n}"`).replace(/"(learn|practice)-1"/gu, `"$1-${n}"`).replace(/"rank-up-1"/gu, `"rank-up-${n}"`));

/** The typed Skills definition made from `base` (the eight-slot one, with its learn guard if it has one). */
export function typedSkills(base, prompt) {
    const slots = Array.from({ length: SKILL_FIELDS_MAX }, (_, at) => at + 1);
    const definition = structuredClone(base);
    const relabel = (schema, n) => (typeof schema.label === 'string' ? { ...structuredClone(schema), label: schema.label.replace(/\d+$/u, String(n)) } : structuredClone(schema));
    definition.state = {
        who: base.state.who,
        ...Object.fromEntries(slots.flatMap(n => [...PARTS.map(part => [`${part}${n}`, relabel(base.state[`${part}1`], n)]),
            [`type${n}`, { type: 'enum', values: [...SKILL_TYPES], default: SKILL_TYPES[0], label: `Used for ${n}` }]])),
        [SIGNATURE_FIELD]: { ...base.state[SIGNATURE_FIELD], max: 2 ** SKILL_FIELDS_MAX - 1 },
    };
    definition.kinds = Object.fromEntries(slots.flatMap(n => {
        const learn = slotted(base.kinds['learn-1'], n), practice = slotted(base.kinds['practice-1'], n);
        learn.labels.type = { type: 'enum', values: [...SKILL_TYPES], optional: true };
        learn.effects.push({ op: 'set', path: [`type${n}`], value: ['arg', 'type'] });
        return [[`learn-${n}`, learn], [`practice-${n}`, practice]];
    }));
    definition.rules = slots.map(n => slotted(base.rules.find(rule => rule.id === 'rank-up-1'), n));
    if (prompt) definition.prompt = prompt;
    return definition;
}
