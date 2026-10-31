// The party's mounts (feature `story-block.mounts`): the animals and carts that set how fast the party
// travels, kept in the scene domain as `scene.mounts`, with the capture kind `mount`, the reader's pencil
// command, the queries `mounts.list` and `mounts.pace` (Story Director reads both) and the narrator's line. Pure.
//
// `scene.mounts` is an object of rows, absent until a reply first writes one (older chats read as none). A row
// is { name, kind, count, pace, condition, where } under a key made from its name when it was added (`m:grey
// mare`), never a list: a reply that edits a row writes that row's own fields, so a replay after an earlier
// reply was deleted still finds it (SPEC §2.2). The rows keep the order they were added in. At most MAX_ROWS.

import { isPlainObject, labelOf, parseCount } from './common.js';
import { cleanName, trimText } from './names.js';
import { foldKey } from '../../text.js';
import { escapeKey } from '../ops.js';
import { CORE_FEATURE } from '../features.js';
import { STRINGS, fill } from '../strings.js';

const M = STRINGS.mounts;

export const MOUNTS_FEATURE = CORE_FEATURE.mounts;
export const MAX_ROWS = 6;
export const MAX_NAME = 40;
export const MAX_KIND = 20;
export const MAX_COUNT = 8;
export const MAX_PACE = 200;
export const MAX_CONDITION = 60;
export const MAX_WHERE = 80;
/** What a party without enough mounts does: km per day on foot. */
export const WALK_PACE = 20;
/** The pace of a kind with no entry below. */
export const DEFAULT_PACE = 30;
/** km per day, by kind. */
export const KIND_PACE = Object.freeze({ horse: 35, pony: 30, camel: 30, mule: 25, donkey: 20, ox: 15, cart: 18, wagon: 18 });

/** The pace a kind of mount goes at when a line gives none ("horses" is a horse; an unknown kind or none, 30). */
export function paceOfKind(kind) {
    const key = foldKey(kind);
    for (const form of [key, key.replace(/s$/, ''), key.replace(/es$/, ''), key === 'oxen' ? 'ox' : '']) {
        if (form && Object.hasOwn(KIND_PACE, form)) return KIND_PACE[form];
    }
    return DEFAULT_PACE;
}

const nameKey = name => foldKey(cleanName(name));
const rowKey = name => `m:${nameKey(name)}`;
const FIELDS = ['name', 'kind', 'count', 'pace', 'condition', 'where'];

/** §2.5 validator for the scene's mounts (called with the scene slice): [] when fine, else plain sentences. */
export function validateMounts(slice) {
    const mounts = slice?.mounts;
    if (mounts === undefined) return [];
    if (!isPlainObject(mounts)) return ['The mounts are not a record.'];
    const errors = [];
    const keys = Object.keys(mounts);
    if (keys.length > MAX_ROWS) errors.push(`At most ${MAX_ROWS} mounts can be kept.`);
    const seen = new Set();
    for (const key of keys) {
        const row = mounts[key];
        if (!isPlainObject(row)) {
            errors.push('A mount is not a record.');
            continue;
        }
        if (typeof row.name !== 'string' || !row.name.trim()) errors.push('A mount has no name.');
        else {
            if (Array.from(row.name).length > MAX_NAME) errors.push(`The mount "${trimText(row.name, 30)}" has a name longer than ${MAX_NAME} characters.`);
            if (seen.has(nameKey(row.name))) errors.push(`${row.name} is listed as a mount twice.`);
            seen.add(nameKey(row.name));
        }
        const label = typeof row.name === 'string' && row.name.trim() ? trimText(row.name, 30) : 'A mount';
        for (const [field, max] of [['kind', MAX_KIND], ['condition', MAX_CONDITION], ['where', MAX_WHERE]]) {
            if (typeof row[field] !== 'string') errors.push(`${label}'s ${field} is not text.`);
            else if (Array.from(row[field]).length > max) errors.push(`${label}'s ${field} is longer than ${max} characters.`);
        }
        if (!Number.isSafeInteger(row.count) || row.count < 1 || row.count > MAX_COUNT) errors.push(`${label}'s count is not a whole number from 1 to ${MAX_COUNT}.`);
        if (!Number.isSafeInteger(row.pace) || row.pace < 1 || row.pace > MAX_PACE) errors.push(`${label}'s pace is not a whole number from 1 to ${MAX_PACE} km a day.`);
    }
    return errors;
}

/** The rows as copies in story order: [{ name, kind, count, pace, condition, where }]. */
export function mountRows(state) {
    const mounts = state?.domains?.scene?.mounts;
    if (!isPlainObject(mounts)) return [];
    return Object.values(mounts).filter(isPlainObject).map(row => ({
        name: String(row.name ?? ''), kind: String(row.kind ?? ''), count: Number.isSafeInteger(row.count) ? row.count : 1,
        pace: Number.isSafeInteger(row.pace) ? row.pace : DEFAULT_PACE, condition: String(row.condition ?? ''), where: String(row.where ?? ''),
    }));
}

/**
 * `{ pace, mounts, riders, short, slowest }` or null with no mount. `pace`: the slowest row's km a day; `mounts`: how many in all;
 * `riders`: who has to be carried (the caller says); `short`: how many riders have no mount; with any short, they walk (WALK_PACE).
 * `slowest`: the slowest row's name (the first of equals).
 */
export function mountsPace(state, riders = 1) {
    const rows = mountRows(state);
    if (!rows.length) return null;
    const slowest = rows.reduce((best, row) => (row.pace < best.pace ? row : best), rows[0]);
    const mounts = rows.reduce((sum, row) => sum + row.count, 0);
    const people = Math.max(1, Number.isSafeInteger(riders) ? riders : 1);
    const short = Math.max(0, people - mounts);
    return { pace: short > 0 ? WALK_PACE : slowest.pace, mounts, riders: people, short, slowest: slowest.name };
}

/**
 * The narrator's line for the tail, or null with no mount: "Mounts: Grey Mare (horse, 35 km/day, ridden by Wessel);
 * Guild remounts ×4 (horse, 35 km/day); Burr (mule, 25 km/day, tired, led)".
 */
export function mountsTail(state) {
    const rows = mountRows(state);
    if (!rows.length) return null;
    const text = rows.map(row => {
        const about = [row.kind, `${row.pace} km/day`, row.condition, row.where].filter(Boolean);
        return `${row.name}${row.count > 1 ? ` ×${row.count}` : ''} (${about.join(', ')})`;
    });
    return `Mounts: ${text.join('; ')}`;
}

// ---------- changing the rows ----------

const told = ctx => ctx.cause !== 'story';

function rowOf(scene, name) {
    const key = nameKey(name);
    return Object.entries(scene.mounts ?? {}).find(([, row]) => nameKey(row.name) === key) ?? [null, null];
}

// A text field as stored: one line, cut with an ellipsis; null when the line did not give it.
const textOf = (value, max) => (value === null || value === undefined ? null : trimText(value, max));

// A whole number between 1 and `max` from a line's label (null when it gave none); a number outside is held to the range
// and said in the Problem, anything else is refused.
function whole(ctx, text, what, max, notes, parse = parseCount) {
    if (text === null || text === undefined || text === '') return null;
    const n = typeof text === 'number' ? text : parse(text);
    if (!Number.isSafeInteger(n)) return ctx.fail('INVALID', fill(M.notNumber, { what }));
    const held = Math.min(max, Math.max(1, n));
    if (held !== n) notes.push(fill(M.held, { what, n: held }));
    return held;
}

const paceNumber = text => {
    const m = /^\s*(\d{1,6})(?:\s*(?:km|kms|kilometres|kilometers)?\s*(?:\/|per|a)?\s*(?:day|d)?)?\s*$/i.exec(String(text ?? ''));
    return m ? Number(m[1]) : null;
};

// `match` is the mount the line names; `rename` (the pencil only) is the name it should have now.
function apply(ctx, { match, rename: to = null, kind, count, pace, condition, where }, { create, notes = [] }) {
    const scene = ctx.draft('scene');
    const name = match;
    const [key, found] = rowOf(scene, match);
    if (!found) {
        if (!create) return ctx.fail('NOT_FOUND', fill(M.none, { name: match }));
        const rows = Object.keys(scene.mounts ?? {}).length;
        if (rows >= MAX_ROWS) return ctx.fail('REFUSED', fill(M.full, { max: MAX_ROWS, name }));
        scene.mounts ??= {};
        let at = rowKey(name);
        for (let n = 2; Object.hasOwn(scene.mounts, at); n += 1) at = `${rowKey(name)}#${n}`;
        const row = { name, kind: kind ?? '', count: count ?? 1, pace: pace ?? paceOfKind(kind), condition: condition ?? '', where: where ?? '' };
        scene.mounts[at] = row;
        return { summary: fill(M.added, { name, n: row.count > 1 ? ` ×${row.count}` : '', about: [row.kind, `${row.pace} km/day`].filter(Boolean).join(', ') }), data: { name, key: at, created: true }, narrate: told(ctx), ...(notes.length ? { problem: notes.join(' ') } : {}) };
    }
    // Only this row's own changes are written, so a replay after an earlier reply was deleted finds it as it is.
    ctx.ifThere('scene', `/mounts/${escapeKey(key)}`);
    const row = scene.mounts[key];
    const before = { ...row };
    if (to && to !== row.name) {
        if (Object.values(scene.mounts).some(other => other !== row && nameKey(other.name) === nameKey(to))) return ctx.fail('REFUSED', fill(M.taken, { name: to }));
        row.name = to;
    }
    if (kind !== null && kind !== undefined) {
        // A pace left at the old kind's usual one follows the new kind, unless the line gives one.
        if (pace === null && row.pace === paceOfKind(row.kind)) row.pace = paceOfKind(kind);
        row.kind = kind;
    }
    if (count !== null && count !== undefined) row.count = count;
    if (pace !== null && pace !== undefined) row.pace = pace;
    if (condition !== null && condition !== undefined) row.condition = condition;
    if (where !== null && where !== undefined) row.where = where;
    const changed = FIELDS.filter(field => row[field] !== before[field]);
    const parts = changed.filter(field => field !== 'name').map(field => (field === 'pace' ? `${row.pace} km/day` : field === 'count' ? `×${row.count}` : row[field] || fill(M.cleared, { field })));
    const rename = changed.includes('name') ? fill(M.renamed, { old: before.name, name: row.name }) : '';
    return {
        summary: changed.length ? `${[rename, parts.length ? `${row.name}: ${parts.join(', ')}` : ''].filter(Boolean).join('; ')}.` : fill(M.same, { name: row.name }),
        data: { name: row.name, key, changed },
        narrate: told(ctx) && changed.length > 0,
        ...(notes.length ? { problem: notes.join(' ') } : {}),
    };
}

function remove(ctx, name) {
    const scene = ctx.draft('scene');
    const [key, row] = rowOf(scene, name);
    // The story often takes away a mount the party never had (or already lost): nothing to undo, as with `- present`.
    if (!row && ctx.cause === 'story') return { summary: fill(M.notWith, { name }), data: { name, missing: true }, narrate: false };
    if (!row) return ctx.fail('NOT_FOUND', fill(M.none, { name }));
    ctx.ifThere('scene', `/mounts/${escapeKey(key)}`);
    delete scene.mounts[key];
    return { summary: fill(M.removed, { name: row.name }), data: { name: row.name, key, removed: true }, narrate: told(ctx) };
}

/**
 * `+ mount Grey Mare | kind: horse | count: 1 | pace: 35 | where: ridden by Wessel` (a mount the party gets; one already
 * here is updated by what the line gives), `~ mount Burr | condition: lame | where: stabled at the Stray Oar`, `- mount Burr`.
 * A missing pace takes the kind's usual one. A seventh row is refused.
 */
export function captureMount(ctx, line) {
    const name = cleanName(line?.name);
    if (!name) ctx.fail('INVALID', M.needName);
    if (Array.from(name).length > MAX_NAME) ctx.fail('INVALID', fill(M.longName, { max: MAX_NAME }));
    if (line.op === '-') return remove(ctx, name);
    if (line.op !== '+' && line.op !== '~') ctx.fail('INVALID', fill(M.badOp, { op: line.op }));
    const notes = [];
    const kind = textOf(labelOf(line, 'kind', 'type'), MAX_KIND);
    const fields = {
        kind,
        count: whole(ctx, labelOf(line, 'count', 'qty', 'quantity'), 'count', MAX_COUNT, notes),
        pace: whole(ctx, labelOf(line, 'pace', 'speed'), 'pace', MAX_PACE, notes, paceNumber),
        condition: textOf(labelOf(line, 'condition', 'state'), MAX_CONDITION),
        where: textOf(labelOf(line, 'where', 'at', 'with'), MAX_WHERE),
    };
    // `~` names a mount the party has; `+` makes it when it is new and updates it when it is not.
    return apply(ctx, { ...fields, match: name }, { create: line.op === '+', notes });
}

/** `mounts.edit({ mount, name?, kind?, count?, pace?, condition?, where? })`: the reader's pencil on a row, kept on the latest reply. */
function editRow(ctx, payload = {}) {
    if (ctx.cause !== 'ui' || ctx.caller !== null) ctx.fail('REFUSED', M.readerOnly);
    const mount = cleanName(payload.mount);
    if (!mount) ctx.fail('INVALID', M.which);
    const notes = [];
    const text = (field, max) => {
        if (payload[field] === undefined || payload[field] === null) return null;
        if (typeof payload[field] !== 'string') ctx.fail('INVALID', fill(M.notText, { what: field }));
        return field === 'name' ? cleanName(payload[field]) : trimText(payload[field], max);
    };
    const number = (field, max, parse) => (payload[field] === undefined || payload[field] === null ? null : whole(ctx, typeof payload[field] === 'number' ? payload[field] : String(payload[field]), field, max, notes, parse));
    const name = text('name', MAX_NAME);
    if (name !== null && !name) ctx.fail('INVALID', M.needName);
    if (name !== null && Array.from(name).length > MAX_NAME) ctx.fail('INVALID', fill(M.longName, { max: MAX_NAME }));
    const result = apply(ctx, {
        match: mount, rename: name, kind: text('kind', MAX_KIND), count: number('count', MAX_COUNT, parseCount), pace: number('pace', MAX_PACE, paceNumber),
        condition: text('condition', MAX_CONDITION), where: text('where', MAX_WHERE),
    }, { create: false, notes });
    return { ...result, data: { ...result.data, edit: true } };
}

export const mountsCommands = {
    'mounts.edit': Object.assign(editRow, { feature: MOUNTS_FEATURE }),
};

/** The queries: `mounts.list` → rows, `mounts.pace` → the party's pace or null. `riders(state)` says how many have to be carried. */
export function createMountsQueries({ riders = () => 1 } = {}) {
    return {
        'mounts.list': Object.assign(state => mountRows(state), { feature: MOUNTS_FEATURE }),
        'mounts.pace': Object.assign(state => {
            let people = 1;
            try { people = riders(state); } catch { people = 1; }
            return mountsPace(state, people);
        }, { feature: MOUNTS_FEATURE }),
    };
}
