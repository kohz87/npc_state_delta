import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';

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
fs.copyFileSync = (source, destination, ...args) => copyFileSync(semanticPath(source), semanticPath(destination), ...args);
