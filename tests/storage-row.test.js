// The Storage row (storage-row.js) and the vault's list()/remove(id): the mockup's wording and states, a confirmation before any removal, the
// disabled state with its reason, and a referenced checkpoint never removed (by the vault itself, whatever the caller asks).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorageRow, offReason, sizeText } from '../src/storysuite-participant/storage-row.js';
import { fileVault, memoryVault } from '../src/storysuite-participant/vault.js';
import { createVaultSweep } from '../src/storysuite-participant/vault-sweep.js';

const DAY = 24 * 60 * 60 * 1000;
const proof = (referenced = []) => ({ complete: true, referenced });
const live = () => ({});

class Node {
    constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.className = ''; this._text = ''; this.disabled = false; this.parent = null; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    replaceChildren(...nodes) { this._text = ''; this.children = []; this.append(...nodes); }
    setAttribute() {}
    addEventListener(name, fn) { this.listeners[name] = fn; }
    get isConnected() { return this.parent !== null; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
    all(out = []) { out.push(this); this.children.forEach(child => child.all(out)); return out; }
    button(label) { return this.all().find(node => node.tag === 'button' && node.textContent === label); }
}
function fakeDoc() {
    const slot = new Node('div');
    return { slot, createElement: tag => new Node(tag), querySelector: selector => (selector.includes('"storage"') ? slot : null) };
}
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve)); };

async function seeded(ids) {
    let t = 1000 * DAY;
    const vault = memoryVault({ now: () => t });
    for (const [id, bytesAgo] of ids) { await vault.put(id, { id, lineage: 'lg_seeded01', pad: 'x'.repeat(2000) }); vault.age(id, bytesAgo); }
    return { vault, now: () => t };
}

test('memory vault: list() reports id, size and time; remove(id) refuses an id in the referenced set and keeps the file', async () => {
    const { vault } = await seeded([['nk_aaaaaaa1', 40 * DAY], ['nk_aaaaaaa2', 1 * DAY]]);
    const listed = await vault.list();
    assert.deepEqual(listed.map(f => f.id).sort(), ['nk_aaaaaaa1', 'nk_aaaaaaa2']);
    assert.ok(listed.every(f => f.size > 2000 && Number.isFinite(f.modifiedAt)));
    assert.equal(await vault.remove('nk_aaaaaaa1', { referenced: new Set(['nk_aaaaaaa1']) }), false);
    assert.ok(await vault.get('nk_aaaaaaa1'));
    assert.equal(await vault.remove('nk_aaaaaaa1', { referenced: ['nk_other001'] }), true);
    assert.equal(await vault.get('nk_aaaaaaa1'), null);
    assert.equal(await vault.remove('nk_aaaaaaa1'), false);
});

test('file vault discovers old unregistered checkpoint files with host metadata and protects referenced files', async () => {
    const files = new Map();
    const times = new Map();
    const calls = [];
    const now = 100 * DAY;
    const oldName = 'npc-state-delta-checkpoint-nk_bbbbbbb1.json';
    const protectedName = 'npc-state-delta-checkpoint-nk_bbbbbbb2.json';
    files.set(oldName, '{"old":true}');
    files.set(protectedName, '{"used":true}');
    files.set('npc-state-delta-checkpoint-not-an-id.json', '{}');
    times.set(oldName, now - 60 * DAY);
    times.set(protectedName, now - 60 * DAY);
    const fetchFn = async (url, options = {}) => {
        calls.push(url);
        const name = url.split('/').pop();
        if (url === '/api/files/upload') { const body = JSON.parse(options.body); files.set(body.name, Buffer.from(body.data, 'base64').toString()); times.set(body.name, now); return { ok: true, status: 200 }; }
        if (url === '/api/files/verify') { const body = JSON.parse(options.body); return { ok: true, status: 200, json: async () => Object.fromEntries(body.urls.map(u => [u, files.has(u.split('/').pop())])) }; }
        if (url === '/api/data-maid/report') return { ok: true, json: async () => ({ token: 'test-token', report: { files: [...files].map(([n, text]) => ({ name: n, size: Buffer.byteLength(text), mtime: times.get(n) })) } }) };
        if (url === '/api/data-maid/finalize') return { ok: true, status: 204 };
        if (url === '/api/files/delete') { const n = JSON.parse(options.body).path.split('/').pop(); const had = files.delete(n); return { ok: had, status: had ? 200 : 404, text: async () => '' }; }
        if (files.has(name)) return { ok: true, status: 200, text: async () => files.get(name) };
        return { ok: false, status: 404, text: async () => '' };
    };
    const vault = fileVault({ fetchFn });
    await vault.put('nk_bbbbbbb3', { new: true });
    const listed = await vault.list();
    assert.deepEqual(listed.map(f => [f.id, f.modifiedAt]), [['nk_bbbbbbb1', now - 60 * DAY], ['nk_bbbbbbb2', now - 60 * DAY], ['nk_bbbbbbb3', now]]);
    assert.ok(calls.includes('/api/data-maid/finalize'));
    const before = calls.filter(u => u === '/api/files/delete').length;
    assert.equal(await vault.remove('nk_bbbbbbb2', { referenced: new Set(['nk_bbbbbbb2']) }), false);
    assert.equal(calls.filter(u => u === '/api/files/delete').length, before, 'no delete request for a referenced id');
    assert.equal(await vault.remove('../etc/passwd'), false);
    const sweep = createVaultSweep({ vault, now: () => now });
    const plan = await sweep.plan({ complete: true, referenced: ['nk_bbbbbbb2'] });
    assert.deepEqual(plan.candidates.map(file => file.id), ['nk_bbbbbbb1']);
    assert.deepEqual((await sweep.sweep()).deleted, ['nk_bbbbbbb1']);
    assert.equal(files.has(oldName), false);
    assert.equal(files.has(protectedName), true);
    assert.equal(files.has('npc-state-delta-checkpoint-nk_bbbbbbb3.json'), true);
});

test('the row shows the mockup text, asks for confirmation, and removes only after Remove', async () => {
    const { vault, now } = await seeded([['nk_ccccccc1', 40 * DAY], ['nk_ccccccc2', 50 * DAY], ['nk_ccccccc3', 60 * DAY], ['nk_ccccccc4', 2 * DAY]]);
    const doc = fakeDoc();
    const row = createStorageRow({ doc, vault, now, live, ask: async () => proof(['nk_ccccccc3']) });
    assert.equal(row.mount(doc), true);
    await settle();
    const text = doc.slot.textContent;
    assert.match(text, /Storage/);
    assert.match(text, /Old dossier files: 4 files, \d+ KB/);
    assert.match(text, /2 of them \(\d+ KB\) are older than 30 days and no chat or branch uses them\./);
    assert.match(text, /Only files that no chat or branch on this install uses, and older than 30 days, are removed\./);
    const clean = doc.slot.all().find(n => n.tag === 'button' && n.textContent.startsWith('Clean up 2 files ('));
    assert.ok(clean && doc.slot.button('Check again'));
    clean.listeners.click();
    assert.equal((await vault.list()).length, 4, 'nothing is removed before the confirmation');
    assert.match(doc.slot.textContent, /Remove 2 old dossier files \(\d+ KB\)\?/);
    assert.match(doc.slot.textContent, /No chat or branch uses these files, and each is older than 30 days\. Dossiers in your chats are not changed\. If you later restore an old chat from a backup, its dossiers may need to start from the chat\./);
    doc.slot.button('Cancel').listeners.click();
    assert.equal((await vault.list()).length, 4);
    doc.slot.all().find(n => n.textContent.startsWith('Clean up 2 files (')).listeners.click();
    doc.slot.button('Remove 2 files').listeners.click();
    await settle();
    assert.deepEqual((await vault.list()).map(f => f.id).sort(), ['nk_ccccccc3', 'nk_ccccccc4']);
    assert.match(doc.slot.textContent, /Old dossier files: 2 files/);
});

test('an unreadable chat disables Clean up with the reason and nothing can be removed', async () => {
    const { vault, now } = await seeded([['nk_ddddddd1', 90 * DAY], ['nk_ddddddd2', 90 * DAY]]);
    const doc = fakeDoc();
    const answer = { complete: false, unreadable: [{ reason: 'newer-version' }, { reason: 'unreadable' }] };
    const row = createStorageRow({ doc, vault, now, ask: async () => answer });
    row.mount(doc);
    await settle();
    const off = doc.slot.button('Clean up');
    assert.ok(off && off.disabled);
    assert.match(doc.slot.textContent, /Old dossier files: 2 files/);
    assert.match(doc.slot.textContent, /Clean-up is off: 2 chats could not be read \(one is from a newer version\), so it can't be sure which files are still used\./);
    assert.equal((await vault.list()).length, 2);
    assert.equal(row.state().kind, 'off');
});

test('a failed or missing referenced query is an incomplete check; Check again asks again', async () => {
    const { vault, now } = await seeded([['nk_eeeeeee1', 90 * DAY]]);
    const doc = fakeDoc();
    let asks = 0;
    const row = createStorageRow({ doc, vault, now, live, ask: async () => { asks += 1; if (asks === 1) throw new Error('no host'); return proof(); } });
    row.mount(doc);
    await settle();
    assert.equal(row.state().kind, 'off');
    assert.match(doc.slot.textContent, /Clean-up is off: the chats could not be checked/);
    doc.slot.button('Check again').listeners.click();
    await settle();
    assert.equal(row.state().kind, 'ready');
    assert.equal(asks, 2);
});

test('a checkpoint only a lineage index names is kept; one whose file or index cannot be read is kept; unnamed old ones are removable', async () => {
    const { vault, now } = await seeded([['nk_fffffff1', 90 * DAY], ['nk_fffffff2', 90 * DAY], ['nk_fffffff3', 90 * DAY]]);
    await vault.putIndex('lg_seeded01', { v: 2, acks: { e1: { checkpoint: 'nk_fffffff1', hash: 'h' } }, prepared: {}, returns: {}, selected: null, base: null });
    await vault.put('nk_fffffff9', { lineage: '' }); vault.age('nk_fffffff9', 90 * DAY);
    const doc = fakeDoc();
    const row = createStorageRow({ doc, vault, now, live, ask: async () => proof() });
    row.mount(doc);
    await settle();
    assert.equal(row.state().kind, 'ready');
    assert.deepEqual(row.state().plan.candidates.map(file => file.id).sort(), ['nk_fffffff2', 'nk_fffffff3'], 'named by the index, or no lineage: kept');
    const broken = { ...vault, getIndex: async () => { throw new Error('unreadable'); } };
    const doc2 = fakeDoc();
    const row2 = createStorageRow({ doc: doc2, vault: broken, now, live, ask: async () => proof() });
    row2.mount(doc2);
    await settle();
    assert.equal(row2.state().plan?.count ?? 0, 0, 'an unreadable index proves nothing, so nothing is offered');
});

test('a checkpoint newly referenced while confirmation is open is not removed', async () => {
    const { vault, now } = await seeded([['nk_ggggggg1', 90 * DAY]]);
    const doc = fakeDoc();
    let asks = 0;
    const row = createStorageRow({ doc, vault, now, live, ask: async () => (++asks === 1 ? proof() : proof(['nk_ggggggg1'])) });
    row.mount(doc);
    await settle();
    doc.slot.all().find(node => node.tag === 'button' && node.textContent.startsWith('Clean up 1 file')).listeners.click();
    doc.slot.button('Remove 1 file').listeners.click();
    await settle();
    assert.ok(await vault.get('nk_ggggggg1'));
    assert.equal(row.state().kind, 'ready');
    assert.equal(row.state().plan.count, 0);
    assert.match(doc.slot.textContent, /The file check changed/);
});

test('malformed reference proof, an unreadable open state, or an unavailable host file list disables cleanup', async () => {
    const { vault, now } = await seeded([['nk_hhhhhhh1', 90 * DAY]]);
    for (const [answer, current, reason] of [
        [{ complete: true, referenced: 'nope' }, live, /chats could not be checked/],
        [proof(), () => null, /open dossier state/],
    ]) {
        const doc = fakeDoc();
        const row = createStorageRow({ doc, vault, now, live: current, ask: async () => answer });
        row.mount(doc);
        await settle();
        assert.equal(row.state().kind, 'off');
        assert.match(doc.slot.textContent, reason);
        assert.ok(await vault.get('nk_hhhhhhh1'));
    }
    const unavailable = fileVault({ fetchFn: async () => ({ ok: false, status: 404 }) });
    const doc = fakeDoc();
    const row = createStorageRow({ doc, vault: unavailable, now, live, ask: async () => proof() });
    row.mount(doc);
    await settle();
    assert.equal(row.state().kind, 'off');
    assert.match(doc.slot.textContent, /dossier files could not be checked/);
});

test('mount does nothing without the slot or for a vault that cannot list; sizes and reasons read plainly', async () => {
    assert.equal(createStorageRow({ doc: { createElement: () => new Node('div'), querySelector: () => null }, vault: memoryVault(), ask: async () => ({}) }).mount(), false);
    const doc = fakeDoc();
    assert.equal(createStorageRow({ doc, vault: { get: async () => null }, ask: async () => ({}) }).mount(doc), false);
    assert.equal(sizeText(36 * 1024 * 1024), '36 MB');
    assert.equal(sizeText(1536 * 1024), '1.5 MB');
    assert.equal(sizeText(300), '1 KB');
    assert.match(offReason({ unreadable: [{ reason: 'newer' }] }), /^Clean-up is off: 1 chat could not be read \(it is from a newer version\)/);
});
