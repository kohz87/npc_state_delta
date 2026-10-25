// Logical clock markers. Identity and activation use E5's single proof allocator and pin rule.
import { stateHash } from './host-block.js';
import { hashJson, sourceProblem, cursorProblem, isHash, isPlainJson } from '../replay.js';
export const CLOCK_COMMANDS = Object.freeze(['capture.time', 'director.seed', 'time.settle', 'director.advance']);
export const markerHash = marker => hashJson({ minute: marker.minute, source: { sid: marker.source.sid, swipeKey: marker.source.swipeKey, evidence: marker.source.evidence }, cursor: { ...marker.cursor, rev: 0 }, entry: marker.entry, baseHash: marker.baseHash });
export function markerProblem(marker) {
    if (!marker || !Number.isSafeInteger(marker.minute) || marker.minute % 1440 !== 0 || sourceProblem(marker.source) || cursorProblem(marker.cursor)) return 'a clock marker has no valid midnight, source or cursor';
    if (!isHash(marker.baseHash) || !isPlainJson(marker.entry) || !marker.entry?.payload || !isHash(marker.pin) || typeof marker.proof !== 'string' || !isHash(marker.prefixHash)) return 'a clock marker has no captured prefix';
    return markerHash(marker) === marker.prefixHash ? '' : 'a clock marker no longer hashes to its captured prefix';
}
export function clockWriteProblem(span) {
    if (span?.clockBoundaries === undefined) return '';
    if (!Array.isArray(span.clockBoundaries)) return 'clock markers are not a list';
    const seen = new Set();
    for (const marker of span.clockBoundaries) {
        const bad = markerProblem(marker);
        if (bad) return bad;
        if (marker.source.sid !== span.source?.sid || marker.source.swipeKey !== span.source?.swipeKey || marker.source.evidence !== span.source?.evidence) return 'a clock marker belongs to another source';
        if (seen.has(marker.cursor.block)) return 'two clock markers have the same identity';
        seen.add(marker.cursor.block);
        const proof = span.evidence?.find(item => item.id === marker.proof);
        if (proof?.owner !== 'story-director' || proof.kind !== 'event' || proof.payload?.clockBoundary !== marker.minute || proof.payload?.prefixHash !== marker.prefixHash) return 'a marker has no matching clock proof';
    }
    return '';
}

// Prefix-only host check: no captured state may survive on a different transaction input.
export function markerPrefixProblem(span, state) {
    return span?.clockBoundaries?.some(marker => marker.baseHash !== stateHash(state))
        ? 'the clock marker was captured on another root prefix; Re-read its clock reply' : '';
}
