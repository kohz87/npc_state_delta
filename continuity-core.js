/* NPC State Delta Stage 4 continuity facade. */
import * as mechanics from './core-mechanics.js';
import {
    applyAppearanceUpdate,
    normalizeAppearanceForms,
    normalizeAppearanceModel,
    resolveNpcAppearance,
} from './appearance.js';
import {
    isTerminalNpcDeath,
    normalizeTerminalNpc,
    protectTerminalNpc,
} from './terminal-lifecycle.js';

function lockedAppearance(npc = {}) {
    return Array.isArray(npc.manualProfileFields) && npc.manualProfileFields.includes('appearance');
}
function sameNpc(raw = {}, npc = {}) {
    if (raw?.id && String(raw.id) === String(npc.id)) return true;
    if (raw?.name && mechanics.npcMatchesLabel(npc, raw.name)) return true;
    return Array.isArray(raw?.aliases) && raw.aliases.some(alias => mechanics.npcMatchesLabel(npc, alias));
}
function matchingPrevious(npc, source = []) {
    return (Array.isArray(source) ? source : []).filter(item => item && (
        String(item.id || '') === String(npc?.id || '')
        || (npc?.name && mechanics.npcMatchesLabel(item, npc.name))
        || (item?.name && mechanics.npcMatchesLabel(npc, item.name))
        || (item?.aliases || []).some(alias => mechanics.npcMatchesLabel(npc, alias))
    ));
}
function applyModel(npc = {}, rawUpdate = null, options = {}) {
    const locked = lockedAppearance(npc);
    const model = rawUpdate
        ? applyAppearanceUpdate(npc, rawUpdate, { locked, context: options.developmentContext || '' })
        : normalizeAppearanceModel(npc, { locked });
    const next = { ...npc, ...model };
    next.appearance = resolveNpcAppearance(next);
    return normalizeTerminalNpc(next);
}
function mergeAppearanceKnowledge(sources = [], current = {}) {
    const normalizedSources = sources.map(source => applyModel(source));
    const locked = normalizedSources.find(lockedAppearance);
    if (locked) return applyModel({ ...current, ...normalizeAppearanceModel(locked, { locked: true }) });

    const currentModel = normalizeAppearanceModel(current);
    const forms = [];
    for (const model of [...normalizedSources.map(item => normalizeAppearanceModel(item)), currentModel]) {
        for (const form of normalizeAppearanceForms(model.appearanceForms)) {
            const key = form.name.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
            const index = forms.findIndex(item => item.name.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim() === key);
            if (index >= 0) forms[index] = form;
            else if (forms.length < 8) forms.push(form);
        }
    }
    const latest = [...normalizedSources, current]
        .sort((a, b) => Number(a?.updatedAt || 0) - Number(b?.updatedAt || 0))
        .at(-1) || current;
    const selection = currentModel.currentForm || currentModel.currentFormUnknown
        ? currentModel
        : normalizeAppearanceModel(latest);
    const overall = currentModel.overallAppearance
        || [...normalizedSources].reverse().map(item => normalizeAppearanceModel(item).overallAppearance).find(Boolean)
        || '';
    return applyModel({
        ...current,
        overallAppearance: overall,
        unclassifiedAppearance: selection.unclassifiedAppearance || '',
        appearanceForms: forms,
        currentForm: selection.currentForm,
        currentFormUnknown: selection.currentFormUnknown,
        appearanceModelVersion: 1,
    });
}

export function normalizeNpcRecord(raw = {}) {
    return applyModel(mechanics.normalizeNpcRecord(raw));
}
export function normalizeScanNpc(raw = {}, options = {}) {
    return {
        ...mechanics.normalizeScanNpc(raw, options),
        overallAppearance: String(raw.overallAppearance ?? raw.overall_appearance ?? '').trim().slice(0, 800),
        overallAppearanceState: String(raw.overallAppearanceState ?? raw.overall_appearance_state ?? '').trim().toLowerCase(),
        overallAppearanceReason: String(raw.overallAppearanceReason ?? raw.overall_appearance_reason ?? '').trim().slice(0, 500),
        appearanceForms: normalizeAppearanceForms(raw.appearanceForms ?? raw.appearance_forms, { updates: true }),
        appearanceFormsProvided: Object.prototype.hasOwnProperty.call(raw, 'appearanceForms') || Object.prototype.hasOwnProperty.call(raw, 'appearance_forms'),
        currentForm: String(raw.currentForm ?? raw.current_form ?? '').trim().slice(0, 120),
        currentFormState: (() => {
            const value = String(raw.currentFormState ?? raw.current_form_state ?? '').trim().toLowerCase();
            if (['unknown', 'unspecified', 'clear'].includes(value)) return 'unknown';
            if (['select', 'switch', 'change', 'current'].includes(value)) return 'select';
            return 'keep';
        })(),
        currentFormReason: String(raw.currentFormReason ?? raw.current_form_reason ?? '').trim().slice(0, 500),
    };
}

// This facade is what the runtime imports. A deliberate manual Restore is the retained
// UI's explicit erroneous-death correction. Automatic model/structured writers do not
// call this path to revive a terminal record.
export function setNpcArchived(npc, archived, options = {}) {
    const current = normalizeNpcRecord(npc);
    const correcting = !archived && isTerminalNpcDeath(current)
        && (options.allowDeathCorrection === true || Number.isInteger(options.sourceMessageId));
    if (!archived && isTerminalNpcDeath(current) && !correcting) return normalizeTerminalNpc(current);
    const next = mechanics.setNpcArchived(current, archived, correcting
        ? { ...options, lifeState: options.lifeState ?? 'alive' }
        : (archived && isTerminalNpcDeath(current) ? { ...options, reason: 'deceased', lifeState: 'deceased' } : options));
    if (correcting) {
        const correctionReason = String(options.lifeStateReason || 'Manual correction: the prior death record was marked erroneous.').trim().slice(0, 500);
        Object.assign(next, {
            archived: false,
            archiveReason: '',
            archivedAt: null,
            archiveSourceMessageId: null,
            lifeState: 'alive',
            lifeStateCertainty: 'explicit',
            lifeStateReason: correctionReason,
            present: false,
            worldActive: false,
            deathCorrection: {
                reason: correctionReason,
                correctedAt: Date.now(),
                sourceMessageId: Number.isInteger(options.sourceMessageId) ? options.sourceMessageId : null,
                previousDeathSourceMessageId: Number.isInteger(current.archiveSourceMessageId) ? current.archiveSourceMessageId : null,
                previousDeathReason: String(current.lifeStateReason || '').trim().slice(0, 500),
            },
        });
    }
    return normalizeNpcRecord(next);
}

export function applyNpcStateCommand(state, command, options = {}) {
    const prior = (state?.npcs || []).filter(isTerminalNpcDeath).map(normalizeNpcRecord);
    const result = mechanics.applyNpcStateCommand(state, command, options);
    result.state.npcs = (result.state.npcs || []).map(npc => {
        const protectedNpc = matchingPrevious(npc, prior)[0];
        return protectedNpc ? protectTerminalNpc(protectedNpc, applyModel(npc)) : applyModel(npc);
    });
    if (result.report?.status === 'restored' && prior.some(npc => String(npc.id) === String(result.report.npcId))) result.report.status = 'terminal-death';
    return result;
}

export function mergeScanResult(state, scanResult, options = {}) {
    const previous = (state?.npcs || []).map(normalizeNpcRecord);
    // Production scanner/Refresh/backfill/import transactions carry sourceMessageId.
    // That provenance marks them as automatic writers and makes confirmed death terminal.
    // Direct unowned utility calls remain outside that automatic-writer contract.
    const automaticOwnedWriter = Number.isInteger(options.sourceMessageId) || options.enforceTerminalDeath === true;
    const result = mechanics.mergeScanResult(state, scanResult, options);
    const ordinary = Array.isArray(scanResult?.npcs) ? scanResult.npcs : [];
    const profiles = Array.isArray(scanResult?.profileUpdates)
        ? scanResult.profileUpdates
        : (Array.isArray(scanResult?.profile_updates) ? scanResult.profile_updates : []);

    result.state.npcs = (result.state.npcs || []).map(rawNpc => {
        const sources = matchingPrevious(rawNpc, previous);
        const ordinaryUpdate = ordinary.find(raw => sameNpc(raw, rawNpc));
        const rawForms = ordinaryUpdate && (ordinaryUpdate.appearanceForms ?? ordinaryUpdate.appearance_forms);
        const seed = !sources.length && rawForms ? { ...rawNpc, appearanceModelVersion: 1 } : rawNpc;
        let npc = applyModel(seed);
        if (ordinaryUpdate) npc = applyModel(npc, ordinaryUpdate, options);
        const profileUpdate = profiles.find(raw => sameNpc(raw, npc));
        if (profileUpdate) npc = applyModel(npc, profileUpdate, options);
        if (sources.length) npc = mergeAppearanceKnowledge(sources, npc);

        const terminalSource = sources.find(isTerminalNpcDeath);
        if (terminalSource && automaticOwnedWriter) return protectTerminalNpc(terminalSource, npc);
        return isTerminalNpcDeath(npc) ? normalizeTerminalNpc(npc) : npc;
    });
    return result;
}

export function buildNpcPortraitPrompts(rawNpc = {}, options = {}) {
    const model = normalizeAppearanceModel(rawNpc, { locked: lockedAppearance(rawNpc) });
    const formSpecific = Boolean(model.currentFormUnknown
        || (model.currentForm && String(model.currentForm).trim().toLocaleLowerCase() !== 'base'));
    return mechanics.buildNpcPortraitPrompts({
        ...rawNpc,
        ...(formSpecific ? { species: '', race: '' } : {}),
        appearance: resolveNpcAppearance(rawNpc),
    }, options);
}

export function buildInjection(npcs, text, turn = 0, limit = 3, behaviorCriteria = mechanics.DEFAULT_BEHAVIOR_CRITERIA, budgetTokens = 1800, socialGraph = null) {
    const resolved = (Array.isArray(npcs) ? npcs : []).map(npc => ({
        ...normalizeTerminalNpc(npc),
        appearance: resolveNpcAppearance(npc),
    }));
    return mechanics.buildInjection(resolved, text, turn, limit, behaviorCriteria, budgetTokens, socialGraph, { includeAppearance: true });
}

const COMPACT_STAGE4_RULE = `\nS4: forms/current; confirmed death terminal.`;
const APPEARANCE_RULES = `\nSTAGE 4 APPEARANCE: appearance is the current visible presentation. overallAppearance is only form-independent visual detail. Named anatomical presentations use appearanceForms:[{name,appearance,state:"refine|change",reason}] plus currentForm/currentFormState:"select". A switch preserves other forms. If transformation is visible but its stable form name is unknown, use currentFormState:"unknown" and grounded current appearance only; never reuse another form's anatomy. Natural anatomical transitions count even when narration never says "form" or "transform". Omission preserves forms/selection. Locked Appearance protects overall/current presentation, forms and selection.`;
const DEATH_RULES = `\nSTAGE 4 DEATH: explicit confirmed death uses lifeState:"deceased"+lifeStateCertainty:"explicit" and is terminal to automatic writers. Later narrative/model output cannot return that NPC to alive/present/worldActive; only explicit player correction or owned-history rollback may reverse an erroneous death.`;
const SCANNER_FORM_SHAPE_ANCHOR = '"appearance":"grounded prompt-ready visual description"';
const SCANNER_FORM_SHAPE = '"appearance":"grounded prompt-ready visual description","overallAppearance":"form-independent visual details or empty","overallAppearanceState":"keep|refine|change","overallAppearanceReason":"","appearanceForms":[{"name":"stable established form name","appearance":"form-specific visible anatomy","state":"refine|change","reason":""}],"currentForm":"stable established form name or empty","currentFormState":"keep|select|unknown","currentFormReason":""';
function hasImplicitAnatomicalTransition(transcript = '') {
    const text = String(transcript || '');
    const anatomy = /\b(horns?|wings?|tails?|ears?|feathers?|plumage|quills?|scales?|talons?|claws?|beaks?|fins?|gills?|antlers?)\b/i.test(text);
    const transition = /\b(dissolv(?:e|ed|es|ing)?|retract(?:ed|s|ing)?|withdraw(?:n|s|ing)?|vanish(?:ed|es|ing)?|disappear(?:ed|s|ing)?|melt(?:ed|s|ing)?|smooth(?:ed|s|ing)?|emerg(?:e|ed|es|ing)|sprout(?:ed|s|ing)?|grow(?:n|s|ing)?|manifest(?:ed|s|ing)?|materializ(?:e|ed|es|ing)|fade(?:d|s|ing)?|recede(?:d|s|ing)?|absorb(?:ed|s|ing)?|sink(?:s|ing)?\s+(?:back|into)|draw(?:n|s|ing)?\s+(?:back|into))\b/i.test(text);
    return anatomy && transition;
}
function needsDetailedStage4(options = {}) {
    const transcript = String(options?.transcript || '');
    const existing = Array.isArray(options?.existingNpcs) ? options.existingNpcs : [];
    return existing.some(npc => (npc?.appearanceForms?.length || npc?.currentForm || isTerminalNpcDeath(npc)))
        || /\b(transform(?:s|ed|ing|ation)?|form|shape-?shift|metamorph|human form|beast form|dragon form|dies|died|dead|deceased|killed|death)\b/i.test(transcript)
        || hasImplicitAnatomicalTransition(transcript);
}
function establishedAppearanceContext(options = {}) {
    const transcriptKey = mechanics.normalizeName(options?.transcript || options?.dossierText || '');
    const source = Array.isArray(options?.existingNpcs) ? options.existingNpcs : [options?.existingNpc, options?.targetNpc].filter(Boolean);
    const records = source.filter(npc => {
        if (!npc || (!npc.appearanceForms?.length && !npc.currentForm && !npc.currentFormUnknown)) return false;
        if (source.length <= 1 || npc.present || npc.worldActive) return true;
        const labels = [npc.name, ...(npc.aliases || [])].map(mechanics.normalizeName).filter(Boolean);
        return labels.some(label => transcriptKey.includes(label));
    }).slice(0, 6).map(npc => ({
        id: npc.id,
        name: npc.name,
        currentForm: npc.currentForm || '',
        currentFormUnknown: Boolean(npc.currentFormUnknown),
        appearanceForms: normalizeAppearanceForms(npc.appearanceForms),
    }));
    return records.length ? `\nEstablished Stage 4 appearance forms (preserve omissions): ${JSON.stringify(records)}` : '';
}
function appendRules(prompt, options = {}, detailed = true) {
    let sanitized = String(prompt).replace('deceased+explicit=death; explicit alive=reactivate.', 'deceased+explicit=terminal death; alive output cannot revive.');
    if (detailed && sanitized.includes(SCANNER_FORM_SHAPE_ANCHOR)) sanitized = sanitized.replace(SCANNER_FORM_SHAPE_ANCHOR, SCANNER_FORM_SHAPE);
    const context = establishedAppearanceContext(options);
    return detailed ? `${sanitized}${COMPACT_STAGE4_RULE}${APPEARANCE_RULES}${DEATH_RULES}${context}` : `${sanitized}${COMPACT_STAGE4_RULE}${context}`;
}
export function buildScannerPrompt(options = {}) { return appendRules(mechanics.buildScannerPrompt(options), options, needsDetailedStage4(options)); }
export function buildBackfillPrompt(options = {}) { return appendRules(mechanics.buildBackfillPrompt(options), options); }
export function buildDossierImportPrompt(options = {}) { return appendRules(mechanics.buildDossierImportPrompt(options), options); }
export function buildProfileRefreshPrompt(options = {}) { return appendRules(mechanics.buildProfileRefreshPrompt(options), options); }
