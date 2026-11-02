import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

test('README images: at most 8, each present, 300 KB or less, with alt text, and none left over in docs/images', () => {
    const readme = read('README.md');
    const images = [...readme.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)].map(match => ({ alt: match[1], src: match[2] }));
    assert.ok(images.length >= 1 && images.length <= 8, `README has ${images.length} images`);
    for (const { alt, src } of images) {
        assert.ok(alt.trim().length > 10, `${src}: alt text`);
        const file = path.join(root, src);
        assert.ok(fs.existsSync(file), `${src} exists`);
        assert.ok(fs.statSync(file).size <= 300 * 1024, `${src} is 300 KB or less`);
    }
    const linked = new Set(images.map(item => path.basename(item.src)));
    const onDisk = fs.readdirSync(path.join(root, 'docs', 'images'));
    assert.deepEqual(onDisk.filter(name => !linked.has(name)), [], 'every file in docs/images is linked by the README');
});

test('AI-README exists, names the current version, stays short and is linked from the README', () => {
    const ai = read('AI-README.md');
    assert.ok(ai.startsWith(`# AI-README: NPC State Delta ${manifest.version}`));
    assert.ok(ai.split('\n').length <= 600, 'AI-README stays under about 600 lines');
    assert.match(read('README.md'), /\]\(AI-README\.md\)/);
    for (const heading of ['Purpose', 'Suite map', 'Install & requirements', 'Concepts', 'Reader features', 'Settings', 'Data the model sees',
        'Reply format the model writes', 'Pack format pointers', 'Commands and queries', 'Storage', 'File map', 'Limits & known follow-ups', 'Version']) {
        assert.ok(ai.includes(`\n## ${heading}\n`), `AI-README has the section ${heading}`);
    }
});

test('README carries the shared "How the four fit together" section with the suite versions', () => {
    const readme = read('README.md');
    assert.ok(readme.includes('## How the four fit together'));
    for (const version of ['Story Block** (2.16.1)', 'Story Director** (2.9.1)', `NPC State Delta** (${manifest.version})`, 'Story Studio** (0.6.0)']) {
        assert.ok(readme.includes(version), version);
    }
});
