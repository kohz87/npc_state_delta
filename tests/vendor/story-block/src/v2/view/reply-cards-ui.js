// Story Suite v2: one card under a reply (fix 8e, reply-cards.js and Cards.dc.html): a glass card with a 1px ring in its tone, a 34px
// tone icon tile, the title and the muted text, the rows, and a button row (44px buttons, the primary one in the accent, at most
// three). Folded by Later it is one line: "<title> · <first row> · Open". Built with createElement and textContent only: a module's
// words are never parsed. A card is drawn under the head reply only, so its buttons are enabled; `head: false` (a caller that draws one
// elsewhere) shows them disabled, with the reason. Controls carry `data-focus` (line, later, action:<id>) so the mount can give the
// focus back to the same control when the card is drawn again.
//
// drawReplyCard(doc, { key, card }, { head, folded, onFold(on), onAct(action) }) → element.

import { STRINGS } from '../strings.js';
import { h, iconNode } from './widgets/dom.js';

const S = STRINGS.replyCards;

export function drawReplyCard(doc, { key, card }, { head = true, folded = false, onFold = () => {}, onAct = () => {} } = {}) {
    const root = h(doc, 'section', `ss-rc ss-rc-${card.tone}`);
    root.setAttribute('data-ss-reply-card', key);
    root.setAttribute('data-tone', card.tone);
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', card.title);
    if (folded) {
        const line = h(doc, 'button', 'ss-rc-line');
        line.type = 'button';
        line.setAttribute('data-focus', 'line');
        const first = card.rows[0]?.text || card.text || '';
        const label = [card.title, first, S.open].filter(Boolean).join(' · ');
        line.textContent = label;
        line.setAttribute('aria-label', label);
        line.setAttribute('aria-expanded', 'false');
        line.addEventListener('click', () => onFold(false));
        root.appendChild(line);
        return root;
    }
    const head0 = h(doc, 'div', 'ss-rc-head');
    const tile = h(doc, 'span', 'ss-rc-tile');
    const glyph = iconNode(doc, card.icon, 'ss-rc-glyph');
    if (glyph) tile.appendChild(glyph);
    const texts = h(doc, 'div', 'ss-rc-texts');
    texts.appendChild(h(doc, 'b', 'ss-rc-title', card.title));
    if (card.text) texts.appendChild(h(doc, 'p', 'ss-rc-text', card.text));
    head0.append(tile, texts);
    root.appendChild(head0);
    if (card.rows.length) {
        const rows = h(doc, 'ul', 'ss-rc-rows');
        for (const row of card.rows) {
            const li = h(doc, 'li', 'ss-rc-row');
            const icon = iconNode(doc, row.icon, 'ss-rc-row-icon');
            if (icon) li.appendChild(icon);
            li.appendChild(h(doc, 'span', 'ss-rc-row-text', row.text));
            if (row.tag) li.appendChild(h(doc, 'span', `ss-rc-tag ss-rc-tag-${row.tagTone}`, row.tag));
            rows.appendChild(li);
        }
        root.appendChild(rows);
    }
    const buttons = h(doc, 'div', 'ss-rc-actions');
    for (const action of card.actions) {
        const node = h(doc, 'button', action.primary ? 'ss-rc-action ss-rc-primary' : 'ss-rc-action');
        node.type = 'button';
        node.setAttribute('data-action', action.id);
        node.setAttribute('data-focus', `action:${action.id}`);
        const icon = iconNode(doc, action.icon, 'ss-rc-action-icon');
        if (icon) node.appendChild(icon);
        node.appendChild(h(doc, 'span', '', action.label));
        if (!head) {
            node.disabled = true;
            node.setAttribute('title', S.headOnly);
        }
        node.addEventListener('click', () => onAct(action));
        buttons.appendChild(node);
    }
    if (card.later) {
        const later = h(doc, 'button', 'ss-rc-action ss-rc-later', S.later);
        later.type = 'button';
        later.setAttribute('data-focus', 'later');
        later.addEventListener('click', () => onFold(true));
        buttons.appendChild(later);
    }
    if (buttons.children.length) root.appendChild(buttons);
    return root;
}
