/* NPC State Delta dossier screens: the pure screen state machine (library | board | profile | section:n), back and Esc order,
   sideways swipe steps, the dossier's own width switch (one column, or two panes) and the desktop pane layout. No markup here; the screen renderers draw each screen. */

// The layout follows the dossier's OWN width (its panel, not the window). Every switch line is a sum of the minimum content widths
// that must fit side by side, never a device width. The CSS @container lines in dossier-ui-styles*.js import these same numbers.
export const PANE_HERO_MIN = 250; // the dial pane: the dial (210 at least) with its labels and padding
export const PANE_HERO_SLIM_MIN = 230; // the same pane with a section open beside it
export const PANE_TILES_MIN = 290; // the tiles: two columns of 140 and the gap and padding
export const PANE_SECTION_MIN = 370; // a section pane, narrowest (its clamp tops out at 420)
export const PANE_SECTION_WIDE_MIN = 420; // a section pane at the width three panes are given
// Two panes (dial pane beside the tiles or a section): 250 + 370.
export const TWO_PANE_MIN = PANE_HERO_MIN + PANE_SECTION_MIN;
// Three panes (dial pane, tiles and a section): 230 + 290 + 420.
export const THREE_PANE_MIN = PANE_HERO_SLIM_MIN + PANE_TILES_MIN + PANE_SECTION_WIDE_MIN;
export const SWIPE_MIN_PX = 48;
export const SECTION_KEYS = Object.freeze(['now', 'with', 'ties', 'past', 'secrets']);
const SCREEN_NAMES = Object.freeze(['library', 'board', 'profile', 'section']);
const HISTORY_LIMIT = 24;
const DESKTOP_PANES = Object.freeze({
    library: Object.freeze(['library']),
    board: Object.freeze(['dial', 'board']),
    section: Object.freeze(['dial', 'board', 'section']),
    profile: Object.freeze(['portrait', 'profile']),
});

// Sections are 0-based: 0 Right now, 1 With {{user}} (key "with"), 2 Ties, 3 Past, 4 Secrets.
export function normalizeSection(value) {
    const n = Number.parseInt(value, 10);
    return Number.isInteger(n) && n >= 0 && n < SECTION_KEYS.length ? n : 0;
}

// Parses 'library' | 'board' | 'profile' | 'section:n'; anything unknown is the library.
export function parseScreen(text) {
    const raw = String(text ?? '').trim().toLowerCase();
    const match = /^section:(\d+)$/.exec(raw);
    if (match) return { name: 'section', section: normalizeSection(match[1]) };
    return { name: SCREEN_NAMES.includes(raw) ? raw : 'library', section: 0 };
}

export function formatScreen(screen) {
    return screen.name === 'section' ? `section:${normalizeSection(screen.section)}` : screen.name;
}

// A board, profile or section needs an NPC; without one the state falls back to the library.
function resolve(target, npcId) {
    const parsed = typeof target === 'string' ? parseScreen(target) : target;
    const wanted = SCREEN_NAMES.includes(parsed?.name) ? parsed.name : 'library';
    const name = wanted !== 'library' && !npcId ? 'library' : wanted;
    return { npcId: npcId || null, name, section: name === 'section' ? normalizeSection(parsed?.section) : 0 };
}

function frameOf(state) {
    return { npcId: state.npcId, name: state.name, section: state.section };
}

function sameFrame(a, b) {
    return a.npcId === b.npcId && a.name === b.name && a.section === b.section;
}

export function createScreenState({ npcId = null, screen = 'library' } = {}) {
    return { ...resolve(screen, npcId), history: [] };
}

// Moves to another screen and pushes the current one, so Back returns to it. Showing the screen already shown changes nothing.
export function showScreen(state, target, npcId = state.npcId) {
    const next = resolve(target, npcId);
    const current = frameOf(state);
    if (sameFrame(current, next)) return state;
    return { ...next, history: [...state.history, current].slice(-HISTORY_LIMIT) };
}

export function openNpc(state, npcId) {
    return showScreen(state, 'board', npcId);
}

export function openSection(state, index) {
    return showScreen(state, { name: 'section', section: index });
}

// Back pops one screen; with no history it goes to the library.
export function goBack(state) {
    if (state.history.length === 0) return { ...resolve('library', state.npcId), history: [] };
    const previous = state.history[state.history.length - 1];
    return { ...resolve(previous, previous.npcId), history: state.history.slice(0, -1) };
}

// A dot jumps to one section in place (no history), like the arrows.
export function setSection(state, index) {
    if (state.name !== 'section') return state;
    const section = normalizeSection(index);
    return section === state.section ? state : { ...state, section };
}

// Arrows and swipes move between sections in place; they do not add history.
export function stepSection(state, delta) {
    if (state.name !== 'section') return state;
    const section = Math.min(SECTION_KEYS.length - 1, Math.max(0, state.section + Math.sign(delta)));
    return section === state.section ? state : { ...state, section };
}

// Esc order: a blocking overlay (editor, lightbox) takes it first; otherwise go back a screen; the library closes the panel.
export function escapeAction(state, { blocked = false } = {}) {
    if (blocked) return 'none';
    return state.name !== 'library' || state.history.length > 0 ? 'back' : 'close';
}

// A sideways swipe of at least SWIPE_MIN_PX that is mostly horizontal: swipe left = next section (+1), right = previous (-1).
export function swipeStep(dx, dy, { min = SWIPE_MIN_PX } = {}) {
    if (Math.abs(dx) < min || Math.abs(dx) <= Math.abs(dy) * 1.5) return 0;
    return dx < 0 ? 1 : -1;
}

// Phone: the one screen. Desktop: library alone; board = dial + board; section adds a right pane; profile = portrait + profile.
export function layoutFor(state, { phone = false } = {}) {
    if (phone) return { mode: 'phone', panes: [state.name] };
    return { mode: 'desktop', panes: DESKTOP_PANES[state.name] || DESKTOP_PANES.library };
}

// Goes into the dossier viewToken so a refresh keeps the screen and does not reset it.
export function screenSignature(state) {
    return `${state.npcId || ''}|${formatScreen(state)}`;
}

// The dossier's width in CSS px: its panel when it is shown, else the window (nothing is drawn while it is hidden anyway).
export function panelWidth(panel, win = globalThis) {
    if (!panel || !(panel.clientWidth > 0)) return win?.innerWidth || 0;
    // The container the CSS queries see is the panel's content box, in fractional px (clientWidth rounds, and a zoomed host gives fractional borders).
    const style = typeof win?.getComputedStyle === 'function' ? win.getComputedStyle(panel) : null;
    const px = value => parseFloat(value) || 0;
    const box = style && style.boxSizing === 'border-box' ? px(style.width) - px(style.borderLeftWidth) - px(style.borderRightWidth) - px(style.paddingLeft) - px(style.paddingRight) : 0;
    return box > 0 ? box : panel.clientWidth;
}

// One column (the narrow layout) while the dossier is narrower than two panes need.
export function isNarrowWidth(width) {
    return width > 0 && width < TWO_PANE_MIN; // an unknown width (nothing measured yet) draws the two-pane layout
}
export function isNarrow(panel, win = globalThis) {
    return isNarrowWidth(panelWidth(panel, win));
}

// The width a ResizeObserver entry reports: the panel's content box, the very box the CSS @container lines measure, so the redraw
// and the stylesheet agree on the same frame. Falls back to measuring the panel for a host without contentBoxSize.
export function observedWidth(entry, panel, win = globalThis) {
    const box = Array.isArray(entry?.contentBoxSize) ? entry.contentBoxSize[0] : entry?.contentBoxSize;
    return box && box.inlineSize > 0 ? box.inlineSize : panelWidth(panel, win);
}

// Wires touch swipes on one element; onStep receives +1 or -1. Returns the unbind function.
export function bindSwipe(element, onStep) {
    if (!element || typeof element.addEventListener !== 'function') return () => {};
    let start = null;
    const onStart = (event) => {
        const touch = event.touches?.[0];
        start = touch ? { x: touch.clientX, y: touch.clientY } : null;
    };
    const onEnd = (event) => {
        const touch = event.changedTouches?.[0];
        const from = start;
        start = null;
        if (!from || !touch) return;
        const step = swipeStep(touch.clientX - from.x, touch.clientY - from.y);
        if (step) onStep(step);
    };
    const onCancel = () => { start = null; };
    element.addEventListener('touchstart', onStart, { passive: true });
    element.addEventListener('touchend', onEnd, { passive: true });
    element.addEventListener('touchcancel', onCancel, { passive: true });
    return () => {
        element.removeEventListener('touchstart', onStart);
        element.removeEventListener('touchend', onEnd);
        element.removeEventListener('touchcancel', onCancel);
    };
}
