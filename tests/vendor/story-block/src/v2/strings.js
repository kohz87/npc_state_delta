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
        showOptions: 'Choose whether to show the block as a tab or card, a short tab name and an app icon.',
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
        hiddenFlag: 'Hiding a field from the story is prompt: false on a field of its own.',
        hiddenKind: 'A field hidden from the story can only be changed by a button.',
        hiddenLine: 'The story cannot change this.',
        namesLimit: 'Give 1 to 32 values a name.',
        namesKey: 'Names go on a number field, for whole values inside its range.',
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
        card: 'Card', replyEnd: 'End of each reply', cardTone: 'Look', cardTitleLabel: 'Title', cardTextLabel: 'Text', cardButtonLabel: 'Button',
        noButton: 'None', always: 'Always', addCondition: 'Add a condition', hiddenField: 'The story cannot change this field.', tones: { info: 'Information', warn: 'Warning', end: 'The end' },
        title: 'Blocks', custom: 'Custom blocks', empty: 'No custom blocks in this story yet.',
        newBlock: 'New block', emptyBlock: 'Empty block', chooseTemplate: 'Start from a template',
        editBlock: 'Edit block', fields: 'Fields', addField: 'Add field', name: 'Block name', fieldNameLabel: 'Field name',
        fieldTypeLabel: 'Type', text: 'Text', number: 'Number', choice: 'Choice', list: 'List',
        min: 'Minimum', max: 'Maximum', defaultValue: 'Default', choices: 'Options, separated by commas',
        up: 'Move up', down: 'Move down', remove: 'Remove', purpose: 'What it is for',
        staticCount: '{n} of 2000 characters for purpose and story lines', showAs: 'Show as', ownTab: 'Own tab', card: 'Card on Home', both: 'Both',
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
        templateCounts: '{name} · {fields} fields, {buttons} buttons, {rules} rules, {timers} timers',
        icons: { 'ph-bookmark-simple': 'Bookmark', 'ph-scroll': 'Scroll', 'ph-heart': 'Heart', 'ph-lightning': 'Lightning',
            'ph-star': 'Star', 'ph-sparkle': 'Sparkle', 'ph-sword': 'Sword', 'ph-skull': 'Skull' },
    },

    editMessages: {
        onlyReader: 'Only the reader can make this edit.', itemName: 'Give the item a name.',
        itemNameLength: 'An item needs a name of 1 to 60 characters.',
        itemAdded: 'You added {item}.', itemCount: '{name} to {qty}', itemNote: "{name}'s note",
        itemGroupRenamed: '{name} to {qty}; one renamed {renamed}',
        itemSet: 'You set {detail}.', itemUnstackable: '{name} does not stack; each piece is kept separately.',
        itemEditDamaged: 'The saved item edit is damaged.', itemEditGone: 'The item for this edit has changed or is gone.',
        itemPiecesChanged: 'The separate pieces for this edit have changed.', itemDecisionChanged: 'The item or stack chosen for this edit has changed.',
        itemGroupLimit: 'Keep at most {max} pieces of this item.',
        itemGroupEquipped: 'Unequip pieces before removing them.',
        itemCannotMerge: '{name} cannot be combined with this stack.', itemQuantityLarge: 'That quantity is too large.',
        purseAmount: 'The amount must be a whole number of at least 0.', purseSet: 'You set the purse to {amount}.',
        moneyEmpty: 'Enter an amount of money.', moneyWhole: 'Enter whole amounts of the coins used here.',
        moneyUnknown: '"{name}" is not a coin here.', moneyLarge: 'That amount is too large.',
        presentReader: 'Only the reader can set the whole list.', presentList: 'Give the people present as a list.',
        presentSummary: 'Present: {names}.', nobody: 'nobody',
        fieldReader: 'Only the reader can set a field.', restorePending: 'A restore is pending.',
        pinDamaged: 'Unsupported or damaged pin.', fieldDeclared: 'Choose a declared field.',
        fieldLocked: 'This field cannot be edited.', mapKeyDeclared: 'Choose a declared map key.',
        fieldNoKeys: 'This field has no map keys.', fieldShared: 'This field is shared by the chat.',
        fieldRange: 'The value is outside this field’s allowed range.', fields: 'Fields',
        fieldSet: 'You set {module}: {field} {from} → {to}.', lockedSuffix: ' (cannot be edited)',
        fieldsSet: 'You set {module}: {changes}.', fieldsAlone: 'Give either one field or a set of fields, not both.',
        fieldsCount: 'Give between 1 and 16 fields to set.', fieldsNoMaps: 'Set a field with map keys on its own.',
        replyFull: 'This reply already holds as many changes as one reply can. Send your next message, then try again.',
        pinsFull: 'This chat has kept as many block versions as it can. Try again after your next message.',
        editBoolean: 'edit must be true or false.', textEffect: 'Text fields accept literal text or a text label within max.',
        declaredSchema: 'Expected a declared {schema} schema.', labelSchema: 'int, bool, enum or text label',
        fieldSchema: 'scalar field or fixed map',
        editableCommand: 'An editable field may call only dm.set.',
        editableField: 'An editable field must name this module and one declared field.',
        editableLocked: 'This field is not editable.', scalarKey: 'A scalar field has no map key.',
        chatCharacter: 'A chat field has no character.', noInventoryControl: 'A data module cannot use the Inventory add control.',
        onlyEditableControl: 'A data module may use only the editable inline control.',
        textComparison: 'Text may only be compared with a literal.', textNonempty: 'be nonempty text',
        inlineControl: 'An inline control must be a supported built-in on a <span>.',
    },

    // The Story Suite bar above the message box, the story panel, the drawer and the wand menu.
    bar: {
        label: 'Story Suite',
        story: 'Story',
        storyTitle: 'Open the story panel',
        game: 'Game view',
        gameTitle: 'Open the game view (Alt+G)',
        suite: 'Suite',
        suiteTitle: 'Story Suite settings',
        dismiss: 'Dismiss',
        blocked: '{module}: {reason}',
        // The screen bar (view/screen-bar.js): the navigation of the game view and the Story panel, and its More sheet.
        screens: 'Screens',
        more: 'More',
        moreSheet: 'More screens',
        moreWith: 'More, {title}',
        // An active tab with something to show (a red dot): its name says it, with the badge's words when it gave some.
        alertWord: 'alert',
        alertSlot: '{title}, {alert}',
        moreAlert: '{more}, {title}: {alert}',
        moreHint: 'Pin your {count} in Settings → Tabs',
        moreEmpty: 'Every screen is in the bar.',
    },
    panel: {
        title: 'Story',
        close: 'Close the story panel',
        tabs: 'Story panel tabs',
    },
    drawer: {
        title: 'Story Block',
        status: 'Story Block {version} (v2) · {modules}',
        settings: 'Story Suite settings',
        panel: 'Story panel',
        hud: 'Status strip above the message box',
        hudTitle: 'Show the status strip (health, place…) above the message box',
    },
    menu: {
        suite: 'Story Suite',
    },

    // Story Block's own features (MODULES §F100), in Settings → Features.
    features: {
        hud: 'Status strip',
        hudDescribe: 'The strip above the message box with the story at a glance (health, place…).',
        cards: 'Cards under replies',
        cardsDescribe: 'A small card under each reply with what it changed (each card can still be turned off on its own).',
        inspector: 'State inspector',
        inspectorDescribe: 'A read-only Inspector screen: any reply\'s story state as a tree you can search, what changed since the reply before, its receipts and its problems.',
        savepoints: 'Save points',
        savepointsDescribe: 'A Save point button on Home keeps the moment as a named branch of the chat, listed with Return here.',
        leanRpg: 'RPG',
        leanRpgDescribe: 'Party cards with stage bars, automatic dice for fights and checks, and a battle log in the reply. Uses the RPG block templates.',
        choices: 'Choices',
        choicesDescribe: 'The story offers 2 to 4 short next moves as buttons under the latest reply. A click only puts the words in your message box; you still send, edit or ignore them.',
        chatter: 'Inner chatter',
        weather: 'Weather',
        weatherDescribe: 'The story notes the weather in a few words when it changes; shown on Scene, Home and the reply\'s Status card. Descriptive only: nothing in the rules reads it.',
        chatterDescribe: 'Short unspoken thoughts of the people in the scene, shown next to each person on the World screen (on the Scene screen without Story Director). Kept out of the story text and, unless you say so, out of later prompts.',
    },

    // Choices under a reply and the Inner chatter setting (src/v2/extras.js, MODULES §F115).
    extras: {
        choices: 'Choices',
        choiceTitle: 'Put this in your message box (it is not sent)',
        inPrompt: 'Send the last reply\'s thoughts back to the story',
        inPromptHelp: 'Off: inner chatter never reaches a later prompt, so it cannot steer the story. On: the thoughts of the reply you answered go with your next message as one short note, dropped first when the notes are full.',
    },

    // The small notes under a reply (MODULES §F40).
    notes: {
        missing: 'No change lines came with this reply, so nothing in it changed the story.',
        missingTitle: 'If something did change, edit the reply to add its <Changes> block, then press Re-read.',
        edited: 'This reply was edited. The story keeps its changes as they were until you Re-read it.',
        reread: 'Re-read',
        rereadTitle: 'Read this reply\'s <Changes> block again and replace what it changed',
        rereading: 'Reading…',
        rereadFailed: 'Re-read did not work: {message}',
        unknownError: 'unknown error',
    },

    // `story-block/changes-card` and its one-line summary.
    card: {
        title: 'Changed this reply',
        editHint: 'Your edits ride on this reply: swipe or delete it to undo them; deleting the oldest remaining reply carries them forward.',
        rule: 'Rule: {name}',
        itemNow: 'now ×{qty}',
        equipped: 'equipped: {slot}',
        wallet: 'Wallet: now {coin} {money}',
        nowAt: 'Now at {place}',
        placeCleared: 'The place was cleared',
        hereNow: 'Here now: {names}',
        nobodyNow: 'No one else is here now',
        nothing: 'Nothing changed in the inventory or the scene.',
        notApplied: 'not applied:',
        assist: '(assist)',
        assistLate: '(assist, from the previous reply)',
        assistTitle: 'Read by the Assist safety net: the story told it, the reply\'s change lines left it out.',
        unknownKind: 'no module keeps "{kind}"',
        loot: 'Loot',
        lootPick: 'Tick what to take, then Take selected.',
        lootTake: 'Take selected',
        lootTakeTitle: 'Put the things you ticked in the party\'s bag',
        lootTaken: 'Taken.',
        movedTo: 'Moved to',
        hereLabel: 'here now',
        roll: ' (Roll {roll})',
        checkLine: 'd20 {d20}{roll} {mod} = {total} vs DC {dc} → {word}',
        labelJoin: ': ',
        success: 'success',
        fail: 'fail',
        storyDice: 'story said {story} / dice said {dice}',
    },
    replyCards: {
        later: 'Later',
        open: 'Open',
        headOnly: 'The story moved on: only the newest reply can act here.',
        label: 'Card',
    },
    summary: {
        none: 'No changes',
        otherOnly: 'No item, coin or place changes',
        more: '{n} more',
        moreTail: ', {n} more',
        held: '{name} ×{qty}',
        coinNow: '{n} {money} now',
        to: 'to {place}',
        placeCleared: 'place cleared',
        arrived: '{names} arrived',
        left: '{names} left',
        here: 'here: {names}',
        nobody: 'no one else here',
        two: '{a} and {b}',
        many: '{first} and {n} more',
        lootOne: '1 thing to pick up',
        lootMany: '{n} things to pick up',
        editsOne: '1 edit of yours',
        editsMany: '{n} edits of yours',
        assistedOne: '1 line from the safety net (assist)',
        assistedMany: '{n} lines from the safety net (assist)',
        refusedOne: '1 line not applied',
        refusedMany: '{n} lines not applied',
        defaultMoney: 'gold',
    },

    // `story-block/inventory`.
    inventory: {
        title: 'Inventory',
        kinds: {
            quest: 'Quest items', equipment: 'Equipment', consumable: 'Consumables',
            material: 'Materials', goods: 'Goods', money: 'Valuables',
        },
        rarities: {
            common: 'Common', uncommon: 'Uncommon', rare: 'Rare', epic: 'Epic', legendary: 'Legendary',
        },
        walletTitle: 'The party\'s money',
        addItem: '+ Add item', itemName: 'Item name', itemCount: 'Count', itemNote: 'Note', save: 'Save',
        countError: 'Enter a whole number of at least 1.', addError: 'Could not add this item.',
        editName: 'item name', editCount: 'item count', editNote: 'item note', editItem: 'item', editPurse: 'purse',
        filterLabel: 'Filter the inventory',
        find: 'Filter…',
        findTitle: 'Show only things whose name has this text',
        show: 'Show',
        everything: 'Everything',
        rarity: 'Rarity',
        any: 'Any',
        equippedOnly: 'Equipped only',
        equippedTitle: 'Equipped',
        key: 'Key',
        keyTitle: 'A key item: yours to use, but it can\'t be sold',
        carry: 'carry',
        carryTitle: 'Adds this much carry capacity while it is owned (equipment: while it is worn)',
        equip: 'Equip',
        equipTitle: 'Equip {name}',
        unequip: 'Unequip',
        unequipTitle: 'Take off {name}',
        drop: 'Drop',
        dropTitle: 'Drop {name}',
        dropOne: 'Drop 1',
        dropAsk: 'Drop {name}?',
        cancel: 'Cancel',
        dropAll: 'Drop all {qty}',
        empty: 'Nothing carried yet.',
        noMatch: 'Nothing matches the filter.',
        wornBy: 'Worn by {name}',
        wornByParty: 'Worn by the party',
        equipOn: 'Equip on…',
        equipOnTitle: 'Choose who puts on {name}',
        equipOnWho: 'Put on {name}',
        useOn: 'Use on…',
        useOnTitle: 'Choose who uses {name}',
        useOnWho: 'Use {name} on them',
        condTitle: 'Condition',
        lootTitle: 'To pick up',
        lootWhere: 'Loot',
        lootPick: 'Tick what to take, then Take selected.',
        lootTake: 'Take selected',
        lootTakeTitle: 'Put the things you ticked in the party\'s bag',
    },

    // `story-block/scene`.
    scene: {
        editPlace: 'place', editWeather: 'weather', editPresent: 'people present',
        title: 'Scene',
        unnamed: 'Somewhere not yet named',
        here: 'Here',
        nobody: 'No one else is here.',
        weather: 'Weather',
    },

    // `story-block/home`.
    // The state inspector (MODULES §F92): read-only, one reply at a time.
    inspector: {
        title: 'Inspector',
        reply: 'Reply',
        pick: 'Which reply to look at',
        latest: 'Latest',
        older: 'Older reply',
        newer: 'Newer reply',
        option: 'Message {index}{name} · rev {rev}{head}',
        headMark: ' (now)',
        none: 'This chat has no story state yet.',
        heading: 'Message {index}{name} · rev {rev}',
        checkpoint: 'starts a checkpoint',
        changed: 'Changed since the reply before',
        noChange: 'Nothing changed in this reply.',
        moreChanges: '…and {n} more',
        receipts: 'Receipts',
        noReceipts: 'No receipts on this reply.',
        problems: 'Problems',
        noProblems: 'No problems with this reply.',
        ops: 'Ops ({n})',
        state: 'State',
        search: 'Search the state',
        searchHint: 'Search keys and values',
        found: '{n} found',
        foundCapped: 'the first {n} found',
        notFound: 'Nothing found.',
        moreKeys: '…and {n} more',
        untold: 'not told',
    },
    // Save points (MODULES §F93): named SillyTavern branches the reader can return to.
    savepoints: {
        title: 'Save points',
        save: 'Save point',
        saveTitle: 'Keep this moment as a save point (a branch of the chat you can return to)',
        name: 'Name',
        namePlaceholder: 'Save point {n}',
        create: 'Save',
        cancel: 'Cancel',
        returnHere: 'Return here',
        returnTitle: 'Open the branch made at this save point',
        here: 'You are here',
        remove: 'Forget',
        removeTitle: 'Take this save point off the list (the branch itself is kept in SillyTavern)',
        none: 'No save points in this chat yet.',
        at: 'Message {index}',
        saved: 'Saved "{name}".',
        failed: 'The save point was not made: {reason}',
        returnFailed: 'Could not return there: {reason}',
    },
    // A long card's toggle (screens/show-more.js).
    showMore: {
        more: 'Show all',
        less: 'Show less',
    },
    // Home's "Before you start" while a module holds the story back (screens/ready-hint.js).
    readyHint: {
        title: 'Before you start',
        go: 'Get started',
    },
    home: {
        title: 'Home',
        level: 'Level {level}',
        hp: 'HP',
        mp: 'MP',
        sp: 'SP',
        party: 'Party',
        fight: 'Fight',
        fightOn: 'A fight is under way.',
        fightOpen: 'Open the Fight screen to act.',
        ahead: 'Ahead:',
        toTheDeath: 'to the death',
        where: 'Where',
        unnamed: 'Somewhere not yet named',
        here: 'Here:',
        purse: 'Purse and pack',
        thing: 'thing',
        things: 'things',
        carried: 'carried',
        quests: 'Quests',
        progress: 'Progress',
        moreQuests: 'and more on the Quests screen',
        offered: 'Offered',
    },
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
