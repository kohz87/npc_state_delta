// Fields display: meters as bars, numbers, text, lists as chips.
//
// Entries come in definition order; labels the model wrote that the definition does
// not know (`unknown`) are kept but shown last and muted, so nothing the model said is
// hidden and nothing unexpected looks official.

import { blockName, changeDot, el, emptyText, renderChanges, renderEmpty, renderFrame } from '../dom.js';
import { render as renderPlain } from './plain.js';
import { foldKey as labelKey } from '../../text.js';

const DEFAULT_METER_MAX = 100;


function finite(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function formatNumber(value) {
    // Avoid float noise such as 0.30000000000000004 from arithmetic upstream.
    return String(Math.round(value * 1000) / 1000);
}

/** Meter numbers for display and ARIA: `now` is clamped into [0, max]. */
export function meterValues(entry, def) {
    const field = (def?.fields ?? []).find(candidate => labelKey(candidate.label) === labelKey(entry?.label));
    const declared = finite(entry?.max) ?? finite(field?.max);
    const max = declared !== null && declared > 0 ? declared : DEFAULT_METER_MAX;
    const value = finite(entry?.value);
    if (value === null) return { value: null, max, now: null, percent: 0 };
    const now = Math.min(max, Math.max(0, value));
    return { value, max, now, percent: Math.round((now / max) * 1000) / 10 };
}

// Fallback when the runtime passed no changes: compare what was written, by label.
function simpleDiff(previous, next) {
    if (!Array.isArray(previous?.entries) || !Array.isArray(next?.entries)) return [];
    const before = new Map(previous.entries.map(entry => [labelKey(entry.label), entry]));
    const changes = [];
    for (const entry of next.entries) {
        const old = before.get(labelKey(entry.label));
        before.delete(labelKey(entry.label));
        if (!old) changes.push({ type: 'added', label: entry.label, to: entry.raw });
        else if (String(old.raw ?? '').trim() !== String(entry.raw ?? '').trim()) changes.push({ type: 'changed', label: entry.label, from: old.raw, to: entry.raw });
    }
    for (const old of before.values()) changes.push({ type: 'removed', label: old.label, from: old.raw });
    return changes;
}

function renderMeter(entry, def) {
    const { value, max, now, percent } = meterValues(entry, def);
    const wrap = el('div', 'story-block-field-value story-block-meter-wrap');
    if (value === null) {
        wrap.classList.add('is-unreadable');
        wrap.textContent = String(entry.raw ?? '').trim() || '—';
        return wrap;
    }
    const meter = el('div', 'story-block-meter');
    meter.setAttribute('role', 'meter');
    meter.setAttribute('aria-valuemin', '0');
    meter.setAttribute('aria-valuemax', formatNumber(max));
    meter.setAttribute('aria-valuenow', formatNumber(now));
    meter.setAttribute('aria-valuetext', `${formatNumber(value)} of ${formatNumber(max)}`);
    meter.setAttribute('aria-label', String(entry.label ?? ''));
    if (value !== now) meter.classList.add(value > max ? 'is-over' : 'is-under');
    const fill = el('div', 'story-block-meter-fill');
    fill.style.width = `${percent}%`;
    meter.appendChild(fill);
    wrap.append(meter, el('span', 'story-block-meter-text', `${formatNumber(value)}/${formatNumber(max)}`));
    return wrap;
}

function renderList(entry) {
    const items = (Array.isArray(entry.items) ? entry.items : String(entry.raw ?? '').split(','))
        .map(item => String(item ?? '').trim())
        .filter(Boolean);
    if (!items.length) return el('div', 'story-block-field-value is-blank', '—');
    const list = el('ul', 'story-block-field-value story-block-chips');
    items.forEach(item => list.appendChild(el('li', 'story-block-chip', item)));
    return list;
}

function renderValue(entry, def) {
    const raw = String(entry.raw ?? '').trim();
    switch (entry.type) {
        case 'meter': return renderMeter(entry, def);
        case 'list': return renderList(entry);
        case 'number': {
            const value = finite(entry.value);
            // Show what was written ("85 gold"); fall back to the parsed number.
            const node = el('div', 'story-block-field-value story-block-number', raw || (value === null ? '—' : formatNumber(value)));
            if (value === null) node.classList.add('is-unreadable');
            return node;
        }
        default: {
            const text = raw || String(entry.value ?? '').trim();
            return el('div', `story-block-field-value story-block-text${text ? '' : ' is-blank'}`, text || '—');
        }
    }
}

export function render(pane, {
    def,
    state,
    previousState = null,
    changes = null,
    changesFromEarlierReply = false,
    error = null,
    truncated = false,
    onEdit = null,
} = {}) {
    if (state && !Array.isArray(state.entries)) {
        renderPlain(pane, { def, state, error, truncated, onEdit });
        return;
    }
    const entries = Array.isArray(state?.entries) ? state.entries : [];
    renderFrame(pane, { def, error, truncated, onEdit, display: 'fields' });
    if (!entries.length) {
        renderEmpty(pane, emptyText(def, state));
        return;
    }

    const changeList = Array.isArray(changes) ? changes : simpleDiff(previousState, state);
    const changeByLabel = new Map(changeList.filter(change => change.type !== 'removed').map(change => [labelKey(change.label), change]));

    const body = el('div', 'story-block-display-body');
    // Every change, worded once, folded away; the fields themselves only carry dots.
    renderChanges(body, changeList, { fromEarlierReply: changesFromEarlierReply });
    const list = el('div', 'story-block-fields');
    list.setAttribute('role', 'list');
    list.setAttribute('aria-label', blockName(def));
    // Known entries first, unknown last; stable within each group.
    const ordered = [...entries.filter(entry => !entry.unknown), ...entries.filter(entry => entry.unknown)];
    for (const entry of ordered) {
        const type = ['meter', 'number', 'text', 'list'].includes(entry.type) ? entry.type : 'text';
        const change = changeByLabel.get(labelKey(entry.label));
        const field = el('div', `story-block-field is-${type}${entry.unknown ? ' is-unknown' : ''}${change ? ' is-changed' : ''}`);
        field.setAttribute('role', 'listitem');
        const label = el('div', 'story-block-field-label', entry.label);
        if (entry.unknown) label.title = 'Not in this block\'s definition';
        if (change) label.appendChild(changeDot(change));
        field.append(label, renderValue({ ...entry, type }, def));
        list.appendChild(field);
    }
    body.appendChild(list);
    pane.appendChild(body);
}
