// NPC notes, drives (phase 2 item 4): how strongly each instinct pull moves one NPC. Seven small ints 0..3 under short keys
// (belo, clos, awe, pres, comf, conf, hone), default 2 (normal, multiplier 1). The slice leaf is one JSON text object: readDrives
// (absent reads as the defaults, malformed reads as null), setDrives (writes a merged object; on the first write it is seeded from
// the cast pack's entry or the first description, see seedDrives), and no story grammar writes it. The pull code scales each
// instinct score by its strength (applyStrength, scaledInst) and the dossier gets fixed rows (driveRows). The first three keys
// match the mood-pull instinct keys (belo, clos, awe). Pure: no imports, never touches storage or npc-meters.js.

export const DRIVE_MIN = 0;
export const DRIVE_MAX = 3;
export const DRIVE_DEFAULT = 2;
export const DRIVES_TEXT_MAX = 300;
export const DRIVE_LIST_STRENGTH = 3;
const DESCRIPTION_MAX = 2000;
const WORDS = Object.freeze(['off', 'low', 'normal', 'high']);
const MULTIPLIERS = Object.freeze([0, 0.5, 1, 1.5]);

export const DRIVES = Object.freeze([
    { kind: 'belonging', key: 'belo', label: 'Belonging', words: ['belong', 'family', 'kin', 'friend', 'party', 'lonely'] },
    { kind: 'closure', key: 'clos', label: 'Closure', words: ['unfinished', 'closure', 'unresolved', 'debt', 'unanswered'] },
    { kind: 'awe', key: 'awe', label: 'Awe', words: ['wonder', 'awe', 'marvel', 'mystic', 'curious'] },
    { kind: 'preservation', key: 'pres', label: 'Preservation', words: ['protect', 'preserve', 'guard', 'shield', 'defend'] },
    { kind: 'comfort', key: 'comf', label: 'Comfort', words: ['comfort', 'rest', 'cozy', 'warm', 'food'] },
    { kind: 'conflict', key: 'conf', label: 'Conflict', words: ['rival', 'feud', 'quarrel', 'fight', 'rage'] },
    { kind: 'honesty', key: 'hone', label: 'Honesty', words: ['honest', 'truth', 'candid', 'sincere', 'frank'] },
]);
const KEYS = new Set(DRIVES.map(drive => drive.key));

const isStrength = value => Number.isInteger(value) && value >= DRIVE_MIN && value <= DRIVE_MAX;
const defaults = () => Object.fromEntries(DRIVES.map(drive => [drive.key, DRIVE_DEFAULT]));
const serialize = drives => JSON.stringify(Object.fromEntries(DRIVES.map(drive => [drive.key, drives[drive.key]])));

// A stored leaf: absent (undefined, null, '') reads as the defaults; a present leaf must be a JSON object of known keys with
// whole-number strengths 0..3 (missing keys take the default). Anything else is null, so the validator can reject the command.
export function readDrives(leaf) {
    if (leaf === undefined || leaf === null || leaf === '') return defaults();
    if (typeof leaf !== 'string' || leaf.length > DRIVES_TEXT_MAX) return null;
    let parsed;
    try { parsed = JSON.parse(leaf); } catch { return null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const out = defaults();
    for (const key of Object.keys(parsed)) {
        if (!KEYS.has(key) || !isStrength(parsed[key])) return null;
        out[key] = parsed[key];
    }
    return out;
}

// The first-time seed, used only when the record has no leaf yet. A cast pack entry's `drives` wins when it names any strength
// (an object keyed by kind name or short key, or a list of kind names that become DRIVE_LIST_STRENGTH). Otherwise the first
// description is scanned for the drive words (whole words, or a prefix for words of six letters or more). No hit: defaults.
export function seedDrives(pack, description) {
    const out = defaults();
    const listed = pack && typeof pack === 'object' ? pack.drives : undefined;
    if (listed && typeof listed === 'object' && !Array.isArray(listed)) {
        let named = false;
        for (const drive of DRIVES) {
            const value = listed[drive.kind] ?? listed[drive.key];
            if (isStrength(value)) { out[drive.key] = value; named = true; }
        }
        if (named) return out;
    }
    if (Array.isArray(listed)) {
        const names = listed.map(item => String(item ?? '').trim().toLowerCase());
        const hits = DRIVES.filter(drive => names.includes(drive.kind));
        if (hits.length) {
            for (const drive of hits) out[drive.key] = DRIVE_LIST_STRENGTH;
            return out;
        }
    }
    const tokens = String(description ?? '').slice(0, DESCRIPTION_MAX).toLowerCase().split(/[^a-z]+/);
    for (const drive of DRIVES) {
        const hit = drive.words.some(word => tokens.some(token => token === word || (word.length >= 6 && token.startsWith(word))));
        if (hit) out[drive.key] = DRIVE_LIST_STRENGTH;
    }
    return out;
}

// Writes the changes ({ key: strength }) over the stored leaf and returns the new leaf text (keys always in DRIVES order), or
// null when a change is unknown or not a strength, or the stored leaf is unusable. The seed (`{ pack, description }`) is used
// only when there is no stored leaf yet, so a later write never reseeds.
export function setDrives(leaf, changes, seed) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return null;
    const hasLeaf = leaf !== undefined && leaf !== null && leaf !== '';
    const base = hasLeaf ? readDrives(leaf) : seedDrives(seed?.pack, seed?.description);
    if (!base) return null;
    const next = { ...base };
    for (const key of Object.keys(changes)) {
        if (!KEYS.has(key) || !isStrength(changes[key])) return null;
        next[key] = changes[key];
    }
    return serialize(next);
}

// The pull code's multiplier for one strength: 0 mutes the instinct, 2 (default) leaves it as it is.
export function strengthMultiplier(strength) {
    return isStrength(strength) ? MULTIPLIERS[strength] : 1;
}

// One instinct score (0..3) scaled by its strength, rounded and kept in 0..3.
export function applyStrength(score, strength) {
    if (!Number.isFinite(score)) return 0;
    const base = Math.max(0, Math.min(DRIVE_MAX, Math.floor(score)));
    return Math.max(0, Math.min(DRIVE_MAX, Math.round(base * strengthMultiplier(strength))));
}

// The per-NPC instinct values with each one scaled by its drive (only the keys the instinct object carries are kept).
export function scaledInst(inst, drives) {
    const strengths = drives && typeof drives === 'object' ? drives : defaults();
    const out = {};
    if (!inst || typeof inst !== 'object') return out;
    for (const key of Object.keys(inst)) {
        if (KEYS.has(key)) out[key] = applyStrength(inst[key], strengths[key]);
    }
    return out;
}

// The dossier rows, always in DRIVES order: { kind, key, label, strength, word } with word off | low | normal | high.
export function driveRows(drives) {
    const strengths = drives && typeof drives === 'object' ? drives : defaults();
    return DRIVES.map(drive => {
        const strength = isStrength(strengths[drive.key]) ? strengths[drive.key] : DRIVE_DEFAULT;
        return { kind: drive.kind, key: drive.key, label: drive.label, strength, word: WORDS[strength] };
    });
}
