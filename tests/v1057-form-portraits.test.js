import test from 'node:test';
import assert from 'node:assert/strict';
import { appearanceFingerprint, createNpcRecord, normalizeFormPortraitAssets, normalizeNpcRecord } from '../core.js';
import { decodeNpcStateBundle, encodeNpcStateBundle, mergeImportedDossierState } from '../bundle.js';
import { prepareNativeImport } from '../native-transfer.js';
import { pruneFormPortraitAssetsForState } from '../storage.js';
import { dossierDetailProjection } from '../dossier-ui.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAaX2RUAAAAAASUVORK5CYII=';
const shifter = (extra = {}) => normalizeNpcRecord({
    ...createNpcRecord('Mira'),
    appearanceForms: [{ name: 'Human', appearance: 'Copper hair; linen dress' }, { name: 'Fox', appearance: 'Red fur; white-tipped tail' }],
    currentForm: 'Human',
    portrait: { dataUrl: PNG },
    ...extra,
});

test('form portrait assets are bounded and reject malformed or reserved entries', () => {
    const forms = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, { dataUrl: PNG, form: `Form ${i}` }]));
    const normalized = normalizeFormPortraitAssets({
        npc_a: forms,
        npc_b: { fox: { form: 'Fox' } },
        __proto__: { x: { dataUrl: PNG } },
        npc_c: 'not-an-object',
    });
    assert.equal(Object.keys(normalized.npc_a).length, 8, 'at most one image per appearance form, bounded to the form limit');
    assert.equal('npc_b' in normalized, false, 'entries without image data are dropped');
    assert.equal('npc_c' in normalized, false);
    assert.equal(normalized.npc_a['form 0'].form, 'Form 0');
});

test('form portraits round-trip through the native bundle and a prepared cross-chat import', () => {
    const npc = shifter();
    const state = { npcs: [npc], formPortraitAssets: { [npc.id]: { fox: { dataUrl: PNG, form: 'Fox', appearanceFingerprint: 'a1:x:1' } } } };
    const decoded = decodeNpcStateBundle(encodeNpcStateBundle(state, { chatKey: 'chat:a' }));
    assert.equal(decoded.state.formPortraitAssets[npc.id].fox.dataUrl, PNG);
    assert.equal(decoded.state.formPortraitAssets[npc.id].fox.appearanceFingerprint, 'a1:x:1');
    assert.equal(decoded.state.npcs[0].portrait.dataUrl, PNG, 'the main portrait encoding is unchanged');
    const prepared = decodeNpcStateBundle(prepareNativeImport(encodeNpcStateBundle(state, { chatKey: 'chat:a' }), 'chat:b').importBytes);
    assert.equal(prepared.state.formPortraitAssets[npc.id].fox.dataUrl, PNG);
});

test('bundles without form portraits decode as before and malformed form metadata is rejected', () => {
    const npc = shifter();
    const plain = decodeNpcStateBundle(encodeNpcStateBundle({ npcs: [npc] }));
    assert.deepEqual(plain.state.formPortraitAssets, {});
    const bytes = encodeNpcStateBundle({ npcs: [npc], formPortraitAssets: { [npc.id]: { fox: { dataUrl: PNG, form: 'Fox' } } } });
    const length = new DataView(bytes.buffer).getUint32(8, true);
    const manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + length)));
    manifest.state.formPortraits[0].portrait.binary.length = 999999;
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    const broken = new Uint8Array(12 + manifestBytes.length + (bytes.length - 12 - length));
    broken.set(bytes.subarray(0, 8));
    new DataView(broken.buffer).setUint32(8, manifestBytes.length, true);
    broken.set(manifestBytes, 12);
    broken.set(bytes.subarray(12 + length), 12 + manifestBytes.length);
    assert.throws(() => decodeNpcStateBundle(broken), /form portrait is truncated/);
});

test("imports carry form portraits to the accepted target id and keep the target's other forms", () => {
    const target = shifter({ id: 'npc_target' });
    const incoming = shifter({ id: 'npc_source' });
    const merged = mergeImportedDossierState(
        { npcs: [target], formPortraitAssets: { npc_target: { human: { dataUrl: PNG, form: 'Human', mark: 'target-human' }, fox: { dataUrl: PNG, form: 'Fox', mark: 'target-fox' } } } },
        { npcs: [incoming], formPortraitAssets: { npc_source: { fox: { dataUrl: PNG, form: 'Fox', mark: 'imported-fox' } } } },
    );
    assert.equal(merged.formPortraitAssets.npc_target.fox.mark, 'imported-fox', 'the imported image replaces only the same form');
    assert.equal(merged.formPortraitAssets.npc_target.human.mark, 'target-human');
    assert.equal('npc_source' in merged.formPortraitAssets, false);

    const excluded = mergeImportedDossierState({ npcs: [] }, { npcs: [incoming], formPortraitAssets: { npc_source: { fox: { dataUrl: PNG, form: 'Fox' } } } }, { excludeNames: ['Mira'] });
    assert.deepEqual(excluded.formPortraitAssets, {}, 'a rejected import brings no images');
});

test('form portrait cleanup follows the same retention as main portraits', () => {
    const npc = shifter();
    const state = {
        npcs: [npc],
        checkpoints: [{ snapshot: { npcs: [shifter({ id: 'npc_old', name: 'Old Mira' })] } }],
        formPortraitAssets: {
            [npc.id]: { fox: { dataUrl: PNG, form: 'Fox' } },
            npc_old: { fox: { dataUrl: PNG, form: 'Fox' } },
            npc_gone: { fox: { dataUrl: PNG, form: 'Fox' } },
        },
    };
    assert.deepEqual(Object.keys(pruneFormPortraitAssetsForState(state)).sort(), [npc.id, 'npc_old'].sort(),
        'images stay while a live or checkpointed record can show them');
});

test("the dossier shows the current form's own portrait and badges it against that form", () => {
    const npc = shifter({ currentForm: 'Fox' });
    const fresh = { Fox: { dataUrl: PNG + '#fox', appearanceFingerprint: appearanceFingerprint(npc) } };
    const shown = dossierDetailProjection(npc, {}, fresh);
    assert.equal(shown.portrait, PNG + '#fox');
    assert.equal(shown.portraitFromForm, true);
    assert.equal(shown.portraitAppearanceChanged, false);
    assert.equal(shown.formPortraits.Fox, PNG + '#fox');

    const stale = dossierDetailProjection({ ...npc, appearanceForms: [npc.appearanceForms[0], { name: 'Fox', appearance: 'Silver fur; three tails' }] }, {}, fresh);
    assert.equal(stale.portraitAppearanceChanged, true, "a changed form description flags that form's image");

    const human = dossierDetailProjection(shifter(), {}, fresh);
    assert.equal(human.portrait, PNG, 'forms without their own image fall back to the main portrait');
    assert.equal(human.portraitFromForm, false);
});
