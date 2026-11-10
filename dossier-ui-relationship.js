/* NPC State Delta dossier surface: relationship meter steps, changes and history markup. */
import { escapeHtml } from './src/util/html.js';
import { changeStamp, plain, relationshipValue, RELATIONSHIP_AXES, stampHtml, wholeNumber } from './dossier-ui-model.js';

// (1.2.15) The change the latest reply made to one axis, beside its meter: ▲3 / ▼2. Only for a change
// recorded at the latest reply (an older one is history, shown below the meters); tension rising reads
// as bad, the other axes rising as good.
export function relationshipStepHtml(axis, label, change, latestReply) {
    const reply = wholeNumber(latestReply);
    if (!change || reply === null || wholeNumber(change.message) !== reply) return '';
    const step = Math.round(Number(change.delta?.[axis]) || 0);
    if (!step) return '';
    const up = step > 0;
    const good = axis === 'tension' ? !up : up;
    const title = `${label} ${up ? 'up' : 'down'} ${Math.abs(step)} since the last reply (reply #${reply})`;
    return `<span class="delta-rel-step delta-rel-step-${good ? 'good' : 'bad'}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">${up ? '▲' : '▼'}${Math.abs(step)}</span>`;
}

function relationshipAxis(label, value, axis, change = null, latestReply = null) {
    const score = relationshipValue(value);
    const position = Math.max(0, Math.min(100, (score + 100) / 2));
    return `<div class="delta-rel-axis delta-rel-${escapeHtml(axis)}">
        <div class="delta-rel-label"><span>${escapeHtml(label)}</span><b>${score > 0 ? '+' : ''}${score}${relationshipStepHtml(axis, label, change, latestReply)}</b></div>
        <div class="delta-rel-track" aria-label="${escapeHtml(label)} ${score}"><span class="delta-rel-zero"></span><i style="left:${position}%"></i></div>
    </div>`;
}

function impactLabel(impact) {
    const value = plain(impact, 'none');
    if (value === 'manual') return 'Manual edit';
    return value.charAt(0).toLocaleUpperCase() + value.slice(1);
}

// The meters' own net change names its source only when the slice window proves it; no tier, no reason.
function sourceChipHtml(source) {
    const text = source === 'story' ? 'From the story' : source === 'scanner' ? 'From the scanner' : '';
    return text ? `<span class="delta-rel-impact delta-rel-impact-source">${text}</span>` : '';
}

export function lastRelationshipChangeHtml(change) {
    if (!change || change.impact === 'none' || (!change.reason && change.impact !== 'manual' && !change.hosted)) {
        return `<div class="delta-rel-last"><h4>Last relationship change</h4><p class="delta-muted">No relationship change recorded yet.</p></div>`;
    }
    const deltas = RELATIONSHIP_AXES
        .filter(([axis]) => change.delta[axis] !== 0)
        .map(([axis, label]) => {
            const value = change.delta[axis];
            return `<span class="delta-rel-delta delta-rel-delta-${value > 0 ? 'up' : 'down'} delta-rel-${escapeHtml(axis)}">${escapeHtml(label)} ${value > 0 ? '+' : ''}${value}</span>`;
        })
        .join('');
    return `<div class="delta-rel-last">
        <div class="delta-rel-last-head"><h4>Last relationship change</h4>${change.hosted ? sourceChipHtml(change.source) : `<span class="delta-rel-impact delta-rel-impact-${escapeHtml(change.impact)}">${escapeHtml(impactLabel(change.impact))}</span>`}${stampHtml(changeStamp(change))}</div>
        <div class="delta-rel-deltas">${deltas || '<span class="delta-rel-delta delta-rel-delta-progress">Progress only · no point change</span>'}</div>
        ${change.reason ? `<p>${escapeHtml(change.reason)}</p>` : ''}
    </div>`;
}

function relationshipHistoryHtml(history, latest) {
    const rows = (Array.isArray(history) ? history : [])
        .filter((event, index) => !(index === 0 && latest?.reason && event.reason === latest.reason))
        .slice(0, 3);
    if (!rows.length) return '';
    return `<div class="delta-rel-history"><h4>Earlier changes</h4><ul class="delta-list">${rows.map(event => `<li><span class="delta-rel-impact delta-rel-impact-${escapeHtml(event.impact)}">${escapeHtml(impactLabel(event.impact))}</span>${changeStamp(event).label ? ` ${stampHtml(changeStamp(event), 'small', 'delta-muted')}` : ''} ${escapeHtml(event.reason)}</li>`).join('')}</ul></div>`;
}

export { relationshipAxis, relationshipHistoryHtml };
