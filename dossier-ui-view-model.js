/* NPC State Delta dossier surface: the phase-1 board's view model (data only, no HTML) and the bond-tone / library-ring helpers. The section screens read the projection directly. */
import { changeStamp, plain, RELATIONSHIP_AXES, relationshipValue, stringList } from './dossier-ui-model.js';
import { parseKeyRelationshipEntry } from './social-bonds.js';
import { socialRelationFamily } from './social-relations.js';

// Tile titles for the two sections the board names. The label "{{user}}" is kept literal here; the renderer substitutes the player's name.
const SECTION_TITLES = Object.freeze({
    now: 'Right now',
    with: 'With {{user}}',
    ties: 'Ties',
    past: 'Past',
    secrets: 'Secrets',
});

const EVENT_TIERS = Object.freeze(['ordinary', 'meaningful', 'major', 'extreme']);

function object(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// The four axes for the dial. `value` is the clamped −100..100 meter; `fraction` maps it to 0..1 for the arc.
export function dialAxesModel(relationship) {
    const rel = object(relationship);
    return RELATIONSHIP_AXES.map(([axis, label]) => {
        const value = relationshipValue(rel[axis]);
        return { axis, label, value, fraction: (value + 100) / 200 };
    });
}

// The stored event details of the latest change (tier, held, note, ask, date), or null when there are none.
function eventModel(event) {
    const source = object(event);
    if (!EVENT_TIERS.includes(source.tier)) return null;
    const ask = RELATIONSHIP_AXES
        .map(([axis, label]) => ({ axis, label, value: Math.round(Number(object(source.ask)[axis]) || 0) }))
        .filter(item => item.value !== 0);
    return {
        tier: source.tier,
        held: source.held === true,
        note: plain(source.note),
        ask,
        date: plain(source.date),
    };
}

// The change the With {{user}} card shows: the four axis moves of the latest reply, its reason and its stamp.
function changeModel(change) {
    const source = object(change);
    const delta = RELATIONSHIP_AXES.map(([axis, label]) => ({ axis, label, value: Math.round(Number(object(source.delta)[axis]) || 0) }));
    const moved = delta.filter(item => item.value !== 0);
    const stamp = changeStamp({ turn: source.turn, message: source.message });
    const event = eventModel(source.event);
    return {
        impact: plain(source.impact, 'none').toLocaleLowerCase(),
        moved,
        reason: plain(source.reason),
        when: stamp.label,
        mark: stamp.mark,
        legacy: stamp.legacy,
        hosted: source.hosted === true,
        event,
        hasChange: moved.length > 0 || Boolean(plain(source.reason)) || event !== null,
    };
}

function rightNowModel(npc) {
    const cast = object(npc.cast);
    const key = object(npc.key);
    const place = plain(npc.location) || plain(cast.where);
    const doing = plain(cast.doing);
    return {
        mood: plain(npc.mood),
        place,
        doing,
        summary: doing || place,
        goal: plain(npc.goal) || plain(cast.goal),
        condition: plain(npc.status),
        homeBase: plain(npc.homeBase),
        inChat: npc.present === true,
        away: key.away ?? null,
        lastHeard: cast.lastHeard ? { text: plain(cast.lastHeard.text), on: plain(cast.lastHeard.on) } : null,
    };
}

function tiesModel(npc) {
    const entries = stringList(npc.keyRelationships, 12).map(text => {
        const parsed = parseKeyRelationshipEntry(text);
        return {
            text,
            name: parsed?.subject ?? text,
            relation: parsed?.relation ?? '',
            dynamic: parsed?.dynamic ?? '',
        };
    });
    return { count: entries.length, names: entries.slice(0, 3).map(entry => entry.name), entries };
}

function pastModel(npc) {
    const memories = stringList(npc.memories, 8);
    return {
        count: memories.length,
        latest: memories.length ? memories[memories.length - 1] : '',
        memories,
        background: plain(npc.background),
    };
}

function secretsModel(npc) {
    const notes = Array.isArray(object(npc.v2Meters).secrets) ? npc.v2Meters.secrets : [];
    const open = notes.filter(note => note?.state === 'open').length;
    const hidden = notes.filter(note => note?.state === 'hidden');
    return {
        present: notes.length > 0,
        total: notes.length,
        open,
        hidden: hidden.length,
        next: hidden.length ? plain(hidden[0].opens) || null : null,
        notes,
    };
}

// The board: the dial's four arcs, name and status, and one tile per section. Pull is null until its data exists (phase 2).
export function boardModel(npc = {}) {
    const source = object(npc);
    const key = object(source.key);
    const last = changeModel(source.lastRelationshipChange);
    const ties = tiesModel(source);
    const past = pastModel(source);
    const secrets = secretsModel(source);
    return {
        id: plain(source.id),
        name: plain(source.name, 'Unnamed NPC'),
        status: plain(source.statusLabel),
        role: plain(source.role),
        species: plain(source.species),
        gender: plain(source.gender),
        isKey: Boolean(source.key),
        keyHere: key.here === true,
        dial: dialAxesModel(source.relationship),
        tiles: {
            lastChange: { title: SECTION_TITLES.with, heading: 'Last change', hasChange: last.hasChange, moved: last.moved, reason: last.reason, when: last.when },
            mood: { title: 'Mood', text: plain(source.mood) },
            pull: null,
            rightNow: { title: SECTION_TITLES.now, summary: rightNowModel(source).summary },
            ties: { title: 'Ties', count: ties.count, names: ties.names },
            past: { title: 'Past', count: past.count, latest: past.latest },
            secrets: { title: 'Secrets', total: secrets.total, open: secrets.open, next: secrets.next },
        },
    };
}

// Bond tone of a relation word: green kin, partner, friend, mentor, student, guardian, ward; red rival, enemy;
// gold owes / debt / duty; grey otherwise. A small local fallback: switch to dossier-ui-bond-tone.js after merge.
const GREEN_FAMILIES = new Set(['child', 'parent', 'sibling', 'partner', 'friend', 'mentor', 'student', 'guardian', 'ward', 'cousin', 'aunt-uncle', 'niece-nephew', 'grandparent', 'grandchild', 'parent-in-law', 'child-in-law', 'sibling-in-law']);
export function bondTone(relation) {
    const word = plain(relation).toLowerCase();
    if (!word) return 'grey';
    const family = socialRelationFamily(word);
    if (family === 'rival' || /\b(?:enem\w*|foes?|nemesis|hates?|hated)\b/.test(word)) return 'bad';
    if (/\b(?:owes?|owed|debts?|duty|oath|sworn|indebted)\b/.test(word)) return 'gold';
    return GREEN_FAMILIES.has(family) ? 'good' : 'grey';
}

// The library face ring from how the person stands with the player: 'ally' (green), 'rival' (red) or '' (plain).
// The gold "owed" ring has no data behind it yet, so it is not drawn.
export function libraryTone(relationship) {
    const rel = object(relationship);
    const trust = relationshipValue(rel.trust);
    const affection = relationshipValue(rel.affection);
    const tension = relationshipValue(rel.tension);
    if (trust <= -20 || (tension >= 50 && trust < 20)) return 'rival';
    if (trust >= 20 || affection >= 20) return 'ally';
    return '';
}
