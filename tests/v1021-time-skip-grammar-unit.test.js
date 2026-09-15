import test from 'node:test';
import assert from 'node:assert/strict';
import { developmentScaleReady } from '../core-mechanics.js';

const REASON = 'Sustained academy training and repeated practice developed a polished formal cadence.';

for (const [label, context] of [
    ['past quantified days', 'Across the past seventy days of academy training, repeated practice developed a polished formal cadence.'],
    ['in quantified months', 'In two months of academy training, repeated practice developed a polished formal cadence.'],
    ['in quantified months before a comma', 'In two months, sustained academy training and repeated practice developed a polished formal cadence.'],
    ['bare season with residence context', "One season under Hilde's roof included sustained academy training and repeated practice that developed a polished formal cadence."],
    ['over the past month', 'Over the past month, sustained academy training and repeated practice developed a polished formal cadence.'],
    ['for quantified months', 'For two months, sustained academy training and repeated practice developed a polished formal cadence.'],
    ['ordinary years', 'Over three years of academy training, repeated practice developed a polished formal cadence.'],
]) {
    test(`v1.0.21 batch duration grammar recognizes ${label}`, () => {
        assert.equal(developmentScaleReady('batch', REASON, context), true);
    });
}

test('v1.0.21 development reason aliases match across schooling/study and training/practice wording', () => {
    const reason = 'Schooling and training continued across the interval.';
    const context = 'In two months, repeated study and practice became routine.';
    assert.equal(developmentScaleReady('batch', reason, context), true);
});

test('v1.0.21 an age statement is not treated as elapsed development', () => {
    const context = 'Marris is thirteen years of age. Today she practiced one formal greeting at the academy.';
    assert.equal(developmentScaleReady('batch', REASON, context), false);
});

test('v1.0.21 unrelated elapsed time cannot borrow a one-off present action as sustained development', () => {
    const context = 'For two months the valley weather changed every day. Today Marris gave one polished greeting at the academy.';
    assert.equal(developmentScaleReady('batch', REASON, context), false);
});
