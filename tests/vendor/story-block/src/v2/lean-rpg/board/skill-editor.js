// Draws the three optional board flags inside the existing skill editor.
// The draft belongs to that editor; saving it uses the reply-owned board skill command.
// Labels and checkbox state are text and booleans, never markup from the skill.

import { h } from '../../view/widgets/dom.js';

export function drawSkillFlags(doc, parent, draft) {
    const fieldset = h(doc, 'fieldset', 'rpg-board-skill-flags');
    fieldset.appendChild(h(doc, 'legend', '', 'Fight board'));
    for (const [key, label] of [['target', 'One foe'], ['area', 'Every foe in reach'], ['defence', 'Automatic defence']]) {
        const row = h(doc, 'label', 'rpg-board-skill-flag');
        const check = h(doc, 'input');
        check.setAttribute('type', 'checkbox');
        check.setAttribute('data-board-flag', key);
        check.checked = draft[key];
        check.addEventListener('change', () => { draft[key] = check.checked; });
        row.append(check, h(doc, 'span', '', label));
        fieldset.appendChild(row);
    }
    parent.appendChild(fieldset);
}
