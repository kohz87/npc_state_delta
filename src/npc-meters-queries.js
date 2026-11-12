// Read-only NPC meter queries and screen views. A pure part of npc-meters.js (same owner, moved without change);
// npc-meters.js re-exports every public name it exported before. Never imports npc-meters.js.
import { NPC_DOMAIN, MAX_STAGES_PER_METER, SECRET_TITLE_MAX, NAME_MAX, FEATURE_NOTES, isObject, isInt, isReplyId, sameReply, clean, own, bandWord, needMet, thresholdReached, stageAt, clamp, intOr, readLeaf } from './npc-meters-config.js';
import { initialNpcSlice, findNpcKey, meterValue, rungMet, conflictOn } from './npc-meters-slice.js';
import { readEvent } from './npc-meters-pacing.js';
import { INSTINCT_KEYS } from '../npc-instincts.js';
import { moodBars, moodWord, normalizeMood } from '../npc-mood.js';
import { dossierNotes, NOTE_FIELDS } from './npc-notes-kinds.js';
import { FEATURE_SOCIAL, SOCIAL_QUERY, socialModifier, socialSettings, socialSkill } from './social-check.js';

export function createNpcQueries({
    call, hooks, resolve, presentNames, featureOn, storedSettings, defsFrom, setupFor, rungsFor, limitsFor, identify, rulesFor,
}) {
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
        // The window's own start values and the meters a story line named on that reply (read only; the dossier's net change card).
        ...(isObject(record.turn?.from) ? { window: { from: { ...record.turn.from }, story: Array.isArray(record.turn.story) ? [...record.turn.story] : [] } } : {}),
        // The reply's last event (tier, held, asked, date) only while it is the window's own reply (read only; the card's details).
        ...(isObject(record.turn) && readEvent(record.lastEvent)?.at === record.turn.reply ? { event: readEvent(record.lastEvent) } : {}),
        ...(isObject(record.progress) && Object.keys(record.progress).length ? { progress: { ...record.progress } } : {}),
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

    // The dossier's mood and pull (feature mood-pull; only a record that has them): `mood` { word, valence, energy, control, bars,
    // cause } and `pull` { kind, cause, since, days, level (1..3, the top item's score), inst }. Plain data: the UI escapes the text.
    function moodPullView(record) {
        const mood = normalizeMood(readLeaf(record.mood));
        const [pullRaw, instRaw] = [readLeaf(record.pull), readLeaf(record.inst)];
        const pull = isObject(pullRaw) ? pullRaw : null;
        const inst = isObject(instRaw) ? instRaw : null;
        return {
            ...(mood ? { mood: { word: moodWord(mood), valence: mood.v, energy: mood.a, control: mood.d, bars: moodBars(mood), cause: mood.cause, day: mood.day } } : {}),
            ...(pull ? { pull: { kind: pull.kind, cause: pull.cause, since: pull.since, days: isInt(record.day) ? Math.max(0, record.day - pull.since) : 0, level: inst && isInt(inst[INSTINCT_KEYS[pull.kind]]) ? inst[INSTINCT_KEYS[pull.kind]] : 0, inst: { ...(inst ?? {}) } } } : {}),
        };
    }

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
         * npc.cast() → [{ key, name, present, bars, still, rank?, next?, notesOn?, locked, opened }], present
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
                        ...(record.mood || record.pull ? moodPullView(record) : {}),
                        // Dossier notes (feature notes): lies, knows, tastes, ties map and drives; an uncaught lie and a secret read as hidden rows.
                        ...(featureOn(FEATURE_NOTES) ? { notesOn: true } : {}),
                        ...(featureOn(FEATURE_NOTES) && NOTE_FIELDS.some(field => record[field]) ? { notes: dossierNotes(record) } : {}),
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

    return { sliceOf, entryView, ladderView, notesView, bars, presentKeys, queries };
}
