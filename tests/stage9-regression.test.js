import test from 'node:test';
import assert from 'node:assert/strict';
import { appearanceDraftRecord, resolveNpcAppearance } from '../appearance.js';
import { applyNpcStateCommand, buildInjection, mergeScanResult, normalizeNpcRecord, setActiveCalendarConfig, stripUiNoise } from '../core.js';
import { deriveAgeFromBirthDate, extractStructuredWorldDate } from '../calendar.js';
import { decodeNpcStateBundle, encodeNpcStateBundle } from '../bundle.js';
import { buildHistoryArchive, prepareNativeImport } from '../native-transfer.js';
import { nativeImportResultSummary } from '../dossier-tools.js';
import { recordToolEvent, toolEvents } from '../dossier-tools-core.js';
import { execFileSync } from 'node:child_process';

const calendar = { era: 'CR', months: [{ name: 'Redleaf', days: 30 }, { name: 'Sunwane', days: 31 }] };
const world = year => `<World_State>Time | CR${year}, Redleaf 16 | 7:42 pm\nNPCs Present: Mira</World_State>`;
function shape() {
    return normalizeNpcRecord({ id: 'mira', name: 'Mira', appearanceModelVersion: 1,
        currentForm: 'Human', overallAppearance: 'Silver pendant.',
        appearanceForms: [{ name: 'Human', appearance: 'Golden-blue hair and ordinary human ears.' }, { name: 'Raven', appearance: 'Black feathers, hooked beak and wings.' }],
        manualProfileLocksExplicit: true, manualProfileFields: ['appearance', 'speech'] });
}
test.afterEach(() => setActiveCalendarConfig(null));

test('locked manual form switch does not overwrite selected anatomy with the old compatibility scalar', () => {
    const original = shape();
    const next = appearanceDraftRecord(original, { currentForm: 'Raven', overallAppearance: original.overallAppearance }, { lockAppearance: true });
    assert.match(resolveNpcAppearance(next), /hooked beak/);
    assert.doesNotMatch(resolveNpcAppearance(next), /human ears/);
    assert.deepEqual(next.appearanceForms, original.appearanceForms);
    assert.deepEqual(next.manualProfileFields, ['appearance', 'speech']);
    assert.equal(original.currentForm, 'Human');
    assert.match(resolveNpcAppearance(original), /Golden-blue/);
});
test('unknown manual form can explicitly clear old anatomy without deleting named forms', () => {
    const next = appearanceDraftRecord(shape(), { currentForm: '__unknown__', unclassifiedAppearance: '', overallAppearance: '' }, { lockAppearance: true });
    assert.equal(resolveNpcAppearance(next), '');
    assert.equal(next.appearanceForms.length, 2);
});
test('native cross-chat import clears new birthday and death-correction source IDs but keeps accepted data', () => {
    const npc = { ...shape(), birthDate: { month: '09', day: 17, year: null }, birthDateSource: 'established', birthDateSourceMessageId: 19,
        deathCorrection: { previousDeathSourceMessageId: 18 }, relationshipProgress: { trust: 0.375 }, relationshipMilestones: [{ sourceMessageId: 20 }] };
    for (const source of ['chat:owner:source', '']) {
        const data = encodeNpcStateBundle({ npcs: [npc] }, { chatKey: source });
        const imported = decodeNpcStateBundle(prepareNativeImport(data, 'chat:owner:target').importBytes).state.npcs[0];
        assert.equal(imported.birthDateSourceMessageId, null);
        assert.equal(imported.deathCorrection.previousDeathSourceMessageId, null);
        assert.equal(imported.relationshipMilestones[0].sourceMessageId, null);
        assert.equal(imported.relationshipProgress.trust, 0.375);
        assert.deepEqual(imported.appearanceForms, npc.appearanceForms);
    }
    const same = decodeNpcStateBundle(prepareNativeImport(encodeNpcStateBundle({ npcs: [npc] }, { chatKey: 'chat:owner:same' }), 'chat:owner:same').importBytes).state.npcs[0];
    assert.equal(same.birthDateSourceMessageId, 19);
});
test('all dossiers are structurally validated before any malformed native import can be applied', () => {
    for (const malformed of [null, 'not a dossier', [], { id: 5 }, { relationship: 'bad' }, { relationshipProgress: { trust: 'not numeric' } }]) {
        const original = { npcs: [shape(), malformed] };
        const manifest = new TextEncoder().encode(JSON.stringify({
            format: 'npc_state_delta_bundle', formatVersion: 1, state: original,
        }));
        const encoded = new Uint8Array(12 + manifest.length);
        encoded.set(new TextEncoder().encode('NPCSTB01'));
        new DataView(encoded.buffer).setUint32(8, manifest.length, true);
        encoded.set(manifest, 12);
        assert.throws(() => prepareNativeImport(encoded, 'chat:owner:target'), /dossier|Dossier/);
        assert.equal(original.npcs[0].name, 'Mira');
    }
});
test('history audit stripping is a single copying traversal and never mutates source portrait assets', () => {
    const original = { lineage: ['a'], checkpoints: [{ snapshot: { npcs: [{ portrait: { dataUrl: 'data:image/png;base64,AA==', mime: 'image/png' } }] } }] };
    const before = structuredClone(original);
    const archive = buildHistoryArchive(original);
    assert.equal(archive.checkpoints[0].snapshot.npcs[0].portrait.dataUrl, undefined);
    archive.lineage.push('b');
    assert.deepEqual(original, before);
});
test('calendar header wins over NPC birth dates and mixed block types obey textual order', () => {
    const old = '<details><summary>World State</summary>Time | CR820, Redleaf 16</details>';
    const current = `${world(821).replace('Mira', 'Mira, born CR815, Redleaf 16')}`;
    assert.equal(extractStructuredWorldDate(`${old}\n${current}`, calendar).date.year, 821);
    assert.equal(extractStructuredWorldDate(`${current}\n${old}`, calendar).date.year, 820);
});
test('numeric compatibility age compares birthday month/day independently of leap years', () => {
    assert.equal(deriveAgeFromBirthDate('2000-03-01', '2021-03-01'), 21);
    assert.equal(deriveAgeFromBirthDate('2001-03-01', '2020-02-29'), 18);
});
test('manual add uses configured months rather than Array.map callback index as calendar configuration', () => {
    setActiveCalendarConfig(calendar);
    const result = applyNpcStateCommand({ npcs: [] }, { action: 'add', name: 'Mira' });
    assert.ok(['Redleaf', 'Sunwane'].includes(result.state.npcs[0].birthDate.month));
});
test('raw owned calendar source survives production UI-noise stripping without changing scanner text', () => {
    setActiveCalendarConfig(calendar);
    const npc = normalizeNpcRecord({ id: 'mira', name: 'Mira', age: '6', apparentAge: '~6', birthDate: { era: 'CR', year: 815, month: 'Redleaf', day: 16 }, birthDateSource: 'established' });
    const source = world(822);
    const text = stripUiNoise(source);
    assert.doesNotMatch(text, /<World_State>/);
    const result = mergeScanResult({ npcs: [npc] }, { npcs: [] }, { developmentContext: text, calendarSource: source, sourceMessageId: 2 });
    assert.equal(result.state.npcs[0].age, '7');
    assert.equal(result.state.npcs[0].apparentAge, '~7');
    assert.equal(result.report.calendarReference.date.year, 822);
});
test('calendar update honors manual age locks and terminal automatic death', () => {
    setActiveCalendarConfig(calendar);
    for (const extra of [{ manualProfileLocksExplicit: true, manualProfileFields: ['age'] }, { lifeState: 'deceased', lifeStateCertainty: 'explicit' }]) {
        const npc = normalizeNpcRecord({ id: 'mira', name: 'Mira', age: '6', birthDate: { era: 'CR', year: 815, month: 'Redleaf', day: 16 }, birthDateSource: 'established', ...extra });
        const result = mergeScanResult({ npcs: [npc] }, { npcs: [] }, { calendarSource: world(822) });
        assert.equal(result.state.npcs[0].age, '6');
    }
});
test('accepted age is not rolled backwards in injection by an older manual fallback clock', () => {
    setActiveCalendarConfig({ ...calendar, currentYear: 821, currentMonth: 'Redleaf', currentDay: 16 });
    const npc = { id: 'mira', name: 'Mira', age: '7', present: true, birthDate: { era: 'CR', year: 815, month: 'Redleaf', day: 16 }, birthDateSource: 'established' };
    const injection = buildInjection([npc], 'Mira is here.', 1, 3);
    assert.match(injection, /7/);
    assert.doesNotMatch(injection, /age[=: ]+6/i);
});
test('bounded diagnostic history never retains exception details containing prompts or credentials', () => {
    toolEvents.splice(0);
    recordToolEvent('persistence', { action: 'save', persisted: false, detail: 'Authorization: Bearer SECRET; system prompt PRIVATE' });
    assert.doesNotMatch(JSON.stringify(toolEvents), /SECRET|PRIVATE|Authorization/);
    assert.equal(toolEvents[0].persisted, false);
});
test('production request bytes, retry counts, output allowances and flags match the recorded baseline', () => {
    execFileSync(process.execPath, ['scripts/measure-stage9.mjs'], { cwd: new URL('..', import.meta.url), stdio: 'pipe' });
});

function uncheckedBundle(manifest) {
    const text = new TextEncoder().encode(JSON.stringify(manifest));
    const result = new Uint8Array(12 + text.length);
    result.set(new TextEncoder().encode('NPCSTB01'));
    new DataView(result.buffer).setUint32(8, text.length, true);
    result.set(text, 12);
    return result;
}
test('native validation rejects unsafe object metadata, reserved IDs and excessive nested history', () => {
    const base = () => ({ format: 'npc_state_delta_bundle', formatVersion: 1, state: { npcs: [shape()] } });
    for (const key of ['__proto__', 'constructor', 'prototype']) {
        const manifest = base();
        manifest.state.npcs[0].notes = JSON.parse(`{"${key}":{"polluted":true}}`);
        assert.throws(() => decodeNpcStateBundle(uncheckedBundle(manifest)), /unsafe object metadata/);
        const idManifest = base(); idManifest.state.npcs[0].id = key;
        assert.throws(() => decodeNpcStateBundle(uncheckedBundle(idManifest)), /reserved/);
    }
    const manifest = base(); let nested = manifest;
    for (let i = 0; i < 66; i++) { nested.nested = {}; nested = nested.nested; }
    assert.throws(() => decodeNpcStateBundle(uncheckedBundle(manifest)), /64-level/);
    assert.equal({}.polluted, undefined);
});
test('older manual fallback does not reverse accepted canonical age on a later date-less scan', () => {
    setActiveCalendarConfig({ ...calendar, currentYear: 821, currentMonth: 'Redleaf', currentDay: 16 });
    const npc = normalizeNpcRecord({ id: 'mira', name: 'Mira', age: '7', birthDate: { era: 'CR', year: 815, month: 'Redleaf', day: 16 }, birthDateSource: 'established' });
    const result = mergeScanResult({ npcs: [npc] }, { npcs: [] }, { calendarSource: 'Ordinary conversation without a date.' });
    assert.equal(result.state.npcs[0].age, '7');
    for (const extra of [{ manualProfileFields: ['age'], manualProfileLocksExplicit: true }, { lifeState: 'deceased', lifeStateCertainty: 'explicit' }]) {
        const locked = { ...npc, age: '5', present: true, ...extra };
        if (extra.lifeState) assert.equal(buildInjection([locked], 'Mira is here.', 1, 3), '');
        else assert.match(buildInjection([locked], 'Mira is here.', 1, 3), /5/);
    }
});

test('native import feedback reports accepted and skipped counts rather than input dossier count', () => {
    const summary = nativeImportResultSummary({ importReport: { added: [{}], updated: [{}, {}], skipped: Array(7).fill({ reason: 'capacity' }) } });
    assert.match(summary, /1 added, 2 updated, 7 skipped/);
    assert.match(summary, /existing active dossiers were preserved/);
    assert.match(nativeImportResultSummary(), /0 added, 0 updated, 0 skipped/);
});
