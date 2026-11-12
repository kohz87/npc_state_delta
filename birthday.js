/* NPC State Delta deterministic birthday continuity policy. */
import {
    calendarFingerprint,
    calendarPromptContext,
    deriveAgeFromBirthDate,
    deriveBirthDateFromAgeParts,
    deterministicCalendarBirthday,
    formatCalendarDate,
    getActiveCalendarConfig,
    normalizeCalendarConfig,
    normalizeCalendarDate,
    storyCurrentDate,
} from './calendar.js';
import { parseKeyRelationshipEntry } from './social-bonds.js';
import { normalizeName } from './core-text.js';

const BIRTH_DATE_SOURCES = Object.freeze(['generated', 'established']);
const BIRTH_YEAR_SOURCES = Object.freeze(['', 'derived', 'established']);

function activeOrProvided(config = undefined) {
    return config === undefined ? getActiveCalendarConfig() : config;
}

function normalizedIdentity(value) {
    return String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function birthdaySeed(npc = {}) {
    const id = String(npc?.id || '').trim();
    return id || normalizedIdentity(npc?.name || '');
}

function sameDate(a, b, config = null) {
    const left = normalizeCalendarDate(a, config);
    const right = normalizeCalendarDate(b, config);
    if (!left || !right) return false;
    return String(left.era || '') === String(right.era || '')
        && left.year === right.year
        && normalizedIdentity(left.month) === normalizedIdentity(right.month)
        && left.day === right.day;
}

function sameMonthDay(a, b, config = null) {
    const left = normalizeCalendarDate(a, config);
    const right = normalizeCalendarDate(b, config);
    if (!left || !right) return false;
    return normalizedIdentity(left.month) === normalizedIdentity(right.month) && left.day === right.day;
}

function exactAge(value) {
    const text = String(value ?? '').trim();
    return /^\d{1,3}$/.test(text) ? Number(text) : null;
}

function groundedReferenceDate(calendar, referenceDate = null) {
    return normalizeCalendarDate(referenceDate, calendar) || storyCurrentDate(calendar);
}

export function normalizeBirthDate(value, config = undefined) {
    return normalizeCalendarDate(value, activeOrProvided(config));
}

function normalizeStoredBirthDate(value, config = undefined) {
    const calendar = activeOrProvided(config);
    return normalizeCalendarDate(value, calendar) || normalizeCalendarDate(value, null);
}

export function formatBirthDate(value, config = undefined) {
    const calendar = activeOrProvided(config);
    const normalized = normalizeCalendarDate(value, calendar) || normalizeCalendarDate(value, null);
    if (!normalized) return '';
    return formatCalendarDate(normalized, normalizeCalendarDate(value, calendar) ? calendar : null);
}

export function birthDatePrecision(value, config = undefined) {
    const normalized = normalizeBirthDate(value, config);
    return normalized ? (normalized.year === null ? 'month-day' : 'full') : '';
}

export function deterministicBirthday(seed, config = undefined) {
    return deterministicCalendarBirthday(seed, activeOrProvided(config));
}

export function deriveBirthDateFromAge(birthDate, age, referenceDate = null, config = undefined) {
    return deriveBirthDateFromAgeParts(birthDate, age, referenceDate, activeOrProvided(config));
}

export function normalizeBirthDateState(raw = {}) {
    const value = String(raw?.birthDateState ?? raw?.birth_date_state ?? '').trim().toLowerCase();
    if (value === 'correct' || value === 'correction') return 'correct';
    if (['establish', 'set', 'update', 'refine'].includes(value)) return 'establish';
    return 'keep';
}

export function normalizeScanBirthday(raw = {}, config = undefined) {
    return {
        birthDate: normalizeBirthDate(raw?.birthDate ?? raw?.birth_date ?? raw?.birthday, config),
        birthDateState: normalizeBirthDateState(raw),
        birthDateReason: String(raw?.birthDateReason ?? raw?.birth_date_reason ?? '').trim().slice(0, 500),
    };
}

function generatedBirthdayFor(npc = {}, config = undefined) {
    const calendar = activeOrProvided(config);
    const generated = deterministicBirthday(birthdaySeed(npc), calendar);
    return {
        birthDate: generated,
        birthDateSource: generated ? 'generated' : '',
        birthDatePrecision: generated ? 'month-day' : '',
        birthDateYearSource: '',
        birthDateCalendarFingerprint: generated ? calendarFingerprint(calendar) : '',
        birthDateReason: '',
        birthDateSourceMessageId: null,
    };
}

function calculateCalendarAge(npc = {}, config = undefined, referenceDate = null) {
    const calendar = activeOrProvided(config);
    const current = groundedReferenceDate(calendar, referenceDate);
    if (!current) return null;
    const age = deriveAgeFromBirthDate(npc.birthDate, current, calendar);
    return Number.isInteger(age) ? age : null;
}

function anchorMissingBirthYear(npc = {}, config = undefined, referenceDate = null) {
    const calendar = activeOrProvided(config);
    const current = groundedReferenceDate(calendar, referenceDate);
    const age = exactAge(npc.age);
    const date = normalizeBirthDate(npc.birthDate, calendar);
    if (!current || age === null || !date || date.year !== null) return npc;
    const derived = deriveBirthDateFromAge(date, String(age), current, calendar);
    if (!derived) return npc;
    return {
        ...npc,
        birthDate: derived,
        birthDatePrecision: 'full',
        birthDateYearSource: 'derived',
    };
}

export function normalizeNpcBirthday(npc = {}, config = undefined, referenceDate = null) {
    const calendar = activeOrProvided(config);
    const rawDate = normalizeStoredBirthDate(npc?.birthDate ?? npc?.birth_date ?? npc?.birthday, calendar);
    const rawSource = String(npc?.birthDateSource ?? npc?.birth_date_source ?? '').trim().toLowerCase();
    const source = BIRTH_DATE_SOURCES.includes(rawSource) ? rawSource : (rawDate ? 'established' : '');
    const storedFingerprint = String(npc?.birthDateCalendarFingerprint ?? npc?.birth_date_calendar_fingerprint ?? '').trim();
    const activeFingerprint = calendarFingerprint(calendar);

    let next;
    if (!rawDate) {
        next = { ...npc, ...generatedBirthdayFor(npc, calendar) };
    } else if (source === 'generated' && storedFingerprint && storedFingerprint !== activeFingerprint) {
        // Generated dates belong to the configured calendar. A deliberate calendar change
        // deterministically remaps them; established story dates are never remapped this way.
        next = { ...npc, ...generatedBirthdayFor(npc, calendar) };
    } else {
        const rawYearSource = String(npc?.birthDateYearSource ?? npc?.birth_date_year_source ?? '').trim().toLowerCase();
        let yearSource = BIRTH_YEAR_SOURCES.includes(rawYearSource) ? rawYearSource : '';
        if (rawDate.year !== null && !yearSource) yearSource = source === 'established' ? 'established' : 'derived';
        const rawSourceMessageId = npc?.birthDateSourceMessageId ?? npc?.birth_date_source_message_id;
        next = {
            ...npc,
            birthDate: rawDate,
            birthDateSource: source || 'established',
            birthDatePrecision: rawDate.year === null ? 'month-day' : 'full',
            birthDateYearSource: yearSource,
            birthDateCalendarFingerprint: storedFingerprint || activeFingerprint,
            birthDateReason: String(npc?.birthDateReason ?? npc?.birth_date_reason ?? '').trim().slice(0, 500),
            birthDateSourceMessageId: Number.isInteger(rawSourceMessageId) ? rawSourceMessageId : null,
        };
    }

    next = anchorMissingBirthYear(next, calendar, referenceDate);
    const calendarAge = calculateCalendarAge(next, calendar, referenceDate);
    next.calendarAge = calendarAge;
    next.birthDateDisplay = formatBirthDate(next.birthDate, calendar);
    return next;
}

export function effectiveChronologicalAge(npc = {}, config = undefined, referenceDate = null) {
    const normalized = normalizeNpcBirthday(npc, config, referenceDate);
    return Number.isInteger(normalized.calendarAge) ? String(normalized.calendarAge) : String(normalized.age ?? '').trim();
}

export function reanchorDerivedBirthYearFromAge(npc = {}, config = undefined, referenceDate = null) {
    const calendar = activeOrProvided(config);
    const current = groundedReferenceDate(calendar, referenceDate);
    const next = normalizeNpcBirthday(npc, calendar, current);
    if (next.birthDateYearSource !== 'derived' || exactAge(next.age) === null || !current) return next;
    const partial = { ...next.birthDate, year: null };
    const derived = deriveBirthDateFromAge(partial, next.age, current, calendar);
    if (!derived) return next;
    return normalizeNpcBirthday({
        ...next,
        birthDate: derived,
        birthDatePrecision: 'full',
        birthDateYearSource: 'derived',
    }, calendar, current);
}

export function applyNpcBirthdayUpdate(npc = {}, rawUpdate = null, options = {}) {
    const calendar = options.calendarConfig ?? getActiveCalendarConfig();
    const referenceDate = groundedReferenceDate(calendar, options.referenceDate);
    const next = normalizeNpcBirthday(npc, calendar, referenceDate);
    if (!rawUpdate || typeof rawUpdate !== 'object') return next;
    let incoming = normalizeBirthDate(rawUpdate.birthDate ?? rawUpdate.birth_date ?? rawUpdate.birthday, calendar);
    if (!incoming) return next;

    const state = normalizeBirthDateState(rawUpdate);
    if (state !== 'establish' && state !== 'correct') return next;
    const reason = String(rawUpdate.birthDateReason ?? rawUpdate.birth_date_reason ?? '').trim().slice(0, 500);
    const currentEstablished = next.birthDateSource === 'established';

    let incomingYearSource = incoming.year === null ? '' : 'established';
    if (incoming.year === null && referenceDate && exactAge(npc.age) !== null) {
        const derived = deriveBirthDateFromAge(incoming, npc.age, referenceDate, calendar);
        if (derived) {
            incoming = derived;
            incomingYearSource = 'derived';
        }
    }

    const exactMatch = sameDate(incoming, next.birthDate, calendar);
    const sameDay = sameMonthDay(incoming, next.birthDate, calendar);
    const existingHasYear = normalizeBirthDate(next.birthDate, calendar)?.year !== null;
    const incomingHasYear = incoming.year !== null;
    const authorityUpgrade = sameDay
        && incomingHasYear
        && (!existingHasYear || next.birthDateYearSource === 'derived')
        && incomingYearSource === 'established';

    const mayEstablish = state === 'establish'
        && (!currentEstablished || !next.birthDate || authorityUpgrade || exactMatch);
    const mayCorrect = state === 'correct';
    if (!mayCorrect && !mayEstablish) return next;

    return normalizeNpcBirthday({
        ...next,
        birthDate: incoming,
        birthDateSource: 'established',
        birthDatePrecision: incoming.year === null ? 'month-day' : 'full',
        birthDateYearSource: incomingYearSource,
        birthDateCalendarFingerprint: calendarFingerprint(calendar),
        birthDateReason: reason || (exactMatch ? next.birthDateReason : ''),
        birthDateSourceMessageId: Number.isInteger(options.sourceMessageId)
            ? options.sourceMessageId
            : next.birthDateSourceMessageId,
    }, calendar, referenceDate);
}

export function mergeNpcBirthdayKnowledge(sources = [], current = {}, config = undefined, referenceDate = null) {
    const calendar = activeOrProvided(config);
    const next = normalizeNpcBirthday(current, calendar, referenceDate);
    if (next.birthDateSource === 'established') return next;
    const established = (Array.isArray(sources) ? sources : [])
        .map(source => normalizeNpcBirthday(source, calendar, referenceDate))
        .find(source => source.birthDateSource === 'established' && source.birthDate);
    if (!established) return next;
    return normalizeNpcBirthday({
        ...next,
        birthDate: established.birthDate,
        birthDateSource: 'established',
        birthDatePrecision: established.birthDatePrecision,
        birthDateYearSource: established.birthDateYearSource,
        birthDateCalendarFingerprint: established.birthDateCalendarFingerprint,
        birthDateReason: established.birthDateReason,
        birthDateSourceMessageId: established.birthDateSourceMessageId,
    }, calendar, referenceDate);
}

export function birthdayEvidenceInText(value) {
    return /\b(birth(?:day|date)?|name\s*day|nameday|born|hatched|turn(?:s|ed|ing)?\s+\d{1,3}|date\s+of\s+birth)\b/i.test(String(value || ''));
}

export function birthdayPromptRule(config = undefined, referenceDate = null) {
    const calendar = activeOrProvided(config);
    const normalized = normalizeCalendarConfig(calendar, { requireCurrentDate: false });
    const context = calendarPromptContext(calendar, referenceDate);
    if (!normalized.calendarValid) {
        return `\nBIRTHDAY: Only grounded birthday/birth-date evidence may return birthDate:"MM-DD|YYYY-MM-DD" with birthDateState:"establish|correct" and a brief birthDateReason; omit otherwise. Never derive from apparentAge, species, or lifespan and never invent a random date; Delta generates the fallback locally.`;
    }
    const contextText = context ? `${context} ` : '';
    return `\nBIRTHDAY: ${contextText}Preserve fantasy era/month names exactly as stated in grounded evidence. Only grounded birthday/birth-date evidence may return birthDate:{"era":"${normalized.config.era || ''}","year":number|null,"month":"month name","day":number} with birthDateState:"establish|correct" and a brief birthDateReason; omit otherwise. Never invent a missing year or birthday. Never derive chronology from apparentAge, species, or lifespan; Delta performs calendar arithmetic locally.`;
}

export const BIRTHDAY_PROMPT_RULE = birthdayPromptRule(null);

// (cleanup step 12, I-10) The one-pass rules' short form: the same contract, nothing that changes
// from reply to reply (the current date is sent with the context instead).
export function birthdayCaptureRule(config = undefined) {
    const normalized = normalizeCalendarConfig(activeOrProvided(config), { requireCurrentDate: false });
    const shape = normalized.calendarValid
        ? `{"era":"${normalized.config.era || ''}","year":number|null,"month":"month name","day":number}`
        : '"MM-DD|YYYY-MM-DD"';
    const names = normalized.calendarValid ? ' Keep stated era/month names.' : '';
    return `\nBIRTHDAY: grounded evidence only: birthDate:${shape}+birthDateState:"establish|correct"+birthDateReason; never invented or derived from apparentAge/species/lifespan.${names}`;
}

// ---- Twins share a birthday (cast-wide pass; the shared month/day is STORED in the generated date) ----
// Two people who ARE twins of each other (a key-relationship tie whose relation is "twin" / "twin sister|brother|sibling", or a pack cast
// dossier whose role says "twin ... of <name>" / "<name>'s twin") share a month and day. "Twin" that qualifies someone else (twin son,
// one of the twins, the twins' mother, twin flame) and negated wordings link nobody: when in doubt, nothing happens. An ESTABLISHED
// (story/player-set) date always wins and is never replaced; a GENERATED date takes the month/day of the established twin (lowest id
// among established ones), or, when none is established, of the generated twin with the lowest id. Only month and day are copied: the
// receiver keeps its own year, era and stored age (a year is never copied; if the move would change its calendar age, it is skipped). Run by scan merges only, never by a live read or an editor command (the date a pass sees must not matter).
// The result is written into the record, so it stays if the tie is later removed. Deterministic from the stored state: replay equals
// live. No model call.
const TWIN_REL = /^(?:(?:her|his|their|my)\s+)?(?:(?:older|younger|elder|identical|fraternal|big|little)\s+)*twin(?:\s+(?:sister|brother|sibling))?$/;
const TWIN_NEGATION = /\b(?:not|never|no|non|isn'?t|wasn'?t|false|fake|half|ex|former|late|dead|deceased)\b/;
const TWIN_END = '(?=\\s*(?:$|[,.;:)!\\u2014\\u2013-])|\\s+(?:and|who|whose|but)\\b)';

export function isTwinRelation(relation) {
    const rel = String(relation ?? '').toLowerCase().replace(/[.!]+$/, '').split(/[;,(]/)[0].trim().replace(/\s+/g, ' ');
    return !!rel && !TWIN_NEGATION.test(rel) && TWIN_REL.test(rel);
}

function twinLabels(npc) {
    return [npc?.name, ...(Array.isArray(npc?.aliases) ? npc.aliases : [])].map(normalizeName).filter(Boolean);
}

// A role links only when the twin wording OPENS a clause (start of the role, or right after ; , | or a dash, optional "the"): any word in
// front ("Wife of Ana's twin brother", "Married to Ana's twin") means the twin is someone else.
const ROLE_OF = new RegExp(`^[Tt]win(?:\\s+(?:[Ss]ister|[Bb]rother|[Ss]ibling))?\\s+of\\s+(\\p{Lu}[\\p{L}\\p{M}'\\u2019-]*(?:\\s+\\p{Lu}[\\p{L}\\p{M}'\\u2019-]*){0,2})(?!['\\u2019]s\\b)`, 'u');
const ROLE_POSSESSIVE = new RegExp(`^(\\p{Lu}[\\p{L}\\p{M}-]*(?:\\s+\\p{Lu}[\\p{L}\\p{M}-]*){0,2})['\\u2019]s\\s+(?:(?:older|younger|elder|identical|fraternal)\\s+)?[Tt]win(?:\\s+(?:[Ss]ister|[Bb]rother|[Ss]ibling))?${TWIN_END}`, 'u');
const ROLE_CLAUSES = /[;,|\u2014\u2013]|\s-\s/;

function twinPairs(npcs) {
    const byLabel = new Map();
    npcs.forEach((npc, index) => twinLabels(npc).forEach(label => { if (!byLabel.has(label)) byLabel.set(label, index); }));
    const pairs = [];
    const link = (from, name) => {
        const to = byLabel.get(normalizeName(name));
        if (to !== undefined && to !== from) pairs.push([from, to]);
    };
    npcs.forEach((npc, index) => {
        for (const tie of Array.isArray(npc?.keyRelationships) ? npc.keyRelationships : []) {
            const parsed = parseKeyRelationshipEntry(tie);
            if (parsed && isTwinRelation(parsed.relation)) link(index, parsed.subject);
        }
        if (npc?.castFrom) {
            const role = String(npc.role ?? '');
            if (TWIN_NEGATION.test(role.toLowerCase())) return;
            for (const part of role.split(ROLE_CLAUSES)) {
                const clause = part.trim().replace(/^the\s+/i, '');
                const m = clause.match(ROLE_OF) || clause.match(ROLE_POSSESSIVE);
                if (m) link(index, m[1]);
            }
        }
    });
    return pairs;
}

export function applyTwinBirthdays(npcs, config = undefined, referenceDate = null) {
    if (!Array.isArray(npcs) || npcs.length < 2) return npcs;
    const calendar = activeOrProvided(config);
    const pairs = twinPairs(npcs);
    if (!pairs.length) return npcs;
    const parent = npcs.map((_, i) => i);
    const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (const [a, b] of pairs) parent[find(a)] = find(b);
    const groups = new Map();
    npcs.forEach((npc, i) => { if (npc && typeof npc === 'object') { const r = find(i); groups.set(r, [...(groups.get(r) || []), i]); } });
    const byId = (a, b) => (birthdaySeed(npcs[a]) < birthdaySeed(npcs[b]) ? -1 : (birthdaySeed(npcs[a]) > birthdaySeed(npcs[b]) ? 1 : 0));
    for (const members of groups.values()) {
        if (members.length < 2) continue;
        const normalized = new Map(members.map(i => [i, normalizeNpcBirthday(npcs[i], calendar, referenceDate)]));
        const sorted = [...members].sort(byId);
        const established = sorted.filter(i => normalized.get(i).birthDateSource === 'established' && normalized.get(i).birthDate);
        const donor = established.length ? normalized.get(established[0]) : normalized.get(sorted[0]);
        if (!donor.birthDate) continue;
        for (const i of members) {
            const own = normalized.get(i);
            if (own.birthDateSource !== 'generated' || i === sorted[0] && !established.length) continue;
            if (sameDate(own.birthDate, donor.birthDate, calendar)) continue;
            const candidate = normalizeNpcBirthday({
                ...npcs[i],
                birthDate: { ...own.birthDate, month: donor.birthDate.month, day: donor.birthDate.day },
                birthDateSource: 'generated',
                birthDateCalendarFingerprint: calendarFingerprint(calendar),
            }, calendar, referenceDate);
            if (candidate.calendarAge !== own.calendarAge) continue;   // never move a stored age
            Object.assign(npcs[i], candidate);
        }
    }
    return npcs;
}
