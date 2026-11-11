// Runtime modules that will ship, including files in split folders beside their declared owner.
// The package inventory is merged in a separate step, so source-audit tests discover split parts here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function shippedModulePaths() {
    const modules = JSON.parse(fs.readFileSync(path.join(root, 'runtime-modules.json'), 'utf8')).modules.map(module => module.path);
    const split = [];
    for (const modulePath of modules) {
        const directory = path.join(root, modulePath.replace(/\.js$/, ''));
        if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) continue;
        for (const name of fs.readdirSync(directory, { recursive: true })) {
            if (!String(name).endsWith('.js')) continue;
            split.push(`${modulePath.replace(/\.js$/, '')}/${String(name).replace(/\\/g, '/')}`);
        }
    }
    return [...modules, ...split];
}

// The stylesheet's parts: style.css holds only @import lines, so tests that pin CSS rules read the parts joined in cascade order.
export function shippedStylePaths() {
    const entry = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
    return [...entry.matchAll(/^@import url\('\.\/([^']+\.css)'\);$/gm)].map(match => match[1]);
}

export function styleSource() {
    return shippedStylePaths().map(name => fs.readFileSync(path.join(root, name), 'utf8')).join('');
}
