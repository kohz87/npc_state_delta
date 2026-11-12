// The fill rides on the backfill every new person already gets (not only on the catch-up's eighth reply): one prompt tail line and the same
// narrow merge allowance, only for a 'new-admission' entry; no extra model call. Looks only: personality still needs evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBackfillPrompt, createNpcRecord, mergeScanResult } from '../core.js';
import { normalizeName } from '../core-text.js';
import { durableSemanticSimilarity } from '../core-relationship.js';
import { sameReplyRetelling } from '../core-record-merge.js';
import { fillAllowed, fillLooksLine, isReadersOwn, FILL_MERGE_OPTION } from '../appearance-fill.js';
import { runEditorHostScenario } from './editor-host.mjs';

const story = 'Tamsin, the ferry keeper from the salt marsh, tied the boat and asked the stranger for the toll.';
const person = (extra = {}) => ({ ...createNpcRecord('Tamsin'), role: 'ferry keeper', species: 'fox-eared human', ...extra });
const NONE = { relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 } };
const merge = (npc, row, extra = {}) => mergeScanResult({ npcs: [npc], candidates: [], dismissed: [], socialGraph: { version: 1, edges: [], unresolved: [] }, turn: 4 },
    { npcs: [{ id: npc.id, name: 'Tamsin', ...NONE, ...row }], profileUpdates: [], keyRelationshipEdges: [] },
    { turn: 5, sourceMessageId: 12, developmentContext: story, skipRelationshipUpdate: true, allowTargetedDurableSeed: true, preservePresence: true, ...extra }).state.npcs[0];
const FILL = { [FILL_MERGE_OPTION]: true };

test('the backfill prompt gets the fill line at its tail only when asked; the static rules are unchanged', () => {
    const plain = buildBackfillPrompt({ transcript: story, targetName: 'Tamsin', existingNpc: person() });
    const filled = buildBackfillPrompt({ transcript: story, targetName: 'Tamsin', existingNpc: person(), fillLooks: true });
    assert.equal(filled.replace(fillLooksLine(person()), ''), plain, 'the only difference is the one line, after the history (as in the Refresh)');
    assert.ok(filled.indexOf('FILL LOOKS') > filled.indexOf(story), 'after the history: the static prefix is untouched');
    assert.equal(buildBackfillPrompt({ transcript: story, targetName: 'Tamsin', existingNpc: person(), fillLooks: false }), plain);
    console.log(`backfill fill line adds ${fillLooksLine(person()).length} chars (blank looks); a normal backfill +0`);
});

test('the backfill merge keeps the fill for blank and for partial looks (word for word), and still refuses personality', () => {
    const blank = merge(person(), { overallAppearance: 'A slim young fox-eared woman, russet hair, amber eyes.', appearance: 'An oilskin coat.', personality: 'Warm and endlessly generous.' }, FILL);
    assert.match(blank.overallAppearance, /russet hair/);
    assert.match(blank.appearance, /oilskin/);
    assert.equal(blank.personality || '', merge(person(), { personality: 'Warm and endlessly generous.' }).personality || '', 'the allowance changes nothing about personality');
    const partial = person({ overallAppearance: 'Young fox-eared woman.', appearance: 'A patched cloak.' });
    const added = merge(partial, { overallAppearance: 'Young fox-eared woman. Russet hair, amber eyes, slim build.' }, FILL);
    assert.equal(added.overallAppearance, 'Young fox-eared woman. Russet hair, amber eyes, slim build.');
    assert.equal(merge(partial, { overallAppearance: 'Young fox-eared woman. Russet hair, amber eyes, slim build.' }).overallAppearance, 'Young fox-eared woman.', 'without the allowance nothing is invented');
});

test('catch-up then backfill for one person leaves one consistent description; replay == live', () => {
    const first = merge(person(), { overallAppearance: 'Fox-eared woman, russet hair, amber eyes.' }, FILL);
    assert.equal(fillAllowed(first, 'Kazuma'), true, 'only the build is still missing: the second call may add just that');
    assert.match(fillLooksLine(first), /build/);
    assert.doesNotMatch(fillLooksLine(first), /describe this person's [^.]*hair|addition for [^.]*hair/, 'hair is quoted, never asked for');
    const second = merge(first, { overallAppearance: 'Fox-eared woman, russet hair, amber eyes. Broad-shouldered.' }, FILL);
    assert.equal(second.overallAppearance, 'Fox-eared woman, russet hair, amber eyes. Broad-shouldered.');
    const clash = merge(first, { overallAppearance: 'Fox-eared woman, russet hair, amber eyes. Black hair, green eyes.' }, FILL);
    assert.equal(clash.overallAppearance, first.overallAppearance, 'a second colour never clashes');
    const done = merge(second, { overallAppearance: 'Totally different.' }, FILL);
    assert.equal(done.overallAppearance, second.overallAppearance);
    assert.equal(fillAllowed(second, 'Kazuma'), false, 'nothing left: the second call sends no line');
    const again = merge(person(), { overallAppearance: 'Fox-eared woman, russet hair, amber eyes.' }, FILL);
    const norm = x => ({ ...x, createdAt: 0, updatedAt: 0, lastScannedAt: 0 });
    assert.deepEqual(norm(again), norm(first));
});

test('the reader\'s own character, by name or alias, never qualifies; the Refresh shares the check', () => {
    assert.equal(isReadersOwn(person({ name: 'Kazuma' }), ' kazuma '), true);
    assert.equal(isReadersOwn(person({ aliases: ['Kaz', 'Kazuma'] }), 'KAZUMA'), true);
    assert.equal(fillAllowed(person({ name: 'Kazuma' }), 'Kazuma'), false);
    assert.equal(fillAllowed(person(), 'Kazuma'), true);
    assert.equal(fillAllowed(person(), ''), true);
    assert.equal(fillAllowed(person({ lifeState: 'deceased' }), 'Kazuma'), false);
    assert.equal(fillAllowed(person({ archived: true }), 'Kazuma'), false);
    assert.equal(fillAllowed(person({ manualProfileFields: ['appearance'] }), 'Kazuma'), false);
});

test('through the synthetic host: a person met on a non-catch-up reply is filled by their one backfill; a missed-participant repair is not', () => {
    runEditorHostScenario('fill-on-backfill', async () => {
        const runtime = globalThis.NPCStateDelta;
        const row = extra => ({ present: true, role: 'ferry keeper', identityKind: 'proper_name', dossierSignal: 'high', dossierReason: 'named person', directInteraction: true, relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 }, ...extra });
        const prompts = [];
        let phase = 1;
        mockState.quietResponder = async (args = {}) => {
            const text = JSON.stringify(args);
            prompts.push(text);
            if (/targeted dossier backfill extractor/.test(text)) {
                const name = /Requested NPC: (\w+)/.exec(text.replace(/\\n/g, '\n'))?.[1];
                return JSON.stringify({ npcs: [row({ name, overallAppearance: 'A slim young woman, russet hair, amber eyes.', appearance: 'A salt-stained oilskin coat.' })] });
            }
            return JSON.stringify({ npcs: phase === 1 ? [row({ name: 'Tamsin' })] : [row({ name: 'Mira', role: 'innkeeper' })] });
        };
        const reply = async (user, text) => {
            mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: user });
            mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: text, swipe_id: 0, swipes: [text] });
            await Promise.all((mockState.listeners.get('message_received') || []).map(fn => fn(mockState.context.chat.length - 1)));
            await sleep(700);
        };
        mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: 'The marsh is quiet.' });
        await reply('Who runs the ferry?', 'Tamsin, the ferry keeper, ties the boat and asks the stranger for the toll. The tide is out and the reeds hiss.');
        const npc = name => runtime.getDossierState().npcs.find(item => item.name === name);
        assert.ok(npc('Tamsin'), 'the person was admitted');
        const forName = (name, list = prompts) => list.filter(text => /targeted dossier backfill extractor/.test(text) && text.includes(`Requested NPC: ${name}`));
        assert.ok(forName('Tamsin').length >= 1, 'the new admission was backfilled');
        assert.ok(forName('Tamsin').every(text => text.includes('FILL LOOKS')), 'the backfill asked for the fill');
        assert.ok(!prompts.some(text => !/backfill extractor/.test(text) && text.includes('FILL LOOKS')), 'no other call carries the line');
        assert.match(npc('Tamsin').overallAppearance || '', /russet hair/, 'filled without quoted evidence');
        // Phase 2: the broad scan omits Tamsin in an exchange she takes part in: a missed-participant repair (not a new admission).
        phase = 2;
        const before = prompts.length;
        await reply('Is Mira here?', 'Mira the innkeeper nods. Tamsin, the ferry keeper, ties the boat again while Mira watches the tide.');
        const later = prompts.slice(before);
        assert.ok(forName('Mira', later).every(text => text.includes('FILL LOOKS')), 'the other new person is filled on her own backfill');
        const repair = forName('Tamsin', later);
        assert.ok(repair.length >= 1, 'a missed-participant repair for Tamsin ran');
        assert.ok(repair.every(text => !text.includes('FILL LOOKS')), 'an established person, repaired as a missed participant, never fills');
    });
});

// Owner payload (nsd-fill-looks-1815): the new person's backfill re-told the one-pass memory of the same reply in other words; the pair is
// far below the similarity rule, so it was stored twice. A memory stamped at the reply being re-read is matched by shared distinct words.
const ONE_PASS = 'Registered Astra at the Bluewatch Guild desk as her bodice button snapped and exposed her chest, leaving her mortified as she threw two culling contracts at him.';
const BACKFILL = "Took Astra's registration fee, but suffered a mortifying wardrobe malfunction when her bodice burst open, prompting her to furiously thrust culling contracts at him.";
const OTHER = 'Promised to send word to the marsh warden before the spring floods.';
const recorded = () => person({ memories: [ONE_PASS], memoryStamps: { [normalizeName(ONE_PASS)]: { m: 12 } } });

test('a backfill memory re-telling the same reply\'s one-pass memory is not stored twice; other memories still are', () => {
    console.log(`one-pass vs backfill similarity ${durableSemanticSimilarity(ONE_PASS, BACKFILL).toFixed(2)} (dedupe needs 0.58)`);
    assert.ok(durableSemanticSimilarity(ONE_PASS, BACKFILL) < 0.58, 'the similarity rule alone does not catch the pair');
    assert.deepEqual(merge(recorded(), { memories: [BACKFILL, OTHER] }).memories, [ONE_PASS, OTHER]);
    const viaUpdate = mergeScanResult({ npcs: [recorded()], candidates: [], dismissed: [], socialGraph: { version: 1, edges: [], unresolved: [] }, turn: 4 },
        { npcs: [], profileUpdates: [{ id: recorded().id, memories: [BACKFILL] }], keyRelationshipEdges: [] },
        { turn: 5, sourceMessageId: 12, developmentContext: story, skipRelationshipUpdate: true, allowTargetedDurableSeed: true, preservePresence: true }).state.npcs[0];
    assert.deepEqual(viaUpdate.memories, [ONE_PASS], 'the profileUpdates channel too');
    assert.equal(sameReplyRetelling(BACKFILL, [ONE_PASS], { [normalizeName(ONE_PASS)]: { m: 11 } }, 12), false, 'another reply\'s memory: ordinary rule');
    assert.deepEqual(merge(recorded(), { memories: [BACKFILL] }, { sourceMessageId: 13 }).memories, [ONE_PASS, BACKFILL], 'a later reply is a new event');
});

test('same-reply rule is narrow: near-similar but different events, pinned memories and other replies are kept', () => {
    const different = [
        'Weeks earlier, Astra begged the Bluewatch Guild healer to save her dying hound after the ambush in the marshes.',
        'Saw Astra beaten by the Bluewatch Guild master in front of the whole hall for a forged ledger.',
        'Astra registered with the guild and later fought off three thugs in the Bluewatch alley, saving his life.',
    ];
    const stamps = { [normalizeName(ONE_PASS)]: { m: 12 } };
    for (const text of different) assert.equal(sameReplyRetelling(text, [ONE_PASS], stamps, 12), false, text);
    assert.equal(sameReplyRetelling(BACKFILL, [ONE_PASS], stamps, 12, [ONE_PASS]), false, 'a pinned stored memory is never matched');
    assert.equal(sameReplyRetelling(BACKFILL, [ONE_PASS], stamps, 12, [BACKFILL]), false, 'a pinned incoming memory is never dropped');
    assert.equal(sameReplyRetelling(BACKFILL, [ONE_PASS], stamps, 12), true, 'the owner pair still matches at the same reply');
    assert.deepEqual(merge(recorded(), { memories: different }).memories.slice(0, 1), [ONE_PASS]);
});
