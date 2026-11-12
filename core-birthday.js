/* NPC State Delta birthday, absence and change-marker helpers: NPC-owned sentences, absence and birthday-claim detection,
   birthday grounding and the deterministic rollover, the per-field change markers (with storyDayFromText) and the calendar
   reference and NPC projection the prompt builders use. A pure part of core.js (same owner, moved without change); core.js
   re-exports every name it exported before. Never imports core.js. */
import { effectiveChronologicalAge, normalizeBirthDate, normalizeNpcBirthday, reanchorDerivedBirthYearFromAge } from './birthday.js';
import { currentCalendarDate, extractStructuredWorldDate, getActiveCalendarConfig, hostedStoryDate, migrateLegacyStoryDay, normalizeCalendarDate, STORY_DAY_SCHEME, storyDateTextAt } from './calendar.js';
import { stampMemories } from './core-record-shared.js';
import * as mechanics from './core-mechanics.js';
import { CHANGE_TRACKED_FIELDS, DAY_TRACKED_FIELDS } from './src/fields/registry.js';
import { resolveNpcAppearance } from './appearance.js';
import { isTerminalNpcDeath } from './terminal-lifecycle.js';

// Sentences that are about this NPC: they name it as a whole word (name, alias or distinctive
// first name), plus a directly following sentence that continues with a pronoun.
export function npcOwnedSentences(npc, text) {
    const labels = [npc?.name, ...(Array.isArray(npc?.aliases) ? npc.aliases : [])].map(label => String(label || '').trim()).filter(Boolean);
    const words = [...labels, ...labels.map(label => label.split(/\s+/)[0]).filter(token => token.length >= 3)];
    const patterns = [...new Set(words)].map(word => new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu'));
    // Markup blocks (<World_State> ...) are separate statements, not part of the next sentence.
    const sentences = String(text || '').split(/(?<=[.!?])\s+|\n+|<\/?[A-Za-z_][^>]*>/).map(item => item.trim()).filter(Boolean);
    const owned = [];
    sentences.forEach((sentence, index) => {
        if (patterns.some(pattern => pattern.test(sentence))) owned.push(sentence);
        else if (index > 0 && owned.includes(sentences[index - 1])
            && /^(?:(?:then|now|later|soon|afterwards?|finally),?\s+)?(?:she|he|they|her|his|their)\b/i.test(sentence)) owned.push(sentence);
    });
    return owned;
}

// Wording that places the NPC outside the current scene ("is not here", "remains at her distant home").
const ABSENCE_WORDING = /\b(?:not (?:here|present|there|in the room|with (?:us|them|him|her))|(?:isn|wasn|aren|weren)['’]?t (?:here|present|there|around)|absent|elsewhere|far away|off[- ]?screen|remains? (?:at|in) (?:her|his|their) (?:distant |own )?(?:home|house|room|quarters)|has (?:already )?left|is (?:away|gone))\b/i;

const HISTORICAL_ABSENCE = /\b(?:ago|earlier|before|previously|until|last\s+(?:night|week)|yesterday|had been)\b/i;
const CURRENT_PARTICIPATION = /\b(?:now|returns?|returned|arrives?|arrived|comes? (?:back|in)|steps? (?:in|inside|back)|enters?|entered|joins?|joined|sits? (?:beside|with|down)|greets?|here now)\b/i;
// A return/arrival that is denied ("does not return") or still ahead ("will return tomorrow") means
// the NPC is not here now; a hypothetical one ("might return if ...") says nothing.
const RETURN_VERBS = /\b(?:returns?|arrives?|arrive|comes? (?:back|in)|come (?:back|in)|steps? (?:in|inside|back))\b/i;
const NEGATED_WORDING = /\b(?:not|never|no longer)\b|n['’]t\b/i;
const FUTURE_WORDING = /\b(?:will|tomorrow|later|soon|going to|plans? to|intends? to)\b/i;
const HYPOTHETICAL_WORDING = /\b(?:if|unless|might|may|would|could)\b/i;
const CLAUSE_BOUNDARY = /,|;|\s+(?:but|then|and then|because|while|although|though)\s+/i;
const CLAUSE_STARTERS = new Set(['the', 'then', 'she', 'he', 'they', 'her', 'his', 'their', 'it', 'today', 'tomorrow', 'yesterday',
    'on', 'in', 'at', 'when', 'after', 'before', 'as', 'if', 'but', 'and', 'so', 'now', 'later', 'this', 'that', 'there', 'here',
    'a', 'an', 'once', 'soon', 'still', 'meanwhile', 'everyone', 'nobody', 'someone']);

// A clause whose subject is a named person other than this NPC ("Noela Far is not here",
// "Noela was born in CR790", "Noela celebrates her birthday") is about that person.
function foreignSubjectClause(clause, own) {
    const lead = String(clause || '').trim().match(/^((?:\p{Lu}[\p{L}\p{M}'’-]*\s+){1,3})(?=\p{Ll})/u)?.[1];
    if (!lead) return false;
    const tokens = lead.trim().split(/\s+/).map(token => token.replace(/['’]s$/i, '').toLowerCase());
    if (CLAUSE_STARTERS.has(tokens[0])) return false;
    return !tokens.some(token => own.has(token));
}

// The NPC's latest current state in the text: another person's absence ("because Noela is not
// here") and an absence the narration then resolves ("was not here an hour ago, but now steps
// inside") do not make this NPC absent.
export function npcCurrentlyAbsentInText(npc, text) {
    const own = npcFirstLabels(npc);
    let absent = false;
    for (const sentence of npcOwnedSentences(npc, text)) {
        for (const clause of sentence.split(CLAUSE_BOUNDARY).map(part => String(part || '').trim()).filter(Boolean)) {
            if (foreignSubjectClause(clause, own)) continue;
            if (ABSENCE_WORDING.test(clause) && !HISTORICAL_ABSENCE.test(clause)) absent = true;
            else if (RETURN_VERBS.test(clause) && (NEGATED_WORDING.test(clause) || FUTURE_WORDING.test(clause))) absent = true;
            else if (CURRENT_PARTICIPATION.test(clause) && !HYPOTHETICAL_WORDING.test(clause) && !NEGATED_WORDING.test(clause)) absent = false;
        }
    }
    return absent;
}

const NEGATED_BEFORE = /\b(?:not|never|isn['’]?t|wasn['’]?t|no longer)\s+(?:\w+\s+){0,3}$/i;
const BIRTH_PREDICATE = /\b(?:birth(?:day|date)?|name\s*day|nameday|born|hatched|date\s+of\s+birth)\b/giu;
const CURRENT_BIRTHDAY = /\b(?:birthday|name\s*day|nameday|turn(?:s|ing)?\s+\d{1,3})\b/giu;
const HYPOTHETICAL_OR_FALSE = /\b(?:if|would|might|could|perhaps|maybe|supposedly|allegedly|forged|forgery|fake|false|lie|lies|lied|rumou?rs?|pretend(?:s|ed|ing)?|claims?\s+(?:to|that)|as if|denies|denied|deny|doubts?|doubted|whether|wonders?|wondered)\b/i;
const PAST_BIRTHDAY = /\b(?:yesterday|tomorrow|last\s+(?:year|week|month)|next\s+birthday|upcoming|ago|earlier|previous|past|recounts?|recounted|recalls?|recalled|remembers?|remembered|was\s+(?:her|his|their)\s+birthday|had\s+(?:her|his|their)\s+birthday|will\s+be)\b/i;

function npcFirstLabels(npc) {
    const labels = [npc?.name, ...(Array.isArray(npc?.aliases) ? npc.aliases : [])].map(label => String(label || '').trim()).filter(Boolean);
    return new Set([...labels, ...labels.map(label => label.split(/\s+/)[0])].map(label => label.toLowerCase()));
}

// The part of a sentence that speaks about this NPC: another named person's possessive
// ("Noela's birthday"), a "Noela, who ..." relative clause and another person's "Noela turns 18"
// belong to that person and are removed.
function npcOwnClaimText(npc, sentence) {
    const own = npcFirstLabels(npc);
    const foreign = name => !own.has(String(name || '').toLowerCase());
    const ownClauses = String(sentence || '').split(/(?<=[,;])\s*|\s+(?=(?:but|while|whereas|and then|because)\b)/i)
        .filter(clause => !foreignSubjectClause(clause, own)).join(' ');
    return ownClauses
        .replace(/\b(\p{Lu}[\p{L}\p{M}-]+),?\s+who\b.*$/u, (match, name) => (foreign(name) ? ' ' : match))
        .replace(/\b(\p{Lu}[\p{L}\p{M}-]+)['’]s\s+(?:birthday|name\s*day|nameday|birth)\b/gu, (match, name) => (foreign(name) ? ' ' : match))
        .replace(/\b(\p{Lu}[\p{L}\p{M}-]+)\s+turn(?:s|ing)?\s+\d{1,3}\b/gu, (match, name) => (foreign(name) ? ' ' : match));
}

function affirmativeMatch(text, pattern) {
    for (const match of String(text || '').matchAll(pattern)) {
        if (!NEGATED_BEFORE.test(text.slice(0, match.index))) return true;
    }
    return false;
}

// Affirmative narration that today is this NPC's own birthday (not a denial, question,
// hypothetical, past birthday or someone else's).
function ownCurrentBirthdayClaim(npc, sentence) {
    const text = npcOwnClaimText(npc, sentence);
    if (/\?\s*$/.test(text) || HYPOTHETICAL_OR_FALSE.test(text) || PAST_BIRTHDAY.test(text)) return false;
    return affirmativeMatch(text, CURRENT_BIRTHDAY);
}

// An affirmative statement of this NPC's own birth (born / birthday / date of birth).
function ownBirthClaim(npc, sentence) {
    const text = npcOwnClaimText(npc, sentence);
    if (/\?\s*$/.test(text) || HYPOTHETICAL_OR_FALSE.test(text)) return '';
    return affirmativeMatch(text, BIRTH_PREDICATE) ? text : '';
}

function npcBirthdayNarrated(npc, text) {
    return npcOwnedSentences(npc, text).some(sentence => ownCurrentBirthdayClaim(npc, sentence));
}

function statedInSentence(sentence, token) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${String(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:st|nd|rd|th)?(?![\\p{L}\\p{N}])`, 'giu');
    for (const match of sentence.matchAll(pattern)) {
        if (!NEGATED_BEFORE.test(sentence.slice(0, match.index))) return true;
    }
    return false;
}

// A scanned birth date may set or change chronology only when an affirmative statement of this
// NPC's own birth supports every part it supplies: the month and day (stated, or "today is her
// birthday" on today's date) and a new year, none of them negated. The parts may be split across
// two consecutive sentences about the NPC ("Mira was born in CR790. Her birthday is Redleaf 2.").
// Callers without source text (manual edits) are not checked.
export function birthdayUpdateGrounded(npc, update, sourceText, calendar, referenceDate = null) {
    const text = String(sourceText || '');
    if (!text.trim()) return true;
    const incoming = normalizeBirthDate(update?.birthDate ?? update?.birth_date ?? update?.birthday, calendar);
    if (!incoming) return true;
    const known = normalizeBirthDate(npc?.birthDate, calendar);
    const reference = referenceDate ? normalizeCalendarDate(referenceDate, calendar) : null;
    const isToday = reference && String(reference.month).toLowerCase() === String(incoming.month).toLowerCase() && Number(reference.day) === Number(incoming.day);
    const needsYear = incoming.year !== null && !(known && known.year === incoming.year);
    const sentences = String(text).split(/(?<=[.!?])\s+|\n+|<\/?[A-Za-z_][^>]*>/).map(item => item.trim()).filter(Boolean);
    const owned = new Set(npcOwnedSentences(npc, text));
    const claims = sentences.map(sentence => (owned.has(sentence) ? ownBirthClaim(npc, sentence) : ''));
    const era = String(incoming.era || calendar?.era || '').trim();
    const yearTokens = [String(incoming.year), era && `${era}${incoming.year}`, era && `${era} ${incoming.year}`].filter(Boolean);
    const supports = window => {
        const dated = window.some(claim => statedInSentence(claim, incoming.month)) && window.some(claim => statedInSentence(claim, Number(incoming.day)));
        const birthdayToday = isToday && window.some(claim => ownCurrentBirthdayClaim(npc, claim));
        if (!dated && !birthdayToday) return false;
        return !needsYear || window.some(claim => yearTokens.some(token => statedInSentence(claim, token)));
    };
    return claims.some((claim, index) => claim && (supports([claim]) || (claims[index + 1] && supports([claim, claims[index + 1]]))));
}

function explicitVisualAgeCueFromAppearance(value) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return '';

    const exactYears = text.match(/\b(\d{1,3})[-\s]+years?[-\s]+old\b/i);
    if (exactYears) return exactYears[1];

    const decadeWords = 'twenties|thirties|forties|fifties|sixties|seventies|eighties|nineties';
    const band = text.match(new RegExp(String.raw`\b(?:in\s+(?:his|her|their)\s+)?((?:early|mid|middle|late)\s+(?:[1-9]\d?s|${decadeWords}))\b`, 'i'));
    if (band) return band[1];

    const broadDecade = text.match(new RegExp(String.raw`\b(?:in\s+(?:his|her|their)\s+|about\s+|around\s+|approximately\s+)?(${decadeWords})\b`, 'i'));
    if (broadDecade) return broadDecade[1];

    const looksNumeric = text.match(/\b(?:looks?|appears?)(?:\s+to\s+be)?\s+(?:about\s+|around\s+|approximately\s+)?(\d{1,3}(?:\s*(?:-|to)\s*\d{1,3})?)(?:\s*(?:years?|yrs?)\s*(?:old)?)?\b/i);
    if (looksNumeric) return looksNumeric[1];

    const descriptor = text.match(/\b(young adult|middle[- ]aged|older adult|newborn|infant|toddler|pre[- ]?teen|adolescent|teenager|teen|elderly|senior|child|young)\b/i);
    return descriptor ? descriptor[1] : '';
}

export function withAppearanceDerivedApparentAge(npc = {}, sourceAppearance = '') {
    if (!npc || typeof npc !== 'object' || String(npc.apparentAge ?? '').trim()) return npc;
    const cue = explicitVisualAgeCueFromAppearance(sourceAppearance || npc.appearance);
    if (!cue) return npc;
    const seed = npc.id || npc.name || npc.species || '';
    const apparentAge = mechanics.normalizeApparentAge(cue, seed);
    return apparentAge ? { ...npc, apparentAge } : npc;
}


const BIRTHDAY_UPDATE_KEYS = ['birthDate', 'birth_date', 'birthday', 'birthDateState', 'birth_date_state', 'birthDateReason', 'birth_date_reason'];
function hasBirthdayUpdate(row) {
    return Boolean(row && typeof row === 'object' && (row.birthDate ?? row.birth_date ?? row.birthday));
}

// The scanner is told to put grounded durable facts in profileUpdates, so a narrated birthday for an
// existing NPC can arrive there instead of in its npcs delta. Accept it from either channel; the
// ordinary delta wins when both carry one, and the same establish/correct gate applies.
export function birthdayUpdateRow(ordinaryRow, profileRow) {
    if (hasBirthdayUpdate(ordinaryRow) || !hasBirthdayUpdate(profileRow)) return ordinaryRow;
    const birthday = Object.fromEntries(BIRTHDAY_UPDATE_KEYS.filter(key => key in profileRow).map(key => [key, profileRow[key]]));
    return { ...(ordinaryRow || {}), ...birthday };
}

// Deterministic per-field "last changed at turn" markers for the dossier. They are presentation
// metadata on the canonical record (rolled back with it), never scanner input or prompt content.

export function normalizeFieldChanges(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const out = {};
    for (const field of CHANGE_TRACKED_FIELDS) {
        const turn = Number(source[field]);
        if (Number.isInteger(turn) && turn >= 0) out[field] = turn;
    }
    return out;
}

function trackedFieldValue(npc, field) {
    if (field === 'appearance') return resolveNpcAppearance(npc);
    if (field === 'relationship') {
        const rel = npc?.relationship || {};
        return ['trust', 'affection', 'desire', 'tension'].map(axis => Math.round(Number(rel[axis]) || 0));
    }
    return npc?.[field] ?? '';
}

// Story-day counterparts of fieldChanges for the stable fields whose age Refresh checks; present
// only when the chat's World State carries a date.

export function normalizeFieldChangeDays(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const current = Number(source.scheme) === STORY_DAY_SCHEME;
    const out = {};
    for (const field of DAY_TRACKED_FIELDS) {
        const day = current ? Number(source[field]) : migrateLegacyStoryDay(source[field]);
        if (Number.isInteger(day)) out[field] = day;
    }
    if (Object.keys(out).length) out.scheme = STORY_DAY_SCHEME;
    return out;
}

// Display-only counterpart of fieldChanges (1.2.3): the chat message index of the reply a change
// was recorded at, the numbering Story Block shows as "reply #N". fieldChanges keeps Delta's own
// turn counter, which recency and Refresh age rely on; a field without an entry predates 1.2.3.
export function normalizeFieldChangeMessages(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const out = {};
    for (const field of CHANGE_TRACKED_FIELDS) {
        const message = Number(source[field]);
        if (Number.isInteger(message) && message >= 0) out[field] = message;
    }
    return out;
}

export function stampFieldChanges(before, after, turn, storyDay = null, message = null) {
    const changes = normalizeFieldChanges(after?.fieldChanges ?? before?.fieldChanges);
    const days = normalizeFieldChangeDays(after?.fieldChangeDays ?? before?.fieldChangeDays);
    const messages = normalizeFieldChangeMessages(after?.fieldChangeMessages ?? before?.fieldChangeMessages);
    const memoryStamps = stampMemories(before, after, message, storyDateTextAt);
    const withExtras = next => {
        const out = Object.keys(days).length ? { ...next, fieldChangeDays: days } : next;
        if (memoryStamps) out.memoryStamps = memoryStamps;
        else delete out.memoryStamps;
        if (Object.keys(messages).length) out.fieldChangeMessages = messages;
        else delete out.fieldChangeMessages;
        return out;
    };
    if (!before || !Number.isInteger(turn) || turn < 0) return withExtras({ ...after, fieldChanges: changes });
    for (const field of CHANGE_TRACKED_FIELDS) {
        if (JSON.stringify(trackedFieldValue(before, field)) !== JSON.stringify(trackedFieldValue(after, field))) {
            changes[field] = turn;
            if (Number.isInteger(message) && message >= 0) messages[field] = message;
            else delete messages[field];
            if (Number.isInteger(storyDay) && DAY_TRACKED_FIELDS.includes(field)) {
                days[field] = storyDay;
                days.scheme = STORY_DAY_SCHEME;
            }
        }
    }
    return withExtras({ ...after, fieldChanges: changes });
}

// (cleanup step 9) The same per-field "changed at" stamps for writers outside the merge: the
// focused relationship pass and the reader's own edits (dossier editor, appearance forms, life
// state). `message` is the reply index the change belongs to; `storyDay` the World State day, if any.
export function stampChangedFields(before, after, { turn, storyDay = null, message = null } = {}) {
    return stampFieldChanges(before, after, Math.trunc(Number(turn)), storyDay, message);
}


export function birthdayPromptSource(options = {}) {
    return String(options?.transcript || options?.dossierText || options?.developmentContext || '');
}

// The story's date for a scan: a World State date in the scanned text (v1), else a given reference date,
// else (v2, hosted with Story Director) the story clock's date (calendar.js hostedStoryDate), else Delta's
// manual clock. `fallback` says no grounded date was found (the manual clock, or none).
export function calendarReference(options = {}, calendar = getActiveCalendarConfig()) {
    const extracted = extractStructuredWorldDate(options.calendarSource ?? birthdayPromptSource(options), calendar);
    const given = normalizeCalendarDate(options?.referenceDate, calendar) || hostedStoryDate(calendar);
    return {
        extracted,
        fallback: !extracted && !given,
        date: extracted?.date || given || currentCalendarDate(calendar),
    };
}

export function exactStoredAge(value) {
    const text = String(value ?? '').trim();
    return /^\d{1,3}$/.test(text) ? Number(text) : null;
}

function compactApparentAgeNumber(value) {
    const match = String(value ?? '').trim().match(/^~?(\d{1,3})$/);
    return match ? Number(match[1]) : null;
}

export function sameCalendarBirthday(a, b, calendar) {
    const left = normalizeCalendarDate(a, calendar);
    const right = normalizeCalendarDate(b, calendar);
    if (!left || !right) return false;
    if (left.era && right.era && mechanics.normalizeName(left.era) !== mechanics.normalizeName(right.era)) return false;
    return mechanics.normalizeName(left.month) === mechanics.normalizeName(right.month) && left.day === right.day;
}

// Apparent age follows chronology from a fixed reference point instead of accumulating deltas:
// apparent = reference apparent + (chronological age - reference age). A dated scene that moves
// backward (a flashback, a corrected typo) therefore undoes exactly what a forward jump carried.
// `result` records the value this carry produced; when anything else later changes the apparent
// age (a scan, a manual edit, an import) it no longer matches and the reference restarts there.
function validApparentAgeAnchor(anchor, apparent) {
    return Boolean(anchor && typeof anchor === 'object'
        && Number.isInteger(anchor.age) && Number.isInteger(anchor.apparent) && anchor.result === apparent);
}

function carriedApparentAge(previousRaw, npc, previousAge, targetAge) {
    const apparent = compactApparentAgeNumber(previousRaw.apparentAge ?? npc.apparentAge);
    if (apparent === null) return null;
    const anchor = validApparentAgeAnchor(previousRaw.apparentAgeAnchor, apparent)
        ? previousRaw.apparentAgeAnchor
        : { age: previousAge, apparent };
    const result = anchor.apparent + (targetAge - anchor.age);
    // A long-lived NPC seen far in the past cannot look younger than an infant; keep what is
    // shown and the reference, so returning to the present restores it unchanged.
    if (result < 1) return { apparentAge: npc.apparentAge, apparentAgeAnchor: { age: anchor.age, apparent: anchor.apparent, result: apparent } };
    return { apparentAge: `~${result}`, apparentAgeAnchor: { age: anchor.age, apparent: anchor.apparent, result } };
}

export function applyDeterministicBirthdayRollover(npc, previousRaw, ordinaryUpdate, options, calendar, referenceDate) {
    if (!npc || !previousRaw || !referenceDate || isTerminalNpcDeath(npc)) return npc;
    const manualFields = Array.isArray(npc.manualProfileFields) ? npc.manualProfileFields : [];
    if (manualFields.includes('age')) return npc;
    const exactBirthday = sameCalendarBirthday(npc.birthDate, referenceDate, calendar);

    const previousAge = exactStoredAge(previousRaw.age);
    if (previousAge === null) return npc;
    const currentAge = exactStoredAge(npc.age);
    const calendarAge = Number.isInteger(npc.calendarAge) ? npc.calendarAge : null;

    const previousBirthDate = normalizeCalendarDate(
        previousRaw.birthDate ?? previousRaw.birth_date ?? previousRaw.birthday,
        calendar,
    );
    const previousHadYear = previousBirthDate?.year !== null && previousBirthDate?.year !== undefined;
    const incomingBirthday = ordinaryUpdate?.birthDate ?? ordinaryUpdate?.birth_date ?? ordinaryUpdate?.birthday;
    const birthdayEstablishedNow = Boolean(incomingBirthday)
        && ['establish', 'set', 'update', 'refine', 'correct', 'correction']
            .includes(String(ordinaryUpdate?.birthDateState ?? ordinaryUpdate?.birth_date_state ?? '').trim().toLowerCase());
    const ageState = String(ordinaryUpdate?.ageState ?? ordinaryUpdate?.age_state ?? '').trim().toLowerCase();
    const correctedAge = ageState === 'correct' || ageState === 'correction';
    const apparentState = String(ordinaryUpdate?.apparentAgeState ?? ordinaryUpdate?.apparent_age_state ?? '').trim().toLowerCase();
    const apparentCarries = !manualFields.includes('apparentAge') && apparentState !== 'evolve';
    // Only an unchanged full (year-bearing) birth date proves elapsed chronology, and only that
    // calendar arithmetic may carry into apparent age.
    const currentBirthDate = normalizeCalendarDate(npc.birthDate, calendar);
    const sameFullBirthDate = previousHadYear && currentBirthDate?.year === previousBirthDate.year
        && sameCalendarBirthday(currentBirthDate, previousBirthDate, calendar);
    const provenChronology = sameFullBirthDate && !birthdayEstablishedNow && !correctedAge && calendarAge !== null;
    if (provenChronology && calendarAge < previousAge) {
        // Chronology moved backward (already applied to age above); apparent age follows it back.
        if (!apparentCarries) return npc;
        const carried = carriedApparentAge(previousRaw, npc, previousAge, calendarAge);
        return carried ? { ...npc, ...carried } : npc;
    }
    if (!exactBirthday && (!provenChronology || calendarAge <= previousAge)) return npc;
    let targetAge = calendarAge !== null && calendarAge > previousAge ? calendarAge : currentAge;
    // Only a birthday narrated about this NPC counts; another NPC's birthday on the same date does not.
    const narratedBirthday = npcBirthdayNarrated(npc, birthdayPromptSource(options));

    // Compatibility recovery for an existing yearless birthday: if the story has reached that
    // exact stored birthday and explicitly presents it as a birthday/nameday, the accepted age
    // is the pre-birthday baseline. Advance once, then anchor the derived year so repeated scans
    // on the same day are idempotent. A birthday first established in this same scan is excluded.
    if (exactBirthday && !previousHadYear && !birthdayEstablishedNow && !correctedAge && narratedBirthday
        && (targetAge === null || targetAge <= previousAge)) {
        targetAge = previousAge + 1;
    }

    if (targetAge === null || targetAge <= previousAge) return npc;
    let next = { ...npc, age: String(targetAge), updatedAt: Date.now() };
    if (next.birthDateYearSource === 'derived'
        && (!Number.isInteger(next.calendarAge) || next.calendarAge < targetAge)) {
        next = reanchorDerivedBirthYearFromAge(next, calendar, referenceDate);
        next.age = String(targetAge);
    }

    if (apparentCarries) {
        const carried = carriedApparentAge(previousRaw, npc, previousAge, targetAge);
        if (carried) Object.assign(next, carried);
    }
    return normalizeNpcBirthday(next, calendar, referenceDate);
}

export function calendarNpcProjection(raw = null, referenceDate = null, fallback = true) {
    if (!raw || typeof raw !== 'object') return raw;
    const calendar = getActiveCalendarConfig();
    const npc = normalizeNpcBirthday(raw, calendar, referenceDate);
    const acceptedAge = String(raw.age ?? '').trim();
    const protectedAge = isTerminalNpcDeath(raw) || (Array.isArray(raw.manualProfileFields) && raw.manualProfileFields.includes('age'));
    const computedAge = referenceDate && !protectedAge ? effectiveChronologicalAge(npc, calendar, referenceDate) : acceptedAge;
    const staleFallback = fallback && /^\d+$/.test(acceptedAge) && /^\d+$/.test(computedAge) && Number(computedAge) < Number(acceptedAge);
    return withAppearanceDerivedApparentAge({ ...npc, age: staleFallback ? acceptedAge : computedAge }, raw.appearance || npc.appearance);
}
