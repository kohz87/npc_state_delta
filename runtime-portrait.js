/* NPC State Delta portrait generator and portrait settings draft (role: portrait-generator-and-settings). The generator dialog and the
   native image request behind it, the generated picture's file, and the portrait settings draft the panel shows (read, validate,
   write to the panel, mark dirty). Built by index.js once per module instance with the shared runtime state and the controller
   functions it calls, so each instance keeps its own generated-picture memory. Bodies are moved from index.js without change. */

import { getContext } from '../../../extensions.js';
import { DEFAULT_PORTRAIT_STYLE_POSITIVE, DEFAULT_PORTRAIT_STYLE_NEGATIVE, DEFAULT_PORTRAIT_COMPOSITION, PORTRAIT_STYLE_PROMPT_LIMIT, PORTRAIT_COMPOSITION_PROMPT_LIMIT, normalizePortraitSeed, normalizePortraitPromptFormat, buildNpcPortraitPrompts } from './core.js';
import { escapeHtml } from './src/util/html.js';
import { PORTRAIT_THEME_PRESETS, PORTRAIT_CUSTOM_PRESET_LIMIT, portraitCustomPreset, portraitCustomPresetLibrary, getSettings } from './runtime-settings.js';

export function createPortraitPart(rt, deps) {
    const { currentNpcById, eventTargetClosest, flushStateFile, getChatKey, requireReadyChatMutation, setNpcPortrait } = deps;
    const { stateVersions } = rt;

    let activePortraitGenerationUrl = '';

    function handlePortraitGeneratorEscape(event) {
        if (event?.key !== 'Escape' || event.defaultPrevented
            || document.getElementById?.('npc_state_delta_tools_overlay')) return false;
        if (!rt.activePortraitGeneratorOverlay) return false;
        event.preventDefault?.();
        event.stopPropagation?.();
        closePortraitGenerator();
        return true;
    }

    function portraitPromptOptions() {
        const settings = portraitSettingsSnapshot(getSettings());
        return {
            stylePositive: settings.portraitStylePositive,
            styleNegative: settings.portraitStyleNegative,
            composition: settings.portraitComposition,
            format: settings.portraitPromptFormat,
            useMood: settings.portraitUseMood,
            useLocation: settings.portraitUseLocation,
        };
    }

    function npcImagePromptPair(npc) {
        return buildNpcPortraitPrompts(npc || {}, portraitPromptOptions());
    }

    function slashQuoted(value) {
        const text = String(value || '').replace(/\s+/g, ' ').trim();
        return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
    }

    async function executeNativePortraitGeneration(positive, negative, seed = null) {
        const prompt = String(positive || '').trim();
        if (!prompt) throw new Error('Positive portrait prompt is empty.');
        const ctx = getContext();
        const execute = ctx.executeSlashCommandsWithOptions;
        if (typeof execute !== 'function') {
            throw new Error('This SillyTavern build does not expose executeSlashCommandsWithOptions().');
        }
        const settings = getSettings();
        const command = [
            '/imagine',
            'quiet=true',
            // Delta already supplies the complete portrait prompt. Prevent SillyTavern's
            // optional free-mode LLM extension/refine layers from rewriting grounded traits
            // (for example hair color) before the configured image backend receives them.
            'extend=false',
            'edit=false',
            `gallery=${settings.portraitSaveToGallery ? 'true' : 'false'}`,
            normalizePortraitSeed(seed) !== null ? `seed=${normalizePortraitSeed(seed)}` : '',
            negative ? `negative=${slashQuoted(negative)}` : '',
            slashQuoted(prompt),
        ].filter(Boolean).join(' ');
        let result;
        try {
            result = await execute(command, {
                handleParserErrors: false,
                handleExecutionErrors: false,
                source: 'npc_state_delta_portrait',
            });
        } catch (error) {
            const message = String(error?.message || error || 'Unknown image generation error');
            if (/unknown command|imagine|image generation|not configured|not available/i.test(message)) {
                throw new Error(`SillyTavern Image Generation is unavailable or not configured. ${message}`);
            }
            throw error;
        }
        const url = String(result?.pipe ?? '').trim();
        if (!url) throw new Error('SillyTavern Image Generation returned no image URL. Check Image Generation settings and try /imagine manually once.');
        return url;
    }

    function portraitGeneratorHtml(npc, prompts) {
        const theme = portraitThemeLabel(getSettings());
        return `
      <div class="npc-state-delta-portrait-generator-dialog" role="dialog" aria-modal="true" aria-labelledby="npc_state_delta_portrait_generator_title">
        <header class="npc-state-delta-portrait-generator-header">
          <div><span class="npc-state-delta-kicker">PORTRAIT GENERATOR</span><h2 id="npc_state_delta_portrait_generator_title">${escapeHtml(npc.name)}</h2><small>${escapeHtml(theme)} · SillyTavern Image Generation</small></div>
          <button type="button" class="npc-state-delta-portrait-generator-close" aria-label="Close portrait generator"><i class="fa-solid fa-xmark"></i></button>
        </header>
        <div class="npc-state-delta-portrait-generator-body">
          <section class="npc-state-delta-portrait-generator-preview" aria-live="polite">
            <div class="npc-state-delta-portrait-generator-placeholder"><i class="fa-solid fa-image"></i><b>Generated portrait preview</b><small>The result stays out of chat. Nothing replaces the current portrait until you choose Use as Portrait.</small></div>
            <img class="npc-state-delta-portrait-generator-image" alt="Generated portrait preview" hidden>
            <div class="npc-state-delta-portrait-generator-status" hidden></div>
          </section>
          <section class="npc-state-delta-portrait-generator-prompts">
            <label><b>Positive prompt</b><small>Built from the current dossier + selected portrait theme/preset. Edit freely for this generation.</small><textarea id="npc_state_delta_portrait_positive" class="text_pole" rows="9">${escapeHtml(prompts.positive)}</textarea></label>
            <label><b>Negative prompt</b><small>Selected preset exclusions + this NPC's optional negative override.</small><textarea id="npc_state_delta_portrait_negative" class="text_pole" rows="7">${escapeHtml(prompts.negative)}</textarea></label>
          </section>
        </div>
        <footer class="npc-state-delta-portrait-generator-actions">
          <button type="button" class="menu_button npc-state-delta-portrait-reset"><i class="fa-solid fa-rotate-left"></i> Reset from dossier</button>
          <button type="button" class="menu_button npc-state-delta-portrait-run"><i class="fa-solid fa-wand-magic-sparkles"></i> Generate</button>
          <button type="button" class="menu_button npc-state-delta-portrait-use" disabled><i class="fa-solid fa-check"></i> Use as Portrait</button>
        </footer>
      </div>`;
    }

    function closePortraitGenerator() {
        const overlay = rt.activePortraitGeneratorOverlay;
        rt.activePortraitGeneratorOverlay = null;
        rt.activePortraitGeneratorChatKey = '';
        rt.activePortraitGeneratorNpcId = '';
        activePortraitGenerationUrl = '';
        rt.portraitGenerationBusy = false;
        overlay?.remove?.();
        document.body?.classList?.remove?.('npc-state-delta-portrait-generator-open');
        document.documentElement?.classList?.remove?.('npc-state-delta-portrait-generator-open');
    }

    function openPortraitGenerator(npcId) {
        const originChatKey = getChatKey();
        if (!requireReadyChatMutation('generate a portrait', originChatKey)) return false;
        const id = String(npcId || '').trim();
        const npc = currentNpcById(id);
        if (!npc) return false;
        if (getSettings().portraitGenerationEnabled === false) {
            globalThis.toastr?.info?.('NPC State Delta: Generate Portrait is disabled in settings.');
            return false;
        }
        const prompts = npcImagePromptPair(npc);
        if (!prompts.positive) {
            globalThis.toastr?.warning?.(`NPC State Delta: ${npc.name} needs an Appearance description or a per-NPC positive prompt before image generation.`);
            return false;
        }
        closePortraitGenerator();
        const overlay = document.createElement('div');
        overlay.id = 'npc_state_delta_portrait_generator_overlay';
        overlay.className = 'npc-state-delta-portrait-generator-overlay';
        // Keep the generator above the already-open full-screen dossier on tablet/mobile.
        overlay.style.zIndex = '2147483600';
        overlay.dataset.npcId = id;
        overlay.innerHTML = portraitGeneratorHtml(npc, prompts);
        overlay.addEventListener?.('click', event => {
            const closeButton = eventTargetClosest(event, '.npc-state-delta-portrait-generator-close');
            if (event.target === overlay || closeButton) {
                event.preventDefault?.();
                event.stopPropagation?.();
                closePortraitGenerator();
            }
        });
        document.body?.appendChild?.(overlay);
        document.body?.classList?.add?.('npc-state-delta-portrait-generator-open');
        document.documentElement?.classList?.add?.('npc-state-delta-portrait-generator-open');
        rt.activePortraitGeneratorOverlay = overlay;
        rt.activePortraitGeneratorChatKey = originChatKey;
        rt.activePortraitGeneratorNpcId = id;
        activePortraitGenerationUrl = '';
        globalThis.requestAnimationFrame?.(() => overlay.querySelector?.('#npc_state_delta_portrait_positive')?.focus?.());
        return true;
    }

    function setPortraitGeneratorBusy(busy, text = '') {
        rt.portraitGenerationBusy = Boolean(busy);
        const overlay = rt.activePortraitGeneratorOverlay;
        if (!overlay) return;
        const run = overlay.querySelector?.('.npc-state-delta-portrait-run');
        const reset = overlay.querySelector?.('.npc-state-delta-portrait-reset');
        const use = overlay.querySelector?.('.npc-state-delta-portrait-use');
        const close = overlay.querySelector?.('.npc-state-delta-portrait-generator-close');
        const status = overlay.querySelector?.('.npc-state-delta-portrait-generator-status');
        if (run) { run.disabled = rt.portraitGenerationBusy; run.innerHTML = rt.portraitGenerationBusy ? '<i class="fa-solid fa-spinner fa-spin"></i> Generating...' : '<i class="fa-solid fa-wand-magic-sparkles"></i> Generate again'; }
        if (reset) reset.disabled = rt.portraitGenerationBusy;
        // Closing invalidates this dialog; late generation/decoding cannot apply a result.
        if (close) close.disabled = false;
        if (use) use.disabled = rt.portraitGenerationBusy || !activePortraitGenerationUrl;
        if (status) {
            status.hidden = !text;
            status.textContent = text;
        }
    }

    function resetPortraitGeneratorFromDossier() {
        if (!rt.activePortraitGeneratorOverlay || !rt.activePortraitGeneratorNpcId || rt.portraitGenerationBusy) return false;
        if (getChatKey() !== rt.activePortraitGeneratorChatKey || !requireReadyChatMutation('reset portrait prompts', rt.activePortraitGeneratorChatKey)) return false;
        const npc = currentNpcById(rt.activePortraitGeneratorNpcId);
        if (!npc) return false;
        const prompts = npcImagePromptPair(npc);
        const positive = rt.activePortraitGeneratorOverlay.querySelector?.('#npc_state_delta_portrait_positive');
        const negative = rt.activePortraitGeneratorOverlay.querySelector?.('#npc_state_delta_portrait_negative');
        if (positive) positive.value = prompts.positive;
        if (negative) negative.value = prompts.negative;
        return true;
    }

    async function generatePortraitFromDialog() {
        const overlay = rt.activePortraitGeneratorOverlay;
        const originChatKey = rt.activePortraitGeneratorChatKey;
        if (!originChatKey || getChatKey() !== originChatKey || !requireReadyChatMutation('generate a portrait', originChatKey)) return false;
        const npc = currentNpcById(rt.activePortraitGeneratorNpcId);
        if (!overlay || !npc || rt.portraitGenerationBusy) return false;
        const positive = String(overlay.querySelector?.('#npc_state_delta_portrait_positive')?.value || '').trim();
        const negative = String(overlay.querySelector?.('#npc_state_delta_portrait_negative')?.value || '').trim();
        if (!positive) {
            globalThis.toastr?.warning?.('NPC State Delta: positive portrait prompt is empty.');
            return false;
        }
        const revision = Number(stateVersions.get(originChatKey) || 0);
        activePortraitGenerationUrl = '';
        setPortraitGeneratorBusy(true, 'Generating through SillyTavern Image Generation…');
        try {
            const url = await executeNativePortraitGeneration(positive, negative, npc.portraitSeed);
            if (rt.activePortraitGeneratorOverlay !== overlay || rt.activePortraitGeneratorNpcId !== npc.id || rt.activePortraitGeneratorChatKey !== originChatKey || getChatKey() !== originChatKey || !currentNpcById(npc.id)) return false;
            if (Number(stateVersions.get(originChatKey) || 0) !== revision) {
                setPortraitGeneratorBusy(false, 'The dossier changed during generation; the stale preview was discarded.');
                return false;
            }
            activePortraitGenerationUrl = url;
            const image = rt.activePortraitGeneratorOverlay.querySelector?.('.npc-state-delta-portrait-generator-image');
            const placeholder = rt.activePortraitGeneratorOverlay.querySelector?.('.npc-state-delta-portrait-generator-placeholder');
            if (image) {
                image.src = url;
                image.hidden = false;
            }
            if (placeholder) placeholder.hidden = true;
            setPortraitGeneratorBusy(false, 'Generation complete. Review the result before applying it.');
            return true;
        } catch (error) {
            if (rt.activePortraitGeneratorOverlay !== overlay || getChatKey() !== originChatKey) return false;
            console.error('[NPC State Delta] portrait generation failed', error);
            setPortraitGeneratorBusy(false, 'Generation failed.');
            globalThis.toastr?.error?.(`NPC State Delta portrait generation: ${error?.message || error}`);
            return false;
        }
    }

    async function portraitFileFromGeneratedUrl(url, npcName = 'npc') {
        const raw = String(url || '').trim();
        if (!raw) throw new Error('Generated image URL is empty.');
        const absolute = new URL(raw, globalThis.location?.href || 'http://localhost/').href;
        const response = await fetch(absolute, { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`Could not load generated image (${response.status}).`);
        const blob = await response.blob();
        if (!blob.type?.startsWith('image/') || blob.size > 16 * 1024 * 1024) throw new Error('Generated URL must return an image no larger than 16 MB.');
        const extension = (blob.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
        const filename = `${safeFilenamePart(npcName)}-generated.${extension}`;
        return new File([blob], filename, { type: blob.type });
    }

    async function useGeneratedPortrait() {
        const overlay = rt.activePortraitGeneratorOverlay;
        const npcId = rt.activePortraitGeneratorNpcId;
        const url = activePortraitGenerationUrl;
        const originChatKey = rt.activePortraitGeneratorChatKey;
        if (!overlay || !npcId || !url || rt.portraitGenerationBusy || getChatKey() !== originChatKey) return false;
        if (!requireReadyChatMutation('apply a generated portrait', originChatKey)) return false;
        const npc = currentNpcById(npcId);
        if (!npc) return false;
        const revision = Number(stateVersions.get(originChatKey) || 0);
        const current = () => rt.activePortraitGeneratorOverlay === overlay && getChatKey() === originChatKey
            && rt.activePortraitGeneratorNpcId === npcId && activePortraitGenerationUrl === url;
        setPortraitGeneratorBusy(true, 'Importing generated image into the NPC dossier...');
        let applied = false;
        try {
            const file = await portraitFileFromGeneratedUrl(url, npc.name);
            if (!current() || Number(stateVersions.get(originChatKey) || 0) !== revision) return false;
            applied = await setNpcPortrait(npcId, file, { chatKey: originChatKey, isCurrent: current, generatedFrom: url });
            if (!applied) return false;
            await flushStateFile(originChatKey);
            if (!current()) return false;
            closePortraitGenerator();
            globalThis.toastr?.success?.(`NPC State Delta: generated portrait applied to ${npc.name} and saved.`);
            return true;
        } catch (error) {
            if (!current()) return false;
            setPortraitGeneratorBusy(false, applied ? 'Applied locally; durable save failed.' : 'Could not import the generated result.');
            globalThis.toastr?.[applied ? 'warning' : 'error']?.(`NPC State Delta portrait import: ${error?.message || error}`);
            return false;
        } finally {
            if (current()) setPortraitGeneratorBusy(false);
        }
    }

    function safeFilenamePart(value) {
        return String(value || 'chat')
            .normalize('NFKC')
            .replace(/[^\p{L}\p{N}._-]+/gu, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 80) || 'chat';
    }

    function portraitThemeLabel(source = getSettings()) {
        const snapshot = portraitSettingsSnapshot(source);
        if (snapshot.portraitThemePreset === 'custom') {
            const preset = snapshot.portraitCustomPresets.find(item => item.id === snapshot.portraitCustomPresetId);
            return preset?.name ? `Custom · ${preset.name}` : 'Custom Library';
        }
        return PORTRAIT_THEME_PRESETS[snapshot.portraitThemePreset]?.label || 'Custom Library';
    }

    function portraitSettingsSnapshot(source = getSettings()) {
        const customPresets = portraitCustomPresetLibrary(source.portraitCustomPresets);
        const customPresetId = customPresets.some(item => item.id === source.portraitCustomPresetId)
            ? source.portraitCustomPresetId
            : customPresets[0].id;
        const customPreset = customPresets.find(item => item.id === customPresetId) || customPresets[0];
        const theme = PORTRAIT_THEME_PRESETS[source.portraitThemePreset] ? source.portraitThemePreset : 'custom';
        const builtIn = theme !== 'custom' ? PORTRAIT_THEME_PRESETS[theme] : null;
        return {
            portraitGenerationEnabled: source.portraitGenerationEnabled !== false,
            portraitThemePreset: theme,
            portraitCustomPresetId: customPresetId,
            portraitCustomPresets: structuredClone(customPresets),
            portraitStylePositive: theme === 'custom'
                ? customPreset.positive
                : String(builtIn?.positive ?? source.portraitStylePositive ?? DEFAULT_PORTRAIT_STYLE_POSITIVE).slice(0, PORTRAIT_STYLE_PROMPT_LIMIT),
            portraitStyleNegative: theme === 'custom'
                ? customPreset.negative
                : String(builtIn?.negative ?? source.portraitStyleNegative ?? DEFAULT_PORTRAIT_STYLE_NEGATIVE).slice(0, PORTRAIT_STYLE_PROMPT_LIMIT),
            portraitComposition: theme === 'custom'
                ? customPreset.composition
                : String(source.portraitComposition ?? DEFAULT_PORTRAIT_COMPOSITION).slice(0, PORTRAIT_COMPOSITION_PROMPT_LIMIT),
            portraitPromptFormat: theme === 'custom'
                ? customPreset.promptFormat
                : normalizePortraitPromptFormat(source.portraitPromptFormat),
            portraitUseMood: theme === 'custom' ? customPreset.useMood : source.portraitUseMood !== false,
            portraitUseLocation: theme === 'custom' ? customPreset.useLocation : source.portraitUseLocation === true,
            portraitSaveToGallery: source.portraitSaveToGallery === true,
        };
    }

    function normalizePortraitSettingsDraft(raw = {}) {
        const settings = getSettings();
        const current = portraitSettingsSnapshot(settings);
        const key = PORTRAIT_THEME_PRESETS[raw.portraitThemePreset]
            ? raw.portraitThemePreset
            : (raw.portraitThemePreset === 'custom' ? 'custom' : current.portraitThemePreset);
        const presets = portraitCustomPresetLibrary(raw.portraitCustomPresets ?? current.portraitCustomPresets);
        const requestedId = String((raw.portraitCustomPresetId ?? current.portraitCustomPresetId) || '').trim();
        const customPresetId = presets.some(item => item.id === requestedId) ? requestedId : presets[0].id;
        const preset = PORTRAIT_THEME_PRESETS[key];
        const next = {
            portraitGenerationEnabled: raw.portraitGenerationEnabled !== undefined ? Boolean(raw.portraitGenerationEnabled) : current.portraitGenerationEnabled,
            portraitThemePreset: key,
            portraitCustomPresetId: customPresetId,
            portraitCustomPresets: structuredClone(presets),
            portraitStylePositive: String(raw.portraitStylePositive ?? current.portraitStylePositive).slice(0, PORTRAIT_STYLE_PROMPT_LIMIT),
            portraitStyleNegative: String(raw.portraitStyleNegative ?? current.portraitStyleNegative).slice(0, PORTRAIT_STYLE_PROMPT_LIMIT),
            portraitComposition: String(raw.portraitComposition ?? current.portraitComposition).slice(0, PORTRAIT_COMPOSITION_PROMPT_LIMIT),
            portraitPromptFormat: normalizePortraitPromptFormat(raw.portraitPromptFormat ?? current.portraitPromptFormat),
            portraitUseMood: raw.portraitUseMood !== undefined ? Boolean(raw.portraitUseMood) : current.portraitUseMood,
            portraitUseLocation: raw.portraitUseLocation !== undefined ? Boolean(raw.portraitUseLocation) : current.portraitUseLocation,
            portraitSaveToGallery: raw.portraitSaveToGallery !== undefined ? Boolean(raw.portraitSaveToGallery) : current.portraitSaveToGallery,
        };
        if (key !== 'custom' && preset) {
            next.portraitStylePositive = preset.positive;
            next.portraitStyleNegative = preset.negative;
        } else {
            const index = next.portraitCustomPresets.findIndex(item => item.id === customPresetId);
            if (index >= 0) {
                next.portraitCustomPresets[index] = portraitCustomPreset({
                    ...next.portraitCustomPresets[index],
                    positive: next.portraitStylePositive,
                    negative: next.portraitStyleNegative,
                    composition: next.portraitComposition,
                    promptFormat: next.portraitPromptFormat,
                    useMood: next.portraitUseMood,
                    useLocation: next.portraitUseLocation,
                }, index);
            }
        }
        return next;
    }

    function portraitSettingsDraftFromUi() {
        const settings = getSettings();
        return normalizePortraitSettingsDraft({
            portraitGenerationEnabled: $('#npc_state_delta_portrait_generation_enabled').prop('checked'),
            portraitThemePreset: String($('#npc_state_delta_portrait_theme_preset').val() || 'custom'),
            portraitCustomPresetId: String($('#npc_state_delta_portrait_custom_preset').val() || settings.portraitCustomPresetId || ''),
            portraitCustomPresets: settings.portraitCustomPresets,
            portraitStylePositive: String($('#npc_state_delta_portrait_style_positive').val() || ''),
            portraitStyleNegative: String($('#npc_state_delta_portrait_style_negative').val() || ''),
            portraitComposition: String($('#npc_state_delta_portrait_composition').val() || ''),
            portraitPromptFormat: String($('#npc_state_delta_portrait_prompt_format').val() || 'hybrid'),
            portraitUseMood: $('#npc_state_delta_portrait_use_mood').prop('checked'),
            portraitUseLocation: $('#npc_state_delta_portrait_use_location').prop('checked'),
            portraitSaveToGallery: $('#npc_state_delta_portrait_save_gallery').prop('checked'),
        });
    }

    function writePortraitCustomPresetOptions(snapshot) {
        const control = $('#npc_state_delta_portrait_custom_preset');
        if (!control.length) return;
        const html = snapshot.portraitCustomPresets
            .map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
        if (control.html() !== html) control.html(html);
        control.val(snapshot.portraitCustomPresetId);
        $('#npc_state_delta_portrait_custom_preset_count').text(`${snapshot.portraitCustomPresets.length}/${PORTRAIT_CUSTOM_PRESET_LIMIT} saved`);
    }

    function writePortraitSettingsDraftToUi(draft) {
        const next = normalizePortraitSettingsDraft(draft);
        $('#npc_state_delta_portrait_generation_enabled').prop('checked', next.portraitGenerationEnabled);
        $('#npc_state_delta_portrait_theme_preset').val(next.portraitThemePreset);
        writePortraitCustomPresetOptions(next);
        $('#npc_state_delta_portrait_style_positive').val(next.portraitStylePositive);
        $('#npc_state_delta_portrait_style_negative').val(next.portraitStyleNegative);
        $('#npc_state_delta_portrait_composition').val(next.portraitComposition);
        $('#npc_state_delta_portrait_prompt_format').val(next.portraitPromptFormat);
        $('#npc_state_delta_portrait_use_mood').prop('checked', next.portraitUseMood);
        $('#npc_state_delta_portrait_use_location').prop('checked', next.portraitUseLocation);
        $('#npc_state_delta_portrait_save_gallery').prop('checked', next.portraitSaveToGallery);
        $('.npc-state-delta-custom-preset-library').toggleClass('delta-custom-active', next.portraitThemePreset === 'custom');
        return next;
    }

    function confirmDiscardPortraitDraft() {
        if (!rt.portraitSettingsDirty) return true;
        return globalThis.window?.confirm?.('Discard unsaved portrait preset edits and switch?') !== false;
    }

    function updatePortraitSettingsSaveUi() {
        const button = $('#npc_state_delta_save_portrait_settings');
        const status = $('#npc_state_delta_portrait_settings_status');
        button.toggleClass?.('npc-state-delta-busy', rt.portraitSettingsSaveBusy);
        button.prop?.('disabled', rt.portraitSettingsSaveBusy);
        if (rt.portraitSettingsSaveBusy) status.text?.('Saving…');
        else if (rt.portraitSettingsDirty) status.text?.('Unsaved changes');
        else status.text?.('Saved');
    }

    function markPortraitSettingsDirty() {
        rt.portraitSettingsDirty = true;
        updatePortraitSettingsSaveUi();
    }

    return { handlePortraitGeneratorEscape, npcImagePromptPair, executeNativePortraitGeneration, closePortraitGenerator, openPortraitGenerator, resetPortraitGeneratorFromDossier, generatePortraitFromDialog, useGeneratedPortrait, portraitSettingsSnapshot, normalizePortraitSettingsDraft, portraitSettingsDraftFromUi, writePortraitCustomPresetOptions, writePortraitSettingsDraftToUi, confirmDiscardPortraitDraft, updatePortraitSettingsSaveUi, markPortraitSettingsDirty };
}
