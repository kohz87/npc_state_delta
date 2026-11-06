// Draws the shared fight-board feature switch inside the existing Rolls settings card.
// The feature store remains the single source of truth for both settings pages.
import { h } from '../../view/widgets/dom.js';
import { switchField } from '../../view/form/fields.js';

export function boardSetting(doc, feature, changed) {
    const row = h(doc, 'div', 'rpg-board-setting');
    row.setAttribute('data-card', 'board');
    const copy = h(doc, 'div', 'rpg-board-setting-copy');
    copy.appendChild(h(doc, 'b', '', 'Fight board'));
    copy.appendChild(h(doc, 'p', 'rpg-set-help', 'Play fights exchange by exchange on the board; one reply tells the whole fight. Standard rules only.'));
    const field = switchField({ doc, ariaLabel: 'Fight board', value: feature.on(), onChange: value => { feature.set(value); changed(); } });
    row.append(copy, field.el);
    return row;
}
