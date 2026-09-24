import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bestAncestorState, chatLineage, recordBranchCheckpoint } from '../branch.js';
import { encodeRetiredStateFilePayload, decodeStateFilePayload, makeNpcStateRecoveryFileName } from '../storage.js';

const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const identity = fs.readFileSync(new URL('../identity.js', import.meta.url), 'utf8');
const ci = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

function msg(text, isUser = false) { return { mes: text, is_user: isUser, is_system: false, name: isUser ? 'User' : 'Character' }; }
function stateFor(chat) {
    const state = { npcs: [{ id: 'npc_a', name: 'A' }], candidates: [], pendingBackfills: [], socialGraph: { edges: [], unresolved: [] }, dismissed: [], turn: 1, assistantSinceScan: 0, lastScanAt: 0, lastScannedMessageId: null, scanCount: 0, checkpoints: [], lineage: [], inlineCards: [] };
    recordBranchCheckpoint(state, chat, chat.length - 1, 'test');
    state.lineage = chatLineage(chat);
    return state;
}

test('group identity takes precedence over host chatId and pending identities are noncanonical', () => {
    assert.match(identity, /if \(hasGroup\)/);
    assert.match(identity, /buildQualifiedChatKey\('group', ownerId, raw\)/);
    assert.match(identity, /group-pending:/);
    assert.match(index, /return isQualifiedChatKey\(key\)/);
});

test('delete and hydration use ownership epochs and stale loader cannot clear a newer promise', () => {
    assert.match(index, /const ownershipEpochs = new Map\(\)/);
    const lifecycleCache = index.slice(index.indexOf('function clearLifecycleCacheKey'), index.indexOf('async function loadLatestLifecycleState'));
    assert.match(lifecycleCache, /bumpOwnershipEpoch\(key\)/);
    assert.match(lifecycleCache, /cancelScanOperation\(key, reason\)/);
    assert.match(index, /clearLifecycleCacheKey\(key, 'chat-deleted'\)/);
    assert.match(index, /assertOwnershipEpoch\(key, epoch\)/);
    assert.match(index, /if \(loadingChatStates\.get\(key\) === task\) loadingChatStates\.delete\(key\)/);
    assert.match(index, /if \(!ownershipEpochCurrent\(key, epoch\)\) return written/);
});

test('retired sidecars are explicit durable tombstones', () => {
    const payload = decodeStateFilePayload(encodeRetiredStateFilePayload('chat:x', 'deleted', '0.2.15'));
    assert.equal(payload.retired, true);
    assert.equal(payload.chatKey, 'chat:x');
    assert.equal(payload.retireReason, 'deleted');
    assert.match(makeNpcStateRecoveryFileName('chat:x', 123), /^npc-state-delta-recovery-/);
    assert.match(index, /retireNpcStateDataFile\(\{ chatKey: key, pointer, reason: 'chat-deleted'/);
});

test('rename uses event groupId and writes a recovery backup before retiring predecessor', () => {
    const fn = index.slice(index.indexOf('async function moveRenamedChatState'), index.indexOf('function flushCurrentChatOnPageHide'));
    assert.match(fn, /eventData\.groupId/);
    const recovery = fn.indexOf('makeNpcStateRecoveryFileName(oldKey)');
    const retire = fn.indexOf('retireNpcStateDataFile');
    const switchOwnership = fn.indexOf('settings.dataFiles[newKey] = newPointer');
    assert.ok(recovery >= 0 && retire > recovery && switchOwnership > retire);
});

test('broken sidecar recovery is explicit rather than silently destructive', () => {
    assert.match(index, /async function detachBrokenSidecar/);
    assert.match(index, /Detach Broken Sidecar/);
    assert.match(index, /settings\.recoveryFiles\[key\]/);
    assert.match(index, /settings\.sidecarTombstones\[key\]/);
});

test('independent chats never inherit without explicit host branch provenance', () => {
    const shortA = [msg('Welcome.'), msg('I enter.', true), msg('The guard nods.')];
    const shortB = [msg('Welcome.'), msg('I enter.', true), msg('The guard nods differently.')];
    assert.equal(bestAncestorState({ 'chat:a': stateFor(shortA) }, 'chat:b', shortB), null);
    const longA = [msg('Welcome.'), msg('I enter.', true), msg('The guard nods.'), msg('I ask for work.', true), msg('A ledger opens.')];
    const longB = [msg('Welcome.'), msg('I enter.', true), msg('The guard nods.'), msg('I ask for work.', true), msg('A different ledger opens.')];
    const inherited = bestAncestorState({ 'chat:a': stateFor(longA.slice(0, 4)) }, 'chat:b', longB);
    assert.equal(inherited, null);
});

test('branch inheritance loads only the explicit host parent', () => {
    assert.match(index, /if \(!hasExplicitParent\) return false/);
    assert.match(index, /await ensureChatStateLoaded\(explicitParentKey\)/);
    assert.doesNotMatch(index, /branchIndex|ensureLikelyAncestorStatesLoaded|BRANCH_DISCOVERY_LIMIT/);
});

test('CI is version-neutral and uses Node 24 actions', () => {
    assert.match(ci, /actions\/checkout@v5/);
    assert.match(ci, /actions\/setup-node@v5/);
    assert.match(ci, /node-version: 24/);
    assert.doesNotMatch(ci, /apply_v0214_hardening|v0\.2\.14 hardening|Sync v0\.2\.14/);
});
