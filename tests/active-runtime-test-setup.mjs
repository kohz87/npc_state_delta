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
            if (!fs.existsSync(target)) copyFileSync(path.join(sourceRoot, module.path), target);
        }
    }
    return result;
};
