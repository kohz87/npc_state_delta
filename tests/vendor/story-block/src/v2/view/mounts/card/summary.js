// The card mount's closed-line summary helpers and the default count of recent carriers a rebuild revisits.

const META = /^\/meta(\/|$)/;

/** How many of the last carriers a redraw after a rebuild goes over, besides those on screen. */
export const RECENT = 30;

/**
 * The default header summary, from the carrier's changed paths: "No changes" when nothing but the meta
 * moved, else nothing (a count of changed paths means nothing to a reader; a screen that wants a line
 * gets one from the mount's `summary`).
 */
export function changeSummary(changes) {
    const count = (changes ?? []).filter(path => !META.test(path)).length;
    return count === 0 ? 'No changes' : '';
}

export const indexOf = value => (typeof value === 'number' ? value : Number(value?.messageId ?? value?.index ?? value));
