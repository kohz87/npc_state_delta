/* NPC State Delta dossier surface: relationship meter steps, changes and history markup. */
import { escapeHtml } from './src/util/html.js';
import { changeStamp, plain, relationshipValue, RELATIONSHIP_AXES, stampHtml, wholeNumber } from './dossier-ui-model.js';
import { gateWords } from './dossier-ui-view-model.js';

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

export function lastRelationshipChangeHtml(change) {
    if (!change || change.impact === 'none' || (!change.reason && change.impact !== 'manual' && !change.hosted)) {
        return `<div class="delta-rel-last"><h4>Last relationship change</h4><p class="delta-muted">No relationship change recorded yet.</p></div>`;
    }
    const deltas = RELATIONSHIP_AXES
        .filter(([axis]) => change.delta[axis] !== 0)
        .map(([axis, label]) => {
            const value = change.delta[axis];
            const good = axis === 'tension' ? value < 0 : value > 0;   // tension rising reads as bad, like the ▲/▼ beside the meter
            return `<span class="delta-rel-delta delta-rel-delta-${good ? 'up' : 'down'} delta-rel-${escapeHtml(axis)}">${escapeHtml(label)} ${value > 0 ? '+' : ''}${value}</span>`;
        })
        .join('');
    const event = change.hosted ? change.event : null;
    const tier = change.hosted ? (event ? event.tier : '') : change.impact;
    const stamp = changeStamp(change);
    const asked = event?.held ? RELATIONSHIP_AXES.filter(([axis]) => event.ask?.[axis]).map(([axis, label]) => `${label} ${event.ask[axis] > 0 ? '+' : ''}${event.ask[axis]}`).join(', ') : '';
    return `<div class="delta-rel-last">
        <div class="delta-rel-last-head"><h4>Last relationship change</h4>${tier ? `<span class="delta-rel-impact delta-rel-impact-${escapeHtml(tier)}">${escapeHtml(impactLabel(tier))}</span>` : ''}${stampHtml(event?.date && stamp.label ? { ...stamp, label: `${stamp.label} · ${event.date}` } : stamp)}</div>
        ${event?.held ? `<p class="delta-rel-held">Held: ${escapeHtml(event.note || 'the day\'s allowance is used')}. Nothing moved.</p>${asked ? `<p class="delta-muted delta-rel-asked">Asked: ${escapeHtml(asked)}</p>` : ''}`
        : `<div class="delta-rel-deltas">${deltas || '<span class="delta-rel-delta delta-rel-delta-progress">Progress only · no point change</span>'}</div>`}
        ${event?.gate ? `<p class="delta-rel-gate">${escapeHtml(event.gate)}</p>` : ''}
        ${change.reason ? `<p>${escapeHtml(change.reason)}</p>` : ''}
    </div>`;
}

function relationshipHistoryHtml(history, latest) {
    const rows = (Array.isArray(history) ? history : [])
        .filter((event, index) => !(index === 0 && latest?.reason && event.reason === latest.reason))
        .filter(event => !(latest?.hosted && wholeNumber(event.message) !== null && wholeNumber(event.message) === wholeNumber(latest.message)))   // the net change shown above is this reply's event
        .slice(0, 3);
    if (!rows.length) return '';
    return `<div class="delta-rel-history"><h4>Earlier changes</h4><ul class="delta-list">${rows.map(event => `<li><span class="delta-rel-impact delta-rel-impact-${escapeHtml(event.impact)}">${escapeHtml(impactLabel(event.impact))}</span>${changeStamp(event).label ? ` ${stampHtml(changeStamp(event), 'small', 'delta-muted')}` : ''} ${escapeHtml(event.reason)}</li>`).join('')}</ul></div>`;
}

// One row of the With {{user}} "Recent changes" list: the date and reply number on the left, the change in its good / bad
// colour (tension rising is bad) over a muted "via ..." line on the right. `change` is the latest change (the projection's
// lastRelationshipChange, with the signed numbers and, when hosted, the event's gate and date); `event` is an earlier one from the stored
// history, which keeps only its tier, the axes it had evidence for and its reason (no signed numbers, no calendar date).
// Said plainly when nothing recorded why a change happened (a scan's row with no reason, a story line without one).
export const NO_REASON = 'no reason given';

export function recentChangeRowHtml({ change = null, event = null, entry = null } = {}) {
    if (entry) return meterEntryRowHtml(entry);
    const source = change || event;
    const stamp = changeStamp(source || {});
    const hosted = change?.hosted ? change.event : null;
    const when = [hosted?.date, stamp.mark].filter(Boolean);
    const whenHtml = when.length ? `<span class="delta-chg-when">${when.map((part, index) => (index ? `<small>${escapeHtml(part)}</small>` : escapeHtml(part))).join('<br>')}</span>` : '<span class="delta-chg-when"></span>';
    let head = '';
    let lines = [];
    if (change) {
        head = hosted?.held ? '<span class="delta-chg-d" data-good="muted">Held</span>' : RELATIONSHIP_AXES
            .filter(([axis]) => change.delta?.[axis])
            .map(([axis, label]) => {
                const value = change.delta[axis];
                const good = axis === 'tension' ? value < 0 : value > 0;
                return `<span class="delta-chg-d" data-good="${good ? 'yes' : 'no'}">${escapeHtml(label)} ${value > 0 ? '+' : '−'}${Math.abs(value)}</span>`;
            }).join(' · ') || '<span class="delta-chg-d" data-good="muted">Progress only</span>';
        // as the mockup: how it came about and why on ONE muted line ("via help — Astra helped her cover up")
        lines = [[hosted?.held ? `Held: ${hosted.note || 'the day\'s allowance is used'}` : gateWords(hosted?.gate, { row: true }), change.reason || NO_REASON].filter(Boolean).join(' — ')];
    } else {
        head = `<span class="delta-chg-d" data-good="muted">${escapeHtml((event.axes || []).length ? event.axes.join(' · ') : impactLabel(event.impact))}</span>`;
        lines = [event.reason || NO_REASON];
    }
    return changeRowHtml(whenHtml, head, lines);
}

// One earlier reply's meter change from the meters' own log (the last three, newest first): the date and reply on the left, the signed amounts
// (or, for a text from before amounts were kept, the axes it asked) over the reason. A held one says so.
function meterEntryRowHtml(entry) {
    const stamp = [entry.date, Number.isInteger(entry.n) ? `#${entry.n}` : ''].filter(Boolean);
    const whenHtml = `<span class="delta-chg-when">${stamp.map((part, index) => (index ? `<small>${escapeHtml(part)}</small>` : escapeHtml(part))).join('<br>')}</span>`;
    const moved = RELATIONSHIP_AXES.filter(([axis]) => entry.mv?.[axis]).map(([axis, label]) => {
        const value = entry.mv[axis];
        const good = axis === 'tension' ? value < 0 : value > 0;
        return `<span class="delta-chg-d" data-good="${good ? 'yes' : 'no'}">${escapeHtml(label)} ${value > 0 ? '+' : '−'}${Math.abs(value)}</span>`;
    }).join(' · ');
    const asked = RELATIONSHIP_AXES.filter(([axis]) => entry.ask?.[axis]).map(([, label]) => label).join(' · ');
    const head = entry.held ? '<span class="delta-chg-d" data-good="muted">Held</span>' : moved || `<span class="delta-chg-d" data-good="muted">${escapeHtml(asked || 'Progress only')}</span>`;
    return changeRowHtml(whenHtml, head, [[entry.held ? `Held: ${entry.note || 'the day\'s allowance is used'}` : '', entry.why || NO_REASON].filter(Boolean).join(' — ')]);
}

// The row both Recent changes lists share (With {{user}} and Right now's mood): the date and reply on the left, the change over its muted reason on the right.
export function changeRowHtml(whenHtml, head, lines) {
    const via = lines.filter(Boolean).map(line => `<div class="delta-chg-via">${escapeHtml(line)}</div>`).join('');
    return `<li class="delta-chg">${whenHtml}<div><b>${head}</b>${via}</div></li>`;
}

export { relationshipAxis, relationshipHistoryHtml };
