import test from 'node:test';
import assert from 'node:assert/strict';
import { createNpcRecord } from '../core.js';
import { encodeNpcStateBundle } from '../bundle.js';
import {
    boundedAppend,
    buildPortablePortraitSettings,
    portraitTargetCurrent,
    recordToolEvent,
    relationshipDiagnosticRows,
    summarizeDecodedBundle,
    toolEvents,
    validatePortraitFile,
} from '../dossier-tools-core.js';
import {
    augmentNativeBundle,
    buildHistoryArchive,
    decodeDeltaNativeBundle,
    prepareNativeImport,
} from '../native-transfer.js';

function portraitData(bytes = [1, 2, 3, 4]) {
    return `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
}

test('portrait validation accepts images and rejects invalid/oversized inputs without mutation', () => {
    assert.equal(validatePortraitFile({ type: 'image/png', size: 1024 }).ok, true);
    assert.match(validatePortraitFile({ type: 'text/plain', size: 10 }).reason, /supported image/i);
    assert.match(validatePortraitFile({ type: 'image/png', size: 17 * 1024 * 1024 }).reason, /16 MB/i);
    assert.match(validatePortraitFile(null).reason, /No image/i);
});

test('portrait ownership guard rejects chat switches, deletion, cancellation, superseded sessions and actions', () => {
    const base = { expectedChatKey: 'chat:a', actualChatKey: 'chat:a', npcId: 'npc_a', npcExists: true, sessionId: 4, activeSessionId: 4, actionSeq: 3, expectedActionSeq: 3, cancelled: false };
    assert.equal(portraitTargetCurrent(base), true);
    assert.equal(portraitTargetCurrent({ ...base, actualChatKey: 'chat:b' }), false);
    assert.equal(portraitTargetCurrent({ ...base, npcExists: false }), false);
    assert.equal(portraitTargetCurrent({ ...base, cancelled: true }), false);
    assert.equal(portraitTargetCurrent({ ...base, activeSessionId: 5 }), false);
    assert.equal(portraitTargetCurrent({ ...base, actionSeq: 4 }), false);
});

test('bounded Stage 8 diagnostics exclude arbitrary secret fields and stay bounded', () => {
    toolEvents.splice(0);
    for (let i = 0; i < 75; i += 1) recordToolEvent('scan', { chatKey: 'chat:a', action: `a${i}`, outcome: 'ok', credential: 'SECRET', prompt: 'PRIVATE' });
    assert.equal(toolEvents.length, 60);
    assert.equal('credential' in toolEvents.at(-1), false);
    assert.equal('prompt' in toolEvents.at(-1), false);
    const custom = [];
    for (let i = 0; i < 5; i += 1) boundedAppend(custom, i, 3);
    assert.deepEqual(custom, [2, 3, 4]);
});

test('relationship diagnostics retain signed fractional progress and report only a derived gate audit', () => {
    const npc = createNpcRecord('Myla');
    npc.relationship = { trust: 50, affection: -25, desire: 0, tension: 0 };
    npc.relationshipProgress = { trust: 0.75, affection: -0.4, desire: 0, tension: 0 };
    npc.relationshipMilestones = [
        { axis: 'trust', polarity: 1, threshold: 25 },
        { axis: 'affection', polarity: -1, threshold: 25 },
    ];
    const rows = relationshipDiagnosticRows(npc);
    assert.equal(rows.find(row => row.axis === 'trust').fractionalProgress, 0.75);
    assert.match(rows.find(row => row.axis === 'trust').derivedGateAudit, /50/);
    assert.equal(rows.find(row => row.axis === 'affection').fractionalProgress, -0.4);
});

test('portable settings include portrait workflow settings only', () => {
    const portable = buildPortablePortraitSettings({
        portraitGenerationEnabled: false,
        portraitThemePreset: 'custom',
        portraitStylePositive: 'clean anime',
        portraitStyleNegative: 'noise',
        portraitComposition: 'portrait',
        portraitPromptFormat: 'hybrid',
        portraitUseMood: true,
        portraitUseLocation: true,
        portraitSaveToGallery: false,
        scannerConnectionProfile: 'do-not-export',
        enabled: false,
    });
    assert.equal(portable.portraitGenerationEnabled, false);
    assert.equal(portable.portraitUseLocation, true);
    assert.equal('scannerConnectionProfile' in portable, false);
    assert.equal('enabled' in portable, false);
});

test('native Delta envelope round-trips portraits, portable settings and source history audit', () => {
    const npc = createNpcRecord('Ryu');
    npc.portrait = { dataUrl: portraitData(), mime: 'image/png', sourceName: 'ryu.png', updatedAt: 123 };
    npc.relationshipProgress = { trust: 0.5, affection: 0.25, desire: 0, tension: 0 };
    npc.lifeState = 'deceased';
    npc.lifeStateCertainty = 'explicit';
    npc.archived = true;
    npc.archiveReason = 'deceased';
    npc.archiveSourceMessageId = 14;
    const state = {
        npcs: [npc],
        dismissed: ['ignored'],
        socialGraph: { version: 1, edges: [], unresolved: [] },
        turn: 8,
        lastScannedMessageId: 14,
        lineage: [{ messageId: 14, hash: 'source-owned' }],
        checkpoints: [{ messageId: 14, snapshot: { npcs: [npc], portraitAssets: { [npc.id]: npc.portrait } } }],
        inlineCards: [{ messageId: 14, cards: [npc] }],
        branchRootSnapshot: { npcs: [npc] },
    };
    const base = encodeNpcStateBundle(state, { appVersion: '0.1.0', chatKey: 'chat:source' });
    const native = augmentNativeBundle(base, {
        portableSettings: buildPortablePortraitSettings({ portraitThemePreset: 'custom', portraitStylePositive: 'anime' }),
        historyArchive: buildHistoryArchive(state),
    });
    const decoded = decodeDeltaNativeBundle(native);
    assert.equal(decoded.state.npcs[0].name, 'Ryu');
    assert.ok(decoded.state.npcs[0].portrait.dataUrl.startsWith('data:image/png;base64,'));
    assert.equal(decoded.state.npcs[0].relationshipProgress.trust, 0.5);
    assert.equal(decoded.state.npcs[0].lifeState, 'deceased');
    assert.equal(decoded.portableSettings.portraitThemePreset, 'custom');
    assert.equal(decoded.historyArchive.checkpoints.length, 1);
    assert.equal(decoded.historyArchive.checkpoints[0].snapshot.npcs[0].portrait.dataUrl, undefined, 'history audit must not duplicate portrait binary payloads');
    assert.equal(decoded.historyArchive.checkpoints[0].snapshot.portraitAssets, undefined);
    const summary = summarizeDecodedBundle(decoded);
    assert.equal(summary.dossiers, 1);
    assert.equal(summary.portraits, 1);
    assert.equal(summary.checkpoints, 1);
});

test('cross-chat native import clears source message ownership while preserving accepted state and terminal death', () => {
    const npc = createNpcRecord('Sora');
    npc.relationship = { trust: 75, affection: 50, desire: 0, tension: 0 };
    npc.relationshipProgress = { trust: 0.8, affection: 0.2, desire: 0, tension: 0 };
    npc.relationshipMilestones = [{ axis: 'trust', polarity: 1, threshold: 75, reason: 'earned', sourceMessageId: 22 }];
    npc.relationshipEventHistory = [{ impact: 'meaningful', reason: 'saved her', sourceMessageId: 22 }];
    npc.lifeState = 'deceased';
    npc.lifeStateCertainty = 'explicit';
    npc.archived = true;
    npc.archiveReason = 'deceased';
    npc.archiveSourceMessageId = 22;
    npc.portrait = { dataUrl: portraitData([8, 9, 10]), mime: 'image/png' };
    const base = encodeNpcStateBundle({ npcs: [npc], dismissed: [] }, { appVersion: '0.1.0', chatKey: 'chat:source' });
    const native = augmentNativeBundle(base, { historyArchive: { policy: 'audit-only-source-history', checkpoints: [{ messageId: 22 }] } });
    const prepared = prepareNativeImport(native, 'chat:target');
    const imported = decodeDeltaNativeBundle(prepared.importBytes).state.npcs[0];
    assert.equal(imported.relationship.trust, 75);
    assert.equal(imported.relationshipProgress.trust, 0.8);
    assert.equal(imported.relationshipMilestones[0].sourceMessageId, null);
    assert.equal(imported.relationshipEventHistory[0].sourceMessageId, null);
    assert.equal(imported.archiveSourceMessageId, null);
    assert.equal(imported.lifeState, 'deceased');
    assert.equal(imported.archiveReason, 'deceased');
    assert.ok(imported.portrait.dataUrl.startsWith('data:image/png;base64,'));
    assert.match(prepared.ownershipPolicy, /cleared/i);
    assert.match(prepared.historyPolicy, /audit/i);
});

test('foreign and malformed native imports fail before mutation preparation', () => {
    assert.throws(() => prepareNativeImport(new Uint8Array([1, 2, 3]), 'chat:target'), /truncated|signature/i);
    const base = encodeNpcStateBundle({ npcs: [], dismissed: [] }, { chatKey: 'chat:a' });
    const corrupt = base.slice();
    corrupt[0] = 0;
    assert.throws(() => prepareNativeImport(corrupt, 'chat:target'), /signature/i);
    assert.throws(() => prepareNativeImport(base, ''), /target chat/i);
});
