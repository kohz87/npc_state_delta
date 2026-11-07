import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeModules = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'runtime-modules.json'), 'utf8')).modules;
const copyFileSync = fs.copyFileSync.bind(fs);
fs.copyFileSync = (source, destination, ...args) => {
    const resolvedSource = path.resolve(String(source));
    const resolvedDestination = path.resolve(String(destination));
    const result = copyFileSync(resolvedSource, resolvedDestination, ...args);
    // Old smoke harnesses enumerate their original module set. Copy the current declared
    // modules alongside the real entrypoint so new static dependencies are exercised too.
    // Nothing is imported here, and existing host/fixture overrides are never overwritten.
    if (path.resolve(resolvedSource) === path.join(sourceRoot, 'index.js')
        && path.dirname(path.resolve(resolvedDestination)) !== sourceRoot) {
        for (const module of runtimeModules) {
            const target = path.join(path.dirname(resolvedDestination), module.path);
            if (!fs.existsSync(target)) {
                fs.mkdirSync(path.dirname(target), { recursive: true });
                copyFileSync(path.join(sourceRoot, module.path), target);
            }
            // Split modules live in a sibling folder named after their owner. Copy every file
            // beneath it too, while preserving any host/fixture file that already exists.
            const splitRoot = path.join(sourceRoot, module.path.replace(/\.js$/, ''));
            if (!fs.statSync(splitRoot, { throwIfNoEntry: false })?.isDirectory()) continue;
            const copySplit = (directory, relative = '') => {
                for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                    const from = path.join(directory, entry.name);
                    const moduleRelative = path.join(relative, entry.name);
                    if (entry.isDirectory()) {
                        copySplit(from, moduleRelative);
                        continue;
                    }
                    const to = path.join(path.dirname(resolvedDestination), module.path.replace(/\.js$/, ''), moduleRelative);
                    if (!entry.isFile() || fs.existsSync(to)) continue;
                    fs.mkdirSync(path.dirname(to), { recursive: true });
                    copyFileSync(from, to);
                }
            };
            copySplit(splitRoot);
        }
    }
    return result;
};
