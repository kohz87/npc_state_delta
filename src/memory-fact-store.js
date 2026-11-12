// Memory facts (design MEMDESIGN2 §6, §7): the identity-aware memory pipeline for a dossier that carries a `memoryFacts` sidecar, and the
// one place the five-slot order is decided. A dossier without a sidecar and without new fact candidates never comes here: its callers run the
// original normalize/merge/stamp functions byte for byte (core-record-merge.js, core-record-shared.js).
//   Priority (total): 1 reader pins > 2 proven first meeting (M) > 3 class A facts > 4 class O facts > 5 ordinary memories.
//   Newest source reply first within a class, ties by key. Model `memoryRetention` orders only the ordinary slots.
//   Amendment 6: the approved order stands, so enough automatic facts CAN take every non-pinned slot and starve model memories; the
//   owner signs that off (see MEMBUILD.REPORT.md). Exactly-equal normalized text is the only thing that suppresses an ordinary memory against a fact.
import { cleanList, normalizeName } from '../core-text.js';
import { DURABLE_PROFILE_LIMITS, durableSemanticSimilarity } from '../core-relationship.js';
import { mergeImportantMemories } from '../core-record-merge.js';
import { factKey, factIdentity } from './memory-fact-key.js';
import { cleanPayload, fallbackText } from './memory-fact-text.js';
import { ADMIT_PER_REPLY, FACT_SLOTS, factSeen, isFactKey, normalizeFacts, withDisposition } from './memory-fact-ledger.js';

const KIND_ORDER = ['met', 'lieCaught', 'milestone', 'quest', 'move', 'gift', 'fight', 'party'];
const RANK = { M: 1, A: 2, O: 3 };

// Priority-order selection of at most `limit` records. Each record { text, tk, pin, key?, entry?, order }; returns the kept records.
export function chooseSlots(records, limit = FACT_SLOTS) {
    const pins = records.filter(item => item.pin);
    if (pins.length >= limit) return pins;                       // five pins leave nothing: automatic writers never evict a pin (>5 stays untouched)
    const rest = records.filter(item => !item.pin);
    const firstMeeting = rest.filter(item => item.entry?.c === 'M').sort((a, b) => a.entry.r - b.entry.r || (a.key < b.key ? -1 : 1))[0];
    const rank = item => (item === firstMeeting ? 1 : (item.entry ? Math.max(2, RANK[item.entry.c] ?? 3) : 4));
    const ordered = rest.filter(item => !item.entry || item.entry.c !== 'M' || item === firstMeeting)
        .sort((a, b) => rank(a) - rank(b) || (rank(a) === 4 ? b.order - a.order : (b.entry.r - a.entry.r || (a.key < b.key ? -1 : 1))));
    return [...pins, ...ordered.slice(0, limit - pins.length)];
}

function stable(records, chosen) { return records.filter(item => chosen.includes(item)).sort((a, b) => a.order - b.order); }

// Stored memories carrying a sidecar: exact-text dedupe only (never semantic), the sidecar validated against them, then the slot order.
export function normalizeFactMemories(rawMemories, rawFacts, rawManual = []) {
    const seen = new Set();
    const texts = cleanList(rawMemories, 64, DURABLE_PROFILE_LIMITS.memory).filter(text => { const k = normalizeName(text); if (!k || seen.has(k)) return false; seen.add(k); return true; });
    let facts = normalizeFacts(rawFacts, texts);
    const manual = new Set((Array.isArray(rawManual) ? rawManual : []).map(normalizeName));
    const byText = new Map(Object.entries(facts?.entries ?? {}).map(([key, entry]) => [entry.t, { key, entry }]));
    const records = texts.map((text, order) => ({ text, tk: normalizeName(text), pin: manual.has(normalizeName(text)), order, ...(byText.get(normalizeName(text)) ?? {}) }));
    const chosen = chooseSlots(records);
    for (const item of records) if (!chosen.includes(item) && item.key) facts = withDisposition(facts, item.key, item.entry.r, 'e', item.entry.i);
    const kept = stable(records, chosen);
    for (const item of records) if (!chosen.includes(item) && item.key && facts?.entries?.[item.key]) { delete facts.entries[item.key]; }
    return { memories: kept.map(item => item.text), facts: facts && (Object.keys(facts.entries).length || facts.ledger.keys.length || facts.ledger.floor) ? facts : undefined };
}

// A scan's own events as candidates -> keys, bounded per reply. Candidate: { kind, cls, R, ns, source, eventId, phase?, payload, rev?, date? }.
export function admitCandidates(candidates, facts, { locked = false } = {}) {
    const out = [];
    let next = facts;
    const list = [...(Array.isArray(candidates) ? candidates : [])]
        .map(candidate => ({ ...candidate, payload: cleanPayload(candidate.kind, candidate.payload) }))
        .filter(candidate => candidate.payload && Number.isInteger(candidate.R) && candidate.R >= 0 && ['M', 'A', 'O'].includes(candidate.cls))
        .map(candidate => ({ ...candidate, key: factKey(candidate), ident: factIdentity(candidate) }))
        .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.cls === 'A' ? 0 : 1) - (b.cls === 'A' ? 0 : 1) || (a.key < b.key ? -1 : 1));
    for (const candidate of list) {
        const row = next?.ledger?.keys?.find(item => item[0] === candidate.key);
        if (row && row[3] && row[3] !== candidate.ident) { next = withDisposition(next, candidate.key, candidate.R, 'q', row[3]); continue; }   // identity collision: quarantine
        if (factSeen(next, candidate.key, candidate.R)) continue;
        if (locked) { next = withDisposition(next, candidate.key, candidate.R, 'l', candidate.ident); continue; }
        if (out.filter(item => item.R === candidate.R).length >= ADMIT_PER_REPLY) { next = withDisposition(next, candidate.key, candidate.R, 'o', candidate.ident); continue; }
        out.push(candidate);
    }
    return { admitted: out, facts: next };
}

// The whole fact-aware merge of one dossier's memories. `incoming` are the model's ordinary memories (suppressed only on EXACT text equality
// against a pin or fact; ordinary-to-ordinary keeps today's semantic merge); `candidates` are code-derived facts, their fallback text written here.
export function mergeFactMemories({ memories = [], manual = [], facts, incoming = [], retention = [], incomingLimit = 3, candidates = [], locked = false, message = null, stamps = {} } = {}) {
    const start = normalizeFactMemories(memories, facts, manual);
    const current = start.memories;
    const pinSet = new Set((Array.isArray(manual) ? manual : []).map(normalizeName));
    const factText = new Set(Object.values(start.facts?.entries ?? {}).map(entry => entry.t));
    const { admitted, facts: afterAdmit } = admitCandidates(candidates, start.facts, { locked });
    let next = afterAdmit;
    // Ordinary memories: today's merge over the unpinned, non-fact ones only; an exact collision with a pin or fact text is dropped.
    const ordinaryOld = current.filter(text => !pinSet.has(normalizeName(text)) && !factText.has(normalizeName(text)));
    const blocked = new Set([...pinSet, ...factText, ...admitted.map(item => normalizeName(fallbackText(item.kind, item.payload)))]);
    const ordinaryNew = cleanList(incoming, 12, DURABLE_PROFILE_LIMITS.memory).filter(text => !blocked.has(normalizeName(text)));
    const ordinary = locked ? ordinaryOld : mergeImportantMemories(ordinaryOld, ordinaryNew, retention, incomingLimit, [], { stamps, message });
    const records = [];
    let order = 0;
    for (const text of current) {
        const tk = normalizeName(text);
        const found = Object.entries(next?.entries ?? {}).find(([, entry]) => entry.t === tk);
        if (found) records.push({ text, tk, pin: pinSet.has(tk), key: found[0], entry: found[1], order: order++ });
        else if (pinSet.has(tk)) records.push({ text, tk, pin: true, order: order++ });
    }
    const ordinaryRecords = ordinary.map(text => ({ text, tk: normalizeName(text), pin: false, order: current.indexOf(text) >= 0 ? current.indexOf(text) : 1000 + order++ }));
    records.push(...ordinaryRecords.filter(item => !records.some(other => other.tk === item.tk)));
    const taken = new Set(records.map(item => item.tk));
    const fresh = [];
    for (const candidate of [...admitted].sort((a, b) => a.R - b.R || (a.key < b.key ? -1 : 1))) {   // chronological: the list reads oldest first
        const text = fallbackText(candidate.kind, candidate.payload);
        const tk = normalizeName(text);
        if (!text || taken.has(tk)) { next = withDisposition(next, candidate.key, candidate.R, 'c', candidate.ident); continue; }   // display collision: one slot, one identity
        taken.add(tk);
        const entry = { t: tk, r: candidate.R, s: String(candidate.source || '').slice(0, 120), rev: String(candidate.rev || '').slice(0, 16), k: candidate.kind, c: candidate.cls, p: candidate.payload, i: candidate.ident, pend: 1 };
        if (typeof candidate.date === 'string' && candidate.date.trim()) entry.d = candidate.date.trim().slice(0, 40);
        fresh.push({ text, tk, pin: false, key: candidate.key, entry, order: 2000 + order++ });
    }
    records.push(...fresh);
    // Ordinary memories compete for the slots the pins and facts leave: the model's retention ranks them (as the legacy merge did), newest last.
    const slotsLeft = FACT_SLOTS - records.filter(item => item.pin || item.entry).length;
    const ordinarySelected = new Set(chooseOrdinary(records.filter(item => !item.pin && !item.entry), Math.max(0, slotsLeft), retention).map(item => item.tk));
    const pool = records.filter(item => item.pin || item.entry || ordinarySelected.has(item.tk));
    const chosen = chooseSlots(pool);
    const entries = { ...(next?.entries ?? {}) };
    for (const item of records) {
        if (!item.key) continue;
        if (chosen.includes(item)) { entries[item.key] = item.entry; if (!next?.ledger?.keys?.some(row => row[0] === item.key && row[2] === 'k')) next = withDisposition(next, item.key, item.entry.r, 'k', item.entry.i); }
        else { delete entries[item.key]; next = withDisposition(next, item.key, item.entry.r, 'e', item.entry.i); }
    }
    const kept = stable(records, chosen);
    for (const key of Object.keys(entries)) if (!kept.some(item => item.key === key)) delete entries[key];
    const out = next ? { v: 1, entries, ledger: next.ledger } : undefined;
    const clean = out && (Object.keys(out.entries).length || out.ledger.keys.length || out.ledger.floor) ? out : undefined;
    return { memories: kept.map(item => item.text), manual: kept.filter(item => item.pin).map(item => item.text), facts: clean, facted: kept.filter(item => item.entry && !item.pin).map(item => item.key) };
}

function chooseOrdinary(list, count, retention) {
    if (list.length <= count) return list;
    const wanted = cleanList(retention, 10, DURABLE_PROFILE_LIMITS.memory);
    const requested = list.filter(item => wanted.some(request => normalizeName(request) === item.tk || durableSemanticSimilarity(request, item.text) >= 0.56));
    const rest = list.filter(item => !requested.includes(item)).sort((a, b) => b.order - a.order);
    return [...requested, ...rest].slice(0, count);
}

export { isFactKey };
