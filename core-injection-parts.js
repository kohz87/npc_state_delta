/* NPC State Delta injection block rendering: truncation, fair field sharing, identity/agency/state
   blocks, optional continuity and mentioned/deceased references. Split unchanged from
   core-injection.js; these helpers are module-internal rather than public core exports. */
import { calibrateRelationshipSummary, DEFAULT_RELATIONSHIP, DURABLE_PROFILE_LIMITS, normalizeRelationshipBaseline, relationshipSummaryConsistent } from './core-relationship.js';
import { cleanList, cleanText, normalizeName } from './core-text.js';
import { npcNamedInText } from './core-merge.js';
import { KEY_RELATIONSHIP_LIMIT } from './core-keyrel.js';
import { customFieldValues, IMPORTANT_MEMORY_LIMIT } from './core-record.js';
import { orderedBehaviorProfile } from './core-behavior.js';
import { normalizeGender } from './core-identity.js';
import { DEFAULT_BEHAVIOR_CRITERIA } from './core-prompts.js';
import { isTerminalNpcDeath } from './terminal-lifecycle.js';
import { buildBehaviorGuidance } from './core-injection-selection.js';

export function truncateInjectionText(value, maxChars) {
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

export function lowPlayerStanding(npc) {
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

export function injectionEssentialBlock(npc, behaviorCap = 160, identityCap = 620, agencyCap = 300, stateCap = 180, customFieldNames = [], sceneDeferred = false) {
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

export function clauseBoundedInjection(text, room) {
    const labelEnd = text.indexOf('): ') + 3;
    if (room < 80 || labelEnd < 3) return '';
    const cut = text.slice(0, room);
    const boundary = Math.max(cut.lastIndexOf('; '), cut.lastIndexOf(', '));
    return boundary >= labelEnd + 20 ? cut.slice(0, boundary) : '';
}

export function injectionOptionalFields(npc, includeAppearance = false, sceneDeferred = false) {
    const importantMemories = cleanList(npc.memories, IMPORTANT_MEMORY_LIMIT, DURABLE_PROFILE_LIMITS.memory);
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

export function compactInjectionBehaviorRubric(criteria, maxChars) {
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
// The "toward the player" fact of a mentioned-but-absent NPC. A cast dossier's summary comes from the pack, not from a gated scanner write,
// so it passes the same calibrate + consistency check as the present path (compactRelationshipModifier); any other dossier is printed as stored.
function towardPlayer(npc) {
    if (!npc.relationshipSummary) return '';
    let summary = npc.relationshipSummary;
    if (npc.castFrom?.key) {
        const rel = normalizeRelationshipBaseline(npc.relationship || DEFAULT_RELATIONSHIP);
        summary = calibrateRelationshipSummary(summary, rel);
        if (!summary || !relationshipSummaryConsistent(summary, rel)) return '';
    }
    return `toward the player: ${cleanText(summary, 90)}`;
}

export function referenceBlock(npcs = [], text = '', castIds = new Set(), customFieldNames = []) {
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
            custom, towardPlayer(npc)].filter(Boolean);
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
