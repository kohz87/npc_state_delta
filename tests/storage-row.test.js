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
// A stand-in for the participant's exclusive queue: one thing at a time, in order; `inside` says whether a callback is running.
function queue() {
    let tail = Promise.resolve();
    const q = { inside: false, exclusive: fn => { const run = tail.then(async () => { q.inside = true; try { return await fn(); } finally { q.inside = false; } }); tail = run.catch(() => {}); return run; } };
    return q;
}

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
    await vault.putIndex('lg_seeded01', { v: 2, acks: {}, prepared: {}, returns: {}, selected: null, base: null });
    return { vault, now: () => t };
}

test('memory vault: list() reports id, size and time; remove(id) refuses an id in the referenced set and keeps the file', async () => {
    const { vault } = await seeded([['nk_aaaaaaa1', 40 * DAY], ['nk_aaaaaaa2', 1 * DAY]]);
    const listed = (await vault.list()).files;
    assert.deepEqual(listed.map(f => f.id).sort(), ['nk_aaaaaaa1', 'nk_aaaaaaa2']);
    assert.ok(listed.every(f => f.size > 2000 && Number.isFinite(f.modifiedAt)));
    assert.equal(await vault.remove('nk_aaaaaaa1', { referenced: new Set(['nk_aaaaaaa1']) }), false);
    assert.ok(await vault.get('nk_aaaaaaa1'));
    assert.equal(await vault.remove('nk_aaaaaaa1', { referenced: ['nk_other001'] }), true);
    assert.equal(await vault.get('nk_aaaaaaa1'), null);
    assert.equal(await vault.remove('nk_aaaaaaa1'), false);
});

// A fake SillyTavern user-files server. `calls` records every URL, so a test can prove which endpoints were (not) used.
function fakeServer(now) {
    const files = new Map(); const times = new Map(); const calls = []; const server = { files, times, calls };
    const fetchFn = async (url, options = {}) => {
        calls.push(url);
        const name = url.split('/').pop();
        if (url === '/api/files/upload') { const body = JSON.parse(options.body); files.set(body.name, Buffer.from(body.data, 'base64').toString()); times.set(body.name, now()); return { ok: true, status: 200 }; }
        if (url === '/api/files/verify') { const body = JSON.parse(options.body); return { ok: true, status: 200, json: async () => Object.fromEntries(body.urls.map(u => [u, files.has(u.split('/').pop())])) }; }
        if (url === '/api/files/delete') { const n = JSON.parse(options.body).path.split('/').pop(); const had = files.delete(n); return { ok: had, status: had ? 200 : 404, text: async () => '' }; }
        if (url === '/api/data-maid/report') { server.maid = (server.maid ?? 0) + 1; if (server.maidFails) return { ok: false, status: 500 }; return { ok: true, status: 200, json: async () => ({ token: 'tok', report: { files: [...files].map(([n, data]) => ({ name: n, size: data.length, mtime: times.get(n) })) } }) }; }
        if (url === '/api/data-maid/finalize') { server.finalized = (server.finalized ?? 0) + 1; return { ok: true, status: 200 }; }
        if (files.has(name)) return { ok: true, status: 200, text: async () => files.get(name) };
        return { ok: false, status: 404, text: async () => '' };
    };
    server.fetchFn = fetchFn;
    return server;
}

test('file vault never calls Data Maid; it lists what it registered, says the list is not complete, and refuses referenced ids', async () => {
    let t = 100 * DAY;
    const server = fakeServer(() => t);
    const vault = fileVault({ fetchFn: server.fetchFn, now: () => t });
    server.files.set('npc-state-delta-checkpoint-nk_bbbbbbb1.json', '{"pre-release":true}'); // written before the registry: never named
    await vault.put('nk_bbbbbbb2', { lineage: 'lg_a' });
    await vault.put('nk_bbbbbbb3', { lineage: 'lg_b' }); // another story line: not a patch against nk_bbbbbbb2, so the sweep may take that one
    const listed = await vault.list();
    assert.equal(listed.complete, false);
    assert.deepEqual(listed.files.map(f => f.id).sort(), ['nk_bbbbbbb2', 'nk_bbbbbbb3']);
    assert.ok(listed.files.every(f => f.size > 0 && f.modifiedAt === t));
    assert.ok(!server.calls.some(u => u.includes('data-maid')), 'the user\'s Data Maid token is never touched');
    const deletes = () => server.calls.filter(u => u === '/api/files/delete').length;
    assert.equal(await vault.remove('nk_bbbbbbb2', { referenced: new Set(['nk_bbbbbbb2']) }), false);
    assert.equal(deletes(), 0, 'no delete request for a referenced id');
    assert.equal(await vault.remove('../etc/passwd'), false);
    t += 60 * DAY;
    const sweep = createVaultSweep({ vault, now: () => t });
    const plan = await sweep.plan({ complete: true, referenced: ['nk_bbbbbbb3'] });
    assert.equal(plan.exact, false);
    assert.deepEqual(plan.candidates.map(file => file.id), ['nk_bbbbbbb2'], 'the unregistered pre-release file is never a candidate');
    assert.deepEqual((await sweep.sweep()).deleted, ['nk_bbbbbbb2']);
    assert.equal(server.files.has('npc-state-delta-checkpoint-nk_bbbbbbb2.json'), false);
    assert.equal(server.files.has('npc-state-delta-checkpoint-nk_bbbbbbb1.json'), true);
    assert.deepEqual((await vault.list()).files.map(f => f.id), ['nk_bbbbbbb3'], 'a removed file leaves the registry');
});

test('writing an already-kept checkpoint again makes it young (a new reference may follow); a damaged registry means no list at all', async () => {
    let t = 100 * DAY;
    const server = fakeServer(() => t);
    const vault = fileVault({ fetchFn: server.fetchFn, now: () => t });
    await vault.put('nk_iiiiiii1', { lineage: 'lg_a' });
    t += 60 * DAY;
    await vault.put('nk_iiiiiii1', { lineage: 'lg_a' });
    assert.equal((await vault.list()).files[0].modifiedAt, t);
    const plan = await createVaultSweep({ vault, now: () => t }).plan({ complete: true, referenced: [] });
    assert.equal(plan.count, 0);
    server.files.set('npc-state-delta-checkpoint-registry.json', '{broken');
    await assert.rejects(vault.list());
    const refused = await createVaultSweep({ vault, now: () => t }).plan({ complete: true, referenced: [] });
    assert.equal(refused.code, 'VAULT_UNREADABLE');
    assert.equal(refused.canSweep, false);
});

test('the row shows "at least" when the list cannot prove it is complete', async () => {
    let t = 40 * DAY;
    const server = fakeServer(() => t);
    const vault = fileVault({ fetchFn: server.fetchFn, now: () => t });
    await vault.put('nk_jjjjjjj1', { lineage: 'lg_a' });
    t = 100 * DAY;
    const doc = fakeDoc();
    const row = createStorageRow({ exclusive: queue().exclusive, doc, vault, now: () => t, live, ask: async () => proof() });
    row.mount(doc);
    await settle();
    assert.match(doc.slot.textContent, /Old dossier files: at least 1 file, \d+ KB/);
    assert.equal(row.state().plan.count, 1);
});

test('the final check and the deletion run inside the exclusive queue, so a checkpoint write waits and cannot land between them', async () => {
    const { vault, now } = await seeded([['nk_kkkkkkk1', 90 * DAY]]);
    const q = queue();
    const order = [];
    const asked = [];
    const doc = fakeDoc();
    const row2 = createStorageRow({ exclusive: q.exclusive, doc, vault: { ...vault, remove: async (...args) => { order.push(`remove inside=${q.inside}`); return vault.remove(...args); } }, now, live, ask: async () => { asked.push(q.inside); return proof(); } });
    row2.mount(doc);
    await settle();
    doc.slot.all().find(n => n.tag === 'button' && n.textContent.startsWith('Clean up 1 file')).listeners.click();
    const first = asked.length;
    doc.slot.button('Remove 1 file').listeners.click();
    // A checkpoint write arrives while the removal is under way: it is queued behind it.
    const write = q.exclusive(async () => { order.push('write'); });
    await settle(); await write;
    assert.equal(asked[first], true, 'the references are read again inside the exclusive step');
    assert.deepEqual(order, ['remove inside=true', 'write'], 'the deletion ran inside it, before the queued write');
    assert.equal(await vault.get('nk_kkkkkkk1'), null);
});

test('without an exclusive step, or when it fails, nothing is removed and the reader is told', async () => {
    for (const exclusive of [undefined, async () => ({ ok: false, code: 'FAILED' })]) {
        const { vault, now } = await seeded([['nk_lllllll1', 90 * DAY]]);
        const doc = fakeDoc();
        const row = createStorageRow({ exclusive, doc, vault, now, live, ask: async () => proof() });
        row.mount(doc);
        await settle();
        doc.slot.all().find(n => n.tag === 'button' && n.textContent.startsWith('Clean up 1 file')).listeners.click();
        doc.slot.button('Remove 1 file').listeners.click();
        await settle();
        assert.ok(await vault.get('nk_lllllll1'));
        assert.match(doc.slot.textContent, /Nothing was removed/);
    }
});

test('the row shows the mockup text, asks for confirmation, and removes only after Remove', async () => {
    const { vault, now } = await seeded([['nk_ccccccc1', 40 * DAY], ['nk_ccccccc2', 50 * DAY], ['nk_ccccccc3', 60 * DAY], ['nk_ccccccc4', 2 * DAY]]);
    const doc = fakeDoc();
    const row = createStorageRow({ exclusive: queue().exclusive, doc, vault, now, live, ask: async () => proof(['nk_ccccccc3']) });
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
    assert.equal((await vault.list()).files.length, 4, 'nothing is removed before the confirmation');
    assert.match(doc.slot.textContent, /Remove 2 old dossier files \(\d+ KB\)\?/);
    assert.match(doc.slot.textContent, /No chat or branch uses these files, and each is older than 30 days\. Dossiers in your chats are not changed\. If you later restore an old chat from a backup, its dossiers may need to start from the chat\./);
    doc.slot.button('Cancel').listeners.click();
    assert.equal((await vault.list()).files.length, 4);
    doc.slot.all().find(n => n.textContent.startsWith('Clean up 2 files (')).listeners.click();
    doc.slot.button('Remove 2 files').listeners.click();
    await settle();
    assert.deepEqual((await vault.list()).files.map(f => f.id).sort(), ['nk_ccccccc3', 'nk_ccccccc4']);
    assert.match(doc.slot.textContent, /Old dossier files: 2 files/);
});

test('an unreadable chat disables Clean up with the reason and nothing can be removed', async () => {
    const { vault, now } = await seeded([['nk_ddddddd1', 90 * DAY], ['nk_ddddddd2', 90 * DAY]]);
    const doc = fakeDoc();
    const answer = { complete: false, unreadable: [{ reason: 'newer-version' }, { reason: 'unreadable' }] };
    const row = createStorageRow({ exclusive: queue().exclusive, doc, vault, now, ask: async () => answer });
    row.mount(doc);
    await settle();
    const off = doc.slot.button('Clean up');
    assert.ok(off && off.disabled);
    assert.match(doc.slot.textContent, /Old dossier files: 2 files/);
    assert.match(doc.slot.textContent, /Clean-up is off: 2 chats could not be read \(one is from a newer version\), so it can't be sure which files are still used\./);
    assert.equal((await vault.list()).files.length, 2);
    assert.equal(row.state().kind, 'off');
});

test('a failed or missing referenced query is an incomplete check; Check again asks again', async () => {
    const { vault, now } = await seeded([['nk_eeeeeee1', 90 * DAY]]);
    const doc = fakeDoc();
    let asks = 0;
    const row = createStorageRow({ exclusive: queue().exclusive, doc, vault, now, live, ask: async () => { asks += 1; if (asks === 1) throw new Error('no host'); return proof(); } });
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
    const row = createStorageRow({ exclusive: queue().exclusive, doc, vault, now, live, ask: async () => proof() });
    row.mount(doc);
    await settle();
    assert.equal(row.state().kind, 'ready');
    assert.deepEqual(row.state().plan.candidates.map(file => file.id).sort(), ['nk_fffffff2', 'nk_fffffff3'], 'named by the index, or no lineage: kept');
    const broken = { ...vault, getIndex: async () => { throw new Error('unreadable'); } };
    const doc2 = fakeDoc();
    const row2 = createStorageRow({ exclusive: queue().exclusive, doc: doc2, vault: broken, now, live, ask: async () => proof() });
    row2.mount(doc2);
    await settle();
    assert.equal(row2.state().kind, 'off', 'an unreadable index proves nothing, so removal is off');
    assert.match(row2.state().reason, /index could not be read/);
});

test('an index of ANOTHER lineage that names an older lineage\'s checkpoint keeps it; a lineage with no index (null) turns removal off', async () => {
    const { vault, now } = await seeded([['nk_hhhhhhh1', 90 * DAY], ['nk_hhhhhhh2', 90 * DAY]]);
    await vault.put('nk_hhhhhhh5', { lineage: 'lg_newer001' }); vault.age('nk_hhhhhhh5', 1 * DAY);
    await vault.putIndex('lg_newer001', { v: 2, acks: {}, prepared: { p1: { checkpoint: 'nk_hhhhhhh1' } }, returns: {}, selected: null, base: null });
    const doc = fakeDoc();
    const row = createStorageRow({ exclusive: queue().exclusive, doc, vault, now, live, ask: async () => proof() });
    row.mount(doc);
    await settle();
    assert.equal(row.state().kind, 'ready');
    assert.deepEqual(row.state().plan.candidates.map(file => file.id), ['nk_hhhhhhh2'], 'named only by the newer lineage\'s index: kept');
    const nullIndex = { ...vault, getIndex: async lineage => (lineage === 'lg_newer001' ? null : vault.getIndex(lineage)) };
    const doc2 = fakeDoc();
    const row2 = createStorageRow({ exclusive: queue().exclusive, doc: doc2, vault: nullIndex, now, live, ask: async () => proof() });
    row2.mount(doc2);
    await settle();
    assert.equal(row2.state().kind, 'off', 'a null index means unknown');
    assert.ok(doc2.slot.all().some(node => node.tag === 'button' && node.textContent === 'Clean up' && node.disabled));
});

test('an index that becomes unreadable while confirmation is open stops the removal inside the exclusive step', async () => {
    const { vault, now } = await seeded([['nk_jjjjjjj1', 90 * DAY]]);
    let broken = false;
    const flaky = { ...vault, getIndex: async lineage => (broken ? null : vault.getIndex(lineage)), remove: async (...args) => vault.remove(...args) };
    const doc = fakeDoc();
    const row = createStorageRow({ exclusive: queue().exclusive, doc, vault: flaky, now, live, ask: async () => proof() });
    row.mount(doc);
    await settle();
    assert.equal(row.state().kind, 'ready');
    doc.slot.all().find(node => node.tag === 'button' && node.textContent.startsWith('Clean up 1 file')).listeners.click();
    broken = true;
    doc.slot.button('Remove 1 file').listeners.click();
    await settle();
    assert.ok(await vault.get('nk_jjjjjjj1'), 'nothing removed');
    assert.equal(row.state().kind, 'off');
});

test('the row carries the mockup line about which chats are counted', async () => {
    const { vault, now } = await seeded([['nk_iiiiiii1', 90 * DAY]]);
    const doc = fakeDoc();
    const row = createStorageRow({ exclusive: queue().exclusive, doc, vault, now, live, ask: async () => proof() });
    row.mount(doc);
    await settle();
    assert.ok(doc.slot.textContent.includes('Counts the chats SillyTavern lists; chats of deleted characters are not checked.'));
});

test('a checkpoint newly referenced while confirmation is open is not removed', async () => {
    const { vault, now } = await seeded([['nk_ggggggg1', 90 * DAY]]);
    const doc = fakeDoc();
    let asks = 0;
    const row = createStorageRow({ exclusive: queue().exclusive, doc, vault, now, live, ask: async () => (++asks === 1 ? proof() : proof(['nk_ggggggg1'])) });
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
        const row = createStorageRow({ exclusive: queue().exclusive, doc, vault, now, live: current, ask: async () => answer });
        row.mount(doc);
        await settle();
        assert.equal(row.state().kind, 'off');
        assert.match(doc.slot.textContent, reason);
        assert.ok(await vault.get('nk_hhhhhhh1'));
    }
    const unavailable = fileVault({ fetchFn: async () => ({ ok: false, status: 404 }) });
    const doc = fakeDoc();
    const row = createStorageRow({ exclusive: queue().exclusive, doc, vault: unavailable, now, live, ask: async () => proof() });
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

// "Find older files": Data Maid is asked only on the press; what it names joins the list under the same rules.
test('Data Maid is never requested on mount or Check again; only "Find older files" asks, and the line before it says what it does', async () => {
    let t = 100 * DAY;
    const server = fakeServer(() => t);
    const vault = fileVault({ fetchFn: server.fetchFn, now: () => t });
    server.files.set('npc-state-delta-checkpoint-nk_ooooooo1.json', JSON.stringify({ lineage: 'lg_a' })); server.times.set('npc-state-delta-checkpoint-nk_ooooooo1.json', t - 60 * DAY);
    server.files.set('npc-state-delta-checkpoint-nk_ooooooo2.json', JSON.stringify({ lineage: 'lg_a' })); server.times.set('npc-state-delta-checkpoint-nk_ooooooo2.json', t - 60 * DAY);
    server.files.set('npc-state-delta-checkpoint-nk_ooooooo3.json', JSON.stringify({ lineage: 'lg_a' })); server.times.set('npc-state-delta-checkpoint-nk_ooooooo3.json', t - 2 * DAY);
    server.files.set('other-file.json', '{}'); server.times.set('other-file.json', t - 90 * DAY);
    await vault.putIndex('lg_a', { v: 2, acks: {}, prepared: {}, returns: {}, selected: null, base: null });
    const doc = fakeDoc();
    const row = createStorageRow({ exclusive: queue().exclusive, doc, vault, now: () => t, live, ask: async () => proof(['nk_ooooooo2']) });
    row.mount(doc);
    await settle();
    doc.slot.button('Check again').listeners.click();
    await settle();
    assert.equal(server.maid ?? 0, 0, 'no Data Maid request on load or on Check again');
    assert.equal(row.state().plan.totalFiles, 0);
    assert.match(doc.slot.textContent, /This uses SillyTavern's Data Maid listing and replaces any Data Maid report you have open\./);
    doc.slot.button('Find older files').listeners.click();
    await settle();
    assert.equal(server.maid, 1);
    assert.equal(server.finalized, 1, 'the report token is closed again; nothing is chosen for deletion');
    assert.match(doc.slot.textContent, /Old dossier files: at least 3 files/);
    assert.deepEqual(row.state().plan.candidates.map(f => f.id), ['nk_ooooooo1'], 'only unused files older than 30 days are offered');
    // The final check inside the exclusive step re-checks, then removes only the confirmed file.
    doc.slot.all().find(n => n.textContent.startsWith('Clean up 1 file (')).listeners.click();
    doc.slot.button('Remove 1 file').listeners.click();
    await settle();
    assert.equal(server.files.has('npc-state-delta-checkpoint-nk_ooooooo1.json'), false);
    assert.equal(server.files.has('npc-state-delta-checkpoint-nk_ooooooo2.json'), true);
    assert.equal(server.files.has('npc-state-delta-checkpoint-nk_ooooooo3.json'), true);
    assert.equal(server.files.has('other-file.json'), true);
    assert.equal(server.maid, 1, 'removal does not ask Data Maid again');
});

test('found old files keep the rules: a chat that cannot be read turns removal off; a failed Data Maid listing changes nothing', async () => {
    let t = 100 * DAY;
    const server = fakeServer(() => t);
    const vault = fileVault({ fetchFn: server.fetchFn, now: () => t });
    server.files.set('npc-state-delta-checkpoint-nk_ppppppp1.json', '{}'); server.times.set('npc-state-delta-checkpoint-nk_ppppppp1.json', t - 60 * DAY);
    const doc = fakeDoc();
    const row = createStorageRow({ exclusive: queue().exclusive, doc, vault, now: () => t, live, ask: async () => ({ complete: false, unreadable: [{ id: 'chat' }], referenced: [] }) });
    row.mount(doc);
    await settle();
    doc.slot.button('Find older files').listeners.click();
    await settle();
    assert.equal(row.state().kind, 'off');
    assert.match(doc.slot.textContent, /Clean-up is off: 1 chat could not be read/);
    assert.ok(doc.slot.button('Clean up').disabled);
    assert.equal(server.files.size, 1);
    server.maidFails = true;
    doc.slot.button('Find older files').listeners.click();
    await settle();
    assert.match(doc.slot.textContent, /The older files could not be listed\. Nothing was changed\./);
    assert.equal(server.files.size, 1);
});
