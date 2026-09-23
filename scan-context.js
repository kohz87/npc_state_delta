/* NPC State Delta: pure scan/backfill eligibility helpers. */

export const AUTOMATIC_BACKFILL_QUEUE_VERSION = 1;
export const AUTOMATIC_MISSED_PARTICIPANT_REPAIR_LIMIT = 1;
export const AUTOMATIC_BACKFILL_REASONS = Object.freeze(['missed-participant', 'new-admission']);

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}
function norm(value) {
    return text(value).normalize('NFKC').toLocaleLowerCase().replace(/<[^>]*>/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}
function hasPhrase(source, phrase) {
    const haystack = norm(source);
    const needle = norm(phrase);
    return Boolean(haystack && needle && ` ${haystack} `.includes(` ${needle} `));
}

function participationText(value) {
    let source = String(value || '');
    source = source
        .replace(/<Blocks\b[^>]*>[\s\S]*?<\/Blocks\s*>/gi, ' ')
        .replace(/<Blocks\b[^>]*>[\s\S]*$/gi, ' ')
        .replace(/<World_State\b[^>]*>[\s\S]*?<\/World_State\s*>/gi, ' ')
        .replace(/<NPC_Inner_Chatter\b[^>]*>[\s\S]*?<\/NPC_Inner_Chatter\s*>/gi, ' ')
        .replace(/<details\b[^>]*>([\s\S]*?)<\/details>/gi, (whole, inner) => {
            const summary = String(inner || '').match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i)?.[1] || '';
            const label = String(summary).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            return /\b(?:world\s*state|npc\s*inner\s*chatter)\b/i.test(label) ? ' ' : whole;
        });
    return source.split(/\r?\n/).map(line => {
        const rosterLine = String(line || '').replace(/^\s*(?:[-*#>]+\s*)?/, '');
        if (/^(?:NPCs?\s+Present|Present\s+NPCs?|NPC\s+Roster|NPC\s+Status(?:es)?|Active\s+NPCs?)(?:\s*\([^)]*\))?\s*:/i.test(rosterLine)) return '';
        const marker = line.search(/\b(?:World State|NPC Inner Chatter)\s*:/i);
        return marker >= 0 ? line.slice(0, marker) : line;
    }).join('\n');
}
function uniqueFirstNames(roster) {
    const counts = new Map();
    for (const npc of roster || []) {
        for (const label of [npc?.name, ...(npc?.aliases || [])].filter(Boolean)) {
            const first = norm(label).split(' ')[0] || '';
            if (first.length >= 3) counts.set(first, (counts.get(first) || 0) + 1);
        }
    }
    return new Set([...counts].filter(([, count]) => count === 1).map(([name]) => name));
}

/** Return true only when the current exchange explicitly involves this NPC. */
export function npcParticipatesInExchange(target, roster = [], currentExchange = '', { includeRole = true } = {}) {
    const narrative = participationText(currentExchange);
    if (!target || typeof target !== 'object' || !text(narrative)) return false;
    const source = Array.isArray(roster) ? roster : [];
    const uniqueFirst = uniqueFirstNames(source);
    const labels = new Set();
    const canonical = norm(target.name);
    if (canonical) {
        labels.add(canonical);
        const first = canonical.split(' ')[0] || '';
        if (uniqueFirst.has(first)) labels.add(first);
    }
    for (const raw of target.aliases || []) {
        const alias = norm(raw);
        if (alias) labels.add(alias);
    }
    const role = norm(target.role);
    if (includeRole && role.length >= 5) labels.add(role);
    return [...labels].some(label => hasPhrase(narrative, label));
}

/**
 * A queued backfill is meaningful only while its target is still an active
 * member of the owning chat roster. Automatic backfill relevance is checked
 * by the caller so manual repair remains available even when the NPC is not
 * in the newest exchange.
 */
export function backfillNeedsRequest(target, roster = []) {
    if (!target || typeof target !== 'object' || target.archived === true) return false;
    const source = Array.isArray(roster) ? roster : [];
    const id = text(target.id);
    if (id) return source.some(item => text(item?.id) === id && item?.archived !== true);
    return source.includes(target);
}

export function normalizeAutomaticBackfillRequest(raw = {}) {
    if (!raw || typeof raw !== 'object') return null;
    if (Number(raw.queueVersion) !== AUTOMATIC_BACKFILL_QUEUE_VERSION) return null;
    const reason = text(raw.reason);
    if (!AUTOMATIC_BACKFILL_REASONS.includes(reason)) return null;
    const npcId = text(raw.npcId).slice(0, 100);
    const label = text(raw.label).slice(0, 120);
    if (!npcId || !label) return null;
    return {
        queueVersion: AUTOMATIC_BACKFILL_QUEUE_VERSION,
        reason,
        npcId,
        label,
        requestedMessageId: Number.isInteger(raw.requestedMessageId) ? raw.requestedMessageId : null,
        preserveLiveState: raw.preserveLiveState === true,
        silent: raw.silent === true,
        requestedAt: Math.max(0, Number(raw.requestedAt || 0) || 0),
        attempts: Math.max(0, Math.round(Number(raw.attempts) || 0)),
        lastAttemptAt: Math.max(0, Number(raw.lastAttemptAt || 0) || 0),
    };
}

export function automaticBackfillStillRelevant(request, target, roster = [], owningExchange = '') {
    const normalized = normalizeAutomaticBackfillRequest(request);
    if (!normalized || !backfillNeedsRequest(target, roster)) return false;
    if (normalized.reason === 'new-admission') return true;
    if (normalized.reason === 'missed-participant') {
        return npcParticipatesInExchange(target, roster, owningExchange, { includeRole: false });
    }
    return false;
}
