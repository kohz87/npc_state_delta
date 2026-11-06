// Board-only roll hooks for member and pack attacks, area damage and shared defence.
import { packAreaBlocks, packAttacks } from './members.js';

export function memberRolls(plan) {
    const rotation = Array.isArray(plan.rotation?.targets) && plan.rotation.targets.length ? plan.rotation : null;
    const defended = new Map();
    let cursor = 0;
    return {
        prepareFoe(out, entry, base, at, prepare) {
            if (entry.once !== true || !rotation) return;
            const options = rotation.targets.map(option => {
                if (option.target === entry.target && (option.skill ?? '') === (entry.skill ?? '')) return base;
                const alternate = prepare(entry, option.target, option.skill, at, { note: false });
                return alternate ? { ...alternate, base } : null;
            });
            if (!out.foeChoices) out.foeChoices = [];
            out.foeChoices[at] = options;
        },
        startRound() { cursor = Math.max(0, (Number(rotation?.number) || 1) - 1); },
        attacks(entries, bar) {
            const mine = entries.filter(entry => entry.foe.slot === bar.slot);
            return bar.foe.pack === true ? mine.slice(0, packAttacks(bar.foe.count, bar.value, bar.size)) : mine;
        },
        hitBlocks(entry, bar, decisive) {
            return entry.area && bar.foe.pack === true ? packAreaBlocks(bar.size, decisive) : undefined;
        },
        foe(base, prepared, roll, standing = () => true) {
            const choices = rotation && base.once === true ? prepared.foeChoices?.[base.at] : null;
            let entry = base, advance = 1;
            if (Array.isArray(choices)) for (let skipped = 0; skipped < rotation.targets.length; skipped += 1) {
                const candidate = choices[(cursor + skipped) % rotation.targets.length] ?? base;
                if (standing(candidate.actor)) { entry = candidate; advance += skipped; break; }
            }
            const first = entry.once === true ? defended.get(entry.actor) : undefined;
            const use = first === true ? { ...entry, paid: true } : entry;
            const done = roll(use);
            if (entry.once === true && done.lines?.length && first === undefined)
                defended.set(entry.actor, !done.lines[0]?.without && Boolean(use.skill));
            if (done.lines?.length) cursor += advance;
            return done;
        },
    };
}
