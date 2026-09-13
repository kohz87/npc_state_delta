import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScannerPrompt, createNpcRecord } from '../core.js';
import { encodeNpcStateBundle } from '../bundle.js';
import { augmentNativeBundle, decodeDeltaNativeBundle } from '../native-transfer.js';

test('v1.0.3 scanner exposes form fields for implicit anatomical transitions without explicit form wording', () => {
    const prompt = buildScannerPrompt({
        transcript: `Ryu's silver horns dissolved into pale vapor. Her wings broke into cool silver dust and her tail retracted into her lower back. Beside her, Sora's plumage melted into sparks and her pointed feathered ears smoothed into rounded ordinary ears.`,
        existingNpcs: [],
        userName: 'Lucien',
        charName: 'Narrator',
    });
    assert.match(prompt, /STAGE 4 APPEARANCE/);
    assert.match(prompt, /Natural anatomical transitions count/i);
    assert.match(prompt, /"appearance":"grounded prompt-ready visual description","overallAppearance":/);
    assert.match(prompt, /"appearanceForms":\[\{"name":"stable established form name"/);
    assert.match(prompt, /"currentFormState":"keep\|select\|unknown"/);
});

test('v1.0.3 ordinary scans do not pay the detailed form-schema cost without a form signal', () => {
    const prompt = buildScannerPrompt({
        transcript: 'Mira sits beside the hearth and asks Lucien about supper.',
        existingNpcs: [],
        userName: 'Lucien',
        charName: 'Narrator',
    });
    assert.doesNotMatch(prompt, /Natural anatomical transitions count/i);
    assert.doesNotMatch(prompt, /"appearance":"grounded prompt-ready visual description","overallAppearance":/);
});

test('v1.0.3 oversized source history compacts instead of blocking native backup', () => {
    const npc = createNpcRecord('Ryu');
    npc.appearance = 'Long silver hair and grey-blue eyes.';
    const state = { npcs: [npc], dismissed: [], turn: 12 };
    const base = encodeNpcStateBundle(state, { appVersion: '1.0.3', chatKey: 'chat:large-history' });
    const giantAudit = {
        policy: 'audit-only-source-history',
        turn: 12,
        lastScannedMessageId: 44,
        lineage: [{ messageId: 44, hash: 'latest' }],
        checkpoints: [{ messageId: 44, snapshot: { note: 'x'.repeat(2 * 1024 * 1024 + 4096) } }],
        branchLineageVersion: 1,
        branchParent: { messageId: 40 },
        branchForkMessageId: 41,
        branchRootSnapshot: { note: 'root' },
        inlineCards: [{ messageId: 44, cards: [] }],
    };

    const exported = augmentNativeBundle(base, { historyArchive: giantAudit });
    const decoded = decodeDeltaNativeBundle(exported);
    assert.equal(decoded.state.npcs[0].name, 'Ryu');
    assert.equal(decoded.declaredContents.sourceHistoryAudit, true);
    assert.equal(decoded.historyArchive.truncated, true);
    assert.equal(decoded.historyArchive.truncationReason, 'export-size-limit');
    assert.equal(decoded.historyArchive.omittedCounts.checkpoints, 1);
    assert.equal(decoded.historyArchive.omittedCounts.lineage, 1);
    assert.equal(decoded.historyArchive.omittedCounts.inlineCards, 1);
    assert.equal(decoded.historyArchive.omittedCounts.branchRootSnapshot, 1);
    assert.deepEqual(decoded.historyArchive.checkpoints, []);
});
