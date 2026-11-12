// NPC notes, the kinds (src/npc-notes-kinds.js): NOTE_FIELDS, the lie / know / taste / tie handlers through the notes option (run and
// flag), unknown kinds, validateNotes on stored leaves, and notesTail with its cap (2 per present person, 4 in all). Pure functions only.
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { NOTE_FIELDS, KINDS, noteKinds, runKind, validateNotes, notesTail, NOTES_TAIL_PER_NPC, NOTES_TAIL_MAX } from '../src/npc-notes-kinds.js';
import { addLie } from '../src/npc-notes-lies.js';
import { addKnow } from '../src/npc-notes-knows.js';
import { tastesText } from '../src/npc-notes-tastes.js';
import { tiesText } from '../src/npc-notes-ties.js';
import { suite } from './helpers/pacing-suite.js';
import { MODULE_ID } from '../src/storysuite-v2.js';
import { validateNpcSlice } from '../src/npc-meters.js';
import { FEATURE_NOTES, RECORD_FIELDS, readLeaf } from '../src/npc-meters-config.js';
import { seedNotes, driveScale, foldTies, aliasCanon, tieRows, dossierNotes } from '../src/npc-notes-kinds.js';
import { stepPull } from '../npc-instincts.js';
import { setDrives } from '../src/npc-notes-drives.js';
import { normalizeEntry } from '../src/cast-dossier.js';
import { bondToneOf } from '../relationship-map-focus.js';
import { resolveMapBonds } from '../relationship-map-core.js';
import { tieTone } from '../dossier-ui-bond-tone.js';

const said = "I didn't sell a spell.";

function notesSpy() {
    const calls = [];
    return {
        calls,
        run: change => calls.push(['run', change]),
        flag: (text, cue) => calls.push(['flag', text, cue]),
    };
}

test('NOTE_FIELDS lists the six record fields the kinds own, and KINDS maps the four line kinds to their fields', () => {
    assert.deepEqual([...NOTE_FIELDS], ['lies', 'knows', 'tastes', 'ties', 'drives', 'lookLockedAt']);
    assert.deepEqual(Object.keys(KINDS), ['lie', 'know', 'taste', 'tie']);
    assert.deepEqual(Object.fromEntries(Object.entries(KINDS).map(([kind, entry]) => [kind, entry.field])), {
        lie: 'lies', know: 'knows', taste: 'tastes', tie: 'ties',
    });
});

test('runKind lie: a told lie is written with the reply key and no notes are sent', () => {
    const notes = notesSpy();
    const out = runKind('lie', null, { to: 'Astra', said }, { name: 'Rika', day: 3, r: 'r1', notes });
    assert.equal(out.field, 'lies');
    assert.equal(out.problem, '');
    assert.equal(JSON.parse(out.text)[0].to, 'Astra');
    assert.deepEqual(notes.calls, []);
});

test('runKind lie catch: stamps the uncaught lie, runs the trust drop at the meaningful tier and flags a receipt', () => {
    const notes = notesSpy();
    const prior = addLie(null, { to: 'Astra', said, day: 3, r: 'r1' }).text;
    const out = runKind('lie', prior, { catch: true, to: 'Astra', said: 'spell' }, { name: 'Rika', day: 4, r: 'r2', notes });
    assert.equal(out.problem, '');
    assert.equal(JSON.parse(out.text)[0].caught.r, 'r2');
    assert.deepEqual(notes.calls, [
        ['run', { changes: [{ meter: 'trust', mode: 'add', value: -6 }], impact: { tier: 'extreme' } }],
        ['flag', 'Rika: caught in a lie to Astra.', undefined],
    ]);
});

test('runKind lie catch with no matching lie is refused and sends nothing', () => {
    const notes = notesSpy();
    const out = runKind('lie', null, { catch: true, to: 'Astra' }, { name: 'Rika', day: 4, r: 'r2', notes });
    assert.match(out.problem, /matches that catch/);
    assert.deepEqual(notes.calls, []);
});

test('runKind know: a reply\'s lines are written; a bad line refuses the whole command', () => {
    const ok = runKind('know', null, { lines: [{ about: 'Mara', fact: 'debt to the guild', how: 'saw' }] }, { r: 'r1' });
    assert.equal(ok.field, 'knows');
    assert.equal(ok.problem, '');
    assert.equal(JSON.parse(ok.text)[0].fact, 'debt to the guild');
    const bad = runKind('know', null, { lines: [{ about: 'Mara', fact: 'debt', how: 'guessed' }] }, { r: 'r1' });
    assert.match(bad.problem, /how \(saw or heard\)/);
    assert.equal(bad.text, null);
});

test('runKind taste: a refused opposite sign keeps the list; a mirrored taste is kept and flagged, not refused', () => {
    const base = tastesText([{ sign: '+', item: 'burnt sugar', day: 1, r: 'r1' }]);
    const notes = notesSpy();
    const refused = runKind('taste', base, { sign: '-', item: 'burnt sugar' }, { name: 'Rika', day: 2, r: 'r2', notes });
    assert.equal(refused.text, base);
    assert.match(refused.problem, /needs a why: reason/);
    assert.deepEqual(notes.calls, []);

    const mirror = runKind('taste', null, { sign: '+', item: 'river fish' }, { name: 'Rika', day: 2, r: 'r2', userText: 'I love river fish', notes });
    assert.equal(mirror.problem, '');
    assert.equal(JSON.parse(mirror.text)[0].mirrored, true);
    assert.equal(notes.calls.length, 1);
    assert.equal(notes.calls[0][0], 'flag');
    assert.match(notes.calls[0][1], /echoes \{\{user\}\}'s words; kept and marked\.$/);
});

test('runKind tie: +ally applies, self-ties and unknown tags are refused, an emptied record returns null text', () => {
    const added = runKind('tie', null, { self: 'Rika', with: 'Mara', tags: ['+ally'] }, { name: 'Rika' });
    assert.equal(added.field, 'ties');
    assert.equal(added.problem, '');
    assert.deepEqual(Object.values(JSON.parse(added.text)), [['ally']]);

    const self = runKind('tie', null, { with: 'Rika', tags: ['+ally'] }, { name: 'Rika' });
    assert.match(self.problem, /self/);
    const unknown = runKind('tie', null, { with: 'Mara', tags: ['+friend'] }, { name: 'Rika' });
    assert.match(unknown.problem, /Unknown tie tag: \+friend/);

    const cleared = runKind('tie', added.text, { with: 'Mara', tags: ['-ally'] }, { name: 'Rika' });
    assert.equal(cleared.text, null);
    assert.equal(cleared.problem, '');
});

test('runKind: an unknown kind is refused with a problem and writes nothing', () => {
    const out = runKind('gossip', null, {}, {});
    assert.equal(out.field, null);
    assert.equal(out.text, null);
    assert.match(out.problem, /Unknown note kind: gossip/);
});

test('validateNotes: absent and well-formed leaves pass; a bad leaf names its field', () => {
    assert.equal(validateNotes(undefined), '');
    assert.equal(validateNotes({}), '');
    const good = {
        lies: addLie(null, { to: 'Astra', said, day: 3, r: 'r1' }).text,
        knows: addKnow(null, 'r1', [{ about: 'Mara', fact: 'debt', how: 'heard' }]).text,
        tastes: tastesText([{ sign: '+', item: 'burnt sugar', day: 1, r: 'r1' }]),
        ties: tiesText({ mara: ['ally'] }),
        drives: JSON.stringify({ belo: 3 }),
        lookLockedAt: { day: 2, r: 'r1' },
    };
    assert.equal(validateNotes(good), '');
    assert.equal(validateNotes({ lies: 'not json' }), 'lies is not valid.');
    assert.equal(validateNotes({ knows: '[{"about":"Mara"}]' }), 'knows is not valid.');
    assert.equal(validateNotes({ tastes: '[{"sign":"?"}]' }), 'tastes is not valid.');
    assert.equal(validateNotes({ drives: '{"belo":9}' }), 'drives is not valid.');
    assert.equal(validateNotes({ lookLockedAt: { day: -1, r: '' } }), 'lookLockedAt is not valid.');
});

test('notesTail: two lines per present person (lie, then secret or fact, then taste) and four in all, nearest first', () => {
    const rika = {
        name: 'Rika',
        lies: addLie(null, { to: 'Astra', said, day: 3, r: 'r1' }).text,
        knows: addKnow(null, 'r1', [{ about: 'Mara', fact: 'debt to the guild', how: 'heard' }]).text,
        tastes: tastesText([{ sign: '+', item: 'burnt sugar', day: 1, r: 'r1' }]),
    };
    const mara = { name: 'Mara', tastes: tastesText([{ sign: '-', item: 'rain', day: 1, r: 'r1' }]) };
    const aldo = { name: 'Aldo', tastes: tastesText([{ sign: '+', item: 'bread', day: 1, r: 'r1' }]) };
    const lines = notesTail({ rika: rika, mara, aldo }, { present: ['rika', 'mara', 'aldo'] });
    assert.equal(lines.length, NOTES_TAIL_MAX);
    assert.equal(NOTES_TAIL_PER_NPC, 2);
    assert.match(lines[0], /^Rika \(hidden\): told Astra/);
    assert.equal(lines[1], "Rika knows: Mara's debt to the guild");
    assert.equal(lines[2], 'Mara dislikes rain.');
    assert.equal(lines[3], 'Aldo likes bread.');
});

test('notesTail: nobody present, or a person with no notes, adds no lines', () => {
    assert.deepEqual(notesTail({ rika: { name: 'Rika' } }, { present: ['rika'] }), []);
    assert.deepEqual(notesTail({ rika: { name: 'Rika', tastes: tastesText([{ sign: '+', item: 'bread', day: 1, r: 'r1' }]) } }, { present: [] }), []);
    assert.deepEqual(notesTail(undefined, { present: ['rika'] }), []);
});


// ---- through the host: the capture, the leaf in the line's own op, the tail, the views (feature notes) ----

const ON = { [FEATURE_NOTES]: true };
const oren = s => s.host.head().domains.npc.npcs.oren;
const cast = async (s, name = 'Oren') => (await s.host.sdk.query('npc.cast', {})).find(item => item.name === name);
const optional = s => s.host.registry.module(MODULE_ID).context.tail({ state: s.host.head(), chat: { length: s.host.ctx.chat.length } }).optional;
const shape = s => JSON.stringify(s.host.head()).replace(/sw_[a-z0-9]+/g, 'sw');

test('notes host: the record fields are the kinds file\'s NOTE_FIELDS, and a lie told is one leaf in the line\'s own op, hidden in the tail', async () => {
    for (const field of NOTE_FIELDS) assert.ok(RECORD_FIELDS.includes(field), field);
    const s = await suite({ allowance: null, features: ON });
    await s.setDay(1);
    await s.say(['~ lie Oren | to: Astra | said: I never sold the spell']);
    assert.equal(JSON.parse(oren(s).lies).length, 1);
    assert.ok(optional(s).some(line => /(^|\n)Oren \(hidden\): told Astra "I never sold the spell"/.test(line)), JSON.stringify(optional(s)));
    assert.deepEqual(validateNpcSlice(s.host.head().domains.npc), []);
    assert.equal((await cast(s)).notes.lies[0].said, null, 'the player\'s view of an uncaught lie has no words of it');
});

test('notes host: only a story line catches a lie: six trust, in the day\'s allowance, the mood cause, and a second catch with none left moves nothing', async () => {
    const s = await suite({ allowance: null, features: { ...ON, 'npc-state-delta.mood-pull': true } });
    await s.setDay(1);
    await s.say(['~ npc Oren | trust: +1']);
    await s.say(['~ lie Oren | to: Astra | said: I never sold the spell']);
    await s.say(['~ lie Oren | to: Astra | caught: yes']);
    assert.equal(s.npc('Oren').meters.trust, -5, 'trust 1 - 6');
    assert.match(readLeaf(oren(s).mood).cause, /caught lying to Astra/);
    assert.ok(JSON.parse(oren(s).lies)[0].caught);
    assert.equal((await cast(s)).notes.lies[0].said, 'I never sold the spell', 'a caught lie is shown');
    assert.deepEqual(validateNpcSlice(s.host.head().domains.npc), []);
    await s.say(['~ lie Oren | to: Astra | caught: yes']);
    assert.equal(s.npc('Oren').meters.trust, -5, 'no uncaught lie left: the line is refused and nothing moves');
});

test('notes host: know lines of one reply are kept together, a secret reads as hidden until told, a bad line writes nothing', async () => {
    const s = await suite({ allowance: null, features: ON });
    await s.setDay(1);
    await s.say(['~ know Oren | about: Astra | fact: copies the gate-logs | how: saw | secret: yes', '~ know Oren | about: Temiwa | fact: is ill | how: heard']);
    assert.equal(JSON.parse(oren(s).knows).length, 2);
    assert.equal((await cast(s)).notes.knows.find(item => item.about === 'Astra').hidden, true);
    assert.doesNotMatch(JSON.stringify((await cast(s)).notes), /gate-logs/);
    assert.ok(optional(s).some(line => /(^|\n)Oren \(hidden\): knows Astra's copies the gate-logs/.test(line)));
    await s.say(['~ know Oren | about: Astra | fact: copies the gate-logs | told: yes']);
    assert.equal((await cast(s)).notes.knows.find(item => item.about === 'Astra').hidden, false);
    const before = oren(s).knows;
    await s.say(['~ know Oren | about: Astra | how: saw']);
    assert.equal(oren(s).knows, before, 'a line with no fact is refused: the leaf is as it was');
});

test('notes host: a taste is fixed (a swap needs why:), an echo of the player\'s words is kept and flagged; ties keep several tags and drop one', async () => {
    const s = await suite({ allowance: null, features: ON });
    await s.setDay(1);
    await s.host.send('I love burnt toffee', 'Fine.\n\n<Changes>\n~ taste Oren | likes: burnt toffee\n</Changes>');
    await s.adapter.ticked();
    assert.equal(JSON.parse(oren(s).tastes)[0].mirrored, true);
    assert.ok(s.host.head().domains.npc.problems.some(item => /echoes/.test(item.text)));
    await s.say(['~ taste Oren | dislikes: stamped paperwork | from: the charter']);
    await s.say(['~ taste Oren | likes: stamped paperwork']);
    assert.equal(JSON.parse(oren(s).tastes).filter(item => item.sign === '+').length, 1, 'refused without why:');
    await s.say(['~ tie Oren | with: Sister Temiwa | tag: +ally, +owes']);
    assert.deepEqual(Object.values(JSON.parse(oren(s).ties)), [['ally', 'owes']]);
    await s.say(['~ tie Oren | with: Sister Temiwa | tag: -ally']);
    assert.deepEqual(Object.values(JSON.parse(oren(s).ties)), [['owes']]);
    assert.deepEqual(validateNpcSlice(s.host.head().domains.npc), []);
});

test('notes host: feature off: the note lines write nothing and the static text is the same', async () => {
    const off = await suite({ allowance: null, features: { [FEATURE_NOTES]: false } });
    await off.setDay(1);
    await off.say(['~ lie Oren | to: Astra | said: x']);
    assert.equal(oren(off), undefined);
    const on = await suite({ allowance: null, features: ON });
    const text = x => x.host.registry.module(MODULE_ID).context.static();
    assert.equal(text(off), text(on), 'the npc static line has no notes text: the grammar goes through the kinds, behind the feature');
});

test('notes host: replay equals live: rebuild, a swipe, a Re-read, a middle delete and a cold reload (the leaves are part of the reply\'s op)', async () => {
    const s = await suite({ allowance: null, features: ON });
    await s.setDay(1);
    await s.say(['~ lie Oren | to: Astra | said: first']);
    const middle = await s.say(['~ know Oren | about: Astra | fact: a thing | how: saw', '~ tie Oren | with: Sister Temiwa | tag: +rival']);
    await s.say(['~ taste Oren | likes: tea']);
    await s.swipe(['~ taste Oren | likes: coffee']);
    const index = await s.say(['~ lie Oren | to: Astra | caught: yes']);
    assert.equal((await s.host.sdk.reread(index)).ok, true);
    let live = shape(s);
    s.host.store.rebuild();
    assert.equal(shape(s), live, 'rebuild equals live');
    await s.host.st.loadChat(s.host.ctx.chat);
    await s.adapter.ticked();
    assert.equal(shape(s), live, 'a cold reload equals live');
    await s.host.st.deleteMessage(middle);
    await s.host.st.deleteMessage(middle - 1);
    live = shape(s);
    s.host.store.rebuild();
    assert.equal(shape(s), live, 'rebuild equals live after the delete');
    assert.deepEqual(s.host.store.problems(), []);
    assert.deepEqual(validateNpcSlice(s.host.head().domains.npc), []);
});

test('notes host: npc.flag stamps the first look once and the reader\'s button is refused', async () => {
    const s = await suite({ allowance: null, features: ON });
    await s.setDay(1);
    await s.say(['~ npc Oren | trust: +1']);
    assert.equal((await s.host.sdk.command('npc.flag', { name: 'Oren', lock: true })).ok, false, 'not from a button');
    await s.adapter.flag({ name: 'Oren', lock: true, reply: s.host.store.headIndex(), cue: 'Oren\'s look is fixed: grey hair.' });
    const stamp = oren(s).lookLockedAt;
    assert.ok(stamp && Number.isInteger(stamp.day));
    await s.adapter.flag({ name: 'Oren', lock: true, reply: s.host.store.headIndex() });
    assert.deepEqual(oren(s).lookLockedAt, stamp, 'kept once');
    assert.equal(await s.adapter.flag({ name: 'Sister Temiwa', lock: true, reply: s.host.store.headIndex() }), null, 'a person with no meters gets no entry made by a flag');
    assert.equal(s.npc('Sister Temiwa'), null);
    assert.deepEqual(validateNpcSlice(s.host.head().domains.npc), []);
});

test('notes pure: drives scale the pull, a muted instinct gives none; tie rows derive from the relation word without storing; aliases fold', () => {
    const facts = { day: 5, party: false, threads: [], here: '', present: true, awayDay: null };
    const benched = stepPull({ party: 1 }, facts);
    assert.equal(benched.pull?.kind, 'belonging');
    const muted = stepPull({ party: 1 }, { ...facts, scale: driveScale(setDrives('', { belo: 0 }, {})) });
    assert.equal(muted.pull, null, 'belonging muted: no pull');
    assert.deepEqual(stepPull({ party: 1 }, { ...facts, scale: driveScale(setDrives('', { belo: 2 }, {})) }).pull, benched.pull, 'normal strength leaves the pull as it is');
    const rows = tieRows({}, ['Mira — rival of the house | cold', 'Tomas — friend | warm'], []);
    assert.deepEqual(rows.map(row => [row.name, row.tags, row.derived]), [['Mira', ['rival'], true], ['Tomas', ['ally'], true]]);
    assert.deepEqual(foldTies({ 'old-name': ['ally'], 'new-name': ['owes'] }, aliasCanon([{ name: 'New Name', aliases: ['Old Name'] }])), { 'new-name': ['ally', 'owes'] });
    assert.equal(dossierNotes({ lies: addLie('', { to: 'A', said: 'x', day: 1, r: 'sw_a' }).text }).lies[0].said, null);
});

test('notes pure: a pack entry\'s tastes and drives are the person\'s first; the map line takes its tone from a tie tag', () => {
    const entry = normalizeEntry({ name: 'Rika', about: 'a calm clerk', personality: 'Wants closure above all.', tastes: [{ sign: '+', item: 'toffee', from: 'barge crews' }, { sign: 'x', item: 'bad' }], drives: { closure: 3 } });
    assert.deepEqual(entry.tastes, [{ sign: '+', item: 'toffee', from: 'barge crews' }]);
    const seeded = seedNotes(entry);
    assert.equal(JSON.parse(seeded.tastes)[0].item, 'toffee');
    assert.ok(seeded.drives, 'a pack drive is a stored leaf');
    assert.deepEqual(seedNotes(normalizeEntry({ name: 'Plain' })), {}, 'nothing for a default');
    assert.equal(tieTone(['ally', 'rival']), 'hostile');
    assert.equal(tieTone(['owes']), 'duty');
    assert.equal(bondToneOf('friend', 'friend', { tags: ['rival'] }), 'bad');
    assert.equal(bondToneOf('friend', 'friend', { tags: ['owes'] }), 'gold');
    const npcs = [{ id: 'a', name: 'Rika', keyRelationships: ['Joren — friend'], v2Meters: { ties: { b: ['owes'] } } }, { id: 'b', name: 'Joren', keyRelationships: [] }];
    assert.deepEqual(resolveMapBonds(npcs, new Set(['a', 'b']))[0].tags, ['owes']);
});

test('locked look: the scan forwards a refused durable look as a flag (Problem + cue), and nothing when it is accepted or unchanged', async () => {
    // runtime-hosted.js imports the host's extensions.js: load a copy of the runtime beside a stub of it.
    const root = fileURLToPath(new URL('../', import.meta.url));
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-look-flag-'));
    const ext = path.join(temp, 'a', 'b', 'ext');
    fs.mkdirSync(ext, { recursive: true });
    for (const file of fs.readdirSync(root).filter(name => name.endsWith('.js'))) fs.copyFileSync(path.join(root, file), path.join(ext, file));
    fs.cpSync(path.join(root, 'src'), path.join(ext, 'src'), { recursive: true });
    fs.writeFileSync(path.join(temp, 'extensions.js'), 'export const getContext = () => ({ chat: [] });\nexport const extension_settings = {};\n');
    globalThis.document = { documentElement: { dataset: { npcStateDeltaStoryBlockV2: '1' } } };
    const sent = [];
    try {
        const { createHostedPart } = await import(pathToFileURL(path.join(ext, 'runtime-hosted.js')).href);
        const adapter = { hosted: () => true, flag: async item => { sent.push(item); }, adjust: async () => {} };
        const part = createHostedPart({ storySuiteV2: adapter }, { chatHydrationStatus: () => ({}), getChatKey: () => 'k', getChatState: () => ({}), latestMessageId: () => 0, latestReplyIndex: () => 0 });
        const rika = overall => ({ id: 'n1', name: 'Rika', overallAppearance: overall });
        const held = 'White hair, yellow-green eyes.';
        const tick = () => new Promise(resolve => setTimeout(resolve, 5));
        part.forwardRelationshipChangesToHost([rika(held)], [rika(held)], 7, null, [{ id: 'n1', overallAppearance: 'Black hair, brown eyes.' }]);
        await tick();
        assert.equal(sent.length, 1);
        assert.equal(sent[0].name, 'Rika');
        assert.equal(sent[0].reply, 7);
        assert.deepEqual(sent[0].drift, { before: held, incoming: 'Black hair, brown eyes.' });
        sent.length = 0;
        part.forwardRelationshipChangesToHost([rika(held)], [rika('Black hair, brown eyes.')], 8, null, [{ id: 'n1', overallAppearance: 'Black hair, brown eyes.' }]);
        part.forwardRelationshipChangesToHost([rika(held)], [rika(held)], 9, null, [{ id: 'n1', overallAppearance: held }]);
        part.forwardRelationshipChangesToHost([rika(held)], [rika(held)], 9, null, []);
        await tick();
        assert.deepEqual(sent, []);
    } finally { delete globalThis.document; fs.rmSync(temp, { recursive: true, force: true }); }
});

test('notes host: a refused look reaches npc.flag as a Problem, written once; the same look sends nothing', async () => {
    const s = await suite({ allowance: null, features: ON });
    await s.setDay(1);
    await s.say(['~ npc Oren | trust: +1']);
    const drift = { before: 'Grey hair, grey eyes.', incoming: 'Black hair.' };
    const head = () => s.host.store.headIndex();
    const done = await s.adapter.flag({ name: 'Oren', drift, reply: head() });
    assert.ok(done);
    const problems = s.host.store.problems().concat(s.host.head().domains.npc.problems ?? []);
    assert.ok(problems.some(item => /Look drift refused: "Black hair\." does not match the fixed look "Grey hair, grey eyes\."/.test(item?.text ?? item)));
    const count = () => (s.host.head().domains.npc.problems ?? []).length;
    const once = count();
    await s.adapter.flag({ name: 'Oren', drift, reply: head() });
    assert.equal(count(), once, 'the same text is not written twice');
    assert.equal(await s.adapter.flag({ name: 'Oren', drift: { before: 'Grey hair.', incoming: 'grey hair' }, reply: head() }), null, 'the same look sends nothing');
    assert.deepEqual(validateNpcSlice(s.host.head().domains.npc), []);
});

test('notes host (review fixes): npc.cast hides an uncaught lie\'s words and id; the lie tail line carries the (hidden) wording when no locked meter note does; a caught lie held by the day\'s allowance is still recorded as caught', async () => {
    const s = await suite({ allowance: null, features: ON });
    await s.setDay(1);
    await s.say(['~ lie Oren | to: Astra | said: I never sold the spell']);
    const lies = (await cast(s)).notes.lies;
    assert.equal(lies.length, 1);
    assert.doesNotMatch(JSON.stringify(lies), /never sold/);
    const lines = optional(s);
    const at = lines.findIndex(line => /\nOren \(hidden\): told Astra/.test(line));
    assert.ok(at >= 0, JSON.stringify(lines));
    assert.match(lines[at], /^Lines marked \(hidden\) are secrets: never state or reveal them/);
    const held = await suite({ allowance: { ordinary: 0, meaningful: 0, major: 0, extreme: 0 }, features: ON });
    await held.setDay(1);
    await held.say(['~ npc Oren | trust: +1']);
    await held.say(['~ lie Oren | to: Astra | said: I never sold the spell']);
    const trust = held.npc('Oren').meters.trust;
    await held.say(['~ lie Oren | to: Astra | caught: yes']);
    assert.ok(JSON.parse(oren(held).lies)[0].caught, 'the player caught it, so it is recorded as caught even when the day holds the drop');
    assert.equal(held.npc('Oren').meters.trust, trust, 'the allowance held the trust drop');
});

test('notes host (review fix 5/9): a swipe of the reply whose scan sent npc.flag takes back the look stamp and the Problem', async () => {
    const s = await suite({ allowance: null, features: ON });
    await s.setDay(1);
    await s.say(['~ npc Oren | trust: +1']);
    await s.say(['~ npc Oren | trust: +1']);
    const head = () => s.host.store.headIndex();
    await s.adapter.flag({ name: 'Oren', lock: true, reply: head() });
    await s.adapter.flag({ name: 'Oren', drift: { before: 'Grey hair, grey eyes.', incoming: 'Black hair.' }, reply: head() });
    assert.ok(oren(s).lookLockedAt, 'stamped');
    assert.ok((s.host.head().domains.npc.problems ?? []).some(item => /Look drift refused/.test(item?.text ?? '')), 'flagged');
    await s.swipe(['~ npc Oren | trust: +1']);
    assert.equal(oren(s).lookLockedAt, undefined, 'the swiped reply\'s stamp is gone');
    assert.ok(!(s.host.head().domains.npc.problems ?? []).some(item => /Look drift refused/.test(item?.text ?? '')), 'and its Problem');
    assert.deepEqual(validateNpcSlice(s.host.head().domains.npc), []);
});

test('notes host: npc.meet gives a scan-admitted person an entry with the dossier\'s mood and drives; a button, a repeat and a swipe-free rebuild all hold', async () => {
    const s = await suite({ allowance: null, features: { ...ON, 'npc-state-delta.mood-pull': true } });
    await s.setDay(1);
    await s.say(['~ npc Oren | trust: +1']);
    assert.equal((await s.host.sdk.command('npc.meet', { name: 'Mara' })).ok, false, 'not from a button');
    const slice = () => s.host.head().domains.npc;
    assert.equal(slice().npcs.mara, undefined, 'a person the scan admitted has no entry yet');
    await s.adapter.meet({ name: 'Mara', personality: 'cheerful, warm and kind; confident and bold', about: 'a caravan guard' });
    const mara = slice().npcs.mara;
    assert.ok(mara && mara.meters, 'the entry exists with meters');
    assert.ok(mara.mood && mara.mood.v > 0 && mara.mood.d > 0, 'a resting mood from the temperament words');
    assert.deepEqual(validateNpcSlice(slice()), []);
    const live = JSON.stringify(slice());
    await s.adapter.meet({ name: 'Mara', personality: 'cheerful, warm and kind' });   // refused: nothing to add
    assert.equal(JSON.stringify(slice()), live, 'a second meeting changes nothing');
    s.host.store.rebuild();
    assert.equal(JSON.stringify(slice()), live, 'rebuild equals live');
    assert.deepEqual(s.host.store.problems(), []);
});

test('notes host: npc.meet gives a scan-admitted person with no temperament words a mood at rest (0/0/0) and a pull entry, once', async () => {
    const s = await suite({ allowance: null, features: { ...ON, 'npc-state-delta.mood-pull': true } });
    await s.setDay(1);
    await s.say(['~ npc Oren | trust: +1']);
    await s.adapter.meet({ name: 'Corren', personality: 'quiet', about: 'a clerk' });
    const slice = () => s.host.head().domains.npc;
    const mood = slice().npcs.corren.mood;
    assert.ok(mood && mood.v === 0 && mood.a === 0 && mood.d === 0, 'a mood with all three fields at rest');
    assert.deepEqual(validateNpcSlice(slice()), []);
    await s.say(['~ npc Oren | trust: +1']);
    assert.ok(slice().npcs.corren.mood, 'the tick keeps stepping it');
    const live = JSON.stringify(slice());
    s.host.store.rebuild();
    assert.equal(JSON.stringify(slice()), live, 'rebuild equals live');
});

test('notes host: npc.meet takes the reply the scan read (as npc.adjust does); rebuild equals live', async () => {
    const s = await suite({ allowance: null, features: { ...ON, 'npc-state-delta.mood-pull': true } });
    await s.setDay(1);
    await s.say(['~ npc Oren | trust: +1']);
    const older = s.host.store.headIndex();
    await s.say(['~ npc Oren | trust: +1']);
    await s.adapter.meet({ name: 'Mara', personality: 'cheerful, warm and kind', reply: older });   // a scan of the older reply admitted her
    const slice = () => s.host.head().domains.npc;
    assert.ok(slice().npcs.mara && slice().npcs.mara.meters, 'met');
    assert.deepEqual(validateNpcSlice(slice()), []);
    const live = JSON.stringify(slice());
    s.host.store.rebuild();
    assert.equal(JSON.stringify(slice()), live, 'rebuild equals live');
});

test('scan-admitted people: the scan sends npc.meet for a dossier it just made, not for a known or archived one, and an older host without meet gets nothing', async () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-meet-'));
    const ext = path.join(temp, 'a', 'b', 'ext');
    fs.mkdirSync(ext, { recursive: true });
    for (const file of fs.readdirSync(root).filter(name => name.endsWith('.js'))) fs.copyFileSync(path.join(root, file), path.join(ext, file));
    fs.cpSync(path.join(root, 'src'), path.join(ext, 'src'), { recursive: true });
    fs.writeFileSync(path.join(temp, 'extensions.js'), 'export const getContext = () => ({ chat: [] });\nexport const extension_settings = {};\n');
    globalThis.document = { documentElement: { dataset: { npcStateDeltaStoryBlockV2: '1' } } };
    const sent = [];
    try {
        const { createHostedPart } = await import(pathToFileURL(path.join(ext, 'runtime-hosted.js')).href);
        const deps = { chatHydrationStatus: () => ({}), getChatKey: () => 'k', getChatState: () => ({}), latestMessageId: () => 0, latestReplyIndex: () => 0 };
        const order = [];
        const adapter = { hosted: () => true, flag: async () => { order.push('flag'); }, adjust: async () => { order.push('adjust'); }, meet: async item => { order.push('meet'); sent.push(item); } };
        const part = createHostedPart({ storySuiteV2: adapter }, deps);
        const old = { id: 'o1', name: 'Oren' };
        const fresh = { id: 'n2', name: 'Coram', personality: 'calm and stoic', background: 'a ferryman' };
        const tick = () => new Promise(resolve => setTimeout(resolve, 5));
        part.forwardRelationshipChangesToHost([old], [old, fresh, { id: 'n3', name: 'Gone', archived: true }], 4, null, []);
        await tick();
        assert.deepEqual(sent, [{ name: 'Coram', personality: 'calm and stoic', about: 'a ferryman', reply: 4 }], 'the meeting names the reply the scan read');
        sent.length = 0;
        // Not the dead and not incidental extras (the slice holds 80 people); an ordinary, living, meaningful one is met.
        const extras = [{ id: 'd1', name: 'Raider', lifeState: 'deceased' }, { id: 'd2', name: 'Raider Two', lifeState: 'dead' }, { id: 'i1', name: 'Passer-by', dossierSignal: 'incidental' }, { id: 'm1', name: 'Wren', dossierSignal: 'meaningful', lifeState: 'alive' }];
        part.forwardRelationshipChangesToHost([old], [old, ...extras], 4, null, []);
        await tick();
        assert.deepEqual(sent.map(item => item.name), ['Wren']);
        sent.length = 0;
        // Order: the slice entry first (adjust, else meet), then the look lock, which never makes an entry itself.
        order.length = 0;
        const moved = { id: 'n4', name: 'Tarn', relationship: { trust: 5 }, overallAppearance: 'a tall man in grey' };
        part.forwardRelationshipChangesToHost([old], [old, moved, { id: 'n5', name: 'Lis', overallAppearance: 'a short woman' }], 4, null, []);
        await tick();
        assert.deepEqual(order, ['adjust', 'meet', 'meet', 'flag', 'flag'], 'meters and meetings before the look flags');
        sent.length = 0;
        part.forwardRelationshipChangesToHost([old, fresh], [old, fresh], 5, null, []);
        await tick();
        assert.deepEqual(sent, [], 'a known person is not met again');
        const older = createHostedPart({ storySuiteV2: { hosted: () => true, flag: async () => {}, adjust: async () => {} } }, deps);
        older.forwardRelationshipChangesToHost([old], [old, fresh], 6, null, []);
        await tick();
        assert.deepEqual(sent, [], 'an adapter without meet: as before');
    } finally { delete globalThis.document; fs.rmSync(temp, { recursive: true, force: true }); }
});

// ---- the prompt text for the five rare kinds (flash-rare-lines): when to write it and one example in the grammar ----

const exampleOf = grammar => /e\.g\. ([^)]+)\)$/.exec(grammar)?.[1];

test('notes grammar: each kind says plainly when to write it and carries one example line that the real parser takes', async () => {
    const kinds = noteKinds(() => {});
    const s = await suite({ allowance: null, features: ON });
    await s.setDay(1);
    for (const kind of ['lie', 'know', 'taste', 'tie']) {
        const grammar = kinds[kind].grammar;
        assert.match(grammar, /write it when /, kind);
        const example = exampleOf(grammar);
        assert.ok(example && example.startsWith(`~ ${kind} `), `${kind}: ${grammar}`);
        const stored = await s.say([example]);
        assert.ok(stored !== undefined, kind);
    }
    const o = Object.values(s.host.head().domains.npc.npcs).find(npc => npc.name === 'Person A');
    assert.ok(o, 'the examples name a generic person');
    assert.equal(JSON.parse(o.lies).length, 1, 'the lie example wrote a lie leaf');
    assert.equal(JSON.parse(o.knows).length, 1);
    assert.ok(o.tastes && o.ties, 'the taste and tie examples wrote their leaves');
    const { createNpcPart } = await import('../src/npc-meters.js');
    const milestone = createNpcPart({ settings: () => ({}), present: () => [], feature: () => true }).kinds.milestone.grammar;
    assert.match(milestone, /when a bond changes for good; e\.g\. \+ milestone Person A — a promise was kept\)$/);
});

test('notes grammar: the example lines use generic placeholder people and facts, never a name or fact of any world', () => {
    const all = Object.values(noteKinds(() => {})).map(kind => exampleOf(kind.grammar)).join('\n');
    for (const name of ['Pell', 'Temiwa', 'Astra', 'Oren', 'Mira', 'Ersveil', 'Rika', 'Tomas']) assert.ok(!all.includes(name), name);
    assert.ok(!/\bill\b/.test(all));
    assert.ok((all.match(/Person [AB]/g) ?? []).length >= 4);
});

test('notes grammar: the lie line agrees with itself: when and example both use the host\'s {{user}} macro, no hard-coded name', () => {
    const lie = noteKinds(() => {}).lie.grammar;
    assert.match(lie, /^~ lie Name \| to: \{\{user\}\} \|/);
    assert.match(lie, /write it when someone lies to \{\{user\}\};/);
    assert.match(lie, /e\.g\. ~ lie Person A \| to: \{\{user\}\} \|/);
    assert.ok(!/Astra|to the player|to: Person B/.test(lie));
});

test('notes grammar: the static text is the same bytes every time and the added text stays small', async () => {
    const once = JSON.stringify(noteKinds(() => {}));
    assert.equal(JSON.stringify(noteKinds(() => {})), once);
    const bare = 88 + 107 + 54 + 70; // the four lines as they were (lie, know, taste, tie)
    const added = Object.values(noteKinds(() => {})).reduce((sum, kind) => sum + kind.grammar.length, 0) - bare;
    assert.ok(added > 0 && added < 500, `added ${added} chars`);
});

test('notes tail: the Changes cue is the last optional line while someone is present, and absent with the notes feature off or nobody here', async () => {
    const on = await suite({ allowance: null, features: ON });
    await on.setDay(1);
    await on.say(['~ npc Oren | trust: +1']);
    const lines = optional(on);
    assert.match(lines.at(-1), /^Whenever anything changed, write the <Changes> block \(just before <Blocks>, which still ends the reply\), even if <Blocks> is empty/);
    assert.equal(lines.filter(line => /<Changes>/.test(line)).length, 1);
    const off = await suite({ allowance: null, features: { [FEATURE_NOTES]: false } });
    await off.setDay(1);
    await off.say(['~ npc Oren | trust: +1']);
    assert.ok(!optional(off).some(line => /<Changes>/.test(line)));
    const empty = await suite({ allowance: null, features: ON });
    assert.ok(!optional(empty).some(line => /<Changes>/.test(line)));
});

test('notes host: npc.drives grows a drive on the 2nd different reply with a cue; live == rebuild, a swipe takes the step back, a button is refused', async () => {
    const s = await suite({ allowance: null, features: { ...ON } });
    await s.setDay(1);
    await s.say(['~ npc Oren | trust: +1']);
    const slice = () => s.host.head().domains.npc;
    const belonging = () => JSON.parse(slice().npcs.oren.drives ?? '{"belo":2}').belo;
    assert.equal((await s.host.sdk.command('npc.drives', { name: 'Oren', texts: ['a friend'], rule: 1 })).ok, false, 'not from a button');
    assert.equal(await s.adapter.drives({ name: 'Oren', texts: ['made a friend at the inn'] }) !== null, true);
    assert.equal(belonging(), 2, 'one reply with a cue: still normal');
    await s.say(['~ npc Oren | trust: +1']);
    await s.adapter.drives({ name: 'Oren', texts: ['his family came to visit'] });
    assert.equal(belonging(), 3, 'a second different reply with a cue: high');
    assert.deepEqual(validateNpcSlice(slice()), []);
    const live = JSON.stringify(slice());
    s.host.store.rebuild();
    assert.equal(JSON.stringify(slice()), live, 'rebuild equals live');
    await s.adapter.drives({ name: 'Oren', texts: ['a friend again'] });
    assert.equal(JSON.stringify(slice()), live, 'the same reply again changes nothing');
    await s.adapter.drives({ name: 'Oren', texts: ['x'], rule: 2 });
    assert.equal(JSON.stringify(slice()), live, 'an unknown rule is not read');
    await s.swipe(['~ npc Oren | trust: +1']);
    assert.equal(belonging(), 2, 'a swipe of the reply takes the step back');
    assert.deepEqual(s.host.store.problems(), []);
});
