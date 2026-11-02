// The Game view hero's one editor (view/widgets/hero.js): the fields it shows and the commands its Save runs, as plain data, so both are
// tested without a page. `heroEditFields(p)` are the fields of `ss.editable` kind `fields` (two groups, "Story" and "Character"); `heroEditPlan(p)`
// is its `plan(changed, all)`: which commands a Save sends, in which order, for the fields that changed only.
//
// Order: the story clock first (`director.clock`, Story Director; one command for the whole date and time), then `scene.place`, `scene.weather`,
// `scene.present`, `scene.you`. A refusal stops the rest (the widget shows its sentence under the fields and keeps the form open). The clock fields
// exist only where Story Director answers its time with `parts` and a calendar with months (`p.clock`, game-header.js); without them the Story group keeps
// place, weather and Here. The Character group exists only while `p.you` is given (`story-block.you` on).

import { STRINGS, fill } from '../strings.js';
import { cutAt } from '../../text.js';

const short = (value, max) => cutAt(String(value ?? '').replace(/\s+/g, ' ').trim(), max);
const S = STRINGS.scene;

export const CLOCK_KEYS = Object.freeze(['year', 'month', 'day', 'time']);
const HERE_MAX = 12;
const NAME_MAX = 80;

/** Minutes of a day (0..1439) as a time box's "HH:MM"; '' for anything else. */
export function timeText(minutes) {
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1439) return '';
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** A time box's "HH:MM" (or "HH:MM:SS") as minutes of the day; null for anything else. */
export function timeMinutes(text) {
    const found = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(text ?? '').trim());
    if (!found) return null;
    const hours = Number(found[1]);
    const minutes = Number(found[2]);
    return hours <= 23 && minutes <= 59 ? hours * 60 + minutes : null;
}

/** The people as a comma-separated line, and back: names trimmed, empty ones dropped, each once (any case), at most HERE_MAX. */
export const hereText = names => (Array.isArray(names) ? names : []).join(', ');
export function hereNames(text) {
    const out = [];
    for (const piece of String(text ?? '').split(',')) {
        const name = short(piece, NAME_MAX);
        if (name && !out.some(other => other.toLowerCase() === name.toLowerCase())) out.push(name);
        if (out.length >= HERE_MAX) break;
    }
    return out;
}

// The clock as the header gives it: `{ parts: { year, month, day, minutes } | null, era, months: [{ name, days }] }`, else null (no clock fields).
function clockOf(clock) {
    if (!clock || typeof clock !== 'object' || !Array.isArray(clock.months) || !clock.months.length) return null;
    const parts = clock.parts && typeof clock.parts === 'object' ? clock.parts : null;
    return { parts, era: short(clock.era, 20), months: clock.months };
}

/** Whether the hero's clock fields are there for these props. */
export const hasClock = p => clockOf(p?.clock) !== null;

/** The fields of the editor for the hero's props `p` (`where`, `you`, `clock`, `place`, `weather`). */
export function heroEditFields(p) {
    const where = p?.where && typeof p.where === 'object' ? p.where : {};
    const fields = [];
    const clock = clockOf(p?.clock);
    if (clock) {
        const { parts } = clock;
        const longest = Math.max(...clock.months.map(month => Number(month?.days) || 0), 1);
        fields.push(
            { key: 'year', label: clock.era ? fill(S.fieldYearEra, { era: clock.era }) : S.fieldYear, type: 'number', value: parts ? parts.year : '', soft: true, group: S.groupStory, row: 'date' },
            {
                key: 'month', label: S.fieldMonth, type: 'choice', value: parts ? parts.month : '', group: S.groupStory, row: 'date',
                options: [...(parts ? [] : [{ value: '', label: '—' }]), ...clock.months.map((month, at) => ({ value: at + 1, label: short(month?.name, 40) || String(at + 1) }))],
            },
            { key: 'day', label: S.fieldDay, type: 'number', value: parts ? parts.day : '', min: 1, max: longest, soft: true, group: S.groupStory, row: 'date' },
            { key: 'time', label: S.fieldTime, type: 'time', value: parts ? timeText(parts.minutes) : '', group: S.groupStory, row: 'date' },
        );
    }
    const places = (Array.isArray(where.places) ? where.places : []).map(item => short(typeof item === 'string' ? item : item?.name, NAME_MAX)).filter(Boolean);
    fields.push({ key: 'place', label: S.fieldPlace, type: 'text', value: short(where.place, NAME_MAX) || short(p?.place, NAME_MAX), options: places, maxLength: NAME_MAX, group: S.groupStory });
    if (where.weatherOn !== false) fields.push({ key: 'weather', label: S.fieldWeather, type: 'text', value: short(where.weatherText, 60) || short(p?.weather, 60), maxLength: 60, group: S.groupStory });
    fields.push({ key: 'here', label: S.fieldHere, type: 'text', value: hereText(hereNames(hereText(where.present))), maxLength: HERE_MAX * (NAME_MAX + 2), group: S.groupStory });
    const you = p?.you && typeof p.you === 'object' ? p.you : null;
    if (you) {
        const rankLabel = short(you.rankLabel, 30);
        if (rankLabel) fields.push({ key: 'rank', label: rankLabel, type: 'text', value: typeof you.rank === 'string' ? you.rank : '', maxLength: 120, group: S.groupCharacter });
        fields.push(
            { key: 'wearing', label: S.fieldWearing, type: 'text', value: typeof you.wearing === 'string' ? you.wearing : '', maxLength: 120, group: S.groupCharacter },
            { key: 'condition', label: S.fieldCondition, type: 'text', value: typeof you.condition === 'string' ? you.condition : '', maxLength: 120, group: S.groupCharacter },
        );
    }
    return fields;
}

/**
 * The editor's `plan(changed, all)` for the hero's props: `changed` holds the fields whose value differs from what the form opened with, `all` every
 * field. → `{ error }` (a sentence, nothing sent) or `{ steps: [{ command, payload, keys }] }`, in the order above.
 */
export function heroEditPlan(p) {
    const where = p?.where && typeof p.where === 'object' ? p.where : {};
    const you = p?.you && typeof p.you === 'object' ? p.you : null;
    const command = typeof you?.command === 'string' && you.command ? you.command : 'scene.you';
    const present = hereNames(hereText(where.present));
    return (changed = {}, all = {}) => {
        const steps = [];
        const has = key => Object.hasOwn(changed, key);
        if (CLOCK_KEYS.some(has)) {
            const minutes = timeMinutes(all.time);
            const { year, month, day } = all;
            if (!Number.isSafeInteger(year) || !Number.isSafeInteger(month) || !Number.isSafeInteger(day) || minutes === null) return { error: S.clockNeeded };
            steps.push({ command: 'director.clock', payload: { year, month, day, minutes }, keys: [...CLOCK_KEYS] });
        }
        // The people stay with a move, as they did when the place had its own pencil.
        if (has('place')) steps.push({ command: 'scene.place', payload: { with: present, name: String(changed.place) }, keys: ['place'] });
        if (has('weather')) steps.push({ command: 'scene.weather', payload: { text: String(changed.weather) }, keys: ['weather'] });
        // The same people typed with other spaces are no change.
        const people = has('here') ? hereNames(changed.here) : present;
        if (has('here') && (people.length !== present.length || people.some((name, at) => name !== present[at]))) steps.push({ command: 'scene.present', payload: { set: people }, keys: ['here'] });
        const look = {};
        for (const part of ['rank', 'wearing', 'condition']) if (has(part)) look[part] = String(changed[part]);
        if (Object.keys(look).length) steps.push({ command, payload: look, keys: Object.keys(look) });
        return { steps };
    };
}
