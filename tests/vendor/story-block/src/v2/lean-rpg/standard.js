// The Standard formula's roll (formula.js has the numbers; resolve.js dispatches here when the recorded rules say `formula: 'standard'`).
//
// How the roll works:
// - a roll is typed: physical, magic, defence, social or check (plan.js). The stat part is formula.js statPart: a skill's stat takes the
//   main slot, half of the type's second stat is added, the sum is halved once. Class = the level bonus (floor(level / divisor); before levels classWeight × Soul Class), then the skill's rank,
//   then the situation's edge held inside LUK's window (formula.js luckWindow, edgeWithLuck).
// - a foe adds foeBonus(class, rules) = foeBase + foeClassWeight × class.
// - a fight has a turn order (rolled once, kept across replies, carried in the payload), an opening action for a character who leads a
//   foe by the quick-start margin, and bars: a hit takes 1 block (2 when decisive) from the target's Health, a heal gives 1 (2). A foe
//   group or a character who is beaten before their turn does not act. Area attacks roll once against each target. Support rolls
//   against a difficulty.
// - the blocks the told rolls take or give are recorded on the roll (`hurts`) and written to the bars by resolve.js.
//
// The record (extends resolve.js's): result.formula 'standard'; each Line has `type`, and pc = { who, die, type, stat (the main stat),
// second, mainValue, secondValue, statBonus (the pair), style ('dodge'|'block'|'ward'|null), classValue, classBonus, rank, window { min, max } (what LUK allows the edge),
// situation (the edge asked for), edge (after luck), total }, foe = { slot, name, die, base, classValue, classBonus, total }; contested lines
// have `decisive` and, where a bar moved, `damage` = { id, kind: 'char'|'foe', name, blocks (+ hurt, − healed), from, to, size };
// `area`, `support` (target = the one healed) and `opening` mark those lines. The result adds `order` = [{ id, name, total, die, bonus,
// agi, party, fresh }] (the turn order for the fight), `quickStart` = [{ who, against }], `opening` = [Line], `idle` = [{ n, id, who,
// kind, why }] and `hurts` = [{ id, kind, name, module, field, from, to, size }].
// Optional board member hooks add pack attacks, area damage, target rotation and shared defence.
// The implementation is split into standard/roster.js, prepare.js and roll.js; the public names stay here.
export { charId, foeId } from './standard/roster.js';
export { prepareStandard } from './standard/prepare.js';
export { outcomeStd, judge, rollStandard, summaryStd } from './standard/roll.js';
