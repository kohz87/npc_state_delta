import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as branch from '../branch.js';
import * as branchCore from '../branch-core.js';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const modules = JSON.parse(read('runtime-modules.json')).modules.map(module => module.path);
const sources = Object.fromEntries(modules.map(path => [path, read(path)]));
const all = Object.values(sources).join('\n');

// The text of a top-level function, from its declaration to the matching closing brace.
function functionText(source, name) {
    const start = source.search(new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`, 'm'));
    if (start < 0) return null;
    const end = source.indexOf('\n}', start);
    return source.slice(start, end + 2).replace(/^export\s+/, '').replace(/\s+/g, ' ');
}

test('1: a module never keeps a copy of a function it re-exports, and the branch keys come from one place', () => {
    const problems = [];
    for (const [path, source] of Object.entries(sources)) {
        for (const match of source.matchAll(/^export \* from '\.\/([^']+)';$/gm)) {
            const reexported = sources[match[1]];
            for (const own of source.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)) {
                const theirs = functionText(reexported, own[1]);
                if (theirs && theirs === functionText(source, own[1])) problems.push(`${path}: ${own[1]} copies ${match[1]}`);
            }
        }
    }
    assert.deepEqual(problems, []);
    assert.equal('lineageCheckpointKeys' in branchCore, false);
    const keys = branch.lineageCheckpointKeys(['a', 'b']);
    assert.equal(keys.length, 2);
    assert.equal(branch.lineageCheckpointKey(['a', 'b'], 1), keys[1]);
});

test('2: no top-level constant in a shipped module goes unused', () => {
    const problems = [];
    for (const [path, source] of Object.entries(sources)) {
        for (const match of source.matchAll(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=/gm)) {
            if ((all.match(new RegExp(`\\b${match[1]}\\b`, 'g')) || []).length <= 1) problems.push(`${path}: ${match[1]} is never used`);
        }
    }
    assert.deepEqual(problems, []);
});

test('3: every extension class in style.css is used by a shipped module', () => {
    const classes = [...new Set([...read('style.css').matchAll(/\.(npc-state-delta-[A-Za-z0-9_-]+)/g)].map(match => match[1]))];
    assert.deepEqual(classes.filter(name => !all.includes(name)), []);
});

test('4: README describes named forms once, and the contract covers later releases', () => {
    assert.equal(read('README.md').split('**named forms**').length - 1, 1);
    assert.match(read('docs/core-contract.md').split('\n')[2], /every later application release[\s\S]*?carries the same requirement/);
});
