import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runtimeSource } from './helpers/runtime-source.js';

const source=runtimeSource();
const runtimeState=readFileSync(new URL('../runtime-state.js',import.meta.url),'utf8');

test('runtime integration uses per-chat scan operations and no legacy global scanBusy flag',()=>{
  assert.match(source,/createScanOperationRegistry/);
  assert.match(source,/beginScanOperation\(scanChatKey/);
  assert.match(source,/scanOperationCurrent\(scanChatKey, operation\)/);
  assert.doesNotMatch(source,/\bscanBusy\b/);
});

test('filename-only chat deletion fails closed instead of borrowing an unrelated active owner',()=>{
  assert.match(source,/removeDeletedChatState\(chatId, 'chat', ''\)/);
  assert.match(source,/removeDeletedChatState\(chatId, 'group', ''\)/);
  assert.doesNotMatch(source,/removeDeletedChatState\(chatId, 'chat', getCharacterOwnerId\(getContext\(\)\)\)/);
  assert.doesNotMatch(source,/for \(const key of \[`chat:\$\{id\}`, `group:\$\{id\}`\]\)/);
});

test('bundle import reports skipped capacity and only clears deletion state for accepted imports',()=>{
  assert.match(source,/report: importReport/);
  assert.match(source,/for \(const accepted of importReport\.accepted \|\| \[\]\)/);
  const tools = readFileSync(new URL('../dossier-tools.js', import.meta.url), 'utf8');
  assert.match(tools,/existing active dossiers were preserved/);
  assert.match(tools,/nativeImportResultSummary\(result\)/);
});

test('manual trash removes narrative name suppression while explicit host provenance can bypass generic branch heuristics',()=>{
  assert.match(source,/const permanentLabels = new Set/);
  assert.match(source,/working\.dismissed = .*?working\.dismissed/s);
  assert.match(source,/const mainChat = String\(metadata\?\.main_chat/);
  assert.match(source,/if \(!hasExplicitParent\) return false/);
});


test('deep hardening gates rendering and injection on hydration readiness',()=>{
  assert.match(source,/chatHydrationStatus\(chatKey\) !== 'ready'/);
  assert.match(source,/chatHydrationStatus\(injectionKey\) !== 'ready'/);
});

test('busy automatic scans coalesce instead of being silently dropped',()=>{
  assert.match(runtimeState,/pendingAutoScans: new Map\(\)/);
  assert.match(source,/queuePendingAutoScan\(scanChatKey, messageId, 'busy-auto-scan'\)/);
  assert.match(source,/drainPendingAutoScan\(scanChatKey\)/);
  assert.doesNotMatch(source,/attempt < 250/);
});

test('chat change hydration is chat-affine and stale async completion is rejected',()=>{
  assert.match(source,/if \(getChatKey\(\) !== key\) return;/);
  assert.match(source,/queueBranchReconcile\(\{ chatKey: key,/);
});


test('manual dossier editor validates birthday corrections through the canonical birthday engine',()=>{
  assert.match(source,/npc_state_delta_edit_birthday/);
  assert.match(source,/normalizeBirthDate\(birthdayInput\)/);
  assert.match(source,/applyNpcBirthdayUpdate\(next,/);
  assert.match(source,/birthDateState: 'correct'/);
  assert.match(source,/Manual dossier birthday correction\./);
  assert.match(source,/correctedBirthday\.birthDateSourceMessageId = null/);
  assert.match(source,/set\('npc_state_delta_edit_birthday', npc\.birthDateDisplay \|\| ''\)/);
});

test('a branch with only unsaved message tracking still inherits, and inheritance is marked decided only when it decides', () => {
  // Story Block's save point opens the branch for a moment and goes back: the branch can be left seeded in memory with its messages and
  // nothing else. With no file of its own it is still empty for inheritance, so "Return here" carries the parent's dossiers.
  assert.match(source, /const unsaved = !getSettings\(\)\.dataFiles\?\.\[key\]\?\.path;/);
  assert.match(source, /!current\.checkpoints\.length && \(!current\.lineage\.length \|\| unsaved\)/);
  const body = source.slice(source.indexOf('async function maybeInheritKnownBranch'), source.indexOf('function branchInheritancePending'));
  // a return because another chat was opened meanwhile decides nothing (the participant then still waits for the inheritance)
  assert.doesNotMatch(body.slice(body.indexOf('} finally {')), /branchInheritanceChecked\.add/);
  assert.match(body, /if \(!hasExplicitParent\) branchInheritanceChecked\.add\(key\);\n\s+if \(!hasExplicitParent\) return false;/);
  assert.match(body, /branchInheritanceChecked\.add\(key\);\n\s+if \(!inherited\) return false;/);
  // and the runtime gives the participant the wait and the inheritance itself
  assert.match(source, /branchPending: \(\) => branchInheritancePending\(\),/);
  assert.match(source, /inheritBranch: \(\) => maybeInheritKnownBranch\(\),/);
});

test('branch inheritance matches the open branch against its own main chat, not the chat open at startup', () => {
  const body = source.slice(source.indexOf('async function maybeInheritKnownBranch'), source.indexOf('function branchInheritancePending'));
  const hint = body.indexOf('setBranchProvenanceHint({ mainChat, currentKey: key });');
  assert.ok(hint > 0, 'the hint is installed for the branch being inherited');
  assert.ok(hint < body.indexOf('bestAncestorState('), 'before the ancestor is looked for');
});
