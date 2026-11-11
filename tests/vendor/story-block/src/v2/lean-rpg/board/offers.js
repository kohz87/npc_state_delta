// Finds the reply that introduced the current foes and remembers the reader's choice per reply.
// The reply's state is authoritative, so swipes, deletes and branches cannot move an offer to another fight.

import { readRecord } from '../../persist.js';
import { fold, readSheet } from '../read.js';
import { boardSession } from './session.js';
import { offerLineData } from './start-view-data.js';

const standing = state => state ? readSheet(state).foes.filter(foe => foe.filled && foe.hurt > 0) : [];
const identity = foe => `${foe.slot}:${fold(foe.name)}`;
const byIdentity = foes => new Map(foes.map(foe => [identity(foe), foe]));
// A group is new when its slot:name was not standing before, when its count rose, or when the reply itself set the slot
// (a slot cleared and set again, even with the same name and numbers). Health moving either way (a foe healing) or a
// smaller count is just the fight, never an arrival.
const arrived = (foe, was, set) => set.has(foe.slot) || !was || foe.count > was.count;

// What a reply's stored receipts say: the foe slots it set with a set-slot line, and how the board fight it carried ended.
function receiptsOf(store, index) {
    const slots = new Set();
    let ended = null, entries = [];
    try { entries = store.receipts?.() ?? []; } catch { /* no receipts to read */ }
    for (const entry of entries) {
        if (entry?.index !== index) continue;
        const kind = entry.receipt?.type === 'capture.dm' ? /^set-slot-([1-6])$/u.exec(String(entry.receipt.data?.v2?.result?.kind ?? '')) : null;
        if (kind) slots.add(Number(kind[1]));
        const result = entry.receipt?.type === 'rpg.resolve' ? entry.receipt.data?.v2?.result : null;
        if (result?.board && ['won', 'fled'].includes(result.stop)) ended = result.stop;
    }
    return { slots, ended };
}

// `enabled` is a flag or a function that answers it: the function is asked last, only once a foe stands and no board is staged, because
// the answer reads the pack's rules through sdk queries, each of which settles the timeline (the Fight tab asks this on every redraw).
function findFightOffer(chat, store, meta, enabled = true) {
    // A board with exchanges staged hides the offer (never clobbered), and so does one the reader opened on the offered reply itself. A segment carried
    // on from an earlier fight follows every later reply (receiveBoard), so it is not the fight a new group starts: a group that arrived on the reply the segment now sits on still gets its offer, an older arrival (the fight in hand) does not.
    const session = boardSession(meta);
    if (!enabled || session?.exchanges?.length) return null;
    let current;
    try { current = standing(store.head()); } catch { return null; }
    if (!current.length) return null;
    if (typeof enabled === 'function') {
        if (!enabled()) return null;
        // (the answer may have settled the timeline: the foes that stand are the head's after it)
        try { current = standing(store.head()); } catch { return null; }
        if (!current.length) return null;
    }
    let next = byIdentity(current);
    const messages = Array.isArray(chat) ? chat : [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index], record = readRecord(message);
        if (!record || message?.is_user || message?.is_system) continue;
        let before = null;
        for (let i = index - 1; i >= 0; i -= 1) {
            if (!messages[i]?.is_user && readRecord(messages[i])) { try { before = store.at(i); } catch { /* no preceding state */ } break; }
        }
        const prior = byIdentity(standing(before));
        const { slots, ended } = receiptsOf(store, index);
        const introduced = [...next].some(([key, foe]) => arrived(foe, prior.get(key), slots));
        // A reply that told a board fight which ended with foes still up offers the board again ("Foes are still standing");
        // new foes the same reply introduced keep the usual "A fight started".
        const left = ended !== null && next.size > 0;
        if (introduced || left) {
            if (meta?.rpgFightOffers?.[record.sid] === true || (session && !(session.carried && session.anchor === record.sid))) return null;
            return { index, sid: record.sid, fight: { groups: current.map(foe => foe.slot), ...(introduced ? {} : { standing: true }) } };
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
    const find = () => findFightOffer(ctx?.chat, store, meta(), on);
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
