// Finds the reply that introduced the current foes and remembers the reader's choice per reply.
// The reply's state is authoritative, so swipes, deletes and branches cannot move an offer to another fight.

import { readRecord } from '../../persist.js';
import { fold, readSheet } from '../read.js';
import { boardSession } from './session.js';
import { offerLineData } from './start-view-data.js';

const standing = state => state ? readSheet(state).foes.filter(foe => foe.filled && foe.hurt > 0) : [];
const identity = foe => `${foe.slot}:${fold(foe.name)}`;

function findFightOffer(chat, store, meta, enabled = true) {
    if (!enabled || boardSession(meta)) return null;
    let current;
    try { current = standing(store.head()); } catch { return null; }
    if (!current.length) return null;
    const wanted = new Set(current.map(identity));
    let next = wanted;
    const messages = Array.isArray(chat) ? chat : [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index], record = readRecord(message);
        if (!record || message?.is_user || message?.is_system) continue;
        let before = null;
        for (let i = index - 1; i >= 0; i -= 1) {
            if (!messages[i]?.is_user && readRecord(messages[i])) { try { before = store.at(i); } catch { /* no preceding state */ } break; }
        }
        const prior = new Set(standing(before).map(identity));
        const introduced = ![...next].some(key => prior.has(key));
        if (introduced) {
            if (meta?.rpgFightOffers?.[record.sid] === true) return null;
            return { index, sid: record.sid, fight: { groups: current.map(foe => foe.slot) } };
        }
        next = prior;
    }
    return null;
}

function hideFightOffer(meta, sid) {
    if (!meta || typeof meta !== 'object' || typeof sid !== 'string' || !sid) return false;
    if (!meta.rpgFightOffers || typeof meta.rpgFightOffers !== 'object') meta.rpgFightOffers = {};
    meta.rpgFightOffers[sid] = true;
    return true;
}

export function createFightOffers({ ctx, doc, store, meta, on, view, open, save, refresh } = {}) {
    const find = () => findFightOffer(ctx?.chat, store, meta(), on());
    const update = () => {
        const offer = find();
        const message = offer && doc.querySelector?.(`.mes[mesid="${offer.index}"]`);
        if (!message) { view.clear(); return offer; }
        const data = offerLineData(offer.fight, { state: store.head() });
        view.render(message.querySelector('.mes_block') ?? message, { ...data, sid: offer.sid });
        return offer;
    };
    // `how` is 'board' (Fight on the board) or 'auto' (open it, then Auto plays the cap's exchanges).
    const choose = (data, how) => {
        const offer = find();
        if (!offer || offer.sid !== data?.sid) return;
        if (open?.({ auto: how === 'auto' }) === false) return;
        hideFightOffer(meta(), offer.sid);
        try { save?.(); } catch { /* saved with the next chat write */ }
        update();
        refresh?.();
    };
    return { find, update, choose };
}
