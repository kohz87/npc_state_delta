// Story Suite v2: the settings host's wording and fold ids (moved out of host-ui.js unchanged; host-ui.js re-exports them).
// The ids of the folds and the class the settings window carries, and the texts the settings, Tabs, Diagnostics and Features
// folds draw. Constants only.

import { STRINGS } from '../strings.js';

export const S = STRINGS;

export const OPEN_CLASS = 'story-suite-open';
export const HOST_FOLD = 'story-suite';
export const FEATURES_FOLD = 'story-suite-features';
export const VERSIONS_FOLD = 'story-suite-versions';
export const DIAGNOSTICS_FOLD = 'story-suite-diagnostics';
// "Show what's sent", a sub-fold of Story Suite's own under the prompt size.
export const SENT_FOLD = 'story-suite::sent';
// Tabs (the reader's order for the Story panel's tabs and the game view's screens), a sub-fold of Story Suite's own.
export const TABS_FOLD = 'story-suite::tabs';
// Story Block's Packs fold (its `settings.folds`), second after Story Suite's; Home's "Import a pack" opens it.
export const PACKS_FOLD = 'story-block/packs';
// Story Block's Events (the events part's debug panel), a sub-fold of Diagnostics (its `place`).
export const EVENTS_FOLD = 'story-block/events';
// A sub-fold's key: its module's id, this, and the part ("example-module::features", "story-director::group:Calendar").
export const SUB_FOLD = '::';
// A module's sub-fold in the Features fold ("story-suite-features::example-module"); its fold's line opens it.
export const featuresFoldOf = moduleId => `${FEATURES_FOLD}${SUB_FOLD}${moduleId}`;
export const SETTINGS_TEXT = Object.freeze({
    hostHint: 'prompt and its size',
    general: 'General',
    more: 'More',
    settings: '{n} settings',
    oneSetting: '1 setting',
    featuresOn: '{on} of {n} on',
    listItem: 'item {n}',
    remove: 'Remove {name}',
    add: 'Add',
    addTitle: 'Add to {field}',
    // A list's text form (`form: 'lines'`, or "Edit as text"): one item per line, its fields split by ":".
    asText: 'Edit as text',
    asRows: 'Edit as rows',
    asTextTitle: 'Edit {field} as text, one per line',
    asRowsTitle: 'Edit {field} as rows',
    linesHelp: 'One per line, as {form}. Any number of lines, up to {max}.',
    lineError: 'Line {n} ("{line}"): {why} The list is kept as it was until every line reads.',
    lineParts: 'it needs {form}.',
    lineExtra: 'it has more than {n} parts split by ":".',
    lineWhole: '{field} is not a whole number.',
    lineMin: '{field} must be at least {min}.',
    lineMax: '{field} must be at most {max}.',
    lineCount: 'a list holds at most {max} lines.',
    size: Object.freeze({
        title: 'Prompt size',
        help: 'What Story Suite adds to the prompt of the next reply in this chat, counted now. Nothing is sent.',
        none: 'Open a chat to see what Story Suite adds to its prompt.',
        static: 'Instructions (the same every reply)',
        tail: 'This reply\'s part',
        total: 'In all',
        about: 'about {n} tokens',
        exact: '{n} tokens',
        ofBudget: '{size} of {budget}',
        perModule: 'Per module, in tokens',
        module: 'Module',
        staticShort: 'Instructions',
        tailShort: 'This reply',
        howAbout: 'Estimated at four characters a token. The budget is Notes per reply, above, or less when the context is small.',
        howExact: 'Counted with SillyTavern\'s tokenizer. The budget is Notes per reply, above, or less when the context is small.',
        context: 'Context size',
        contextValue: '{n} tokens',
        contextReply: '{n} tokens ({reply} of them for the reply)',
        share: 'Story Suite\'s share',
        shareValue: '{share} of {room} tokens ({percent}%)',
        contextUnknown: 'The context size is shown after the next reply.',
        // A module's own prompt (its `ownPrompt` hook): sent by the module itself, counted here and in the share.
        own: '{name}, sent by itself',
    }),
    // "Show what's sent": the exact text the next reply would get, per module, with Copy. Read-only.
    sent: Object.freeze({
        title: 'Show what\'s sent',
        hint: 'the exact text',
        help: 'The exact text Story Suite would add to the prompt of the next reply, built now from this chat. Nothing is sent from here.',
        static: 'Instructions (the same every reply)',
        tail: 'This reply\'s part',
        own: 'Sent by the modules themselves',
        part: '{name}: {label}',
        tokens: '{n} tokens',
        about: 'about {n} tokens',
        dropped: '{n} lines left out to fit the budget.',
        droppedOne: '1 line left out to fit the budget.',
        nothing: 'Nothing (no module adds text here now).',
        hidden: '(hidden)',
        copy: 'Copy',
        copyTitle: 'Copy all of the text below',
        copied: 'Copied.',
        copyFailed: 'It could not be copied here: the text is selected, so copy it by hand (Ctrl+C, or long-press on a phone).',
        textLabel: 'What is sent: {part}',
    }),
});
// Settings → Tabs & Packs → Tabs (view/tab-order.js keeps the choice).
export const TABS_TEXT = Object.freeze({
    title: 'Tabs',
    hint: 'order, show or hide',
    help: 'The order of the Story panel\'s tabs and the game view\'s screens, one list for both. Up and Down move one; a hidden one stays here to show again. Each one sits in the bar or under More (the main screens start in the bar). Home is always first, shown and in the bar. Scene starts hidden while another screen that shows the same is installed.',
    none: 'No module has a tab or a screen yet.',
    listLabel: 'Tabs and screens, in order',
    up: 'Up',
    down: 'Down',
    upTitle: 'Move {name} up',
    downTitle: 'Move {name} down',
    shown: 'Shown',
    inBar: 'In the bar',
    underMore: 'Under More',
    placeTitle: 'Where {name} sits: in the bar or under More',
    movedToBar: '{name} is in the bar.',
    movedToMore: '{name} is under More.',
    shownTitle: 'Show {name} in the tabs and the game view',
    homeTitle: 'Home is always first and always shown',
    hidden: 'hidden',
    activeNote: 'Shown only while it is active (during a battle, for example).',
    both: 'Story panel and game view',
    tab: 'Story panel',
    screen: 'game view',
    reset: 'Reset to default',
    resetTitle: 'Put every tab back in the default order and place, and show them all',
    movedUp: '{name} moved up.',
    movedDown: '{name} moved down.',
    nowHidden: '{name} is hidden.',
    nowShown: '{name} is shown.',
    wasReset: 'Back to the default order and places, all shown.',
    // Home's switch is locked; hiding is refused when no tab would stay shown.
    alwaysShown: 'Always shown',
    lastOne: 'At least one tab has to stay shown, so {name} stays.',
});
// The Diagnostics page (diagnostics.js builds the report; view/settings/diagnostics-page.js draws it).
export const DIAGNOSTICS_TEXT = Object.freeze({
    title: 'Diagnostics',
    // The report's fold: its summary line says what the report holds (the fold is closed until it is opened).
    reportTitle: 'Report',
    reportHint: 'versions, modules, settings',
    checksHint: 'checks for packs and modules',
    help: 'A plain report of what Story Suite sees: versions, features, settings, the prompt size, the last problems, saving and the size of this chat, and what each module adds. It holds no API keys, passwords or addresses and no chat text. Read it before you share it.',
    copy: 'Copy report',
    save: 'Save report',
    refresh: 'Refresh',
    reportLabel: 'The diagnostics report',
    building: 'Building the report…',
    copied: 'Copied the report.',
    copyFailed: 'The report could not be copied here: it is selected above, so copy it by hand (Ctrl+C, or long-press on a phone).',
    saved: 'Saved the report as {name}.',
    saveFailed: 'The report could not be saved: {why}',
    failed: 'The report could not be built: {why}',
    sample: 'Show the UI sample',
    sampleTitle: 'Every building block of Story Suite\'s look, in light and dark, for checking a theme and for screenshots',
    sampleFailed: 'The UI sample could not be shown: {why}',
    credits: 'Icons: Phosphor Icons (phosphoricons.com), MIT License.',
    repairTitle: 'Story record',
    repairHelp: 'This chat\'s saved story could not be used as it is. Story Block has not touched it and works on an empty story until you decide.',
    repairYes: 'Yes, do it',
    repairNo: 'Cancel',
    repairDone: 'Done.',
    repairFailed: 'That could not be done: {why}',
});
export const FEATURE_TEXT = Object.freeze({
    title: 'Features',
    overviewHint: 'every module',
    filter: 'Find a feature',
    filterPlaceholder: 'Name or description',
    filterNone: 'No feature matches "{text}".',
    link: 'Features: {on} of {n} on — change',
    linkTitle: 'Features of {name}: {on} of {n} on. Change them in the Features fold.',
    overviewHelp: 'Every optional part of every module. It applies to you, in every chat; turning one off keeps what the story holds for it, so turning it on again brings it all back.',
});
