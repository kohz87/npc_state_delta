// Prepares foe attacks and the board's optional alternate defenders for Standard rolls.
// Shared sheet and skill helpers keep the ordinary preparations (old planner records and the board) unchanged.

export function prepareFoes({ plan, out, sheet, ready, refuse, skillStd, skillSide, withSkill, foeSide, charId, memberRolls }) {
    const preparedFoe = (entry, target, skillName, at, { note = true } = {}) => {
        const foe = sheet.foes.find(slot => slot.slot === entry.slot && slot.filled);
        const label = `${foe?.name ?? `Foe ${entry.slot}`} attacks ${target}`;
        if (!foe) { if (note) refuse(`foe${entry.slot}`, `${label}: not rolled (that foe slot is empty).`); return null; }
        const defender = ready(target);
        if (defender.refusal) { if (note) refuse(target, `${label}: not rolled (${defender.refusal}).`); return null; }
        const skill = skillStd(defender.character, skillName, {});
        const { side, check } = skillSide(defender.character, skill, 'defence', { againstMagic: entry.againstMagic === true });
        if (check.refusal) { if (note) refuse(target, `${label}: not rolled (${check.refusal}).`, `${label}: not rolled (${check.plain ?? check.refusal}).`); return null; }
        if (skill.refused && note) refuse(target, skill.refused, skill.refusedPlain);
        return { at, kind: 'foe', actor: charId(defender.character), type: 'defence', skill: skill.skill, ...(entry.paid === true ? { paid: true } : {}),
            ...(entry.once === true ? { once: true } : {}),
            ...withSkill(skill, defender.character, 'defence', { againstMagic: entry.againstMagic === true }), pc: side, foe: foeSide(foe) };
    };
    for (const [at, entry] of (plan.foes ?? []).entries()) {
        if (entry.hold) continue;
        const base = preparedFoe(entry, entry.target, entry.skill, at);
        if (!base) continue;
        out.foes.push(base);
        memberRolls?.prepareFoe(out, entry, base, at, preparedFoe);
    }
}
