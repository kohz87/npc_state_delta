// The Tabs & Packs section's body (UI stage, step 3e): three cards on the form engine's look, in place of Story Suite's fold and the
// Packs fold.
//
// * Tabs (tabs-list.js): every tab and screen as a row with a show/hide switch and Up and Down; the same tabs control as before.
// * Packs (packs/panel.js, drawn by Story Block's own `packs` fold's render): the installed packs as list rows with an on/off switch
//   and Remove (asks first), Import (a file) and Read from the character's lorebook.
// * Prompt (prompt.js): the budgets (sliders and a number) and the prompt's size, with "Show what's sent".
//
// The fold ids still open this page: the Story Suite fold's `story-suite` (its first card, Tabs), `story-suite::tabs`, `story-suite::size`
// and `story-suite::sent` (Prompt), and Story Block's Packs fold `story-block/packs` (the Import button has the focus, which is
// where Home's "Import a pack" lands).
//
// Built with createElement and textContent only.

import { HOST_FOLD, PACKS_FOLD, SENT_FOLD, TABS_FOLD } from '../../host-ui.js';
import { newId, sectionBlock } from '../form/fields.js';
import { matchesSearch } from '../form/schema.js';
import { PROMPT_FOLD, createPromptReader, renderPromptCard } from './prompt.js';
import { renderTabsCard } from './tabs-list.js';
import { showAndFocus } from '../scroll.js';
import { renderDataModules } from '../../data-modules/setup.js';

/** Story Block's module id and its Packs fold. */
const CORE_ID = 'story-block';
export const PACKS_CARD = Object.freeze({ title: 'Packs', hint: 'import a pack' });
/** The Data modules card (data-modules/setup.js): there only while the library holds a data module or this chat has one. */
export const DATA_MODULES_CARD = Object.freeze({ title: 'Data modules', hint: 'enable for this chat' });
const KEYS = Object.freeze([HOST_FOLD, TABS_FOLD, PACKS_FOLD, PROMPT_FOLD, SENT_FOLD]);

/** The Packs fold Story Block registers (`settings.folds`), with its module's settings access; null when there is none. */
function packsFold(registry, settings, sdk) {
    const defs = typeof registry?.settingsDefs === 'function' ? registry.settingsDefs() : [];
    for (const def of defs) {
        if (def.moduleId !== CORE_ID) continue;
        const item = (Array.isArray(def.folds) ? def.folds : []).find(fold => fold?.id === 'packs' && typeof fold.render === 'function');
        if (item) {
            return {
                item,
                api: Object.freeze({ get: key => settings(def.moduleId)[key], set: (key, value) => settings.set(def.moduleId, key, value), values: () => settings(def.moduleId), sdk }),
            };
        }
    }
    return null;
}

/** The Tabs & Packs body: `(pane, ctx) → { filter, refresh, refreshSize, destroy, has, open }` (bodies.js). */
export function tabsPacksBody(pane, ctx) {
    const { doc } = ctx;
    const { registry, settings, sdk = null, tabs = null, promptParts = null, countTokens = null } = ctx.options;
    const reader = ctx.options.reader ?? createPromptReader({ registry, settings, promptParts, countTokens });
    const root = doc.createElement('div');
    root.className = 'ss-tabspacks';
    pane.appendChild(root);
    const changed = () => ctx.changed?.();

    const tabsCard = renderTabsCard(root, { doc, tabs, onChange: changed });

    // Packs: Story Block's own panel, in a card.
    const packs = packsFold(registry, settings, sdk);
    const packsCard = sectionBlock(doc, { title: PACKS_CARD.title, hint: PACKS_CARD.hint, id: newId('packs-card') });
    packsCard.el.classList.add('ss-packs-card');
    packsCard.el.dataset.fold = PACKS_FOLD;
    let panel = null;
    if (packs) {
        try {
            panel = packs.item.render(packsCard.body, packs.api) ?? null;
        } catch (error) {
            const note = doc.createElement('p');
            note.className = 'story-suite-muted';
            note.textContent = `This part of Story Block's settings could not be shown: ${error?.message ?? error}`;
            packsCard.body.replaceChildren(note);
        }
        root.appendChild(packsCard.el);
    }

    // Data modules: the reader's explicit choice of which ones this chat uses. The card is made when there is something to
    // show (an installed definition or a pin) and stays out of the page otherwise, so a chat that uses none is unchanged.
    let modulesCard = null;
    let modules = null;
    const ensureModules = () => {
        if (!sdk) return false;
        let count = 0;
        try { count = (sdk.query('dataModules.setup') ?? []).length; } catch { count = 0; }
        if (!count) { modulesCard?.setHidden(true); return false; }
        if (!modulesCard) {
            modulesCard = sectionBlock(doc, { title: DATA_MODULES_CARD.title, hint: DATA_MODULES_CARD.hint, id: newId('dm-card') });
            modulesCard.el.classList.add('ss-dm-card');
            modules = renderDataModules(modulesCard.body, { sdk });
            root.insertBefore(modulesCard.el, root.querySelector('.ss-prompt-card'));
        }
        modulesCard.setHidden(false);
        return true;
    };

    const prompt = renderPromptCard(root, { doc, settings, reader, openState: ctx.openState, onChange: changed });
    ensureModules();

    const packNames = () => [...packsCard.body.querySelectorAll('.ss-packs-row')].map(node => node.textContent ?? '').join(' ');
    const importButton = () => packsCard.body.querySelector('.ss-packs-import');

    return {
        filter(text) {
            const query = String(text ?? '').trim();
            let count = tabsCard.filter(text) + prompt.filter(text);
            if (ensureModules()) {
                const match = !query || matchesSearch('data-modules', { label: DATA_MODULES_CARD.title, help: `${DATA_MODULES_CARD.hint} ${modulesCard.body.textContent ?? ''}` }, 'Data modules', text);
                modulesCard.setHidden(!match);
                if (query && match) count += 1;
            }
            if (packs) {
                const match = !query || matchesSearch('packs', { label: PACKS_CARD.title, help: `${PACKS_CARD.hint} ${packNames()}` }, 'Packs', text);
                packsCard.setHidden(!match);
                if (query && match) count += 1;
            }
            return count;
        },
        refresh() {
            tabsCard.refresh();
            panel?.refresh?.();
            if (ensureModules()) modules.refresh();
            prompt.refresh();
        },
        // The story moved: only the size is read again.
        refreshSize() {
            prompt.refresh();
        },
        destroy() {
            tabsCard.destroy();
            prompt.destroy();
            packsCard.el.remove();
            modulesCard?.el.remove();
            root.remove();
        },
        has: key => KEYS.includes(key),
        open(key) {
            if (key === PACKS_FOLD) {
                const input = importButton();
                return showAndFocus(input, 'center');
            }
            // With no chat open there is nothing to show: the card's first budget takes the focus instead.
            if (key === SENT_FOLD) return prompt.openSent() || prompt.focus();
            if (key === PROMPT_FOLD) return prompt.focus();
            return tabsCard.focus();
        },
    };
}
