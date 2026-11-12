// Story Block's extra core query helpers: Inner chatter coming back into the prompt, and whether the
// head reply moved the scene.

import { answeredReply, chatterTail } from '../../extras.js';

/**
 * The tail part of Inner chatter (MODULES §F115): with the reader's `chatterInPrompt` on, the thoughts
 * of the reply the reader's latest message answered, as one optional line (dropped first when the tail
 * is full). Off (the default), nothing: chatter never reaches a later prompt. `extras`: { promptChat() →
 * SillyTavern's chat without the messages a restore faded (the timeline's active-history reader), display(mes) → displayLines' answer };
 * without it, nothing.
 */
export function chatterBack(settings, extras) {
    let on = false;
    try { on = settings()?.chatterInPrompt === true; } catch { on = false; }
    if (!on || typeof extras?.promptChat !== 'function' || typeof extras.display !== 'function') return { lines: [], optional: [] };
    const chat = extras.promptChat();
    const at = answeredReply(chat);
    if (at < 0) return { lines: [], optional: [] };
    const line = chatterTail(extras.display(String(chat[at]?.mes ?? ''), chat[at]).chatter);
    return { lines: [], optional: line ? [line] : [] };
}

/**
 * `scene.moved` → true when the head reply (the last carrier) moved the scene to another place: one of
 * its receipts is a `scene.place` (a `~ place` line: `capture.place`) that says `moved`. From the line's receipts (tools.receipts), so a
 * swipe, a delete or a Re-read answers as a rebuild does. False without a head or receipts.
 */
const PLACE_RECEIPTS = new Set(['scene.place', 'capture.place']);
export function headMoved(tools, headIndex) {
    let head = -1;
    try { head = typeof headIndex === 'function' ? headIndex() : -1; } catch { head = -1; }
    if (!Number.isInteger(head) || head < 0) return false;
    let list = [];
    try { list = typeof tools?.receipts === 'function' ? tools.receipts() ?? [] : []; } catch { list = []; }
    return list.some(entry => entry?.index === head && PLACE_RECEIPTS.has(entry.receipt?.type) && entry.receipt?.data?.moved === true);
}
