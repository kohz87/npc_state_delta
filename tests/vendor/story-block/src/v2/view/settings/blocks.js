// The Blocks section's body: the blocks of the open story, listed with where each shows (Its own tab, A card on Home, Both,
// Hidden), Edit (the block editor) and a more menu (Save as template, Export as pack, Remove). The page itself is drawn by
// screens/blocks.js (`page`: it shares its editor and template chooser with the block cards' "Edit fields" in the game view);
// this body only gives it a pane and tells the window what matches a search. With no chat open it says that blocks belong to a story.
//
// The body: `(pane, ctx) → { filter, refresh, refreshSize, destroy }` (bodies.js). `ctx.options.blocks` is the block widgets of
// ui-host.js (`page`), `chatOpen()` whether a story is open.

import { STRINGS } from '../../strings.js';

export function blocksBody(pane, ctx) {
    const { doc } = ctx;
    const { blocks = null, sdk = null, chatOpen = () => true } = ctx.options;
    const root = doc.createElement('div');
    root.className = 'ss-blocks';
    pane.appendChild(root);
    const page = blocks?.page?.({ doc, parent: root, api: sdk, chatOpen }) ?? null;
    if (!page) {
        const note = doc.createElement('p');
        note.className = 'ss-blocks-empty';
        note.textContent = STRINGS.blocks.page.noChat;
        root.appendChild(note);
    }
    return {
        filter: text => page?.filter(text) ?? 0,
        refresh: () => page?.refresh(),
        // The story moved (a reply, a swipe, an edit): the list is read again.
        refreshSize: () => page?.refresh(),
        destroy() { page?.destroy(); root.remove(); },
    };
}
