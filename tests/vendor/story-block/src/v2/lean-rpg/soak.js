// VIT soak (the fight mark `soak: 1`): on a party member's defence, a foe's hit lands only if the foe beats the defender by more than
// 2 + S, S = min(5, floor(effective VIT / 4)). Effective VIT is what the fight rolls with (base + worn gear, gear.js applyGear). A decisive
// hit (natural 20 or 1, or the decisive margin) always lands. Pure helpers: the roll (standard/roll.js) and the Party card both read them.
export const SOAK_BASE = 2;
export const SOAK_MAX = 5;
export const SOAK_STEP = 4;

/** S for an effective VIT (0 when it is not a number). */
export const soakOf = vit => (Number.isFinite(vit) ? Math.min(SOAK_MAX, Math.max(0, Math.floor(vit / SOAK_STEP))) : 0);

/** Whether a foe's non-decisive hit, `margin` ahead of the defender, glances off at soak `s`. */
export const soaked = (s, margin, decisive) => s >= 0 && !decisive && margin <= SOAK_BASE + s;

/** The Party card's numbers for an effective VIT: { s, next } (`next`: the VIT that adds one, null at the top). */
export function soakGrowth(vit) {
    const s = soakOf(vit);
    return { s, next: s >= SOAK_MAX ? null : (s + 1) * SOAK_STEP };
}
