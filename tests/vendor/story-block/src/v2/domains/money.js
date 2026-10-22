// Money: one currency per chat (MODULES.md F1). The currency has one name, set in Story Block's
// settings (default 'gold'); the reader may rename it, never add a second. A wallet is one integer
// per owner under `coin`: wallets[owner] = { coin: 125 }. Pure.
//
// The name is singular ("1 mark"); the plural is its own setting, blank for the name + "s" ("44 marks",
// see pluralOf). The default, gold, has no plural form of its own ("44 gold").
//
// Coins (MODULES §F108): a world may count its one currency in coins of different worth ("copper: 1",
// "silver: 10", "gold: 100"): the reader's Coins setting, else the pack's `currency.coins` (when the pack's
// currency is in use), else none. The wallet still holds one whole number of the smallest unit (the
// coin worth 1); a written amount names at most one coin ("3 silver" is 30), which code turns into
// that unit before any budget or cap; amounts are shown in mixed coins ("3 silver 5 copper"), or in
// the smallest unit when the reader prefers (Coin display: base).

import { cutAt } from '../../text.js';

export const WALLET_KEY = 'coin';
export const DEFAULT_CURRENCY = Object.freeze({ name: 'gold', plural: 'gold', short: 'g' });

const MAX_NAME = 24;
const MAX_SHORT = 6;
// The most coins a currency has, and the most one is worth in the smallest unit.
export const MAX_COINS = 8;
export const MAX_COIN_VALUE = 1_000_000;
// Words that sometimes follow a coin's name in an amount and say nothing more ("3 silver coins",
// "3 pieces of silver").
const COIN_FILLER = new Set(['coin', 'coins', 'piece', 'pieces', 'of', 'in']);
// The money words that name the smallest unit on their own (coinValue).
const BARE_COIN = new Set(['coin', 'coins']);
// Coin names that read as their own plural ("15 copper", "3 silver").
const MASS_WORDS = new Set(['copper', 'silver', 'gold', 'bronze', 'iron', 'brass', 'tin', 'steel', 'platinum', 'electrum', 'nickel']);

const tidy = (text, max) => cutAt(String(text ?? '').replace(/\s+/g, ' ').trim(), max);

/**
 * The plural a currency name gets when none is set: the name + "s" ("marks"). Gold stays gold, and a
 * name the reader already wrote as a plural ("crowns") is not given a second s.
 */
export function pluralOf(name) {
    const singular = tidy(name, MAX_NAME) || DEFAULT_CURRENCY.name;
    if (singular.toLowerCase() === DEFAULT_CURRENCY.name || /s$/i.test(singular)) return singular;
    return `${singular}s`;
}

/** The plural a coin gets when none is written: a metal reads as its own ("15 copper"), "penny" → "pennies", "crown" → "crowns". */
export function coinPlural(name) {
    const singular = tidy(name, MAX_NAME);
    const lower = singular.toLowerCase();
    if (!singular || MASS_WORDS.has(lower) || /s$/i.test(singular)) return singular;
    if (/[^aeiou]y$/i.test(singular)) return `${singular.slice(0, -1)}ies`;
    if (/(?:x|z|ch|sh)$/i.test(singular)) return `${singular}es`;
    return `${singular}s`;
}

/**
 * A list of coins (the Coins setting's rows `{ name, value }`, a row's name may be "penny/pennies", or a
 * pack's `{ name, plural?, value }`) cleaned: `[{ name, plural, value }]`, smallest first, at most
 * MAX_COINS, names once each (ignoring case); [] when none is usable. Two coins may be worth the same
 * ("copper" and "bronze"): both are read, the first is the one shown.
 */
export function coinsOf(rows) {
    const out = [];
    const taken = word => out.some(coin => [coin.name, coin.plural].some(other => other.toLowerCase() === word.toLowerCase()));
    for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || typeof row !== 'object' || out.length >= MAX_COINS) continue;
        const [first, second] = String(row.name ?? '').split('/');
        const name = tidy(first, MAX_NAME).replace(/[|:#<>]/g, '').trim();
        const plural = tidy(row.plural ?? second ?? '', MAX_NAME).replace(/[|:#<>]/g, '').trim() || coinPlural(name);
        const value = Number(row.value);
        if (!name || /\d/.test(name) || !Number.isSafeInteger(value) || value < 1 || value > MAX_COIN_VALUE || taken(name) || taken(plural)) continue;
        out.push({ name, plural, value });
    }
    return out.sort((a, b) => a.value - b.value);
}

/**
 * The currency from this module's settings ({ currency?, currencyPlural?, currencyShort?, coins?,
 * coinDisplay? }): { name, plural, short }, with `coins` (coinsOf) when it has any and `display: 'base'`
 * when the reader shows amounts in the smallest unit. The plural defaults to pluralOf(name); the short
 * form to the name's first letter, lowercased.
 */
export function currencyOf(settings) {
    const name = tidy(settings?.currency, MAX_NAME) || DEFAULT_CURRENCY.name;
    const plural = tidy(settings?.currencyPlural, MAX_NAME) || pluralOf(name);
    const short = cutAt(String(settings?.currencyShort ?? '').trim(), MAX_SHORT)
        || (name === DEFAULT_CURRENCY.name ? DEFAULT_CURRENCY.short : Array.from(name)[0].toLowerCase());
    const coins = coinsOf(settings?.coins);
    if (!coins.length) return { name, plural, short };
    return { name, plural, short, coins, ...(settings?.coinDisplay === 'base' ? { display: 'base' } : {}) };
}

const coinList = currency => (Array.isArray(currency?.coins) ? currency.coins : []);

/** The smallest unit's names: the coin worth 1, else the currency's own name. */
export function baseUnit(currency = DEFAULT_CURRENCY) {
    const one = coinList(currency).find(coin => coin.value === 1);
    if (one) return { name: one.name, plural: one.plural };
    const name = currency?.name || DEFAULT_CURRENCY.name;
    return { name, plural: currency?.plural || pluralOf(name) };
}

/**
 * What one of the money word `text` is worth in the smallest unit: a coin's value for a coin's name or
 * plural (any case, "coins"/"pieces of" around it ignored, "<name>s" too), else 1 for the currency's name
 * or plural or a bare "coin"/"coins" (the smallest unit), else 0. With coins the currency's own name is
 * not a coin (B-a1-8: "+ coin 2 gold" in a world of copper and silver is refused, never read as 2
 * copper), unless no coin is worth 1 (it is the unit).
 */
export function coinValue(text, currency = DEFAULT_CURRENCY) {
    const all = tidy(text, 200).toLowerCase().split(' ').filter(Boolean);
    const word = all.filter(word => !COIN_FILLER.has(word)).join(' ');
    // FB-3: "coin" or "coins" alone ("+ item Coins | qty: 5", "+ coin 5 coins") is the smallest unit, as
    // "+ coin 5" is; filler words alone ("pieces") are not money.
    if (!word) return all.some(word => BARE_COIN.has(word)) ? 1 : 0;
    const coins = coinList(currency);
    const coin = coins.find(entry => entry.name.toLowerCase() === word || entry.plural.toLowerCase() === word || `${entry.name.toLowerCase()}s` === word);
    if (coin) return coin.value;
    if (coins.some(entry => entry.value === 1)) return 0;
    const plural = currency?.plural || pluralOf(currency?.name);
    const name = String(currency?.name ?? '').toLowerCase();
    return word === name || word === `${name}s` || word === String(plural).toLowerCase() ? 1 : 0;
}

/**
 * True when `text` names money: the currency's name or plural, or a coin's, read as coinValue reads it
 * ("Silver Coins", "Silvers", "pieces of gold"), so an item line, a loot line and a coin line agree on
 * what is money (B-a1-7): "+ item Marks" is money.
 */
export function isCurrencyName(text, currency = DEFAULT_CURRENCY) {
    return coinValue(text, currency) > 0;
}

/** "3 silver coins" → { count: 3, value: 10 } when the words after the number name money (coinValue), else null. */
export function countedMoney(text, currency = DEFAULT_CURRENCY) {
    const found = /^(\d{1,3}(?:,\d{3})+|\d+)\s+(.+)$/.exec(tidy(text, 200));
    if (!found) return null;
    const value = coinValue(found[2], currency);
    const count = Number(found[1].replace(/,/g, ''));
    return value > 0 && Number.isSafeInteger(count) && count > 0 ? { count, value } : null;
}

/**
 * The static prompt's coin line (one short line), or '' for a currency without coins: the coins and
 * what each is worth in the smallest unit, and how a money line is written. It changes only when the
 * coins do.
 */
export function coinLine(currency) {
    const coins = coinList(currency);
    if (!coins.length) return '';
    const base = baseUnit(currency);
    const larger = coins.filter(coin => coin.value > 1).slice(0, 6);
    const worth = larger.map(coin => `1 ${coin.name} = ${coin.value} ${base.plural}`).join(', ');
    const example = larger[0]?.name ?? base.plural;
    return `Money is counted in ${base.plural}${worth ? `: ${worth}` : ''}. A coin line names one coin (+ coin 3 ${example}) or ${base.plural} (+ coin 35); never two coins in one line.`;
}

/**
 * An amount from a coin line: the number, in the smallest unit ("30", "30 gold", "1,200 crowns"; a
 * currency without coins ignores the words). With coins, a known coin's name multiplies it ("3 silver"
 * → 30 when silver is worth 10) and any other word is refused, so no amount is read in the wrong coin.
 * { amount } or { error } with a plain sentence. Two numbers are refused, not added up.
 */
export function parseAmount(text, currency = null) {
    const { multiple = false, ...read } = parseNumber(text);
    const coined = coinList(currency).length > 0;
    if (!coined) return read;
    // "3 silver 5 copper" is two numbers: refused, with how to write it.
    if (read.error) return multiple ? { error: `${read.error.replace(/; write one amount\.$/, '')}: write it in one coin or in ${baseUnit(currency).plural} (+ coin 35).` } : read;
    const words = String(text ?? '').replace(/\d[\d,.]*/g, ' ').replace(/[^\p{L}\s'-]+/gu, ' ');
    if (!words.trim()) return read;
    const value = coinValue(words, currency);
    if (!value) return { error: `"${tidy(words, 40)}" is not a coin here: write ${coinList(currency).map(coin => coin.name).join(', ')} or a number of ${baseUnit(currency).plural}.` };
    const amount = read.amount * value;
    if (!Number.isSafeInteger(amount)) return { error: 'That amount is too large.' };
    return { amount };
}

// The number of an amount (parseAmount without coins): only plain whole digits, one number, no sign.
function parseNumber(text) {
    const numbers = String(text ?? '').match(/\d[\d,.]*/g) ?? [];
    if (!numbers.length) return { error: 'No amount of money was written.' };
    // The line's op is the only sign: "+ coin -50" is not a payment of 50 (B3-5). Any dash or minus
    // counts (C2-4: ‐ ‑ ‒ ⁻ ₋ ﹣ － as well as - − – —).
    if (/[\p{Pd}\u2212\u207B\u208B]\s*\d/u.test(String(text))) return { error: 'Write the amount without a sign; + coin or - coin says whether it is gained or paid.' };
    // C2-4: only plain digits make an amount; a fraction, a superscript, other digits or a decimal
    // point in front (".5", "٫5", "2⁵", "½5") would be paid as a different whole number.
    if (/[^\P{N}0-9]/u.test(String(text)) || /(?:^|[^\d])[.,\u066B\u066C]\d/.test(String(text))) return { error: `"${String(text).trim()}" is not a whole amount.` };
    if (numbers.length > 1) return { error: `"${String(text).trim()}" holds more than one number; write one amount.`, multiple: true };
    const written = numbers[0].replace(/[.,]$/, '');
    if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)$/.test(written)) return { error: `"${written}" is not a whole amount.` };
    const amount = Number(written.replace(/,/g, ''));
    if (!Number.isSafeInteger(amount) || amount <= 0) return { error: 'The amount must be more than nothing.' };
    return { amount };
}

/**
 * "1 mark", "44 marks" (the plural from the currency, else pluralOf(name)). With coins: mixed, largest
 * first ("3 silver 5 pennies"; nothing: "0 pennies"), or the smallest unit ("35 pennies") with
 * `display: 'base'`.
 */
export function formatAmount(amount, currency = DEFAULT_CURRENCY) {
    const n = Math.max(0, Math.round(Number(amount) || 0));
    const coins = coinList(currency);
    if (coins.length) {
        const base = baseUnit(currency);
        if (currency?.display === 'base' || n === 0) return `${n} ${n === 1 ? base.name : base.plural}`;
        const parts = [];
        let rest = n;
        const shown = coins.filter((coin, index) => coins.findIndex(other => other.value === coin.value) === index);
        for (const coin of [...shown].reverse()) {
            const count = Math.floor(rest / coin.value);
            if (!count) continue;
            parts.push(`${count} ${count === 1 ? coin.name : coin.plural}`);
            rest -= count * coin.value;
        }
        if (rest) parts.push(`${rest} ${rest === 1 ? base.name : base.plural}`);
        return parts.join(' ');
    }
    const name = currency?.name || DEFAULT_CURRENCY.name;
    return `${n} ${n === 1 ? name : currency?.plural || pluralOf(name)}`;
}

/** One wallet ({ coin: n }) as text. */
export function formatWallet(wallet, currency = DEFAULT_CURRENCY) {
    return formatAmount(wallet?.[WALLET_KEY] ?? 0, currency);
}
