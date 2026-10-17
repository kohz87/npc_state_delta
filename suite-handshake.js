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

function safeSuite(suite) {
    try {
        return suite || storySuite();
    } catch {
        return null;
    }
}

/** True when another suite extension is the source of truth for `area` under the reader's choice. */
export function defersArea(area, choices = {}, suite = null) {
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

/**
 * What Story Suite's overlay uses to manage Delta (docs/STORY_SUITE.md, api.manage). The
 * callbacks are Delta's own settings actions; this wrapper only validates and copies. setSource
 * returns false, without calling back, for an unknown area or choice.
 */
export function buildManageApi({ sources, setSource, enabled, setEnabled } = {}) {
    return Object.freeze({
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
export function suiteManageAvailable(suite = null) {
    const registry = safeSuite(suite);
    if (!registry) return false;
    try {
        return registry.providers().length >= 2 && typeof registry.api('story-block')?.openSuite === 'function';
    } catch {
        return false;
    }
}

/** Open Story Suite's overlay on Delta's tab; false when the overlay is unavailable or fails. */
export function openSuiteOverlay(suite = null) {
    const registry = safeSuite(suite);
    if (!suiteManageAvailable(registry)) return false;
    try {
        registry.api('story-block').openSuite(SUITE_ID);
        return true;
    } catch (error) {
        console.warn('[NPC State Delta] Story Suite overlay failed to open', error);
        return false;
    }
}

/**
 * Announce Delta. Enabled, it offers its four areas. Disabled, it announces `enabled: false`
 * (keeping `settings` and the api) when its api can switch it back on, so the overlay can;
 * otherwise it withdraws. Returns true while Delta is announced as enabled.
 */
export function announceNpcStateDelta({ enabled = true, version = '', api = null, settings = '' } = {}, suite = null) {
    const registry = safeSuite(suite);
    if (!registry) return false;
    try {
        if (!enabled && typeof api?.manage?.setEnabled !== 'function') {
            registry.withdraw(SUITE_ID);
            return false;
        }
        registry.announce({
            id: SUITE_ID,
            name: SUITE_NAME,
            version: String(version),
            owns: [...SUITE_AREAS],
            enabled: Boolean(enabled),
            ...(settings ? { settings: String(settings) } : {}),
            ...(api ? { api } : {}),
        });
        return Boolean(enabled);
    } catch (error) {
        console.warn('[NPC State Delta] Story Suite announcement failed', error);
        return false;
    }
}
