import test from 'node:test';
import assert from 'node:assert/strict';
import { overlayMountHost } from '../dossier-tools-core.js';

test('supporting tools mount inside the dossier root so they share its stacking context', () => {
    const previousDocument = globalThis.document;
    const body = { id: 'body', appendChild() {} };
    const root = { id: 'npc_state_delta_dossier_root', isConnected: true, appendChild() {} };
    globalThis.document = {
        body,
        getElementById: id => id === root.id ? root : null,
    };
    try {
        assert.equal(overlayMountHost(), root);
        root.isConnected = false;
        assert.equal(overlayMountHost(), body);
    } finally {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
    }
});
