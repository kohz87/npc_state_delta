// Coordinates the waiting reply, its pause screen and the board's send button.
// The saved choice is bound to the chat's last user message and anchor reply.

import { createPauseView } from './pause.js';
import { pauseViewData } from './start-view-data.js';
import { pendingStart } from '../../turn/fight-start.js';
import { readSheet } from '../read.js';
import { boardSession, clearSend, markSend } from './session.js';

export function createStartController({ doc, chat, meta, state, preview, board, on, save, refresh, generate, show = () => {}, close = () => {} } = {}) {
    const listeners = new Set();
    let sending = false, error = '';
    const current = () => on() ? pendingStart(meta(), chat()) : null;
    const tell = () => { for (const draw of [...listeners]) draw(); refresh?.(); };
    const persist = () => { try { save?.(); } catch { /* kept in this page */ } };
    const begin = () => {
        const pending = current();
        if (!pending || pending.choice) return;
        const opened = pending.opening ? preview?.() : null;
        if (pending.opening && (!opened || JSON.stringify(opened.result?.checks ?? []) !== JSON.stringify(pending.result?.checks ?? [])
            || JSON.stringify(opened.result?.opened ?? []) !== JSON.stringify(pending.result?.opened ?? []))) {
            error = 'The sheet changed. Restore it before opening the fight, or choose narration.'; tell(); return;
        }
        if (!board()?.open({ state: opened?.state ?? state(), opening: pending.opening, result: opened?.result })) {
            error = 'The fight could not be opened. Check the party and foes.'; tell(); return;
        }
        error = '';
        pending.choice = 'board';
        persist(); tell();
    };
    const send = () => {
        const pending = current();
        if (!pending || sending) return;
        // The staged fight goes with the send or the send does not happen: it is never replaced by a new planner roll.
        if (pending.choice === 'board' && !markSend(meta(), pending, boardSession(meta()))) {
            error = 'The staged fight cannot be attached to this reply (its anchor reply or exchanges are missing). Discard it and start the fight again.';
            tell(); return;
        }
        if (pending.choice === 'board') persist();
        sending = true;
        tell();
        try {
            const running = generate?.();
            // The reply has started: close the panel so the reader sees it being written.
            try { close(); } catch { /* the panel stays open */ }
            Promise.resolve(running).finally(() => { sending = false; tell(); }).catch(() => {});
        } catch { sending = false; clearSend(meta()); tell(); }
    };
    const narrate = () => {
        const pending = current();
        if (!pending || pending.choice) return;
        if (boardSession(meta())?.exchanges?.length === 0) delete meta().rpgFightBoard;
        pending.choice = 'narrate';
        clearSend(meta());
        persist(); tell();
        if (pending.mode !== 'working') send();
    };
    const pause = createPauseView({ doc, onBoard: begin, onNarrate: narrate });
    // The original message is already in the chat. A second Send must not append another one while it waits.
    const stopSend = event => {
        if (!current()) return;
        event.preventDefault?.(); event.stopImmediatePropagation?.(); event.stopPropagation?.();
        tell(); show();
    };
    const click = event => { if (event.target?.closest?.('#send_but')) stopSend(event); };
    const key = event => {
        if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.isComposing || doc.activeElement !== doc.getElementById?.('send_textarea')) return;
        let sends = true;
        try { sends = globalThis.SillyTavern?.getContext?.()?.shouldSendOnEnter?.() !== false; } catch { /* use the usual Enter action */ }
        if (sends) stopSend(event);
    };
    doc.addEventListener?.('click', click, true);
    doc.addEventListener?.('keydown', key, true);
    const sheetState = () => current()?.opening ? (preview?.()?.state ?? state()) : state();
    const draw = root => {
        const pending = current();
        if (!pending || pending.choice) { error = ''; pause.clear(); return false; }
        const live = state(), sheet = readSheet(live);
        const fight = { groups: sheet.foes.filter(foe => foe.filled && foe.hurt > 0).map(foe => foe.slot) };
        const data = pauseViewData({ fight, opening: pending.result, state: live, waiting: pending.mode === 'working' });
        if (!data) return false;
        pause.render(root, error ? { ...data, note: error } : data);
        return true;
    };
    return {
        current, draw, state: sheetState, send, changed: tell, sending: () => sending,
        waiting: () => current()?.choice === 'board',
        discard() { const pending = current(); if (pending?.choice === 'board') { pending.choice = null; error = ''; clearSend(meta()); persist(); } },
        listen(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        clear: () => pause.clear(),
        destroy() { listeners.clear(); doc.removeEventListener?.('click', click, true); doc.removeEventListener?.('keydown', key, true); pause.destroy(); },
    };
}
