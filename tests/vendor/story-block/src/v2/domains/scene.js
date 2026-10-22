// The `scene` domain (§7): where the story is, who is present and the weather, with its validator,
// commands, capture kinds `place`, `present` and `weather`, queries and prompt view. Pure.

import { isPlainObject, labelOf } from './common.js';
import { cleanName, trimText } from './names.js';
import { foldKey } from '../../text.js';
import { lineBody } from '../capture.js';
import { cutPoints, flatten } from '../extras.js';
import { CORE_FEATURE } from '../features.js';

const MAX_NAME = 80;
const MAX_PRESENT = 40;
/** A weather text is at most this many code points (cut, an ellipsis in the last place). */
export const WEATHER_CHARS = 60;
/** The weather in the tail's Place line is cut to this many code points (about 8 tokens with its separator). */
export const WEATHER_TAIL_CHARS = 26;
export const WEATHER_FEATURE = CORE_FEATURE.weather;

export function initialScene() {
    return { place: { name: '', kind: '', region: '' }, present: [] };
}

/** §2.5 validator for the scene slice: [] when fine, else plain sentences. */
export function validateScene(slice) {
    if (!isPlainObject(slice)) return ['The scene is not a record.'];
    const errors = [];
    const place = slice.place;
    if (!isPlainObject(place)) errors.push('The scene has no place record.');
    else {
        for (const field of ['name', 'kind', 'region']) {
            if (typeof place[field] !== 'string') errors.push(`The place's ${field} is not text.`);
            else if (place[field].length > MAX_NAME) errors.push(`The place's ${field} is longer than ${MAX_NAME} characters.`);
        }
    }
    if (!Array.isArray(slice.present)) errors.push('The scene has no list of who is present.');
    else {
        const seen = new Set();
        for (const name of slice.present) {
            if (typeof name !== 'string' || !name.trim()) {
                errors.push('Someone present has no name.');
                continue;
            }
            if (name.length > MAX_NAME) errors.push(`The name "${trimText(name, 30)}" is longer than ${MAX_NAME} characters.`);
            if (seen.has(name.toLowerCase())) errors.push(`${name} is listed as present twice.`);
            seen.add(name.toLowerCase());
        }
        if (slice.present.length > MAX_PRESENT) errors.push(`At most ${MAX_PRESENT} people can be listed as present.`);
    }
    // The weather (`~ weather`, MODULES §F120): absent until a reply first writes one.
    if (slice.weather !== undefined) {
        const weather = slice.weather;
        if (!isPlainObject(weather)) errors.push('The weather is not a record.');
        else {
            if (typeof weather.text !== 'string' || !weather.text.trim()) errors.push('The weather has no text.');
            else if (Array.from(weather.text).length > WEATHER_CHARS) errors.push(`The weather is longer than ${WEATHER_CHARS} characters.`);
            if (!Number.isSafeInteger(weather.rev) || weather.rev < 0) errors.push('The weather\'s rev is not a whole number.');
        }
    }
    return errors;
}

const told = ctx => ctx.cause !== 'story';
const nameList = value => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);

function field(ctx, value, what) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') ctx.fail('INVALID', `The place's ${what} must be text.`);
    const text = value.replace(/\s+/g, ' ').trim();
    if (text.length > MAX_NAME) ctx.fail('INVALID', `The place's ${what} is longer than ${MAX_NAME} characters.`);
    return text;
}

// Who came along to a new place: `with` as a name, a comma list or a list of names.
function companions(ctx, value) {
    const names = [];
    for (const raw of nameList(value).flatMap(item => (typeof item === 'string' ? item.split(',') : [item]))) {
        if (typeof raw !== 'string') ctx.fail('INVALID', 'Say who comes along by name.');
        const name = cleanName(raw);
        if (!name) continue;
        if (name.length > MAX_NAME) ctx.fail('INVALID', `A name is at most ${MAX_NAME} characters.`);
        if (!names.some(other => other.toLowerCase() === name.toLowerCase())) names.push(name);
    }
    if (names.length > MAX_PRESENT) ctx.fail('INVALID', `At most ${MAX_PRESENT} people can be listed as present.`);
    return names;
}

// The kind of a place a pack names (by name or alias, `packs.content({ kind: 'places' })`), or null.
function packPlaceKind(ctx, name) {
    let places;
    try { places = ctx.query('packs.content', { kind: 'places' }); } catch { return null; }
    if (!Array.isArray(places)) return null;
    const key = foldKey(name);
    const place = places.find(entry => [entry?.name, ...(Array.isArray(entry?.aliases) ? entry.aliases : [])].some(other => typeof other === 'string' && foldKey(other) === key));
    return typeof place?.kind === 'string' && place.kind.trim() ? place.kind : null;
}

// A place's kind: what the line says (an explicit empty `kind:` clears it); without `kind:`, the
// same place keeps its stored kind (a model often leaves it out), and a move to another place takes
// the kind a pack gives a place of that name, else none (B4r2-5: never the old place's kind). The
// region is kept unless the line says otherwise. Who was
// present stays behind: after a move only the people named in `with` (they came along) are here, and
// the story adds whoever it meets there (`+ present`). The same place keeps everyone; `with` adds to them.
function setPlace(ctx, { name, kind, region, with: along }) {
    const scene = ctx.draft('scene');
    const placeName = field(ctx, name, 'name');
    if (!placeName) ctx.fail('INVALID', 'A place needs a name.');
    const moved = placeName.toLowerCase() !== scene.place.name.toLowerCase();
    const came = companions(ctx, along);
    scene.place = {
        name: placeName,
        kind: field(ctx, kind, 'kind') ?? (moved ? field(ctx, packPlaceKind(ctx, placeName), 'kind') ?? '' : scene.place.kind),
        region: field(ctx, region, 'region') ?? scene.place.region,
    };
    const keys = list => new Set(list.map(person => person.toLowerCase()));
    const cameKeys = keys(came);
    const left = moved ? scene.present.filter(person => !cameKeys.has(person.toLowerCase())) : [];
    const staying = moved ? scene.present.filter(person => cameKeys.has(person.toLowerCase())) : [...scene.present];
    const stayingKeys = keys(staying);
    const present = [...staying, ...came.filter(person => !stayingKeys.has(person.toLowerCase()))];
    if (present.length > MAX_PRESENT) ctx.fail('INVALID', `At most ${MAX_PRESENT} people can be listed as present.`);
    if (present.length !== scene.present.length || present.some((person, at) => person !== scene.present[at])) scene.present = present;
    const withWho = came.length ? ` with ${came.join(', ')}` : '';
    return {
        summary: moved ? `The scene moves to ${placeName}${withWho}.` : `${placeName} is described anew.`,
        data: { ...scene.place, moved, present: [...scene.present], left },
        narrate: told(ctx),
    };
}

function changePresent(ctx, { add, remove }) {
    const scene = ctx.draft('scene');
    const index = name => scene.present.findIndex(other => other.toLowerCase() === name.toLowerCase());
    const added = [];
    const removed = [];
    const missing = [];
    for (const raw of nameList(remove)) {
        const name = typeof raw === 'string' ? cleanName(raw) : '';
        if (!name) ctx.fail('INVALID', 'Say who leaves.');
        const at = index(name);
        // The story often says who stays behind after a move, which already left them: nothing to undo.
        if (at < 0 && ctx.cause === 'story') {
            missing.push(name);
            continue;
        }
        if (at < 0) ctx.fail('NOT_FOUND', `${name} is not in the scene.`);
        removed.push(scene.present[at]);
        scene.present.splice(at, 1);
    }
    for (const raw of nameList(add)) {
        const name = typeof raw === 'string' ? cleanName(raw) : '';
        if (!name) ctx.fail('INVALID', 'Say who arrives.');
        if (name.length > MAX_NAME) ctx.fail('INVALID', `A name is at most ${MAX_NAME} characters.`);
        if (index(name) >= 0) continue;   // already here: nothing to change
        scene.present.push(name);
        added.push(name);
    }
    const parts = [];
    if (added.length) parts.push(`${added.join(', ')} ${added.length === 1 ? 'is' : 'are'} here`);
    if (removed.length) parts.push(`${removed.join(', ')} ${removed.length === 1 ? 'leaves' : 'leave'}`);
    const away = missing.length ? `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not here.` : '';
    return {
        summary: parts.length ? `${parts.join('; ')}.` : away || 'No one arrives or leaves.',
        data: { added, removed, present: [...scene.present], ...(missing.length ? { missing } : {}) },
        narrate: told(ctx) && parts.length > 0,
    };
}

export const sceneCommands = {
    // { name, kind?, region?, with?: name | name[] } (a move leaves behind everyone not named in `with`)
    'scene.place': (ctx, payload = {}) => setPlace(ctx, payload),
    // { add?: name | name[], remove?: name | name[] }
    'scene.present': (ctx, payload = {}) => changePresent(ctx, payload),
};

/** `~ place Name | kind | region | with: who came along` (or `+ place`). */
export function capturePlace(ctx, line) {
    if (line?.op !== '~' && line?.op !== '+') {
        ctx.fail('INVALID', `"${line?.op} place" is not a change the scene understands; use ~ place Name.`);
    }
    return setPlace(ctx, {
        name: cleanName(line.name),
        kind: labelOf(line, 'kind', 'type'),
        region: labelOf(line, 'region', 'area'),
        with: labelOf(line, 'with', 'present'),
    });
}

/** `+ present Name`, `- present Name` (several names may be separated by commas). */
export function capturePresent(ctx, line) {
    const names = String(line?.name ?? '').split(',').map(cleanName).filter(Boolean);
    if (!names.length) ctx.fail('INVALID', 'A present line needs a name.');
    if (line.op === '+') return changePresent(ctx, { add: names });
    if (line.op === '-') return changePresent(ctx, { remove: names });
    return ctx.fail('INVALID', `"${line.op} present" is not a change the scene understands; use + present or - present.`);
}

// A weather text as stored: the line's words (markdown and decoration gone), tags and anything inside
// `<…>` out (never markup), one plain line, cut by code points.
const HAS_WORD = /[\p{L}\p{N}]/u;
export function weatherText(raw) {
    const text = flatten(lineBody(String(raw ?? '')).replace(/<[^>]*>?/g, ' ').replace(/[<>]/g, ' '));
    return HAS_WORD.test(text) ? cutPoints(text, WEATHER_CHARS) : '';
}

/**
 * `~ weather cold drizzle, low fog` (or `+ weather`): the weather now, descriptive only (no mechanics read
 * it). Kept as `scene.weather = { text, rev }` (`rev`: the meta.rev of the receipt that wrote it). The same
 * text again changes nothing. `weather` is one of the scene's `scratch` fields, so a later reply's write
 * replays whole after the reply that first wrote a weather is deleted (SPEC §2.2).
 */
export function captureWeather(ctx, line) {
    if (line?.op !== '~' && line?.op !== '+') {
        ctx.fail('INVALID', `"${line?.op} weather" is not a change the scene understands; use ~ weather and a few words.`);
    }
    const text = weatherText(line?.raw ?? `${line?.op ?? '~'} weather ${line?.text ?? line?.name ?? ''}`);
    if (!text) ctx.fail('INVALID', 'The weather line has no words (write "~ weather cold drizzle, low fog").');
    const scene = ctx.draft('scene');
    if (scene.weather?.text === text) return { summary: `The weather stays: ${text}.`, data: { text, same: true }, narrate: false };
    scene.weather = { text, rev: Number.isSafeInteger(ctx.rev) ? ctx.rev : 0 };
    return { summary: `The weather: ${text}.`, data: { text }, narrate: false };
}

export const sceneQueries = {
    'scene.place': state => ({ ...(state?.domains?.scene?.place ?? initialScene().place) }),
    'scene.present': state => [...(state?.domains?.scene?.present ?? [])],
    // The weather now, `{ text }`, or null when no reply wrote one (and while `story-block.weather` is off).
    'scene.weather': Object.assign(state => {
        const text = state?.domains?.scene?.weather?.text;
        return typeof text === 'string' && text ? { text } : null;
    }, { feature: WEATHER_FEATURE }),
};

/**
 * The scene's tail lines: the place and who is present (nothing when both are empty). With `weather`
 * (the feature is on), the weather ends the Place line, cut to WEATHER_TAIL_CHARS code points.
 */
export function sceneTail(state, { weather = false } = {}) {
    const scene = state?.domains?.scene;
    const lines = [];
    const place = scene?.place;
    if (place?.name) {
        const about = [place.kind, place.region].filter(Boolean);
        const sky = weather && typeof scene.weather?.text === 'string' && scene.weather.text ? `; ${cutPoints(scene.weather.text, WEATHER_TAIL_CHARS)}` : '';
        lines.push(`Place: ${place.name}${about.length ? ` (${about.join(', ')})` : ''}${sky}`);
    }
    if (scene?.present?.length) lines.push(`Present: ${scene.present.join(', ')}`);
    return lines;
}
