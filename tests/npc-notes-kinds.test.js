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
import { tastesText, mergeRefreshTastes, readTastes } from '../src/npc-notes-tastes.js';
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
import { projectDossierState } from '../dossier-ui-catalog.js';
import { dossierProfileHtml } from '../dossier-ui-profile.js';

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
        assert.deepEqual(sent[0].drift, { before: held, incoming: 'Black hair, brown eyes.', swaps: [{ trait: 'hair', said: 'black', kept: 'white' }, { trait: 'eyes', said: 'brown', kept: 'yellow green' }] });
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
        const adapter = { hosted: () => true, flag: async () => { order.push('flag'); }, adjust: async () => { order.push('adjust'); }, meet: async ({ guard, ...item }) => { order.push('meet'); assert.equal(typeof guard, 'function', 'the meeting carries its guard (held while a native change finishes, dropped if its reply is taken back)'); sent.push(item); } };
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

const CUE = /^Whenever anything changed, write the <Changes> block \(just before <Blocks>, which still ends the reply\), even if <Blocks> is empty/;
const tailOf = s => s.host.registry.module(MODULE_ID).context.tail({ state: s.host.head(), chat: { length: s.host.ctx.chat.length } });
const cueLines = tail => tail.lines.filter(line => CUE.test(typeof line === 'string' ? line : line?.text));

test('notes tail: the Changes cue is one kept line, last of the lines, with the notes feature on whoever is in the scene, and absent with it off', async () => {
    const on = await suite({ allowance: null, features: ON });
    await on.setDay(1);
    await on.say(['~ npc Oren | trust: +1']);
    const tail = tailOf(on);
    assert.equal(cueLines(tail).length, 1);
    assert.deepEqual(tail.lines.at(-1), { text: tail.lines.at(-1).text, keep: true });
    assert.match(tail.lines.at(-1).text, CUE);
    assert.ok(!tail.optional.some(line => /<Changes>/.test(line)), 'not an optional line: the host drops those first');
    const off = await suite({ allowance: null, features: { [FEATURE_NOTES]: false } });
    await off.setDay(1);
    await off.say(['~ npc Oren | trust: +1']);
    assert.equal(cueLines(tailOf(off)).length, 0);
});

test('notes tail: the cue is sent in a reply with nobody present (a quiet travel reply) and with no dossier at all', async () => {
    const empty = await suite({ allowance: null, features: ON });
    assert.equal(cueLines(tailOf(empty)).length, 1);
    const alone = await suite({ allowance: null, features: ON, present: [] });
    await alone.setDay(1);
    await alone.say(['~ npc Oren | trust: +1']);
    assert.equal(cueLines(tailOf(alone)).length, 1);
});

test('notes tail: under a tight tail budget (the run\'s 550 tokens, here 60 with a crowded section) the host still sends the cue (the meters line is the one that goes)', async () => {
    const { assemble } = await import('./vendor/story-block/src/v2/prompt.js');
    const s = await suite({ allowance: null, features: ON });
    await s.setDay(1);
    await s.say(['~ npc Oren | trust: +1']);
    const view = { state: s.host.head(), query: () => null, settings: {}, chat: { length: s.host.ctx.chat.length } };
    const built = assemble({ registry: s.host.registry, view, settings: { tailBudget: 60 } });
    assert.ok(CUE.test(built.tailText.split('\n').find(line => CUE.test(line)) ?? ''), built.tailText);
    const ours = built.parts.find(part => part.module === MODULE_ID && part.place === 'tail');
    assert.match(ours.text, /Whenever anything changed/);
    assert.ok(!/NPC meters now/.test(ours.text), 'the ordinary line was dropped, the kept cue stayed');
});

// The run's conditions: tailBudget 550, a crowded earlier section (Story Director's lines) with a kept Initiative line, a kept pulse prelude, nobody present.
async function crowded(keptTokens) {
    const { assemble, estimateTokens, KEPT_TAIL_TOKENS } = await import('./vendor/story-block/src/v2/prompt.js');
    const s = await suite({ allowance: null, features: ON, present: [] });
    await s.setDay(1);
    const initiative = 'Initiative: Mira acts first, then the guards, then Oren.';
    const filler = Array.from({ length: 11 }, (_, i) => `Scene note ${i + 1}: ${'the harbour street holds its breath '.repeat(5)}`.trim());
    s.host.registry.register({ id: 'aa-crowd', name: 'Crowd', context: { tail: () => ({ lines: [{ text: initiative, keep: true }, ...filler, 'Guild: the last ordinary line.'] }) } });
    const view = { state: s.host.head(), query: () => null, settings: {}, chat: { length: s.host.ctx.chat.length } };
    const built = assemble({ registry: s.host.registry, view, settings: { tailBudget: 550 }, keptTokens });
    return { built, initiative, estimateTokens, KEPT_TAIL_TOKENS };
}

test('notes tail: tailBudget 550, nobody present, a crowded section: the other module\'s kept line wins, the cue is kept when it fits after it, the tail is under budget', async () => {
    const { built, initiative, estimateTokens } = await crowded(32);
    assert.ok(built.tailText.includes(initiative), 'the Initiative kept line stays');
    assert.ok(CUE.test(built.tailText.split('\n').find(line => CUE.test(line)) ?? ''), 'the cue is sent');
    assert.ok(estimateTokens(built.tailText) <= 550, `tail ${estimateTokens(built.tailText)} tokens`);
    assert.ok(!built.tailText.includes('Guild: the last'), 'ordinary lines go before the kept ones (the crowd was over budget)');
});

test('notes tail: when the shared kept cap is spent (past 120 tokens) the cue is an ordinary line: the other kept lines still stay, the tail is under budget', async () => {
    const { built, initiative, estimateTokens } = await crowded(100);
    assert.ok(built.tailText.includes(initiative), 'the kept line stays whatever happens to the cue');
    assert.ok(estimateTokens(built.tailText) <= 550, `tail ${estimateTokens(built.tailText)} tokens`);
    assert.ok(!/Whenever anything changed/.test(built.tailText), 'no room after the others\' kept lines: the cue goes first, as an ordinary line');
});

test('mergeRefreshTastes: new tastes merge like ~ taste lines; a taste already there (either sign) and a full sign are never changed or pushed out', () => {
    const own = tastesText([{ sign: '+', item: 'Burnt Sugar', from: 'narrator', day: 1, r: 'r1' }, { sign: '-', item: 'Paperwork', day: 1, r: 'r1' }]);
    const out = mergeRefreshTastes(own, [
        { sign: '+', item: 'burnt  sugar', from: 'again' }, { sign: '+', item: 'paperwork', from: 'flip' }, { sign: '+', item: 'old maps', from: 'collects them [m4]' },
        { sign: '-', item: 'loud bells', from: 'flinches' }, { sign: 'x', item: 'junk' }, { sign: '+', item: '' },
    ], { name: 'Oren', day: 3, r: 'r9' });
    assert.equal(out.added, 2);
    const rows = readTastes(out.text);
    assert.deepEqual(rows.map(row => [row.sign, row.item, row.from ?? null, row.r]), [['+', 'Burnt Sugar', 'narrator', 'r1'], ['-', 'Paperwork', null, 'r1'], ['+', 'old maps', 'collects them', 'r9'], ['-', 'loud bells', 'flinches', 'r9']]);
    const full = tastesText(Array.from({ length: 6 }, (_, i) => ({ sign: '+', item: `like ${i}`, day: 0, r: 'r1' })));
    const none = mergeRefreshTastes(full, [{ sign: '+', item: 'one more' }], { r: 'r2' });
    assert.equal(none.added, 0, 'a full sign takes nothing');
    assert.equal(none.text, full, 'and nothing is pushed out');
    assert.equal(mergeRefreshTastes('', [{ sign: '+', item: 'tea' }], {}).added, 1);
    assert.equal(mergeRefreshTastes(null, 'nope').added, 0);
});

test('notes host: npc.taste records a Refresh\'s tastes on its reply; the narrator\'s taste stays; a button, an unknown person and a repeat write nothing; swipe and rebuild equal live', async () => {
    const s = await suite({ allowance: null, features: ON });
    await s.setDay(1);
    await s.say(['~ npc Oren | trust: +1']);
    await s.say(['~ taste Oren | likes: tea | from: the kettle']);
    const head = () => s.host.store.headIndex();
    assert.equal((await s.host.sdk.command('npc.taste', { name: 'Oren', tastes: [{ sign: '+', item: 'x' }] })).ok, false, 'not from a button');
    assert.equal(await s.adapter.tastes({ name: 'Sister Temiwa', tastes: [{ sign: '+', item: 'x' }], reply: head() }), null, 'no entry is made by a Refresh');
    assert.equal(await s.adapter.tastes({ name: 'Oren', tastes: [], reply: head() }), null);
    await s.say(['~ npc Oren | trust: +1']);
    await s.adapter.tastes({ name: 'Oren', tastes: [{ sign: '+', item: 'Tea', from: 'refresh' }, { sign: '-', item: 'loud bells', from: 'flinches [m3]' }, { sign: '+', item: 'old maps', from: 'collects them' }], reply: head() });
    const rows = () => readTastes(oren(s).tastes);
    assert.deepEqual(rows().map(row => [row.sign, row.item, row.from ?? null]), [['+', 'tea', 'the kettle'], ['-', 'loud bells', 'flinches'], ['+', 'old maps', 'collects them']].map(([a, b, c]) => [a, b === 'tea' ? 'tea' : b, c]));
    assert.ok(rows().slice(1).every(row => row.r), 'each Refresh taste carries its reply');
    const before = JSON.stringify(oren(s).tastes);
    await s.adapter.tastes({ name: 'Oren', tastes: [{ sign: '+', item: 'old maps', from: 'again' }], reply: head() });
    assert.equal(JSON.stringify(oren(s).tastes), before, 'a repeat changes nothing');
    const live = JSON.stringify(s.host.head().domains.npc);
    s.host.store.rebuild();
    assert.equal(JSON.stringify(s.host.head().domains.npc), live, 'rebuild equals live');
    assert.deepEqual(validateNpcSlice(s.host.head().domains.npc), []);
    await s.swipe(['~ npc Oren | trust: +1']);
    assert.deepEqual(rows().map(row => row.item), ['tea'], 'a swipe of the reply that ran the Refresh takes its tastes back');
    const swiped = JSON.stringify(s.host.head().domains.npc);
    s.host.store.rebuild();
    assert.equal(JSON.stringify(s.host.head().domains.npc), swiped, 'rebuild equals live after the swipe');
    assert.deepEqual(validateNpcSlice(s.host.head().domains.npc), []);
});

test('notes host: the Profile placeholders (Tastes, Drives) reach the real dossier chain only with notes ON (adapter.dossierMeters → projectDossierState → Profile)', async () => {
    const profile = async features => {
        const s = await suite({ allowance: null, features });
        await s.setDay(1);
        await s.say(['~ npc Oren | trust: +1']);
        const npcs = [{ id: 'npc_oren', name: 'Oren' }];
        const meterViews = s.adapter.dossierMeters(npcs);
        const projected = projectDossierState({ npcs, meterViews }).npcs[0];
        return { view: meterViews.npc_oren, html: dossierProfileHtml(projected, { layout: 'phone' }) };
    };
    const on = await profile(ON);
    assert.equal(on.view.notesOn, true, 'the adapter keeps the flag');
    assert.match(on.html, /<h3>Tastes<\/h3>/);
    assert.match(on.html, /No tastes yet/);
    assert.match(on.html, /<h3>Drives<\/h3>/);
    assert.match(on.html, /All normal so far/);
    const off = await profile({ [FEATURE_NOTES]: false });
    assert.equal(off.view.notesOn, undefined);
    assert.doesNotMatch(off.html, /Tastes|Drives|No tastes yet|All normal so far/);
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
    await s.swipe(['~ npc Oren | trust: +1']);
    assert.equal(belonging(), 2, 'a swipe of the reply takes the step back');
    assert.deepEqual(s.host.store.problems(), []);
});

test('notes host: the same reply twice counts once while the drive is below max (the 2-reply rule, not the max cap); an Re-read and a middle delete keep the drives', async () => {
    const s = await suite({ allowance: null, features: { ...ON } });
    await s.setDay(1);
    await s.say(['~ npc Oren | trust: +1']);
    const comfort = () => JSON.parse(s.host.head().domains.npc.npcs.oren.drives ?? '{"comf":2}').comf;
    await s.adapter.drives({ name: 'Oren', texts: ['found a cozy bed'] });
    const once = JSON.stringify(s.host.head().domains.npc);
    await s.adapter.drives({ name: 'Oren', texts: ['a warm meal'] });
    assert.equal(comfort(), 2, 'two cues in the SAME reply: still normal');
    assert.equal(JSON.stringify(s.host.head().domains.npc), once, 'nothing written for the same reply');
    const second = await s.say(['~ npc Oren | trust: +1']);
    await s.adapter.drives({ name: 'Oren', texts: ['a warm meal'] });
    assert.equal(comfort(), 3, 'the next reply: high');
    await s.say(['~ npc Oren | trust: +1']);
    assert.equal((await s.host.sdk.reread(second)).ok, true);
    let live = JSON.stringify(s.host.head().domains.npc);
    s.host.store.rebuild();
    assert.equal(JSON.stringify(s.host.head().domains.npc), live, 'a Re-read of the reply that carried npc.drives replays as stored');
    assert.equal(comfort(), 3);
    await s.host.st.deleteMessage(second - 1);
    live = JSON.stringify(s.host.head().domains.npc);
    s.host.store.rebuild();
    assert.equal(JSON.stringify(s.host.head().domains.npc), live, 'rebuild equals live after a middle delete');
    assert.deepEqual(s.host.store.problems(), []);
});

// ---- the scanner's mood word becomes the three numbers (npc-mood.js lexicon; npc.mood) ----
test('mood words: the fixed lexicon gives the axes of a word or phrase, an unknown text gives none, a negated word does not count, and the numbers always settle toward rest', async () => {
    const { moodFromWord, applyWord, decayMood, restMood, nextMoodLog, readMoodLog } = await import('../npc-mood.js');
    assert.deepEqual(moodFromWord('mortified and flustered'), { v: -2, a: 2, d: -3, words: ['mortified', 'flustered'] }, 'the mean of the words found, rounded away from zero');
    assert.deepEqual(moodFromWord('Alarmed'), { v: -2, a: 3, d: -2, words: ['alarmed'] });
    assert.equal(moodFromWord('xyzzy plugh'), null, 'no known word: no numbers, never a guess');
    assert.equal(moodFromWord(''), null);
    const rest = restMood({}, 0);
    const moved = applyWord(rest, 600, moodFromWord('mortified and flustered'), 'mortified and flustered', 'the mishap');
    assert.deepEqual([moved.mood.v, moved.mood.a, moved.mood.d], [-2, 2, -3]);
    assert.deepEqual(moved.change, { v: -2, a: 2, d: -3 });
    assert.equal(moved.mood.cause, 'now mortified and flustered — the mishap');
    const later = decayMood(moved.mood, 600 + 1440 * 5);
    assert.ok(Math.abs(later.v) < 2 && Math.abs(later.d) <= 3, 'fades toward the resting mood');
    const text = nextMoodLog(null, { n: 4, date: 'Goldwane 21', change: moved.change, why: 'the mishap' });
    assert.deepEqual(readMoodLog(text), [{ n: 4, date: 'Goldwane 21', v: -2, a: 2, d: -3, why: 'the mishap' }]);
    assert.equal(nextMoodLog(text, { n: 5, change: { v: 0, a: 0, d: 0 } }), null, 'a reply that moved nothing writes no entry');
    assert.deepEqual(readMoodLog('{"e":[{"n":1}]}'), [], 'an unreadable entry is dropped');
});

test('notes host: npc.mood sets the three numbers from the scanner\'s word, logs the move with its reason, keeps the numbers for an unrated word, and rebuild equals live', async () => {
    const s = await suite({ allowance: null, features: { ...ON, 'npc-state-delta.mood-pull': true } });
    await s.setDay(1);
    await s.say(['~ npc Oren | trust: +1']);
    const slice = () => s.host.head().domains.npc;
    assert.equal((await s.host.sdk.command('npc.mood', { name: 'Oren', word: 'mortified' })).ok, false, 'not from a button');
    const head = s.host.store.headIndex();
    await s.adapter.mood({ name: 'Oren', word: 'mortified and flustered', reason: 'the wardrobe mishap', reply: head });
    const oren = slice().npcs.oren;
    const mood = readLeaf(oren.mood);
    assert.deepEqual([mood.v, mood.a, mood.d], [-2, 2, -3]);
    const log = readLeaf(oren.moodLog).e;
    assert.equal(log.length, 1);
    assert.deepEqual([log[0].n, log[0].v, log[0].a, log[0].d, log[0].why], [head, -2, 2, -3, 'now mortified and flustered — the wardrobe mishap']);
    assert.deepEqual(validateNpcSlice(slice()), []);
    const view = (await cast(s)).mood;
    assert.deepEqual([view.valence, view.energy, view.control], [-2, 2, -3], 'the query carries the raw axes');
    assert.deepEqual(view.log.map(row => [row.n, row.v, row.a, row.d]), [[head, -2, 2, -3]], 'and the history');
    const before = JSON.stringify(slice());
    assert.equal((await s.adapter.mood({ name: 'Oren', word: 'mortified and flustered', again: true })).ok, false, 'a catch-up is refused when the mood already follows a move');
    assert.equal(JSON.stringify(slice()), before);
    // a word with no numbers and no known word keeps the numbers and says so (never silently nothing)
    assert.equal((await s.adapter.mood({ name: 'Oren', word: 'xyzzy', reply: head })).ok, true);
    const kept = readLeaf(slice().npcs.oren.mood);
    assert.deepEqual([kept.v, kept.a, kept.d], [-2, 2, -3], 'the previous numbers stay');
    assert.equal(kept.cause, 'now xyzzy — mood word not rated');
    assert.equal(readLeaf(slice().npcs.oren.moodLog).e.length, 1, 'no movement: no new history row');
    const after = JSON.stringify(slice());
    s.host.store.rebuild();
    assert.equal(JSON.stringify(slice()), after, 'rebuild equals live');
    assert.deepEqual(s.host.store.problems(), []);
});

test('notes host: a caught lie (a trust drop) writes its move on the mood history with the cause', async () => {
    const s = await suite({ allowance: null, features: { ...ON, 'npc-state-delta.mood-pull': true } });
    await s.setDay(1);
    await s.say(['~ npc Oren | trust: +1']);
    await s.say(['~ lie Oren | to: Astra | said: I never sold the spell']);
    await s.say(['~ lie Oren | to: Astra | caught: yes']);
    const log = readLeaf(oren(s).moodLog)?.e ?? [];
    assert.equal(log.length, 1, 'the trust drop made one entry');
    assert.match(log[0].why, /caught lying to Astra/);
    assert.ok(log[0].v < 0 && log[0].a > 0, 'the axes moved the way the event says');
    assert.deepEqual(validateNpcSlice(s.host.head().domains.npc), []);
    const live = JSON.stringify(s.host.head().domains.npc);
    s.host.store.rebuild();
    assert.equal(JSON.stringify(s.host.head().domains.npc), live, 'rebuild equals live');
});

test('notes host: the reason a story line gave is kept on the reply\'s last event and read back by the card summary; a line without one keeps none', async () => {
    const { readEvent, eventSummary } = await import('../src/npc-meters-pacing.js');
    const s = await suite({ allowance: null, features: ON });
    await s.setDay(1);
    await s.say(['~ npc Oren | affection: +2 | reason: Astra helped her cover up after the mishap']);
    assert.equal(eventSummary(readEvent(oren(s).lastEvent)).why, 'Astra helped her cover up after the mishap');
    await s.say(['~ npc Oren | affection: +1']);
    assert.equal(eventSummary(readEvent(oren(s).lastEvent)).why, undefined, 'no reason given: none kept');
    assert.deepEqual(validateNpcSlice(s.host.head().domains.npc), []);
    const live = JSON.stringify(s.host.head().domains.npc);
    s.host.store.rebuild();
    assert.equal(JSON.stringify(s.host.head().domains.npc), live, 'rebuild equals live');
});

test('replay: a Re-read of a reply the older code read writes no mood history and keeps no story reason; a first read and a read the new code made do', async () => {
    const { writeMood, reasonKept } = await import('../src/npc-meters-slice.js');
    const { restMood, applyEvents } = await import('../npc-mood.js');
    const prev = restMood({}, 0);
    const mood = applyEvents(prev, 100, [{ kind: 'trust-drop', reason: 'Astra lied' }]);
    const write = ctx => { const record = {}; writeMood(ctx, 'oren', record, { prev, mood, day: 100, n: 4, date: 'Goldwane 1' }); return record; };
    assert.ok(write({}).moodLog, 'a first read writes the history');
    assert.equal(write({ standing: { domains: { npc: { npcs: { oren: { mood: '{}' } } } } } }).moodLog, undefined, 'the earlier read had none: this one has none');
    assert.ok(write({ standing: { domains: { npc: { npcs: { oren: { moodLog: '{"e":[]}' } } } } } }).moodLog, 'the earlier read wrote it: so does this one');
    assert.equal(reasonKept({}, 'oren', 'because'), 'because');
    assert.equal(reasonKept({ standing: { domains: { npc: { npcs: { oren: { lastEvent: '{"at":1,"date":"","events":[]}' } } } } } }, 'oren', 'because'), '', 'the earlier read kept no reason');
    assert.equal(reasonKept({ standing: { domains: { npc: { npcs: { oren: { lastEvent: '{"events":[{"why":"x"}]}' } } } } } }, 'oren', 'because'), 'because');
});

test('notes host: the catch-up (again) gives a mood word kept from before the numbers existed its numbers, once', async () => {
    const s = await suite({ allowance: null, features: { ...ON, 'npc-state-delta.mood-pull': true } });
    await s.setDay(1);
    await s.say(['~ npc Oren | trust: +1']);
    await s.adapter.meet({ name: 'Oren', personality: 'quiet' });
    const slice = () => s.host.head().domains.npc;
    assert.deepEqual([readLeaf(slice().npcs.oren.mood).v, readLeaf(slice().npcs.oren.mood).a], [0, 0], 'at rest, no cause');
    assert.equal((await s.adapter.mood({ name: 'Oren', word: 'wary', again: true })).ok, true);
    assert.deepEqual([readLeaf(slice().npcs.oren.mood).v, readLeaf(slice().npcs.oren.mood).a, readLeaf(slice().npcs.oren.mood).d], [-1, 1, 0]);
    assert.equal((await s.adapter.mood({ name: 'Oren', word: 'wary', again: true })).ok, false, 'the second catch-up finds a mood that already follows a move');
    assert.deepEqual(validateNpcSlice(slice()), []);
});

test('display: a person with a scanner word and the numbers the command wrote shows the scanner\'s word', async () => {
    const { moodTile } = await import('../dossier-ui-view-model.js');
    const { v2MetersProjection } = await import('../dossier-ui-meters.js');
    const view = { mood: { word: 'Alarmed', valence: -2, energy: 2, control: -3, bars: { energy: 5, control: 0, max: 6 }, cause: 'now mortified and flustered', log: [] }, bars: [], secrets: [] };
    const tile = moodTile({ mood: 'Mortified and flustered', v2Meters: v2MetersProjection(view) }, 4);
    assert.equal(tile.text, 'Mortified and flustered');
    assert.deepEqual(tile.rows.map(row => row.value), [-2, 2, -3], 'the three rows hold the numbers');
});

// ---- VADFIX2: numbers from the scan, the widened word list, negation, history keyed by reply id, the entry-less mood ----
// Every mood text the scanner wrote in the live runs of 11-12 Nov (liverun2, liverun3), one per line.
const REAL_MOODS = `quietly relieved
wary and desperate
relieved and winded
bored and mechanical
transactional and shrewd
brisk and dry
wry, guarded, indifferent
withdrawn, anxious, guarded.
cynical and indifferent
quietly cynical, wary of newcomers
furious and fed up
irritable, spiteful, stubborn
gruff, pragmatic
alarmed, hurried
curt, vigilant, indifferent
stressed, urgent
cautious, calculating, watchful.
brisk and impatient
brisk, bureaucratic
flustered and irritable
suspicious and sharp
observant, measured
in shock and agony
indifferent, weary, routine.
suspicious and blunt
dry, businesslike
methodical and pedantic
direct and procedural
stunned and nervous
withdrawn, mildly anxious
terrified and urgent
distrustful and inquisitive
impassive and dry
hurried and self-important
pragmatic and wry
crisp and dismissive
irritated and blunt
indifferent, bureaucratic, dismissive.
impassive and dismissive
brisk, bureaucratic, impatient
furious and mortified by patron ridicule
rattled and contrite
terrified and skittish
irritable and blunt
urgent and hurried
violent and pragmatic
nervous and sore
conspiratorial and hurried
guarded and hurried
startled and aggressive
blunt and skeptical
blunt, dryly amused, practical
pragmatic and dry
businesslike, watchful
suspicious, irritated, blunt
eager and nervous, eyeing the table and taps for ale
gruff and businesslike
brisk and dismissive
dry, guarded, observant
eager and self-important
opportunistic and calculating
hurried and guarded
wary and mistrustful of unearned charity
suspicious, dismissive
stunned, wary, and quietly grateful
businesslike and mildly observant
impressed and businesslike
furious, embarrassed, hostile
anxious and urgent
calculating and discreet
frightened and defensive
defensive, nervous, hostile
terrified of being overheard
terrified and guarded
exasperated and sharp
hostile, vigilant, and aggressive
frantic and urgent
defensive and embarrassed
flustered but rigid
relieved but weary
embarrassed, flustered, irritable
eager, alert for coin or ale
terrified and secretive
frightened, suspicious, overwhelmed by high coin
bewildered and hungry
flustered, caught out
hostile, violent, aggressive
bureaucratic
anxious and fearful of discovery
bewildered and subdued`.split('\n');

test('mood words (real runs): every mood text the scanner really wrote maps to numbers, none is left unread', async () => {
    const { moodFromWord } = await import('../npc-mood.js');
    assert.equal(REAL_MOODS.length, 90);
    const unread = REAL_MOODS.filter(text => !moodFromWord(text));
    assert.deepEqual(unread, [], 'no real mood text is left without numbers');
    assert.deepEqual(moodFromWord('gruff, pragmatic'), { v: -1, a: 1, d: 2, words: ['gruff', 'pragmatic'] }, 'a word the first list missed (Gruff) now reads');
    assert.deepEqual(moodFromWord('Wary and desperate'), { v: -2, a: 2, d: -1, words: ['wary', 'desperate'] });
    assert.ok(moodFromWord('Breathless') && moodFromWord('Impatient') && moodFromWord('curt and bureaucratic'), 'the words the review named');
});

test('mood words: a negated word does not count (not / no longer / never / less / n\'t), only in its own clause', async () => {
    const { moodFromWord } = await import('../npc-mood.js');
    assert.equal(moodFromWord('not angry'), null);
    assert.equal(moodFromWord('never afraid'), null);
    assert.equal(moodFromWord('less angry'), null);
    assert.equal(moodFromWord("isn't angry"), null);
    assert.deepEqual(moodFromWord('calm but not happy')?.words, ['calm']);
    assert.deepEqual(moodFromWord('no longer scared, calm')?.words, ['calm'], 'the clause after the comma stands on its own');
    assert.deepEqual(moodFromWord('not angry, furious')?.words, ['furious']);
    assert.deepEqual(moodFromWord('angry and furious')?.words, ['angry', 'furious'], 'no negator: both count');
});

test('mood numbers the scanner gives: whole numbers clamped to -3..3, all three or none', async () => {
    const { moodNumbers } = await import('../npc-mood.js');
    assert.deepEqual(moodNumbers({ moodV: 2, moodA: '-1', moodD: 0 }), { v: 2, a: -1, d: 0 });
    assert.deepEqual(moodNumbers({ moodV: 9, moodA: -9, moodD: 1.6 }), { v: 3, a: -3, d: 2 }, 'clamped and whole');
    assert.deepEqual(moodNumbers({ v: 1, a: 1, d: -1 }), { v: 1, a: 1, d: -1 }, 'the command\'s own shape');
    assert.equal(moodNumbers({ moodV: 1, moodA: 1 }), null, 'one missing: none');
    assert.equal(moodNumbers({ moodV: 'high', moodA: 1, moodD: 1 }), null);
    assert.equal(moodNumbers(null), null);
    assert.equal(moodNumbers({ moodV: null, moodA: '', moodD: 1 }), null);
});

test('mood history: the same reply is the same record id, a netted-out move drops its row', async () => {
    const { nextMoodLog, readMoodLog } = await import('../npc-mood.js');
    const one = nextMoodLog(null, { n: 4, s: 'r-a', date: 'D1', change: { v: -1, a: 2, d: 0 }, why: 'first' });
    assert.deepEqual(readMoodLog(one).map(row => [row.n, row.s]), [[4, 'r-a']]);
    // the same index but another record id (a delete in the middle shifted the chat): another reply, another row
    const two = nextMoodLog(one, { n: 4, s: 'r-b', date: 'D1', change: { v: 1, a: 0, d: 0 }, why: 'other' });
    assert.deepEqual(readMoodLog(two).map(row => [row.s, row.v]), [['r-b', 1], ['r-a', -1]]);
    // the same record id at another index: the same reply, its moves add
    const three = nextMoodLog(two, { n: 3, s: 'r-b', date: 'D1', change: { v: 1, a: 0, d: 0 }, why: 'again' });
    assert.deepEqual(readMoodLog(three).map(row => [row.s, row.v, row.why]), [['r-b', 2, 'other; again'], ['r-a', -1, 'first']]);
    // a move that cancels the reply's earlier one: the row goes, the older rows stay
    const four = nextMoodLog(two, { n: 4, s: 'r-b', date: 'D1', change: { v: -1, a: 0, d: 0 }, why: 'undo' });
    assert.deepEqual(readMoodLog(four).map(row => row.s), ['r-a'], 'the net-zero reply has no row');
    // no record id on either side: the index decides, as before
    const old = nextMoodLog(null, { n: 7, date: 'D', change: { v: 1, a: 0, d: 0 } });
    assert.equal(readMoodLog(nextMoodLog(old, { n: 7, date: 'D', change: { v: 1, a: 0, d: 0 } }))[0].v, 2);
    assert.equal(nextMoodLog(null, { n: 1, s: 'x', change: { v: 0, a: 0, d: 0 } }), null, 'nothing moved, nothing before: nothing written');
});

test('notes host: npc.mood takes the three numbers the scan gave over the word list, writes the reply id on the history, and an unrated word keeps them', async () => {
    const s = await suite({ allowance: null, features: { ...ON, 'npc-state-delta.mood-pull': true } });
    await s.setDay(1);
    await s.say(['~ npc Oren | trust: +1']);
    const slice = () => s.host.head().domains.npc;
    const head = s.host.store.headIndex();
    // 'Impatient' is on the list too, but the scan's own numbers win
    assert.equal((await s.adapter.mood({ name: 'Oren', word: 'Impatient', vad: { v: 2, a: -2, d: 3 }, reply: head })).ok, true);
    let mood = readLeaf(slice().npcs.oren.mood);
    assert.deepEqual([mood.v, mood.a, mood.d], [2, -2, 3], 'the numbers the scan gave');
    const row = readLeaf(slice().npcs.oren.moodLog).e[0];
    assert.equal(row.n, head);
    assert.equal(typeof row.s, 'string', 'the history names the reply by its record id');
    // an unknown word without numbers: the numbers stay and the reason says so
    await s.adapter.mood({ name: 'Oren', word: 'Zonked', reply: head });
    mood = readLeaf(slice().npcs.oren.mood);
    assert.deepEqual([mood.v, mood.a, mood.d], [2, -2, 3]);
    assert.match(mood.cause, /mood word not rated/);
    assert.deepEqual(validateNpcSlice(slice()), []);
    const live = JSON.stringify(slice());
    s.host.store.rebuild();
    assert.equal(JSON.stringify(slice()), live, 'rebuild equals live');
    // the fallback: no numbers, a known word with a negation
    await s.say(['~ npc Oren | trust: +1']);
    await s.adapter.mood({ name: 'Oren', word: 'not angry, wary', reply: s.host.store.headIndex() });
    mood = readLeaf(slice().npcs.oren.mood);
    assert.deepEqual([mood.v, mood.a, mood.d], [-1, 1, 0], 'only "wary" counts');
});

test('notes host: npc.mood for a person the meeting has not made (it was refused) rests at their temperament, not at 0/0/0', async () => {
    const s = await suite({ allowance: null, features: { ...ON, 'npc-state-delta.mood-pull': true } });
    await s.setDay(1);
    await s.say(['~ npc Oren | trust: +1']);
    const slice = () => s.host.head().domains.npc;
    assert.equal(slice().npcs.pell, undefined);
    assert.equal((await s.adapter.mood({ name: 'Pell', word: 'Zonked', personality: 'cheerful, warm and kind', about: '', reply: s.host.store.headIndex() })).ok, true);
    const mood = readLeaf(slice().npcs.pell.mood);
    assert.deepEqual([mood.v, mood.a, mood.d], [2, 0, 0], 'the mood sits at the resting mood the words give');
    assert.deepEqual(mood.rest, { v: 2, a: 0, d: 0 }, 'so it fades toward the person\'s calm');
    assert.deepEqual(validateNpcSlice(slice()), []);
});

test('a stored taste leaf with "[m2]" citations (valid on main) still validates, displays clean, and a taste write keeps its old rows as stored', () => {
    const leaves = [
        [{ sign: '+', item: 'tea [m2]', day: 1, r: 'r1' }, { sign: '+', item: 'tea [m5]', day: 2, r: 'r2' }],
        [{ sign: '+', item: 'tea', day: 1, r: 'r1' }, { sign: '-', item: 'tea [m5]', day: 2, r: 'r2' }],
        [{ sign: '+', item: '[m2]', day: 1, r: 'r1' }],
    ].map(rows => JSON.stringify(rows));
    for (const leaf of leaves) {
        assert.equal(validateNotes({ tastes: leaf }), '', 'what main accepted stays valid');
        assert.doesNotMatch(JSON.stringify(dossierNotes({ tastes: leaf }).tastes), /\[m\d/, 'shown clean');
    }
    assert.deepEqual(dossierNotes({ tastes: leaves[0] }).tastes.map(row => row.item), ['tea']);
    const out = runKind('taste', leaves[0], { sign: '+', item: 'coffee [m7]' }, { name: 'Oren', day: 3, r: 'r3', notes: { flag() {} } });
    const written = JSON.parse(out.text);
    assert.deepEqual(written.slice(0, 2), JSON.parse(leaves[0]), 'old rows stay byte-identical');
    assert.equal(written[2].item, 'coffee', 'the new row is written clean');
    assert.equal(validateNotes({ tastes: out.text }), '');
});
