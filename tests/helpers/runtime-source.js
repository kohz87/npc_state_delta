// Source text of the runtime controller together with the parts split out of index.js, for tests that pin source text.
// The controller comes first, then the parts in the order they were split out; the text of each file is unchanged, so a
// pin finds its text wherever it now lives. Add a file here when more code moves out of index.js.
import fs from 'node:fs';

const root = new URL('../../', import.meta.url);

export const RUNTIME_SOURCE_FILES = [
    'index.js',
    'runtime-settings.js',
    'runtime-suite.js',
];

export function runtimeSource() {
    return RUNTIME_SOURCE_FILES.map(file => fs.readFileSync(new URL(file, root), 'utf8')).join('\n');
}
