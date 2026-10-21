import test from 'node:test';
import assert from 'node:assert/strict';

import {
    NARRATION_CAPTURE_REMINDER,
    buildNarrationCapturePrompt,
    buildNarrationCaptureParts,
    buildScannerPrompt,
    createNpcRecord,
    extractNarrationCapture,
    mergeScanResult,
    parseNarrationCapture,
    storyProse,
    stripUiNoise,
    tagScanEvidence,
} from '../core.js';

// One-pass narration capture: the roleplay reply ends with a hidden quick-scan block that the
// extension strips before anything reads the message and merges instead of a scanner request.
const BLOCK_JSON = '{"npcs":[{"name":"Yunyun","present":true}]}';
const STORY = 'Yunyun waves from the gate and calls Kazuma over.';

test('extraction strips the comment form and keeps its body as raw', () => {
    const result = extractNarrationCapture(`${STORY}\n\n<!--npc_state_delta\n${BLOCK_JSON}\n-->`);
    assert.deepEqual(result, { text: STORY, raw: BLOCK_JSON, status: 'found' });
});

test('the tagged form is stripped only in lenient mode', () => {
    const text = `${STORY}\n<npc_state_delta version="1">\n${BLOCK_JSON}\n</npc_state_delta>\n`;
    assert.deepEqual(extractNarrationCapture(text, { lenient: true }), { text: STORY, raw: BLOCK_JSON, status: 'found' });
    assert.deepEqual(extractNarrationCapture(text), { text, raw: '', status: 'none' }, 'strict mode leaves the tag form untouched');
});

test('a trailing ```json fence that opens with {"npcs" is stripped only in lenient mode', () => {
    const fencedText = `${STORY}\n\n\`\`\`json\n${BLOCK_JSON}\n\`\`\`\n  `;
    assert.deepEqual(extractNarrationCapture(fencedText, { lenient: true }), { text: STORY, raw: BLOCK_JSON, status: 'found' });
    assert.deepEqual(extractNarrationCapture(fencedText), { text: fencedText, raw: '', status: 'none' }, 'strict mode leaves a fence untouched');
    const bare = extractNarrationCapture(`${STORY}\n\`\`\`\n${BLOCK_JSON}\n\`\`\``, { lenient: true });
    assert.deepEqual(bare, { text: STORY, raw: BLOCK_JSON, status: 'found' }, 'the language tag is optional');
});

test('a fence that is not trailing, or is not an npcs object, stays in the story', () => {
    const midStory = `${STORY}\n\`\`\`json\n${BLOCK_JSON}\n\`\`\`\nShe laughs afterwards.`;
    assert.equal(extractNarrationCapture(midStory, { lenient: true }).status, 'none');
    assert.equal(extractNarrationCapture(midStory, { lenient: true }).text, midStory);
    const otherJson = `${STORY}\n\`\`\`json\n{"spell":"Explosion"}\n\`\`\``;
    assert.equal(extractNarrationCapture(otherJson, { lenient: true }).status, 'none');
    assert.equal(extractNarrationCapture(otherJson, { lenient: true }).text, otherJson);
});

test('the fence body never crosses another fence', () => {
    const crossing = 'Story A.\n```json\n{"npcs":[]}\n```\nStory B\n```\nStatus\n```';
    assert.deepEqual(extractNarrationCapture(crossing, { lenient: true }), { text: crossing, raw: '', status: 'none' }, 'story B and the status block survive');
    const earlierCode = 'Story.\n```\ncode\n```\nMore.\n```json\n{"npcs":[]}\n```';
    const result = extractNarrationCapture(earlierCode, { lenient: true });
    assert.equal(result.status, 'found');
    assert.equal(result.raw, '{"npcs":[]}');
    assert.equal(result.text, 'Story.\n```\ncode\n```\nMore.', 'only the trailing npcs fence is removed');
});

test('a closing --> at the very end wins over a --> inside the JSON', () => {
    const json = '{"npcs":[{"name":"Yunyun","goal":"A --> B"}]}';
    const result = extractNarrationCapture(`${STORY} <!--npc_state_delta\n${json}\n-->\n`);
    assert.deepEqual(result, { text: STORY, raw: json, status: 'found' }, 'nothing of the block leaks into the story');
    assert.equal(parseNarrationCapture(result.raw).npcs[0].goal, 'A --> B');
    const twoBlocks = extractNarrationCapture(`A <!--npc_state_delta {"npcs":[1]} --> B <!--npc_state_delta ${json} -->`);
    assert.equal(twoBlocks.raw, json, 'the last block keeps its inner arrow');
    assert.doesNotMatch(twoBlocks.text, /npc_state_delta|-->|npcs/);
});

test('an unterminated comment at the end is stripped in both modes; an unterminated tag only when lenient', () => {
    const commentText = `${STORY}\n<!--npc_state_delta\n{"npcs":[{"name":"Yun`;
    for (const lenient of [false, true]) {
        const comment = extractNarrationCapture(commentText, { lenient });
        assert.equal(comment.status, 'unterminated');
        assert.equal(comment.text, STORY);
        assert.equal(comment.raw, '{"npcs":[{"name":"Yun');
        assert.equal(parseNarrationCapture(comment.raw), null, 'a cut-off body never parses');
    }
    const taggedText = `${STORY}\n<npc_state_delta>{"npcs":[`;
    const tagged = extractNarrationCapture(taggedText, { lenient: true });
    assert.equal(tagged.status, 'unterminated');
    assert.equal(tagged.text, STORY);
    assert.equal(tagged.raw, '{"npcs":[');
    assert.equal(extractNarrationCapture(taggedText).status, 'none');
    assert.equal(extractNarrationCapture(taggedText).text, taggedText);
});

test('multiple comment blocks are all stripped and the last body is kept', () => {
    const text = 'Opening line. <!--npc_state_delta {"npcs":[{"name":"First"}]} -->Middle line.\n\n<!--npc_state_delta\n{"npcs":[{"name":"Last"}]}\n-->\n';
    for (const lenient of [false, true]) {
        const result = extractNarrationCapture(text, { lenient });
        assert.equal(result.status, 'found');
        assert.equal(result.raw, '{"npcs":[{"name":"Last"}]}');
        assert.equal(result.text, 'Opening line. Middle line.');
    }
    const mixed = extractNarrationCapture('A <!--npc_state_delta {"npcs":[1]} --> B <npc_state_delta>{"npcs":[2]}</npc_state_delta> C <!--npc_state_delta {"npcs":[3]} -->', { lenient: true });
    assert.equal(mixed.raw, '{"npcs":[3]}');
    assert.doesNotMatch(mixed.text, /npc_state_delta|npcs/);
    const strictMixed = extractNarrationCapture('A <!--npc_state_delta {"npcs":[1]} --> B <npc_state_delta>{"npcs":[2]}</npc_state_delta>');
    assert.equal(strictMixed.raw, '{"npcs":[1]}');
    assert.equal(strictMixed.text, 'A  B <npc_state_delta>{"npcs":[2]}</npc_state_delta>', 'strict mode removes only the comment');
});

test('text without a block is returned unchanged, including trailing whitespace', () => {
    const plain = `${STORY}\n\n   `;
    const result = extractNarrationCapture(plain);
    assert.equal(result.status, 'none');
    assert.equal(result.raw, '');
    assert.equal(result.text, plain, 'the same string comes back; whitespace is trimmed only when a block was removed');
    assert.deepEqual(extractNarrationCapture(undefined), { text: '', raw: '', status: 'none' });
    assert.deepEqual(extractNarrationCapture(null), { text: '', raw: '', status: 'none' });
    // Leading whitespace survives even when a block is removed; only the tail is trimmed.
    assert.equal(extractNarrationCapture(`  ${STORY} <!--npc_state_delta {"npcs":[]} -->\n\n`).text, `  ${STORY}`);
});

test('parseNarrationCapture returns the parsed object or null', () => {
    assert.deepEqual(parseNarrationCapture(BLOCK_JSON), JSON.parse(BLOCK_JSON));
    assert.equal(parseNarrationCapture(''), null);
    assert.equal(parseNarrationCapture('   \n'), null);
    assert.equal(parseNarrationCapture(undefined), null);
    assert.equal(parseNarrationCapture('{"npcs": [ {"name": '), null, 'malformed JSON is null, not an exception');
    assert.equal(parseNarrationCapture('not json at all, just prose'), null);
    assert.equal(parseNarrationCapture('42'), null, 'a non-object value is null');
    assert.equal(parseNarrationCapture('"just a string"'), null);
});

test('stripUiNoise removes comment blocks (strict) before any transcript reads the message', () => {
    for (const block of [
        `<!--npc_state_delta\n${BLOCK_JSON}\n-->`,
        '<!--npc_state_delta {"npcs":[{"name":"Cut',
        '<!--npc_state_delta {"npcs":[{"goal":"A --> B"}]} -->',
    ]) {
        const cleaned = stripUiNoise(`${STORY}\n\n${block}`);
        assert.doesNotMatch(cleaned, /npc_state_delta|"npcs"|-->/, block);
        assert.match(cleaned, /Yunyun waves from the gate/);
    }
    // The lenient near-miss forms are not capture syntax for the transcript reader.
    assert.match(stripUiNoise(`${STORY}\n\`\`\`json\n${BLOCK_JSON}\n\`\`\``), /"npcs"/);
});

const TRANSCRIPT = 'Kazuma: Who is that at the gate?\nMegumin: Yunyun waves from the gate, clutching her wand.';
const promptOptions = (extra = {}) => ({
    transcript: TRANSCRIPT,
    existingNpcs: [],
    candidates: [],
    userName: 'Kazuma',
    charName: 'Megumin',
    maxNpcs: 12,
    admissionMode: 'conservative',
    ...extra,
});

function rulesSection(prompt) {
    const start = prompt.indexOf('\nAdmission:');
    const end = prompt.indexOf('Identity index (matching only):');
    assert.ok(start > 0 && end > start, 'prompt keeps its admission/rules/identity layout');
    return prompt.slice(start, end);
}

test('the scanner prompt is unchanged when narrationCapture is absent or false', () => {
    for (const extra of [{}, { fullScanMode: true, currentTranscript: TRANSCRIPT }, { customFieldNames: ['Favorite food'] }]) {
        const absent = buildScannerPrompt(promptOptions(extra));
        const explicitFalse = buildScannerPrompt(promptOptions({ ...extra, narrationCapture: false }));
        assert.equal(absent, explicitFalse);
        assert.ok(absent.startsWith('Private NPC dossier scanner.\n'));
        assert.ok(absent.includes(`Story context:\n${TRANSCRIPT}`), 'the transcript section is still supplied to the scanner');
        assert.doesNotMatch(absent, /ONE-PASS CAPTURE|<!--npc_state_delta|the chat above/);
    }
});

test('the capture prompt carries the scanner rules without the transcript and ends with the reminder', () => {
    const scanner = buildScannerPrompt(promptOptions());
    const capture = buildNarrationCapturePrompt(promptOptions());
    assert.ok(capture.startsWith('NPC STATE DELTA ONE-PASS CAPTURE.'));
    assert.ok(capture.includes('<!--npc_state_delta'));
    assert.ok(capture.includes('Identity index (matching only):'));
    // (b5b r2-8) Rule 1 names roles in the capture (the people are named in the context part);
    // otherwise rules 1-15 and the admission policy are the scanner's own text.
    // (cleanup step 12, I-10) and it always ends with the short Stage 4 and birthday rules, where the
    // scanner has its one-line Stage 4 summary.
    const rubricsOnly = text => text.slice(0, text.lastIndexOf('\n\n'));
    assert.equal(rubricsOnly(rulesSection(capture)), rubricsOnly(rulesSection(scanner)).replace('Exclude player (Kazuma), main speaker (Megumin), extras.', 'Exclude the player, the character you play, extras.'),
        'Rules 1-15 and the admission policy are the scanner\'s own text');
    assert.match(rulesSection(capture), /\n\nSTAGE 4: named forms=>[^\n]+\nBIRTHDAY: grounded evidence only: [^\n]+\n$/);
    assert.match(rulesSection(scanner), /\n\nS4: forms\/current; confirmed death terminal\.\n$/);
    assert.match(capture, /\nNot NPCs: the player is Kazuma; the character you play is Megumin\.\n/);
    for (let rule = 1; rule <= 15; rule += 1) assert.match(capture, new RegExp(`\\n${rule}\\. `), `rule ${rule}`);
    assert.ok(!capture.includes(TRANSCRIPT), 'the roleplay model already sees the chat; no transcript is duplicated');
    assert.ok(!capture.includes('Yunyun waves from the gate'));
    assert.ok(!capture.includes('Story context:\n'));
    assert.match(capture, /Story context: the chat above\./);
    assert.ok(capture.endsWith(`\n\n${NARRATION_CAPTURE_REMINDER}`));
    assert.ok(NARRATION_CAPTURE_REMINDER.startsWith('Reminder: after the story, end with the <!--npc_state_delta {valid JSON} --> block.'));
    // (1.2.11) The slow fields are named last, where the model looks.
    for (const field of ['mannerisms', 'evidence.mannerisms', 'behaviorProfile', 'evidence.behaviorProfile', 'memories']) assert.ok(NARRATION_CAPTURE_REMINDER.includes(field), field);
    assert.ok(!capture.startsWith('Private NPC dossier scanner.'));
});

test('the capture prompt is never a full-window prompt and keeps the custom-field rule', () => {
    const forcedFull = buildNarrationCapturePrompt(promptOptions({ fullScanMode: true, currentTranscript: TRANSCRIPT }));
    assert.equal(forcedFull, buildNarrationCapturePrompt(promptOptions()), 'fullScanMode is overridden to false');
    assert.doesNotMatch(forcedFull, /FULL-WINDOW RECONCILIATION|CURRENT exchange \(authoritative/);
    const withFields = buildNarrationCapturePrompt(promptOptions({ customFieldNames: ['Favorite food'] }));
    const scannerWithFields = buildScannerPrompt(promptOptions({ customFieldNames: ['Favorite food'] }));
    const rule = scannerWithFields.slice(scannerWithFields.indexOf('CUSTOM FIELDS (Favorite food)'));
    assert.ok(rule.length > 20 && rule.startsWith('CUSTOM FIELDS (Favorite food)'));
    assert.ok(withFields.includes(rule), 'the custom-field rule is appended to the capture prompt too');
    assert.ok(withFields.indexOf(rule) < withFields.indexOf('Reminder: after the story'), 'the reminder stays last');
    assert.ok(!buildNarrationCapturePrompt(promptOptions()).includes('CUSTOM FIELDS'));
});

// A live 1.1.9 report: a Delta block placed before Story Block's comment envelope reached that
// envelope's closing `-->` and deleted the inventory with it.
test('v1.1.10 a capture block never swallows another extension\'s comment envelope', () => {
    const envelope = '<!-- STORY_BLOCKS_V1\n<Blocks>\n<Inventory>\n[Gear]\nRope | 1 |\n</Inventory>\n</Blocks>\n-->';
    const dice = '<!-- STORY_BLOCKS_V1\n<Dice>d20+10 vs DC 15</Dice>\n-->';
    const block = '<!--npc_state_delta {"npcs":[]} -->';
    for (const lenient of [false, true]) {
        const before = extractNarrationCapture(`Story.\n${block}\n${envelope}`, { lenient });
        assert.equal(before.status, 'found');
        assert.equal(before.raw, '{"npcs":[]}');
        assert.ok(before.text.endsWith(envelope), 'the envelope after the block is kept whole');
        assert.ok(!before.text.includes('npc_state_delta'));

        const after = extractNarrationCapture(`Story.\n${envelope}\n${block}`, { lenient });
        assert.equal(after.text, `Story.\n${envelope}`);
        assert.equal(after.raw, '{"npcs":[]}');

        const unterminated = extractNarrationCapture(`Story.\n<!--npc_state_delta {"npcs":[]}\n${envelope}`, { lenient });
        assert.equal(unterminated.status, 'unterminated', 'an unclosed block ends where the next comment begins');
        assert.ok(unterminated.text.endsWith(envelope));

        const between = extractNarrationCapture(`${dice}\nStory.\n${block}\n${envelope}`, { lenient });
        assert.ok(between.text.startsWith(dice) && between.text.endsWith(envelope), 'envelopes on both sides survive');
        assert.equal(between.raw, '{"npcs":[]}');
    }
    const arrow = extractNarrationCapture('Story.\n<!--npc_state_delta {"npcs":[{"note":"A --> B"}]} -->');
    assert.equal(arrow.text, 'Story.', 'a closing arrow inside the JSON still cannot split a final block');
    assert.deepEqual(parseNarrationCapture(arrow.raw).npcs, [{ note: 'A --> B' }]);
    assert.equal(stripUiNoise(`Story. ${block} ${envelope}`), stripUiNoise(`Story. ${envelope}`), 'transcripts treat the envelope exactly as without the block');
});

// (1.2.11) The slow fields: a habit seen again in a later reply is a second sighting, however
// alike the words, so it fills once the evidence is written in two replies.
test('a habit written as evidence in two replies fills Mannerisms; never from one, never without evidence (1.2.11)', () => {
    const verna = createNpcRecord('Verna');
    const habit = 'Taps her ledger twice before naming a price.';
    const block = (said) => ({ npcs: [], profileUpdates: [{ id: verna.id, mannerisms: [habit], evidence: { mannerisms: [said] } }] });
    const scan = (state, messageId, parsed, context) => mergeScanResult(state, tagScanEvidence(parsed, messageId), { turn: messageId, sourceMessageId: messageId, developmentContext: context });
    const one = scan({ npcs: [verna], candidates: [], turn: 1 }, 2, block('taps her ledger twice before naming the price'), 'Verna taps her ledger twice before naming the price.');
    assert.deepEqual(one.state.npcs[0].mannerisms, [], 'one scene is not enough');
    assert.deepEqual(one.state.npcs[0].profileEvidence.mannerisms, ['[m2] taps her ledger twice before naming the price'], 'the sighting is kept, tagged with its reply');
    const two = scan({ ...one.state, turn: 7 }, 8, block('taps her ledger twice before naming a price'), 'Verna taps her ledger twice before naming a price.');
    assert.deepEqual(two.state.npcs[0].mannerisms, [habit], 'seen again in a later reply');
    // The same reply read again is no second sighting.
    const again = scan({ ...one.state, turn: 2 }, 2, block('taps her ledger twice before naming a price'), 'Verna taps her ledger twice before naming a price.');
    assert.deepEqual(again.state.npcs[0].mannerisms, []);
    // Without evidence the habit never builds up.
    const bare = { npcs: [], profileUpdates: [{ id: verna.id, mannerisms: [habit] }] };
    const b1 = scan({ npcs: [verna], candidates: [], turn: 1 }, 2, bare, 'Verna taps her ledger twice before naming the price.');
    assert.deepEqual(scan({ ...b1.state, turn: 7 }, 8, bare, 'Verna taps her ledger twice before naming a price.').state.npcs[0].mannerisms, []);
});

test('tagScanEvidence tags untagged evidence with its reply and leaves the rest alone (1.2.11)', () => {
    const parsed = { npcs: [{ name: 'Verna' }], profileUpdates: [{ id: 'npc_verna', evidence: { mannerisms: ['taps the ledger', '[m3] already tagged'], speech: ['clipped'] } }, { id: 'npc_burl' }] };
    const tagged = tagScanEvidence(parsed, 9);
    assert.deepEqual(tagged.profileUpdates[0].evidence, { mannerisms: ['[m9] taps the ledger', '[m3] already tagged'], speech: ['[m9] clipped'] });
    assert.deepEqual(tagged.profileUpdates[1], { id: 'npc_burl' });
    assert.equal(parsed.profileUpdates[0].evidence.mannerisms[0], 'taps the ledger', 'the input is not touched');
    assert.equal(tagScanEvidence(parsed, null), parsed);
});

test('storyProse keeps the narration and dialogue, never the World State or other blocks (1.2.12)', () => {
    const reply = 'Verna nods at Burl. "Fine."\n\n<!-- STORY_BLOCKS_V1\n<Blocks>\n<World_State>\n**👥 NPCs Present:**\n**Marrit:**\n**📡 Off-Screen:**\n* Brecht — at the sheds\n</World_State>\n<NPC_Inner_Chatter>Greta: hmm</NPC_Inner_Chatter>\n</Blocks>\n-->';
    assert.equal(storyProse(reply), 'Verna nods at Burl. "Fine."');
    assert.match(stripUiNoise(reply), /Brecht/, 'the scan still reads the World State');
    assert.equal(storyProse('Before <details><summary>World State</summary>Brecht</details> after.'), 'Before after.');
    assert.equal(storyProse('<World_State>Brecht</World_State>'), '');
    assert.equal(storyProse(`Yunyun waves.${'\n\n<!--npc_state_delta\n{"npcs":[]}\n-->'}`), 'Yunyun waves.');
});

test('the capture reminder asks for complete relationship rows and the block\'s own word (1.2.12)', () => {
    for (const part of ['relationshipImpact', 'relationshipDelta', '"relationshipsCovered": true', '"relationshipReview"']) assert.ok(NARRATION_CAPTURE_REMINDER.includes(part), part);
});

test('v1.2.16 the capture splits into rules (byte-identical reply to reply) and the dossier context with the reminder', () => {
    // Two consecutive replies: the dossiers, the cast, a candidate, a form and a death all change between them.
    const first = buildNarrationCaptureParts({
        transcript: 'USER: Who is at the gate?', userName: 'Kazuma', charName: 'Megumin', customFieldNames: ['Rank'],
        existingNpcs: [{ id: 'npc_yun', name: 'Yunyun', present: true, mood: 'shy', location: 'Gate', personality: 'Earnest.' }],
    });
    const second = buildNarrationCaptureParts({
        transcript: 'USER: We head for the guild hall instead.', userName: 'Kazuma', charName: 'Megumin', customFieldNames: ['Rank'],
        existingNpcs: [
            { id: 'npc_yun', name: 'Yunyun', present: false, mood: 'lonely', location: 'Guild', lifeState: 'deceased', lifeStateCertainty: 'explicit' },
            { id: 'npc_wiz', name: 'Wiz', present: true, appearanceForms: [{ name: 'Lich', appearance: 'pale' }], currentForm: 'Lich' },
        ],
        candidates: [{ name: 'Guard', seenCount: 1 }],
    });
    assert.equal(first.rules, second.rules, 'the rules part is the same text on both replies');
    assert.ok(first.rules.startsWith('NPC STATE DELTA ONE-PASS CAPTURE.') && first.rules.includes('\n15. JSON only'));
    for (const dynamic of ['Yunyun', 'Wiz', 'Guard', 'Gate', 'Identity index', 'Reminder:']) {
        assert.ok(!first.rules.includes(dynamic) && !second.rules.includes(dynamic), `no ${dynamic} in the rules`);
    }
    assert.ok(second.context.includes('"Wiz"') && second.context.includes('Identity index (matching only):'));
    assert.ok(second.context.trimEnd().endsWith('"relationshipReview": ["Name"].'), 'the reminder is still read last');
    // Nothing added or lost: the parts are the one-piece instruction, split where the context starts.
    const whole = buildNarrationCapturePrompt({ transcript: 'USER: Who is at the gate?', userName: 'Kazuma', charName: 'Megumin', customFieldNames: ['Rank'], existingNpcs: [{ id: 'npc_yun', name: 'Yunyun', present: true, mood: 'shy', location: 'Gate', personality: 'Earnest.' }] });
    const rest = first.context.split('\n').slice(1).join('\n');
    assert.ok(whole.startsWith(first.rules) && whole.endsWith(rest), 'rules first, then the rest, as one piece');
    assert.equal(whole.slice(first.rules.length, whole.length - rest.length).trim(), '', 'only the line break between them');
});

test('v1.2.17 the capture context leaves out values the live dossier above already gives, only that NPC\'s own and only word for word', () => {
    const vrena = { id: 'npc_vrena', name: 'Vrena Tolk', present: true, role: 'Guild clerk', personality: 'Dry, exacting, quietly kind.', speech: 'Clipped, formal sentences.', mannerisms: ['Taps the signature line twice.'], mood: 'busy', location: 'Guild counter', relationship: { trust: 3, affection: 1, desire: 0, tension: 0 }, manualProfileFields: ['speech'] };
    const elke = { id: 'npc_elke', name: 'Elke', present: true, personality: 'Warm.', mood: 'tired', location: 'Back room' };
    const options = { transcript: 'USER: Vrena Tolk and Elke, a moment?', userName: 'Ari', charName: 'Narrator', existingNpcs: [vrena, elke] };
    // Vrena's line repeats her personality, speech, mannerism, mood and role; it also says "tired", Elke's mood.
    const dossier = '- Vrena Tolk: IDENTITY (authoritative): personality: Dry, exacting, quietly kind.; established speech: Clipped, formal sentences.; established mannerisms: Taps the signature line twice.; role: Guild clerk; mood: busy, a little tired';
    const plain = buildNarrationCaptureParts(options).context;
    const deduped = buildNarrationCaptureParts({ ...options, dossierAbove: dossier }).context;
    assert.ok(deduped.length < plain.length);
    const live = JSON.parse(deduped.split('Relevant live context (dynamic fields only):\n')[1].split('\n')[0]);
    const vLive = live.find(entry => entry.id === 'npc_vrena');
    assert.equal(vLive.inDossier, true);
    assert.equal(vLive.mood, undefined, 'her mood is in her own dossier line');
    assert.equal(vLive.location, 'Guild counter', 'a value the dossier does not give stays');
    assert.deepEqual(vLive.currentRelationship, { trust: 3, affection: 1, desire: 0, tension: 0 }, 'the numbers are never in the dossier and always stay');
    const eLive = live.find(entry => entry.id === 'npc_elke');
    assert.equal(eLive.mood, 'tired', "another NPC's line never removes Elke's values");
    assert.equal(eLive.inDossier, undefined);
    assert.match(deduped, /\(inDossier: fields left out here are the NPC STATE DELTA DOSSIER's values above, current and unchanged\.\)/);
    // The scanner's own prompt and a capture with no dossier are untouched.
    assert.equal(buildScannerPrompt({ ...options, dossierAbove: dossier }), buildScannerPrompt(options));
    assert.doesNotMatch(plain, /inDossier/);
});

test('v1.2.17 the opt-in compact capture rules keep every field, state word and gate, in fewer words, for capture only', () => {
    const options = { transcript: 'USER: hi', userName: 'Kazuma', charName: 'Megumin', existingNpcs: [{ id: 'npc_yun', name: 'Yunyun', present: true }] };
    const full = buildNarrationCaptureParts(options).rules;
    const compact = buildNarrationCaptureParts({ ...options, compactCapture: true }).rules;
    // (cleanup step 12) Both now carry the short Stage 4 and birthday rules, and compact its restored gates.
    assert.ok(compact.length < full.length * 0.85, `compact ${compact.length} vs full ${full.length}`);
    assert.ok(compact.startsWith('NPC STATE DELTA ONE-PASS CAPTURE.'));
    for (const word of ['profileUpdates', 'keyRelationshipEdges', 'relationshipDelta', 'relationshipEvidence', 'relationshipImpact', 'developmentScale', 'developmentReason', 'memoryRetention', 'homeBaseState', 'ageState', 'apparentAgeState', 'genderState', 'lifeState', 'appearanceState', 'overallAppearance', 'identityKind', 'dossierSignal', 'sameIndividual', 'directInteraction', 'worldActive', 'goalState', 'locationState', 'Disposition|Care|Expression|Independence|Conflict|Threat|Analytical|Presentation|Mercy|Loyalty|Drive|Honesty', 'Delta caps:', 'Relationship rubric:',
        // (cleanup step 12, I-11) the gates the first compact version dropped
        'MUST return it when age unknown', 'never dangling "(deceased)"', 'no species-aging inference', 'Inner Chatter gives durable facts only, not monologue',
        'raw max 1/2/5/10', 'kindness stays general; necessary force != cruelty', 'speech evidence = voice style',
        'Explicit death (deceased+explicit) is terminal: never alive/present/worldActive again', 'STAGE 4: named forms', 'BIRTHDAY:']) {
        assert.ok(compact.includes(word), word);
    }
    // (b5b r2-8) Roles in the rules, names with the context.
    assert.ok(!compact.includes('Kazuma') && !compact.includes('Megumin'));
    assert.match(buildNarrationCaptureParts({ ...options, compactCapture: true }).context, /Not NPCs: the player is Kazuma; the character you play is Megumin\./);
    // Byte-identical reply to reply, like the full rules.
    assert.equal(buildNarrationCaptureParts({ ...options, compactCapture: true, existingNpcs: [] }).rules, compact);
    // The scanner never uses them.
    assert.equal(buildScannerPrompt({ ...options, compactCapture: true }), buildScannerPrompt(options));
});
