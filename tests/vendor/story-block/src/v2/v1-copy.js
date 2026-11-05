// An old copy of Story Block (version 1) enabled next to this one: its own prompt tells the model to end every reply with
// v1's `<!-- STORY_BLOCKS_V1 … -->` envelope (which the model then writes instead of, or beside, the <Changes> block), and
// both name the same generate interceptor. Told once as one plain Problems line (and a notice) while it is running; nothing
// is said once it is disabled (a page loaded without it never sees either sign).
//
// The signs are v1's own, so nothing else sets them off: its public object, `globalThis.StoryBlock` with `apiVersion: 1` and
// v1's block functions (v2's has `apiVersion: 2` and an sdk), seen before this file set its own or put back over it later;
// and its settings drawer, whose element ids v2 never uses (v1's entry file, `index.js` on the `v1` branch). A legacy envelope in a chat is no sign: chats
// made while v1 ran keep theirs after it is gone.

export const V1_COPY_CODE = 'V1_COPY';
export const V1_COPY_PROBLEM = 'An old copy of Story Block (version 1) seems to be installed too; remove it under Extensions.';
// v1's settings drawer (v1's `index.js`, on the `v1` branch): its Rescan button and its display and money pickers.
const V1_IDS = ['story_block_rescan', 'story_block_display', 'story_block_money'];

/** True when `api` is v1's public object (v1's `index.js`, on the `v1` branch: frozen, apiVersion 1, listBlocks / getBlock / registerBlock). */
export function isV1Api(api) {
    if (!api || typeof api !== 'object') return false;
    try {
        return api.apiVersion === 1 && !api.sdk && ['listBlocks', 'getBlock', 'registerBlock'].every(name => typeof api[name] === 'function');
    } catch {
        return false;
    }
}

/** True when the page shows v1's settings drawer. */
export function hasV1Settings(doc) {
    try {
        return V1_IDS.some(id => !!doc?.getElementById?.(id));
    } catch {
        return false;
    }
}

/**
 * Watches for a v1 copy: `before` is what `globalThis.StoryBlock` held before this copy set its own; `current()` what it
 * holds now; `report(entry)` adds a Problems line; `problems()` the list (so the line is not told twice). → check(), which
 * looks again (at start, when the app is ready, on a chat change) and returns true when it found one.
 */
export function createV1Watch({ before = null, current = () => globalThis.StoryBlock, doc = globalThis.document, report, problems = () => [] } = {}) {
    const earlier = isV1Api(before);
    return {
        check() {
            let now = null;
            try { now = current(); } catch { now = null; }
            const found = earlier || isV1Api(now) || hasV1Settings(doc);
            if (!found) return false;
            let told = false;
            try { told = (problems() ?? []).some(item => item?.code === V1_COPY_CODE); } catch { told = false; }
            // (Told at once too: only the reader can remove it.)
            if (!told) report?.({ code: V1_COPY_CODE, message: V1_COPY_PROBLEM, toast: true });
            return true;
        },
    };
}
