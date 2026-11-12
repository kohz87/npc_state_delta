// Memory facts (design MEMDESIGN2 §7): the union of two dossiers' memory facts when an alias merge joins them. Immutable event keys are kept as they
// are (never rehashed from the new name). For the same event key a tombstone (deleted/edited/evicted) beats an automatic duplicate, which is dropped with
// its text; otherwise one entry is kept with the larger attempt count; different keys stay different. The floor is the more conservative (larger) one;
// exact-text collisions and the five-slot order are then settled by the store.
import { normalizeName } from '../core-text.js';
import { normalizeFactMemories } from './memory-fact-store.js';

export function mergeAliasFacts(merged, a, b) {
    const rows = new Map();
    for (const row of [...(b.memoryFacts?.ledger?.keys ?? []), ...(a.memoryFacts?.ledger?.keys ?? [])]) {
        const had = rows.get(row[0]);
        if (!had || (had[2] === 'k' && row[2] !== 'k')) rows.set(row[0], row);
    }
    const entries = {};
    const dropped = new Set();
    for (const key of new Set([...Object.keys(a.memoryFacts?.entries ?? {}), ...Object.keys(b.memoryFacts?.entries ?? {})])) {
        const left = a.memoryFacts?.entries?.[key];
        const right = b.memoryFacts?.entries?.[key];
        const row = rows.get(key);
        if (row && row[2] !== 'k') { for (const entry of [left, right]) if (entry) dropped.add(entry.t); continue; }
        const entry = structuredClone(left ?? right);
        if (left && right) { entry.att = Math.max(left.att ?? 0, right.att ?? 0) || undefined; if (!entry.att) delete entry.att; if (!(left.pend && right.pend)) delete entry.pend; }
        entries[key] = entry;
    }
    const keepTexts = new Set(Object.values(entries).map(entry => entry.t));
    const texts = [...(a.memories || []), ...(b.memories || [])].filter(text => !dropped.has(normalizeName(text)) || keepTexts.has(normalizeName(text)));
    const facts = { v: 1, entries, ledger: { floor: Math.max(a.memoryFacts?.ledger?.floor ?? 0, b.memoryFacts?.ledger?.floor ?? 0), keys: [...rows.values()] } };
    const result = normalizeFactMemories(texts, facts, merged.manualMemories);
    merged.memories = result.memories;
    if (result.facts) merged.memoryFacts = result.facts; else delete merged.memoryFacts;
    merged.manualMemories = (merged.manualMemories || []).filter(text => result.memories.some(item => normalizeName(item) === normalizeName(text)));
    if (!merged.manualMemories.length) delete merged.manualMemories;
}
