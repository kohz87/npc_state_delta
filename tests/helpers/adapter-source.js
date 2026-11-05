// The Story Suite v2 adapter's source text: src/storysuite-v2.js and the parts of its factory under src/adapter/ (the closure was
// cut into parts; tests that look for a line of the adapter's code read all of them).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

export function adapterFiles() {
    const parts = fs.readdirSync(path.join(src, 'adapter')).filter(name => name.endsWith('.js')).sort().map(name => `adapter/${name}`);
    return ['storysuite-v2.js', ...parts];
}

export function adapterSource() {
    return adapterFiles().map(name => fs.readFileSync(path.join(src, name), 'utf8')).join('\n');
}
