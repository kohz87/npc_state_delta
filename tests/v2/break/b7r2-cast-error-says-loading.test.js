// R2-b7-combos-5: hosted, a chat whose sidecar cannot be read (corrupt JSON) shows "This chat's
// dossiers are still loading." in the Cast tab forever (live S8). index.js castEmptyReason() treats
// every hydration status other than 'ready' as loading, including 'error'. While hosted the drawer
// copy (with its "could not load … Detach Broken Sidecar" notice) is hidden, so the Cast tab is the
// only place the reader looks, and it says to wait. Source-level check (castEmptyReason is not
// exported; the runtime harness would need a corrupt sidecar fixture).
// Drop into npc_state_delta/tests/v2/break/.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('castEmptyReason tells a failed load apart from a load in progress', () => {
    const source = fs.readFileSync(new URL('../../../index.js', import.meta.url), 'utf8');
    const start = source.indexOf('function castEmptyReason()');
    assert.ok(start >= 0, 'castEmptyReason is in index.js');
    const body = source.slice(start, source.indexOf('\n}\n', start));
    assert.match(body, /'error'|hydrationErrors|could not (?:be )?load/i, 'a hydration error gets its own reason (and a way to the Detach action), not "still loading"');
});
