import test from 'node:test';
import assert from 'node:assert/strict';
import { developmentScaleReady } from '../core-mechanics.js';

const LIVE_REASON = 'Two-month domestic time jump covering parish schooling, hospice chirurgery, and nameday preparation.';

test('v1.0.21 batch reason grounding accepts direct study/schooling semantic continuity', () => {
    const context = 'In two months, parish study halls and hospice training repeatedly developed her formal cadence for nameday preparation.';
    assert.equal(developmentScaleReady('batch', LIVE_REASON, context), true);
});

test('v1.0.21 batch reason grounding accepts the separated live-style Ryu context', () => {
    const context = [
        "Two months of your mountain wolves did not tame them. One season under Hilde's roof, watching the scribe's desk, suddenly they walk like high-born daughters.",
        'Up close, the changes of the past seventy days were impossible to miss.',
        'Ryu looked up through her pale lashes.',
        "When she spoke, the harsh guttural mountain hiss was entirely gone, replaced by a smooth, measured cadence that carried the gentle lilt of Seren's ledger desk.",
        'In two months, the girls had devoured three years of collegiate arithmetic and natural history, turning afternoon study halls into exhaustive debates on root chemistry.',
        'Their parish studies continued while Sister Althea supervised the hospice work.',
        'The nameday feast marked their formal presentation to the city.',
        'Seren had given them private lessons in posture and ladylike diction over the past month.',
    ].join('\n');
    assert.equal(developmentScaleReady('batch', LIVE_REASON, context), true);
});
