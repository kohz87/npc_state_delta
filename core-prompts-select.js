/* NPC State Delta scanner context selection: scene-present focus, bounded context assembly and mention scoring.
   Split from core-prompts.js without change; core-prompts.js re-exports every name it exported before. */
import { cleanText, normalizeName } from './core-text.js';

import { countNormalizedPhrase } from './core-merge.js';
/**
 * (v2 World view) The scene's present list for the scanner: `{ names, ids, npcs }` with the names as the
 * scene gives them (at most 12, each cut to 80 characters) and the dossiers they name (by name or alias,
 * not archived), or null when there is no list or it names no one, so the prompt stays as it was.
 */
export function scenePresentFocus(existingNpcs = [], sceneNames = null) {
    if (!Array.isArray(sceneNames)) return null;
    const names = [];
    const seen = new Set();
    for (const raw of sceneNames) {
        const name = String(raw ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim();
        const key = normalizeName(name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        names.push(name);
        if (names.length >= 12) break;
    }
    if (!names.length) return null;
    const npcs = (Array.isArray(existingNpcs) ? existingNpcs : []).filter(npc => npc && !npc.archived
        && [npc.name, ...(npc.aliases || [])].map(normalizeName).some(label => label && seen.has(label)));
    return { names, ids: new Set(npcs.map(npc => npc.id)), npcs };
}

/** The scanner's context NPCs with the scene's present dossiers added after them, within `limit`. */
export function withScenePresent(selected = [], present = [], limit = 4) {
    const cap = Math.max(1, Math.min(8, Number(limit) || 4));
    const out = [...selected];
    for (const npc of present) {
        if (out.length >= cap) break;
        if (!out.some(other => other.id === npc.id)) out.push(npc);
    }
    return out.slice(0, cap);
}

export function selectScannerContextNpcs(existingNpcs = [], transcript = '', limit = 4) {
    const cap = Math.max(1, Math.min(8, Number(limit) || 4));
    const list = Array.isArray(existingNpcs) ? existingNpcs : [];
    const scored = list.map((npc, index) => ({
        npc,
        index,
        mentionScore: scannerNpcMentionScore(npc, transcript),
    }));
    const mentioned = scored
        .filter(item => item.mentionScore > 0)
        .sort((a, b) => b.mentionScore - a.mentionScore
            || Number(b.npc?.lastSeenTurn || 0) - Number(a.npc?.lastSeenTurn || 0)
            || a.index - b.index);
    const selected = mentioned.slice(0, cap);

    // Role-only prose may not contain the proper name. Keep one recent dossier as a
    // continuity hint when nothing can be matched lexically, but never pad every scan
    // with two unrelated full dossiers as older releases did.
    if (!selected.length) {
        const recent = scored
            .filter(item => !item.npc?.archived)
            .sort((a, b) => Number(b.npc?.lastSeenTurn || 0) - Number(a.npc?.lastSeenTurn || 0)
                || Number(b.npc?.seenCount || 0) - Number(a.npc?.seenCount || 0));
        if (recent.length) selected.push(recent[0]);
    }
    return selected.slice(0, cap).map(item => item.npc);
}

export function selectScannerProfileContextNpcs(existingNpcs = [], transcript = '', limit = 2) {
    const cap = Math.max(1, Math.min(3, Number(limit) || 2));
    const scored = (Array.isArray(existingNpcs) ? existingNpcs : [])
        .map((npc, index) => ({ npc, index, score: scannerNpcMentionScore(npc, transcript) }))
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score || a.index - b.index);
    if (!scored.length) {
        const fallback = [...(Array.isArray(existingNpcs) ? existingNpcs : [])]
            .filter(npc => !npc?.archived)
            .sort((a, b) => Number(Boolean(b?.present)) - Number(Boolean(a?.present))
                || Number(Boolean(b?.worldActive)) - Number(Boolean(a?.worldActive))
                || Number(b?.lastSeenTurn || 0) - Number(a?.lastSeenTurn || 0));
        return fallback.length ? [fallback[0]] : [];
    }
    const result = [scored[0]];
    const secondThreshold = Math.max(8, scored[0].score * 0.45);
    for (const item of scored.slice(1)) {
        if (result.length >= cap) break;
        if (item.score >= secondThreshold) result.push(item);
    }
    return result.map(item => item.npc);
}

function scannerNpcMentionScore(npc, transcript) {
    const raw = String(transcript || '');
    const mainRaw = raw.split(/\b(?:World State|NPC Inner Chatter)\s*:/i)[0] || raw;
    const whole = normalizeName(raw);
    const main = normalizeName(mainRaw);
    const canonicalName = cleanText(npc?.name, 120);
    const shortName = canonicalName.split(/\s+/).filter(Boolean)[0] || '';
    const labels = [canonicalName, shortName, ...(Array.isArray(npc?.aliases) ? npc.aliases : [])]
        .map(normalizeName)
        .filter(Boolean)
        .filter((label, index, array) => array.indexOf(label) === index);
    let score = 0;
    for (const label of labels) {
        const mainCount = countNormalizedPhrase(main, label);
        const wholeCount = countNormalizedPhrase(whole, label);
        score += (mainCount * 6) + Math.max(0, wholeCount - mainCount) * 2;
    }
    const role = normalizeName(npc?.role);
    if (role) {
        const roleMain = countNormalizedPhrase(main, role);
        const roleWhole = countNormalizedPhrase(whole, role);
        score += (roleMain * 3) + Math.max(0, roleWhole - roleMain);
    }
    return score;
}
