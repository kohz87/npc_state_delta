// NPC meters, hidden notes (secrets): normalization, ids, the generated-note list, and the line forms of secrets and per-NPC
// limits. A pure part of npc-meters.js (same owner, moved without change); npc-meters.js re-exports every name it exported before.
// Never imports npc-meters.js.
import { BUILT_IN_METERS, clean, intOr, isObject, MAX_GENERATED_SECRETS, MAX_METERS_PER_NPC, MAX_SECRETS, NOTE_SOURCES, SECRET_TEXT_MAX, SECRET_TITLE_MAX, SECRET_WHEN_MAX, slug } from './npc-meters-config.js';
import { normalizeLimits } from './npc-meters-presets.js';

/**
 * Hidden notes from a dossier record, cleaned: [{ id, meter?, at?, when?, text, title? }] (at most
 * eight). A note needs text and a rule: a meter id with a whole-number `at`, a story event (`when`,
 * up to 120 characters), or both (it opens by whichever comes first). The id comes from the rule and
 * the text only, so giving a note a title never locks it again. `from` says a note is not the reader's: 'pack' (the cast's) or 'scan'
 * (written for a new dossier); a note with no `from` is the reader's own (every note before packs and scans wrote any), and the
 * dossier editor shows it even while locked. A note's `from` is never read from a model's answer or a pack's file.
 */
export function normalizeSecrets(list, max = MAX_SECRETS) {
    const out = [];
    for (const entry of Array.isArray(list) ? list : []) {
        if (out.length >= max) break;
        if (!isObject(entry)) continue;
        const meter = slug(entry.meter);
        const at = intOr(entry.at, null);
        const text = clean(entry.text, SECRET_TEXT_MAX);
        const when = clean(entry.when, SECRET_WHEN_MAX);
        const byMeter = Boolean(meter) && at !== null;
        if (!text || (!byMeter && !when)) continue;
        const id = typeof entry.id === 'string' && /^[a-z][a-z0-9]*_[0-9a-z]{8}$/.test(entry.id) ? entry.id : secretId(byMeter ? meter : '', byMeter ? at : 0, text, when);
        if (out.some(other => other.id === id)) continue;
        const title = clean(entry.title, SECRET_TITLE_MAX);
        out.push({ id, ...(byMeter ? { meter, at } : {}), ...(when ? { when } : {}), text, ...(title ? { title } : {}), ...(NOTE_SOURCES.includes(entry.from) ? { from: entry.from } : {}) });
    }
    return out;
}

/** A stable id for a note from its rule and text (FNV-1a): `sec_` and 8 base-36 characters. A meter note's id does not depend on `when`. */
export function secretId(meter, at, text, when = '') {
    let hash = 0x811c9dc5;
    for (const char of `${meter}|${at}|${text}${meter ? '' : `|${when}`}`) {
        hash ^= char.codePointAt(0);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `sec_${hash.toString(36).padStart(8, '0').slice(-8)}`;
}

/**
 * The notes a scan wrote for someone new (the model's `secrets`), cleaned: [{ id, meter?, at?, when?,
 * title?, text }], 2 to 5 of them in the order given (light to deep), at most MAX_GENERATED_SECRETS.
 * A meter rule uses one of the four built-in meters and a whole number from -100 to 100; anything else
 * must carry a story event. Fewer than one usable note gives [].
 */
export function normalizeGeneratedSecrets(list) {
    const meters = new Set(BUILT_IN_METERS.map(def => def.id));
    const usable = (Array.isArray(list) ? list : []).filter(isObject).map(entry => {
        const meter = slug(entry.meter);
        const at = intOr(entry.at, null);
        const ok = meters.has(meter) && at !== null && at >= -100 && at <= 100 && at !== 0;
        return { ...entry, id: undefined, from: 'scan', meter: ok ? meter : '', at: ok ? at : null };
    });
    return normalizeSecrets(usable, MAX_GENERATED_SECRETS);
}

/** The notes as editor lines: `trust 40: [Her past] She is the duke's daughter.`; an event note: `when the duke falls => text`. */
export function secretsToLines(list) {
    return normalizeSecrets(list).map(secret => {
        const body = `${secret.title ? `[${secret.title}] ` : ''}${secret.text}`;
        if (secret.meter === undefined) return `when ${secret.when} => ${body}`;
        return secret.when ? `${secret.meter} ${secret.at} or when ${secret.when} => ${body}` : `${secret.meter} ${secret.at}: ${body}`;
    }).join('\n');
}

/**
 * Editor lines back to notes: one per line, `meter at: text` (`trust 40: …`, `trust >= 40: …`,
 * `tension -30: …`), with an optional title in brackets before the text (`trust 60: [Her past] …`;
 * a title is only for the reader: screens never show it while the note is hidden). A note that opens
 * on a story event is `when the duke falls => text`, and `trust 60 or when the duke falls => text`
 * opens by whichever comes first. A note whose rule and text are unchanged keeps its id. Lines that do
 * not read are returned in `problems`.
 */
export function secretsFromLines(text, previous = []) {
    const kept = new Map(normalizeSecrets(previous).map(secret => [`${secret.meter ?? ''}|${secret.at ?? ''}|${secret.when ?? ''}|${secret.text}`, secret]));
    const secrets = [];
    const problems = [];
    for (const line of String(text ?? '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let meter = '';
        let at = null;
        let when = '';
        let rest = '';
        const event = /^(?:([\p{L}][\p{L}\p{N} _-]*?)\s*(?:>=|≥|<=|≤|at)?\s*([+\-−]?\d{1,4})\s+or\s+)?when\s+(.{1,200}?)\s*=>\s*(.+)$/u.exec(trimmed);
        const plain = event ? null : /^([\p{L}][\p{L}\p{N} _-]*?)\s*(?:>=|≥|<=|≤|at)?\s*([+\-−]?\d{1,4})\s*:\s*(.+)$/u.exec(trimmed);
        if (event) {
            meter = event[1] ? slug(event[1]) : '';
            at = event[2] ? Number(event[2].replace('−', '-')) : null;
            when = clean(event[3], SECRET_WHEN_MAX);
            rest = event[4];
        } else if (plain) {
            meter = slug(plain[1]);
            at = Number(plain[2].replace('−', '-'));
            rest = plain[3];
        } else { problems.push(trimmed); continue; }
        const titled = /^\[([^\]]{1,80})\]\s*(.+)$/u.exec(rest.trim());
        const title = titled ? clean(titled[1], SECRET_TITLE_MAX) : '';
        const body = clean(titled ? titled[2] : rest, SECRET_TEXT_MAX);
        if ((event ? !when : !meter) || !body) { problems.push(trimmed); continue; }
        const byMeter = Boolean(meter) && at !== null;
        // A line left as it was is the note it was: its id and what it came from (`from`) go with it.
        const same = kept.get(`${byMeter ? meter : ''}|${byMeter ? at : ''}|${when}|${body}`);
        const id = same?.id ?? secretId(byMeter ? meter : '', byMeter ? at : 0, body, when);
        if (secrets.some(secret => secret.id === id)) continue;
        if (secrets.length >= MAX_SECRETS) { problems.push(trimmed); continue; }
        secrets.push({ id, ...(byMeter ? { meter, at } : {}), ...(when ? { when } : {}), text: body, ...(title ? { title } : {}), ...(same?.from ? { from: same.from } : {}) });
    }
    return { secrets, problems };
}

/**
 * Per-NPC limits as editor lines: `trust: floor -20, ceiling 60` (one meter per line), and back.
 * Lines read `meter: ceiling N` / `max N` / `floor N` / `min N` (either or both); others are problems.
 */
export function limitsToLines(limits) {
    return Object.entries(normalizeLimits(limits))
        .map(([meter, limit]) => `${meter}: ${[limit.floor !== undefined ? `floor ${limit.floor}` : '', limit.ceiling !== undefined ? `ceiling ${limit.ceiling}` : ''].filter(Boolean).join(', ')}`)
        .join('\n');
}
export function limitsFromLines(text) {
    const limits = {};
    const problems = [];
    for (const line of String(text ?? '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const match = /^([\p{L}][\p{L}\p{N} _-]*?)\s*:\s*(.+)$/u.exec(trimmed);
        const meter = match ? slug(match[1]) : '';
        const limit = {};
        let ok = Boolean(meter);
        for (const part of match ? match[2].split(/[,;]/) : []) {
            const piece = /^\s*(ceiling|max|floor|min)\s*[:=]?\s*([+\-−]?\d{1,4})\s*$/iu.exec(part);
            if (!piece) { ok = false; break; }
            limit[/^(?:ceiling|max)$/i.test(piece[1]) ? 'ceiling' : 'floor'] = Number(piece[2].replace('−', '-'));
        }
        const normalized = ok ? normalizeLimits({ [meter]: limit })[meter] : null;
        if (!normalized || Object.keys(limits).length >= MAX_METERS_PER_NPC) { problems.push(trimmed); continue; }
        limits[meter] = normalized;
    }
    return { limits, problems };
}

// ---- the slice ----
