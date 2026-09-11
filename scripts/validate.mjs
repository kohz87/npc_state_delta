import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const requireCheck = (ok, message) => { if (!ok) errors.push(message); };

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (['.git', 'dist', 'node_modules'].includes(entry.name)) return [];
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const files = walk(root);
const runtimeConfigPath = path.join(root, 'runtime-modules.json');
requireCheck(fs.existsSync(runtimeConfigPath), 'missing runtime-modules.json active runtime inventory');
const runtimeConfig = fs.existsSync(runtimeConfigPath)
  ? JSON.parse(fs.readFileSync(runtimeConfigPath, 'utf8'))
  : { modules: [] };
const declaredModules = Array.isArray(runtimeConfig.modules) ? runtimeConfig.modules : [];
const declaredPaths = declaredModules.map(module => String(module?.path || ''));
const declaredSet = new Set(declaredPaths);
const rootRuntimeFiles = fs.readdirSync(root, { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
  .map(entry => entry.name)
  .sort();

requireCheck(runtimeConfig.schemaVersion === 1, 'runtime module inventory schema mismatch');
requireCheck(declaredPaths.length === declaredSet.size, 'runtime module inventory contains duplicate paths');
requireCheck(declaredModules.every(module => typeof module?.role === 'string' && module.role.trim()), 'runtime module inventory requires a role for every module');
requireCheck(declaredModules.every(module => typeof module?.required === 'boolean'), 'runtime module inventory requires explicit required flags');
requireCheck(declaredPaths.every(file => file && path.dirname(file) === '.' && file.endsWith('.js')), 'runtime module inventory may contain only top-level JS modules');
requireCheck(declaredPaths.every(file => !/(?:^|[-_.])legacy(?:[-_.]|$)/i.test(file) && !/(?:^|[-_.])v\d{3,}(?:[-_.]|$)/i.test(file)), 'active runtime module names must be semantic, not legacy/version labels');
requireCheck(JSON.stringify([...declaredSet].sort()) === JSON.stringify(rootRuntimeFiles), 'runtime-modules.json must declare every and only top-level runtime JS module');

for (const module of declaredModules) {
  const full = path.join(root, module.path);
  requireCheck(fs.existsSync(full), `active runtime module missing: ${module.path}`);
}

for (const file of files.filter(file => /\.(?:m?js)$/.test(file))) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  requireCheck(result.status === 0, `${path.relative(root, file)}: ${result.stderr || result.error || 'syntax check failed'}`);
}

for (const file of rootRuntimeFiles.map(name => path.join(root, name))) {
  const source = fs.readFileSync(file, 'utf8');
  requireCheck(!/npc_state(?!_delta)|npc-state(?!-delta)|NPCState(?!Delta)|npcState(?!Delta)|\.npcstate(?!delta)/.test(source), `${path.basename(file)}: old shared namespace remains`);
  requireCheck(!/(?:from\s*|import\s*\()\s*['"]https?:/.test(source), `${path.basename(file)}: remote runtime import`);
  requireCheck(!/(?:from\s*|import\s*\()\s*['"][^'"]*docs\/history/i.test(source), `${path.basename(file)}: historical documentation imported by runtime`);
  requireCheck(!/(?:from\s*|import\s*\()\s*['"][^'"]*(?:core-v\d|branch-v\d)/i.test(source), `${path.basename(file)}: version-labelled runtime dependency remains`);
  for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*['"](\.\/[^'"]+)['"]/g)) {
    requireCheck(fs.existsSync(path.resolve(path.dirname(file), match[1])), `${path.basename(file)}: missing dependency ${match[1]}`);
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const facade = fs.readFileSync(path.join(root, 'core.js'), 'utf8');
const branch = fs.readFileSync(path.join(root, 'branch.js'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const bootstrap = fs.readFileSync(path.join(root, 'bootstrap.js'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const scannerRouting = fs.readFileSync(path.join(root, 'scanner-routing.js'), 'utf8');

requireCheck(manifest.display_name === 'NPC State Delta', 'manifest identity');
requireCheck(manifest.js === 'bootstrap.js' && manifest.css === 'style.css', 'manifest entrypoints');
requireCheck(runtimeConfig.entrypoint === manifest.js, 'active runtime inventory/manifest entrypoint mismatch');
requireCheck(runtimeConfig.applicationVersion === manifest.version, 'active runtime inventory/manifest version mismatch');
requireCheck(facade.includes(`NPC_STATE_VERSION = '${manifest.version}'`), 'core facade/manifest version mismatch');
requireCheck(facade.includes("export * from './core-mechanics.js'"), 'core facade must expose canonical core-mechanics owner');
requireCheck(!facade.includes('SOURCE_ENGINE_VERSION') && !facade.includes('core-v0218'), 'core facade still exposes source-version compatibility identity');
requireCheck(branch.includes("from './branch-core.js'"), 'branch owner must use canonical branch-core module');
requireCheck(!branch.includes("from './branch-v") && !branch.includes("export * from './branch-v"), 'branch owner still references version-labelled branch implementation');
requireCheck(pkg.version === manifest.version, 'package/manifest version mismatch');
requireCheck(readme.startsWith(`# NPC State Delta v${manifest.version}`), 'README/manifest version mismatch');
requireCheck(!fs.existsSync(path.join(root, 'enhancements.js')), 'superseded enhancements.js remains');
requireCheck(!fs.existsSync(path.join(root, 'core-v0218.js')), 'superseded version-labelled core path remains');
requireCheck(!fs.existsSync(path.join(root, 'branch-v0218.js')), 'superseded version-labelled branch path remains');
requireCheck(fs.existsSync(path.join(root, 'full-cast.js')), 'full-cast owner missing');
requireCheck(!bootstrap.includes('enhancements.js') && bootstrap.includes("await import('./full-cast.js')"), 'bootstrap full-cast ownership mismatch');
requireCheck(bootstrap.indexOf('await prepareNpcStateHardening()') >= 0 && bootstrap.indexOf('await prepareNpcStateHardening()') < bootstrap.indexOf("await import('./index.js')"), 'hardening must precede engine');
requireCheck(bootstrap.includes("await import('./scanner-routing.js')") && bootstrap.indexOf("await import('./scanner-routing.js')") < bootstrap.indexOf("await import('./index.js')"), 'scanner routing must load before the runtime controller');
requireCheck(declaredModules.some(module => module.path === 'scanner-routing.js' && module.role === 'scanner-request-routing' && module.required === true), 'scanner-routing.js must be a required active runtime owner');
requireCheck(scannerRouting.includes("const PROFILE_KEY = 'scannerConnectionProfile'"), 'scanner routing setting key missing');
requireCheck(scannerRouting.includes('ConnectionManagerRequestService') && scannerRouting.includes('service.sendRequest('), 'scanner routing must use request-scoped SillyTavern Connection Manager requests');
requireCheck(scannerRouting.includes('ctx.generateRaw(options)'), 'scanner routing must preserve the default host generateRaw route');
requireCheck(!/connectionManager\s*\.\s*selectedProfile\s*=/.test(scannerRouting), 'scanner routing must not mutate the host roleplay connection profile');
requireCheck(runtime.includes('NPCStateDeltaScannerRouting?.dispatch'), 'runtime scanner calls are not wired through the shared dispatcher');
requireCheck(runtime.includes("scannerConnectionProfile: ''"), 'scanner connection profile is missing from active Delta settings defaults');

for (const file of ['AGENTS.md', 'docs/core-contract.md', 'docs/WORKPLAN.md', 'DEVELOPMENT.md', 'docs/seed-provenance.md', 'docs/seed-provenance.json', 'LICENSE']) {
  requireCheck(fs.existsSync(path.join(root, file)), `missing ${file}`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Validation passed: ${rootRuntimeFiles.length} declared active runtime JS modules; syntax, local imports, isolation, semantic module ownership, scanner routing, application version, entrypoints and governing documents.`);
}
