// Keeps the newest reply's card in view: a draw or open that changes its box settles the chat at the
// bottom only when the reader was there before the change.

import { keepAtBottom } from '../../scroll.js';

export function createFollow() {
    let following = null;       // { pass, measured, watch, newest }
    // The newest message has no `.mes` after it (SillyTavern's chat is a flat list of them).
    const isNewest = message => {
        for (let next = message.nextElementSibling; next; next = next.nextElementSibling) if (next.classList?.contains('mes')) return false;
        return true;
    };
    function beforeChange(message) {
        if (!following || following.measured) return;
        // A single draw for an older message cannot matter; a pass over many might end at the newest.
        if (!following.pass && !isNewest(message)) return;
        following.measured = true;
        const chat = message.closest?.('#chat') ?? null;
        following.watch = chat ? keepAtBottom(chat) : null;
    }
    function changed(message) {
        if (following?.measured && isNewest(message)) following.newest = true;
    }
    function follow(run, { pass = false } = {}) {
        if (following) return run();
        following = { pass, measured: false, watch: null, newest: false };
        try {
            return run();
        } finally {
            const done = following;
            following = null;
            if (done.newest) done.watch?.settle();
        }
    }

    return { beforeChange, changed, follow };
}
