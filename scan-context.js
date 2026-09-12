/* NPC State Delta: pure scan/backfill eligibility helpers. */

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * A queued backfill is meaningful only while its target is still an active
 * member of the owning chat roster. The caller already decides whether the
 * target has evidence in the configured history window; this helper keeps
 * stale/archived queue entries from spending a model request after state moves
 * underneath them.
 */
export function backfillNeedsRequest(target, roster = [], _currentExchange = '') {
    if (!target || typeof target !== 'object' || target.archived === true) return false;
    const source = Array.isArray(roster) ? roster : [];
    const id = text(target.id);
    if (id) return source.some(item => text(item?.id) === id && item?.archived !== true);
    return source.includes(target);
}
