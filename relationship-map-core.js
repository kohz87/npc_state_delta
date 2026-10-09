/* NPC State Delta relationship map primitives: pure layout, selection and bond rules over the
   dossier projection. No DOM, host or state access. */
import { parseKeyRelationshipEntry, resolveNpcReference } from './social.js';

// The radius formula is drawn for a 780-unit map; the SVG and node positions scale with it.
export const MAP_SPAN = 780;
export const MAP_CENTER = MAP_SPAN / 2;
export const DESKTOP_NODE_CAP = 24;
export const PHONE_NODE_CAP = 16;

export const MAP_LENSES = Object.freeze([
    Object.freeze({ key: 'warmth', label: 'Warmth', negative: 'cold · hostile' }),
    Object.freeze({ key: 'trust', label: 'Trust', negative: 'distrust' }),
    Object.freeze({ key: 'affection', label: 'Affection', negative: 'dislike' }),
    Object.freeze({ key: 'desire', label: 'Desire', negative: 'aversion' }),
    Object.freeze({ key: 'tension', label: 'Tension', negative: 'at ease' }),
]);
const LENS_KEYS = MAP_LENSES.map(lens => lens.key);
const AXES = Object.freeze([['trust', 'Trust'], ['affection', 'Affection'], ['desire', 'Desire'], ['tension', 'Tension']]);

export const RELATIONSHIP_MAP_DEFAULTS = Object.freeze({ enabled: true, defaultLens: 'warmth', showPast: false });

export function plain(value) { return String(value ?? '').trim(); }

function score(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(-100, Math.min(100, Math.round(number))) : 0;
}

export function signed(value) { return value > 0 ? `+${value}` : (value < 0 ? `−${Math.abs(value)}` : '0'); }

export function normalizeRelationshipMapSettings(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
        enabled: typeof source.enabled === 'boolean' ? source.enabled : RELATIONSHIP_MAP_DEFAULTS.enabled,
        defaultLens: LENS_KEYS.includes(source.defaultLens) ? source.defaultLens : RELATIONSHIP_MAP_DEFAULTS.defaultLens,
        showPast: typeof source.showPast === 'boolean' ? source.showPast : RELATIONSHIP_MAP_DEFAULTS.showPast,
    };
}

export function lensValue(relationship = {}, lens = 'warmth') {
    const rel = relationship && typeof relationship === 'object' ? relationship : {};
    if (lens === 'warmth') return Math.round((score(rel.trust) + score(rel.affection)) / 2);
    return score(rel[LENS_KEYS.includes(lens) ? lens : 'trust']);
}

// Closer to the centre is higher. Positive values pull in faster than negative values push out.
export function mapRadius(value, size = MAP_SPAN) {
    const v = score(value);
    return (size / MAP_SPAN) * (v >= 0 ? 245 - v * 1.85 : 245 - v * 1.15);
}

export function mapStatus(npc = {}) {
    if (npc.bucket === 'dead') return 'dead';
    if (npc.bucket === 'archived') return 'archived';
    if (npc.present) return 'scene';
    if (npc.worldActive) return 'active';
    return 'away';
}

function isPast(npc) { return npc.bucket === 'dead' || npc.bucket === 'archived'; }

function idHash(text) {
    let hash = 0x811c9dc5;
    for (const char of String(text)) {
        hash ^= char.codePointAt(0);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash;
}

// People from the same home base sit side by side; inside a group the order comes from the id, so
// a node keeps its place while values change.
export function mapAngles(npcs = []) {
    const groupOf = npc => plain(npc.homeBase).toLocaleLowerCase();
    const ordered = [...npcs].sort((a, b) => {
        const ga = groupOf(a), gb = groupOf(b);
        if (ga !== gb) return !ga ? 1 : (!gb ? -1 : ga.localeCompare(gb));
        return idHash(a.id) - idHash(b.id) || String(a.id).localeCompare(String(b.id));
    });
    const step = 360 / Math.max(1, ordered.length);
    return new Map(ordered.map((npc, index) => [npc.id, -90 + (index + 0.5) * step]));
}

// In-chat and active NPCs are always shown; the rest are the strongest by the current lens, up to
// the cap. Past NPCs only join when asked for. The selected dossier is always on the map.
export function selectMapNpcs(npcs = [], { lens = 'warmth', showPast = false, cap = DESKTOP_NODE_CAP, selectedId = '' } = {}) {
    const eligible = npcs.filter(npc => npc?.id && (showPast || !isPast(npc) || npc.id === selectedId));
    const always = eligible.filter(npc => !isPast(npc) && (npc.present || npc.worldActive));
    const rest = eligible.filter(npc => !always.includes(npc))
        .sort((a, b) => Math.abs(lensValue(b.relationship, lens)) - Math.abs(lensValue(a.relationship, lens))
            || String(a.name).localeCompare(String(b.name)));
    const shown = [...always, ...rest.slice(0, Math.max(0, cap - always.length))];
    const selected = eligible.find(npc => npc.id === selectedId);
    if (selected && !shown.includes(selected)) shown.push(selected);
    return { shown, total: eligible.length };
}

// Important Bonds between NPCs on the map. Unresolved or off-map counterparts draw nothing.
export function resolveMapBonds(npcs = [], shownIds = new Set()) {
    const bonds = new Map();
    for (const npc of npcs) {
        if (!shownIds.has(npc.id)) continue;
        for (const entry of Array.isArray(npc.keyRelationships) ? npc.keyRelationships : []) {
            const parsed = parseKeyRelationshipEntry(entry);
            const other = parsed ? resolveNpcReference(npcs, parsed.subject) : null;
            if (!other || other.id === npc.id || !shownIds.has(other.id)) continue;
            const key = [npc.id, other.id].sort().join('|');
            const bond = bonds.get(key) || { a: [npc.id, other.id].sort()[0], b: [npc.id, other.id].sort()[1], relation: {} };
            bond.relation[npc.id] = parsed.relation;
            bonds.set(key, bond);
        }
    }
    return [...bonds.values()];
}

// The gold badge shows only a change recorded on the current turn that moved the current lens.
export function relationshipDelta(change = {}, lens = 'warmth', turn = null) {
    if (!change || change.turn === null || change.turn === undefined || Number(change.turn) !== Number(turn)) return 0;
    const delta = change.delta && typeof change.delta === 'object' ? change.delta : {};
    if (lens === 'warmth') return Math.round((score(delta.trust) + score(delta.affection)) / 2);
    return score(delta[lens]);
}

function point(value, angle) {
    const r = mapRadius(value);
    const theta = angle * Math.PI / 180;
    return { x: MAP_CENTER + r * Math.cos(theta), y: MAP_CENTER + r * Math.sin(theta) };
}

function shortName(name) {
    const words = plain(name).replace(/^(?:the|capt\.?|captain|sir|lady|lord|sister|brother|old)\s+/i, '').split(/\s+/);
    return words[0] || plain(name);
}

export function buildMapModel(projection = {}, { selectedId = '', lens = 'warmth', showPast = false, allBonds = true, cap = DESKTOP_NODE_CAP } = {}) {
    const npcs = Array.isArray(projection?.npcs) ? projection.npcs.filter(npc => npc?.id) : [];
    const turn = Number.isFinite(Number(projection?.turn)) ? Number(projection.turn) : 0;
    const { shown, total } = selectMapNpcs(npcs, { lens, showPast, cap, selectedId });
    const angles = mapAngles(shown);
    const positions = new Map(shown.map(npc => [npc.id, point(lensValue(npc.relationship, lens), angles.get(npc.id))]));
    const selected = shown.find(npc => npc.id === selectedId) || null;
    const nodes = shown.map(npc => {
        const at = positions.get(npc.id);
        const status = mapStatus(npc);
        return {
            id: npc.id,
            name: `${status === 'dead' ? '† ' : ''}${npc.name}`,
            short: `${status === 'dead' ? '† ' : ''}${shortName(npc.name)}`,
            initial: (shortName(npc.name).charAt(0) || '?').toLocaleUpperCase(),
            portrait: plain(npc.portrait),
            status,
            value: lensValue(npc.relationship, lens),
            delta: relationshipDelta(npc.lastRelationshipChange, lens, turn),
            selected: npc.id === selectedId,
            x: (at.x / MAP_SPAN) * 100,
            y: (at.y / MAP_SPAN) * 100,
        };
    });
    const lines = resolveMapBonds(npcs, new Set(positions.keys()))
        .map(bond => ({ ...bond, touches: bond.a === selectedId || bond.b === selectedId }))
        .filter(bond => bond.touches || allBonds)
        .map(bond => ({ touches: bond.touches, from: positions.get(bond.a), to: positions.get(bond.b) }));
    const change = selected?.lastRelationshipChange || {};
    return {
        turn,
        lens,
        nodes,
        lines,
        shownCount: shown.length,
        total,
        allZero: shown.length > 0 && nodes.every(node => node.value === 0),
        selected: selected ? {
            id: selected.id,
            name: selected.name,
            axes: AXES.map(([key, label]) => ({
                key,
                label,
                value: score(selected.relationship?.[key]),
                delta: change.turn !== null && Number(change.turn) === turn ? score(change.delta?.[key]) : 0,
                on: lens === key || (lens === 'warmth' && (key === 'trust' || key === 'affection')),
            })),
            lastTurn: change.turn === null || change.turn === undefined ? '' : `T${change.turn}`,
            lastReason: plain(change.reason),
        } : null,
    };
}
