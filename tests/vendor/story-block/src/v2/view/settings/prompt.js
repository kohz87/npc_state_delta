// The Prompt card of the Tabs & Packs page (UI stage, step 3e) and the footer bar's numbers: what Story Suite adds to the prompt of
// the next reply, counted now. Nothing is sent from here and nothing is stored but the budgets.
//
// * Budgets: the host's own `tailBudget` (a slider), `contextShare` (a slider) and `maxChangeLines` (a number), the form engine over
//   HOST_SETTINGS_SCHEMA, written through the same settings store as the Story Suite fold wrote through.
// * Prompt size: the estimate (four characters a token) at once, then SillyTavern's tokenizer's own counts when there is one: the
//   context size and Story Suite's share of it, the static part, this reply's part against its budget (a meter), what modules
//   send on their own, the total, and a table per module.
// * "Show what's sent": the exact text of each part, per module, with Copy (drawn while it is open: the texts are long).
//
// `createPromptReader` is the one reader of all this: the card and the window's footer bar both use it, so they always say the same.
// Every node is built with textContent; module names and texts are never markup.

import { SETTINGS_TEXT, SENT_FOLD, promptSize, sentText } from '../../host-ui.js';
import { HOST_SETTINGS_SCHEMA } from '../../sdk.js';
import { DEFAULT_TAIL_BUDGET, contextNotice, estimateTokens } from '../../prompt.js';
import { fill } from '../../strings.js';
import { renderSettingsForm } from '../form/form.js';
import { sectionBlock } from '../form/fields.js';
import { matchesSearch } from '../form/schema.js';
import { focusNode, revealIn, showAndFocus } from '../scroll.js';

/** The fold key of the whole card (the Story Suite fold's old size block), and the host settings it draws. */
export const PROMPT_FOLD = 'story-suite::size';
export const PROMPT_KEYS = Object.freeze(['tailBudget', 'contextShare', 'maxChangeLines']);

export const PROMPT_TEXT = Object.freeze({
    title: 'Prompt',
    hint: 'what Story Suite adds to each reply',
    budgets: 'Budgets',
    footerLabel: 'What\'s sent each reply',
    footerNone: 'Open a chat to see it',
    footerValue: '{tail} of {budget} tokens',
    footerNotes: 'for the notes',
    footerAll: '{total} in all',
    footerTitle: 'Show what Story Suite adds to each reply',
});

// The budgets as sliders and a number (HOST_SETTINGS_SCHEMA's own bounds): the notes' budget in steps of 50 up to a
// slider's reach (a larger stored value stretches it), the share in steps of 5.
export const PROMPT_SCHEMA = Object.freeze({
    tailBudget: Object.freeze({ ...HOST_SETTINGS_SCHEMA.tailBudget, group: PROMPT_TEXT.budgets, form: 'slider', sliderMax: 6000, step: 50, unit: ' tokens' }),
    contextShare: Object.freeze({ ...HOST_SETTINGS_SCHEMA.contextShare, group: PROMPT_TEXT.budgets, form: 'slider', step: 5, unit: '%' }),
    maxChangeLines: Object.freeze({ ...HOST_SETTINGS_SCHEMA.maxChangeLines, group: PROMPT_TEXT.budgets }),
});

const el = (doc, tag, className = '', text = '') => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== '' && text !== null && text !== undefined) node.textContent = String(text);
    return node;
};
const ownParts = own => (Array.isArray(own) ? own.filter(part => part && typeof part.text === 'string' && part.text) : []);
const num = n => Number(n).toLocaleString('en-US');

/**
 * The reader of the prompt's size. `promptParts()` is the turn's preview ({ parts, fit, own } or a bare parts list; it throws
 * or answers nothing with no chat open), `countTokens(text)` SillyTavern's tokenizer (optional, may be async).
 * → { available, read(), readExact(base) }:
 *   `read()` → null (no chat to read) or { parts, fit, own, budget, size, exact: false, names } at once, counted at four
 *   characters a token; `readExact(base)` → a promise of the same with the tokenizer's counts and `exact: true`, or null when it
 *   cannot count (the estimate stays).
 */
export function createPromptReader({ registry, settings, promptParts = null, countTokens = null }) {
    const names = id => (id === 'story-suite' ? 'Story Suite' : registry?.module?.(id)?.name ?? id);
    const tailBudget = () => {
        const value = settings()?.tailBudget;
        return Number.isInteger(value) && value > 0 ? value : DEFAULT_TAIL_BUDGET;
    };
    const available = typeof promptParts === 'function';
    function read() {
        if (!available) return null;
        let parts = null;
        let fit = null;
        let own = [];
        try {
            const got = promptParts();
            parts = Array.isArray(got) ? got : got?.parts;
            fit = Array.isArray(got) ? null : got?.fit ?? null;
            own = Array.isArray(got?.own) ? got.own : [];
        } catch { parts = null; }
        if (!Array.isArray(parts)) return null;
        // A small context cuts the notes' budget (prompt.js contextFit).
        const budget = Number.isInteger(fit?.budget) ? fit.budget : tailBudget();
        return { parts, fit, own, budget, names, exact: false, tokensOf: estimateTokens, size: promptSize(parts, { names, budget, own }) };
    }
    async function readExact(base) {
        if (typeof countTokens !== 'function' || !base) return null;
        const { parts, own, budget } = base;
        // SillyTavern's tokenizer: every text counted once, then the same sums with its numbers.
        const texts = [...new Set([
            ...parts.map(part => String(part?.text ?? '')),
            parts.filter(part => part?.place === 'static').map(part => part.text).join('\n\n'),
            parts.filter(part => part?.place !== 'static').map(part => part.text).filter(Boolean).join('\n'),
            ...ownParts(own).map(part => part.text),
        ])];
        try {
            const counts = await Promise.all(texts.map(text => Promise.resolve().then(() => countTokens(text))));
            if (!counts.every(n => Number.isFinite(n) && n >= 0)) return null;
            const known = new Map(texts.map((text, at) => [text, Math.round(counts[at])]));
            const tokensOf = text => known.get(text) ?? estimateTokens(text);
            return { ...base, exact: true, tokensOf, size: promptSize(parts, { names, budget, own, tokensOf }) };
        } catch { return null; }
    }
    return { available, read, readExact };
}

/** The footer bar's numbers from a read: { none: true } with no chat, else { tail, budget, total, exact, over, ratio }. */
export function footerSummary(read) {
    if (!read) return { none: true };
    const { size, budget } = read;
    return { none: false, tail: size.tail, budget, total: size.total, exact: read.exact, over: size.tail > budget, ratio: budget > 0 ? Math.min(1, size.tail / budget) : 0 };
}

// "Show what's sent": a sub-fold under the size, every part's exact text by place with its size and Copy (the clipboard, else the
// text is selected for copying by hand). It only reads. The texts are drawn only while it is open.
function sentFold(doc, state, openState) {
    const T = SETTINGS_TEXT.sent;
    const details = el(doc, 'details', 'story-suite-subfold story-suite-sent');
    details.dataset.fold = SENT_FOLD;
    const summary = el(doc, 'summary');
    summary.append(el(doc, 'b', '', T.title), el(doc, 'small', '', T.hint));
    const body = el(doc, 'div', 'story-suite-subfold-body');
    details.append(summary, body);
    details.open = openState?.get(SENT_FOLD) === true;
    const draw = () => {
        if (!details.open || body.children.length) return;
        drawSent(doc, body, sentText(state.read.parts, state.read.own, { names: state.read.names }), state.read.tokensOf, state.read.exact);
    };
    details.addEventListener('toggle', () => {
        openState?.set(SENT_FOLD, details.open === true);
        draw();
    });
    // Opening it from outside (the footer bar, `openSettings({ fold: SENT_FOLD })`): open and draw now, not at the browser's own toggle.
    details.ssOpen = () => {
        details.open = true;
        openState?.set(SENT_FOLD, true);
        draw();
    };
    draw();
    return details;
}

function drawSent(doc, body, text, tokensOf, exact) {
    const T = SETTINGS_TEXT.sent;
    body.appendChild(el(doc, 'p', 'story-suite-muted', T.help));
    const actions = el(doc, 'div', 'story-suite-sent-actions');
    const copy = el(doc, 'button', 'menu_button story-suite-sent-copy');
    copy.type = 'button';
    copy.title = T.copyTitle;
    copy.setAttribute('aria-label', T.copyTitle);
    const glyph = el(doc, 'i', 'fa-solid fa-copy');
    glyph.setAttribute('aria-hidden', 'true');
    copy.append(glyph, el(doc, 'span', '', T.copy));
    const status = el(doc, 'span', 'story-suite-sent-status');
    status.setAttribute('role', 'status');
    actions.append(copy, status);
    body.appendChild(actions);
    const texts = el(doc, 'div', 'story-suite-sent-texts');
    const sections = [['static', T.static, text.static], ['tail', T.tail, text.tail]];
    if (text.own.length) sections.push(['own', T.own, text.own]);
    for (const [place, heading, list] of sections) {
        const section = el(doc, 'section', 'story-suite-sent-section');
        section.dataset.place = place;
        section.appendChild(el(doc, 'h5', '', heading));
        if (!list.length) section.appendChild(el(doc, 'p', 'story-suite-muted', T.nothing));
        for (const part of list) {
            const item = el(doc, 'div', 'story-suite-sent-part');
            item.dataset.module = part.module;
            const n = part.text ? tokensOf(part.text) : 0;
            const head = el(doc, 'p', 'story-suite-sent-head');
            head.append(el(doc, 'b', '', part.title), doc.createTextNode(' · '), el(doc, 'small', '', fill(exact ? T.tokens : T.about, { n: num(n) })));
            item.appendChild(head);
            if (part.text) {
                const pre = el(doc, 'pre', 'story-suite-sent-text', part.text);
                pre.tabIndex = 0;
                pre.setAttribute('aria-label', fill(T.textLabel, { part: part.title }));
                item.appendChild(pre);
            }
            if (part.dropped) item.appendChild(el(doc, 'p', 'story-suite-muted story-suite-sent-dropped', part.dropped === 1 ? T.droppedOne : fill(T.dropped, { n: part.dropped })));
            section.appendChild(item);
        }
        texts.appendChild(section);
    }
    body.appendChild(texts);
    copy.addEventListener('click', async () => {
        const clipboard = (doc.defaultView ?? globalThis).navigator?.clipboard;
        try {
            if (typeof clipboard?.writeText !== 'function') throw new Error('no clipboard');
            await clipboard.writeText(text.copy);
            status.textContent = T.copied;
        } catch {
            const win = doc.defaultView ?? globalThis;
            const range = doc.createRange?.();
            const selection = win.getSelection?.();
            if (range && selection) {
                range.selectNodeContents(texts);
                selection.removeAllRanges();
                selection.addRange(range);
            }
            status.textContent = T.copyFailed;
        }
    });
}

/** Paints the size into `block`: the sums, the meter, the per-module table, then "Show what's sent". */
export function paintSize(doc, block, read, openState = null) {
    const T = SETTINGS_TEXT.size;
    const { size, exact, fit } = read;
    const amount = n => fill(exact ? T.exact : T.about, { n: num(n) });
    const list = el(doc, 'ul', 'story-suite-size-sum');
    const line = (label, value, className = '') => {
        const item = el(doc, 'li', className);
        item.append(el(doc, 'span', '', label), el(doc, 'b', 'story-suite-size-n', value));
        list.appendChild(item);
        return item;
    };
    // The context size and the share Story Suite may take of it (the notes' budget follows from it).
    if (fit) {
        line(T.context, fit.reply ? fill(T.contextReply, { n: num(fit.size), reply: num(fit.reply) }) : fill(T.contextValue, { n: num(fit.size) }), 'story-suite-size-context');
        const share = line(T.share, fill(T.shareValue, { share: num(fit.share), room: num(fit.room), percent: fit.percent }), 'story-suite-size-share');
        if (fit.tooSmall) share.classList.add('story-suite-size-over');
    }
    line(T.static, amount(size.static));
    const tail = line(T.tail, fill(T.ofBudget, { size: amount(size.tail), budget: num(size.budget) }), 'story-suite-size-tail');
    const meter = el(doc, 'meter', 'story-suite-size-meter');
    meter.min = 0;
    meter.max = size.budget;
    meter.value = Math.min(size.tail, size.budget);
    meter.setAttribute('aria-label', T.tail);
    tail.appendChild(meter);
    if (size.tail > size.budget) tail.classList.add('story-suite-size-over');
    // What modules send on their own (NPC State Delta's dossiers): a row each, counted in the total.
    for (const row of size.own ?? []) {
        const item = line(fill(T.own, { name: row.name }), amount(row.tokens), 'story-suite-size-own');
        item.dataset.module = row.id;
    }
    line(T.total, amount(size.total), 'story-suite-size-total');
    const table = el(doc, 'table', 'story-suite-size-table');
    table.appendChild(el(doc, 'caption', '', T.perModule));
    const head = el(doc, 'tr');
    for (const name of [T.module, T.staticShort, T.tailShort]) {
        const cell = el(doc, 'th', '', name);
        cell.setAttribute('scope', 'col');
        head.appendChild(cell);
    }
    const thead = el(doc, 'thead');
    thead.appendChild(head);
    const tbody = el(doc, 'tbody');
    for (const row of size.modules) {
        const tr = el(doc, 'tr');
        tr.dataset.module = row.id;
        const name = el(doc, 'th', '', row.name);
        name.setAttribute('scope', 'row');
        tr.append(name, el(doc, 'td', '', num(row.static)), el(doc, 'td', '', num(row.tail)));
        tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    block.dataset.exact = String(exact);
    const warn = fit?.tooSmall ? el(doc, 'p', 'story-suite-size-warn', contextNotice(fit)) : null;
    if (warn) warn.setAttribute('role', 'status');
    block.replaceChildren(...[
        el(doc, 'p', 'story-suite-muted', T.help),
        warn,
        list,
        table,
        fit ? null : el(doc, 'p', 'story-suite-muted story-suite-size-context-unknown', T.contextUnknown),
        el(doc, 'p', 'story-suite-muted story-suite-size-how', exact ? T.howExact : T.howAbout),
        sentFold(doc, { read }, openState),
    ].filter(Boolean));
}

/**
 * The Prompt card: the budgets (the form engine) and the size under them. `reader` is createPromptReader's; `onChange()` is told
 * after a budget changed (the footer bar and the other pages follow); `openState` keeps "Show what's sent" open across redraws.
 * → { el, refresh(), filter(text), destroy(), focus(), openSent() }.
 */
export function renderPromptCard(parent, { doc, settings, reader, openState = new Map(), onChange = null }) {
    const card = sectionBlock(doc, { title: PROMPT_TEXT.title, hint: PROMPT_TEXT.hint, id: 'ss_prompt_card' });
    card.el.classList.add('ss-prompt-card');
    card.el.dataset.fold = PROMPT_FOLD;
    const form = renderSettingsForm(card.body, { moduleId: null, schema: PROMPT_SCHEMA, settings, doc, quiet: true, className: 'ss-prompt-form', onChange: () => { draw(); onChange?.(); } });
    const block = el(doc, 'div', 'story-suite-subsection story-suite-size');
    block.setAttribute('aria-live', 'polite');
    card.body.appendChild(block);
    parent.appendChild(card.el);
    let run = 0;
    function draw() {
        const mine = ++run;
        const read = reader.read();
        if (!read) {
            block.replaceChildren(el(doc, 'p', 'story-suite-muted', SETTINGS_TEXT.size.none));
            return;
        }
        paintSize(doc, block, read, openState);
        reader.readExact(read).then(exact => {
            if (mine === run && exact) paintSize(doc, block, exact, openState);
        });
    }
    draw();
    return {
        el: card.el,
        refresh() {
            form.refresh();
            draw();
        },
        filter(text) {
            const query = String(text ?? '').trim();
            const shown = form.filter(text);
            const match = matchesSearch('prompt.size', { label: `${PROMPT_TEXT.title} ${SETTINGS_TEXT.size.title}`, help: SETTINGS_TEXT.size.help }, 'Prompt', text);
            // The card stays while any of its rows or its size matches; the size alone is shown with its heading.
            card.setHidden(Boolean(query) && !shown && !match);
            block.hidden = Boolean(query) && !match;
            return shown + (query && match ? 1 : 0);
        },
        destroy() {
            run += 1;
            form.destroy();
            card.el.remove();
        },
        field: key => form.field(key),
        keys: () => form.keys(),
        focus() {
            const first = form.keys()[0];
            const input = first ? form.field(first).row.querySelector('input, select, button') : null;
            return showAndFocus(input, 'center');
        },
        openSent() {
            const details = block.querySelector('details.story-suite-sent');
            if (!details) return false;
            details.ssOpen();
            revealIn(null, details, 'start');
            focusNode(details.querySelector('summary'));
            return true;
        },
    };
}
