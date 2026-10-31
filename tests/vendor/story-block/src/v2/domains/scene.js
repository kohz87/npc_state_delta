// The `scene` domain (§7): where the story is, who is present, the weather and what {{user}} wears and how they
// are, with its validator, commands, capture kinds `place`, `present`, `weather` and `you`, queries and prompt view. Pure.

import { isPlainObject, labelOf } from './common.js';
import { cleanName, trimText } from './names.js';
import { foldKey } from '../../text.js';
import { lineBody } from '../capture.js';
import { cutPoints, flatten } from '../extras.js';
import { CORE_FEATURE } from '../features.js';
import { validateMounts } from './mounts.js';
import { STRINGS, fill } from '../strings.js';

const E = STRINGS.editMessages;

const MAX_NAME = 80;
const MAX_PRESENT = 40;
/** A weather text is at most this many code points (cut, an ellipsis in the last place). */
export const WEATHER_CHARS = 60;
/** The weather in the tail's Place line is cut to this many code points (about 8 tokens with its separator). */
export const WEATHER_TAIL_CHARS = 26;
/** The mark a module's rule leaves on the weather it set (`scene.weather` command `key`), at most this many code points. */
export const WEATHER_KEY_CHARS = 80;
export const WEATHER_FEATURE = CORE_FEATURE.weather;
/** What {{user}} wears and their condition (`~ you`): each at most this many code points (cut, an ellipsis in the last place). */
export const YOU_CHARS = 120;
export const YOU_FEATURE = CORE_FEATURE.you;
const YOU_PARTS = Object.freeze(['rank', 'wearing', 'condition']);

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
            if (weather.key !== undefined && (typeof weather.key !== 'string' || !weather.key || Array.from(weather.key).length > WEATHER_KEY_CHARS)) errors.push(`The weather's key is not text of at most ${WEATHER_KEY_CHARS} characters.`);
        }
    }
    errors.push(...validateMounts(slice));
    // {{user}}'s look (`~ you`, MODULES §F126): absent until a reply first writes one; each part may be missing (read as '').
    if (slice.you !== undefined) {
        if (!isPlainObject(slice.you)) errors.push('Your look is not a record.');
        else {
            for (const part of YOU_PARTS) {
                const value = slice.you[part];
                if (value === undefined) continue;
                if (typeof value !== 'string') errors.push(`Your ${part} is not text.`);
                else if (Array.from(value).length > YOU_CHARS) errors.push(`Your ${part} is longer than ${YOU_CHARS} characters.`);
            }
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

/**
 * `scene.weather({ text?, key? })`: the weather a module's rule sets (Story Director's weather from its
 * calendar and the region, MODULES §F122), cause `system` (or `ui`), never the story (it writes `~ weather`).
 * With `text`: the weather now, cleaned as a `~ weather` line is, marked with `key` (what the rule chose it
 * for, such as the story day and region; one line, at most WEATHER_KEY_CHARS). Without `text`: the weather
 * as it is (the story's own `~ weather`) is marked with `key`, its words kept, so the rule knows the story's
 * word stands for that key. The same text and key again change nothing. A story `~ weather` line writes
 * `{ text, rev }` without a key, so the mark goes with it.
 */
function setWeather(ctx, { text, key } = {}) {
    if (ctx.cause === 'story') ctx.fail('REFUSED', 'The story writes the weather with a ~ weather line.');
    if (key !== undefined && key !== null && typeof key !== 'string') ctx.fail('INVALID', 'The weather\'s key must be text.');
    const mark = flatten(String(key ?? ''));
    if (Array.from(mark).length > WEATHER_KEY_CHARS) ctx.fail('INVALID', `The weather's key is longer than ${WEATHER_KEY_CHARS} characters.`);
    const scene = ctx.draft('scene');
    const keyed = mark ? { key: mark } : {};
    if (text === undefined || text === null || text === '') {
        if (!scene.weather?.text) ctx.fail('NOT_FOUND', 'There is no weather to mark yet; give its text.');
        if ((scene.weather.key ?? '') === mark) return { summary: `The weather stays: ${scene.weather.text}.`, data: { text: scene.weather.text, key: mark, same: true }, narrate: false };
        const { key: _old, ...rest } = scene.weather;
        scene.weather = { ...rest, ...keyed };
        return { summary: `The weather stays: ${scene.weather.text}.`, data: { text: scene.weather.text, key: mark, kept: true }, narrate: false };
    }
    if (typeof text !== 'string') ctx.fail('INVALID', 'The weather must be text.');
    const clean = weatherText(`~ weather ${text}`);
    if (!clean) ctx.fail('INVALID', 'The weather has no words.');
    if (scene.weather?.text === clean && (scene.weather.key ?? '') === mark) return { summary: `The weather stays: ${clean}.`, data: { text: clean, key: mark, same: true }, narrate: false };
    scene.weather = { text: clean, rev: Number.isSafeInteger(ctx.rev) ? ctx.rev : 0, ...keyed };
    return { summary: `The weather: ${clean}.`, data: { text: clean, key: mark }, narrate: false };
}

// The list editor replaces the whole set of names with one reader command. Existing add/remove
// actions keep their semantics for story lines and module calls.
function setPresent(ctx, value) {
    if (ctx.cause !== 'ui' || ctx.caller !== null) ctx.fail('REFUSED', E.presentReader);
    if (!Array.isArray(value)) ctx.fail('INVALID', E.presentList);
    const scene = ctx.draft('scene');
    const before = scene.present;
    const present = companions(ctx, value);
    scene.present = present;
    return { summary: fill(E.presentSummary, { names: present.join(', ') || E.nobody }),
        data: { added: present.filter(name => !before.includes(name)), removed: before.filter(name => !present.includes(name)), present: [...present] }, narrate: true };
}

/**
 * `scene.you({ rank?, wearing?, condition? })`: {{user}}'s standing, what they wear and how they are, from the reader (the pencils on Home) or a
 * module, never the story (it writes `~ you`). A part that is given replaces that part, '' clears it; a part left out stays.
 */
function setYou(ctx, payload = {}) {
    if (ctx.cause === 'story') ctx.fail('REFUSED', 'The story writes your look with a ~ you line.');
    const parts = {};
    for (const part of YOU_PARTS) {
        const value = payload?.[part];
        if (value === undefined || value === null) continue;
        if (typeof value !== 'string') ctx.fail('INVALID', `Your ${part} must be text.`);
        parts[part] = youText(value);
    }
    if (!Object.keys(parts).length) ctx.fail('INVALID', 'Say what you wear or how you are.');
    return changeYou(ctx, parts);
}

// The Rank's label the first enabled pack that declares one gives ('' when no pack does: this story has no Rank).
function rankLabelIn(query) {
    try {
        const found = query('packs.youRank', {});
        return typeof found?.label === 'string' ? found.label : '';
    } catch { return ''; }
}

// Puts the given parts into the scene: a part that differs replaces that part only (one op each, so a replay after an earlier
// reply was deleted keeps the other part as the replies still there left it). Nothing differs: nothing is written.
function changeYou(ctx, parts) {
    // Rank comes from a pack: a story with none has no Rank, so a line or a call that names it is refused (nothing saved).
    if (parts.rank !== undefined && !rankLabelIn(ctx.query)) ctx.fail('INVALID', 'This story has no rank, so "rank" was not used (a pack can give your character one).');
    const scene = ctx.draft('scene');
    const held = isPlainObject(scene.you) ? scene.you : null;
    const now = part => (typeof held?.[part] === 'string' ? held[part] : '');
    const next = held ? { ...held } : { rank: '', wearing: '', condition: '' };
    const said = [];
    for (const part of YOU_PARTS) {
        if (parts[part] === undefined || parts[part] === now(part)) continue;
        next[part] = parts[part];
        said.push(parts[part] ? `${part} ${parts[part]}` : `${part} cleared`);
    }
    const data = part => parts[part] === undefined ? now(part) : parts[part];
    if (!said.length) return { summary: 'Your look stays.', data: { rank: now('rank'), wearing: now('wearing'), condition: now('condition'), same: true }, narrate: false };
    scene.you = next;
    return { summary: `Your look: ${said.join('; ')}.`, data: { rank: data('rank'), wearing: data('wearing'), condition: data('condition') }, narrate: false };
}

function markEdit(ctx, result) {
    if (ctx.cause === 'ui') result.data = { ...result.data, edit: true };
    return result;
}

export const sceneCommands = {
    // { name, kind?, region?, with?: name | name[] } (a move leaves behind everyone not named in `with`)
    'scene.place': (ctx, payload = {}) => markEdit(ctx, setPlace(ctx, payload)),
    // { add?: name | name[], remove?: name | name[] }
    'scene.present': (ctx, payload = {}) => markEdit(ctx, payload.set === undefined ? changePresent(ctx, payload) : setPresent(ctx, payload.set)),
    // { text?, key? } (a module's rule; the story writes `~ weather`)
    'scene.weather': Object.assign((ctx, payload = {}) => markEdit(ctx, setWeather(ctx, payload)), { feature: WEATHER_FEATURE }),
    // { rank?, wearing?, condition? } ('' clears a part; the story writes `~ you`)
    'scene.you': Object.assign((ctx, payload = {}) => markEdit(ctx, setYou(ctx, payload)), { feature: YOU_FEATURE }),
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

// A part of {{user}}'s look as stored: plain words on one line (markdown, tags and invisible characters gone), cut by code
// points; '' (which clears the part) when it holds no word.
export function youText(raw) {
    const text = flatten(lineBody(`~ you ${raw ?? ''}`).replace(/<[^>]*>?/g, ' ').replace(/[<>]/g, ' '));
    return HAS_WORD.test(text) ? cutPoints(text, YOU_CHARS) : '';
}

// The words a change line may call each part.
const YOU_LABELS = Object.freeze({ rank: 'rank', standing: 'rank', wearing: 'wearing', wear: 'wearing', wears: 'wearing', worn: 'wearing', outfit: 'wearing', clothes: 'wearing', clothing: 'wearing', condition: 'condition', state: 'condition' });

/**
 * The parts a `~ you` line gives: `{ rank?, wearing?, condition? }` from "rank: … | wearing: … | condition: …" (any of them is fine; a part
 * with no words is '', which clears it). A piece after a `|` with no label of its own goes on the part before it; one with a
 * label that is not a part ("mood: glad") is not used.
 */
export function youParts(raw) {
    const found = {};
    let last = null;
    for (const piece of lineBody(String(raw ?? '')).split('|')) {
        const named = /^\s*(\p{L}+)\s*:\s*([\s\S]*)$/u.exec(piece);
        const part = named ? YOU_LABELS[named[1].toLowerCase()] : null;
        if (part) {
            found[part] = named[2];
            last = part;
        } else if (named) last = null;   // a label that is not one of the parts: not used, and not part of the one before
        else if (last && piece.trim()) found[last] = `${found[last].trimEnd()}, ${piece.trim()}`;
    }
    for (const part of Object.keys(found)) found[part] = youText(found[part]);
    return found;
}

/**
 * `~ you rank: F-rank, Adventurer Guild | wearing: oilskin coat, boots | condition: tired and cold` (or `+ you`): {{user}}'s
 * standing, what they wear and how they are,
 * descriptive only (no mechanics read it). Either part alone is fine and the other stays; an empty one clears its part. Kept as
 * `scene.you = { rank, wearing, condition }`, each part written on its own, and `you` is one of the scene's `scratch` fields, so a
 * later reply's write replays after the reply that first wrote one is deleted (SPEC §2.2).
 */
export function captureYou(ctx, line) {
    if (line?.op !== '~' && line?.op !== '+') {
        ctx.fail('INVALID', `"${line?.op} you" is not a change the scene understands; use ~ you rank: … | wearing: … | condition: ….`);
    }
    const fallback = `~ you ${[`${line?.name ?? ''}${line?.text ? ` - ${line.text}` : ''}`, ...Object.entries(line?.labels ?? {}).map(([label, value]) => `${label}: ${value}`)].join(' | ')}`;
    const parts = youParts(line?.raw ?? fallback);
    if (!Object.keys(parts).length) ctx.fail('INVALID', 'The you line names no part of your look (write "~ you rank: F-rank | wearing: a grey coat | condition: tired").');
    return changeYou(ctx, parts);
}

export const sceneQueries = {
    'scene.place': state => ({ ...(state?.domains?.scene?.place ?? initialScene().place) }),
    'scene.present': state => [...(state?.domains?.scene?.present ?? [])],
    // The weather now, `{ text }`, or null when no reply wrote one (and while `story-block.weather` is off).
    'scene.weather': Object.assign(state => {
        const text = state?.domains?.scene?.weather?.text;
        return typeof text === 'string' && text ? { text } : null;
    }, { feature: WEATHER_FEATURE }),
    // What {{user}} wears and their condition, `{ wearing, condition }` ('' for what no reply said; null while `story-block.you` is off).
    // With a pack that gives a Rank (`packs.youRank`), also `rank` and `rankLabel` (the pack's word for it); without one the stored rank is
    // kept but not answered.
    'scene.you': Object.assign((state, _args, tools) => {
        const you = state?.domains?.scene?.you;
        const text = part => (typeof you?.[part] === 'string' ? you[part] : '');
        const label = typeof tools?.query === 'function' ? rankLabelIn(tools.query) : '';
        return { ...(label ? { rank: text('rank'), rankLabel: label } : {}), wearing: text('wearing'), condition: text('condition') };
    }, { feature: YOU_FEATURE }),
};

/**
 * The scene's tail lines: the place and who is present (nothing when both are empty). With `weather`
 * (the feature is on), the weather ends the Place line, cut to WEATHER_TAIL_CHARS code points. With `you` (the feature is
 * on), one more line says {{user}}'s rank, what they wear and their condition, whichever are set.
 */
export function sceneTail(state, { weather = false, you = false, rankLabel = '' } = {}) {
    const scene = state?.domains?.scene;
    const lines = [];
    const place = scene?.place;
    if (place?.name) {
        const about = [place.kind, place.region].filter(Boolean);
        const sky = weather && typeof scene.weather?.text === 'string' && scene.weather.text ? `; ${cutPoints(scene.weather.text, WEATHER_TAIL_CHARS)}` : '';
        lines.push(`Place: ${place.name}${about.length ? ` (${about.join(', ')})` : ''}${sky}`);
    }
    if (scene?.present?.length) lines.push(`Present: ${scene.present.join(', ')}`);
    if (you) {
        const said = [...(rankLabel ? [['rank', rankLabel]] : []), ['wearing', 'wears'], ['condition', 'condition']]
            .map(([part, word]) => [word, typeof scene?.you?.[part] === 'string' ? scene.you[part] : '']).filter(([, text]) => text);
        // "{{user}}: Guild rank …; wears …; condition …" (the pack's word for the Rank, only with a pack that gives one), only the parts that are set.
        if (said.length) lines.push(`{{user}}: ${said.map(([word, text]) => `${word} ${text}`).join('; ')}`);
    }
    return lines;
}
