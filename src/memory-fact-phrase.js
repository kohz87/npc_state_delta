// Memory facts (design MEMDESIGN2 §8, §9): the model's chance to phrase a fallback, inside a call that already runs (auto/full scan; no new call,
// retry or timer). A handle names one pending fact; the dynamic paragraph lists, per handle, the closed set of allowed sentences; the model answers
// with an optional top-level `mem` { "h1": "sentence" }. A sentence is taken only when it equals an allowed production and the handle is still
// current at commit (same chat state, text, revision, pin/lock state, attempt and proven prompt window). One-pass capture sends NO handles
// (its window cannot be proven), so core-prompts-capture stays byte-identical. With no pending fact nothing is added to any prompt.
import { normalizeName } from '../core-text.js';
import { productions, validPhrasing } from './memory-fact-text.js';
import { normalizeFacts } from './memory-fact-ledger.js';

export const MAX_HANDLES = 4;
export const MAX_ATTEMPTS = 2;
export const PARAGRAPH_BYTES = 1600;
const bytes = text => new TextEncoder().encode(text).length;
const locked = npc => (Array.isArray(npc?.manualProfileFields) ? npc.manualProfileFields : []).includes('memories');

// Pending entries whose source reply is IN the exact window of the prompt: { h, npcId, key, R, fp, tk, rev, att }.
// `windowIds` are the message ids placed in the call's transcript; `fingerprintAt(id)` binds the message's content now.
export function selectHandles(npcs, windowIds, fingerprintAt) {
    const inWindow = new Set((Array.isArray(windowIds) ? windowIds : []).filter(Number.isInteger));
    if (!inWindow.size) return [];
    const rows = [];
    for (const npc of Array.isArray(npcs) ? npcs : []) {
        if (!npc?.id || npc.archived || locked(npc)) continue;
        const pins = new Set((npc.manualMemories || []).map(normalizeName));
        for (const [key, entry] of Object.entries(npc.memoryFacts?.entries ?? {})) {
            if (!entry.pend || (entry.att ?? 0) >= MAX_ATTEMPTS || pins.has(entry.t) || !inWindow.has(entry.r)) continue;
            rows.push({ npcId: npc.id, key, R: entry.r, fp: fingerprintAt(entry.r), tk: entry.t, rev: entry.rev, att: entry.att ?? 0 });
        }
    }
    rows.sort((a, b) => a.R - b.R || (a.npcId < b.npcId ? -1 : (a.npcId > b.npcId ? 1 : 0)) || (a.key < b.key ? -1 : 1));
    const firstPerNpc = [];
    const seen = new Set();
    for (const row of rows) if (!seen.has(row.npcId)) { seen.add(row.npcId); firstPerNpc.push(row); }
    const picked = [...firstPerNpc, ...rows.filter(row => !firstPerNpc.includes(row))].slice(0, MAX_HANDLES);
    return picked.map((row, index) => ({ ...row, h: `h${index + 1}` }));
}

// The conditional paragraph (appended to the scanner prompt only when handles exist) and the handles it names, byte-bounded: a handle whose
// forms do not fit is skipped whole, never truncated.
export function memoryParagraph(handles, npcs) {
    const head = 'MEMORY FACTS: for each handle below, copy exactly one of its allowed sentences into the optional top-level "mem" object, e.g. "mem":{"h1":"sentence"}. Omit any you do not want to change. Use only the listed sentences.';
    let text = head;
    const used = [];
    for (const handle of handles) {
        const entry = (Array.isArray(npcs) ? npcs : []).find(npc => npc.id === handle.npcId)?.memoryFacts?.entries?.[handle.key];
        if (!entry) continue;
        const line = `\n${handle.h}: ${productions(entry.k, entry.p).map(form => JSON.stringify(form)).join(' | ')}`;
        if (bytes(text + line) > PARAGRAPH_BYTES) continue;
        text += line;
        used.push(handle);
    }
    return used.length ? { text: `\n\n${text}`, handles: used } : { text: '', handles: [] };
}

// After a SUCCESSFULLY merged response: applies each valid sentence to the still-current handle, counts a try for the rest, stops offering after
// MAX_ATTEMPTS. `ok` false (failed, cut off, stale or never-dispatched call) changes nothing. Returns the new npcs list (original objects untouched).
export function applyPhrasing(npcs, handles, mem, { ok = true, fingerprintAt = () => null } = {}) {
    if (!ok || !Array.isArray(handles) || !handles.length) return npcs;
    const answers = mem && typeof mem === 'object' && !Array.isArray(mem) ? mem : {};
    let list = npcs;
    for (const handle of handles) {
        const index = list.findIndex(npc => npc.id === handle.npcId);
        const npc = list[index];
        const entry = npc?.memoryFacts?.entries?.[handle.key];
        const current = entry && entry.pend && entry.t === handle.tk && entry.rev === handle.rev && (entry.att ?? 0) === handle.att
            && !locked(npc) && !(npc.manualMemories || []).map(normalizeName).includes(entry.t) && fingerprintAt(entry.r) === handle.fp;
        if (!current) continue;
        const sentence = Object.hasOwn(answers, handle.h) ? validPhrasing(entry.k, entry.p, answers[handle.h]) : null;
        const next = structuredClone(npc);
        const slot = next.memories.findIndex(text => normalizeName(text) === entry.t);
        if (slot < 0) continue;
        const nextEntry = next.memoryFacts.entries[handle.key];
        if (sentence && !next.memories.some((text, at) => at !== slot && normalizeName(text) === normalizeName(sentence))) {
            const oldKey = entry.t;
            const newKey = normalizeName(sentence);
            next.memories[slot] = sentence;
            nextEntry.t = newKey;
            delete nextEntry.pend;
            delete nextEntry.att;
            if (next.memoryStamps?.[oldKey] && oldKey !== newKey) { next.memoryStamps[newKey] = next.memoryStamps[oldKey]; delete next.memoryStamps[oldKey]; }
        } else {
            nextEntry.att = (entry.att ?? 0) + 1;
            if (nextEntry.att >= MAX_ATTEMPTS) delete nextEntry.pend;
        }
        const checked = normalizeFacts(next.memoryFacts, next.memories);
        if (checked) next.memoryFacts = checked; else delete next.memoryFacts;
        list = list.map((item, at) => (at === index ? next : item));
    }
    return list;
}
