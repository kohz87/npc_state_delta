// The sections of the settings window (UI stage, step 3a): their order, names, icons, the words on each page, and
// where each piece of today's settings goes. The window (window.js) draws one page per section; what a page holds
// is a *body* (bodies.js), so a section can move to the form engine (view/form/) one at a time without touching
// the frame.
//
// The order is the approved concept's, with Look first (step 3b): Look, Features, Money, Assist, Tabs & Packs, Modules,
// Diagnostics. Look and Features are drawn by the form engine (bodies.js). The other sections still hold today's
// settings (host-ui.js `renderSettingsHost`, one column of folds); `routeOf` sends each fold, and for Story Block's
// own fold each of its parts, to the section it belongs to. Fold ids do not change (`openSettings({ fold })` finds
// the section the fold is in), so Home's "Import a pack" (PACKS_FOLD) still lands on its fold.

import { HOST_FOLD, PACKS_FOLD } from '../../host-ui.js';

/** Story Block's own module id (src/v2/domains/index.js CORE_MODULE_ID): the one module whose parts are spread over sections. */
const CORE_ID = 'story-block';

/** The sections, in the order of the rail. `title` and `sub` head the page; `icon` is a Font Awesome class. */
export const SETTINGS_SECTIONS = Object.freeze([
    Object.freeze({ id: 'look', label: 'Look', icon: 'fa-palette', title: 'Look', sub: 'How Story Suite\'s panels and text look.' }),
    Object.freeze({ id: 'features', label: 'Features', icon: 'fa-toggle-on', title: 'Features', sub: 'Switch parts of the game on or off.' }),
    Object.freeze({ id: 'money', label: 'Money', icon: 'fa-coins', title: 'Money', sub: 'Your world\'s coins, and how much the story may pay.' }),
    Object.freeze({ id: 'assist', label: 'Assist', icon: 'fa-wand-magic-sparkles', title: 'Assist', sub: 'Optional cheap model calls that help a fast narrator.' }),
    Object.freeze({ id: 'tabs', label: 'Tabs & Packs', icon: 'fa-table-columns', title: 'Tabs & Packs', sub: 'The look of the panels, which tabs show and in what order, and your content packs.' }),
    Object.freeze({ id: 'modules', label: 'Modules', icon: 'fa-puzzle-piece', title: 'Modules', sub: 'The settings of each installed module, and which versions are installed.' }),
    Object.freeze({ id: 'diagnostics', label: 'Diagnostics', icon: 'fa-stethoscope', title: 'Diagnostics', sub: 'A report to share when something goes wrong, and what packs and modules say about themselves.' }),
]);
export const SECTION_IDS = Object.freeze(SETTINGS_SECTIONS.map(section => section.id));
// The page the window opens on: Features, the one most readers come for, though Look is first in the rail.
export const DEFAULT_SECTION = 'features';
/** The host settings the Look section draws (and the Story Suite fold no longer does): HOST_SETTINGS_SCHEMA's keys. */
export const LOOK_KEYS = Object.freeze(['panelStyle', 'glassStrength', 'font']);

/** What the window says (plain words). */
export const WINDOW_TEXT = Object.freeze({
    title: 'Story Suite',
    dialogLabel: 'Story Suite settings',
    railLabel: 'Settings sections',
    close: 'Close Story Suite settings',
    searchLabel: 'Search all settings',
    searchPlaceholder: 'Search settings…',
    content: '{section} settings',
});

/**
 * The section a piece of today's settings belongs to. `piece` is what host-ui.js is placing:
 * { type: 'host' } (the Story Suite fold: panel style, prompt size, Tabs), 'own-fold' (a module's own fold: Story
 * Block's Packs), 'features', 'module' (a module's fold), 'panel' (a module's custom panel), 'group' (one settings
 * group of a module), 'diagnostics', 'versions'.
 */
export function routeOf(piece) {
    switch (piece?.type) {
        case 'features': return 'features';
        // The Story Suite fold (budgets, Prompt size, Tabs); its look settings are in Look.
        case 'host': return 'tabs';
        case 'own-fold': return piece.moduleId === CORE_ID ? 'tabs' : 'modules';
        // Story Block's money settings are its General group; its Assist panel and the Assist group are Assist.
        case 'panel': return piece.moduleId === CORE_ID ? 'assist' : 'modules';
        case 'group':
            if (piece.moduleId !== CORE_ID) return 'modules';
            return piece.group === 'General' ? 'money' : piece.group === 'Assist' ? 'assist' : 'modules';
        case 'diagnostics': return 'diagnostics';
        default: return 'modules';
    }
}

// Folds that start open: a page that is one fold or one group should not open on a closed box. The rest are as
// the reader left them, or closed.
const OPEN = new Set([HOST_FOLD, PACKS_FOLD, `${CORE_ID}::group:Assist`]);
export const opensByDefault = key => OPEN.has(key);

/** A section by id (the default one for an id that is none). */
export const sectionById = id => SETTINGS_SECTIONS.find(section => section.id === id) ?? SETTINGS_SECTIONS[0];
