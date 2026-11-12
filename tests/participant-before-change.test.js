// A head selection after a change in the middle of the chat (Story Block picks the state saved just before the earliest changed reply):
// the participant installs it only when the guard allows, reads the surviving later replies again with the catch-up (one field written with the
// install), and tells the reader once; an unsafe selection is refused with a note and the live dossiers stay. Pure over a memory port and vault.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParticipant, memoryVault, installGuard, changeAt, restoreNoteText } from '../src/storysuite-participant/index.js';
import { hashJson } from '../src/storysuite-participant/hash.js';

const npc = (id, name) => ({ id, name, aliases: [], archived: false, present: true, lifeState: 'alive', trust: 3 });
const names = count => Array.from({ length: count }, (_, at) => `m${at}`);
let seeds = 100;
const seededRandom = seed => () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };

/** replies: the chat's reply ids now. A fake of the runtime's replay boundaries (runtime-entry-public-write.js) over the memory state. */
function build({ chat, replies, extra = {}, vault = memoryVault() }) {
    const live = { state: { npcs: [npc('npc_a', 'Ann')], lineage: names(12), lastScannedMessageId: 11 }, installs: 0, read: [], chatKey: 'chat:k:one' };
    const fingerprint = state => JSON.stringify(Object.fromEntries(Object.entries(state).filter(([key]) => key !== 'catchUp')));
    const L = {
        state: () => live.state, all: () => replies.slice(), active: ids => ids.every(id => replies.includes(id)),
        pending: () => ({ ids: [], marker: null }), copy: () => structuredClone(live.state), empty: () => ({ npcs: [] }),
        head: () => ({ key: live.chatKey, length: chat.length, last: null, swipe: null, state: fingerprint(live.state) }),
        markRead: (state, id) => Object.assign(state, { lastScannedMessageId: id }),
        install: async state => { live.state = structuredClone(state); },
        writeCatchUp: async field => { if (field) live.state.catchUp = structuredClone(field); else delete live.state.catchUp; },
        markReadLive: async id => { live.state.lastScannedMessageId = id; delete live.state.catchUp; },
        reply: async (copy, id) => { live.read.push(id); copy.npcs.push(npc(`npc_r${id}`, `Read ${id}`)); },
        pendingOf: (state, at, deleted = false) => {
            const latest = replies.length ? replies[replies.length - 1] : -1;
            const after = Number.isInteger(state.lastScannedMessageId) ? state.lastScannedMessageId : -1;
            return { ids: at >= latest && !deleted ? [] : replies.filter(id => id >= at && id > after), marker: after >= 0 ? after : null, n: replies.filter(id => id < at).length + 1 };
        },
    };
    const port = {
        chatKey: () => live.chatKey, readState: () => structuredClone(live.state), chatLineage: () => chat, live: () => L, enabled: () => true,
        installState: async state => { live.installs += 1; live.state = structuredClone(state); },
        writeTimeline: async block => { live.state = { ...live.state, timeline: structuredClone(block) }; },
        warn: text => live.told.push(text), ...extra,
    };
    live.told = [];
    const made = createParticipant({ port, vault, now: () => 1000, random: seededRandom(seeds += 1) });
    return { live, vault, port, ...made };
}

/** The story at 12 messages (m0..m11, replies are the odd ones); states saved after 4 and 10 messages; the live state published last. */
async function story(options, { published = 12 } = {}) {
    const made = build(options);
    await made.hydrate();
    const keep = async length => {
        made.live.state.lineage = names(length);
        made.live.state.lastScannedMessageId = length - 1;
        await made.hydrate();
        return made.participant.checkpoint({ cursor: { sid: `sr_${length}` }, headHash: String(length % 10).repeat(64) });
    };
    made.early = await keep(4);
    made.parent = await keep(10);
    made.live.state.npcs.push(npc('npc_late', 'Late'));
    made.live.state.lineage = names(12);
    made.live.state.lastScannedMessageId = 11;
    await made.hydrate();
    made.latest = await keep(published);
    return made;
}
const select = async (made, point, id = 'hs_00000001') => {
    const prepared = await made.participant.prepare({ return: id, checkpoint: point.checkpoint, hash: point.hash });
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    return made.participant.activate({ return: id, prepared: prepared.prepared });
};
const without = (list, at) => list.filter((_, index) => index !== at);

test('delete the last reply and swipe the latest: the parent\'s state is installed, no catch-up, no note (also with "Scan every" 5 and the state far behind)', async () => {
    for (const chat of [names(11), [...names(11), 'swiped']]) {
        const made = await story({ chat, replies: [1, 3, 5, 7, 9, ...(chat.length > 11 ? [11] : [])] });
        const answer = await select(made, made.early);   // 6 messages behind the change: the marker rule would have read replies 5-9 here
        assert.deepEqual([answer.ok, answer.older, made.live.installs], [true, undefined, 1]);
        assert.equal(made.live.state.catchUp, undefined, 'no catch-up field');
        assert.equal(made.index().restoreNote, undefined, 'no note');
        assert.equal(made.catchUp.canGenerate(), true, 'sending is not held');
        assert.equal(made.live.state.npcs.some(item => item.id === 'npc_late'), false, 'the selected state is live');
    }
});

for (const kind of ['delete a middle reply', 'edit a middle reply', 'Re-read a middle reply']) {
    test(`${kind}: restored to before the change, later replies read again, one note once, the field is gone at the end`, async () => {
        // message 5 is the changed reply: removed (the chat is one shorter) or rewritten (same length, a new fingerprint)
        const chat = kind.startsWith('delete') ? without(names(12), 5) : names(12).map((entry, at) => (at === 5 ? 'm5 rewritten' : entry));
        const replies = kind.startsWith('delete') ? [1, 3, 5, 7, 9] : [1, 3, 5, 7, 9, 11];
        const made = await story({ chat, replies });
        const writes = [];
        const wrote = made.vault.putIndex;
        made.vault.putIndex = async (...args) => { writes.push(structuredClone(args[1])); return wrote.call(made.vault, ...args); };
        const fields = [];
        const write = made.port.live().writeCatchUp;
        made.port.live().writeCatchUp = async field => { if (field) fields.push(structuredClone(field)); return write(field); };
        const answer = await select(made, made.early);
        assert.equal(answer.ok, true);
        assert.match(answer.older, /^Dossiers were restored to before reply 3 and rebuilt from the later replies; details may differ\./);
        assert.doesNotMatch(answer.older, /Restored an older dossier state/, 'the old line is replaced, never added to');
        assert.deepEqual(made.live.told, [answer.older], 'told once');
        // install, field and note in the one answer; the saved index carries the note and the base of the installed state
        const field = fields[0];
        assert.deepEqual([field.reason, field.attempt, field.ids, field.since], ['before-change', 0, replies.filter(id => id >= 5), 3], 'the field is the first write, with the install');
        assert.deepEqual(writes.at(-1).restoreNote, { kind: 'rebuilt', replyN: 3, unread: 0 });
        assert.equal(made.catchUp.canGenerate().ok, false, 'the hold is set before the host hears the answer');
        await made.catchUp.idle();
        assert.deepEqual(made.live.read, replies.filter(id => id >= 5), 'each surviving reply from the change on is read once');
        assert.equal(made.live.state.catchUp, undefined, 'the field is gone when it is done');
        assert.equal(made.live.state.npcs.some(item => item.id === 'npc_late'), false, 'the removed reply\'s dossier is gone');
        assert.deepEqual(made.live.state.npcs.map(item => item.id).sort(), ['npc_a', ...replies.filter(id => id >= 5).map(id => `npc_r${id}`)].sort());
        assert.match(made.catchUp.status().note, /^Dossiers were restored to before reply 3/, 'the note stays after the catch-up');
        assert.equal(made.catchUp.canGenerate(), true);
    });
}

test('the note survives a reload and a failed catch-up, shows until dismissed, and dismiss is one call that persists', async () => {
    const made = await story({ chat: without(names(12), 5), replies: [1, 3, 5, 7, 9] });
    made.live.reply = null;
    const L = made.port.live();
    L.reply = async () => { throw new Error('the model failed'); };
    await select(made, made.early);
    await made.catchUp.idle();
    assert.equal(made.catchUp.status().outcome, 'failed');
    assert.equal(made.live.state.npcs.some(item => item.id === 'npc_late'), false, 'the dossiers stay at the restored state');
    assert.notEqual(made.live.state.catchUp, undefined, 'the field stays for the next open');
    const reopened = createParticipant({ port: made.port, vault: made.vault, now: () => 1000, random: seededRandom(5) });
    await reopened.hydrate();
    assert.match(reopened.catchUp.status().note, /^Dossiers were restored to before reply 3/, 'after a reload');
    // the crash/reload: the saved field resumes on the chat open (the model works now) and finishes
    made.port.live().reply = async (copy, id) => { made.live.read.push(id); copy.npcs.push(npc(`npc_r${id}`, `Read ${id}`)); };
    assert.equal(reopened.catchUp.resume().started, true);
    await reopened.catchUp.idle();
    assert.equal(reopened.catchUp.status().outcome, 'done');
    assert.equal(made.live.state.catchUp, undefined);
    assert.match(reopened.catchUp.status().note, /^Dossiers were restored to before reply 3/, 'the note stays after it finished');
    await reopened.catchUp.dismiss();
    assert.equal(reopened.catchUp.status().note, null);
    const again = createParticipant({ port: made.port, vault: made.vault, now: () => 1000, random: seededRandom(6) });
    await again.hydrate();
    assert.equal(again.catchUp.status().note, null, 'gone for good');
});

test('three tries used up, and Skip: the dossiers stay at the restored state and the note is still there', async () => {
    const made = await story({ chat: without(names(12), 5), replies: [1, 3, 5, 7, 9] });
    made.port.live().reply = async () => { throw new Error('the model failed'); };
    await select(made, made.early);
    await made.catchUp.idle();
    made.live.state.catchUp.attempt = 3;
    assert.equal(made.catchUp.resume().started, false, 'no more tries');
    assert.match(made.catchUp.status().note, /rebuilt from the later replies/);
    await made.catchUp.skip();
    assert.equal(made.catchUp.status().outcome, 'skipped');
    assert.match(made.catchUp.status().note, /rebuilt from the later replies/, 'a skip is the reader\'s choice; the note stays');
});

test('a reply older than the 40 newest is not re-read and is counted in the note', async () => {
    const replies = Array.from({ length: 60 }, (_, at) => 10 + at * 2 + 1);
    const chat = names(10 + 120);
    const made = build({ chat, replies });
    await made.hydrate();
    made.live.state.lineage = names(8);
    made.live.state.lastScannedMessageId = 7;
    await made.hydrate();
    const early = await made.participant.checkpoint({ cursor: { sid: 'sr_a' }, headHash: 'a'.repeat(64) });
    made.live.state.lineage = chat.map((entry, at) => (at === 9 ? 'rewritten' : entry));
    made.live.state.lastScannedMessageId = 129;
    await made.hydrate();
    await made.participant.checkpoint({ cursor: { sid: 'sr_b' }, headHash: 'b'.repeat(64) });
    const answer = await select(made, early);
    assert.match(answer.older, /20 earlier replies were not re-read\.$/);
    assert.equal(made.live.state.catchUp.ids.length, 60);
    await made.catchUp.idle();
    assert.equal(made.live.read.length, 40, 'the 40 newest');
});

test('an unsafe selection is refused with a note: nothing is installed, the live state stays, it is published next', async () => {
    const cases = {
        'the state holds a message the chat lacks': async made => { made.chatNow = without(names(12), 3); return made.parent; },
        'the state has no lineage': async made => {
            delete made.live.state.lineage;
            await made.hydrate();
            const saved = await made.participant.checkpoint({ cursor: { sid: 'sr_x' }, headHash: 'c'.repeat(64) });
            assert.equal(saved.ok, true, JSON.stringify(saved));
            made.live.state.lineage = names(12);   // the dossiers go on, and are published (the base is the live state again)
            made.live.state.npcs.push(npc('npc_more', 'More'));
            await made.hydrate();
            await made.participant.checkpoint({ cursor: { sid: 'sr_z' }, headHash: 'e'.repeat(64) });
            return saved;
        },
        'the live dossiers are not what was last published (unpublished work)': async made => { made.live.state.npcs.push(npc('npc_new', 'New work')); return made.early; },
    };
    for (const [why, pick] of Object.entries(cases)) {
        const made = await story({ chat: without(names(12), 5), replies: [1, 3, 5, 7, 9] });
        made.port.chatLineage = () => made.chatNow ?? without(names(12), 5);
        const point = await pick(made);
        made.live.installs = 0;
        // a state with no lineage is saved while the live one still is the base; the unsafe case is then only the missing lineage
        const answer = await select(made, point);
        assert.equal(answer.ok, true, why);
        assert.equal(made.live.installs, 0, `${why}: nothing installed`);
        assert.equal(made.live.state.npcs.some(item => item.id === 'npc_late'), true, `${why}: the live dossiers are kept`);
        assert.match(answer.older, /^Dossiers were kept as they are\. They may still hold what reply \d+ changed, because the earlier state could not be used safely\./, why);
        assert.deepEqual(made.live.told, [answer.older]);
        assert.equal(made.index().base.stateHash, '', `${why}: the base is not the live state, so it is published next`);
        assert.equal(made.index().restoreNote.kind, 'refused');
        assert.equal(made.live.state.catchUp, undefined);
        assert.equal(made.catchUp.canGenerate(), true);
    }
});

test('an older state is never installed over newer valid data: a newer live state that equals what was published is the only one replaced', async () => {
    const made = await story({ chat: without(names(12), 5), replies: [1, 3, 5, 7, 9] });
    made.live.state.npcs.push(npc('npc_scan', 'Scanned just now'));   // a scan written, not yet published
    const answer = await select(made, made.early);
    assert.equal(made.live.installs, 0);
    assert.equal(made.live.state.npcs.some(item => item.id === 'npc_scan'), true);
    assert.match(answer.older, /kept as they are/);
});

test('a death in a surviving later reply stays dead; the removed reply\'s death is gone; the answer does not raise a barrier', async () => {
    const made = await story({ chat: without(names(12), 5), replies: [1, 3, 5, 7, 9] });
    made.live.state.npcs.find(item => item.id === 'npc_late').lifeState = 'deceased';   // the removed reply's death (live, published next)
    await made.hydrate();
    await made.participant.checkpoint({ cursor: { sid: 'sr_y' }, headHash: 'd'.repeat(64) });
    made.port.live().reply = async (copy, id) => { copy.npcs.push({ ...npc('npc_tom', 'Tom'), lifeState: 'deceased' }); made.live.read.push(id); };
    const answer = await select(made, made.early);
    assert.equal(answer.ok, true);
    await made.catchUp.idle();
    assert.equal(made.live.state.npcs.some(item => item.id === 'npc_late'), false, 'the removed reply\'s death is gone');
    assert.equal(made.live.state.npcs.find(item => item.id === 'npc_tom').lifeState, 'deceased', 'the surviving death stays dead');
    assert.equal(made.catchUp.status().outcome, 'done', 'nothing blocks: the catch-up finished');
});

test('installGuard, changeAt and the note words (pure)', () => {
    const chat = names(8);
    const live = hashJson({ a: 1 });
    assert.deepEqual(installGuard({ saved: names(4), chat, liveHash: live, baseHash: live }), { install: true, why: '' });
    assert.equal(installGuard({ saved: names(8), chat, liveHash: live, baseHash: live }).install, true, 'the whole chat is a prefix');
    assert.equal(installGuard({ saved: [...names(3), 'x'], chat, liveHash: live, baseHash: live }).why, 'not-in-chat');
    assert.equal(installGuard({ saved: names(9), chat, liveHash: live, baseHash: live }).why, 'not-in-chat', 'longer than the chat');
    assert.equal(installGuard({ saved: [], chat, liveHash: live, baseHash: live }).why, 'no-lineage');
    assert.equal(installGuard({ saved: undefined, chat, liveHash: live, baseHash: live }).why, 'no-lineage');
    assert.equal(installGuard({ saved: names(4), chat, liveHash: live, baseHash: 'other' }).why, 'unpublished');
    assert.equal(changeAt({ saved: names(4), live: names(12), chat: without(names(12), 5) }), 5);
    assert.equal(changeAt({ saved: names(4), live: names(12), chat: names(11) }), 11, 'the last message is gone');
    assert.equal(changeAt({ saved: names(4), live: undefined, chat }), 4, 'no live lineage: where the saved state ends');
    assert.match(restoreNoteText({ kind: 'rebuilt', replyN: 3, unread: 1 }), /People you added or edited yourself after that point are not restored\. Use Refresh on anyone who looks wrong\. 1 earlier reply was not re-read\.$/);
    assert.equal(restoreNoteText(null), '');
});

test('the live lineage lags the chat (it is written when the reader sends, not when the reply is scanned): delete-last and swipe-latest still leave no field and no note', async () => {
    // lineage of the live dossiers: the chat up to the reader's last turn (the reply 11 is not in it), or one turn behind that
    for (const [published, chat, replies] of [[11, names(11), [1, 3, 5, 7, 9]], [11, [...names(11), 'swiped'], [1, 3, 5, 7, 9, 11]], [10, names(11), [1, 3, 5, 7, 9]]]) {
        const made = await story({ chat, replies }, { published });
        const answer = await select(made, made.early);
        assert.deepEqual([answer.ok, answer.older, made.live.state.catchUp, made.index().restoreNote, made.catchUp.canGenerate()], [true, undefined, undefined, undefined, true], `lineage ${published} of chat ${chat.length}`);
    }
});

test('the ordinary flow (a scan writes, noteChange, the publication, the host activates it) leaves live equal to the base: the next change installs; a change inside the publish debounce is refused with the note (stated)', async () => {
    const made = await story({ chat: without(names(12), 5), replies: [1, 3, 5, 7, 9] });
    const calls = [];
    made.participant.attach({
        head: async () => ({ ok: true, headHash: 'a'.repeat(64), cursor: { sid: 'sr_1', swipeKey: 'sw_1', op: 0, rev: 0 }, epoch: 'ep_00000000', prefixHash: 'c'.repeat(64), source: { sid: 'sr_1', swipeKey: 'sw_1', evidence: 'ev_1', ordinal: 0 } }),
        nativeMutation: async input => { const done = await input.prepare(); calls.push(done); return { ok: true, checkpoint: done.after.checkpoint, hash: done.after.hash }; },
    });
    made.live.state.npcs.push(npc('npc_scan', 'Scanned'));
    made.noteChange();
    assert.equal((await made.flush()).ok, true);
    const activated = await made.participant.activate({ return: 'nm_00000001', prepared: calls[0].prepared });
    assert.equal(activated.ok, true);
    assert.equal(made.index().base.stateHash, hashJson(made.port.readState()), 'live equals the base once the publication is activated');
    const answer = await select(made, made.early);
    assert.equal(made.live.installs, 1, 'installed: the guard passes on the ordinary flow');
    assert.match(answer.older, /^Dossiers were restored to before reply 3/);
    // inside the debounce (written, not yet published): refused, kept, visible
    const second = await story({ chat: without(names(12), 5), replies: [1, 3, 5, 7, 9] });
    second.live.state.npcs.push(npc('npc_scan', 'Scanned'));
    second.noteChange();
    const refused = await select(second, second.early);
    assert.equal(second.live.installs, 0);
    assert.match(refused.older, /kept as they are/);
});

test('a deleted middle reply whose neighbour turns read the same: the change shows up at the next reply, which is a survivor and is read again (the chat is shorter than the dossiers\' lineage)', async () => {
    const lineage = ['m0', 'm1', 'm2', 'm3', 'turn', 'r7', 'turn', 'r8'];
    const made = build({ chat: ['m0', 'm1', 'm2', 'm3', 'turn', 'r8'], replies: [1, 3, 5] });
    await made.hydrate();
    const keep = async length => {
        made.live.state.lineage = lineage.slice(0, length);
        made.live.state.lastScannedMessageId = length - 1;
        await made.hydrate();
        return made.participant.checkpoint({ cursor: { sid: `sr_${length}` }, headHash: String(length).repeat(64) });
    };
    const early = await keep(4);
    await keep(8);
    const answer = await select(made, early);
    assert.match(answer.older, /^Dossiers were restored to before reply 3/);
    await made.catchUp.idle();
    assert.deepEqual(made.live.read, [5], 'the eighth reply (now message 5) is read again');
});
