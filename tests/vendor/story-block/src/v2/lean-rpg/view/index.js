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
import { FIGHT_SCREEN_ID, FIGHT_WIDGET, createFightScreen, createFightWidget } from './fight.js';
import { rpgReplyLines } from './changes-lines.js';
import { PARTY_WIDGET, createPartyScreen, createPartyWidget } from './party.js';
import { isStandard, levelCapFor, packInForce, packRulesOf, rulesFromSettings } from '../rules.js';
import { rpgSection } from './settings.js';
import { heroLead } from './hero-data.js';
import { HOLD_WIDGET, createStart } from './start.js';
import { WIZARD_WIDGET, createWizard } from './wizard.js';
import { EXPORT_WIDGET, createExporter } from './export.js';
import { packLevelsOf } from '../levels.js';
import { autoCapFrom, practiceFromRollsOnly } from '../names.js';
import { planGear } from '../gear.js';
import { readSheet } from '../read.js';
import { readRecord } from '../../persist.js';
import { createBoardView } from '../board/view.js';
import { boardFlags } from '../board/overrides.js';
import { createOfferLineView } from '../board/offer-line.js';
import { createFightOffers } from '../board/offers.js';
import { createStartController } from '../board/start-controller.js';

export { PARTY_SCREEN_ID, PARTY_WIDGET } from './party.js';
export { WIZARD_SCREEN_ID, WIZARD_WIDGET } from './wizard.js';
export { EXPORT_SCREEN_ID, EXPORT_WIDGET } from './export.js';
export { HOLD_SCREEN_ID, HOLD_WIDGET, START_WIDGET } from './start.js';
export { FIGHT_SCREEN_ID, FIGHT_WIDGET } from './fight.js';
export { rpgReplyLines } from './changes-lines.js';
export { heroLead } from './hero-data.js';
export const PACK = 'rpg';
const STYLE_ATTR = 'data-ss-rpg';

const STYLE_FILES = ['./lean-rpg.css', '../board/board.css', '../board/fight-start.css'];

function addStyle(doc, file) {
    try {
        const href = new URL(file, import.meta.url).href;
        if ([...(doc.querySelectorAll?.(`link[${STYLE_ATTR}]`) ?? [])].some(link => link.getAttribute('href') === href)) return null;
        const link = doc.createElement('link');
        link.setAttribute('rel', 'stylesheet');
        link.setAttribute(STYLE_ATTR, '');
        link.setAttribute('href', href);
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
export function mountLeanRpg({ doc, ctx, store, events = null, screens, widgets, headState, readerName = () => '', readerAbout = () => '', meta = () => null, save = () => {}, roleOf, featureOn = () => true, boardOn = () => false, boardFeature = null, gear = null, openDialog = null, openScreen = () => false, closeView = () => {}, refresh = () => {}, command = null, values = () => ({}), query = null, previewStart = () => null, generateHeld = () => {} }) {
    const links = STYLE_FILES.map(file => addStyle(doc, file)).filter(Boolean);
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
    // What the story's pack says about levels: its rank bands and the field that names the party's rank (a story with neither shows "Lv 14" and "Rank F · Lv 7" only where a band exists).
    const levels = () => { let found = null; try { found = packLevelsOf(query?.('packs.content', { kind: 'rpg' })); } catch { found = null; } return { ranks: found?.ranks ?? [], playerRank: found?.playerRank ?? null, levelCap: found?.levelCap ?? null }; };
    const levelCap = () => levelCapFor(values(), levels().levelCap);
    // "From the pack: Ersveil" under the wizard's Stats, when the pack decides the numbers.
    const packNote = () => { const given = pack(); return given && packInForce(values(), given).numbers ? given.name || given.pack || '' : ''; };
    // The head reply's key in the blocks' per-reply action count (data-modules/part.js pairKey): the wizard asks it for room before Create.
    const replyKey = () => {
        const source = readRecord(ctx?.chat?.[store?.headIndex?.()])?.source;
        return source?.logical && source?.swipeKey ? `${source.logical}/${source.swipeKey}` : '';
    };
    const wizard = createWizard({ headState, readerName, readerAbout, roleOf, openDialog, replyKey, rules, packNote, levels, levelCap });
    const exporter = createExporter({ headState, readerName, roleOf, openDialog });
    const start = createStart({ doc, headState, readerName, featureOn, roleOf, openDialog, wizard, meta, save, redraw: () => refresh() });
    widgets[PARTY_WIDGET] = createPartyWidget({ headState, readerName, roleOf, openWizard: openDialog ? wizard.open : null, exportCharacter: openDialog ? exporter.open : null, rules, rolled: () => practiceFromRollsOnly(true, values()), levels, board: { on: boardOn, flags: () => boardFlags(headState()) },
        // The slot card behind a card's Inventory button: the switch and the `gear.view` answer (null while off).
        gear: gear ? { on: () => gear.on(), view: args => { try { return query?.('gear.view', args) ?? null; } catch { return null; } } } : null });
    widgets[WIZARD_WIDGET] = wizard.widget;
    widgets[EXPORT_WIDGET] = exporter.widget;
    widgets[HOLD_WIDGET] = start.holdWidget;
    let board;
    const fightStart = createStartController({ doc, chat: () => ctx?.chat ?? [], meta, state: headState, preview: previewStart,
        board: () => board, on: () => featureOn() && boardOn(), save, refresh, generate: generateHeld, cap: () => autoCapFrom(values()), show: () => openScreen(FIGHT_SCREEN_ID), close: () => closeView?.() });
    board = createBoardView({ doc, headState: () => fightStart.state(), meta, save, store, rules, query, readerName, roleOf, levels, on: boardOn, start: fightStart, cap: () => autoCapFrom(values()) });
    let offers;
    const offerView = createOfferLineView({ doc, onFight: data => offers.choose(data, 'board'), onAuto: data => offers.choose(data, 'auto') });
    offers = createFightOffers({ ctx, doc, store, meta, on: () => featureOn() && boardOn() && isStandard(rules()), view: offerView,
        open: ({ auto = false } = {}) => { if (!board.open()) return false; if (auto) board.auto(); openScreen(FIGHT_SCREEN_ID); return true; }, save, refresh });
    const battleLog = createBattleLog({ ctx, doc, store, events, featureOn, roleOf, levels, offer: offers });
    widgets[FIGHT_WIDGET] = createFightWidget({ headState, readerName, roleOf, battleLog, closeView, levels, board, start: fightStart });
    screens.setPack(PACK, [createPartyScreen(), createFightScreen({ roleOf, offer: () => Boolean(offers.find()), waiting: () => Boolean(fightStart.current()) }), wizard.screen, exporter.screen, start.holdScreen]);
    // The Fight screen opens only for a pause that is ready (foes found, a choice to make). The planner wait ("Working out the fight…") opens nothing:
    // it shows on the Fight tab's dot, so a message that only mentions a skill never makes the screen pop open and shut.
    const offFightStart = events?.on?.('head', info => {
        if (info?.reason !== 'fight-start' && info?.reason !== 'fight-start-done') return;
        fightStart.changed();
        if (info.reason !== 'fight-start') return;
        const waiting = fightStart.current();
        if (waiting) openScreen(FIGHT_SCREEN_ID);
    });
    start.attach();
    battleLog.refreshAll();
    refresh();
    return {
        battleLog,
        wizard,
        exporter,
        start,
        cardLines: info => { try { return rpgReplyLines({ ...info, roleOf, rules: rules() }); } catch { return []; } },
        settingsSections: () => [rpgSection({ featureOn, headState, readerName, roleOf, command, pack, gear, boardFeature, gearOf: () => { try { return planGear(readSheet(headState()), (name, args) => query?.(name, args), readerName()); } catch { return null; } } })],
        heroLead: state => { try { return heroLead(state, { own: readerName(), roleOf, ...levels() }); } catch { return null; } },
        destroy() {
            battleLog.destroy();
            offerView.destroy();
            offFightStart?.();
            fightStart.destroy();
            start.detach();
            wizard.destroy();
            exporter.destroy();
            screens.removePack(PACK);
            delete widgets[PARTY_WIDGET];
            delete widgets[WIZARD_WIDGET];
            delete widgets[EXPORT_WIDGET];
            delete widgets[HOLD_WIDGET];
            delete widgets[FIGHT_WIDGET];
            for (const link of links) link.remove();
            refresh();
        },
    };
}
