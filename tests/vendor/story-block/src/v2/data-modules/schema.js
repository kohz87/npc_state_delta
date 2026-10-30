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
    interpreter: 1, definitions: 8, pins: 16, subjects: 16,
    definitionBytes: 32768, pinsBytes: 262144, instanceBytes: 16384,
    fields: 32, kinds: 16, rules: 32, timers: 8, templates: 16,
    expressionDepth: 6, expressionNodes: 64, effects: 16, imports: 8, offers: 64,
    rootVisits: 2048, replyRoots: 32, replyVisits: 16384,
    patchOps: 128, actionBytes: 8192, pinBytes: 131072,
    staticCharacters: 2000, tailTokens: 100,
    slug: 40, enumValues: 32, mapKeys: 16, text: 240, migrations: 4,
    elapsedMinutes: 525600, integer: 1000000000, errors: 20,
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
        optional: ['imports', 'rules', 'timers', 'rewards', 'exports', 'screens', 'layouts', 'migrations', 'prompt', 'show'] },
    defaults: { imports: {}, rules: [], timers: [], rewards: {}, exports: {}, screens: [], layouts: [], migrations: [] },
    scope: ['chat', 'character'],
    fields: {
        int: { required: ['type', 'min', 'max', 'default'], optional: ['edit', 'label'] }, bool: { required: ['type', 'default'], optional: ['edit', 'label'] },
        enum: { required: ['type', 'values', 'default'], optional: ['edit', 'label'] }, text: { required: ['type', 'max', 'default'], optional: ['edit', 'list', 'label'] },
        map: { required: ['type', 'keys', 'values'], optional: ['edit', 'label'] },
    },
    labels: { int: ['type', 'min', 'max'], bool: ['type'], enum: ['type', 'values'], text: ['type', 'max'] },
    kind: { required: ['op', 'labels', 'effects'], optional: ['when', 'refusal', 'oncePerReply', 'ui', 'check', 'title'] },
    ops: [...OPS],
    effects: {
        set: { required: ['op', 'path', 'value'], optional: [] },
        add: { required: ['op', 'path', 'value'], optional: ['bounds'] },
        clamp: { required: ['op', 'path', 'min', 'max'], optional: [] },
        reward: { required: ['op', 'template', 'bind'], optional: [] },
        offer: { required: ['op', 'template', 'key', 'bind'], optional: [] },
        award: { required: ['op', 'offer'], optional: [] },
    },
    arities: { get: 1, arg: 1, bind: 1, input: 2, reward: 1, check: 1, timer: 1,
        eq: 2, ne: 2, lt: 2, le: 2, gt: 2, ge: 2, and: 2, or: 2, not: 1,
        add: 2, sub: 2, mul: 2, min: 2, max: 2, floorDiv: 2, clamp: 3 },
    rule: { required: ['id', 'when', 'then'], optional: [] },
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

export const dmObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const dmOwn = (value, key) => dmObject(value) && typeof key === 'string' && Object.hasOwn(value, key);
export const dmSlug = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(value)
    && !['constructor', 'prototype', '__proto__'].includes(value);
export const dmInt = (value, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value)
    && Number.isSafeInteger(min) && Number.isSafeInteger(max) && value >= min && value <= max;
export const dmId = value => typeof value === 'string' && /^pack\.[a-z0-9][a-z0-9-]{0,39}\/[a-z0-9][a-z0-9-]{0,39}$/.test(value);
