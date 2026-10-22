// The Events debug section of the Story Suite settings overlay: which events have happened, which are
// due, which wait and why, which a pack got wrong, and what the last reply fired. Read-only.
//
// Everything a pack wrote (ids, cues, conditions) is set as text, never as markup.

const LABELS = { fired: 'happened', due: 'due', waiting: 'waiting', error: 'can\'t check', invalid: 'problem' };

function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function plural(count, one, many = `${one}s`) {
    return `${count} ${count === 1 ? one : many}`;
}

/** One line for the head of the section: "3 events: 1 happened, 1 due, 1 waiting." */
export function summaryLine(status) {
    const rows = Array.isArray(status?.events) ? status.events : [];
    if (!rows.length) return 'No events: no enabled pack defines any.';
    const counts = {};
    for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
    const parts = ['fired', 'due', 'waiting', 'error', 'invalid']
        .filter(key => counts[key])
        .map(key => `${counts[key]} ${LABELS[key]}`);
    return `${plural(rows.length, 'event')}: ${parts.join(', ')}.`;
}

function lastRunLine(lastRun) {
    const fired = lastRun?.fired ?? [];
    const failed = lastRun?.failed ?? [];
    if (!fired.length && !failed.length) return 'Before the last reply, no event happened.';
    const parts = [];
    if (fired.length) parts.push(`happened: ${fired.join(', ')}`);
    if (failed.length) parts.push(`refused: ${failed.map(entry => `${entry.id} (${entry.message})`).join('; ')}`);
    return `Before the last reply, ${parts.join('; ')}.`;
}

/**
 * Render into `el`. `status` is the `events.status` result or a function returning it (or a promise of
 * it). Returns the root element; its Refresh button reads `status` again.
 */
export function renderEventsSection(target, status) {
    const doc = target.ownerDocument ?? globalThis.document;
    const root = el(doc, 'div', 'ss-events');
    const draw = value => {
        root.textContent = '';
        root.appendChild(el(doc, 'div', 'ss-events-summary', summaryLine(value)));
        const list = el(doc, 'ul', 'ss-events-list');
        for (const row of value?.events ?? []) {
            const item = el(doc, 'li', 'ss-events-row');
            item.dataset.status = row.status;
            item.appendChild(el(doc, 'b', 'ss-events-id', row.id ?? '(no id)'));
            if (row.pack) item.appendChild(el(doc, 'span', 'ss-events-pack', ` (${row.pack})`));
            item.appendChild(el(doc, 'span', 'ss-events-status', ` · ${LABELS[row.status] ?? row.status}`));
            if (row.after) item.appendChild(el(doc, 'span', 'ss-events-after', ` · after ${row.after}`));
            if (row.once === false) item.appendChild(el(doc, 'span', 'ss-events-repeat', ' · repeats'));
            item.appendChild(el(doc, 'div', 'ss-events-why', row.why ?? ''));
            if (row.when) item.appendChild(el(doc, 'code', 'ss-events-when', row.when));
            list.appendChild(item);
        }
        root.appendChild(list);
        for (const problem of value?.problems ?? []) root.appendChild(el(doc, 'div', 'ss-events-problem', problem));
        root.appendChild(el(doc, 'div', 'ss-events-last', lastRunLine(value?.lastRun)));
        const refresh = el(doc, 'button', 'menu_button ss-events-refresh', 'Refresh');
        refresh.type = 'button';
        refresh.addEventListener('click', () => load());
        root.appendChild(refresh);
    };
    const load = () => {
        let value;
        try {
            value = typeof status === 'function' ? status() : status;
        } catch (error) {
            value = { events: [], problems: [`The events could not be read: ${error?.message ?? String(error)}`] };
        }
        if (value && typeof value.then === 'function') {
            draw({ events: [], problems: ['Reading the events…'] });
            return value.then(draw, error => draw({ events: [], problems: [`The events could not be read: ${error?.message ?? String(error)}`] }));
        }
        draw(value);
        return undefined;
    };
    target.textContent = '';
    target.appendChild(root);
    load();
    return root;
}
