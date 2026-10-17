import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    chatterBubbleKind,
    chatterSlotsHtml,
    fillPresentSceneText,
    matchPresentCard,
    NOW_PART_MAX,
    nowParts,
    nowSlotHtml,
    othersSlotsHtml,
    parseChatterLines,
    parseWorldStateNpcs,
    presentSceneModel,
    rememberPresentScene,
    sceneAttr,
    storyBlockTags,
} from '../present-scene.js';
import { ensureSuiteStylesheet, SUITE_STYLESHEET_ID } from '../suite-handshake.js';

// Present NPCs view (1.2.2), display only: the now line and NPC Inner Chatter bubbles.

const WORLD_STATE = [
    '**📅 Time:** Year 3, Redleaf 4, dusk | **🌤 Loc:** Axel | **🌡 Wx:** Clear',
    '',
    '---',
    '',
    '**🧍 Kazuma:**',
    '* *Outfit:* green tracksuit',
    '* *Visible Condition:* tired',
    '',
    '---',
    '',
    '**👥 NPCs Present:**',
    '**Yunyun:**',
    '* *Outfit:* red ribbon, black robe',
    '* *Position:* by the gate',
    '* *Mood:* nervous, hopeful',
    '* *Agenda:* be noticed',
    '- **Capt. Orrin Hask**:',
    '- Mood: stern',
    '- Visible Condition: bandaged left arm',
    '**Wiz:**',
    '* *Outfit:* [Current clothing]',
    '',
    '*[Repeat for each NPC currently in the scene]*',
    '---',
    '**📡 Off-Screen:**',
    '* Megumin is blowing something up',
].join('\n');

const cards = [
    { id: 'yun', name: 'Yunyun', aliases: ['Yun'], mood: 'shy', condition: '', outfit: 'travel cloak' },
    { id: 'orrin', name: 'Capt. Orrin Hask', aliases: [], mood: 'calm', condition: 'healthy', outfit: 'armor' },
    { id: 'wiz', name: 'Wiz', aliases: [], mood: 'cheerful', condition: '', outfit: 'shop apron' },
];

test('v1.2.2 Story Block blocks are found by display, enabled ones only, in list order', () => {
    const blocks = [
        { tag: 'World_State', display: 'scene', enabled: true },
        { tag: 'NPC_Inner_Chatter', display: 'chatter', enabled: true },
        { tag: 'Old_Chatter', display: 'chatter', enabled: false },
        { tag: 'Whispers', display: 'chatter', enabled: true },
        { tag: 'NPC_Inner_Chatter', display: 'chatter', enabled: true },
    ];
    assert.deepEqual(storyBlockTags(blocks, 'chatter'), ['NPC_Inner_Chatter', 'Whispers']);
    assert.deepEqual(storyBlockTags(blocks, 'scene'), ['World_State']);
    assert.deepEqual(storyBlockTags(null, 'scene'), []);
});

test('v1.2.2 chatter parses Name: line, tolerating bold names, quotes and dashes, keeping order', () => {
    const text = [
        '[NPC Name]: [what they say or think, in their own voice]',
        '**Yunyun:** "Did he notice my ribbon?"',
        '- Wiz: *Such a nice boy... I should offer tea.*',
        '— **Orrin**: Keep your eyes on the road.',
        '  and on the girl.',
        '---',
        'Then she said: run',
        '“Megumin”: “Explosion!”',
        'Note: this is not a person',
        '',
    ].join('\n');
    assert.deepEqual(parseChatterLines(text), [
        { speaker: 'Yunyun', line: 'Did he notice my ribbon?' },
        { speaker: 'Wiz', line: 'Such a nice boy... I should offer tea.' },
        { speaker: 'Orrin', line: 'Keep your eyes on the road. and on the girl. Then she said: run' },
        { speaker: 'Megumin', line: 'Explosion! Note: this is not a person' },
    ], 'a line that is not a speaker line (or names "Note") continues the speaker above it');
    assert.deepEqual(parseChatterLines(null), []);
});

test('v1.2.3 chatter: long known names are speakers, nothing before the first speaker is lost', () => {
    const astral = 'The Astral-Bound Spirit of the Northern Vale';
    const line = `${astral}: They followed us from the river.`;
    assert.deepEqual(parseChatterLines(line, { names: [astral] }), [{ speaker: astral, line: 'They followed us from the river.' }],
        'a tracked NPC\'s name is always a speaker, whatever its length or first word');
    assert.deepEqual(parseChatterLines(`**${astral}:** *They followed us.*`, { names: ['Yunyun', astral] }), [{ speaker: astral, line: 'They followed us.' }]);
    assert.deepEqual(parseChatterLines('The Astral-Bound Spirit of the Northern Vale: They followed us from the river.'),
        [{ speaker: astral, line: 'They followed us from the river.' }], 'up to ten words, a leading "The" before a capitalised word');
    assert.deepEqual(parseChatterLines('A Tall Stranger: Who goes there?'), [{ speaker: 'A Tall Stranger', line: 'Who goes there?' }]);
    assert.deepEqual(parseChatterLines('the guard thinks this: halt'), [{ speaker: '', line: 'the guard thinks this: halt' }],
        'an article before a lower-case word is no name, but the first line is kept without a speaker');
    assert.deepEqual(parseChatterLines('One two three four five six seven eight nine ten eleven: no'), [{ speaker: '', line: 'One two three four five six seven eight nine ten eleven: no' }]);
    assert.deepEqual(parseChatterLines('just prose with no speaker\nYunyun: Hi.'), [{ speaker: '', line: 'just prose with no speaker' }, { speaker: 'Yunyun', line: 'Hi.' }]);
    assert.deepEqual(parseChatterLines('http://example.com: not a name'), [{ speaker: '', line: 'http://example.com: not a name' }]);
    assert.deepEqual(parseChatterLines('**NPC Inner Chatter**\nInner chatter:\nWiz: Tea?'), [{ speaker: 'Wiz', line: 'Tea?' }], 'bare headings are left out');

    const cast = [{ id: 'astral', name: astral, aliases: [] }, { id: 'yun', name: 'Yunyun', aliases: [] }];
    const model = presentSceneModel({ cards: cast, chatterText: `${line}\nYunyun: It is beautiful.\nRiver Nymph of the Seven Silent Falls in Spring: Leave.` });
    assert.equal(model.kind, 'speech');
    assert.deepEqual(model.byCard.astral.map(entry => model.texts[entry.text]), ['They followed us from the river.'], 'the long name reaches its card');
    const loose = presentSceneModel({ cards: cast, chatterText: 'Something stirs in the reeds.\nYunyun: Did you hear that?' });
    assert.deepEqual(loose.others.map(other => [other.speaker, loose.texts[other.text]]), [[null, 'Something stirs in the reeds.']]);
    const others = othersSlotsHtml(loose);
    assert.match(others, /npc-state-delta-chatter-said/);
    assert.doesNotMatch(others, /npc-state-delta-chatter-speaker/, 'no empty speaker label');
});

test('v1.2.2 World State people: name headers with outfit, mood and condition bullets', () => {
    assert.deepEqual(parseWorldStateNpcs(WORLD_STATE), [
        { name: 'Kazuma', mood: '', condition: 'tired', outfit: 'green tracksuit' },
        { name: 'NPCs Present', mood: '', condition: '', outfit: '' },
        { name: 'Yunyun', mood: 'nervous, hopeful', condition: '', outfit: 'red ribbon, black robe' },
        { name: 'Capt. Orrin Hask', mood: 'stern', condition: 'bandaged left arm', outfit: '' },
        { name: 'Wiz', mood: '', condition: '', outfit: '' },
        { name: 'Off-Screen', mood: '', condition: '', outfit: '' },
    ]);
    assert.deepEqual(parseWorldStateNpcs(''), []);
});

test('v1.2.2 names match cards by exact name or alias, then by a distinctive part of the name', () => {
    assert.equal(matchPresentCard('yunyun', cards), 'yun');
    assert.equal(matchPresentCard('YUN', cards), 'yun', 'aliases count');
    assert.equal(matchPresentCard('Orrin', cards), 'orrin', 'a distinctive part of the name');
    assert.equal(matchPresentCard('Hask', cards), 'orrin');
    assert.equal(matchPresentCard('Capt.', cards), '', 'titles never identify anyone');
    assert.equal(matchPresentCard('Megumin', cards), '');
    const twins = [{ id: 'a', name: 'Sam' }, { id: 'b', name: 'sam' }];
    assert.equal(matchPresentCard('Sam', twins), '', 'ambiguous names match nobody');
    assert.equal(matchPresentCard('', cards), '');
});

test('v1.2.3 now lines: labelled Mood, Condition and Outfit, only those with a value, barely cut', () => {
    const lines = parts => parts.map(part => [part.label, part.text]);
    assert.deepEqual(lines(nowParts({ mood: 'calm', condition: 'healthy', outfit: 'armor' })), [['Mood', 'calm'], ['Condition', 'healthy'], ['Outfit', 'armor']]);
    assert.deepEqual(lines(nowParts({ mood: '', condition: '', outfit: 'apron' })), [['Outfit', 'apron']]);
    assert.deepEqual(nowParts({}), []);
    assert.deepEqual(nowParts(null), []);
    const mood = 'quietly furious about the broken promise she was made at dawn';
    const [part] = nowParts({ mood });
    assert.equal(part.text, mood, 'a long mood is no longer cut after 48 characters');
    assert.equal(part.title, mood);
    const huge = nowParts({ outfit: 'a rain-soaked travelling cloak over borrowed armor two sizes too large '.repeat(4) })[0];
    assert.ok(huge.text.length <= NOW_PART_MAX && huge.text.endsWith('…'), huge.text);
    assert.ok(huge.title.length > huge.text.length, 'the tooltip carries more than the clamped line');
});

test('v1.2.2 now line source: World State while Story Block keeps the scene, otherwise Delta\'s own', () => {
    const owned = presentSceneModel({ cards, sceneText: WORLD_STATE, sceneOwned: true });
    const text = (model, now) => now.parts.map(part => `${part.label}: ${model.texts[part.text]}`).join(' | ');
    assert.deepEqual([text(owned, owned.now.yun), owned.now.yun.source], ['Mood: nervous, hopeful | Outfit: red ribbon, black robe', 'world-state']);
    assert.deepEqual([text(owned, owned.now.orrin), owned.now.orrin.source], ['Mood: stern | Condition: bandaged left arm', 'world-state']);
    assert.deepEqual([text(owned, owned.now.wiz), owned.now.wiz.source], ['Mood: cheerful | Outfit: shop apron', 'dossier'], 'an NPC World State leaves empty keeps Delta\'s own line');
    assert.equal(owned.texts[owned.now.yun.parts[0].title], 'nervous, hopeful', 'each line has its full text for the tooltip');

    const own = presentSceneModel({ cards, sceneText: WORLD_STATE, sceneOwned: false });
    assert.deepEqual(Object.values(own.now).map(now => [text(own, now), now.source]), [
        ['Mood: shy | Outfit: travel cloak', 'dossier'], ['Mood: calm | Condition: healthy | Outfit: armor', 'dossier'], ['Mood: cheerful | Outfit: shop apron', 'dossier'],
    ], 'World State is not used while Delta keeps the scene');
});

test('v1.2.2 bubbles: speech for two or more speakers, thought for one, Others for names without a card', () => {
    assert.equal(chatterBubbleKind([]), '');
    assert.equal(chatterBubbleKind([{ speaker: 'Yunyun' }, { speaker: 'yunyun' }]), 'thought');
    assert.equal(chatterBubbleKind([{ speaker: 'Yunyun' }, { speaker: 'Wiz' }]), 'speech');

    const whispers = presentSceneModel({ cards, chatterText: 'Yunyun: Is he looking?\nMegumin: Explosion later.\nWiz: Tea, anyone?\nYun: He is!' });
    assert.equal(whispers.kind, 'speech');
    assert.deepEqual(whispers.byCard.yun.map(line => [line.order, whispers.texts[line.text]]), [[1, 'Is he looking?'], [4, 'He is!']]);
    assert.deepEqual(whispers.byCard.wiz.map(line => [line.order, whispers.texts[line.text]]), [[3, 'Tea, anyone?']]);
    assert.deepEqual(whispers.others.map(other => [other.order, whispers.texts[other.speaker], whispers.texts[other.text]]), [[2, 'Megumin', 'Explosion later.']]);
    const speech = chatterSlotsHtml(whispers, 'yun');
    assert.match(speech, /class="npc-state-delta-chatter npc-state-delta-chatter-speech"/);
    assert.match(speech, /npc-state-delta-bubble-order" aria-hidden="true">1<[\s\S]*npc-state-delta-bubble-order" aria-hidden="true">4</, 'the order lets a back-and-forth read across cards');
    assert.match(othersSlotsHtml(whispers), /npc-state-delta-chatter-others[\s\S]*>Others<[\s\S]*data-delta-text/);
    assert.equal(chatterSlotsHtml(whispers, 'orrin'), '');

    const alone = presentSceneModel({ cards, chatterText: '**Wiz:** *I hope the shop is safe.*' });
    assert.equal(alone.kind, 'thought');
    assert.match(chatterSlotsHtml(alone, 'wiz'), /npc-state-delta-chatter-thought/);
    assert.doesNotMatch(chatterSlotsHtml(alone, 'wiz'), /bubble-order/);
    assert.equal(othersSlotsHtml(alone), '');
});

test('v1.2.2 chatter text never becomes markup: slots carry indexes, text arrives by textContent', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const model = rememberPresentScene(presentSceneModel({
        cards: [{ id: 'yun', name: 'Yunyun', mood: '<b>bold</b>' }],
        chatterText: `Yunyun: ${hostile}\n<script>: x\nStranger: "${hostile}"`,
    }));
    const html = [sceneAttr(model), nowSlotHtml(model, 'yun'), chatterSlotsHtml(model, 'yun'), othersSlotsHtml(model)].join('');
    assert.doesNotMatch(html, /<img|<script|<b>|onerror/, 'no story text in the markup');
    assert.match(html, /data-delta-scene="[^"]+"/);

    // A small DOM double: fill writes textContent (and the now lines' title), only where it changed.
    const node = (attrs = {}) => ({ attrs, textContent: '', getAttribute: name => attrs[name] ?? null, setAttribute: (name, value) => { attrs[name] = String(value); } });
    const slots = [...html.matchAll(/data-delta-text="(\d+)"/g)].map(match => node({ 'data-delta-text': match[1] }));
    const titled = [...html.matchAll(/data-delta-title="(\d+)"/g)].map(match => node({ 'data-delta-title': match[1] }));
    assert.equal(titled.length, 1, 'one now line (Mood) for this card');
    const section = { getAttribute: name => (name === 'data-delta-scene' ? model.signature : null), matches: selector => selector === '[data-delta-scene]', querySelectorAll: selector => (selector === '[data-delta-text]' ? slots : (selector === '[data-delta-title]' ? titled : [])) };
    assert.equal(fillPresentSceneText(section), slots.length + titled.length);
    assert.deepEqual(slots.map(slot => slot.textContent), ['<b>bold</b>', `${hostile} <script>: x`, 'Stranger', hostile], '"<script>" is no name, so it continues the line above');
    assert.equal(titled[0].attrs.title, '<b>bold</b>', 'the tooltip is an attribute value, never markup');
    assert.equal(fillPresentSceneText(section), 0, 'unchanged text is not rewritten');
    assert.equal(fillPresentSceneText(null), 0);
    assert.equal(fillPresentSceneText({ querySelectorAll() { throw new Error('boom'); } }), 0, 'never throws');
});

test('v1.2.3 the card shows labelled now lines that wrap to two lines, the name wraps too, full text in a tooltip', () => {
    const model = presentSceneModel({ cards: [{ id: 'astral', name: 'The Astral-Bound Wanderer of the Northern Reach', mood: 'Curious; wary of the strangers at the gate', condition: '', outfit: 'starlit travelling cloak' }] });
    const html = nowSlotHtml(model, 'astral');
    assert.match(html, /^<span class="npc-state-delta-present-now">/);
    assert.match(html, /npc-state-delta-present-now-mood" data-delta-title="\d+"><span class="npc-state-delta-present-now-label">Mood:<\/span> <span class="npc-state-delta-present-now-text" data-delta-text="\d+"><\/span>/);
    assert.match(html, /npc-state-delta-present-now-outfit[^>]*><span class="npc-state-delta-present-now-label">Outfit:<\/span>/);
    assert.doesNotMatch(html, /Condition:/, 'a part without a value has no line');
    assert.doesNotMatch(html, /Curious|starlit/, 'the story text still arrives by textContent');
    assert.equal(model.texts[model.now.astral.parts[0].text], 'Curious; wary of the strangers at the gate');

    const css = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
    const rule = selector => css.match(new RegExp(`\\n${selector.replace(/[.-]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] || '';
    for (const selector of ['.npc-state-delta-present-now-part', '.npc-state-delta-present-card-name']) {
        assert.match(rule(selector), /-webkit-line-clamp: 2;/, `${selector} wraps to two lines`);
        assert.doesNotMatch(rule(selector), /white-space: nowrap|text-overflow: ellipsis/, `${selector} is not cut to one line`);
    }
    assert.match(rule('.npc-state-delta-present-card-text'), /background: rgba\(5,6,8,\.62\)/, 'readable text in a footer under the portrait');
    assert.doesNotMatch(css, /present-card-overlay/, 'no text over the portrait');
    const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    assert.match(index, /<span class="npc-state-delta-present-card-portrait">\$\{portrait\}<\/span>\s*<span class="npc-state-delta-present-card-text">/);
    assert.match(index, /class="npc-state-delta-present-chip"/, 'the compact strip stays compact');
});

test('v1.2.3 narrow panes: one full-width card per row, half a row beside its bubble; very narrow puts the bubble under; wide keeps the grid', () => {
    const css = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
    assert.match(css, /\.npc-state-delta-present-roster \{[^}]*container-type: inline-size;[^}]*container-name: npc-present;/);
    const blockOf = query => css.match(new RegExp(`@container npc-present \\(max-width: ${query}px\\) \\{([\\s\\S]*?)\\n\\}`))?.[1] || '';
    const narrow = blockOf(520);
    const tiny = blockOf(340);
    assert.ok(narrow && tiny, 'both container blocks exist');
    assert.ok(css.indexOf('@container npc-present (max-width: 520px)') > css.lastIndexOf('@media (max-width: 380px)'), 'after the screen-size rules they override');
    assert.ok(css.indexOf('@container npc-present (max-width: 340px)') > css.indexOf('@container npc-present (max-width: 520px)'), 'the very narrow fallback wins');
    const rule = (block, selector) => block.match(new RegExp(`\\.npc-state-delta-present-roster ${selector.replace(/[.-]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] || '';
    const cardRow = '.npc-state-delta-present-cell-chatter .npc-state-delta-present-card';

    assert.match(rule(narrow, '.npc-state-delta-present-grid'), /grid-template-columns: minmax\(0, 1fr\)/, 'one card per row');
    assert.doesNotMatch(rule(narrow, '.npc-state-delta-present-cell'), /grid-template-columns/, 'without chatter the card takes the whole row');
    assert.match(rule(narrow, '.npc-state-delta-present-card'), /flex-direction: row/, 'full-width card: portrait on the left, text on the right');
    assert.match(rule(narrow, '.npc-state-delta-present-card-portrait'), /flex: 0 0 42%; width: 42%;[^}]*aspect-ratio: 4 \/ 5/, 'a large portrait');
    assert.match(rule(narrow, '.npc-state-delta-present-card-name'), /line-clamp: none/, 'the name in full');
    assert.match(rule(narrow, '.npc-state-delta-present-card-role'), /white-space: normal/);
    assert.match(rule(narrow, '.npc-state-delta-present-now-part'), /-webkit-line-clamp: unset; line-clamp: none; overflow: visible;/, 'Mood / Condition / Outfit in full');
    assert.match(rule(narrow, '.npc-state-delta-present-cell-chatter'), /grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/, 'with chatter: card half, bubble half');
    assert.match(rule(narrow, cardRow), /flex-direction: column/, 'the half card: portrait on top, text under it');
    assert.match(rule(narrow, `${cardRow}-portrait`), /width: 100%;[^}]*aspect-ratio: 1 \/ 1/);
    assert.match(rule(narrow, '.npc-state-delta-chatter-speech .npc-state-delta-bubble::before'), /left: -7px;[^}]*border-right-color/, 'the pointer points left, at the card');
    assert.match(rule(narrow, '.npc-state-delta-chatter-thought .npc-state-delta-bubble::after'), /left: -19px/, 'thought circles trail toward the card');
    assert.match(rule(narrow, '.npc-state-delta-chatter-other'), /border-radius: 12px;/, 'Others are bubbles with the speaker inside');

    assert.match(rule(tiny, '.npc-state-delta-present-cell-chatter'), /grid-template-columns: minmax\(0, 1fr\)/, 'very narrow: the bubble goes under the card');
    assert.match(rule(tiny, cardRow), /flex-direction: row/, 'and the card takes the whole row again');
    assert.match(rule(tiny, '.npc-state-delta-chatter-speech .npc-state-delta-bubble::before'), /top: -7px;[^}]*border-bottom-color/, 'pointing up');

    // Wide: the card grid, the chatter under its card in the same cell.
    assert.match(css, /\.npc-state-delta-present-cell \{ display: grid; grid-template-columns: minmax\(0, 1fr\);/);
    assert.match(css, /\n\.npc-state-delta-chatter-speech \.npc-state-delta-bubble::before \{[^}]*top: -7px;/);
    assert.doesNotMatch(css, /@media \(min-width: 701px\) \{/, 'no stretched side-by-side cell on wide screens');
});

test('v1.2.2 a malformed scene shapes to nothing instead of throwing', () => {
    const model = presentSceneModel({ cards: 'nope', chatterText: { toString: () => 'x' }, sceneText: 5, sceneOwned: true });
    assert.deepEqual([model.now, model.kind, model.byCard, model.others], [{}, '', {}, []]);
    assert.equal(nowSlotHtml(null, 'x'), '');
    assert.equal(chatterSlotsHtml(undefined, 'x'), '');
    assert.equal(othersSlotsHtml({}), '');
    assert.equal(sceneAttr(null), '');
});

test('v1.2.2 the present cards render now/chatter slots and the Story Block tab fills them', () => {
    const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const tabs = fs.readFileSync(new URL('../story-block-tabs.js', import.meta.url), 'utf8');
    assert.match(index, /function inlineCardHtml\(npc, messageId, scene = null\)[\s\S]*nowSlotHtml\(scene, npc\.id\)[\s\S]*chatterSlotsHtml\(scene, npc\.id\)/);
    assert.match(index, /npc-state-delta-present-roster" data-message-id="\$\{messageId\}"\$\{sceneAttr\(scene\)\}/);
    assert.match(index, /fillPresentSceneText\(anchor\)/);
    assert.match(index, /fillPresentCast: root => fillPresentSceneText\(root\)/);
    assert.match(index, /areaOwner\('scene', settings\.sourceOfTruth\)\?\.id === 'story-block'/, 'World State only while Story Block keeps the scene');
    assert.match(tabs, /pane\.innerHTML = html;[\s\S]*api\.fillPresentCast\?\.\(pane\)/);
    assert.match(tabs, /storyBlock\.onUpdate\?\.\(\(\) => api\.renderInline\?\.\(\)\)/);
    const css = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
    assert.doesNotMatch(css, /grid-column: span 2/, 'wide: the bubble sits under its card, not in a stretched two-column cell');
    assert.match(index, /return `<div class="npc-state-delta-present-cell\$\{chatter \? ' npc-state-delta-present-cell-chatter' : ''\}" data-npc-id="\$\{escapeHtml\(npc\.id\)\}"[^`]*>\$\{card\}\$\{chatter\}<\/div>`/, 'one cell per NPC, card then chatter');
    assert.match(css, /\.npc-state-delta-chatter-thought \.npc-state-delta-bubble \{[^}]*font-style: italic; opacity: \.86;/);
    assert.match(css, /\.npc-state-delta-chatter-thought \.npc-state-delta-bubble::after \{ width: 5px; height: 5px;/, 'trailing thought circles');
});

test('v1.2.2 the settings panel carries the shared story-suite-* classes beside its own', () => {
    const sources = ['index.js', 'calendar-settings.js', 'relationship-map.js', 'full-cast.js', 'scanner-output-ui.js']
        .map(name => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
    const [index] = sources;
    for (const [own, shared] of [
        ['inline-drawer-content npc-state-delta-drawer', 'story-suite-panel'],
        ['npc-state-delta-suite-manage', 'story-suite-manage'],
        ['delta-settings-quickbar', 'story-suite-quickbar'],
        ['npc-state-delta-actions delta-settings-quick-actions', 'story-suite-actions'],
        ['delta-settings-experience', 'story-suite-folds'],
        ['delta-settings-group', 'story-suite-fold'],
        ['delta-settings-group-body', 'story-suite-fold-body'],
        ['npc-state-delta-setting-row', 'story-suite-row'],
        ['delta-setting-number', 'story-suite-number'],
        ['delta-settings-subhead', 'story-suite-subhead'],
        ['npc-state-delta-suite-warning', 'story-suite-notice'],
        ['delta-settings-danger', 'story-suite-danger'],
    ]) {
        assert.match(index, new RegExp(`class="${own} ${shared}"`), `${own} also carries ${shared}`);
    }
    for (const source of sources) {
        assert.doesNotMatch(source, /class="npc-state-delta-setting-row"|className = 'npc-state-delta-setting-row delta/, 'every settings row carries story-suite-row');
    }
    assert.match(index, /data-delta-settings-group="\$\{key\}"/, 'groups keep their data attribute');
    assert.match(index, /<i class="fa-solid fa-layer-group"><\/i> Manage all in Story Suite/);

    // suite.css is the shared copy, shipped beside suite.js and loaded once.
    const css = fs.readFileSync(new URL('../suite.css', import.meta.url), 'utf8');
    assert.match(css, /^\/\* Story Suite shared styles, v1/);
    assert.match(css, /\.story-suite-panel \.story-suite-fold \{/);
    assert.match(fs.readFileSync(new URL('../scripts/package.py', import.meta.url), 'utf8'), /support_files = \['style\.css', 'suite\.css'/);
    assert.match(index, /suiteConnected = true;\s*ensureSuiteStylesheet\(\);/);
    // Delta's own panel rules stay and win where they differ (#npc_state_delta_settings is more specific).
    const own = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
    assert.match(own, /#npc_state_delta_settings \.delta-settings-group \{ margin: 0; border: 1px solid rgba\(218,193,148,\.14\)/);
    assert.match(own, /#npc_state_delta_settings \.npc-state-delta-drawer \{ container: npc-delta-settings \/ inline-size; \}/);
});

test('v1.2.2 suite.css is linked once per page, first extension wins', () => {
    const appended = [];
    const byId = new Map();
    const doc = {
        head: { appendChild: node => { appended.push(node); byId.set(node.id, node); } },
        createElement: tag => ({ tagName: tag }),
        getElementById: id => byId.get(id) || null,
    };
    assert.equal(ensureSuiteStylesheet('https://host/ext/npc_state_delta/suite.css', doc), true);
    assert.deepEqual(appended.map(node => [node.tagName, node.rel, node.id, node.href]), [['link', 'stylesheet', SUITE_STYLESHEET_ID, 'https://host/ext/npc_state_delta/suite.css']]);
    assert.equal(ensureSuiteStylesheet('https://host/ext/other/suite.css', doc), false, 'an existing #story-suite-css is kept');
    assert.equal(appended.length, 1);
    assert.equal(ensureSuiteStylesheet('x', null), false);
    assert.equal(ensureSuiteStylesheet('x', { createElement() { throw new Error('boom'); }, head: { appendChild() {} } }), false, 'never throws');
    assert.match(ensureSuiteStylesheet.toString(), /new URL\('\.\/suite\.css', import\.meta\.url\)/);
});
