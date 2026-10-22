// Story Suite v2: the story clock in words, for templates' `fmt.time(minutes)` (Home, Scene, cards, the
// status strip). Story Director keeps the clock as minutes since its calendar's epoch: year 0, the first
// month, day 1, 00:00, with Gregorian leap years when the calendar has them. This writes those minutes
// on that same calendar, the way the Director writes them: "CY 611, Goldwane 12, 7:40 pm", or
// "Goldwane 12, 611, 7:40 pm" for a calendar without an era.
//
// The calendar, first that answers:
//   1. Story Director's `director.calendar`: the one the chat's clock runs on (the reader's own choice,
//      else the enabled pack's, else Gregorian);
//   2. Story Block's `packs.calendar`: the first enabled pack's;
//   3. Gregorian.
// Pure apart from the `query` it is given.

const DAY = 1440;

const GREGORIAN = Object.freeze({
    era: '',
    leapYears: true,
    months: Object.freeze([
        ['January', 31], ['February', 28], ['March', 31], ['April', 30], ['May', 31], ['June', 30],
        ['July', 31], ['August', 31], ['September', 30], ['October', 31], ['November', 30], ['December', 31],
    ].map(([name, days]) => Object.freeze({ name, days }))),
});

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** `{ era, months: [{ name, days }], leapYears }` from a calendar-like value, or null when it has no months. */
export function calendarFrom(value) {
    if (!isRecord(value) || !Array.isArray(value.months)) return null;
    const months = value.months.map(month => {
        if (typeof month === 'string') {
            const [name, days] = month.split('|');
            return { name: name.trim(), days: Math.floor(Number(days)) || 30 };
        }
        return isRecord(month) ? { name: String(month.name ?? '').trim(), days: Math.floor(Number(month.days)) || 30 } : null;
    }).filter(month => month && month.name && month.days > 0);
    if (!months.length) return null;
    return { era: typeof value.era === 'string' ? value.era.trim() : '', months, leapYears: value.leapYears === true || value.preset === 'gregorian' };
}

/** The calendar the story clock is on, through `query(name, args)` (see the top of this file). */
export function storyCalendar(query) {
    for (const name of ['director.calendar', 'packs.calendar']) {
        let value = null;
        try { value = typeof query === 'function' ? query(name, {}) : null; } catch { value = null; }
        const calendar = calendarFrom(value);
        if (calendar) return calendar;
    }
    return calendarFrom(GREGORIAN);
}

const isLeap = year => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
// Leap years in [0, year): year 0 is one (proleptic), as the Director counts them.
const leapsBefore = year => Math.floor((year - 1) / 4) - Math.floor((year - 1) / 100) + Math.floor((year - 1) / 400) + 1;

/** `{ year, month, day, minutes }` (month 0-based) for `abs` minutes on `calendar`. */
export function dateOf(abs, calendar) {
    const { months, leapYears } = calendar;
    const yearDays = months.reduce((sum, month) => sum + month.days, 0);
    const leapMonth = months.length > 1 ? 1 : 0;
    const leap = year => leapYears && isLeap(year);
    const daysBeforeYear = year => yearDays * year + (leapYears ? leapsBefore(year) : 0);
    const monthDays = (year, month) => months[month].days + (month === leapMonth && leap(year) ? 1 : 0);
    const total = Math.floor(abs / DAY);
    const minutes = abs - total * DAY;
    let year = Math.floor(total / (yearDays + (leapYears ? 0.2425 : 0)));
    while (daysBeforeYear(year) > total) year -= 1;
    while (daysBeforeYear(year + 1) <= total) year += 1;
    let rest = total - daysBeforeYear(year);
    let month = 0;
    while (month < months.length - 1 && rest >= monthDays(year, month)) rest -= monthDays(year, month++);
    return { year, month, day: rest + 1, minutes };
}

/** "7:40 pm" */
export function clockText(minutes) {
    const hour = Math.floor(minutes / 60);
    return `${hour % 12 || 12}:${String(minutes % 60).padStart(2, '0')} ${hour < 12 ? 'am' : 'pm'}`;
}

/** "CY 611, Goldwane 12, 7:40 pm" (no era: "Goldwane 12, 611, 7:40 pm"); '' for a value that is not a time. */
export function formatStoryTime(minutes, calendar = null) {
    if (!Number.isSafeInteger(minutes) || minutes < 0) return '';
    const cal = calendarFrom(calendar) ?? calendarFrom(GREGORIAN);
    const date = dateOf(minutes, cal);
    const day = `${cal.months[date.month].name} ${date.day}`;
    const dated = cal.era ? `${cal.era} ${date.year}, ${day}` : `${day}, ${date.year}`;
    return `${dated}, ${clockText(date.minutes)}`;
}

/** `fmt.time` for templates: minutes → words, on the calendar `query` finds (looked up on each call). */
export const timeFormatter = query => minutes => formatStoryTime(minutes, storyCalendar(query));
