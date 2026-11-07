// The battle log's shared words and marker: the strings every part reads, the panel's root and screen ids, the
// narrator's `[battle]` line, and the fold and recent-message constants used by the live controller.

import { RPG_STRINGS } from '../../strings.js';

export const B = RPG_STRINGS.battle;
// The result word of a foe's attack, by the recorded outcome (the party's): the colour stays the outcome's (fail red, cost amber, success green).
export const FOE_WORDS = Object.freeze({ fail: B.foeHit, cost: B.foeGrazed, success: B.foeBlocked });
// A Standard line that was decisive: a party success is "Decisive"; a foe's decisive hit (the party's fail) or decisive block (its success) say so.
export const DECISIVE_WORDS = Object.freeze({ success: B.decisive, 'foe-fail': B.foeDecisiveHit, 'foe-success': B.foeDecisiveBlock });
export const BATTLE_ROOT = 'rpg-battle';
export const BATTLE_ID = 'rpg/battle-log';
/** The narrator's marker: a line of its own. (turn.js strips the same line from the prompt history.) */
export const MARKER_LINE = /^[ \t]*\[battle\][ \t]*$/i;
export const FOLD_KEY = 'story-block.rpg.battle.folded';
export const RECENT_MESSAGES = 30;

// Why a character or group does not act in a round (Standard's `idle`): the words the log says (strings.js blocks.idle).
export const IDLE = RPG_STRINGS.blocks.idle;
