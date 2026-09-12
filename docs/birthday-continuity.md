# Deterministic birthday continuity

This is a narrow Delta continuity amendment. It is not Stage 9 and it does not import another generation's birthday or aging system.

## Policy

Every canonical NPC may have `birthDate`, `birthDateSource`, `birthDatePrecision`, `birthDateReason`, and `birthDateSourceMessageId`.

When no grounded birthday is established, Delta deterministically generates a stable month/day (`MM-DD`) from the NPC's stable id, falling back to normalized name only when no id exists. The generated value is tagged `birthDateSource: "generated"` and `birthDatePrecision: "month-day"`. Generation never uses a model call, random state, the host clock, species/race, apparent age, or fantasy lifespan assumptions.

Grounded story evidence may establish `MM-DD` or `YYYY-MM-DD`. A generated fallback is replaceable by such evidence. Once `birthDateSource` is `established`, a different date requires an explicit `birthDateState: "correct"`; ordinary establishment/omission cannot silently churn it. Source-message provenance is retained when available.

A full birth year may be derived from a month/day only when both an exact chronological `age` and a grounded full current in-world reference date are available. `apparentAge` is visual presentation and is never chronology. Delta does not substitute the real-world date for a missing story calendar date.

Generated birthdays are bookkeeping continuity, not automatically injected roleplay lore. They also do not by themselves advance chronological age. Automatic calendar aging should only be enabled if Delta later has a canonical grounded story-date source.

## Scanner impact

Ordinary scanner prompts are unchanged. A compact birthday rule is appended only when the current scanner source contains birthday/birth-date evidence such as `birthday`, `born`, `hatched`, or an explicit age-turning statement. The model may establish/correct a birthday from grounded evidence; it is told not to invent a date and not to derive chronology from apparent age, species, or lifespan.

This keeps deterministic generation in local code while allowing explicit narrative corrections through the normal scan path.

## Verification boundary

`tests/birthday-continuity.test.js` covers deterministic stability, date/leap validation, guarded year deduction, scanner field normalization, generated-to-established replacement, established correction protection, and conditional prompt wording. Full repository acceptance still requires the normal exact-candidate CI workflow. Live-provider testing is only needed to evaluate model extraction quality for explicit birthday phrasing; it is not required to prove the deterministic fallback.
