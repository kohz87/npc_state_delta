/* NPC State Delta checkpoint packing for sidecar format version 2: pure functions that turn the in-memory
   checkpoint array (one full snapshot per entry) into its on-disk form and back. Entries are full (the newest
   replies, every anchor turn, chain heads, stalled chains, and any entry whose patch does not verify or does not
   save bytes) or packed: an RFC 6902 patch, restricted to add/replace/remove, against an earlier entry's rebuilt
   image. Entries without a plain `snapshot` object are stored verbatim and never serve as a base. No I/O, no
   clock, no randomness, no module-level state; imports nothing. storage-payload.js is the only caller. The
   in-memory checkpoints keep their shape: packing happens at the file boundary only. */

export const PACK_SCHEME = 'chain-rfc6902';
export const PACK_DEFAULTS = Object.freeze({ anchorEvery: 25, fullTail: 4, maxChainEntries: 80 });

export class PackError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PackError';
    }
}

const PATCH_OPS = new Set(['add', 'replace', 'remove']);
const ARRAY_INDEX = /^(0|[1-9]\d*)$/;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Own-property write. Plain assignment of a key named __proto__ would set the prototype instead.
function setOwn(object, key, value) {
    Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
}

// Copy of an entry with one key renamed (in the same position) and its value replaced.
function withKey(entry, fromKey, toKey, value) {
    const result = {};
    for (const key of Object.keys(entry)) {
        if (key === fromKey) setOwn(result, toKey, value);
        else setOwn(result, key, entry[key]);
    }
    return result;
}

function jsonImage(value) {
    const text = JSON.stringify(value);
    if (text === undefined) throw new PackError('checkpoint value is not JSON-serializable');
    return JSON.parse(text);
}

function escapeToken(key) {
    return String(key).replace(/~/g, '~0').replace(/\//g, '~1');
}

// RFC 6901 pointer for the token stack (plus one more token when given).
function pointerOf(tokens, last) {
    let out = '';
    for (const token of tokens) out += `/${escapeToken(token)}`;
    return last === undefined ? out : `${out}/${escapeToken(last)}`;
}

function parsePointer(path) {
    if (typeof path !== 'string' || (path !== '' && path[0] !== '/')) throw new PackError('patch path must be a JSON Pointer');
    if (path === '') return [];
    return path.slice(1).split('/').map(token => {
        if (/~(?![01])/.test(token)) throw new PackError('invalid JSON Pointer escape');
        return token.replace(/~1/g, '/').replace(/~0/g, '~');
    });
}

function arrayIndex(array, token) {
    if (!ARRAY_INDEX.test(token) || Number(token) >= array.length) throw new PackError('patch array index is out of range');
    return Number(token);
}

// Walks one token down an existing path. Only own properties count, so "constructor/..." never resolves
// through the prototype chain.
function childOf(container, token) {
    if (Array.isArray(container)) return container[arrayIndex(container, token)];
    if (isObject(container) && Object.hasOwn(container, token)) return container[token];
    throw new PackError('patch path does not exist');
}

function operationValue(op) {
    if (!Object.hasOwn(op, 'value')) throw new PackError('patch operation needs a value');
    return structuredClone(op.value);
}

function applyAt(parent, key, op) {
    const isArray = Array.isArray(parent);
    if (!isArray && !isObject(parent)) throw new PackError('patch parent is not a container');
    if (op.op === 'remove') {
        if (isArray) throw new PackError('patch may not remove an array element');
        if (!Object.hasOwn(parent, key)) throw new PackError('patch removes a missing key');
        delete parent[key];
        return;
    }
    if (isArray) {
        const value = operationValue(op);
        if (op.op === 'add') {
            if (key !== '-') throw new PackError('patch may only append to an array with "-"');
            parent.push(value);
        } else {
            parent[arrayIndex(parent, key)] = value;
        }
        return;
    }
    if (op.op === 'add' && Object.hasOwn(parent, key)) throw new PackError('patch adds a key that already exists');
    if (op.op === 'replace' && !Object.hasOwn(parent, key)) throw new PackError('patch replaces a missing key');
    setOwn(parent, key, operationValue(op));
}

// Copy of a container, made at most once per applyJson call: the walk below copies only the containers on a patched path
// and shares everything else with `base` (never mutated, so sharing is safe). Cost is the patch, not the snapshot.
function ownCopy(container, copied) {
    if (copied.has(container)) return container;
    let copy;
    if (Array.isArray(container)) copy = container.slice();
    else {
        copy = {};
        for (const key of Object.keys(container)) setOwn(copy, key, container[key]);
    }
    copied.add(copy);
    return copy;
}

// Applies a restricted RFC 6902 patch to `base` by path copying. Never mutates its inputs; throws PackError on any
// operation, path or base that the generator would not produce. The result may share unchanged parts with `base`.
export function applyJson(base, ops) {
    if (base === undefined) throw new PackError('patch base is missing');
    if (!Array.isArray(ops)) throw new PackError('patch must be an array');
    const copied = new WeakSet();
    let root = base;
    for (const op of ops) {
        if (!isObject(op) || !PATCH_OPS.has(op.op)) throw new PackError('unsupported patch operation');
        const tokens = parsePointer(op.path);
        if (tokens.length === 0) {
            if (op.op !== 'replace') throw new PackError(`"${op.op}" needs a path`);
            root = operationValue(op);
            if (root !== null && typeof root === 'object') copied.add(root);
            continue;
        }
        if (root === null || typeof root !== 'object') throw new PackError('patch path does not exist');
        root = ownCopy(root, copied);
        let parent = root;
        for (const token of tokens.slice(0, -1)) {
            const child = childOf(parent, token);
            if (child === null || typeof child !== 'object') throw new PackError('patch path does not exist');
            const own = ownCopy(child, copied);
            if (own !== child) {
                if (Array.isArray(parent)) parent[Number(token)] = own;
                else setOwn(parent, token, own);
            }
            parent = own;
        }
        applyAt(parent, tokens[tokens.length - 1], op);
    }
    return root;
}

// Generator rules (section 1 of V2DESIGN, with the REV-v2design changes). Objects: the kept keys must keep their
// order and every new key must come after them; then removals, recursion into kept keys, appended adds.
// Arrays: a shorter target replaces the whole array; otherwise recurse per index and append the new tail with "-".
// Anything else (type change, changed primitive, reordered keys) is a replace of that path.
function diffImages(base, target, tokens, ops) {
    if (isObject(base) && isObject(target)) diffObjects(base, target, tokens, ops);
    else if (Array.isArray(base) && Array.isArray(target)) diffArrays(base, target, tokens, ops);
    else if (base !== target) ops.push({ op: 'replace', path: pointerOf(tokens), value: target });
    return ops;
}

// Recurse into one child; the pointer string is only built when an operation is emitted.
function diffChild(base, target, tokens, key, ops) {
    tokens.push(key);
    diffImages(base, target, tokens, ops);
    tokens.pop();
}

function diffObjects(base, target, tokens, ops) {
    const baseKeys = Object.keys(base);
    const targetKeys = Object.keys(target);
    // Common case, same keys in the same order: recurse per key with no set building.
    if (baseKeys.length === targetKeys.length && baseKeys.every((key, index) => key === targetKeys[index])) {
        for (const key of baseKeys) diffChild(base[key], target[key], tokens, key, ops);
        return;
    }
    const inBase = new Set(baseKeys);
    const inTarget = new Set(targetKeys);
    const kept = baseKeys.filter(key => inTarget.has(key));
    const keptInTarget = targetKeys.filter(key => inBase.has(key));
    const sameOrder = kept.every((key, index) => key === keptInTarget[index]);
    const newKeysLast = targetKeys.slice(0, kept.length).every(key => inBase.has(key));
    if (!sameOrder || !newKeysLast) {
        ops.push({ op: 'replace', path: pointerOf(tokens), value: target });
        return;
    }
    for (const key of baseKeys) {
        if (!inTarget.has(key)) ops.push({ op: 'remove', path: pointerOf(tokens, key) });
    }
    for (const key of kept) diffChild(base[key], target[key], tokens, key, ops);
    for (const key of targetKeys) {
        if (!inBase.has(key)) ops.push({ op: 'add', path: pointerOf(tokens, key), value: target[key] });
    }
}

function diffArrays(base, target, tokens, ops) {
    if (target.length < base.length) {
        ops.push({ op: 'replace', path: pointerOf(tokens), value: target });
        return;
    }
    for (let index = 0; index < base.length; index++) diffChild(base[index], target[index], tokens, String(index), ops);
    for (let index = base.length; index < target.length; index++) ops.push({ op: 'add', path: pointerOf(tokens, '-'), value: target[index] });
}

// Patch between two JSON-like values. An undefined-valued key counts as absent (both sides go through JSON).
export function diffJson(base, target) {
    return diffImages(jsonImage(base), jsonImage(target), [], []);
}

function fullReason(info, firstOfTurn, tailFrom, anchorEvery) {
    if (info.turn === null) return 'no-turn';
    if (tailFrom !== null && info.turn >= tailFrom) return 'tail';
    if (firstOfTurn && info.turn % anchorEvery === 0) return 'anchor';
    return null;
}

// Nearest earlier non-verbatim entry of the same parent lineage, else the nearest earlier non-verbatim entry.
function findBase(infos, index) {
    const parent = infos[index].parentLineageKey;
    if (parent !== undefined && parent !== null) {
        for (let j = index - 1; j >= 0; j--) {
            if (infos[j] && infos[j].lineageKey === parent) return j;
        }
    }
    for (let j = index - 1; j >= 0; j--) {
        if (infos[j]) return j;
    }
    return -1;
}

// Builds the patch and checks it the way the decoder will rebuild it. Null when it does not reproduce the
// entry's own JSON byte for byte (the entry then stays full).
function tryPatch(baseImage, info) {
    const ops = diffImages(baseImage, info.image, [], []);
    let rebuiltImage;
    try {
        rebuiltImage = applyJson(baseImage, ops);
    } catch (error) {
        if (error instanceof PackError) return null;
        throw error;
    }
    if (JSON.stringify(rebuiltImage) !== info.text) return null;
    return { ops, rebuiltImage, patchText: JSON.stringify(ops) };
}

function activeLineageSet(keys) {
    if (keys === undefined || keys === null) return null;
    if (!Array.isArray(keys) && !(keys instanceof Set)) throw new PackError('activeKeys must be an array or a Set');
    const set = new Set(keys);
    return set.size ? set : null;
}

function packSettings(options) {
    const settings = { ...PACK_DEFAULTS };
    for (const key of Object.keys(PACK_DEFAULTS)) {
        if (options[key] !== undefined) settings[key] = options[key];
        if (!Number.isInteger(settings[key]) || settings[key] < 1) throw new PackError(`${key} must be a positive integer`);
    }
    return settings;
}

// Returns { entries, packing, stats }. `entries` is the on-disk checkpoint array: full entries are the original
// objects, packed entries have their `snapshot` key replaced in place by `packed: {base, patch}`. Options:
// anchorEvery, fullTail, maxChainEntries (defaults PACK_DEFAULTS) and activeKeys (the active lineage's checkpoint
// keys; empty or absent means every entry counts as active when choosing the newest reply).
export function packCheckpoints(checkpoints, options = {}) {
    if (!Array.isArray(checkpoints)) throw new PackError('checkpoints must be an array');
    const settings = packSettings(options);
    const active = activeLineageSet(options.activeKeys);
    const infos = checkpoints.map(entry => {
        if (!isObject(entry)) return null;
        if (Object.hasOwn(entry, 'packed')) throw new PackError('checkpoint already uses the reserved "packed" key');
        if (!isObject(entry.snapshot)) return null;
        const text = JSON.stringify(entry.snapshot);
        const turn = entry.snapshot.turn;
        return {
            entry,
            text,
            image: JSON.parse(text),
            turn: typeof turn === 'number' && Number.isFinite(turn) ? turn : null,
            lineageKey: entry.lineageKey,
            parentLineageKey: entry.parentLineageKey,
        };
    });
    let newest = null;
    for (const info of infos) {
        if (!info || info.turn === null) continue;
        if (active !== null && !active.has(info.lineageKey)) continue;
        newest = newest === null ? info.turn : Math.max(newest, info.turn);
    }
    const tailFrom = newest === null ? null : newest - (settings.fullTail - 1);
    const count = checkpoints.length;
    const entries = new Array(count);
    const rebuilt = new Array(count);
    const chain = new Array(count).fill(0);
    const seenTurns = new Set();
    const stats = { entries: count, full: 0, packed: 0, verbatim: 0, reasons: {}, snapshotChars: 0, patchChars: 0 };
    const countReason = reason => {
        stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
    };
    for (let index = 0; index < count; index++) {
        const info = infos[index];
        if (!info) {
            entries[index] = checkpoints[index];
            stats.verbatim++;
            continue;
        }
        stats.snapshotChars += info.text.length;
        const firstOfTurn = info.turn !== null && !seenTurns.has(info.turn);
        if (info.turn !== null) seenTurns.add(info.turn);
        let reason = fullReason(info, firstOfTurn, tailFrom, settings.anchorEvery);
        let base = -1;
        if (!reason) {
            base = findBase(infos, index);
            if (base < 0) reason = 'no-base';
            else if (chain[base] + 1 > settings.maxChainEntries) reason = 'stall';
        }
        const patch = reason ? null : tryPatch(rebuilt[base], info);
        if (!reason && !patch) reason = 'verify';
        if (!reason && patch.patchText.length >= info.text.length) reason = 'size';
        if (reason) {
            entries[index] = checkpoints[index];
            rebuilt[index] = info.image;
            stats.full++;
            countReason(reason);
            continue;
        }
        entries[index] = withKey(info.entry, 'snapshot', 'packed', { base, patch: patch.ops });
        rebuilt[index] = patch.rebuiltImage;
        chain[index] = chain[base] + 1;
        stats.packed++;
        stats.patchChars += patch.patchText.length;
    }
    const packing = {
        scheme: PACK_SCHEME,
        anchorEvery: settings.anchorEvery,
        fullTail: settings.fullTail,
        maxChainEntries: settings.maxChainEntries,
    };
    return { entries, packing, stats };
}

// Inverse of packCheckpoints: one forward pass; every packed entry's base must be an earlier entry that rebuilt.
// Returns v1-shaped checkpoints (full `snapshot` in the same key position). Throws PackError, never a partial result.
export function unpackCheckpoints(entries, packing) {
    if (!Array.isArray(entries)) throw new PackError('packed checkpoints must be an array');
    if (!isObject(packing) || packing.scheme !== PACK_SCHEME) throw new PackError('unknown checkpoint packing scheme');
    const rebuilt = new Array(entries.length);
    const ready = new Array(entries.length).fill(false);
    const out = new Array(entries.length);
    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        if (!isObject(entry)) {
            out[index] = entry;
            continue;
        }
        if (!Object.hasOwn(entry, 'packed')) {
            if (isObject(entry.snapshot)) {
                rebuilt[index] = entry.snapshot;
                ready[index] = true;
            }
            out[index] = entry;
            continue;
        }
        const packed = entry.packed;
        if (Object.hasOwn(entry, 'snapshot')) throw new PackError(`checkpoint ${index} has both a snapshot and a packed form`);
        if (!isObject(packed) || !Number.isInteger(packed.base) || packed.base < 0 || packed.base >= index) {
            throw new PackError(`checkpoint ${index} has an invalid base`);
        }
        if (!ready[packed.base]) throw new PackError(`checkpoint ${index} is based on an entry without a snapshot`);
        if (!Array.isArray(packed.patch)) throw new PackError(`checkpoint ${index} has no patch array`);
        // applyJson shares unchanged parts with its base; the returned snapshot must own its data (hydration edits snapshots in place).
        const image = applyJson(rebuilt[packed.base], packed.patch);
        rebuilt[index] = image;
        ready[index] = true;
        out[index] = withKey(entry, 'packed', 'snapshot', structuredClone(image));
    }
    return out;
}
