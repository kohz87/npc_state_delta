import test from 'node:test';
import assert from 'node:assert/strict';
import { createNpcRecord, mergeScanResult } from '../core.js';

// Story text that only concerns Bram must never support an update for Malia.
const BRAM_SCENE = '[m1] Bram studies the stranger from the doorway for a long moment before he unbars the door. [m2] Bram dyes his hair crimson and waits in stern silence until the stranger pays.';

function cast() {
    const malia = createNpcRecord('Malia');
    malia.present = true;
    malia.personality = 'Cheerful and chatty.';
    malia.behaviorProfile = ['Disposition: warm - welcoming to every guest'];
    const bram = createNpcRecord('Bram');
    bram.present = true;
    return [malia, bram];
}

function scanMalia(update, context = BRAM_SCENE, npcs = cast()) {
    const result = mergeScanResult({ npcs, turn: 5 }, {
        npcs: [],
        profileUpdates: [{ id: npcs[0].id, name: 'Malia', ...update }, { id: npcs[1].id, name: 'Bram', personalityState: 'keep' }],
    }, { developmentContext: context, sourceMessageId: 2, turn: 5 });
    return result.state.npcs.find(npc => npc.name === 'Malia');
}

test('another NPC\'s scene cannot ground a new Behavioral Lever', () => {
    const lever = 'Threat Sensitivity: high - studies strangers from the doorway before unbarring the door';
    const refined = scanMalia({ behaviorProfileState: 'refine', behaviorProfile: ['Disposition: warm - welcoming to every guest', lever] });
    assert.deepEqual(refined.behaviorProfile, ['Disposition: warm - welcoming to every guest']);

    const npcs = cast();
    npcs[0].behaviorProfile = [];
    const seeded = scanMalia({ behaviorProfileState: 'refine', behaviorProfile: [lever] }, BRAM_SCENE, npcs);
    assert.deepEqual(seeded.behaviorProfile, [], 'first-profile seeding is scoped to the NPC as well');
});

test('another NPC\'s scene cannot ground a Personality refinement', () => {
    const malia = scanMalia({ personalityState: 'refine', personality: 'Cheerful and chatty; stern and silent with strangers until they pay.' });
    assert.equal(malia.personality, 'Cheerful and chatty.');
});

test('another NPC\'s scene cannot ground an overall appearance change; the NPC\'s own scene still can', () => {
    const npcs = cast();
    npcs[0].appearanceModelVersion = 1;
    npcs[0].overallAppearance = 'Long brown hair and green eyes.';
    const update = {
        overallAppearance: 'Crimson hair and green eyes.',
        overallAppearanceState: 'change',
        overallAppearanceReason: 'dyed her hair crimson',
    };
    const leaked = scanMalia(update, BRAM_SCENE, npcs);
    assert.equal(leaked.overallAppearance, 'Long brown hair and green eyes.');

    const own = scanMalia(update, '[m1] Malia dyes her hair crimson before the festival.', cast().map((npc, index) => index === 0
        ? { ...npc, appearanceModelVersion: 1, overallAppearance: 'Long brown hair and green eyes.' }
        : npc));
    assert.equal(own.overallAppearance, 'Crimson hair and green eyes.');
});

test('the NPC\'s own scene still grounds a new lever', () => {
    const malia = scanMalia({
        behaviorProfileState: 'refine',
        behaviorProfile: ['Disposition: warm - welcoming to every guest', 'Threat Sensitivity: high - studies strangers from the doorway before unbarring the door'],
    }, '[m1] Malia studies the stranger from the doorway for a long moment before she unbars the door.');
    assert.ok(malia.behaviorProfile.some(entry => /^Threat Sensitivity:/.test(entry)), JSON.stringify(malia.behaviorProfile));
});

test('structured updates without narration keep direct refinement', () => {
    const npcs = cast();
    const result = mergeScanResult({ npcs, turn: 5 }, { npcs: [], profileUpdates: [{
        id: npcs[0].id, name: 'Malia', personalityState: 'refine', personality: 'Cheerful, chatty and quick to laugh.',
    }] }, { turn: 5 });
    assert.equal(result.state.npcs.find(npc => npc.name === 'Malia').personality, 'Cheerful, chatty and quick to laugh.');
});
