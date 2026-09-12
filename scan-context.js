/* NPC State Delta: pure scan/backfill eligibility helpers. */

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
export function npcParticipatesInExchange(target, roster = [], currentExchange = '') {
    if (!target || typeof target !== 'object' || !text(currentExchange)) return false;
    const source = Array.isArray(roster) ? roster : [];
    const uniqueFirst = uniqueFirstNames(source);
    const labels = new Set();
    for (const raw of [target.name, ...(target.aliases || [])]) {
        const label = norm(raw);
        if (!label) continue;
        labels.add(label);
        const first = label.split(' ')[0] || '';
        if (uniqueFirst.has(first)) labels.add(first);
    }
    const role = norm(target.role);
    if (role.length >= 5) labels.add(role);
    return [...labels].some(label => hasPhrase(currentExchange, label));
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
