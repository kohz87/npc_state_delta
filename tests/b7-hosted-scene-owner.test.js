// B-b7-combos-11: while hosted by Story Block v2 there are two authorities for who is in the scene:
// Story Block's `scene.present` (from `+ present` / `- present` lines, in its tail as "Present: …")
// and NSD's own presence (scanner / one-pass capture), injected as "NPC STATE DELTA DOSSIER. Only
// confirmed-present NPCs are included". NSD's v1 source-of-truth switch ("scene: theirs" = Story
// Block keeps the scene) only works through the v1 suite registry, which a v2 host never fills, so
// the reader's choice is silently ignored. Live: after `- present Fenna` Story Block's tail drops her
// while NSD's dossier injection still presents her as in the scene, in the same prompt.


import test from 'node:test';
import assert from 'node:assert/strict';

import { defersArea } from '../suite-handshake.js';

test('with a Story Block v2 host, "scene: theirs" defers the scene to Story Block', () => {
    const before = globalThis.StoryBlock;
    const sdk = { apiVersion: 2, registerModule: async () => sdk, query: name => (name === 'scene.present' ? ['Hollis'] : null) };
    globalThis.StoryBlock = Object.freeze({ apiVersion: 2, version: '2.0.0-alpha.1', ready: Promise.resolve(sdk), sdk });
    try {
        assert.equal(defersArea('scene', { scene: 'theirs' }), true, 'the reader chose Story Block for the scene, and a v2 Story Block keeps one');
    } finally {
        if (before === undefined) delete globalThis.StoryBlock;
        else globalThis.StoryBlock = before;
    }
});
