// The money guard: a `+ coin` line (or a money-named `+ item`) that pays what an earlier reply already paid from the same source, or
// is far above the purse, still applies but adds a warning to the Problems list. It reads receipts only (this reply's lines so far and
// the stored receipts of the few replies before) and writes nothing, so replay, rebuild and live agree and no line is ever blocked.
import { readRecord } from '../persist.js';
import { CAPTURE_PREFIX } from '../registry-checks.js';

/** How many messages back the guard looks for the same payment. */
export const GUARD_REPLIES = 4;
/** "Far above the purse": more than this many times the purse before the line, and more than FAR_MIN units. */
export const FAR_TIMES = 5;
export const FAR_MIN = 10;

// The source of a payment, as the line wrote it: `from Master Vane's saddle-coffer (70 silver…)` → `master vane's saddle-coffer`.
export const sourceOf = note => String(note ?? '').replace(/^from\s+/iu, '').replace(/\(.*$/u, '').normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();

// A receipt that paid the party's wallet from a story line: { amount, now, source }, else null.
export function paidBy(receipt) {
    const data = receipt?.data;
    if (!String(receipt?.type ?? '').startsWith(CAPTURE_PREFIX) || !data || typeof data !== 'object') return null;
    if (!/ receives /u.test(String(receipt.summary ?? '')) || !Number.isSafeInteger(data.amount) || !Number.isSafeInteger(data.now)) return null;
    return { amount: data.amount, now: data.now, source: sourceOf(data.note) };
}

/** The stored receipts of the replies before message `index` (at most GUARD_REPLIES messages back, the reader's own skipped). */
export function earlierReceipts(chat, index) {
    const out = [];
    let seen = 0;
    for (let at = index - 1; at >= 0 && seen < GUARD_REPLIES; at -= 1) {
        const message = chat?.[at];
        if (!message || message.is_user || message.is_system) continue;
        seen += 1;
        out.push(...(readRecord(message)?.receipts ?? []));
    }
    return out;
}

/** The warning for a coin line's receipt, or null. `before`: receipts it can be compared with (earlier replies' and this reply's lines so far). */
export function moneyWarning(receipt, before) {
    const now = paidBy(receipt);
    if (!now) return null;
    const repeated = now.source && before.some(other => { const paid = paidBy(other); return paid && paid.source === now.source && paid.amount === now.amount; });
    if (repeated) return `${now.amount} from "${now.source}" was paid in a reply a moment ago and is paid again here. It was applied; undo it if the story paid the same find twice.`;
    const purse = now.now - now.amount;
    // An empty purse is no baseline (a chat's first money is not "far above" anything): only a purse with something in it is compared.
    if (purse > 0 && now.amount > FAR_MIN && now.amount > FAR_TIMES * purse) return `${now.amount} is more than ${FAR_TIMES} times the purse (${purse}). It was applied; undo it if the story paid too much.`;
    return null;
}
