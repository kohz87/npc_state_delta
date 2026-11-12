/* NPC State Delta deterministic fantasy-calendar primitives. The implementation is split across
   calendar-config.js, calendar-clock.js, calendar-date.js and calendar-derived.js; this path keeps
   the original public exports and existing importers unchanged. */

export { MAX_CALENDAR_MONTHS, MAX_CALENDAR_DAYS_PER_MONTH, LEGACY_NUMERIC_CALENDAR_ID, parseMonthDefinitions, monthDefinitionsText, calendarFingerprint, calendarYearLength, normalizeCalendarConfig, setActiveCalendarConfig, setExternalCalendarSource, getActiveCalendarConfig } from './calendar-config.js';
export { setStoryClockSource, setStoryDateAtSource, storyDateTextAt, withStoryDateMemo, storyMinuteText, storyClockDate, hostedStoryDate, storyCurrentDate } from './calendar-clock.js';
export { normalizeCalendarDate, formatCalendarDate, STORY_DAY_SCHEME, migrateLegacyStoryDay, calendarDayNumber, currentCalendarDate } from './calendar-date.js';
export { deterministicCalendarBirthday, extractStructuredWorldDate, deriveBirthDateFromAgeParts, deriveAgeFromBirthDate, calendarPromptContext } from './calendar-derived.js';
