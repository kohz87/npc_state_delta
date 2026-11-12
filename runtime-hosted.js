/* NPC State Delta hosted Story Suite views (role: hosted-suite-views). What Delta reads from a Story Block v2 host and its modules while hosted:
   the host's clock, meters and scene, Story Director's key people and living cast as the dossier views read them, the chat-head mark, and the
   relationship changes, secret events and hidden-note options Delta sends back, and the words for why no one shows as present. Built by index.js once per module instance with the shared
   runtime state and the controller functions it calls. Bodies are moved from index.js without change. */

import { chatContext as getContext, replayScope, scopedAdapter } from './runtime-scan-helpers.js';
import { replyScanned } from './scan-context.js';
import { tieDayAt } from './src/transcript.js';
import { normalizeRelationshipBaseline, isTerminalNpcDeath, npcMatchesLabel, storyMinuteText } from './core.js';
import { defersArea, resolveDossierTarget } from './suite-handshake.js';
import { awayNpcIds, findKeyEntry, isKey, keyView, normalizeKeyPeople, returnNote } from './src/key-people.js';
import { castView, findCastPerson, normalizeCast } from './src/cast-dossier.js';
import { getSettings, setRpgProbe } from './runtime-settings.js';
import { sheetLevelOf } from './core-record.js';
import { rejectedOverallLook } from './appearance-update.js';
import { stage1Refresh } from './dossier-tools-core.js';

export function createHostedPart(rt, deps) {
    const { chatHydrationStatus, getChatKey, getChatState, latestMessageId, latestReplyIndex } = deps;
    setRpgProbe(() => (storyBlockV2Hosted() && rt.storySuiteV2?.hosted?.() ? rt.storySuiteV2.rpgOn?.() === true : false));

    // Set by src/storysuite-v2.js while Delta is registered with a Story Block v2 host.
    function storyBlockV2Hosted() {
        return globalThis.document?.documentElement?.dataset?.npcStateDeltaStoryBlockV2 === '1';
    }

    // (v2 meters, F81/F90) While hosted, Story Block's per-reply `npc` slice holds the meter values. Every
    // helper here is a no-op without a host: the records pass through untouched and nothing is sent.
    function storySuiteV2Meters() {
        const adapter = storyBlockV2Hosted() && rt.storySuiteV2?.hosted?.() ? rt.storySuiteV2 : null;
        const scope = replayScope();
        return adapter && scope ? scopedAdapter(adapter, scope.at, scope.sink) : adapter;   // a history replay reads Story Block as of its reply
    }
    // (v2) Story Suite's "Scan after every reply" switch (feature npc-state-delta.scan-every-reply, on by default).
    // Off, the automatic scan waits for three replies (or "Scan every" when larger), as in 1.7.4, and then reads every reply since the last scan. True without a host, or when
    // the host cannot answer: Delta alone scans as it always did. Manual scans never ask.
    function scanAfterEveryReply() {
        const adapter = storySuiteV2Meters();
        if (!adapter) return true;
        try { return adapter.scanEveryReply?.() !== false; } catch { return true; }
    }
    // (v2) Story Director's clock while hosted ({ minutes, calendar }), for calendar.js; null otherwise (and
    // while the reader keeps the calendar here: the adapter's calendarOwn).
    // The story's date after reply `index` as the dossier writes it ("Icewane 27"), '' with no host clock (calendar.js setStoryDateAtSource).
    function hostedStoryDateAt(index) {
        try { return String(storySuiteV2Meters()?.storyDateText?.(index) ?? ''); } catch { return ''; }
    }
    function hostedStoryDayAt(index) {
        try { const day = storySuiteV2Meters()?.storyDayNumber?.(index); return Number.isInteger(day) ? day : null; } catch { return null; }
    }
    function hostedStoryClock() {
        const adapter = storySuiteV2Meters();
        if (!adapter) return null;
        try { return adapter.storyClock?.() ?? null; } catch { return null; }
    }
    // Delta's records with their relationship numbers, part-points and earned milestones read from the slice (views, the injection and a scan's copy).
    function hostedMeterView(npcs) {
        const adapter = storySuiteV2Meters();
        if (!adapter) return npcs;
        try { return adapter.sliceView(npcs) || npcs; } catch { return npcs; }
    }
    // (v2, key people) Story Director's key people (`director.keyPeople`, read only), or null: no host, no Story Director,
    // or one without the query. Null means Delta alone: no badge, no section, no hold, nothing sent. src/key-people.js.
    function keyPeopleList() {
        const adapter = storySuiteV2Meters();
        if (!adapter) return null;
        try {
            const answer = adapter.keyPeopleAnswer?.();
            if (!Array.isArray(answer)) return null;
            const calendar = adapter.directorCalendar?.() ?? null;
            return normalizeKeyPeople(answer, minutes => storyMinuteText(minutes, calendar));
        } catch {
            return null;
        }
    }
    // Whether this dossier (or snapshot of one) is a current key person.
    function isKeyNpc(npc, list = keyPeopleList()) {
        return Boolean(list?.length) && isKey(findKeyEntry(list, npc));
    }
    // The index of the reply the story stands on for the next generation: the latest reply, or the one before it while the
    // latest is being replaced.
    function keyHeadIndex() {
        const latest = latestReplyIndex();
        const chat = getContext().chat || [];
        if (!rt.replacingReply || rt.replacingReply.key !== getChatKey() || latest < 0 || chat[latest] !== rt.replacingReply.message) return latest;
        for (let at = latest - 1; at >= 0; at -= 1) if (chat[at] && !chat[at].is_system && !chat[at].is_user) return at;
        return -1;
    }
    // What the narrator is told once about key people who just came back: { dossier id: "WHILE AWAY, NOW BACK …" }.
    // It stands while the latest reply is the one the return was noticed at, so a swipe of the next reply repeats it and
    // the next reply that stays drops it.
    function keyReturnNotes(state) {
        const list = keyPeopleList();
        if (!list?.length) return null;
        const head = keyHeadIndex();
        const memory = storySuiteV2Meters()?.keyAwayMemory?.() ?? {};
        const notes = {};
        for (const npc of state?.npcs || []) {
            const view = npc?.id ? keyView(list, memory, npc, head) : null;
            if (view?.recent?.justReturned) notes[npc.id] = returnNote(view.recent.away);
        }
        return Object.keys(notes).length ? notes : null;
    }

    // The people the step has recorded as made (the slice's `cast`), met now with their entry, with no dossier standing for them
    // and not removed by the reader.
    function castList() {
        const adapter = storySuiteV2Meters();
        if (!adapter) return null;
        try {
            const answer = adapter.castAnswer?.();
            if (!Array.isArray(answer)) return null;
            const calendar = adapter.directorCalendar?.() ?? null;
            return normalizeCast(answer, minutes => storyMinuteText(minutes, calendar));
        } catch {
            return null;
        }
    }

    // The dossier view's cast data by dossier id ({ badge, packName, firstMet, goal, routine, lastHeard, where, doing }) for the
    // dossiers made from the cast; null with none. Story Director's answer adds the live path and "last heard" when it is there.
    function dossierCastViews(state) {
        const made = (state?.npcs || []).filter(npc => npc?.id && npc.castFrom?.key);
        if (!made.length) return null;
        const people = castList();
        const views = {};
        for (const npc of made) {
            const view = castView(npc, findCastPerson(people, npc.castFrom.key));
            if (view) views[npc.id] = view;
        }
        return Object.keys(views).length ? views : null;
    }

    // (v2) While hosted, Story Block's scene says who is here unless the reader keeps the scene in Delta
    // ("scene: mine"): the dossier injection, the Cast tab and the module's queries all follow its
    // `scene.present`, so the prompt never carries two different casts. Delta's stored presence is not
    // changed. Without a host, or when the scene cannot answer, Delta's own presence stands.
    function scenePresenceView(npcs) {
        const adapter = storySuiteV2Meters();
        if (!adapter || !Array.isArray(npcs) || !defersArea('scene', getSettings().sourceOfTruth)) return npcs;
        let names = null;
        try { names = adapter.scenePresent?.(); } catch { names = null; }
        if (!Array.isArray(names)) return npcs;
        const here = new Set(names.map(name => resolveDossierTarget(npcs, name)).filter(Boolean));
        let changed = false;
        const out = npcs.map(npc => {
            // (C-1) The scene cannot bring a confirmed-dead NPC back on stage.
            const present = Boolean(npc?.id) && here.has(String(npc.id)) && !npc.archived && !isTerminalNpcDeath(npc);
            if (Boolean(npc?.present) === present) return npc;
            changed = true;
            return { ...npc, present, worldActive: present ? false : Boolean(npc.worldActive) };
        });
        return changed ? out : npcs;
    }
    // (v2 World view) Who the story's scene lists as present now, for the scanner's dynamic context: only
    // while hosted with Story Block keeping the scene (as scenePresenceView) and only for a scan of the
    // head reply (the scene is the head's). Story Director's World view first, else Story Block's scene;
    // null otherwise, and the scanner prompt is then exactly as before.
    function scanScenePresent(messageId) {
        const adapter = storySuiteV2Meters();
        if (!adapter || !defersArea('scene', getSettings().sourceOfTruth)) return null;
        if (Number.isInteger(messageId) && messageId !== latestMessageId(true)) return null;
        try {
            const names = adapter.presentNow?.();
            return Array.isArray(names) && names.length ? names : null;
        } catch {
            return null;
        }
    }
    // The merge option that holds away key people's stable fields (as if locked) for one scan: { awayNpcIds } or nothing.
    // The dossier view's key-person data by dossier id ({ name, here, away, recent }), or null with no key people.
    function dossierKeyViews(state) {
        const list = keyPeopleList();
        if (!list?.length) return null;
        const head = keyHeadIndex();
        const memory = storySuiteV2Meters()?.keyAwayMemory?.() ?? {};
        const views = {};
        for (const npc of state?.npcs || []) {
            const view = npc?.id ? keyView(list, memory, npc, head) : null;
            if (view) views[npc.id] = view;
        }
        return Object.keys(views).length ? views : null;
    }
    // (hosted) Active party members with a whole-number sheet level, [{ name, level }] (Story Block's `party.levels`); [] when the host
    // cannot say (no host, no query, RPG off), and members who left are not in it: their stored Level is left to the scanner rules.
    function partyLevelList() {
        let answer = null;
        try { answer = storySuiteV2Meters()?.partyLevelsAnswer?.() ?? null; } catch { answer = null; }
        return (answer || []).filter(row => row && row.left !== true && typeof row.name === 'string' && Number.isInteger(row.level)).map(row => ({ name: row.name, level: row.level }));
    }
    // The dossiers whose Level follows the party sheet now: { dossier id: true }; null with none.
    function dossierSheetLevels(state) {
        const levels = partyLevelList();
        const marked = {};
        for (const npc of levels.length ? state?.npcs || [] : []) if (npc?.id && sheetLevelOf(npc, levels) !== null && String(npc.customFields?.Level ?? '') === String(sheetLevelOf(npc, levels))) marked[npc.id] = true;
        return Object.keys(marked).length ? marked : null;
    }
    // What the dossier view reads from the host beside the dossiers: v2 meters, key-person and living-cast views.
    function dossierHostViews(state) {
        const meterViews = storySuiteV2Meters()?.dossierMeters?.(state.npcs) ?? {};
        const keyViews = dossierKeyViews(state);
        const castViews = dossierCastViews(state);
        const sheetLevels = dossierSheetLevels(state);
        const storyDay = tieDayAt();   // the story day now: older ties fade by it (core-keyrel.js)
        return { meterViews, ...(Number.isInteger(storyDay) ? { storyDay } : {}), ...(keyViews ? { keyViews } : {}), ...(castViews ? { castViews } : {}), ...(sheetLevels ? { sheetLevels } : {}) };
    }
    // (perf) The dossiers as the views read them: a copy, except that a portrait's picture (its data URL, an immutable string of up to
    // a few hundred KB) is shared rather than copied; the portrait record itself is still a copy.
    function viewNpcCopies(npcs) {
        return (Array.isArray(npcs) ? npcs : []).map(npc => {
            const portrait = npc?.portrait;
            if (!portrait || typeof portrait !== 'object' || typeof portrait.dataUrl !== 'string') return structuredClone(npc);
            const copy = structuredClone({ ...npc, portrait: null });
            const { dataUrl, ...record } = portrait;
            copy.portrait = { ...structuredClone(record), dataUrl };
            return copy;
        });
    }
    // The ids of dossiers Story Director names as key people or away (exact name/alias, src/key-people.js): the stale pass archives, never deletes, them.
    function keyKeepIds(state) {
        const list = keyPeopleList();
        return list?.length ? (state?.npcs || []).filter(npc => isKey(findKeyEntry(list, npc))).map(npc => npc.id) : [];
    }
    // True while hosted and a read really failed: the key list (a present query that errors or answers a non-list; Story Director absent or
    // off is no key list, not a failure) or the meter read. The stale pass then only archives.
    function hostedReadsFailed() {
        const adapter = storySuiteV2Meters();
        if (!adapter) return false;
        try { return adapter.keyPeopleReadable?.() === false || !Array.isArray(adapter.meterEntries?.()); } catch { return true; }
    }
    function keyAwayScanOptions(state) {
        const list = keyPeopleList();
        if (!list?.length) return {};
        const ids = awayNpcIds(list, state?.npcs);
        return ids.size ? { awayNpcIds: [...ids] } : {};
    }
    // The chat state a scan works from: with the slice's relationship numbers while hosted (a copy;
    // the stored state is never changed here), the state itself otherwise.
    function hostedScanState(state) {
        const npcs = hostedMeterView(state?.npcs);
        return npcs === state?.npcs ? state : { ...state, npcs };
    }
    // Which message is the head of the chat, and which of its swipes is shown. Story Block writes a
    // module's command onto its head reply, so a scan's changes may go there only while it is the head
    // the scan started from: the same message object at the same place with the same swipe.
    function chatHeadMark() {
        const chat = getContext().chat || [];
        const message = chat[chat.length - 1] ?? null;
        return { length: chat.length, message, swipe: Number.isInteger(message?.swipe_id) ? message.swipe_id : null };
    }
    function chatHeadUnchanged(mark) {
        if (!mark) return true;
        const now = chatHeadMark();
        return now.length === mark.length && now.message === mark.message && now.swipe === mark.swipe;
    }
    // A committed scan's relationship changes go to the slice as npc.adjust (same clamps as a story
    // line), in dossier order; the sidecar keeps its own numbers by v1's rules. `head` (chatHeadMark,
    // taken when the scan started): when the reader swiped, or a reply was added or deleted, since
    // then, nothing is sent; the changes belonged to a reply that is no longer the one Story Block
    // would write them on, and the reply now shown gets its own scan.
    function forwardRelationshipChangesToHost(before, after, messageId, head = null, updates = []) {
        if (replayScope()) return;   // Story Block already holds these changes in its own per-reply records
        const adapter = storySuiteV2Meters();
        if (!adapter) return;
        const dropped = () => {
            console.info('[NPC State Delta] the chat moved on during the scan (a swipe or a new or deleted reply); its relationship changes were not sent to Story Suite.');
        };
        if (!chatHeadUnchanged(head)) return dropped();
        const prior = new Map((before || []).map(npc => [npc?.id, npc]));
        const baseline = normalizeRelationshipBaseline(getSettings().relationshipBaseline);
        const changes = [];
        for (const npc of after || []) {
            if (!npc?.id || npc.archived) continue;
            const from = prior.has(npc.id) ? normalizeRelationshipBaseline(prior.get(npc.id).relationship) : baseline;
            const to = normalizeRelationshipBaseline(npc.relationship);
            const meters = Object.fromEntries(Object.keys(to).filter(key => to[key] !== from[key]).map(key => [key, to[key] - from[key]]));
            // The tier the scanner gave this scan's event (its newest relationship change), so the slice's allowance counts it like a
            // story line's: one event however many meters it moved. None known: sent without one, and not counted.
            const last = npc.lastRelationshipChange;
            const fresh = last && JSON.stringify(last) !== JSON.stringify(prior.get(npc.id)?.lastRelationshipChange);
            if (Object.keys(meters).length) changes.push({ name: npc.name, meters, start: from, reply: messageId, ...(fresh && typeof last.impact === 'string' ? { impact: last.impact } : {}) });
        }
        // A person's look set for the first time by this scan: its day and reply are stamped (the notes feature's locked look).
        const looks = (after || []).filter(npc => npc?.id && !npc.archived && String(npc.overallAppearance ?? '').trim() && !String(prior.get(npc.id)?.overallAppearance ?? '').trim());
        // A durable look the scan refused (the story did not explain a change): a Problem and a next-reply cue, never a silent change.
        const refused = [];
        const afterBy = new Map((after || []).map(npc => [npc?.id, npc]));
        for (const row of Array.isArray(updates) ? updates : []) {
            const was = prior.get(row?.id);
            const now = afterBy.get(row?.id);
            if (!was || !now || now.archived) continue;
            const rejected = rejectedOverallLook(was.overallAppearance, now.overallAppearance, row);
            if (rejected && !refused.some(item => item.id === now.id)) refused.push({ id: now.id, name: now.name, before: was.overallAppearance, incoming: rejected.incoming });
        }
        // (scan-admitted people) A dossier the scan made (an id the sidecar did not have) gets a slice entry the way a cast meeting gives one;
        // an adjust below has made it first when the scan moved its meters, and the meeting then only adds the mood and drives. Not the dead
        // and not incidental extras: the slice holds 80 people, and a long chat must not fill it with people who never matter.
        const worth = npc => !['dead', 'deceased'].includes(String(npc.lifeState ?? '').toLowerCase()) && npc.dossierSignal !== 'incidental';
        const met = typeof adapter.meet === 'function' ? (after || []).filter(npc => npc?.id && !npc.archived && !prior.has(npc.id) && worth(npc)) : [];
        if (!changes.length && !looks.length && !refused.length && !met.length) return;
        void (async () => {
            // The slice entry comes first (adjust, else meet): a look flag never makes one, so a new person's look lock needs it.
            for (const change of changes) {
                if (!chatHeadUnchanged(head)) return dropped();
                await adapter.adjust(change);
                stage1Refresh();   // an open dossier panel draws again once the host's meters took this change
            }
            for (const npc of met) {
                if (!chatHeadUnchanged(head)) return dropped();
                await adapter.meet({ name: npc.name, personality: npc.personality, about: npc.background, reply: messageId });
                stage1Refresh();
            }
            for (const npc of looks) {
                if (!chatHeadUnchanged(head)) return dropped();
                await adapter.flag?.({ name: npc.name, lock: true, reply: messageId });
            }
            for (const item of refused) {
                if (!chatHeadUnchanged(head)) return dropped();
                await adapter.flag?.({ name: item.name, drift: { before: item.before, incoming: item.incoming }, reply: messageId });
            }
        })();
    }

    // (v2 hidden notes) The story events of present people's locked notes this scan should look for ([] when none): only for
    // a scan of the head reply (an opened note is recorded on the head), and only for the people in the scene now.
    function hostedEventWatch(state, messageId) {
        const adapter = storySuiteV2Meters();
        if (!adapter || (Number.isInteger(messageId) && messageId !== latestMessageId(true))) return [];
        try { return adapter.eventWatch?.(scenePresenceView(state?.npcs || [])) || []; } catch { return []; }
    }

    // (v2 hidden notes) What a scanner or one-pass prompt is asked about hidden notes while hosted: the layered notes for a new
    // dossier (setting) and the story events of present people's locked notes; {} when neither (the prompt is then as before).
    function hostedNotePromptOptions(state, settings, messageId = null) {
        if (!storySuiteV2Meters()) return {};
        const eventWatch = hostedEventWatch(state, Number.isInteger(messageId) ? messageId : undefined);
        return {
            ...(settings.layeredSecrets !== false ? { layeredSecrets: true } : {}),
            ...(eventWatch.length ? { eventWatch } : {}),
        };
    }

    // (v2 hidden notes) What a targeted pass (backfill, Refresh) is asked about hidden notes: { layered, watch } or null when
    // nothing is asked (not hosted, or no setting and no event note to look for). `layered`: this dossier is new (a backfill
    // queued at admission) and has no notes yet. `watch`: this one person's locked event notes, when they are present.
    // `tastes` (Refresh only): the pass also asks for this person's tastes (the notes feature on) and forwards them (forwardTastesToHost).
    function hostedTargetNotes(npc, { newDossier = false, messageId = null, tastes = false } = {}) {
        const adapter = storySuiteV2Meters();
        if (!adapter || !npc) return null;
        const layered = newDossier && getSettings().layeredSecrets !== false && !(Array.isArray(npc.secrets) && npc.secrets.length);
        const watch = hostedEventWatch({ npcs: [npc] }, messageId);
        const asked = tastes === true && adapter.asksTastes?.() === true;
        return layered || watch.length || asked ? { layered, watch, ...(asked ? { tastes: true } : {}) } : null;
    }
    const targetNoteOptions = notes => ({
        ...(notes?.layered ? { layeredSecrets: true } : {}),
        ...(notes?.watch?.length ? { eventWatch: notes.watch } : {}),
        ...(notes?.tastes ? { askTastes: true } : {}),
    });

    // A Refresh's answered tastes (the target's row of `rows`: { tastes: [{ sign, item, from }] }) → npc.taste on the head reply the Refresh read, once the
    // chat is known not to have moved (as forwardSecretEventsToHost). Nothing while replaying.
    function forwardTastesToHost(npc, rows, head = null) {
        if (replayScope()) return;
        const adapter = storySuiteV2Meters();
        const list = Array.isArray(rows) ? rows : [];
        const row = list.find(item => String(item?.id || '') === npc?.id || (item?.name && npcMatchesLabel(npc, String(item.name)))) || (list.length === 1 ? list[0] : null);
        if (!adapter || !npc || !Array.isArray(row?.tastes) || !row.tastes.length) return;
        if (!chatHeadUnchanged(head)) return;
        const reply = latestMessageId(true);
        void adapter.tastes({ name: npc.name, tastes: row.tastes, ...(reply >= 0 ? { reply } : {}) });
    }

    // A committed scan's `secretEvents` (the keys of the watched story events the current exchange showed) open those notes
    // as npc.open (cause ui, recorded on the head reply, so a swipe takes them back). Nothing is sent when the chat moved
    // on during the scan (as forwardRelationshipChangesToHost).
    function forwardSecretEventsToHost(watched, answered, head = null) {
        if (replayScope()) return;
        const adapter = storySuiteV2Meters();
        if (!adapter || !Array.isArray(watched) || !watched.length || !Array.isArray(answered) || !answered.length) return;
        if (!chatHeadUnchanged(head)) {
            console.info('[NPC State Delta] the chat moved on during the scan; its story events were not sent to Story Suite.');
            return;
        }
        const keys = new Set(answered.map(item => String(item ?? '')));
        const byName = new Map();
        for (const item of watched) {
            if (!keys.has(item.key)) continue;
            byName.set(item.name, [...(byName.get(item.name) || []), item.note]);
        }
        if (!byName.size) return;
        void (async () => {
            for (const [name, ids] of byName) {
                if (!chatHeadUnchanged(head)) return;
                await adapter.openByEvent({ name, ids });
            }
        })();
    }

    // (v2 hidden notes) The layered notes a scan wrote for the dossiers it just built (`ids`), read from the rows the model
    // returned: 2 to 5 per person, cleaned, set once and never rewritten by a later scan. A dossier that already has notes
    // (the pack's, the reader's) keeps them. Returns how many dossiers got notes.
    function attachGeneratedSecrets(state, ids, ...sources) {
        const adapter = storySuiteV2Meters();
        if (!adapter || !Array.isArray(state?.npcs)) return 0;
        const rows = sources.flatMap(source => (Array.isArray(source?.npcs) ? source.npcs : []));
        let count = 0;
        for (const id of ids || []) {
            const npc = state.npcs.find(item => item?.id === id && !item.archived);
            if (!npc || (Array.isArray(npc.secrets) && npc.secrets.length)) continue;
            const row = rows.find(item => Array.isArray(item?.secrets) && item.secrets.length
                && (String(item.id || '') === npc.id || npcMatchesLabel(npc, String(item.name || ''))));
            let made = [];
            try { made = row ? adapter.generatedSecrets(row.secrets) : []; } catch { made = []; }
            if (!made.length) continue;
            npc.secrets = made;
            count += 1;
        }
        return count;
    }

    // (1.2.13) Why no NPC shows as present, in words, and whether a scan could change that.
    function castEmptyReason() {
        const key = getChatKey();
        if (key === 'no-chat') return { text: 'No chat is open.', scan: false };
        if (getSettings().enabled === false) return { text: 'NPC State Delta is off.', scan: false };
        const hydration = chatHydrationStatus(key);
        // (R2-5) A sidecar that could not be read is not "still loading": say so, and where to fix it
        // (the settings section's roster, the same notice the drawer shows).
        if (hydration === 'error') {
            const detach = getSettings().dataFiles?.[key]?.path ? ' or Detach Broken Sidecar' : '';
            return { text: `This chat's dossiers could not be loaded, so nothing is shown and nothing is changed. NPC State Delta's settings section has Retry Load${detach}.`, scan: false };
        }
        if (hydration !== 'ready') return { text: "This chat's dossiers are still loading.", scan: false };
        const state = getChatState(key);
        const latest = latestMessageId(true);
        if (!(state.npcs || []).some(npc => npc && !npc.archived)) {
            return { text: 'No NPC has a dossier in this chat yet, so nobody shows here even when the story or the World State names them. A scan of the latest reply makes dossiers for the NPCs in it.', scan: true };
        }
        if (latest >= 0 && !replyScanned(state, latest)) {
            return { text: 'The latest reply has not been scanned yet, so who is present is not known.', scan: true };
        }
        return { text: 'The latest scan found no NPC in the scene.', scan: true };
    }

    return { storyBlockV2Hosted, storySuiteV2Meters, scanAfterEveryReply, hostedStoryClock, hostedStoryDateAt, hostedStoryDayAt, hostedMeterView, isKeyNpc, keyReturnNotes, castList, scenePresenceView, scanScenePresent, dossierHostViews, viewNpcCopies, keyAwayScanOptions, partyLevelList, keyKeepIds, hostedReadsFailed, hostedScanState, chatHeadMark, chatHeadUnchanged, forwardRelationshipChangesToHost, hostedNotePromptOptions, hostedTargetNotes, targetNoteOptions, forwardSecretEventsToHost, forwardTastesToHost, attachGeneratedSecrets, castEmptyReason };
}
