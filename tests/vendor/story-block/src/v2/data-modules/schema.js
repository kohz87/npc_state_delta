// Interpreter 1's closed authoring contract. Studio imports this and check.js directly;
// there is no editor-specific schema. Runtime budgets also belong to this version.
import { OPS } from '../capture.js';

const freeze = value => {
    if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
};

export const DATA_MODULES_CAPABILITY = 'data-modules-v1';
export const DM_LIMITS = freeze({
    interpreter: 1, definitions: 20, pins: 28, subjects: 16,
    definitionBytes: 32768, pinsBytes: 262144, instanceBytes: 16384,
    fields: 32, kinds: 16, rules: 32, timers: 8, templates: 16,
    expressionDepth: 6, expressionNodes: 64, effects: 16, imports: 8, offers: 64,
    rootVisits: 2048, replyRoots: 32, replyVisits: 16384,
    patchOps: 128, actionBytes: 8192, pinBytes: 131072,
    staticCharacters: 2000, tailTokens: 100,
    slug: 40, enumValues: 32, mapKeys: 16, text: 240, migrations: 4,
    elapsedMinutes: 525600, integer: 1000000000, errors: 20,
    // Added with the RPG (the frozen interpreter-1 basis in hash-basis-v1.js keeps its own copy): the block prompt cap,
    // the display names of a number field, and the card and reply-end functions of a block.
    prompt: 1200, names: 32, nameText: 40, cards: 4, replyEnd: 4, cardTitle: 60, cardText: 240,
    // A block with a `role` (a Character or Skills sheet) says more in the tail: five skills with what each does, or a character with who they are.
    roleTailTokens: 300,
    // A Skills block (role `skills`) holds up to eight skill slots of six fields each, their `who` and the signature mark: more than other blocks' 32 (names.js SKILL_SLOTS_MAX).
    // Its tail may be longer too, by 47 tokens for each skill it holds past five (tailRoom in part.js: the longest line one skill makes, measured).
    // A Skills block made with the types holds eleven slots (eight combat, three utility) of seven fields each (a `type` per slot), their `who` and the mark: 79 fields and a learn and
    // a practice line per slot, so `skillsFields` 80 and `skillsKinds` 22 (a block of the earlier eight slots is far inside both).
    skillsLegacyFields: 56, skillsFields: 80, skillsKinds: 22, skillTailTokens: 47,
    // A Foes block (role `foes`) holds up to six groups of three kinds each (set, hurt, clear): 18 kinds, two over the others' 16 (its fields, 24, are inside 32).
    foesKinds: 18,
    // The most stages a role block's bar field (health, mana, stamina, a foe's health) may have, counted up from 0.
    stages: 10,
    // The same for a character's bar that carries `scale: 2` (the doubled sizes, lean-rpg/templates-bars.js): the most it holds is 2 x (4 + 20/5) = 16 at the stat
    // maximum 20, so 17 stages (0 to 16); a test holds this to the template's own maximum.
    scaledStages: 17,
    // A List of entries field (`type: "entries"`): the sub-fields of one entry, the entries a story may add (default and most), and the longest `at` a line may write.
    entrySubs: 8, entriesDefault: 30, entriesMax: 50, entryAt: 60,
    // A block with a List of entries says more in the tail (its open entries by number and title): 250 tokens instead of 100.
    listTailTokens: 250,
});

export const DM_DIAGNOSTICS = freeze({
    DM_SCHEMA: 'Invalid data module definition or reference.',
    DM_BOUNDS: 'A value or arithmetic result is outside its declared bounds.',
    DM_LABEL: 'A line label or claim label is invalid.',
    DM_CONDITION: 'A condition must be boolean; a false kind condition refuses the line.',
    DM_BUDGET: 'The data module exceeds a version 1 budget.',
});

export const DM_DESCRIPTORS = freeze({
    definition: { required: ['slug', 'name', 'schema', 'stateVersion', 'scope', 'state', 'kinds'],
        optional: ['imports', 'rules', 'timers', 'rewards', 'exports', 'screens', 'layouts', 'migrations', 'prompt', 'show', 'role', 'cards', 'replyEnd', 'layout', 'roles', 'tones'] },
    defaults: { imports: {}, rules: [], timers: [], rewards: {}, exports: {}, screens: [], layouts: [], migrations: [] },
    scope: ['chat', 'character'],
    fields: {
        int: { required: ['type', 'min', 'max', 'default'], optional: ['edit', 'label', 'names', 'prompt', 'blocks', 'scale'] }, bool: { required: ['type', 'default'], optional: ['edit', 'label', 'prompt'] },
        enum: { required: ['type', 'values', 'default'], optional: ['edit', 'label', 'prompt'] }, text: { required: ['type', 'max', 'default'], optional: ['edit', 'list', 'label', 'prompt'] },
        map: { required: ['type', 'keys', 'values'], optional: ['edit', 'label', 'prompt'] },
        // A list of entries: `of` holds the sub-fields (text, int or enum, no `edit`/`prompt`/`label` of their own to speak of), `max` the most entries.
        entries: { required: ['type', 'of'], optional: ['max', 'edit', 'label', 'prompt'] },
    },
    // (`optional: true` on a label of an entries line: the line may leave it out)
    labels: { int: { required: ['type', 'min', 'max'], optional: ['names', 'optional'] }, bool: ['type'], enum: { required: ['type', 'values'], optional: ['optional'] }, text: { required: ['type', 'max'], optional: ['optional'] } },
    layouts: ['cards', 'bars', 'fields'],
    roleKeys: ['field', 'title', 'status', 'step'],
    toneNames: ['active', 'done', 'failed', 'neutral'],
    kind: { required: ['op', 'labels', 'effects'], optional: ['when', 'refusal', 'oncePerReply', 'ui', 'check', 'title'] },
    ops: [...OPS],
    effects: {
        set: { required: ['op', 'path', 'value'], optional: [] },
        add: { required: ['op', 'path', 'value'], optional: ['bounds'] },
        clamp: { required: ['op', 'path', 'min', 'max'], optional: [] },
        reward: { required: ['op', 'template', 'bind'], optional: [] },
        offer: { required: ['op', 'template', 'key', 'bind'], optional: [] },
        award: { required: ['op', 'offer'], optional: [] },
        // The three lines of a List of entries field: add an entry, change one (`at`: its number or title), drop one.
        entryAdd: { required: ['op', 'path'], optional: [] },
        entrySet: { required: ['op', 'path'], optional: [] },
        entryDrop: { required: ['op', 'path'], optional: [] },
    },
    arities: { get: 1, arg: 1, bind: 1, input: 2, reward: 1, check: 1, timer: 1,
        eq: 2, ne: 2, lt: 2, le: 2, gt: 2, ge: 2, and: 2, or: 2, not: 1,
        add: 2, sub: 2, mul: 2, min: 2, max: 2, floorDiv: 2, clamp: 3 },
    rule: { required: ['id', 'when', 'then'], optional: [] },
    // A card under the head reply (derived from its state, never stored) and a rule settled once at the end of each reply.
    card: { required: ['when', 'tone', 'title', 'text'], optional: ['id', 'type', 'button'] },
    cardTones: ['info', 'warn', 'end'],
    replyEnd: { required: ['when', 'effects'], optional: ['id', 'type'] },
    timer: { required: ['id', 'clock', 'every', 'effects'], optional: [] },
    reward: { required: ['bindings', 'values', 'effects'], optional: ['when'] },
    range: { required: ['min', 'max', 'pick'], optional: [] },
    rangeTable: { required: ['binding', 'table'], optional: [] },
    pick: ['min', 'max', 'midpoint'],
    import: { required: ['query', 'mode', 'projection'], optional: ['args'] },
    adapters: {
        'director.time': { modes: ['prefix', 'recorded'], projection: ['minutes'], args: [] },
        'checks.policy': { modes: ['prefix', 'recorded'], projection: ['actors.id', 'actors.name'], args: [] },
        'dataModules.public': { modes: ['prefix', 'recorded'], projection: null, args: ['module', 'export', 'who'] },
    },
    export: { required: ['fields'], optional: [] },
    migration: { required: ['from', 'to', 'add'], optional: [] },
    v11Effects: ['grantCoin', 'grantItem', 'grantXp'],
});

/** The effects that work a List of entries field (the interpreter reads the line's labels itself). */
export const DM_ENTRY_EFFECTS = Object.freeze(['entryAdd', 'entrySet', 'entryDrop']);
/** The tone a status value has unless the author changed it: active, done and failed by name, anything else neutral. */
export const dmDefaultTone = value => (['active', 'done', 'failed'].includes(value) ? value : 'neutral');
export const dmObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const dmOwn = (value, key) => dmObject(value) && typeof key === 'string' && Object.hasOwn(value, key);
export const dmSlug = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(value)
    && !['constructor', 'prototype', '__proto__'].includes(value);
export const dmInt = (value, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value)
    && Number.isSafeInteger(min) && Number.isSafeInteger(max) && value >= min && value <= max;
export const dmId = value => typeof value === 'string' && /^pack\.[a-z0-9][a-z0-9-]{0,39}\/[a-z0-9][a-z0-9-]{0,39}$/.test(value);

// --- Display names and hidden fields (the RPG's number names and `prompt: false`) -----------------------------------------
const foldName = text => String(text ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/** The display name of an int field's value: its `names` entry, or null. Stored values stay numbers. */
export const dmNameOf = (schema, value) => (schema?.type === 'int' && dmOwn(schema.names, String(value)) ? schema.names[String(value)] : null);

/** What a person (or the AI) is shown for a value: its name when it has one, else the value as it is. */
export const dmShown = (schema, value) => dmNameOf(schema, value) ?? (typeof value === 'string' ? value : String(value));

/** The number a name stands for (case-insensitive, spaces tidied), or null. */
export function dmValueOfName(names, text) {
    if (!dmObject(names)) return null;
    const wanted = foldName(text);
    if (!wanted) return null;
    const hit = Object.entries(names).find(([, name]) => foldName(name) === wanted);
    return hit ? Number(hit[0]) : null;
}

/** A field the narrator may not set (`prompt: false`): left out of the tail and the grammar. */
export const dmHidden = schema => dmObject(schema) && schema.prompt === false;

/**
 * Where a kind writes: the root field names of its effects (and of the effects of the reward templates it names), and whether
 * any path is computed (then it could be any field). Tolerates a definition that has not been checked.
 */
export function dmKindWrites(definition, kind) {
    const fields = new Set();
    let computed = false;
    const visit = (list, seen = new Set()) => {
        for (const effect of Array.isArray(list) ? list : []) {
            if (!dmObject(effect)) continue;
            if (['set', 'add', 'clamp'].includes(effect.op)) {
                if (Array.isArray(effect.path) && typeof effect.path[0] === 'string') fields.add(effect.path[0]);
                else computed = true;
            } else if ((effect.op === 'reward' || effect.op === 'offer') && typeof effect.template === 'string' && !seen.has(effect.template)) {
                seen.add(effect.template);
                visit(definition?.rewards?.[effect.template]?.effects, seen);
            }
        }
    };
    visit(kind?.effects);
    return { fields, computed };
}

/**
 * The room a story has for blocks: its own (`definitions`) and all active (`pins`). A reply captured before the `partyRoom` rule mark
 * (turn/rule-marks.js) keeps the earlier 8 and 16 on a Re-read, so an old refused join stays refused; every other caller gets the current room.
 * Bytes (`pinsBytes` 262144) cap it too: a companion's two blocks are about 29 KB, so about 8 fit by size before the block counts.
 */
export const DM_OLD_ROOM = freeze({ definitions: 8, pins: 16 });
export const dmRoom = ctx => (ctx?.cause === 'story' && ctx?.carrier && !ctx.carrier.rules?.includes('partyRoom') ? DM_OLD_ROOM : freeze({ definitions: DM_LIMITS.definitions, pins: DM_LIMITS.pins }));

/** Whether a kind writes a hidden field (or might, through a computed path while some field is hidden). */
export function dmKindWritesHidden(definition, kind) {
    const state = dmObject(definition?.state) ? definition.state : {};
    const anyHidden = Object.values(state).some(dmHidden);
    if (!anyHidden) return false;
    const { fields, computed } = dmKindWrites(definition, kind);
    return computed || [...fields].some(name => dmHidden(state[name]));
}

/** What an int field's `blocks` may say: a character's bar (its stored value counts the blocks left) or a foe group's health. */
export const DM_BLOCK_BARS = Object.freeze(['health', 'stamina', 'mana', 'foe']);

/**
 * The names a kind's int label shows: its own `names` (a label whose effect works the number out, as the Standard bars' stage words do),
 * else those of the int field a `set` effect copies it into (`value: ['arg', label]`), so a label needs no second copy of them. Null when
 * there are none.
 */
export function dmLabelNames(definition, kind, label) {
    if (kind?.labels?.[label]?.type === 'int' && dmObject(kind.labels[label].names)) return kind.labels[label].names;
    for (const effect of Array.isArray(kind?.effects) ? kind.effects : []) {
        if (effect?.op !== 'set' || !Array.isArray(effect.value) || effect.value[0] !== 'arg' || effect.value[1] !== label) continue;
        const field = Array.isArray(effect.path) && typeof effect.path[0] === 'string' && dmOwn(definition?.state, effect.path[0]) ? definition.state[effect.path[0]] : null;
        if (field?.type === 'int' && dmObject(field.names)) return field.names;
    }
    return null;
}
