// Relationship pacing: how many events of each impact tier one NPC can have per story day (setting
// `relationshipAllowance`), and what an event over its allowance counts as. Pure: no DOM, no clock of its own,
// no randomness. The story day is given in; the count lives on the record (`impactDay`), written in the same
// change as the move it paces, so a replay, a rebuild, a swipe and a Re-read give the live values.
//
//   impactDay = { day, reply, ordinary, meaningful, major, extreme }   (flat on the slice: see toFlatDay)
//   day    the story day the counts are for: the clock before `reply` (its own time lines cannot refresh it)
//   reply  the reply that fixed `day` (its record ID or index, as `turn.reply`); later events of it reuse `day`
//
// Used by: src/npc-meters.js (spendFlatEvent: a story line and a forwarded scanner change, counted on the slice record) and
// src/relationship-pass.js (Delta alone, counted on Delta's own record). Never imports either of them. The hosted-only
// words and cut of a held event are in src/npc-meters-pacing.js.
import { DEFAULT_RELATIONSHIP_CAPS, LEGACY_RELATIONSHIP_CAPS, normalizeRelationshipCaps } from '../core-relationship-model.js';
import { DEFAULT_IMPACT_CRITERIA, LEGACY_IMPACT_CRITERIA } from '../core-prompts-criteria.js';

export const PACING_TIERS = Object.freeze(['ordinary', 'meaningful', 'major', 'extreme']);
export const DEFAULT_ALLOWANCE = Object.freeze({ ordinary: 3, meaningful: 1, major: 1, extreme: 1 });
export const ALLOWANCE_MAX = 99;

const isInt = value => Number.isInteger(value);

/**
 * The reader's allowance as { tier: whole number 0..99 | null }. null (a blank field) is no limit and is kept apart
 * from a missing key, which reads as the default.
 */
export function normalizeAllowance(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const out = {};
    for (const tier of PACING_TIERS) {
        const value = source[tier];
        if (!Object.hasOwn(source, tier) || value === undefined) out[tier] = DEFAULT_ALLOWANCE[tier];
        else if (value === null || (typeof value === 'string' && !value.trim())) out[tier] = null;
        else {
            const number = Number(value);
            out[tier] = Number.isFinite(number) ? Math.max(0, Math.min(ALLOWANCE_MAX, Math.round(number))) : DEFAULT_ALLOWANCE[tier];
        }
    }
    return out;
}

/** The tier word of a payload, or null (an unknown or missing word is never "ordinary": it is not paced). */
export const pacedTier = value => (PACING_TIERS.includes(value) ? value : null);

/** Problems with a stored `impactDay` ([] when fine). */
export function impactDayProblems(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return ['is not a record'];
    const errors = [];
    if (!isInt(value.day)) errors.push('has no whole story day');
    if (!(typeof value.reply === 'string' ? value.reply.length > 0 && value.reply.length <= 120 : isInt(value.reply) && value.reply >= 0)) errors.push('has no reply');
    for (const tier of PACING_TIERS) if (!isInt(value[tier]) || value[tier] < 0 || value[tier] > 1000) errors.push(`has an unusable count of ${tier} events`);
    for (const key of Object.keys(value)) if (key !== 'day' && key !== 'reply' && !PACING_TIERS.includes(key)) errors.push(`has an unknown field "${key}"`);
    return errors;
}

// On the hosted slice the same record is stored FLAT, with the day in every key: { reply, 'd12:ordinary': 1, 'd12:meaningful': 0, ... }.
// Story Block replays stored ops, and an op holds only the fields that changed (Story_block src/v2/ops/diff.js), so a `day` field
// that did not change would be missing from a later event's op and a surviving event could be counted on the day before. A key that
// names its day carries it in whatever op wrote it; the day in force is the newest one named, and an old day's keys are dropped.
const FLAT_KEY = /^d(-?\d{1,9}):(ordinary|meaningful|major|extreme)$/;

/** The flat record of a spendEvent `next` ({ day, reply, counts }): every tier's count for that day, and the reply. */
export function toFlatDay(next) {
    return { reply: next.reply, ...Object.fromEntries(PACING_TIERS.map(tier => [`d${next.day}:${tier}`, next[tier]])) };
}

/** A stored flat record as spendEvent reads it ({ day, reply, counts }), or null (none, unusable, or no day named). */
export function fromFlatDay(value) {
    if (!value || typeof value !== 'object' || flatDayProblems(value).length) return null;
    const days = Object.keys(value).map(key => FLAT_KEY.exec(key)).filter(Boolean).map(match => Number(match[1]));
    if (!days.length) return null;
    const day = Math.max(...days);
    return { day, reply: value.reply, ...Object.fromEntries(PACING_TIERS.map(tier => [tier, value[`d${day}:${tier}`] ?? 0])) };
}

/** Problems with a stored flat record ([] when fine). */
export function flatDayProblems(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return ['is not a record'];
    const errors = [];
    if (value.reply !== undefined && !(typeof value.reply === 'string' ? value.reply.length > 0 && value.reply.length <= 120 : isInt(value.reply) && value.reply >= 0)) errors.push('has no reply');
    for (const [key, count] of Object.entries(value)) {
        if (key === 'reply') continue;
        if (!FLAT_KEY.test(key)) errors.push(`has an unknown field "${key}"`);
        else if (!isInt(count) || count < 0 || count > 1000) errors.push(`has an unusable count in "${key}"`);
    }
    return errors;
}

/**
 * One event of `tier` for the NPC whose record holds `prior` (its stored impactDay, if any).
 *   reply     the reply the event belongs to (null: nothing is paced)
 *   clockDay  the story day now as a whole number (null: no story clock, so no limit: nothing is counted)
 *   allowance normalizeAllowance's answer (null: no limit)
 * → { used, next, skipped }: `used` the tier the event counts as (null: none has room, it moves nothing); `next` the
 *   impactDay to store (null: leave the record as it is); `skipped` the tiers that were full, lowest first.
 */
export function spendEvent(prior, { tier, reply, clockDay, allowance }) {
    const unpaced = !allowance || !isInt(clockDay) || reply === null || reply === undefined;
    if (!pacedTier(tier) || unpaced) return { used: pacedTier(tier), next: null, skipped: [] };
    const stored = prior && typeof prior === 'object' && !impactDayProblems(prior).length ? prior : null;
    const same = stored && stored.reply === reply;
    const day = same ? stored.day : clockDay;
    const counts = Object.fromEntries(PACING_TIERS.map(name => [name, stored && stored.day === day ? stored[name] : 0]));
    const skipped = [];
    let used = null;
    for (let at = PACING_TIERS.indexOf(tier); at >= 0; at -= 1) {
        const name = PACING_TIERS[at];
        const room = allowance[name];
        if (room === null || room === undefined || counts[name] < room) { used = name; break; }
        skipped.unshift(name);
    }
    // Unlimited tiers can be used indefinitely; keep their persisted count valid and still above every finite allowance.
    if (used) counts[used] = Math.min(1000, counts[used] + 1);
    return { used, next: { day, reply, ...counts }, skipped };
}

/** spendEvent for the slice's flat record: `prior` is the stored flat record, `next` the flat record to store. */
export function spendFlatEvent(prior, args) {
    const spent = spendEvent(fromFlatDay(prior), args);
    return spent.next ? { ...spent, next: toFlatDay(spent.next) } : spent;
}

// 1.14 moved the default points per event from 1 / 2 / 5 / 10 to 1 / 2 / 3 / 6, and the default impact-tier criteria with them. A
// saved copy of the old defaults is moved once; anything else is the reader's own and is kept, as is a later deliberate
// 1 / 2 / 5 / 10 (the marker `relationshipPacingMigrated`, set by getSettings after the first look). → { caps, impactCriteria }.
export function pacingDefaults(settings) {
    const first = settings?.relationshipPacingMigrated !== true;
    const caps = normalizeRelationshipCaps(settings?.relationshipCaps);
    const saved = typeof settings?.relationshipImpactCriteria === 'string' ? settings.relationshipImpactCriteria : DEFAULT_IMPACT_CRITERIA;
    return {
        caps: first && JSON.stringify(caps) === JSON.stringify(LEGACY_RELATIONSHIP_CAPS) ? { ...DEFAULT_RELATIONSHIP_CAPS } : caps,
        impactCriteria: first && saved === LEGACY_IMPACT_CRITERIA ? DEFAULT_IMPACT_CRITERIA : saved,
    };
}
