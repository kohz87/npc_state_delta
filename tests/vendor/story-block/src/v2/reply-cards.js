// Cards under replies (fix 8e): the socket a module uses to put a card under an assistant message (WIDGETS.md, "Cards under
// replies"; the README's "How modules connect" table). A module declares `cards: { <id>: { for(state, message, ctx) → card | null } }`.
// `for` is asked once per card, about the HEAD reply (the newest assistant message; in a chat that holds only the greeting, the
// greeting), with the head's state, its SillyTavern message object and `ctx.head === true`. When it answers, the card is drawn under
// the head reply with its actions enabled; older replies carry no module cards. So a card follows the story: a start card goes when
// the character exists, and a second fight's battle card sits under the newest reply, not the first fight's. A card the module
// stops returning goes away on the next draw (a character made, a fight ended); a swipe or a delete moves it with the head.
//
// A card: { tone: 'accent'|'bad'|'good'|'info', icon: 'ph-…' | 'fa-…', title, text?, rows?: [{ icon?, text, tag?, tagTone? }] (at most 4),
// actions?: [{ id, label, icon?, primary?, command?, payload?, open? }] (at most 4), later?: true|false }. An action runs its `command`
// (sdk.command, recorded with the reply) or opens its `open` screen in the game view; `later` adds a Later button that folds the card
// into one line. Text is plain: the host prints it, never parses it. `normalizeCard` drops what it cannot read; a card without a title
// is no card.
//
// The Later state is the viewer's (localStorage, per chat and card key): it is not game state, so it is never in a command or a save.
// It is cleared when the card stops being drawn, so a later card of the same id starts unfolded.
// Pure except for the storage that `laterStore` takes; no DOM.

import { oneLine } from '../text.js';
import { STRINGS, fill } from './strings.js';
import { activeDefinition, instanceOf } from './data-modules/adapters.js';
import { dmNameOf } from './data-modules/schema.js';

export const CARD_TONES = Object.freeze(['accent', 'bad', 'good', 'info']);
export const CARD_ROWS_MAX = 4;
export const CARD_ACTIONS_MAX = 4;
const ICON = /^(ph-[a-z0-9-]+(:fill)?|fa-[a-z0-9-]+)$/;
const COMMAND = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9_-]+)+$/i;
const LATER_KEY = 'story-block.replyCards.later';

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const iconOf = (value, fallback) => (typeof value === 'string' && ICON.test(value.trim()) ? value.trim() : fallback);

function rowOf(raw) {
    if (!isRecord(raw)) return null;
    const text = oneLine(raw.text ?? '', 120);
    if (!text) return null;
    const tag = oneLine(raw.tag ?? '', 24);
    return { icon: iconOf(raw.icon, ''), text, tag, tagTone: CARD_TONES.includes(raw.tagTone) ? raw.tagTone : 'info' };
}

// A payload as plain JSON (what a command or a dialog's draft takes), or {} when it cannot be copied (a loop, a BigInt, a getter that throws).
function payloadOf(value) {
    if (!isRecord(value)) return {};
    try {
        const copy = JSON.parse(JSON.stringify(value));
        return isRecord(copy) ? copy : {};
    } catch {
        return {};
    }
}

function actionOf(raw, at) {
    if (!isRecord(raw)) return null;
    // (32 code points, the way benchLabel counts: an emoji name must not lose its tail to a UTF-16 cut)
    const label = [...oneLine(raw.label ?? '', 128)].slice(0, 32).join('');
    const command = typeof raw.command === 'string' && COMMAND.test(raw.command) ? raw.command : '';
    const open = typeof raw.open === 'string' && /^[A-Za-z0-9._\-/]{1,120}$/.test(raw.open) ? raw.open : '';
    if (!label || (!command && !open)) return null;
    const id = oneLine(raw.id ?? '', 40) || `action-${at}`;
    return {
        id,
        label,
        icon: iconOf(raw.icon, ''),
        primary: raw.primary === true,
        command,
        payload: payloadOf(raw.payload),
        open,
    };
}

/** A module's card, read: { tone, icon, title, text, rows, actions, later } or null when it has no title. */
export function normalizeCard(raw) {
    if (!isRecord(raw)) return null;
    const title = oneLine(raw.title ?? '', 60);
    if (!title) return null;
    const rows = (Array.isArray(raw.rows) ? raw.rows : []).map(rowOf).filter(Boolean).slice(0, CARD_ROWS_MAX);
    const actions = (Array.isArray(raw.actions) ? raw.actions : []).map(actionOf).filter(Boolean).slice(0, CARD_ACTIONS_MAX);
    return {
        tone: CARD_TONES.includes(raw.tone) ? raw.tone : 'info',
        icon: iconOf(raw.icon, 'ph-star'),
        title,
        text: oneLine(raw.text ?? '', 200),
        rows,
        actions,
        later: raw.later === true,
    };
}

/**
 * The cards under the head reply: `entries` are the registry's [{ moduleId, id, fn }] (id: "<module>/<card>"), `head` the head
 * reply's index, `messageAt(index)` the message, `stateAt(index)` the state after it (asked once, shared by every card),
 * `query(name, args, state)` the queries. Each `fn(state, message, { index, head: true, chatId, query })` is asked once; a card that
 * throws (or whose words cannot be read) is left out and never stops the others. `onEnded(id)` hears of each card that answered
 * without a card. → Map head index → [{ key, card }] (empty when there is no head).
 */
export function scanReplyCards(entries, { head = -1, messageAt = () => null, stateAt = () => null, query = () => null, chatId = '', onEnded = null } = {}) {
    const out = new Map();
    if (!Number.isInteger(head) || head < 0) return out;
    const list = (Array.isArray(entries) ? entries : []).filter(entry => typeof entry?.fn === 'function');
    if (!list.length) return out;
    let state;
    let message = null;
    try {
        state = stateAt(head);
        message = messageAt(head);
    } catch {
        return out;
    }
    const found = [];
    for (const { id, fn } of list) {
        try {
            const card = normalizeCard(fn(state, message, { index: head, head: true, chatId, query: (name, args) => query(name, args, state) }));
            if (card) found.push({ key: id, card });
            else {
                try { onEnded?.(id); } catch { /* the caller's note never stops the scan */ }
            }
        } catch {
            // One module's card never stops the others.
        }
    }
    if (found.length) out.set(head, found);
    return out;
}

/**
 * The viewer's Later state: `laterStore(storage)` with storage { getItem, setItem } (localStorage by default). This page keeps its own
 * copy (read once), and each change is written to the storage when there is one; a storage that throws or holds junk is read as
 * nothing folded, and a change the storage refuses lasts this page only. Never throws.
 */
export function laterStore(storage) {
    let kept = null;
    // The default storage is read inside a try: a browser that refuses site data throws on `localStorage` itself.
    const area = () => {
        try { return storage === undefined ? globalThis.localStorage : storage; } catch { return null; }
    };
    const load = () => {
        if (kept) return kept;
        try {
            const parsed = JSON.parse(area()?.getItem?.(LATER_KEY) ?? '{}');
            kept = isRecord(parsed) ? parsed : {};
        } catch {
            kept = {};
        }
        return kept;
    };
    return {
        /** Whether the card (`${chatId}|${key}`: a chat and a card key, never a message index) is folded. */
        has: key => load()[key] === true,
        /** Folds (on) or opens the card. */
        set(key, on) {
            const all = load();
            if (on) all[key] = true;
            else delete all[key];
            try { area()?.setItem?.(LATER_KEY, JSON.stringify(all)); } catch { /* the choice lasts this page only */ }
        },
    };
}

/** Applied reader edits on one reply, in receipt order. Skipped replay blocks do not describe changes. */
export function replyEdits(record, problems = [], index = null) {
    const skipped = new Set((Array.isArray(problems) ? problems : []).filter(problem => index === null || problem?.index === index)
        .flatMap(problem => Array.isArray(problem?.receipts) ? problem.receipts : []));
    return (Array.isArray(record?.receipts) ? record.receipts : [])
        .filter(receipt => receipt?.data?.edit === true && !skipped.has(receipt.id))
        .map(receipt => ({ text: oneLine(receipt.summary ?? '', 200) })).filter(row => row.text);
}

// ---- Rule lines ("Guild standing: probation") ---------------------------------------------------------------------------------
// A receipt keeps only the ids of the rules that fired (data.v2.result.rules) and which block and subject it acted on (its guard).
// What a rule changed is read from the states instead of stored: the fields its effects write, in the module's state after this
// reply against the state before it. A rule that left those fields as they were says nothing.

const humanize = id => String(id).replace(/[-_]+/g, ' ').trim();
// A label starts in lower case after the block's name ("Standing" → "standing"), unless its first word is an acronym ("HP").
const lowerFirst = text => (/^[A-Z]{2,}\b/.test(text) ? text : text.charAt(0).toLowerCase() + text.slice(1));
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const shown = (schema, value) => (typeof value === 'string' ? value : dmNameOf(schema, value) ?? String(value));

/** The field names a list of effects writes, with the map key when the path names one: [{ field, key? }]. Reward templates count. */
function writtenBy(definition, effects, seen = new Set()) {
    const out = [];
    for (const effect of Array.isArray(effects) ? effects : []) {
        if (effect?.op === 'reward' && typeof effect.template === 'string' && !seen.has(effect.template)) {
            seen.add(effect.template);
            out.push(...writtenBy(definition, definition.rewards?.[effect.template]?.effects, seen));
        } else if (Array.isArray(effect?.path) && typeof effect.path[0] === 'string') {
            out.push({ field: effect.path[0], key: typeof effect.path[1] === 'string' ? effect.path[1] : null });
        }
    }
    return out;
}

/** The label a screen of the block gives a field (or a map's key): { 'field' | 'field.key': label }. */
function screenLabels(definition, module) {
    const labels = {};
    const visit = (node, row) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(child => visit(child, row)); return; }
        const bind = node.bind ?? node.value;
        let path = null;
        if (typeof node.label === 'string' && node.label.trim()) {
            if (bind?.query === 'dataModules.view' && bind.args?.module === module && typeof bind.path === 'string' && bind.path.startsWith('chat.')) path = bind.path.slice(5);
            else if (row && typeof bind === 'string' && bind.startsWith('$item.')) path = bind.slice(6);
        }
        if (path && !(path in labels)) labels[path] = node.label.trim();
        const rows = row || (definition.scope === 'character' && node.type === 'list' && node.bind?.args?.module === module && node.bind?.path === 'characters');
        visit(node.children, row);
        visit(node.item, rows);
        visit(node.pages, row);
        if (node.node) visit(node.node, row);
        if (node.root) visit(node.root, row);
    };
    for (const screen of Array.isArray(definition.screens) ? definition.screens : []) visit(screen?.layout?.root, false);
    return labels;
}

const defaultOf = (schema, key) => (schema?.type === 'map' ? schema.values?.default : schema?.default);

/** The lines for one fired rule of one block: [{ block, label, value }], one per field it changed between `before` and `after`. */
function changedByRule(definition, module, rule, subject, before, after, labels) {
    const read = (state, field) => {
        const fields = instanceOf(state, module, definition.scope === 'chat' ? 'chat' : subject)?.fields;
        return fields && Object.hasOwn(fields, field) ? fields[field] : undefined;
    };
    const block = oneLine((Array.isArray(definition.screens) ? definition.screens : []).find(screen => typeof screen?.title === 'string' && screen.title.trim())?.title ?? definition.name ?? module, 60);
    const out = [];
    for (const { field, key } of writtenBy(definition, rule.then)) {
        const schema = definition.state?.[field];
        if (!schema) continue;
        const now = read(after, field), was = read(before, field);
        if (now === undefined) continue;
        const pick = value => (schema.type === 'map' && key !== null && value && typeof value === 'object' ? value[key] : value);
        const had = was === undefined ? (schema.type === 'map' ? (key !== null ? defaultOf(schema) : Object.fromEntries((schema.keys ?? []).map(name => [name, defaultOf(schema)]))) : defaultOf(schema)) : was;
        const cells = schema.type === 'map' && key === null
            ? (schema.keys ?? Object.keys(now ?? {})).map(name => ({ key: name, now: now?.[name], was: had?.[name] }))
            : [{ key, now: pick(now), was: pick(had) }];
        for (const cell of cells) {
            if (same(cell.now, cell.was)) continue;
            const scalar = schema.type === 'map' ? schema.values : schema;
            const name = labels[cell.key ? `${field}.${cell.key}` : field] ?? labels[field] ?? (cell.key ? `${humanize(field)} ${cell.key}` : humanize(field));
            out.push({ block, label: oneLine(lowerFirst(name), 60), value: oneLine(shown(scalar, cell.now), 60) });
        }
    }
    return out;
}

/**
 * The rule lines of one reply: for each rule a data-module action fired, one line per field it changed: "<Block> <field>: <new value>".
 * `states` = { state, before }: the module state at this reply and at the carrier before it (null: the chat's start, every field at its
 * default). Without `state` nothing can be told, so no line. A rule that changed nothing has no line; the rule's id stays in the Inspector.
 */
export function replyRules(record, problems = [], index = null, states = {}) {
    const { state, before = null } = states ?? {};
    if (!state) return [];
    const skipped = new Set((Array.isArray(problems) ? problems : []).filter(problem => index === null || problem?.index === index)
        .flatMap(problem => Array.isArray(problem?.receipts) ? problem.receipts : []));
    const seen = new Set(), out = [];
    for (const receipt of Array.isArray(record?.receipts) ? record.receipts : []) {
        if (skipped.has(receipt?.id)) continue;
        const fired = receipt?.data?.v2?.result?.rules;
        const guard = receipt?.data?.v2?.guard?.predicate;
        if (!Array.isArray(fired) || typeof guard?.module !== 'string') continue;
        const module = guard.module, definition = activeDefinition(state, module);
        if (!definition) continue;
        const subject = guard.subject ?? 'chat', labels = screenLabels(definition, module);
        for (const id of fired) {
            const rule = (definition.rules ?? []).find(each => each.id === id);
            if (!rule) continue;
            for (const line of changedByRule(definition, module, rule, subject, before, state, labels)) {
                const text = fill(STRINGS.card.ruleField, line), key = `${module}|${subject}|${text}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push({ text, summary: text, kind: 'line', tone: 'accent', icon: 'fa-bolt', flag: '', note: '', check: null });
            }
        }
    }
    return out;
}

// ---- The one card under a reply ("This reply") ----------------------------------------------------------------------------
// Every module's card screen (mount `card`: "Changed this reply" and every other module's) is a
// section of one card. Closed, the card is one line: each section's own summary, joined with " · ". Pure; no DOM.

/** The key the one card carries (`data-ss-card`, and its open state per reply). */
export const THIS_REPLY_ID = 'this-reply';
/** Between one section's summary and the next on the closed line. */
export const SUMMARY_JOIN = ' · ';

/** The sections in order: the ids in `first` lead (in that order), the rest keep the order they came in. */
export function orderSections(entries, first = []) {
    const list = Array.isArray(entries) ? entries : [];
    const lead = (Array.isArray(first) ? first : []).flatMap(id => list.filter(entry => entry?.id === id));
    return [...lead, ...list.filter(entry => !lead.includes(entry))];
}

/** A section's small heading: the card's own title (its id when it has none). */
export function sectionHeading(entry) {
    return oneLine(entry?.screen?.title ?? '', 60) || String(entry?.id ?? '');
}

/** The closed line: the sections' summaries (empty ones left out) joined with " · ". */
export function mergeSummaries(parts) {
    return (Array.isArray(parts) ? parts : []).map(part => String(part ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(SUMMARY_JOIN);
}
