// Story Suite v2: the five mounts (SPEC §13.4) built from one set of dependencies (see common.js).
// Each controller has `mount(el, screenId, opts)`; the rest is per mount (tabs register, the game view
// opens and closes, cards follow the chat, the hud sits above the message box, dialogs run wizards).

import { createCardMount } from './card.js';
import { createDialogMount } from './dialog.js';
import { createHudMount } from './hud.js';
import { createScreenMount } from './screen.js';
import { createTabMount } from './tab.js';

export { createCardMount, createDialogMount, createHudMount, createScreenMount, createTabMount };
export { changeSummary } from './card.js';
export { drawScreen } from './common.js';

/** → { tab, screen, card, hud, dialog }; `card` only when `deps.carriers` is given. */
export function createMounts(deps) {
    return {
        tab: createTabMount(deps),
        screen: createScreenMount(deps),
        card: typeof deps.carriers === 'function' ? createCardMount(deps) : null,
        hud: createHudMount(deps),
        dialog: createDialogMount(deps),
    };
}
