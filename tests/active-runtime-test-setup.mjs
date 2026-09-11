import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeModules = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'runtime-modules.json'), 'utf8')).modules;
const PATH_RENAMES = new Map([
    ['core-v0218.js', 'core-mechanics.js'],
    ['branch-v0218.js', 'branch-core.js'],
]);

function semanticPath(value) {
    let result = String(value);
    for (const [oldName, activeName] of PATH_RENAMES) {
        if (result.endsWith(`/${oldName}`) || result.endsWith(`\\${oldName}`)) {
            result = path.join(path.dirname(result), activeName);
            break;
        }
    }
    return result;
}

// Historical tests intentionally exercise source-era fixtures. Redirect their old module
// filenames to the canonical active Delta owners without keeping compatibility files in the
// shipped runtime tree.
registerHooks({
    resolve(specifier, context, nextResolve) {
        let nextSpecifier = specifier;
        for (const [oldName, activeName] of PATH_RENAMES) {
            if (nextSpecifier.endsWith(oldName)) nextSpecifier = nextSpecifier.slice(0, -oldName.length) + activeName;
        }
        return nextResolve(nextSpecifier, context);
    },
});

const copyFileSync = fs.copyFileSync.bind(fs);
fs.copyFileSync = (source, destination, ...args) => {
    const resolvedSource = semanticPath(source);
    const resolvedDestination = semanticPath(destination);
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
