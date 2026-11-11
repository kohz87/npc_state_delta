// NPC meters, the settings defaults and the settings schema the Story Suite overlay renders. A pure part of npc-meters.js (same
// owner, moved without change); npc-meters.js re-exports both names. Never imports npc-meters.js.
import { BUILT_IN_RANGE, DEFAULT_CHANGE_CAP, DEFAULT_CONFLICT_AT, DEFAULT_DEMOTE_AFTER, DESCRIBE_MAX, LABEL_MAX, MAX_CHANGE_CAP, MAX_CUSTOM_METERS, MILESTONE_MAX, STAGE_NAME_MAX, TONES, TRACK_MAX } from './npc-meters-config.js';
import { DEFAULT_GATE_SETTINGS, GATE_STRENGTHS, GATE_WINDOW_MAX } from '../npc-meters-gate.js';
import { FEATURE_GATE } from './npc-meters-config.js';
import { DEFAULT_SOCIAL_CAP, DEFAULT_SOCIAL_SCALE, FEATURE_SOCIAL, MAX_SOCIAL_CAP, MAX_SOCIAL_SCALE } from './social-check.js';

export const SETTINGS_DEFAULTS = Object.freeze({ changeCap: DEFAULT_CHANGE_CAP, customMeters: [], stages: [], ladder: [], conflictAt: DEFAULT_CONFLICT_AT, demoteAfter: DEFAULT_DEMOTE_AFTER, presets: [], socialScale: DEFAULT_SOCIAL_SCALE, socialCap: DEFAULT_SOCIAL_CAP, gateDays: DEFAULT_GATE_SETTINGS.windowDays, gateStrength: DEFAULT_GATE_SETTINGS.strength });

const TONE_OPTIONS = Object.freeze(TONES.map(tone => Object.freeze({ value: tone, label: tone[0].toUpperCase() + tone.slice(1) })));

// Rendered by the Story Suite overlay in Delta's fold, above Delta's own panel (SPEC §6 schema fields).
// `presets` has no field here: the presets block in Delta's section turns them on and off.
export const SETTINGS_SCHEMA = Object.freeze({
    changeCap: Object.freeze({
        type: 'int', min: 1, max: MAX_CHANGE_CAP, label: 'Most a meter moves per reply',
        help: 'Story lines and Delta\'s scans together; code holds each meter within this of where the reply started.',
    }),
    customMeters: Object.freeze({
        type: 'list', label: 'Custom meters',
        help: `Up to ${MAX_CUSTOM_METERS} meters of your own beside trust, affection, desire and tension. The story moves them with "~ npc Name | meter: +N". Rule: one line telling the story what moves it (sent while presets and rules are on). Words: "doubtful 25, steady 60, devoted" — the story is told the word, not the number. Drift: how far it moves each story day toward its resting value (needs the drift feature and Story Director's clock).`,
        of: Object.freeze({
            name: Object.freeze({ type: 'text', label: 'Name', max: LABEL_MAX }),
            min: Object.freeze({ type: 'int', label: 'Lowest' }),
            max: Object.freeze({ type: 'int', label: 'Highest' }),
            start: Object.freeze({ type: 'int', label: 'Starts at' }),
            show: Object.freeze({ type: 'choice', label: 'Bar', options: Object.freeze([Object.freeze({ value: 'bar', label: 'Show' }), Object.freeze({ value: 'hidden', label: 'Hide' })]) }),
            tone: Object.freeze({ type: 'choice', label: 'Colour', options: TONE_OPTIONS }),
            describe: Object.freeze({ type: 'text', label: 'Rule', max: DESCRIBE_MAX }),
            bands: Object.freeze({ type: 'text', label: 'Words', max: 160 }),
            drift: Object.freeze({ type: 'int', label: 'Drift a day', min: 0, max: 100 }),
            driftTo: Object.freeze({ type: 'int', label: 'Rests at' }),
        }),
    }),
    stages: Object.freeze({
        type: 'list', label: 'Meter stages',
        help: 'Named thresholds: a stage at 0 or more is reached at or above it, a negative one at or below it. Code moves the stage and notes it on the reply.',
        of: Object.freeze({
            meter: Object.freeze({ type: 'text', label: 'Meter' }),
            at: Object.freeze({ type: 'int', label: 'At' }),
            name: Object.freeze({ type: 'text', label: 'Stage' }),
        }),
    }),
    ladder: Object.freeze({
        type: 'list', label: 'Stage ladder',
        help: 'Rungs in order, each reached when all its needs hold ("trust 60, affection 40") and, if named, its story milestone has happened ("+ milestone Mira — saved her brother"). Track: leave empty for everyone, or name a track an NPC is given in the dossier editor.',
        of: Object.freeze({
            name: Object.freeze({ type: 'text', label: 'Stage', max: STAGE_NAME_MAX }),
            needs: Object.freeze({ type: 'text', label: 'Needs', max: 120 }),
            milestone: Object.freeze({ type: 'text', label: 'Milestone', max: MILESTONE_MAX }),
            track: Object.freeze({ type: 'text', label: 'Track', max: TRACK_MAX }),
        }),
    }),
    conflictAt: Object.freeze({
        type: 'int', min: BUILT_IN_RANGE.min, max: BUILT_IN_RANGE.max, label: 'Conflict: tension above',
        help: 'While an NPC\'s tension is above this, no stage on the ladder is reached.',
    }),
    demoteAfter: Object.freeze({
        type: 'int', min: 0, max: 50, label: 'Replies before a stage is lost',
        help: 'A stage on the ladder falls back one rung only after its needs have failed this many replies in a row (0: never).',
    }),
    // The anti-lever gate (feature npc-state-delta.anti-lever, npc-meters-gate.js): a story line's `| via:` approach repeated to one person.
    gateDays: Object.freeze({
        type: 'int', min: 1, max: GATE_WINDOW_MAX, label: 'Anti-lever: window (story days)', feature: FEATURE_GATE,
        help: 'The same approach (praise, a gift, help, flirting, a threat, shared danger) to the same person within this many story days counts as a repeat. Needs the story clock.',
    }),
    gateStrength: Object.freeze({
        type: 'choice', label: 'Anti-lever: strength', feature: FEATURE_GATE,
        options: Object.freeze(Object.keys(GATE_STRENGTHS).map(value => Object.freeze({ value, label: value[0].toUpperCase() + value.slice(1) }))),
        help: 'Light: a repeat gives three quarters and the fourth backfires. Normal: half, the third backfires. Strong: a quarter, the second backfires.',
    }),
    // Social checks (feature npc-state-delta.social, src/social-check.js): read by a dice module only.
    socialScale: Object.freeze({
        type: 'int', min: 0, max: MAX_SOCIAL_SCALE, label: 'Social checks: strength (%)', feature: FEATURE_SOCIAL,
        help: 'How strongly an NPC\'s meters, stage and disposition move a social check against them: 100 is the standard table, 50 half, 0 none.',
    }),
    socialCap: Object.freeze({
        type: 'int', min: 1, max: MAX_SOCIAL_CAP, label: 'Social checks: most a check moves', feature: FEATURE_SOCIAL,
        help: 'The bonus or penalty on one social check never goes past this (on a d20 roll).',
    }),
});
