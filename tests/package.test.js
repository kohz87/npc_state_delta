import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function activeRuntimeConfig() {
    return JSON.parse(fs.readFileSync(path.join(root, 'runtime-modules.json'), 'utf8'));
}

test('install folder has SillyTavern-discoverable one-level layout', () => {
    assert.equal(path.basename(root), 'npc_state_delta');
    const config = activeRuntimeConfig();
    const configured = config.modules.map(module => module.path).sort();
    const rootJs = fs.readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
        .map(entry => entry.name)
        .sort();
    assert.deepEqual(configured, rootJs, 'active runtime inventory must match every root JS module exactly');
    for (const name of configured) assert.ok(fs.existsSync(path.join(root, name)), `${name} must be directly inside npc_state_delta/`);
    for (const name of ['manifest.json', 'runtime-modules.json', 'style.css', 'README.md', 'CHANGELOG.md']) {
        assert.ok(fs.existsSync(path.join(root, name)), `${name} must exist in the Delta repository root`);
    }
    assert.ok(fs.existsSync(path.join(root, 'docs', 'history')), 'historical source records remain segregated under docs/history');
    assert.equal(fs.existsSync(path.join(root, 'enhancements.js')), false, 'superseded enhancement wrapper must be removed');
    assert.equal(fs.existsSync(path.join(root, 'core-v0218.js')), false, 'version-labelled core path must not remain active');
    assert.equal(fs.existsSync(path.join(root, 'branch-v0218.js')), false, 'version-labelled branch path must not remain active');
    assert.ok(fs.existsSync(path.join(root, 'core-mechanics.js')), 'canonical core mechanics owner must exist');
    assert.ok(fs.existsSync(path.join(root, 'branch-core.js')), 'canonical branch primitives owner must exist');
    assert.equal(fs.existsSync(path.join(root, 'npc_state_delta', 'manifest.json')), false, 'must not contain a second nested npc_state_delta folder');

    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    assert.equal(manifest.display_name, 'NPC State Delta');
    assert.equal(manifest.version, '1.0.20');
    assert.equal(manifest.js, 'bootstrap.js');
    assert.equal(config.applicationVersion, manifest.version);
    assert.equal(config.entrypoint, manifest.js);
    assert.equal(config.modules.some(module => /legacy|(?:^|[-_.])v\d{3,}/i.test(module.path)), false, 'active module paths must use current semantic names');
});
