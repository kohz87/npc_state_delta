// Constants for the public sdk: event names, host settings (defaults and schema), limits, and the
// preflight classifications and name patterns. Values only; no behaviour.

// `feature` ({ id, on, prompt }) fires when the reader turns a feature on or off (MODULES §F100).
// `modules` ({ changes: [{ id, status, reason, from }] }) fires when a module becomes ready, dormant or
// restore-pending (docs/v2/LIFECYCLE.md); `from` is the status it had been announced with, null when new.
export const EVENTS = Object.freeze(['committed', 'head', 'turn', 'feature', 'modules']);
// The most change lines one reply's block may hold; the rest are one Problem (turn.js).
export const MAX_CHANGE_LINES = 150;
export const HOST_SETTINGS_DEFAULTS = Object.freeze({ tailBudget: 1500, contextShare: 40, maxChangeLines: MAX_CHANGE_LINES, callQueue: true, panelStyle: 'glass', glassStrength: 50, font: 'nunito', textSize: '100' });
export const HOST_SETTINGS_SCHEMA = Object.freeze({
    tailBudget: Object.freeze({
        type: 'int', min: 100, max: 20000, label: 'Notes per reply (tokens)',
        help: 'The most Story Suite adds to the end of each reply\'s prompt, about four characters a token.',
    }),
    contextShare: Object.freeze({
        type: 'int', min: 10, max: 90, label: 'Share of the context (%)',
        help: 'The most of SillyTavern\'s context size (less the reply) Story Suite\'s instructions and notes take together; the rest is left for the conversation. The notes are cut to fit, the instructions never are.',
    }),
    maxChangeLines: Object.freeze({
        type: 'int', min: 10, max: 1000, label: 'Change lines per reply',
        help: 'The most change lines one reply may hold; any after them are not used and the Problems list says so.',
    }),
    callQueue: Object.freeze({
        type: 'bool', label: 'Run extra calls one at a time per connection',
        help: 'Story Suite\'s own model calls (Delta\'s scan, the arc planner, Assist) wait for each other when they use the same connection profile, so a local server that answers one request at a time is never asked twice at once. Calls on different profiles still go side by side.',
    }),
    // Story Suite's look (src/v2/view/theme.js): the panels and the font, for every Story Suite screen.
    panelStyle: Object.freeze({
        type: 'choice', label: 'Panel style', options: Object.freeze([
            Object.freeze({ value: 'glass', label: 'Glass' }),
            Object.freeze({ value: 'solid', label: 'Solid' }),
            Object.freeze({ value: 'sillytavern', label: 'Follow SillyTavern' }),
        ]),
        help: 'How Story Suite\'s panels look. Glass: see-through panels over your background. Solid: less transparency and no blur. Follow SillyTavern: its own colours and blur only. Light or dark follows your SillyTavern theme either way. Solid suits a busy background or a slow device; your system\'s "reduce transparency" setting also turns Glass into Solid.',
    }),
    glassStrength: Object.freeze({
        type: 'int', min: 30, max: 90, form: 'slider', label: 'Glass strength (%)',
        help: 'How dense the Glass panels are: low shows more of your background through them, high is easier to read on a busy one. Solid ignores it.',
    }),
    font: Object.freeze({
        type: 'choice', label: 'Font', options: Object.freeze([
            Object.freeze({ value: 'nunito', label: 'Nunito (soft and round)' }),
            Object.freeze({ value: 'theme', label: 'Your theme\'s font' }),
        ]),
        help: 'Nunito comes with Story Block, so it looks the same offline and with "Forbid external media" on. "Your theme\'s font" uses the font SillyTavern\'s theme sets.',
    }),
    // The size of Story Suite's own text (view/theme.js textSizeOf, view/size.css): Normal adds nothing.
    textSize: Object.freeze({
        type: 'choice', form: 'segmented', label: 'Text size', options: Object.freeze([
            Object.freeze({ value: '100', label: 'Normal' }),
            Object.freeze({ value: '110', label: '110%' }),
            Object.freeze({ value: '120', label: '120%' }),
        ]),
        help: 'Makes the text in Story Suite\'s panels bigger: the Game view, cards, dialogs and these settings. Your SillyTavern chat text keeps its own size (SillyTavern\'s User Settings → Font scale).',
    }),
});

// A text field with no `max` of its own is held to this many characters; a list to this many rows.
export const SETTING_TEXT_MAX = 200;
export const SETTING_LIST_ROWS = 100;

/** The classes a module's stored data can be in, as sdk.preflight tells them. */
export const PREFLIGHT_CLASSES = Object.freeze(['empty', 'current', 'legacy', 'mixed', 'future', 'damaged']);
// The version of the store records this Story Block reads (record `v`, state `v`).
export const STORE_VERSION = 2;
// A module may keep version markers in a `rules` domain.
export const RULES_DOMAIN = 'rules';
export const MODULE_ID_TEXT = /^[a-z0-9][a-z0-9._-]*$/;
export const DOMAIN_TEXT = /^[a-z][a-zA-Z0-9_-]*$/;
