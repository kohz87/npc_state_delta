// Search across the settings window (UI stage, step 3a), for the sections that still draw today's folds and rows
// (bodies.js). The rows, features and panels host-ui.js drew are listed as search entries (`renderSettingsHost`'s
// `entries()`); this shows the ones that match and hides the rest, with the folds around them, the way the form
// engine's own search does for its fields (view/form/form.js: the same `matchesSearch`, a row hidden when it does not
// match, a section hidden when none of its rows show). A section that moves to the form engine uses the engine's
// `filter(text)` instead; the window only needs a number back.

import { matchesSearch } from '../form/schema.js';

const FOLDS = 'details.story-suite-fold, details.story-suite-subfold';

/**
 * Shows what matches `text` in `pane` (a section's page), hides the rest; '' shows everything. `entries` are the
 * search entries (`{ kind: 'row' | 'feature' | 'panel', key, field: { label, help }, group, node }`), `label` the
 * section's name (searching "money" finds the Money page's rows), `openState` the folds' open state the reader left
 * (a fold opened only for the search is put back when it ends). Returns how many matches are shown (every entry when
 * there is no search): a panel that matches counts once, not the rows inside it.
 */
export function filterPane({ pane, entries, text, openState = new Map() }) {
    const mine = entries.filter(entry => entry.node && pane.contains(entry.node));
    const query = String(text ?? '').trim();
    const searching = query !== '';
    const own = new Map(mine.map(entry => [entry, matchesSearch(entry.key, entry.field, entry.group, query)]));
    const inside = (outer, inner) => outer !== inner && outer.node.contains(inner.node);
    // A matching panel (Packs, Tabs) shows whole, with what is in it.
    const covered = entry => mine.some(other => other.kind === 'panel' && own.get(other) && inside(other, entry));
    const shown = new Map(mine.map(entry => [entry, own.get(entry) || covered(entry)]));
    // A panel with a match inside it shows too (Diagnostics holding Events).
    const visible = new Map(mine.map(entry => [entry, shown.get(entry) || mine.some(other => shown.get(other) && inside(entry, other))]));
    for (const entry of mine) entry.node.hidden = !visible.get(entry);
    for (const details of pane.querySelectorAll(FOLDS)) {
        const has = !searching || mine.some(entry => visible.get(entry) && details.contains(entry.node));
        details.hidden = !has;
        const key = details.dataset.fold;
        if (searching && has) {
            // Opened for the search only: how the reader left it is kept, and put back when the search ends.
            if (!details.dataset.filtered) openState.set(key, details.open === true);
            details.dataset.filtered = 'true';
            details.open = true;
        } else if (details.dataset.filtered) {
            delete details.dataset.filtered;
            details.open = openState.get(key) === true;
        }
    }
    if (!searching) return mine.length;
    return mine.filter(entry => own.get(entry) && !covered(entry)).length;
}
