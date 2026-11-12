// Memory facts (design MEMDESIGN2 §2): the event catalog as shipped. A function turns ONE structured, source-bound event into a fact candidate
// { kind, cls, R, ns, source, eventId, phase, payload, rev, date? } for src/memory-fact-store.js. Unknown, ambiguous or unproven input yields no
// candidate (never a guess). `R` is the reply that owns the event; `source` the branch-owned source identity string.
// Shipped source: the standalone scan's applied relationship movement. Milestone, caught-lie, quest, fight, party, met and gift builders are NOT
// shipped: no host event source is wired for them (the design's rule for a missing source is "no fact"), and no `met` is ever built from an
// admission, promotion, manual or cast creation. See MEMBUILD.REPORT.md.
import { hashText } from './memory-fact-key.js';
import { AXES } from './memory-fact-text.js';

const reply = value => (Number.isInteger(value) && value >= 0 ? value : null);
const revision = projection => hashText(JSON.stringify(projection ?? null)).slice(0, 12);
const cand = (kind, cls, R, ns, source, eventId, payload, extra = {}) => ({ kind, cls, R, ns, source: String(source ?? ''), eventId: String(eventId ?? ''), phase: extra.phase ?? '', payload, rev: revision([kind, eventId, payload]), ...(extra.date ? { date: extra.date } : {}) });

// A meter movement actually applied (after - before of the successful result, or a standalone scan's appliedDelta), never the ask.
// major/extreme tiers are class A; meaningful is class O; ordinary and below make no fact.
export function moveFact({ applied, tier, R, ns = 'scan', source, opId, player, date } = {}) {
    const at = reply(R);
    const cls = tier === 'major' || tier === 'extreme' ? 'A' : (tier === 'meaningful' ? 'O' : null);
    if (at === null || !cls || !opId) return null;
    const axes = {};
    for (const axis of AXES) {
        const value = Number(applied?.[axis]);
        if (Number.isFinite(value) && value !== 0) axes[axis] = value > 0 ? '+' : '-';
    }
    return Object.keys(axes).length ? cand('move', cls, at, ns, source, `move:${opId}`, { player, axes }, { date }) : null;
}
