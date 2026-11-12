// Memory facts (design MEMDESIGN2 §3): the per-NPC `memoryFacts` sidecar and its bounded suppression ledger.
//   { v: 1, entries: { [key]: { t: normalized text, r: reply, s: source ref, rev: source revision, k: kind, c: 'M'|'A'|'O', p: payload,
//                              i: identity hash, d?: story date, pend?: 1, att?: n } },
//     ledger: { floor: reply boundary, keys: [[key, boundary, disposition, identity]] } }
// Dispositions: k kept, e evicted by retention, x deleted/edited by the reader, l locked, c display collision, o per-reply overflow, q quarantined.
// The ledger holds at most LEDGER_CAP keys per NPC (whole boundary groups pruned oldest first, `floor` advancing over them), so an old event
// below the floor is never recreated just because its key was pruned. Storage (amendment 2): the cap is 64 (not 256: 256 rows x ~70 B x 60 dossiers would be ~1 MB per snapshot). A full sidecar (64 rows, 5 maximal entries) measured 6.9 KB, so 60 dossiers all full = ~0.41 MB, a fifth of the 2 MB single-checkpoint limit.
import { normalizeName } from '../core-text.js';
import { cleanPayload, productions, FACT_KINDS } from './memory-fact-text.js';

export const FACT_SLOTS = 5;
export const LEDGER_CAP = 64;
export const PAYLOAD_BYTES = 512;
export const ADMIT_PER_REPLY = 4;
const KEY_RE = /^v1:[A-Za-z0-9_-]{43}$/;
const DISPOSITIONS = 'kexlcoq';
const CLASSES = ['M', 'A', 'O'];

export const isFactKey = key => typeof key === 'string' && KEY_RE.test(key);
const nonNegative = value => (Number.isInteger(value) && value >= 0 ? value : null);

function cleanEntry(key, raw) {
    if (!isFactKey(key) || !raw || typeof raw !== 'object') return null;
    const kind = FACT_KINDS.includes(raw.k) ? raw.k : '';
    const payload = kind ? cleanPayload(kind, raw.p) : null;
    const r = nonNegative(raw.r);
    if (!payload || r === null || !CLASSES.includes(raw.c)) return null;
    if (new TextEncoder().encode(JSON.stringify(payload)).length > PAYLOAD_BYTES) return null;
    const entry = { t: String(raw.t || ''), r, s: String(raw.s || '').slice(0, 120), rev: String(raw.rev || '').slice(0, 16), k: kind, c: raw.c, p: payload, i: String(raw.i || '').slice(0, 12) };
    if (typeof raw.d === 'string' && raw.d.trim()) entry.d = raw.d.trim().slice(0, 40);
    if (raw.pend) entry.pend = 1;
    if (Number.isInteger(raw.att) && raw.att > 0) entry.att = Math.min(raw.att, 9);
    return entry;
}

export function cleanLedger(raw) {
    const rows = [];
    const seen = new Set();
    for (const row of Array.isArray(raw?.keys) ? raw.keys : []) {
        if (!Array.isArray(row) || !isFactKey(row[0]) || seen.has(row[0])) continue;
        const boundary = nonNegative(row[1]);
        if (boundary === null || !DISPOSITIONS.includes(row[2]) || row[2].length !== 1) continue;
        seen.add(row[0]);
        rows.push([row[0], boundary, row[2], String(row[3] || '').slice(0, 12)]);
    }
    return { floor: nonNegative(raw?.floor) ?? 0, keys: rows };
}

// Prunes whole boundary groups, oldest first, and advances the floor over each; never splits a boundary.
export function pruneLedger(ledger, cap = LEDGER_CAP) {
    const keys = [...ledger.keys].sort((a, b) => a[1] - b[1]);
    let floor = ledger.floor;
    while (keys.length > cap) {
        const boundary = keys[0][1];
        while (keys.length && keys[0][1] === boundary) keys.shift();
        floor = Math.max(floor, boundary);
    }
    return { floor, keys };
}

// Sidecar from stored data against the visible memories: an entry stays only while exactly one stored memory still carries its text and
// that text is one of its allowed sentences. Any other entry is detached and its key tombstoned (`x`), the reader's text untouched.
export function normalizeFacts(raw, memories) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const ledger = cleanLedger(raw.ledger);
    const entries = {};
    const slots = new Map();
    for (const text of Array.isArray(memories) ? memories : []) {
        const tk = normalizeName(text);
        slots.set(tk, slots.has(tk) ? null : text);
    }
    const dropped = [];
    for (const [key, value] of Object.entries(raw.entries && typeof raw.entries === 'object' ? raw.entries : {})) {
        const entry = cleanEntry(key, value);
        const text = entry ? slots.get(entry.t) : null;
        if (!entry || !text || !productions(entry.k, entry.p).includes(text.normalize('NFC')) || Object.keys(entries).length >= FACT_SLOTS) { dropped.push([key, entry]); continue; }
        entries[key] = entry;
    }
    let next = ledger;
    for (const [key, entry] of dropped) {
        if (!isFactKey(key) || next.keys.some(row => row[0] === key && row[2] !== 'k')) continue;
        next = { floor: next.floor, keys: [...next.keys.filter(row => row[0] !== key), [key, entry?.r ?? 0, 'x', entry?.i ?? '']] };
    }
    for (const key of Object.keys(entries)) {
        if (!next.keys.some(row => row[0] === key)) next = { floor: next.floor, keys: [...next.keys, [key, entries[key].r, 'k', entries[key].i]] };
    }
    next = pruneLedger(next);
    if (!Object.keys(entries).length && !next.keys.length && !next.floor) return undefined;
    return { v: 1, entries, ledger: next };
}

export const ledgerRow = (facts, key) => facts?.ledger?.keys?.find(row => row[0] === key) ?? null;

// Seen = tombstoned, retained, or at/below the pruned floor: the event may not be recreated.
export function factSeen(facts, key, boundary) {
    if (!facts) return false;
    if (ledgerRow(facts, key) || facts.entries?.[key]) return true;
    return facts.ledger?.floor > 0 && boundary <= facts.ledger.floor;
}

export function withDisposition(facts, key, boundary, disposition, identity = '') {
    const base = facts ?? { v: 1, entries: {}, ledger: { floor: 0, keys: [] } };
    const keys = base.ledger.keys.filter(row => row[0] !== key);
    keys.push([key, boundary, disposition, identity]);
    return { v: 1, entries: base.entries, ledger: pruneLedger({ floor: base.ledger.floor, keys }) };
}
