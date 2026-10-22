// The Assist section of the Story Suite settings overlay, below the two switches and the profile
// name: whether each helper is on and what its last runs did. Read-only; everything is set as text.

const OUTCOMES = Object.freeze({
    check: 'turned the message into a check',
    none: 'found nothing to check',
    unreadable: 'gave an answer that was not used',
    lines: 'found changes',
    nothing: 'found no changes',
    skipped: 'did not run',
    timeout: 'gave up waiting',
    failed: 'failed',
});

function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/** One line for a run: "Pre-roll: turned the message into a check (? check stealth — … | dc: hard)." */
export function runLine(entry) {
    const who = entry?.helper === 'extractor' ? 'Reading changes' : 'Pre-roll';
    const what = OUTCOMES[entry?.outcome] ?? String(entry?.outcome ?? '');
    const detail = entry?.line ?? (entry?.lines ? `${entry.lines} line${entry.lines === 1 ? '' : 's'}` : entry?.message ?? '');
    return `${who}: ${what}${detail ? ` (${detail})` : ''}.`;
}

/**
 * Render into `target`. `status` is the `assist.status` result or a function returning it. Returns
 * the root element; its Refresh button reads `status` again.
 */
export function renderAssistSection(target, status) {
    const doc = target.ownerDocument ?? globalThis.document;
    const root = el(doc, 'div', 'ss-assist');
    const draw = value => {
        root.textContent = '';
        const onOff = on => (on ? 'on' : 'off');
        root.appendChild(el(doc, 'div', 'ss-assist-state', `Pre-roll checks: ${onOff(value?.classifier?.on)}. Reading forgotten changes: ${onOff(value?.extractor?.on)}.`));
        if (value?.profile) root.appendChild(el(doc, 'div', 'ss-assist-profile', `Calls go through the profile "${value.profile}".`));
        const runs = Array.isArray(value?.runs) ? value.runs.slice(-8).reverse() : [];
        if (!runs.length) root.appendChild(el(doc, 'div', 'ss-assist-empty', 'No runs yet in this session.'));
        const list = el(doc, 'ul', 'ss-assist-runs');
        for (const entry of runs) {
            const item = el(doc, 'li', 'ss-assist-run', runLine(entry));
            item.dataset.outcome = String(entry.outcome ?? '');
            list.appendChild(item);
        }
        root.appendChild(list);
        const refresh = el(doc, 'button', 'menu_button ss-assist-refresh', 'Refresh');
        refresh.type = 'button';
        refresh.addEventListener('click', () => load());
        root.appendChild(refresh);
    };
    const load = () => {
        let value;
        try {
            value = typeof status === 'function' ? status() : status;
        } catch (error) {
            value = { runs: [{ helper: 'classifier', outcome: 'failed', message: `the status could not be read: ${error?.message ?? error}` }] };
        }
        draw(value);
    };
    target.textContent = '';
    target.appendChild(root);
    load();
    return root;
}
