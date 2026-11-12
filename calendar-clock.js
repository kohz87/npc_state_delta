/* NPC State Delta story-clock bridge: the Story Director clock source and memo, story-minute
   formatting, agreement with Delta's calendar, and hosted/current date fallbacks. Split from
   calendar.js as a line-for-line part; the original keeps the public exports. */

import { getActiveCalendarConfig, MAX_CALENDAR_DAYS_PER_MONTH, MAX_CALENDAR_MONTHS, normalizeCalendarConfig, normalizeMonthKey } from './calendar-config.js';
import { currentCalendarDate, legacyLeapYear, normalizeCalendarDate } from './calendar-date.js';

// (v2) Hosted by Story Block v2, the story's date can come from Story Director's clock: index.js sets a
// source that answers { minutes, calendar } (its `director.time` minutes and `director.calendar` config)
// or null (no host, no Story Director, its clock not set yet, or Delta's calendar kept as "mine"). Without
// a source, or when it answers null, nothing here runs and the dates are Delta's own (v1).
let storyClockSource = null;

export function setStoryClockSource(source = null) {
    storyClockSource = typeof source === 'function' ? source : null;
}

// (1.10.1) One synchronous pass over every dossier (a chat state's normalization) asks for the story's
// clock once, not twice per dossier: each ask is two Story Block queries. Nothing can move the clock
// inside a synchronous pass, so every dossier sees the same answer it would have got on its own.
let storyClockMemo = null;

export function withStoryDateMemo(task) {
    if (storyClockMemo) return task();
    storyClockMemo = { read: false, clock: null };
    try { return task(); }
    finally { storyClockMemo = null; }
}

function readStoryClock() {
    if (!storyClockMemo) return storyClockSource();
    if (!storyClockMemo.read) {
        storyClockMemo.read = true;
        try { storyClockMemo.clock = storyClockSource(); } catch { storyClockMemo.clock = null; }
    }
    return storyClockMemo.clock;
}

// (memory dates) The story's date as of reply `index`, in the dossier's words ("Icewane 27"), or '' without a host clock. index.js sets a
// source that asks the hosted adapter at that reply, so a date is the same live and in a replay (the date of the reply, not of viewing).
let storyDateAtSource = null;

export function setStoryDateAtSource(source = null) {
    storyDateAtSource = typeof source === 'function' ? source : null;
}

export function storyDateTextAt(index) {
    if (!storyDateAtSource || !Number.isInteger(index) || index < 0) return '';
    try { return String(storyDateAtSource(index) ?? '').trim().slice(0, 40); } catch { return ''; }
}

const STORY_DAY_MINUTES = 1440;
const GREGORIAN_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// Story Director's date arithmetic (its src/calendar.js makeCalendar): story time is minutes since year
// 0, the first month, day 1, 00:00; months of fixed length, with Gregorian leap years when `leapYears`
// (the extra day in the second month). → { year, monthIndex, day } or null for a malformed clock.
function storyClockParts(minutes, calendar) {
    if (!Number.isSafeInteger(minutes) || !calendar || typeof calendar !== 'object' || !Array.isArray(calendar.months)) return null;
    const months = calendar.months.slice(0, MAX_CALENDAR_MONTHS + 1);
    if (!months.length || months.length > MAX_CALENDAR_MONTHS) return null;
    const lengths = months.map(month => Number(month?.days));
    if (!lengths.every(days => Number.isInteger(days) && days >= 1 && days <= MAX_CALENDAR_DAYS_PER_MONTH)) return null;
    const leapYears = calendar.leapYears === true;
    const count = lengths.length;
    const leapMonth = count > 1 ? 1 : 0;
    const baseYear = lengths.reduce((sum, days) => sum + days, 0);
    const averageYear = baseYear + (leapYears ? 0.2425 : 0);
    const leap = year => leapYears && legacyLeapYear(year);
    const leapsBefore = year => Math.floor((year - 1) / 4) - Math.floor((year - 1) / 100) + Math.floor((year - 1) / 400) + 1;
    const daysBeforeYear = year => baseYear * year + (leapYears ? leapsBefore(year) : 0);
    const daysIn = (year, month) => lengths[month] + (month === leapMonth && leap(year) ? 1 : 0);
    const total = Math.floor(minutes / STORY_DAY_MINUTES);
    let year = Math.floor(total / averageYear);
    while (daysBeforeYear(year) > total) year -= 1;
    while (daysBeforeYear(year + 1) <= total) year += 1;
    let rest = total - daysBeforeYear(year);
    let month = 0;
    while (month < count - 1 && rest >= daysIn(year, month)) rest -= daysIn(year, month++);
    return Number.isSafeInteger(year) && Math.abs(year) <= 999999 ? { year, monthIndex: month, day: rest + 1 } : null;
}

const GREGORIAN_MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * A story minute as the dossier writes a date: "Goldwane 18" (month and day, no year, no clock) on `calendar`
 * (`{ months: [{ name, days }], leapYears }`, Story Director's `director.calendar`), Gregorian when it is not given
 * ('' for anything that is not a story minute). Story Director's key people carry their dates as minutes.
 */
export function storyMinuteText(minutes, calendar = null) {
    const shared = calendar && Array.isArray(calendar.months) && calendar.months.length
        ? calendar
        : { months: GREGORIAN_MONTH_NAMES.map((name, at) => ({ name, days: GREGORIAN_DAYS[at] })), leapYears: true };
    const parts = storyClockParts(minutes, shared);
    const name = parts ? String(shared.months[parts.monthIndex]?.name ?? '').trim() : '';
    return name ? `${name} ${parts.day}` : '';
}

/**
 * The date Story Director's clock (`{ minutes, calendar }`) is on Delta's calendar `config`, or null when
 * Delta cannot write it there. Delta keeps its own calendar (its prompts' birthday shape and era are
 * unchanged), so the clock is used only where both calendars agree:
 * - Delta with no calendar of its own (numeric Gregorian dates): Story Director's Gregorian one
 *   (twelve months of the Gregorian lengths, with leap years) → { era: '', year, month: 'MM', day };
 * - Delta's own months: Story Director's must be the same months (names, ignoring case, and lengths, in
 *   order) → { era: Delta's era, year, month: its name, day }; a leap day Delta's calendar has not got
 *   (the 29th of a 28-day month) gives null for that day.
 * Any other pair (a pack's calendar on one side only) gives null: Delta's own dates stand.
 */
export function storyClockDate(clock = null, config = null) {
    const parts = storyClockParts(clock?.minutes, clock?.calendar);
    if (!parts) return null;
    const shared = clock.calendar.months;
    const normalized = normalizeCalendarConfig(config, { requireCurrentDate: false });
    if (!normalized.calendarValid) {
        const gregorian = clock.calendar.leapYears === true && shared.length === 12 && shared.every((month, at) => Number(month?.days) === GREGORIAN_DAYS[at]);
        if (!gregorian) return null;
        return normalizeCalendarDate({ era: '', year: parts.year, month: String(parts.monthIndex + 1).padStart(2, '0'), day: parts.day }, null);
    }
    const own = normalized.config.months;
    const same = own.length === shared.length && own.every((month, at) => normalizeMonthKey(month.name) === normalizeMonthKey(shared[at]?.name) && month.days === Number(shared[at]?.days));
    if (!same) return null;
    const month = own[parts.monthIndex];
    if (!month || parts.day > month.days) return null;
    return normalizeCalendarDate({ era: normalized.config.era, year: parts.year, month: month.name, day: parts.day }, normalized.config);
}

/** The story's date from the clock source on `config` (storyClockDate), or null without one. */
export function hostedStoryDate(config = getActiveCalendarConfig()) {
    if (!storyClockSource) return null;
    let clock = null;
    try { clock = readStoryClock(); } catch { return null; }
    return clock ? storyClockDate(clock, config) : null;
}

/** Today in the story when nothing more grounded is given: the hosted story date, else Delta's manual clock. */
export function storyCurrentDate(config = null) {
    return hostedStoryDate(config) || currentCalendarDate(config);
}
