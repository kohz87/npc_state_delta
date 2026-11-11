// The RPG settings page's shared words and controls data: its section id, Rolls fallback, card search words, and
// the Standard Custom-number fields.

import { LEVEL, ROLLS_SETTING } from '../../names.js';
import { RPG_STRINGS, fill } from '../../strings.js';
import { SOUL_LABEL } from '../../soul.js';

export const S = RPG_STRINGS.settings;
export const ROLLS_DEFAULT = 'automatic';
/** The setting's key (the rolls piece's ROLLS_SETTING). */
export const ROLLS_KEY = ROLLS_SETTING;
export const SETTINGS_MODULE = 'story-block';
/** The rail entry and page id of the section. */
export const SECTION_ID = 'rpg';

/** The reader's choice: 'automatic' or 'off'. */
export const rollsOf = settings => (settings?.(SETTINGS_MODULE)?.[ROLLS_KEY] === 'off' ? 'off' : ROLLS_DEFAULT);

// The level divisor row (Custom): 3 to 8, 5 unset; it replaces the Soul Class weight row, which a levelled roll no longer reads.
const DIVISORS = Object.freeze(Array.from({ length: LEVEL.maxDivisor - LEVEL.minDivisor + 1 }, (_, n) => LEVEL.minDivisor + n));

// Standard's Custom numbers: the roll's, then creation's.
export const STANDARD_FIELDS = Object.freeze([
    Object.freeze({ key: 'foeBase', label: S.foeBase, help: S.foeBaseHelpStandard }),
    Object.freeze({ key: 'foeClassWeight', label: S.foeClassWeight, help: S.foeClassWeightHelp }),
    Object.freeze({ key: 'levelDivisor', label: S.levelDivisor, help: S.levelDivisorHelp, options: Object.freeze(DIVISORS.map(n => [n, `÷${n}`])) }),
    Object.freeze({ key: 'costMargin', label: S.costMargin, help: S.costMarginHelp }),
    Object.freeze({ key: 'decisiveMargin', label: S.decisiveMargin, help: S.decisiveMarginHelp }),
    Object.freeze({ key: 'roundCap', label: S.roundCap, help: S.roundCapHelp }),
    Object.freeze({ key: 'quickStartMargin', label: S.quickStartMargin, help: S.quickStartMarginHelp }),
    Object.freeze({ key: 'startStat', label: S.startStat, help: S.startStatHelp }),
    Object.freeze({ key: 'createPoints', label: S.createPoints, help: S.createPointsHelp }),
    Object.freeze({ key: 'createMin', label: S.createMin, help: S.createMinHelp }),
    Object.freeze({ key: 'createMax', label: S.createMax, help: S.createMaxHelp }),
    Object.freeze({ key: 'pointsPerSoul', label: S.pointsPerSoul, help: S.pointsPerSoulHelp }),
    Object.freeze({ key: 'statMax', label: S.statMax, help: S.statMaxHelp }),
]);

const words = (...parts) => parts.join(' ').toLowerCase();
export const CARD_WORDS = Object.freeze({
    formula: words(S.formula, S.formulaStandardHelp, S.formulaNote, S.formulaRows.map(row => `${row.type} ${row.what}`).join(' '), Object.values(S.formulaNums).join(' '), S.formulaFootStandard),
    levels: words(S.levels, S.levelCap, S.levelCapHelp, S.practice, S.practiceHelp, S.xpRate, S.xpRateHelp),
    rolls: words(S.rolls, S.rollsHelp, S.checks, S.checksHelp, S.automatic, S.off, 'fight board choose exchanges'),
    difficulty: words(S.difficulty, S.gentle, S.standard, S.harsh, S.custom, STANDARD_FIELDS.map(field => `${fill(field.label, { label: SOUL_LABEL })} ${field.help}`).join(' '), S.replayNote),
    combat: words(S.combat, S.combatHelp, S.combatLabel, S.combatReset),
    join: words(S.join, S.joinHelp, S.joinAsk, S.joinAuto, S.joinOff),
    gear: words(S.gear, S.gearHelp, S.gearOn, S.off),
});
