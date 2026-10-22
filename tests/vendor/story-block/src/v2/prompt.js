// Prompt assembly (docs/v2/SPEC.md §5): the two texts Story Block sends for every ordinary reply.
//
// - static: the change-line instruction (a fixed header, then each module's kind grammar in
//   module-id order) and each module's context.static() in module-id order. It never reads the
//   state, so it is byte-identical reply after reply and a provider's prompt cache keeps it.
// - tail: `[Happened]` with one code-written line per untold receipt, then each module's
//   context.tail(view) in the fixed order scene, inventory, party, combat, trade, director, then
//   other modules by id; sent last (depth 0), where text that changes belongs.
//
// Budgets are tokens estimated at four characters each. A module's optional lines go first when
// it is over its own budget, then its last lines; past the host's total budget the same happens
// from the last module back. The first [Happened] lines are never dropped: they are what the reply
// must tell. Past half the total budget (and the first MIN_HAPPENED of them) the rest are told as one
// counted line, "…and N more things happened." Names (`{{user}}`, `{{char}}`) are filled in before
// anything is counted, so a long name cannot push a text past its budget. Pure: no DOM, no SillyTavern.
//
// The context size (final soak): SillyTavern fits the extension prompts first and drops the conversation
// when the rest no longer fits, so Story Suite in all (static + tail) is held to a share of the room the
// prompt has (the context size less the reply's length; `contextShare` percent, default 40). Only the
// tail is cut for it, never below MIN_TAIL_BUDGET: the static part stays byte-identical reply to reply.
// When the static part alone is over the share, `fit.tooSmall` says so (turn.js tells the reader).
// What a module sends on its own (NPC State Delta's dossiers, under its own prompt keys; its
// `ownPrompt` hook says what, turn.js ownPrompt) counts toward the share too: the tail gets what the
// static part and that leave, still never below MIN_TAIL_BUDGET. It never cuts the static part.

export const TAIL_ORDER = Object.freeze(['scene', 'inventory', 'party', 'combat', 'trade', 'director']);
export const DEFAULT_TAIL_BUDGET = 1500;
// The most of the prompt's room (percent) Story Suite's static and tail may take together, by default.
export const DEFAULT_CONTEXT_SHARE = 40;
export const CONTEXT_SHARE_MIN = 10;
export const CONTEXT_SHARE_MAX = 90;
// A tail cut for a small context keeps at least this many tokens (the [Happened] lines and the first
// required lines are what the reply must tell).
export const MIN_TAIL_BUDGET = 200;
export const HAPPENED = '[Happened]';
// [Happened] lines always kept, however long they are; the rest share half the tail budget.
export const MIN_HAPPENED = 5;
// The static header's first line; turn.js looks for it to tell whether SillyTavern sent it.
export const STATIC_MARKER = '[Story Suite: how this story is kept]';

const HEADER = [
    STATIC_MARKER,
    'Code keeps this story\'s facts and numbers; you narrate.',
    `When a note starts with ${HAPPENED}, those things have just happened: tell them as they happen in the scene and keep their numbers. Do not write them again as changes.`,
].join('\n');

const CHANGES_HEADER = [
    'At the very end of your reply, after the story, list what changed in one block, one change per line:',
    '<Changes>',
    'op kind Name — what happened | label: value',
    '</Changes>',
    'op: + new or gained, - gone or lost, ~ changed, ! happened, ? asks code to decide (a check, a roll).',
    'Use only the kinds below. Leave out what did not change, and the whole block when nothing did.',
    'This is the only block you write: no state, inventory or party blocks; code keeps those and shows them to you.',
    'Write it outside any thinking, once. It does not count toward any reply length limit.',
    'Kinds:',
].join('\n');

/** Tokens in `text`, estimated at four characters each. */
export const estimateTokens = text => Math.ceil(String(text ?? '').length / 4);

const linesOf = value => (Array.isArray(value) ? value : [])
    .filter(line => typeof line === 'string')
    .map(line => line.trimEnd())
    .filter(line => line.trim());

function attempt(fn, fallback, problems, what) {
    try { return fn(); } catch (error) {
        problems.push(`${what} failed: ${error?.message ?? error}`);
        return fallback;
    }
}

// Where a module's tail goes: by the earliest fixed-order domain it owns, else after them.
function rank(context) {
    const ranks = context.domains.map(domain => TAIL_ORDER.indexOf(domain)).filter(index => index >= 0);
    return ranks.length ? Math.min(...ranks) : TAIL_ORDER.length;
}

/** The modules' contexts in tail order (fixed domains first, then by id). */
export function tailOrder(contexts) {
    return [...contexts].sort((a, b) => rank(a) - rank(b) || (a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : 0));
}

/**
 * The static text alone (header + kind grammar + module statics), built from the registry only.
 * `problems` collects what failed (a throwing static() is left out, logged there).
 */
export function staticParts(registry, problems = []) {
    const contexts = registry.contexts();
    const kinds = contexts.flatMap(context => context.kinds.map(kind => kind.grammar));
    const header = kinds.length ? `${HEADER}\n${CHANGES_HEADER}\n${kinds.join('\n')}` : HEADER;
    const parts = [{ module: 'story-suite', label: 'Story Suite: instructions', place: 'static', text: header }];
    for (const context of contexts) {
        if (typeof context.static !== 'function') continue;
        const text = attempt(() => context.static(), '', problems, `${context.name}: instructions`);
        const clean = typeof text === 'string' ? text.trim() : '';
        if (clean) parts.push({ module: context.moduleId, label: `${context.name}: instructions`, place: 'static', text: clean });
    }
    return parts;
}

// Drops lines from `section` until its text fits `budget` tokens: optional ones from the end,
// then required ones from the end. Returns how many it dropped.
function fit(section, budget) {
    let dropped = 0;
    const cost = () => estimateTokens([...section.lines, ...section.optional].join('\n'));
    while (cost() > budget && section.optional.length) { section.optional.pop(); dropped += 1; }
    while (cost() > budget && section.lines.length) { section.lines.pop(); dropped += 1; }
    return dropped;
}

// The [Happened] lines that fit `budget` tokens (at least the first MIN_HAPPENED), the rest told as
// one counted line.
function happenedLines(lines, budget) {
    const out = [HAPPENED];
    let cost = estimateTokens(HAPPENED);
    for (let i = 0; i < lines.length; i += 1) {
        const left = lines.length - i;
        const next = estimateTokens(lines[i]) + 1;
        // Room is kept for the closing line whenever lines would be left over.
        const closing = left > 1 ? estimateTokens(`…and ${left - 1} more things happened.`) + 1 : 0;
        if (i >= MIN_HAPPENED && cost + next + closing > budget) {
            out.push(left === 1 ? '…and 1 more thing happened.' : `…and ${left} more things happened.`);
            return out;
        }
        out.push(lines[i]);
        cost += next;
    }
    return out;
}

/**
 * How Story Suite fits the context: `context` = { size, reply, room } (the context size the reader set, the
 * reply's length or null, the tokens the prompt may take; turn.js contextRoom) or null when not known,
 * `staticTokens` the static part's size, `settings` the host settings ({ tailBudget, contextShare }),
 * `ownTokens` what modules send on their own (their `ownPrompt` hooks; 0 by default).
 * → { size, reply, room, percent, share, static, own, budget, tooSmall } or null (no context known: the
 * tail budget is the setting's).
 */
export function contextFit(context, staticTokens, settings = {}, ownTokens = 0) {
    const tail = Number.isInteger(settings?.tailBudget) && settings.tailBudget > 0 ? settings.tailBudget : DEFAULT_TAIL_BUDGET;
    const room = Number(context?.room);
    if (!Number.isFinite(room) || room <= 0) return null;
    const asked = settings?.contextShare;
    const percent = Number.isInteger(asked) ? Math.min(CONTEXT_SHARE_MAX, Math.max(CONTEXT_SHARE_MIN, asked)) : DEFAULT_CONTEXT_SHARE;
    const share = Math.floor(room * percent / 100);
    const own = Number.isFinite(Number(ownTokens)) && Number(ownTokens) > 0 ? Math.round(Number(ownTokens)) : 0;
    const budget = Math.min(tail, Math.max(MIN_TAIL_BUDGET, share - staticTokens - own));
    const size = Number.isFinite(Number(context.size)) && Number(context.size) > 0 ? Math.round(Number(context.size)) : Math.round(room);
    const reply = Number.isFinite(Number(context.reply)) && Number(context.reply) > 0 ? Math.round(Number(context.reply)) : null;
    return { size, reply, room: Math.round(room), percent, share, static: staticTokens, own, budget, tooSmall: staticTokens > share };
}

/** What the reader is told when the static part alone is over the share (`fit` from contextFit). */
export function contextNotice(fit) {
    const n = value => Math.round(Number(value) || 0).toLocaleString('en-US');
    return `Your context size (${n(fit?.size)} tokens) is too small for Story Suite's instructions (about ${n(fit?.static)} tokens). Raise the context size or turn features off.`;
}

/**
 * Builds both texts for the next reply.
 * - `registry`: createRegistry() result; `view`: { state, query, settings, chat } (§6).
 * - `untold`: receipts to tell (oldest first); only those with narrate !== false and a summary.
 * - `settings`: the host settings ({ tailBudget } in tokens, default 1500; { contextShare } percent, 40).
 * - `context` (optional): { size, reply, room } of the reader's context (contextFit); the tail is cut so
 *   static + tail fit the share, the static part never is.
 * - `cues` (optional): { [moduleId]: string[] } extra required tail lines (beforeGenerate hooks).
 * - `substitute` (optional): text → text, run on every text before it is counted (turn.js fills in
 *   `{{user}}` and `{{char}}` with it).
 * - `ownTokens` (optional): what modules send on their own this reply (contextFit), 0 by default.
 * Returns { staticText, tailText, parts: [{ module, label, place, text, tokens, dropped? }],
 * problems, fit (contextFit, or null) }. `parts` is what the What's-sent preview lists, in prompt order.
 */
export function assemble({ registry, view, untold = [], settings = {}, cues = {}, substitute = null, context = null, ownTokens = 0 }) {
    const problems = [];
    const fill = typeof substitute === 'function' ? text => String(substitute(text) ?? '') : text => text;
    const statics = staticParts(registry, problems).map(part => ({ ...part, text: fill(part.text) }));
    const staticText = statics.map(part => part.text).join('\n\n');
    const fitted = contextFit(context, estimateTokens(staticText), settings, ownTokens);
    const total = fitted ? fitted.budget
        : Number.isInteger(settings?.tailBudget) && settings.tailBudget > 0 ? settings.tailBudget : DEFAULT_TAIL_BUDGET;

    const happened = untold
        .filter(receipt => receipt && receipt.narrate !== false && typeof receipt.summary === 'string' && receipt.summary.trim())
        .map(receipt => fill(receipt.summary).trim().split(/\n/).map(part => part.trim()).filter(Boolean).join(' '));
    const head = happened.length
        ? { module: 'story-suite', label: 'Happened', text: happenedLines(happened, Math.floor(total / 2)).join('\n') }
        : null;

    const sections = [];
    for (const context of tailOrder(registry.contexts())) {
        const extra = linesOf(cues?.[context.moduleId]);
        let tail = null;
        if (typeof context.tail === 'function') tail = attempt(() => context.tail(view), null, problems, `${context.name}: this reply`);
        const section = { context, lines: linesOf([...extra, ...linesOf(tail?.lines)].map(fill)), optional: linesOf(linesOf(tail?.optional).map(fill)), dropped: 0 };
        if (!section.lines.length && !section.optional.length) continue;
        if (context.budget) section.dropped += fit(section, context.budget);
        sections.push(section);
    }

    // The host's total: what the sections may spend after [Happened] (and the line breaks).
    const tailText = () => [head?.text, ...sections.map(section => [...section.lines, ...section.optional].join('\n'))]
        .filter(Boolean).join('\n');
    for (const pass of ['optional', 'lines']) {
        for (let i = sections.length - 1; i >= 0 && estimateTokens(tailText()) > total; i -= 1) {
            const list = sections[i][pass];
            while (list.length && estimateTokens(tailText()) > total) { list.pop(); sections[i].dropped += 1; }
        }
    }

    const tailParts = [
        ...(head ? [{ ...head, place: 'tail' }] : []),
        ...sections
            .map(section => ({
                module: section.context.moduleId,
                label: `${section.context.name}: this reply`,
                place: 'tail',
                text: [...section.lines, ...section.optional].join('\n'),
                dropped: section.dropped,
            }))
            .filter(part => part.text || part.dropped),
    ];
    const parts = [...statics, ...tailParts].map(part => ({ ...part, tokens: estimateTokens(part.text) }));
    return { staticText, tailText: tailText(), parts, problems, fit: fitted };
}
