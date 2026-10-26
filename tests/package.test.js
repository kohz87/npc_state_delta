import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function activeRuntimeConfig() {
    return JSON.parse(fs.readFileSync(path.join(root, 'runtime-modules.json'), 'utf8'));
}

test('install folder has SillyTavern-discoverable one-level layout', () => {
    const config = activeRuntimeConfig();
    const configured = config.modules.map(module => module.path).filter(file => !file.includes('/')).sort();
    const rootJs = fs.readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
        .map(entry => entry.name)
        .sort();
    assert.deepEqual(configured, rootJs, 'active runtime inventory must match every root JS module exactly');
    for (const name of configured) assert.ok(fs.existsSync(path.join(root, name)), `${name} must be directly inside npc_state_delta/`);
    for (const name of config.modules.map(module => module.path).filter(file => file.includes('/'))) {
        assert.match(name, /^src\//, `${name}: a nested runtime module lives under src/`);
        assert.ok(fs.existsSync(path.join(root, name)), `${name} must exist`);
    }
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
    assert.equal(manifest.version, '1.3.0');
    assert.equal(manifest.js, 'bootstrap.js');
    assert.equal(config.applicationVersion, manifest.version);
    assert.equal(config.entrypoint, manifest.js);
    assert.equal(config.modules.some(module => /legacy|(?:^|[-_.])v\d{3,}/i.test(module.path)), false, 'active module paths must use current semantic names');
});

test('the package ships the Story Suite v2 adapter beside the runtime modules', () => {
    const script = fs.readFileSync(path.join(root, 'scripts', 'package.py'), 'utf8');
    const support = script.match(/^support_files = \[(.*)\]$/m);
    assert.ok(support, 'package.py lists its support files on one line');
    const listed = [...support[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
    assert.ok(listed.includes('src/storysuite-v2.js'), 'src/storysuite-v2.js is packaged');
    for (const name of listed) assert.ok(fs.existsSync(path.join(root, name)), `${name} exists`);
    // Every module under src/ ships (index.js imports the adapter at runtime, by relative path).
    const srcJs = fs.readdirSync(path.join(root, 'src'), { recursive: true })
        .filter(name => String(name).endsWith('.js'))
        .map(name => `src/${String(name).split(path.sep).join('/')}`);
    // A src/ module ships either as a support file or as a module declared in runtime-modules.json.
    const declared = activeRuntimeConfig().modules.map(module => module.path);
    for (const name of srcJs) assert.ok(listed.includes(name) || declared.includes(name), `${name} is packaged`);
    assert.match(script, /assert all\(name in files for name in src_js\)/, 'package.py refuses to leave a src/ module out');
});

// A scratch copy of the repository without tests, history or build output, so validation and
// packaging can be run against a changed inventory without touching the real one.
function scratchRepository() {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'nsd-inventory-'));
    const skip = new Set(['.git', 'dist', 'node_modules', 'tests', 'history']);
    fs.cpSync(root, copy, { recursive: true, filter: source => !skip.has(path.basename(source)) });
    return copy;
}
function declare(copy, entries) {
    const file = path.join(copy, 'runtime-modules.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    config.modules.push(...entries);
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}
function run(copy, script) {
    const python = ['python3', 'python'].find(command => spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0);
    const [command, args] = script.endsWith('.py') ? [python, [script]] : [process.execPath, [script]];
    return spawnSync(command, args, { cwd: copy, encoding: 'utf8' });
}

test('validation and packaging accept runtime modules declared under src/', () => {
    const copy = scratchRepository();
    try {
        fs.mkdirSync(path.join(copy, 'src', 'fields'), { recursive: true });
        fs.writeFileSync(path.join(copy, 'src', 'fields', 'example.js'), "export const EXAMPLE = Object.freeze(['background']);\n");
        declare(copy, [
            { path: 'src/storysuite-v2.js', role: 'story-suite-v2-adapter', required: false },
            { path: 'src/fields/example.js', role: 'example-src-module', required: true },
        ]);
        const validation = run(copy, 'scripts/validate.mjs');
        assert.equal(validation.status, 0, validation.stderr || validation.stdout);
        assert.match(validation.stdout, /Validation passed: \d+ declared active runtime JS modules/);
        const packaging = run(copy, 'scripts/package.py');
        assert.equal(packaging.status, 0, packaging.stderr || packaging.stdout);
        const summary = JSON.parse(packaging.stdout.trim().split('\n').pop());
        assert.equal(summary.contentsAndSyntaxVerified, true);
        const config = JSON.parse(fs.readFileSync(path.join(copy, 'runtime-modules.json'), 'utf8'));
        assert.equal(summary.runtimeFiles, config.modules.length, 'the declared src/ modules count as runtime files');
    } finally {
        fs.rmSync(copy, { recursive: true, force: true });
    }
});

test('validation and packaging still refuse runtime modules outside the top level and src/', () => {
    for (const [entry, expected] of [
        [{ path: 'lib/stray.js', role: 'stray', required: true }, /only top-level or src\/ JS modules/],
        [{ path: 'src/../stray.js', role: 'stray', required: true }, /only top-level or src\/ JS modules/],
        [{ path: 'src/missing.js', role: 'missing', required: true }, /active runtime module missing: src\/missing\.js/],
    ]) {
        const copy = scratchRepository();
        try {
            fs.mkdirSync(path.join(copy, 'lib'), { recursive: true });
            fs.writeFileSync(path.join(copy, 'lib', 'stray.js'), 'export const STRAY = 1;\n');
            declare(copy, [entry]);
            const validation = run(copy, 'scripts/validate.mjs');
            assert.notEqual(validation.status, 0, `${entry.path} is refused by validation`);
            assert.match(validation.stderr, expected);
            assert.notEqual(run(copy, 'scripts/package.py').status, 0, `${entry.path} is refused by packaging`);
        } finally {
            fs.rmSync(copy, { recursive: true, force: true });
        }
    }
});

test('a declared src/ module gets the same runtime checks as a top-level one', () => {
    const copy = scratchRepository();
    try {
        fs.writeFileSync(path.join(copy, 'src', 'broken-import.js'), "import { nothing } from './not-here.js';\nexport const BROKEN = nothing;\n");
        declare(copy, [{ path: 'src/broken-import.js', role: 'broken-import', required: true }]);
        const validation = run(copy, 'scripts/validate.mjs');
        assert.notEqual(validation.status, 0);
        assert.match(validation.stderr, /broken-import\.js: missing dependency \.\/not-here\.js/);
    } finally {
        fs.rmSync(copy, { recursive: true, force: true });
    }
});
