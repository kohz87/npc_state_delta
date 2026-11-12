// Story Suite v2 adapter (Story Block 2, docs/v2/SPEC.md §6 and MODULES.md §D in Story Block).
//
// NPC State Delta stays a standalone engine: its storage, capture, prompts and history rules are
// its own and nothing here changes them. When a Story Block v2 host is on the page, Delta also
// registers as module `npc-state-delta` with read-only queries, a Dossiers tab (id `cast`, the tab once
// called Cast) that is the dossier browser (and the same Dossiers as a screen in Story Block's game view),
// and a settings section that carries Delta's own settings panel into the Story Suite overlay. The present
// cast's cards are on Story Director's World screen (World → Now → Here) when it is there, drawn by Delta
// through the page API `globalThis.NPCStateDeltaCast` (PAGE_API, below); without Story Director they stay
// at the top of Dossiers (Story Block MODULES §F119). It also owns one small domain, `npc` (src/npc-meters.js; F81, F90): each NPC's
// meters, stages and unlocked hidden notes in the per-reply state, so they swipe and delete back
// with the replies. While hosted that slice is the truth for meter values: index.js reads it back
// through sliceView() for the dossier view and the injection, and sends its scanner's relationship
// changes as `npc.adjust` (adjust()); the `~ npc` change line, an NPC card under each reply and the
// meters beside the present cast's cards come from here. While hosted, the copy in SillyTavern's extensions drawer is
// hidden; if the host goes away it comes back exactly where it was. While hosted, <html> also carries
// HOSTED_FLAG, which index.js and the CSS read (launcher, in-chat cast default, sidecar checks).
//
// Without a v2 host (no Story Block, or a v1 Story Block whose global has no `ready`/`sdk`) this
// module does nothing: it looks for the host a bounded number of times and then stops. The v1
// handshake (suite.js, suite-handshake.js) keeps working with v1 hosts; with a
// v2 host (`apiVersion: 2`) it offers nothing (suite-handshake.js storyBlockIsV2), and this adapter
// sends V2_HOST_EVENT when it registers and when the host goes away so the v1 side can follow.
//
// Waiting for the host: the spec names no page event for it, so the adapter polls
// `globalThis.StoryBlock` every 250 ms, 40 times (10 s, the same bound as the v1 tabs), and once it
// has `ready` (or `sdk`) waits on that promise. Going away: every 5 s, while hosted, it checks that
// `globalThis.StoryBlock` is still the host it registered with; when it is not, the drawer copy is
// restored and the search starts again.
//
// Pure apart from the DOM it is given: no SillyTavern import, and every outside thing (Delta's
// runtime api, the host global, the document, timers) is injectable for tests.
//
// The factory is cut into parts under src/adapter/ (queries, cast-ui, timeline, connect, editor). Each part is a factory that gets
// the shared state (`session`: the lets more than one part uses) and `deps` (the options, the constants below and the parts built
// before it). This file keeps the exported constants, the assembly of the parts and the adapter object they make.
import { FEATURE_SCAN_EVERY_REPLY, FEATURE_NOTES, normalizeGeneratedSecrets, secretsFromLines, secretsToLines } from './npc-meters.js';
import { lookDrift, lookFlagWording } from './npc-notes-look.js';
import { METERS_CARD_ID } from './npc-meters-screen.js';
import { DOSSIER_FIELDS } from './fields/registry.js';
import { escapeHtml } from './util/html.js';
import { createQueriesPart } from './adapter/queries.js';
import { createCastUiPart } from './adapter/cast-ui.js';
import { createTimelinePart } from './adapter/timeline.js';
import { createConnectPart } from './adapter/connect.js';
import { createEditorPart } from './adapter/editor.js';

export { dossierFields, safeImageUrl, portraitUrl } from './adapter/queries.js';
export { meterBarNode } from './adapter/cast-ui.js';
export { isV2Host } from './adapter/connect.js';

export const MODULE_ID = 'npc-state-delta';
export const MODULE_NAME = 'NPC State Delta';
// The tab's id stays `cast` (and the screen's `npc-state-delta/cast`) so a reader's saved tab order still
// finds it; its title is Dossiers (MODULES §F119).
export const CAST_TAB_ID = 'cast';
export const DOSSIERS_TITLE = 'Dossiers';
export const DOSSIERS_ICON = 'fa-address-book';
/**
 * Dossiers as a game-view screen (Story Block's full-screen view lists screens, not module tabs): mount
 * `screen` only, so the Story panel keeps its one Dossiers tab. Its template is one widget,
 * CAST_WIDGET, that draws exactly what the tab draws (the dossier list, and the present cast's cards and
 * meters above it while Story Director's World does not show them).
 */
export const CAST_SCREEN_ID = 'npc-state-delta/cast';
export const CAST_WIDGET = 'npc-state-delta.cast';
// Story Block places the suite's own screens itself (view/screens.js SUITE_NAV: Dossiers last); an older
// host reads this number.
export const CAST_SCREEN_ORDER = 35;
/** Story Director's World view: while it is on, the present cast's cards are drawn there, not in Dossiers. */
export const WORLD_FEATURE = 'story-director.world';
/**
 * The page API for Story Director's World screen, on `globalThis` while the adapter runs (read-only; it
 * changes nothing in Delta): { version, available(), render(el, { slot }) → number of present cards drawn,
 * onChange(fn) → off }. `render` draws Delta's own present-cast cards and meters into `el` (the markup and
 * classes the Cast tab drew) and, with `slot(name, aliases)` → a node or null, puts that node inside each
 * present person's card (class PAGE_SLOT_CLASS; drawn again on every render). `onChange(fn)` calls `fn`
 * after Delta's cast or state may have changed (a cast drawn, a scan or edit, Delta on or off, hosted or
 * not); the caller redraws then.
 */
export const PAGE_API = 'NPCStateDeltaCast';
export const PAGE_SLOT_CLASS = 'npc-state-delta-v2-slot';
// Story Director's reader-only pin for key people (its feature switch is `story-director.key-people`).
const KEY_PIN_COMMAND = 'keypeople.pin';
// Story Block's lean RPG feature (its names.js LEAN_RPG_FEATURE); an extension cannot import Story Block.
const RPG_FEATURE = 'story-block.rpg';
export const QUERY_NAMES = Object.freeze(['npc.present', 'npc.dossier', 'npc.known', 'npc.portrait', 'npc.meters', 'npc.cast', 'npc.next', 'npc.keyAway', 'npc.castMade', 'npc.socialModifier', 'npc.identity', 'npc.catchUp']);
export const COMMAND_NAMES = Object.freeze(['npc.adjust', 'npc.set', 'npc.refresh', 'npc.milestone', 'npc.open', 'npc.tick', 'npc.flag', 'npc.meet']);
// The replies after which Delta takes its per-reply step (npc.tick): a new reply or a new swipe of
// one, never a Continue, a Re-read or late change lines (the same reply again).
export const TICK_TURNS = Object.freeze(['normal', 'swipe', 'regenerate']);
// The pack content kind for meter presets (Story Block's packs.content).
export const PRESET_KIND = 'meterPresets';
export { METERS_CARD_ID };
/** Sent on the document with detail { hosted } when Delta registers with a v2 host and when it goes away. */
export const V2_HOST_EVENT = 'npc-state-delta:v2-host';
/**
 * Set to '1' on <html> (data-npc-state-delta-story-block-v2) while Delta is registered with a v2
 * host, removed when it goes away. index.js and the CSS read it: the floating launcher hides (unless
 * the reader keeps it), the in-chat cast takes v1's "Only in Story Block" default, and automatic
 * freshness checks trust an already-seen missing sidecar.
 */
export const HOSTED_FLAG = 'npcStateDeltaStoryBlockV2';
export const HOST_RETRY_MS = 250;
export const HOST_RETRY_ATTEMPTS = 40;
export const HOST_ALIVE_MS = 5000;
export const SECTION_WATCH_MS = 1000;
// How long a scan, a pass or a generation waits for the host's head-selection barrier, and how often it looks.
export const HEAD_SETTLE_MS = 20000;
export const HEAD_SETTLE_POLL_MS = 50;

// What npc.dossier returns: the dossier's own fields, as the dossier shows them (DOSSIER_FIELDS, from
// the field registry). Book-keeping (evidence, change ledgers, portrait prompts and images,
// timestamps, locks) and the hidden notes stay inside Delta.
export { DOSSIER_FIELDS };

// Used only if story-block-tabs.js cannot be loaded: the same empty line, without the Scan button.
const fallbackEmptyCast = reason => `<div class="npc-state-delta-story-empty-state"><p class="npc-state-delta-story-empty">${escapeHtml(reason?.text || 'No NPC is present in the latest scene.')}</p></div>`;

/**
 * The adapter. Options (all optional except in tests):
 *   suiteApi   Delta's v1 suite api (index.js SUITE_API): npcs() gives { id, name, aliases, present, archived }.
 *   delta      () => Delta's runtime api (window.NPCStateDelta): presentCastHtml, fillPresentCast,
 *              castEmptyReason, getNpc, formPortraits, isEnabled, scan, addNpc.
 *   panelId    id of Delta's settings panel in the extensions drawer.
 *   version    Delta's version, for the module definition.
 *   host       () => the Story Block global.
 *   headReply  () => the index of the latest reply (the reader's own meter values start its window).
 *   castSync   async () => makes the dossiers of the cast people the step has just recorded (index.js castSync), and gives a cast
 *              dossier made without its picture the picture once Story Block has it.
 *   castPortraitDue   () => whether castSync has a picture to give (a cheap look); the adapter asks before it runs the sync for that alone.
 *   doc, timers, loadEmptyCast (() => Promise<emptyCastHtml>), logger.
 */
export function createStorySuiteV2Adapter({
    suiteApi = null,
    delta = () => globalThis.NPCStateDelta,
    panelId = 'npc_state_delta_settings',
    version = '',
    host = () => globalThis.StoryBlock,
    headReply = () => null,
    castSync = null,
    castPortraitDue = null,
    doc = globalThis.document,
    timers = globalThis,
    loadEmptyCast = () => import('../story-block-tabs.js').then(module => module.emptyCastHtml),
    retryMs = HOST_RETRY_MS,
    attempts = HOST_RETRY_ATTEMPTS,
    aliveMs = HOST_ALIVE_MS,
    watchMs = SECTION_WATCH_MS,
    logger = console,
    // True while the reader keeps the calendar in Delta (Source of truth: calendar "mine"): no story clock.
    calendarOwn = () => false,
    // Delta's dossier list markup and projection (story-block-tabs.js, dossier-ui.js), as v1's Dossiers tab.
    loadDossierList = () => Promise.all([import('../story-block-tabs.js'), import('../dossier-ui.js')])
        .then(([tabs, ui]) => ({ rowNodes: tabs.dossierRowNodes, project: ui.dossierIndexProjection, filter: ui.filterDossierIndex })),
    // Where the page API (PAGE_API) goes; null for none.
    page = globalThis,
    // Where the timeline participant keeps its checkpoints (storysuite-participant/vault.js); SillyTavern's user files by default.
    participantVault = null,
    // The participant's timings (debounceMs, retryMs, idleMs; participant.js), for tests.
    participantOptions = {},
    // How long Delta waits for the host's head-selection barrier to come down, and how often it looks (messageGate.settled).
    settleMs = HEAD_SETTLE_MS,
    settlePollMs = HEAD_SETTLE_POLL_MS,
    // Delta's card settings (src/card-settings.js); registered with a Story Block that has sdk.registerCardSettings (2.21.0).
    cardSettings = null,
} = {}) {
    const session = {
        started: false,
        pollTimer: null,
        sdkRef: null,           // the sdk we registered with (once per sdk)
        hosted: false,
        emptyCast: fallbackEmptyCast,
        mounted: null,          // { el, node, placeholder, drawer } while the panel is in the overlay
        pendingSection: null,   // a section element waiting for the panel to mount
        castEl: null,           // the last element the Cast tab rendered into
        pending: null,          // the connection attempt in progress, if any
        baselineKey: null,      // the chat whose first loaded render was taken as the public paths' baseline
        offPublicPaths: null,   // unregisters Delta's public paths (npc.<name>.<meter>); `.changed()` tells the host the values moved
        lastTick: Promise.resolve(null),
        listParts: null,        // loadDossierList's { rowNodes, project, filter } once loaded
    };

    // The parts, in the order the closure declared them: each gets the options and constants (deps) and what the parts before it return.
    const deps = {
        suiteApi, delta, panelId, version, host, headReply, castSync, castPortraitDue, doc, timers, loadEmptyCast, retryMs,
        attempts, aliveMs, watchMs, logger, calendarOwn, loadDossierList, page, participantVault, participantOptions, settleMs,
        settlePollMs, cardSettings, MODULE_ID, MODULE_NAME, CAST_TAB_ID, DOSSIERS_TITLE, DOSSIERS_ICON, CAST_SCREEN_ID,
        CAST_WIDGET, CAST_SCREEN_ORDER, WORLD_FEATURE, PAGE_API, PAGE_SLOT_CLASS, KEY_PIN_COMMAND, TICK_TURNS, PRESET_KIND,
        V2_HOST_EVENT, HOSTED_FLAG,
    };
    // The queries part reads the timeline participant's npc.identity query when it is called; the timeline part is built after it.
    let timelinePartRef = null;
    deps.timeline = { get queries() { return timelinePartRef.timeline.queries; } };
    const queriesPart = createQueriesPart(session, deps);
    Object.assign(deps, queriesPart);
    const castUiPart = createCastUiPart(session, deps);
    Object.assign(deps, castUiPart);
    const timelinePart = createTimelinePart(session, deps);
    timelinePartRef = timelinePart;
    Object.assign(deps, timelinePart);
    const connectPart = createConnectPart(session, deps);
    Object.assign(deps, connectPart);
    const editorPart = createEditorPart(session, deps);
    Object.assign(deps, editorPart);
    const { watchers, pinKeyPerson, pageApi, offerPage } = castUiPart;
    const { storyDateText, dossierOf, part, sliceEntries, entryFor, partyLevelsAnswer, keyPeopleAnswer, keyPeopleReadable, keyAwayMemory, castAnswer, castPeople, castMade, packNames, packPortraitUrl, castGearLine, keyPinOffered, directorCalendar, keyPeople, send, sliceView } = queriesPart;
    const { ownPrompt, storyClock, calendarLink, definition, scenePresentNames } = timelinePart;
    const { poll, unhost, check } = connectPart;
    const { editorHtml, readEditor, dossierMeters, eventWatch } = editorPart;

    return Object.freeze({
        definition,
        /** The catch-up after a fallback and the rebuild: status() for the banner, skip() (not a Story Block command: that would write an op), rebuild({ replies }). */
        catchUp: timelinePart.timeline.catchUp,
        /** The page API Story Director's World screen uses (PAGE_API). */
        pageApi,
        /** While hosted: Delta's scanner changes for one NPC → `npc.adjust` (a promise of the result, or null). */
        adjust: ({ name, meters, start, reply, impact } = {}) => send('npc.adjust', { name, meters, ...(start ? { start } : {}), ...(Number.isInteger(reply) && reply >= 0 ? { reply } : {}), ...(typeof impact === 'string' ? { impact } : {}) }, { own: true, background: true }),
        /** While hosted: Delta's scan admitted a person → `npc.meet` (an entry with the dossier's meters, a resting mood and drives, like a cast meeting). */
        meet: ({ name, personality, about, reply } = {}) => send('npc.meet', { name, ...(Number.isInteger(reply) && reply >= 0 ? { reply } : {}), ...(personality ? { personality: String(personality).slice(0, 600) } : {}), ...(about ? { about: String(about).slice(0, 600) } : {}) }, { own: true, background: true }),
        /** While hosted: Delta's scan tells the slice a person's look was first set (`lock`) or contradicted (`drift: { before, incoming }`, worded by npc-notes-look.js; or `text`, `cue`) → `npc.flag`. Only with the notes feature on and for a person who already has meters (a flag never makes an entry); else null. */
        flag: ({ name, text: said, cue: told, lock, reply, drift } = {}) => ((text, cue) => (!text && lock !== true ? null : part.featureOn(FEATURE_NOTES) === true && (() => { const entries = sliceEntries(); return Boolean(entries && entryFor(entries, dossierOf(name) ?? { name })); })() ? send('npc.flag', { name, ...(text ? { text } : {}), ...(cue ? { cue } : {}), ...(lock === true ? { lock: true } : {}), ...(Number.isInteger(reply) && reply >= 0 ? { reply } : {}) }, { own: true, background: true }) : null))(said || (drift ? lookDrift(drift.before, drift.incoming) : ''), told || (drift ? lookFlagWording(name, drift.before) : '')),
        /** While hosted: the reader's own values from the dossier editor → `npc.set` (the host's latest reply; headReply). */
        setMeters: ({ name, meters } = {}) => send('npc.set', { name, meters }),
        /** While hosted: stages and notes again for one NPC (after its notes were edited) → `npc.refresh`. */
        refresh: name => send('npc.refresh', { name }),
        /** While hosted: one NPC's slice entry (npc.meters), or null. */
        meters: name => {
            const entries = sliceEntries();
            const npc = dossierOf(name) ?? { name };
            return entries ? entryFor(entries, npc) : null;
        },
        /** While hosted: Delta's records with numbers, part-points and earned milestones read from the slice (read time; nothing written). */
        sliceView,
        /** Runs the synchronous reads of `fn` against Story Block's state after reply `index` (query { asOf }); nothing is written or moved. */
        at: (index, fn) => {
            const real = session.sdkRef;
            if (typeof real?.query !== 'function') return fn();
            session.sdkRef = Object.create(real, { query: { value: (name, args) => real.query(name, { ...args, asOf: index }) } });
            try { return fn(); } finally { session.sdkRef = real; }
        },
        /** While hosted: Story Block's `party.levels` as it answers, or null (no host, no query, RPG off). */
        partyLevelsAnswer,
        /** While hosted: Story Director's key people (`director.keyPeople`) as it answers, or null when it cannot. */
        keyPeopleAnswer,
        keyPeopleReadable,
        /** While hosted: the slice's entries (npc.meters) at the head, or null when the host cannot answer. */
        meterEntries: sliceEntries,
        /** While hosted: the memory of key people's last absences (npc.keyAway), {} without one. */
        keyAwayMemory,
        /** The same, cleaned (normalizeKeyPeople), without dates written. */
        keyPeople,
        /** While hosted: Story Director's calendar (`director.calendar`), or null. */
        directorCalendar,
        /** While hosted: the story's date after reply `index` ("Icewane 27"), '' without a clock; dates a memory when it is recorded. */
        storyDateText,
        /** While hosted: whether Story Director offers `keypeople.pin` (the "Pin as Key people" button shows only then). */
        keyPinOffered,
        /** While hosted: the reader pins a person as a key person (`keypeople.pin`, cause ui) → { ok, message }. */
        pinKeyPerson,
        /** While hosted: Story Director's cast (`director.cast`) as it answers, or null when it cannot. */
        castAnswer,
        /** The same, cleaned (src/cast-dossier.js normalizeCast), dates written on Story Director's calendar. */
        castPeople,
        /** While hosted: the people a cast dossier was made for (npc.castMade), {} without one. */
        castMade,
        /** While hosted: packs' names by id. */
        packNames,
        /** While hosted: a pack portrait's safe image URL, or null. */
        packPortraitUrl,
        /** While hosted: a pack cast member's "Gear: A, B" line for the narrator's entry, or ''. */
        castGearLine,
        /** While hosted: whether Story Block's RPG feature is on (the custom field "Level" then appears by itself). */
        rpgOn: () => session.hosted === true && part.featureOn(RPG_FEATURE) === true,
        /** While hosted: the "Scan after every reply" switch (index.js asks before each automatic scan). */
        scanEveryReply: () => part.featureOn(FEATURE_SCAN_EVERY_REPLY) !== false,
        /**
         * Where the calendar in Delta's settings stands: 'story-director' (Story Director's calendar is the one in
         * use), 'own' (the reader keeps the calendar in Delta) or 'none' (no host, or no Story Director calendar).
         */
        calendarLink,
        /** While hosted: Story Director's clock, { minutes, calendar: { era, months, leapYears } }, or null. */
        storyClock,
        /** What Delta sends with the next reply under its own keys: [{ label, text }] (the `ownPrompt` hook). */
        ownPrompt,
        /** While hosted: the names in Story Block's scene (`scene.present`), or null when it cannot answer. */
        scenePresent: scenePresentNames,
        /**
         * While hosted: who is in the scene now, for the scanner: Story Director's World view
         * (`director.world.here` → `present`) when it answers, else Story Block's `scene.present`; null
         * when neither can answer. Both are optional: Delta alone (or Story Block alone) still works.
         */
        presentNow: () => {
            if (!session.hosted || typeof session.sdkRef?.query !== 'function') return null;
            const ask = name => {
                try { return session.sdkRef.query(name, {}); } catch { return undefined; }
            };
            const here = ask('director.world.here');
            const list = Array.isArray(here?.present) ? here.present : ask('scene.present');
            return Array.isArray(list) ? list.map(name => String(name ?? '').trim()).filter(Boolean) : null;
        },
        /** A dossier's hidden notes as editor lines, and editor lines back to notes (src/npc-meters.js). */
        secretLines: list => secretsToLines(list),
        parseSecrets: (text, previous) => secretsFromLines(text, previous),
        /** While hosted: the editor's v2 controls for a dossier (markup), and what they hold (readEditor). */
        editorHtml,
        readEditor,
        /**
         * While hosted, after the dossier was saved: the editor's milestones and custom meter values
         * go to the slice (npc.milestone, npc.set), then stages and notes are settled again (npc.refresh).
         */
        applyEditor: async (name, edits = {}) => {
            if (!session.hosted) return null;
            if (edits.meters && Object.keys(edits.meters).length) await send('npc.set', { name, meters: edits.meters });
            if (edits.milestones) await send('npc.milestone', { name, add: edits.milestones.add ?? [], remove: edits.milestones.remove ?? [] });
            if (edits.noteStates) await send('npc.open', { name, open: edits.noteStates.open ?? [], close: edits.noteStates.close ?? [] });
            return send('npc.refresh', { name });
        },
        /** While hosted: the dossier view's v2 meters by dossier id ({} otherwise). */
        dossierMeters,
        /** The story events of present people's locked notes the scan should look for (see eventWatch); [] when none. */
        eventWatch,
        /** While hosted: a story event the scan saw opens these notes of one NPC → `npc.open` (Delta's own send). */
        openByEvent: ({ name, ids } = {}) => send('npc.open', { name, open: ids, by: 'story' }, { own: true, background: true }),
        /** The notes a scan wrote for someone new, cleaned to 2 to 5 layers (src/npc-meters.js normalizeGeneratedSecrets). */
        generatedSecrets: list => normalizeGeneratedSecrets(list),
        /** While hosted: Delta's per-reply step now (the host's 'turn' event sends it on its own). */
        tick: () => send('npc.tick', {}, { own: true }),
        /** Resolves once the latest per-reply step has settled. */
        ticked: () => session.lastTick,
        /** Start looking for the host (idempotent). */
        start() {
            if (session.started) return;
            session.started = true;
            offerPage(true);
            poll(0);
        },
        /** Stop looking and give everything back (tests; a reload of Delta). */
        stop() {
            session.started = false;
            offerPage(false);
            watchers.clear();
            if (session.pollTimer !== null) timers.clearTimeout?.(session.pollTimer);
            session.pollTimer = null;
            unhost();
        },
        check,
        hosted: () => session.hosted,
        /** Resolves (true when it registered) once the latest connection attempt has settled. */
        settled: () => session.pending ?? Promise.resolve(false),
    });
}

let adapter = null;

/** Start the page's one adapter (index.js calls this once at startup); later calls return the same one. */
export function startStorySuiteV2(options = {}) {
    if (!adapter) {
        adapter = createStorySuiteV2Adapter(options);
        adapter.start();
    }
    return adapter;
}
