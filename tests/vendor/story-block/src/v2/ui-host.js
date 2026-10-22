// Story Block v2's page furniture in SillyTavern (index.js calls mountUi once): everything a reader
// clicks that is not a module's own screen.
//
// * The Story Suite bar, just above the message box: Story (the tab panel), Game view (when a module
//   offers full-screen screens; Alt+G opens and closes it too, MODULES §F53), Settings (the Story Suite
//   overlay), and the notice a canGenerate hook leaves when it held a reply back (MODULES §F12).
// * The status strip (the `hud` mount) above the message box: Story Block's feature `story-block.hud`, on
//   unless the reader turned it off (Settings → Features, or the drawer's switch; MODULES §F54, §F100). The
//   cards under replies are the feature `story-block.cards` (each card screen keeps its own switch too).
// * Features (MODULES §F100): screens, tabs and widgets under a feature the reader turned off are hidden,
//   whoever restyled them (a pack, the card, the reader); turning one on or off redraws what it touches.
// * The notes under replies (src/v2/reply-notes.js, MODULES §F40): a reply that came without change lines,
//   a reply edited since, each with Re-read when the runtime offers one. The changes card gets the reply's
//   refused lines in its scope as `refused` (§F41).
// * The tab panel: the tab host (src/v2/host-ui.js) with every module tab and every `tab` screen, a
//   side sheet on wide screens and a bottom sheet on phones. Redrawn from the head on every change.
// * The Story Block drawer in Extensions: version, modules, the same buttons.
// * The wand menu: Story Suite (the overlay). The overlay's prompt size counts what the next reply would
//   be sent (turn.preview) with SillyTavern's tokenizer when there is one; `openSettings({ fold })` opens
//   it at one fold (Home's "Import a pack" → the Packs fold, while no pack is installed).
// * The five mounts (SPEC §13.4) over the screen registry, drawn by the layout renderer (and the
//   template renderer when it is in this checkout), with the standard and module widgets, and the
//   host's own two that need the store and the chat: `story-block.inspector` (the Inspector screen,
//   MODULES §F92; feature `story-block.inspector`, off by default) and `story-block.savepoints` (the
//   save points on Home, §F93; feature `story-block.savepoints`, on).
//
// Every text is set with textContent; nothing a module or a pack wrote becomes markup here. The texts are
// in src/v2/strings.js.

import { PACKS_FOLD, createTabHost, openSettingsOverlay } from './host-ui.js';
import { mountQuery } from './sdk.js';
import { createMounts } from './view/mounts/index.js';
import { createScreenRenderer } from './view/render-screen.js';
import { formatStoryTime, storyCalendar } from './view/clock.js';
import { byNavOrder, createScreens } from './view/screens.js';
import { CHANGES_CARD_SCREEN_ID, HOME_SCREEN_ID, changesSummary } from './screens/index.js';
import { createReplyNotes } from './reply-notes.js';
import { STRINGS, fill } from './strings.js';
import { readRecord } from './persist.js';
import { CORE_FEATURE } from './features.js';
import { createInspectorSource } from './inspect.js';
import { createSavePoints } from './rewind.js';
import { createInspectorWidget, INSPECTOR_WIDGET } from './screens/inspector.js';
import { createSavePointsWidget, SAVEPOINTS_WIDGET } from './screens/savepoints.js';
import { createPacksHintWidget, PACKS_HINT_WIDGET } from './screens/packs-hint.js';
import { createReadyHintWidget, READY_HINT_WIDGET } from './screens/ready-hint.js';

const IDS = Object.freeze({ bar: 'story_suite_v2_bar', panel: 'story_suite_v2_panel', drawer: 'story_suite_v2_drawer', menu: 'story_suite_v2_menu' });

function el(doc, tag, className = '', text = '') {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function iconButton(doc, className, iconName, label, title = label) {
    const node = el(doc, 'button', `menu_button ${className}`);
    node.type = 'button';
    node.title = title;
    node.setAttribute('aria-label', title);
    const glyph = el(doc, 'i', `fa-solid ${iconName}`);
    glyph.setAttribute('aria-hidden', 'true');
    node.append(glyph, el(doc, 'span', 'story-suite-label', label));
    return node;
}

const S = STRINGS;

/** True for Alt+G alone (no Ctrl, Meta or Shift); `code` so it works whatever Alt types on a Mac. */
export const isGameViewKey = event => Boolean(event?.altKey) && !event.ctrlKey && !event.metaKey && !event.shiftKey
    && (event.code === 'KeyG' || String(event.key ?? '').toLowerCase() === 'g');

/**
 * Does message `index` of `chat` get inline cards? Only a reply after the reader's first message (not the
 * greeting) that carries a v2 record for its shown swipe.
 */
export function hasReplyRecord(chat, index) {
    const message = chat?.[index];
    if (!message || message.is_user) return false;
    const firstUser = chat.findIndex(item => item?.is_user);
    if (firstUser < 0 || index < firstUser) return false;
    return readRecord(message) !== null;
}

/**
 * The status strip is on unless the reader turned it off (MODULES §F54): the feature `story-block.hud`
 * when the reader has set it, else the drawer switch older versions kept (`storySuite.hud`).
 */
export function hudOn(extensionSettings) {
    const suite = extensionSettings?.storySuite;
    const choice = suite?.features?.[CORE_FEATURE.hud];
    return typeof choice === 'boolean' ? choice : suite?.hud !== false;
}

/** Reader choices for screens and cards: extension_settings.storySuite.{screens, cards}. */
function readerStore(ctx) {
    const root = () => {
        const es = ctx.extensionSettings ?? {};
        if (!es.storySuite || typeof es.storySuite !== 'object') es.storySuite = {};
        return es.storySuite;
    };
    return {
        reader: () => ({ screens: root().screens ?? {}, cards: root().cards ?? {} }),
        saveReader(next) {
            root().screens = next.screens ?? {};
            root().cards = next.cards ?? {};
            ctx.saveSettingsDebounced?.();
        },
    };
}

/**
 * mountUi({ runtime, ctx, doc?, version? }) → { refresh(), blocked(reason, moduleId), clearBlocked(),
 * openPanel(), closePanel(), openSettings(), toggleGameView(), setHud(on), hudOn(), screens, mounts,
 * renderer, notes, savePoints, inspector, syncScreens(), destroy() }.
 * Re-read uses `sdk.reread(index)` (or `runtime.turn.reread(index)`) when the runtime has one.
 */
export function mountUi({ runtime, ctx, doc = globalThis.document, version = '' }) {
    const { registry, store, sdk, settings, events } = runtime;
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
    // The host's own widgets: the Inspector (over the store's replay) and the save points (over the chat).
    const liveCtx = () => globalThis.SillyTavern?.getContext?.() ?? ctx;
    const savePoints = createSavePoints({ ctx, store, live: liveCtx, ...(runtime.createBranch ? { createBranch: runtime.createBranch } : {}) });
    const inspector = createInspectorSource({
        store,
        chat: () => ctx.chat ?? [],
        chatId: () => (typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx.chatId),
        problems: index => inspectorProblems(index),
    });
    const hostWidgets = {
        [INSPECTOR_WIDGET]: createInspectorWidget(inspector, { enabled: () => coreOn(CORE_FEATURE.inspector) }),
        [SAVEPOINTS_WIDGET]: createSavePointsWidget({
            points: savePoints,
            enabled: () => coreOn(CORE_FEATURE.savepoints),
            notify: text => globalThis.toastr?.warning?.(text, S.savepoints.title),
        }),
        // Home's "Before you start" while a module's canGenerate holds the story back (MODULES §F12).
        [READY_HINT_WIDGET]: createReadyHintWidget({
            blockers: () => (typeof runtime.turn?.blockers === 'function' ? runtime.turn.blockers() : []),
            unblock: (moduleId, reason) => runtime.turn?.unblock?.(moduleId, reason) ?? false,
        }),
        // Home's "Import a pack" while no pack is installed: the settings, open at the Packs fold.
        [PACKS_HINT_WIDGET]: createPacksHintWidget({
            list: () => {
                if (typeof runtime.packs?.packs?.list === 'function') return runtime.packs.packs.list();
                try { return registry.query('packs.list') ? sdk.query('packs.list') ?? [] : null; } catch { return null; }
            },
            subscribe: fn => runtime.packs?.packs?.subscribe?.(fn) ?? null,
            open: () => {
                mounts.screen.close?.();
                openSettings({ fold: PACKS_FOLD });
            },
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
                // "1 mark", "44 marks": the currency's plural for any amount but one (MODULES §F1).
                ...(currency?.name ? { money: n => (Number.isInteger(n) ? `${n} ${Math.abs(n) === 1 ? currency.name : currency.plural || currency.name}` : '') } : {}),
                time: minutes => formatStoryTime(minutes, calendar),
            };
        },
    });
    // The screen registry as the mounts see it: a screen under a feature that is off is not there.
    const allScreens = createScreens(readerStore(ctx));
    const screenOff = id => registry.screenOff?.(id) === true;
    const screens = Object.freeze({
        ...allScreens,
        resolve: id => (screenOff(id) ? null : allScreens.resolve(id)),
        list: (mount = null) => allScreens.list(mount).filter(entry => !screenOff(entry.id)),
    });
    const extraTabs = [];

    // ---- screens from the modules and the packs ----------------------------------------------
    function syncScreens() {
        const byModule = new Map();
        // Every module with screens, even one whose screens are all off just now (its list is then empty).
        for (const def of registry.modules()) if (Array.isArray(def.screens) && def.screens.length) byModule.set(def.id, []);
        for (const screen of registry.screens()) {
            const { moduleId, ...def } = screen;
            if (!byModule.has(moduleId)) byModule.set(moduleId, []);
            byModule.get(moduleId).push(def);
        }
        for (const [moduleId, list] of byModule) {
            try { screens.addModule(moduleId, list); } catch (error) { console.warn('[Story Suite]', error?.message ?? error); }
        }
        let packScreens = [];
        try { packScreens = sdk.query('packs.content', { kind: 'screens' }) ?? []; } catch { packScreens = []; }
        const byPack = new Map();
        for (const screen of packScreens) {
            const { pack, ...def } = screen ?? {};
            if (!pack) continue;
            if (!byPack.has(pack)) byPack.set(pack, []);
            byPack.get(pack).push(def);
        }
        for (const [pack, list] of byPack) {
            try { screens.setPack(pack, list); } catch (error) { console.warn('[Story Suite]', error?.message ?? error); }
        }
    }

    const api = Object.freeze({
        command: (type, payload, options) => sdk.command(type, payload, options),
        preview: (type, payload) => sdk.preview(type, payload),
        commit: token => sdk.commit(token),
        query: (name, args) => sdk.query(name, args),
        on: (name, fn) => sdk.on(name, fn),
        rewind: options => sdk.rewind(options),
        substitute: text => sdk.substitute(text),
        dialog: Object.freeze({ open: (screenId, opts) => sdk.dialog.open(screenId, opts), current: () => sdk.dialog.current?.() ?? null }),
    });
    const carriers = () => (ctx.chat ?? []).map((message, index) => (message && !message.is_user ? index : -1)).filter(index => index >= 0);
    // Cards go under replies with a story record of their own; never under the greeting (every message
    // before the reader's first one), which holds the chat's start, not a reply's changes.
    const hasCard = index => hasReplyRecord(ctx.chat ?? [], index);
    // ---- notes under replies, and the refused lines the changes card shows ----------------------
    const rereadFn = typeof sdk.reread === 'function' ? index => sdk.reread(index)
        : typeof runtime.turn?.reread === 'function' ? index => runtime.turn.reread(index) : null;
    const notes = createReplyNotes({
        ctx,
        doc,
        turn: runtime.turn ?? null,
        events,
        reread: rereadFn,
        extractorOn: () => {
            try { return typeof sdk.feature === 'function' ? sdk.feature(CORE_FEATURE.extractor) : sdk.settings('story-block')?.assistExtractor === true; } catch { return false; }
        },
        // The extractor ran on reply `index` (this swipe, this chat) and its call failed: the note shows.
        extractorFailed: (index, swipe) => {
            try {
                const chat = String(ctx.getCurrentChatId?.() ?? ctx.chatId ?? '');
                const runs = sdk.query('assist.status')?.runs ?? [];
                const last = runs.findLast(run => run?.helper === 'extractor' && run.index === index && run.swipe === swipe && (run.chat ?? '') === chat);
                return last?.outcome === 'failed' || last?.outcome === 'timeout';
            } catch { return false; }
        },
        onChanged: index => mounts?.card?.refresh?.(index, { force: true }),
    });
    // What the Inspector lists as a reply's problems: blocks its replay skipped, and what the turn met
    // reading it in this session (change lines not used, with why); the refused lines the notes keep
    // stand in when the turn's list has nothing for that reply.
    function inspectorProblems(index) {
        const out = [];
        for (const item of store.problems?.() ?? []) if (item.index === index) out.push({ code: item.code ?? 'SKIPPED', message: item.message });
        const told = (runtime.turn?.problems?.() ?? []).filter(item => item?.index === index);
        for (const item of told) out.push({ code: item.code ?? '', message: item.line ? `"${item.line}": ${item.message}` : item.message });
        if (!told.length) for (const item of notes.refusedAt(index)) out.push({ code: 'REFUSED', message: item.reason ? `"${item.line}": ${item.reason}` : `"${item.line}"` });
        return out;
    }
    // A card's scope also gets `refused`: that reply's change lines the code did not apply.
    const drawScreen = renderer.render;
    renderer.render = (el, screen, scope) => drawScreen(el, screen, scope?.mount === 'card' ? { ...scope, refused: notes.refusedAt(scope.index) } : scope);
    const mounts = createMounts({
        screens,
        render: renderer.render,
        // A chat with no carrier has head index -1 (and a stale index can point past the end): no
        // state there, so the mounts show nothing instead of failing on store.at's RangeError.
        stateAt: index => (Number.isInteger(index) && index >= 0 && index < (ctx.chat?.length ?? 0) ? store.at(index) : null),
        headIndex: () => store.headIndex(),
        query: queryAt,
        changesAt: index => store.changesAt(index),
        opsAt: index => store.opsAt(index),
        summary(screen, { index, state, before, changes }) {
            if (screen?.id !== CHANGES_CARD_SCREEN_ID) return null;
            let currency = null;
            try { currency = sdk.query('inventory.currency'); } catch { currency = null; }
            return changesSummary({ state, before, changes, currency, refused: notes.refusedAt(index).length });
        },
        settings: screenId => {
            const owner = String(screenId ?? '').split('/')[0];
            return sdk.settings(registry.has(owner) ? owner : 'story-block');
        },
        // Cards: the reader's switch per card screen, under Story Block's `story-block.cards` feature.
        enabled: (mount, screenId) => (mount === 'card' ? coreOn(CORE_FEATURE.cards) && screens.cardsOn(screenId) : true),
        api,
        on: (name, fn) => events.on(name, fn),
        carriers,
        hasCard,
        swipeAt: index => ctx.chat?.[index]?.swipe_id ?? 0,
        eventSource: ctx.eventSource,
        eventTypes: ctx.eventTypes ?? ctx.event_types,
        addTab(tab) {
            extraTabs.push(tab);
            return () => {
                const at = extraTabs.indexOf(tab);
                if (at >= 0) extraTabs.splice(at, 1);
            };
        },
        document: doc,
    });
    runtime.setDialog?.((screenId, opts) => mounts.dialog.open(screenId, opts), () => mounts.dialog.current?.() ?? null);
    // The tab host sees the module tabs and the tab screens as one list, in navigation order (Home's
    // neighbours first: Party, Quests, Scene, Inventory, Map, then the rest; a tab's `order` moves it).
    const tabSource = { tabs: () => byNavOrder([...registry.tabs(), ...extraTabs.map(tab => ({ ...tab, moduleId: 'screens' }))]) };

    // ---- the panel ---------------------------------------------------------------------------
    let tabHost = null;
    const panel = el(doc, 'div', 'story-suite-sheet');
    panel.id = IDS.panel;
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', S.panel.title);
    const panelHead = el(doc, 'div', 'story-suite-sheet-head');
    panelHead.appendChild(el(doc, 'b', '', S.panel.title));
    const panelClose = iconButton(doc, 'story-suite-sheet-close', 'fa-xmark', '', S.panel.close);
    panelHead.appendChild(panelClose);
    const panelBody = el(doc, 'div', 'story-suite-sheet-body');
    panel.append(panelHead, panelBody);
    doc.body.appendChild(panel);

    function openPanel() {
        panel.hidden = false;
        doc.body.classList.add('story-suite-sheet-open');
        if (!tabHost) tabHost = createTabHost(panelBody, { registry: tabSource, view: () => sdk.view(), api: sdk, doc });
        else tabHost.refresh();
    }
    function closePanel() {
        panel.hidden = true;
        doc.body.classList.remove('story-suite-sheet-open');
    }
    panelClose.addEventListener('click', closePanel);

    // The settings overlay. Its prompt size is what the next ordinary reply would be sent (turn.preview:
    // built on demand, never sent, nothing changed), counted with SillyTavern's tokenizer when the context
    // has one; it is counted again when a feature flips or the story moves while the overlay is open.
    let overlay = null;
    const countTokens = () => {
        const live = liveCtx();
        return typeof live?.getTokenCountAsync === 'function' ? text => live.getTokenCountAsync(text) : null;
    };
    function openSettings(options = null) {
        const fold = typeof options?.fold === 'string' ? options.fold : null;
        overlay = openSettingsOverlay({
            registry, settings, doc, sdk, features: runtime.features ?? null, fold,
            promptParts: typeof runtime.turn?.previewFit === 'function' ? () => runtime.turn.previewFit()
                : typeof runtime.turn?.preview === 'function' ? () => runtime.turn.preview() : null,
            countTokens: countTokens(),
            onClose: () => { overlay = null; },
        });
        return overlay;
    }

    // ---- the bar above the message box ------------------------------------------------------
    const bar = el(doc, 'div', 'story-suite-bar');
    bar.id = IDS.bar;
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', S.bar.label);
    const storyButton = iconButton(doc, 'story-suite-bar-story', 'fa-book-open', S.bar.story, S.bar.storyTitle);
    const gameButton = iconButton(doc, 'story-suite-bar-game', 'fa-expand', S.bar.game, S.bar.gameTitle);
    gameButton.setAttribute('aria-keyshortcuts', 'Alt+G');
    const settingsButton = iconButton(doc, 'story-suite-bar-settings', 'fa-sliders', S.bar.suite, S.bar.suiteTitle);
    const notice = el(doc, 'div', 'story-suite-notice');
    notice.setAttribute('role', 'status');
    notice.hidden = true;
    const noticeText = el(doc, 'span', 'story-suite-notice-text');
    const noticeClose = iconButton(doc, 'story-suite-notice-close', 'fa-xmark', '', S.bar.dismiss);
    notice.append(noticeText, noticeClose);
    bar.append(storyButton, gameButton, settingsButton, notice);
    storyButton.addEventListener('click', () => (panel.hidden ? openPanel() : closePanel()));
    gameButton.addEventListener('click', () => mounts.screen.open(HOME_SCREEN_ID));
    settingsButton.addEventListener('click', () => openSettings());
    noticeClose.addEventListener('click', () => clearBlocked());

    // Alt+G: the game view, open or closed (MODULES §F53). The bar button stays the visible way in.
    function toggleGameView() {
        if (mounts.screen.isOpen()) {
            mounts.screen.close();
            return false;
        }
        return mounts.screen.open(HOME_SCREEN_ID);
    }
    const onKey = event => {
        if (!isGameViewKey(event) || event.repeat) return;
        if (!mounts.screen.isOpen() && screens.list('screen').length === 0) return;
        event.preventDefault?.();
        event.stopPropagation?.();
        toggleGameView();
    };
    doc.addEventListener?.('keydown', onKey);
    const placeBar = () => {
        const anchor = doc.querySelector('#send_form');
        if (anchor?.parentNode && bar.nextElementSibling !== anchor && bar.parentNode !== anchor.parentNode) anchor.parentNode.insertBefore(bar, anchor);
        else if (!bar.parentNode) doc.body.appendChild(bar);
    };
    placeBar();

    // ---- the Extensions drawer and the wand menu -------------------------------------------
    const drawerStatus = el(doc, 'p', 'story-suite-muted');
    let hudCheck = null;
    function drawer() {
        const host = doc.querySelector('#extensions_settings2') ?? doc.querySelector('#extensions_settings');
        if (!host || doc.querySelector(`#${IDS.drawer}`)) return;
        const root = el(doc, 'div', 'inline-drawer story-suite-drawer');
        root.id = IDS.drawer;
        const toggle = el(doc, 'div', 'inline-drawer-toggle inline-drawer-header');
        toggle.appendChild(el(doc, 'b', '', S.drawer.title));
        toggle.appendChild(el(doc, 'div', 'inline-drawer-icon fa-solid fa-circle-chevron-down down'));
        const content = el(doc, 'div', 'inline-drawer-content');
        const buttons = el(doc, 'div', 'story-suite-drawer-buttons');
        const one = iconButton(doc, '', 'fa-sliders', S.drawer.settings);
        const two = iconButton(doc, '', 'fa-book-open', S.drawer.panel);
        one.addEventListener('click', () => openSettings());
        two.addEventListener('click', openPanel);
        buttons.append(one, two);
        // The status strip's switch (on by default, MODULES §F54).
        const hudRow = el(doc, 'label', 'checkbox_label story-suite-hud-toggle');
        hudRow.title = S.drawer.hudTitle;
        hudCheck = el(doc, 'input');
        hudCheck.type = 'checkbox';
        hudCheck.setAttribute('type', 'checkbox');
        hudCheck.checked = hudOn(ctx.extensionSettings);
        hudCheck.addEventListener('change', () => setHud(hudCheck.checked));
        hudRow.append(hudCheck, el(doc, 'span', '', S.drawer.hud));
        content.append(drawerStatus, buttons, hudRow);
        root.append(toggle, content);
        host.appendChild(root);
    }
    function menu() {
        const host = doc.querySelector('#extensionsMenu');
        if (!host || doc.querySelector(`#${IDS.menu}`)) return;
        const item = el(doc, 'div', 'list-group-item flex-container flexGap5 interactable');
        item.id = IDS.menu;
        item.tabIndex = 0;
        item.append(el(doc, 'div', 'fa-solid fa-sliders extensionsMenuExtensionButton'), el(doc, 'span', '', S.menu.suite));
        item.addEventListener('click', () => openSettings());
        host.appendChild(item);
    }
    drawer();
    menu();

    // ---- the canGenerate notice ------------------------------------------------------------
    let blockedBy = null;
    function blocked(reason, moduleId) {
        blockedBy = moduleId ?? null;
        const name = registry.module(moduleId)?.name ?? moduleId ?? S.bar.label;
        noticeText.textContent = fill(S.bar.blocked, { module: name, reason });
        notice.hidden = false;
        bar.classList.add('story-suite-bar-blocked');
    }
    function clearBlocked() {
        blockedBy = null;
        notice.hidden = true;
        noticeText.textContent = '';
        bar.classList.remove('story-suite-bar-blocked');
    }

    // ---- keeping it all current -------------------------------------------------------------
    function refresh() {
        placeBar();
        drawer();
        menu();
        const modules = sdk.modules();
        drawerStatus.textContent = fill(S.drawer.status, { version, modules: modules.map(module => module.name).join(', ') });
        gameButton.hidden = screens.list('screen').length === 0;
        mounts.tab.register();
        if (!panel.hidden) tabHost?.refresh();
        if (hudOn(ctx.extensionSettings)) mounts.hud.show();
        else mounts.hud.hide();
        if (hudCheck) hudCheck.checked = hudOn(ctx.extensionSettings);
        mounts.screen.update();
        notes.refreshAll();
    }

    /**
     * Turns the status strip on or off and keeps the choice: the feature `story-block.hud`, and the old
     * `storySuite.hud` switch with it (so an older Story Block reads the same choice).
     */
    function setHud(on) {
        const es = ctx.extensionSettings ?? {};
        if (!es.storySuite || typeof es.storySuite !== 'object') es.storySuite = {};
        es.storySuite.hud = Boolean(on);
        if (runtime.features?.set?.(CORE_FEATURE.hud, Boolean(on)) === undefined) {
            if (!es.storySuite.features || typeof es.storySuite.features !== 'object') es.storySuite.features = {};
            es.storySuite.features[CORE_FEATURE.hud] = Boolean(on);
            ctx.saveSettingsDebounced?.();
        }
        refresh();
        return Boolean(on);
    }
    const offs = [];
    for (const name of ['head', 'committed']) offs.push(events.on(name, () => { if (!panel.hidden) tabHost?.refresh(); }));
    // A feature turned on or off: its screens, tabs, widgets and cards come and go; nothing else changes.
    for (const name of ['head', 'committed', 'turn']) offs.push(events.on(name, () => overlay?.refreshSize?.()));
    offs.push(events.on('feature', () => {
        // The overlay draws the switch and the fields of that feature again, and the prompt size.
        overlay?.refresh?.();
        syncScreens();
        // A dialog open on a screen that is gone now closes: its controls belong to a part turned off.
        mounts.dialog?.closeWhere?.(screenId => !screens.resolve(screenId));
        refresh();
        mounts.card?.refreshAll?.({ force: true });
    }));
    // The notice goes once the module that held the story back no longer does (the character was made).
    offs.push(events.on('committed', async () => {
        if (!blockedBy || typeof runtime.turn?.blockers !== 'function') return;
        const was = blockedBy;
        let still = true;
        try { still = (await runtime.turn.blockers()).some(entry => entry.moduleId === was); } catch { still = true; }
        if (!still && blockedBy === was) clearBlocked();
    }));
    offs.push(events.on('turn', done => {
        clearBlocked();
        if (!panel.hidden) tabHost?.refresh();
        // The card under that reply now knows its refused lines.
        if (Number.isInteger(done?.index)) mounts.card?.refresh?.(done.index, { force: true });
    }));

    syncScreens();
    refresh();
    mounts.card?.attachAll?.();

    return {
        refresh,
        blocked,
        clearBlocked,
        openPanel,
        closePanel,
        openSettings,
        toggleGameView,
        setHud,
        hudOn: () => hudOn(ctx.extensionSettings),
        syncScreens() { syncScreens(); refresh(); mounts.card?.refreshAll?.({ force: true }); },
        screens,
        mounts,
        renderer,
        notes,
        savePoints,
        inspector,
        destroy() {
            overlay?.close?.();
            doc.removeEventListener?.('keydown', onKey);
            offs.splice(0).forEach(off => off?.());
            notes.destroy();
        },
    };
}
