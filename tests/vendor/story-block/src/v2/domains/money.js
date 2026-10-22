// Money: one currency per chat (MODULES.md F1). The currency has one name, set in Story Block's
// settings (default 'gold'); the reader may rename it, never add a second. A wallet is one integer
// per owner under `coin`: wallets[owner] = { coin: 125 }. Pure.
//
// The name is singular ("1 mark"); the plural is its own setting, blank for the name + "s" ("44 marks",
// see pluralOf). The default, gold, has no plural form of its own ("44 gold").

import { cutAt } from '../../text.js';

export const WALLET_KEY = 'coin';
export const DEFAULT_CURRENCY = Object.freeze({ name: 'gold', plural: 'gold', short: 'g' });

const MAX_NAME = 24;
const MAX_SHORT = 6;

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

/**
 * The currency from this module's settings ({ currency?, currencyPlural?, currencyShort? }):
 * { name, plural, short }. The plural defaults to pluralOf(name); the short form to the name's first
 * letter, lowercased.
 */
export function currencyOf(settings) {
    const name = tidy(settings?.currency, MAX_NAME) || DEFAULT_CURRENCY.name;
    const plural = tidy(settings?.currencyPlural, MAX_NAME) || pluralOf(name);
    const short = cutAt(String(settings?.currencyShort ?? '').trim(), MAX_SHORT)
        || (name === DEFAULT_CURRENCY.name ? DEFAULT_CURRENCY.short : Array.from(name)[0].toLowerCase());
    return { name, plural, short };
}

/** True when `text` is exactly the currency's name or its plural (any case): "+ item Marks" is money. */
export function isCurrencyName(text, currency = DEFAULT_CURRENCY) {
    const word = tidy(text, 200).toLowerCase();
    if (!word) return false;
    const plural = currency?.plural || pluralOf(currency?.name);
    return word === String(currency?.name ?? '').toLowerCase() || word === String(plural).toLowerCase();
}

/**
 * An amount from a coin line: only the number counts ("30", "30 gold", "1,200 crowns"); coin words
 * are ignored. { amount } or { error } with a plain sentence. Two numbers are refused, not added up.
 */
export function parseAmount(text) {
    const numbers = String(text ?? '').match(/\d[\d,.]*/g) ?? [];
    if (!numbers.length) return { error: 'No amount of money was written.' };
    // The line's op is the only sign: "+ coin -50" is not a payment of 50 (B3-5).
    if (/[-−–—]\s*\d/.test(String(text))) return { error: 'Write the amount without a sign; + coin or - coin says whether it is gained or paid.' };
    if (numbers.length > 1) return { error: `"${String(text).trim()}" holds more than one number; write one amount.` };
    const written = numbers[0].replace(/[.,]$/, '');
    if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)$/.test(written)) return { error: `"${written}" is not a whole amount.` };
    const amount = Number(written.replace(/,/g, ''));
    if (!Number.isSafeInteger(amount) || amount <= 0) return { error: 'The amount must be more than nothing.' };
    return { amount };
}

/** "1 mark", "44 marks" (the plural from the currency, else pluralOf(name)). */
export function formatAmount(amount, currency = DEFAULT_CURRENCY) {
    const n = Math.max(0, Math.round(Number(amount) || 0));
    const name = currency?.name || DEFAULT_CURRENCY.name;
    return `${n} ${n === 1 ? name : currency?.plural || pluralOf(name)}`;
}

/** One wallet ({ coin: n }) as text. */
export function formatWallet(wallet, currency = DEFAULT_CURRENCY) {
    return formatAmount(wallet?.[WALLET_KEY] ?? 0, currency);
}
