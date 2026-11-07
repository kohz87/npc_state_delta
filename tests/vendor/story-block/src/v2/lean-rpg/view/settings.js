// Settings → RPG (mockup section 6): a page of its own in the rail under Features, shown while the feature `story-block.rpg`
// is on. Six cards:
//   Formula     Standard / Classic (`rpgFormula`): the roll table and the four numbers of the formula in force
//   Rolls       Automatic / Off (`rpgRolls`, ROLLS_SETTING in lean-rpg/names.js)
//   Difficulty  Gentle / Standard / Harsh / Custom (`rpgDifficulty`), the Custom numbers of the formula (`rpgCustom`: Classic's six;
//               `rpgStandard`: Standard's thirteen) and the exact odds for the reader's own character under the numbers chosen, drawn
//               again as they change
//   Combat      the chat's Combat rules block's text (≤1200), saved as an edit of that block's definition, with Reset to the default
//   Planner     the reader's own instructions for the roll planner (`rpgPlannerNote`, ≤400) and the planner's full prompt, read-only
//   Companions  who join: Ask (the default) / Automatically / Off (`rpgJoin`, JOIN_SETTING): what the story's `+ party` line does (join.js)
// The numbers are only *chosen* here: a roll takes the numbers in force when it is planned and records them (rules.js), so
// nothing on this page can change a roll already made. Every node is built with createElement and textContent.
//
// The page's parts live in `settings/`: `constants.js` its words and Custom fields; `controls.js` the card, chips, field
// and number builders; `sections.js` Formula, Rolls, Levels, Companions and Gear; `difficulty.js` Custom numbers and odds;
// `combat.js` the Combat box and its saves; `planner.js` the planner note and preview; `page.js` the shared render closure.
// This file keeps the path, section record and public exports.

import { S, SECTION_ID } from './settings/constants.js';
import { renderRpgSettings } from './settings/page.js';

export { ROLLS_DEFAULT, ROLLS_KEY, SETTINGS_MODULE, SECTION_ID, rollsOf } from './settings/constants.js';
export { renderRpgSettings };

/** The section record the settings window adds after Features (window.js `extraSections`). `body(pane, ctx)` draws the page. */
export function rpgSection({ featureOn = () => true, ...deps } = {}) {
    return Object.freeze({
        id: SECTION_ID, label: S.title, icon: 'fa-dice-d20', title: S.title, sub: S.sub, after: 'features', visible: () => featureOn(),
        body: (pane, ctx) => renderRpgSettings(pane, { settings: ctx.options.settings, doc: ctx.doc, featureOn, onChange: () => ctx.changed?.(), ...deps }),
    });
}
