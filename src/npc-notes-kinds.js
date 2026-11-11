// NPC notes, the kinds (NSDMAP2 §9 item 7): the one file that imports the six npc-notes-* files. KINDS maps each `~` line kind
// (lie, know, taste, tie) to its record field and handler. A handler takes the stored leaf, one parsed line and a context
// { name, day, r, userText, tier, drop, notes } and returns { text, problem }: `text` is the new leaf (null clears a tie leaf),
// `problem` is '' or the reason the whole command is refused. A handler reports code-set effects through the notes option:
// notes.run(change) for a meter change (a caught lie's trust drop, to run() at a tier) and notes.flag(text, cue) for a Problem
// or receipt. The handlers do not store anything; the host writes the leaves inside the reply's own op. NOTE_FIELDS lists the
// record fields these kinds own; validateNotes(record) checks them; notesTail(record, ctx) builds the optional tail lines.
// Pure: no storage, never imports npc-meters.js.
import { readLies, addLie, catchLie, lieTail, caughtSummary } from './npc-notes-lies.js';
import { readKnows, addKnow, openKnow, knowsTail, KNOWS_MAX, KNOWS_TEXT_MAX } from './npc-notes-knows.js';
import { readTastes, addTaste, tastesText, tasteTail, TASTE_LIMITS } from './npc-notes-tastes.js';
import { readTies, applyTags, tiesText } from './npc-notes-ties.js';
import { readDrives } from './npc-notes-drives.js';
import { readLookStamp } from './npc-notes-look.js';

export const NOTE_FIELDS = Object.freeze(['lies', 'knows', 'tastes', 'ties', 'drives', 'lookLockedAt']);
export const NOTES_TAIL_PER_NPC = 2;
export const NOTES_TAIL_MAX = 4;

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
