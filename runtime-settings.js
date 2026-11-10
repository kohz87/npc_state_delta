/* NPC State Delta settings (role: runtime-settings). The extension's settings key, the portrait theme presets and custom
   preset library, the defaults, getSettings (which fills in and canonicalizes the stored settings), persistSettings,
   injectDepthOf and the present-cast display normalizer. Moved out of index.js without change; nothing here keeps
   per-instance state, so index.js imports the functions directly. */

import { extension_settings, getContext } from '../../../extensions.js';
import { normalizeScannerMaxOutputTokens } from './scanner-routing.js';
import { normalizeRelationshipMapSettings } from './relationship-map-core.js';
import { DEFAULT_ALLOWANCE, normalizeAllowance, pacingDefaults } from './src/relationship-pacing.js';
import { DEFAULT_RELATIONSHIP, DEFAULT_RELATIONSHIP_CAPS, DEFAULT_RELATIONSHIP_CRITERIA, DEFAULT_IMPACT_CRITERIA, DEFAULT_MEMORY_CRITERIA, DEFAULT_BEHAVIOR_CRITERIA, normalizeRelationshipBaseline, normalizeNpcAdmissionMode, DEFAULT_PORTRAIT_STYLE_POSITIVE, DEFAULT_PORTRAIT_STYLE_NEGATIVE, DEFAULT_PORTRAIT_COMPOSITION, PORTRAIT_STYLE_PROMPT_LIMIT, PORTRAIT_COMPOSITION_PROMPT_LIMIT, normalizePortraitPromptFormat, normalizeCustomFieldNames } from './core.js';
import { normalizeSourceOfTruth } from './suite-handshake.js';

export const EXTENSION_NAME = 'npc_state_delta';

export const PORTRAIT_THEME_PRESETS = Object.freeze({
    fantasy_anime: {
        label: 'Fantasy Anime',
        positive: DEFAULT_PORTRAIT_STYLE_POSITIVE,
        negative: DEFAULT_PORTRAIT_STYLE_NEGATIVE,
    },
    anime_key_visual: {
        label: 'Anime Key Visual',
        positive: 'high-end fantasy anime key visual, crisp expressive linework, polished cel shading, luminous detailed eyes, elegant costume rendering, cinematic color design, studio-quality character illustration',
        negative: DEFAULT_PORTRAIT_STYLE_NEGATIVE,
    },
    painterly_fantasy: {
        label: 'Painterly Fantasy',
        positive: 'painterly fantasy character portrait, refined brushwork, detailed face and eyes, rich textile rendering, atmospheric cinematic light, elegant high-fantasy illustration',
        negative: 'low quality, blurry, bad anatomy, malformed hands, extra limbs, duplicate character, text, watermark, logo, flat cel shading, cheap 3d render',
    },
    dark_medieval: {
        label: 'Dark Medieval',
        positive: 'grounded dark medieval fantasy character portrait, weathered materials, restrained dramatic lighting, detailed practical clothing and armor, serious illustrated realism',
        negative: 'low quality, blurry, bad anatomy, extra limbs, duplicate character, text, watermark, logo, neon cyberpunk, modern streetwear, glossy plastic armor',
    },
    semi_realistic: {
        label: 'Semi-Realistic',
        positive: 'semi-realistic fantasy character portrait, natural facial anatomy, detailed eyes and hair, realistic fabric and metal textures, soft cinematic lighting, polished digital illustration',
        negative: 'low quality, blurry, bad anatomy, malformed hands, extra limbs, duplicate character, text, watermark, logo, chibi, super-deformed proportions, cheap 3d render',
    },
    custom: { label: 'Custom Library', positive: '', negative: '' },
});

export const PORTRAIT_CUSTOM_PRESET_LIMIT = 24;
const DEFAULT_CUSTOM_PORTRAIT_PRESET_ID = 'custom-default';

export function portraitCustomPreset(raw = {}, index = 0) {
    const id = String(raw.id || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '').slice(0, 64)
        || (index === 0 ? DEFAULT_CUSTOM_PORTRAIT_PRESET_ID : `custom-${index + 1}`);
    const name = String(raw.name || '').trim().slice(0, 80) || `Custom ${index + 1}`;
    return {
        id,
        name,
        positive: String(raw.positive ?? DEFAULT_PORTRAIT_STYLE_POSITIVE).slice(0, PORTRAIT_STYLE_PROMPT_LIMIT),
        negative: String(raw.negative ?? DEFAULT_PORTRAIT_STYLE_NEGATIVE).slice(0, PORTRAIT_STYLE_PROMPT_LIMIT),
        composition: String(raw.composition ?? DEFAULT_PORTRAIT_COMPOSITION).slice(0, PORTRAIT_COMPOSITION_PROMPT_LIMIT),
        promptFormat: normalizePortraitPromptFormat(raw.promptFormat ?? 'hybrid'),
        useMood: raw.useMood !== undefined ? Boolean(raw.useMood) : true,
        useLocation: raw.useLocation !== undefined ? Boolean(raw.useLocation) : false,
    };
}

export function portraitCustomPresetLibrary(raw) {
    const source = Array.isArray(raw) ? raw : [];
    const seen = new Set();
    const result = [];
    for (let index = 0; index < source.length && result.length < PORTRAIT_CUSTOM_PRESET_LIMIT; index += 1) {
        const preset = portraitCustomPreset(source[index], index);
        let id = preset.id;
        let suffix = 2;
        while (seen.has(id)) id = `${preset.id.slice(0, 56)}-${suffix++}`;
        seen.add(id);
        result.push({ ...preset, id });
    }
    if (!result.length) {
        result.push(portraitCustomPreset({
            id: DEFAULT_CUSTOM_PORTRAIT_PRESET_ID,
            name: 'Custom 1',
        }, 0));
    }
    return result;
}

export function portraitCustomPresetFor(source = {}, id = '') {
    const presets = portraitCustomPresetLibrary(source.portraitCustomPresets);
    const selectedId = String(id || source.portraitCustomPresetId || '').trim();
    return presets.find(item => item.id === selectedId) || presets[0];
}

export function nextPortraitCustomPresetId(presets = []) {
    const taken = new Set((presets || []).map(item => String(item?.id || '')));
    const base = `custom-${Date.now().toString(36)}`;
    let id = base;
    let suffix = 2;
    while (taken.has(id)) id = `${base}-${suffix++}`;
    return id;
}

function portraitCustomPresetNameKey(value) {
    return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function portraitCustomPresetNameTaken(presets, name, excludeId = '') {
    const key = portraitCustomPresetNameKey(name);
    if (!key) return false;
    return (presets || []).some(item => String(item?.id || '') !== String(excludeId || '')
        && portraitCustomPresetNameKey(item?.name) === key);
}

export function uniquePortraitCustomPresetName(presets, base, excludeId = '') {
    const root = String(base || 'Custom').trim().slice(0, 72) || 'Custom';
    if (!portraitCustomPresetNameTaken(presets, root, excludeId)) return root;
    for (let suffix = 2; suffix < 1000; suffix += 1) {
        const candidate = `${root} ${suffix}`.slice(0, 80);
        if (!portraitCustomPresetNameTaken(presets, candidate, excludeId)) return candidate;
    }
    return `${root.slice(0, 68)} ${Date.now().toString(36)}`.slice(0, 80);
}


const DEFAULTS = Object.freeze({
    schemaVersion: 30,
    enabled: true,
    autoScan: true,
    fullScanEveryTurn: false,
    narrationCapture: false,
    // (1.2.11) With one-pass capture: a quiet Refresh of the NPCs most in the last N captured
    // replies (0 = never), for the slow fields a block beside the story tends to leave thin.
    narrationCaptureCatchUp: 8,
    // (1.2.17) Opt-in: the one-pass rules in fewer words (about 500 tokens less per armed reply).
    narrationCaptureCompact: false,
    scannerConnectionProfile: '',
    portraitGenerationEnabled: true,
    portraitThemePreset: 'fantasy_anime',
    portraitCustomPresetId: DEFAULT_CUSTOM_PORTRAIT_PRESET_ID,
    portraitCustomPresets: [portraitCustomPreset({ id: DEFAULT_CUSTOM_PORTRAIT_PRESET_ID, name: 'Custom 1' })],
    portraitStylePositive: DEFAULT_PORTRAIT_STYLE_POSITIVE,
    portraitStyleNegative: DEFAULT_PORTRAIT_STYLE_NEGATIVE,
    portraitComposition: DEFAULT_PORTRAIT_COMPOSITION,
    portraitPromptFormat: 'hybrid',
    portraitUseMood: true,
    portraitUseLocation: false,
    portraitSaveToGallery: false,
    scanEvery: 5,
    scanDepth: 6,
    maxNpcs: 40,
    autoPruneStale: true,
    staleArchiveAfter: 30,
    staleDeleteAfter: 50,
    admissionMode: 'conservative',
    inject: true,
    // (1.2.16) 0: after the player's message, the cache-friendly tail. An install still on the old
    // default 1 is moved once (injectDepthTailUpgraded); any other depth the player set is kept.
    injectDepth: 0,
    // How many present NPCs the live dossier carries at most (the most relevant first).
    injectLimit: 3,
    injectBudgetTokens: 4000,
    customFieldNames: [],
    sourceOfTruth: normalizeSourceOfTruth(),
    branchRescan: true,
    midDeleteRewind: false,
    presentCastDisplay: 'full',
    presentCastDisplayChosen: false,
    // The floating npc state button while Story Block carries Delta's Present NPCs and Dossiers tabs.
    launcherWithStoryBlock: false,
    // The same button while a Story Block v2 host carries Delta (its Cast tab and overlay).
    launcherWithStoryBlockV2: false,
    relationshipBaseline: { ...DEFAULT_RELATIONSHIP },
    relationshipCaps: { ...DEFAULT_RELATIONSHIP_CAPS },
    relationshipAllowance: { ...DEFAULT_ALLOWANCE },
    relationshipCriteria: DEFAULT_RELATIONSHIP_CRITERIA,
    relationshipImpactCriteria: DEFAULT_IMPACT_CRITERIA,
    memoryCriteria: DEFAULT_MEMORY_CRITERIA,
    behaviorCriteria: DEFAULT_BEHAVIOR_CRITERIA,
    autoArchiveDeaths: true,
    autoReactivateArchived: true,
    // (v2 hidden notes) A scan that builds a new dossier also writes 2 to 5 layered hidden notes. Hosted only.
    layeredSecrets: true,
    dataFiles: {},
    sidecarTombstones: {},
    recoveryFiles: {},
    recoveryHistory: {},
    recoveryGarbage: {},
    // Settings whose controls live in their own modules (full-cast.js, scanner-output-ui.js,
    // relationship-map.js, calendar-settings.js); declared and normalized here, the one settings owner.
    fullCastScanEveryTurn: false,
    scannerMaxOutputTokens: 0,
    relationshipMap: normalizeRelationshipMapSettings(),
});

// Settings changes the reader or a recovery step makes are saved at once (ST's own 1 s debounce). The sidecar pointer that follows
// every dossier write is not urgent: the sidecar path is deterministic and hydration re-reads its revision, so those saves are
// coalesced (SETTINGS_LAZY_QUIET_MS after the last request, never later than SETTINGS_LAZY_MAX_MS after the first) and flushed on
// page hide, chat change and any immediate save. Each save writes ST's whole settings body, so a burst costs one, not one per write.
export const SETTINGS_LAZY_QUIET_MS = 8000;
export const SETTINGS_LAZY_MAX_MS = 30000;
const lazySave = { timer: null, firstAt: 0 };

function cancelLazySettingsSave() {
    if (lazySave.timer) clearTimeout(lazySave.timer);
    lazySave.timer = null;
    lazySave.firstAt = 0;
}

export function persistSettings() {
    cancelLazySettingsSave();
    const ctx = getContext();
    if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
}

export function persistSettingsLazy() {
    const now = Date.now();
    if (!lazySave.timer) lazySave.firstAt = now;
    else clearTimeout(lazySave.timer);
    const wait = Math.max(0, Math.min(SETTINGS_LAZY_QUIET_MS, lazySave.firstAt + SETTINGS_LAZY_MAX_MS - now));
    lazySave.timer = setTimeout(() => {
        cancelLazySettingsSave();
        // A timer has no caller to take an error: a failed deferred save is logged, not thrown.
        try { persistSettings(); } catch (error) { console.warn('[NPC State Delta] the deferred settings save could not be requested.', error); }
    }, wait);
}

// Page hide, chat change: a pending coalesced save is handed to ST now (its own 1 s debounce starts). Nothing pending, nothing saved.
export function flushPendingSettingsSave() {
    if (!lazySave.timer) return false;
    persistSettings();
    return true;
}

// The dossier's depth: 0 to 20, 0 kept (it is the default since 1.2.16).
export function injectDepthOf(settings) {
    const depth = Math.round(Number(settings?.injectDepth));
    return Number.isFinite(depth) ? Math.max(0, Math.min(20, depth)) : 0;
}

// The host's answer to "is Story Block's RPG feature on?", set by runtime-hosted.js; null (no host) means off.
let rpgProbe = null;
export function setRpgProbe(probe) { rpgProbe = typeof probe === 'function' ? probe : null; }

// The custom field names in force right now: the configured names, plus "Level" while Story Block's RPG feature is on
// (read at call time, never stored, so a feature switched mid-chat is seen by the next prompt, injection or view).
// Standalone or RPG off: exactly the configured names. The settings page keeps showing the configured list.
export function effectiveCustomFieldNames(settings = getSettings()) {
    const names = normalizeCustomFieldNames(settings?.customFieldNames);
    let on = false;
    try { on = rpgProbe?.() === true; } catch { on = false; }
    return on && !names.some(name => name.toLowerCase() === 'level') ? [...names, 'Level'] : names;
}

export function getSettings() {
    let settings = extension_settings[EXTENSION_NAME];
    let dirty = false;
    if (!settings || typeof settings !== 'object') {
        settings = structuredClone(DEFAULTS);
        extension_settings[EXTENSION_NAME] = settings;
        dirty = true;
    }

    const assign = (key, value, equal = Object.is) => {
        if (equal(settings[key], value)) return;
        settings[key] = structuredClone(value);
        dirty = true;
    };
    const sameJson = (a, b) => {
        try { return JSON.stringify(a) === JSON.stringify(b); }
        catch { return false; }
    };

    for (const [key, value] of Object.entries(DEFAULTS)) {
        if (settings[key] === undefined) assign(key, value);
    }
    if (!settings.dataFiles || typeof settings.dataFiles !== 'object') assign('dataFiles', {});
    if (!settings.sidecarTombstones || typeof settings.sidecarTombstones !== 'object') assign('sidecarTombstones', {});
    if (!settings.recoveryFiles || typeof settings.recoveryFiles !== 'object') assign('recoveryFiles', {});
    if (!settings.recoveryHistory || typeof settings.recoveryHistory !== 'object') assign('recoveryHistory', {});
    if (!settings.recoveryGarbage || typeof settings.recoveryGarbage !== 'object') assign('recoveryGarbage', {});

    // Current-format settings are canonicalized in place; older Delta schemas are unsupported.
    assign('relationshipBaseline', normalizeRelationshipBaseline(settings.relationshipBaseline), sameJson);
    const pacing = pacingDefaults(settings);
    assign('relationshipImpactCriteria', pacing.impactCriteria);
    assign('relationshipCaps', pacing.caps, sameJson);
    assign('relationshipAllowance', normalizeAllowance(settings.relationshipAllowance), sameJson);
    assign('relationshipPacingMigrated', true);
    assign('customFieldNames', normalizeCustomFieldNames(settings.customFieldNames), sameJson);
    assign('sourceOfTruth', normalizeSourceOfTruth(settings.sourceOfTruth), sameJson);
    assign('relationshipCriteria', typeof settings.relationshipCriteria === 'string' ? settings.relationshipCriteria : DEFAULT_RELATIONSHIP_CRITERIA);
    assign('memoryCriteria', typeof settings.memoryCriteria === 'string' ? settings.memoryCriteria : DEFAULT_MEMORY_CRITERIA);
    assign('behaviorCriteria', typeof settings.behaviorCriteria === 'string' ? settings.behaviorCriteria : DEFAULT_BEHAVIOR_CRITERIA);
    assign('admissionMode', normalizeNpcAdmissionMode(settings.admissionMode));
    assign('presentCastDisplay', normalizePresentCastDisplay(settings.presentCastDisplay));
    assign('presentCastDisplayChosen', settings.presentCastDisplayChosen === true);
    assign('launcherWithStoryBlock', settings.launcherWithStoryBlock === true);
    assign('launcherWithStoryBlockV2', settings.launcherWithStoryBlockV2 === true);
    // 1.0.70 raised the default budget from 1800 to 4000 tokens. An install still on the old default
    // is moved once; any value the player chose, including a later deliberate 1800, is kept.
    const legacyDefaultBudget = settings.injectBudgetDefaultUpgraded !== true && Number(settings.injectBudgetTokens) === 1800;
    assign('injectBudgetTokens', legacyDefaultBudget ? 4000 : Math.max(512, Math.min(6000, Math.round(Number(settings.injectBudgetTokens) || 4000))));
    assign('injectBudgetDefaultUpgraded', true);
    const legacyDefaultDepth = settings.injectDepthTailUpgraded !== true && Number(settings.injectDepth) === 1;
    assign('injectDepth', legacyDefaultDepth ? 0 : injectDepthOf(settings));
    assign('injectDepthTailUpgraded', true);
    assign('layeredSecrets', settings.layeredSecrets !== false);
    assign('fullScanEveryTurn', settings.fullScanEveryTurn === true);
    assign('narrationCapture', settings.narrationCapture === true);
    assign('narrationCaptureCompact', settings.narrationCaptureCompact === true);
    assign('narrationCaptureCatchUp', Number.isFinite(Number(settings.narrationCaptureCatchUp)) ? Math.max(0, Math.min(50, Math.round(Number(settings.narrationCaptureCatchUp)))) : 8);
    assign('scannerConnectionProfile', typeof settings.scannerConnectionProfile === 'string' ? settings.scannerConnectionProfile.trim() : '');
    assign('portraitGenerationEnabled', settings.portraitGenerationEnabled !== false);
    assign('portraitThemePreset', PORTRAIT_THEME_PRESETS[settings.portraitThemePreset] ? settings.portraitThemePreset : 'custom');
    const portraitCustomPresets = portraitCustomPresetLibrary(settings.portraitCustomPresets);
    assign('portraitCustomPresets', portraitCustomPresets, sameJson);
    const portraitCustomPresetId = portraitCustomPresets.some(item => item.id === settings.portraitCustomPresetId)
        ? settings.portraitCustomPresetId
        : portraitCustomPresets[0].id;
    assign('portraitCustomPresetId', portraitCustomPresetId);
    const activeCustomPortraitPreset = portraitCustomPresets.find(item => item.id === portraitCustomPresetId) || portraitCustomPresets[0];
    if (settings.portraitThemePreset === 'custom') {
        assign('portraitStylePositive', activeCustomPortraitPreset.positive);
        assign('portraitStyleNegative', activeCustomPortraitPreset.negative);
        assign('portraitComposition', activeCustomPortraitPreset.composition);
        assign('portraitPromptFormat', activeCustomPortraitPreset.promptFormat);
        assign('portraitUseMood', activeCustomPortraitPreset.useMood);
        assign('portraitUseLocation', activeCustomPortraitPreset.useLocation);
    }
    assign('portraitStylePositive', String(settings.portraitStylePositive ?? DEFAULT_PORTRAIT_STYLE_POSITIVE).slice(0, PORTRAIT_STYLE_PROMPT_LIMIT));
    assign('portraitStyleNegative', String(settings.portraitStyleNegative ?? DEFAULT_PORTRAIT_STYLE_NEGATIVE).slice(0, PORTRAIT_STYLE_PROMPT_LIMIT));
    assign('portraitComposition', String(settings.portraitComposition ?? DEFAULT_PORTRAIT_COMPOSITION).slice(0, PORTRAIT_COMPOSITION_PROMPT_LIMIT));
    assign('portraitPromptFormat', normalizePortraitPromptFormat(settings.portraitPromptFormat));
    assign('portraitUseMood', settings.portraitUseMood !== false);
    assign('portraitUseLocation', settings.portraitUseLocation === true);
    assign('portraitSaveToGallery', settings.portraitSaveToGallery === true);
    assign('autoPruneStale', settings.autoPruneStale !== false);
    const archiveAfter = Math.max(10, Math.min(999, Math.round(Number(settings.staleArchiveAfter) || 30)));
    assign('staleArchiveAfter', archiveAfter);
    assign('staleDeleteAfter', Math.max(archiveAfter + 1, Math.min(1000, Math.round(Number(settings.staleDeleteAfter) || 50))));
    assign('injectLimit', Math.max(1, Math.min(12, Math.round(Number(settings.injectLimit) || 3))));
    assign('fullCastScanEveryTurn', settings.fullCastScanEveryTurn === true);
    assign('scannerMaxOutputTokens', normalizeScannerMaxOutputTokens(settings.scannerMaxOutputTokens));
    assign('relationshipMap', normalizeRelationshipMapSettings(settings.relationshipMap), sameJson);
    // The fantasy calendar (calendar-settings.js) is optional: absent means none; only a stored
    // object is a calendar.
    if (settings.calendarConfig !== undefined && (!settings.calendarConfig || typeof settings.calendarConfig !== 'object' || Array.isArray(settings.calendarConfig))) {
        delete settings.calendarConfig;
        dirty = true;
    }
    assign('schemaVersion', DEFAULTS.schemaVersion);

    if (dirty) persistSettings();
    return settings;
}

const PRESENT_CAST_DISPLAY_MODES = Object.freeze(['full', 'compact', 'storyblock', 'off']);

export function normalizePresentCastDisplay(value) {
    return PRESENT_CAST_DISPLAY_MODES.includes(value) ? value : 'full';
}
