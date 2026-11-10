// The living cast (1 Nov, the user's decision): a pack lists a hand-written cast, Story Director owns who has been met and
// where everyone is, and Delta READS `director.cast` (and Story Block's `packs.portrait`) and never writes to either.
// At the first meeting Delta makes the person's dossier at once from the pack entry: no scan, no model call. This file
// holds every rule (pure: no DOM, no host, no clock); index.js and src/storysuite-v2.js call it, src/npc-meters.js
// records the meeting in the saved `npc` slice.
//
// The query: `director.cast` → [{ key ("pack:id"), pack, id, name, aliases, met: { on, where } | null, where?, doing?,
// lastHeard? (words, or { text, on }), alive, entry? }]. `entry` (the full pack entry) comes ONLY for met people: an unmet
// person is never more than a count to anyone but Story Director. `met.on`, `lastHeard.on` are story minutes (null when
// unknown); `dateText` (minutes → "Gw 12") writes them on Story Director's calendar, words are kept as given.
//
// The pack entry: { id, name, aliases?, about, look, wears?, voice?, personality?, history?, portrait? (file name),
// behaviour?[] ("Lever: level - effect"), mannerisms?[], withYou?, start: { place, goal, routine? }, drawnTo?[], meters?: { preset?, <meter>: n }, stages?[] ({ id, name, needs: [{ meter, at }], milestone }), fields?{}, secrets?[]
// ({ title, text, meter + at | when }), canDieUnmet? }.
//
//   about → role, look → overallAppearance (the body: what lasts), wears → appearance (what they usually wear and carry: the current
//   look; an older pack without `wears` mixed body and outfit in `look`: it still goes to overallAppearance, whole, and the current
//   appearance stays empty for the scanner to fill from the story, so a later scan never merges its own physical text into outfit
//   words or the other way round), voice → speech, personality, history → background, behaviour → behaviorProfile (levers in Delta's
//   own form, up to 6; a lever Delta's rules would drop or merge is skipped), mannerisms → mannerisms (up to 4), withYou → the
//   relationship summary (read up to 400, then compacted to 320 and calibrated like any summary: the pack's words are not kept whole), start.place → home base,
//   start.goal → goal, the place they were met → location, fields → custom fields, meters (built-in four → the dossier's
//   relationship numbers; any meter's value is also the first value in the saved slice, see src/npc-meters.js
//   observeCast), meters.preset → the dossier's meter track, stages → the person's own stage ladder (castFrom.stages),
//   secrets → the hidden notes (castSecrets, the one place that shapes them), portrait → the dossier's portrait.
//
// A dossier made while the pack's picture was missing (a pack imported without its pictures) is given the picture later, once Story
// Block answers `packs.portrait` for the entry's `portrait` (index.js castSync): only a cast dossier whose portrait is empty and was
// not removed on purpose (`castFrom.portraitRemoved`), never a picture the reader set or generated. castPortraitWanted says which.
//
// A dossier made here carries `castFrom` (where it came from: the key, the pack and its name and version, when and where
// they were met, the starting goal and routine as the pack gave them). Delta's later scans treat the dossier as any other:
// they add and change as they do for anyone, and every change is marked in the dossier as today.

import { portraitHasImage } from './portrait-file.js';
import { isBehaviorLever, normalizeBehaviorProfile } from '../core-behavior.js';
import { normalizeMannerisms } from '../core-durable.js';
import { DURABLE_PROFILE_LIMITS } from '../core-relationship.js';
import { normalizeAge, normalizeApparentAge, normalizeGender } from '../core-identity.js';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clip = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();

/** The most people one answer is read for. */
export const CAST_MAX = 200;
export const KEY_MAX = 120;
export const NAME_MAX = 120;
export const ALIASES_MAX = 8;
export const TEXT_MAX = 1800;
export const FIELD_NAME_MAX = 60;
export const FIELD_VALUE_MAX = 300;
export const FIELDS_MAX = 12;
export const STAGES_MAX = 8;
export const SECRETS_MAX = 8;
/** How many behaviour levers, mannerisms and characters of "with you" a pack entry may give (Delta's own limits: 6 levers, 4 mannerisms; 400 is wider than the stored 320). */
export const BEHAVIOUR_MAX = 6;
export const MANNERISMS_MAX = 4;
export const WITH_YOU_MAX = 400;
export const DATE_MAX = 40;
/** A cast key: "pack:id" (letters, digits and . _ : -). */
export const CAST_KEY = /^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,119}$/u;

/** A name as a comparison key: letters and digits only, lowercase (the same reading as Delta's own name match). */
export function labelKey(value) {
    return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const dateOf = (value, dateText) => {
    if (Number.isSafeInteger(value)) {
        let text = '';
        try { text = typeof dateText === 'function' ? clip(dateText(value), DATE_MAX) : ''; } catch { text = ''; }
        return text;
    }
    return typeof value === 'string' ? clip(value, DATE_MAX) : '';
};

const wholeNumber = value => {
    const number = Number(value);
    return value !== null && value !== '' && Number.isFinite(number) ? Math.round(number) : null;
};

// ---- the pack entry, cleaned ----

function normalizeFields(raw) {
    const entries = Array.isArray(raw) ? raw.map(item => [item?.name ?? item?.field, item?.value]) : Object.entries(isObject(raw) ? raw : {});
    const out = {};
    for (const [key, value] of entries) {
        const name = clip(key, FIELD_NAME_MAX);
        const text = clip(typeof value === 'number' ? String(value) : value, FIELD_VALUE_MAX);
        if (!name || !text || Object.keys(out).some(other => other.toLowerCase() === name.toLowerCase())) continue;
        out[name] = text;
        if (Object.keys(out).length >= FIELDS_MAX) break;
    }
    return out;
}

// A stage row in the pack's meterPresets shape, { id, name, needs: [{ meter, at }], milestone }: the needs are met by the meters alone
// and `milestone` is the line the story is told when the stage is first reached (a rung's `cue`, never a milestone it needs). A
// text `needs` ("trust 40, loyalty 50") and a { meter, at, name } threshold are read too.
function normalizeStages(raw) {
    const out = [];
    for (const row of Array.isArray(raw) ? raw : []) {
        if (!isObject(row) || out.length >= STAGES_MAX) continue;
        const name = clip(row.name, 40);
        let needs = row.needs ?? row.need;
        if ((needs === undefined || needs === null) && row.meter !== undefined && wholeNumber(row.at) !== null) needs = [{ meter: row.meter, at: wholeNumber(row.at) }];
        if (!name || needs === undefined || needs === null) continue;
        if (!Array.isArray(needs) && !isObject(needs)) needs = clip(needs, 120);
        const cue = clip(row.cue ?? row.milestone, 200);
        out.push({ name, needs: JSON.parse(JSON.stringify(needs)), ...(cue ? { cue } : {}) });
    }
    return out;
}

function normalizeMeters(raw) {
    if (!isObject(raw)) return { preset: '', values: {} };
    const values = {};
    let preset = '';
    for (const [name, value] of Object.entries(raw).slice(0, 40)) {
        const id = clip(name, 40);
        if (!id || ['__proto__', 'constructor', 'prototype'].includes(id)) continue;
        if (id === 'preset') { preset = clip(value, 80); continue; }
        const number = wholeNumber(value);
        if (number !== null) values[id] = Math.max(-1000, Math.min(1000, number));
    }
    return { preset, values };
}

/**
 * The hidden notes of a pack entry as the dossier keeps them: [{ title?, text, meter?, at?, when? }], at most eight. A note opens on
 * a meter value (`meter` + `at`), on a story event (`when`, words, up to 120 characters), or both. The note ids are made by the
 * hidden-notes code (src/npc-meters.js normalizeSecrets) wherever the notes are read, from the rule and text only.
 */
export function castSecrets(raw) {
    const out = [];
    for (const item of Array.isArray(raw) ? raw : []) {
        if (!isObject(item) || out.length >= SECRETS_MAX) continue;
        const text = clip(item.text, 300);
        if (!text) continue;
        const title = clip(item.title, 60);
        const meter = clip(item.meter, 40).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
        const at = wholeNumber(item.at);
        const when = clip(item.when, 120);
        const byMeter = Boolean(meter) && at !== null;
        if (!byMeter && !when) continue;
        out.push({ ...(title ? { title } : {}), text, ...(byMeter ? { meter, at } : {}), ...(when ? { when } : {}), from: 'pack' });
    }
    return out;
}

const sameList = (a, b) => a.length === b.length && a.every((item, index) => item === b[index]);
const LEVER_LINE = /^([^:]{1,40}?)\s*:\s*(low|medium|high)\b\s*[-\u2013\u2014]\s*(\S.*)$/i;

/**
 * The pack's behaviour levers as the dossier stores them: ["Label: level - effect"], at most six. Each item is written in Delta's own
 * form (level low|medium|high) and kept only if Delta's lever rules would keep it as it stands: a recognised lever label, not
 * about the player or one named person (that is "with you"), and not merged into another lever of the same kind. Anything else
 * is skipped, so the stored list is exactly what Delta's normalizer gives back (nothing is changed after the first meeting).
 */
export function castBehaviour(raw) {
    const out = [];
    for (const item of (Array.isArray(raw) ? raw : []).slice(0, BEHAVIOUR_MAX * 4)) {
        if (out.length >= BEHAVIOUR_MAX) break;
        const match = typeof item === 'string' ? LEVER_LINE.exec(clip(item, 400)) : null;
        if (!match) continue;
        const line = clip(`${match[1].trim()}: ${match[2].toLowerCase()} - ${match[3]}`, DURABLE_PROFILE_LIMITS.behaviorProfile);
        const next = [...out, line];
        if (!isBehaviorLever(line) || !sameList(normalizeBehaviorProfile(next), next)) continue;
        out.push(line);
    }
    return out;
}

/** The pack's mannerisms: at most four short habits (160 characters each), kept only when Delta's mannerism rules keep them as they stand (a near-repeat of an earlier one is skipped). */
export function castMannerisms(raw) {
    const out = [];
    for (const item of (Array.isArray(raw) ? raw : []).slice(0, MANNERISMS_MAX * 4)) {
        if (out.length >= MANNERISMS_MAX) break;
        const line = typeof item === 'string' ? clip(item, DURABLE_PROFILE_LIMITS.mannerism) : '';
        const next = [...out, line];
        if (line && sameList(normalizeMannerisms(next), next)) out.push(line);
    }
    return out;
}

/** The pack entry, cleaned (texts cut and flattened, lists bounded), or null without a usable name. */
export function normalizeEntry(raw) {
    if (!isObject(raw)) return null;
    const name = clip(raw.name, NAME_MAX);
    if (!name) return null;
    const start = isObject(raw.start) ? raw.start : {};
    const meters = normalizeMeters(raw.meters);
    return {
        id: clip(raw.id, 80),
        name,
        aliases: (Array.isArray(raw.aliases) ? raw.aliases : []).map(alias => clip(alias, NAME_MAX)).filter(alias => alias && labelKey(alias) !== labelKey(name)).slice(0, ALIASES_MAX),
        about: clip(raw.about, 300),
        look: clip(raw.look, TEXT_MAX),
        wears: clip(raw.wears, TEXT_MAX),
        voice: clip(raw.voice, 600),
        personality: clip(raw.personality, 900),
        history: clip(raw.history, 1200),
        behaviour: castBehaviour(raw.behaviour),
        mannerisms: castMannerisms(raw.mannerisms),
        withYou: clip(raw.withYou, WITH_YOU_MAX),
        portrait: clip(raw.portrait, 120),
        start: { place: clip(start.place, 300), goal: clip(start.goal, 500), routine: clip(start.routine, 300) },
        drawnTo: (Array.isArray(raw.drawnTo) ? raw.drawnTo : []).map(item => clip(item, 120)).filter(Boolean).slice(0, 8),
        meters,
        stages: normalizeStages(raw.stages),
        fields: normalizeFields(raw.fields),
        secrets: castSecrets(raw.secrets),
        packVersion: clip(raw.packVersion, 40),
    };
}

// ---- Story Director's answer, cleaned ----

function normalizeLastHeard(raw, dateText) {
    if (typeof raw === 'string') {
        const text = clip(raw, 300);
        return text ? { text, on: '' } : null;
    }
    if (!isObject(raw)) return null;
    const text = clip(raw.text ?? raw.doing ?? raw.line, 300);
    return text ? { text, on: dateOf(raw.on ?? raw.date, dateText) } : null;
}

/**
 * Story Director's answer as a clean list: [{ key, pack, id, name, aliases, met: { on, where } | null, where, doing,
 * lastHeard: { text, on } | null, alive, entry: <normalizeEntry> | null }], at most 200 people, one per key. The entry is kept only
 * for a met person. Anything that is not an array gives [] (the adapter tells "no answer" apart: null).
 */
export function normalizeCast(answer, dateText = null) {
    if (!Array.isArray(answer)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of answer.slice(0, CAST_MAX)) {
        if (!isObject(raw)) continue;
        const pack = clip(raw.pack, 80);
        const id = clip(raw.id, 80);
        const key = clip(raw.key || (pack && id ? `${pack}:${id}` : ''), KEY_MAX);
        const name = clip(raw.name, NAME_MAX);
        if (!CAST_KEY.test(key) || !name || seen.has(key)) continue;
        seen.add(key);
        const met = isObject(raw.met) ? { on: dateOf(raw.met.on, dateText), where: clip(raw.met.where, 200), at: Number.isSafeInteger(raw.met.on) ? raw.met.on : null } : null;
        const entry = met && isObject(raw.entry) ? normalizeEntry({ ...raw.entry, packVersion: raw.entry.packVersion ?? raw.packVersion }) : null;
        out.push(Object.freeze({
            key, pack, id, name,
            aliases: (Array.isArray(raw.aliases) ? raw.aliases : []).map(alias => clip(alias, NAME_MAX)).filter(Boolean).slice(0, ALIASES_MAX),
            met,
            where: clip(raw.where, 200),
            doing: clip(raw.doing, 300),
            lastHeard: met ? normalizeLastHeard(raw.lastHeard, dateText) : null,
            alive: raw.alive !== false,
            entry,
        }));
    }
    return out;
}

/** The met people whose entry came with the answer (the only ones a dossier can be made from). */
export const metWithEntry = list => (Array.isArray(list) ? list : []).filter(person => person?.met && person.entry);

/** The person of `list` with this cast key, or null. */
export const findCastPerson = (list, key) => (Array.isArray(list) ? list : []).find(person => person?.key === key) ?? null;

// ---- the dossier ----

/** Whether a dossier already stands for this person: one made from this key, or one that answers to their name or an alias. */
export function dossierFor(npcs, person) {
    if (!person) return null;
    const mine = [person.name, person.entry?.name, ...(person.aliases ?? []), ...(person.entry?.aliases ?? [])].map(labelKey).filter(Boolean);
    for (const npc of Array.isArray(npcs) ? npcs : []) {
        if (npc?.castFrom?.key === person.key) return npc;
    }
    for (const npc of Array.isArray(npcs) ? npcs : []) {
        const theirs = [npc?.name, ...(Array.isArray(npc?.aliases) ? npc.aliases : [])].map(labelKey).filter(Boolean);
        if (theirs.some(label => mine.includes(label))) return npc;
    }
    return null;
}

/** A pack's name as the badge says it: "Ersveil (open world)" → "Ersveil" (a bracketed note or a subtitle after a dash or colon is left off). */
export function shortPackName(name) {
    const text = clip(name, 80).replace(/\s*[([{][^)\]}]*[)\]}]/g, ' ').split(/\s+[-–—]\s+|:\s/)[0];
    return clip(text, 40);
}

const PEOPLE_LOOKS = /\s*\(?\blooks?\s+(?:(?:about|around|approx\.?|approximately)\s+)?(\d{1,3})\)?\s*$/i;
const PEOPLE_AGE = /^(?:formed\s+)?(?:(about|around|approx\.?|approximately)\s+)?(\d{1,3})(?:\s*(?:years?|yrs?)(?:\s+(?:old|ago))?)?$/i;
const PEOPLE_HEAD = /^(\p{L}[\p{L}'-]*(?:\s+\p{L}[\p{L}'-]*){0,2}?)(?:\s+(woman|man|female|male))?$/iu;

/**
 * A pack's `People` field ("Dogfolk woman, 21", "Dwelf, 58 (looks about 25)", "Elf, about 240 (looks about 35)", "Fairy, about 160",
 * "Spiritfolk, formed about 300 years ago (looks about 30)") read as { species, gender, age, apparentAge } (each '' when absent), in the
 * shapes the dossier stores them (core-identity: gender male|female, age "21" or "about 240", apparent age "~25"). Gender only from
 * woman/man/female/male, never inferred. Text that does not fit whole gives all empty: nothing is guessed.
 */
export function parsePeople(raw) {
    const none = { species: '', gender: '', age: '', apparentAge: '' };
    let text = clip(raw, FIELD_VALUE_MAX);
    let looks = '';
    const seen = PEOPLE_LOOKS.exec(text);
    if (seen) { looks = seen[1]; text = text.slice(0, seen.index).trim(); }
    const [headText, ...rest] = text.split(',');
    const head = PEOPLE_HEAD.exec(headText.trim());
    if (!head) return none;
    let age = '';
    if (rest.length) {
        const match = PEOPLE_AGE.exec(rest.join(',').trim());
        if (!match) return none;
        age = normalizeAge(`${match[1] ? 'about ' : ''}${match[2]}`);
    }
    const species = clip(head[1], 160);
    if (!species || (!age && !looks && !head[2])) return none;
    return { species, gender: normalizeGender(head[2]), age, apparentAge: looks ? normalizeApparentAge(`about ${looks}`) : '' };
}

const BUILT_IN_METERS = Object.freeze(['trust', 'affection', 'desire', 'tension']);

/**
 * The record `base` (a fresh dossier from createNpcRecord) filled from the person's entry: the profile, the starting
 * numbers, the hidden notes and `castFrom`. `packName` is the pack's name for the badge; `portrait` is the portrait record
 * ({ path, type, hash, … } or, when the file could not be written, { dataUrl, … }) or null. Returns a new record; null without an entry.
 */
export function applyCastEntry(base, person, { packName = '', portrait = null } = {}) {
    const entry = person?.entry;
    if (!isObject(base) || !entry) return null;
    const npc = { ...base };
    npc.aliases = entry.aliases.filter(alias => labelKey(alias) !== labelKey(npc.name)).slice(0, ALIASES_MAX);
    if (entry.about) npc.role = entry.about;
    if (entry.look) npc.overallAppearance = entry.look;
    if (entry.wears) npc.appearance = entry.wears;
    if (entry.voice) npc.speech = entry.voice;
    if (entry.personality) npc.personality = entry.personality;
    if (entry.history) npc.background = entry.history;
    if (entry.behaviour?.length) npc.behaviorProfile = [...entry.behaviour];
    if (entry.mannerisms?.length) npc.mannerisms = [...entry.mannerisms];
    if (entry.withYou) npc.relationshipSummary = entry.withYou;
    if (entry.start.place) npc.homeBase = entry.start.place;
    if (entry.start.goal) npc.goal = entry.start.goal;
    if (person.met?.where) npc.location = person.met.where;
    if (Object.keys(entry.fields).length) npc.customFields = { ...entry.fields };
    const relationship = { ...(isObject(base.relationship) ? base.relationship : {}) };
    for (const meter of BUILT_IN_METERS) if (Number.isInteger(entry.meters.values[meter])) relationship[meter] = Math.max(-100, Math.min(100, entry.meters.values[meter]));
    npc.relationship = relationship;
    // The People field also fills the dossier's own species, gender and ages, only where the fresh dossier holds nothing yet.
    const people = parsePeople(entry.fields[Object.keys(entry.fields).find(name => name.toLowerCase() === 'people')]);
    for (const field of ['species', 'gender', 'age', 'apparentAge']) if (people[field] && !String(npc[field] ?? '').trim()) npc[field] = people[field];
    if (entry.meters.preset) npc.meterSetup = { track: entry.meters.preset, limits: {} };
    const secrets = castSecrets(entry.secrets);
    if (secrets.length) npc.secrets = secrets;
    if (portraitHasImage(portrait)) npc.portrait = portrait;
    npc.castFrom = {
        key: person.key, pack: person.pack, id: person.id,
        ...(shortPackName(packName) ? { packName: shortPackName(packName) } : {}),
        ...(entry.packVersion ? { packVersion: entry.packVersion } : {}),
        met: { on: person.met?.on ?? '', where: person.met?.where ?? '' },
        goal: entry.start.goal, routine: entry.start.routine,
        // The pack's own words, kept exactly while the stored field still is them (core-mechanics normalizeNpcRecord).
        first: Object.fromEntries([['overallAppearance', entry.look], ['appearance', entry.wears], ['speech', entry.voice], ['personality', entry.personality], ['background', entry.history], ['behaviorProfile', entry.behaviour], ['mannerisms', entry.mannerisms]].filter(([, words]) => (Array.isArray(words) ? words.length : words)).map(([field, words]) => [field, Array.isArray(words) ? [...words] : words])),
        ...(entry.stages.length ? { stages: entry.stages } : {}),
    };
    return npc;
}

/**
 * Whether a dossier made from the cast may be given the pack's picture now: it came from the cast, holds no portrait of its own
 * (an upload, a generated picture or the pack's own all count as its own) and the reader has not removed one on purpose
 * (`castFrom.portraitRemoved`, set when the reader removes the portrait of a cast dossier). Pure: the pack's answer is asked separately.
 */
export function castPortraitWanted(npc) {
    return isObject(npc) && isObject(npc.castFrom) && Boolean(npc.castFrom.key)
        && npc.castFrom.portraitRemoved !== true && !portraitHasImage(npc.portrait);
}

/** The dossier with the pack's portrait record set on it (a new object; the dossier unchanged without a usable record or when it may not be filled). */
export function applyCastPortrait(npc, portrait) {
    if (!castPortraitWanted(npc) || !portraitHasImage(portrait)) return npc;
    return { ...npc, portrait };
}

/** The dossier of a cast person after the reader removed its portrait: the removal is recorded in `castFrom` so the pack's picture is not put back. */
export function markCastPortraitRemoved(npc) {
    if (!isObject(npc) || !isObject(npc.castFrom) || !npc.castFrom.key) return npc;
    return { ...npc, castFrom: { ...npc.castFrom, portraitRemoved: true } };
}

/** The badge words: "Ersveil cast" (the pack's name) or "Cast". */
export const castBadge = castFrom => (castFrom?.packName ? `${castFrom.packName} cast` : 'Cast');

/**
 * What the dossier shows for a dossier made from the cast: { badge, packName, firstMet, goal, routine, lastHeard: { text, on } |
 * null, where, doing }. `person` is Story Director's answer for it (null without Story Director: then the starting words the
 * pack gave stand, and there is no "last heard"). Text only: the view draws it escaped. Null for any other dossier.
 */
export function castView(npc, person = null, { pin = false } = {}) {
    const from = npc?.castFrom;
    if (!isObject(from) || !from.key) return null;
    const start = person?.entry?.start;
    const where = from.met?.where ?? '';
    const on = from.met?.on ?? '';
    const firstMet = [on, where ? `${on ? 'at ' : ''}${where}` : ''].filter(Boolean).join(' ');
    return {
        badge: castBadge(from),
        packName: from.packName ?? '',
        firstMet,
        goal: clip(start?.goal || from.goal, 500),
        routine: clip(start?.routine || from.routine, 300),
        lastHeard: person?.lastHeard ?? null,
        where: person?.where ?? '',
        doing: person?.doing ?? '',
        pin: pin === true,
    };
}
