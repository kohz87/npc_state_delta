// Story Suite v2: a scroll cue for a row (or column) of navigation that may not fit: the game view's
// bar and the Story panel's tab bar. It keeps `data-ss-more` on the element up to date ('start', 'end',
// 'both' or 'none': on which side more is hidden) and `data-ss-axis` ('x' or 'y': the way it scrolls);
// the stylesheets fade that edge so the reader sees there is more to scroll to.
//
// scrollCue(el, { win? }) → { update(), destroy() }. It listens to the element's scroll and, when the
// page has one, a ResizeObserver; update() is for after the items change.

/** Which side of a scroller has more hidden: 'start' | 'end' | 'both' | 'none' (1px of slack). */
export function hiddenSides({ scrollStart = 0, scrollSize = 0, clientSize = 0 } = {}) {
    const room = Math.max(0, scrollSize - clientSize);
    const before = scrollStart > 1;
    const after = scrollStart < room - 1;
    return before && after ? 'both' : before ? 'start' : after ? 'end' : 'none';
}

/** The axis that overflows: 'x' when wider than its box, else 'y' when taller, else 'x'. */
export function overflowAxis(el) {
    if ((el.scrollWidth ?? 0) > (el.clientWidth ?? 0) + 1) return 'x';
    if ((el.scrollHeight ?? 0) > (el.clientHeight ?? 0) + 1) return 'y';
    return 'x';
}

export function scrollCue(el, { win = globalThis } = {}) {
    function update() {
        const axis = overflowAxis(el);
        const sides = axis === 'x'
            ? hiddenSides({ scrollStart: Math.abs(el.scrollLeft ?? 0), scrollSize: el.scrollWidth ?? 0, clientSize: el.clientWidth ?? 0 })
            : hiddenSides({ scrollStart: el.scrollTop ?? 0, scrollSize: el.scrollHeight ?? 0, clientSize: el.clientHeight ?? 0 });
        if (el.getAttribute?.('data-ss-axis') !== axis) el.setAttribute('data-ss-axis', axis);
        if (el.getAttribute?.('data-ss-more') !== sides) el.setAttribute('data-ss-more', sides);
        return sides;
    }
    const onScroll = () => update();
    el.addEventListener?.('scroll', onScroll, { passive: true });
    const Observer = win?.ResizeObserver;
    let observer = null;
    if (typeof Observer === 'function') {
        observer = new Observer(() => update());
        observer.observe(el);
    }
    update();
    return {
        update,
        destroy() {
            el.removeEventListener?.('scroll', onScroll);
            observer?.disconnect();
            observer = null;
        },
    };
}
