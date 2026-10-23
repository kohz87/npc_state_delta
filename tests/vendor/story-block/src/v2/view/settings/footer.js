// The settings window's footer bar (UI stage, step 3e): "What's sent each reply", a slim bar at the bottom of every page that says what
// Story Suite adds to the next reply's prompt against its budget, and opens the Prompt card (Tabs & Packs) when it is pressed.
//
// It is read when the window opens, after a setting changed (`refresh()`: the window calls it from its own refresh) and when the
// story moves (a new head, a commit, a turn: `refreshSize()`), never while the reader types in the search box: reading the prompt
// assembles it, which costs more than a keystroke is worth. The estimate shows at once; SillyTavern's own count replaces it when it
// arrives (a stale answer never does: the newest read wins).
//
// Built with createElement and textContent only.

import { fill } from '../../strings.js';
import { PROMPT_TEXT, footerSummary } from './prompt.js';

const h = (doc, tag, className = '', text = '') => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== '' && text !== null && text !== undefined) node.textContent = String(text);
    return node;
};
const num = n => Number(n).toLocaleString('en-US');

/** `reader` is createPromptReader's; `onOpen()` shows the Prompt card. → { el, refresh(), summary(), destroy() }. */
export function createFooter(doc, { reader, onOpen }) {
    const root = h(doc, 'button', 'ss-settings-foot');
    root.type = 'button';
    root.id = 'story_suite_v2_footer';
    root.title = PROMPT_TEXT.footerTitle;
    const glyph = h(doc, 'i', 'fa-solid fa-scale-balanced ss-settings-foot-icon');
    glyph.setAttribute('aria-hidden', 'true');
    const label = h(doc, 'span', 'ss-settings-foot-label', PROMPT_TEXT.footerLabel);
    const meter = h(doc, 'span', 'ss-settings-foot-meter');
    meter.setAttribute('aria-hidden', 'true');
    const fill_ = h(doc, 'span', 'ss-settings-foot-fill');
    meter.appendChild(fill_);
    const value = h(doc, 'span', 'ss-settings-foot-value');
    const allText = h(doc, 'span', 'ss-settings-foot-all');
    const chevron = h(doc, 'i', 'fa-solid fa-chevron-right ss-settings-foot-go');
    chevron.setAttribute('aria-hidden', 'true');
    root.append(glyph, label, meter, value, allText, chevron);
    let run = 0;
    let last = { none: true };
    const paint = summary => {
        last = summary;
        if (summary.none) {
            value.textContent = PROMPT_TEXT.footerNone;
            allText.textContent = '';
            fill_.style.setProperty?.('--ss-fill', '0');
            root.setAttribute('aria-label', `${PROMPT_TEXT.footerLabel}: ${PROMPT_TEXT.footerNone}. ${PROMPT_TEXT.footerTitle}`);
            root.classList.remove('ss-settings-foot-over');
            return;
        }
        const text = fill(PROMPT_TEXT.footerValue, { tail: num(summary.tail), budget: num(summary.budget) });
        const all = fill(PROMPT_TEXT.footerAll, { total: num(summary.total) });
        value.textContent = text;
        allText.textContent = all;
        fill_.style.setProperty?.('--ss-fill', String(Math.round(summary.ratio * 1000) / 1000));
        root.classList.toggle('ss-settings-foot-over', summary.over);
        root.dataset.exact = String(summary.exact);
        root.setAttribute('aria-label', `${PROMPT_TEXT.footerLabel}: ${text} ${PROMPT_TEXT.footerNotes}, ${all}${summary.exact ? '' : ', estimated'}. ${PROMPT_TEXT.footerTitle}`);
    };
    function refresh() {
        const mine = ++run;
        const read = reader.read();
        paint(footerSummary(read));
        if (!read) return;
        reader.readExact(read).then(exact => {
            if (mine === run && exact) paint(footerSummary(exact));
        });
    }
    root.addEventListener('click', () => onOpen?.());
    refresh();
    return { el: root, refresh, summary: () => last, destroy() { run += 1; root.remove(); } };
}
