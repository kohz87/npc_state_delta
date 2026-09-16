import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    createDestructiveSettlementController,
    destructiveMutationSettled,
    firstNarrativeDivergence,
    narrativeLineage,
} from '../destructive-settlement-core.js';

function user(mes) { return { is_user: true, is_system: false, mes }; }
function assistant(mes) { return { is_user: false, is_system: false, mes }; }

function controllerHarness(initialChat, { probe = () => null } = {}) {
    let chat = structuredClone(initialChat);
    let chatKey = 'chat:test';
    let clock = 1000;
    const reconciliations = [];
    const timeouts = [];
    const errors = [];
    const timers = new Set();
    const controller = createDestructiveSettlementController({
        getChat: () => chat,
        getChatKey: () => chatKey,
        reconcile: async options => { reconciliations.push(options); },
        probe,
        isSwipeActive: () => false,
        setTimer: fn => { const token = { fn }; timers.add(token); return token; },
        clearTimer: token => timers.delete(token),
        now: () => clock,
        pollMs: 50,
        timeoutMs: 5000,
        onTimeout: pending => timeouts.push(pending),
        onError: error => errors.push(error),
    });
    return {
        controller,
        reconciliations,
        timeouts,
        errors,
        setChat: value => { chat = structuredClone(value); },
        setChatKey: value => { chatKey = value; },
        advance: ms => { clock += ms; },
    };
}

test('destructive lineage helpers distinguish unchanged, delete, and edit mutations', () => {
    const original = narrativeLineage([user('u1'), assistant('a1'), user('u2'), assistant('a2')]);
    const deleted = narrativeLineage([user('u1'), assistant('a1')]);
    const edited = narrativeLineage([user('u1'), assistant('a1 revised'), user('u2'), assistant('a2')]);
    assert.equal(firstNarrativeDivergence(original, original), -1);
    assert.equal(firstNarrativeDivergence(original, deleted), 2);
    assert.equal(firstNarrativeDivergence(original, edited), 1);
    assert.equal(destructiveMutationSettled('delete', original, original), false);
    assert.equal(destructiveMutationSettled('delete', original, deleted), true);
    assert.equal(destructiveMutationSettled('edit', original, original), false);
    assert.equal(destructiveMutationSettled('edit', original, edited), true);
});

test('delete event stays pending while SillyTavern still exposes the old chat, then reconciles observed truncation', async () => {
    const original = [user('u1'), assistant('a1'), user('u2'), assistant('a2')];
    const harness = controllerHarness(original);
    assert.equal(harness.controller.schedule('delete', 2, 'message-deleted'), true);
    await harness.controller.pollNow();
    assert.equal(harness.reconciliations.length, 0);
    assert.equal(harness.controller.status().pending, true);

    harness.setChat(original.slice(0, 2));
    await harness.controller.pollNow();
    assert.equal(harness.reconciliations.length, 1);
    assert.deepEqual(harness.reconciliations[0], {
        explicitDivergence: 2,
        operation: 'delete',
        rescan: true,
        reason: 'message-deleted-settled',
        chatKey: 'chat:test',
    });
    assert.equal(harness.controller.status().pending, false);
    assert.equal(harness.errors.length, 0);
});

test('edit settlement uses the observed content divergence instead of callback timing', async () => {
    const original = [user('u1'), assistant('a1'), user('u2'), assistant('a2')];
    const harness = controllerHarness(original);
    harness.controller.schedule('edit', 3, 'message-edited');
    await harness.controller.pollNow();
    assert.equal(harness.reconciliations.length, 0);

    harness.setChat([user('u1'), assistant('a1 revised'), user('u2'), assistant('a2')]);
    await harness.controller.pollNow();
    assert.equal(harness.reconciliations.length, 1);
    assert.equal(harness.reconciliations[0].explicitDivergence, 1);
    assert.equal(harness.reconciliations[0].operation, 'edit');
});

test('rapid destructive events preserve the earliest observed baseline and deletion authority', async () => {
    const original = [user('u1'), assistant('a1'), user('u2'), assistant('a2'), user('u3'), assistant('a3')];
    const harness = controllerHarness(original);
    harness.controller.schedule('edit', 4, 'message-edited');
    harness.controller.schedule('delete', 2, 'message-deleted');
    harness.setChat(original.slice(0, 2));
    await harness.controller.pollNow();
    assert.equal(harness.reconciliations.length, 1);
    assert.equal(harness.reconciliations[0].operation, 'delete');
    assert.equal(harness.reconciliations[0].explicitDivergence, 2);
});

test('immediate probe cancels fallback settlement when the host mutation already landed before the event callback', async () => {
    const alreadyDeleted = [user('u1'), assistant('a1')];
    const probes = [];
    const harness = controllerHarness(alreadyDeleted, {
        probe: async options => {
            probes.push(options);
            return { invalidated: true };
        },
    });
    harness.controller.schedule('delete', 2, 'message-deleted');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(probes.length, 1);
    assert.equal(probes[0].operation, 'delete');
    assert.equal(harness.controller.status().pending, false);
    assert.equal(harness.timeouts.length, 0);
});

test('chat switch cancels a pending destructive settlement and timeout fails closed', async () => {
    const original = [user('u1'), assistant('a1'), user('u2'), assistant('a2')];
    const switched = controllerHarness(original);
    switched.controller.schedule('delete', 2, 'message-deleted');
    switched.setChatKey('chat:other');
    await switched.controller.pollNow();
    assert.equal(switched.controller.status().pending, false);
    assert.equal(switched.reconciliations.length, 0);

    const timedOut = controllerHarness(original);
    timedOut.controller.schedule('delete', 2, 'message-deleted');
    timedOut.advance(5001);
    await timedOut.controller.pollNow();
    assert.equal(timedOut.reconciliations.length, 0);
    assert.equal(timedOut.timeouts.length, 1);
    assert.equal(timedOut.controller.status().pending, false);
});

test('runtime wiring loads the settlement adapter after the canonical index and listens only to destructive/chat-change events', () => {
    const bootstrap = fs.readFileSync(new URL('../bootstrap.js', import.meta.url), 'utf8');
    const adapter = fs.readFileSync(new URL('../destructive-settlement.js', import.meta.url), 'utf8');
    const runtime = JSON.parse(fs.readFileSync(new URL('../runtime-modules.json', import.meta.url), 'utf8'));
    assert.match(bootstrap, /await import\('\.\/index\.js'\);[\s\S]*await import\('\.\/destructive-settlement\.js'\)/);
    assert.match(adapter, /MESSAGE_DELETED[\s\S]*controller\.schedule\('delete'/);
    assert.match(adapter, /MESSAGE_EDITED[\s\S]*controller\.schedule\('edit'/);
    assert.match(adapter, /CHAT_CHANGED[\s\S]*controller\.cancel\(\)/);
    assert.equal(runtime.modules.some(module => module.path === 'destructive-settlement.js'), true);
    assert.equal(runtime.modules.some(module => module.path === 'destructive-settlement-core.js'), true);
});
