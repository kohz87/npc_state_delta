// NPC notes, drives (phase 2 item 4): how strongly each instinct pull moves one NPC. Seven small ints 0..3 under short keys
// (belo, clos, awe, pres, comf, conf, hone), default 2 (normal, multiplier 1). The slice leaf is one JSON text object: readDrives
// (absent reads as the defaults, malformed reads as null), setDrives (writes a merged object; on the first write it is seeded from
// the cast pack's entry or the first description, see seedDrives), and no story grammar writes it. The pull code scales each
// instinct score by its strength (applyStrength, scaledInst) and the dossier gets fixed rows (driveRows). The first three keys
// match the mood-pull instinct keys (belo, clos, awe). Pure: no imports, never touches storage or npc-meters.js.
// Seeding: the pack's drives win; otherwise a drive starts high only when the first description carries TWO DIFFERENT cue words for it.
// Growth (rule 1, the `npc.drives` command): the evidence the scan already recorded (new memories, behavior and mannerism lines, the
// relationship reason) is read for cue words; a drive steps one level (up on its own cues, down on its short opposite list) when its cues
// show in 2 DIFFERENT replies since its last change. The pending reply, the source and the reason live in the leaf's `x` object, so the
// step is stored like any change (swipe, delete, Re-read and replay give the same drives as live).

export const DRIVE_MIN = 0;
export const DRIVE_MAX = 3;
export const DRIVE_DEFAULT = 2;
export const DRIVES_TEXT_MAX = 900;   // the largest leaf the caps below allow is 803 characters
export const DRIVE_RULE = 1;
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
// Short opposite-cue lists: a cue here pushes the drive down one level (rule 1).
const OPPOSITES = Object.freeze({
    belo: ['alone', 'aloof', 'distant', 'loner'],
    clos: ['indifferent', 'careless', 'forget', 'forgot'],
    awe: ['bored', 'dull', 'mundane', 'jaded', 'cynical'],
    pres: ['reckless', 'abandon', 'neglect', 'expose'],
    comf: ['austere', 'ascetic', 'spartan', 'hardship'],
    conf: ['peaceful', 'calm', 'gentle', 'forgive', 'truce'],
    hone: ['lied', 'lying', 'liar', 'lies', 'lie', 'deceit', 'deceive', 'dishonest', 'untruthful'],
});
const SOURCES = new Set(['p', 'd', 'u', 'l']);
const KEYS = new Set(DRIVES.map(drive => drive.key));

const isStrength = value => Number.isInteger(value) && value >= DRIVE_MIN && value <= DRIVE_MAX;
const defaults = () => Object.fromEntries(DRIVES.map(drive => [drive.key, DRIVE_DEFAULT]));
const serialize = (drives, extras) => {
    const out = Object.fromEntries(DRIVES.map(drive => [drive.key, drives[drive.key]]));
    const x = Object.fromEntries(DRIVES.filter(drive => extras && extras[drive.key] && Object.keys(extras[drive.key]).length).map(drive => [drive.key, extras[drive.key]]));
    if (Object.keys(x).length) out.x = x;
    return JSON.stringify(out);
};
// Per-drive extras: { s: p|d|u|l (pack, description, grew, eased), n: moments, c: cue word, e: 'u|d:reply' pending evidence }.
function validExtras(x) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
    return Object.keys(x).every(key => KEYS.has(key) && x[key] && typeof x[key] === 'object' && !Array.isArray(x[key])
        && Object.keys(x[key]).every(field => ['s', 'n', 'c', 'e'].includes(field))
        && (x[key].s === undefined || SOURCES.has(x[key].s)) && (x[key].n === undefined || (Number.isInteger(x[key].n) && x[key].n >= 0 && x[key].n <= 999))
        && (x[key].c === undefined || (typeof x[key].c === 'string' && x[key].c.length <= 24)) && (x[key].e === undefined || (typeof x[key].e === 'string' && x[key].e.length <= 48)));
}
// The stored extras ({} when none or unreadable).
export function readExtras(leaf) {
    if (typeof leaf !== 'string' || !leaf) return {};
    try { const parsed = JSON.parse(leaf); return parsed && validExtras(parsed.x) ? parsed.x : {}; } catch { return {}; }
}
const tokensOf = text => String(text ?? '').slice(0, DESCRIPTION_MAX).toLowerCase().split(/[^a-z]+/);
// A word shortly before a cue that turns it round ("has no family", "never honest", "doesn't care": n't leaves a lone "t").
const NEGATORS = new Set(['no', 'not', 'never', 'without', 'nor', 'neither', 'none', 'nobody', 'nothing', 'cannot', 'hardly', 'barely', 'lack', 'lacks', 'lacking', 'low', 'little', 'weak', 'poor', 't']);
const NEGATION_REACH = 3;
const MATCH = (word, token) => token === word || (word.length >= 6 && token.startsWith(word));
// The cue words of `words` found in the tokens (whole words, or a prefix for words of six letters or more): { pos, neg }, the distinct
// words said plainly and the ones a negator stands just before. A token in `skip` (the person's own name or role) is no evidence.
function cueHits(words, tokens, skip) {
    const pos = [];
    const neg = [];
    tokens.forEach((token, at) => {
        if (!token || skip?.has(token)) return;
        const word = words.find(item => MATCH(item, token));
        if (!word) return;
        const negated = tokens.slice(Math.max(0, at - NEGATION_REACH), at).some(before => NEGATORS.has(before));
        const into = negated ? neg : pos;
        if (!into.includes(word)) into.push(word);
    });
    return { pos, neg };
}
const hitsOf = (words, tokens) => cueHits(words, tokens).pos;

// A stored leaf: absent (undefined, null, '') reads as the defaults; a present leaf must be a JSON object of known keys with
// whole-number strengths 0..3 (missing keys take the default). Anything else is null, so the validator can reject the command.
export function readDrives(leaf) {
    if (leaf === undefined || leaf === null || leaf === '') return defaults();
    if (typeof leaf !== 'string' || leaf.length > DRIVES_TEXT_MAX) return null;
    let parsed;
    try { parsed = JSON.parse(leaf); } catch { return null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const out = defaults();
    if (Object.hasOwn(parsed, 'x') && !validExtras(parsed.x)) return null;
    for (const key of Object.keys(parsed)) {
        if (key === 'x') continue;
        if (!KEYS.has(key) || !isStrength(parsed[key])) return null;
        out[key] = parsed[key];
    }
    return out;
}

// The first-time seed, used only when the record has no leaf yet. A cast pack entry's `drives` wins when it names any strength
// (an object keyed by kind name or short key, or a list of kind names that become DRIVE_LIST_STRENGTH). Otherwise the first
// description is scanned for the drive words (whole words, or a prefix for words of six letters or more). No hit: defaults.
export function seedDrives(pack, description) {
    return seedDetail(pack, description).out;
}

// The seed and where each non-default strength came from: { out, extras } (extras: { key: { s: 'p' | 'd', c? } }).
export function seedDetail(pack, description) {
    const out = defaults();
    const extras = {};
    const listed = pack && typeof pack === 'object' ? pack.drives : undefined;
    if (listed && typeof listed === 'object' && !Array.isArray(listed)) {
        let named = false;
        for (const drive of DRIVES) {
            const value = listed[drive.kind] ?? listed[drive.key];
            if (isStrength(value)) { out[drive.key] = value; named = true; if (value !== DRIVE_DEFAULT) extras[drive.key] = { s: 'p' }; }
        }
        if (named) return { out, extras };
    }
    if (Array.isArray(listed)) {
        const names = listed.map(item => String(item ?? '').trim().toLowerCase());
        const hits = DRIVES.filter(drive => names.includes(drive.kind));
        if (hits.length) {
            for (const drive of hits) { out[drive.key] = DRIVE_LIST_STRENGTH; extras[drive.key] = { s: 'p' }; }
            return { out, extras };
        }
    }
    // The first description: one cue word keeps a drive normal; two different cue words start it high.
    const tokens = tokensOf(description);
    for (const drive of DRIVES) {
        const hits = hitsOf(drive.words, tokens);
        if (hits.length >= 2) { out[drive.key] = DRIVE_LIST_STRENGTH; extras[drive.key] = { s: 'd', c: hits[0] }; }
    }
    return { out, extras };
}

// Writes the changes ({ key: strength }) over the stored leaf and returns the new leaf text (keys always in DRIVES order), or
// null when a change is unknown or not a strength, or the stored leaf is unusable. The seed (`{ pack, description }`) is used
// only when there is no stored leaf yet, so a later write never reseeds.
export function setDrives(leaf, changes, seed) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return null;
    const hasLeaf = leaf !== undefined && leaf !== null && leaf !== '';
    const seeded = hasLeaf ? null : seedDetail(seed?.pack, seed?.description);
    const base = hasLeaf ? readDrives(leaf) : seeded.out;
    if (!base) return null;
    const extras = hasLeaf ? readExtras(leaf) : seeded.extras;
    const next = { ...base };
    for (const key of Object.keys(changes)) {
        if (!KEYS.has(key) || !isStrength(changes[key])) return null;
        if (next[key] !== changes[key]) delete extras[key];   // a hand-set value has no source or pending evidence
        next[key] = changes[key];
    }
    return serialize(next, extras);
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

// The dossier rows, always in DRIVES order: { kind, key, label, strength, word, note } with word off | low | normal | high and `note`
// the short source line shown when the drive is not normal ('' otherwise, or when the leaf holds no source).
export function driveRows(drives, leaf) {
    const strengths = drives && typeof drives === 'object' ? drives : defaults();
    const extras = readExtras(leaf);
    return DRIVES.map(drive => {
        const strength = isStrength(strengths[drive.key]) ? strengths[drive.key] : DRIVE_DEFAULT;
        return { kind: drive.kind, key: drive.key, label: drive.label, strength, word: WORDS[strength], note: strength === DRIVE_DEFAULT ? '' : noteOf(extras[drive.key]) };
    });
}

function noteOf(extra) {
    if (!extra) return '';
    if (extra.s === 'p') return 'set by the pack';
    if (extra.s === 'd') return 'from their description';
    if ((extra.s === 'u' || extra.s === 'l') && extra.n) return `${extra.s === 'u' ? 'grew' : 'eased'} over ${extra.n} story moments${extra.c ? ` (${extra.c})` : ''}`;
    return '';
}

// ---- growth (rule 1) ----

const textOf = item => String(typeof item === 'string' ? item : item?.text ?? item?.memory ?? '').trim();

// The text a scan newly recorded for one person (before and after: dossier records): new memories, behavior and mannerism lines,
// and the relationship reason when it changed. Plain strings, at most 12 of 200 characters; nothing new reads as [].
export function driveEvidence(before, after) {
    const out = [];
    for (const field of ['memories', 'behaviorProfile', 'mannerisms']) {
        const old = new Set((Array.isArray(before?.[field]) ? before[field] : []).map(textOf));
        for (const item of Array.isArray(after?.[field]) ? after[field] : []) {
            const text = textOf(item);
            if (text && !old.has(text)) out.push(text);
        }
    }
    const reason = String(after?.lastRelationshipChange?.reason ?? '').trim();
    if (reason && reason !== String(before?.lastRelationshipChange?.reason ?? '').trim()) out.push(reason);
    return out.slice(0, 12).map(text => text.slice(0, 200));
}

// One reply's evidence (`texts`, plain strings) against the stored leaf, for the reply `rid`: { leaf, steps } or null when nothing is
// stored or moved. A drive whose cues (and no opposite cue) show for the first time since its last change only remembers the reply; the
// same drive and direction in a DIFFERENT reply steps it one level (3 and 0 are the ends). Never more than one step per drive per reply.
export function growDrives(leaf, texts, rid, skipText) {
    const key = rid === null || rid === undefined ? '' : String(rid);
    const base = readDrives(leaf);
    if (!base || !key || key.length > 40 || !Array.isArray(texts)) return null;
    const extras = readExtras(leaf);
    const skip = new Set(tokensOf(skipText).filter(token => token.length > 1));
    const found = leverCues(texts, skip);
    const next = { ...base };
    const steps = [];
    let touched = false;
    for (const drive of DRIVES) {
        const up = found[drive.key].up;
        const down = found[drive.key].down;
        if (!up.length === !down.length) continue;   // no cue, or cues both ways: nothing to count
        const dir = up.length ? 'u' : 'd';
        const cue = (up.length ? up : down)[0];
        if (dir === 'u' ? next[drive.key] >= DRIVE_MAX : next[drive.key] <= DRIVE_MIN) continue;
        const entry = { ...(extras[drive.key] ?? {}) };
        const [pendDir, pendReply] = String(entry.e ?? '').split(':');
        if (pendDir === dir && pendReply === key) continue;   // the same reply again counts once
        touched = true;
        if (pendDir === dir && pendReply) {
            const from = next[drive.key];
            next[drive.key] = from + (dir === 'u' ? 1 : -1);
            const source = dir === 'u' ? 'u' : 'l';
            extras[drive.key] = { s: source, n: Math.min(999, (entry.s === source ? entry.n ?? 0 : 0) + 2), c: cue.slice(0, 24) };
            steps.push({ key: drive.key, label: drive.label, from, to: next[drive.key], cue });
        } else {
            extras[drive.key] = { ...entry, e: `${dir}:${key}` };
        }
    }
    return touched ? { leaf: serialize(next, extras), steps } : null;
}

const LEVEL_UP = /^(?:very |quite |fairly )?(?:high|strong|great)$/;
const LEVEL_DOWN = /^(?:very |quite |fairly )?(?:low|none|weak|nil|minimal|absent)$/;
// Each line read on its own (a negator never reaches across lines): { key: { up: [cue words], down: [cue words] } }. A lever line
// ("Honesty: low - lies to cover") whose label names a drive counts by its LEVEL word alone (low or none = down, high = up, else
// nothing); any other line loses its "Label:" part and counts by its body. A negated cue counts toward the opposite direction, and a
// negated opposite cue counts for nothing, so evidence that says a drive is weak never raises it.
function leverCues(texts, skip) {
    const out = Object.fromEntries(DRIVES.map(drive => [drive.key, { up: [], down: [] }]));
    const add = (list, word) => { if (!list.includes(word)) list.push(word); };
    for (const text of texts) {
        const lever = /^\s*([A-Za-z ]{1,24}):\s*([A-Za-z ]{2,14}?)\s*(?:[-\u2013\u2014:]|$)/.exec(String(text));
        const named = lever && DRIVES.find(drive => drive.label.toLowerCase() === lever[1].trim().toLowerCase() || drive.kind === lever[1].trim().toLowerCase());
        if (named) {
            const level = lever[2].trim().toLowerCase();
            if (LEVEL_UP.test(level)) add(out[named.key].up, named.kind);
            else if (LEVEL_DOWN.test(level)) add(out[named.key].down, named.kind);
            continue;
        }
        const tokens = tokensOf(String(text).replace(/^\s*[A-Za-z ]{1,24}:\s*/, ''));
        for (const drive of DRIVES) {
            const same = cueHits(drive.words, tokens, skip);
            const opposite = cueHits(OPPOSITES[drive.key], tokens, skip);
            same.pos.forEach(word => add(out[drive.key].up, word));
            same.neg.forEach(word => add(out[drive.key].down, word));
            opposite.pos.forEach(word => add(out[drive.key].down, word));
        }
    }
    return out;
}
