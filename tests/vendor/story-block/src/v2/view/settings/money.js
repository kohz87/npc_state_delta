// The Money section's body (UI stage, step 3c): Story Block's General settings (the world's coins, how much the story may
// pay, the money words) drawn by the form engine in the concept's Money page: a Coins card (the coins as name and worth rows
// with "+ Add" and "Edit as text", the coin display under them), a card for what the story may pay (the budget as a slider
// whose unit is named after the smallest coin, the money scale) and a card for the money words. It writes through the same
// settings store as the General group did (`settings.set('story-block', key, value)`), so nothing the story pays changes
// with where the setting is drawn.
//
// The schema is the registry's (`registry.settingsDefs()`, Story Block's fields in its General group), regrouped into the
// cards and given what only the page needs: the budget a slider range of 0–1000 (the store still allows far more, and the
// slider grows to a larger value rather than showing it wrong), words for its value ("60 pennies", "Automatic" for 0), and a
// check on the coins that says what the store cannot: a coin the story will not use (a number in its name, a name used twice,
// no worth) and coins past the eighth. A field in General that this file does not know goes in a card of its own at the end.

import { MAX_COINS, MAX_COIN_VALUE, baseUnit, coinsOf, currencyOf } from '../../domains/money.js';
import { cutAt } from '../../../text.js';
import { renderSettingsForm } from '../form/form.js';
import { SETTINGS_TEXT, groupFields } from '../form/schema.js';
import { showAndFocus } from '../scroll.js';

/** Story Block's module id and the fold key of its General group, which `openSettings({ fold })` has always taken for the money settings. */
export const MONEY_MODULE = 'story-block';
export const MONEY_FOLD = `${MONEY_MODULE}::group:${SETTINGS_TEXT.general}`;

/** The cards, in order: a title and the fields in each. */
export const MONEY_CARDS = Object.freeze([
    Object.freeze({ title: 'Coins', keys: Object.freeze(['coins', 'coinDisplay']) }),
    Object.freeze({ title: 'What the story may pay', keys: Object.freeze(['storyCoinPerReply']) }),
    Object.freeze({ title: 'Money words', keys: Object.freeze(['currency', 'currencyPlural', 'currencyShort']) }),
    Object.freeze({ title: 'Advanced', keys: Object.freeze(['economyScale']) }),
]);
const MORE = 'More';

/** How far the budget slider goes before it grows to the value (the store's own limit is a billion). */
export const BUDGET_SLIDER_MAX = 1000;

const num = n => Number(n).toLocaleString('en-US');

/**
 * The smallest unit's words for the budget: the coin the wallet counts in (the one worth 1), else the money word, the
 * Currency setting ("gold" when the reader never set one): { one, many }.
 */
export function budgetUnit(values) {
    const unit = baseUnit(currencyOf(values));
    return { one: unit.name, many: unit.plural };
}

/** The budget as words: "60 pennies", "1 penny", and the unlimited automatic setting for 0. */
export function budgetText(n, values) {
    if (!Number.isFinite(n) || n <= 0) return 'Automatic: no limit — the story decides';
    const unit = budgetUnit(values);
    return `${num(n)} ${n === 1 ? unit.one : unit.many}`;
}

/**
 * What the coins' rows hold that the story will not use, in plain words (at most `limit` sentences): a row with no name, a
 * number in a name, a worth that is not a whole number from 1 to the most, a name an earlier coin already has, and coins
 * past the most a world has. The store keeps the rows as typed; money.js `coinsOf` reads the usable ones.
 */
export function coinProblems(rows, limit = 2) {
    const list = Array.isArray(rows) ? rows : [];
    const out = [];
    const usable = [];
    let past = false;
    list.forEach((row, at) => {
        const who = `Coin ${at + 1}`;
        const name = cutAt(String(row?.name ?? '').split('/')[0].replace(/\s+/g, ' ').trim(), 24);
        const value = Number(row?.value);
        if (!name) out.push(`${who} has no name, so it is not used.`);
        else if (/\d/.test(name)) out.push(`${who} (${name}) has a number in its name, so it is not used.`);
        else if (!Number.isSafeInteger(value) || value < 1 || value > MAX_COIN_VALUE) out.push(`${who} (${name}) needs a worth from 1 to ${num(MAX_COIN_VALUE)}, so it is not used.`);
        else if (usable.length >= MAX_COINS) past = true;
        else if (coinsOf([...usable, row]).length === usable.length) out.push(`${who} (${name}) is named like an earlier coin, so it is not used.`);
        else usable.push(row);
    });
    if (past) out.push(`Only ${MAX_COINS} coins count; the rest are not used.`);
    return out.slice(0, limit);
}

/**
 * The page's schema from Story Block's own: its General group's fields regrouped into MONEY_CARDS (a field the cards do not
 * name goes in a card at the end), the coins as rows, the budget a slider with words, the coins checked. `values()` gives the
 * settings now (the budget's unit follows the coins and the money word). → { key: field }.
 */
export function moneySchema(schema, values) {
    const general = groupFields(schema ?? {}).find(group => group.name === SETTINGS_TEXT.general)?.fields ?? [];
    const fields = new Map(general.map(({ key, field }) => [key, field]));
    const out = {};
    const put = (key, card) => {
        const field = fields.get(key);
        if (!field) return;
        out[key] = { ...field, group: card };
        fields.delete(key);
    };
    for (const card of MONEY_CARDS) for (const key of card.keys) put(key, card.title);
    for (const key of [...fields.keys()]) put(key, MORE);
    // The coins as name and worth rows (the text form is one tap away); what the store cannot say about them.
    if (out.coins) {
        const { form, ...rest } = out.coins;
        out.coins = { ...rest, check: rows => coinProblems(rows).join(' ') };
    }
    // The budget as a slider over a practical range, in the smallest coin's name.
    if (out.storyCoinPerReply) out.storyCoinPerReply = { ...out.storyCoinPerReply, form: 'slider', sliderMax: BUDGET_SLIDER_MAX, format: n => budgetText(n, values()) };
    return out;
}

/** The Money body: `(pane, ctx) → { filter, refresh, destroy, has, open }` (bodies.js). */
export function moneyBody(pane, ctx) {
    const { registry, settings } = ctx.options;
    const def = typeof registry?.settingsDefs === 'function' ? registry.settingsDefs().find(item => item.moduleId === MONEY_MODULE) : null;
    const form = renderSettingsForm(pane, {
        moduleId: MONEY_MODULE, schema: moneySchema(def?.schema, () => settings(MONEY_MODULE)), settings, doc: ctx.doc, quiet: true, className: 'ss-money',
        fold: { prefix: 'money::', only: ['Advanced'], openFirst: false },
    });
    return {
        filter: text => form.filter(text),
        refresh: () => form.refresh(),
        destroy: () => form.destroy(),
        has: key => key === MONEY_FOLD,
        open() {
            const first = form.keys()[0];
            const input = first ? form.field(first).row.querySelector('input, select, textarea, button') : null;
            return showAndFocus(input, 'center');
        },
    };
}
