// Builds the battle log's panel model for one reply: the recorded lines plus consequence arrows, turn-order levels,
// Status rows and the Foes line, read from the reply's state and the state before it.

import { fold } from '../../read.js';
import { areaLineGroups } from '../../board/order.js';
import { RPG_STRINGS, fill } from '../../strings.js';
import { BARS, readFoes, readParty } from '../party-data.js';
import { B } from './constants.js';

// What moved between the state before the reply and the reply's own: "Sluice Rat A Wounded", "Ren Tired".
function consequences(state, before, roleOf) {
    const out = [];
    const foesBefore = new Map(readFoes(before, { roleOf }).map(foe => [foe.name, foe]));
    for (const foe of readFoes(state, { roleOf })) {
        const was = foesBefore.get(foe.name);
        if (was && was.hurt !== foe.hurt) out.push({ name: foe.name, kind: 'health', foeSlot: foe.slot, text: `${foe.name} ${foe.word}` });
    }
    const was = new Map(readParty(before, { roleOf }).map(character => [`${character.module}|${character.subject}`, character]));
    for (const character of readParty(state, { roleOf })) {
        const old = was.get(`${character.module}|${character.subject}`);
        if (!old) continue;
        for (const key of BARS) if (old.bars[key].value !== character.bars[key].value) out.push({ name: character.name, kind: key, text: key === 'health' ? `${character.name} ${character.bars[key].word}` : fill(B.arrowBar, { name: character.name, bar: character.definition.state?.[key]?.label ?? RPG_STRINGS.bars[key], word: character.bars[key].word }) });
    }
    return out;
}

// The arrow goes on the last told action aimed at that name (a health change) or taken by it (mana, stamina), once. A change no
// told action explains is left to the Status block.
const same = (a, b) => a.normalize('NFKC').toLowerCase() === b.normalize('NFKC').toLowerCase();
function attach(model, changes) {
    const lines = [...(model.opening ?? []), ...model.rounds.flatMap(round => round.lines)];
    for (const change of changes) {
        const aimed = line => (change.kind === 'health' ? (line.target && same(line.target, change.name)) || (line.foe && same(line.who, change.name)) : same(line.who, change.name));
        // A Mana or Stamina change sits on the first line whose recorded cost moved that bar; a record with no cost keeps the last line the actor took.
        const paid = change.kind === 'health' ? null : lines.find(line => line.cost === change.kind && same(line.foe ? line.target : line.who, change.name));
        (paid ?? lines.findLast(aimed))?.arrows.push(change.text);
    }
}

/**
 * The panel's content for a reply: the recorded rolls, the arrows, the Status rows and the Foes line.
 * `state` and `before` are the reply's state and the one before it (null for none).
 */
export function panelModel({ resolve, state, before = null, roleOf, ranks = [] }) {
    const copyLine = line => ({ ...line, arrows: [...(line.arrows ?? [])] });
    const model = { ...resolve, rounds: resolve.rounds.map(round => ({ ...round, lines: round.lines.map(copyLine) })),
        ...(resolve.opening ? { opening: resolve.opening.map(copyLine) } : {}) };
    const recordedCosts = [...(model.opening ?? []), ...model.rounds.flatMap(round => round.lines)]
        .filter(line => line.recordedCost).map(line => `${fold(line.foe ? line.target : line.who)}|${line.recordedCost}`);
    const recordedHealth = new Set(model.rounds.flatMap(round => round.lines).filter(line => line.recordedHealth).map(line => fold(line.target)));
    const changes = consequences(state, before, roleOf).filter(change => !resolve.virtualGroups?.includes(change.foeSlot)
        && !(change.foeSlot && recordedHealth.has(fold(change.name))) && !recordedCosts.includes(`${fold(change.name)}|${change.kind}`));
    attach(model, changes);
    for (const round of model.rounds) round.lines = areaLineGroups(round.lines).map(group => {
        const first = group[0];
        return first.aoe ? { ...first, target: first.aoeName || first.target, arrows: group.flatMap(line => line.arrows) } : first;
    });
    const names = new Set([...(model.opening ?? []), ...model.rounds.flatMap(round => round.lines)].flatMap(line => [line.who, line.target]));
    const party = readParty(state, { roleOf });
    const foes = readFoes(state, { roleOf, ranks });
    // The turn order says each one's level, "Astra (Lv 14)": the level the roll used where the record has it, else read from the reply's state (so a swipe and a Re-read agree).
    const levelByName = new Map([...party, ...foes].map(item => [fold(item.name), item.level]));
    if (model.orderEntries) model.orderEntries = model.orderEntries.map(item => {
        const level = item.group ? foes.find(foe => foe.slot === item.group)?.level : levelByName.get(fold(item.name));
        return item.level === undefined && level !== undefined ? { ...item, level } : item;
    });
    const involved = party.filter(character => names.has(character.name));
    model.status = (involved.length ? involved : party).map(character => ({ name: character.name,
        rows: BARS.map(key => ({ key, ...character.bars[key], label: character.definition.state?.[key]?.label ?? RPG_STRINGS.bars[key] })) }));
    // The Foes line lists the groups that took part in this reply's rolls (a group left on the block from an earlier fight is not this reply's).
    const rolledFoes = new Set([...(model.opening ?? []), ...model.rounds.flatMap(round => round.lines)].filter(line => line.foe).map(line => fold(line.who)).concat([...(model.opening ?? []), ...model.rounds.flatMap(round => round.lines)].filter(line => !line.foe && line.target).map(line => fold(line.target))));
    const rolledGroups = new Set(model.rounds.flatMap(round => round.lines).filter(line => line.aoe).map(line => line.aoeGroup));
    model.foes = model.rounds.length ? foes.filter(foe => !rolledFoes.size || rolledFoes.has(fold(foe.name)) || rolledGroups.has(foe.slot)).map(foe => ({ text: `${foe.count > 1 ? `${foe.name} ${fill(B.count, { n: foe.count })}` : foe.name} · ${foe.levelText}: ${foe.hurt === 0 ? B.down : foe.word}` })) : [];
    return model;
}
