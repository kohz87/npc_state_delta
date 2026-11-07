// The roll hook (SPEC_RPG §2R A3). Rolls are made by the fight board only: there is no planner and no model call before a reply.
// beforeGenerate carries a board fight the reader staged ("Send with this fight") as `rpg.resolve` board commands and, with no fight to carry, tells
// the narrator how to open one (noFight); canGenerate holds a send until the waiting fight is played or chosen. Old chats keep their planner
// rolls as records (resolve.js replays them); nothing here asks a model for a plan.
import { hashText, normalizeType } from '../assist/common.js';
import { LEAN_RPG_FEATURE, PRACTICE, PRACTICE_SETTING, RESOLVE, ROLLS_SETTING, practiceOf } from './names.js';
import { OPEN_FIGHT_LINE } from './cue.js';
import { claimKey } from './resolve.js';
import { readSheet } from './read.js';
import { knownFoeAction } from './board/action-gate.js';
import { readRecord } from '../persist.js';
import { boardKey, boardPayload, boardSession, clearSend, lastBoard, linkBoard, priorBoard, readSend, receiveBoard, reconcileBoard } from './board/session.js';
import { boardInputError } from './board/commit.js';
import { CORE_FEATURE } from '../features.js';
import { clearStart, holdStart, pendingStart } from '../turn/fight-start.js';

// Whether the fight board is on (one literal id, read once per call).
const boardOn = view => view?.feature?.(CORE_FEATURE.fightBoard) === true;
// The fight copied at "Send with this fight" (a clone, or null): canGenerate and beforeGenerate read it the same way.
const sentBoard = (meta, messages) => structuredClone(readSend(meta, messages)?.board ?? null);

const readSettings = (view, moduleId) => {
    try {
        const values = typeof view?.settings === 'function' ? view.settings(moduleId) : null;
        return values && typeof values === 'object' ? values : {};
    } catch { return {}; }
};

/** Whether `state` already holds this message's rolls (its claim). */
export const claimed = (state, key) => state?.meta?.claims?.[claimKey(key)] === true;

/**
 * The hook. `deps`: { chat() → SillyTavern's chat array, metadata() → the chat's metadata, moduleId,
 * skip { peek() → whether the next reply is to go out with no dice, clear() } (start.js: "Send without the RPG for now") }.
 * Returns { canGenerate(view, info), beforeGenerate(view, info) → { commands } | { lines } | null, afterCapture(), afterReceive(info, state, query) }.
 */
export function createPrecall({ chat, metadata = () => null, moduleId = 'story-block', skip: noDice = { peek: () => false, clear: () => {} } }) {
    // No foe is filled in and nothing was rolled: if a fight starts in this reply, the narrator sets the Foes line and stops at the first clash.
    // (a block of Down groups only is a won fight: no fight is on)
    const noFight = (sheet, board = false) => (sheet.foes.length && !sheet.foes.some(foe => foe.filled && foe.hurt > 0)
        ? { lines: [board ? { text: 'No foes are set. If a fight begins, set the Foes line and tell the approach only. The fight has not started: end at the moment of engagement.', keep: true } : OPEN_FIGHT_LINE] } : null);

    function canGenerate(view, info = {}) {
        if (view?.feature?.(LEAN_RPG_FEATURE) !== true) return null;
        let meta;
        try { meta = metadata(); } catch { return null; }
        const messages = chat() ?? [], last = messages.at(-1), session = boardSession(meta), pending = pendingStart(meta, messages);
        const on = boardOn(view), live = Boolean(session?.exchanges?.length);
        // (With the board off and no staged exchanges the feature is out of the way: a regenerate is allowed exactly as before it existed.)
        let board = null;
        if (last?.is_user) {
            const anchor = readRecord(messages.at(-2))?.sid;
            // The waiting reply is released only by "Send with this fight" (markSend copies the staged fight, exchanges and all): until then every
            // generation attempt stays held, whatever the board holds. A copy older than the board (more exchanges staged since) does not release it.
            if (info.commit === true && on && pending?.choice === 'board' && session?.anchor === anchor) {
                const sent = readSend(meta, messages)?.board;
                if (!live || !sent || (sent.exchanges?.length ?? 0) !== session.exchanges.length)
                    return { ok: false, reason: 'Play the waiting fight on the board.', action: false, fightStart: true };
            }
            if (on || live) {
                board = session?.anchor === anchor ? boardPayload(session) : lastBoard(meta, anchor, last)?.board;
                // (the copy made at "Send with this fight" stands in when the session itself is gone)
                if (!board) board = sentBoard(meta, messages);
            }
            if (!board && live) return { ok: false, reason: 'The fight no longer matches this reply. Restore the reply or discard the fight.', action: false };
            if (session?.anchor === anchor && live && !session.setup?.witness) return { ok: false, reason: 'This older fight cannot be checked. Discard it and start the fight again.', action: false };
        } else if ((on || live) && last && !last.is_user && !String(last.mes ?? '')) board = priorBoard(last)?.board;
        if (!board) {
            if (info.commit !== true || !['normal', 'regenerate'].includes(normalizeType(info.type)) || !last?.is_user || !on) return null;
            if (!pending && normalizeType(info.type) !== 'normal') return null;
            const sheet = readSheet(view.state);
            if (pending || (sheet.characters.length && sheet.foes.some(foe => foe.filled && foe.hurt > 0) && knownFoeAction(last.mes, sheet))) {
                if (!pending && !holdStart(meta, messages, { mode: 'known' })) return null;
                return { ok: false, reason: 'Choose how to play the waiting fight.', action: false, fightStart: true };
            }
            return null;
        }
        if (!on) return { ok: false, reason: 'Turn on the fight board or discard the fight before sending.', action: false };
        const error = board.setup?.opening ? null : boardInputError(view.state, board);
        return error ? { ok: false, reason: error, action: false } : null;
    }

    async function beforeGenerate(view, info = {}) {
        if (view?.feature?.(LEAN_RPG_FEATURE) !== true) return null;
        if (info?.commit === false) return null;
        if (!['normal', 'regenerate', 'swipe'].includes(normalizeType(info?.type))) return null;
        const sheet = readSheet(view.state);
        // The reader's message: the last one for a send or a regenerate, the one before the reply for a swipe.
        const messages = chat() ?? [];
        if (!messages.some(message => message && !message.is_user)) return null;
        const index = normalizeType(info?.type) === 'swipe' ? messages.length - 2 : messages.length - 1;
        const last = messages[index];
        if (!last?.is_user) return null;
        const text = String(last.mes ?? '').trim();
        if (!text) return null;
        const key = `${index}-${hashText(text)}`;
        const startAnchor = readRecord(messages[index - 1])?.sid;
        const on = boardOn(view);
        let meta = null;
        try { meta = metadata(); } catch { /* no board without chat metadata */ }
        if (on) {
            const anchorRecord = readRecord(messages[index - 1]);
            const type = normalizeType(info?.type), previous = type === 'swipe' ? priorBoard(messages[index + 1]) : null;
            const remembered = type === 'regenerate' ? lastBoard(meta, startAnchor, last) : null;
            let session = boardSession(meta);
            if (session?.anchor === startAnchor) session = reconcileBoard(meta, id => (anchorRecord?.receipts ?? []).some(item => item?.id === id));
            // (a live fight: this reply's own anchor holds the session)
            const live = session?.anchor === startAnchor;
            // A fight the reader staged on this very anchor is what this send carries: "Send with this fight" is a 'regenerate', and the
            // cached payload of an earlier send (rpgFightLast, same anchor) must never stand in for it (it kept only the first exchange).
            const staged = live && session.exchanges?.length ? boardPayload(session) : null;
            const copied = type !== 'swipe' ? sentBoard(meta, messages) : null;
            const fresh = previous ? null : staged ?? copied;
            const board = previous?.board ?? fresh ?? remembered?.board ?? (live ? boardPayload(session) : null);
            if (board) {
                const anchored = board.anchor ? board : { ...board, anchor: startAnchor ?? board.id };
                const fightKey = previous?.key?.startsWith('b:') ? previous.key : !fresh && remembered?.key?.startsWith('b:') ? remembered.key : boardKey(anchored);
                linkBoard(last, fightKey);
                const opening = anchored.setup?.opening;
                return { commands: [
                    ...(opening ? [{ type: RESOLVE, payload: opening.payload, seed: opening.seed }] : []),
                    { type: RESOLVE, payload: { key: fightKey, board: anchored, practice: previous?.practice ?? (fresh ? null : remembered?.practice) ?? practiceOf(opening?.payload?.practice) ?? practiceOf(readSettings(view, moduleId)[PRACTICE_SETTING]) ?? PRACTICE.perUse } },
                ] };
            }
        }
        if (claimed(view.state, key)) return null;
        if (normalizeType(info?.type) === 'normal' && noDice.peek()) return null;
        if (!sheet.characters.length) return null;
        if (readSettings(view, moduleId)[ROLLS_SETTING] === 'off') return null;
        // No model is asked for a plan: with no fight to carry the reply goes out as one the planner once answered "none" to.
        return noFight(sheet, on);
    }

    // The reply is captured: the one-time "send without the RPG" flag goes.
    function afterCapture() {
        noDice.clear();
    }

    function afterReceive(info = {}, state = null, query = null) {
        let current = null;
        try { current = metadata(); } catch { /* no saved start */ }
        clearStart(current);
        clearSend(current);
        const record = readRecord((chat() ?? [])[info.index]);
        const receipt = record?.receipts?.findLast(item => item?.type === RESOLVE && item.replan?.payload?.board);
        if (!receipt) return;
        let meta = null;
        try { meta = metadata(); } catch { return; }
        receiveBoard(meta, receipt.replan.payload, receipt.data?.v2?.result, record.sid, receipt.id, state, query);
    }

    return { canGenerate, beforeGenerate, afterCapture, afterReceive };
}
