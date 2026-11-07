// Story Block's core module identity, static prompt/grammar text, features and settings. These are the
// stable values the core part and module assembly share; no domain logic lives here.

import { DEFAULT_CURRENCY, MAX_COIN_VALUE } from '../money.js';
import { CORE_FEATURE } from '../../features.js';
import { FEATURE_TEXT } from '../../assist/index.js';
import { STRINGS } from '../../strings.js';
import { CHATTER_LIMIT } from '../../extras.js';

export const CORE_MODULE_ID = 'story-block';
export const CORE_BUDGET = 400;

// One line for the static prompt part: no names, counts or coins, so it is byte-identical every reply.
// (The coin rule is said once, in the coin kind's grammar line; the wallet line and this one do not repeat it.)
export const CORE_STATIC = 'Code keeps the inventory, the wallet, the place and who is present: use or pay only what the '
    + 'lists below hold, and write a change line for every item gained, used or lost and every arrival, departure or move.';

/** Added to the `+ item` grammar line while `story-block.gear` is on (and only then): the gear words, short, static. */
export const GEAR_ITEM_GRAMMAR = '; gear: kind: weapon|armour|shield|head|cloak|feet|accessory|bag | rarity: common|uncommon|rare|epic|legendary | DEX: +1 (at most 2 stats, held to rarity) | equipped: slot; ~ item Name | wear: scuff|tear|ruin | repair: mend|restore';

// Story Block's own optional pieces as features (MODULES §F100): the status strip and the cards under
// replies (on), the two assist helpers (off; each makes an extra model call), the state inspector (off)
// and save points (on). None of them changes the
// static prompt part. The host reads them where the piece is drawn or run (ui-host.js, runtime.js).
// `presets` (features.js, "How much to track"): { lean?, full? } says the switch in those presets (Standard is `default`);
// `false` keeps a feature out of presets. The pieces about the screen, the helpers, the tester's tools and the RPG are
// the reader's own choice, so no preset touches them.
const OUT_OF_PRESETS = false;
const LEAN_OFF = Object.freeze({ lean: false });
const LEAN_OFF_FULL_ON = Object.freeze({ lean: false, full: true });
export const CORE_FEATURES = Object.freeze([
    Object.freeze({ id: CORE_FEATURE.hud, label: STRINGS.features.hud, describe: STRINGS.features.hudDescribe, default: true, presets: OUT_OF_PRESETS }),
    Object.freeze({ id: CORE_FEATURE.cards, label: STRINGS.features.cards, describe: STRINGS.features.cardsDescribe, default: true, presets: OUT_OF_PRESETS }),
    // The pre-roll only works with a module that keeps `? check` lines.
    Object.freeze({ id: CORE_FEATURE.preroll, label: FEATURE_TEXT.classifier.label, describe: FEATURE_TEXT.classifier.describe, default: false, presets: LEAN_OFF_FULL_ON, needs: Object.freeze({ kinds: Object.freeze(['check']), why: FEATURE_TEXT.classifier.needs }) }),
    Object.freeze({ id: CORE_FEATURE.extractor, label: FEATURE_TEXT.extractor.label, describe: FEATURE_TEXT.extractor.describe, default: false, presets: OUT_OF_PRESETS }),
    // The state inspector is for testers and pack authors (off); save points are for every reader (on).
    Object.freeze({ id: CORE_FEATURE.inspector, label: STRINGS.features.inspector, describe: STRINGS.features.inspectorDescribe, default: false, presets: OUT_OF_PRESETS }),
    Object.freeze({ id: CORE_FEATURE.savepoints, label: STRINGS.features.savepoints, describe: STRINGS.features.savepointsDescribe, default: true, presets: OUT_OF_PRESETS }),
    // Choices and Inner chatter (MODULES §F115): off; on, each adds its grammar line to the static part.
    Object.freeze({ id: CORE_FEATURE.choices, label: STRINGS.features.choices, describe: STRINGS.features.choicesDescribe, default: false, presets: LEAN_OFF_FULL_ON }),
    Object.freeze({ id: CORE_FEATURE.chatter, label: STRINGS.features.chatter, describe: STRINGS.features.chatterDescribe, default: false, presets: LEAN_OFF_FULL_ON }),
    // The weather (MODULES §F120): on; its grammar line is in the static part while it is on.
    Object.freeze({ id: CORE_FEATURE.weather, label: STRINGS.features.weather, describe: STRINGS.features.weatherDescribe, default: true, presets: LEAN_OFF }),
    // Your look (MODULES §F126): on; its grammar line is in the static part while it is on.
    Object.freeze({ id: CORE_FEATURE.you, label: STRINGS.features.you, describe: STRINGS.features.youDescribe, default: true, presets: LEAN_OFF }),
    // The mounts: on; the grammar line and the narrator's line are there only while it is on.
    Object.freeze({ id: CORE_FEATURE.mounts, label: STRINGS.features.mounts, describe: STRINGS.features.mountsDescribe, default: true, presets: LEAN_OFF }),
    Object.freeze({ id: CORE_FEATURE.leanRpg, label: STRINGS.features.leanRpg, describe: STRINGS.features.leanRpgDescribe, default: false, presets: OUT_OF_PRESETS }),
    Object.freeze({ id: CORE_FEATURE.fightBoard, label: 'Fight board', describe: 'Choose each exchange on the Fight tab.', default: true, presets: OUT_OF_PRESETS }),
]);


// The chat's one currency (MODULES.md F1): its name (singular) and plural, renamable by the reader,
// never a second one.
export const CORE_SETTINGS = Object.freeze({
    section: 'Story Block',
    defaults: Object.freeze({ currency: DEFAULT_CURRENCY.name, currencyPlural: '', currencyShort: '', economyScale: '0', coins: Object.freeze([]), coinDisplay: 'mixed', chatterInPrompt: false, chatterMax: 3 }),
    schema: Object.freeze({
        currency: Object.freeze({ type: 'text', label: 'Currency (one coin: mark, crown, gold)', max: 24 }),
        currencyPlural: Object.freeze({ type: 'text', label: 'Currency, plural (blank: the name with an s)', max: 24 }),
        currencyShort: Object.freeze({ type: 'text', label: 'Currency, short form (blank: its first letter)', max: 6 }),
        // A number from 0.001 to 1000, kept as text so it can hold a fraction (MODULES §F104).
        economyScale: Object.freeze({
            type: 'text', max: 12, label: 'Money scale (0: the pack\'s)',
            help: 'How many of your coins one coin of the built-in defaults is worth, from 0.001 to 1000: 100 for a copper-coin world (a hundred copper to a built-in gold), 1 for gold. 0 or blank: the enabled pack\'s scale, else 1. Numbers a pack writes are never scaled.',
        }),
        // The world's coins (money.js coinsOf, MODULES §F108): "copper: 1", "silver: 10", smallest first.
        coins: Object.freeze({
            type: 'list', label: 'Coins (smallest first)', form: 'lines',
            of: Object.freeze({ name: Object.freeze({ type: 'text', label: 'Coin', max: 49 }), value: Object.freeze({ type: 'int', label: 'Worth', min: 1, max: MAX_COIN_VALUE }) }),
            help: 'The coins of this world and what each is worth in the smallest one, one per line: "copper: 1", "silver: 10", "gold: 100" (a plural after a slash: "penny/pennies: 1"). The wallet counts the smallest coin; "+ coin 3 silver" is 30 copper. Empty: the enabled pack\'s coins, else the one currency above.',
        }),
        coinDisplay: Object.freeze({
            type: 'choice', label: 'Coin display', options: Object.freeze([
                Object.freeze({ value: 'mixed', label: 'Mixed coins (3 silver 5 copper)' }),
                Object.freeze({ value: 'base', label: 'Smallest coin only (35 copper)' }),
            ]),
            help: 'How amounts are shown when the world has coins.',
        }),
        // MODULES §F115: chatter stays out of later prompts unless the reader asks (it would steer the story).
        chatterInPrompt: Object.freeze({ type: 'bool', group: 'Inner chatter', label: STRINGS.extras.inPrompt, help: STRINGS.extras.inPromptHelp, feature: CORE_FEATURE.chatter }),
        // The most `~ chatter` lines a reply may show; the grammar line asks for up to this many (one per NPC with something on their mind).
        chatterMax: Object.freeze({ type: 'int', min: 1, max: CHATTER_LIMIT, group: 'Inner chatter', label: STRINGS.extras.chatterMax, help: STRINGS.extras.chatterMaxHelp, feature: CORE_FEATURE.chatter }),
    }),
});
