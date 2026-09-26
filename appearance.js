import {
    DURABLE_PROFILE_LIMITS,
    normalizeName,
    durableSeedGrounded,
    durableRefinementCandidateGrounded,
    groundedAppearanceCorrection,
    isSafeUnmarkedDurableRefinement,
    isSafeUnmarkedDurableReplacement,
} from './core-mechanics.js';

export const APPEARANCE_FORM_LIMIT = 8;
export const APPEARANCE_MODEL_VERSION = 1;

function clean(value, max = 1800) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function truthy(value) {
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}
function appearanceText(value) { return clean(value, DURABLE_PROFILE_LIMITS?.appearance || 800); }
function sameAppearance(a, b) { return normalizeName(a) === normalizeName(b); }
function regexEscape(value) { return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function appearanceClauses(value) {
    return appearanceText(value).split(/\s*;\s*|(?<=[.!?])\s+/).map(part => appearanceText(part)).filter(Boolean);
}
function stripOverallPrefix(value, overall) {
    const current = appearanceText(value);
    const shared = appearanceText(overall);
    if (!current || !shared) return current;
    if (sameAppearance(current, shared)) return '';

    const sharedClauses = appearanceClauses(shared);
    const currentClauses = appearanceClauses(current);
    const remaining = currentClauses.filter(clause => !sharedClauses.some(sharedClause => sameAppearance(clause, sharedClause)));
    if (remaining.length !== currentClauses.length) return appearanceText(remaining.join('; '));

    // Some providers repeat the shared phrase before a comma/colon rather than as a complete
    // sentence. Match the exact normalized word sequence only, never loose keyword overlap, so
    // negated or genuinely different form anatomy remains intact.
    const words = normalizeName(shared).split(/\s+/).filter(Boolean);
    if (words.length) {
        const boundary = String.raw`[\s,.;:!?()\[\]{}\-–—/]`;
        const separator = `${boundary}+`;
        const trailing = `${boundary}*`;
        const prefix = new RegExp(`^\\s*${words.map(regexEscape).join(separator)}(?=$|${boundary})${trailing}`, 'iu');
        const match = prefix.exec(current);
        if (match) {
            const remainder = current.slice(match[0].length);
            if (!/^\s*(?:is|are|was|were|be|been|being|not|never|no|hidden|covered|concealed|veiled|beneath|under|obscured)\b/i.test(remainder)) {
                return appearanceText(remainder);
            }
        }
    }
    return current;
}
function combineAppearance(overall, specific) {
    const shared = appearanceText(overall);
    const local = stripOverallPrefix(specific, shared);
    if (!shared) return local;
    if (!local) return shared;
    if (sameAppearance(shared, local)) return shared;
    if (normalizeName(local).startsWith(normalizeName(shared))) return local;
    return appearanceText(`${shared}; ${local}`);
}
function formKey(value) { return clean(value, 120).normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim(); }
function formState(value) {
    const state = String(value ?? '').trim().toLowerCase();
    if (['change', 'evolve', 'correct'].includes(state)) return 'change';
    if (['refine', 'update', 'learn', 'establish'].includes(state)) return 'refine';
    return 'keep';
}
function hasOwn(object, key) { return Object.prototype.hasOwnProperty.call(object || {}, key); }

const STOPWORDS = new Set([
    'and', 'the', 'with', 'that', 'this', 'their', 'they', 'them', 'when', 'while', 'from', 'into', 'over', 'under',
    'very', 'more', 'less', 'than', 'then', 'but', 'for', 'her', 'his', 'its', 'she', 'him', 'who', 'has', 'have', 'had',
    'uses', 'use', 'often', 'usually', 'still', 'also', 'only', 'toward', 'towards', 'around', 'becomes', 'become', 'being',
    'a', 'an', 'of', 'to', 'in', 'on', 'at', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'by', 'or', 'it', 'he',
]);
const ALIASES = Object.freeze({
    telepathy: 'telepath', telepathic: 'telepath', telepathically: 'telepath',
    connection: 'link', connections: 'link', connected: 'link', channel: 'link', channels: 'link', linked: 'link',
    thoughts: 'mind', thought: 'mind', minds: 'mind', mental: 'mind',
    siblings: 'sibling', sisters: 'sister', brothers: 'brother',
    courteous: 'courtesy', courteously: 'courtesy', politeness: 'polite', politely: 'polite',
    kindness: 'kind', kindhearted: 'kind', compassionate: 'compassion', compassion: 'compassion',
    reserved: 'reserve', restraint: 'restrain', restrained: 'restrain',
    gentleness: 'gentle', gently: 'gentle', motherly: 'maternal',
    speaks: 'speak', speaking: 'speak', spoken: 'speak', says: 'say', saying: 'say',
    gestures: 'gesture', gesturing: 'gesture', movements: 'movement',
    bonded: 'bond', bonding: 'bond', bonds: 'bond',
});
function conceptToken(token) {
    let word = String(token || '').toLowerCase();
    if (!word) return '';
    if (ALIASES[word]) return ALIASES[word];
    if (word.length > 5 && word.endsWith('ies')) word = `${word.slice(0, -3)}y`;
    else if (word.length > 6 && word.endsWith('ing')) word = word.slice(0, -3);
    else if (word.length > 5 && word.endsWith('ed')) word = word.slice(0, -2);
    else if (word.length > 4 && word.endsWith('es')) word = word.slice(0, -2);
    else if (word.length > 4 && word.endsWith('s')) word = word.slice(0, -1);
    return ALIASES[word] || word;
}
function refinementTokens(value) {
    return normalizeName(value).split(/\s+/)
        .filter(token => (token.length >= 2 || /^\d+$/.test(token)) && !STOPWORDS.has(token))
        .map(conceptToken)
        .filter(token => (token.length >= 2 || /^\d+$/.test(token)) && !STOPWORDS.has(token));
}
function grounded(value, context = '') {
    const source = String(context || '').trim();
    if (!source) return true;
    const proposed = [...new Set(refinementTokens(value))].filter(token => token.length >= 3 && !/^\d+$/.test(token));
    if (!proposed.length) return false;
    const sourceTokens = new Set(refinementTokens(source));
    const overlap = proposed.filter(token => sourceTokens.has(token));
    return overlap.length >= (proposed.length <= 2 ? 1 : 2);
}
function similarity(a, b) {
    const left = new Set(refinementTokens(a));
    const right = new Set(refinementTokens(b));
    if (!left.size || !right.size) return normalizeName(a) === normalizeName(b) ? 1 : 0;
    let overlap = 0;
    for (const token of left) if (right.has(token)) overlap += 1;
    const containment = overlap / Math.min(left.size, right.size);
    const jaccard = overlap / (left.size + right.size - overlap);
    return Math.max(jaccard, containment * 0.86, overlap >= 3 && containment >= 0.4 ? 0.62 : 0);
}
function safeRefinement(existing, incoming) {
    const oldTokens = new Set(refinementTokens(existing));
    const newTokens = new Set(refinementTokens(incoming));
    if (!oldTokens.size || !newTokens.size || normalizeName(existing) === normalizeName(incoming)) return false;
    const addsDetail = [...newTokens].some(token => !oldTokens.has(token));
    const coverage = [...oldTokens].filter(token => newTokens.has(token)).length / oldTokens.size;
    return addsDetail && (coverage >= 0.62 || similarity(existing, incoming) >= 0.58);
}
function safeUnmarkedReplacement(existing, incoming) {
    if (!safeRefinement(existing, incoming)) return false;
    const oldTokens = new Set(refinementTokens(existing));
    const newTokens = new Set(refinementTokens(incoming));
    const coverage = [...oldTokens].filter(token => newTokens.has(token)).length / oldTokens.size;
    return coverage >= 1;
}
function mergeRefinement(existing, incoming, maxChars) {
    const current = clean(existing, maxChars);
    const next = clean(incoming, maxChars);
    if (!current) return next;
    if (!next || sameAppearance(current, next)) return current;
    // The caller has already passed safeRefinement/grounding. `refine` is a full current
    // summary for this exact appearance slot, so omitted old clauses are retired here.
    return next;
}

// Enduring physical traits (hair, eyes, build, scars, anatomy) survive an accepted current-appearance
// update that simply omits them, e.g. an outfit change narrated without restating the body. A trait is
// replaced only when the incoming presentation itself describes that trait (outside a "hidden under"
// style mention). Clothing, gear and transient condition are never carried forward: they follow the
// existing full-current-presentation replacement rule.
const PHYSICAL_TRAITS = Object.freeze([
    ['hair', /\b(?:hair|haired|braids?|braided|ponytails?|pigtails|bangs|mane)\b/i],
    ['eyes', /\b(?:eyes?|eyed|irises|iris|pupils)\b/i],
    ['skin', /\b(?:skin|skinned|complexion|freckles?|freckled)\b/i],
    ['build', /\b(?:build|frame|figure|physique|muscular|muscles?|slender|slim|lean|lithe|stocky|petite|curvy|lanky|burly|brawny|willowy|broad[- ]shouldered)\b/i],
    ['height', /\b(?:tall|height|towering|diminutive|statuesque)\b/i],
    ['face', /\b(?:face|facial|jaw|jawline|cheekbones|nose|lips|beard|bearded|mustache|moustache|stubble)\b/i],
    ['scar', /\b(?:scars?|scarred)\b/i],
    ['tattoo', /\b(?:tattoos?|tattooed)\b/i],
    ['birthmark', /\b(?:birthmarks?|moles?)\b/i],
    ['ears', /\bears?\b/i],
    ['horns', /\b(?:horns?|horned)\b/i],
    ['tail', /\btails?\b/i],
    ['wings', /\b(?:wings?|winged)\b/i],
    ['fur', /\b(?:fur|furred)\b/i],
    ['scales', /\b(?:scales|scaled)\b/i],
    ['fangs', /\bfangs?\b/i],
    ['claws', /\bclaws?\b/i],
    ['antlers', /\bantlers?\b/i],
    ['tusks', /\btusks?\b/i],
]);
const CHANGEABLE_PRESENTATION = /\b(?:wear(?:s|ing)?|worn|dressed|clad|outfit|attire|cloth(?:es|ing)|dress|gown|robes?|cloak|cape|coat|jacket|shirt|blouse|tunic|vest|skirt|trousers|pants|leggings|stockings|boots?|shoes?|sandals|gloves?|gauntlets?|hat|hood(?:ed)?|helmet|mask|armou?r|uniform|apron|scarf|belt|sash|jewel(?:ry|lery)|necklace|pendant|rings?|bracelets?|earrings?|ribbons?|carr(?:y|ies|ying)|hold(?:s|ing)|wield(?:s|ing)|sword|staff|dagger|bag|satchel|pack|wet|damp|soaked|drenched|blood(?:ied|y|stained)|mud(?:dy)?|dirt(?:y)?|bruised?|bleeding|wounded|injured|bandaged|sweat(?:y|ing)|flushed|tear[- ]streaked|disheveled|dishevelled)\b/i;
const CONCEALED_MENTION = /\b(?:hid(?:e|es|den|ing)|cover(?:s|ed|ing)?|conceal(?:s|ed|ing)?|beneath|under(?:neath)?|obscur(?:e|es|ed|ing)|tucked)\b/i;

function presentationSegments(value) {
    return appearanceText(value)
        .split(/\s*;\s*|(?<=[.!?])\s+|\s*,\s*/)
        .map(part => clean(part.replace(/^(?:and|with)\s+/i, '').replace(/[.!?]+$/, ''), 400))
        .filter(Boolean);
}
function physicalTraitKeys(segment) {
    return PHYSICAL_TRAITS.filter(([, pattern]) => pattern.test(segment)).map(([key]) => key);
}
function preserveOmittedPhysicalTraits(previous, next, { alsoPresent = '' } = {}) {
    const incoming = appearanceText(next);
    const prior = appearanceText(previous);
    if (!incoming || !prior || sameAppearance(prior, incoming)) return incoming;
    const incomingNormalized = normalizeName(incoming);
    const presentNormalized = normalizeName(alsoPresent);
    const addressed = new Set(presentationSegments(incoming)
        .filter(segment => !CONCEALED_MENTION.test(segment))
        .flatMap(physicalTraitKeys));
    const kept = presentationSegments(prior).filter(segment => {
        const keys = physicalTraitKeys(segment);
        if (!keys.length || CHANGEABLE_PRESENTATION.test(segment) || keys.some(key => addressed.has(key))) return false;
        const normalized = normalizeName(segment);
        return normalized && !incomingNormalized.includes(normalized) && !(presentNormalized && presentNormalized.includes(normalized));
    });
    const limit = DURABLE_PROFILE_LIMITS?.appearance || 800;
    // The incoming presentation is authoritative; if the budget is tight, drop the oldest carried traits whole.
    while (kept.length && `${kept.join(', ')}; ${incoming}`.length > limit) kept.pop();
    return kept.length ? appearanceText(`${kept.join(', ')}; ${incoming}`) : incoming;
}

export function normalizeAppearanceForms(value, { updates = false } = {}) {
    const source = Array.isArray(value)
        ? value
        : (value && typeof value === 'object'
            ? Object.entries(value).map(([name, form]) => form && typeof form === 'object' ? { name, ...form } : { name, appearance: form })
            : []);
    const forms = [];
    for (const raw of source) {
        if (!raw || typeof raw !== 'object') continue;
        const name = clean(raw.name ?? raw.form ?? raw.formName ?? raw.form_name, 120);
        const appearance = appearanceText(raw.appearance ?? raw.description ?? raw.visual ?? raw.value);
        if (!name || !appearance) continue;
        const entry = { name, appearance };
        if (updates) {
            entry.state = formState(raw.state ?? raw.appearanceState ?? raw.appearance_state);
            entry.reason = clean(raw.reason ?? raw.appearanceReason ?? raw.appearance_reason, 500);
        }
        const index = forms.findIndex(item => formKey(item.name) === formKey(name));
        if (index >= 0) forms[index] = entry;
        else forms.push(entry);
        if (forms.length >= APPEARANCE_FORM_LIMIT) break;
    }
    return forms;
}

export function formatAppearanceForms(value) {
    return normalizeAppearanceForms(value).map(form => `${form.name} | ${form.appearance}`).join('\n');
}
export function parseAppearanceFormsText(value) {
    const lines = String(value ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length > APPEARANCE_FORM_LIMIT) throw new Error(`Appearance forms are limited to ${APPEARANCE_FORM_LIMIT}.`);
    const forms = [];
    const keys = new Set();
    for (const line of lines) {
        const split = line.indexOf('|');
        if (split <= 0) throw new Error('Each appearance form must use: Form name | Description');
        const name = clean(line.slice(0, split), 120);
        const appearance = appearanceText(line.slice(split + 1));
        const key = formKey(name);
        if (!name || !appearance) throw new Error('Each appearance form needs both a name and description.');
        if (!key || keys.has(key)) throw new Error(`Duplicate appearance form: ${name}`);
        keys.add(key);
        forms.push({ name, appearance });
    }
    return forms;
}
export function appearanceFormByName(npc = {}, name = '') {
    const key = formKey(name);
    if (!key) return null;
    return normalizeAppearanceForms(npc.appearanceForms ?? npc.appearance_forms).find(form => formKey(form.name) === key) || null;
}

export function normalizeAppearanceModel(raw = {}, { locked = false } = {}) {
    const appearance = locked ? clean(raw.appearance, 1800) : appearanceText(raw.appearance);
    const overallAppearance = locked
        ? clean(raw.overallAppearance ?? raw.overall_appearance, 1800)
        : appearanceText(raw.overallAppearance ?? raw.overall_appearance);
    let unclassifiedAppearance = locked
        ? clean(raw.unclassifiedAppearance ?? raw.unclassified_appearance, 1800)
        : appearanceText(raw.unclassifiedAppearance ?? raw.unclassified_appearance);
    const appearanceForms = normalizeAppearanceForms(raw.appearanceForms ?? raw.appearance_forms);
    const currentForm = clean(raw.currentForm ?? raw.current_form, 120);
    let currentFormUnknown = truthy(raw.currentFormUnknown ?? raw.current_form_unknown);
    if (currentForm) currentFormUnknown = false;
    if (currentFormUnknown && !unclassifiedAppearance) {
        unclassifiedAppearance = stripOverallPrefix(appearance, overallAppearance);
    }
    return {
        appearance,
        overallAppearance,
        unclassifiedAppearance,
        appearanceForms,
        currentForm,
        currentFormUnknown,
        appearanceModelVersion: APPEARANCE_MODEL_VERSION,
    };
}

export function resolveNpcAppearance(rawNpc = {}) {
    const model = normalizeAppearanceModel(rawNpc, {
        locked: Array.isArray(rawNpc?.manualProfileFields) && rawNpc.manualProfileFields.includes('appearance'),
    });
    const current = model.currentForm ? appearanceFormByName(model, model.currentForm) : null;
    const overall = model.overallAppearance;
    if (current) return combineAppearance(overall, current.appearance);
    if (model.currentFormUnknown) return combineAppearance(overall, model.unclassifiedAppearance || model.appearance);
    if (model.currentForm) return combineAppearance(overall, model.unclassifiedAppearance || model.appearance);
    return model.appearance || overall || appearanceFormByName(model, 'Base')?.appearance || model.appearanceForms[0]?.appearance || '';
}

function reconcileFormAppearance(existing, update, context = '') {
    const current = appearanceText(existing);
    const incoming = appearanceText(update?.appearance);
    if (!incoming) return current;
    if (!current) return context && !durableSeedGrounded(incoming, context) ? '' : incoming;
    if (normalizeName(current) === normalizeName(incoming)) return current;
    const state = formState(update?.state);
    if (state === 'change') {
        const reason = clean(update?.reason, 500);
        if (!reason || (context && (!durableSeedGrounded(reason, context) || !durableSeedGrounded(incoming, context)))) return current;
        return incoming;
    }
    const compatible = state === 'refine'
        ? (isSafeUnmarkedDurableRefinement(current, incoming)
            || groundedAppearanceCorrection(current, incoming, context))
        : isSafeUnmarkedDurableReplacement(current, incoming);
    if (!compatible || (context && !durableRefinementCandidateGrounded('appearance', current, incoming, context))) return current;
    return mergeRefinement(current, incoming, DURABLE_PROFILE_LIMITS?.appearance || 800);
}

export function applyAppearanceUpdate(record = {}, rawUpdate = {}, { locked = false, context = '' } = {}) {
    const next = normalizeAppearanceModel(record, { locked });
    if (locked || !rawUpdate || typeof rawUpdate !== 'object') return { ...next, appearance: resolveNpcAppearance(next) };

    const overallProvided = hasOwn(rawUpdate, 'overallAppearance') || hasOwn(rawUpdate, 'overall_appearance');
    if (overallProvided) {
        const incoming = appearanceText(rawUpdate.overallAppearance ?? rawUpdate.overall_appearance);
        if (!next.overallAppearance) {
            if (!context || durableSeedGrounded(incoming, context)) next.overallAppearance = incoming;
        } else if (incoming && normalizeName(incoming) !== normalizeName(next.overallAppearance)) {
            const state = formState(rawUpdate.overallAppearanceState ?? rawUpdate.overall_appearance_state);
            if (state === 'change') {
                const reason = clean(rawUpdate.overallAppearanceReason ?? rawUpdate.overall_appearance_reason, 500);
                if (reason && (!context || (durableSeedGrounded(reason, context) && durableSeedGrounded(incoming, context)))) next.overallAppearance = incoming;
            } else {
                const compatible = state === 'refine'
                    ? (isSafeUnmarkedDurableRefinement(next.overallAppearance, incoming)
                        || groundedAppearanceCorrection(next.overallAppearance, incoming, context))
                    : isSafeUnmarkedDurableReplacement(next.overallAppearance, incoming);
                if (compatible && (!context || durableRefinementCandidateGrounded('appearance', next.overallAppearance, incoming, context))) {
                    next.overallAppearance = mergeRefinement(next.overallAppearance, incoming, DURABLE_PROFILE_LIMITS?.appearance || 800);
                }
            }
        }
    }

    const formsProvided = hasOwn(rawUpdate, 'appearanceForms') || hasOwn(rawUpdate, 'appearance_forms');
    if (formsProvided) {
        for (const form of normalizeAppearanceForms(rawUpdate.appearanceForms ?? rawUpdate.appearance_forms, { updates: true })) {
            const index = next.appearanceForms.findIndex(item => formKey(item.name) === formKey(form.name));
            if (index >= 0) {
                const appearance = reconcileFormAppearance(next.appearanceForms[index].appearance, form, context);
                if (appearance) next.appearanceForms[index] = { name: next.appearanceForms[index].name || form.name, appearance };
            } else if (next.appearanceForms.length < APPEARANCE_FORM_LIMIT) {
                const appearance = reconcileFormAppearance('', form, context);
                if (appearance) next.appearanceForms.push({ name: form.name, appearance });
            }
        }
    }

    const currentStateRaw = String(rawUpdate.currentFormState ?? rawUpdate.current_form_state ?? '').trim().toLowerCase();
    const incomingCurrent = clean(rawUpdate.currentForm ?? rawUpdate.current_form, 120);
    const currentAppearanceProvided = hasOwn(rawUpdate, 'appearance');
    if (['unknown', 'unspecified', 'clear'].includes(currentStateRaw)) {
        next.currentForm = '';
        next.currentFormUnknown = true;
        const incomingAppearance = appearanceText(rawUpdate.appearance);
        const reason = clean(rawUpdate.appearanceReason ?? rawUpdate.appearance_reason ?? rawUpdate.currentFormReason ?? rawUpdate.current_form_reason, 500);
        const explicitChange = formState(rawUpdate.appearanceState ?? rawUpdate.appearance_state) === 'change';
        next.unclassifiedAppearance = currentAppearanceProvided
            && incomingAppearance
            && (!context || durableSeedGrounded(incomingAppearance, context))
            && (!explicitChange || (reason && (!context || durableSeedGrounded(reason, context))))
            ? incomingAppearance
            : '';
        next.appearance = '';
    } else if (incomingCurrent || ['select', 'switch', 'change', 'current'].includes(currentStateRaw)) {
        if (incomingCurrent) next.currentForm = incomingCurrent;
        next.currentFormUnknown = false;
        // A named form owns its own anatomy. Do not carry the old compatibility scalar across
        // a switch, since that scalar may describe the previous form.
        if (incomingCurrent && !currentAppearanceProvided) next.appearance = '';
    }
    // A valid flat appearance update describes the CURRENT presentation. Reconcile it into
    // that canonical slot before resolving the compatibility/display scalar, so a selected
    // named form cannot replay stale clothing or anatomy over an accepted current update.
    if (currentAppearanceProvided) {
        const incomingAppearance = appearanceText(rawUpdate.appearance);
        if (incomingAppearance) {
            const localAppearance = stripOverallPrefix(incomingAppearance, next.overallAppearance) || incomingAppearance;
            const update = {
                appearance: localAppearance,
                state: rawUpdate.appearanceState ?? rawUpdate.appearance_state,
                reason: rawUpdate.appearanceReason ?? rawUpdate.appearance_reason,
            };
            if (next.currentForm) {
                const index = next.appearanceForms.findIndex(form => formKey(form.name) === formKey(next.currentForm));
                if (index >= 0) {
                    const existingLocal = next.appearanceForms[index].appearance;
                    const existingResolved = combineAppearance(next.overallAppearance, existingLocal);
                    const resolved = reconcileFormAppearance(existingResolved, { ...update, appearance: incomingAppearance }, context);
                    const stripped = stripOverallPrefix(resolved, next.overallAppearance) || resolved;
                    const appearance = preserveOmittedPhysicalTraits(existingLocal, stripped, { alsoPresent: next.overallAppearance });
                    if (appearance) next.appearanceForms[index] = { ...next.appearanceForms[index], appearance };
                } else {
                    // A flat presentation may describe a selected-but-not-yet-established form,
                    // but it cannot fabricate that named form after its own form detail failed
                    // grounding. Keep the accepted current presentation in the compatibility slot.
                    next.appearance = reconcileFormAppearance('', { ...update, appearance: incomingAppearance }, context);
                }
            } else if (next.currentFormUnknown) {
                const previous = next.unclassifiedAppearance;
                next.unclassifiedAppearance = preserveOmittedPhysicalTraits(previous, reconcileFormAppearance(previous, update, context), { alsoPresent: next.overallAppearance });
            } else {
                // Without a selected/unknown form the compatibility scalar is resolved on its own (shared
                // appearance is not prepended), so carried traits are checked against it alone.
                const previous = next.appearance;
                next.appearance = preserveOmittedPhysicalTraits(previous, reconcileFormAppearance(previous, update, context));
            }
        }
    }

    next.appearanceModelVersion = APPEARANCE_MODEL_VERSION;
    next.appearance = resolveNpcAppearance(next);
    return next;
}

// Compact identity of the resolved current presentation. A portrait records it when attached so
// the dossier can show that the described appearance moved on after the image was made.
export function appearanceFingerprint(npc = {}) {
    const text = normalizeName(resolveNpcAppearance(npc));
    if (!text) return '';
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `a1:${hash.toString(36)}:${text.length}`;
}

export function appearanceDraftRecord(npc = {}, draft = {}, { lockAppearance = false } = {}) {
    const forms = parseAppearanceFormsText(draft.formsText ?? formatAppearanceForms(npc?.appearanceForms));
    const selected = clean(draft.currentForm);
    const currentFormUnknown = selected === '__unknown__' || draft.currentFormUnknown === true;
    const currentForm = currentFormUnknown || selected === '__none__' ? '' : selected;
    if (currentForm && !forms.some(form => formKey(form.name) === formKey(currentForm))) {
        throw new Error(`Current form is not in the appearance-form list: ${currentForm}`);
    }

    const nextInput = {
        ...npc,
        appearanceModelVersion: 1,
        appearance: '',
        overallAppearance: clean(draft.overallAppearance).slice(0, 1800),
        appearanceForms: forms,
        currentForm,
        currentFormUnknown,
    };
    if (currentFormUnknown) {
        nextInput.unclassifiedAppearance = clean(draft.unclassifiedAppearance ?? npc?.unclassifiedAppearance ?? npc?.appearance).slice(0, 1800);
    }

    const normalized = normalizeAppearanceModel(nextInput, { locked: false });
    const next = { ...npc, ...normalized, appearance: '' };
    const locks = new Set(Array.isArray(npc?.manualProfileFields) ? npc.manualProfileFields : []);
    // A lock prevents scanner changes; it must not replay old anatomy over a manual form edit.
    next.manualProfileFields = [...locks].filter(key => key !== 'appearance');
    next.appearance = resolveNpcAppearance(next);
    if (lockAppearance) locks.add('appearance');
    else locks.delete('appearance');
    next.manualProfileFields = [...locks];
    return next;
}
