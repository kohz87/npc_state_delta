// The RPG's screens, mounted by ui-host.js only while the feature `story-block.rpg` is on (a dynamic import(),
// so with the feature off none of this file or its siblings is ever loaded). One call wires everything:
//   * the stylesheet (lean-rpg.css), added to the page's head;
//   * the Party tab and its widget, with the Spend points sheet, the Skills view and the New character wizard (a dialog);
//   * the "Your character" card on Home and the dialog that holds the first Send until there is a character (start.js);
//   * the Fight tab (the Foes block's tab, on while a foe slot is filled);
//   * the battle log in the replies (at the narrator's `[battle]` marker, else a card under the reply);
//   * the "Changed this reply" lines (`cardLines`) and the RPG page of the settings window, after Features (`settingsSections`).
// `destroy()` takes all of it away again (the feature was switched off).

import { createBattleLog } from './battle-log.js';
import { FIGHT_WIDGET, createFightScreen, createFightWidget } from './fight.js';
import { rpgReplyLines } from './changes-lines.js';
import { PARTY_WIDGET, createPartyScreen, createPartyWidget } from './party.js';
import { rulesFromSettings } from '../rules.js';
import { rpgSection } from './settings.js';
import { HOLD_WIDGET, createStart } from './start.js';
import { WIZARD_WIDGET, createWizard } from './wizard.js';
import { readRecord } from '../../persist.js';

export { PARTY_SCREEN_ID, PARTY_WIDGET } from './party.js';
export { WIZARD_SCREEN_ID, WIZARD_WIDGET } from './wizard.js';
export { HOLD_SCREEN_ID, HOLD_WIDGET, START_WIDGET } from './start.js';
export { FIGHT_SCREEN_ID, FIGHT_WIDGET } from './fight.js';
export { rpgReplyLines } from './changes-lines.js';
export const PACK = 'rpg';
const STYLE_ATTR = 'data-ss-rpg';

function addStyle(doc) {
    try {
        if (doc.querySelector?.(`link[${STYLE_ATTR}]`)) return null;
        const link = doc.createElement('link');
        link.setAttribute('rel', 'stylesheet');
        link.setAttribute(STYLE_ATTR, '');
        link.setAttribute('href', new URL('./lean-rpg.css', import.meta.url).href);
        (doc.head ?? doc.body).appendChild(link);
        return link;
    } catch {
        // A page with no head, or an address that cannot be made: the screens still work, with the base look.
        return null;
    }
}

/**
 * mountLeanRpg({ doc, ctx, store, events, screens, widgets, headState, readerName, readerAbout, roleOf, featureOn, openDialog, closeView, refresh, command, values, meta, save })
 * → { cardLines({ index, state, before, record, problems }), settingsSections(), battleLog, wizard, start, destroy() }.
 * `screens` is the screen registry (`setPack`, `removePack`); `widgets` the host's own widget table (the Party and wizard widgets are
 * added to it); `headState()` the head state; `featureOn()` whether the feature is on now; `openDialog(screenId, { draft, onClose })` the
 * host's dialog mount (the New character wizard opens through it; without it the Party tab has no button for it); `readerAbout()` the active
 * persona's description (a You's Who they are starts with it); `meta()` the open chat's metadata and `save()` its write (what Home's card and the first-send
 * dialog remember per chat, ../start.js); `values()` Story Block's settings, `command(type, payload)` the host's
 * commands (the settings page saves the Combat rules text through `dm.redefine`); `closeView()` closes the game view
 * ("See it in the story" on the Fight tab); `refresh()` redraws the tabs.
 */
export function mountLeanRpg({ doc, ctx, store, events = null, screens, widgets, headState, readerName = () => '', readerAbout = () => '', meta = () => null, save = () => {}, roleOf, featureOn = () => true, openDialog = null, closeView = () => {}, refresh = () => {}, command = null, values = () => ({}) }) {
    const link = addStyle(doc);
    // The numbers a roll would be made with now (Settings → RPG): the roll line on a skill and a class-up note state them.
    const rules = () => rulesFromSettings(values());
    // The head reply's key in the blocks' per-reply action count (data-modules/part.js pairKey): the wizard asks it for room before Create.
    const replyKey = () => {
        const source = readRecord(ctx?.chat?.[store?.headIndex?.()])?.source;
        return source?.logical && source?.swipeKey ? `${source.logical}/${source.swipeKey}` : '';
    };
    const wizard = createWizard({ headState, readerName, readerAbout, roleOf, openDialog, replyKey });
    const start = createStart({ doc, headState, readerName, featureOn, roleOf, openDialog, wizard, meta, save, redraw: () => refresh() });
    widgets[PARTY_WIDGET] = createPartyWidget({ headState, readerName, roleOf, openWizard: openDialog ? wizard.open : null, rules });
    widgets[WIZARD_WIDGET] = wizard.widget;
    widgets[HOLD_WIDGET] = start.holdWidget;
    const battleLog = createBattleLog({ ctx, doc, store, events, featureOn, roleOf });
    widgets[FIGHT_WIDGET] = createFightWidget({ headState, readerName, roleOf, battleLog, closeView });
    screens.setPack(PACK, [createPartyScreen(), createFightScreen({ roleOf }), wizard.screen, start.holdScreen]);
    start.attach();
    battleLog.refreshAll();
    refresh();
    return {
        battleLog,
        wizard,
        start,
        cardLines: info => { try { return rpgReplyLines({ ...info, roleOf, rules: rules() }); } catch { return []; } },
        settingsSections: () => [rpgSection({ featureOn, headState, readerName, roleOf, command })],
        destroy() {
            battleLog.destroy();
            start.detach();
            wizard.destroy();
            screens.removePack(PACK);
            delete widgets[PARTY_WIDGET];
            delete widgets[WIZARD_WIDGET];
            delete widgets[HOLD_WIDGET];
            delete widgets[FIGHT_WIDGET];
            link?.remove();
            refresh();
        },
    };
}
