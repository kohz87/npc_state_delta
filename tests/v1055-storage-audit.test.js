import test from 'node:test';
import assert from 'node:assert/strict';
import {
    encodeRetiredStateFilePayload,
    encodeStateFilePayload,
    makeNpcStateDataFileName,
    writeNpcStateDataFile,
} from '../storage.js';
import { createNpcRecord } from '../core.js';

test('an unpointered first write probes the deterministic sidecar and refuses to overwrite another session', async () => {
    const chatKey = 'chat:unpointered-first-write';
    const name = makeNpcStateDataFileName(chatKey);
    const path = `/user/files/${name}`;
    const remote = encodeStateFilePayload(chatKey, { turn: 5, npcs: [createNpcRecord('Remote')] }, '1.0.54', {
        revision: 5,
        writerId: 'other-session',
    });
    let uploads = 0;
    const fetchFn = async (url) => {
        if (url === path) return { ok: true, status: 200, text: async () => remote };
        if (url === '/api/files/upload') {
            uploads += 1;
            return { ok: true, status: 200, json: async () => ({ path }), text: async () => '' };
        }
        return { ok: false, status: 404, text: async () => '' };
    };
    await assert.rejects(
        writeNpcStateDataFile({
            chatKey,
            state: { turn: 1, npcs: [createNpcRecord('Local')] },
            appVersion: '1.0.55',
            pointer: null,
            fetchFn,
            continuousRetry: false,
        }),
        error => error?.code === 'NPC_STATE_WRITE_CONFLICT' && error.expectedRevision === null && error.actualRevision === 5,
    );
    assert.equal(uploads, 0, 'a session without a revision token must not replace an existing canonical sidecar');
});

test('an unpointered first write still creates a missing deterministic sidecar', async () => {
    const chatKey = 'chat:unpointered-create';
    const files = new Map();
    const fetchFn = async (url, options = {}) => {
        if (url === '/api/files/upload') {
            const body = JSON.parse(options.body);
            const filePath = `/user/files/${body.name}`;
            files.set(filePath, Buffer.from(body.data, 'base64').toString('utf8'));
            return { ok: true, status: 200, json: async () => ({ path: filePath }), text: async () => '' };
        }
        if (files.has(url)) return { ok: true, status: 200, text: async () => files.get(url) };
        return { ok: false, status: 404, text: async () => '' };
    };
    const written = await writeNpcStateDataFile({ chatKey, state: { turn: 1, npcs: [] }, appVersion: '1.0.55', pointer: null, fetchFn, continuousRetry: false });
    assert.equal(written.revision, 1);
    assert.equal(written.path, `/user/files/${makeNpcStateDataFileName(chatKey)}`);
});

test('a lost upload acknowledgement is recognized as this writer\'s own durable revision on retry', async () => {
    const chatKey = 'chat:lost-ack';
    const name = makeNpcStateDataFileName(chatKey);
    const path = `/user/files/${name}`;
    let server = encodeStateFilePayload(chatKey, { turn: 2, npcs: [] }, '1.0.54', { revision: 2, writerId: 'base-writer' });
    let uploads = 0;
    let failNextVerification = false;
    const fetchFn = async (url, options = {}) => {
        if (url === path) {
            if (failNextVerification) {
                failNextVerification = false;
                throw new Error('network connection reset');
            }
            return { ok: true, status: 200, text: async () => server };
        }
        if (url === '/api/files/upload') {
            uploads += 1;
            const body = JSON.parse(options.body);
            server = Buffer.from(body.data, 'base64').toString('utf8');
            failNextVerification = uploads === 1;
            return { ok: true, status: 200, json: async () => ({ path }), text: async () => '' };
        }
        return { ok: false, status: 404, text: async () => '' };
    };
    const written = await writeNpcStateDataFile({
        chatKey,
        state: { turn: 3, npcs: [createNpcRecord('Local')] },
        appVersion: '1.0.55',
        pointer: { name, path, revision: 2, writerId: 'base-writer' },
        fetchFn,
        continuousRetry: false,
        sleepFn: (resolve) => resolve(),
    });
    assert.equal(written.revision, 3, 'the already-durable upload is adopted rather than reported as another session');
    assert.equal(uploads, 1, 'the identical durable payload is not uploaded again');
    assert.equal(JSON.parse(server).state.npcs[0].name, 'Local');
});

test('a same-writer revision with different content is still a conflict after a lost acknowledgement', async () => {
    const chatKey = 'chat:lost-ack-overwritten';
    const name = makeNpcStateDataFileName(chatKey);
    const path = `/user/files/${name}`;
    let server = encodeStateFilePayload(chatKey, { turn: 2, npcs: [] }, '1.0.54', { revision: 2, writerId: 'base-writer' });
    let uploads = 0;
    let failNextVerification = false;
    const fetchFn = async (url, options = {}) => {
        if (url === path) {
            if (failNextVerification) {
                failNextVerification = false;
                // Another session replaces the revision while this writer's acknowledgement is lost.
                const replaced = JSON.parse(server);
                replaced.revision = 4;
                replaced.writerId = 'other-session';
                server = JSON.stringify(replaced);
                throw new Error('network connection reset');
            }
            return { ok: true, status: 200, text: async () => server };
        }
        if (url === '/api/files/upload') {
            uploads += 1;
            const body = JSON.parse(options.body);
            server = Buffer.from(body.data, 'base64').toString('utf8');
            failNextVerification = uploads === 1;
            return { ok: true, status: 200, json: async () => ({ path }), text: async () => '' };
        }
        return { ok: false, status: 404, text: async () => '' };
    };
    await assert.rejects(
        writeNpcStateDataFile({
            chatKey,
            state: { turn: 3, npcs: [] },
            appVersion: '1.0.55',
            pointer: { name, path, revision: 2, writerId: 'base-writer' },
            fetchFn,
            continuousRetry: false,
            sleepFn: (resolve) => resolve(),
        }),
        error => error?.code === 'NPC_STATE_WRITE_CONFLICT' && error.actualRevision === 4,
    );
    assert.equal(uploads, 1);
});

test('an unpointered first write may replace a retired tombstone for a reused chat name', async () => {
    const chatKey = 'chat:unpointered-retired';
    const path = `/user/files/${makeNpcStateDataFileName(chatKey)}`;
    let server = encodeRetiredStateFilePayload(chatKey, 'chat-deleted', '1.0.54', { revision: 7, writerId: 'old-session' });
    const fetchFn = async (url, options = {}) => {
        if (url === '/api/files/upload') {
            server = Buffer.from(JSON.parse(options.body).data, 'base64').toString('utf8');
            return { ok: true, status: 200, json: async () => ({ path }), text: async () => '' };
        }
        if (url === path) return { ok: true, status: 200, text: async () => server };
        return { ok: false, status: 404, text: async () => '' };
    };
    const written = await writeNpcStateDataFile({ chatKey, state: { turn: 1, npcs: [] }, appVersion: '1.0.55', pointer: null, fetchFn, continuousRetry: false });
    assert.equal(written.revision, 8, 'the replacement still advances past the tombstone revision');
    assert.notEqual(JSON.parse(server).retired, true);
});
