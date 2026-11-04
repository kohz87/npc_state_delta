/* NPC State Delta prompt injection: buildBehaviorGuidance, relevance scoring and selection, the injection token budget and
   its parts, and buildInjection. A pure part of core-mechanics.js (same owner, moved without change); core-mechanics.js
   re-exports every name it exported before. Never imports core-mechanics.js or core.js. */
import { calibrateRelationshipSummary, DEFAULT_RELATIONSHIP, DURABLE_PROFILE_LIMITS, durableSemanticSimilarity, normalizeRelationshipBaseline, RELATIONSHIP_KEYS, relationshipSummaryConsistent } from './core-relationship.js';
import { cleanList, cleanText, normalizeName } from './core-text.js';
import { countNormalizedPhrase, npcNamedInText } from './core-merge.js';
import { KEY_RELATIONSHIP_LIMIT, keyRelationshipSubject } from './core-keyrel.js';
import { socialGraphLabelsForNpc } from './social.js';
import { customFieldValues, IMPORTANT_MEMORY_LIMIT } from './core-record.js';
import { orderedBehaviorProfile } from './core-behavior.js';
import { normalizeGender } from './core-identity.js';
import { DEFAULT_BEHAVIOR_CRITERIA } from './core-prompts.js';
import { isTerminalNpcDeath } from './terminal-lifecycle.js';

export function buildBehaviorGuidance(npc) {
    const rel = normalizeRelationshipBaseline(npc?.relationship || DEFAULT_RELATIONSHIP);
    const material = RELATIONSHIP_KEYS
        .map(key => ({ key, value: rel[key], magnitude: Math.abs(rel[key]) }))
        .filter(item => item.magnitude >= 30)
        .sort((a, b) => b.magnitude - a.magnitude || RELATIONSHIP_KEYS.indexOf(a.key) - RELATIONSHIP_KEYS.indexOf(b.key));
    if (!material.length) return 'relationship remains mostly neutral or unsettled; let identity, goals, and current state drive behavior';

    const cues = [];
    for (const { key, value } of material) {
        if (key === 'trust') {
            if (value <= -70) cues.push('strong distrust: protect self and verify claims');
            else if (value <= -30) cues.push('distrust: remain guarded about reliance');
            else if (value < 70) cues.push('trust: some extra candor/reliance is plausible');
            else cues.push('strong trust: vulnerability/reliance is permitted when identity and context allow');
        } else if (key === 'affection') {
            if (value <= -70) cues.push('strong resentment/dislike may cool treatment');
            else if (value <= -30) cues.push('dislike/resentment is established');
            else if (value < 70) cues.push('affection: modest extra concern/attention may appear through established care style');
            else cues.push('strong affection: high emotional importance, not devotion or self-erasure');
        } else if (key === 'desire') {
            if (value <= -70) cues.push('strong aversion to intimate/romantic closeness');
            else if (value <= -30) cues.push('aversion to intimate/romantic closeness is established');
            else if (value < 70) cues.push('attraction may subtly color attention only when context supports it');
            else cues.push('strong desire may affect attention/proximity only through established expressiveness and consent');
        } else if (key === 'tension') {
            if (value <= -70) cues.push('exceptional ease/safety may lower interpersonal pressure');
            else if (value <= -30) cues.push('noticeable ease/reduced pressure is established');
            else if (value < 70) cues.push('unresolved pressure may affect delivery only in the form the scene supports');
            else cues.push('strong unresolved pressure matters, but does not imply jealousy, embarrassment, hostility, or denial');
        }
    }
    const combinations = [];
    if (rel.trust >= 70 && rel.tension >= 70) combinations.push('familiarity and strain coexist');
    if (rel.affection >= 70 && rel.trust <= -30) combinations.push('care does not erase distrust');
    if (rel.desire >= 70 && rel.trust <= -30) combinations.push('attraction does not imply safety or trust');
    return [...combinations, ...cues].join('; ');
}

export function scoreNpcRelevance(npc, text, turn = 0, socialGraph = null, allNpcs = []) {
    const haystack = normalizeName(text);
    let score = 0;
    for (const label of [npc.name, ...(npc.aliases || [])]) {
        const needle = normalizeName(label);
        if (needle && countNormalizedPhrase(haystack, needle) > 0) score += label === npc.name ? 8 : 5;
    }
    const canonicalTokens = normalizeName(npc.name).split(/\s+/).filter(Boolean);
    if (canonicalTokens.length > 1 && canonicalTokens[0].length >= 4 && countNormalizedPhrase(haystack, canonicalTokens[0]) > 0) score += 6;
    const role = normalizeName(npc.role);
    if (role && countNormalizedPhrase(haystack, role) > 0) score += 3;
    for (const entry of cleanList(npc.keyRelationships, KEY_RELATIONSHIP_LIMIT, DURABLE_PROFILE_LIMITS.keyRelationship)) {
        const subject = keyRelationshipSubject(entry);
        if (subject && countNormalizedPhrase(haystack, subject) > 0) score += 2;
    }
    for (const label of socialGraphLabelsForNpc(socialGraph, npc.id, allNpcs)) {
        const subject = normalizeName(label);
        if (subject && countNormalizedPhrase(haystack, subject) > 0) score += 2;
    }
    const goalSimilarity = npc.goal ? durableSemanticSimilarity(npc.goal, text) : 0;
    if (goalSimilarity >= 0.35) score += Math.max(1, Math.round(goalSimilarity * 4));
    const memoryMatch = cleanList(npc.memories, IMPORTANT_MEMORY_LIMIT, DURABLE_PROFILE_LIMITS.memory)
        .some(memory => durableSemanticSimilarity(memory, text) >= 0.42);
    if (memoryMatch) score += 1;
    const age = Math.max(0, Number(turn) - Number(npc.lastSeenTurn || 0));
    score += Math.max(0, 4 - age);
    // Runtime prompt-space selection is calculated from current story salience only.
    return score;
}

export function selectRelevantNpcs(npcs, text, turn = 0, limit = 3, socialGraph = null, graphRegistry = null) {
    const all = [...(npcs || [])];
    const registry = Array.isArray(graphRegistry) ? graphRegistry : all;
    return all
        .map(npc => ({ npc, score: scoreNpcRelevance(npc, text, turn, socialGraph, registry) }))
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, limit))
        .map(item => item.npc);
}

export const DEFAULT_INJECTION_BUDGET_TOKENS = 4000;
// Section caps are sized for this budget and grow in proportion above it (see buildInjection).
const INJECTION_CAP_BASE_TOKENS = 1800;
export const MIN_INJECTION_BUDGET_TOKENS = 512;
export const MAX_INJECTION_BUDGET_TOKENS = 6000;
const APPROX_CHARS_PER_TOKEN = 4;

export function normalizeInjectionBudgetTokens(value) {
    return Math.max(MIN_INJECTION_BUDGET_TOKENS, Math.min(MAX_INJECTION_BUDGET_TOKENS, Math.round(Number(value) || DEFAULT_INJECTION_BUDGET_TOKENS)));
}

export function estimateInjectionTokens(text) {
    return Math.ceil(String(text || '').length / APPROX_CHARS_PER_TOKEN);
}

function truncateInjectionText(value, maxChars) {
    const text = String(value || '').trim();
    const cap = Math.max(0, Math.floor(maxChars));
    if (!text || cap <= 0) return '';
    if (text.length <= cap) return text;
    if (cap <= 1) return text.slice(0, cap);
    return `${text.slice(0, cap - 1).trimEnd()}…`;
}

function fairInjectionParts(parts, maxChars) {
    const entries = (Array.isArray(parts) ? parts : []).map(value => String(value || '').trim()).filter(Boolean);
    const cap = Math.max(0, Math.floor(maxChars));
    if (!entries.length || cap <= 0) return '';
    if (entries.length === 1) return truncateInjectionText(entries[0], cap);
    const separators = (entries.length - 1) * 2;
    const usable = Math.max(entries.length * 20, cap - separators);
    const share = Math.max(20, Math.floor(usable / entries.length));
    const itemCaps = entries.map(() => share);
    let rendered = entries.map((entry, i) => truncateInjectionText(entry, itemCaps[i]));
    let used = rendered.join('; ').length;
    let remaining = Math.max(0, cap - used);
    // Redistribute unused room to the fields that were actually truncated, so short fields
    // do not waste the budget while every established identity channel still gets a seat.
    for (let rounds = 0; rounds < entries.length * 3 && remaining > 0; rounds += 1) {
        let best = -1;
        let bestNeed = 0;
        for (let i = 0; i < entries.length; i += 1) {
            const need = entries[i].length - rendered[i].length;
            if (need > bestNeed) { bestNeed = need; best = i; }
        }
        if (best < 0 || bestNeed <= 0) break;
        const add = Math.min(bestNeed, remaining, 80);
        itemCaps[best] += add;
        rendered[best] = truncateInjectionText(entries[best], itemCaps[best]);
        used = rendered.join('; ').length;
        remaining = Math.max(0, cap - used);
    }
    return truncateInjectionText(rendered.join('; '), cap);
}

// Each lever keeps its category and as much of "level - effect" as its equal share allows, cut at a
// word boundary. (Cutting to the first three words left "high - refuses", which lost the meaning.)
function wordBoundedInjection(text, maxChars) {
    const value = String(text || '').trim().replace(/[\s.;]+$/, '');
    if (value.length <= maxChars) return value;
    const cut = value.slice(0, Math.max(1, maxChars - 1));
    const space = cut.lastIndexOf(' ');
    const head = (space >= Math.floor(maxChars * 0.6) ? cut.slice(0, space) : cut).replace(/[\s,;:\-–—]+$/, '');
    return `${head}…`;
}

function compactBehaviorProfileForInjection(value, maxChars = 180) {
    const entries = orderedBehaviorProfile(value);
    if (!entries.length) return '';
    const share = Math.floor((maxChars - 3 * (entries.length - 1)) / entries.length);
    // With little room every category still gets "Category: level" so none is starved; with room,
    // each lever keeps its effect as well.
    const levelOnly = share < 40;
    const compact = entries.map(item => {
        const match = item.match(/^([\p{L}][\p{L}\p{N} _\-/]{1,36})\s*:\s*(.*)$/u);
        if (!match) return wordBoundedInjection(item, Math.max(28, share));
        const label = match[1].split('/')[0].trim();
        const body = match[2].trim();
        if (levelOnly) {
            const level = body.split(/\s+[-–—]\s+|[.;,]/, 1)[0].trim().split(/\s+/).slice(0, 3).join(' ');
            return level ? `${label}: ${level}` : label;
        }
        return wordBoundedInjection(`${label}: ${body}`, share);
    });
    return truncateInjectionText(compact.join(' | '), maxChars);
}

function injectionIdentityCore(npc, identityCap = 540) {
    const others = [
        npc.personality && `personality: ${npc.personality}`,
        npc.speech && `speech: ${npc.speech}`,
        npc.mannerisms?.length && `mannerisms: ${npc.mannerisms.join(', ')}`,
    ].filter(Boolean);
    // Size the levers to the room the fair split below will actually give them: other identity
    // fields take at most an equal share and the levers get the rest (never more than 300 chars).
    const fairShare = Math.floor(identityCap / (others.length + 1));
    const leverRoom = identityCap - others.reduce((sum, part) => sum + Math.min(part.length, fairShare) + 2, 0) - 'behavioral profile: '.length;
    const leverCap = Math.min(1100, Math.max(fairShare - 'behavioral profile: '.length, leverRoom));
    const parts = [
        others[0] && others[0].startsWith('personality:') ? others[0] : '',
        npc.behaviorProfile?.length && `behavioral profile: ${compactBehaviorProfileForInjection(npc.behaviorProfile, leverCap)}`,
        ...others.filter(part => !part.startsWith('personality:')),
    ].filter(Boolean);
    return fairInjectionParts(parts, identityCap) || 'not yet established; do not invent an archetype to fill the gap';
}

function injectionAgencyCore(npc, agencyCap = 260, customFieldNames = []) {
    const bonds = cleanList(npc.keyRelationships, agencyCap >= 450 ? KEY_RELATIONSHIP_LIMIT : Math.min(3, KEY_RELATIONSHIP_LIMIT), 150);
    const custom = Object.entries(customFieldValues(npc, customFieldNames)).map(([name, value]) => `${name}: ${value}`).join(' · ');
    const parts = [
        custom && `established details: ${custom}`,
        npc.role && `role: ${npc.role}`,
        npc.goal && `goal: ${npc.goal}`,
        bonds.length && `bonds: ${bonds.join(' | ')}`,
    ].filter(Boolean);
    return fairInjectionParts(parts, agencyCap) || 'no additional agency facts established';
}

// A mood that names a stance toward the player ("devoted", "adoring") is a relationship claim, not
// a mood; below established trust/affection it is left out of the roleplay injection.
const STANCE_MOOD_WORDS = /\b(devoted|adoring|worshipful|worshipping|obedient|infatuated|lovestruck|besotted|smitten|enthralled)\b/i;

function lowPlayerStanding(npc) {
    const rel = normalizeRelationshipBaseline(npc?.relationship || DEFAULT_RELATIONSHIP);
    return Math.max(rel.trust, rel.affection) < 50;
}

function injectedMood(npc) {
    const mood = String(npc?.mood || '').trim();
    if (!mood || !lowPlayerStanding(npc)) return mood;
    return mood.split(/\s*,\s*|\s*;\s*/).filter(part => part && !STANCE_MOOD_WORDS.test(part)).join(', ');
}

// While another extension owns the scene (Story Block's World State, Story Suite), the live mood
// and outfit come from it, so the cards leave them out and point there instead.
const SCENE_DEFERRED_STATE = 'live mood/outfit: as in World State';

function injectionCurrentStateCore(npc, stateCap = 180, sceneDeferred = false) {
    const mood = sceneDeferred ? '' : injectedMood(npc);
    const parts = [
        mood && `mood: ${mood}`,
        npc.status && `status: ${npc.status}`,
        sceneDeferred && SCENE_DEFERRED_STATE,
    ].filter(Boolean);
    return fairInjectionParts(parts, stateCap) || 'no overriding live emotional/condition state established';
}

function compactRelationshipModifier(npc, behaviorCap = 160) {
    const rel = normalizeRelationshipBaseline(npc?.relationship || DEFAULT_RELATIONSHIP);
    const summary = calibrateRelationshipSummary(npc?.relationshipSummary, rel);
    if (summary && relationshipSummaryConsistent(summary, rel)) return truncateInjectionText(summary, behaviorCap);
    return truncateInjectionText(buildBehaviorGuidance(npc), behaviorCap);
}

function injectionEssentialBlock(npc, behaviorCap = 160, identityCap = 620, agencyCap = 300, stateCap = 180, customFieldNames = [], sceneDeferred = false) {
    const identity = injectionIdentityCore(npc, identityCap);
    const agency = injectionAgencyCore(npc, agencyCap, customFieldNames);
    const currentState = injectionCurrentStateCore(npc, stateCap, sceneDeferred);
    const relationship = compactRelationshipModifier(npc, behaviorCap);
    return `- ${npc.name}: IDENTITY: ${identity}; AGENCY/BONDS: ${agency}; STATE: ${currentState}; TOWARD PLAYER (secondary): ${relationship}`;
}

const INJECTED_APPEARANCE_LABEL = 'APPEARANCE (authoritative; species cannot override the form): ';
const INJECTED_PHYSICAL_LABEL = 'PHYSICAL FEATURES (authoritative): ';
const INJECTED_FORM_ANATOMY_LABEL = 'FORM ANATOMY (authoritative; World State gives the outfit): ';

// Appearance is optional continuity, but when the whole current appearance does not fit the
// remaining budget its enduring physical features still should, so the roleplay model is not left
// to invent anatomy. Variants are tried in order; the last may be cut at a clause boundary.
// With the scene deferred, an NPC without a selected form keeps only its enduring physical
// features; a selected form's appearance is its whole anatomy, so it stays with World State
// named as the outfit's source.
function injectionAppearanceVariants(npc, sceneDeferred = false) {
    const appearance = cleanText(npc.appearance, 1200);
    if (!appearance) return [];
    const physical = !npc.currentForm && !npc.currentFormUnknown ? cleanText(npc.overallAppearance, 800) : '';
    if (sceneDeferred) {
        if (npc.currentForm || npc.currentFormUnknown) return [`${INJECTED_FORM_ANATOMY_LABEL}${appearance}`];
        return physical ? [`${INJECTED_PHYSICAL_LABEL}${physical}`] : [];
    }
    const variants = [`${INJECTED_APPEARANCE_LABEL}${appearance}`];
    if (physical && normalizeName(physical) !== normalizeName(appearance)) variants.push(`${INJECTED_PHYSICAL_LABEL}${physical}`);
    return variants;
}

function clauseBoundedInjection(text, room) {
    const labelEnd = text.indexOf('): ') + 3;
    if (room < 80 || labelEnd < 3) return '';
    const cut = text.slice(0, room);
    const boundary = Math.max(cut.lastIndexOf('; '), cut.lastIndexOf(', '));
    return boundary >= labelEnd + 20 ? cut.slice(0, boundary) : '';
}

function injectionOptionalFields(npc, includeAppearance = false, sceneDeferred = false) {
    const importantMemories = cleanList(npc.memories, IMPORTANT_MEMORY_LIMIT, 220);
    const appearanceVariants = includeAppearance ? injectionAppearanceVariants(npc, sceneDeferred) : [];
    return [
        appearanceVariants.length && appearanceVariants,
        includeAppearance && !npc.appearance && (npc.currentForm || npc.currentFormUnknown) && 'Current visible appearance is not established; do not infer anatomy from species or another form.',
        importantMemories.length && `memories: ${importantMemories.join(' | ')}`,
        npc.species && `species: ${npc.species}`,
        npc.gender && `gender: ${normalizeGender(npc.gender)}`,
        npc.age && `age: ${npc.age}`,
        npc.apparentAge && `apparent age: ${npc.apparentAge}`,
        npc.location && `location: ${npc.location}`,
        npc.homeBase && `home base: ${npc.homeBase}`,
        npc.background && `background: ${cleanText(npc.background, 320)}`,
    ].filter(Boolean);
}

function compactInjectionBehaviorRubric(criteria, maxChars) {
    const raw = String(criteria || '').trim();
    if (!raw) return '';
    if (raw === DEFAULT_BEHAVIOR_CRITERIA) {
        return truncateInjectionText('Identity first; relationship only biases player-directed weighting.', maxChars);
    }
    return truncateInjectionText(raw, maxChars);
}

const REFERENCE_LINE_LIMIT = 4;
const REFERENCE_LINE_CHARS = 240;
const MENTIONED_HEADER = 'MENTIONED, NOT PRESENT: NPCs the recent story names. Use these established facts if they come up or arrive; do not bring them on-screen unprompted.';
const DECEASED_HEADER = 'DECEASED, REFERENCED ONLY: these NPCs are dead and only mentioned. Use these facts; never portray them alive, present, or speaking.';

// NPCs the recent story names who are not in the injected cast get one compact line each: a living
// off-screen (or archived) NPC its established facts, a confirmed-dead NPC who they were and how they
// died. At most four, living first; never a dossier block.
function referenceBlock(npcs = [], text = '', castIds = new Set(), customFieldNames = []) {
    const roster = Array.isArray(npcs) ? npcs : [];
    const haystack = normalizeName(text);
    if (!haystack) return '';
    // Cheap pre-check before the full roster-aware match: a late game can hold hundreds of NPCs.
    const mayBeNamed = npc => [npc.name, ...(npc.aliases || [])]
        .some(label => normalizeName(label).split(/\s+/).some(token => token.length >= 3 && haystack.includes(token)));
    const named = roster.filter(npc => npc?.name && !castIds.has(npc.id) && !npc.present && mayBeNamed(npc) && npcNamedInText(npc, text, roster));
    const bondOf = npc => cleanText(String(cleanList(npc.keyRelationships, 1, 160)[0] || '').split('|')[0], 90);
    const mentioned = named.filter(npc => !isTerminalNpcDeath(npc)).slice(0, REFERENCE_LINE_LIMIT).map(npc => {
        const custom = Object.entries(customFieldValues(npc, customFieldNames)).map(([name, value]) => `${name}: ${value}`).join(' · ');
        const facts = [normalizeGender(npc.gender), cleanText(npc.role, 70), npc.homeBase && `home base: ${cleanText(npc.homeBase, 60)}`,
            custom, npc.relationshipSummary && `toward the player: ${cleanText(npc.relationshipSummary, 90)}`].filter(Boolean);
        return truncateInjectionText(`- ${npc.name} (${['mentioned, not present', ...facts].join('; ')})`, REFERENCE_LINE_CHARS);
    });
    const deceased = named.filter(npc => isTerminalNpcDeath(npc)).slice(0, Math.min(3, REFERENCE_LINE_LIMIT - mentioned.length)).map(npc => {
        const bond = bondOf(npc);
        const facts = [normalizeGender(npc.gender), cleanText(npc.role, 70), bond && `bond: ${bond}`].filter(Boolean);
        const death = cleanText(npc.lifeStateReason, 140);
        return truncateInjectionText(`- ${npc.name} (deceased${facts.length ? `; ${facts.join('; ')}` : ''})${death ? `: ${death}` : ''}`, REFERENCE_LINE_CHARS);
    });
    return [mentioned.length && MENTIONED_HEADER, ...mentioned, deceased.length && DECEASED_HEADER, ...deceased].filter(Boolean).join('\n');
}

export function buildInjection(npcs, text, turn = 0, limit = 3, behaviorCriteria = DEFAULT_BEHAVIOR_CRITERIA, budgetTokens = DEFAULT_INJECTION_BUDGET_TOKENS, socialGraph = null, { includeAppearance = false, namedNpcIds = [], customFieldNames = [], sceneDeferred = false, awayNotes = null, gearLines = null } = {}) {
    const named = new Set(Array.isArray(namedNpcIds) ? namedNpcIds : []);
    const calledIn = npc => !npc?.present && named.has(npc?.id);
    const present = (npcs || []).filter(npc => (Boolean(npc?.present) || calledIn(npc)) && !npc?.archived);
    let relevant = selectRelevantNpcs(present, text, turn, limit, socialGraph, npcs || []);
    const budget = normalizeInjectionBudgetTokens(budgetTokens);
    const budgetChars = budget * APPROX_CHARS_PER_TOKEN;
    if (!relevant.length) {
        const references = referenceBlock(npcs || [], text, new Set(), customFieldNames);
        return references ? truncateInjectionText(['NPC STATE DELTA DOSSIER. Treat these as established story facts; never mention the dossier.', references].join('\n'), budgetChars) : '';
    }
    const headerFor = () => [
        'NPC STATE DELTA DOSSIER. Only confirmed-present NPCs; established facts; never mention it or any numeric value.',
        'Personality sets identity; behavior profile, speech and mannerisms shape response and expression; goals, duties, morals, bonds and CURRENT mood/status decide behavior. Keep each Speech\'s wording, cadence and habits; do not flatten distinct voices.',
        'Player relationship only biases openness and attention; high scores never mean obedience, clinginess, jealousy, tsundere behavior or cruelty to others. Mood or player-specific behavior is not identity; durable identity changes gradually unless a time skip.',
        relevant.some(lowPlayerStanding) && 'LOW SCORES: the player is not special to them; no obligation, fixation or "only them" thinking.',
        relevant.some(calledIn) && 'Exception: NPCs marked "named by player" are not yet confirmed on-screen; use their dossier if they appear.',
    ].filter(Boolean).join('\n');

    let header = headerFor();

    // Identity and agency are structural, not optional enrichment. Drop lower-ranked NPCs before
    // sacrificing the top NPC's personality/voice/mannerisms or non-player goals and bonds.
    // Section caps grow with the budget above the 1800-token base, so raising the
    // budget lets a rich dossier arrive whole; tight budgets still shrink them below.
    const capScale = Math.min(3.6, Math.max(1, budget / INJECTION_CAP_BASE_TOKENS));
    let behaviorCap = Math.round(Math.min(320, 160 * capScale));
    let identityCap = Math.round(Math.min(2200, 620 * capScale));
    let agencyCap = Math.round(Math.min(900, 300 * capScale));
    let stateCap = Math.round(Math.min(400, 180 * capScale));
    // A key person who just came back (Story Director's key people) brings a short "while away" summary, once, with
    // their block; it counts in the budget like the block. Without notes the text is exactly as before.
    const awayNote = npc => {
        const note = awayNotes && typeof awayNotes === 'object' ? cleanText(awayNotes[npc.id], 400) : '';
        return note ? `; ${note}` : '';
    };
    // A pack cast member's signature gear line (Story Block's packs.castGear), as given, at the end of their block; none, nothing.
    const gearNote = npc => {
        const line = gearLines && typeof gearLines === 'object' ? cleanText(gearLines[npc.id], 300) : '';
        return line ? `; ${line}` : '';
    };
    const renderEssentials = () => relevant.map(npc => {
        const block = injectionEssentialBlock(npc, behaviorCap, identityCap, agencyCap, stateCap, customFieldNames, sceneDeferred) + awayNote(npc) + gearNote(npc);
        return calledIn(npc) ? block.replace(`- ${npc.name}: `, `- ${npc.name} (named by player): `) : block;
    });
    while (relevant.length > 1 && (header.length + 1 + renderEssentials().join('\n').length) > budgetChars) {
        relevant = relevant.slice(0, -1);
    }
    header = headerFor();
    let essentialBlocks = renderEssentials();
    while ((header.length + 1 + essentialBlocks.join('\n').length) > budgetChars
        && (behaviorCap > 80 || identityCap > 260 || agencyCap > 140 || stateCap > 100)) {
        behaviorCap = Math.max(80, behaviorCap - 20);
        identityCap = Math.max(260, identityCap - 50);
        agencyCap = Math.max(140, agencyCap - 30);
        stateCap = Math.max(100, stateCap - 20);
        essentialBlocks = renderEssentials();
    }

    let lines = [header, ...essentialBlocks];
    let currentLength = lines.join('\n').length;
    if (currentLength > budgetChars) {
        // The minimum-budget last resort keeps the priority order: header -> identity/agency ->
        // relationship expression. Because every identity field is compacted independently,
        // this no longer silently starves Speech/Mannerisms behind a long Personality field.
        return truncateInjectionText(lines.join('\n'), budgetChars);
    }

    // Relationship rubric is useful, but subordinate to the actual NPC. Stock wording is compiled
    // to a tiny semantic rubric; custom user criteria are retained only as space permits.
    const rubricAllowance = Math.min(600, Math.max(100, Math.floor(budgetChars * 0.08)));
    const rubricText = compactInjectionBehaviorRubric(behaviorCriteria, rubricAllowance);
    if (rubricText) {
        const fullRubric = `RELATIONSHIP-TO-BEHAVIOR RUBRIC: ${rubricText}`;
        const room = budgetChars - currentLength - 1;
        if (room >= 90) {
            lines.push(truncateInjectionText(fullRubric, room));
            currentLength = lines.join('\n').length;
        }
    }

    // Mentioned and deceased references outrank optional enrichment but never the injected cast's
    // essentials; NPCs dropped from the cast for budget may still get their one line.
    const referenceText = (() => {
        const block = referenceBlock(npcs || [], text, new Set(relevant.map(npc => npc.id)), customFieldNames);
        const room = budgetChars - currentLength - 1;
        return block && room >= 80 ? truncateInjectionText(block, room) : '';
    })();
    if (referenceText) currentLength += referenceText.length + 1;

    // Optional continuity then fills remaining room round-robin so one verbose dossier cannot
    // starve another. Relationship summary is deliberately late: live identity/state already won priority.
    // Resolved appearance uses the same optional budget as other continuity. It must not
    // shrink the essential identity/agency budget or be spliced ahead of characterization.
    const optionalByNpc = relevant.map(npc => injectionOptionalFields(npc, includeAppearance, sceneDeferred));
    const enriched = essentialBlocks.slice();
    const maxPriority = Math.max(0, ...optionalByNpc.map(fields => fields.length));
    for (let priority = 0; priority < maxPriority; priority++) {
        // Appearance variants are placed in two passes: every NPC first gets its most compact
        // anatomy (physical features, or a clause-bounded cut), then full appearances replace them
        // while room remains, so one long outfit cannot crowd out another NPC's anatomy.
        const chosen = relevant.map(() => '');
        for (let i = 0; i < relevant.length; i++) {
            const field = optionalByNpc[i][priority];
            if (!field) continue;
            const variants = Array.isArray(field) ? field : [field];
            const compact = variants[variants.length - 1];
            let pick = (currentLength + 2 + compact.length) <= budgetChars ? compact : '';
            if (!pick && Array.isArray(field)) pick = clauseBoundedInjection(compact, budgetChars - currentLength - 2);
            if (!pick) continue;
            chosen[i] = pick;
            currentLength += pick.length + 2;
        }
        for (let i = 0; i < relevant.length; i++) {
            const field = optionalByNpc[i][priority];
            if (!Array.isArray(field) || !chosen[i]) continue;
            const upgrade = field.find(variant => variant.length > chosen[i].length && (currentLength - chosen[i].length + variant.length) <= budgetChars);
            if (!upgrade) continue;
            currentLength += upgrade.length - chosen[i].length;
            chosen[i] = upgrade;
        }
        for (let i = 0; i < relevant.length; i++) {
            if (chosen[i]) enriched[i] += `; ${chosen[i]}`;
        }
    }

    // Rebuild with enriched NPC lines while preserving rubric placement.
    const rubricLine = lines.find(line => line.startsWith('RELATIONSHIP-TO-BEHAVIOR RUBRIC:')) || '';
    const finalLines = [header, ...enriched, referenceText, rubricLine].filter(Boolean);
    return truncateInjectionText(finalLines.join('\n'), budgetChars);
}
