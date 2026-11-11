/* NPC State Delta dossier surface: the phase-1 board's view model (data only, no HTML) and the bond-tone / library-ring helpers. The section screens read the projection directly. */
import { changeStamp, plain, RELATIONSHIP_AXES, relationshipValue, stringList } from './dossier-ui-model.js';
import { parseKeyRelationshipEntry } from './social-bonds.js';
import { moodBars, moodWord } from './npc-mood.js';
import { bondTone as bondToneOf, tieTone } from './dossier-ui-bond-tone.js';

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
        gate: plain(source.gate),
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
        gate: event?.gate || '',
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

function tagTone(tags) {
    return boardTone(tieTone(tags) || 'neutral') === 'grey' ? '' : boardTone(tieTone(tags));
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
    // Tie tags (feature notes) tint a face by the bond: rival red, owes gold, ally green; else the relation word's tone.
    const tagged = new Map(object(npc.v2Meters).notes?.ties?.map(row => [String(row.name).toLowerCase(), row.tags]) ?? []);
    const faces = entries.slice(0, 3).map(entry => ({ name: entry.name, tone: tagTone(tagged.get(entry.name.toLowerCase())) || bondTone(entry.relation) }));
    const lies = object(npc.v2Meters).notes?.lies?.length ?? 0;
    return { count: entries.length, names: faces.map(face => face.name), faces, entries, lies };
}

function pastModel(npc) {
    const memories = stringList(npc.memories, 8);
    return {
        count: memories.length,
        latest: memories.length ? memories[memories.length - 1] : '',
        // One dot per remembered thing (violet); a lie told is gold and something known blue (feature notes). At most 5.
        dots: [...memories.map(() => 'mem'), ...(object(npc.v2Meters).notes?.lies ?? []).map(() => 'lie'), ...(object(npc.v2Meters).notes?.knows ?? []).map(() => 'know')].slice(0, 5),
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
        lastOpen: open ? plain(notes.filter(note => note?.state === 'open').pop().title) : '',
        notes,
    };
}

// Mood: the word with the Energy and Control bars, always (all three mood fields are kept). The meters' mood gives the word and the
// bar steps; a person with none yet shows the scanner's word (or the resting word) with both bars at the middle step.
function moodTile(npc) {
    const mood = object(npc.v2Meters).mood;
    if (mood) return { title: 'Mood', text: mood.word, energy: mood.energy, control: mood.control, max: mood.max, cause: mood.cause };
    const rest = moodBars(null);
    return { title: 'Mood', text: plain(npc.mood) || moodWord(null), energy: rest.energy, control: rest.control, max: rest.max };
}

// Pull: the instinct word with a strength ring and "high · 2 days". Null (no tile) without one.
const PULL_WORDS = ['Belonging', 'Closure', 'Awe'];
export const pullWord = kind => PULL_WORDS.find(word => word.toLowerCase() === kind) || '';
const STRENGTH = ['', 'low', 'medium', 'high'];
export function pullTile(npc) {
    const pull = object(npc.v2Meters).pull;
    if (!pull) return null;
    const days = pull.days === 1 ? '1 day' : `${pull.days} days`;
    return { title: 'Pull', text: pullWord(pull.kind), level: pull.level, note: `${[STRENGTH[pull.level], days].filter(Boolean).join(' · ')}`, cause: pull.cause };
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
            lastChange: { title: SECTION_TITLES.with, heading: 'Last change', hasChange: last.hasChange, moved: last.moved, reason: last.reason, gate: last.gate, when: last.when },
            mood: moodTile(source),
            pull: pullTile(source),
            rightNow: { title: SECTION_TITLES.now, ...(({ place, doing, summary }) => ({ place, doing, summary }))(rightNowModel(source)) },
            ties: { title: 'Ties', count: ties.count, names: ties.names, faces: ties.faces, lies: ties.lies },
            past: { title: 'Past', count: past.count, latest: past.latest, dots: past.dots },
            secrets: { title: 'Secrets', total: secrets.total, open: secrets.open, next: secrets.next, lastOpen: secrets.lastOpen },
        },
    };
}

// Bond tone of a relation word in the board's vocabulary (good / bad / gold / grey), from dossier-ui-bond-tone.js.
const BOARD_TONE = { close: 'good', hostile: 'bad', duty: 'gold', neutral: 'grey' };
export const boardTone = tone => BOARD_TONE[tone] || 'grey';
export function bondTone(relation) {
    return boardTone(bondToneOf(plain(relation)));
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
