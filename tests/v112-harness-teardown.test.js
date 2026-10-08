import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Leaves a branch reconcile scheduled when the synthetic host is torn down.
async function pendingAtTeardown(mockState, eventSource) {
    mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: 'An edited reply.', swipe_id: 0 });
    eventSource.emit('message_edited', mockState.context.chat.length - 1);
}

test('1.1.2: the synthetic host cancels pending extension timers before it is removed', () => {
    let source = fs.readFileSync(new URL('./runtime-smoke.mjs', import.meta.url), 'utf8');
    source = source.replace('const here = path.dirname(fileURLToPath(import.meta.url));', `const here = ${JSON.stringify(fileURLToPath(new URL('.', import.meta.url)))};`);
    const marker = "    console.log('Runtime smoke:";
    if (!source.includes(marker)) throw new Error('Runtime smoke cleanup marker changed');
    source = source.replace(marker, `    await (${pendingAtTeardown.toString()})(mockState, eventSource);\n${marker}`);
    const run = spawnSync(process.execPath, ['--import', new URL('./active-runtime-test-setup.mjs', import.meta.url).href, '--input-type=module'], {
        input: source,
        encoding: 'utf8',
        timeout: 180000,
        maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(`${run.stdout}\n${run.stderr}`, /reading 'context'/);
});
