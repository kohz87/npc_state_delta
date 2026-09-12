# Deterministic fantasy calendar and birthday continuity

This is a narrow Delta continuity amendment. It is not Stage 9 and it does not import another generation's birthday or aging engine.

## Calendar definition and optional campaign clock

Delta can use a user-defined in-world calendar. The calendar definition has:

- `era`: optional display/year prefix such as `CR`.
- `months`: required ordered list of month definitions. The Settings UI accepts one `Month name:days` row per month, and row order defines month order.

The campaign clock is a separate optional capability:

- `currentYear`: optional manual fallback year.
- `currentMonth`: optional manual fallback month.
- `currentDay`: optional manual fallback day.

The three manual current-date fields operate as a unit. They may all be blank. If any one is supplied, all three must form a valid date in the configured calendar.

A minimal calendar therefore needs only:

```text
Era: CR

Redleaf:30
Sunwane:31
Frostwane:30
```

That is enough for deterministic named-month birthdays such as `Redleaf 16`. It does not authorize Delta to invent a year.

A user who wants a manual fallback clock may additionally configure:

```text
Current year: 821
Current month: Redleaf
Current day: 16
```

The resulting manual date displays as `CR821, Redleaf 16`. Delta never substitutes the computer clock for a missing in-world date.

Until a valid custom calendar is saved, Delta keeps the prior numeric birthday compatibility mode. Clearing the custom calendar returns to that compatibility mode.

## Structured World State as a grounded clock

When a scanned story source contains a recognized structured World State block, Delta can extract a full date directly from that block using the configured month table. Supported structured boundaries mirror the existing World State compatibility surface: `<World_State>...</World_State>` and `<details>` blocks whose summary identifies `World State`.

For example, with the calendar above:

```text
<World_State>
Time | CR821, Redleaf 16 | 7:42 pm
Location | Rimecross
</World_State>
```

produces the grounded reference date `CR821, Redleaf 16`. If a scanned window contains more than one valid World State date, the latest valid structured date wins.

Structured World State has precedence over the optional manual fallback current date for that scan. Delta does not infer dates from ordinary prose, flashbacks, vague statements such as `several years later`, or the real-world clock.

The structured date is consumed directly by deterministic calendar/birthday logic. It does not require a separate model request and the full `Month:days` table is not pasted into ordinary scanner prompts.

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

A birth year is derived only when Delta has all of the following:

1. an exact chronological `age`,
2. a birthday month/day, and
3. a grounded full current world date, either from structured World State or the complete manual fallback clock.

With `CR821, Redleaf 16`, an NPC aged 6 whose birthday is `Redleaf 16` derives to `CR815, Redleaf 16`. If the birthday is later in the configured year, such as `Sunwane 4`, the compatible birth year is `CR814` because that birthday has not occurred yet in CR821.

Without a grounded current date, the same NPC remains simply `Age: 6` and `Birthday: Redleaf 16`. Delta does not fabricate `CR815`.

`birthDateYearSource: "derived"` distinguishes an arithmetic year from a story-established year. Once a full birth date and grounded current date exist, `calendarAge` is recalculated locally. During an owned scan merge, the canonical chronological `age` can advance from this deterministic result, so a World State moving from `CR821, Redleaf 16` to `CR822, Redleaf 16` advances a `CR815, Redleaf 16` NPC from age 6 to 7 without model arithmetic.

`apparentAge` is always visual presentation. It is never used to derive a birth year or chronological age. Fantasy race/species and lifespan are likewise irrelevant to calendar arithmetic.

Arithmetic is only performed when the birth date and current date use a compatible configured calendar/era. Delta does not guess across different eras.

## Scanner impact

Ordinary scanner prompts remain unchanged. A compact birthday rule is appended only when the current source contains birthday/birth-date evidence such as `birthday`, `born`, `hatched`, or an explicit age-turning statement.

When a grounded current date is available, the conditional birthday rule may include only that date, for example `CR821, Redleaf 16`. It does not paste the month table into every prompt. If no current date is available, the rule tells the model to preserve grounded fantasy month/era names and not invent a missing year.

The scanner never chooses generated birthdays and is instructed not to infer chronology from apparent age, species, or lifespan.

## Settings ownership

`calendar-settings.js` is a thin adapter over the existing `extension_settings.npc_state_delta` object. It stores only the `calendarConfig` slice and uses the host's normal debounced settings persistence. It does not create another settings database or persistence path. `calendar.js` owns pure calendar validation/arithmetic plus deterministic structured-World-State date extraction; `birthday.js` owns birthday continuity policy.

The manual current date is a fallback setting, not a second campaign-history database. Structured World State is read from the current scan source rather than copied into a separate persistent clock, which keeps normal Delta branch/recovery ownership unchanged.

## Verification boundary

`tests/birthday-continuity.test.js` covers months-only calendar validation, all-or-none manual clock validation, deterministic named-month generation, numeric compatibility fallback, structured World State extraction, guarded birth-year and age arithmetic, deterministic age progression, generated-to-established replacement, correction protection, explicit year authority upgrades, incompatible-date preservation, and conditional prompt wording.

Full repository acceptance still requires the normal exact-candidate CI workflow. Live-provider testing is only needed to evaluate model extraction quality for fantasy-calendar birthday phrasing; it is not required to prove deterministic calendar or structured-date arithmetic.

## Stage 9 integration clarifications

The runtime passes the owning raw assistant message separately to local date extraction before UI-noise stripping can erase its structural boundaries. Model-facing scanner text is unchanged. Mixed supported block formats use source order; only the World State header before NPC sections supplies the current date, not an NPC birth date. Manual actual-age locks and terminal-death state remain protected. An older manual fallback does not reverse an accepted chronological age in a date-less scan or subsequent injection. No independent clock store, narration-based elapsed-time guess or extra model request is introduced.

The dedicated Calendar & birthdays settings section uses the host's existing debounced settings save and reports queued persistence. Dossier birthday/form display is now part of the ordinary read-only projection; it does not require a document-wide observer or full-history copying.
