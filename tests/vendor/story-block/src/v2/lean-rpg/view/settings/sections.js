// Draws the RPG settings page's Formula, Rolls, Levels, Companions and Gear cards from the live settings store and
// story facts, using the page's shared card, chip and number-row builders.

import { h } from '../../../view/widgets/dom.js';
import { switchField } from '../../../view/form/fields.js';
import { boardSetting } from '../../board/settings.js';
import { AUTO_CAP_SETTING, CHECKS_SETTING, PRECHECK_SETTING, checksOn, precheckOn, LEVEL, LEVEL_CAP_SETTING, autoCapFrom, levelCapOf, JOIN_SETTING, PRACTICE, PRACTICE_SETTING, practiceOf } from '../../names.js';
import { joinMode } from '../../join.js';
import { rulesFromSettings } from '../../rules.js';
import { XP_RATE, XP_RATE_SETTING, xpRateOf } from '../../levels.js';
import { fill } from '../../strings.js';
import { S, ROLLS_KEY, rollsOf } from './constants.js';

export function createBasicSections({ doc, card, chips, field, numberRow, packNote, values, settings, put, pack, boardFeature, gear, onChange }) {
    // ---- The stat formula: how its rolls are made, and its four main numbers (Standard is the only formula)
    function drawFormula() {
        const rules = rulesFromSettings(values(), pack());
        const box = card('formula', S.formula);
        const fromPack = packNote('formula', 'numbers');
        if (fromPack) box.appendChild(fromPack);
        box.appendChild(h(doc, 'p', 'rpg-set-help', S.formulaStandardHelp));
        const table = h(doc, 'table', 'rpg-formula-table');
        table.setAttribute('data-formula', 'standard');
        const body = h(doc, 'tbody');
        for (const row of S.formulaRows) {
            const tr = h(doc, 'tr');
            tr.append(h(doc, 'th', '', row.type), h(doc, 'td', '', row.what));
            body.appendChild(tr);
        }
        table.appendChild(body);
        const scroll = h(doc, 'div', 'rpg-formula-scroll');
        scroll.appendChild(table);
        box.appendChild(scroll);
        const tiles = [[rules.startStat, S.formulaNums.start], [rules.createPoints, S.formulaNums.points], [fill(S.formulaPoints, { n: LEVEL.pointEvery }), S.formulaNums.perSoul], [fill(S.formulaFoe, { base: rules.foeBase, divisor: rules.levelDivisor ?? LEVEL.divisor }), S.formulaNums.foe]];
        const nums = h(doc, 'div', 'rpg-formula-nums');
        for (const [value, label] of tiles) {
            const tile = h(doc, 'div', 'rpg-formula-num');
            tile.append(h(doc, 'b', '', String(value)), h(doc, 'span', '', label));
            nums.appendChild(tile);
        }
        box.appendChild(nums);
        box.appendChild(h(doc, 'p', 'rpg-set-help', S.formulaFootStandard));
        box.appendChild(h(doc, 'p', 'rpg-set-help', S.formulaNote));
    }

    // ---- Rolls
    function drawRolls() {
        const box = card('rolls', S.rolls);
        chips(box, S.rolls, [['automatic', S.automatic], ['off', S.off]], rollsOf(settings), value => put(ROLLS_KEY, value));
        box.appendChild(h(doc, 'p', 'rpg-set-help', S.rollsHelp));
        const row = h(doc, 'div', 'rpg-board-setting');
        row.setAttribute('data-card', 'checks');
        const copy = h(doc, 'div', 'rpg-board-setting-copy');
        copy.append(h(doc, 'b', '', S.checks), h(doc, 'p', 'rpg-set-help', S.checksHelp));
        const toggle = switchField({ doc, ariaLabel: S.checks, value: checksOn(values()), onChange: value => put(CHECKS_SETTING, value) });
        row.append(copy, toggle.el);
        box.appendChild(row);
        if (boardFeature) box.appendChild(boardSetting(doc, boardFeature, onChange, { value: autoCapFrom(values()), set: v => put(AUTO_CAP_SETTING, v) }, { value: precheckOn(values()), set: v => put(PRECHECK_SETTING, v === true) }));
    }

    // ---- Levels and practice: the level cap, the practice a skill use gives, the XP rate
    function drawLevels() {
        const box = card('levels', S.levels);
        const grid = h(doc, 'div', 'rpg-set-nums');
        // The level cap and the XP rate are read when a reply is made, and the XP rate is recorded with it, so a change here moves only the replies after it.
        numberRow(grid, { label: S.levelCap, help: S.levelCapHelp, setting: LEVEL_CAP_SETTING, min: LEVEL.min, max: LEVEL.max, step: 1, current: () => levelCapOf(values()[LEVEL_CAP_SETTING]) ?? LEVEL.max,
            clean: typed => Math.min(LEVEL.max, Math.max(LEVEL.min, Math.round(typed))) });
        numberRow(grid, { label: S.practice, help: S.practiceHelp, setting: PRACTICE_SETTING, min: PRACTICE.minPerUse, max: PRACTICE.maxPerUse, step: 1, current: () => practiceOf(values()[PRACTICE_SETTING]) ?? PRACTICE.perUse,
            clean: typed => Math.min(PRACTICE.maxPerUse, Math.max(PRACTICE.minPerUse, Math.round(typed))) });
        numberRow(grid, { label: S.xpRate, help: S.xpRateHelp, setting: XP_RATE_SETTING, min: XP_RATE.min, max: XP_RATE.max, step: XP_RATE.step, current: () => xpRateOf(values()[XP_RATE_SETTING]) ?? XP_RATE.default,
            clean: typed => Math.min(XP_RATE.max, Math.max(XP_RATE.min, Math.round(typed / XP_RATE.step) * XP_RATE.step)) });
        box.appendChild(grid);
    }

    // ---- Companions who join
    function drawJoin() {
        const box = card('join', S.join);
        chips(box, S.join, [['ask', S.joinAsk], ['auto', S.joinAuto], ['off', S.joinOff]], joinMode(values()), value => put(JOIN_SETTING, value));
        box.appendChild(h(doc, 'p', 'rpg-set-help', S.joinHelp));
    }

    // ---- Gear in fights (the feature `story-block.gear`, kept off the Features list; `gear` = { on(), set(value) }, none without a host)
    function drawGear() {
        if (!gear) return;
        const box = card('gear', S.gear);
        chips(box, S.gear, [['on', S.gearOn], ['off', S.off]], gear.on() ? 'on' : 'off', value => { gear.set(value === 'on'); onChange(); });
        box.appendChild(h(doc, 'p', 'rpg-set-help', S.gearHelp));
    }

    return { drawFormula, drawRolls, drawLevels, drawJoin, drawGear };
}
