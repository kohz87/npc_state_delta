// Story Suite v2: build the host's widgets, renderer and screen registry.
// Shared choices and callbacks stay live while the page furniture is mounted.

import { formatAmount } from '../domains/money.js';
import { mountQuery } from '../sdk.js';
import { createScreenRenderer } from '../view/render-screen.js';
import { formatStoryTime, storyCalendar } from '../view/clock.js';
import { createScreens } from '../view/screens.js';
import { createTabOrderStore, navKey, orderNav } from '../view/tab-order.js';
import { CORE_FEATURE } from '../features.js';
import { createBlockTemplates } from '../data-modules/block-templates.js';
import { createBlockWidgets } from '../screens/blocks.js';
import { createFieldsWidgets } from '../screens/block-fields.js';
import { renderBlockPreview } from '../screens/block-layouts.js';
import { createInspectorSource } from '../inspect.js';
import { createSavePoints } from '../rewind.js';
import { createInspectorWidget, INSPECTOR_WIDGET } from '../screens/inspector.js';
import { createSavePointsWidget, SAVEPOINTS_WIDGET } from '../screens/savepoints.js';
import { replyNumberAt } from '../timeline/coordinator-rebuild.js';
import { createRebuildBannerWidget, REBUILD_BANNER_WIDGET } from '../screens/rebuild-banner.js';
import { createReadyHintWidget, READY_HINT_WIDGET } from '../screens/ready-hint.js';
import { RPG_START_WIDGET } from '../screens/home.js';
import { createShowMoreWidget, SHOW_MORE_WIDGET } from '../screens/show-more.js';
import { createInventoryAddWidget, INVENTORY_ADD_WIDGET } from '../screens/inventory-add.js';
import { readerStore, S } from './shared.js';

export function createHostSetup({ runtime, ctx, doc, registry, store, sdk, openSettings, inspectorProblems, getRpg }) {
    // A screen asking a query no module answers (an optional module that is not installed, like NSD's
    // npc.portrait) gets null, not a problem line.
    const runAt = mountQuery(registry, () => store.receipts());
    const queryAt = (name, args, state) => (registry.query(name) ? runAt(name, args, state) : null);
    // A widget whose feature is off draws nothing (instead of "there is no widget called …").
    const hiddenWidget = Object.freeze({ render: el => { el.hidden = true; return null; } });
    // The host's own two (the Inspector, the save points) after the modules' ones; each checks its
    // feature itself (the Inspector's screen is left out while it is off, the save points draw nothing).
    const widgets = () => ({
        ...Object.fromEntries([
            ...(registry.widgetsOff?.() ?? []).map(name => [name, { ...hiddenWidget, name }]),
            ...registry.widgets().map(widget => [widget.name, widget]),
        ]),
        ...hostWidgets,
    });
    // A feature of a module that is not here (a runtime without Story Block's core) counts as on.
    const coreOn = id => (registry.feature?.(id) ? registry.featureOn(id) : true);
    const blockTemplates = createBlockTemplates({ read: () => {
        const es = ctx.extensionSettings;
        if (!es.storySuite || typeof es.storySuite !== 'object') es.storySuite = {};
        return es.storySuite;
    }, save: () => ctx.saveSettingsDebounced?.() });
    // The tabs screens share (a pack's `tab` ids and titles), for a block's Show in tab.
    let sharedTabs = [];
    const blockWidgets = createBlockWidgets({ templates: blockTemplates, tabs: () => sharedTabs, renderPreview: renderBlockPreview,
        directorOn: () => registry.lifecycle?.('story-director')?.status === 'ready',
        // Off unless Story Block's core is there to own the switch (unlike coreOn, which counts a missing feature as on).
        leanRpgOn: () => (registry.feature?.(CORE_FEATURE.leanRpg) ? registry.featureOn(CORE_FEATURE.leanRpg) : false),
        // The stat formula Story Block's settings say (Classic only when the reader chose it): which RPG templates the chooser offers.
        rpgFormula: () => { try { return runtime.settings?.('story-block')?.rpgFormula === 'classic' ? 'classic' : 'standard'; } catch { return 'standard'; } },
        // A block card's "Edit fields": the editor is on Settings → Blocks.
        navigate: () => { openSettings().select('blocks'); return true; } });
    // The host's own widgets: the Inspector (over the store's replay) and the save points (over the chat).
    const liveCtx = () => globalThis.SillyTavern?.getContext?.() ?? ctx;
    const savePoints = createSavePoints({ ctx, store, live: liveCtx, ...(runtime.createBranch ? { createBranch: runtime.createBranch } : {}) });
    const inspector = createInspectorSource({
        store,
        chat: () => ctx.chat ?? [],
        chatId: () => (typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx.chatId),
        problems: index => inspectorProblems(index),
    });
    // Home's rebuild banner and the Inspector's Problem-row button share one widget and one last result (the timeline's `host.rebuild`).
    let rebuilt = null;
    const rebuildScope = () => liveCtx()?.chatMetadata ?? null;
    const rebuildBlocked = () => runtime.timeline?.blocked?.() ?? null;
    const rebuildBanner = createRebuildBannerWidget({
        blocked: rebuildBlocked,
        scope: rebuildScope,
        rebuild: async (module, input) => {
            const holder = rebuildScope();
            const result = await runtime.timeline.host.rebuild(module, input);
            // A participant that reads on (`started`) is followed through `catchUp()`; only an instant rebuild leaves a result to show.
            if (result?.ok && !result.started && rebuildScope() === holder) rebuilt = { holder, result };
            return result;
        },
        catchUp: () => runtime.timeline?.host?.progress?.() ?? null,
        skip: module => runtime.timeline.host.skip(module),
        // The scan marker is a message position; the reader counts replies (the story replies through it).
        replyOf: index => replyNumberAt({ index }, ctx.chat ?? []) ?? index + 1,
        last: () => (rebuilt?.holder === rebuildScope() ? rebuilt.result : null),
        dismiss: () => { if (rebuilt?.holder === rebuildScope()) rebuilt = null; },
    });
    const hostWidgets = {
        ...blockWidgets.widgets,
        ...createFieldsWidgets(),
        [INSPECTOR_WIDGET]: createInspectorWidget(inspector, { enabled: () => coreOn(CORE_FEATURE.inspector), rebuild: { widget: rebuildBanner, blocked: rebuildBlocked, nameOf: module => registry.module?.(module)?.name ?? module } }),
        [REBUILD_BANNER_WIDGET]: rebuildBanner,
        [SAVEPOINTS_WIDGET]: createSavePointsWidget({
            points: savePoints,
            enabled: () => coreOn(CORE_FEATURE.savepoints),
            notify: text => globalThis.toastr?.warning?.(text, S.savepoints.title),
        }),
        // Home's "Before you start" while a module's canGenerate holds the story back (MODULES §F12).
        // A long card's "Show all" / "Show less" (screens/show-more.js).
        [SHOW_MORE_WIDGET]: createShowMoreWidget(),
        [INVENTORY_ADD_WIDGET]: createInventoryAddWidget(),
        // Home's "Your character" card (the RPG's, lean-rpg/view/start.js): this stands in for it while the RPG screens are not loaded.
        [RPG_START_WIDGET]: Object.freeze({
            props: {}, primary: null, validate: () => [],
            render(el, props, api) {
                const widget = getRpg()?.start?.widget;
                if (!widget) { el.hidden = true; return null; }
                el.hidden = false;
                return widget.render(el, props, api);
            },
        }),
        [READY_HINT_WIDGET]: createReadyHintWidget({
            blockers: () => (typeof runtime.turn?.blockers === 'function' ? runtime.turn.blockers() : []),
            unblock: (moduleId, reason) => runtime.turn?.unblock?.(moduleId, reason) ?? false,
        }),
    };
    const renderer = createScreenRenderer({
        queryAt,
        widgets,
        headIndex: () => store.headIndex(),
        sanitize: globalThis.SillyTavern?.libs?.DOMPurify?.sanitize?.bind(globalThis.SillyTavern.libs.DOMPurify) ?? null,
        formatters: () => {
            let currency = null;
            try { currency = sdk.query('inventory.currency'); } catch { currency = null; }
            // fmt.time: the story clock on its calendar (Story Director's, else the pack's, else Gregorian).
            const calendar = storyCalendar((name, args) => (registry.query(name) ? sdk.query(name, args) : null));
            return {
                // "1 mark", "44 marks": the currency's plural for any amount but one (MODULES §F1); with coins
                // the mixed coins, "3 silver 5 copper", or the smallest unit when the reader prefers (§F108).
                ...(currency?.name ? { money: n => (!Number.isInteger(n) ? '' : n < 0 ? `-${formatAmount(-n, currency)}` : formatAmount(n, currency)) } : {}),
                time: minutes => formatStoryTime(minutes, calendar),
            };
        },
    });
    // The screen registry as the mounts see it: a screen under a feature that is off is not there, and the
    // game view's and the tab strip's screens come in the reader's order (Settings → Tabs & Packs → Tabs).
    const allScreens = createScreens(readerStore(ctx));
    const screenOff = id => registry.screenOff?.(id) === true;
    const tabOrder = createTabOrderStore(ctx);
    const screens = Object.freeze({
        ...allScreens,
        resolve: id => (screenOff(id) ? null : allScreens.resolve(id)),
        list: (mount = null) => {
            const list = allScreens.list(mount).filter(entry => !screenOff(entry.id));
            return mount === 'screen' || mount === 'tab' ? orderNav(list, tabOrder.choice(), entry => entry.id, entry => entry.screen.order) : list;
        },
    });
    const extraTabs = [];
    // Whether a screen is there now (a screen hidden by default while another is: Scene while World is).
    const navPresent = id => Boolean(screens.resolve(id));
    // Whether a screen or a module's tab says `bar: true` on its own registration (in the bar until the reader moves it).
    const barDeclared = id => screens.declaredBar(id) || registry.tabs().some(tab => navKey(tab) === id && tab.bar === true);

    return { queryAt, widgets, coreOn, blockTemplates, blockWidgets, liveCtx, savePoints, inspector, hostWidgets, renderer, screens, tabOrder, extraTabs, navPresent, barDeclared, setSharedTabs: value => { sharedTabs = value; } };
}
