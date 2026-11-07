import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventRegistration } from '../runtime-entry-events.js';

// CHAT_CHANGED cancels the scan of every cached chat; the cache must reach the split-out registration.
test('CHAT_CHANGED listener cancels the scan operation of each cached chat key', async () => {
    const handlers = {};
    const source = { on: (name, fn) => { handlers[name] = fn; } };
    const rt = { eventsRegistered: false, swipeSettlementSequence: 0 };
    const cancelled = [];
    const noop = () => {};
    const deps = new Proxy({
        getContext: () => ({ eventTypes: { CHAT_CHANGED: 'chat_changed' }, eventSource: source, chat: [] }),
        chatStateCache: new Map([['a', {}], ['b', {}]]),
        cancelScanOperation: key => cancelled.push(key),
        getChatKey: () => 'no-chat',
        isCanonicalChatKey: () => false,
        staleHostChats: new Set(), retiredInSessionChats: new Set(), openingHostChats: new Set(), castPortraitMisses: new Set(),
        setScanIndicator: noop, isScanBusy: () => false,
    }, { get: (target, name) => (name in target ? target[name] : noop) });
    createEventRegistration(rt, deps)();
    await handlers.chat_changed();
    assert.deepEqual(cancelled, ['a', 'b']);
});
