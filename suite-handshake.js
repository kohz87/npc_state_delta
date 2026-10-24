// NPC State Delta's side of the Story Suite handshake (docs/STORY_SUITE.md). suite.js is the
// shared registry, identical in every suite extension; this module holds what Delta announces and
// how it defers. Alone, every choice behaves like Automatic and Delta is the source of truth for
// all four areas, so nothing here changes Delta's behavior without another suite extension.
import { isSourceOfTruth, storySuite } from './suite.js';

export const SUITE_ID = 'npc-state-delta';
export const SUITE_NAME = 'NPC State Delta';
// Calendar, scene and stats are fallbacks: the suite's AREAS order lets their specialists win.
export const SUITE_AREAS = Object.freeze(['npc', 'calendar', 'scene', 'stats']);
export const SOURCE_OF_TRUTH_CHOICES = Object.freeze(['auto', 'mine', 'theirs']);

export function normalizeSourceOfTruth(raw = {}) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return Object.fromEntries(SUITE_AREAS.map(area => [area, SOURCE_OF_TRUTH_CHOICES.includes(source[area]) ? source[area] : 'auto']));
}

export const SUITE_STYLESHEET_ID = 'story-suite-css';

/**
 * True when the page's Story Block is version 2 (`apiVersion: 2`). A v2 host carries Delta through
 * its sdk (src/storysuite-v2.js: the Cast tab and the settings section), so Delta then offers it
 * nothing of v1's: no Present NPCs / Dossiers tabs, no Story Suite announcement for v1's overlay,
 * no "Open Story Suite" button. A v1 Story Block (apiVersion 1) or none changes nothing.
 */
export function storyBlockIsV2(storyBlock = globalThis.StoryBlock) {
    try {
        return storyBlock?.apiVersion === 2;
    } catch {
        return false;
    }
}

/**
 * Load the shared suite.css once per page as <link id="story-suite-css">: the first suite
 * extension to load wins (the copies are identical). True when this call added it.
 */
export function ensureSuiteStylesheet(href = new URL('./suite.css', import.meta.url).href, doc = globalThis.document) {
    try {
        if (!doc?.createElement || doc.getElementById?.(SUITE_STYLESHEET_ID)) return false;
        const parent = doc.head || doc.documentElement;
        if (typeof parent?.appendChild !== 'function') return false;
        const link = doc.createElement('link');
        link.rel = 'stylesheet';
        link.id = SUITE_STYLESHEET_ID;
        link.href = String(href);
        parent.appendChild(link);
        return true;
    } catch {
        return false;
    }
}

function safeSuite(suite) {
    try {
        return suite || storySuite();
    } catch {
        return null;
    }
}

/** True when another suite extension is the source of truth for `area` under the reader's choice. */
export function defersArea(area, choices = {}, suite = null) {
    // A Story Block v2 host keeps the scene (its `scene.present`) but never fills v1's registry: the
    // reader's "theirs" (and "auto", where the scene specialist wins) defer to it; "mine" keeps it here.
    if (area === 'scene' && storyBlockIsV2()) return normalizeSourceOfTruth(choices).scene !== 'mine';
    const registry = safeSuite(suite);
    if (!registry) return false;
    try {
        return !isSourceOfTruth(SUITE_ID, area, normalizeSourceOfTruth(choices)[area] || 'auto', registry);
    } catch {
        return false;
    }
}

/** The extension Delta defers `area` to, as { id, name }, or null when Delta is the source of truth. */
export function areaOwner(area, choices = {}, suite = null) {
    const registry = safeSuite(suite);
    if (!registry || !defersArea(area, choices, registry)) return null;
    try {
        const owner = registry.owner(area);
        const id = owner && owner !== SUITE_ID ? owner : registry.offering(area).find(other => other !== SUITE_ID);
        if (!id) return null;
        const provider = registry.providers().find(item => item.id === id);
        return { id, name: String(provider?.name || id) };
    } catch {
        return null;
    }
}

/**
 * The calendar Delta should use while another extension owns 'calendar': that extension's
 * shared { era, months: [{ name, days }] }, or null (Delta then keeps its own calendar). A
 * missing, throwing or malformed provider is treated as absent.
 */
export function externalCalendar(choices = {}, suite = null) {
    const owner = areaOwner('calendar', choices, suite);
    if (!owner) return null;
    try {
        const shared = safeSuite(suite)?.api(owner.id)?.calendar?.();
        if (!shared || typeof shared !== 'object' || !Array.isArray(shared.months) || !shared.months.length) return null;
        return {
            era: String(shared.era ?? ''),
            months: shared.months.map(month => ({ name: String(month?.name ?? ''), days: Number(month?.days) })),
        };
    } catch {
        return null;
    }
}

// Words that name game numbers kept by a stats owner (RPG Battle), matched as whole words.
const STAT_FIELD_WORDS = new Set([
    'level', 'lv', 'lvl', 'hp', 'mp', 'sp', 'xp', 'exp', 'experience', 'health', 'mana', 'stamina',
    'str', 'vit', 'agi', 'dex', 'int', 'luk', 'cha', 'wis', 'con', 'atk', 'def',
    'strength', 'vitality', 'agility', 'dexterity', 'intelligence', 'luck', 'charisma', 'wisdom', 'constitution',
    'attack', 'defense', 'defence', 'class', 'rank', 'stats', 'skill', 'skills',
]);

/** The custom field names that look like game stats (Level, HP, Class…), in their given order. */
export function statLikeFieldNames(names = []) {
    return (Array.isArray(names) ? names : [])
        .map(name => String(name ?? '').trim())
        .filter(name => (name.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || []).some(word => STAT_FIELD_WORDS.has(word)));
}

/** The warning shown under Custom fields when another extension owns 'stats', or ''. */
export function statsOverlapWarning(names = [], choices = {}, suite = null) {
    const owner = areaOwner('stats', choices, suite);
    const overlap = owner ? statLikeFieldNames(names) : [];
    if (!overlap.length) return '';
    return `${owner.name} keeps game stats. ${overlap.join(', ')} may duplicate or contradict it; consider removing ${overlap.length === 1 ? 'that field' : 'those fields'} here.`;
}

// npcProfiles() (Story Suite contract, NPC State Delta 1.2.2): a short role and a <= 200-char
// summary per tracked, non-archived NPC, shaped only from fields the dossier already holds.
export const NPC_PROFILE_ROLE_MAX = 60;
export const NPC_PROFILE_SUMMARY_MAX = 200;
// Custom field names (as whole words) that stand in for an empty dossier role, in this order.
const ROLE_FIELD_WORDS = ['role', 'occupation', 'profession', 'job', 'title', 'class'];
// Custom field names (as whole words) that say what an NPC can do.
const ABILITY_FIELD_WORDS = new Set([
    'ability', 'abilities', 'skill', 'skills', 'power', 'powers', 'magic', 'spell', 'spells',
    'talent', 'talents', 'specialty', 'speciality', 'expertise', 'combat', 'weapon', 'weapons', 'class',
]);

function plainText(value) {
    return typeof value === 'string' || typeof value === 'number' ? String(value).replace(/\s+/g, ' ').trim() : '';
}

function fieldWords(name) {
    return plainText(name).toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

/** `text` within `max` characters: whole words only, ending in an ellipsis when shortened. */
export function trimAtWord(text, max) {
    const value = plainText(text);
    const cap = Math.max(0, Math.floor(Number(max) || 0));
    if (value.length <= cap) return value;
    if (cap < 2) return '';
    const prefix = value.slice(0, cap - 1);
    const cut = value[cap - 1] === ' ' ? prefix.length : prefix.lastIndexOf(' ');
    const head = (cut > 0 ? prefix.slice(0, cut) : prefix).replace(/[\s,;:.|/(\-–—]+$/u, '');
    return head ? `${head}…` : '';
}

// The configured custom fields that hold a value on this dossier, as [name, value] pairs.
function configuredCustomFields(npc, names) {
    const stored = npc?.customFields && typeof npc.customFields === 'object' && !Array.isArray(npc.customFields) ? npc.customFields : {};
    const keys = Object.keys(stored);
    const seen = new Set();
    const out = [];
    for (const raw of Array.isArray(names) ? names : []) {
        const name = plainText(raw);
        const lower = name.toLocaleLowerCase();
        if (!name || seen.has(lower)) continue;
        seen.add(lower);
        const key = keys.find(other => other.toLocaleLowerCase() === lower);
        const value = key === undefined ? '' : plainText(stored[key]);
        if (value) out.push([name, value]);
    }
    return out;
}

function sentence(text) {
    return plainText(text).replace(/[\s.;,:]+$/u, '');
}

/**
 * One NPC's suite profile: { id, name, aliases, present, role, summary } as a frozen plain copy.
 * `role` is the dossier's occupation/story role (or a role-like custom field when it is empty),
 * cut to its first phrase; `summary` joins who they are (role, species), what they can do
 * (ability-like custom fields), personality and background, trimmed to 200 characters.
 */
export function buildNpcProfile(npc, { customFieldNames = [] } = {}) {
    const fields = configuredCustomFields(npc, customFieldNames);
    const dossierRole = plainText(npc?.role);
    const roleField = dossierRole ? null : ROLE_FIELD_WORDS
        .map(word => fields.find(([name]) => fieldWords(name).includes(word)))
        .find(Boolean) || null;
    const fullRole = dossierRole || roleField?.[1] || '';
    const firstPhrase = fullRole.split(/\s*(?:[;|(]|\s[-–—]\s)/u)[0];
    const role = trimAtWord(sentence(firstPhrase), NPC_PROFILE_ROLE_MAX);

    const species = sentence(npc?.species);
    const who = sentence(fullRole);
    const identity = who && species && !who.toLocaleLowerCase().includes(species.toLocaleLowerCase())
        ? `${who} (${species})`
        : who || species;
    const abilities = fields
        .filter(field => field !== roleField && fieldWords(field[0]).some(word => ABILITY_FIELD_WORDS.has(word)))
        .map(([name, value]) => `${name}: ${sentence(value)}`);
    const parts = [identity, ...abilities, sentence(npc?.personality), sentence(npc?.background)].filter(Boolean);
    const summary = trimAtWord(parts.length ? `${parts.join('. ')}.` : '', NPC_PROFILE_SUMMARY_MAX);

    return Object.freeze({
        id: plainText(npc?.id),
        name: plainText(npc?.name),
        aliases: Object.freeze((Array.isArray(npc?.aliases) ? npc.aliases : []).map(plainText).filter(Boolean)),
        present: Boolean(npc?.present),
        role,
        summary,
    });
}

// Dead in the dossier: lifeState 'deceased' (explicit or inferred), or archived as deceased. A
// confirmed death is archived automatically only while Auto-archive deaths is on, and an inferred
// one never is, so the archive flag alone does not keep the dead out of a companion picker.
function isDeceased(npc) {
    return String(npc?.lifeState ?? '').trim().toLowerCase() === 'deceased' || npc?.archiveReason === 'deceased';
}

/** Suite profiles for the tracked, non-archived, not-deceased NPCs, in dossier order; never throws. */
export function buildNpcProfiles(npcs, options = {}) {
    try {
        return Object.freeze((Array.isArray(npcs) ? npcs : [])
            .filter(npc => npc && typeof npc === 'object' && !npc.archived && !isDeceased(npc))
            .map(npc => buildNpcProfile(npc, options)));
    } catch (error) {
        console.warn('[NPC State Delta] Story Suite NPC profiles failed', error);
        return Object.freeze([]);
    }
}

function nameKey(value) {
    return plainText(value).toLocaleLowerCase();
}

/**
 * The dossier id openDossier(value) should open, or '' to do nothing. `value` is an NPC id; when
 * no dossier has that id, it may be a name or alias (case-insensitive, exact), matched among the
 * non-archived NPCs: a unique name match first, then a unique alias match. An archived NPC, an
 * unknown or ambiguous value, or a malformed list resolves to ''. Never throws.
 */
export function resolveDossierTarget(npcs, value) {
    try {
        const query = plainText(value);
        if (!query) return '';
        const list = (Array.isArray(npcs) ? npcs : []).filter(npc => npc && typeof npc === 'object' && plainText(npc.id));
        const byId = list.find(npc => plainText(npc.id) === query);
        if (byId) return byId.archived ? '' : plainText(byId.id);
        const key = nameKey(query);
        const active = list.filter(npc => !npc.archived);
        const named = active.filter(npc => nameKey(npc.name) === key);
        if (named.length) return named.length === 1 ? plainText(named[0].id) : '';
        const aliased = active.filter(npc => Array.isArray(npc.aliases) && npc.aliases.some(alias => nameKey(alias) === key));
        return aliased.length === 1 ? plainText(aliased[0].id) : '';
    } catch {
        return '';
    }
}

// tokens() (docs/STORY_SUITE.md, api.manage.tokens): about four characters a token.
export const CHARS_PER_TOKEN = 4;
// The one-pass capture block the model writes back, until this session has seen one.
export const NARRATION_CAPTURE_OUTPUT_ESTIMATE_CHARS = 1200;
const MENTIONED_PREFIX = 'MENTIONED, NOT PRESENT:';
const DECEASED_PREFIX = 'DECEASED, REFERENCED ONLY:';
const RUBRIC_PREFIX = 'RELATIONSHIP-TO-BEHAVIOR RUBRIC:';
const tokensFor = chars => Math.ceil(Math.max(0, Number(chars) || 0) / CHARS_PER_TOKEN);

/**
 * The dossier injection split into its sections, as { label, chars }: the instructions header,
 * the present NPC cards, mentioned-not-present lines, deceased references and the relationship
 * rubric, in the order they appear. Empty sections are left out.
 */
export function injectionSections(text) {
    const order = ['Dossier instructions', 'Present NPC cards', 'Mentioned NPCs', 'Deceased references', 'Relationship rubric'];
    const chars = new Map();
    let section = order[0];
    const lines = String(text ?? '').split('\n');
    lines.forEach((line, index) => {
        if (line.startsWith(MENTIONED_PREFIX)) section = order[2];
        else if (line.startsWith(DECEASED_PREFIX)) section = order[3];
        else if (line.startsWith(RUBRIC_PREFIX)) section = order[4];
        else if (line.startsWith('- ') && section === order[0]) section = order[1];
        if (!line && lines.length === 1) return;
        chars.set(section, (chars.get(section) || 0) + line.length + (index ? 1 : 0));
    });
    return order.filter(label => chars.get(label)).map(label => ({ label, chars: chars.get(label) }));
}

/**
 * { input, output, parts: [{ label, input, output }] } for what Delta adds to one ordinary reply:
 * the injection's sections, plus the one-pass capture instruction (input) and its block (output)
 * when capture is on. Totals are the sums of the parts. Never throws.
 */
export function replyTokenEstimate({ injection = '', captureChars = 0, captureOutputChars = 0 } = {}) {
    try {
        const parts = injectionSections(injection).map(({ label, chars }) => ({ label, input: tokensFor(chars), output: 0 }));
        if (Number(captureChars) > 0) {
            // (1.2.13) Its own slot at the end of the prompt, apart from the dossier.
            parts.push({ label: 'One-pass capture instruction', input: tokensFor(Number(captureChars)), output: 0 });
            parts.push({ label: 'One-pass capture block', input: 0, output: tokensFor(captureOutputChars) });
        }
        const sum = key => parts.reduce((total, part) => total + part[key], 0);
        return { input: sum('input'), output: sum('output'), parts };
    } catch {
        return { input: 0, output: 0, parts: [] };
    }
}

/** A plain copy of an estimate: whole non-negative numbers, totals recomputed from the parts. */
export function copyTokenEstimate(estimate) {
    const count = value => Math.max(0, Math.round(Number(value) || 0));
    const parts = (Array.isArray(estimate?.parts) ? estimate.parts : [])
        .filter(part => part && typeof part === 'object')
        .map(part => ({ label: String(part.label ?? ''), input: count(part.input), output: count(part.output) }));
    const sum = key => parts.reduce((total, part) => total + part[key], 0);
    return { input: sum('input'), output: sum('output'), parts };
}

/**
 * What Story Suite's overlay uses to manage Delta (docs/STORY_SUITE.md, api.manage). The
 * callbacks are Delta's own settings actions; this wrapper only validates and copies. setSource
 * returns false, without calling back, for an unknown area or choice.
 */
/**
 * (1.2.13) What Delta sends with the next ordinary reply, as text: { label, text, parts:
 * [{ label, text, tokens }] } (empty parts left out). Never throws.
 */
export function replyPreview({ injection = '', capture = '' } = {}) {
    try {
        const parts = [
            { label: 'Live dossier', text: String(injection ?? '') },
            { label: 'One-pass capture instruction (end of the prompt)', text: String(capture ?? '') },
        ].filter(part => part.text).map(part => ({ ...part, tokens: tokensFor(part.text.length) }));
        return { label: 'NPC State Delta', text: parts.map(part => part.text).join('\n\n'), parts };
    } catch {
        return { label: 'NPC State Delta', text: '', parts: [] };
    }
}

export function buildManageApi({ sources, setSource, enabled, setEnabled, tokens, preview } = {}) {
    return Object.freeze({
        /** (1.2.13) What Delta sends with the next ordinary reply ({ label, text, parts }); never throws. */
        preview: () => {
            try {
                const result = typeof preview === 'function' ? preview() : null;
                return replyPreview({ injection: result?.injection, capture: result?.capture });
            } catch (error) {
                console.warn('[NPC State Delta] Story Suite preview failed', error);
                return replyPreview();
            }
        },
        /** What Delta adds to the next ordinary reply ({ input, output, parts }); never throws. */
        tokens: () => {
            try {
                return copyTokenEstimate(typeof tokens === 'function' ? tokens() : null);
            } catch (error) {
                console.warn('[NPC State Delta] Story Suite token estimate failed', error);
                return replyTokenEstimate();
            }
        },
        areas: SUITE_AREAS,
        sources: () => ({ ...normalizeSourceOfTruth(sources?.()) }),
        setSource: (area, choice) => {
            if (!SUITE_AREAS.includes(area) || !SOURCE_OF_TRUTH_CHOICES.includes(choice)) return false;
            setSource?.(area, choice);
            return true;
        },
        enabled: () => enabled?.() !== false,
        setEnabled: on => {
            setEnabled?.(Boolean(on));
        },
    });
}

/**
 * Whether Delta's panel shows "Manage all in Story Suite": two or more extensions announced (on
 * or off, as the overlay counts them) and Story Block sharing openSuite.
 */
export function suiteManageAvailable(suite = null, storyBlock = globalThis.StoryBlock) {
    if (storyBlockIsV2(storyBlock)) return false;
    const registry = safeSuite(suite);
    if (!registry) return false;
    try {
        return registry.providers().length >= 2 && typeof registry.api('story-block')?.openSuite === 'function';
    } catch {
        return false;
    }
}

/** Open Story Suite's overlay on Delta's tab; false when the overlay is unavailable or fails. */
export function openSuiteOverlay(suite = null, storyBlock = globalThis.StoryBlock) {
    const registry = safeSuite(suite);
    if (!suiteManageAvailable(registry, storyBlock)) return false;
    try {
        registry.api('story-block').openSuite(SUITE_ID);
        return true;
    } catch (error) {
        console.warn('[NPC State Delta] Story Suite overlay failed to open', error);
        return false;
    }
}

// What Delta displays for another extension (docs/STORY_SUITE.md, `shows`): Story Block's NPC
// Inner Chatter, on the Present NPCs cards. Story Block hides its own Chatter tab meanwhile.
export const SUITE_SHOWS = Object.freeze(['chatter']);

/**
 * Announce Delta. Enabled, it offers its four areas and `shows` what it displays for others.
 * Disabled, it announces `enabled: false` without `shows` (keeping `settings` and the api) when
 * its api can switch it back on, so the overlay can; otherwise it withdraws. Returns true while
 * Delta is announced as enabled. With a Story Block v2 host on the page it withdraws (v1's overlay
 * would otherwise carry the same settings panel the v2 section carries).
 */
export function announceNpcStateDelta({ enabled = true, version = '', api = null, settings = '', shows = [], storyBlock = globalThis.StoryBlock } = {}, suite = null) {
    const registry = safeSuite(suite);
    if (!registry) return false;
    try {
        if (storyBlockIsV2(storyBlock) || (!enabled && typeof api?.manage?.setEnabled !== 'function')) {
            registry.withdraw(SUITE_ID);
            return false;
        }
        registry.announce({
            id: SUITE_ID,
            name: SUITE_NAME,
            version: String(version),
            owns: [...SUITE_AREAS],
            enabled: Boolean(enabled),
            ...(enabled && Array.isArray(shows) && shows.length ? { shows: shows.map(String) } : {}),
            ...(settings ? { settings: String(settings) } : {}),
            ...(api ? { api } : {}),
        });
        return Boolean(enabled);
    } catch (error) {
        console.warn('[NPC State Delta] Story Suite announcement failed', error);
        return false;
    }
}
