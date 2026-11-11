// The roll hook (SPEC_RPG §2R A3). Rolls are made by the fight board; the optional pre-check reads new foes without planning dice.
// beforeGenerate carries a board fight the reader staged ("Send with this fight") as `rpg.resolve` board commands and, with no fight to carry, tells
// the narrator how to open one (noFight); canGenerate holds a send until the waiting fight is played or chosen. Old chats keep their planner
// rolls as records (resolve.js replays them); nothing here asks a model for a plan.
import { hashText, normalizeType } from '../assist/common.js';
import { DICE, LEAN_RPG_FEATURE, PRACTICE, PRACTICE_SETTING, RESOLVE, ROLLS_SETTING, checksOn, practiceOf } from './names.js';
import { OPEN_FIGHT_LINE } from './cue.js';
import { claimKey } from './resolve.js';
import { readSheet } from './read.js';
import { dicePayload } from './checks/dice.js';
import { membersOf } from './practice.js';
import { knownFoeAction } from './board/action-gate.js';
import { readRecord } from '../persist.js';
import { boardKey, boardPayload, boardSession, clearSend, lastBoard, linkBoard, priorBoard, readSend, receiveBoard, reconcileBoard } from './board/session.js';
import { boardInputError } from './board/commit.js';
import { CORE_FEATURE } from '../features.js';
import { clearStart, holdStart, pendingStart } from '../turn/fight-start.js';
import { isStandard, packRulesOf, rulesFromSettings } from './rules.js';
import { openingPayload, runPrecheck, wantsPrecheck } from './board/precheck-run.js';

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

/** The text of the reply just before the reader's last message (the narration that introduced the foes), or ''. */
const previousReply = messages => { const before = messages.at(-2); return before && !before.is_user && !before.is_system ? String(before.mes ?? '') : ''; };

/**
 * The hook. `deps`: { chat() → SillyTavern's chat array, metadata() → the chat's metadata, moduleId,
 * skip { peek() → whether the next reply is to go out with no dice, clear() } (start.js: "Send without the RPG for now"),
 * callModel(prompt, { maxTokens, profile, helper, timeoutMs }) → text (the foe pre-check's one Assist call; none: no pre-check), onPlanning(working) (the screens redraw), timeoutMs, timer }.
 * Returns { canGenerate(view, info), beforeGenerate(view, info) → { commands } | { lines } | null, afterCapture(), afterReceive(info, state, query) }.
 */
export function createPrecall({ chat, metadata = () => null, moduleId = 'story-block', skip: noDice = { peek: () => false, clear: () => {} }, callModel = null, onPlanning = () => {}, timeoutMs, timer }) {
    // A retried interceptor must not repeat a check, but an edited or different message still needs its own check.
    const checked = new WeakMap();
    // No foe is filled in and nothing was rolled: if a fight starts in this reply, the narrator sets the Foes line and stops at the first clash.
    // (a block of Down groups only is a won fight: no fight is on)
    const noFight = (sheet, board = false) => (sheet.foes.length && !sheet.foes.some(foe => foe.filled && foe.hurt > 0)
        ? { lines: [board ? { text: 'No foes are set. If a fight begins, set the Foes line and tell the approach only. The fight has not started: end at the moment of engagement.', keep: true } : OPEN_FIGHT_LINE] } : null);

    // A running pre-check also holds another send; stale working states are ignored by pendingStart after a reload.
    const waiting = held => (held && held.choice !== 'plain' ? held : null);

    // The foe pre-check (board/precheck-run.js): a typed attack with no foe standing is read once for its groups; the opening is recorded as the old
    // planner's was and the send is held (turn/prompt-build.js records it). → { fightStart } or null (the send goes on as it does without the pre-check).
    async function precheck(view, sheet, messages, key, text, startAnchor) {
        let meta;
        try { meta = metadata(); } catch { return null; }
        const values = readSettings(view, moduleId), held = pendingStart(meta, messages);
        let pack = null;
        try { pack = packRulesOf(view.query?.('packs.content', { kind: 'rpg' })); } catch { /* no pack rules */ }
        const rules = rulesFromSettings(values, pack);
        if (!startAnchor || !callModel || held?.choice === 'plain' || !isStandard(rules) || noDice.peek() || !wantsPrecheck(values, sheet, text)) return null;
        checked.set(messages.at(-1), key);
        const working = holdStart(meta, messages, { mode: 'working' });
        try { onPlanning(true); } catch { /* the screen redraws on the next event */ }
        let groups = [];
        try { groups = await runPrecheck({ callModel, message: text, previous: previousReply(messages), sheet, values, limit: timeoutMs, timer, query: (name, args) => view.query?.(name, args) }); } finally {
            if (working) clearStart(meta, working);
            try { onPlanning(false); } catch { /* the screen redraws on the next event */ }
        }
        if (!groups.length) return null;
        return { opening: openingPayload({ groups, key, rules, anchor: startAnchor, values }), anchor: startAnchor, message: hashText(text) };
    }

    function canGenerate(view, info = {}) {
        if (view?.feature?.(LEAN_RPG_FEATURE) !== true) return null;
        let meta;
        try { meta = metadata(); } catch { return null; }
        const messages = chat() ?? [], last = messages.at(-1), session = boardSession(meta), pending = waiting(pendingStart(meta, messages));
        const on = boardOn(view), live = Boolean(session?.exchanges?.length);
        // (With the board off and no staged exchanges the feature is out of the way: a regenerate is allowed exactly as before it existed.)
        let board = null;
        if (last?.is_user) {
            const anchor = readRecord(messages.at(-2))?.sid;
            // The waiting reply is released only by "Send with this fight" (markSend copies the staged fight, exchanges and all): until then every
            // generation attempt stays held, whatever the board holds. A copy older than the board (more exchanges staged since) does not release it.
            if (info.commit === true && on && pending?.choice === 'board' && session && session.anchor === anchor) {
                const sent = readSend(meta, messages)?.board;
                if (!live || !sent || (sent.exchanges?.length ?? 0) !== session.exchanges.length)
                    return { ok: false, reason: 'Play the waiting fight on the board.', action: false, fightStart: true };
            }
            if (on || live) {
                board = session && session.anchor === anchor ? boardPayload(session) : lastBoard(meta, anchor, last)?.board;
                // (the copy made at "Send with this fight" stands in when the session itself is gone)
                if (!board) board = sentBoard(meta, messages);
            }
            if (!board && live) return { ok: false, reason: 'The fight no longer matches this reply. Restore the reply or discard the fight (Fight tab, Discard fight).', action: false };
            if (session && session.anchor === anchor && live && !session.setup?.witness) return { ok: false, reason: 'This older fight cannot be checked. Discard it (Fight tab, Discard fight) and start the fight again.', action: false };
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
        if (!on) return { ok: false, reason: 'Turn on the fight board or discard the fight (Fight tab, Discard fight) before sending.', action: false };
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
            if (session && session.anchor === startAnchor) session = reconcileBoard(meta, id => (anchorRecord?.receipts ?? []).some(item => item?.id === id));
            // (a live fight: this reply's own anchor holds the session)
            const live = Boolean(session) && session.anchor === startAnchor;
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
        if (on && normalizeType(info?.type) === 'normal' && info.commit !== false && !(info.again && checked.get(last) === key) && !waiting(pendingStart(meta, messages))) {
            const fightStart = await precheck(view, sheet, messages, key, text, startAnchor);
            if (fightStart) return { fightStart, ...(readSettings(view, moduleId)[ROLLS_SETTING] !== 'off' ? noFight(sheet, on) ?? {} : {}) };
        }
        if (normalizeType(info?.type) === 'normal' && noDice.peek()) return null;
        if (!sheet.characters.length) return null;
        // Story checks (checks/dice.js): this reply, which carries no fight, is offered three dice, rolled from its own seed and recorded with it, together with the
        // rules, difficulty numbers and practice in force now and each member's bonuses (a Re-read and a replay use these, never the settings of the day). The switch is
        // Story checks alone, as the grammar line is: Rolls (the fights' setting) does not matter, so the static prompt does not move with it.
        const values = readSettings(view, moduleId);
        let dice = null;
        if (checksOn(values)) {
            let records = null;
            try { records = view.query?.('packs.content', { kind: 'rpg' }); } catch { /* no pack rules */ }
            dice = { type: DICE, payload: dicePayload(membersOf(view, sheet), values, records) };
        }
        if (values[ROLLS_SETTING] === 'off') return dice ? { commands: [dice] } : null;
        // No model is asked for a plan: with no fight to carry the reply goes out as one the planner once answered "none" to.
        const first = noFight(sheet, on);
        return dice ? { ...(first ?? {}), commands: [dice] } : first;
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
