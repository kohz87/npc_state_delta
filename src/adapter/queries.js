// The adapter's read-only side (src/storysuite-v2.js): Delta's npc.* queries, the npc slice the host holds (src/npc-meters.js) and
// the lookups every other part of the adapter uses (Delta's runtime, its NPC list and dossiers, the host's features), the answers
// Story Director gives about key people and the cast, and the commands Delta sends to the host.
//
// A part of the adapter closure: createQueriesPart(session, deps) gets the adapter's shared state (session) and the adapter's options,
// constants and the parts built before it (deps), and returns what the other parts and the adapter use. Pure apart from the DOM it
// is given: no SillyTavern import.

import { normalizeRelationshipMilestones, normalizeRelationshipProgress } from '../../core-relationship-model.js';
import { resolveDossierTarget } from '../../suite-handshake.js';
import { FEATURE_SOCIAL, SOCIAL_QUERY, createNpcPart, normalizeSecrets } from '../npc-meters.js';
import { normalizeLimits, presetCatalog } from '../npc-meters-presets.js';
import { RELATIONSHIP_KEYS, dossierFields, portraitUrl } from './queries-dossier.js';
import { storyMinuteText } from '../../calendar.js';
import { createDirectorQueriesPart } from './queries-director.js';

export { dossierFields, safeImageUrl, portraitUrl } from './queries-dossier.js';

export function createQueriesPart(session, deps) {
    const {
        calendarOwn, delta, doc, headReply, host, KEY_PIN_COMMAND, logger, MODULE_ID, panelId, PRESET_KIND, suiteApi, timeline, WORLD_FEATURE,
    } = deps;

    // Delta's own commands on their way to the host, by type and payload: npc.adjust takes a reader's
    // action at the top only when it is one of these (the scanner's), never a button that names it.
    const ownSends = new Map();
    const sendKey = (type, payload) => {
        try { return `${type}\n${JSON.stringify(payload)}`; } catch { return null; }
    };

    const warn = (message, error) => {
        try { logger?.warn?.(`[NPC State Delta] ${message}`, error); } catch { /* logging only */ }
    };
    const runtime = () => {
        try { return delta?.() || null; } catch { return null; }
    };
    const enabled = () => runtime()?.isEnabled?.() !== false;
    const panel = () => {
        try { return doc?.getElementById?.(panelId) || null; } catch { return null; }
    };

    // ---- queries (read-only; fresh plain copies; empty while Delta is off or still loading) ----

    const npcList = () => {
        if (!enabled()) return [];
        try {
            const list = suiteApi?.npcs?.();
            return Array.isArray(list) ? list.filter(npc => npc && typeof npc === 'object') : [];
        } catch (error) {
            warn('Story Suite v2 query failed', error);
            return [];
        }
    };
    const names = list => list.map(npc => String(npc.name ?? '').trim()).filter(Boolean);
    const presentList = () => npcList().filter(npc => npc.present === true && npc.archived !== true);
    // Delta's own record for a name, alias or id (as npc.dossier finds it), or null.
    const dossierOf = name => {
        const id = resolveDossierTarget(npcList(), name);
        if (!id) return null;
        const npc = runtime()?.getNpc?.(id);
        return npc && typeof npc === 'object' ? npc : null;
    };
    const storedSettings = () => {
        try { return session.sdkRef?.settings?.(MODULE_ID) ?? {}; } catch { return {}; }
    };

    // ---- the npc slice (src/npc-meters.js) ----

    // A feature's switch from the host (MODULES §F100), or undefined when the host has no Features
    // API yet (the part then uses the feature's default).
    const hostFeature = id => {
        try {
            if (typeof session.sdkRef?.feature === 'function') return session.sdkRef.feature(id);
            if (typeof session.sdkRef?.features?.isOn === 'function') return session.sdkRef.features.isOn(id);
        } catch { /* the default */ }
        return undefined;
    };
    // The presets the reader may use: the built-in ones and the enabled packs' `meterPresets`.
    const catalog = () => {
        let records = [];
        if (session.hosted && typeof session.sdkRef?.query === 'function') {
            try {
                const list = session.sdkRef.query('packs.content', { kind: PRESET_KIND });
                records = Array.isArray(list) ? list : [];
            } catch { records = []; }
        }
        return presetCatalog(records);
    };
    // One dossier's meter setup (the editor's): { track, limits }.
    const setupOf = npc => {
        const setup = npc?.meterSetup && typeof npc.meterSetup === 'object' ? npc.meterSetup : {};
        return { track: typeof setup.track === 'string' ? setup.track : '', limits: normalizeLimits(setup.limits) };
    };
    // The same for the stage logic: a person made from the cast also brings their own stages (castFrom.stages), which the
    // editor's setup never holds (so saving the editor cannot lose them).
    const stageSetupOf = npc => ({ ...setupOf(npc), ladder: Array.isArray(npc?.castFrom?.stages) ? npc.castFrom.stages : [] });

    const part = createNpcPart({
        resolve: name => {
            const npc = dossierOf(name);
            return npc ? { name: npc.name, aliases: Array.isArray(npc.aliases) ? npc.aliases : [], relationship: npc.relationship } : null;
        },
        baseline: () => runtime()?.relationshipBaseline?.() ?? {},
        caps: () => runtime()?.relationshipCaps?.() ?? null,
        allowance: () => runtime()?.relationshipAllowance?.() ?? null,
        calendarOwn: () => { try { return calendarOwn?.() === true; } catch { return false; } },
        // The day belongs to the state before this reply, even if its own time line ran first.
        startTime: index => {
            if (!Number.isInteger(index) || index < 1) return null;
            try {
                const time = session.sdkRef?.query?.('director.time', { asOf: index - 1 });
                return Number.isInteger(time) ? time : time?.minutes ?? null;
            } catch { return null; }
        },
        startDate: index => {
            if (!Number.isInteger(index) || index < 1) return '';
            try {
                const time = session.sdkRef?.query?.('director.time', { asOf: index - 1 });
                const minutes = Number.isInteger(time) ? time : time?.minutes;
                return Number.isInteger(minutes) ? storyMinuteText(minutes, director.directorCalendar()) : '';
            } catch { return ''; }
        },
        // Only the rules (and the titles screens show while locked) leave the dossier for the
        // handlers and screens; the texts go to the tail and to an unlocked note's screen line alone.
        secretRules: (name, labels = []) => {
            const npc = dossierOf(name) ?? labels.map(dossierOf).find(Boolean);
            return normalizeSecrets(npc?.secrets).map(({ id, meter, at, when, title }) => ({ id, ...(meter ? { meter, at } : {}), ...(when ? { when } : {}), ...(title ? { title } : {}) }));
        },
        secretTexts: (name, ids = []) => {
            const npc = dossierOf(name);
            return normalizeSecrets(npc?.secrets).filter(secret => ids.includes(secret.id)).map(({ id, text }) => ({ id, text }));
        },
        setup: (name, labels = []) => stageSetupOf(dossierOf(name) ?? labels.map(dossierOf).find(Boolean)),
        presets: catalog,
        feature: hostFeature,
        present: () => names(presentList()),
        settings: storedSettings,
        ownCommand: (type, payload) => (ownSends.get(sendKey(type, payload)) ?? 0) > 0,
        headReply: () => headReply?.(),
    });
    // The slice entries at the head, by key (null when the host cannot answer).
    const sliceEntries = () => {
        if (!session.hosted || typeof session.sdkRef?.query !== 'function') return null;
        try {
            const list = session.sdkRef.query('npc.meters', {});
            return Array.isArray(list) ? list : null;
        } catch {
            return null;
        }
    };
    const entryFor = (entries, npc) => {
        if (!entries?.length || !npc) return null;
        const byKey = Object.fromEntries(entries.map(entry => [entry.key, entry]));
        const who = part.identify(byKey, npc.name);
        return who && Object.hasOwn(byKey, who.key) ? byKey[who.key] : null;
    };
    // The built-in meters of a slice entry as Delta's `relationship`.
    const relationshipOf = (entry, fallback = {}) => Object.fromEntries(RELATIONSHIP_KEYS.map(key => [key, Number.isInteger(entry?.meters?.[key]) ? entry.meters[key] : (Number(fallback?.[key]) || 0)]));

    // What the host's ss.meter widget takes. Story Block's view work adds `ceiling`, `ticks` and
    // `delta`; a host that lists its widgets' props says whether it has them (null: it does not say,
    // and the props are passed as they are: ss.meter reads only the props it knows).
    const meterProps = () => {
        try {
            const widgets = typeof session.sdkRef?.widgets === 'function' ? session.sdkRef.widgets() : host()?.widgets;
            const props = widgets?.['ss.meter']?.props;
            return props && typeof props === 'object' ? new Set(Object.keys(props)) : null;
        } catch {
            return null;
        }
    };
    // npc.cast for a host whose ss.meter has no ceiling or delta yet: they go into the bar's text.
    const castFor = (state, args) => {
        const list = part.queries['npc.cast'](state, args ?? {});
        const props = meterProps();
        if (!props || ['ceiling', 'ticks', 'delta'].every(prop => props.has(prop))) return list;
        const fold = bar => {
            const out = { ...bar };
            if (!props.has('ceiling')) {
                if (Number.isInteger(out.ceiling)) out.text = `${out.text} · max ${out.ceiling}`;
                delete out.ceiling;
                delete out.floor;
            }
            if (!props.has('ticks')) delete out.ticks;
            if (!props.has('delta')) {
                if (Number.isInteger(out.delta) && out.delta) out.text = `${out.text} ${out.delta > 0 ? '▲' : '▼'}${Math.abs(out.delta)}`;
                delete out.delta;
            }
            return out;
        };
        return list.map(entry => ({ ...entry, bars: entry.bars.map(fold), still: entry.still.map(fold) }));
    };

    const queries = Object.freeze({
        /**
         * Names of the NPCs present in the current scene, in dossier order. With { meters: true },
         * [{ name, meters, stages }] instead (the slice's values; null meters for someone it has no entry for).
         */
        'npc.present': (state, args) => {
            const list = presentList();
            if (args?.meters !== true) return names(list);
            return list.map(npc => {
                const entry = part.queries['npc.meters'](state, { name: npc.name });
                return { name: String(npc.name ?? '').trim(), meters: entry?.meters ?? null, stages: entry?.stages ?? {} };
            }).filter(item => item.name);
        },
        /** Names of every tracked (not archived) NPC, in dossier order. */
        'npc.known': () => names(npcList().filter(npc => npc.archived !== true)),
        /**
         * One NPC's dossier fields by name, alias or id (case-insensitive, exact), or null. While the
         * slice has an entry for them, `relationship` is the slice's and `meters`, `stages` and
         * `unlocked` (note ids) are added. Hidden notes are never part of it.
         */
        'npc.dossier': (state, args) => {
            try {
                // A native dependency uses the stable np_ identity, including a terminal-death dossier
                // archived from the ordinary cast. Name-based browsing keeps its existing visibility rule.
                const byId = args?.id !== undefined;
                const identity = byId ? timeline.queries['npc.identity'](state, { id: args.id }) : null;
                const npc = byId ? (identity && runtime()?.getNpc?.(identity.nativeKey)) : dossierOf(args?.name);
                if (!npc) return null;
                const names = runtime()?.customFieldNames?.();
                const out = dossierFields(npc, { customFieldNames: Array.isArray(names) ? names : undefined });
                const entry = part.queries['npc.meters'](state, { name: npc.name });
                if (entry) {
                    out.relationship = relationshipOf(entry, out.relationship);
                    out.meters = entry.meters;
                    out.stages = entry.stages;
                    out.unlocked = entry.unlocked;
                }
                return out;
            } catch (error) {
                warn('Story Suite v2 dossier query failed', error);
                return null;
            }
        },
        /** One NPC's portrait URL by name, alias or id (as npc.dossier finds them), or null (§F11). */
        'npc.portrait': (state, args) => {
            try {
                const id = resolveDossierTarget(npcList(), args?.name);
                if (!id) return null;
                const api = runtime();
                const npc = api?.getNpc?.(id);
                if (!npc) return null;
                let forms = {};
                try { forms = api?.formPortraits?.(id) || {}; } catch { forms = {}; }
                return portraitUrl(npc, forms);
            } catch (error) {
                warn('Story Suite v2 portrait query failed', error);
                return null;
            }
        },
        /** npc.meters({ name }) → { key, name, meters, stages, unlocked, … } | null; no name: every entry. */
        'npc.meters': (state, args) => part.queries['npc.meters'](state, args ?? {}),
        /** npc.cast() → the slice's NPCs with their bars, ladder line and locked-note teasers, present first (the NPC card). */
        'npc.cast': (state, args) => castFor(state, args),
        /** npc.next({ name }) → the NPC's ladder from here: { rank, next, risk, text } ("what's missing"), or null. */
        'npc.next': (state, args) => part.queries['npc.next'](state, args ?? {}),
        /** npc.keyAway() → the memory of key people's last absences (the slice's `keyAway`: { [name key]: { name, aliases, away, returnedAt, presentReplies } }), {} when none. */
        'npc.keyAway': (state, args) => part.queries['npc.keyAway'](state, args ?? {}),
        /** npc.castMade() → the people Delta made a dossier for from the cast (the slice's `cast`: { [castKey]: { name, rungs? } }), {} when none. */
        'npc.castMade': (state, args) => part.queries['npc.castMade'](state, args ?? {}),
        /**
         * npc.socialModifier({ name, skill }) → { mod, name, skill, reasons: [{ text, value }] } | null:
         * what an NPC's meters, stage and disposition do to a social check against them (src/social-check.js).
         * Null while Delta is off, for a skill that is not social, an unknown name, or the feature off
         * (the host answers null itself then). Reads the state it is given; never calls the model.
         */
        [SOCIAL_QUERY]: Object.assign((state, args) => {
            if (!enabled()) return null;
            try {
                return part.queries[SOCIAL_QUERY](state, args ?? {});
            } catch (error) {
                warn('Story Suite v2 social check query failed', error);
                return null;
            }
        }, { feature: FEATURE_SOCIAL }),
    });

    const director = createDirectorQueriesPart(session, deps, { hostFeature });

    // ---- what index.js asks while hosted (each a no-op answer without a host) ----

    // A command to the host as Delta's own action (cause ui; the host keeps other causes for itself).
    // `own`: the command is one npc.adjust takes only from Delta itself (ownSends, while it runs).
    // `background`: a change Delta's own scan makes on its own (not the reader's action): Story Block saves it in its late window, one
    // write for a burst instead of one per command. A Story Block that does not know the option ignores it and saves as before.
    async function send(type, payload, { own = false, background = false } = {}) {
        if (!session.hosted || typeof session.sdkRef?.command !== 'function') return null;
        const key = own ? sendKey(type, payload) : null;
        if (key) ownSends.set(key, (ownSends.get(key) ?? 0) + 1);
        try {
            const out = background ? await session.sdkRef.command(type, payload, { background: true }) : await session.sdkRef.command(type, payload);
            if (out && out.ok === false && out.code !== 'REFUSED' && out.code !== 'NOT_FOUND') warn(`Story Suite v2 ${type} was not kept: ${out.message ?? out.code}`);
            return out ?? null;
        } catch (error) {
            warn(`Story Suite v2 ${type} failed`, error);
            return null;
        } finally {
            if (key) {
                const left = (ownSends.get(key) ?? 1) - 1;
                if (left > 0) ownSends.set(key, left);
                else ownSends.delete(key);
            }
        }
    }

    /**
     * `npcs` (Delta's records) with each one's relationship read from the v2 slice where the slice has an entry: the four numbers,
     * the part-points, and the earned milestones that still hold at those numbers (the scorer infers the rest from the numbers).
     * The same array when not hosted or when nothing differs. Read time only: `npcs` is never changed and nothing is written back,
     * so whatever the sidecar holds for these is not read while hosted (a person with no entry yet keeps their own record).
     */
    function sliceView(npcs) {
        if (!Array.isArray(npcs) || !session.hosted) return npcs;
        const entries = sliceEntries();
        if (!entries?.length) return npcs;
        let changed = false;
        const out = npcs.map(npc => {
            const entry = npc && typeof npc === 'object' ? entryFor(entries, npc) : null;
            if (!entry) return npc;
            const relationship = relationshipOf(entry, npc.relationship);
            const holds = item => item.inferred !== true && Math.sign(relationship[item.axis]) === item.polarity && Math.abs(relationship[item.axis]) > item.threshold;
            const next = {
                relationship, relationshipProgress: normalizeRelationshipProgress(entry.progress),
                relationshipMilestones: normalizeRelationshipMilestones(npc.relationshipMilestones, relationship, { inferFromRelationship: false }).filter(holds),
            };
            if (Object.keys(next).every(key => JSON.stringify(npc[key]) === JSON.stringify(next[key]))) return npc;
            changed = true;
            return { ...npc, ...next };
        });
        return changed ? out : npcs;
    }

    return {
        warn, runtime, enabled, panel, npcList, presentList, dossierOf, storedSettings, catalog, setupOf, part, sliceEntries,
        entryFor, queries, ...director, send, sliceView,
    };
}
