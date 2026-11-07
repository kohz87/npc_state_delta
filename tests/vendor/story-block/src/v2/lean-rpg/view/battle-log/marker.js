// Finds the narrator's `[battle]` marker in a drawn message, hides markers without a panel, takes a panel out again,
// and puts a panel where the first marker line stood. Text nodes are split and moved; no markup is parsed.

import { BATTLE_ROOT, MARKER_LINE } from './constants.js';

export const nodesOf = node => Array.from(node?.childNodes ?? []);
const SKIP = new Set(['PRE', 'CODE', 'SCRIPT', 'STYLE']);

/** The text nodes under `root` that hold a marker line (outside code and the panels themselves), in order. */
export function markerNodes(root) {
    const out = [];
    const walk = node => {
        for (const child of nodesOf(node)) {
            if (child.nodeType === 3) {
                if (String(child.data ?? child.textContent ?? '').split(/\r?\n/).some(line => MARKER_LINE.test(line))) out.push(child);
            } else if (child.nodeType === 1 && !SKIP.has(child.tagName) && !String(child.className ?? '').split(/\s+/).includes(BATTLE_ROOT)) walk(child);
        }
    };
    walk(root);
    return out;
}

// The marker text a panel took out of the story (placeAtMarker), kept on the panel itself.
export const CONSUMED = Symbol('consumed marker');

// A marker line with no panel to stand for (the reply has no recorded rolls, the feature is off) is hidden, never shown as
// text: a paragraph that holds only it is hidden, else the line is put in a hidden span of its own. It stays in the message,
// so a panel drawn later still finds it (markerNodes walks into it; placeAtMarker shows it again first).
export const MARKER_HIDDEN = 'rpg-battle-marker';
export const isHiddenMarker = node => node?.nodeType === 1 && String(node.className ?? '').split(/\s+/).includes(MARKER_HIDDEN);
const onlyMarker = node => textOf(node).split(/\r?\n/).every(line => !line.trim() || MARKER_LINE.test(line));

/** Hides every marker line under `root` (see above). */
export function hideMarkers(doc, root) {
    for (const node of markerNodes(root)) {
        const parent = node.parentNode;
        if (!parent || isHiddenMarker(parent)) continue;
        if (parent !== root && parent.tagName === 'P' && nodesOf(parent).every(child => child === node || blank(child)) && onlyMarker(node)) {
            parent.hidden = true;
            parent.classList?.add?.(MARKER_HIDDEN) ?? (parent.className = `${parent.className ?? ''} ${MARKER_HIDDEN}`.trim());
            continue;
        }
        const lines = textOf(node).split(/\r?\n/);
        // (A line break drawn right after a marker that stood alone in its text goes into the hidden span with it, so no empty line is left.)
        const next = lines.length === 1 && node.nextSibling?.tagName === 'BR' ? node.nextSibling : null;
        lines.forEach((line, i) => {
            if (MARKER_LINE.test(line)) {
                const span = doc.createElement('span');
                span.className = MARKER_HIDDEN;
                span.hidden = true;
                span.appendChild(doc.createTextNode(line));
                if (next) span.appendChild(next);
                parent.insertBefore(span, node);
            } else if (line) parent.insertBefore(doc.createTextNode(line), node);
            if (i < lines.length - 1) parent.insertBefore(doc.createTextNode('\n'), node);
        });
        node.remove();
    }
}

// Shows again the marker lines hideMarkers hid under `root`.
function showMarkers(doc, root) {
    const hidden = [];
    const walk = node => { for (const child of nodesOf(node)) if (child.nodeType === 1) { if (isHiddenMarker(child)) hidden.push(child); else walk(child); } };
    walk(root);
    for (const node of hidden) {
        if (node.tagName === 'SPAN') {
            for (const child of nodesOf(node)) node.parentNode?.insertBefore(child, node);
            node.remove();
        } else {
            node.hidden = false;
            node.classList?.remove?.(MARKER_HIDDEN) ?? (node.className = String(node.className ?? '').split(/\s+/).filter(name => name && name !== MARKER_HIDDEN).join(' '));
        }
    }
}

/**
 * Takes a panel out of the message. An inline panel that stood in the place of a marker line leaves that line behind, so the place
 * is kept for the next time (switching the RPG off and on again draws the panel where the narrator wrote it).
 */
export function releasePanel(doc, panel) {
    const marker = panel?.[CONSUMED];
    const parent = panel?.parentNode;
    if (marker && parent) {
        const line = doc.createElement('p');
        line.textContent = marker;
        parent.insertBefore(line, panel);
    }
    panel?.remove?.();
}

const blank = node => (node.nodeType === 3 ? !String(node.data ?? node.textContent ?? '').trim() : node.tagName === 'BR');
const textOf = node => String(node.data ?? node.textContent ?? '');

/**
 * Takes the first marker line out of its paragraph and puts `panel` there: a paragraph that held other lines is split
 * in two around the panel, one that held only the marker is replaced. Returns true when a marker was found. Any other
 * marker line is taken out of the text.
 */
export function placeAtMarker(doc, root, panel) {
    showMarkers(doc, root);
    const found = markerNodes(root);
    if (!found.length) return false;
    const [first, ...extra] = found;
    for (const node of extra) node.data = textOf(node).split(/\r?\n/).filter(line => !MARKER_LINE.test(line)).join('\n');
    const lines = textOf(first).split(/\r?\n/), at = lines.findIndex(line => MARKER_LINE.test(line));
    // The marker line is kept on the panel, so taking the panel away can put it back (releasePanel).
    panel[CONSUMED] = lines[at].trim();
    const parent = first.parentNode, siblings = nodesOf(parent), spot = siblings.indexOf(first);
    const before = siblings.slice(0, spot), after = siblings.slice(spot + 1);
    const tail = lines.slice(at + 1).join('\n'), tailNode = tail.trim() ? doc.createTextNode(tail) : null;
    first.data = lines.slice(0, at).join('\n');
    if (blank(first)) first.remove(); else before.push(first);
    // A line break right next to the marker belongs to it.
    while (before.length && blank(before.at(-1))) { const node = before.pop(); if (node !== first) node.remove(); }
    while (after.length && blank(after[0])) after.shift().remove();
    if (tailNode) after.unshift(tailNode);
    const hasBefore = before.some(node => !blank(node)), hasAfter = after.some(node => !blank(node));
    if (parent.tagName === 'P' && parent.parentNode) {
        const container = parent.parentNode, next = nodesOf(container)[nodesOf(container).indexOf(parent) + 1] ?? null;
        container.insertBefore(panel, next);
        if (hasAfter) {
            const rest = doc.createElement('p');
            for (const node of after) rest.appendChild(node);
            container.insertBefore(rest, nodesOf(container)[nodesOf(container).indexOf(panel) + 1] ?? null);
        }
        if (!hasBefore) parent.remove();
        return true;
    }
    const reference = after.find(node => node.parentNode === parent) ?? null;
    if (tailNode && tailNode.parentNode !== parent) parent.insertBefore(tailNode, reference);
    parent.insertBefore(panel, tailNode && tailNode.parentNode === parent ? tailNode : reference);
    return true;
}
