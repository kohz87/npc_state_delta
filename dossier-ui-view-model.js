/* NPC State Delta dossier surface: the phase-1 board's view model (data only, no HTML) and the bond-tone / library-ring helpers. The section screens read the projection directly. */
import { changeStamp, plain, RELATIONSHIP_AXES, relationshipValue, stringList, wholeNumber } from './dossier-ui-model.js';
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
        why: plain(source.why),
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

// Mood: the word (the scanner's own, which the numbers follow; the table word of the numbers when it wrote none), and Feeling / Energy / Control each as a row (value on the stored -3..+3 scale, and what it moved by in the reply on show), always
// (all three mood fields are kept). The meters' mood gives the word, the numbers and the history of moves; a person with none yet shows the scanner's
// word (or the resting word) with the three rows at 0. `reply`: the reply on show (a move recorded at it is "this reply"). `bars` and `max` keep the
// step form (0..6, the middle neutral) the plain-words line reads.
export const MOOD_AXES = Object.freeze([['v', 'Feeling', 'feel'], ['a', 'Energy', 'energy'], ['d', 'Control', 'control']]);
export function moodTile(npc, reply = null) {
    const mood = object(npc.v2Meters).mood;
    const now = wholeNumber(reply);
    if (mood) {
        const log = Array.isArray(mood.log) ? mood.log : [];
        const latest = now !== null && log[0] && wholeNumber(log[0].n) === now ? log[0] : null;
        const rows = MOOD_AXES.map(([key, label, tone]) => ({ key, label, tone, value: Math.round(Number(object(mood.axes)[key]) || 0), change: latest ? Math.round(Number(latest[key]) || 0) : 0 }));
        return { title: 'Mood', text: plain(npc.mood) || mood.word, feeling: mood.feeling, energy: mood.energy, control: mood.control, max: mood.max, cause: mood.cause, rows, log, known: true, quiet: now !== null && !latest };
    }
    const rest = moodBars(null);
    return { title: 'Mood', text: plain(npc.mood) || moodWord(null), feeling: rest.max / 2, energy: rest.energy, control: rest.control, max: rest.max, rows: MOOD_AXES.map(([key, label, tone]) => ({ key, label, tone, value: 0, change: 0 })), log: [], known: false, quiet: false };
}

// The few plain words under the mood word, from the three bars (a step 0..max, the middle is neutral): only a bar well off the
// middle (two steps or more, the code's band edge) speaks: unpleasant / pleasant, slack / keyed-up, cornered / in control.
export function moodDescriptors(mood) {
    if (!mood?.max) return [];
    const mid = mood.max / 2;
    const word = (value, low, high) => (value <= mid - 2 ? low : (value >= mid + 2 ? high : ''));
    return [word(mood.feeling, 'unpleasant', 'pleasant'), word(mood.energy, 'slack', 'keyed-up'), word(mood.control, 'cornered', 'in control')].filter(Boolean);
}

// "Her", "His" or "Their" (lower-case for a sentence) from the gender the dossier holds.
export function possessiveWord(gender = '', { lower = false } = {}) {
    const text = plain(gender).toLocaleLowerCase();
    const word = /^(?:f|she)|\b(?:female|woman|girl)\b/.test(text) ? 'Her' : (/^(?:m$|male|he\b)|\b(?:man|boy)\b/.test(text) ? 'His' : 'Their');
    return lower ? word.toLocaleLowerCase() : word;
}

// The gate's receipt ("via praise · 3rd in 2 days · backfired", built by npc-meters-gate.js and kept as it is) in the words the mockup uses:
// the board tile reads "praise, the 3rd time in 2 days, backfired", the Recent changes row "via praise: the 3rd time in 2 days, so it backfired".
// Text that does not parse is returned as it came.
const GATE_VERB = { backfired: 'it backfired', less: 'it landed less', suspicion: 'it read as pressure' };
export function gateWords(text, { row = false } = {}) {
    const match = /^via (.+?)(?: · (\d+(?:st|nd|rd|th)) in (\d+) (days?))? · (backfired|less|suspicion)$/.exec(plain(text));
    if (!match) return plain(text);
    const [, via, nth, span, unit, mode] = match;
    const times = nth ? `the ${nth} time in ${span} ${unit}` : '';
    if (row) return `via ${via}${times ? `: ${times}, so ${GATE_VERB[mode]}` : `: ${GATE_VERB[mode]}`}`;
    return [via, times, mode].filter(Boolean).join(', ');
}

// Pull: the instinct word with a strength ring and "high · 2 days". Null (no tile) without one.
const PULL_WORDS = ['Belonging', 'Closure', 'Awe'];
export const pullWord = kind => PULL_WORDS.find(word => word.toLowerCase() === kind) || '';
const STRENGTH = ['', 'low', 'medium', 'high'];
export function pullTile(npc) {
    const pull = object(npc.v2Meters).pull;
    if (!pull) return null;
    const days = pull.days === 1 ? '1 day' : `${pull.days} days`;
    return { title: 'Pull', text: pullWord(pull.kind), level: pull.level, note: `${[STRENGTH[pull.level], days].filter(Boolean).join(' · ')}`, cause: pull.cause, fresh: pull.days === 0 };
}

// The board: the dial's four arcs, name and status, and one tile per section. Pull is null until its data exists (phase 2).
export function boardModel(npc = {}, { reply = null } = {}) {
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
            mood: moodTile(source, reply),
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
