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
import { NPC_DOMAIN, NPC_KIND, MILESTONE_KIND, BUILT_IN_METERS, CUSTOM_RANGE, MAX_NPCS, MAX_STAGES_PER_METER, MAX_UNLOCKED, MAX_PROBLEMS, MAX_MILESTONES, MAX_RUNGS, DAY_MINUTES, RECENT_MESSAGES, SECRET_TEXT_MAX, SECRET_TITLE_MAX, MILESTONE_MAX, TAIL_SECRETS_PER_NPC, CONTEXT_BUDGET, FEATURE_STAGES, FEATURE_DRIFT, FEATURE_PRESETS, FEATURES, FEATURE_DEFAULTS, NAME_MAX, DISPOSITION_MAX, TRACK_MAX, REASON_LABELS, IMPACT_TIERS, tierOf, isObject, isInt, isReplyId, replyKey, sameReply, clamp, clean, own, slug, npcKey, KEY_PEOPLE_QUERY, wordKey, intOr, bandWord, needMet, rung, normalizeMeterSettings, meterDefs, thresholdReached, stageAt, parseMeterValue } from './npc-meters-config.js';
import { initialNpcSlice, observeKeyAway, CAST_QUERY, observeCast, validateNpcSlice, findNpcKey, meterValue, moveMeters, rungMet, conflictOn, settle, sentence, result } from './npc-meters-slice.js';
import { SETTINGS_DEFAULTS, SETTINGS_SCHEMA } from './npc-meters-schema.js';
export { NPC_DOMAIN, NPC_KIND, MILESTONE_KIND, BUILT_IN_METERS, BUILT_IN_RANGE, CUSTOM_RANGE, MAX_CUSTOM_METERS, MAX_NPCS, MAX_METERS_PER_NPC, MAX_STAGES_PER_METER, MAX_SECRETS, MAX_GENERATED_SECRETS, MAX_UNLOCKED, MAX_PROBLEMS, MAX_MILESTONES, MAX_RUNGS, MAX_TRACKS, MAX_BANDS, MAX_NEEDS, DEFAULT_CHANGE_CAP, MAX_CHANGE_CAP, DEFAULT_CONFLICT_AT, DEFAULT_DEMOTE_AFTER, DAY_MINUTES, RECENT_MESSAGES, SECRET_TEXT_MAX, SECRET_TITLE_MAX, SECRET_WHEN_MAX, NOTE_SOURCES, MILESTONE_MAX, DESCRIBE_MAX, TAIL_SECRETS_PER_NPC, CONTEXT_BUDGET, FEATURE_STAGES, FEATURE_DRIFT, FEATURE_PRESETS, FEATURE_SCAN_EVERY_REPLY, FEATURES, replyKey, slug, npcKey, KEY_PEOPLE_QUERY, wordKey, parseBands, bandWord, parseNeeds, normalizeMeterSettings, meterDefs, thresholdReached, stageAt, parseMeterValue } from './npc-meters-config.js';
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
    function run(ctx, { label, changes, problems, limit, reply, at = null, seed, disposition, allowEmpty = false, milestone = null, notes = null, impact = null, story = false, yieldToStory = false }) {
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
        const stepped = impact ? tiered(record, mine, defs, impact) : mine;
        const moved = moveMeters(record, stepped, { defs, cap: settings.changeCap, reply, at, limit, limits: limitsFor(settings, setup), story });
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
        return result({ name: record.name, key: who.key, moved, settled, problems, created, disposition, milestone: marked });
    }

    // ---- the change lines ----

    function captureMilestone(ctx, line = {}) {
        if (!featureOn(FEATURE_STAGES, ctx)) ctx.fail('FEATURE_OFF', 'Stage ladders and milestones are turned off.');
        if (line.op !== '+') ctx.fail('REFUSED', 'A milestone is only ever added (+ milestone Name — what happened); the reader takes one away in the dossier editor.');
        const name = clean(line.text, MILESTONE_MAX);
        const key = wordKey(name);
        if (!key) ctx.fail('INVALID', 'The line names no milestone: + milestone Name — what happened.');
        return run(ctx, { label: line.name, changes: [], problems: [], limit: false, reply: null, allowEmpty: true, milestone: { add: [{ key, name }] } });
    }

    function captureLine(ctx, line = {}) {
        if (line.kind === MILESTONE_KIND) return captureMilestone(ctx, line);
        const settings = normalized(ctx.settings(), ctx);
        const defs = defsFrom(settings);
        const byLabel = new Map(defs.flatMap(def => [[def.id, def], [slug(def.label), def]]));
        const problems = [];
        const changes = [];
        let disposition;
        let tier = 'ordinary';
        for (const [label, raw] of Object.entries(isObject(line.labels) ? line.labels : {})) {
            const key = slug(label);
            if (REASON_LABELS.has(key)) continue;
            if (key === 'impact' && !byLabel.has(key)) { tier = tierOf(raw); continue; }
            if (key === 'stage' || key === 'stages') { problems.push(`Stages are set by code from the meters; "stage: ${clean(raw, 60)}" was not used.`); continue; }
            if (key === 'disposition') { disposition = clean(raw, DISPOSITION_MAX); continue; }
            const def = byLabel.get(key);
            if (!def) { problems.push(`"${clean(label, 40)}" is not a meter (meters: ${defs.map(item => item.id).join(', ')}).`); continue; }
            const parsed = parseMeterValue(raw);
            if (!parsed) { problems.push(`${def.label}: "${clean(raw, 40)}" is not +N, -N or =N.`); continue; }
            changes.push({ meter: def.id, ...parsed });
        }
        // B-a1-15: the window is the reply's by its record ID, so after a middle delete a new reply at an
        // index an older one had is its own reply, with its own cap.
        const at = isInt(ctx.carrier?.index) ? ctx.carrier.index : null;
        const reply = replyKey(ctx.carrier?.sid, at);
        return run(ctx, { label: line.name, changes, problems, limit: true, reply, at, disposition, allowEmpty: line.op === '+', impact: tierCaps() ? { tier, caps: tierCaps() } : null, story: true });
    }

    // ---- commands (cause ui from Delta itself; capture is the story's) ----

    const milestoneList = value => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value])
        .map(item => clean(isObject(item) ? item.name ?? item.key : item, MILESTONE_MAX)).filter(Boolean)
        .map(name => ({ key: wordKey(name), name })).filter(item => item.key);

    const commands = {
        /**
         * npc.adjust { name, meters: { meter: ±n }, start?: { meter: n }, reply?: n }: moves meters
         * by the given amounts, with the same range, per-reply and per-NPC clamps as a story line.
         * Delta's own scanner sends its relationship changes this way while hosted (`start`: the
         * values the dossier had before them, for an NPC the slice has no entry for yet). Only
         * Delta's scanner and another module's command (ctx.call) may send it: a button, screen or
         * pack at the top (cause ui, no calling module) is refused, as the host's own steps are.
         */
        'npc.adjust'(ctx, payload = {}) {
            if (!ownOrModule(ctx, 'npc.adjust', payload)) {
                ctx.fail('REFUSED', 'Meters move with the story and with NPC State Delta\'s scans; the dossier editor sets them by hand.');
            }
            const problems = [];
            const defs = defsFrom(normalized(ctx.settings(), ctx));
            const changes = changesFrom(payload?.meters, defs, 'add', problems).filter(change => change.value !== 0);
            const at = isInt(payload?.reply) && payload.reply >= 0 ? payload.reply : null;
            return run(ctx, { label: payload?.name, changes, problems, limit: true, reply: commandReply(ctx, at), at, seed: isObject(payload?.start) ? payload.start : null, yieldToStory: true });
        },
        /**
         * npc.set { name, meters: { meter: n }, reply? }: the reader's own values (range only). From
         * a button or screen the reply is the latest one, whatever the payload says; `reply` is
         * read only from another module's command.
         */
        'npc.set'(ctx, payload = {}) {
            const problems = [];
            const defs = defsFrom(normalized(ctx.settings(), ctx));
            const changes = changesFrom(payload?.meters, defs, 'set', problems);
            const asked = isInt(payload?.reply) && payload.reply >= 0 ? payload.reply : null;
            const at = readerAction(ctx) ? headReply() : asked;
            return run(ctx, { label: payload?.name, changes, problems, limit: false, reply: commandReply(ctx, at), at });
        },
        /** npc.refresh { name }: stages, the ladder and notes again (after the reader changed them). */
        'npc.refresh'(ctx, payload = {}) {
            const slice = ctx.read(NPC_DOMAIN);
            const who = identify(slice?.npcs ?? {}, payload?.name);
            if (!who || !Object.hasOwn(slice?.npcs ?? {}, who.key)) ctx.fail('NOT_FOUND', 'That NPC has no meters yet.');
            const out = run(ctx, { label: payload.name, changes: [], problems: [], limit: false, reply: null, allowEmpty: true });
            if (!out.data.stages.length && !out.data.unlocked.length && !out.data.ranks?.length) ctx.fail('REFUSED', 'Nothing to update.');
            return out;
        },
        /**
         * npc.open { name, open?: [noteId], close?: [noteId], by?: 'story' }: opens or shuts hidden notes. From
         * Delta's scan (`by: 'story'`, its own send only): notes whose story event the reply showed. From the
         * reader's editor (no `by`): any of the dossier's notes, opened or shut by hand (a shut one stays shut
         * until it is opened by hand). Recorded on the reply like any change, so a swipe takes it back.
         */
        'npc.open'(ctx, payload = {}) {
            const story = payload?.by === 'story';
            if (story && !ownOrModule(ctx, 'npc.open', payload)) {
                ctx.fail('REFUSED', 'A story event opens a note only through NPC State Delta\'s own scan.');
            }
            const open = Array.isArray(payload?.open) ? payload.open : [];
            const close = Array.isArray(payload?.close) ? payload.close : [];
            if (!open.length && !close.length) ctx.fail('INVALID', 'It names no note to open or shut.');
            // Someone with notes but no meters yet gets an entry here, from their dossier's numbers.
            return run(ctx, { label: payload?.name, changes: [], problems: [], limit: false, reply: null, allowEmpty: true, notes: { open, close, story } });
        },
        /**
         * npc.milestone { name, add?: [words], remove?: [words or keys] }: the reader's own milestones
         * for one NPC (the dossier editor). Each is kept under its words' key, so the same milestone
         * written twice is one; a new one may promote on the ladder at once.
         */
        'npc.milestone'(ctx, payload = {}) {
            if (!featureOn(FEATURE_STAGES, ctx)) ctx.fail('FEATURE_OFF', 'Stage ladders and milestones are turned off.');
            const add = milestoneList(payload?.add);
            const remove = milestoneList(payload?.remove).map(item => item.key);
            if (!add.length && !remove.length) ctx.fail('INVALID', 'It names no milestone to add or take away.');
            return run(ctx, { label: payload?.name, changes: [], problems: [], limit: false, reply: null, allowEmpty: true, milestone: { add, remove } });
        },
        /**
         * npc.tick {}: Delta's own step after each reply (and another module's, through ctx.call):
         * meters with a drift move toward their resting value for each story day passed (Story
         * Director's clock; feature npc-state-delta.drift), and every NPC below its rung's needs counts
         * one more reply toward losing it (feature npc-state-delta.stages). Refused when nothing moves.
         */
        'npc.tick'(ctx, payload = {}) {
            if (!ownOrModule(ctx, 'npc.tick', payload)) ctx.fail('REFUSED', 'The per-reply step is NPC State Delta\'s own.');
            const settings = normalized(ctx.settings(), ctx);
            const defs = defsFrom(settings);
            const drifting = featureOn(FEATURE_DRIFT, ctx) ? defs.filter(def => def.drift) : [];
            let minutes = null;
            if (drifting.length && typeof ctx.time === 'function') {
                try { minutes = ctx.time(); } catch { minutes = null; }
            }
            const day = isInt(minutes) ? Math.floor(minutes / DAY_MINUTES) : null;
            // Key people (Story Director's `director.keyPeople`, read only): while one is away their meters stay as
            // the reader set them, so no drift and no count toward losing a stage. Without that query: nobody.
            let people = null;
            try {
                let calendar = null;
                try { calendar = ctx.query('director.calendar', {}); } catch { calendar = null; }
                people = normalizeKeyPeople(ctx.query(KEY_PEOPLE_QUERY, {}), minutes => storyMinuteText(minutes, calendar));
            } catch { people = null; }
            const awayKeys = new Set();
            for (const entry of people ?? []) if (isAway(entry)) for (const label of labelsOf(entry)) awayKeys.add(label);
            const before = ctx.read(NPC_DOMAIN);
            // The memory of the last absence (above): noted at this reply.
            const observed = people ? observeKeyAway(before?.keyAway, people, ctx.reply?.index) : null;
            // The living cast (Story Director's `director.cast`, read only): the people met for the first time at this reply.
            let castPeople = null;
            try { castPeople = normalizeCast(ctx.query(CAST_QUERY, {})); } catch { castPeople = null; }
            const castSeen = observeCast(before?.cast, castPeople);
            if ((!isObject(before?.npcs) || !Object.keys(before.npcs).length) && !observed?.changed && !castSeen.fresh.length) ctx.fail('REFUSED', 'Nothing to update.');
            const slice = ctx.draft(NPC_DOMAIN);
            const castNames = [];
            for (const person of castSeen.fresh) {
                castNames.push(person.name);
                const who = identify(slice.npcs, person.name);
                if (!who || Object.hasOwn(slice.npcs, who.key)) continue;
                // The pack's first meter values (by id or label); a meter this chat does not have is a problem line, not an error.
                const byId = new Map(defs.flatMap(def => [[def.id, def], [slug(def.label), def]]));
                const seed = {};
                const unknown = [];
                for (const [name, value] of Object.entries(person.entry.meters.values)) {
                    const def = byId.get(slug(name));
                    if (def) seed[def.id] = value;
                    else unknown.push(`${person.name}: "${clean(name, 40)}" is not a meter here (meters: ${defs.map(item => item.id).join(', ')}).`);
                }
                try { ensure(ctx, slice.npcs, who, defs, seed); } catch { continue; }
                note(slice, ctx.rev, unknown);
            }
            if (castSeen.fresh.length) slice.cast = castSeen.cast;
            const texts = [];
            const data = [];
            let narrate = false;
            let changed = false;
            for (const key of Object.keys(slice.npcs).sort()) {
                const record = slice.npcs[key];
                if (!isObject(record) || !isObject(record.meters)) continue;
                if (!isObject(record.stages)) record.stages = {};
                if (!Array.isArray(record.unlocked)) record.unlocked = [];
                const was = JSON.stringify(record);
                const drift = [];
                const away = awayKeys.size > 0 && [record.name, ...(resolve(record.name)?.aliases ?? [])].some(label => awayKeys.has(labelKey(label)));
                if (day !== null) {
                    const days = isInt(record.day) ? day - record.day : 0;
                    if (record.day !== day) record.day = day;
                    const setup = setupFor(record.name);
                    const limits = limitsFor(settings, setup);
                    for (const def of days > 0 && !away ? drifting : []) {
                        const value = meterValue(record, def);
                        const { perDay, to } = def.drift;
                        const step = Math.min(Math.abs(to - value), perDay * days);
                        let next = value + Math.sign(to - value) * step;
                        const bound = limits[def.id];
                        if (bound && isInt(bound.ceiling) && next > value) next = Math.max(value, Math.min(next, bound.ceiling));
                        if (bound && isInt(bound.floor) && next < value) next = Math.min(value, Math.max(next, bound.floor));
                        next = clamp(next, def.min, def.max);
                        if (next === value) continue;
                        record.meters[def.id] = next;
                        drift.push({ meter: def.id, before: value, after: next });
                    }
                }
                const settled = settleRecord(record, [record.name], settings, defs, featureOn(FEATURE_STAGES, ctx) && !away);
                if (JSON.stringify(record) === was) continue;
                changed = true;
                if (drift.length) texts.push(`${record.name}: ${drift.map(item => `${defs.find(def => def.id === item.meter)?.label.toLocaleLowerCase() ?? item.meter} ${item.before} → ${item.after}`).join(', ')} (story days passed)`);
                texts.push(...settled.stages.map(move => move.text), ...settled.ranks.map(move => move.text), ...settled.unlocked.map(item => item.text));
                if (settled.stages.length || settled.ranks.length) narrate = true;
                data.push({ key, drift, stages: settled.stages.map(({ meter, from, to }) => ({ meter, from, to })), ranks: settled.ranks.map(({ from, to }) => ({ from, to })), unlocked: settled.unlocked.map(item => item.id), ...(isInt(record.low) ? { low: record.low } : {}) });
            }
            if (observed?.changed) {
                if (Object.keys(observed.memory).length) slice.keyAway = observed.memory;
                else delete slice.keyAway;
                if (!changed) texts.push('Key people: noted');
                changed = true;
            }
            if (castNames.length) {
                if (!changed) texts.push(`Cast dossier: ${castNames.join(', ')}`);
                changed = true;
            }
            if (!changed) ctx.fail('REFUSED', 'Nothing to update.');
            return { summary: sentence(texts.length ? texts : ['NPC meters: the reply was counted']), narrate, data: { day, npcs: data, ...(castNames.length ? { cast: castSeen.fresh.map(person => person.key) } : {}) } };
        },
    };

    // ---- queries ----

    const sliceOf = state => (isObject(state?.domains?.[NPC_DOMAIN]?.npcs) ? state.domains[NPC_DOMAIN] : initialNpcSlice());
    const entryView = (key, record, defs, rungs) => ({
        key,
        name: record.name,
        meters: Object.fromEntries(defs.map(def => [def.id, meterValue(record, def)])),
        stages: { ...(record.stages ?? {}) },
        unlocked: [...(record.unlocked ?? [])],
        ...(Array.isArray(record.held) && record.held.length ? { held: [...record.held] } : {}),
        ...(record.disposition ? { disposition: record.disposition } : {}),
        // The window's reply by its index (as before record IDs): `at` beside a record ID.
        ...(isInt(record.turn?.at) ? { reply: record.turn.at } : isInt(record.turn?.reply) ? { reply: record.turn.reply } : {}),
        ...(isObject(record.milestones) && Object.keys(record.milestones).length ? { milestones: { ...record.milestones } } : {}),
        ...(rungs.find(step => step.key === record.rank) ? { rank: rungs.find(step => step.key === record.rank).name } : {}),
    });

    /**
     * What the NPC's ladder looks like from here: { rank, next, risk, text } (null without a ladder).
     *   rank  the rung reached (its name) or null
     *   next  { name, needs: [{ meter, label, value, at, below, met }], milestone: { name, met } | null,
     *         held } for the rung after it, or null at the top
     *   risk  { name, needs, replies, of } while the reached rung's needs fail (it falls back after
     *         `of` replies in a row; `replies` so far), or null
     *   text  one line: "Next: Confidant — affection 40/55, milestone “saved her brother”"
     */
    function ladderView(record, settings, defs) {
        const setup = setupFor(record.name);
        const rungs = rungsFor(settings, setup);
        if (!rungs.length) return null;
        const byId = new Map(defs.map(def => [def.id, def]));
        const at = rungs.findIndex(step => step.key === record.rank);
        const needsOf = step => step.needs.map(need => {
            const def = byId.get(need.meter);
            const value = def ? meterValue(record, def) : null;
            return { meter: need.meter, label: def?.label ?? need.meter, value, at: need.at, below: need.below, met: def ? needMet(need, value) : false };
        });
        const missing = needs => needs.filter(need => !need.met).map(need => (need.value === null ? `${need.label} (no such meter)` : `${need.label.toLocaleLowerCase()} ${need.value}/${need.at}`));
        const upcoming = rungs[at + 1] ?? null;
        const next = upcoming ? {
            name: upcoming.name,
            needs: needsOf(upcoming),
            milestone: upcoming.milestone ? { name: upcoming.milestone.name, met: own(record.milestones, upcoming.milestone.key) } : null,
            held: rungMet(record, upcoming, defs) && conflictOn(record, defs, settings.conflictAt),
        } : null;
        const current = at >= 0 ? rungs[at] : null;
        const risk = current && !rungMet(record, current, defs) && settings.demoteAfter > 0
            ? { name: current.name, needs: needsOf(current), replies: isInt(record.low) ? record.low : 0, of: settings.demoteAfter } : null;
        const parts = [];
        if (next) {
            const lacking = [...missing(next.needs), ...(next.milestone && !next.milestone.met ? [`milestone “${next.milestone.name}”`] : [])];
            if (next.held) parts.push(`Next: ${next.name} — waits while tension is above ${settings.conflictAt}`);
            else if (lacking.length) parts.push(`Next: ${next.name} — ${lacking.join(', ')}`);
        }
        if (risk) parts.push(`${risk.name} slipping — ${missing(risk.needs).join(', ') || 'milestone'} (${risk.replies}/${risk.of} replies)`);
        return { rank: current?.name ?? null, next, risk, text: parts.join('; ') };
    }

    // The notes of a dossier for screens. A locked one shows only its rule ("Opens at Trust 60", "Opens with the
    // story"), never its title, text or event wording; an opened one its title and what opened it ("Opened · Trust 20").
    function notesView(record, defs) {
        const byId = new Map(defs.map(def => [def.id, def]));
        const unlocked = new Set(Array.isArray(record.unlocked) ? record.unlocked : []);
        const locked = [];
        const opened = [];
        for (const rule of rulesFor(record.name, [record.name])) {
            if (!rule || typeof rule.id !== 'string') continue;
            const meter = isInt(rule.at) && typeof rule.meter === 'string' && rule.meter ? `${byId.get(rule.meter)?.label ?? rule.meter} ${rule.at}` : '';
            const event = typeof rule.when === 'string' && rule.when.trim() !== '';
            if (!meter && !event) continue;
            const title = clean(rule.title, SECRET_TITLE_MAX) || 'A hidden note';
            if (unlocked.has(rule.id)) {
                // What opened it: its meter (when the meter is past the rule), else the story's event, else the reader's hand.
                const def = byId.get(rule.meter);
                const reached = Boolean(meter) && Boolean(def) && isObject(record.meters) && thresholdReached(meterValue(record, def), rule.at);
                const how = reached ? meter : event ? 'with the story' : 'by you';
                opened.push({ id: rule.id, title, rule: how, text: `Opened · ${how}` });
                continue;
            }
            const opens = meter && event ? `Opens at ${meter} or with the story` : meter ? `Opens at ${meter}` : 'Opens with the story';
            locked.push({ id: rule.id, ...(meter ? { meter: rule.meter, at: rule.at } : {}), event, opens, text: `Hidden note · ${opens[0].toLocaleLowerCase()}${opens.slice(1)}` });
        }
        return { locked, opened };
    }

    function bars(record, defs, settings, { headReply: head = undefined, reply = null } = {}) {
        const setup = setupFor(record.name);
        const limits = limitsFor(settings, setup);
        const rungs = rungsFor(settings, setup);
        // A window that belongs to a reply other than the head's is not "since the last reply". The head
        // is asked by index; a window keyed by record ID is the head's when the query's reply
        // (`tools.reply`, the head) is at that index with that ID.
        const headKey = isInt(head) && reply?.index === head && isReplyId(reply?.sid) ? reply.sid : head;
        const fresh = head === undefined || (isInt(head) && (sameReply(record.turn, head) || sameReply(record.turn, headKey)));
        return defs.filter(def => def.show).map(def => {
            const value = meterValue(record, def);
            const stage = record.stages?.[def.id] ?? '';
            const band = bandWord(def.bands, value);
            const ticks = [
                ...(settings.stages[def.id] ?? []).map(item => ({ at: item.at, label: item.name })),
                ...rungs.flatMap(step => step.needs.filter(need => need.meter === def.id).map(need => ({ at: need.at, label: step.name }))),
            ].filter(item => item.at >= def.min && item.at <= def.max).sort((a, b) => a.at - b.at).slice(0, MAX_STAGES_PER_METER);
            const limit = limits[def.id];
            const from = record.turn?.from?.[def.id];
            const delta = fresh && isInt(from) ? value - from : 0;
            const bar = {
                id: def.id, label: def.label, value, min: def.min, max: def.max, stage, tone: def.tone,
                text: stage ? `${value} · ${stage}` : band ? `${value} · ${band}` : String(value),
                ...(isInt(limit?.ceiling) ? { ceiling: limit.ceiling } : {}),
                ...(isInt(limit?.floor) ? { floor: limit.floor } : {}),
                ...(ticks.length ? { ticks } : {}),
            };
            return delta ? { ...bar, delta } : bar;
        });
    }
    const presentKeys = npcs => new Set(presentNames().map(name => findNpcKey(npcs, [name, ...(resolve(name)?.aliases ?? [])])).filter(Boolean));

    const queries = {
        /**
         * npc.meters({ name }) → { key, name, meters, stages, unlocked, disposition?, reply?,
         * milestones?, rank? } | null; without a name, every entry (in key order). Meters are filled
         * in for every meter in use.
         */
        'npc.meters'(state, args = {}) {
            const { npcs } = sliceOf(state);
            const settings = storedSettings();
            const defs = defsFrom(settings);
            const view = key => entryView(key, npcs[key], defs, rungsFor(settings, setupFor(npcs[key].name)));
            if (args && typeof args.name === 'string') {
                const who = identify(npcs, args.name);
                return who && Object.hasOwn(npcs, who.key) ? view(who.key) : null;
            }
            return Object.keys(npcs).sort().map(view);
        },
        /**
         * npc.cast() → [{ key, name, present, bars, still, rank?, next?, locked, opened }], present
         * first. `bars`: [{ id, label, value, min, max, stage, text, tone, ceiling?, floor?, ticks?,
         * delta? }] (ss.meter's props; `delta` is the change of the entry's latest reply window),
         * `still`: the same without `delta`. `locked`: the hidden notes still locked, as teasers with no
         * title ({ id, meter?, at?, event, opens: "Opens at Trust 60", text: "Hidden note · opens at Trust 60" });
         * `opened`: [{ id, title, text: "Opened · Trust 20" }].
         */
        'npc.cast'(state, args = {}, tools = null) {
            const { npcs } = sliceOf(state);
            const settings = storedSettings();
            const defs = defsFrom(settings);
            const here = presentKeys(npcs);
            const head = isObject(args) && Object.hasOwn(args, 'headReply') ? args.headReply : undefined;
            return Object.keys(npcs)
                .map(key => {
                    const record = npcs[key];
                    const list = bars(record, defs, settings, { headReply: head, reply: tools?.reply ?? null });
                    const ladder = ladderView(record, settings, defs);
                    const notes = notesView(record, defs);
                    return {
                        key, name: record.name, present: here.has(key), bars: list, still: list.map(({ delta, ...bar }) => bar),
                        ...(ladder?.rank ? { rank: ladder.rank } : {}),
                        ...(ladder?.text ? { next: ladder.text } : {}),
                        locked: notes.locked.map(({ id, meter, at, event, opens, text }) => ({ id, ...(meter ? { meter, at } : {}), event, opens, text })),
                        opened: notes.opened.map(({ id, title, text }) => ({ id, title, text })),
                    };
                })
                .sort((a, b) => Number(b.present) - Number(a.present) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        },
        /** npc.keyAway → the memory of key people's last absences (see observeKeyAway), {} when none. Read by Delta's dossier, cards and injection. */
        'npc.keyAway'(state) {
            const memory = state?.domains?.[NPC_DOMAIN]?.keyAway;
            return isObject(memory) ? JSON.parse(JSON.stringify(memory)) : {};
        },
        /** npc.castMade → the people Delta made a dossier for from the cast, { [castKey]: { name, rungs? } }, {} when none. */
        'npc.castMade'(state) {
            const cast = state?.domains?.[NPC_DOMAIN]?.cast;
            return isObject(cast) ? JSON.parse(JSON.stringify(cast)) : {};
        },
        /** npc.next({ name }) → the NPC's ladder from here ({ rank, next, risk, text }), or null. */
        'npc.next'(state, args = {}) {
            const { npcs } = sliceOf(state);
            const who = identify(npcs, args?.name);
            if (!who || !Object.hasOwn(npcs, who.key)) return null;
            const settings = storedSettings();
            return ladderView(npcs[who.key], settings, defsFrom(settings));
        },
        /**
         * npc.socialModifier({ name, skill }) → { mod, name, skill, reasons: [{ text, value }] } | null
         * (src/social-check.js has the rules). Null for a skill that is not social, a name that is
         * neither a dossier (name or alias, any case) nor an entry in `state`, or the feature off.
         * Reads `state` as given (the check's reply) and the stored settings; never writes.
         */
        [SOCIAL_QUERY](state, args = {}) {
            if (!featureOn(FEATURE_SOCIAL)) return null;
            const skill = socialSkill(args?.skill);
            const asked = clean(args?.name, NAME_MAX);
            if (!skill || !asked) return null;
            const { npcs } = sliceOf(state);
            const dossier = resolve(asked);
            const who = identify(npcs, asked);
            const entry = who && Object.hasOwn(npcs, who.key) ? npcs[who.key] : null;
            if (!dossier && !entry) return null;
            const settings = storedSettings();
            const defs = defsFrom(settings);
            // Someone with a dossier but no meters yet stands where their entry would start (ensure).
            const seed = isObject(who.seed) ? who.seed : {};
            const record = entry ?? { name: who.name, meters: Object.fromEntries(defs.map(def => {
                const given = intOr(seed[def.id], null);
                return [def.id, given === null ? def.start : clamp(given, def.min, def.max)];
            })) };
            const meters = defs.map(def => {
                const value = meterValue(record, def);
                const stage = entry ? record.stages?.[def.id] : stageAt(settings.stages[def.id], value)?.name;
                return { def, value, stage: typeof stage === 'string' ? stage : '' };
            });
            const rungs = rungsFor(settings, setupFor(record.name, who.labels));
            const index = record.rank === undefined ? -1 : rungs.findIndex(step => step.key === record.rank);
            return socialModifier({
                name: record.name, skill, meters,
                rank: index >= 0 ? { name: rungs[index].name, index } : null,
                disposition: typeof record.disposition === 'string' ? record.disposition : '',
                settings: socialSettings(call(hooks.settings, {})),
            });
        },
    };

    // ---- the prompt (SPEC §5) ----

    /**
     * One line: how to write an npc line and which meters there are, plus each meter's rule while the
     * presets feature is on. Changes only with the settings (and the presets in use).
     */
    function staticText() {
        const settings = storedSettings();
        const caps = tierCaps();
        const custom = settings.custom.map(def => `, ${def.id} (${def.min}..${def.max})`).join('');
        const base = `NPC meters: ${BUILT_IN_METERS.map(def => def.id).join(', ')} (-100..100)${custom}. When the scene changes how someone feels: ~ npc Name | meter: +N, -N or =N. Code clamps each meter, moves it at most ${settings.changeCap} a reply and sets the stages; never write a stage.${caps ? ` Add | impact: ordinary|meaningful|major|extreme (the most a move can be: ${IMPACT_TIERS.map(tier => caps[tier]).join('/')}; =N moves toward N; none given: ordinary).` : ''}`;
        const rules = featureOn(FEATURE_PRESETS) ? settings.custom.filter(def => def.describe).map(def => `${def.id} ${def.describe}`) : [];
        return rules.length ? `${base} Meter rules: ${rules.join('; ')}.` : base;
    }

    // How far a locked note is from opening (smaller is nearer): its meter's gap, else a story event's fixed middle.
    const EVENT_DISTANCE = 100;
    function openingDistance(rule, record, byId) {
        const def = typeof rule.meter === 'string' ? byId.get(rule.meter) : null;
        if (def && isInt(rule.at)) {
            const value = meterValue(record, def);
            return Math.max(0, rule.at < 0 ? value - rule.at : rule.at - value);
        }
        return EVENT_DISTANCE;
    }

    // The tail's words for a note: an opened one is the player's to know; a locked one shapes how the NPC acts.
    const KNOWN = 'known to the player now; may come out';
    const HIDDEN = 'hidden: never state or reveal; let it shape how they act';
    // (lean) The wording is said once, on the nearest locked note, and each note then reads "Name (hidden): text".
    const HIDDEN_ONCE = 'Lines marked (hidden) are secrets: never state or reveal them; let them shape how that person acts.';
    const HIDDEN_LINE = new RegExp(`^(.+?)(?:, ${HIDDEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}| \\(hidden\\)): .*$`, 'gm');

    /**
     * Present NPCs' meters when they moved lately (band words where a meter has them), and their notes: an
     * opened one as known to the player (a line), a locked one as hidden (optional lines, nearest to opening
     * first, so the host's budget drops the farthest first).
     */
    function tail(view) {
        const state = view?.state;
        const { npcs } = sliceOf(state);
        const settings = storedSettings();
        const defs = defsFrom(settings);
        const byId = new Map(defs.map(def => [def.id, def]));
        const length = Number.isInteger(view?.chat?.length) ? view.chat.length : 0;
        const here = presentKeys(npcs);
        const moved = [];
        const notes = [];
        const hidden = [];
        let order = 0;
        for (const key of Object.keys(npcs).sort()) {
            if (!here.has(key)) continue;
            const record = npcs[key];
            // Where the window's reply was (its index, kept beside a record ID).
            const where = isInt(record.turn?.at) ? record.turn.at : record.turn?.reply;
            if (isInt(where) && where >= length - RECENT_MESSAGES) {
                const parts = defs.map(def => {
                    const stage = record.stages?.[def.id];
                    const value = meterValue(record, def);
                    return `${def.id} ${bandWord(def.bands, value) || value}${stage ? ` (${stage})` : ''}`;
                });
                const rank = record.rank !== undefined ? rungsFor(settings, setupFor(record.name)).find(step => step.key === record.rank)?.name : null;
                moved.push(`${record.name}${rank ? ` (${rank})` : ''} ${parts.join(', ')}`);
            }
            const rules = rulesFor(record.name, [record.name]).filter(rule => rule && typeof rule.id === 'string');
            if (!rules.length) continue;
            const opened = new Set(Array.isArray(record.unlocked) ? record.unlocked : []);
            const given = call(hooks.secretTexts, [], record.name, rules.map(rule => rule.id));
            const textOf = new Map((Array.isArray(given) ? given : []).map(item => [item?.id, clean(item?.text, SECRET_TEXT_MAX)]));
            let known = 0;
            for (const rule of rules) {
                const text = textOf.get(rule.id);
                if (!text) continue;
                if (opened.has(rule.id)) {
                    if (known < TAIL_SECRETS_PER_NPC) { notes.push(`${record.name}, ${KNOWN}: ${text}`); known += 1; }
                } else {
                    hidden.push({ distance: openingDistance(rule, record, byId), order: order += 1, short: `${record.name} (hidden): ${text}` });
                }
            }
        }
        const lines = [];
        if (moved.length) lines.push(`NPC meters now: ${moved.join('; ')}.`);
        hidden.sort((a, b) => a.distance - b.distance || a.order - b.order);
        // The wording rides on the nearest note (the host drops the farthest first, so it stays while any note does).
        const optional = hidden.map((item, i) => (i ? item.short : `${HIDDEN_ONCE}\n${item.short}`));
        return { lines: [...lines, ...notes], optional };
    }

    /**
     * The same text as a reader sees it in "What's sent each reply": a locked note's line becomes
     * "Mira: 1 hidden note", never its text. Everything else is as sent. (Offered to Story Block as the
     * module's `hooks.redactSent`, for the view that draws and copies the sent text; SillyTavern's own prompt view still shows all.)
     */
    function redact(text) {
        // Every locked line of the whole text, wherever it stands; each other line (and every line break) is left as it is.
        return String(text ?? '').replace(HIDDEN_LINE, '$1: 1 hidden note');
    }

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
                || (featureOn(FEATURE_DRIFT) && settings.custom.some(def => def.drift));
        },
        ladder: record => (isObject(record) ? ladderView(record, storedSettings(), defsFrom(storedSettings())) : null),
        notes: record => (isObject(record) ? notesView(record, defsFrom(storedSettings())) : { locked: [], opened: [] }),
    };
}
