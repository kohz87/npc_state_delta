// The interpreter-1 identity is a historical wire contract. These are the exact
// descriptors and limits from Story Block 2.6.1 (d5fdb46). Never edit this basis;
// a future interpreter must define its own versioned basis.
const freeze = value => {
    if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
};

const limits = {
    interpreter: 1, definitions: 8, pins: 16, subjects: 16,
    definitionBytes: 32768, pinsBytes: 262144, instanceBytes: 16384,
    fields: 32, kinds: 16, rules: 32, timers: 8, templates: 16,
    expressionDepth: 6, expressionNodes: 64, effects: 16, imports: 8, offers: 64,
    rootVisits: 2048, replyRoots: 32, replyVisits: 16384,
    patchOps: 128, actionBytes: 8192, pinBytes: 131072,
    staticCharacters: 2000, tailTokens: 100,
    slug: 40, enumValues: 32, mapKeys: 16, text: 240, migrations: 4,
    elapsedMinutes: 525600, integer: 1000000000, errors: 20,
};

const descriptors = {
    definition: { required: ['slug', 'name', 'schema', 'stateVersion', 'scope', 'state', 'kinds'],
        optional: ['imports', 'rules', 'timers', 'rewards', 'exports', 'screens', 'layouts', 'migrations'] },
    defaults: { imports: {}, rules: [], timers: [], rewards: {}, exports: {}, screens: [], layouts: [], migrations: [] },
    scope: ['chat', 'character'],
    fields: {
        int: ['type', 'min', 'max', 'default'], bool: ['type', 'default'],
        enum: ['type', 'values', 'default'], text: ['type', 'max', 'default'],
        map: ['type', 'keys', 'values'],
    },
    labels: { int: ['type', 'min', 'max'], bool: ['type'], enum: ['type', 'values'] },
    kind: { required: ['op', 'labels', 'effects'], optional: ['when', 'refusal', 'oncePerReply', 'ui', 'check'] },
    ops: ['+', '-', '~', '!', '?'],
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
};

export const HASH_BASIS_V1 = freeze({ interpreter: 1, descriptors, limits });
