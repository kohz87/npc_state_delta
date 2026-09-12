/* NPC State Delta portrait management: prompt generation plus explicit upload/remove only. */
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

function portraitDialogHtml(npc, draft) {
    const portrait = npc?.portrait?.dataUrl || '';
    return `<section class="delta-tools-dialog delta-tools-portrait" role="document" aria-label="Portrait management for ${escapeHtml(npc.name)}">
      <header>
        <div><span class="delta-tools-kicker">PORTRAIT + PROMPTS</span><h2>${escapeHtml(npc.name)}</h2><small>Generate prompts from the accepted dossier, edit or copy them, then manage the portrait explicitly from your device. Delta does not generate an image here.</small></div>
        <button type="button" class="delta-tools-close" data-delta-tools-close aria-label="Close">×</button>
      </header>
      <div class="delta-tools-body delta-tools-portrait-grid">
        <section class="delta-tools-preview">
          <div class="delta-tools-current">${portrait ? `<img src="${escapeHtml(portrait)}" alt="Current portrait of ${escapeHtml(npc.name)}">` : '<div class="delta-tools-placeholder">No current portrait</div>'}</div>
        </section>
        <section class="delta-tools-prompts">
          <label>Positive prompt<textarea id="npc_state_delta_tools_positive" rows="8" data-delta-tools-autofocus>${escapeHtml(draft.positive)}</textarea></label>
          <div class="delta-tools-copy-row"><button type="button" data-copy="positive">Copy positive</button><button type="button" data-generate-prompts>Generate prompts from dossier</button></div>
          <label>Negative prompt<textarea id="npc_state_delta_tools_negative" rows="6">${escapeHtml(draft.negative)}</textarea></label>
          <div class="delta-tools-copy-row"><button type="button" data-copy="negative">Copy negative</button></div>
          <small>Manual edits are kept for this chat session. “Generate prompts from dossier” replaces them with a fresh resolved-appearance prompt. “Copy Prompt” copies the currently edited positive + negative prompt pair.</small>
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
