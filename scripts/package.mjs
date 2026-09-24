import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./package.py', import.meta.url));
const candidates = process.platform === 'win32'
    ? [['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['python', []], ['py', ['-3']]];

for (const [command, prefix] of candidates) {
    const probe = spawnSync(command, [...prefix, '--version'], { stdio: 'ignore', shell: false });
    if (probe.error?.code === 'ENOENT' || probe.status !== 0) continue;
    const result = spawnSync(command, [...prefix, script], { stdio: 'inherit', shell: false });
    if (result.error) {
        console.error(`Packaging failed to launch ${command}: ${result.error.message}`);
        process.exit(1);
    }
    process.exit(result.status ?? 1);
}

console.error('Packaging requires Python 3. Install Python 3 or make py/python/python3 available on PATH.');
process.exit(1);
