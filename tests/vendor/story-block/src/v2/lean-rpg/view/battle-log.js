// The battle log (display D, approved mockup): a dark monospace panel drawn inside the reply at the narrator's
// `[battle]` marker, from the reply's recorded rolls (A's `rpg.resolve` receipt, `data.v2.result`); when the reply has
// no marker the same panel is a card under the reply, above "Changed this reply". It has a one-line header that folds
// (the fold is the viewer's: localStorage, per chat and reply), the turn order, one short line per action with the
// coloured result word and "(26 vs 16)", the breakdown on tap, the consequence arrow ("→ Sluice Rat A Wounded", from
// the reply's word changes), a Status grid with aligned solid bars (coloured by stage, like the Party tab's) and a Foes line. A check shows as one line.
//
// Nothing the panel shows is stored in the chat text: it is read from the record and the state each time, so a swipe,
// a delete, a Re-read and a reload agree. Every node is built with createElement and textContent.
//
// The Standard formula's record (lean-rpg/standard/roll.js, re-exported by standard.js) adds, all optional (a record without them draws exactly as before):
//   result.order       [{ id, name, total, die, bonus, agi, party, fresh }] the turn order rolled at the start of the fight, highest first
//   result.quickStart  [{ who, against }] a character 10 or more ahead of a foe: one opening action against it before the first round
//   result.opening     [Line] those opening actions
//   round.idle         [{ n, id, who, kind, why }] a foe group or character who does not act: why 'beaten' (before its turn), 'down' or 'no-target'
//   Line               { kind, type: physical|magic|defence|social|check, skill, pc: { who, die, type, stat, second, mainValue, secondValue, statBonus, style,
//                        classValue, classBonus, rank, luck, edge, total }, foe, outcome, decisive?, damage?: { name, blocks (+ hurt, − healed), from, to, size },
//                        area?, support? (kind 'check', `target` the one helped), opening? }; the breakdown on tap is built from these
//                        ("Physical: d20 17 + (AGI 10 + DEX 6/2)/2 = 6 + Expert 2 + Lv 14 ÷ 5 = 2 = 29 · vs Weir-drake d20 9 + 3 + Lv 7 ÷ 5 = 1 = 24"; a record made before Levels says "Class II 4")
//   Line.breakdown     (or the roll's breakdown as one plain string, which then wins)
// A's result record (`data.v2.result` of the `rpg.resolve` receipt; see the header of lean-rpg/resolve.js), as `readResolve` reads it:
//   { v: 1, key, pace, stop, checks: [Line], rounds: [{ n, decisive, lines: [Line] }], refused: [{ who, text }], summary: { exchanges, acts, refused } }
//   Line = { kind: 'act' | 'foe' | 'check', outcome: 'success' | 'cost' | 'fail', skill: string | null, why?,
//            pc: { who, die, stat, statBonus, classValue, classBonus, rank, edge, total },
//            foe?: { slot, name, die, base, classValue, classBonus, total }, difficulty?, dc? }
// For a 'foe' line `pc` is the defender. The numbers read the party's total against the foe's total (or the DC).
//
// The parts live in `battle-log/`: `constants.js` the words and marker; `util.js` small value helpers; `read.js` the
// recorded rolls as lines; `model.js` arrows, Status rows and Foes; `draw.js` the panel and no-rolls note; `marker.js`
// finding, hiding and replacing marker lines; `follow.js` the fold store and the live chat controller. This file keeps
// the path and every public export.

export { BATTLE_ROOT, BATTLE_ID, MARKER_LINE } from './battle-log/constants.js';
export { outcomeOf, rollText, readResolve, resolveOf } from './battle-log/read.js';
export { panelModel } from './battle-log/model.js';
export { headerText, buildPanel, noteText, buildNote } from './battle-log/draw.js';
export { MARKER_HIDDEN, markerNodes, hideMarkers, releasePanel, placeAtMarker } from './battle-log/marker.js';
export { createFoldStore, createBattleLog } from './battle-log/follow.js';
