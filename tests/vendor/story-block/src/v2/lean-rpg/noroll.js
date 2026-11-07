// `rpg.noroll`, the record of a reply whose roll planner gave nothing usable while a fight was live. The planner is gone (nothing writes this record
// any more); the command and the reader stay so an old chat's note still replays, shows and re-reads the same.
//
// The pre-call asked for dice, a fight was on (a filled foe with health) and the plan failed: it timed out, the call failed or the answer could not be
// read. The quiet ROLLS_SKIPPED line in Settings → Diagnostics says so for this session only; this prelude keeps the same fact WITH THE REPLY, as a receipt on
// it (like the roll's own), so the note under the reply (view/battle-log.js, where the battle log would stand) survives a reload, a rebuild and a Re-read,
// is the same on a replay as live, and goes with the reply: a swipe that rolls has its own receipts and no note.
//
// It changes no state, claims nothing (a swipe or a retry plans again) and is never told to the narrator (`narrate: false`: turn.js adds no cue for it;
// the tail's NO_ROLLS_LINE is the narrator's, unchanged). The record, `data.v2.skip`: { v: 1, reason: 'timeout' | 'failed' | 'unreadable', key, limit? },
// `limit` = the seconds the planner was given (timeout only), so the note says the limit that was used whatever the setting says now.
import { NOROLL, NOROLL_LIMIT_MAX } from './names.js';

export const SKIP_VERSION = 1;
export const SKIP_REASONS = Object.freeze(['timeout', 'failed', 'unreadable']);
const KEY = /^\d{1,7}-[0-9a-z]{1,7}$/;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** `rpg.noroll { key, reason, limit? }`: a prelude (turn.js previews it and stores it on the generated reply with the same seed). */
export function noRoll(ctx, payload = {}) {
    if (ctx.cause !== 'system' || ctx.caller !== null) ctx.fail('REFUSED', 'This note is made by Story Block before a reply, not by an action.');
    const key = String(payload?.key ?? '');
    if (!KEY.test(key)) ctx.fail('INVALID', 'A note needs the key of the message it was made for.');
    if (!SKIP_REASONS.includes(payload?.reason)) ctx.fail('INVALID', 'That is not a reason the planner can give.');
    const limit = payload.reason === 'timeout' && Number.isInteger(payload.limit) && payload.limit >= 1 && payload.limit <= NOROLL_LIMIT_MAX ? payload.limit : undefined;
    return { summary: '', narrate: false, data: { v2: { key: `rpg:noroll:${key}`, skip: { v: SKIP_VERSION, key, reason: payload.reason, ...(limit ? { limit } : {}) } } } };
}

/** The note a reply's record holds: { reason, limit? } from the last `rpg.noroll` receipt that is whole, else null. `receipts`: the record's receipts. */
export function noRollOf(receipts) {
    const found = (Array.isArray(receipts) ? receipts : []).findLast(receipt => receipt?.type === NOROLL && isObject(receipt.data?.v2?.skip)
        && receipt.data.v2.skip.v === SKIP_VERSION && SKIP_REASONS.includes(receipt.data.v2.skip.reason));
    if (!found) return null;
    const { reason, limit } = found.data.v2.skip;
    return { reason, ...(reason === 'timeout' && Number.isInteger(limit) && limit >= 1 && limit <= NOROLL_LIMIT_MAX ? { limit } : {}) };
}
