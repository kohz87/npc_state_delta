// Story Suite v2: the "what is sent" figures of the settings host (moved out of host-ui.js unchanged; host-ui.js re-exports the
// public ones): the size of the prompt parts, the text of what a reply is sent with, and what a registry redacts from it.

import { estimateTokens, DEFAULT_TAIL_BUDGET } from '../prompt.js';
import { fill } from '../strings.js';
import { SETTINGS_TEXT } from './text.js';

/**
 * What Story Suite adds to the prompt, counted per module: `parts` as prompt.js assemble() gives them
 * ({ module, place, text }), `tokensOf(text)` → a number, `own` what modules send on their own (turn.js
 * previewFit's `own`: { module, label, text }). → { modules: [{ id, name, static, tail }], static, tail,
 * own: [{ id, name, tokens }], total, budget }. The totals count the texts as sent (joined), the rows
 * their own parts; `total` takes in the modules' own prompts.
 */
export function promptSize(parts, { tokensOf = estimateTokens, names = id => id, budget = DEFAULT_TAIL_BUDGET, own = [] } = {}) {
    const list = Array.isArray(parts) ? parts.filter(part => part && typeof part.text === 'string') : [];
    const rows = new Map();
    for (const part of list) {
        const id = String(part.module ?? '');
        if (!rows.has(id)) rows.set(id, { id, name: names(id), static: 0, tail: 0 });
        rows.get(id)[part.place === 'static' ? 'static' : 'tail'] += tokensOf(part.text);
    }
    const staticText = list.filter(part => part.place === 'static').map(part => part.text).join('\n\n');
    const tailText = list.filter(part => part.place !== 'static').map(part => part.text).filter(Boolean).join('\n');
    const stat = staticText ? tokensOf(staticText) : 0;
    const tail = tailText ? tokensOf(tailText) : 0;
    const ownRows = new Map();
    for (const part of ownParts(own)) {
        const id = String(part.module ?? '');
        if (!ownRows.has(id)) ownRows.set(id, { id, name: names(id), tokens: 0 });
        ownRows.get(id).tokens += tokensOf(part.text);
    }
    const ownTotal = [...ownRows.values()].reduce((sum, row) => sum + row.tokens, 0);
    return { modules: [...rows.values()], static: stat, tail, own: [...ownRows.values()], total: stat + tail + ownTotal, budget };
}

// turn.js previewFit's `own` list, its parts with text only.
const ownParts = own => (Array.isArray(own) ? own.filter(part => part && typeof part.text === 'string' && part.text) : []);

/**
 * The texts the next reply would get, as "Show what's sent" lists them: { static: [part], tail: [part],
 * own: [part] } (each part { module, label, text, dropped, counted }, empty texts left out unless lines were
 * dropped), and `copy`, all of it as one text: each section's heading, then its parts as sent (the
 * static ones joined by a blank line, the tail's by a line break, as prompt.js joins them).
 *
 * `redact(moduleId, text)` (optional) is what the reader may see of a part: the list, the drawing and `copy` use the
 * text it gives, never the raw one (`counted` keeps the raw text for token counts only; it is never drawn). The prompt
 * itself is not touched. See `redactSentOf`.
 */
export function sentText(parts, own = [], { names = id => id, redact = null } = {}) {
    const list = Array.isArray(parts) ? parts.filter(part => part && typeof part.text === 'string') : [];
    const T = SETTINGS_TEXT.sent;
    const shown = part => (typeof redact === 'function' && part.text ? redact(String(part.module ?? ''), part.text) : part.text);
    const stat = list.filter(part => part.place === 'static' && part.text);
    const tail = list.filter(part => part.place !== 'static' && (part.text || part.dropped));
    const titled = part => ({ module: String(part.module ?? ''), title: String(part.label ?? names(part.module)), text: shown(part), counted: part.text, dropped: Number(part.dropped) || 0 });
    const mine = ownParts(own).map(part => ({ ...titled(part), title: fill(T.part, { name: names(part.module), label: String(part.label ?? '') }) }));
    const statShown = stat.map(titled);
    const tailShown = tail.map(titled);
    const sections = [
        [T.static, statShown.map(part => part.text).join('\n\n')],
        [T.tail, tailShown.map(part => part.text).filter(Boolean).join('\n')],
        ...mine.map(part => [part.title, part.text]),
    ].filter(([, text]) => text);
    return { static: statShown, tail: tailShown, own: mine, copy: sections.map(([head, text]) => `[${head}]\n${text}`).join('\n\n') };
}

/**
 * The `redact(moduleId, text)` for sentText over a registry: a module with `hooks.redactSent(text)` says what the reader
 * sees of its text (NPC State Delta turns each locked note into "Mira: 1 hidden note"). Only the view and its copy use it. A hook that
 * throws, or answers anything but a string, shows the fixed "(hidden)" line, never the raw text. A module with no such hook is shown as sent.
 */
export function redactSentOf(registry) {
    return (moduleId, text) => {
        let hook;
        try { hook = registry?.module?.(moduleId)?.hooks?.redactSent; } catch { hook = null; }
        if (typeof hook !== 'function') return text;
        try {
            const shown = hook(text);
            return typeof shown === 'string' ? shown : SETTINGS_TEXT.sent.hidden;
        } catch {
            return SETTINGS_TEXT.sent.hidden;
        }
    };
}
