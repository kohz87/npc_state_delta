import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeStateFilePayload, decodeStateFilePayload, makeNpcStateDataFileName } from '../storage.js';
import { encodeNpcStateBundle, decodeNpcStateBundle } from '../bundle.js';

test('Delta sidecars round-trip their own namespace and reject legacy data', () => {
  const own = encodeStateFilePayload('chat:test.png:seed', { npcs: [] }, '0.1.0');
  const payload = decodeStateFilePayload(own);
  assert.equal(payload.format, 'npc_state_delta_chat_data');
  assert.equal(payload.chatKey, 'chat:test.png:seed');
  assert.equal(payload.appVersion, '0.1.0');
  assert.match(makeNpcStateDataFileName(payload.chatKey), /^npc-state-delta-/);
  assert.throws(() => decodeStateFilePayload(JSON.stringify({ ...payload, format: 'npc_state_chat_data' })), /Not an NPC State Delta/);
});

test('Delta native bundle rejects a valid-envelope legacy format without conversion', () => {
  const own = encodeNpcStateBundle({ npcs: [], dismissed: [] });
  assert.doesNotThrow(() => decodeNpcStateBundle(own));
  const length = new DataView(own.buffer, own.byteOffset, own.byteLength).getUint32(8, true);
  const header = own.slice(0, 12);
  const manifest = JSON.parse(new TextDecoder().decode(own.subarray(12, 12 + length)));
  manifest.format = 'npc_state_bundle';
  const foreignManifest = new TextEncoder().encode(JSON.stringify(manifest));
  const foreign = new Uint8Array(12 + foreignManifest.length);
  foreign.set(header);
  new DataView(foreign.buffer).setUint32(8, foreignManifest.length, true);
  foreign.set(foreignManifest, 12);
  assert.throws(() => decodeNpcStateBundle(foreign), /Not an NPC State Delta bundle/);
});
