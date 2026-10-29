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
// * Choices under replies (src/v2/extras-ui.js, MODULES §F115): the latest reply's choices as buttons
//   that only fill the message box. Inner chatter is not drawn under replies (World → Now or Scene shows it).
// * The tab panel: the tab host (src/v2/host-ui.js) with every module tab and every `tab` screen, a
//   side sheet on wide screens and a bottom sheet on phones. Redrawn from the head on every change.
// * The reader's tab order (src/v2/view/tab-order.js, Settings → Tabs & Packs → Tabs): one list for the
//   panel's tabs and the game view's screens, Up/Down, Shown, Reset to default. Hidden ones leave the
//   tab strip and the game view's navigation; Home is always first and shown.
// * The Story Block drawer in Extensions: version, modules, the same buttons.
// * Settings → Diagnostics (src/v2/diagnostics.js): a report to copy or save, made from the runtime's
//   parts and each module's `hooks.diagnostics`; Story Suite's console errors are caught for it. And
//   "Show the UI sample" (src/v2/screens/ui-sample.js): every building block of the look, light and dark.
// * The look (src/v2/view/theme.js): the theme bridge writes Story Suite's tokens (light or dark from
//   SillyTavern's theme, Settings → Story Suite → Panel style and Font) for every Story Suite root.
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

import { formatAmount } from './domains/money.js';
import { PACKS_FOLD, TABS_TEXT, createTabHost } from './host-ui.js';
import { openSettingsWindow } from './view/settings/window.js';
import { mountQuery } from './sdk.js';
import { createMounts } from './view/mounts/index.js';
import { TEMPLATES, applyScreenCss, createScreenRenderer } from './view/render-screen.js';
import { formatStoryTime, storyCalendar } from './view/clock.js';
import { gameHeroProps, readHeroContext } from './view/game-header.js';
import { HOME_ID, createScreens } from './view/screens.js';
import { createTabOrderStore, isDefaultChoice, isHiddenNav, moveNav, navKey, orderNav, setNavHidden, visibleNav } from './view/tab-order.js';
import { CHANGES_CARD_SCREEN_ID, HOME_SCREEN_ID, changesSummary, replyCardLines } from './screens/index.js';
import { createReplyNotes } from './reply-notes.js';
import { createReplyExtras } from './extras-ui.js';
import { displayLines } from './extras.js';
import { STRINGS, fill } from './strings.js';
import { readRecord } from './persist.js';
import { laterStore, scanReplyCards } from './reply-cards.js';
import { drawReplyCard } from './view/reply-cards-ui.js';
import { CORE_FEATURE } from './features.js';
import { createInspectorSource } from './inspect.js';
import { createSavePoints } from './rewind.js';
import { createInspectorWidget, INSPECTOR_WIDGET } from './screens/inspector.js';
import { createSavePointsWidget, SAVEPOINTS_WIDGET } from './screens/savepoints.js';
import { createReadyHintWidget, READY_HINT_WIDGET } from './screens/ready-hint.js';
import { createShowMoreWidget, SHOW_MORE_WIDGET } from './screens/show-more.js';
import { buildReport, captureConsole, caughtSoFar, reportFileName } from './diagnostics.js';
import { createThemeBridge } from './view/theme.js';
import { activeNow } from './view/mounts/common.js';
import { openUiSample } from './screens/ui-sample.js';

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
 * renderer, notes, extras, savePoints, inspector, tabs (Settings → Tabs: rows(), move(id, delta),
 * setHidden(id, hidden), reset(), isDefault()), syncScreens(), destroy() }.
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
        // A long card's "Show all" / "Show less" (screens/show-more.js).
        [SHOW_MORE_WIDGET]: createShowMoreWidget(),
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

    // ---- screens from the modules and the packs ----------------------------------------------
    // The screen ids each pack gave at the last sync, by pack: a pack that is disabled, removed or no longer has a screen takes
    // those screens and their stylesheets away, and a replaced pack's new stylesheets replace the old ones.
    const packScreenIds = new Map();
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
        try { packScreens.push(...(sdk.query('dataModules.presentation', { kind: 'screens' }) ?? [])); } catch { /* older host */ }
        const byPack = new Map();
        for (const screen of packScreens) {
            const { pack, ...def } = screen ?? {};
            if (!pack) continue;
            if (!byPack.has(pack)) byPack.set(pack, []);
            byPack.get(pack).push(def);
        }
        for (const [pack, ids] of packScreenIds) {
            if (byPack.has(pack)) continue;
            screens.removePack(pack);
            for (const id of ids) applyScreenCss(doc, { id, css: '' });
            packScreenIds.delete(pack);
        }
        for (const [pack, list] of byPack) {
            const before = packScreenIds.get(pack) ?? [];
            const now = list.map(def => def.id);
            for (const id of before) if (!now.includes(id)) applyScreenCss(doc, { id, css: '' });
            try {
                screens.setPack(pack, list);
                packScreenIds.set(pack, now);
                for (const def of list) applyScreenCss(doc, def, TEMPLATES.scopeCss);
            } catch (error) { console.warn('[Story Suite]', error?.message ?? error); }
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
        // A reply card's "open" action: the screen in the game view (window on desktop, full screen on a phone).
        openScreen: id => mounts?.screen?.open?.(id) ?? false,
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
    // Choices under the latest reply (MODULES §F115), read from its own text.
    const extras = createReplyExtras({
        ctx,
        doc,
        events,
        display: typeof runtime.display === 'function' ? runtime.display : mes => displayLines(mes, { entryOf: word => registry.capture(word) }),
        featureOn: id => registry.featureOn?.(id) === true,
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
    // A card's scope also gets `refused`: that reply's change lines the code did not apply; the "Changed this
    // reply" card also `moduleLines`: the modules' own lines for that reply (hooks.replyCard, MODULES §F125).
    const cardLines = (index, state, changes) => replyCardLines(registry.hookEntries?.('replyCard') ?? [], { index, state, changes });
    const drawScreen = renderer.render;
    // …and `assisted`: the lines the Assist safety net applied on it (its receipts marked `assist`).
    const assistedAt = index => {
        try {
            return (readRecord(ctx.chat?.[index])?.receipts ?? []).filter(receipt => receipt?.assist === 'now' || receipt?.assist === 'late')
                .map(receipt => ({ line: String(receipt.assistLine ?? receipt.summary ?? ''), late: receipt.assist === 'late' }));
        } catch { return []; }
    };
    renderer.render = (el, screen, scope) => drawScreen(el, screen, scope?.mount === 'card'
        ? { ...scope, refused: notes.refusedAt(scope.index), assisted: assistedAt(scope.index), ...(screen?.id === CHANGES_CARD_SCREEN_ID ? { moduleLines: cardLines(scope.index, scope.state, scope.changes) } : {}) }
        : scope);
    // The story head a dialog was opened on (mounts/dialog.js): the head's index and record. Which swipe is shown is not part of
    // it: a swipe that keeps the head record is not a move (the chat's id is checked on its own).
    const branchNow = () => {
        const index = store.headIndex();
        if (!Number.isInteger(index) || index < 0) return `${index}`;
        return `${index}|${readRecord(ctx.chat?.[index])?.sid ?? ''}`;
    };
    // ---- cards under replies (reply-cards.js): each card is asked once, on the head reply's state; the scan is kept per chat, head and rev ----
    const replyLater = laterStore();
    let replyScan = null;          // { key, map } for the chat, head and rev it was made on
    let replyNodes = new Map();    // drawn card nodes by `${chat}|${index}|${card key}`, reused while the card is the same
    const pageFolds = new Set();   // folds of a chat with no id: this page only, never saved
    const dropReplyScan = () => { replyScan = null; };
    const replyOffs = ['head', 'committed', 'turn', 'feature'].map(name => events.on(name, dropReplyScan));
    const replyChatTypes = ctx.eventTypes ?? ctx.event_types ?? {};
    if (typeof ctx.eventSource?.on === 'function' && replyChatTypes.CHAT_CHANGED) {
        const chatLeft = () => { dropReplyScan(); pageFolds.clear(); replyNodes = new Map(); };
        ctx.eventSource.on(replyChatTypes.CHAT_CHANGED, chatLeft);
        replyOffs.push(() => (ctx.eventSource.removeListener ?? ctx.eventSource.off)?.call(ctx.eventSource, replyChatTypes.CHAT_CHANGED, chatLeft));
    }
    const chatKeyNow = () => String(ctx.getCurrentChatId?.() ?? ctx.chatId ?? '');
    // The Later fold is kept per chat and card key (not per message: a new reply does not reset it); a chat with no id keeps it
    // for this page only.
    const foldKey = (chat, key) => (chat ? `${chat}|${key}` : '');
    const foldedNow = (chat, key) => (chat ? replyLater.has(foldKey(chat, key)) : pageFolds.has(key));
    const setFold = (chat, key, on) => {
        if (chat) replyLater.set(foldKey(chat, key), on);
        else if (on) pageFolds.add(key);
        else pageFolds.delete(key);
    };
    const replyHead = () => {
        const index = store.headIndex();
        return Number.isInteger(index) && index >= 0 && index < (ctx.chat?.length ?? 0) ? index : -1;
    };
    const replyScanAt = (head, chat) => {
        const stored = head >= 0 ? store.at(head) : null;
        const key = `${chat}|${head}|${stored?.meta?.rev ?? ''}`;
        if (replyScan?.key === key) return replyScan.map;
        const entries = registry.cardEntries?.() ?? [];
        // A brand-new chat holds only the greeting and no story record yet (nothing has been read or written): the head has no state, so
        // the cards are asked on the initial one, and a start card shows before the first reply.
        let state = stored;
        if (!state && head >= 0 && entries.length) {
            try { state = runtime.initial?.() ?? null; } catch { state = null; }
        }
        const map = entries.length && state ? scanReplyCards(entries, {
            head,
            messageAt: i => ctx.chat?.[i] ?? null,
            stateAt: () => state,
            query: (name, args, at) => queryAt(name, args, at),
            chatId: chat,
            // A card that stops being drawn drops its fold: a later card of the same id starts unfolded.
            onEnded: id => { if (foldedNow(chat, id)) setFold(chat, id, false); },
        }) : new Map();
        replyScan = { key, map };
        return map;
    };
    const replyCardsAt = index => {
        // Cards follow the head: only the head reply carries them (the greeting when it is the only reply).
        const head = replyHead();
        if (index !== head) return [];
        const chat = chatKeyNow();
        const items = replyScanAt(head, chat).get(head) ?? [];
        const drawn = new Map();
        const nodes = items.map(item => {
            const folded = foldedNow(chat, item.key);
            const nodeKey = `${chat}|${index}|${item.key}`;
            let sign = null;
            try { sign = JSON.stringify([item.card, folded]); } catch { sign = null; }
            const kept = replyNodes.get(nodeKey);
            const node = sign !== null && kept?.sign === sign ? kept.node : drawReplyCard(doc, item, {
                head: true,
                folded,
                onFold: on => { setFold(chat, item.key, on); mounts?.card?.refresh?.(index, { force: false }); },
                onAct: action => runReplyAction(action),
            });
            drawn.set(nodeKey, { sign, node });
            return node;
        });
        replyNodes = drawn;
        return nodes;
    };
    // A card's "open" names a screen: the game view when the screen has a screen mount, else its dialog (a wizard is dialog-only;
    // the action's `payload` is the dialog's starting draft), else nothing; that is said once per screen.
    const unopened = new Set();
    function openReplyScreen(id, payload) {
        const mountsOf = screens.resolve(id)?.screen?.mounts ?? [];
        if (mountsOf.includes('screen') && api.openScreen(id)) return;
        if (mountsOf.includes('dialog')) {
            let draft = {};
            try { draft = JSON.parse(JSON.stringify(payload ?? {})); } catch { draft = {}; }
            if (api.dialog.open(id, { draft })) return;
        }
        if (unopened.has(id)) return;
        unopened.add(id);
        console.warn(`[Story Suite] a card asked to open "${id}", which has no screen or dialog to show.`);
    }
    // A reply card's action: "open" shows the screen; "command" sends the command (sdk.command, recorded with the reply).
    function runReplyAction(action) {
        if (action.open) { openReplyScreen(action.open, action.payload); return; }
        if (action.command) {
            try { Promise.resolve(api.command(action.command, JSON.parse(JSON.stringify(action.payload ?? {})), { cause: 'ui' })).catch(() => {}); } catch { /* the host reports its own failures */ }
        }
    }
    const mounts = createMounts({
        screens,
        render: renderer.render,
        replyCards: index => replyCardsAt(index),
        hasReplyCards: () => (registry.cardEntries?.().length ?? 0) > 0,
        chatScope: () => ({ chat: String(ctx.getCurrentChatId?.() ?? ctx.chatId ?? ''), branch: branchNow() }),
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
            return changesSummary({ state, before, changes, currency, refused: notes.refusedAt(index).length, assisted: assistedAt(index).length, lines: cardLines(index, state, changes) });
        },
        settings: screenId => {
            const owner = String(screenId ?? '').split('/')[0];
            return sdk.settings(registry.has(owner) ? owner : 'story-block');
        },
        // Cards: the reader's switch per card screen, under Story Block's `story-block.cards` feature.
        enabled: (mount, screenId) => (mount === 'card' ? coreOn(CORE_FEATURE.cards) && screens.cardsOn(screenId) : true),
        api,
        // The game view's header (UI stage 5a): the lead and the scene, read through the queries, the story time through
        // the host's own calendar formatter (the same one the screens' fmt.time uses).
        heroOf: state => gameHeroProps({
            state,
            query: (name, args) => queryAt(name, args, state),
            context: readHeroContext(),
            formatTime: minutes => formatStoryTime(minutes, storyCalendar((name, args) => (registry.query(name) ? sdk.query(name, args) : null))),
        }),
        on: (name, fn) => events.on(name, fn),
        carriers,
        hasCard,
        swipeAt: index => ctx.chat?.[index]?.swipe_id ?? 0,
        eventSource: ctx.eventSource,
        eventTypes: ctx.eventTypes ?? ctx.event_types,
        // The game view's navigation leaves out the screens the reader hid (they still open by name).
        inNav: screenId => !isHiddenNav(tabOrder.choice(), screenId, navPresent),
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
    // The tab host sees the module tabs and the tab screens as one list, in the reader's order (else the
    // default: screens.js screenOrder), without the ones the reader hid. A module tab goes by
    // "<module>/<id>" there, so NPC State Delta's Cast tab and its Cast screen are one entry.
    const panelTabs = () => [...registry.tabs(), ...extraTabs.map(tab => ({ ...tab, moduleId: 'screens' }))];
    // A module's tab that is active only sometimes is listed while its `active` says so (its alert is read at each draw).
    const headStateNow = () => { const index = store.headIndex(); return Number.isInteger(index) && index >= 0 ? store.at(index) : null; };
    const activeTabs = () => panelTabs()
        .filter(tab => typeof tab.active !== 'function' || activeNow(tab, headStateNow(), queryAt).on)
        .map(tab => {
            if (typeof tab.active !== 'function') return tab;
            const now = activeNow(tab, headStateNow(), queryAt);
            return { ...tab, alert: now.alert, alertText: now.badge ?? '' };
        });
    const tabSource = { tabs: () => visibleNav(activeTabs(), tabOrder.choice(), navKey, tab => tab.order, navPresent) };

    // Settings → Tabs & Packs → Tabs: every tab and screen once (by id), where it shows, in the reader's order.
    function tabRows() {
        const rows = new Map();
        const add = (id, screen, where) => {
            if (!id) return;
            const { title, icon, order } = screen ?? {};
            const row = rows.get(id) ?? { id, title: String(title || id), icon: icon || '', order, where: [] };
            if (!row.where.includes(where)) row.where.push(where);
            // A tab or screen that is shown only while active: Settings says so instead of a switch (its own note, if it gave one).
            if (typeof screen?.active === 'function') row.activeNote = typeof screen.activeNote === 'string' && screen.activeNote ? screen.activeNote : TABS_TEXT.activeNote;
            rows.set(id, row);
        };
        for (const mount of ['screen', 'tab']) for (const entry of screens.list(mount)) add(entry.id, entry.screen, mount);
        for (const tab of registry.tabs()) add(navKey(tab), tab, 'tab');
        const choice = tabOrder.choice();
        return orderNav([...rows.values()], choice).map(row => ({
            ...row,
            fixed: row.id === HOME_ID,
            hidden: isHiddenNav(choice, row.id, navPresent),
        }));
    }
    // After a change: the tab strip and the game view's navigation follow at once.
    function refreshNav() {
        if (!panel.hidden) tabHost?.refresh();
        mounts.screen.update();
    }
    const tabsControl = Object.freeze({
        rows: tabRows,
        move(id, delta) {
            const ids = tabRows().filter(row => !row.fixed).map(row => row.id);
            tabOrder.set(moveNav(tabOrder.choice(), ids, id, delta));
            refreshNav();
        },
        setHidden(id, hidden) {
            tabOrder.set(setNavHidden(tabOrder.choice(), id, hidden));
            refreshNav();
        },
        reset() {
            tabOrder.reset();
            refreshNav();
        },
        isDefault: () => isDefaultChoice(tabOrder.choice()),
    });

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
        if (!tabHost) tabHost = createTabHost(panelBody, { registry: tabSource, view: () => sdk.view(), api: sdk, doc, barHost: panel });
        else tabHost.refresh();
    }
    function closePanel() {
        // More's sheet, if it is open, goes with the panel: its scrim and its keys (the focus does not go to a hidden tile). The
        // dialogs the panel opened go too (their opener is in the panel, and it is about to be hidden).
        tabHost?.bar?.closeMore({ focus: false });
        mounts.dialog?.closeOpenedIn?.(panel);
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
    // Settings → Diagnostics (diagnostics.js): the report's parts, read when it is built. SillyTavern's
    // version is the one its page shows (else its /version answer). Each module's `hooks.diagnostics`
    // adds its own section.
    const promptParts = typeof runtime.turn?.previewFit === 'function' ? () => runtime.turn.previewFit()
        : typeof runtime.turn?.preview === 'function' ? () => runtime.turn.preview() : null;
    const stVersion = async () => {
        const shown = doc.querySelector?.('#version_display')?.textContent?.trim();
        if (shown && shown !== 'SillyTavern') return shown;
        const fetcher = (doc.defaultView ?? globalThis).fetch;
        if (typeof fetcher !== 'function') return '';
        const answer = await fetcher('/version');
        const data = answer?.ok ? await answer.json() : null;
        return data?.pkgVersion ? `SillyTavern ${data.pkgVersion}` : '';
    };
    // Story Suite's look (view/theme.js): light or dark from SillyTavern's theme, the reader's panel style
    // and font, on every Story Suite root; SillyTavern's own elements are never touched.
    const theme = createThemeBridge({ doc, settings: () => settings() });
    const sanitizer = globalThis.SillyTavern?.libs?.DOMPurify?.sanitize?.bind(globalThis.SillyTavern.libs.DOMPurify) ?? null;
    const diagnostics = Object.freeze({
        // Settings → Diagnostics → Show the UI sample: every building block, light and dark (screens/ui-sample.js).
        sample: () => {
            overlay?.close?.();
            return openUiSample({ doc, widgets, sanitize: sanitizer });
        },
        report: () => buildReport({
            stVersion,
            hostVersion: version || registry.hostVersion?.() || '',
            modules: () => registry.modules().map(def => ({ id: def.id, name: def.name ?? def.id, version: def.version ?? '' })),
            refusals: () => registry.refusals?.() ?? [],
            features: () => runtime.features?.list?.() ?? [],
            hostSettings: () => settings(),
            settingsOf: id => settings(id),
            promptParts,
            problems: () => runtime.turn?.problems?.() ?? [],
            save: () => ({ failing: store.failing?.(), dirty: store.dirty?.(), suspect: typeof store.suspect === 'function' ? store.suspect() : undefined }),
            calls: () => runtime.callQueue?.stats?.() ?? null,
            caught: caughtSoFar,
            chat: () => liveCtx()?.chat ?? [],
            chatOpen: () => Boolean(liveCtx()?.getCurrentChatId?.() ?? liveCtx()?.chatId),
            hooks: () => registry.hookEntries?.('diagnostics') ?? [],
        }),
        fileName: () => reportFileName(),
        // A story Story Block keeps as it is (read-only) can be repaired, only when the reader says so (turn.repair).
        repairActions: () => runtime.turn?.repairActions?.() ?? [],
        repair: id => runtime.turn?.repair?.(id, { confirmed: true }),
    });
    function openSettings(options = null) {
        const fold = typeof options?.fold === 'string' ? options.fold : null;
        overlay = openSettingsWindow({
            registry, settings, doc, sdk, features: runtime.features ?? null, fold, diagnostics,
            promptParts, tabs: tabsControl, theme,
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
    // SillyTavern's keyboard handler clicks a focused menu_button on Enter, and the browser's own Enter activation clicks it again:
    // one press, two clicks (the Story toggle opened and closed). The browser's activation is cancelled for the bar's buttons;
    // the handler's click is the one that counts (Space is one click already: it activates on the key's release).
    for (const node of [storyButton, gameButton, settingsButton]) node.addEventListener('keypress', event => { if (event.key === 'Enter') event.preventDefault(); });
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
        extras.refreshAll();
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
    const offs = [...replyOffs];
    // Story Suite's console errors, kept for Diagnostics (once per page; the console still prints them).
    offs.push(captureConsole());
    let dataPresentation = '';
    for (const name of ['head', 'committed']) offs.push(events.on(name, () => {
        let next = '';
        try { const pinned = sdk.query('dataModules.presentation', { kind: 'screens' }) ?? []; if (pinned.length) next = JSON.stringify(pinned); } catch { /* older host */ }
        if (next !== dataPresentation) { dataPresentation = next; syncScreens(); }
        mounts.tab.register(); if (!panel.hidden) tabHost?.refresh();
    }));
    // A feature turned on or off: its screens, tabs, widgets and cards come and go; nothing else changes.
    for (const name of ['head', 'committed', 'turn']) offs.push(events.on(name, () => overlay?.refreshSize?.()));
    // A chat change closes the dialogs (their drafts were for the chat they were opened in), the game view's More sheet and the
    // Story panel's More sheet.
    const chatTypes = ctx.eventTypes ?? ctx.event_types ?? {};
    const onChatChanged = () => {
        mounts.dialog?.closeAll();
        mounts.screen?.closeMore?.();
        tabHost?.bar?.closeMore?.({ focus: false });
    };
    if (typeof ctx.eventSource?.on === 'function' && chatTypes.CHAT_CHANGED) {
        ctx.eventSource.on(chatTypes.CHAT_CHANGED, onChatChanged);
        offs.push(() => (ctx.eventSource.removeListener ?? ctx.eventSource.off)?.call(ctx.eventSource, chatTypes.CHAT_CHANGED, onChatChanged));
    }
    // A pack turned on or off, installed or removed: the screens it gives come and go with it (the installed store says so).
    offs.push(runtime.packs?.packs?.subscribe?.(() => {
        syncScreens();
        mounts.dialog?.closeWhere?.(screenId => !screens.resolve(screenId));
        refresh();
        mounts.card?.refreshAll?.({ force: true });
    }) ?? (() => {}));
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
        tabs: tabsControl,
        mounts,
        renderer,
        notes,
        extras,
        savePoints,
        inspector,
        theme,
        destroy() {
            overlay?.close?.();
            mounts.dialog?.closeAll?.();
            tabHost?.destroy?.();
            tabHost?.bar?.destroy();
            mounts.screen?.destroy?.();
            theme.destroy();
            doc.removeEventListener?.('keydown', onKey);
            offs.splice(0).forEach(off => off?.());
            notes.destroy();
            extras.destroy();
        },
    };
}
