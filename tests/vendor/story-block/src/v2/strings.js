// Every text Story Block's v2 screens and page furniture show the reader, in one place (MODULES §F56):
// English for now, kept together so a translation later is one file. Code refers to a text by its key
// (`STRINGS.bar.story`); a text with holes names them in braces (`'{n} more'`) and is filled with `fill`.
//
// * `fill(text, values)`: plain text (textContent, summaries). A hole without a value stays as written.
// * `html(text, values)`: for screen templates. The text is HTML-escaped first, then the holes are filled
//   with the values as they are, so a hole can take a template binding (`{{ it.qty }}`).
// * `jsonText(text)`: a text inside a JSON string in a template attribute (`data-props='{"label":"…"}'`).
//
// Existing messages written by the runtime and other parts stay with their owners; inline-edit messages are below.

import { MESSAGE_STRINGS } from './strings/messages.js';
import { PAGE_STRINGS } from './strings/page.js';
import { SCREEN_STRINGS } from './strings/screens.js';

function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const item of Object.values(value)) deepFreeze(item);
    }
    return value;
}

export const STRINGS = deepFreeze({
    editable: {
        edit: 'Edit {label}', value: 'value', save: 'Save', cancel: 'Cancel', add: 'Add',
        remove: 'Remove {value}', wholeNumber: 'Enter a whole number.', failed: 'Could not save this change.',
        fieldWholeNumber: '{label}: enter a whole number.', fieldRange: '{label}: use a number from {min} to {max}.',
    },

    blocks: {
        reservedPack: 'The pack id "chat" is reserved for blocks made in this chat.',
        origin: 'Made in this chat', reader: 'Only the reader can change a block.',
        chatScope: 'A block must have chat scope.', exists: 'A block with this name is already active.',
        limit: 'This chat already has the maximum number of blocks and data modules.',
        blockLimit: 'This chat can have at most 8 blocks.',
        chatOnly: 'Only a block made in this chat can be changed here.',
        sameSlug: 'Keep the block identifier when changing its fields.',
        defined: 'You made {name}.', redefined: 'You changed {name}.', removed: 'You removed {name}.',
        promptLimit: 'What it is for must be at most 1200 characters.',
        staticLimit: 'The purpose and story lines together must fit 2000 characters.',
        showOptions: 'Choose where the block shows (its own tab, a card on Home, both or neither), a short tab name and an app icon.',
        // How a block's records, numbers and fields are drawn (screens/block-layouts.js).
        view: { active: 'Active ({n})', finished: 'Finished ({n})', more: 'More', less: 'Less', unknown: 'Not known yet ({n})', known: '{n} of {total} known',
            nothing: 'Nothing here yet.', editQuest: 'Edit {name}', edited: 'Edit' },
        listOnlyText: 'A list must be a text field.', listLimit: 'A list can have at most 12 entries.',
        labelLimit: 'Use a name of 1 to 60 characters.', choiceLimit: 'A choice needs 2 to 32 different options.',
        functionLimit: 'A block can have at most 8 functions.', chooseField: 'Choose a field.',
        kindLimit: 'A block can have at most 16 fields and buttons in total.',
        kindCount: '{n} of 16 used: each field and each button uses one.',
        timerNumber: 'A timer can only add to a number field.',
        chooseFunction: 'Choose a valid function and effect.', fieldType: 'Choose a field type.',
        blockName: 'Give the block a name.', fieldName: 'Give each field a different name.',
        templatesFull: 'You can save at most 16 block templates.', templateExists: 'A template with this name already exists.',
        templateMissing: 'That template is no longer available.', templateLarge: 'This block is too large to save as a template.',
        exportFailed: 'Could not export this block.',
        unsupportedEdit: 'This block has details the editor cannot change safely.',
        madeFromTemplate: 'Made from a template: edit its fields here, its rules in the pack file.',
        replyFull: 'This reply has used all the block actions it can take, and the last place is kept for settling it; this line was not applied.',
        stagesLimit: 'A bar field (health, mana, stamina, a foe\'s health) has at most {max} stages, counted up from 0.',
        roleInvalid: 'A block role is character, skills, foes or rules.',
        roleChat: 'A block with a role belongs to the chat: give it scope chat, one block for each person.',
        entriesMax: 'A list of entries holds 1 to {max} entries.',
        entrySubName: 'A part of an entry is named with one lowercase word (not at, kind or who).',
        entrySubType: 'A part of an entry is a text, a number or a choice.',
        entryKindOnly: 'Adding, changing or dropping an entry is a story line, not a rule or a timer.',
        entryPath: 'This line must name a list of entries field.',
        entryAt: 'Changing or dropping an entry needs an at label (its number or title), and adding one has none.',
        entryLabel: 'A label of an entries line must be a part of the entry, of the same kind and no wider.',
        layoutInvalid: 'A layout is cards, bars or fields.',
        layoutBarsNumbers: 'Bars need every field to be a number.',
        rolesNeeded: 'A list of cards needs roles: the list and which part is the title.',
        rolesCards: 'Roles belong to the cards layout.',
        rolesField: 'Roles name a field that is a list of entries.',
        rolesSub: 'A role names a part of the entry of the right kind: a text for the title and the step, a choice for the status.',
        tonesNeedStatus: 'Tones need a status role.',
        tonesInvalid: 'A tone is for one of the status values and is active, done, failed or neutral.',
        entriesFormula: 'A list of entries is changed by its own lines; a rule, timer or condition cannot read or set it.',
        // The block editor: starters, layout, card roles, tones, show in tab, preview.
        entries: 'List of entries', entriesMaxLabel: 'Most entries', addPart: 'Add part', partName: 'Part name', partsOf: 'Parts of one entry',
        startFrom: 'Start from', starterEmpty: 'Empty', starterEmptyAbout: 'Add your own fields.', replaceFields: 'Replace the fields?',
        starterFilled: 'Filled: {fields}, the {layout} layout{roles}. Change any of it before you save.', starterRoles: ', and the card roles',
        starterFields: '{n} of 16 fields used',
        layout: 'Layout', layoutCards: 'List of cards', layoutBars: 'Numbers with bars', layoutFields: 'Card of fields',
        layoutEmpty: 'Add fields and the layout is chosen from their shape.',
        layoutCardsNeed: 'A list of cards needs a List of entries field with a text part for each card\'s title.',
        layoutCardsTitle: 'A list of cards needs a text part for each card\'s title; your list has none.',
        layoutBarsNot: 'Bars need every field to be a number; not a number: {names}.',
        whyCards: 'Your block holds a list of entries: {name}.', whyBars: 'All {n} of your fields are numbers with a range.',
        whyFields: 'Your block holds one record: {n} different fields.', whyChosen: 'Chosen by you. ', whyStarter: 'Set by the {name} starter. ',
        layoutFell: 'Your block changed shape, so the layout is now {name}.',
        cardRoles: 'Card roles', roleList: 'List', roleTitle: 'Title', roleStatus: 'Status', roleStep: 'Step', roleNone: 'None',
        rolesGuessed: 'Guessed from the part names; change them if wrong.', rolesAlso: 'Also on the card: {text}',
        statusColours: 'Status colours', toneActive: 'Accent', toneDone: 'Green', toneFailed: 'Red', toneNeutral: 'Neutral',
        showInTab: 'Show in tab', showOwnTab: 'Its own tab (default)', showHeading: 'Section heading', showIntoHint: 'The block is drawn as one more section under its own heading in that tab.',
        showNeedsTab: 'Needs Own tab or Both',
        preview: 'Preview', previewExample: 'Example values; yours appear as the story writes them.', previewNothing: 'Nothing to preview until the block has fields.',
        previewOwn: 'Drawn in its own tab "{name}".', previewInto: 'Drawn as a section of the {tab} tab.', previewBroken: 'The preview appears when the form is complete.',
        previewMore: 'Finished ({n})',
        entrySubsLimit: 'A list of entries needs 1 to 8 parts.',
        entriesFull: 'The list is full.', entryMissing: 'There is no such entry.', entryAmbiguous: 'More than one entry has that title; use its number.',
        entryDropped: 'Entry {n} was dropped earlier in this reply.',
        entryDuplicate: 'There is already an entry with that title; change it by its number or title.',
        listShrinks: 'The list {name} holds {n} entries now, so Most entries cannot go below {n}.',
        listTooBig: 'The list {name} cannot be stored at that size: {max} entries of up to {chars} characters each come to about {kb} KB and a block keeps {limit} KB. Lower Most entries to {fit} or shorten the parts.',
        entryEmpty: 'Give the entry something to say.',
        hiddenFlag: 'Hiding a field from the story is prompt: false on a field of its own.',
        hiddenKind: 'A field hidden from the story can only be changed by a button.',
        hiddenLine: 'The story cannot change this.',
        namesLimit: 'Give 1 to 32 values a name.',
        namesKey: 'Names go on a number field, for whole values inside its range.',
        blocksKey: 'Blocks go on a number field of a block with a role and say which bar it is: health, stamina, mana or foe.',
        namesText: 'A name is 1 to 40 characters and not a number.',
        namesSame: 'Two values have the same name.',
        namesInvalid: 'Write one name per line as "value = name", for values inside the range.',
        cardsChat: 'Cards belong to blocks made for the chat.',
        functionType: 'This function is listed under the wrong type.',
        cardTitle: 'A card title is 1 to 60 characters.', cardText: 'A card text is at most 240 characters.',
        cardButton: 'A card button must be a button of this block that asks for nothing.',
        replyEndPlain: 'An end-of-reply function changes only the fields of its own block.',
        names: 'Names', namesHelp: 'One per line: value = name',
        leanRpg: 'RPG', templateAdded: 'Added {name}.',
        cardKind: 'Card', replyEnd: 'End of each reply', cardTone: 'Look', cardTitleLabel: 'Title', cardTextLabel: 'Text', cardButtonLabel: 'Button',
        noButton: 'None', always: 'Always', addCondition: 'Add a condition', hiddenField: 'The story cannot change this field.', tones: { info: 'Information', warn: 'Warning', end: 'The end' },
        title: 'Blocks',
        // Settings → Blocks (view/settings/blocks.js, screens/blocks.js `page`).
        page: {
            sub: 'Trackers for this story: make one, change it, and choose where it shows.',
            noChat: 'Blocks belong to a story. Open a chat to make or change its blocks.',
            none: 'No blocks in this story yet.',
            fromTemplate: 'From a template', noTemplates: 'No templates yet. Use ⋯ → Save as template on a block to keep one.',
            count: '{blocks} in this story · {where}', nothingShown: 'none shown',
            block: { one: 'block', other: 'blocks' }, tab: { one: 'tab', other: 'tabs' }, card: { one: 'card', other: 'cards' },
            showAs: 'Show as', showAsFor: 'Show {name} as',
            show: { tab: 'Its own tab', card: 'A card on Home', both: 'Both', hidden: 'Hidden' },
            edit: 'Edit', editFor: 'Edit {name}', menuFor: 'More for {name}',
            fields: { one: 'field', other: 'fields' }, buttons: { one: 'button', other: 'buttons' }, rules: { one: 'rule', other: 'rules' }, timers: { one: 'timer', other: 'timers' },
            whereTab: 'tab "{name}", icon {icon}', whereCard: 'on Home', whereHidden: 'hidden',
            rpg: 'RPG', roles: { character: 'Character', skills: 'Skills', foes: 'Foes', rules: 'Rules' },
            rpgShown: { character: 'Shown by the RPG in the Party tab', skills: 'Shown by the RPG in the Party tab', foes: 'Shown by the RPG in the Fight tab',
                rules: 'Used by the RPG; its text is in Settings → RPG' },
            rpgOption: { character: 'Party tab (RPG)', skills: 'Party tab (RPG)', foes: 'Fight tab (RPG)', rules: 'RPG settings' },
            // With the RPG off there is no Party or Fight tab: the block is only data, used by the RPG when it is on.
            rpgIdle: { character: 'Used by the RPG when it is on', skills: 'Used by the RPG when it is on', foes: 'Used by the RPG when it is on',
                rules: 'Used by the RPG when it is on; its text is in Settings → RPG' },
            rpgIdleOption: { character: 'The RPG, when it is on', skills: 'The RPG, when it is on', foes: 'The RPG, when it is on', rules: 'RPG settings' },
            shownAs: '{name} is now shown as: {how}.', removed: 'Removed {name}.',
            note: 'Blocks belong to this story. A block shown as its own tab gets a tab in the Game view, with the name and icon you give it (Edit → Show as). RPG blocks are shown by the RPG\'s own tabs while it is on. Block templates you save are in Tabs & Packs, for any story.',
        },
        newBlock: 'New block',
        editBlock: 'Edit block', fields: 'Fields', addField: 'Add field', name: 'Block name', fieldNameLabel: 'Field name',
        fieldTypeLabel: 'Type', text: 'Text', number: 'Number', choice: 'Choice', list: 'List',
        min: 'Minimum', max: 'Maximum', defaultValue: 'Default', choices: 'Options, separated by commas',
        up: 'Move up', down: 'Move down', remove: 'Remove', purpose: 'What it is for',
        staticCount: '{n} of 2000 characters for purpose and story lines', showAs: 'Show as', ownTab: 'Own tab', card: 'Card on Home', both: 'Both', hidden: 'Hidden',
        tabName: 'Tab name', icon: 'Tab icon', functions: 'Functions', addButton: 'Add button', addRule: 'Add rule', addTimer: 'Add timer',
        timerNeeds: 'Timers need Story Director’s clock.', functionName: 'Name', button: 'Button', rule: 'Rule', timer: 'Timer',
        every: 'Every N minutes', whenField: 'When field', comparison: 'Comparison', whenValue: 'Value',
        is: 'is', isNot: 'is not', below: 'below', above: 'above', atMost: 'at most', atLeast: 'at least',
        effectField: 'Field', effectAction: 'Do', setTo: 'Set to', add: 'Add', effectValue: 'Value', addStep: 'Add step',
        save: 'Save block', cancel: 'Cancel', savedWithReply: 'Saved with the latest reply.',
        menu: 'Block actions', editFields: 'Edit fields', saveTemplate: 'Save as template', exportPack: 'Export as pack',
        removeBlock: 'Remove block', confirmRemove: 'Remove this block from the chat?', confirmReplace: 'Replace the saved template with this name?',
        templateSaved: 'Template saved.', templateDeleted: 'Template deleted.', templates: 'Block templates', noTemplates: 'No block templates saved.',
        deleteTemplate: 'Delete template', timerUnavailable: 'Timers need Story Director’s clock.',
        newFieldName: 'Field {n}', newFunctionName: '{type} {n}',
        templateCounts: '{name} · {fields}, {buttons}, {rules}, {timers}',
        icons: { 'ph-bookmark-simple': 'Bookmark', 'ph-scroll': 'Scroll', 'ph-heart': 'Heart', 'ph-lightning': 'Lightning',
            'ph-star': 'Star', 'ph-sparkle': 'Sparkle', 'ph-sword': 'Sword', 'ph-skull': 'Skull' },
    },

    ...MESSAGE_STRINGS,
    ...PAGE_STRINGS,
    ...SCREEN_STRINGS,
});

const HOLE = /\{(\w+)\}/g;

/** `text` with each `{name}` replaced by `values[name]` (a hole without a value stays as written). */
export function fill(text, values = {}) {
    return String(text ?? '').replace(HOLE, (hole, name) => (Object.hasOwn(values, name) && values[name] !== undefined && values[name] !== null ? String(values[name]) : hole));
}

/** What a reader sees when a command was refused: a full reply budget or a chat that holds as many block versions as it can, in plain words (`pinsFull` words the second), else the refusal's own sentence (or `fallback`). */
export function refusalText(result, fallback = '', { pinsFull = STRINGS.editMessages.pinsFull } = {}) {
    if (result?.code === 'DM_BUDGET') return /Retained pin budget exhausted/.test(String(result.message ?? '')) ? pinsFull : STRINGS.editMessages.replyFull;
    return result?.message || fallback;
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' };

/** `text` escaped for HTML (text and quoted attributes). */
export const escapeHtml = text => String(text ?? '').replace(/[&<>"']/g, char => ESCAPES[char]);

/**
 * For screen templates: `text` HTML-escaped, then its holes filled with `values` as they are (template
 * bindings such as `{{ it.qty }}`, or markup the caller wrote).
 */
export function html(text, values = {}) {
    return fill(escapeHtml(text), values);
}

/** `text` as the inside of a JSON string, escaped for an HTML attribute (a widget's `data-props`). */
export const jsonText = text => escapeHtml(JSON.stringify(String(text ?? '')).slice(1, -1));
