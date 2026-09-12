# Deterministic fantasy calendar and birthday continuity

This is a narrow Delta continuity amendment. It is not Stage 9 and it does not import another generation's birthday or aging engine.

## Calendar setup

Delta can use a user-defined in-world calendar. The custom calendar configuration has:

- `era`: optional display prefix such as `CR`.
- `currentYear`: mandatory integer.
- `currentMonth`: mandatory configured month name.
- `currentDay`: mandatory day within the selected month.
- `months`: mandatory ordered list of month definitions. The Settings UI accepts one `Month name:days` row per month, and row order defines month order.

For example:

```text
Era: CR
Current year: 821
Current month: Redleaf
Current day: 16

Redleaf:30
Sunwane:31
Frostwane:30
```

The resulting current world date is displayed as `CR821, Redleaf 16`. Era is a label; year/month/day arithmetic is deterministic code. Delta does not use the computer clock as an in-world date.

Until a valid custom calendar is saved, Delta keeps the prior numeric birthday compatibility mode. Clearing the custom calendar returns to that compatibility mode.

## Birthday policy

Every canonical NPC may carry `birthDate`, `birthDateSource`, `birthDatePrecision`, `birthDateYearSource`, `birthDateReason`, `birthDateSourceMessageId`, `birthDateCalendarFingerprint`, `birthDateDisplay`, and `calendarAge`.

`birthDate` is stored as calendar-neutral components:

```json
{"era":"CR","year":815,"month":"Redleaf","day":16}
```

`year` may be null when only the birthday within the year is known.

When no grounded birthday is established, Delta deterministically hashes the NPC's stable id, falling back to normalized name only when no id exists, into an ordinal day of the configured calendar year. The ordinal is then mapped through the ordered month table. This uses no model call, random state, real-world clock, species/race, apparent age, or lifespan assumption.

A generated birthday is tagged `birthDateSource: "generated"`. If the configured calendar changes, generated birthdays are deterministically remapped to the new calendar. Established story birthdays are never silently remapped. An established date that is incompatible with a later calendar configuration is preserved rather than fabricated into a different date; calendar arithmetic simply remains unavailable for that record until the calendar/date is reconciled.

Grounded story evidence may establish or correct a birthday. Once `birthDateSource` is `established`, a different month/day requires `birthDateState: "correct"`. A previously derived year may be upgraded by an explicitly established year for the same birthday without treating that authority upgrade as a different birthday.

## Deterministic year and age arithmetic

If Delta has all of the following:

1. an exact chronological `age`,
2. a birthday month/day, and
3. a valid configured current world date,

then it can derive the compatible birth year locally. For `CR821, Redleaf 16`, an NPC aged 6 whose birthday is `Redleaf 16` derives to `CR815, Redleaf 16`. If the birthday is later in the configured year, such as `Sunwane 4`, the compatible birth year is `CR814` because that birthday has not occurred yet in CR821.

`birthDateYearSource: "derived"` distinguishes this arithmetic year from a story-established year. Once a full birth date exists, `calendarAge` is recalculated from the configured current world date. Runtime prompts use that deterministic calendar age where appropriate while retaining the original chronological-age evidence field for continuity and correction handling.

`apparentAge` is always visual presentation. It is never used to derive a birth year or chronological age. Fantasy race/species and lifespan are likewise irrelevant to calendar arithmetic.

Arithmetic is only performed when the birth date and current date use a compatible configured calendar/era. Delta does not guess across different eras.

## Scanner impact

Ordinary scanner prompts remain unchanged. A compact birthday rule is appended only when the current source contains birthday/birth-date evidence such as `birthday`, `born`, `hatched`, or an explicit age-turning statement.

With a custom calendar configured, the conditional rule supplies only the current in-world date, for example `CR821, Redleaf 16`. It does not paste the entire month table into every prompt. The model copies grounded era/month/day evidence or binds words such as `today`; deterministic validation, month ordering, year deduction, and age arithmetic remain local code.

The scanner never chooses generated birthdays and is instructed not to infer chronology from apparent age, species, or lifespan.

## Settings ownership

`calendar-settings.js` is a thin adapter over the existing `extension_settings.npc_state_delta` object. It stores only the `calendarConfig` slice and uses the host's normal debounced settings persistence. It does not create another settings database or persistence path. `calendar.js` owns pure calendar validation/arithmetic; `birthday.js` owns birthday continuity policy.

## Verification boundary

`tests/birthday-continuity.test.js` covers custom calendar validation, ordered month handling, deterministic named-month generation, numeric compatibility fallback, birth-year and age arithmetic, generated-to-established replacement, correction protection, explicit year authority upgrades, incompatible-date preservation, and conditional prompt wording.

Full repository acceptance still requires the normal exact-candidate CI workflow. Live-provider testing is only needed to evaluate model extraction quality for fantasy-calendar birthday phrasing; it is not required to prove deterministic calendar arithmetic.
