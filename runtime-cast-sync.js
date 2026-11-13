/* NPC State Delta cast sync (role: cast-sync). Makes a dossier at once from a Story Director cast entry (no scan, no model call) and gives a
   cast dossier its pack picture when Story Block answers for it. Built by index.js once per module instance, after the dossier editor (the
   sync redraws the dossier view), so each instance keeps its own run flags. Bodies are moved from index.js without change. */

import { currentExclusions } from './src/transcript.js';
import { applyNpcStateCommand, normalizeName, normalizeNpcRecord, appearanceFingerprint } from './core.js';
import { savePortraitFile } from './storage.js';
import { portraitHasImage } from './src/portrait-file.js';
import { applyCastEntry, applyCastPortrait, castPortraitWanted, dossierFor, findCastPerson, metWithEntry } from './src/cast-dossier.js';
import { getSettings } from './runtime-settings.js';
import { normalizeSourceOfTruth } from './suite-handshake.js';
import { chatLineage, lineageCheckpointKey } from './branch.js';
import { chatContext } from './runtime-scan-helpers.js';
import { applyNpcMemories, firstMeetingCandidates } from './src/memory-fact-apply.js';
import { scanMemoryFacts } from './src/memory-fact-scan.js';
import { stampMemories } from './core-record-shared.js';
import { storyDateTextAt } from './calendar.js';

// (ONEPASSCAPR2-2) Keep the admission values until the host's meeting step can answer. A later manual edit or scan wins over this seed.
const SEED_FIELDS = ['aliases', 'role', 'overallAppearance', 'appearance', 'unclassifiedAppearance', 'appearanceForms', 'currentForm', 'currentFormUnknown', 'speech', 'personality', 'background', 'behaviorProfile', 'mannerisms', 'relationshipSummary', 'homeBase', 'goal', 'location', 'customFields', 'species', 'gender', 'age', 'apparentAge', 'birthDate', 'birthDateSource', 'birthDateReason', 'birthDatePrecision', 'birthDateYearSource', 'relationship', 'meterSetup', 'secrets'];
const seedValues = npc => Object.fromEntries(SEED_FIELDS.map(field => [field, structuredClone(npc[field] ?? null)]));
const sameSeedValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export function rememberCastAdmissions(state, ids, messageId, lineage) {
    if (!ids.length || !Number.isInteger(messageId)) return;
    state.castSeedPending = { ...(state.castSeedPending || {}) };
    for (const npc of state.npcs || []) if (ids.includes(npc.id)) state.castSeedPending[npc.id] = {
        messageId, lineageKey: lineageCheckpointKey(lineage, messageId), values: seedValues(npc),
    };
}
export function seedCastAdmission(state, npc, person, options = {}) {
    const pending = state.castSeedPending?.[npc?.id];
    if (!pending || !person?.entry) return null;
    const seeded = applyCastEntry(npc, person, options);
    if (!seeded) return null;
    const locked = new Set(npc.manualProfileFields || []);
    for (const field of SEED_FIELDS) {
        const group = ['overallAppearance', 'unclassifiedAppearance', 'appearanceForms', 'currentForm', 'currentFormUnknown'].includes(field) ? 'appearance' : field;
        if (locked.has(group) || !sameSeedValue(npc[field], pending.values[field])) {
            if (Object.hasOwn(npc, field)) seeded[field] = npc[field]; else delete seeded[field];
        }
    }
    if (!locked.has('secrets') && sameSeedValue(npc.secrets, pending.values.secrets)) seeded.secrets = person.entry.secrets || [];
    if (!locked.has('appearance') && person.entry.look && sameSeedValue(npc.overallAppearance, pending.values.overallAppearance)
        && sameSeedValue(npc.appearance, pending.values.appearance)) {
        seeded.appearance = person.entry.wears || '';
        seeded.unclassifiedAppearance = '';
        seeded.appearanceForms = [];
        seeded.currentForm = '';
        seeded.currentFormUnknown = false;
    }
    delete state.castSeedPending[npc.id];
    if (!Object.keys(state.castSeedPending).length) delete state.castSeedPending;
    return normalizeNpcRecord(seeded);
}
export function advanceCastAdmission(state, before, after) {
    const pending = state.castSeedPending?.[before?.id];
    if (!pending || !after) return;
    const locked = new Set(before.manualProfileFields || []);
    for (const field of SEED_FIELDS) if (!locked.has(field) && sameSeedValue(before[field], pending.values[field])) {
        pending.values[field] = structuredClone(after[field] ?? null);
    }
}

export function createCastSyncPart(rt, deps) {
    const { castList, chatHeadMark, chatHeadUnchanged, chatHydrationStatus, commitBranchCheckpoint, ensureFreshMutationBoundary, getChatKey, getChatState, latestMessageId, persistCritical, renderDossier, requestHeaders, setChatState, storySuiteV2Meters, updateInjection } = deps;
    const { castPortraitMisses } = rt;

    // (v2, the living cast) Delta reads Story Director's `director.cast` and Story Block's `packs.portrait` (never writes to them). At
    // the first meeting it makes the person's dossier at once from the pack entry: no scan, no model call. The step (npc.tick,
    // src/npc-meters.js observeCast) records the meeting in the saved slice at that reply; this makes the dossier and commits a
    // branch checkpoint at the reply, so a swipe or a delete takes it back with the reply (as a manual add does). Nothing here
    // without a host or without a Story Director that answers `director.cast`. Rules: src/cast-dossier.js.
    // The same sync gives a cast dossier made while its picture was missing the picture once `packs.portrait` answers for it (see
    // castPortraitTargets): when the step ends, the host's head moves, the host accepts Delta, the Dossiers tab is drawn or a chat opens.
    let castSyncRunning = false;
    // The picture's size in pixels ({ width, height }) when the browser can say, else null.
    function portraitImageSize(dataUrl) {
        return new Promise(resolve => {
            if (typeof Image !== 'function') { resolve(null); return; }
            const image = new Image();
            const timer = setTimeout(() => resolve(null), 3000);
            image.onload = () => { clearTimeout(timer); resolve(image.naturalWidth > 0 && image.naturalHeight > 0 ? { width: image.naturalWidth, height: image.naturalHeight } : null); };
            image.onerror = () => { clearTimeout(timer); resolve(null); };
            image.src = dataUrl;
        });
    }
    // A pack portrait as the dossier's portrait record from its safe image URL, or null. Story Block keeps a cast portrait up to 150 KB and
    // 1200 px, so there is no re-compression: a data: URL is kept as it is, anything else is fetched once. The picture is saved ONCE as its own
    // user file named by its content (storage.js savePortraitFile: written only when absent) and the record is { path, type, hash, width?, height?,
    // sourceName, updatedAt }: the chat's state never holds the picture, and the file outlives the pack. When the file cannot be written the record
    // keeps the picture itself ({ dataUrl, … }) exactly as before.
    async function castPortraitRecord(url, fileName) {
        try {
            let dataUrl = String(url || '');
            if (!/^data:/i.test(dataUrl)) {
                const controller = typeof AbortController === 'function' ? new AbortController() : null;
                const timer = controller ? setTimeout(() => controller.abort(), 8000) : null;
                try {
                    const response = await fetch(dataUrl, controller ? { signal: controller.signal } : undefined);
                    if (!response?.ok) return null;
                    const blob = await response.blob();
                    if (!/^image\/(?:png|jpeg|webp)$/i.test(String(blob?.type || '')) || blob.size > 256 * 1024) return null;
                    dataUrl = await new Promise(resolve => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(String(reader.result || ''));
                        reader.onerror = () => resolve('');
                        reader.readAsDataURL(blob);
                    });
                } finally {
                    if (timer) clearTimeout(timer);
                }
            }
            if (!/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(dataUrl) || dataUrl.length > 400_000) return null;
            const own = { sourceName: String(fileName || '').slice(0, 120), updatedAt: Date.now() };
            const filed = await savePortraitFile(dataUrl, { headers: requestHeaders() });
            if (filed) return { ...filed, ...(await portraitImageSize(dataUrl) ?? {}), ...own };
            return { dataUrl, mime: dataUrl.slice(5, dataUrl.indexOf(';')), ...own };
        } catch {
            return null;
        }
    }
    // Whether the reader removed this person's dossier before (their name is in the dismissed groups).
    function castPersonDismissed(state, person) {
        const labels = new Set([person.name, person.entry?.name, ...(person.aliases || [])].map(normalizeName).filter(Boolean));
        return (state?.userDismissedGroups || []).some(group => (group?.labels || []).some(label => labels.has(label)));
    }

    function castDue(state, adapter) {
        const people = castList();
        if (!Array.isArray(people) || !people.length) return [];
        const made = adapter.castMade?.() ?? {};
        return metWithEntry(people).filter(person => {
            if (!Object.hasOwn(made, person.key) || castPersonDismissed(state, person)) return false;
            const matches = (state.npcs || []).filter(npc => dossierFor([npc], person));
            if (!matches.length) return true;
            const pending = matches.length === 1 && state.castSeedPending?.[matches[0].id];
            return Boolean(pending && pending.messageId === latestMessageId(true) && metWithEntry(people).filter(other => dossierFor([matches[0]], other)).length === 1
                && pending.lineageKey === lineageCheckpointKey(chatLineage(chatContext().chat || []), pending.messageId));
        });
    }
    // The cast dossiers that may be given the pack's picture now (src/cast-dossier.js castPortraitWanted: made from the cast, no portrait of
    // their own, none removed on purpose) and for whom Story Block's `packs.portrait` now answers for their entry's `portrait`:
    // [{ npc, person, url, file }]. A picture that could not be read is not asked for again in this session (castPortraitMisses).
    function castPortraitTargets(state, adapter, key = getChatKey()) {
        const wanting = (state?.npcs || []).filter(castPortraitWanted);
        if (!wanting.length) return [];
        const people = metWithEntry(castList());
        const targets = [];
        for (const npc of wanting) {
            const person = findCastPerson(people, npc.castFrom.key);
            const file = person?.entry?.portrait;
            const url = file ? adapter.packPortraitUrl?.(person.pack, file) : null;
            if (url && !castPortraitMisses.has(`${key}|${npc.id}|${url}`)) targets.push({ npc, person, url, file });
        }
        return targets;
    }
    // Whether the sync has a picture to give a cast dossier (a cheap look, no wait): the adapter asks before it runs the sync for this alone.
    function castPortraitDue() {
        try {
            const adapter = storySuiteV2Meters();
            const key = getChatKey();
            if (!adapter || getSettings().enabled === false || !key || key === 'no-chat' || chatHydrationStatus(key) !== 'ready') return false;
            return castPortraitTargets(getChatState(key), adapter, key).length > 0;
        } catch {
            return false;
        }
    }
    // One run at a time. A call that comes while one is running (the step ends while a picture is being read) is not lost: the run goes round once more.
    let castSyncAgain = false;
    async function castSync() {
        if (castSyncRunning) { castSyncAgain = true; return false; }
        castSyncRunning = true;
        let any = false;
        try {
            do {
                castSyncAgain = false;
                if (await castSyncOnce()) any = true;
            } while (castSyncAgain);
        } finally {
            castSyncRunning = false;
        }
        return any;
    }
    async function castSyncOnce() {
        const adapter = storySuiteV2Meters();
        if (!adapter || getSettings().enabled === false) return false;
        const key = getChatKey();
        if (!key || key === 'no-chat' || chatHydrationStatus(key) !== 'ready') return false;
        if (!castDue(getChatState(key), adapter).length && !castPortraitTargets(getChatState(key), adapter, key).length) return false;
        const mark = chatHeadMark();
        const names = adapter.packNames?.() ?? {};
        const portraits = new Map();
        for (const person of castDue(getChatState(key), adapter)) {
            const url = person.entry.portrait ? adapter.packPortraitUrl?.(person.pack, person.entry.portrait) : null;
            if (url) portraits.set(person.key, await castPortraitRecord(url, person.entry.portrait));
        }
        // A cast dossier made while its picture was missing (the pack imported without pictures) gets it once the pack answers for it.
        const pictures = new Map();
        for (const target of castPortraitTargets(getChatState(key), adapter, key)) {
            const record = await castPortraitRecord(target.url, target.file);
            if (record) pictures.set(target.npc.id, { url: target.url, record });
            else castPortraitMisses.add(`${key}|${target.npc.id}|${target.url}`);
        }
        // The same checks as any other change to the dossiers, after the waits: the chat and its head are still the ones asked about.
        if (!await ensureFreshMutationBoundary('make dossiers from the cast', key, { notify: false })) return false;
        if (getChatKey() !== key || !chatHeadUnchanged(mark)) return false;
        const settings = getSettings();
        const messageId = latestMessageId(true);
        let working = getChatState(key);
        const made = [];
        for (const person of castDue(working, adapter)) {
            const existing = dossierFor(working.npcs, person);
            if (existing && working.castSeedPending?.[existing.id]) {
                const seeded = seedCastAdmission(working, existing, person, { packName: names[person.pack] ?? '', calendarOwn: normalizeSourceOfTruth(settings.sourceOfTruth).calendar === 'mine' });
                if (seeded) { working.npcs = working.npcs.map(npc => npc.id === seeded.id ? seeded : npc); made.push(seeded); }
                continue;
            }
            const added = applyNpcStateCommand(working, { action: 'add', name: person.entry.name || person.name }, {
                maxNpcs: settings.maxNpcs, excludeNames: currentExclusions(), turn: working.turn, relationshipBaseline: settings.relationshipBaseline,
            });
            if (added.report.status !== 'added') continue;
            const base = added.state.npcs.find(npc => npc.id === added.report.npcId);
            const portrait = portraits.get(person.key) ?? null;
            const filled = base ? applyCastEntry(base, person, { packName: names[person.pack] ?? '', portrait, calendarOwn: normalizeSourceOfTruth(settings.sourceOfTruth).calendar === 'mine' }) : null;
            if (!filled) continue;
            // (first meeting) The person was met at this reply (Story Director's answer): the dossier made here has never been present, so the fact is hers too.
            const facts = scanMemoryFacts(working, settings, chatLineage(chatContext().chat || []), messageId, chatContext().name1, { hosted: true });
            const meeting = firstMeetingCandidates(base, { ...filled, present: true, location: person.met?.where || filled.location }, { facts, R: messageId, player: facts?.player });
            if (meeting.length) {
                // (memory dates) `met.on` is story minutes, never text: the date is the first-meeting reply's own story date, the same words every other
                // automatic memory carries (a string `on` from an older host is kept as given).
                const metOn = typeof person.met?.on === 'string' ? person.met.on.trim().slice(0, 40) : '';
                const metDate = metOn || storyDateTextAt(messageId);
                if (metDate) meeting[0].date = metDate;
                applyNpcMemories(filled, filled, {}, { candidates: meeting });
                filled.memoryStamps = stampMemories(filled, filled, messageId, () => metDate);
            }
            const record = normalizeNpcRecord(filled);
            if (portraitHasImage(record.portrait)) {
                const fingerprint = appearanceFingerprint(record);
                if (fingerprint) record.portrait = { ...record.portrait, appearanceFingerprint: fingerprint };
                // A file-form portrait is kept once, in the dossier; only a picture held in the record gets its portraitAssets copy.
                if (record.portrait.dataUrl) added.state.portraitAssets = { ...(added.state.portraitAssets || {}), [record.id]: structuredClone(record.portrait) };
            }
            added.state.npcs = added.state.npcs.map(npc => (npc.id === record.id ? record : npc));
            working = added.state;
            made.push(record);
        }
        // The pictures: only a dossier that still has none, still of the cast, whose picture was read for the address the pack gives now.
        const given = [];
        for (const target of castPortraitTargets(working, adapter, key)) {
            const got = pictures.get(target.npc.id);
            if (!got || got.url !== target.url) continue;
            const fingerprint = appearanceFingerprint(target.npc);
            const portrait = fingerprint ? { ...got.record, appearanceFingerprint: fingerprint } : got.record;
            const next = applyCastPortrait(target.npc, portrait);
            if (next === target.npc) continue;
            if (next.portrait.dataUrl) working.portraitAssets = { ...(working.portraitAssets || {}), [next.id]: structuredClone(next.portrait) };
            working.npcs = working.npcs.map(npc => (npc.id === next.id ? next : npc));
            given.push(next.id);
        }
        if (!made.length && !given.length) { if (pictures.size) renderDossier(); return false; } // a same-file repair changes no state, but the blank picture is drawn again
        if (messageId >= 0 && made.length) commitBranchCheckpoint(working, messageId, 'cast-dossier');
        else if (messageId >= 0) commitBranchCheckpoint(working, messageId, 'cast-portrait');
        setChatState(key, working);
        persistCritical(key);
        renderDossier();
        if (made.length) updateInjection();
        return true;
    }

    return { castPortraitDue, castSync };
}
