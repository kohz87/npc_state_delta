// `content.cast` (pure): the pack's hand-written cast, checked and normalized (PACKS.md "The cast").
//
// A cast entry is a prepared person: who they are, how they look and sound, where they start, what they want and
// where they are when. Story Director keeps them off-screen until the party meets them; NPC State Delta makes
// the dossier from the entry at the first meeting. Every text is plain (no markup characters), one line.
//
// checkCast(list, packId, add) → the normalized entries `[{ id, name, aliases, about, look, … , pack }]`, or `[]` when
// anything is wrong (the problems went to `add`). `id` stays the entry's own slug: the cast key is `pack:id`.

import { CAST_BUILT_IN_METERS, CAST_FIELDS, CAST_LIMITS, CAST_SECRET_FIELDS, CAST_START_FIELDS, METER_LIMITS, METER_RESERVED, METER_STAGE_FIELDS, PORTRAIT_LIMITS, PORTRAIT_NAME, SLUG } from './limits.js';
import { foldKey, oneLine } from '../../text.js';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// Markup and brace characters never belong in a person's text; `|` splits a change line, so the short lines refuse it too.
const PLAIN = /[<>{}]/;
const SHORT = /[<>{}|]/;
const whole = value => Number.isInteger(value) && value >= METER_LIMITS.min && value <= METER_LIMITS.max;

/**
 * The normalized cast of one pack. `add(code, path, message)` collects problems. At most
 * `CAST_LIMITS.entries` entries and `PORTRAIT_LIMITS.perPack` different portrait files.
 */
export function checkCast(list, packId, add) {
    if (!Array.isArray(list)) {
        add('BAD_CONTENT', 'content.cast', 'content.cast must be a list of people like [{ "id": "fenna", "name": "Fenna", "about": "…", "look": "…", "start": { "place": "…", "goal": "…" } }].');
        return [];
    }
    if (list.length > CAST_LIMITS.entries) {
        add('BAD_CONTENT', 'content.cast', `content.cast holds at most ${CAST_LIMITS.entries} people.`);
        return [];
    }
    const out = [];
    const ids = new Set();
    const names = new Map();
    const portraits = new Set();
    let ok = true;
    list.forEach((record, index) => {
        const path = `content.cast[${index}]`;
        if (!isObject(record)) { ok = false; return add('BAD_RECORD', path, `${path} must be an object.`); }
        const label = typeof record.name === 'string' && record.name.trim() ? `Cast "${oneLine(record.name, CAST_LIMITS.name)}"` : path;
        let good = true;
        const say = (field, message, code = 'BAD_RECORD') => { good = false; add(code, `${path}.${field}`, `${label}: ${message}`); };
        for (const key of Object.keys(record)) if (!CAST_FIELDS.includes(key)) say(key, `"${key}" is not a cast field (expected ${CAST_FIELDS.join(', ')}).`, 'UNKNOWN_FIELD');

        // Text: `short` lines refuse | as well; every text is cut to one line.
        const text = (field, value, max, { required = false, short = false, what = field } = {}) => {
            if (value === undefined && !required) return undefined;
            const line = typeof value === 'string' ? oneLine(value) : '';
            if (!line) { say(field, `${what} must be text of 1 to ${max} characters.`); return undefined; }
            if ([...line].length > max) { say(field, `${what} must be text of at most ${max} characters.`); return undefined; }
            if ((short ? SHORT : PLAIN).test(line)) { say(field, `${what} is plain text: no ${short ? '< > { } |' : '< > { }'}.`); return undefined; }
            return line;
        };

        let id;
        if (typeof record.id !== 'string' || !SLUG.test(record.id)) say('id', 'id must be lowercase letters, digits and dashes (like "fenna").');
        else if (ids.has(record.id)) say('id', `two people share the id "${record.id}".`, 'DUPLICATE');
        else { id = record.id; ids.add(id); }
        const name = text('name', record.name, CAST_LIMITS.name, { required: true, short: true });
        let aliases = [];
        if (record.aliases !== undefined) {
            if (!Array.isArray(record.aliases) || record.aliases.length > CAST_LIMITS.aliases) say('aliases', `aliases must be a list of at most ${CAST_LIMITS.aliases} other names.`);
            else {
                const seen = [];
                record.aliases.forEach((alias, n) => {
                    const line = typeof alias === 'string' ? oneLine(alias) : '';
                    if (!line || [...line].length > CAST_LIMITS.name || SHORT.test(line)) return say(`aliases[${n}]`, `aliases[${n}] must be plain text of 1 to ${CAST_LIMITS.name} characters.`);
                    if (!seen.some(other => foldKey(other) === foldKey(line)) && foldKey(line) !== foldKey(name ?? '')) seen.push(line);
                });
                aliases = seen;
            }
        }
        const about = text('about', record.about, CAST_LIMITS.about, { required: true });
        const look = text('look', record.look, CAST_LIMITS.look, { required: true });
        const voice = text('voice', record.voice, CAST_LIMITS.voice);
        const personality = text('personality', record.personality, CAST_LIMITS.personality);
        const history = text('history', record.history, CAST_LIMITS.history);

        let portrait;
        if (record.portrait !== undefined) {
            if (typeof record.portrait !== 'string' || !PORTRAIT_NAME.test(record.portrait)) say('portrait', `portrait must be the name of an image file beside the pack, like "fenna.webp" (letters, digits, - and _; .webp, .png or .jpg; at most ${PORTRAIT_LIMITS.name} characters).`);
            else { portrait = record.portrait; portraits.add(portrait); }
        }

        let start;
        if (!isObject(record.start)) say('start', 'start must say where they begin: { "place": "Bluewatch docks", "goal": "…", "routine": "…" }.');
        else {
            for (const key of Object.keys(record.start)) if (!CAST_START_FIELDS.includes(key)) say(`start.${key}`, `"${key}" is not a start field (expected ${CAST_START_FIELDS.join(', ')}).`, 'UNKNOWN_FIELD');
            const place = text('start.place', record.start.place, CAST_LIMITS.place, { required: true, short: true, what: 'start.place' });
            const goal = text('start.goal', record.start.goal, CAST_LIMITS.goal, { required: true, short: true, what: 'start.goal' });
            const routine = text('start.routine', record.start.routine, CAST_LIMITS.routine, { short: true, what: 'start.routine' });
            if (place && goal) start = { place, goal, ...(routine ? { routine } : {}) };
        }

        let drawnTo;
        if (record.drawnTo !== undefined) {
            if (!Array.isArray(record.drawnTo) || record.drawnTo.length > CAST_LIMITS.drawnTo) say('drawnTo', `drawnTo must be a list of at most ${CAST_LIMITS.drawnTo} short phrases (what pulls them toward the party).`);
            else {
                const phrases = [];
                record.drawnTo.forEach((phrase, n) => {
                    const line = typeof phrase === 'string' ? oneLine(phrase) : '';
                    if (!line || [...line].length > CAST_LIMITS.phrase || SHORT.test(line)) return say(`drawnTo[${n}]`, `drawnTo[${n}] must be plain text of 1 to ${CAST_LIMITS.phrase} characters.`);
                    if (!phrases.some(other => foldKey(other) === foldKey(line))) phrases.push(line);
                });
                if (phrases.length) drawnTo = phrases;
            }
        }

        // Meters: `{ preset?, <meter>: n }`. Without a preset the meters are NPC State Delta's own four; with one, the preset's.
        let meters;
        const meterIds = new Set(CAST_BUILT_IN_METERS);
        let hasPreset = false;
        if (record.meters !== undefined) {
            if (!isObject(record.meters) || Object.keys(record.meters).length > CAST_LIMITS.meters) say('meters', `meters must be an object like { "preset": "companion", "trust": 20 } of at most ${CAST_LIMITS.meters} keys.`);
            else {
                const given = {};
                for (const [key, value] of Object.entries(record.meters)) {
                    if (key === 'preset') {
                        if (typeof value !== 'string' || !SLUG.test(value) || value.length > METER_LIMITS.id) say('meters.preset', `meters.preset must be a meter preset id (lowercase letters, digits and dashes, at most ${METER_LIMITS.id}).`);
                        else { given.preset = value; hasPreset = true; }
                    } else if (!SLUG.test(key) || key.length > METER_LIMITS.id) say(`meters.${key}`, `"${key}" is not a meter id (lowercase letters, digits and dashes, at most ${METER_LIMITS.id}).`);
                    else if (METER_RESERVED.includes(key)) say(`meters.${key}`, `"${key}" is a word NPC State Delta keeps for itself; pick another meter id.`);
                    else if (!whole(value)) say(`meters.${key}`, `meters.${key} must be a whole number from ${METER_LIMITS.min} to ${METER_LIMITS.max}.`);
                    else { given[key] = value; meterIds.add(key); }
                }
                meters = given;
            }
        }
        const knowsMeter = meter => hasPreset || meterIds.has(meter);

        let stages;
        if (record.stages !== undefined) {
            if (!Array.isArray(record.stages) || record.stages.length > METER_LIMITS.stages) say('stages', `stages must be a list of at most ${METER_LIMITS.stages} { "id", "name", "needs": [{ "meter", "at" }] }.`);
            else {
                const seen = new Set();
                const kept = [];
                record.stages.forEach((stage, n) => {
                    const at = `stages[${n}]`;
                    if (!isObject(stage)) return say(at, `${at} must be an object.`);
                    for (const key of Object.keys(stage)) if (!METER_STAGE_FIELDS.includes(key)) say(`${at}.${key}`, `"${key}" is not a stage field (expected ${METER_STAGE_FIELDS.join(', ')}).`, 'UNKNOWN_FIELD');
                    if (typeof stage.id !== 'string' || !SLUG.test(stage.id)) say(`${at}.id`, `${at}.id must be lowercase letters, digits and dashes (like "trusted").`);
                    else if (seen.has(stage.id)) say(`${at}.id`, `two stages share the id "${stage.id}".`, 'DUPLICATE');
                    else seen.add(stage.id);
                    const stageName = typeof stage.name === 'string' ? oneLine(stage.name) : '';
                    if (!stageName || [...stageName].length > METER_LIMITS.name || /[|:#<>{}]/.test(stageName)) say(`${at}.name`, `${at}.name must be plain text of 1 to ${METER_LIMITS.name} characters (no | : # < > { }).`);
                    const needs = [];
                    if (!Array.isArray(stage.needs) || !stage.needs.length || stage.needs.length > METER_LIMITS.needs) say(`${at}.needs`, `${at}.needs must be a list of 1 to ${METER_LIMITS.needs} { "meter": …, "at": … }.`);
                    else stage.needs.forEach((need, k) => {
                        const where = `${at}.needs[${k}]`;
                        if (!isObject(need) || Object.keys(need).some(key => key !== 'meter' && key !== 'at')) return say(where, `${where} must be { "meter": …, "at": … }.`);
                        if (typeof need.meter !== 'string' || !knowsMeter(need.meter)) return say(`${where}.meter`, `"${need.meter ?? ''}" is not one of this person's meters (trust, affection, desire, tension, a meter listed in meters, or a preset's).`, 'UNKNOWN_REF');
                        if (needs.some(other => other.meter === need.meter)) return say(`${where}.meter`, `${at} names the meter "${need.meter}" twice.`, 'DUPLICATE');
                        if (!whole(need.at)) return say(`${where}.at`, `${where}.at must be a whole number from ${METER_LIMITS.min} to ${METER_LIMITS.max} (0 or more: at or above it; below 0: at or below it).`);
                        needs.push({ meter: need.meter, at: need.at });
                    });
                    let milestone;
                    if (stage.milestone !== undefined) {
                        const line = typeof stage.milestone === 'string' ? oneLine(stage.milestone) : '';
                        if (!line || [...line].length > METER_LIMITS.milestone || PLAIN.test(line)) say(`${at}.milestone`, `${at}.milestone must be plain text of 1 to ${METER_LIMITS.milestone} characters.`);
                        else milestone = line;
                    }
                    if (stageName && needs.length && needs.length === stage.needs?.length) kept.push({ id: stage.id, name: stageName, needs, ...(milestone ? { milestone } : {}) });
                });
                stages = kept;
            }
        }

        let fields;
        if (record.fields !== undefined) {
            if (!isObject(record.fields) || Object.keys(record.fields).length > CAST_LIMITS.fields) say('fields', `fields must be an object of at most ${CAST_LIMITS.fields} short facts like { "Class": "Ferrywoman" }.`);
            else {
                const kept = {};
                for (const [key, value] of Object.entries(record.fields)) {
                    const fieldName = oneLine(key);
                    const fieldValue = typeof value === 'string' ? oneLine(value) : Number.isFinite(value) ? String(value) : '';
                    if (!fieldName || [...fieldName].length > CAST_LIMITS.fieldName || /["{}:<>|]/.test(fieldName)) say(`fields.${key}`, `a field name is plain text of 1 to ${CAST_LIMITS.fieldName} characters (no " { } : < > |).`);
                    else if (!fieldValue || [...fieldValue].length > CAST_LIMITS.fieldValue || SHORT.test(fieldValue)) say(`fields.${key}`, `fields.${key} must be plain text of 1 to ${CAST_LIMITS.fieldValue} characters.`);
                    else if (Object.keys(kept).some(other => foldKey(other) === foldKey(fieldName))) say(`fields.${key}`, `two fields are named "${fieldName}".`, 'DUPLICATE');
                    else kept[fieldName] = fieldValue;
                }
                fields = kept;
            }
        }

        // Secrets: hidden notes, opened by a meter reaching `at` or by a story event (`when`), one rule each. The story never rewrites them.
        let secrets;
        if (record.secrets !== undefined) {
            if (!Array.isArray(record.secrets) || record.secrets.length > CAST_LIMITS.secrets) say('secrets', `secrets must be a list of at most ${CAST_LIMITS.secrets} { "title", "text", "meter" and "at", or "when" }.`);
            else {
                const kept = [];
                record.secrets.forEach((secret, n) => {
                    const at = `secrets[${n}]`;
                    if (!isObject(secret)) return say(at, `${at} must be an object.`);
                    for (const key of Object.keys(secret)) if (!CAST_SECRET_FIELDS.includes(key)) say(`${at}.${key}`, `"${key}" is not a secret field (expected ${CAST_SECRET_FIELDS.join(', ')}).`, 'UNKNOWN_FIELD');
                    const title = typeof secret.title === 'string' ? oneLine(secret.title) : '';
                    if (!title || [...title].length > CAST_LIMITS.secretTitle || PLAIN.test(title)) say(`${at}.title`, `${at}.title must be plain text of 1 to ${CAST_LIMITS.secretTitle} characters.`);
                    const body = typeof secret.text === 'string' ? oneLine(secret.text) : '';
                    if (!body || [...body].length > CAST_LIMITS.secretText || PLAIN.test(body)) say(`${at}.text`, `${at}.text must be plain text of 1 to ${CAST_LIMITS.secretText} characters.`);
                    const byMeter = secret.meter !== undefined || secret.at !== undefined;
                    const byEvent = secret.when !== undefined;
                    let rule = null;
                    if (byMeter === byEvent) say(at, `${at} opens by a meter ("meter" and "at") or by a story event ("when"), one of the two.`);
                    else if (byMeter) {
                        if (typeof secret.meter !== 'string' || !SLUG.test(secret.meter) || !knowsMeter(secret.meter)) say(`${at}.meter`, `${at}.meter must be one of this person's meters (trust, affection, desire, tension, a meter listed in meters, or a preset's).`, 'UNKNOWN_REF');
                        else if (!whole(secret.at)) say(`${at}.at`, `${at}.at must be a whole number from ${METER_LIMITS.min} to ${METER_LIMITS.max} (0 or more: at or above it; below 0: at or below it).`);
                        else rule = { meter: secret.meter, at: secret.at };
                    } else {
                        const when = typeof secret.when === 'string' ? oneLine(secret.when) : '';
                        if (!when || [...when].length > CAST_LIMITS.secretWhen || PLAIN.test(when)) say(`${at}.when`, `${at}.when must be plain text of 1 to ${CAST_LIMITS.secretWhen} characters (the story event that opens it).`);
                        else rule = { when };
                    }
                    if (title && body && rule) kept.push({ title, text: body, ...rule });
                });
                secrets = kept;
            }
        }

        if (record.canDieUnmet !== undefined && typeof record.canDieUnmet !== 'boolean') say('canDieUnmet', 'canDieUnmet must be true or false.');

        if (name) {
            for (const each of [name, ...aliases]) {
                const key = foldKey(each);
                if (names.has(key) && names.get(key) !== id) say('name', `"${each}" is already a name or alias of another person in this pack.`, 'DUPLICATE');
                else names.set(key, id);
            }
        }
        if (!good) { ok = false; return; }
        out.push({
            id, name, aliases, about, look,
            ...(voice ? { voice } : {}), ...(personality ? { personality } : {}), ...(history ? { history } : {}),
            ...(portrait ? { portrait } : {}),
            start,
            ...(drawnTo ? { drawnTo } : {}),
            ...(meters && Object.keys(meters).length ? { meters } : {}),
            ...(stages?.length ? { stages } : {}),
            ...(fields && Object.keys(fields).length ? { fields } : {}),
            ...(secrets?.length ? { secrets } : {}),
            ...(record.canDieUnmet !== undefined ? { canDieUnmet: record.canDieUnmet } : {}),
            pack: packId,
        });
    });
    if (portraits.size > PORTRAIT_LIMITS.perPack) {
        ok = false;
        add('BAD_CONTENT', 'content.cast', `A pack may name at most ${PORTRAIT_LIMITS.perPack} different portrait files; this one names ${portraits.size}.`);
    }
    return ok ? out : [];
}
