// The scene's weather: `~ weather cold drizzle, low fog` (the story's words, kept as they are) and the `scene.weather` command a module's
// rule uses (with a key it chose the weather for). Descriptive only; no mechanics read it. Pure.

import { cutPoints, flatten } from '../../extras.js';
import { lineBody } from '../../capture.js';
import { WEATHER_CHARS, WEATHER_KEY_CHARS } from './constants.js';
import { HAS_WORD } from './shared.js';

/**
 * `scene.weather({ text?, key? })`: the weather a module's rule sets (Story Director's weather from its
 * calendar and the region, MODULES §F122), cause `system` (or `ui`), never the story (it writes `~ weather`).
 * With `text`: the weather now, cleaned as a `~ weather` line is, marked with `key` (what the rule chose it
 * for, such as the story day and region; one line, at most WEATHER_KEY_CHARS). Without `text`: the weather
 * as it is (the story's own `~ weather`) is marked with `key`, its words kept, so the rule knows the story's
 * word stands for that key. The same text and key again change nothing. A story `~ weather` line writes
 * `{ text, rev }` without a key, so the mark goes with it.
 */
export function setWeather(ctx, { text, key } = {}) {
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

// A weather text as stored: the line's words (markdown and decoration gone), tags and anything inside
// `<…>` out (never markup), one plain line, cut by code points.
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
