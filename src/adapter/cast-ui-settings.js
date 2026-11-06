// Cast settings mounting: the drawer copy of Delta's panel and the settings section that hosts it, including the meter presets slot.

const PLACEHOLDER_FLAG = 'npcStateDeltaPlaceholder';
const HIDDEN_FLAG = 'npcStateDeltaHosted';

export function createCastSettingsUi(session, deps) {
    const { doc, MODULE_ID, panel, timers, watchMs } = deps;

    let watchTimer = null;
    let sectionLead = null;      // the meter presets block above Delta's panel in the settings section
    const savedDisplay = new WeakMap();

    // ---- the drawer copy ----

    function hidePanel(node) {
        if (!node?.style || node.dataset?.[HIDDEN_FLAG] === '1') return;
        savedDisplay.set(node, node.style.display ?? '');
        node.style.display = 'none';
        if (node.dataset) node.dataset[HIDDEN_FLAG] = '1';
    }

    function showPanel(node) {
        if (!node?.style || node.dataset?.[HIDDEN_FLAG] !== '1') return;
        node.style.display = savedDisplay.get(node) ?? '';
        savedDisplay.delete(node);
        delete node.dataset[HIDDEN_FLAG];
    }

    // While hosted, the panel is hidden wherever it is except inside the overlay.
    function syncDrawer() {
        const node = panel();
        if (!node || (session.mounted && session.mounted.node === node)) return;
        if (session.hosted) hidePanel(node);
        else showPanel(node);
    }

    // ---- the settings section ----

    function stopWatch() {
        if (watchTimer !== null) timers.clearInterval?.(watchTimer);
        watchTimer = null;
    }

    // Back before its placeholder (v1 overlay rule). A panel Delta removed meanwhile is left alone;
    // one whose place is gone stays where it is.
    function unmountSection() {
        stopWatch();
        if (!session.mounted) return;
        const { el, node, placeholder, drawer, parent } = session.mounted;
        session.mounted = null;
        drawer?.classList?.remove?.('story-suite-drawer');
        if (node.dataset) delete node.dataset.storySuiteMoved;
        clearLead(node);
        const ours = el.contains?.(node);
        if (ours && placeholder.parentNode) placeholder.parentNode.insertBefore(node, placeholder);
        else if (ours && parent?.isConnected) parent.appendChild(node);
        placeholder.remove?.();
        syncDrawer();
    }

    function watchSection() {
        stopWatch();
        // The overlay may drop the section's element without telling anyone: the panel then goes
        // home at once, so Delta's own code (which finds it by id) keeps finding it.
        watchTimer = timers.setInterval?.(() => {
            if (!session.mounted) return stopWatch();
            if (!session.mounted.el.isConnected || session.mounted.node.parentNode !== session.mounted.el) unmountSection();
        }, watchMs) ?? null;
        watchTimer?.unref?.();
    }

    // The meter presets block sits in Delta's own "Meter presets" fold (index.js buildSettingsHtml), which stays hidden
    // until the block is in it. A panel without that slot gets the block above it, as before.
    const PRESETS_SLOT = '[data-delta-settings-slot="meter-presets"]';
    const presetsSlot = node => {
        try { return node?.querySelector?.(PRESETS_SLOT) ?? null; } catch { return null; }
    };
    function placeLead(slot, lead) {
        slot.replaceChildren(lead);
        const group = slot.closest?.('[data-delta-settings-group]');
        if (group) group.hidden = false;
    }
    function clearLead(node) {
        const slot = presetsSlot(node);
        if (!slot) return;
        slot.replaceChildren();
        const group = slot.closest?.('[data-delta-settings-group]');
        if (group) group.hidden = true;
    }

    // `lead`: the meter presets block, shown in Delta's "Meter presets" fold (above the panel when it has none).
    function mountSection(el, lead = null) {
        if (!el) return () => {};
        if (session.mounted && session.mounted.el !== el) unmountSection();
        const node = panel();
        if (lead) sectionLead = lead;
        if (!node) {
            session.pendingSection = el;
            const loading = "NPC State Delta's settings are still loading.";
            if (sectionLead && typeof el.replaceChildren === 'function' && typeof doc?.createElement === 'function') {
                const line = doc.createElement('p');
                line.textContent = loading;
                el.replaceChildren(sectionLead, line);
            } else el.textContent = loading;
            return () => { if (session.pendingSection === el) session.pendingSection = null; };
        }
        session.pendingSection = null;
        if (!session.mounted) {
            const placeholder = doc.createElement('div');
            placeholder.className = 'story-suite-placeholder';
            placeholder.hidden = true;
            placeholder.style.display = 'none';
            placeholder.dataset[PLACEHOLDER_FLAG] = '1';
            node.before(placeholder);
            // Its SillyTavern drawer shows open in the overlay, as v1's overlay shows it.
            const drawer = node.querySelector?.('.inline-drawer') || null;
            drawer?.classList?.add?.('story-suite-drawer');
            if (node.dataset) node.dataset.storySuiteMoved = MODULE_ID;
            session.mounted = { el, node, placeholder, drawer, parent: placeholder.parentNode };
        }
        showPanel(node);
        const top = sectionLead && sectionLead.ownerDocument === node.ownerDocument ? sectionLead : null;
        const slot = top ? presetsSlot(node) : null;
        if (slot) placeLead(slot, top);
        const above = top && !slot ? top : null;
        if (typeof el.replaceChildren === 'function') el.replaceChildren(...(above ? [above] : []), node);
        else {
            if (above) el.appendChild(above);
            el.appendChild(node);
        }
        watchSection();
        return () => { if (session.mounted?.el === el) unmountSection(); };
    }

    return { syncDrawer, unmountSection, mountSection };
}
