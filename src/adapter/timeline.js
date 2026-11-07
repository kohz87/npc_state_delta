// The module definition and the timeline (src/storysuite-v2.js): the Story Block restore participant, the module definition Delta
// registers with a v2 host (queries, capture, context, settings, screens, tabs), the story clock and calendar link, what Delta sends
// under its own prompt keys, the diagnostics lines, the host events that redraw Delta's views, Delta's card settings and its public paths.
//
// A part of the adapter closure: createTimelinePart(session, deps) gets the adapter's shared state (session) and the adapter's options,
// constants and the parts built before it (deps), and returns what the other parts and the adapter use. No SillyTavern import.

import { resolveDossierTarget } from '../../suite-handshake.js';
import { FEATURE_STAGES, MILESTONE_KIND, NPC_KIND } from '../npc-meters.js';
import { metersCardScreen } from '../npc-meters-screen.js';
import { createPublicPathsDefinition } from '../public-paths.js';
import { createParticipant, fileVault } from '../storysuite-participant/index.js';
import { createStorageRow, REFERENCED_QUERY } from '../storysuite-participant/storage-row.js';

const EVENTS = Object.freeze({
    settingsMounted: 'npc-state-delta:settings-mounted',
    castRendered: 'npc-state-delta:cast-rendered',
    enabledChanged: 'npc-state-delta:enabled-changed',
});

export function createTimelinePart(session, deps) {
    const {
        calendarOwn, CAST_TAB_ID, CAST_WIDGET, castScreen, castStillShown, castWidget, doc, DOSSIERS_ICON, DOSSIERS_TITLE,
        enabled, HOSTED_FLAG, MODULE_ID, MODULE_NAME, mountSection, notifyChange, npcList, part, participantOptions,
        participantVault, presetsBlock, queries, redrawCastViews, renderDossiers, runtime, settleMs, settlePollMs,
        storedSettings, suiteApi, syncDrawer, V2_HOST_EVENT, version, warn,
    } = deps;

    let listening = false;

    // ---- Diagnostics (Story Block's Settings → Diagnostics) ----

    function diagnosticsLines() {
        const api = runtime();
        if (typeof api?.scannerReport !== 'function') return ['NPC State Delta is still loading (no scanner report yet).'];
        const lines = [...api.scannerReport()];
        try {
            const npcs = suiteApi?.npcs?.() ?? [];
            if (Array.isArray(npcs)) lines.push(`Dossiers in this chat: ${npcs.filter(npc => !npc?.archived).length} active, ${npcs.filter(npc => npc?.archived).length} archived, ${npcs.filter(npc => npc?.present).length} present.`);
        } catch { /* the counts are optional */ }
        lines.push(`Hosted in Story Block: ${session.hosted ? 'yes' : 'no'}. Settings panel in the overlay: ${session.mounted ? 'yes' : 'no'}.`);
        return lines;
    }

    // ---- what Delta sends on its own (Story Block's prompt size; its `ownPrompt` hook, SPEC §5) ----

    // Delta's live dossier and, with one-pass capture on, its instruction go out under Delta's own prompt
    // keys, so the host counts them toward its share of the context and shows them in its prompt size and
    // "Show what's sent". The same texts Delta's own What's sent shows (index.js nextReplyTexts); nothing
    // is built twice for the prompt and nothing here changes what is sent.
    function ownPrompt() {
        if (!enabled()) return [];
        let preview = null;
        try { preview = suiteApi?.manage?.preview?.(); } catch { return []; }
        const parts = Array.isArray(preview?.parts) ? preview.parts : [];
        return parts
            .filter(item => typeof item?.text === 'string' && item.text)
            .map(item => ({ label: String(item.label ?? MODULE_NAME), text: item.text }));
    }

    // ---- the story's date (Story Director's clock, read only) ----

    // Story Director's `director.time` minutes and `director.calendar` config while hosted, or null: no
    // host, no Story Director (the queries are unknown), its clock not set yet, or the reader keeps the
    // calendar in Delta (`calendarOwn`). calendar.js turns it
    // into a date on Delta's own calendar (storyClockDate) when the two calendars agree.
    function storyClock() {
        if (!session.hosted || typeof session.sdkRef?.query !== 'function') return null;
        try { if (calendarOwn?.() === true) return null; } catch { return null; }
        let time = null;
        let calendar = null;
        try {
            time = session.sdkRef.query('director.time', {});
            if (!Number.isSafeInteger(time?.minutes)) return null;
            calendar = session.sdkRef.query('director.calendar', {});
        } catch {
            return null;
        }
        if (!calendar || typeof calendar !== 'object' || !Array.isArray(calendar.months)) return null;
        const months = calendar.months.map(month => ({ name: String(month?.name ?? ''), days: Number(month?.days) }));
        return { minutes: time.minutes, calendar: { era: String(calendar.era ?? ''), months, leapYears: calendar.leapYears === true } };
    }

    // Whether Delta's calendar settings matter: Story Director's calendar answers (`director.calendar`) and the reader has
    // not kept the calendar in Delta, or neither. Read only; the settings panel's Expert note follows it.
    function calendarLink() {
        if (!session.hosted || typeof session.sdkRef?.query !== 'function') return 'none';
        try { if (calendarOwn?.() === true) return 'own'; } catch { return 'none'; }
        try {
            const calendar = session.sdkRef.query('director.calendar', {});
            return calendar && typeof calendar === 'object' && Array.isArray(calendar.months) ? 'story-director' : 'none';
        } catch {
            return 'none';
        }
    }

    // ---- the module definition ----

    // The timeline participant (Story Block docs/v2/TIMELINE.md, contract §8): Delta's native state takes part in save points and restores, and
    // `npc.identity` names a person by an np_ id. It needs Delta's runtime for the open chat's key, its state and an absolute install. Nothing of it
    // runs for a chat until the chat uses the timeline or asks `npc.identity` (participant.js `started`): registering, opening a chat, a reply or a
    // scan hydrate nothing, write nothing and publish nothing.
    //
    // Which of the chat's messages the story stands on: Story Block's one active-history filter, `sdk.timeline.history()`, one entry per message of the
    // chat as it stands when asked (`active: false` for a faded one). Delta asks before it builds any prompt from the chat (src/transcript.js), and
    // after a restore the host hides the faded replies with SillyTavern's own flag as well. Never cached here: a delete or a swipe moves the indexes.
    const activeMessages = async () => {
        try {
            const history = await session.sdkRef?.timeline?.history?.();
            return history?.ok === true && Array.isArray(history.messages) ? history.messages.map(message => message?.active !== false) : null;
        } catch { return null; }
    };
    // Story Block's head-selection barrier (docs/v2/TIMELINE.md, HISTORY.md): after a delete, a swipe or a retraction the host raises its barrier and
    // asks every participant to stand on the checkpoint of the selected head (`prepare`, `activate`: the callbacks of the participant below), and lowers
    // it only when they do. Nothing here selects a head. `head()` is the host's own look at it (it raises the barrier when a selection is needed and
    // answers RESTORE_PENDING while it is up), so Delta asks it before it reads or writes the dossiers and waits for it. true once the barrier is
    // down (or when the host has no such barrier), false if it is still up after `settleMs`.
    //
    // The wait is bounded by `settleMs`, and ends at once when the host says the block is permanent: a refused head carries `blockedBy`
    // ({ module, code }, Story Block's answer from the version that classifies it); FAILED and STALE are the transient codes the host tries again
    // itself, any other code (SNAPSHOT_UNAVAILABLE, CONFLICT, ...) will not clear by waiting. A host that gives no `blockedBy` is waited for in full.
    // `wait: false` is one look, no waiting (the second look of a send that already waited).
    const TRANSIENT_BLOCKS = new Set(['FAILED', 'STALE']);
    const permanentBlock = answer => {
        const code = answer?.blockedBy?.code;
        return typeof code === 'string' && code !== '' && !TRANSIENT_BLOCKS.has(code);
    };
    const headSettled = async ({ wait = true } = {}) => {
        const head = session.sdkRef?.timeline?.head;
        if (typeof head !== 'function') return true;
        const until = Date.now() + settleMs;
        for (;;) {
            let answer = null;
            try { answer = await session.sdkRef.timeline.head({}); } catch { return true; }
            if (answer?.ok !== false || answer.code !== 'RESTORE_PENDING') return true;
            if (!wait || permanentBlock(answer) || Date.now() >= until) return false;
            await new Promise(resolve => { const timer = setTimeout(resolve, settlePollMs); timer?.unref?.(); });
        }
    };
    const messageGate = Object.freeze({ refresh: activeMessages, settled: headSettled });
    let offNativeChange = null;
    const vault = participantVault ?? fileVault({ headers: () => runtime()?.requestHeaders?.() ?? {} });
    // The Storage row of the settings panel (clean-up of old dossier files; report and confirmed removal only). Hosted only: Story Block answers
    // which checkpoint files every chat uses.
    const storageRow = createStorageRow({
        doc, vault, warn,
        // The participant's own exclusive queue (checkpoint writes run in it); `timeline` is made just below, before any click can happen.
        exclusive: fn => timeline.exclusive(fn),
        ask: async () => session.sdkRef.query(REFERENCED_QUERY, {}),
        live: () => { try { return runtime()?.getState?.() ?? null; } catch { return null; } },
    });
    const timeline = createParticipant({
        port: {
            chatKey: () => String(runtime()?.chatKey?.() ?? ''),
            readState: () => runtime()?.getState?.() ?? { npcs: [] },
            started: () => runtime()?.timelineStarted?.() === true,
            // Whether Delta has loaded the open chat's state, and its load: the participant reads nothing before it (a reload's recovery comes early).
            ready: () => runtime()?.stateReady?.() === true,
            // Delta tried to load the chat's state and could not: waiting for it would only hold the host's callback.
            // Whether a load of the chat's state is running now (an answered load with nothing running will not make the state ready by itself).
            loading: () => runtime()?.stateLoading?.() === true,
            loadFailed: () => runtime()?.stateFailed?.() === true,
            load: () => runtime()?.ensureFresh?.(),
            // The state as Delta keeps it once installed (the participant's look after an install compares it so).
            normalize: state => (typeof runtime()?.normalizeState === 'function' ? runtime().normalizeState(state) : state),
            // A branch waiting for its parent's dossiers is left to Delta's branch inheritance (asked to run now) before a line is minted.
            branchPending: () => runtime()?.branchPending?.() === true,
            inheritBranch: () => runtime()?.inheritBranch?.(),
            installState: state => runtime().installState(state),
            writeTimeline: block => runtime().writeTimeline(block),
            busy: () => runtime()?.scanActive?.() === true,
            idle: ms => (typeof runtime()?.scanIdle === 'function' ? runtime().scanIdle(ms) : Promise.resolve(true)),
            // The host installed an earlier checkpoint (its selection fell back): the replies after it are read by Delta's own catch-up.
            restored: () => { runtime()?.catchUpAfterRestore?.(); },
            warn: text => warn(text),
        },
        vault,
        ...participantOptions,
    });
    function startTimeline() {
        const api = runtime();
        offNativeChange?.();
        offNativeChange = typeof api?.onNativeChange === 'function' ? api.onNativeChange(() => timeline.noteChange()) : null;
        try { api?.useMessageGate?.(messageGate); } catch { /* an older runtime */ }
    }
    function stopTimeline() {
        try { offNativeChange?.(); } catch { /* gone */ }
        offNativeChange = null;
        try { runtime()?.useMessageGate?.(null); } catch { /* gone */ }
        storageRow.unmount();
    }
    const definition = Object.freeze({
        id: MODULE_ID,
        name: MODULE_NAME,
        version: String(version),
        // Story Block 2.23.0 or later: its feature `presets` key, the folds and the one "This reply" card this
        // release is built for. An older Story Block 2 refuses the hosted module and Delta keeps working on its own.
        requires: Object.freeze({ storyBlock: '>=2.23.0' }),
        // The optional mechanics (MODULES §F100); a host without the Features API warns and ignores.
        features: part.features,
        domains: part.domains,
        commands: Object.freeze({
            ...part.commands,
            'npc.milestone': Object.freeze({ handler: part.commands['npc.milestone'], feature: FEATURE_STAGES }),
        }),
        queries: Object.freeze({ ...queries, ...timeline.queries }),
        participant: timeline.participant,
        capture: {
            kinds: {
                [NPC_KIND]: { grammar: part.kinds[NPC_KIND].grammar },
                [MILESTONE_KIND]: { grammar: part.kinds[MILESTONE_KIND].grammar, feature: FEATURE_STAGES },
            },
            apply: (ctx, line) => part.kinds[NPC_KIND].apply(ctx, line),
        },
        context: {
            // Nothing about meters while Delta is off; otherwise the same line until the settings change.
            static: () => (enabled() ? part.context.static() : ''),
            tail: view => (enabled() ? part.context.tail(view) : { lines: [], optional: [] }),
            budget: part.context.budget,
        },
        settings: {
            defaults: part.settings.defaults,
            schema: part.settings.schema,
            section: (el, api) => mountSection(el, presetsBlock(api)),
        },
        // Story Block's Settings → Diagnostics (its optional hooks.diagnostics; an older host ignores it):
        // the scanner's route, profile, call counts and last outcome (index.js scannerReport),
        // and what Delta sends under its own prompt keys (`ownPrompt`, Story Block's prompt size). `redactSent` is for
        // "Show what's sent": the text of this module's tail with each locked note's line as "Name: 1 hidden note"
        // (a host that does not call it shows the raw text; SillyTavern's own prompt view always does).
        hooks: Object.freeze({ diagnostics: () => diagnosticsLines(), ownPrompt: () => ownPrompt(), redactSent: text => part.redact(text) }),
        screens: [metersCardScreen, castScreen],
        widgets: { [CAST_WIDGET]: castWidget },
        tabs: [{
            id: CAST_TAB_ID,
            title: DOSSIERS_TITLE,
            icon: DOSSIERS_ICON,
            render: (el) => {
                try { renderDossiers(el); } catch (error) { warn('Story Suite v2 Dossiers tab failed', error); }
            },
        }],
    });

    // ---- host lifecycle ----

    // story-block-tabs.js and index.js take back (or offer again) what v1 gave Story Block, and the
    // page flag (HOSTED_FLAG) follows.
    function announceHosted(on) {
        try {
            const data = doc?.documentElement?.dataset;
            if (data && on) data[HOSTED_FLAG] = '1';
            else if (data) delete data[HOSTED_FLAG];
        } catch (error) {
            warn('Story Suite v2 host flag failed', error);
        }
        try {
            if (typeof doc?.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
                doc.dispatchEvent(new CustomEvent(V2_HOST_EVENT, { detail: { hosted: on } }));
            }
        } catch (error) {
            warn('Story Suite v2 host event failed', error);
        }
        notifyChange();
    }

    // The chat the dossiers belong to (the revision is "<chat key>|<version>"), and whether they are loaded. Older Delta: always loaded.
    function chatKeyOf() {
        try {
            const revision = String(runtime()?.dossierRevision?.() ?? '');
            const at = revision.lastIndexOf('|');
            return at < 0 ? '' : revision.slice(0, at);
        } catch { return ''; }
    }
    function dossiersReady() {
        try { return runtime()?.dossiersReady?.() !== false; } catch { return true; }
    }
    // The values of a chat just opened are the host's baseline, not changes: registering again tells the host the paths came, not that values moved.
    function rebaselinePublicPaths() {
        const sdk = session.sdkRef;
        if (!session.hosted || !sdk || typeof session.offPublicPaths !== 'function') return;
        try { session.offPublicPaths(); } catch (error) { warn('Story Block public paths could not be released', error); }
        session.offPublicPaths = registerPublicPaths(sdk);
    }

    function listen() {
        if (listening || typeof doc?.addEventListener !== 'function') return;
        listening = true;
        doc.addEventListener(EVENTS.settingsMounted, () => {
            if (!session.hosted) return;
            if (typeof session.sdkRef?.query === 'function') storageRow.mount();
            if (session.pendingSection?.isConnected) mountSection(session.pendingSection);
            else syncDrawer();
        });
        // Delta's own page events (a cast drawn in the chat, Delta turned on or off) redraw the Cast
        // tab only while the pane still shows it; once the reader has moved to another tab the pane
        // is let go until the host renders the Cast tab again.
        const rerender = () => {
            if (!session.hosted) return;
            // A scan that finished late moved moods and presence: the host compares and tells `story:changed`.
            // The first render of a chat's loaded dossiers is no news: its values are the baseline (a quiet re-registration).
            try {
                const key = chatKeyOf();
                if (key !== session.baselineKey) {
                    if (dossiersReady()) { session.baselineKey = key; rebaselinePublicPaths(); }
                } else session.offPublicPaths?.changed?.();
            } catch (error) { warn('Story Block public paths change failed', error); }
            // Story Director's World screen (the page API's subscribers) redraws its cards too.
            notifyChange();
            redrawCastViews();
            if (!session.castEl) return;
            if (!session.castEl.isConnected || !castStillShown(session.castEl)) {
                session.castEl = null;
                return;
            }
            try { renderDossiers(session.castEl); } catch (error) { warn('Story Suite v2 Dossiers tab failed', error); }
        };
        doc.addEventListener(EVENTS.castRendered, rerender);
        doc.addEventListener(EVENTS.enabledChanged, rerender);
    }

    // Delta's card settings (src/card-settings.js), for a Story Block that has sdk.registerCardSettings (2.21.0); an older one
    // has none and nothing happens. A refusal is logged and never stops Delta being hosted. Returns the unregister function.
    function registerCardSettings(sdk, definition) {
        if (typeof sdk?.registerCardSettings !== 'function' || !definition) return null;
        try {
            const off = sdk.registerCardSettings(definition);
            return typeof off === 'function' ? off : (typeof off?.unregister === 'function' ? () => off.unregister() : null);
        } catch (error) {
            warn('Story Block card settings were not registered', error);
            return null;
        }
    }

    // The people behind `npc.<name>.<meter>` (src/public-paths.js): the slice's meters at the head, only the meters the reader shows, and the dossier's
    // mood and presence. A tracked person with no entry in the slice yet reads from the dossier's relationship numbers (where the entry would start).
    // An archived person is left out. Nothing while Delta is off or the host is gone.
    function publicPeople() {
        if (!session.hosted || !enabled() || typeof session.sdkRef?.query !== 'function') return [];
        const rows = session.sdkRef.query('npc.meters', {});
        if (!Array.isArray(rows)) return [];
        const defs = part.defs();
        const shown = defs.filter(def => def.show !== false);
        const hiddenMeters = defs.filter(def => def.show === false).map(def => def.id);
        const list = npcList();   // once: the list already carries names, aliases, presence and archived
        const fold = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
        const labelsOf = npc => [npc.name, ...(Array.isArray(npc.aliases) ? npc.aliases : [])].map(fold).filter(Boolean);
        const archived = new Set(list.filter(npc => npc.archived === true).flatMap(labelsOf));
        const here = new Set(list.filter(npc => npc.present === true && npc.archived !== true).map(npc => fold(npc.name)));
        // Mood and the seed numbers are read without copying the dossier (portraits and notes stay where they are).
        const fieldsOf = entry => {
            if (!entry) return null;
            try {
                const given = runtime()?.publicFields?.(entry.id);
                if (given) return given;
                const full = runtime()?.getNpc?.(entry.id);
                return full && typeof full === 'object' ? { mood: typeof full.mood === 'string' ? full.mood : null, relationship: full.relationship } : null;
            } catch { return null; }
        };
        const entryOf = name => {
            const id = resolveDossierTarget(list, name);
            return id ? list.find(npc => String(npc.id ?? '') === String(id)) ?? null : null;
        };
        const people = [];
        const taken = new Set();
        for (const row of rows) {
            if (archived.has(fold(row.name))) continue;
            const entry = entryOf(row.name);
            const fields = fieldsOf(entry);
            const meters = {};
            for (const def of shown) if (Number.isFinite(row.meters?.[def.id])) meters[def.id] = row.meters[def.id];
            people.push({
                name: row.name, meters, hiddenMeters, present: here.has(fold(entry?.name ?? row.name)),
                ...(typeof fields?.mood === 'string' ? { mood: fields.mood } : {}),
            });
            taken.add(fold(row.name));
            for (const label of entry ? labelsOf(entry) : []) taken.add(label);
        }
        for (const npc of list) {
            if (npc.archived === true || labelsOf(npc).some(label => taken.has(label))) continue;
            const fields = fieldsOf(npc);
            const given = fields?.relationship && typeof fields.relationship === 'object' ? fields.relationship : {};
            const meters = {};
            for (const def of shown) {
                const seed = Number.isFinite(given[def.id]) ? Math.round(given[def.id]) : def.start;
                meters[def.id] = Math.min(def.max, Math.max(def.min, seed));
            }
            people.push({
                name: String(npc.name ?? '').trim(), meters, hiddenMeters, present: here.has(fold(npc.name)),
                ...(typeof fields?.mood === 'string' ? { mood: fields.mood } : {}),
            });
        }
        return people.filter(person => person.name);
    }

    // The names in Story Block's scene (`scene.present`), or null when it cannot answer; also the adapter's scenePresent().
    function scenePresentNames() {
        if (!session.hosted || typeof session.sdkRef?.query !== 'function') return null;
        try {
            const list = session.sdkRef.query('scene.present');
            return Array.isArray(list) ? list.map(name => String(name ?? '').trim()).filter(Boolean) : null;
        } catch {
            return null;
        }
    }

    // A cheap token of what publicPeople() reads: the slice's rows, the dossier revision, who is present, the meter settings and Delta's switch. While it is
    // the same the table built for one synchronous read is reused (src/public-paths.js); any change reads fresh.
    function publicVersion() {
        if (!session.hosted || !enabled() || typeof session.sdkRef?.query !== 'function') return 'off';
        let revision = '';
        try { revision = String(runtime()?.dossierRevision?.() ?? ''); } catch { revision = ''; }
        return JSON.stringify([revision, session.sdkRef.query('npc.meters', {}), scenePresentNames(), storedSettings()]);
    }

    // Delta's public paths, for a Story Block that has sdk.registerPublicPaths (2.22.0); an older one has none and nothing happens.
    // A refusal is logged and never stops Delta being hosted. Returns the unregister function (with `.changed` when the host gives one) or null.
    function registerPublicPaths(sdk) {
        if (typeof sdk?.registerPublicPaths !== 'function') return null;
        try {
            const off = sdk.registerPublicPaths(createPublicPathsDefinition({ people: publicPeople, version: publicVersion }));
            return typeof off === 'function' ? off : null;
        } catch (error) {
            warn('Story Block public paths were not registered', error);
            return null;
        }
    }

    return {
        ownPrompt, storyClock, calendarLink, timeline, startTimeline, stopTimeline, definition, announceHosted, chatKeyOf,
        dossiersReady, listen, registerCardSettings, scenePresentNames, registerPublicPaths,
    };
}
