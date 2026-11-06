// The Blocks page's words and small format helpers (moved out of screens/blocks.js unchanged): the singular/plural
// count name, the Show as value and the words under a block's name. The page imports them; the card view imports S.

import { STRINGS, fill } from '../../strings.js';

export const S = STRINGS.blocks;
export const P = S.page;

// Whole values min..max all named (a choice can list them): else the number is typed and shown by its name where it has one.
export const plural = (n, word) => `${n} ${n === 1 ? word.one : word.other}`;
// Where a block shows now, as the Show as choice names it (a block with no `show` has no tab and no card).
export const showValue = show => (show?.tab && show.card ? 'both' : show?.tab ? 'tab' : show?.card ? 'card' : 'hidden');

export function metaOf(definition, managed, rpgOn = true) {
    if (managed) return (rpgOn ? P.rpgShown : P.rpgIdle)[definition.role];
    const buttons = Object.values(definition.kinds ?? {}).filter(kind => kind.ui).length, rules = definition.rules?.length ?? 0, timers = definition.timers?.length ?? 0;
    const show = definition.show, shown = [];
    if (show?.tab) shown.push(fill(P.whereTab, { name: show.tabName, icon: String(S.icons[show.icon] ?? '').toLowerCase() || show.icon }));
    if (show?.card) shown.push(P.whereCard);
    return [plural(Object.keys(definition.state ?? {}).length, P.fields), buttons ? plural(buttons, P.buttons) : '', rules ? plural(rules, P.rules) : '',
        timers ? plural(timers, P.timers) : '', shown.join(', ') || P.whereHidden].filter(Boolean).join(' · ');
}
