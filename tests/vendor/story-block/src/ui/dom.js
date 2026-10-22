// Small DOM helpers shared by the card and the displays.
//
// Everything model- or user-written goes through textContent or text nodes. innerHTML
// is never used here: block names, labels and states are all reader/model text.

// `doc`: the document to make it in (a page that draws into another one passes its own).
export function el(tag, className = '', text = '', doc = globalThis.document) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== '' && text !== null && text !== undefined) node.textContent = String(text);
    return node;
}

export function button(className, { text = '', title = '', icon = '' } = {}) {
    const node = el('button', className, text);
    node.type = 'button';
    if (title) {
        node.title = title;
        node.setAttribute('aria-label', title);
    }
    if (icon) {
        const glyph = el('i', `fa-solid ${icon}`);
        glyph.setAttribute('aria-hidden', 'true');
        node.prepend(glyph);
    }
    return node;
}

// Tabs as a card or the sidebar takes them: each with an id (trimmed) and a render
// function, the first of each id kept.
export function normalizeTabs(tabs) {
    const seen = new Set();
    const out = [];
    for (const tab of Array.isArray(tabs) ? tabs : []) {
        const id = String(tab?.id ?? '').trim();
        if (!id || seen.has(id) || typeof tab?.render !== 'function') continue;
        seen.add(id);
        out.push({ ...tab, id });
    }
    return out;
}

// Clicks inside the card must not reach SillyTavern's message handlers (or a host
// card's delegated listeners), which would treat them as clicks on the message.
export function stop(handler) {
    return event => {
        event.stopPropagation();
        handler(event);
    };
}

export function plural(count, word = 'item') {
    return `${count} ${count === 1 ? word : `${word}s`}`;
}

/**
 * Countable noun for a column label: "Item" -> "item"/"items", "NPC" -> "NPC"/"NPCs".
 * Only a plain capitalised word is lower-cased, so acronyms keep their spelling.
 */
export function noun(label, count = 2) {
    let word = String(label ?? '').trim() || 'item';
    if (/^[A-Z][a-z]+$/.test(word)) word = word.toLowerCase();
    return count === 1 || /s$/i.test(word) ? word : `${word}s`;
}

export function unitWord(label, count) {
    return `${count} ${noun(label, count)}`;
}

export function blockName(def) {
    return String(def?.name ?? '').trim() || 'Block';
}

/**
 * Clear `pane` and lay down what every display shares: a header (name, summary,
 * "kept by" for a block another extension keeps, Edit), then the owner, error and
 * cut-off notices. Returns the header's actions element so a display can add its own buttons.
 */
export function renderFrame(pane, { def, error, truncated, onEdit, display, summary = '' } = {}) {
    pane.replaceChildren();
    pane.classList.add('story-block-display', `story-block-display-${display}`);
    const name = blockName(def);

    const head = el('div', 'story-block-head');
    const titles = el('div', 'story-block-head-titles');
    titles.appendChild(el('span', 'story-block-title', name));
    if (summary) titles.appendChild(el('span', 'story-block-summary', summary));
    // A block another extension keeps has no Edit button; this says why, and whose it is.
    if (def?.kept && def.owner) {
        const kept = el('span', 'story-block-kept', `kept by ${def.owner}`);
        kept.title = `Kept by ${def.owner}: only ${def.owner} changes it`;
        titles.appendChild(kept);
    }
    head.appendChild(titles);
    const actions = el('div', 'story-block-actions');
    if (typeof onEdit === 'function') {
        const edit = button('menu_button story-block-icon-button story-block-edit', { title: `Edit ${name}`, icon: 'fa-pen-to-square' });
        edit.addEventListener('click', stop(() => onEdit()));
        actions.appendChild(edit);
    }
    head.appendChild(actions);
    pane.appendChild(head);

    renderNotices(pane, { def, error, truncated });
    return actions;
}

export function renderNotices(pane, { def, error, truncated } = {}) {
    const name = blockName(def);
    // Another extension is the source of truth for what this block tracks (Story Suite): the
    // block is still shown as it is, and this says who owns it, so the reader can decide.
    if (def?.deferNote) pane.appendChild(notice('is-deferred', String(def.deferNote)));
    if (error) {
        const text = String(error).trim().replace(/\.$/, '');
        pane.appendChild(notice('is-error', `This reply's ${name} couldn't be read: ${text}. Showing the last valid state.`));
    }
    if (truncated) {
        // Stateful blocks never take a cut-off copy; a turn block may show what arrived.
        const tail = def?.kind !== 'stateful' ? ' What arrived may be incomplete.' : ' Showing the last valid state.';
        pane.appendChild(notice('is-truncated', `This reply's ${name} was cut off before it finished.${error ? '' : tail}`));
    }
}

const NOTICE_GLYPHS = { 'is-error': 'fa-triangle-exclamation', 'is-truncated': 'fa-scissors', 'is-deferred': 'fa-circle-info' };

function notice(kind, text) {
    const node = el('div', `story-block-notice ${kind}`);
    node.setAttribute('role', 'note');
    const glyph = el('i', `fa-solid ${NOTICE_GLYPHS[kind] ?? 'fa-scissors'}`);
    glyph.setAttribute('aria-hidden', 'true');
    node.append(glyph, el('span', 'story-block-notice-text', text));
    return node;
}

export function emptyText(def, state) {
    const name = blockName(def);
    // A per-reply block with no copy in the latest reply, or a kept block nothing filled yet.
    return state === null || state === undefined ? `No ${name} in the latest reply.` : `${name} is empty. It fills in as the story goes.`;
}

export function renderEmpty(parent, text) {
    return parent.appendChild(el('div', 'story-block-empty', text));
}

const CHANGE_GLYPH = { added: '+', removed: '−', changed: '~', moved: '↪' };

function describeChange(change) {
    const label = String(change?.label ?? '').trim();
    const from = String(change?.from ?? '').trim();
    const to = String(change?.to ?? '').trim();
    if (change?.type === 'added') return to ? `${label}: ${to}` : `${label} (new)`;
    if (change?.type === 'removed') return `${label} (gone)`;
    return `${label}: ${from || '—'} → ${to || '—'}`;
}

/**
 * One folded "Changed this turn · N" section, the same in every display, so the board
 * itself stays calm: changed things carry only a small dot (changeDot), and the wording
 * of each change lives here. Collapsed by default; the reader opens it when they care.
 */
export function renderChanges(parent, changes, { describe = describeChange, fromEarlierReply = false } = {}) {
    const list = (Array.isArray(changes) ? changes : []).filter(Boolean);
    if (!list.length) return null;
    const details = el('details', 'story-block-changes');
    const summary = el('summary', 'story-block-changes-summary');
    summary.append(
        el('span', 'story-block-changes-title', fromEarlierReply ? 'Changed in an earlier reply' : 'Changed this turn'),
        el('span', 'story-block-changes-count', String(list.length)),
    );
    if (fromEarlierReply) summary.title = 'The newest reply did not update this block; these are the last changes it made.';
    const items = el('ul', 'story-block-changes-list');
    for (const change of list) {
        const item = el('li', `story-block-changes-item is-${change.type ?? 'changed'}`);
        const glyph = el('span', 'story-block-changes-glyph', CHANGE_GLYPH[change.type] ?? '~');
        glyph.setAttribute('aria-hidden', 'true');
        item.append(glyph, el('span', 'story-block-changes-text', describe(change)));
        items.appendChild(item);
    }
    details.append(summary, items);
    parent.appendChild(details);
    return details;
}

/** The small mark a changed field, row or person carries; the detail is in renderChanges. */
export function changeDot(change) {
    const dot = el('span', `story-block-change-dot is-${change?.type ?? 'changed'}`);
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', change?.type === 'added' ? 'new this turn' : 'changed this turn');
    dot.title = change?.type === 'added' ? 'New this turn' : 'Changed this turn';
    return dot;
}
