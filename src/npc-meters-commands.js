// NPC meter story-line capture and hosted commands. A pure part of npc-meters.js (same owner, moved without change);
// npc-meters.js re-exports every public name it exported before. Never imports npc-meters.js.
import { storyMinuteText } from '../calendar.js';
import { isAway, labelKey, labelsOf, normalizeKeyPeople } from './key-people.js';
import { normalizeCast } from './cast-dossier.js';
import { normalizeApproachKind } from '../npc-meters-gate.js';
import { NPC_DOMAIN, FEATURE_GATE, FEATURE_MOOD_PULL, FEATURE_NOTES, MILESTONE_KIND, DAY_MINUTES, MILESTONE_MAX, DISPOSITION_MAX, REASON_LABELS, FEATURE_STAGES, FEATURE_DRIFT, KEY_PEOPLE_QUERY, isObject, isInt, readLeaf, replyKey, clamp, clean, slug, wordKey, tierOf, parseMeterValue } from './npc-meters-config.js';
import { stepPull } from '../npc-instincts.js';
import { growDrives, DRIVE_RULE } from './npc-notes-drives.js';
import { runKind, noteLine, isNoteKind, noteField, driveScale, seedNotes, lookStamp, readLookStamp, CAUGHT_TIER, CAUGHT_DROP } from './npc-notes-kinds.js';
import { applyEvents, restMood, restingMood } from '../npc-mood.js';
import { CAST_QUERY, observeKeyAway, observeCast, meterValue, sentence, asStored } from './npc-meters-slice.js';

export function createNpcCommands({
    featureOn, normalized, defsFrom, tierCaps, ownOrModule, readerAction, headReply, commandReply,
    identify, ensure, note, changesFrom, setupFor, limitsFor, resolve, settleRecord, run, presentNames, clockDay,
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

    // A note line (lie, know, taste, tie; feature notes): the kind's handler works out the new leaf and any trust drop of a caught lie,
    // then ONE run() writes both in the line's own op (so the day's allowance, the mood and a swipe all follow). A refusal writes nothing.
    function captureNote(ctx, line) {
        if (!featureOn(FEATURE_NOTES, ctx)) ctx.fail('FEATURE_OFF', 'Dossier notes are turned off.');
        const labels = Object.fromEntries(Object.entries(isObject(line.labels) ? line.labels : {}).map(([label, raw]) => [slug(label), clean(String(raw ?? ''), 200)]));
        const at = isInt(ctx.carrier?.index) ? ctx.carrier.index : null;
        const reply = replyKey(ctx.carrier?.sid, at);
        const slice = ctx.draft(NPC_DOMAIN);
        const who = identify(isObject(slice.npcs) ? slice.npcs : {}, line.name);
        if (!who) ctx.fail('INVALID', 'The line does not name anyone.');
        const day = clockDay(at);
        const current = (isObject(slice.npcs) && isObject(slice.npcs[who.key]) ? slice.npcs[who.key][noteField(line.kind)] : '') ?? '';
        const changes = [];
        const problems = [];
        const cues = [];
        const notes = { run: change => changes.push(...change.changes), flag: (text, cue) => (cue ? (problems.push(text), cues.push(cue)) : cues.push(text)) };
        const out = runKind(line.kind, current, noteLine(line.kind, labels, { current, r: reply, day }), { name: who.name, day, r: reply, userText: ctx.chat?.lastUser ?? '', tier: CAUGHT_TIER, drop: CAUGHT_DROP, notes });
        if (out.problem) ctx.fail('REFUSED', out.problem);
        const moves = changes.length > 0;
        const done = run(ctx, {
            label: line.name, changes, problems, limit: moves, reply: moves ? reply : null, at: moves ? at : null, allowEmpty: true, story: moves,
            impact: moves && tierCaps() ? { tier: CAUGHT_TIER, caps: tierCaps() } : null, reason: moves ? `caught lying to ${clean(labels.to, 40)}` : '', leaf: { field: out.field, text: out.text },
        });
        return cues.length ? { ...done, summary: sentence(moves ? [...cues, done.summary] : cues), narrate: true } : done;
    }

    function captureLine(ctx, line = {}) {
        if (line.kind === MILESTONE_KIND) return captureMilestone(ctx, line);
        if (isNoteKind(line.kind)) return captureNote(ctx, line);
        const settings = normalized(ctx.settings(), ctx);
        const defs = defsFrom(settings);
        const byLabel = new Map(defs.flatMap(def => [[def.id, def], [slug(def.label), def]]));
        const problems = [];
        const changes = [];
        let disposition;
        let tier = 'ordinary';
        let via = null;
        let reason = '';
        for (const [label, raw] of Object.entries(isObject(line.labels) ? line.labels : {})) {
            const key = slug(label);
            if (REASON_LABELS.has(key)) { reason ||= clean(raw, 80); continue; }
            if (key === 'impact' && !byLabel.has(key)) { tier = tierOf(raw); continue; }
            // The anti-lever approach label (a feature, off: "not a meter" as before); an unknown word is no approach, quietly.
            if (key === 'via' && !byLabel.has(key) && featureOn(FEATURE_GATE, ctx)) { via = normalizeApproachKind(String(raw ?? '').trim().toLowerCase()); continue; }
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
        return run(ctx, { label: line.name, changes, problems, limit: true, reply, at, disposition, via, allowEmpty: line.op === '+', impact: tierCaps() ? { tier, caps: tierCaps() } : null, story: true, reason });
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
    function moodPullStep(ctx, key, record, day, world, rawPeople, minutes) {
        const labels = new Set([record.name, ...(resolve(record.name)?.aliases ?? [])].map(labelKey).filter(Boolean));
        const has = list => list.some(label => labels.has(label));
        const gone = (Array.isArray(rawPeople) ? rawPeople : []).find(person => isObject(person?.away) && !person.removed && has([person.name, ...(Array.isArray(person.aliases) ? person.aliases : [])].map(labelKey)));
        const out = stepPull(readLeaf(record.track), {
            day, party: world.party ? has([...world.party]) : null, here: world.here, present: has([...world.present]),
            awayDay: isInt(gone?.away?.since) ? Math.floor(gone.away.since / DAY_MINUTES) : null,
            threads: world.threads.filter(thread => has(thread.names)),
            // Drives (notes feature): the person's instinct strengths scale what pulls at them; none stored: the scores as they are.
            scale: featureOn(FEATURE_NOTES) && record.drives ? driveScale(record.drives) : undefined,
        });
        const mood = readLeaf(record.mood);
        if (isObject(mood) && isInt(minutes)) record.mood = asStored(ctx, key, 'mood', applyEvents(mood, minutes, []));
        const set = (field, value, empty) => { if (empty) delete record[field]; else record[field] = asStored(ctx, key, field, value); };
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
         * npc.flag { name, text?, cue?, lock?: true, reply? }: Delta's own scan tells the slice about a person's look (feature notes): `lock` stamps the
         * day and reply the first durable look was set (kept once), `text` is a Problem line (the same text is not written twice in a row) and `cue`
         * the one-reply words the story is told (narrate). Only Delta's own scan or another module's command may send it.
         */
        'npc.flag'(ctx, payload = {}) {
            if (!ownOrModule(ctx, 'npc.flag', payload)) ctx.fail('REFUSED', 'A look flag comes only from NPC State Delta\'s own scan.');
            if (!featureOn(FEATURE_NOTES, ctx)) ctx.fail('FEATURE_OFF', 'Dossier notes are turned off.');
            const at = isInt(payload?.reply) && payload.reply >= 0 ? payload.reply : null;
            const slice = ctx.read(NPC_DOMAIN);
            const who = identify(slice?.npcs ?? {}, payload?.name);
            const have = who ? slice?.npcs?.[who.key] : null;
            const text = clean(payload?.text, 200);
            const cue = clean(payload?.cue, 240);
            const stamp = payload?.lock === true && !readLookStamp(have?.lookLockedAt) ? lookStamp(clockDay(at), commandReply(ctx, at)) : null;
            const fresh = text && !(Array.isArray(slice?.problems) && slice.problems.some(item => item?.text === text));
            if (!fresh && !stamp) ctx.fail('REFUSED', 'Nothing to flag.');
            const done = run(ctx, { label: payload?.name, changes: [], problems: fresh ? [text] : [], limit: false, reply: null, allowEmpty: true, leaf: stamp ? { field: 'lookLockedAt', text: stamp } : null });
            return cue ? { ...done, summary: sentence([cue]), narrate: true } : done;
        },
        /**
         * npc.meet { name, personality?, about?, reply? }: Delta's own scan admitted a person the slice has no record for (or one with no mood
         * and drives yet). They get an entry the way a cast meeting gives one: the dossier's numbers as the first meters, a resting
         * mood from their temperament (feature mood-pull) and their drives (feature notes). Recorded on the reply like any change, so a
         * swipe takes it back; chats that never send it replay unchanged. Refused when there is nothing to add.
         */
        'npc.meet'(ctx, payload = {}) {
            if (!ownOrModule(ctx, 'npc.meet', payload)) ctx.fail('REFUSED', 'A meeting is noted only by NPC State Delta\'s own scan.');
            const have = ctx.read(NPC_DOMAIN);
            const named = identify(have?.npcs ?? {}, payload?.name);
            if (!named) ctx.fail('INVALID', 'It names no one.');
            const before = have?.npcs?.[named.key];
            const needsMood = featureOn(FEATURE_MOOD_PULL, ctx) && !(before && before.mood);
            const needsDrives = featureOn(FEATURE_NOTES, ctx) && !(before && before.drives);
            if (before && !needsMood && !needsDrives) ctx.fail('REFUSED', 'Nothing to update.');
            // `reply`: the reply the scan read (as npc.adjust's), so a scan of an older reply does not record the meeting on the head.
            const at = isInt(payload?.reply) && payload.reply >= 0 ? payload.reply : null;
            const out = run(ctx, { label: payload.name, changes: [], problems: [], limit: false, reply: commandReply(ctx, at), at, allowEmpty: true });
            const record = ctx.draft(NPC_DOMAIN).npcs?.[named.key];
            if (!record) return out;
            let minutes = null;
            try { minutes = ctx.time(); } catch { minutes = null; }
            if (needsMood && isInt(minutes)) {
                const rest = restingMood(payload?.personality, payload?.about);
                // Always stored, even at 0/0/0: a person with no temperament words still has a mood (and so a decay and pull) like a cast meeting's.
                record.mood = restMood(rest, minutes);
            }
            if (needsDrives) Object.assign(record, seedNotes({ personality: payload?.personality, about: payload?.about }));
            return out;
        },
        /**
         * npc.drives { name, texts: [plain strings], reply, rule }: what Delta's scan newly recorded for one person (new memories, behavior and
         * mannerism lines, the relationship reason), read for drive cues (npc-notes-drives.js growDrives, rule 1: a drive steps one level when
         * its cues show in 2 different replies since its last change). The leaf is written whole on the reply, so a swipe, a delete, a Re-read
         * and a rebuild give the drives live had. Only rule 1 is understood, so a reply that never carried it replays as it was.
         */
        'npc.drives'(ctx, payload = {}) {
            if (!ownOrModule(ctx, 'npc.drives', payload)) ctx.fail('REFUSED', 'Drive growth is noted only by NPC State Delta\'s own scan.');
            if (!featureOn(FEATURE_NOTES, ctx)) ctx.fail('FEATURE_OFF', 'Dossier notes are turned off.');
            if (payload?.rule !== DRIVE_RULE) ctx.fail('INVALID', 'It names no drive rule this version knows.');
            const slice = ctx.read(NPC_DOMAIN);
            const who = identify(slice?.npcs ?? {}, payload?.name);
            const have = who ? slice?.npcs?.[who.key] : null;
            if (!have) ctx.fail('REFUSED', 'No one by that name has an entry.');
            const at = isInt(payload?.reply) && payload.reply >= 0 ? payload.reply : headReply();
            const texts = (Array.isArray(payload?.texts) ? payload.texts : []).map(item => clean(item, 200)).filter(Boolean).slice(0, 12);
            const grown = growDrives(have.drives, texts, commandReply(ctx, at));
            if (!grown) ctx.fail('REFUSED', 'Nothing to update.');
            const moved = grown.steps.map(step => `${step.label} ${step.to > step.from ? 'grew' : 'eased'} (${step.cue})`);
            const done = run(ctx, { label: payload.name, changes: [], problems: [], limit: false, reply: null, allowEmpty: true, leaf: { field: 'drives', text: grown.leaf } });
            return moved.length ? { ...done, summary: sentence([`${have.name}: ${moved.join(', ')}`]) } : done;
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
                if (rest && (rest.v || rest.a || rest.d)) slice.npcs[who.key].mood = asStored(ctx, who.key, 'mood', restMood(rest, minutes));
                // Notes (feature notes): the pack's tastes and drives are the person's first, kept in the record's leaves.
                if (slice.npcs[who.key] && featureOn(FEATURE_NOTES, ctx)) Object.assign(slice.npcs[who.key], seedNotes(person.entry));
                note(slice, ctx.rev, unknown);
            }
            if (castSeen.fresh.length) slice.cast = castSeen.cast;
            // The world (four reads) is read once for this tick, and only when a person's record is there to use it.
            let world = null;
            const worldNow = () => { if (!world) world = readWorld(ctx); return world; };
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
                if (moodPull && day !== null) moodPullStep(ctx, key, record, day, worldNow(), rawPeople, minutes);
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
