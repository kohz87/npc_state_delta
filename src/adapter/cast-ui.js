// The Dossiers screens (src/storysuite-v2.js): the drawer copy of Delta's settings panel, the settings section, the dossier list and
// the present cast's cards and meters (renderCast, renderDossiers), the page API for Story Director's World screen, the Dossiers
// widget and screen, the meter presets block, the key-person pin, and the cast sync that follows a reply (onTurn).
//
// A part of the adapter closure: createCastUiPart(session, deps) gets the adapter's shared state (session) and the adapter's options,
// constants and the parts built before it (deps), and returns what the other parts and the adapter use. Text is set with textContent;
// nothing is parsed as markup. No SillyTavern import. The implementation groups live under src/adapter/cast-ui/.

import { createCastRenderPart } from './cast-ui/cast-render.js';
import { createCastViews } from './cast-ui/cast-views.js';
import { createDossierListPart } from './cast-ui/dossier-list.js';
import { createDrawerPart } from './cast-ui/drawer.js';
import { createPageApi } from './cast-ui/page-api.js';
import { createPresetsPart } from './cast-ui/presets.js';
import { createSectionPart } from './cast-ui/section.js';
import { createTurnPart } from './cast-ui/turn.js';
import { createWatchers } from './cast-ui/watchers.js';

export { meterBarNode } from './cast-ui/dom.js';

export function createCastUiPart(session, deps) {
    const drawer = createDrawerPart(session, deps);
    const section = createSectionPart(session, deps, drawer);
    const watchersPart = createWatchers(deps);
    const dossiers = createDossierListPart(session, deps);
    const turn = createTurnPart(session, deps);
    const castRender = createCastRenderPart(session, deps, dossiers, {
        notifyChange: watchersPart.notifyChange,
        portraitFill: turn.portraitFill,
    });
    const page = createPageApi(session, deps, castRender.renderCast, watchersPart.watchers);
    const views = createCastViews(session, deps, castRender);
    const presets = createPresetsPart(session, deps);

    return {
        watchers: watchersPart.watchers, syncDrawer: drawer.syncDrawer, unmountSection: section.unmountSection, mountSection: section.mountSection, renderDossiers: castRender.renderDossiers, notifyChange: watchersPart.notifyChange, pageApi: page.pageApi, offerPage: page.offerPage,
        castStillShown: views.castStillShown, redrawCastViews: views.redrawCastViews, castWidget: views.castWidget, castScreen: views.castScreen, presetsBlock: presets.presetsBlock, onTurn: turn.onTurn, portraitFill: turn.portraitFill,
    };
}
