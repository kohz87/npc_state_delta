// The RPG's screens, mounted by ui-host.js only while the feature `story-block.rpg` is on (a dynamic import(),
// so with the feature off none of this file or its siblings is ever loaded). One call wires everything:
//   * the stylesheet (lean-rpg.css), added to the page's head;
//   * the Party tab and its widget, with the Spend points sheet, the Skills view, the New character wizard (a dialog) and Export character (a dialog);
//   * the "Your character" card on Home and the dialog that holds the first Send until there is a character (start.js);
//   * the Fight tab (the Foes block's tab, on while a foe slot is filled);
//   * the battle log in the replies (at the narrator's `[battle]` marker, else a card under the reply);
//   * the "Changed this reply" lines (`cardLines`) and the RPG page of the settings window, after Features (`settingsSections`).
// `destroy()` takes all of it away again (the feature was switched off).

import { createBattleLog } from './battle-log.js';
import { FIGHT_WIDGET, createFightScreen, createFightWidget } from './fight.js';
import { rpgReplyLines } from './changes-lines.js';
import { PARTY_WIDGET, createPartyScreen, createPartyWidget } from './party.js';
import { packInForce, packRulesOf, rulesFromSettings } from '../rules.js';
import { rpgSection } from './settings.js';
import { heroLead } from './hero-data.js';
import { HOLD_WIDGET, createStart } from './start.js';
import { WIZARD_WIDGET, createWizard } from './wizard.js';
import { EXPORT_WIDGET, createExporter } from './export.js';
import { readRecord } from '../../persist.js';

export { PARTY_SCREEN_ID, PARTY_WIDGET } from './party.js';
export { WIZARD_SCREEN_ID, WIZARD_WIDGET } from './wizard.js';
export { EXPORT_SCREEN_ID, EXPORT_WIDGET } from './export.js';
export { HOLD_SCREEN_ID, HOLD_WIDGET, START_WIDGET } from './start.js';
export { FIGHT_SCREEN_ID, FIGHT_WIDGET } from './fight.js';
export { rpgReplyLines } from './changes-lines.js';
export { heroLead } from './hero-data.js';
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
 * → { cardLines({ index, state, before, record, problems }), settingsSections(), heroLead(state), battleLog, wizard, start, destroy() }.
 * `heroLead(state)` is the reader's own character as the game view's header draws it ({ name, bars }, hero-data.js), or null.
 * `screens` is the screen registry (`setPack`, `removePack`); `widgets` the host's own widget table (the Party and wizard widgets are
 * added to it); `headState()` the head state; `featureOn()` whether the feature is on now; `openDialog(screenId, { draft, onClose })` the
 * host's dialog mount (the New character wizard opens through it; without it the Party tab has no button for it); `readerAbout()` the active
 * persona's description (a You's Who they are starts with it); `meta()` the open chat's metadata and `save()` its write (what Home's card and the first-send
 * dialog remember per chat, ../start.js); `values()` Story Block's settings, `command(type, payload)` the host's
 * commands (the settings page saves the Combat rules text through `dm.redefine`); `closeView()` closes the game view
 * ("See it in the story" on the Fight tab); `refresh()` redraws the tabs.
 */
export function mountLeanRpg({ doc, ctx, store, events = null, screens, widgets, headState, readerName = () => '', readerAbout = () => '', meta = () => null, save = () => {}, roleOf, featureOn = () => true, openDialog = null, closeView = () => {}, refresh = () => {}, command = null, values = () => ({}), query = null }) {
    const link = addStyle(doc);
    // The numbers a roll would be made with now (Settings → RPG): the roll line on a skill and a class-up note state them.
    // What the story's pack asks for (its formula and numbers), with the pack's name: the default of a reader who has chosen nothing.
    const pack = () => {
        try {
            const found = packRulesOf(query?.('packs.content', { kind: 'rpg' }));
            if (!found) return null;
            const listed = (query?.('packs.list') ?? []).find(entry => entry?.id === found.pack);
            return { ...found, name: String(listed?.name ?? found.pack ?? '') };
        } catch { return null; }
    };
    const rules = () => rulesFromSettings(values(), pack());
    // "From the pack: Ersveil" under the wizard's Stats, when the pack decides the numbers.
    const packNote = () => { const given = pack(); return given && packInForce(values(), given).numbers ? given.name || given.pack || '' : ''; };
    // The head reply's key in the blocks' per-reply action count (data-modules/part.js pairKey): the wizard asks it for room before Create.
    const replyKey = () => {
        const source = readRecord(ctx?.chat?.[store?.headIndex?.()])?.source;
        return source?.logical && source?.swipeKey ? `${source.logical}/${source.swipeKey}` : '';
    };
    const wizard = createWizard({ headState, readerName, readerAbout, roleOf, openDialog, replyKey, rules, packNote });
    const exporter = createExporter({ headState, readerName, roleOf, openDialog });
    const start = createStart({ doc, headState, readerName, featureOn, roleOf, openDialog, wizard, meta, save, redraw: () => refresh() });
    widgets[PARTY_WIDGET] = createPartyWidget({ headState, readerName, roleOf, openWizard: openDialog ? wizard.open : null, exportCharacter: openDialog ? exporter.open : null, rules });
    widgets[WIZARD_WIDGET] = wizard.widget;
    widgets[EXPORT_WIDGET] = exporter.widget;
    widgets[HOLD_WIDGET] = start.holdWidget;
    const battleLog = createBattleLog({ ctx, doc, store, events, featureOn, roleOf });
    widgets[FIGHT_WIDGET] = createFightWidget({ headState, readerName, roleOf, battleLog, closeView });
    screens.setPack(PACK, [createPartyScreen(), createFightScreen({ roleOf }), wizard.screen, exporter.screen, start.holdScreen]);
    start.attach();
    battleLog.refreshAll();
    refresh();
    return {
        battleLog,
        wizard,
        exporter,
        start,
        cardLines: info => { try { return rpgReplyLines({ ...info, roleOf, rules: rules() }); } catch { return []; } },
        settingsSections: () => [rpgSection({ featureOn, headState, readerName, roleOf, command, pack })],
        heroLead: state => { try { return heroLead(state, { own: readerName(), roleOf }); } catch { return null; } },
        destroy() {
            battleLog.destroy();
            start.detach();
            wizard.destroy();
            exporter.destroy();
            screens.removePack(PACK);
            delete widgets[PARTY_WIDGET];
            delete widgets[WIZARD_WIDGET];
            delete widgets[EXPORT_WIDGET];
            delete widgets[HOLD_WIDGET];
            delete widgets[FIGHT_WIDGET];
            link?.remove();
            refresh();
        },
    };
}
