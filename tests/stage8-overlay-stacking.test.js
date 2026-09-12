import test from 'node:test';
import assert from 'node:assert/strict';
import { modalTopLayerSupported, overlayMountHost } from '../dossier-tools-core.js';

test('supporting tools mount on body and prefer a native modal dialog top layer', () => {
    const previousDocument = globalThis.document;
    const body = { id: 'body', appendChild() {} };
    globalThis.document = {
        body,
        createElement: tag => tag === 'dialog' ? { showModal() {} } : {},
        getElementById: () => ({ id: 'npc_state_delta_dossier_root', isConnected: true, appendChild() {} }),
    };
    try {
        assert.equal(overlayMountHost(), body, 'top-layer dialogs should not inherit the dossier stacking context');
        assert.equal(modalTopLayerSupported(), true);
        globalThis.document.createElement = () => ({});
        assert.equal(modalTopLayerSupported(), false, 'fixed fallback remains detectable for older hosts');
    } finally {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
    }
});
