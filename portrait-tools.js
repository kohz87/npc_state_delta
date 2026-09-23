/* NPC State Delta portrait management: dossier prompts, native host-image preview, and explicit application. */
import {
    activeChatKey, api, closeOverlay, currentSessionIs, draftKey, escapeHtml, flushDurably,
    keepPromptDraft, makeSession, mountOverlay, npcById, promptDrafts,
    recordToolEvent, selectedNpcId, setBusy, stage1Refresh, validatePortraitFile,
} from './dossier-tools-core.js';

function toast(kind, message) { globalThis.toastr?.[kind]?.(message); }

function hiddenUploadInput(npcId) {
    return `<input type="file" class="npc-state-delta-inline-portrait-file delta-tools-portrait-file" data-npc-id="${escapeHtml(npcId)}" accept="image/*">`;
}

function currentDraft(npc) {
    const key = draftKey(activeChatKey(), npc.id);
    const saved = promptDrafts.get(key);
    if (saved) return { key, positive: saved.positive || '', negative: saved.negative || '' };
    const prompts = api()?.portraitPrompts?.(npc.id) || { positive: '', negative: '' };
    return { key, positive: String(prompts.positive || ''), negative: String(prompts.negative || '') };
}

function saveDraftFromOverlay(session, overlay) {
    const positive = String(overlay?.querySelector('#npc_state_delta_tools_positive')?.value || '');
    const negative = String(overlay?.querySelector('#npc_state_delta_tools_negative')?.value || '');
    keepPromptDraft(draftKey(session.chatKey, session.npcId), { positive, negative });
    return { positive: positive.trim(), negative: negative.trim() };
}

function hideManualCopy(overlay) {
    const box = overlay?.querySelector?.('[data-delta-tools-manual-copy]');
    const textarea = overlay?.querySelector?.('[data-delta-tools-manual-copy-text]');
    if (box) box.hidden = true;
    if (textarea) textarea.value = '';
}

function revealManualCopy(overlay, value, label) {
    const box = overlay?.querySelector?.('[data-delta-tools-manual-copy]');
    const textarea = overlay?.querySelector?.('[data-delta-tools-manual-copy-text]');
    if (!box || !textarea) return false;
    textarea.value = value;
    box.hidden = false;
    try {
        textarea.focus({ preventScroll: true });
        textarea.select();
        textarea.setSelectionRange(0, textarea.value.length);
    } catch {
        try { textarea.focus(); textarea.select(); } catch {}
    }
    toast('warning', `NPC State Delta: automatic clipboard access was blocked. ${label} is selected below; press Ctrl+C to copy it.`);
    return true;
}

async function hostCopyText(value) {
    // SillyTavern owns this host-only module. Lazy loading keeps Delta's isolated
    // Node/runtime tests independent from the surrounding SillyTavern install.
    const hostUtils = await import('../../../utils.js');
    if (typeof hostUtils?.copyText !== 'function') throw new Error('SillyTavern clipboard helper is unavailable.');
    return hostUtils.copyText(value);
}

async function copyPromptText(text, label, overlay) {
    const value = String(text ?? '').trim();
    if (!value) {
        toast('warning', `NPC State Delta: ${label.toLowerCase()} is empty; nothing was copied.`);
        return false;
    }

    hideManualCopy(overlay);
    try {
        // Use SillyTavern's own clipboard helper. It owns the host-compatible
        // Clipboard API / textarea fallback rather than duplicating it here.
        await hostCopyText(value);
        toast('success', `NPC State Delta: ${label} copied.`);
        return true;
    } catch (error) {
        recordToolEvent('portrait-prompt-copy', {
            chatKey: activeChatKey(),
            action: label,
            outcome: 'clipboard-blocked',
            detail: error?.message || error,
        });
        if (revealManualCopy(overlay, value, label)) return false;
        toast('error', `NPC State Delta: could not copy ${label.toLowerCase()}. ${error?.message || error}`);
        return false;
    }
}

function combinedPrompt(draft) {
    const positive = String(draft?.positive || '').trim();
    const negative = String(draft?.negative || '').trim();
    const blocks = [];
    if (positive) blocks.push(`Positive prompt:\n${positive}`);
    if (negative) blocks.push(`Negative prompt:\n${negative}`);
    return blocks.join('\n\n');
}

function portraitGenerationAvailable() {
    const runtime = api();
    if (typeof runtime?.generatePortraitUrl !== 'function') return false;
    try { return runtime?.portraitSettings?.()?.portraitGenerationEnabled !== false; }
    catch { return true; }
}

function portraitDialogHtml(npc, draft) {
    const portrait = npc?.portrait?.dataUrl || '';
    const canGenerate = portraitGenerationAvailable();
    const portraitSeed = Number.isSafeInteger(npc?.portraitSeed) && npc.portraitSeed >= 0 ? String(npc.portraitSeed) : '';
    return `<section class="delta-tools-dialog delta-tools-portrait" role="document" aria-label="Portrait management for ${escapeHtml(npc.name)}">
      <header>
        <div><span class="delta-tools-kicker">PORTRAIT + PROMPTS</span><h2>${escapeHtml(npc.name)}</h2><small>Build prompts from the accepted dossier or generate through SillyTavern Image Generation. Generated images stay preview-only until you explicitly choose Use as Portrait.</small></div>
        <button type="button" class="delta-tools-close" data-delta-tools-close aria-label="Close">×</button>
      </header>
      <div class="delta-tools-body delta-tools-portrait-grid">
        <section class="delta-tools-preview">
          <div class="delta-tools-current">${portrait ? `<img src="${escapeHtml(portrait)}" alt="Current portrait of ${escapeHtml(npc.name)}">` : '<div class="delta-tools-placeholder">No current portrait</div>'}</div>
          <div class="delta-tools-generated" data-generated-preview hidden>
            <div class="delta-tools-generated-placeholder" data-generated-placeholder>Generated preview will appear here. It will not change the dossier until applied.</div>
            <img data-generated-image alt="Generated portrait preview for ${escapeHtml(npc.name)}" hidden>
          </div>
        </section>
        <section class="delta-tools-prompts">
          <label>Positive prompt<textarea id="npc_state_delta_tools_positive" rows="8" data-delta-tools-autofocus>${escapeHtml(draft.positive)}</textarea></label>
          <div class="delta-tools-copy-row"><button type="button" data-copy="positive">Copy positive</button><button type="button" data-generate-prompts>Generate prompts from dossier</button></div>
          <label>Negative prompt<textarea id="npc_state_delta_tools_negative" rows="6">${escapeHtml(draft.negative)}</textarea></label>
          <div class="delta-tools-copy-row"><button type="button" data-copy="negative">Copy negative</button></div>
          <div class="delta-tools-seed-card">
            <label for="npc_state_delta_tools_seed"><b>Portrait seed</b><small>Blank generates a fresh seed for each preview. Save one when you want to reproduce a result with otherwise unchanged image settings.</small></label>
            <div class="delta-tools-seed-row">
              <input id="npc_state_delta_tools_seed" class="delta-tools-seed-input" type="number" min="0" max="9007199254740991" step="1" value="${escapeHtml(portraitSeed)}" placeholder="Blank = fresh random seed">
              <button type="button" data-save-portrait-seed>Save seed</button>
            </div>
            <div class="delta-tools-generation-seed" data-generation-seed hidden>
              <span><small>Generation seed</small><code data-generation-seed-value></code></span>
              <button type="button" data-use-generation-seed>Save as NPC seed</button>
            </div>
          </div>
          <small>Manual edits are kept for this chat session. Delta disables SillyTavern's free-prompt auto-extension/refinement for this handoff so the edited traits reach the image backend unchanged. SillyTavern's global Image Generation Prompt Prefix / Negative Prompt and configured backend settings still apply.</small>
          <div class="delta-tools-manual-copy" data-delta-tools-manual-copy hidden>
            <small>Clipboard access is blocked by this browser context. The prompt is selected below; press Ctrl+C.</small>
            <textarea data-delta-tools-manual-copy-text rows="4" readonly aria-label="Prompt ready for manual copy"></textarea>
          </div>
        </section>
      </div>
      <footer>
        <label class="delta-tools-file-button">${portrait ? 'Replace from device' : 'Upload from device'}${hiddenUploadInput(npc.id)}</label>
        <button type="button" data-remove-portrait ${portrait ? '' : 'disabled'}>Remove portrait</button>
        <button type="button" data-copy-final-prompt>Copy Prompt</button>
        <button type="button" data-generate-portrait ${canGenerate ? '' : 'disabled title="Enable Portrait generation in NPC State Delta settings and configure SillyTavern Image Generation."'}>Generate Portrait</button>
        <button type="button" data-use-generated-portrait disabled>Use as Portrait</button>
        <span data-delta-tools-status hidden></span>
      </footer>
    </section>`;
}

async function finishUploadedPortrait(session, file) {
    try {
        const applied = await api()?.setPortrait?.(session.npcId, file, { chatKey: session.chatKey, isCurrent: () => currentSessionIs(session) });
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

function generatePromptsFromDossier(session, overlay) {
    if (!currentSessionIs(session)) return;
    const prompts = api()?.portraitPrompts?.(session.npcId);
    if (!prompts) {
        toast('warning', 'NPC State Delta: could not build portrait prompts for the selected dossier.');
        return;
    }
    const positive = overlay.querySelector('#npc_state_delta_tools_positive');
    const negative = overlay.querySelector('#npc_state_delta_tools_negative');
    if (positive) positive.value = prompts.positive || '';
    if (negative) negative.value = prompts.negative || '';
    keepPromptDraft(draftKey(session.chatKey, session.npcId), { positive: prompts.positive || '', negative: prompts.negative || '' });
    recordToolEvent('portrait-prompts', { chatKey: session.chatKey, npcId: session.npcId, action: 'generate-from-dossier', outcome: 'generated' });
    toast('info', 'NPC State Delta: portrait prompts generated from the current accepted dossier.');
}

function generatedPreview(session, overlay, url) {
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

async function generatedPortraitFile(url, npcId = 'npc') {
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

function portraitSeedFromOverlay(overlay) {
    const raw = String(overlay?.querySelector?.('#npc_state_delta_tools_seed')?.value ?? '').trim();
    if (!raw) return null;
    const seed = Number(raw);
    if (!Number.isSafeInteger(seed) || seed < 0) {
        throw new Error('Portrait seed must be a whole number from 0 to 9007199254740991, or blank to generate a fresh seed for each preview.');
    }
    return seed;
}

function randomPortraitSeed() {
    const cryptoApi = globalThis.crypto;
    if (typeof cryptoApi?.getRandomValues === 'function') {
        const words = new Uint32Array(2);
        cryptoApi.getRandomValues(words);
        return ((words[0] & 0x1fffff) * 0x100000000) + words[1];
    }
    return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}

function resetGeneratedSeed(session, overlay) {
    session.generatedPortraitSeed = null;
    const panel = overlay?.querySelector?.('[data-generation-seed]');
    const value = overlay?.querySelector?.('[data-generation-seed-value]');
    if (panel) panel.hidden = true;
    if (value) value.textContent = '';
}

function showGeneratedSeed(session, overlay, seed) {
    if (!currentSessionIs(session) || !Number.isSafeInteger(seed) || seed < 0) return false;
    session.generatedPortraitSeed = seed;
    const panel = overlay?.querySelector?.('[data-generation-seed]');
    const value = overlay?.querySelector?.('[data-generation-seed-value]');
    if (value) value.textContent = String(seed);
    if (panel) panel.hidden = false;
    return true;
}

async function saveGeneratedPortraitSeed(session, overlay) {
    const seed = session.generatedPortraitSeed;
    if (!currentSessionIs(session) || session.busy || !Number.isSafeInteger(seed) || seed < 0) return false;
    const input = overlay?.querySelector?.('#npc_state_delta_tools_seed');
    if (input) input.value = String(seed);
    return savePortraitSeed(session, overlay);
}

async function savePortraitSeed(session, overlay) {
    if (!currentSessionIs(session) || session.busy) return false;
    let seed;
    try {
        seed = portraitSeedFromOverlay(overlay);
    } catch (error) {
        toast('warning', `NPC State Delta: ${error?.message || error}`);
        return false;
    }
    setBusy(session, true, 'Saving portrait seed…');
    try {
        if (!api()?.setPortraitSeed?.(session.npcId, seed, { chatKey: session.chatKey })) {
            throw new Error('The portrait target is no longer current.');
        }
        const saved = await flushDurably(session.chatKey, 'portrait seed');
        if (!currentSessionIs(session)) return false;
        stage1Refresh();
        setBusy(session, false, saved.persisted ? 'Portrait seed saved.' : 'Portrait seed changed locally; durable save failed.');
        toast(saved.persisted ? 'success' : 'warning', saved.persisted
            ? `NPC State Delta: portrait seed ${seed === null ? 'cleared' : `saved as ${seed}`}.`
            : `NPC State Delta: portrait seed changed locally, but durable save failed. ${saved.error?.message || saved.error}`);
        return saved.persisted;
    } catch (error) {
        if (!currentSessionIs(session)) return false;
        setBusy(session, false, 'Could not save portrait seed.');
        toast('error', `NPC State Delta portrait seed: ${error?.message || error}`);
        return false;
    }
}

async function generatePortrait(session, overlay) {
    if (!currentSessionIs(session) || session.busy) return false;
    const runtime = api();
    if (typeof runtime?.generatePortraitUrl !== 'function') {
        toast('warning', 'NPC State Delta: SillyTavern Image Generation is unavailable in this runtime.');
        return false;
    }
    try {
        if (runtime?.portraitSettings?.()?.portraitGenerationEnabled === false) {
            toast('info', 'NPC State Delta: enable Portrait generation in settings first.');
            return false;
        }
    } catch {}
    const draft = saveDraftFromOverlay(session, overlay);
    if (!draft.positive) {
        toast('warning', 'NPC State Delta: positive portrait prompt is empty.');
        return false;
    }
    let requestedSeed;
    try {
        requestedSeed = portraitSeedFromOverlay(overlay);
    } catch (error) {
        toast('warning', `NPC State Delta: ${error?.message || error}`);
        return false;
    }
    const generationSeed = requestedSeed ?? randomPortraitSeed();
    const actionSeq = ++session.actionSeq;
    session.generatedPortraitUrl = '';
    resetGeneratedSeed(session, overlay);
    const use = overlay?.querySelector?.('[data-use-generated-portrait]');
    if (use) use.disabled = true;
    setBusy(session, true, 'Generating through SillyTavern Image Generation…', { allowClose: true });
    try {
        const url = await runtime.generatePortraitUrl(session.npcId, { positive: draft.positive, negative: draft.negative, seed: generationSeed });
        if (!currentSessionIs(session) || session.actionSeq !== actionSeq) return false;
        const value = String(url || '').trim();
        if (!value) throw new Error('SillyTavern Image Generation returned no image URL.');
        setBusy(session, false, 'Generation complete. Review the preview before applying it.');
        if (!generatedPreview(session, overlay, value)) return false;
        showGeneratedSeed(session, overlay, generationSeed);
        recordToolEvent('portrait-generation', {
            chatKey: session.chatKey,
            npcId: session.npcId,
            action: 'generate-preview',
            outcome: 'generated',
        });
        return true;
    } catch (error) {
        if (!currentSessionIs(session) || session.actionSeq !== actionSeq) return false;
        recordToolEvent('portrait-generation', {
            chatKey: session.chatKey,
            npcId: session.npcId,
            action: 'generate-preview',
            outcome: 'failed',
            detail: error?.message || error,
        });
        setBusy(session, false, 'Generation failed.');
        toast('error', `NPC State Delta portrait generation: ${error?.message || error}`);
        return false;
    }
}

async function useGeneratedPortrait(session, overlay) {
    const url = String(session.generatedPortraitUrl || '').trim();
    if (!currentSessionIs(session) || session.busy || !url) return false;
    const actionSeq = ++session.actionSeq;
    const live = npcById(session.npcId);
    if (!live) return false;
    setBusy(session, true, 'Preparing generated preview…', { allowClose: true });
    let applied = false;
    try {
        const file = await generatedPortraitFile(url, session.npcId);
        if (!currentSessionIs(session) || session.actionSeq !== actionSeq) return false;
        setBusy(session, true, 'Applying generated preview through the canonical portrait handler…');
        applied = await api()?.setPortrait?.(session.npcId, file, {
            chatKey: session.chatKey,
            isCurrent: () => currentSessionIs(session) && session.actionSeq === actionSeq,
            generatedFrom: url,
        });
        if (!applied) throw new Error('The portrait target changed; stale generated image was rejected.');
        if (!currentSessionIs(session) || session.actionSeq !== actionSeq) return false;
        const saved = await flushDurably(session.chatKey, 'generated portrait');
        if (!currentSessionIs(session) || session.actionSeq !== actionSeq) return false;
        stage1Refresh();
        recordToolEvent('portrait-generation', {
            chatKey: session.chatKey,
            npcId: session.npcId,
            action: 'apply-preview',
            outcome: saved.persisted ? 'saved' : 'local-only',
            persisted: saved.persisted,
        });
        toast(saved.persisted ? 'success' : 'warning', saved.persisted
            ? `NPC State Delta: generated portrait applied to ${live.name} and saved.`
            : `NPC State Delta: generated portrait applied locally, but durable save failed. ${saved.error?.message || saved.error}`);
        closeOverlay({ reason: 'generated-portrait-applied', session });
        return true;
    } catch (error) {
        if (!currentSessionIs(session) || session.actionSeq !== actionSeq) return false;
        setBusy(session, false, applied ? 'Applied locally; durable save failed.' : 'Could not apply generated preview.');
        toast(applied ? 'warning' : 'error', `NPC State Delta portrait import: ${error?.message || error}`);
        return false;
    }
}

function wirePortraitDialog(session, overlay) {
    const input = overlay?.querySelector('.delta-tools-portrait-file');
    input?.addEventListener('change', event => {
        // The canonical API owns this operation. Do not also dispatch the delegated host handler.
        event.stopImmediatePropagation();
        const file = input.files?.[0];
        const validation = validatePortraitFile(file);
        if (!validation.ok) {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (file) toast('warning', `NPC State Delta: ${validation.reason}`);
            input.value = '';
            return;
        }
        if (!currentSessionIs(session)) {
            event.preventDefault();
            event.stopImmediatePropagation();
            input.value = '';
            recordToolEvent('portrait-upload', { chatKey: session.chatKey, npcId: session.npcId, action: 'file-selected', outcome: 'stale-rejected', stale: true });
            toast('warning', 'NPC State Delta: the portrait target changed while the file picker was open. Reopen Portrait for the current dossier.');
            return;
        }
        setBusy(session, true, 'Processing image through the canonical portrait handler…');
        input.value = '';
        void finishUploadedPortrait(session, file);
    });

    overlay?.addEventListener('input', event => {
        if (event.target.matches?.('#npc_state_delta_tools_positive, #npc_state_delta_tools_negative')) saveDraftFromOverlay(session, overlay);
    });

    overlay?.addEventListener('click', event => {
        const copy = event.target.closest?.('[data-copy]')?.dataset?.copy;
        if (copy) {
            const draft = saveDraftFromOverlay(session, overlay);
            if (copy === 'positive') void copyPromptText(draft.positive, 'Positive prompt', overlay);
            else void copyPromptText(draft.negative, 'Negative prompt', overlay);
            return;
        }
        if (event.target.closest?.('[data-generate-prompts]')) {
            generatePromptsFromDossier(session, overlay);
            return;
        }
        if (event.target.closest?.('[data-copy-final-prompt]')) {
            const draft = saveDraftFromOverlay(session, overlay);
            void copyPromptText(combinedPrompt(draft), 'Portrait prompt', overlay);
            return;
        }
        if (event.target.closest?.('[data-save-portrait-seed]')) {
            void savePortraitSeed(session, overlay);
            return;
        }
        if (event.target.closest?.('[data-use-generation-seed]')) {
            void saveGeneratedPortraitSeed(session, overlay);
            return;
        }
        if (event.target.closest?.('[data-generate-portrait]')) {
            void generatePortrait(session, overlay);
            return;
        }
        if (event.target.closest?.('[data-use-generated-portrait]')) {
            void useGeneratedPortrait(session, overlay);
            return;
        }
        if (event.target.closest?.('[data-remove-portrait]')) void removePortrait(session);
    });
}

export function openPortraitTools(npcId = selectedNpcId()) {
    const npc = npcById(npcId);
    if (!npc) {
        toast('warning', 'NPC State Delta: select an NPC dossier first.');
        return null;
    }
    const session = makeSession('portrait', { npcId: npc.id });
    const overlay = mountOverlay(portraitDialogHtml(npc, currentDraft(npc)), session);
    wirePortraitDialog(session, overlay);
    return overlay;
}

async function removePortrait(session) {
    if (!currentSessionIs(session) || session.busy) return;
    const npc = npcById(session.npcId);
    if (!npc?.portrait?.dataUrl) return;
    setBusy(session, true, 'Removing portrait without changing the dossier...');
    try {
        if (!api()?.removePortrait?.(session.npcId, { chatKey: session.chatKey })) throw new Error('The portrait target is no longer current.');
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
