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

/** Announce Delta while it is enabled; withdraw it while it is disabled. */
export function announceNpcStateDelta({ enabled = true, version = '', api = null } = {}, suite = null) {
    const registry = safeSuite(suite);
    if (!registry) return false;
    try {
        if (!enabled) {
            registry.withdraw(SUITE_ID);
            return false;
        }
        registry.announce({ id: SUITE_ID, name: SUITE_NAME, version: String(version), owns: [...SUITE_AREAS], ...(api ? { api } : {}) });
        return true;
    } catch (error) {
        console.warn('[NPC State Delta] Story Suite announcement failed', error);
        return false;
    }
}
