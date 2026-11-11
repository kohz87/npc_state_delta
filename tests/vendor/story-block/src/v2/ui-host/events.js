// Installs the page host's event listeners in their original order, and holds the redraw a multi-step form asks for (createHold, below).
// The panel, overlay and blocked notice remain live until the returned listeners are removed.

import { captureConsole } from '../diagnostics.js';

export function installUiEvents({ replyOffs, offs0, registry, store, events, ctx, runtime, mounts, screens, blockWidgets, cardOffer, blockPresentation, syncScreens, syncLeanRpg, refresh, clearBlocked, getPanel, getTabHost, getOverlay, getBlockedBy, redrawHold }) {
    const offs = [...replyOffs, ...offs0];
    // Story Suite's console errors, kept for Diagnostics (once per page; the console still prints them).
    offs.push(captureConsole());
    // The blocks' screens come from `dataModules.presentation`, a query that settles the timeline and reads the story. It depends only on
    // which block definitions are pinned, so it is asked again only when that stamp moved (a pin, unpin, edit or migration changes a
    // block's hash; a swipe, delete, Re-read, rewind, restore or chat switch changes which blocks the head holds). One reply sends many
    // `head` and `committed` events: each looks at the stamp at once (the listeners after this one read the screens in the same event, so
    // the screens are not left for later), and only the first to see a new stamp asks. The last state always wins: every event checks it.
    let dataPresentation = '', dataStamp = null;
    const presentationStamp = () => {
        try {
            if (!registry.query?.('dataModules.presentation')) return null;
            const modules = store.head()?.domains?.dataModules;
            return JSON.stringify(Object.entries(modules?.active ?? {}).map(([id, entry]) => [id, entry?.hash, Boolean(modules.pins?.[entry?.hash])]));
        } catch { return null; }   // (not known: asked every time, as before)
    };
    for (const name of ['head', 'committed']) offs.push(events.on(name, () => {
        const stamp = presentationStamp();
        if (stamp === null || stamp !== dataStamp) {
            dataStamp = stamp;
            let next = '', pinned = null;
            // (A query that throws leaves no stamp behind, so the next event asks again, as before the stamp.)
            try { pinned = blockPresentation() ?? []; if (pinned.length) next = JSON.stringify(pinned); } catch { dataStamp = null; /* older host */ }
            if (next !== dataPresentation) { dataPresentation = next; syncScreens(pinned); }
        }
        // (the panel's redraw waits while a form's plan holds it, and runs once after)
        const redraw = () => { mounts.tab.register(); if (!getPanel().hidden) getTabHost()?.refresh(); };
        if (name === 'committed') redrawHold.run('panel', redraw); else redraw();
    }));
    // A feature turned on or off: its screens, tabs, widgets and cards come and go; nothing else changes.
    for (const name of ['head', 'committed', 'turn']) offs.push(events.on(name, () => getOverlay()?.refreshSize?.()));
    // A chat change closes the dialogs (their drafts were for the chat they were opened in).
    const chatTypes = ctx.eventTypes ?? ctx.event_types ?? {};
    const onChatChanged = () => {
        blockWidgets.reset();
        mounts.dialog?.closeAll();
        // The new chat's card is read for its offer (a read of the chat before is dropped).
        cardOffer?.refresh().catch(error => console.warn('[Story Suite] the card offer could not be read', error));
    };
    if (typeof ctx.eventSource?.on === 'function' && chatTypes.CHAT_CHANGED) {
        ctx.eventSource.on(chatTypes.CHAT_CHANGED, onChatChanged);
        offs.push(() => (ctx.eventSource.removeListener ?? ctx.eventSource.off)?.call(ctx.eventSource, chatTypes.CHAT_CHANGED, onChatChanged));
    }
    // A pack turned on or off, installed or removed: the screens it gives come and go with it (the installed store says so).
    offs.push(runtime.packs?.packs?.subscribe?.(() => {
        syncScreens();
        mounts.dialog?.closeWhere?.(screenId => !screens.resolve(screenId));
        refresh();
        mounts.card?.refreshAll?.({ force: true });
    }) ?? (() => {}));
    offs.push(events.on('feature', () => {
        syncLeanRpg();
        // The overlay draws the switch and the fields of that feature again, and the prompt size.
        getOverlay()?.refresh?.();
        syncScreens();
        // A dialog open on a screen that is gone now closes: its controls belong to a part turned off.
        mounts.dialog?.closeWhere?.(screenId => !screens.resolve(screenId));
        refresh();
        mounts.card?.refreshAll?.({ force: true });
    }));
    // The notice goes once the module that held the story back no longer does (the character was made).
    offs.push(events.on('committed', async () => {
        if (!getBlockedBy() || typeof runtime.turn?.blockers !== 'function') return;
        const was = getBlockedBy();
        let still = true;
        try { still = (await runtime.turn.blockers()).some(entry => entry.moduleId === was); } catch { still = true; }
        if (!still && getBlockedBy() === was) clearBlocked();
    }));
    offs.push(events.on('turn', done => {
        clearBlocked();
        // The "Installed …" notice stays for one reply.
        cardOffer?.clearDone();
        if (!getPanel().hidden) getTabHost()?.refresh();
        // The card under that reply now knows its refused lines.
        if (Number.isInteger(done?.index)) mounts.card?.refresh?.(done.index, { force: true });
    }));

    return offs;
}

// The redraw hold: a form with several steps (the Inventory item form) holds the screens' redraw from `committed` events until its plan
// ends, so the form stays alive for every step and shows a refusal; the held redraws then run once each. Held work is keyed, so
// the same listener held twice runs once.
export function createHold() {
    let holds = 0;
    const queued = new Map();
    const flush = () => { const run = [...queued.values()]; queued.clear(); for (const fn of run) fn(); };
    return {
        /** → a release function (safe to call twice); the last release runs what was held. */
        hold() {
            holds += 1;
            let done = false;
            return () => { if (done) return; done = true; holds -= 1; if (!holds) flush(); };
        },
        /** Runs `fn` now, or after the last release when held. */
        run(key, fn) { if (holds) queued.set(key, fn); else fn(); },
        /** Forgets what was held for `key` (its listener went away). */
        drop(key) { queued.delete(key); },
    };
}
