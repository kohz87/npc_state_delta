// NPC meter story-line capture and hosted commands. A pure part of npc-meters.js (same owner, moved without change);
// npc-meters.js re-exports every public name it exported before. Never imports npc-meters.js.
import { storyMinuteText } from '../calendar.js';
import { isAway, labelKey, labelsOf, normalizeKeyPeople } from './key-people.js';
import { normalizeCast } from './cast-dossier.js';
import { NPC_DOMAIN, MILESTONE_KIND, DAY_MINUTES, MILESTONE_MAX, DISPOSITION_MAX, REASON_LABELS, FEATURE_STAGES, FEATURE_DRIFT, FEATURE_MOOD_PULL, KEY_PEOPLE_QUERY, isObject, isInt, replyKey, clamp, clean, slug, wordKey, tierOf, parseMeterValue } from './npc-meters-config.js';
import { stepPull } from '../npc-instincts.js';
import { applyEvents, restMood, restingMood } from '../npc-mood.js';
import { CAST_QUERY, observeKeyAway, observeCast, meterValue, sentence } from './npc-meters-slice.js';

export function createNpcCommands({
    featureOn, normalized, defsFrom, tierCaps, ownOrModule, readerAction, headReply, commandReply,
    identify, ensure, note, changesFrom, setupFor, limitsFor, resolve, settleRecord, run, presentNames,
}) {
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
        let reason = '';
        for (const [label, raw] of Object.entries(isObject(line.labels) ? line.labels : {})) {
            const key = slug(label);
            if (REASON_LABELS.has(key)) { reason ||= clean(raw, 80); continue; }
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
        return run(ctx, { label: line.name, changes, problems, limit: true, reply, at, disposition, allowEmpty: line.op === '+', impact: tierCaps() ? { tier, caps: tierCaps() } : null, story: true, reason });
    }

    // ---- commands (cause ui from Delta itself; capture is the story's) ----

    const milestoneList = value => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value])
        .map(item => clean(isObject(item) ? item.name ?? item.key : item, MILESTONE_MAX)).filter(Boolean)
        .map(name => ({ key: wordKey(name), name })).filter(item => item.key);

    // What the tick reads once for mood and pull (feature mood-pull): who is in the party (party.actors), the place (scene.place),
    // the open threads and who they name (director.threads), who is present. A query that fails or is missing is "no signal" (null, '', []).
    function readWorld(ctx) {
        const ask = (name, args) => { try { return ctx.query(name, args); } catch { return null; } };
        const actors = ask('party.actors', {});
        const place = ask('scene.place', {});
        const rows = ask('director.threads', { open: true });
        const scene = ask('scene.present', {});
        const names = value => String(value ?? '').split(',').map(labelKey).filter(Boolean);
        return {
            party: Array.isArray(actors) ? new Set(actors.map(actor => labelKey(actor?.name)).filter(Boolean)) : null,
            here: typeof place?.name === 'string' ? clean(place.name, 60) : '',
            // Present by the reply's own scene (reply-pinned like every other read here), else the host's present list (the dossiers' own flags).
            present: new Set((Array.isArray(scene) && scene.length ? scene : presentNames()).map(name => labelKey(typeof name === 'string' ? name : name?.name)).filter(Boolean)),
            threads: (Array.isArray(rows) ? rows : []).filter(row => typeof row?.id === 'string' && row.status === 'active').map(row => ({
                id: row.id, title: clean(row.key, 60), names: [labelKey(row.key), ...names(row.fields?.giver), ...names(row.fields?.people)].filter(Boolean),
            })),
        };
    }

    // One record's mood decay and pull for this tick (feature mood-pull). `rawPeople`: Story Director's key people as answered.
    function moodPullStep(record, day, world, rawPeople, minutes) {
        const labels = new Set([record.name, ...(resolve(record.name)?.aliases ?? [])].map(labelKey).filter(Boolean));
        const has = list => list.some(label => labels.has(label));
        const gone = (Array.isArray(rawPeople) ? rawPeople : []).find(person => isObject(person?.away) && !person.removed && has([person.name, ...(Array.isArray(person.aliases) ? person.aliases : [])].map(labelKey)));
        const out = stepPull(record.track, {
            day, party: world.party ? has([...world.party]) : null, here: world.here, present: has([...world.present]),
            awayDay: isInt(gone?.away?.since) ? Math.floor(gone.away.since / DAY_MINUTES) : null,
            threads: world.threads.filter(thread => has(thread.names)),
        });
        if (isObject(record.mood) && isInt(minutes)) record.mood = applyEvents(record.mood, minutes, []);
        const set = (field, value, empty) => { if (empty) delete record[field]; else record[field] = value; };
        set('track', out.track, !Object.keys(out.track).length);
        set('inst', out.inst, !Object.values(out.inst).some(Boolean));
        set('pull', out.pull, !out.pull);
    }

    const commands = {
        /**
         * npc.adjust { name, meters: { meter: ±n }, start?: { meter: n }, reply?: n }: moves meters
         * by the given amounts, with the same range, per-reply and per-NPC clamps as a story line.
         * Delta's own scanner sends its relationship changes this way while hosted (`start`: the
         * values the dossier had before them, for an NPC the slice has no entry for yet; `impact`: the tier the scanner gave the event,
         * which the day's allowance counts like a story line's: one event however many meters it names; none given: not counted). Only
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
            return run(ctx, { label: payload?.name, changes, problems, limit: true, reply: commandReply(ctx, at), at, seed: isObject(payload?.start) ? payload.start : null, yieldToStory: true, scanTier: payload?.impact });
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
            const moodPull = featureOn(FEATURE_MOOD_PULL, ctx);
            let minutes = null;
            if ((drifting.length || moodPull) && typeof ctx.time === 'function') {
                try { minutes = ctx.time(); } catch { minutes = null; }
            }
            const day = isInt(minutes) ? Math.floor(minutes / DAY_MINUTES) : null;
            // Key people (Story Director's `director.keyPeople`, read only): while one is away their meters stay as
            // the reader set them, so no drift and no count toward losing a stage. Without that query: nobody.
            let people = null;
            let rawPeople = null;
            try {
                let calendar = null;
                try { calendar = ctx.query('director.calendar', {}); } catch { calendar = null; }
                rawPeople = ctx.query(KEY_PEOPLE_QUERY, {});
                people = normalizeKeyPeople(rawPeople, minutes => storyMinuteText(minutes, calendar));
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
                // Temperament (feature mood-pull): a person whose pack words give a resting mood starts at it, so it is stored with the record.
                const rest = moodPull && isInt(minutes) && slice.npcs[who.key] ? restingMood(person.entry.personality, person.entry.about) : null;
                if (rest && (rest.v || rest.a || rest.d)) slice.npcs[who.key].mood = restMood(rest, minutes);
                note(slice, ctx.rev, unknown);
            }
            if (castSeen.fresh.length) slice.cast = castSeen.cast;
            const world = moodPull && day !== null ? readWorld(ctx) : null;
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
                if (world) moodPullStep(record, day, world, rawPeople, minutes);
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

    return { captureMilestone, captureLine, commands };
}
