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
const runtimeFiles = files.filter(file => path.dirname(file) === root && file.endsWith('.js'));
for (const file of files.filter(file => /\.(?:m?js)$/.test(file))) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  requireCheck(result.status === 0, `${path.relative(root, file)}: ${result.stderr || result.error || 'syntax check failed'}`);
}
for (const file of runtimeFiles) {
  const source = fs.readFileSync(file, 'utf8');
  requireCheck(!/npc_state(?!_delta)|npc-state(?!-delta)|NPCState(?!Delta)|npcState(?!Delta)|\.npcstate(?!delta)/.test(source), `${path.basename(file)}: old shared namespace remains`);
  requireCheck(!/(?:from\s*|import\s*\()\s*['"]https?:/.test(source), `${path.basename(file)}: remote runtime import`);
  for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*['"](\.\/[^'"]+)['"]/g)) {
    requireCheck(fs.existsSync(path.resolve(path.dirname(file), match[1])), `${path.basename(file)}: missing dependency ${match[1]}`);
  }
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const facade = fs.readFileSync(path.join(root, 'core.js'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const bootstrap = fs.readFileSync(path.join(root, 'bootstrap.js'), 'utf8');
requireCheck(manifest.display_name === 'NPC State Delta', 'manifest identity');
requireCheck(manifest.js === 'bootstrap.js' && manifest.css === 'style.css', 'manifest entrypoints');
requireCheck(facade.includes(`NPC_STATE_VERSION = '${manifest.version}'`), 'core facade/manifest version mismatch');
requireCheck(readme.startsWith(`# NPC State Delta v${manifest.version}`), 'README/manifest version mismatch');
requireCheck(bootstrap.indexOf('await prepareNpcStateHardening()') >= 0 && bootstrap.indexOf('await prepareNpcStateHardening()') < bootstrap.indexOf("await import('./index.js')"), 'hardening must precede engine');
for (const file of ['AGENTS.md', 'docs/core-contract.md', 'docs/WORKPLAN.md', 'DEVELOPMENT.md', 'docs/seed-provenance.md', 'docs/seed-provenance.json', 'LICENSE']) {
  requireCheck(fs.existsSync(path.join(root, file)), `missing ${file}`);
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else console.log(`Validation passed: ${runtimeFiles.length} runtime JS modules; syntax, local imports, isolation, entrypoints and governing documents.`);
