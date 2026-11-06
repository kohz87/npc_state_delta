// Keeps a failed board capture attached to the reply's stable record ID.
// Markers are add-only; the reply's recorded prelude shows when capture succeeded.
// The turn restores the small capture session after a reload or swipe.

import { readRecord } from '../persist.js';
import { rpgLib } from '../rpg-lazy.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
export const boardStep = current => current?.prechecks?.find(step => step?.type === 'rpg.resolve' && step.payload?.board);

/** The "restore or discard" advice that ends a fight failure (none when the message already says discard). */
export const restoreHint = (detail, tail = '.') => (/discard/i.test(detail) ? '' : ` Restore the sheet or gear, or discard the fight${tail}`);

/** "<lead> <reason>. Restore the sheet or gear, or discard the fight." for a fight that could not be saved or prepared. */
export function boardFailure(lead, message) {
    const detail = String(message ?? 'unknown error').trim().replace(/[.\s]+$/u, '');
    return `${lead} ${detail}.${restoreHint(detail)}`;
}

export function heldForSid(meta, sid, receipts = []) {
    const held = typeof sid === 'string' ? meta?.rpgFightHeld?.[sid] : null;
    const step = boardStep(held?.current);
    if (!object(held) || !step) return null;
    const done = receipts.some(receipt => receipt?.type === 'rpg.resolve' && receipt.beforeGenerate === true
        && receipt.replan?.payload?.key === step.payload.key && receipt.replan?.payload?.board?.id === step.payload.board.id);
    return done ? null : held;
}

export function heldForMessage(meta, message) {
    if (!object(meta?.rpgFightHeld)) return null;
    const record = readRecord(message);
    return record ? heldForSid(meta, record.sid, record.receipts) : null;
}

export function rememberHeld(meta, sid, current, staged) {
    if (!object(meta) || typeof sid !== 'string' || !sid || !boardStep(current)) return false;
    if (!object(meta.rpgFightHeld)) meta.rpgFightHeld = {};
    if (!Object.hasOwn(meta.rpgFightHeld, sid)) {
        meta.rpgFightHeld[sid] = { current: structuredClone({ type: current.type, prechecks: current.prechecks,
            base: current.base, untold: current.untold, stopped: current.stopped === true }), staged };
    }
    return true;
}

export function discardHeld(meta, sid) {
    if (!object(meta) || typeof sid !== 'string' || !meta.rpgFightHeld?.[sid]) return;
    if (!object(meta.rpgFightHeldDiscarded)) meta.rpgFightHeldDiscarded = {};
    if (!Object.hasOwn(meta.rpgFightHeldDiscarded, sid)) meta.rpgFightHeldDiscarded[sid] = true;
}

/** A copied chat cannot keep a staged fight if its anchor reply was not copied. */
export function pruneMissingBoard(meta, chat) {
    const session = meta?.rpgFightBoard;
    if (!object(meta) || !object(session) || typeof session.anchor !== 'string' || !session.anchor) return false;
    if ((Array.isArray(chat) ? chat : []).some(message => !message?.is_user && readRecord(message)?.sid === session.anchor)) return false;
    delete meta.rpgFightBoard;
    return true;
}

/** Recreate a board's opening without recording it, then check the exact sheet the board used. */
export function boardStartState(bus, state, board) {
    const opening = board?.setup?.opening;
    if (!opening) return { state };
    if (!object(opening.payload) || !Number.isSafeInteger(opening.seed)) return { error: 'The fight opening is damaged.' };
    const preview = bus.run('rpg.resolve', opening.payload, { cause: 'system', state, seed: opening.seed });
    const result = preview?.receipt?.data?.v2?.result;
    const dropOf = rpgLib()?.dropOf;
    if (!preview?.ok || !result || typeof dropOf !== 'function' || JSON.stringify(result.checks ?? []) !== JSON.stringify(board.setup.approach ?? [])
        || JSON.stringify(dropOf(result)) !== JSON.stringify(board.setup.drop ?? null)) return { error: 'The fight opening changed. Restore the sheet or discard the fight.' };
    return { state: preview.state, result };
}
