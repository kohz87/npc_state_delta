// Reply-card scopes, scans and actions for the page host. The scan and its listeners live for one mount.

import { CHANGES_CARD_SCREEN_ID, replyCardLines } from '../screens/index.js';
import { mergeRpgLines } from '../screens/changes-card.js';
import { readRecord } from '../persist.js';
import { laterStore, replyEdits, replyRules, scanReplyCards } from '../reply-cards.js';
import { drawReplyCard } from '../view/reply-cards-ui.js';

export function createReplyCards({ runtime, ctx, doc, store, registry, events, queryAt, renderer, notes, screens, api, getRpg, getMounts }) {
    // A card's scope also gets `refused`: that reply's change lines the code did not apply; the "Changed this
    // reply" card also `moduleLines`: the modules' own lines for that reply (hooks.replyCard, MODULES §F125).
    const recordAt = index => readRecord(ctx.chat?.[index]);
    const editsAt = index => replyEdits(recordAt(index), store.problems?.() ?? [], index);
    const cardLines = (index, state, changes, before = null) => {
        const lines = [
            ...replyCardLines(registry.hookEntries?.('replyCard') ?? [], { index, state, changes }),
            ...replyRules(recordAt(index), store.problems?.() ?? [], index, { state, before }),
        ];
        // The RPG's own lines (rolls, class and rank rises), only while its screens are mounted.
        return getRpg() ? mergeRpgLines(lines, getRpg().cardLines({ state, before, record: recordAt(index), problems: (store.problems?.() ?? []).filter(item => item?.index === index) })) : lines;
    };
    const drawScreen = renderer.render;
    // …and `assisted`: the lines the Assist safety net applied on it (its receipts marked `assist`).
    const assistedAt = index => {
        try {
            return (readRecord(ctx.chat?.[index])?.receipts ?? []).filter(receipt => receipt?.assist === 'now' || receipt?.assist === 'late')
                .map(receipt => ({ line: String(receipt.assistLine ?? receipt.summary ?? ''), late: receipt.assist === 'late' }));
        } catch { return []; }
    };
    renderer.render = (el, screen, scope) => drawScreen(el, screen, scope?.mount === 'card'
        ? { ...scope, refused: notes.refusedAt(scope.index), assisted: assistedAt(scope.index), ...(screen?.id === CHANGES_CARD_SCREEN_ID ? { moduleLines: cardLines(scope.index, scope.state, scope.changes, scope.before), edits: editsAt(scope.index), editableHead: scope.index === store.headIndex() } : {}) }
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
                onFold: on => { setFold(chat, item.key, on); getMounts()?.card?.refresh?.(index, { force: false }); },
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
        // The card that asks to add a companion opens the New character window filled in (lean-rpg/join.js): the wizard keeps its own draft.
        if (id === 'story-block/new-character' && getRpg()?.wizard?.open(payload && typeof payload === 'object' ? payload : null)) return;
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
    return { cardLines, assistedAt, branchNow, replyCardsAt, replyOffs };
}
