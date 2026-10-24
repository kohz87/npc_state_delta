/* NPC State Delta Stage 4 continuity facade. */
import * as mechanics from './core-mechanics.js';
import {
    APPEARANCE_MODEL_VERSION,
    applyAppearanceUpdate,
    carryOmittedPhysicalTraits,
    completeFormWithShared,
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
function applyModel(npc = {}, rawUpdate = null, options = {}) {
    const locked = lockedAppearance(npc);
    const model = rawUpdate
        ? applyAppearanceUpdate(npc, rawUpdate, { locked, context: options.developmentContext || '', seedContext: options.appearanceSeedContext || '' })
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
        appearanceModelVersion: APPEARANCE_MODEL_VERSION,
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
        const protectedNpc = mechanics.matchingNpcRecords(npc, prior)[0];
        return protectedNpc ? protectTerminalNpc(protectedNpc, applyModel(npc)) : applyModel(npc);
    });
    if (result.report?.status === 'restored' && prior.some(npc => String(npc.id) === String(result.report.npcId))) result.report.status = 'terminal-death';
    return result;
}

export function mergeScanResult(state, scanResult, options = {}) {
    const previous = (state?.npcs || []).map(normalizeNpcRecord);
    // (C05, C-1) Confirmed death is terminal for every merge: scanner, Refresh, backfill and import
    // output, with or without a source message, cannot make the NPC alive or present again. Only
    // the reader's own correction (manual Restore / life state in the editor) and owned rollback can.
    const result = mechanics.mergeScanResult(state, scanResult, options);
    const ordinary = Array.isArray(scanResult?.npcs) ? scanResult.npcs : [];
    const profiles = Array.isArray(scanResult?.profileUpdates)
        ? scanResult.profileUpdates
        : (Array.isArray(scanResult?.profile_updates) ? scanResult.profile_updates : []);

    result.state.npcs = (result.state.npcs || []).map(rawNpc => {
        const sources = mechanics.matchingNpcRecords(rawNpc, previous);
        let ordinaryUpdate = ordinary.find(raw => mechanics.scanRowMatchesNpc(raw, rawNpc));
        let profileUpdate = profiles.find(raw => mechanics.scanRowMatchesNpc(raw, rawNpc));
        const rawForms = ordinaryUpdate && (ordinaryUpdate.appearanceForms ?? ordinaryUpdate.appearance_forms);
        const seed = !sources.length && rawForms
            ? {
                ...rawNpc,
                appearanceModelVersion: APPEARANCE_MODEL_VERSION,
                appearanceForms: normalizeAppearanceForms(rawNpc.appearanceForms)
                    .map(form => ({ ...form, appearance: completeFormWithShared(rawNpc.overallAppearance, form.appearance) })),
            }
            : (sources.length && !lockedAppearance(rawNpc) ? carryOmittedPhysicalTraits(sources[0], rawNpc) : rawNpc);

        const formSwitch = Boolean(
            ordinaryUpdate?.currentForm || ordinaryUpdate?.currentFormState
            || profileUpdate?.currentForm || profileUpdate?.currentFormState
            || (ordinaryUpdate && (ordinaryUpdate.appearanceForms ?? ordinaryUpdate.appearance_forms))
            || (profileUpdate && (profileUpdate.appearanceForms ?? profileUpdate.appearance_forms))
        );
        const appearanceRejected = !formSwitch && (sources.length
            ? (sources[0]?.appearance ? mechanics.normalizeName(rawNpc.appearance) === mechanics.normalizeName(sources[0]?.appearance) : !rawNpc.appearance)
            : (!rawNpc.appearance));
        if (appearanceRejected) {
            if (ordinaryUpdate && (ordinaryUpdate.appearance || ordinaryUpdate.appearanceState)) {
                ordinaryUpdate = { ...ordinaryUpdate };
                delete ordinaryUpdate.appearance;
                delete ordinaryUpdate.appearanceState;
                delete ordinaryUpdate.appearanceReason;
            }
            if (profileUpdate && (profileUpdate.appearance || profileUpdate.appearanceState)) {
                profileUpdate = { ...profileUpdate };
                delete profileUpdate.appearance;
                delete profileUpdate.appearanceState;
                delete profileUpdate.appearanceReason;
            }
        }

        // Ordinary scans ground appearance only in story text about this NPC; targeted Refresh and
        // backfill reconcile one named NPC and keep their whole window.
        const appearanceOptions = options.allowTargetedDurableSeed === true || !options.developmentContext
            ? options
            : {
                ...options,
                appearanceSeedContext: options.developmentContext,
                developmentContext: mechanics.npcScopedNarration(options.developmentContext, rawNpc, (result.state.npcs || [])
                    .filter(other => other !== rawNpc && String(other?.id || '') !== String(rawNpc?.id || ''))
                    .flatMap(other => [other?.name, ...(Array.isArray(other?.aliases) ? other.aliases : [])])
                    .filter(Boolean)
                    .slice(0, 64)),
            };
        let npc = applyModel(seed);
        if (ordinaryUpdate) npc = applyModel(npc, ordinaryUpdate, appearanceOptions);
        if (profileUpdate) npc = applyModel(npc, profileUpdate, appearanceOptions);
        if (sources.length) npc = mergeAppearanceKnowledge(sources, npc);

        const terminalSource = sources.find(isTerminalNpcDeath);
        if (terminalSource) return protectTerminalNpc(terminalSource, npc);
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

export function buildInjection(npcs, text, turn = 0, limit = 3, behaviorCriteria = mechanics.DEFAULT_BEHAVIOR_CRITERIA, budgetTokens = mechanics.DEFAULT_INJECTION_BUDGET_TOKENS, socialGraph = null, { namedNpcIds = [], customFieldNames = [], sceneDeferred = false } = {}) {
    const resolved = (Array.isArray(npcs) ? npcs : []).map(npc => ({
        ...normalizeTerminalNpc(npc),
        appearance: resolveNpcAppearance(npc),
    }));
    return mechanics.buildInjection(resolved, text, turn, limit, behaviorCriteria, budgetTokens, socialGraph, { includeAppearance: true, namedNpcIds, customFieldNames, sceneDeferred: sceneDeferred === true });
}

const COMPACT_STAGE4_RULE = `\nS4: forms/current; confirmed death terminal.`;
// Form rules shared by every prompt. The scanner and Refresh already define flat Appearance (current
// visible presentation; correction=>refine, clothes/form change=>change+reason) in their own rules, so
// only backfill and dossier import, which do not, get that sentence here.
const APPEARANCE_FORM_RULES = 'With named forms, each form appearance is that form\'s COMPLETE visible appearance (body+outfit); overallAppearance is only for an NPC without forms. Named anatomy uses appearanceForms:[{name,appearance,state:"refine|change",reason}]+currentForm/currentFormState:"select"; switches preserve other forms. Unknown transformed form=>currentFormState:"unknown"+grounded current appearance; never reuse another form\'s anatomy. Omission preserves; Appearance lock protects all appearance state.';
const APPEARANCE_RULES = `\nSTAGE 4 APPEARANCE: ${APPEARANCE_FORM_RULES}`;
const APPEARANCE_RULES_WITH_FLAT = `\nSTAGE 4 APPEARANCE: appearance=current outfit/gear/visible condition. Explicit correction/reveal=>refine corrected FULL appearance; changed clothes/form/presentation=>change+reason FULL appearance. ${APPEARANCE_FORM_RULES}`;
const DEATH_RULES = `\nSTAGE 4 DEATH: explicit death is terminal: lifeState:"deceased"+lifeStateCertainty:"explicit"; later output cannot return that NPC to alive/present/worldActive.`;
// (cleanup step 12, I-10) The one-pass rules are written before the reply exists, and the reply can
// bring a transformation or a death, so they always carry the form and death rules, in short.
const CAPTURE_STAGE4_RULES = `\nSTAGE 4: named forms=>appearanceForms:[{name,appearance=its COMPLETE look,state:"refine|change",reason}]+currentForm,currentFormState:"select|unknown" (unknown=>grounded appearance, never another form's anatomy); a switch keeps other forms; overallAppearance only without forms. Explicit death (deceased+explicit) is terminal: never alive/present/worldActive again.`;
const PROFILE_REFRESH_APPEARANCE_RULE = `\nREFRESH: visible anatomy changes are form evidence even without literal "form"/"transform" wording.`;
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
const ESTABLISHED_FORM_CONTEXT_CHARS = 240;
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
        // The current form is shown whole; the others only need enough to be recognised and kept.
        appearanceForms: normalizeAppearanceForms(npc.appearanceForms).map(form => (form.name === npc.currentForm || form.appearance.length <= ESTABLISHED_FORM_CONTEXT_CHARS
            ? form
            : { ...form, appearance: `${form.appearance.slice(0, ESTABLISHED_FORM_CONTEXT_CHARS).replace(/\s+\S*$/, '')}…` })),
    }));
    return records.length ? `\nEstablished Stage 4 appearance forms (preserve omissions): ${JSON.stringify(records)}` : '';
}
function insertPromptBlockBefore(prompt = '', anchor = '', block = '') {
    const source = String(prompt);
    const addition = String(block || '');
    const index = anchor ? source.indexOf(anchor) : -1;
    if (!addition) return source;
    if (index < 0) return `${source}${addition}`;
    const prefix = source.slice(0, index);
    const lineBreak = prefix.endsWith('\r\n') ? '\r\n' : (prefix.endsWith('\n') ? '\n' : '');
    if (!lineBreak) return `${prefix}${addition}\n${source.slice(index)}`;
    return `${prefix.slice(0, -lineBreak.length)}${addition}${lineBreak}${source.slice(index)}`;
}
// (cleanup step 12) The terminal-death wording and Refresh's form keys are written in the prompts
// themselves now (core-mechanics; the registry's return shapes), not patched in here.
function appendRules(prompt, options = {}) {
    return `${String(prompt)}${APPEARANCE_RULES_WITH_FLAT}${DEATH_RULES}${establishedAppearanceContext(options)}`;
}
export function buildScannerPrompt(options = {}) {
    const base = mechanics.buildScannerPrompt(options);
    const context = establishedAppearanceContext(options);
    if (options.narrationCapture) return `${insertPromptBlockBefore(base, 'Identity index (matching only):', CAPTURE_STAGE4_RULES)}${context}`;
    const prefixed = insertPromptBlockBefore(base, 'Identity index (matching only):', COMPACT_STAGE4_RULE);
    return needsDetailedStage4(options) ? `${prefixed}${APPEARANCE_RULES}${DEATH_RULES}${context}` : `${prefixed}${context}`;
}
export function buildBackfillPrompt(options = {}) { return appendRules(mechanics.buildBackfillPrompt(options), options); }
export function buildDossierImportPrompt(options = {}) { return appendRules(mechanics.buildDossierImportPrompt(options), options); }
export function buildProfileRefreshPrompt(options = {}) {
    const base = mechanics.buildProfileRefreshPrompt(options);
    const stableRules = `${PROFILE_REFRESH_APPEARANCE_RULE}${APPEARANCE_RULES}${DEATH_RULES}`;
    const prefixed = insertPromptBlockBefore(base, 'Recent story window (EVIDENCE ONLY;', stableRules);
    return `${prefixed}${establishedAppearanceContext(options)}`;
}
