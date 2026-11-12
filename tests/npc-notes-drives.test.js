// NPC notes, drives (src/npc-notes-drives.js): the stored strength leaf (readDrives, setDrives), the first-time seed from a cast
// pack entry or the first description (seedDrives), the strength multiplier the pull applies (applyStrength, scaledInst) and the
// dossier rows (driveRows). Pure functions only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DRIVES, DRIVE_DEFAULT, DRIVE_RULE, growDrives, parseLever, driveEvidence, DRIVES_TEXT_MAX, readDrives, setDrives, seedDrives, strengthMultiplier, applyStrength, scaledInst, driveRows,
} from '../src/npc-notes-drives.js';

const allDefault = () => Object.fromEntries(DRIVES.map(drive => [drive.key, DRIVE_DEFAULT]));

test('DRIVES: seven drives in a fixed order, the first three keyed like the mood-pull instincts', () => {
    assert.deepEqual(DRIVES.map(drive => drive.kind), ['belonging', 'closure', 'awe', 'preservation', 'comfort', 'conflict', 'honesty']);
    assert.deepEqual(DRIVES.slice(0, 3).map(drive => drive.key), ['belo', 'clos', 'awe']);
    assert.equal(DRIVE_DEFAULT, 2);
});

test('readDrives: absent leaf reads as the defaults; a partial object fills the rest with defaults', () => {
    assert.deepEqual(readDrives(undefined), allDefault());
    assert.deepEqual(readDrives(null), allDefault());
    assert.deepEqual(readDrives(''), allDefault());
    assert.deepEqual(readDrives('{"belo":3}'), { ...allDefault(), belo: 3 });
    assert.deepEqual(readDrives('{}'), allDefault());
});

test('readDrives: malformed, unknown, out-of-range or over-long leaves read as null', () => {
    assert.equal(readDrives('not json'), null);
    assert.equal(readDrives('[]'), null);
    assert.equal(readDrives('"belo"'), null);
    assert.equal(readDrives('{"belo":4}'), null);
    assert.equal(readDrives('{"belo":-1}'), null);
    assert.equal(readDrives('{"belo":1.5}'), null);
    assert.equal(readDrives('{"belo":"2"}'), null);
    assert.equal(readDrives('{"love":2}'), null);
    assert.equal(readDrives('{"belo":2,"love":2}'), null);
    assert.equal(readDrives(42), null);
    assert.equal(readDrives(`{"belo":${'1'.repeat(DRIVES_TEXT_MAX)}}`), null);
});

test('setDrives: writes the merged object in fixed key order, whatever order the changes arrive in', () => {
    const one = setDrives(undefined, { hone: 0, belo: 3 });
    const two = setDrives(undefined, { belo: 3, hone: 0 });
    assert.equal(one, two);
    assert.deepEqual(readDrives(one), { ...allDefault(), belo: 3, hone: 0 });
    assert.equal(one, JSON.stringify(Object.fromEntries(DRIVES.map(drive => [drive.key, readDrives(one)[drive.key]]))));
});

test('setDrives: a later write keeps the stored values and does not reseed', () => {
    const stored = setDrives(undefined, { belo: 1 });
    const again = setDrives(stored, { clos: 3 }, { pack: { drives: { honesty: 3 } } });
    assert.deepEqual(readDrives(again), { ...allDefault(), belo: 1, clos: 3 });
});

test('setDrives: rejects unknown keys, non-strengths, a non-object change and an unusable stored leaf', () => {
    assert.equal(setDrives(undefined, { love: 2 }), null);
    assert.equal(setDrives(undefined, { belo: 4 }), null);
    assert.equal(setDrives(undefined, { belo: 2.5 }), null);
    assert.equal(setDrives(undefined, { belo: 2, clos: 'x' }), null);
    assert.equal(setDrives(undefined, null), null);
    assert.equal(setDrives(undefined, ['belo']), null);
    assert.equal(setDrives('not json', { belo: 1 }), null);
});

test('seedDrives: a cast pack object wins, by kind name or short key', () => {
    assert.deepEqual(seedDrives({ drives: { belonging: 3, clos: 0 } }), { ...allDefault(), belo: 3, clos: 0 });
    assert.deepEqual(seedDrives({ drives: { honesty: 1 } }), { ...allDefault(), hone: 1 });
});

test('seedDrives: a pack list of kind names marks those drives high and the rest default', () => {
    assert.deepEqual(seedDrives({ drives: ['Awe', 'comfort', 'unknown'] }), { ...allDefault(), awe: 3, comf: 3 });
    assert.deepEqual(seedDrives({ drives: ['awe'] }), { ...allDefault(), awe: 3 });
});

test('seedDrives: with no usable pack drives, the first description is scanned for drive words', () => {
    const seeded = seedDrives({}, 'She is honest and frank with everyone and wants to protect and guard the village.');
    assert.deepEqual(seeded, { ...allDefault(), hone: 3, pres: 3 });
    assert.deepEqual(seedDrives(null, 'A quiet cook.'), allDefault());
    assert.deepEqual(seedDrives(undefined, undefined), allDefault());
});

test('seedDrives: a pack object with strengths does not also read the description', () => {
    assert.deepEqual(seedDrives({ drives: { belonging: 1 } }, 'Honest and frank to a fault.'), { ...allDefault(), belo: 1 });
});

test('seedDrives: short words only match whole tokens (kin does not match kingdom)', () => {
    assert.deepEqual(seedDrives({}, 'From the kingdom of the east.'), allDefault());
});

test('setDrives: a first write uses the seed; with no leaf and no seed it is the defaults plus the change', () => {
    const seeded = setDrives(undefined, {}, { pack: { drives: { comfort: 3 } } });
    assert.deepEqual(readDrives(seeded), { ...allDefault(), comf: 3 });
    assert.deepEqual(readDrives(setDrives(undefined, { awe: 0 })), { ...allDefault(), awe: 0 });
});

test('strengthMultiplier: 0 mutes, 2 is one, other strengths step by a half', () => {
    assert.equal(strengthMultiplier(0), 0);
    assert.equal(strengthMultiplier(1), 0.5);
    assert.equal(strengthMultiplier(2), 1);
    assert.equal(strengthMultiplier(3), 1.5);
    assert.equal(strengthMultiplier(9), 1);
    assert.equal(strengthMultiplier(undefined), 1);
});

test('applyStrength: scores scale and stay in 0..3; default strength leaves a score as it is', () => {
    assert.equal(applyStrength(0, 3), 0);
    assert.equal(applyStrength(3, 0), 0);
    assert.equal(applyStrength(2, DRIVE_DEFAULT), 2);
    assert.equal(applyStrength(3, 1), 2);
    assert.equal(applyStrength(2, 1), 1);
    assert.equal(applyStrength(2, 3), 3);
    assert.equal(applyStrength(3, 3), 3);
    assert.equal(applyStrength(NaN, 2), 0);
    assert.equal(applyStrength(3, undefined), 3);
});

test('scaledInst: each instinct is scaled by its drive, unknown keys dropped, missing drives default', () => {
    const drives = { ...allDefault(), belo: 0, clos: 3 };
    assert.deepEqual(scaledInst({ belo: 3, clos: 1, awe: 2, love: 3 }, drives), { belo: 0, clos: 2, awe: 2 });
    assert.deepEqual(scaledInst({ belo: 3, awe: 1 }, null), { belo: 3, awe: 1 });
    assert.deepEqual(scaledInst(null, drives), {});
});

test('driveRows: seven rows in fixed order with labels and words; defaults read normal', () => {
    const rows = driveRows(null);
    assert.equal(rows.length, 7);
    assert.deepEqual(rows.map(row => row.label), ['Belonging', 'Closure', 'Awe', 'Preservation', 'Comfort', 'Conflict', 'Honesty']);
    assert.ok(rows.every(row => row.strength === 2 && row.word === 'normal'));
});

test('driveRows: strengths map to off, low, normal and high', () => {
    const rows = driveRows({ ...allDefault(), belo: 0, clos: 1, awe: 3 });
    assert.deepEqual(rows.slice(0, 3).map(row => row.word), ['off', 'low', 'high']);
    assert.deepEqual(rows.slice(0, 3).map(row => row.strength), [0, 1, 3]);
});

test('seeding: ONE cue word keeps a drive normal, TWO DIFFERENT cue words start it high, a repeated word is still one, the pack wins', () => {
    assert.deepEqual(seedDrives({}, 'A friend to all, quiet and plain.'), allDefault(), 'one cue: normal');
    assert.deepEqual(seedDrives({}, 'Friend, friend, friend.'), allDefault(), 'the same word three times is one cue');
    assert.deepEqual(seedDrives({}, 'A loyal friend who misses her family.'), { ...allDefault(), belo: 3 }, 'two different cues: high');
    assert.deepEqual(seedDrives({ drives: { honesty: 0 } }, 'A loyal friend who misses her family.'), { ...allDefault(), hone: 0 }, 'pack wins');
    assert.deepEqual(seedDrives({ drives: ['comfort'] }, 'A loyal friend who misses her family.'), { ...allDefault(), comf: 3 }, 'a pack list wins too');
});

test('driveRows: a note says where a non-normal drive came from (pack, description, growth); normal shows none', () => {
    const fromPack = setDrives(undefined, {}, { pack: { drives: { honesty: 3, belonging: 1 } } });
    const rows = driveRows(readDrives(fromPack), fromPack);
    assert.equal(rows.find(row => row.key === 'hone').note, 'set by the pack');
    assert.equal(rows.find(row => row.key === 'belo').note, 'set by the pack');
    assert.equal(rows.find(row => row.key === 'awe').note, '', 'normal: no note');
    const fromText = setDrives(undefined, {}, { description: 'protect and guard' });
    assert.equal(driveRows(readDrives(fromText), fromText).find(row => row.key === 'pres').note, 'from their description');
    const grew = growTwice('a new friend', 'family came to visit');
    assert.match(driveRows(readDrives(grew), grew).find(row => row.key === 'belo').note, /^grew over 2 story moments/);
    assert.equal(driveRows(readDrives(setDrives(undefined, {}, {})), undefined).every(row => row.note === ''), true);
    const set = setDrives(fromPack, { hone: 2 });
    assert.equal(driveRows(readDrives(set), set).find(row => row.key === 'hone').note, '');
});

function growTwice(a, b, leaf) {
    const one = growDrives(leaf, [a], 'r1');
    return growDrives(one.leaf, [b], 'r2').leaf;
}

test('growth: a cue in ONE reply only remembers it; the same drive in a SECOND, different reply steps it one level', () => {
    const first = growDrives(undefined, ['She made a new friend'], 'r1');
    assert.deepEqual(readDrives(first.leaf), allDefault(), 'no step yet');
    assert.deepEqual(first.steps, []);
    assert.equal(growDrives(first.leaf, ['another friend'], 'r1'), null, 'the same reply again counts once');
    const second = growDrives(first.leaf, ['her family wrote'], 'r2');
    assert.equal(readDrives(second.leaf).belo, 3);
    assert.deepEqual(second.steps.map(step => [step.key, step.from, step.to]), [['belo', 2, 3]]);
    assert.equal(growDrives(second.leaf, ['yet another friend'], 'r3'), null, 'max 3: nothing more');
});

test('growth: opposite cues step a drive down, never below 0, and a cue the other way restarts the count', () => {
    const down = growTwice('she stays alone', 'an aloof loner');
    assert.equal(readDrives(down).belo, 1);
    assert.match(driveRows(readDrives(down), down).find(row => row.key === 'belo').note, /^eased over 2 story moments/);
    const lower = growTwice('alone again', 'distant as ever', down);
    assert.equal(readDrives(lower).belo, 0);
    assert.equal(growDrives(lower, ['alone'], 'r9'), null, 'min 0');
    const mixed = growDrives(growDrives(undefined, ['a friend'], 'r1').leaf, ['she is alone'], 'r2');
    assert.equal(readDrives(mixed.leaf).belo, 2, 'an opposite cue replaces the pending one');
    assert.equal(readDrives(growDrives(mixed.leaf, ['alone again'], 'r3').leaf).belo, 1);
});

test('growth: cues both ways in one reply, or none, count for nothing; one step per drive per reply; other drives are independent', () => {
    assert.equal(growDrives(undefined, ['a friend, but alone'], 'r1'), null);
    assert.equal(growDrives(undefined, ['nothing of note'], 'r1'), null);
    const a = growDrives(undefined, ['a friend, honest and frank, wants to protect'], 'r1');
    const b = growDrives(a.leaf, ['friend', 'family', 'kin'], 'r2');
    assert.deepEqual(b.steps.map(step => step.key), ['belo'], 'only the drive whose cues showed again');
    assert.equal(readDrives(b.leaf).belo, 3);
    assert.equal(readDrives(b.leaf).hone, 2);
});

test('growth: only a usable leaf and a reply id are accepted; the stored leaf stays valid and short', () => {
    assert.equal(growDrives('not json', ['friend'], 'r1'), null);
    assert.equal(growDrives(undefined, ['friend'], null), null);
    const full = DRIVES.reduce((leaf, drive) => growDrives(leaf, [drive.words[0]], 'r1')?.leaf ?? leaf, undefined);
    assert.notEqual(readDrives(full), null);
    assert.ok(full.length <= DRIVES_TEXT_MAX);
    assert.equal(DRIVE_RULE, 1);
});

test('driveEvidence: only what is new (memories, behavior, mannerisms, the changed reason)', () => {
    const before = { memories: ['old'], behaviorProfile: [], lastRelationshipChange: { reason: 'same' } };
    const after = { memories: ['old', { text: 'met a friend' }], behaviorProfile: ['keeps apart'], mannerisms: ['hums'], lastRelationshipChange: { reason: 'same' } };
    assert.deepEqual(driveEvidence(before, after), ['met a friend', 'keeps apart', 'hums']);
    assert.deepEqual(driveEvidence(after, after), []);
    assert.deepEqual(driveEvidence(undefined, { lastRelationshipChange: { reason: 'shared a meal' } }), ['shared a meal']);
});

test('negation: evidence that says a drive is weak never raises it, for every drive', () => {
    const twice = (a, b) => growDrives(growDrives(undefined, [a], 'r1')?.leaf, [b], 'r2');
    const liar = readDrives(twice('Honesty: low - lies to cover for her brother', 'Honesty: low - lies again').leaf);
    assert.equal(liar.hone, 1, 'a low Honesty lever lowers Honesty');
    assert.equal(readDrives(twice('Honesty: high - tells the truth', 'Honesty: high - speaks frankly').leaf).hone, 3);
    assert.equal(twice('Honesty: moderate - hedges', 'Honesty: moderate - hedges again'), null, 'a middle level counts for nothing');
    const cases = { belo: 'has no family and no friend', clos: 'never feels closure, no unresolved debt', awe: 'no wonder, not curious', pres: 'does not protect, will not defend', comf: 'no rest, never cozy', conf: 'no feud, no rival', hone: 'not honest, never candid' };
    for (const drive of DRIVES) {
        const text = cases[drive.key];
        const result = twice(text, `${text} again`);
        const after = result ? readDrives(result.leaf)[drive.key] : 2;
        assert.ok(after <= 2, `${drive.label}: "${text}" never raises it`);
    }
    assert.equal(readDrives(twice('dishonest and a liar', 'a dishonest man').leaf).hone, 1, 'dishonest counts down');
    assert.match(growDrives(undefined, ['not honest, no truth'], 'r1').leaf, /"e":"d:r1"/, 'negated cues count toward the opposite direction, never up');
    assert.equal(seedDrives(undefined, 'not honest and no truth at all')[DRIVES[6].key], 2, 'seeding reads negation too');
    assert.equal(seedDrives(undefined, 'honest and frank')[DRIVES[6].key], 3);
});

test('growth: a cue only in the NPC\'s name or role text is no evidence; a negator does not reach across lines', () => {
    const a = growDrives(undefined, ['Guard Rilke stood'], 'r1', 'Rilke Guard');
    assert.equal(a, null, 'guard is the role');
    const b = growDrives(undefined, ['she will protect Rilke'], 'r1', 'Rilke Guard');
    assert.ok(b, 'protect is not the role');
    assert.equal(readDrives(growDrives(b.leaf, ['a shield for the village'], 'r2', 'Rilke Guard').leaf).pres, 3);
    const lines = growDrives(growDrives(undefined, ['no luck', 'a friend'], 'r1').leaf, ['her family', 'not at all'], 'r2');
    assert.equal(readDrives(lines.leaf).belo, 3, 'a negator on one line leaves the next line\'s cue alone');
});

test('leaf size: the worst leaf the caps allow still reads (the limit holds it)', () => {
    const x = Object.fromEntries(DRIVES.map(drive => [drive.key, { s: 'u', n: 999, c: 'c'.repeat(24), e: `u:${'r'.repeat(40)}`.slice(0, 42) }]));
    const leaf = JSON.stringify({ ...Object.fromEntries(DRIVES.map(drive => [drive.key, 3])), x });
    assert.ok(leaf.length <= DRIVES_TEXT_MAX, `${leaf.length} characters`);
    assert.notEqual(readDrives(leaf), null);
});

// Every distinct "Label: level - text" lever string found in the stored live runs (one per label and level; texts cut to 80 characters).
// The first list names a drive; the expected [key, direction] is from the level alone (high up, low or none down, anything else null).
const REAL_DRIVE_LEVERS = [
    ["Conflict: aggressive - snaps orders and lashes beasts with the crop when under p", null],
    ["Conflict: direct - curses his mule with wheezing spite and issues blunt instruct", null],
    ["Conflict: avoid - warns nosy strangers to leave before patrols notice them", null],
    ["Honesty: high - bluntly deflates compliments about her plain food", ['hone', 'u']],
    ["Conflict: blunt - cuts through polite small talk with immediate, direct accusati", null],
    ["Conflict: low - Snaps at couriers and loiterers from behind the wire grating but", ['conf', 'd']],
    ["Honesty: blunt - warns strangers plainly about vouchers and market closures whil", null],
    ["Honesty: strict - Enforces intake fees and official protocols before providing s", null],
    ["Conflict: rigid - halts inquiries until required guild fees or warrants are sett", null],
    ["Honesty: low - peddles loose gate rumors and fabrications to extract coins or dr", ['hone', 'd']],
    ["Conflict: high - sprang up from dirty blankets and leveled a rusted billhook to ", ['conf', 'u']],
    ["Honesty: straightforward - bluntly warns travelers of dangerous road hazards and", null],
    ["Conflict: pragmatic - Advises readiness without seeking unnecessary trouble.", null],
    ["Conflict: unyielding - Risks drowning wheels in swollen fords rather than submit", null],
    ["Honesty: fair - Pays two copper bits for hard physical help hauling his cart fre", null],
    ["Honesty: candid - Readily shares rumors about empty watchposts and nightly cart ", null],
    ["Honesty: medium - trades genuine civic intelligence, but only for coin, trade, o", null],
    ["Conflict: passive - enforces rules through curt bureaucratic denial rather than ", null],
    ["Conflict: active - cracks iron kitchen tools against wood to quiet the taproom a", null],
    ["Conflict: guarded - Wouter swung the flat of his blade against the coaming to dr", null],
    ["Honesty: direct - Demands exact tolls and clearance stamps before granting any s", null],
    ["Conflict: explosive - snaps into screeching reprimands the moment a customer sta", null],
];
const REAL_OTHER_LEVERS = [
    "Last Gains: none - opening scene",
    "Label: level - effect",
    "Loyalty: moderate - maintains the Bluewatch post despite months of unpaid wages ",
    "Care: moderate - prioritizes the safety and order of the border settlement again",
    "Mercy: high - she stitches gently and takes her time, even with people who don't",
    "Care: high - she is fiercely protective of the dead",
    "Loyalty: high - she is warm and steady once someone matters to her",
    "Independence: high - she fears being used",
    "Expression: low - she speaks little, and her care shows in what she does",
    "Presentation: low - a seductive air she doesn't mean; stares mortify her and she",
    "Threat: firm - grits through cold water and physical strain to salvage his axle",
    "Analytical: medium - sizes up travelers' origin and armaments immediately upon a",
    "Presentation: curt - Processes arrivals mechanically and provides blunt directio",
    "Analytical: observant - Scans traveler equipment, mount branding, and regional a",
    "Disposition: curt - Assesses entrants flatly and issues tolls without ceremony.",
    "Analytical: level - Identifies origins by speech and clothing cut immediately.",
    "Presentation: plain - Directs strangers to practical city lodgings based on thei",
    "Threat: Low - Deflects risks by snapping warnings and demanding a transaction or",
    "Presentation: strict - Enforces intake fees and rank prerequisites before granti",
    "Presentation: guarded - keeps his focus sharp and wary, assessing newcomers' wea",
    "Pragmatism: high - Serves plain fare bluntly and dismisses travelers' compliment",
    "Disposition: suspicious - treats unsolicited compliments as a front for unpaid b",
    "Rigidity: high - Strictly enforces intake wicket boundaries against wanderers an",
    "Threat: aggressive - Rises immediately with weapon in hand and calls out intrude",
    "Duty: high - Manages Bluewatch defenses despite garrison shortages and logistica",
    "Care: cautious - measures out goods and words with deliberate restraint under pa",
    "Disposition: indifferent - unhurriedly directs entrants to standard registration",
    "Threat: high - Draws a notched cleaver and issues lethal ultimatums the moment a",
    "Disposition: weary - mutters cynical assessments of road conditions while casual",
    "Care: watchful - warns departing riders of seasonal hazards, wolves, and marcher",
    "Care: low - casually pares turnips and spits into drainage ditches while travele",
    "Disposition: guarded - warns travelers to keep coin hidden and look out for beas",
    "Drive: dutiful - levers open the heavy ash gate barrier despite complaining of c",
    "Analytical: moderate - Observes potential customers, mounts, and gear before spe",
    "Analytical: high - Carefully assesses arms, clothing, and travel marks before co",
    "Threat: cautious - keeps careful watch over palisade gates and warns travelers o",
    "Expression: high - repeats exaggerated rumors and gossip as absolute fact to see",
    "Drive: moderate - Immediately pitches wares to anyone sharing camp to secure cop",
    "Presentation: high - Loudly hawks cheap tallow and wares the instant he encounte",
    "Presentation: moderate - Maintains rigid decorum behind the registry counter",
    "Threat: watchful - sizes up mounts, weapons, and traveler gear immediately upon ",
    "Threat: direct - warns travelers plainly about greedy levies and scrappers down ",
    "Care: guarded - warns travelers of predatory tolls while remaining wary of fine ",
    "Drive: greedy - Ambush travelers specifically to plunder valuable mounts.",
    "Disposition: reserved - Handles gate traffic efficiently with pragmatic advice [",
    "Presentation: modest - Checks newcomers methodically while maintaining the gate'",
    "Disposition: neutral - Directs travelers pragmatically without unnecessary hosti",
    "Presentation: blunt - Answers queries without fuss but immediately guards her st",
    "Presentation: direct - delivers practical guidance and district realities withou",
    "Threat: avoidant - flees unnatural omens and hastens to fortified settlements [m",
    "Disposition: open - reaches out a welcoming hand to thank strangers who offer ai",
    "Threat: observant - measures newcomers' weapons and mounts while noting down the",
    "Drive: high - leverages local gossip and market trade to stay ahead of city seiz",
    "Disposition: cynical - assumes sweet words conceal bad intent or a leaking purse",
    "Threat: medium - tracks armed city patrols and authority figures silently until ",
    "Presentation: rigid - enforces guild admission rules and fee requirements withou",
    "Presentation: practical - Quotes strict rates for food and lodging without givin",
    "Disposition: gruff - brushes aside compliments and demands unvarnished transacti",
    "Threat: vigilant - monitors town guard interest and secures her premises against",
    "Drive: opportunistic - feeds exaggerated rumors to out-of-towners to angle for e",
    "Disposition: blunt - answers plain questions with raw practical facts of the riv",
    "Drive: working - focuses on chocking crates and hauling freight despite interrup",
    "Drive: medium - Balances garrison shortages against impending regional threats.",
    "Disposition: brusque - sets plain, non-negotiable terms and points out river obs",
    "Disposition: pragmatic - Answers travelers bluntly while continuing manual wharf",
    "Analytical: observational - Keeps track of river depths, alternate routes, and g",
    "Expression: neutral - Explains local river routes and military requisitions plai",
    "Analytical: pragmatic - keeps an eye on imperial or military risks like town wat",
    "Analytical: cautious - stays alert to local authorities and impending vessel sei",
    "Mercy: low - refuses deck space or ship provisions without upfront coin in hand",
    "Disposition: hostile - Shoves past locals and barks brusque instructions to newc",
    "Presentation: brisk - monitors cargo loading with tally slate and dismisses idle",
    "Disposition: low - Spits into the slip gap and dismissively directs inquiries to",
    "Care: pragmatic - Prioritizes keeping her garrison intact and dealing with logis",
    "Duty: committed - Manages administrative neglect and late pay ahead of regional ",
    "Disposition: sour - Snaps blunt directions and spits into the water rather than ",
    "Expression: blunt - gives direct, unvarnished river directions without pleasantr",
    "Drive: steady - continues hammering oakum and caulking without dropping his tool",
    "Presentation: bold - shouts out hawking calls directly beside potential customer",
    "Presentation: boisterous - clangs kitchen iron and bellows dockside threats to d",
    "Disposition: abrasive - snorts at polite requests and serves bitter alternatives",
    "Drive: relentless - pushes sales over other workers' shouting and workspace boun",
];

const leverResult = text => {
    const lever = parseLever(text);
    if (!lever) return 'prose';
    const found = growDrives(growDrives(undefined, [text], 'r1')?.leaf, [text], 'r2');
    if (!found) return null;
    const after = readDrives(found.leaf);
    const moved = DRIVES.find(drive => after[drive.key] !== DRIVE_DEFAULT);
    return moved ? [moved.key, after[moved.key] > DRIVE_DEFAULT ? 'u' : 'd'] : null;
};

test('levers: every real drive lever from the runs counts by its level alone', () => {
    for (const [text, expected] of REAL_DRIVE_LEVERS) assert.deepEqual(leverResult(text), expected, text);
});

test('levers: every real lever with another label (Care, Threat, Disposition ...) counts for nothing, whatever its text says', () => {
    for (const text of REAL_OTHER_LEVERS) assert.equal(leverResult(text), null, text);
});

test('levers: combined, bracketed and synonym labels use the level, never the label or the text as a cue', () => {
    for (const text of ['Honesty/Candor: low - conceals local barrow issues', 'Honesty/Candor: guarded - holds back', 'Honesty/Candor: transactional - trades facts',
        'Honesty (strangers): low - lies to outsiders', 'Honesty & Loyalty: low - sells out anyone', 'Candor: low - evasive', 'Secrecy: high - hides the truth', 'Deception: high - honest-looking lies', 'Sincerity: medium - truth for coin']) {
        const twice = growDrives(growDrives(undefined, [text], 'r1')?.leaf, [text], 'r2');
        const after = twice ? readDrives(twice.leaf).hone : 2;
        assert.ok(after <= 2, `${text} never raises Honesty (${after})`);
    }
    assert.equal(leverResult('Honesty/Candor: low - conceals things')[1], 'd');
    assert.equal(leverResult('Honesty/Candor: high - speaks plainly')[1], 'u');
    assert.equal(leverResult('Honesty (strangers): low - lies')[1], 'd');
    assert.equal(leverResult('Secrecy: high - hides the truth')[1], 'd', 'a high Secrecy lever lowers Honesty');
    assert.equal(leverResult('Secrecy: low - open about it'), null, 'a low Secrecy lever counts for nothing');
    assert.deepEqual(leverResult('Honesty: high, candid and frank'), ['hone', 'u'], 'a level followed by a comma is read too');
    assert.equal(parseLever('she lied to him: and ran'), null, 'prose with a colon is not a lever');
    assert.deepEqual(parseLever('Honesty/Candor (to kin): very low - hides it').parts, ['honesty', 'candor', 'to kin']);
});

test('levers: a drive-labelled line without a parsed level counts for nothing and never reaches the cue words', () => {
    const LEVELLESS = ['Honesty: Conceals the truth from strangers', 'Honesty: 1/5 - Conceals the truth', 'Honesty (with strangers only): lies to every stranger',
        'Honesty / Candor (with strangers): lies', '**Honesty:** Conceals the truth from strangers', 'Conflict: avoids every fight and quarrel',
        'Conflict/Assertiveness: Commands firm authority over every fight', 'Honesty: Conceals the truth, always honest about nothing'];
    for (const text of LEVELLESS) {
        assert.ok(parseLever(text), `${text} is a lever line`);
        assert.equal(leverResult(text), null, text);
        const twice = growDrives(growDrives(undefined, [text, text], 'r1')?.leaf, [text], 'r2');
        assert.equal(twice, null, `${text} leaves the drives untouched`);
    }
    assert.deepEqual(leverResult('Honesty: low. Conceals the truth'), ['hone', 'd'], 'a period ends the level');
    assert.deepEqual(leverResult('**Honesty:** high - speaks plainly'), ['hone', 'u'], 'markdown around the label is ignored');
    assert.deepEqual(leverResult('Honesty (with strangers only): low - lies'), ['hone', 'd'], 'a long label still parses its level');
});

test('levers: cue words still read free prose, with negation', () => {
    const twice = (a, b) => readDrives(growDrives(growDrives(undefined, [a], 'r1').leaf, [b], 'r2').leaf);
    assert.equal(twice('she lied to the guard', 'a liar again').hone, 1);
    assert.equal(twice('a friend of the family', 'her family again').belo, 3);
});
