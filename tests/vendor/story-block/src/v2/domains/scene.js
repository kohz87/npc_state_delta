// The `scene` domain (§7): where the story is, who is present, the weather and what {{user}} wears and how they
// are, with its validator, commands, capture kinds `place`, `present`, `weather` and `you`, queries and prompt view. Pure.
// The parts live in scene/ (constants, shared, present, place, weather, you); this file keeps the validator, the command and
// query tables and the tail, and re-exports every name the scene always exported, so importers keep this path.

import { isPlainObject } from './common.js';
import { trimText } from './names.js';
import { cutPoints } from '../extras.js';
import { validateMounts } from './mounts.js';
import { MAX_NAME, MAX_PRESENT, WEATHER_CHARS, WEATHER_FEATURE, WEATHER_KEY_CHARS, WEATHER_TAIL_CHARS, YOU_CHARS, YOU_FEATURE, YOU_PARTS } from './scene/constants.js';
import { markEdit } from './scene/shared.js';
import { changePresent, setPresent } from './scene/present.js';
import { setPlace } from './scene/place.js';
import { setWeather } from './scene/weather.js';
import { rankLabelIn, setYou, youNote } from './scene/you.js';

export { WEATHER_CHARS, WEATHER_TAIL_CHARS, WEATHER_KEY_CHARS, WEATHER_FEATURE, YOU_CHARS, YOU_FEATURE } from './scene/constants.js';
export { capturePresent } from './scene/present.js';
export { capturePlace } from './scene/place.js';
export { captureWeather, weatherText } from './scene/weather.js';
export { captureYou, youParts, youText, youNote } from './scene/you.js';

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
 * on), one more line says {{user}}'s rank, what they wear and their condition, whichever are set, and while wearing or condition is
 * empty a second line asks the narrator to write the empty ones (`youNote`).
 */
export function sceneTail(state, { weather = false, you = false, rankLabel = '', askLook = true } = {}) {
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
        // (Prompt diet: the ask for the look is made once per chat, on the reader's first message (`askLook` false after it), not on every reply until it is set.)
        const note = askLook ? youNote(scene?.you, rankLabel) : '';
        if (note) lines.push(note);
    }
    return lines;
}
