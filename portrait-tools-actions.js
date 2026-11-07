/* NPC State Delta portrait actions: upload completion, generated portrait previews/seeds, and removal. */
import {
    api, closeOverlay, currentSessionIs, flushDurably,
    npcById, recordToolEvent, setBusy, stage1Refresh, validatePortraitFile,
} from './dossier-tools-core.js';
import { targetPortrait } from './portrait-tools-targets.js';

function toast(kind, message) { globalThis.toastr?.[kind]?.(message); }

export async function finishUploadedPortrait(session, file) {
    try {
        const applied = await api()?.setPortrait?.(session.npcId, file, { chatKey: session.chatKey, isCurrent: () => currentSessionIs(session), form: session.form || '' });
        if (!applied) throw new Error('The portrait target changed; stale image result was rejected.');
        const live = npcById(session.npcId);
        if (!currentSessionIs(session)) throw new Error('The portrait workflow is no longer current; late completion was rejected from this workflow.');
        const saved = await flushDurably(session.chatKey, 'device portrait');
        if (!currentSessionIs(session)) return;
        stage1Refresh();
        if (saved.persisted) toast('success', `NPC State Delta: ${live.name} portrait updated and saved.`);
        else toast('warning', `NPC State Delta: portrait applied locally, but durable save failed. ${saved.error?.message || saved.error}`);
        closeOverlay({ reason: 'portrait-applied', session });
    } catch (error) {
        recordToolEvent('portrait-completion', {
            chatKey: session.chatKey,
            npcId: session.npcId,
            action: 'device portrait',
            outcome: 'rejected-or-failed',
            stale: /stale|changed|no longer|current/i.test(String(error?.message || error)),
            detail: error?.message || error,
        });
        if (!currentSessionIs(session)) return;
        setBusy(session, false, error?.message || String(error));
        toast('error', `NPC State Delta portrait: ${error?.message || error}`);
    }
}

export function generatedPreview(session, overlay, url) {
    if (!currentSessionIs(session)) return false;
    const value = String(url || '').trim();
    if (!value) return false;
    session.generatedPortraitUrl = value;
    const box = overlay?.querySelector?.('[data-generated-preview]');
    const image = overlay?.querySelector?.('[data-generated-image]');
    const placeholder = overlay?.querySelector?.('[data-generated-placeholder]');
    const use = overlay?.querySelector?.('[data-use-generated-portrait]');
    if (box) box.hidden = false;
    if (image) {
        image.src = value;
        image.hidden = false;
    }
    if (placeholder) placeholder.hidden = true;
    if (use) use.disabled = false;
    return true;
}

export async function generatedPortraitFile(url, npcId = 'npc') {
    const raw = String(url || '').trim();
    if (!raw) throw new Error('Generated image URL is empty.');
    const absolute = new URL(raw, globalThis.location?.href || 'http://localhost/').href;
    const response = await fetch(absolute, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`Could not load generated image (${response.status}).`);
    const blob = await response.blob();
    if (!blob.type?.startsWith('image/') || blob.size > 16 * 1024 * 1024) throw new Error('Generated result must be an image no larger than 16 MB.');
    const validation = validatePortraitFile({ type: blob.type, size: blob.size });
    if (!validation.ok) throw new Error(validation.reason);
    const extension = (blob.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
    const safeId = String(npcId || 'npc').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'npc';
    return new File([blob], `${safeId}-generated.${extension}`, { type: blob.type });
}

export function portraitSeedFromOverlay(overlay) {
    const raw = String(overlay?.querySelector?.('#npc_state_delta_tools_seed')?.value ?? '').trim();
    if (!raw) return null;
    const seed = Number(raw);
    if (!Number.isSafeInteger(seed) || seed < 0) {
        throw new Error('Portrait seed must be a whole number from 0 to 9007199254740991, or blank to generate a fresh seed for each preview.');
    }
    return seed;
}

export function resetGeneratedSeed(session, overlay) {
    session.generatedPortraitSeed = null;
    const panel = overlay?.querySelector?.('[data-generation-seed]');
    const value = overlay?.querySelector?.('[data-generation-seed-value]');
    if (panel) panel.hidden = true;
    if (value) value.textContent = '';
}

export function showGeneratedSeed(session, overlay, seed) {
    if (!currentSessionIs(session) || !Number.isSafeInteger(seed) || seed < 0) return false;
    session.generatedPortraitSeed = seed;
    const panel = overlay?.querySelector?.('[data-generation-seed]');
    const value = overlay?.querySelector?.('[data-generation-seed-value]');
    if (value) value.textContent = String(seed);
    if (panel) panel.hidden = false;
    return true;
}

export async function removePortrait(session) {
    if (!currentSessionIs(session) || session.busy) return;
    const npc = npcById(session.npcId);
    if (!npc || !targetPortrait(npc, session.form)) return;
    setBusy(session, true, 'Removing portrait without changing the dossier...');
    try {
        if (!await api()?.removePortrait?.(session.npcId, { chatKey: session.chatKey, form: session.form || '' })) throw new Error('The portrait target is no longer current.');
        const saved = await flushDurably(session.chatKey, 'portrait removal');
        if (!currentSessionIs(session)) return;
        stage1Refresh();
        toast(saved.persisted ? 'success' : 'warning', saved.persisted
            ? `NPC State Delta: portrait removed from ${npc.name} and saved.`
            : `NPC State Delta: portrait removed locally, but durable save failed. ${saved.error?.message || saved.error}`);
        closeOverlay({ reason: 'portrait-removed', session });
    } catch (error) {
        if (!currentSessionIs(session)) return;
        setBusy(session, false, error?.message || String(error));
        toast('error', `NPC State Delta portrait removal: ${error?.message || error}`);
    }
}
