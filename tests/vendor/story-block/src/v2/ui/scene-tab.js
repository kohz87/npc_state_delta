// Scene tab: a minimal plain renderer (no styling) of the place and who is present, from the
// head state. Read-only. Interim, like the Inventory tab, until the layout renderer lands.

function make(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
}

/** (el, view, api): `api` is unused (nothing here changes state). */
export function renderSceneTab(el, view) {
    const doc = el.ownerDocument ?? globalThis.document;
    const scene = view?.state?.domains?.scene;
    const place = scene?.place ?? {};
    const present = Array.isArray(scene?.present) ? scene.present : [];
    const root = make(doc, 'div', 'ss-scene');
    root.append(make(doc, 'div', 'ss-scene-place', place.name || 'No place yet.'));
    const about = [place.kind, place.region].filter(Boolean).join(' · ');
    if (about) root.append(make(doc, 'div', 'ss-scene-about', about));
    root.append(make(doc, 'div', 'ss-scene-title', 'Present'));
    if (!present.length) root.append(make(doc, 'div', 'ss-scene-empty', 'No one else here.'));
    else {
        const list = make(doc, 'ul', 'ss-scene-present');
        for (const name of present) list.append(make(doc, 'li', 'ss-scene-person', name));
        root.append(list);
    }
    el.replaceChildren(root);
    return root;
}
