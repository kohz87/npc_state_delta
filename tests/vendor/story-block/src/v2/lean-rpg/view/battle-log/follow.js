// Keeps the battle log following the chat: reads each reply's record and state, draws, reuses or removes its panel,
// places a card under the reply when no marker is present, watches redraws and SillyTavern events, and stores the fold.

import { readRecord } from '../../../persist.js';
import { fold } from '../../read.js';
import { characterReading, soulShortOf } from '../../soul.js';
import { noRollOf } from '../../noroll.js';
import { readParty } from '../party-data.js';
import { BATTLE_ROOT, FOLD_KEY, RECENT_MESSAGES } from './constants.js';
import { resolveOf } from './read.js';
import { panelModel } from './model.js';
import { buildPanel, buildNote } from './draw.js';
import { CONSUMED, isHiddenMarker, markerNodes, hideMarkers, releasePanel, placeAtMarker, nodesOf } from './marker.js';

const storage = doc => {
    try { return doc?.defaultView?.localStorage ?? globalThis.localStorage ?? null; } catch { return null; }
};

/** The viewer's fold per chat and reply (localStorage; this page only when it is not there). */
export function createFoldStore(doc) {
    const memory = new Set();
    const read = () => {
        try { return JSON.parse(storage(doc)?.getItem(FOLD_KEY) ?? '{}') ?? {}; } catch { return {}; }
    };
    return {
        has: key => (key in read() ? read()[key] === true : memory.has(key)),
        set(key, on) {
            if (on) memory.add(key); else memory.delete(key);
            const all = read();
            if (on) all[key] = true; else delete all[key];
            try { storage(doc)?.setItem(FOLD_KEY, JSON.stringify(all)); } catch { /* the choice lasts this page only */ }
        },
    };
}

/**
 * createBattleLog({ ctx, doc, store, events, featureOn, roleOf, messageElement? })
 * → { refresh(index, element?), refreshAll({ recent }), modelAt(index), latest(), destroy() }.
 * Draws, redraws or removes the panel of every drawn reply that has recorded rolls; `featureOn()` false removes them all.
 */
export function createBattleLog({ ctx, doc = globalThis.document, store, events = null, featureOn = () => true, roleOf, levels = () => ({}), messageElement = null, offer = null, Observer = doc?.defaultView?.MutationObserver ?? globalThis.MutationObserver } = {}) {
    const chat = () => (Array.isArray(ctx?.chat) ? ctx.chat : []);
    const elementOf = messageElement ?? (index => doc.querySelector(`.mes[mesid="${index}"]`));
    const folds = createFoldStore(doc);
    let refreshingAll = false;
    const chatKey = () => String(ctx?.getCurrentChatId?.() ?? ctx?.chatId ?? '');
    const problems = () => { try { return store?.problems?.() ?? []; } catch { return []; } };
    const stateAt = index => { try { return store.at(index); } catch { return null; } };
    const beforeOf = index => {
        for (let at = index - 1; at >= 0; at -= 1) if (chat()[at] && !chat()[at].is_user && readRecord(chat()[at])) return stateAt(at);
        return null;
    };

    /** What reply `index` shows: { key, model } or null (no recorded rolls, a message of the reader's, the feature off). */
    function modelAt(index) {
        const message = chat()[index];
        if (!featureOn() || !message || message.is_user || message.is_system) return null;
        const record = readRecord(message);
        if (!record) return null;
        // What each party member calls the Soul Class (a roll made before Levels) comes from the reply's own state, read once and only when a line is drawn.
        let souls = null;
        const soulOf = who => {
            souls ??= new Map((stateAt(index) ? readParty(stateAt(index), { roleOf }) : []).map(character => [fold(character.name), characterReading(character.definition)]));
            return souls.get(fold(who)) ?? null;
        };
        const resolve = resolveOf(record, problems().filter(problem => problem?.index === index), { soulOf });
        const state = resolve ? stateAt(index) : null;
        if (!state) return null;
        return { key: `${chatKey()}|${record.sid ?? index}`, model: panelModel({ resolve, state, before: beforeOf(index), roleOf, ranks: levels().ranks ?? [] }) };
    }

    /** The no-rolls note reply `index` shows: { key, model: note } or null (it has rolls, no note, a message of the reader's, the feature off). */
    function noteAt(index) {
        const message = chat()[index];
        if (!featureOn() || !message || message.is_user || message.is_system) return null;
        const record = readRecord(message);
        const note = record ? noRollOf(record.receipts) : null;
        return note ? { key: `${chatKey()}|${record.sid ?? index}|noroll`, model: note } : null;
    }

    /** The latest reply with recorded rolls, searching the whole chat from the newest back: { index, key, model } or null. */
    function latest() {
        for (let index = chat().length - 1; index >= 0; index -= 1) {
            const shown = modelAt(index);
            if (shown) return { index, ...shown };
        }
        return null;
    }

    const panelsIn = message => Array.from(message.querySelectorAll(`.${BATTLE_ROOT}`));
    function placeCard(message, node) {
        const text = message.querySelector('.mes_text');
        const parent = text?.parentNode ?? message.querySelector('.mes_block') ?? message;
        const cards = nodesOf(parent).find(child => child.nodeType === 1 && String(child.className ?? '').split(/\s+/).includes('ss-cards'));
        if (node.parentNode === parent && (cards ? node.nextElementSibling === cards : true)) return;
        parent.insertBefore(node, cards ?? null);
    }

    function refresh(index, element = null) {
        if (!refreshingAll) offer?.update();
        const message = element ?? elementOf(index);
        if (!message) return null;
        const old = panelsIn(message);
        const log = modelAt(index);
        const shown = log ?? noteAt(index);
        if (!shown) {
            for (const node of old) releasePanel(doc, node);
            const text = message.querySelector('.mes_text');
            if (text) hideMarkers(doc, text);
            return null;
        }
        const text = message.querySelector('.mes_text');
        const marked = text ? markerNodes(text).length > 0 : false;
        const inline = old.find(node => node.getAttribute('data-variant') === 'inline');
        const variant = marked || inline ? 'inline' : 'card';
        const sign = JSON.stringify([shown.key, variant, shown.model, folds.has(shown.key)]);
        const kept = old.find(node => node.getAttribute('data-variant') === variant);
        if (!marked && kept && kept.getAttribute('data-ss-sign') === sign) {
            for (const node of old) if (node !== kept) node.remove();
            if (variant === 'card') placeCard(message, kept);
            return kept;
        }
        const node = log ? buildPanel(doc, shown.model, { folded: folds.has(shown.key), variant, index, onFold: on => folds.set(shown.key, on) }) : buildNote(doc, shown.model, { variant, index });
        node.setAttribute('data-ss-sign', sign);
        if (marked) {
            for (const item of old) item.remove();
            placeAtMarker(doc, text, node);
        } else if (variant === 'inline' && kept) {
            kept.parentNode.insertBefore(node, kept);
            if (kept[CONSUMED]) node[CONSUMED] = kept[CONSUMED];
            for (const item of old) item.remove();
        } else {
            for (const item of old) item.remove();
            placeCard(message, node);
        }
        return node;
    }

    function refreshAll({ recent = false } = {}) {
        const drawn = Array.from(doc.querySelectorAll('.mes[mesid]'));
        refreshingAll = true;
        try {
            for (const message of recent ? drawn.slice(Math.max(0, drawn.length - RECENT_MESSAGES)) : drawn) {
                const index = Number(message.getAttribute('mesid'));
                if (Number.isInteger(index)) refresh(index, messageElement ? null : message);
            }
        } finally { refreshingAll = false; }
        offer?.update();
    }

    const offs = [];
    // Another extension may draw a reply's text again after the panel was drawn (SillyTavern's updateMessageBlock, which no
    // event follows: NPC State Delta does it on CHARACTER_MESSAGE_RENDERED after taking its own block out), so the panel is
    // gone and the raw marker is back until something redraws the reply. A watch on the chat's message texts draws that
    // reply again whenever a marker shows in it (a consumed or hidden one does not count, so drawing never feeds itself).
    const shownMarkers = text => markerNodes(text).filter(node => !isHiddenMarker(node.parentNode));
    if (typeof Observer === 'function' && doc) {
        const waiting = new Map();
        let queued = false;
        const flush = () => {
            queued = false;
            const list = [...waiting.values()];
            waiting.clear();
            for (const message of list) {
                const index = Number(message.getAttribute?.('mesid'));
                const text = message.querySelector?.('.mes_text');
                if (Number.isInteger(index) && text && shownMarkers(text).length) refresh(index, messageElement ? null : message);
            }
        };
        try {
            const watch = new Observer(records => {
                for (const record of records) {
                    const target = record.target?.nodeType === 1 ? record.target : record.target?.parentNode;
                    const message = target?.closest?.('.mes[mesid]');
                    if (message && target.closest?.('.mes_text')) waiting.set(message, message);
                }
                if (waiting.size && !queued) { queued = true; Promise.resolve().then(flush); }
            });
            const root = doc.querySelector?.('#chat') ?? doc.body ?? null;
            if (root) {
                watch.observe(root, { childList: true, subtree: true });
                offs.push(() => watch.disconnect());
            }
        } catch { /* no watch: the events below still draw the panel */ }
    }
    const source = ctx?.eventSource;
    const types = ctx?.eventTypes ?? ctx?.event_types ?? {};
    if (typeof source?.on === 'function') {
        const all = () => refreshAll({ recent: true });
        const forget = () => refreshAll();
        const wire = [
            [types.CHARACTER_MESSAGE_RENDERED, all], [types.USER_MESSAGE_RENDERED, all], [types.MESSAGE_SWIPED, all],
            [types.MESSAGE_EDITED, all], [types.MESSAGE_UPDATED, all], [types.MESSAGE_SENT, all],
            [types.MESSAGE_DELETED, forget], [types.CHAT_CHANGED, forget], [types.MORE_MESSAGES_LOADED, forget],
        ].filter(([type]) => type);
        for (const [type, fn] of wire) source.on(type, fn);
        offs.push(() => { for (const [type, fn] of wire) (source.removeListener ?? source.off)?.call(source, type, fn); });
    }
    if (typeof events?.on === 'function') {
        for (const name of ['turn', 'head', 'feature']) {
            const off = events.on(name, () => refreshAll({ recent: name !== 'feature' }));
            if (typeof off === 'function') offs.push(off);
        }
    }

    return {
        refresh, refreshAll, modelAt, noteAt, latest,
        destroy() {
            offs.splice(0).forEach(off => off());
            for (const node of doc.querySelectorAll(`.${BATTLE_ROOT}`)) {
                const text = node.parentNode;
                releasePanel(doc, node);
                if (text) hideMarkers(doc, text);
            }
        },
    };
}
