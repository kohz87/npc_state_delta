// NPC notes, the kinds (NSDMAP2 §9 item 7): the one file that imports the six npc-notes-* files. KINDS maps each `~` line kind
// (lie, know, taste, tie) to its record field and handler. A handler takes the stored leaf, one parsed line and a context
// { name, day, r, userText, tier, drop, notes } and returns { text, problem }: `text` is the new leaf (null clears a tie leaf),
// `problem` is '' or the reason the whole command is refused. A handler reports code-set effects through the notes option:
// notes.run(change) for a meter change (a caught lie's trust drop, to run() at a tier) and notes.flag(text, cue) for a Problem
// or receipt. The handlers do not store anything; the host writes the leaves inside the reply's own op. NOTE_FIELDS lists the
// record fields these kinds own; validateNotes(record) checks them; notesTail(record, ctx) builds the optional tail lines.
// Pure: no storage, never imports npc-meters.js.
import { FEATURE_NOTES, npcKey } from './npc-meters-config.js';
import { readLies, addLie, catchLie, lieTail, lieRows, caughtSummary } from './npc-notes-lies.js';
import { readKnows, addKnow, openKnow, knowsTail, knowsView, KNOWS_MAX, KNOWS_TEXT_MAX } from './npc-notes-knows.js';
import { readTastes, addTaste, tastesText, tasteTail, TASTE_LIMITS } from './npc-notes-tastes.js';
import { readTies, applyTags, tiesText, tiesView, tagsFromRelation, owedBy } from './npc-notes-ties.js';
import { readDrives, driveRows, setDrives, applyStrength } from './npc-notes-drives.js';
import { readLookStamp, lookStamp } from './npc-notes-look.js';
export { lookStamp, readLookStamp };

export const NOTE_FIELDS = Object.freeze(['lies', 'knows', 'tastes', 'ties', 'drives', 'lookLockedAt']);
export const NOTES_TAIL_PER_NPC = 2;
export const NOTES_TAIL_MAX = 4;
// A caught lie costs about six trust (owner decision); only the extreme tier's cap lets a step that big land, and it is counted
// in that tier's events per story day.
export const CAUGHT_TIER = 'extreme';
export const CAUGHT_DROP = 6;

const NO_NOTES = Object.freeze({ run() {}, flag() {} });

// lie: `~ lie` tells a lie (to, said); `~ lie catch` stamps the latest matching uncaught lie as caught (trust drop via notes.run).
function lieKind(current, line, ctx) {
    if (line.catch) {
        const hit = catchLie(current, { to: line.to, said: line.said, day: ctx.day, r: ctx.r, tier: ctx.tier, drop: ctx.drop });
        if (!hit) return { text: current, problem: `No uncaught lie to ${String(line.to ?? '')} matches that catch.` };
        ctx.notes.run(hit.change);
        ctx.notes.flag(caughtSummary(ctx.name, hit.entry.to));
        return { text: hit.text, problem: '' };
    }
    const out = addLie(current, { to: line.to, said: line.said, day: ctx.day, r: ctx.r });
    return { text: out.text, problem: out.problem };
}

// know: `~ know` records one reply's lines (lines: [{ about, fact, how, secret? }]); `~ know open` opens a secret (about, fact).
function knowKind(current, line, ctx) {
    if (line.open) return { text: openKnow(current, line.about, line.fact) ?? current, problem: '' };
    const out = addKnow(current, ctx.r, line.lines);
    return { text: out.text ?? current, problem: out.problem ?? '' };
}

// taste: `~ taste` captures a likes/dislikes item. A refused change keeps the list; a mirrored one is kept and flagged.
function tasteKind(current, line, ctx) {
    const out = addTaste(current, {
        name: ctx.name, sign: line.sign, item: line.item, from: line.from, why: line.why, day: ctx.day, r: ctx.r, userText: ctx.userText,
    });
    if (out.status === 'refused') return { text: current, problem: out.problem };
    if (out.problem) ctx.notes.flag(out.problem, out.cue);
    return { text: tastesText(out.tastes), problem: '' };
}

// tie: `~ tie` applies +ally / -rival / +owes between this person and `with`. An empty result returns null (the host drops the leaf).
function tieKind(current, line, ctx) {
    const base = current ? readTies(current) : {};
    if (base === null) return { text: current, problem: 'The stored ties are not valid.' };
    const out = applyTags(base, { self: ctx.name, with: line.with, tags: line.tags });
    if (out.refused) return { text: current, problem: `The tie is refused (${out.refused}).` };
    if (out.ignored.length) return { text: current, problem: `Unknown tie tag: ${out.ignored.join(', ')}.` };
    return { text: tiesText(out.ties), problem: '' };
}

export const KINDS = Object.freeze({
    lie: Object.freeze({ field: 'lies', handle: lieKind }),
    know: Object.freeze({ field: 'knows', handle: knowKind }),
    taste: Object.freeze({ field: 'tastes', handle: tasteKind }),
    tie: Object.freeze({ field: 'ties', handle: tieKind }),
});

/** Runs one parsed line through its kind → { field, text, problem }. An unknown kind is refused with a problem; nothing is written. */
export function runKind(kind, current, line, ctx = {}) {
    const entry = Object.hasOwn(KINDS, kind) ? KINDS[kind] : null;
    if (!entry) return { field: null, text: current, problem: `Unknown note kind: ${String(kind)}.` };
    return { field: entry.field, ...entry.handle(current, line ?? {}, { ...ctx, notes: ctx.notes ?? NO_NOTES }) };
}

// Stored-leaf checks for validateNotes: each returns true when the leaf reads back whole (no entry dropped by the reader).
function knowsOk(text) {
    if (typeof text !== 'string' || text.length > KNOWS_TEXT_MAX) return false;
    let list;
    try { list = JSON.parse(text); } catch { return false; }
    return Array.isArray(list) && list.length <= KNOWS_MAX && readKnows(text).length === list.length;
}

function tastesOk(text) {
    if (typeof text !== 'string' || text.length > TASTE_LIMITS.text) return false;
    let list;
    try { list = JSON.parse(text); } catch { return false; }
    return Array.isArray(list) && readTastes(text).length === list.length;
}

const CHECKS = Object.freeze({
    lies: value => readLies(value) !== null,
    knows: knowsOk,
    tastes: tastesOk,
    ties: value => readTies(value) !== null,
    drives: value => readDrives(value) !== null,
    lookLockedAt: value => readLookStamp(value) !== null,
});

/**
 * Checks the note fields of one record. An absent field (undefined, null or '') is fine. Returns '' when every present field is
 * valid, else the name of the first bad field and "is not valid." (the host refuses the whole command, as validateNpcSlice does).
 */
export function validateNotes(record) {
    if (!record || typeof record !== 'object') return '';
    for (const field of NOTE_FIELDS) {
        const value = record[field];
        if (value === undefined || value === null || value === '') continue;
        if (!CHECKS[field](value)) return `${field} is not valid.`;
    }
    return '';
}

/**
 * The optional tail lines for the people present this reply. `record` maps a person's key to { name, lies, knows, tastes } (their
 * stored leaves); `ctx.present` lists the keys nearest-relevant first. Per person up to NOTES_TAIL_PER_NPC lines, in the order
 * uncaught lie, secret or fact, taste; at most NOTES_TAIL_MAX lines in all (the nearer people fill it first). Ties and drives have
 * no tail. → string[] (every line is optional for the host's budget).
 */
export function notesTail(record, { present = [] } = {}) {
    const out = [];
    for (const key of Array.isArray(present) ? present : []) {
        if (out.length >= NOTES_TAIL_MAX) break;
        const person = record?.[key];
        if (!person || typeof person !== 'object') continue;
        const name = person.name;
        const lines = [
            lieTail(name, person.lies),
            ...knowsTail([{ name, knows: person.knows }]),
            tasteTail(name, person.tastes),
        ].filter(Boolean);
        out.push(...lines.slice(0, Math.min(NOTES_TAIL_PER_NPC, NOTES_TAIL_MAX - out.length)));
    }
    return out;
}

// ---- the host's side: grammar lines, the label parser and the player's view ----

// One short grammar line per kind, sent only while the notes feature is on (the host leaves a kind's grammar out when its feature is off).
const GRAMMAR = Object.freeze({
    lie: '~ lie Name | to: Astra | said: the false claim (| caught: yes once the story exposes it)',
    know: '~ know Name | about: Other | fact: what they learned | how: saw or heard (| secret: yes; later | told: yes)',
    taste: '~ taste Name | likes: or dislikes: an item | from: why',
    tie: '~ tie Name | with: Other | tag: +ally, +rival or +owes (-tag drops it)',
});

/** The `kinds` entries for the host: every note kind handled by `capture` and behind the notes feature. */
export const noteKinds = capture => Object.fromEntries(Object.keys(KINDS).map(kind => [kind, { grammar: GRAMMAR[kind], apply: capture, feature: FEATURE_NOTES }]));
export const isNoteKind = kind => Object.hasOwn(KINDS, kind);
export const noteField = kind => KINDS[kind]?.field ?? null;

const yes = value => /^(yes|true)$/i.test(String(value ?? '').trim());

/** A parsed line's labels ({ slugged label: text }) as the handler's line shape. `ctx`: { current, r, day } (the stored leaf, the reply key, the story day). */
export function noteLine(kind, labels, { current = '', r = null, day = null } = {}) {
    if (kind === 'lie') return { to: labels.to, said: labels.said, catch: yes(labels.caught) };
    if (kind === 'know') {
        if (yes(labels.told)) return { open: true, about: labels.about, fact: labels.fact };
        // One call per line, but addKnow keeps one reply's entries as a set: hand it the reply's earlier lines too.
        const same = readKnows(current).filter(entry => entry.r === r).map(({ about, fact, how, day: at, secret }) => ({ about, fact, how, day: at, secret }));
        return { lines: [...same, { about: labels.about, fact: labels.fact, how: labels.how, day, secret: yes(labels.secret) }] };
    }
    if (kind === 'taste') {
        const sign = labels.likes !== undefined ? '+' : labels.dislikes !== undefined ? '-' : '';
        return { sign, item: labels.likes ?? labels.dislikes, from: labels.from, why: labels.why };
    }
    const tags = String(labels.tag ?? '').split(',').map(tag => tag.trim()).filter(Boolean).map(tag => (/^[+-]/.test(tag) ? tag : `+${tag}`));
    return { with: labels.with, tags };
}

/**
 * What the dossier shows of a record's notes: { lies, knows, tastes, ties, drives, look } as plain rows (`look`: the locked-look stamp { day, r } or null). A lie the story has not caught and a
 * secret it has not told are redacted (no words of them) unless `show`; `bonds` are the person's bond strings (ties rows follow them).
 */
export function dossierNotes(record, { bonds = null, show = false } = {}) {
    const source = record && typeof record === 'object' ? record : {};
    return {
        lies: lieRows(source.lies, { redact: !show }),
        knows: knowsView(source.knows ?? '', { show }),
        tastes: readTastes(source.tastes).map(({ sign, item, from, mirrored }) => ({ sign, item, from: from ?? '', mirrored: mirrored === true })),
        ties: Array.isArray(bonds) ? tieRows(readTies(source.ties) ?? {}, bonds, []) : (readTies(source.ties) ?? {}),
        drives: driveRows(readDrives(source.drives) ?? undefined),
        look: readLookStamp(source.lookLockedAt),
    };
}

/** The pack entry's (cast-dossier normalizeEntry) tastes and drives as the record's first leaves: { tastes?, drives? } (nothing for a default). */
export function seedNotes(entry) {
    const out = {};
    const rows = (Array.isArray(entry?.tastes) ? entry.tastes : []).map(({ sign, item, from }) => ({ sign, item, from, day: 0, r: 'pack' }));
    const tastes = rows.length ? tastesText(readTastes(rows)) : '';
    if (tastes) out.tastes = tastes;
    const drives = setDrives('', {}, { pack: { drives: entry?.drives }, description: `${entry?.personality ?? ''} ${entry?.about ?? ''}` });
    if (drives && drives !== setDrives('', {}, {})) out.drives = drives;
    return out;
}

/** The scale function for npc-instincts' readInstincts: a score scaled by this person's drive for that instinct key (belo, clos, awe). */
export function driveScale(leaf) {
    const drives = readDrives(leaf);
    return drives ? (key, score) => applyStrength(score, drives[key]) : undefined;
}

/**
 * The Ties rows for a person's bond list (bond strings "Name — relation | dynamic"): the stored tags, and for a bond with none the
 * tags its relation word implies (read-time only, never stored; `derived: true`). `owedByKeys`: owedBy(key, everyone's ties).
 */
export function tieRows(ties, bonds, owedByKeys = []) {
    const rows = tiesView(ties, bonds, owedByKeys);
    const have = new Set(rows.map(row => row.key));
    for (const entry of Array.isArray(bonds) ? bonds : []) {
        const [head, relation = ''] = String(entry ?? '').split(/\s+[—-]\s+/, 2);
        const name = head.split('|')[0].trim();
        const key = npcKey(name);
        const tags = key && !have.has(key) ? tagsFromRelation(relation.split('|')[0]) : [];
        if (!tags.length) continue;
        have.add(key);
        rows.push({ key, name, tags, owes: tags.includes('owes'), owedBy: false, derived: true });
    }
    return rows;
}

export { owedBy };

/**
 * Folds tie keys written under an alias into the person's own key (an alias merge in Delta leaves the slice's keys as they were):
 * `canon` maps an alias's key to the key of the name it now answers to. Tags of keys that meet are joined, in the canonical order.
 */
export function foldTies(ties, canon = {}) {
    const out = {};
    for (const [key, tags] of Object.entries(ties && typeof ties === 'object' ? ties : {})) {
        const to = Object.hasOwn(canon, key) ? canon[key] : key;
        out[to] = [...new Set([...(out[to] ?? []), ...(Array.isArray(tags) ? tags : [])])];
    }
    for (const [key, tags] of Object.entries(out)) out[key] = ['ally', 'rival', 'owes'].filter(tag => tags.includes(tag));
    return out;
}

/** { aliasKey: nameKey } for Delta's dossiers (`npcs`: [{ name, aliases }]), for foldTies. */
export function aliasCanon(npcs) {
    const out = {};
    for (const npc of Array.isArray(npcs) ? npcs : []) {
        const to = npcKey(npc?.name);
        if (!to) continue;
        for (const alias of Array.isArray(npc.aliases) ? npc.aliases : []) {
            const key = npcKey(alias);
            if (key && key !== to && !Object.hasOwn(out, key)) out[key] = to;
        }
    }
    return out;
}
