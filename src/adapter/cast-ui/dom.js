// DOM primitives for the Dossiers part: the drawer flags, the shared pane class, text-only element helpers and the meter bar.
// These helpers never parse text as markup; callers pass text through textContent.

export const PLACEHOLDER_FLAG = 'npcStateDeltaPlaceholder';
export const HIDDEN_FLAG = 'npcStateDeltaHosted';
export const PANE_CLASS = 'npc-state-delta-story-pane';

const METER_TONES = new Set(['neutral', 'accent', 'good', 'warn', 'bad', 'info']);

// DOM helpers for the Cast markup (text is set with textContent; nothing is parsed as markup).
export const elementOf = (doc, tag, className = '', text = null) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== null && text !== undefined) node.textContent = String(text);
    return node;
};
// One meter as ss.meter draws it (WIDGETS.md: role="meter", aria values, `ss-w-meter-*` parts, `--ss-w-ratio` on the track).
// `def`: { id, label, min, max, tone }. `extra` (optional): { text, ceiling, ticks: [{ at, label }], delta }.
export function meterBarNode(doc, def, value, stage = '', extra = {}) {
    const min = Number.isFinite(def?.min) ? def.min : -100;
    const max = Number.isFinite(def?.max) && def.max > min ? def.max : min + 100;
    const now = Math.min(max, Math.max(min, Number.isFinite(Number(value)) ? Math.round(Number(value)) : min));
    const at = point => Math.round(((Math.min(max, Math.max(min, point)) - min) / (max - min)) * 10000) / 10000;
    const ratio = at(now);
    const text = typeof extra?.text === 'string' && extra.text ? extra.text : stage ? `${now} · ${stage}` : String(now);
    const tone = METER_TONES.has(def?.tone) ? def.tone : 'neutral';
    const label = String(def?.label ?? def?.id ?? '');
    const delta = Number.isInteger(extra?.delta) && extra.delta !== 0 ? extra.delta : 0;
    const node = elementOf(doc, 'div', `ss-w ss-w-meter ss-w-tone-${tone}${ratio >= 1 ? ' ss-w-full' : ''}${ratio <= 0 ? ' ss-w-empty' : ''}`);
    node.setAttribute('role', 'meter');
    node.setAttribute('aria-label', label);
    node.setAttribute('aria-valuemin', String(min));
    node.setAttribute('aria-valuemax', String(max));
    node.setAttribute('aria-valuenow', String(now));
    node.setAttribute('aria-valuetext', text);
    node.dataset.meter = String(def?.id ?? '');
    const head = elementOf(doc, 'div', 'ss-w-meter-head');
    head.append(elementOf(doc, 'span', 'ss-w-meter-label', label));
    const value_ = elementOf(doc, 'span', 'ss-w-meter-value', text);
    value_.setAttribute('aria-hidden', 'true');
    if (delta) value_.append(elementOf(doc, 'span', `npc-state-delta-v2-delta ${delta > 0 ? 'npc-state-delta-v2-delta-up' : 'npc-state-delta-v2-delta-down'}`, `${delta > 0 ? '▲' : '▼'}${Math.abs(delta)}`));
    head.append(value_);
    const track = elementOf(doc, 'div', 'ss-w-meter-track');
    track.setAttribute('style', `--ss-w-ratio: ${ratio}`);
    track.append(elementOf(doc, 'div', 'ss-w-meter-fill'));
    for (const tick of (Array.isArray(extra?.ticks) ? extra.ticks : []).slice(0, 8)) {
        if (!Number.isFinite(tick?.at)) continue;
        const mark = elementOf(doc, 'span', 'npc-state-delta-v2-tick');
        mark.setAttribute('style', `--npc-state-delta-at: ${at(tick.at)}`);
        mark.setAttribute('title', `${tick.label ?? ''} ${tick.at}`.trim());
        track.append(mark);
    }
    if (Number.isFinite(extra?.ceiling) && extra.ceiling < max) {
        const mark = elementOf(doc, 'span', 'npc-state-delta-v2-ceiling');
        mark.setAttribute('style', `--npc-state-delta-at: ${at(extra.ceiling)}`);
        mark.setAttribute('title', `Ceiling ${extra.ceiling}`);
        track.append(mark);
    }
    node.append(head, track);
    return node;
}
