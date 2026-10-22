// Story Block's own default screens (SPEC §13.1–13.3), for the core module's
// `registerModule({ screens })`. Each is plain data: an id, where it may appear, the queries it reads,
// an HTML template and scoped CSS in SillyTavern's colours (MODULES §F18). Packs, cards and the reader
// can restyle or replace any of them by id (§13.7).
//
//   story-block/inventory     tab, screen   the party's things by kind; Equip / Drop; a filter box
//   story-block/scene         tab, screen   the place and who is there, with portraits from NSD
//   story-block/changes-card  card          "Changed this reply" under each reply
//   story-block/home          screen        the game view's landing page: a summary of every module,
//                                           and the save points (feature story-block.savepoints)
//   story-block/inspector     screen, tab   the state inspector, read-only (feature story-block.inspector)
//
// The card mount's collapsed header line comes from `changesSummary` (see changes-card.js).

import { inventoryScreen, INVENTORY_SCREEN_ID, KIND_TITLES } from './inventory.js';
import { sceneScreen, SCENE_SCREEN_ID } from './scene.js';
import { changesCardScreen, changesDigest, changesSummary, CHANGES_CARD_SCREEN_ID } from './changes-card.js';
import { homeScreen, HOME_SCREEN_ID } from './home.js';
import { inspectorScreen, INSPECTOR_SCREEN_ID } from './inspector.js';
import { BASE_CSS, RARITY_THEME } from './style.js';

export {
    inventoryScreen, sceneScreen, changesCardScreen, homeScreen, inspectorScreen,
    INVENTORY_SCREEN_ID, SCENE_SCREEN_ID, CHANGES_CARD_SCREEN_ID, HOME_SCREEN_ID, INSPECTOR_SCREEN_ID,
    changesDigest, changesSummary, KIND_TITLES, BASE_CSS, RARITY_THEME,
};

/** The default screens, in the order the game view should offer them (home first). */
export const screens = Object.freeze([homeScreen, inventoryScreen, sceneScreen, changesCardScreen, inspectorScreen]);
