// Scrolling and focus inside Story Suite's windows, without moving anything around them (phone hotfix).
//
// `node.scrollIntoView()` and a plain `node.focus()` scroll every scrollable ancestor, and on a phone that includes the
// fixed layer and window around the page (their `overflow: hidden` does not stop a script), the document and the
// browser's visual viewport: the window's header, search and rail were pushed off the top with an empty band below the
// footer. So inside the settings window:
//
// * `revealIn(scroller, node, block)` moves one thing only: the page scroller's `scrollTop`.
// * `focusNode(node)` is `focus({ preventScroll: true })`; the caller reveals the node with `revealIn` when it should be seen.
// * `holdPage(doc)` keeps the document where it was while the window is open (and stops overscroll chaining into it).
// * `followViewport(doc, layer)` (a phone) keeps the window's layer exactly over what is visible: the visual viewport
//   (it shrinks for the on-screen keyboard and can be panned by the browser).
//
// * `gapBelow(scroller)`, `atBottom(scroller)`, `scrollToBottom(scroller)` and `keepAtBottom(scroller)` are for a list that grows at its end
//   (the chat: a card drawn under the newest reply): `keepAtBottom` is asked before the growth and `settle()` after it, and the list
//   is taken to its bottom again only if the reader was at the bottom before; a reader who had scrolled up is never moved.
// * `zoomOf(node)` is the CSS zoom a node is drawn at (Story Suite's roots are zoomed, size.css): measured distances are drawn
//   pixels, `scrollTop` is the scroller's own, so a measured distance is divided by it before it moves a scroller.
//
// Everything tolerates a document with no layout (the tests' fake DOM): nothing is scrolled then, and nothing throws.

const PHONE = '(max-width: 759.98px)';

/**
 * The CSS zoom `node` is drawn at, its ancestors' included: the browser's `currentCSSZoom` where it has one, else its drawn width
 * over its own; 1 when there is nothing to measure (no layout, the tests' fake DOM).
 */
export function zoomOf(node) {
    const own = Number(node?.currentCSSZoom);
    if (Number.isFinite(own) && own > 0) return own;
    const width = Number(node?.offsetWidth);
    const drawn = Number(node?.getBoundingClientRect?.()?.width);
    return width > 0 && drawn > 0 ? drawn / width : 1;
}

/** Focuses `node` and never scrolls the page for it. → whether there was a node. */
export function focusNode(node) {
    if (!node || typeof node.focus !== 'function') return Boolean(node);
    try { node.focus({ preventScroll: true }); } catch { try { node.focus(); } catch { /* not focusable */ } }
    return true;
}

/** How far (in drawn pixels) the bottom of `scroller`'s content is below what it shows, or null where there is no layout to ask. */
export function gapBelow(scroller) {
    const gap = Number(scroller?.scrollHeight) - Number(scroller?.scrollTop) - Number(scroller?.clientHeight);
    return Number.isFinite(gap) && Number(scroller?.clientHeight) > 0 ? gap : null;
}

/** The most slack "at the bottom" ever allows, in drawn pixels (Story Director's follow of a new reply used the same 400). */
export const BOTTOM_SLACK = 400;

/**
 * How far from its bottom a reader still counts as being at it: half of what the scroller shows, at most BOTTOM_SLACK. SillyTavern scrolls
 * to a new reply and other extensions still add to it after that (status rows, cards: 100 px or more), so a gap of a line or two would
 * miss a reader who has not moved; a reader who scrolled up to read is further away than half a screen.
 */
export function bottomSlack(scroller) {
    const shown = Number(scroller?.clientHeight);
    return Number.isFinite(shown) && shown > 0 ? Math.min(BOTTOM_SLACK, Math.round(shown / 2)) : 0;
}

/** Whether `scroller` is scrolled to (within `slack` pixels, by default bottomSlack) of its bottom. False where there is no layout. */
export function atBottom(scroller, slack = bottomSlack(scroller)) {
    const gap = gapBelow(scroller);
    return gap !== null && gap <= slack;
}

/** Takes `scroller` (not its ancestors) to its bottom. → whether it moved. */
export function scrollToBottom(scroller) {
    if (!scroller || !(Number(scroller.scrollHeight) > 0)) return false;
    const before = scroller.scrollTop;
    scroller.scrollTop = scroller.scrollHeight;
    return scroller.scrollTop !== before;
}

/**
 * Looks now at whether `scroller` is at its bottom. → `{ wasAtBottom, settle() }`: after its content has grown, `settle()` takes it to the
 * bottom again if (and only if) it was at the bottom when this was called, and returns whether it moved.
 */
export function keepAtBottom(scroller, slack = bottomSlack(scroller)) {
    const wasAtBottom = atBottom(scroller, slack);
    return { wasAtBottom, settle: () => (wasAtBottom ? scrollToBottom(scroller) : false) };
}

/** The page scroller a node is in (the settings window's `.ss-settings-content`), or null. */
export function scrollerOf(node) {
    return node?.closest?.('.ss-settings-content') ?? null;
}

// The height the page's own heading strip covers at the top of the scroller (a sticky strip from 760px), 0 when there is none.
function coveredTop(scroller, box) {
    const view = scroller.ownerDocument?.defaultView;
    // a document that cannot answer the selector (a test's fake DOM) has no heading strip: nothing is covered
    let head = null;
    try { head = scroller.querySelector?.('.ss-settings-page-head:not([hidden])') ?? null; } catch { head = null; }
    if (!head || typeof head.getBoundingClientRect !== 'function' || typeof view?.getComputedStyle !== 'function') return 0;
    if (view.getComputedStyle(head).position !== 'sticky') return 0;
    const rect = head.getBoundingClientRect();
    return Math.max(0, rect.bottom - box.top);
}

/**
 * Scrolls `scroller` (not its ancestors) so `node` shows: `block` 'start' puts it near the top (under the sticky heading
 * strip), 'center' in the middle, 'nearest' only as far as needed. `scroller` may be null: the node's page scroller. → whether it moved.
 */
export function revealIn(scroller, node, block = 'start') {
    const box = scroller ?? scrollerOf(node);
    if (!box || !node || typeof box.getBoundingClientRect !== 'function' || typeof node.getBoundingClientRect !== 'function') return false;
    const outer = box.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    if (!(outer.height > 0)) return false;
    const covered = coveredTop(box, outer);
    const margin = 8;
    let delta = 0;
    if (block === 'center') delta = (rect.top + rect.height / 2) - (outer.top + covered + (outer.height - covered) / 2);
    else if (block === 'nearest') {
        if (rect.top < outer.top + covered + margin) delta = rect.top - (outer.top + covered + margin);
        else if (rect.bottom > outer.bottom - margin) delta = Math.min(rect.bottom - (outer.bottom - margin), rect.top - (outer.top + covered + margin));
    } else delta = rect.top - (outer.top + covered + margin);
    if (!delta) return false;
    const before = box.scrollTop;
    box.scrollTop = before + delta / zoomOf(box);
    return box.scrollTop !== before;
}

/** Reveals a node and takes the focus to it, moving nothing but the page scroller. */
export function showAndFocus(node, block = 'start') {
    if (!node) return false;
    revealIn(null, node, block);
    return focusNode(node);
}

/**
 * Holds the document still while a window is open: the scroll position it had is put back if anything moves it, and a scroll
 * that reaches the end of the window's own scrollers does not carry on into the page. → release().
 */
export function holdPage(doc) {
    const root = doc?.scrollingElement ?? doc?.documentElement ?? null;
    if (!root || typeof doc.addEventListener !== 'function') return () => {};
    const top = root.scrollTop || 0;
    const left = root.scrollLeft || 0;
    const style = doc.documentElement?.style ?? null;
    const was = style ? style.overscrollBehavior : '';
    if (style) style.overscrollBehavior = 'none';
    const keep = () => {
        if (root.scrollTop !== top) root.scrollTop = top;
        if (root.scrollLeft !== left) root.scrollLeft = left;
    };
    doc.addEventListener('scroll', keep);
    return () => {
        doc.removeEventListener?.('scroll', keep);
        if (style) style.overscrollBehavior = was ?? '';
    };
}

/**
 * Keeps a full-screen `layer` (position: fixed) over the visible area on a phone: when the visual viewport has been shrunk (the
 * on-screen keyboard) or panned (the browser brings a focused box into view), the layer takes its top and height, so the window's
 * header never leaves the screen. Wide screens are left alone. → stop().
 */
export function followViewport(doc, layer) {
    const view = doc?.defaultView;
    const vv = view?.visualViewport;
    if (!vv || typeof vv.addEventListener !== 'function' || !layer?.style) return () => {};
    const phone = () => view.matchMedia?.(PHONE)?.matches !== false;
    const clear = () => { layer.style.top = ''; layer.style.height = ''; };
    const apply = () => {
        if (!phone()) { clear(); return; }
        const top = Number(vv.offsetTop) || 0;
        const height = Number(vv.height) || 0;
        if (height > 0 && (top > 0.5 || Math.abs(height - (view.innerHeight || height)) > 1)) {
            layer.style.top = `${Math.round(top)}px`;
            layer.style.height = `${Math.round(height)}px`;
        } else clear();
    };
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    apply();
    return () => {
        vv.removeEventListener?.('resize', apply);
        vv.removeEventListener?.('scroll', apply);
        clear();
    };
}
