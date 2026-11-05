/* NPC State Delta scoped manual mutations (role: scoped-manual-mutations). The single-dossier changes a person makes by hand:
   appearance, life state, portrait set/seed/remove, delete, archive and restore, manual add, and the export/import bundle with its
   portrait files. Built by index.js once per module instance with the shared runtime state and the controller functions it calls.
   Bodies are moved from index.js without change. */

import { currentExclusions } from './src/transcript.js';
import { NPC_STATE_VERSION, applyNpcStateCommand, isTerminalNpcDeath, manualLifeStateRecord, normalizeName, normalizeNpcRecord, setNpcArchived, normalizePortraitSeed, appearanceDraftRecord, appearanceFingerprint, formPortraitKey, normalizeFormPortraitAssets } from './core.js';
import { encodeNpcStateBundle, mergeImportedDossierState } from './bundle.js';
import { decodeDeltaNativeBundle, nativeStateForTarget } from './native-transfer.js';
import { addUserDismissedGroup } from './branch.js';
import { reconcileSocialState, removeNpcFromSocialGraph, purgeNpcStructuredReferences } from './social.js';
import { readPortraitFileDataUrl, savePortraitFile } from './storage.js';
import { isPortraitFileRecord } from './src/portrait-file.js';
import { markCastPortraitRemoved } from './src/cast-dossier.js';
import { getSettings } from './runtime-settings.js';

export function createMutationsPart(rt, deps) {
    const { clearUserDismissedSuppression, closeNpcEditor, commitBranchCheckpoint, editorIsMounted, ensureFreshMutationBoundary, ensureHydratedStateFresh, getChatKey, getChatState, hydratedRevision, latestMessageId, ownershipEpoch, ownershipEpochCurrent, persistCritical, persistCriticalDurable, purgeInlineCardsInState, recordFreshnessEvent, renderDossier, requestHeaders, requireReadyChatMutation, setChatState, stampManualEdit, updateInjection, workingCopyAdoption } = deps;
    const { hydratedStateMeta, stateVersions, portraitActions } = rt;

    function updateNpcAppearance(npcId, draft, { chatKey, lockAppearance = false } = {}) {
        if (!chatKey || chatKey !== getChatKey() || !requireReadyChatMutation('edit appearance forms', chatKey)) return false;
        // The appearance draft lives in the dossier editor; like its main Save, it must not overwrite a
        // newer server copy adopted after the editor opened.
        if (editorIsMounted() && rt.activeEditorChatKey === chatKey && rt.activeEditorBaseRevision !== null
            && Number(rt.activeEditorBaseRevision) !== workingCopyAdoption(chatKey)) {
            globalThis.toastr?.warning?.('NPC State Delta: this editor was opened on an older server revision. The appearance draft was not applied; review the newly loaded dossier and reopen the editor.');
            return false;
        }
        const state = getChatState(chatKey);
        const index = state.npcs.findIndex(item => item.id === String(npcId || ''));
        if (index < 0) return false;
        const before = state.npcs[index];
        const next = appearanceDraftRecord(before, draft, { lockAppearance });
        // The appearance lock comes from the editor's protect checkbox: the reader's explicit choice.
        next.manualProfileLocksExplicit = true;
        next.updatedAt = Date.now();
        state.npcs[index] = stampManualEdit(state, normalizeNpcRecord(next), before);
        const messageId = latestMessageId(false);
        if (messageId >= 0) commitBranchCheckpoint(state, messageId, 'manual-edit');
        persistCritical(chatKey);
        renderDossier();
        updateInjection();
        return true;
    }

    function updateNpcLifeState(npcId, choice, { chatKey } = {}) {
        if (!chatKey || chatKey !== getChatKey() || !['alive', 'unknown', 'deceased'].includes(choice)
            || !requireReadyChatMutation('edit life state', chatKey)) return false;
        const state = getChatState(chatKey);
        const index = state.npcs.findIndex(npc => npc.id === String(npcId || ''));
        if (index < 0) return false;
        const current = state.npcs[index];
        const correctingDeath = isTerminalNpcDeath(current) && choice !== 'deceased';
        const messageId = latestMessageId(false);
        const corrected = correctingDeath ? setNpcArchived(current, false, {
            allowDeathCorrection: true, sourceMessageId: messageId,
        }) : current;
        state.npcs[index] = stampManualEdit(state, normalizeNpcRecord(manualLifeStateRecord(corrected, choice)), current);
        if (messageId >= 0) commitBranchCheckpoint(state, messageId, correctingDeath ? 'manual-death-correction' : 'manual-life-state');
        persistCritical(chatKey);
        renderDossier();
        updateInjection();
        return true;
    }

    function portraitAction(chatKey, npcId) {
        const key = `${chatKey}::${npcId}`;
        const action = {};
        portraitActions.set(key, action);
        return { key, action };
    }

    function npcFormName(npc, form) {
        const key = formPortraitKey(form);
        if (!key) return '';
        return (Array.isArray(npc?.appearanceForms) ? npc.appearanceForms : []).find(item => formPortraitKey(item?.name) === key)?.name || '';
    }

    async function setNpcPortrait(npcId, file, { chatKey, isCurrent = () => true, generatedFrom = '', form = '' } = {}) {
        if (!chatKey || chatKey !== getChatKey() || !isCurrent() || !await ensureFreshMutationBoundary('attach a portrait', chatKey)) return false;
        const originCanonicalRevision = hydratedRevision(chatKey);
        const npc = getChatState(chatKey).npcs.find(item => item.id === String(npcId || ''));
        if (!npc || !file) return false;
        const targetForm = form ? npcFormName(npc, form) : '';
        if (form && !targetForm) throw new Error(`${npc.name} has no appearance form named "${form}".`);
        if (!/^image\/(?:png|jpeg|webp|gif|avif|bmp)$/i.test(String(file.type || '')) || file.size > 16 * 1024 * 1024) {
            throw new Error('Choose a PNG, JPEG, WebP, GIF, AVIF or BMP image no larger than 16 MB.');
        }
        const originChatKey = chatKey;
        const originRevision = Number(stateVersions.get(originChatKey) || 0);
        const epoch = ownershipEpoch(chatKey);
        const { key, action } = portraitAction(chatKey, npc.id);
        try {
            const portrait = await compressPortrait(file);
            try { await ensureHydratedStateFresh(chatKey, { reason: 'portrait-commit' }); } catch { return false; }
            if (portraitActions.get(key) !== action || !isCurrent() || getChatKey() !== chatKey
                || !ownershipEpochCurrent(chatKey, epoch) || Number(stateVersions.get(chatKey) || 0) !== originRevision
                || hydratedRevision(chatKey) !== originCanonicalRevision
                || !requireReadyChatMutation('attach a portrait', chatKey)) {
                recordFreshnessEvent(chatKey, 'stale-operation-rejected', {
                    reason: 'portrait-commit',
                    hydratedRevision: originCanonicalRevision,
                    serverRevision: hydratedStateMeta.get(chatKey)?.latestObservedServerRevision ?? hydratedRevision(chatKey),
                    dirty: false,
                });
                return false;
            }
            const live = getChatState(chatKey).npcs.find(item => item.id === npc.id);
            if (!live) return false;
            if (generatedFrom) portrait.generatedFrom = String(generatedFrom);
            if (targetForm) {
                // A form portrait is an extra user-owned asset for that named form; the main portrait
                // and the canonical dossier record are left unchanged.
                const liveForm = npcFormName(live, targetForm);
                if (!liveForm) return false;
                const fingerprint = appearanceFingerprint(live, { form: liveForm });
                if (fingerprint) portrait.appearanceFingerprint = fingerprint;
                portrait.appearanceForm = liveForm;
                portrait.form = liveForm;
                const state = getChatState(chatKey);
                state.formPortraitAssets = normalizeFormPortraitAssets(state.formPortraitAssets);
                const forms = { ...(state.formPortraitAssets[live.id] || {}) };
                const key = formPortraitKey(liveForm);
                if (!forms[key] && Object.keys(forms).length >= 8) {
                    // Images for forms that were renamed or removed from this dossier give way first.
                    for (const existing of Object.keys(forms)) if (!npcFormName(live, forms[existing]?.form || existing)) delete forms[existing];
                }
                if (!forms[key] && Object.keys(forms).length >= 8) throw new Error('Each NPC can keep at most 8 form portraits.');
                forms[key] = portrait;
                state.formPortraitAssets[live.id] = forms;
                persistCritical(chatKey);
                renderDossier();
                return true;
            }
            const fingerprint = appearanceFingerprint(live);
            if (fingerprint) portrait.appearanceFingerprint = fingerprint;
            portrait.appearanceForm = String(live.currentForm || '').slice(0, 120);
            live.portrait = portrait;
            getChatState(chatKey).portraitAssets[live.id] = structuredClone(portrait);
            live.updatedAt = Date.now();
            persistCritical(chatKey);
            renderDossier();
            return true;
        } finally {
            if (portraitActions.get(key) === action) portraitActions.delete(key);
        }
    }

    function setNpcPortraitSeed(npcId, seed, { chatKey, isCurrent = () => true } = {}) {
        // Runs after the freshness wait: a workflow the user closed meanwhile must not still mutate.
        if (!isCurrent()) return false;
        if (!chatKey || chatKey !== getChatKey() || !requireReadyChatMutation('edit portrait seed', chatKey)) return false;
        const npc = getChatState(chatKey).npcs.find(item => item.id === String(npcId || ''));
        if (!npc) return false;
        const raw = seed === null || seed === undefined ? '' : String(seed).trim();
        const normalized = normalizePortraitSeed(seed);
        if (raw && normalized === null) throw new Error('Portrait seed must be a whole number from 0 to 9007199254740991, or blank for SillyTavern default/random behavior.');
        npc.portraitSeed = normalized;
        npc.updatedAt = Date.now();
        persistCritical(chatKey);
        renderDossier();
        return true;
    }

    function removeNpcPortrait(npcId, { chatKey, form = '' } = {}) {
        if (!chatKey || chatKey !== getChatKey() || !requireReadyChatMutation('remove a portrait', chatKey)) return false;
        const npc = getChatState(chatKey).npcs.find(item => item.id === String(npcId || ''));
        if (!npc) return false;
        // Invalidate a prior decode even when there was no portrait to remove yet.
        portraitActions.delete(`${chatKey}::${npc.id}`);
        if (form) {
            const state = getChatState(chatKey);
            const key = formPortraitKey(form);
            const forms = { ...(state.formPortraitAssets?.[npc.id] || {}) };
            if (!key || !forms[key]) return false;
            delete forms[key];
            if (Object.keys(forms).length) state.formPortraitAssets[npc.id] = forms;
            else delete state.formPortraitAssets[npc.id];
            persistCritical(chatKey);
            renderDossier();
            return true;
        }
        npc.portrait = null;
        // A cast dossier remembers the removal: the pack's picture is not put back (castSync fills only a portrait nobody removed).
        const marked = markCastPortraitRemoved(npc);
        if (marked !== npc) npc.castFrom = marked.castFrom;
        delete getChatState(chatKey).portraitAssets[npc.id];
        npc.updatedAt = Date.now();
        persistCritical(chatKey);
        renderDossier();
        return true;
    }

    function deleteNpcById(npcId, { confirmAction = true } = {}) {
        const id = String(npcId || '').trim();
        if (!id || !requireReadyChatMutation('delete a dossier')) return false;
        const settings = getSettings();
        const state = getChatState();
        const current = state.npcs.find(item => item.id === id);
        if (!current) return false;
        if (confirmAction) {
            const message = `Delete ${current.name}? This permanently removes this dossier and prevents older branch snapshots from restoring this identity. A genuinely different future NPC with the same name remains trackable.`;
            if (!window.confirm(message)) return false;
        }

        const result = applyNpcStateCommand(state, { action: 'remove', name: current.name, npcId: id }, {
            maxNpcs: settings.maxNpcs,
            excludeNames: currentExclusions(),
            turn: state.turn,
            relationshipBaseline: settings.relationshipBaseline,
        });
        const working = result.state;
        if (result.report.status !== 'removed') return false;
        // The shared add/remove helper suppresses by label. Manual UI trash is
        // identity-specific instead: remove those labels from narrative dismissal and retain an
        // ID-backed tombstone so a future homonym is not blocked.
        const permanentLabels = new Set([current.name, ...(current.aliases || [])].map(normalizeName).filter(Boolean));
        working.dismissed = (Array.isArray(working.dismissed) ? working.dismissed : [])
            .filter(label => !permanentLabels.has(normalizeName(label)));
        working.userDismissedGroups = addUserDismissedGroup(state.userDismissedGroups, current);
        working.socialGraph = removeNpcFromSocialGraph(working.socialGraph, current.id);
        purgeNpcStructuredReferences(working.npcs, current);
        const socialAfterDelete = reconcileSocialState(working, { provenance: 'manual', confidence: 'manual' });
        working.socialGraph = socialAfterDelete.socialGraph;
        working.npcs = socialAfterDelete.state.npcs;
        purgeInlineCardsInState(working, result.report.npcId, result.report.name);
        const reportKey = normalizeName(result.report.name);
        working.pendingBackfills = (working.pendingBackfills || []).filter(item => item.npcId !== result.report.npcId && normalizeName(item.label) !== reportKey);
        if (working.portraitAssets && typeof working.portraitAssets === 'object') delete working.portraitAssets[current.id];
        if (working.formPortraitAssets && typeof working.formPortraitAssets === 'object') delete working.formPortraitAssets[current.id];
        const targetMessageId = latestMessageId(false);
        if (targetMessageId >= 0) commitBranchCheckpoint(working, targetMessageId, 'manual-delete');
        const deleteKey = getChatKey();
        setChatState(deleteKey, working);
        closeNpcEditor();
        renderDossier();
        updateInjection();
        // The deletion is applied now; completion is announced only once the server holds it.
        reportDurableOutcome(deleteKey,
            `NPC State Delta: deleted ${result.report.name}; older branch snapshots cannot restore that identity.`,
            `NPC State Delta: ${result.report.name} was removed in this browser, but the deletion could not be saved to the server yet. It will be retried; the server copy still contains the dossier until then.`);
        return true;
    }

    // Announce a manual lifecycle change only after its sidecar write completes, and say plainly when
    // it is applied locally but not yet on the server (the pending write keeps retrying/recovering).
    function reportDurableOutcome(key, successMessage, pendingMessage) {
        void persistCriticalDurable(key).then(saved => {
            if (saved) globalThis.toastr?.success?.(successMessage);
            else globalThis.toastr?.warning?.(pendingMessage);
        });
    }

    function setNpcArchiveStateById(npcId, archived, { reason = 'manual', confirmAction = true } = {}) {
        if (!requireReadyChatMutation(archived ? 'archive a dossier' : 'restore a dossier')) return false;
        const state = getChatState();
        const index = state.npcs.findIndex(item => item.id === npcId);
        if (index < 0) return false;
        const current = state.npcs[index];
        const correctingDeath = !archived && isTerminalNpcDeath(current);
        if (Boolean(current.archived) === Boolean(archived) && !correctingDeath) return false;
        if (confirmAction) {
            const message = archived
                ? `Archive ${current.name}? The dossier, portrait, history, and relationship state will be preserved, but it will stop receiving inline cards and prompt injection until restored or clearly returned in the story.`
                : (correctingDeath
                    ? `Correct ${current.name}'s death record as erroneous? This is a manual correction, not narrative resurrection. The NPC will remain off-screen until new evidence establishes presence.`
                    : `Restore ${current.name} to the active roster?`);
            if (!window.confirm(message)) return false;
        }
        state.npcs[index] = setNpcArchived(current, archived, {
            reason: archived ? reason : '',
            allowDeathCorrection: correctingDeath,
            sourceMessageId: latestMessageId(false),
        });
        const targetMessageId = latestMessageId(false);
        if (targetMessageId >= 0) commitBranchCheckpoint(state, targetMessageId, archived ? 'manual-archive' : (correctingDeath ? 'manual-death-correction' : 'manual-restore'));
        closeNpcEditor();
        renderDossier();
        updateInjection();
        reportDurableOutcome(getChatKey(),
            archived
                ? `NPC State Delta: archived ${current.name}. Their dossier and history are preserved.`
                : (correctingDeath ? `NPC State Delta: corrected ${current.name}'s erroneous death record; presence remains unconfirmed.` : `NPC State Delta: restored ${current.name} to the active roster.`),
            `NPC State Delta: the change to ${current.name} is applied in this browser but could not be saved to the server yet. It will be retried; the server copy is unchanged until then.`);
        return true;
    }

    async function compressPortrait(file) {
        if (!file || !file.type?.startsWith('image/')) throw new Error('Choose an image file.');
        const source = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Could not read image.'));
            reader.readAsDataURL(file);
        });
        const image = await new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('Could not decode image.'));
            img.src = source;
        });
        if (!Number.isFinite(image.width) || !Number.isFinite(image.height) || image.width <= 0 || image.height <= 0) throw new Error('Could not decode image dimensions.');
        // Keep enough source resolution for the full-screen dossier viewer and high-DPI mobile/tablet displays.
        // The old 512 px cap looked acceptable in roster thumbnails but became visibly pixelated when expanded.
        const maxSide = 1536;
        const maxDataUrlLength = 1_600_000;
        const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('Image processing is unavailable in this browser.');
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, 0, 0, canvas.width, canvas.height);

        const encode = quality => {
            let value = canvas.toDataURL('image/webp', quality);
            if (!value.startsWith('data:image/webp')) value = canvas.toDataURL('image/jpeg', quality);
            return value;
        };

        let dataUrl = encode(0.88);
        // Prefer preserving pixels. Only lower quality if an unusually complex portrait exceeds the bounded state-file budget.
        for (const quality of [0.84, 0.80, 0.76, 0.72, 0.68]) {
            if (dataUrl.length <= maxDataUrlLength) break;
            dataUrl = encode(quality);
        }
        if (dataUrl.length > maxDataUrlLength) {
            throw new Error('Portrait is still too large after high-resolution compression. Try a smaller image.');
        }
        return {
            dataUrl,
            mime: dataUrl.slice(5, dataUrl.indexOf(';')),
            sourceName: file.name,
            width: canvas.width,
            height: canvas.height,
            updatedAt: Date.now(),
        };
    }


    // (cast portraits) A dossier whose portrait is a file carries the picture in an export: it is read back and put in the bundle as the data
    // the bundle format always held (its hash and type stay as the mark that it was a file). A file that is gone leaves the normal no-portrait look.
    async function withPortraitFilesInlined(npcs) {
        return Promise.all((npcs || []).map(async npc => {
            if (!isPortraitFileRecord(npc?.portrait)) return npc;
            const dataUrl = await readPortraitFileDataUrl(npc.portrait);
            if (!dataUrl) return { ...npc, portrait: null };
            const { path, ...rest } = npc.portrait;
            return { ...npc, portrait: { ...rest, dataUrl, mime: npc.portrait.type } };
        }));
    }
    // (cast portraits) The reverse, on import: a portrait the bundle marks as a file (hash and type with its picture) is written as the same
    // content-named file when it is absent and kept as the file record. Any other portrait (an upload, a generated one, an older bundle) stays as it
    // was; so does one whose file cannot be written.
    async function withPortraitFilesFromBundle(npcs) {
        return Promise.all((npcs || []).map(async npc => {
            const portrait = npc?.portrait;
            if (!portrait?.dataUrl || !portrait.hash || !portrait.type) return npc;
            const filed = await savePortraitFile(portrait.dataUrl, { headers: requestHeaders() });
            if (!filed) return npc;
            const { dataUrl, mime, binary, ...rest } = portrait;
            return { ...npc, portrait: { ...rest, ...filed } };
        }));
    }

    async function exportBundleBytes() {
        if (!requireReadyChatMutation('export a dossier', getChatKey(), { notify: false })) throw new Error('NPC State Delta chat dossier is not loaded.');
        const state = getChatState();
        const key = getChatKey();
        const npcs = await withPortraitFilesInlined(state.npcs);
        if (getChatKey() !== key) throw new Error('The active chat changed before export; nothing was exported.');
        return encodeNpcStateBundle({ ...state, npcs }, {
            appVersion: NPC_STATE_VERSION,
            chatKey: key,
        });
    }

    async function importBundleBytes(bytes) {
        if (!requireReadyChatMutation('import a dossier')) throw new Error('NPC State Delta chat dossier is not loaded.');
        const settings = getSettings();
        const decoded = decodeDeltaNativeBundle(bytes);
        const targetChatKey = getChatKey();
        if (Array.isArray(decoded.state?.npcs)) decoded.state.npcs = await withPortraitFilesFromBundle(decoded.state.npcs);
        if (getChatKey() !== targetChatKey) throw new Error('The active chat changed before import; nothing was imported.');
        const foreignOwnership = decoded.metadata.sourceChatKey !== targetChatKey;
        decoded.state = nativeStateForTarget(decoded, targetChatKey);
        const before = getChatState();
        const importReport = {};
        const merged = mergeImportedDossierState(before, decoded.state, {
            maxNpcs: settings.maxNpcs,
            excludeNames: currentExclusions(),
            report: importReport,
            foreignOwnership,
        });
        // Only an actually accepted import can deliberately resurrect an ID-backed deleted
        // identity. Capacity/exclusion/duplicate skips must not weaken tombstones.
        for (const accepted of importReport.accepted || []) {
            clearUserDismissedSuppression(merged, { id: accepted.id, name: accepted.name });
        }
        if (!merged.portraitAssets || typeof merged.portraitAssets !== 'object') merged.portraitAssets = {};
        for (const npc of merged.npcs) if (npc.portrait?.dataUrl) merged.portraitAssets[npc.id] = structuredClone(npc.portrait);
        // (timeline participant) A chat with no story line yet takes the bundle's (its dossiers keep their np_ ids); one that has its own keeps it.
        // A bundle from another chat is a copy of the story, not the same line of it: it keeps its np_ ids and gets a lineage of its own (the participant makes it).
        if (!before.timeline?.lineage && decoded.state.timeline && typeof decoded.state.timeline === 'object') {
            merged.timeline = structuredClone(decoded.state.timeline);
            if (foreignOwnership) merged.timeline.lineage = null;
        }
        const socialImport = reconcileSocialState(merged, { provenance: 'migration', confidence: 'migration' });
        merged.socialGraph = socialImport.socialGraph;
        merged.npcs = socialImport.state.npcs;
        const targetMessageId = latestMessageId(false);
        if (targetMessageId >= 0) commitBranchCheckpoint(merged, targetMessageId, 'import');
        setChatState(getChatKey(), merged);
        persistCritical();
        renderDossier();
        updateInjection();
        return { decoded, merged, importReport };
    }

    // The panel's Add NPC and (1.2.13) the Dossiers tab's: ask a name, add a dossier for it.
    async function addNpcManually() {
        if (!await ensureFreshMutationBoundary('add an NPC')) return;
        const settings = getSettings();
        const state = getChatState();
        if (state.npcs.filter(npc => !npc?.archived).length >= settings.maxNpcs) return globalThis.toastr?.warning?.(`NPC State Delta: active roster cap is ${settings.maxNpcs}. Archived dossiers do not count.`);
        const name = window.prompt('NPC name to add to this chat dossier:')?.trim();
        if (!name) return;
        const result = applyNpcStateCommand(state, { action: 'add', name }, {
            maxNpcs: settings.maxNpcs,
            excludeNames: currentExclusions(),
            turn: state.turn,
            relationshipBaseline: settings.relationshipBaseline,
        });
        if (result.report.status === 'excluded') return globalThis.toastr?.warning?.('NPC State Delta: player/main character cannot be added as an NPC.');
        if (result.report.status === 'full') return globalThis.toastr?.warning?.(`NPC State Delta: active roster cap is ${settings.maxNpcs}. Archived dossiers do not count.`);
        if (['added', 'exists', 'restored'].includes(result.report.status)) clearUserDismissedSuppression(result.state, name);
        const targetMessageId = latestMessageId(false);
        if (targetMessageId >= 0) commitBranchCheckpoint(result.state, targetMessageId, 'manual-add');
        setChatState(getChatKey(), result.state);
        persistCritical(); renderDossier(); updateInjection();
        const addedNpc = result.report.npcId ? result.state.npcs.find(npc => npc.id === result.report.npcId) : null;
        if (addedNpc) globalThis.toastr?.success?.(`NPC State Delta: ${addedNpc.name} created. Use the wand beside the dossier to Scan dossier and populate it.`);
    }

    return { updateNpcAppearance, updateNpcLifeState, npcFormName, setNpcPortrait, setNpcPortraitSeed, removeNpcPortrait, deleteNpcById, setNpcArchiveStateById, exportBundleBytes, importBundleBytes, addNpcManually };
}
