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
    assert.match(index, /firstLineageDivergence\(scanLineage, currentLineage\) !== -1 \|\| Number\(stateVersions\.get\(scanChatKey\)[\s\S]*?stale result was discarded/, 'async scan results must be invalidated by either branch lineage or dossier-state changes');
    assert.match(index, /const scanExpected = shouldForceBranchScan \|\| autoScanDue;[\s\S]*?commitBranchCheckpoint\(state, messageId, 'turn'\)/, 'assistant receipt must be checkpointed independently of whether its scan succeeds');
});
