// NPC meters for Story Suite v2 (Story Block 2, docs/v2/SPEC.md §2, §4, §5; coordinator decisions
// F81, F90 and TRS ideas 1-4): a small slice of each NPC in v2's per-reply state, so the meters swipe
// and delete back with the replies. The long prose dossiers stay in Delta's own sidecar; only numbers,
// stage names, milestone names and the ids of unlocked hidden notes live here.
//
//   npc = {
//     npcs: { [key]: { name, meters: { trust, affection, desire, tension, ...custom }, stages: { meter: name },
//                      unlocked: [noteId], held?: [noteId], disposition?, turn?: { reply, from: { meter: value } },
//                      milestones?: { [milestoneKey]: name }, rank?: rungKey, low?: n, day?: n } },
//     problems: [{ rev, text }],          // the last change lines code could not use in full (last 20)
//   }
//
// * Keys are the NPC's name in lowercase words joined by "-" (`mira`, `jean-luc`), so a line about
//   someone Delta has no dossier for still finds the same entry next time; a dossier is matched to
//   its entry by its name, then its aliases.
// * Meters: trust, affection, desire and tension (-100..100, starting from Delta's base values, or
//   from the dossier's own numbers for someone Delta already knows), plus up to six custom meters
//   from the reader's settings and the presets in use. Code clamps every value to its range, and the
//   change of one meter within one reply to the change cap (`turn.from` holds the values the reply
//   started from). A custom meter may carry a rule line for the story (`describe`), band words the
//   tail uses instead of its number (`bands`), and a drift toward a value per story day (`drift`).
// * Per-NPC limits (the dossier's `meterSetup`, or the preset the reader gave that NPC): growth from
//   the story or a scan stops at the meter's ceiling, a fall stops at its floor. A change away from a
//   limit always lands in full; a value the reader set beyond one is never pulled back to it.
// * Stages (F90): named thresholds per meter. A threshold at 0 or above is reached at or above it, a
//   negative one at or below it; the stage is the farthest one reached. Code moves the stage when a
//   meter crosses a threshold either way and says so in the receipt. The story cannot set a stage.
// * Stage ladder (feature npc-state-delta.stages): rungs in order, each needing several meters at once
//   and optionally a story milestone ("Confidant: trust 60, affection 40, milestone saved her
//   brother"). `rank` is the rung reached. Code promotes as soon as the next rung's needs are met,
//   never while a conflict is on (tension above `conflictAt`); it demotes one rung only after the
//   rung's needs have failed `demoteAfter` replies in a row (`low` counts them, on Delta's per-reply
//   tick). Milestones are keyed by their words: `+ milestone Mira — saved her brother` (once) or the
//   reader in the dossier editor. Setting one writes nothing to the prompt by itself.
// * Hidden notes ("secrets"): kept in Delta's dossier with an unlock rule { meter, at } and an
//   optional title. When the meter reaches `at` (same rule as a threshold), code adds the note's id to
//   `unlocked` (it stays unlocked on that line of history) and says so; the text itself never enters
//   this state and is given to the story only through the tail, only while the NPC is present and
//   unlocked. While locked, screens show only that a note is hidden and its rule ("Opens at Trust 60",
//   "Opens with the story"), never its title, text or event wording.
// * A note opens by a meter rule { meter, at }, by a story event (`when`, up to 120 characters; the scan
//   of a reply that shows it sends `npc.open`, recorded on that reply), or by the reader's hand (also
//   `npc.open`; a note the reader shut is kept in `held` so a meter does not open it again).
// * Every note of a present NPC reaches the story through the tail: an opened one as known to the
//   player, a locked one worded "hidden: never state or reveal" (the nearest to opening first when the
//   budget cannot hold them all). `redact` (below) is the screen view of the same text, with locked
//   notes shown as "1 hidden note".
//
// * The living cast (src/cast-dossier.js): `cast` = { [castKey ("pack:id")]: { name, rungs? } } records the people whose
//   dossier Delta made from the pack at the first meeting (Story Director's `director.cast`, read only). npc.tick writes it
//   at the reply the meeting is first seen (observeCast), so it follows swipes and deletes with the replies; the first meter
//   values the pack gave are the entry's first values. Read through the query `npc.castMade`.
//
// Pure: no DOM, no SillyTavern, no clock, no randomness. What Delta knows (dossier names, base
// values, note rules and texts, per-NPC setup, presets, who is present) comes in through the hooks
// given to createNpcPart.
import { storyMinuteText } from '../calendar.js';
import { RELATIONSHIP_KEYS, applyRelationshipDelta, normalizeRelationshipCaps } from '../core-mechanics.js';
import { BUILT_IN_PRESETS, normalizeLimits } from './npc-meters-presets.js';
import { isAway, labelKey, labelsOf, normalizeKeyPeople } from './key-people.js';
import { normalizeCast } from './cast-dossier.js';
import {
    FEATURE_SOCIAL,
    SOCIAL_QUERY,
    socialModifier,
    socialSettings,
    socialSkill,
} from './social-check.js';
import { NPC_DOMAIN, NPC_KIND, MILESTONE_KIND, BUILT_IN_METERS, CUSTOM_RANGE, MAX_NPCS, MAX_STAGES_PER_METER, MAX_UNLOCKED, MAX_PROBLEMS, MAX_MILESTONES, MAX_RUNGS, DAY_MINUTES, RECENT_MESSAGES, SECRET_TEXT_MAX, SECRET_TITLE_MAX, MILESTONE_MAX, TAIL_SECRETS_PER_NPC, CONTEXT_BUDGET, FEATURE_STAGES, FEATURE_DRIFT, FEATURE_PRESETS, FEATURE_MOOD_PULL, FEATURES, FEATURE_DEFAULTS, NAME_MAX, DISPOSITION_MAX, TRACK_MAX, REASON_LABELS, IMPACT_TIERS, tierOf, isObject, isInt, isReplyId, replyKey, sameReply, clamp, clean, own, slug, npcKey, KEY_PEOPLE_QUERY, wordKey, intOr, bandWord, needMet, rung, normalizeMeterSettings, meterDefs, thresholdReached, stageAt, parseMeterValue } from './npc-meters-config.js';
import { initialNpcSlice, observeKeyAway, CAST_QUERY, observeCast, validateNpcSlice, findNpcKey, meterValue, moveMeters, rungMet, conflictOn, settle, sentence, result } from './npc-meters-slice.js';
import { applyEvents, eventsFromMoves } from '../npc-mood.js';
import { SETTINGS_DEFAULTS, SETTINGS_SCHEMA } from './npc-meters-schema.js';
import { createNpcCommands } from './npc-meters-commands.js';
import { createNpcQueries } from './npc-meters-queries.js';
import { createNpcPrompt } from './npc-meters-prompt.js';
import { normalizeAllowance, pacedTier, spendFlatEvent } from './relationship-pacing.js';
import { askedOf, cutToTier, nextEvent, pacingNote } from './npc-meters-pacing.js';
export { NPC_DOMAIN, NPC_KIND, MILESTONE_KIND, BUILT_IN_METERS, BUILT_IN_RANGE, CUSTOM_RANGE, MAX_CUSTOM_METERS, MAX_NPCS, MAX_METERS_PER_NPC, MAX_STAGES_PER_METER, MAX_SECRETS, MAX_GENERATED_SECRETS, MAX_UNLOCKED, MAX_PROBLEMS, MAX_MILESTONES, MAX_RUNGS, MAX_TRACKS, MAX_BANDS, MAX_NEEDS, DEFAULT_CHANGE_CAP, MAX_CHANGE_CAP, DEFAULT_CONFLICT_AT, DEFAULT_DEMOTE_AFTER, DAY_MINUTES, RECENT_MESSAGES, SECRET_TEXT_MAX, SECRET_TITLE_MAX, SECRET_WHEN_MAX, NOTE_SOURCES, MILESTONE_MAX, DESCRIBE_MAX, TAIL_SECRETS_PER_NPC, CONTEXT_BUDGET, FEATURE_STAGES, FEATURE_DRIFT, FEATURE_PRESETS, FEATURE_SCAN_EVERY_REPLY, FEATURE_MOOD_PULL, FEATURES, replyKey, slug, npcKey, KEY_PEOPLE_QUERY, wordKey, parseBands, bandWord, parseNeeds, normalizeMeterSettings, meterDefs, thresholdReached, stageAt, parseMeterValue } from './npc-meters-config.js';
export { normalizeSecrets, secretId, normalizeGeneratedSecrets, secretsToLines, secretsFromLines, limitsToLines, limitsFromLines } from './npc-meters-secrets.js';
export { initialNpcSlice, observeKeyAway, CAST_QUERY, CAST_MADE_MAX, observeCast, validateNpcSlice, findNpcKey, meterValue, rungMet } from './npc-meters-slice.js';
export { SETTINGS_DEFAULTS, SETTINGS_SCHEMA } from './npc-meters-schema.js';

export { FEATURE_SOCIAL, SOCIAL_QUERY };

/**
 * The `npc` part (MODULES §A part shape): domain, commands, queries, the `npc` and `milestone`
 * change-line kinds and the prompt context. Hooks (each optional, each may throw — a throw reads as
 * "nothing known"):
 *   resolve(name)     → Delta's dossier for that name or alias: { name, aliases, relationship } | null
 *   baseline()        → Delta's base relationship values (new NPCs start there)
 *   caps()            → Delta's impact-tier caps { ordinary, meaningful, major, extreme } (a story line's step is held to its tier's)
 *   allowance()       → the reader's events per story day { ordinary, meaningful, major, extreme } (null: no limit; relationship-pacing.js)
 *   calendarOwn()     → true while the reader keeps the calendar in Delta (then there is no story day to count on)
 *   startTime(index)  → story-clock minutes before that reply (null when unavailable)
 *   startDate(index)  → that story day as the dossier writes it ("Goldwane 13"; '' when unavailable)
 *   secretRules(name) → that dossier's notes as [{ id, meter?, at?, when?, title? }] (never their text)
 *   secretTexts(name, ids) → [{ id, text }] for those notes (the tail and screens only)
 *   setup(name, labels) → that dossier's meter setup { track, limits } (the editor's)
 *   presets()         → the preset catalog (presetCatalog: built-ins and packs')
 *   feature(id)       → true / false for a feature the host knows; anything else: its default
 *   present()         → names of the NPCs present now
 *   settings()        → the module's stored settings (queries and the prompt; commands use ctx.settings)
 *   ownCommand(type, payload) → true while Delta's own adapter is sending exactly this command (its
 *                       scanner's npc.adjust, its tick); a button, screen or pack cannot make it true
 *   headReply()       → the index of the latest reply (the reader's own values start its window)
 */
export function createNpcPart(hooks = {}) {
    const call = (fn, fallback, ...args) => {
        if (typeof fn !== 'function') return fallback;
        try { return fn(...args) ?? fallback; } catch { return fallback; }
    };
    const resolve = name => {
        const found = call(hooks.resolve, null, name);
        return isObject(found) && typeof found.name === 'string' && found.name.trim() ? found : null;
    };
    const baseline = () => {
        const value = call(hooks.baseline, {});
        return isObject(value) ? value : {};
    };
    // Delta's impact-tier caps, normalized; null when the host gives none (then a story line is held by the per-reply cap alone).
    const tierCaps = () => {
        const value = call(hooks.caps, null);
        return isObject(value) ? normalizeRelationshipCaps(value) : null;
    };
    // The events-per-day allowance and the story day before the reply (null: no clock, or Delta owns the calendar).
    const tierAllowance = () => {
        const value = call(hooks.allowance, null);
        return isObject(value) ? normalizeAllowance(value) : null;
    };
    const clockMinutes = at => (call(hooks.calendarOwn, false) === true ? null : (m => (isInt(m) ? m : null))(call(hooks.startTime, null, at)));
    const clockDay = at => { const minutes = clockMinutes(at); return minutes === null ? null : Math.floor(minutes / DAY_MINUTES); };
    // The story minute by the host's clock now (a scan's change names no reply); null without a clock.
    const timeMinutes = ctx => {
        try { const minutes = ctx.time(); return isInt(minutes) ? minutes : null; } catch { return null; }
    };
    const rulesFor = (name, aliases = []) => {
        const value = call(hooks.secretRules, [], name, aliases);
        return Array.isArray(value) ? value : [];
    };
    const presentNames = () => {
        const value = call(hooks.present, []);
        return Array.isArray(value) ? value.filter(name => typeof name === 'string' && name.trim()) : [];
    };
    // A feature's switch: the command's own ctx.feature, else the host's (hook), else its default.
    const featureOn = (id, ctx = null) => {
        if (typeof ctx?.feature === 'function') {
            try {
                const answer = ctx.feature(id);
                if (typeof answer === 'boolean') return answer;
            } catch { /* the host's default below */ }
        }
        const answer = call(hooks.feature, undefined, id);
        return typeof answer === 'boolean' ? answer : FEATURE_DEFAULTS[id] === true;
    };
    const catalog = ctx => {
        if (!featureOn(FEATURE_PRESETS, ctx)) return [];
        const value = call(hooks.presets, null);
        return Array.isArray(value) ? value : BUILT_IN_PRESETS;
    };
    const normalized = (raw, ctx = null) => normalizeMeterSettings(raw, { presets: catalog(ctx), stagesOn: featureOn(FEATURE_STAGES, ctx) });
    const storedSettings = () => normalized(call(hooks.settings, {}));
    const defsFrom = settings => meterDefs(settings, baseline());
    // A reader's action at the top (a button, a screen, a pack): cause ui and no calling module.
    const readerAction = ctx => ctx.cause === 'ui' && !ctx.caller;
    const ownOrModule = (ctx, type, payload) => !readerAction(ctx) || call(hooks.ownCommand, false, type, payload) === true;
    const headReply = () => {
        const value = call(hooks.headReply, null);
        return isInt(value) && value >= 0 ? value : null;
    };
    // The window key for a command about the reply at `index` (Delta's scan of it, the reader's values):
    // the record ID Story Block gives the reply the command is stored on (`ctx.reply`) when that is the
    // reply meant, else the index (replyKey).
    const commandReply = (ctx, index) => replyKey(isInt(index) && ctx?.reply?.index === index ? ctx.reply.sid : null, index);
    // The NPC's meter setup from the dossier (track, limits) and what it means with these settings.
    const setupFor = (name, labels = []) => {
        const value = call(hooks.setup, null, name, labels);
        return { track: clean(value?.track, TRACK_MAX), limits: normalizeLimits(value?.limits), rungs: ownRungs(value?.ladder) };
    };
    // A person's own stage ladder (the cast's `stages`, kept on the dossier): rows as the settings' ladder rows, in order. It stands
    // before any track and only while the stage ladders feature is on (settings.stagesOn).
    const ownRungs = rows => {
        const out = [];
        for (const row of Array.isArray(rows) ? rows : []) {
            const step = rung(row);
            if (step && out.length < MAX_RUNGS && !out.some(other => other.key === step.key)) out.push(step);
        }
        return out;
    };
    const rungsFor = (settings, setup) => {
        if (setup.rungs?.length && settings.stagesOn) return setup.rungs;
        return setup.track && Object.hasOwn(settings.ladder, setup.track) ? settings.ladder[setup.track] : settings.ladder[''] ?? [];
    };
    const limitsFor = (settings, setup) => {
        const merged = { ...(setup.track && Object.hasOwn(settings.limits, setup.track) ? settings.limits[setup.track] : {}) };
        for (const [meter, limit] of Object.entries(setup.limits)) merged[meter] = limit;
        return merged;
    };

    // Who a change is about: the entry key, the name it shows, the dossier's labels and numbers.
    function identify(npcs, label) {
        const asked = clean(label, NAME_MAX);
        if (!asked) return null;
        const dossier = resolve(asked);
        const name = clean(dossier?.name ?? asked, NAME_MAX);
        const labels = [name, asked, ...(Array.isArray(dossier?.aliases) ? dossier.aliases : [])].map(item => clean(item, NAME_MAX)).filter(Boolean);
        const key = findNpcKey(npcs, labels) ?? npcKey(name);
        if (!key) return null;
        return { key, name, labels, seed: isObject(dossier?.relationship) ? dossier.relationship : null };
    }

    function ensure(ctx, npcs, who, defs, seed) {
        if (Object.hasOwn(npcs, who.key)) return false;
        if (Object.keys(npcs).length >= MAX_NPCS) ctx.fail('REFUSED', `NPC State Delta keeps meters for up to ${MAX_NPCS} people; ${who.name} was not added.`);
        const meters = {};
        for (const def of defs) {
            const given = intOr(seed?.[def.id], null);
            meters[def.id] = given === null ? def.start : clamp(given, def.min, def.max);
        }
        // `milestones` is made with the entry, so a later reply's milestone is an add under an object
        // the entry's first reply made (a middle delete never leaves it without its parent).
        npcs[who.key] = { name: who.name, meters, stages: {}, unlocked: [], milestones: {} };
        return true;
    }

    function note(slice, rev, problems) {
        if (!problems.length) return;
        if (!Array.isArray(slice.problems)) slice.problems = [];
        for (const text of problems) slice.problems.push({ rev: isInt(rev) ? rev : 0, text });
        if (slice.problems.length > MAX_PROBLEMS) slice.problems.splice(0, slice.problems.length - MAX_PROBLEMS);
    }

    // Meter changes from a record of numbers ({ trust: 3 }); unknown names become problems.
    function changesFrom(meters, defs, mode, problems) {
        const byId = new Map(defs.flatMap(def => [[def.id, def], [slug(def.label), def]]));
        const changes = [];
        for (const [name, raw] of Object.entries(isObject(meters) ? meters : {})) {
            const def = byId.get(slug(name));
            if (!def) { problems.push(`"${name}" is not a meter (meters: ${defs.map(item => item.id).join(', ')}).`); continue; }
            const value = Number(raw);
            if (!Number.isFinite(value) || Math.abs(value) > CUSTOM_RANGE.max * 2) { problems.push(`${def.label} was given ${JSON.stringify(raw)}, which is not a whole number.`); continue; }
            changes.push({ meter: def.id, mode, value: Math.round(value) });
        }
        return changes;
    }

    // Stages, ladder and notes of one record, with this NPC's own setup.
    const settleRecord = (record, labels, settings, defs, tick = false) => {
        const setup = setupFor(record.name, labels);
        return settle(record, {
            defs, stages: settings.stages, rules: rulesFor(record.name, labels), name: record.name,
            rungs: rungsFor(settings, setup), conflictAt: settings.conflictAt, demoteAfter: settings.demoteAfter, tick,
        });
    };

    // Opens and shuts notes of one record. `notes`: { open: [id], close: [id], story: bool }. A story event may
    // only open a note that has an event (`when`); the reader's hand may open or shut any of its notes. A shut
    // note is kept in `held`, so a meter does not open it again; opening it takes it out of `held`.
    function openCloseNotes(record, rules, notes) {
        const known = new Map(rules.filter(rule => rule && typeof rule.id === 'string').map(rule => [rule.id, rule]));
        const ids = list => [...new Set(Array.isArray(list) ? list.filter(id => typeof id === 'string' && known.has(id)) : [])];
        const held = new Set(Array.isArray(record.held) ? record.held : []);
        const before = JSON.stringify([record.unlocked, [...held]]);
        const opened = [];
        if (!notes.story) {
            for (const id of ids(notes.close)) {
                const at = record.unlocked.indexOf(id);
                if (at >= 0) record.unlocked.splice(at, 1);
                if (held.size < MAX_UNLOCKED) held.add(id);
            }
        }
        for (const id of ids(notes.open)) {
            if (record.unlocked.includes(id) || record.unlocked.length >= MAX_UNLOCKED) continue;
            if (notes.story && (!known.get(id).when || held.has(id))) continue;
            record.unlocked.push(id);
            held.delete(id);
            opened.push({ id, text: `${record.name}: a hidden note opened (${notes.story ? 'the story' : 'by hand'})` });
        }
        if (held.size) record.held = [...held];
        else delete record.held;
        return { opened, changed: JSON.stringify([record.unlocked, [...held]]) !== before };
    }

    // A story line's moves through the impact tiers. The built-in meters move as Delta's scanner moves them
    // (applyRelationshipDelta: the tier's cap, the resistance of a deep value, the milestone gates), one meter at a
    // time, so a line that names two meters moves each; a move too small to show a whole point is kept on the record
    // as `progress` and adds up on the next line. A custom meter's step is held to the tier's cap. `=N` is a move
    // toward N. The per-reply cap and the meter's range still apply after (moveMeters).
    // → the changes as { meter, mode: 'add', value, ask } (`ask`: the value the line asked for).
    function tiered(record, changes, defs, { tier, caps }) {
        const byId = new Map(defs.map(def => [def.id, def]));
        const limits = normalizeRelationshipCaps(caps);
        const live = Object.fromEntries(RELATIONSHIP_KEYS.map(id => [id, meterValue(record, byId.get(id))]));
        const part = isObject(record.progress) ? { ...record.progress } : {};
        const out = [];
        for (const change of changes) {
            const def = byId.get(change.meter);
            if (!def) continue;
            const before = RELATIONSHIP_KEYS.includes(def.id) ? live[def.id] : meterValue(record, def);
            const asked = change.mode === 'add' ? before + change.value : change.value;
            const delta = asked - before;
            let step;
            if (RELATIONSHIP_KEYS.includes(def.id)) {
                const update = applyRelationshipDelta(live, { [def.id]: delta }, tier, limits, { [def.id]: Number(part[def.id]) || 0 });
                step = update.appliedDelta[def.id];
                live[def.id] = update.relationship[def.id];
                part[def.id] = update.relationshipProgress[def.id];
            } else {
                const cap = limits[tier];
                step = Math.max(-cap, Math.min(cap, delta));
            }
            out.push({ meter: def.id, mode: 'add', value: step, ask: asked });
        }
        const kept = Object.fromEntries(Object.entries(part).filter(([, value]) => value));
        if (Object.keys(kept).length) record.progress = kept;
        else delete record.progress;
        return out;
    }

    // `milestone`: { add: [{ key, name }], remove: [key] } (the reader's or a story line's).
    function run(ctx, { label, changes, problems, limit, reply, at = null, seed, disposition, allowEmpty = false, milestone = null, notes = null, impact = null, story = false, yieldToStory = false, scanTier = null, reason = '' }) {
        const settings = normalized(ctx.settings(), ctx);
        const defs = defsFrom(settings);
        if (!changes.length && disposition === undefined && !allowEmpty) {
            ctx.fail('REFUSED', problems.length ? problems.join(' ') : 'It names no meter to change.');
        }
        const slice = ctx.draft(NPC_DOMAIN);
        if (!isObject(slice.npcs)) slice.npcs = {};
        if (!Array.isArray(slice.problems)) slice.problems = [];
        const who = identify(slice.npcs, label);
        if (!who) ctx.fail('INVALID', 'The change does not name anyone.');
        const created = ensure(ctx, slice.npcs, who, defs, seed ?? who.seed);
        const record = slice.npcs[who.key];
        if (!isObject(record.stages)) record.stages = {};
        if (!Array.isArray(record.unlocked)) record.unlocked = [];
        const setup = setupFor(record.name, who.labels);
        // Delta's scan of a reply whose story line already moved a meter leaves that meter to the line (one move, not two).
        const left = yieldToStory && limit && record.turn && sameReply(record.turn, reply) && Array.isArray(record.turn.story) ? record.turn.story : [];
        const mine = left.length ? changes.filter(change => !left.includes(change.meter)) : changes;
        // Pacing (relationship-pacing.js): one event per line or scanner change, counted once whatever number of meters it names.
        // A story line (`impact`) and a forwarded scanner change (`scanTier`) share the record's count; a change with neither is not paced.
        const asked = impact?.tier ?? pacedTier(scanTier);
        const spent = asked && mine.length && limit ? spendFlatEvent(record.impactDay, { tier: asked, reply: replyKey(reply, reply), clockDay: clockDay(at), allowance: tierAllowance() }) : null;
        if (spent?.next) record.impactDay = spent.next;
        const pace = spent ? pacingNote(asked, spent.used, spent.skipped) : '';
        const askedNow = spent ? askedOf(mine, id => meterValue(record, defs.find(def => def.id === id))) : null;
        let stepped = mine;
        if (spent && !spent.used) stepped = [];
        else if (impact) stepped = tiered(record, mine, defs, { ...impact, tier: spent?.used ?? impact.tier });
        else if (spent?.used && spent.used !== asked) stepped = cutToTier(mine, spent.used, normalizeRelationshipCaps(tierCaps() ?? {}), id => meterValue(record, defs.find(def => def.id === id)));
        const moved = moveMeters(record, stepped, { defs, cap: settings.changeCap, reply, at, limit, limits: limitsFor(settings, setup), story });
        // Mood (npc-mood.js; feature mood-pull): the trust this line moved, as code reads it, is a trust drop or a betrayal.
        if (limit && moved.length && featureOn(FEATURE_MOOD_PULL, ctx)) {
            const day = clockMinutes(at) ?? timeMinutes(ctx);
            const events = day === null ? [] : eventsFromMoves(moved.map(item => ({ meter: item.meter, change: item.after - item.before })), { reason, impact: spent?.used ?? asked });
            if (events.length) record.mood = applyEvents(record.mood, day, events);
        }
        // This event's outcome, written whole on the record (display only; the card's tier, held and asked).
        if (spent && replyKey(reply, reply) !== null) {
            const text = nextEvent(record.lastEvent, { reply: replyKey(reply, reply), date: clockDay(at) === null ? '' : call(hooks.startDate, '', at), src: impact ? 'story' : 'scan', ask: askedNow, tier: spent.used ?? asked, held: !spent.used, note: pace });
            if (text) record.lastEvent = text;
        }
        if (!limit) {
            // The reader's own value for a built-in meter ends the part-points the story lines had gathered on it.
            for (const change of changes) if (record.progress) delete record.progress[change.meter];
            if (record.progress && !Object.keys(record.progress).length) delete record.progress;
        }
        if (disposition !== undefined) {
            if (disposition) record.disposition = disposition;
            else delete record.disposition;
        }
        let marked = null;
        if (milestone) {
            const had = isObject(record.milestones) ? record.milestones : {};
            const next = { ...had };
            for (const key of milestone.remove ?? []) delete next[key];
            const added = (milestone.add ?? []).filter(item => !Object.hasOwn(had, item.key));
            for (const item of added) next[item.key] = item.name;
            if (Object.keys(next).length > MAX_MILESTONES) ctx.fail('REFUSED', `${record.name} can keep up to ${MAX_MILESTONES} milestones.`);
            if (JSON.stringify(next) === JSON.stringify(had)) {
                ctx.fail('REFUSED', milestone.add?.length === 1 && !milestone.remove?.length
                    ? `${record.name} already has the milestone “${had[milestone.add[0].key] ?? milestone.add[0].name}”.` : 'Those milestones are already as given.');
            }
            // Each milestone is its own key: added and taken away by key, never as a list.
            if (!isObject(record.milestones)) record.milestones = {};
            for (const key of milestone.remove ?? []) delete record.milestones[key];
            for (const item of added) record.milestones[item.key] = item.name;
            marked = added.length === 1 ? added[0] : null;
        }
        // Notes opened or shut by hand or by a story event, before the meters are looked at again.
        const handled = notes ? openCloseNotes(record, rulesFor(record.name, who.labels), notes) : null;
        const settled = settleRecord(record, who.labels, settings, defs);
        if (handled?.opened.length) settled.unlocked.unshift(...handled.opened);
        if (notes && !handled.changed && !settled.stages.length && !settled.ranks.length && !settled.unlocked.length) {
            ctx.fail('REFUSED', 'Nothing to update.');
        }
        note(slice, ctx.rev, problems);
        return result({ name: record.name, key: who.key, moved, settled, problems, created, disposition, milestone: marked, pace });
    }

    const shared = {
        call, resolve, baseline, tierCaps, rulesFor, presentNames, featureOn, catalog, normalized,
        storedSettings, tierAllowance, clockDay, defsFrom, readerAction, ownOrModule, headReply, commandReply, setupFor,
        ownRungs, rungsFor, limitsFor, identify, ensure, note, changesFrom, settleRecord,
        openCloseNotes, tiered, run, hooks,
    };
    const { captureLine, commands } = createNpcCommands(shared);
    const { queries, ladderView, notesView, sliceOf, presentKeys } = createNpcQueries(shared);
    const { staticText, tail, redact } = createNpcPrompt(shared, { sliceOf, presentKeys });

    return {
        domains: { [NPC_DOMAIN]: { initial: initialNpcSlice, validate: slice => validateNpcSlice(slice) } },
        commands,
        queries,
        kinds: {
            [NPC_KIND]: { grammar: '~ npc Name | trust: +N | affection: -N', apply: captureLine },
            [MILESTONE_KIND]: { grammar: '+ milestone Name — the turning point that just happened between you (once)', apply: captureLine, feature: FEATURE_STAGES },
        },
        context: { static: staticText, tail, budget: CONTEXT_BUDGET },
        redact,
        settings: { defaults: { ...SETTINGS_DEFAULTS }, schema: SETTINGS_SCHEMA },
        features: FEATURES,
        featureOn: id => featureOn(id),
        identify: (npcs, label) => identify(npcs ?? {}, label),
        defs: () => defsFrom(storedSettings()),
        meterSettings: () => storedSettings(),
        /** True when Delta's per-reply tick has something to look at (a ladder, or a drifting meter). */
        tickWanted: () => {
            const settings = storedSettings();
            return (featureOn(FEATURE_STAGES) && Object.keys(settings.ladder).length > 0)
                || (featureOn(FEATURE_DRIFT) && settings.custom.some(def => def.drift))
                || featureOn(FEATURE_MOOD_PULL);
        },
        ladder: record => (isObject(record) ? ladderView(record, storedSettings(), defsFrom(storedSettings())) : null),
        notes: record => (isObject(record) ? notesView(record, defsFrom(storedSettings())) : { locked: [], opened: [] }),
    };
}
