// Story Suite v2: reading one change line (moved out of capture.js unchanged; capture.js re-exports the public names): the ops, the line
// length cap, the markdown and bullet decoration a model puts around a line, `parseLine` and `parseChanges`, and the kind words a
// module declares (`grammarHeads`). The lowest layer of capture: it imports nothing from the other capture files.

import { cutAt } from '../../text.js';

// + new or gained, - gone or lost, ~ changed, ! happened, ? asks code to decide.
export const OPS = Object.freeze(['+', '-', '~', '!', '?']);

export const escapeRe = text => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A change line longer than this is not read (a Problem says so): no real change needs it.
export const MAX_LINE = 2000;

const SPACE = /\s/;
export const isSpace = char => char !== undefined && SPACE.test(char);
// `text` without the whitespace at its end (String#trimEnd is linear; `/\s+$/` is not in V8).
export const trimEnd = text => text.trimEnd();

// The separator between the name and the text: an em or en dash (with or without spaces) or a
// spaced hyphen, so `Jean-Luc` stays one name. → its index, or -1.
function textDash(first) {
    for (let i = 0; i < first.length; i += 1) {
        const char = first[i];
        if (char === '—' || char === '–') return i;
        if (char === '-' && i > 0 && isSpace(first[i - 1]) && (i + 1 === first.length || isSpace(first[i + 1]))) return i;
    }
    return -1;
}

// `label: value`: the label is words starting with a letter (so `09:00` is not one), lowercased by
// the parser. Without a space after the colon (`qty:3`, a common drift) the label must be one word
// of letters, so `at 09:00` stays text, and a colon followed by `//` is a link, not a label.
const LABEL_WORDS = /^\p{L}[\p{L}\p{N}'’ _-]*$/u;
const LABEL_WORD = /^\p{L}[\p{L}_-]*$/u;
function labelled(part) {
    const colon = part.indexOf(':');
    if (colon < 1) return null;
    const label = trimEnd(part.slice(0, colon));
    const rest = part.slice(colon + 1);
    if (!label || label.length > 60) return null;
    const spaced = rest === '' || isSpace(rest[0]);
    if (spaced ? !LABEL_WORDS.test(label) : !LABEL_WORD.test(label) || rest.startsWith('//')) return null;
    return [label, rest.trim()];
}
// What a model writes when it had nothing to change; dropped quietly.
export const NOTHING = /^\(?\s*(?:none|no changes?|nothing(?: changed)?|n\/a)\s*\)?\.?$/i;

export function stripMarkdown(text) {
    return String(text ?? '').replace(/\*\*|__|`/g, '');
}

// A run of ^ at the very start of a line is decoration too (a preset may mark lines with it); a ^ elsewhere stays.
// A bullet, number or quote mark in front of a line is decoration. A hyphen counts as one only
// when an op follows it: `- item Rope` is itself an op.
export function stripDecoration(line) {
    return line
        .replace(/^\^+\s*/, '')
        .replace(/^>\s*/, '')
        .replace(/^(?:[*•·]\s+|\d+[.)]\s+)/, '')
        .replace(/^-\s+(?=[+\-~!?]\s)/, '');
}

/**
 * A change line's text after its op and kind, as written (bold, backticks and a bullet in front are
 * decoration; a colon after the kind is drift): the whole of what a display kind shows (extras.js).
 */
export function lineBody(raw) {
    const line = stripDecoration(stripMarkdown(raw).trim()).trim();
    return line.replace(/^[+\-~!?]\s*\p{L}[\p{L}\p{N}_-]*\s*:?\s*/u, '');
}

function addLabel(labels, label, value) {
    const had = Object.hasOwn(labels, label) ? labels[label] : '';
    const next = had && value ? `${had}; ${value}` : (had || value);
    // "__proto__" would set the prototype even of a prototype-less object: define it as a key.
    Object.defineProperty(labels, label, { value: next, enumerable: true, writable: true, configurable: true });
}

// One line → { op, kind, name, text, labels } or { error }.
export function parseLine(source) {
    const line = stripDecoration(stripMarkdown(source).trim()).trim();
    const opMatch = /^([+\-~!?])\s*(.*)$/s.exec(line);
    if (!opMatch) return { error: 'it does not start with + - ~ ! or ?' };
    const op = opMatch[1];
    const kindMatch = /^(\p{L}[\p{L}\p{N}_-]*)\s*:?(?:\s+|$)(.*)$/su.exec(opMatch[2].trim());
    if (!kindMatch) return { error: 'there is no kind after the op' };
    const kind = kindMatch[1].toLowerCase();
    const [first, ...rest] = kindMatch[2].split('|');
    const dash = textDash(first);
    const name = (dash < 0 ? first : first.slice(0, dash)).trim();
    const texts = [dash < 0 ? '' : first.slice(dash + 1).trim()];
    if (!name) return { error: `the ${kind} has no name` };
    // No prototype: a label named "constructor" or "toString" is the line's own, never inherited.
    const labels = Object.create(null);
    for (const part of rest) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const found = labelled(trimmed);
        // A part with no label is more text, so nothing written is lost.
        if (found) {
            const label = found[0].trim().toLowerCase();
            if (kind === 'dm' && Object.hasOwn(labels, label)) return { error: `DM_LABEL: duplicate label ${label}` };
            addLabel(labels, label, found[1]);
        }
        else if (kind === 'dm') return { error: 'DM_LABEL: unused trailing text needs a declared label' };
        else texts.push(trimmed);
    }
    return { op, kind, name, text: texts.filter(Boolean).join('; '), labels };
}

/**
 * Parses change lines, one per line. Blank lines, code fences, the block's own tags and "none"
 * are skipped; any other line that is not a change goes to `problems` as a plain sentence.
 * Returns { lines: [{ op, kind, name, text, labels, raw, index }], problems: string[], over? }; `index`
 * is the line's place among the lines read (0-based), `raw` the line as written. With `max`, at most
 * that many written lines (change lines or not) are read; `over` = { count, total, first } tells the rest.
 */
export function parseChanges(text, { max = Infinity } = {}) {
    const lines = [];
    const problems = [];
    const sources = String(text ?? '').split(/\r?\n/);
    let read = 0;
    let over = null;
    for (let number = 0; number < sources.length; number += 1) {
        const raw = sources[number].trim();
        if (!raw || raw.startsWith('```') || raw.startsWith('~~~') || /^<\/?[A-Za-z_]+\s*>$/.test(raw) || NOTHING.test(raw)) continue;
        // Every line written counts against `max`, read or not (B-b5b-robust-r2-5): past it the rest are
        // counted, not read, and told once (`over`).
        read += 1;
        if (read > max) {
            over ??= { first: raw, count: 0 };
            over.count += 1;
            continue;
        }
        if (raw.length > MAX_LINE) {
            problems.push(`Line ${number + 1} "${cutAt(raw, 60)}…" is longer than ${MAX_LINE} characters, so it was not read.`);
            continue;
        }
        const parsed = parseLine(raw);
        if (parsed.error) problems.push(`Line ${number + 1} "${raw}" is not a change line: ${parsed.error}.`);
        else lines.push({ ...parsed, raw, index: lines.length });
    }
    return over ? { lines, problems, over: { ...over, total: read } } : { lines, problems };
}

export const KIND_WORD = /^\p{L}[\p{L}\p{N}_-]*$/u;

/**
 * The heads each kind's grammar line writes, from [{ kind, grammar }] (registry.contexts()' kinds):
 * a Set of "op kind" ("! encounter", "+ present", "- present").
 */
export function grammarHeads(kinds) {
    const heads = new Set();
    for (const entry of Array.isArray(kinds) ? kinds : []) {
        const word = String(entry?.kind ?? '').toLowerCase();
        if (!KIND_WORD.test(word)) continue;
        // A kind's own `heads` (registry.contexts()): taken as they are written, for a kind with no grammar line in the prompt.
        for (const head of Array.isArray(entry?.heads) ? entry.heads : []) if (typeof head === 'string' && new RegExp(`^[+\\-~!?] ${escapeRe(word)}$`, 'iu').test(head)) heads.add(head.toLowerCase());
        const re = new RegExp(`(?:^|[\\s(;,])([+\\-~!?]) ${escapeRe(word)}(?![\\p{L}\\p{N}_-])`, 'gu');
        for (const found of String(entry?.grammar ?? '').matchAll(re)) heads.add(`${found[1]} ${word}`);
    }
    return heads;
}
