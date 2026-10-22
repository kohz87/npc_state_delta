// Every text Story Block's v2 screens and page furniture show the reader, in one place (MODULES §F56):
// English for now, kept together so a translation later is one file. Code refers to a text by its key
// (`STRINGS.bar.story`); a text with holes names them in braces (`'{n} more'`) and is filled with `fill`.
//
// * `fill(text, values)`: plain text (textContent, summaries). A hole without a value stays as written.
// * `html(text, values)`: for screen templates. The text is HTML-escaped first, then the holes are filled
//   with the values as they are, so a hole can take a template binding (`{{ it.qty }}`).
// * `jsonText(text)`: a text inside a JSON string in a template attribute (`data-props='{"label":"…"}'`).
//
// Not here: messages written by the runtime (command refusals, problems) and by other parts (the mounts,
// the settings overlay); those are their owners' texts.

function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const item of Object.values(value)) deepFreeze(item);
    }
    return value;
}

export const STRINGS = deepFreeze({
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
    },
    panel: {
        title: 'Story',
        close: 'Close the story panel',
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
        choices: 'Choices',
        choicesDescribe: 'The story offers 2 to 4 short next moves as buttons under the latest reply. A click only puts the words in your message box; you still send, edit or ignore them.',
        chatter: 'Inner chatter',
        chatterDescribe: 'Short unspoken thoughts of the people in the scene, folded away under each reply. Kept out of the story text and, unless you say so, out of later prompts.',
    },

    // Choices and Inner chatter under a reply (src/v2/extras.js, MODULES §F115).
    extras: {
        choices: 'Choices',
        choiceTitle: 'Put this in your message box (it is not sent)',
        chatter: 'Inner chatter',
        dossierTitle: 'Open {name}\'s dossier',
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
        itemNow: 'now ×{qty}',
        equipped: 'equipped: {slot}',
        wallet: 'Wallet: now {coin} {money}',
        nowAt: 'Now at {place}',
        placeCleared: 'The place was cleared',
        hereNow: 'Here now: {names}',
        nobodyNow: 'No one else is here now',
        nothing: 'Nothing changed in the inventory or the scene.',
        notApplied: 'not applied:',
        unknownKind: 'no module keeps "{kind}"',
        loot: 'Loot',
        lootPick: 'Tick what to take, then Take selected.',
        lootTake: 'Take selected',
        lootTakeTitle: 'Put the things you ticked in the party\'s bag',
        lootTaken: 'Taken.',
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
        dropAll: 'Drop all {qty}',
        dropIt: 'Yes, drop it',
        empty: 'Nothing carried yet.',
        noMatch: 'Nothing matches the filter.',
        wornTitle: 'Equipped',
        takeOff: 'Take off',
        takeOffTitle: 'Take off {name}; it stays in their pack',
        equipOn: 'Equip on…',
        equipOnTitle: 'Choose who puts on {name}',
        equipOnWho: 'Put on {name}',
        give: 'Give…',
        giveTitle: 'Hand {name} to someone else in the party',
        giveTo: 'Give to {name}',
        condTitle: 'Condition',
        lootTitle: 'To pick up',
        lootWhere: 'Loot',
        lootPick: 'Tick what to take, then Take selected.',
        lootTake: 'Take selected',
        lootTakeTitle: 'Put the things you ticked in the party\'s bag',
    },

    // `story-block/scene`.
    scene: {
        title: 'Scene',
        unnamed: 'Somewhere not yet named',
        here: 'Here',
        nobody: 'No one else is here.',
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
    // Home's line while no pack is installed (screens/packs-hint.js).
    readyHint: {
        title: 'Before you start',
        go: 'Get started',
    },
    packsHint: {
        title: 'Packs',
        none: 'No pack installed. A pack adds a ready-made setting: items, shops, places, quests and a start.',
        import: 'Import a pack',
        importTitle: 'Open the Story Suite settings at Packs',
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
