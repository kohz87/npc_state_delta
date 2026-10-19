import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const index = fs.readFileSync(path.join(root, 'index.js'), 'utf8');

test('swipe branch handling waits for SillyTavern swipe idle before dossier generation', () => {
    assert.match(index, /function hostSwipeState\(\)[\s\S]*?getContext\(\)\.swipe\?\.state\?\.\(\)/);
    assert.match(index, /function isHostSwipeActive\(\)[\s\S]*?hostSwipeState\(\) !== 'none'/);
    assert.match(index, /events\.MESSAGE_SWIPED[\s\S]*?queueSettledSwipeReconcile/);
    assert.doesNotMatch(index, /events\.MESSAGE_SWIPED[\s\S]{0,450}?queueBranchReconcile/);
    assert.match(index, /if \(!allowDuringSwipe && isHostSwipeActive\(\)\)/, 'scanNow must refuse hidden generation during host swipe');
    assert.match(index, /MESSAGE_RECEIVED while swipeState is still SWIPING[\s\S]*?queueSettledSwipeReconcile/, 'early MESSAGE_RECEIVED must be deferred');
    assert.match(index, /const reconciliation = await reconcileCurrentBranch\([\s\S]*?if \(reconciliation\?\.requiresRescan === false\) return;/, 'an exact known sibling must skip another LLM scan while a parent/root restore still rebuilds the new swipe');
    assert.match(index, /lineageMoved\(scanLineage, currentLineage, messageId\) \|\| Number\(stateVersions\.get\(scanChatKey\)[\s\S]*?stale result was discarded/, 'async scan results must be invalidated by either branch lineage or dossier-state changes');
    assert.match(index, /const scanExpected = shouldForceBranchScan \|\| autoScanDue \|\| captureDue;[\s\S]*?commitBranchCheckpoint\(state, messageId, 'turn'\)/, 'assistant receipt must be checkpointed independently of whether its scan succeeds');
});

test('a reply rewritten in place by another extension is still the same reply (1.2.9)', () => {
    // Story Block, RPG Battle and Story Director write into a reply just after it arrives; the
    // receipt and the scan (and the one-pass capture it merges) must not take that for a new branch.
    assert.match(index, /function sameReplyRewritten\(chatKey, messageId, parentKey\)[\s\S]*?replyParentKey\(messageId\) === parentKey/);
    assert.match(index, /function lineageMoved\(previous, current, messageId\)[\s\S]*?at !== messageId \|\| previous\.length !== current\.length/);
    assert.match(index, /const sourceStillHere = \(\) => \{[\s\S]*?sameReplyRewritten\(eventChatKey, messageId, eventParent\)[\s\S]*?eventSourceKey = now;/);
    assert.match(index, /if \(!sourceStillHere\(\)\) return;\n\n    \/\/ SillyTavern 1\.18 emits MESSAGE_SWIPED/);
    assert.match(index, /const sourceMoved = \(\) => getChatKey\(\) !== scanChatKey \|\| \(sourceFingerprint !== null[\s\S]*?!sameReplyRewritten\(scanChatKey, messageId, sourceParent\)\)/);
    assert.match(index, /operation\.sourceMessageId = Number\.isInteger\(messageId\) \? messageId : null;/);
    const scanNowBody = index.slice(index.indexOf('async function scanNow('), index.indexOf('\nasync function ', index.indexOf('async function scanNow(') + 10));
    assert.doesNotMatch(scanNowBody, /firstLineageDivergence\(scanLineage, currentLineage\) !== -1/, 'no scanNow stale check ignores in-place rewrites');
});
