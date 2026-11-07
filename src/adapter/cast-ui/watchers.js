// Page-API change listeners: the subscriber set and the one notification loop used by the rendered cast and key-person pin.

export function createWatchers({ warn }) {
    const watchers = new Set();  // the page API's onChange subscribers
    function notifyChange() {
        for (const fn of [...watchers]) {
            try { fn(); } catch (error) { warn('Story Suite v2 cast listener failed', error); }
        }
    }
    return { watchers, notifyChange };
}
