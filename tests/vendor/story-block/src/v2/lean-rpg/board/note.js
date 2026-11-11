// Makes the narrator's settled account from the board's recorded lines.
// Every outcome and every bar movement is included, even in a long fight; one line is told as one
// [Happened] cue and is never cut. Opening names come from the recorded setup for both preview and receipt.

import { BATTLE_MARKER, STAGES, stageWord } from '../names.js';
import { MEMBER_CAP, MEMBER_CAP_SIX, packLeft } from './members.js';

const clean = value => String(value ?? '').replace(/\s+/gu, ' ').trim();

function packSuffix(damage, foe) {
    const count = Number(foe?.count ?? damage?.count ?? damage?.packCount);
    // (a split pack always holds more than five foes before the six-group rule and more than six after, so its flag alone says it is one)
    const flagged = foe?.pack === true || damage?.pack === true;
    if (!(flagged || count > MEMBER_CAP) || !Number.isInteger(count) || count <= (flagged ? 1 : MEMBER_CAP)) return '';
    const left = Number.isFinite(damage?.left) ? damage.left : packLeft(count, damage?.to, damage?.size);
    return ` (about ${left} of ${count} left)`;
}

// A bar that moved within one word ("Tired → Tired") is left out: the board and the narrator speak in words only.
export const barMovement = (damage, resource = false, foe = null) => {
    const kind = resource ? (/:(mana|stamina)$/u.exec(damage.id)?.[1] ?? 'stamina') : 'health';
    const from = stageWord(STAGES[kind], damage.from, damage.size), to = stageWord(STAGES[kind], damage.to, damage.size);
    const virtual = foe?.member === true || foe?.pack === true || (Number.isInteger(foe?.group) && foe?.pack === false);
    const name = clean(virtual ? foe.name : damage.name);
    return from === to ? '' : `${name} ${kind} ${from} → ${to}${resource ? '' : packSuffix(damage, foe)}`;
};

function lineNote(line, members = null) {
    const who = clean(line.pc?.who), foe = clean(line.foe?.name), skill = line.skill ? ` (${clean(line.skill)})` : '';
    const area = line.aoe ? (line.reduced ? ' (area, reduced)' : ' (area)') : '';
    const action = line.flee ? `${who} flees from ${foe}` : line.support ? `${who} heals ${clean(line.target)}${skill}` : line.kind === 'foe' ? `${foe} attacks ${who}` : `${who} attacks ${foe}${skill}${area}`;
    const result = line.outcome === 'cost' ? 'success at a cost' : line.outcome;
    // (a hit soaked by the defender's VIT, even at soak 0: told briefly, no number)
    const glance = line.kind === 'foe' && Number.isInteger(line.soaked) && line.soaked >= 0;
    const verdict = glance ? `blow glances off${skill}` : line.kind === 'foe' ? `${who}'s defence${skill}: ${result}` : result;
    const slot = line.foe?.slot ?? Number(/^f:(\d+)/u.exec(line.damage?.id ?? '')?.[1] ?? NaN);
    const target = line.kind === 'foe' ? null : { ...(members?.get(slot) ?? {}), ...(line.foe ?? {}) };
    const changes = [line.damage ? barMovement(line.damage, false, target) : '', line.cost ? barMovement(line.cost, true) : ''].filter(Boolean);
    return `${action}: ${line.aoeNoTarget ? 'main target already Down; ' : ''}${verdict}${line.decisive ? ', decisive' : ''}${changes.length ? `; ${changes.join('; ')}` : ''}`;
}

function newFoesNote(result, setup) {
    if (!Array.isArray(result.members) || !Array.isArray(setup?.opened) || !setup.opened.length) return '';
    const foes = setup.opened.filter(entry => entry && clean(entry.name) && Number.isInteger(entry.count) && entry.count > 0).map(entry => {
        const cap = setup?.foesSix === 1 ? MEMBER_CAP_SIX : MEMBER_CAP, list = entry.count >= 2 && entry.count <= cap ? ', each fought on its own' : entry.count > cap ? ', fought as a pack' : '';
        return `${clean(entry.name)} ×${entry.count}${Number.isInteger(entry.level) ? ` (Lv ${entry.level})` : ''}${list}`;
    });
    return foes.length ? `New foes: ${foes.join(', ')}.` : '';
}

/** A compact but complete list of settled outcomes and changes, followed by the fight's status. */
export function settledNote(result, setup = null) {
    const lines = [result.fromApproach ? 'Tell the approach, then the settled fight results in order; do not reroll them.' : 'Tell the settled fight results in order; do not reroll them.',
        `Write ${BATTLE_MARKER} on its own line where the fight is told.`,
        'Code has already moved the bars for these results; never set those yourself.'];
    const members = new Map((Array.isArray(result.members) ? result.members : []).filter(entry => Number.isInteger(entry?.slot)).map(entry => [entry.slot, entry]));
    const newFoes = newFoesNote(result, setup);
    if (newFoes) lines.push(newFoes);
    for (const line of result.opening ?? []) lines.push(`Opening: ${lineNote(line, members)}.`);
    const wear = Array.isArray(result.wear) ? result.wear : [], included = new Set();
    const wearNote = event => `${clean(event.who)}'s ${clean(event.item)} condition: ${clean(event.from)} → ${clean(event.to)}`;
    for (const round of result.rounds ?? []) {
        const changes = wear.flatMap((event, index) => {
            if (event.n !== round.n) return [];
            included.add(index);
            return [wearNote(event)];
        });
        const unpaid = (round.idle ?? []).filter(item => item.why === 'no-resource').map(item => `${clean(item.who)} cannot heal: the skill's resource is Empty`);
        lines.push(`Exchange ${round.n}: ${[...round.lines.map(line => lineNote(line, members)), ...unpaid, ...changes].join(' | ') || 'No one acted'}.`);
    }
    wear.forEach((event, index) => { if (!included.has(index)) lines.push(`Exchange ${event.n}: ${wearNote(event)}.`); });
    const end = { won: 'The fight is won. Code gives the party its XP.', lost: 'The fight is lost.', fled: 'The party fled.', open: 'The fight is still open.' };
    lines.push(end[result.stop] ?? 'The fight is still open.');
    lines.push(result.stop === 'open' ? 'The fight is still in progress; do not tell a post-fight aftermath yet.'
        : result.stop === 'won' ? 'Then follow the reader’s requested aftermath as the outcome permits.'
            : 'Then follow the reader’s requested aftermath only as the outcome permits; do not assume the foes or their possessions are accessible or looting succeeds.');
    return lines.join(' | ');
}

// The board's log lines (the view reads them; a followup of an area skill under `areaAll` is a group hit alike, not reduced).
const signed = n => n >= 0 ? `+${n}` : String(n);
export const labelLine = line => {
    const pc = line.pc ?? {}, foe = line.foe ?? {}, who = line.flee ? `${pc.who} flees` : line.support ? `${pc.who} heals ${line.target}` : line.reduced ? `… also hits ${foe.name} (reduced)` : line.kind === 'foe' ? `${foe.name} attacks ${pc.who}` : `${pc.who} → ${foe.name}`;
    const bonus = (pc.statBonus ?? 0) + (pc.classBonus ?? 0) + (pc.rank ?? 0) + (pc.edge ?? 0);
    const changes = [line.damage ? barMovement(line.damage) : '', line.cost ? barMovement(line.cost, true) : ''].filter(Boolean);
    const skill = line.skill ? ` (${line.skill})` : '';
    const verdict = `${line.kind === 'foe' ? `${pc.who}'s defence${skill}: ` : ''}${line.kind === 'foe' && Number.isInteger(line.soaked) && line.soaked >= 0 ? 'GLANCED OFF' : String(line.outcome).toUpperCase()}`;
    return `${who}${line.kind === 'foe' ? '' : skill}: d20 ${pc.die} ${signed(bonus)} = ${pc.total} vs ${foe.total ?? line.dc} — ${verdict}${line.decisive ? ', DECISIVE' : ''}${changes.length ? ` · ${changes.join(' · ')}` : ''}`;
};
export const labelAreaGroup = group => {
    const line = group[0], name = line.aoeName || line.foe?.name || '';
    const changes = group.flatMap(item => [item.damage ? barMovement(item.damage) : '', item.cost ? barMovement(item.cost, true) : '']).filter(Boolean);
    if (line.reduced || line.aoeFollowup) return `… also ${line.outcome === 'fail' ? 'targets' : 'hits'} ${name}${line.reduced ? ' (reduced)' : ''}${changes.length ? ` → ${changes.join(', ')}` : line.outcome === 'fail' ? ' — FAIL' : ''}`;
    const base = labelLine({ ...line, foe: { ...line.foe, name }, damage: undefined, cost: undefined });
    return `${base}${line.aoeNoTarget ? ' · main target Down' : ''}${changes.length ? ` → ${changes.join(', ')}` : ''}`;
};
