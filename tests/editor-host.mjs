// Drives the real dossier editor (openNpcEditor / saveNpcEditor) inside the runtime-smoke synthetic
// host. A scenario is a function run in that host; it can use the editor helpers defined below.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TRY_MARKER = '\ntry {\n    await import(pathToFileURL(path.join(extRoot, \'index.js\'))';

// Defined inside the host script, next to the scenario.
const EDITOR_HELPERS = String.raw`
const decodeEditorHtml = text => String(text)
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#039;', "'").replaceAll('&amp;', '&');
// Opens the editor for an NPC and returns the rendered form: every npc_state_delta_edit_* control
// with the value, checked state and maxlength the reader would see.
async function openEditorForm(id) {
    await globalThis.NPCStateDelta.openEditor(id);
    await sleep(30);
    const popup = mockState.popupCalls.at(-1);
    const html = String(popup.content?.innerHTML ?? popup.content ?? '');
    const controls = new Map();
    const attr = (attrs, name) => (attrs.match(new RegExp('\\b' + name + '="([^"]*)"')) || [])[1];
    for (const match of html.matchAll(/<input id="(npc_state_delta_edit_[a-z_]+)"([^>]*)>/g)) {
        const attrs = match[2];
        const maxlength = attr(attrs, 'maxlength');
        controls.set(match[1], { tag: 'input', value: decodeEditorHtml(attr(attrs, 'value') ?? ''), checked: /\bchecked\b/.test(attrs),
            maxLength: maxlength === undefined ? null : Number(maxlength) });
    }
    for (const match of html.matchAll(/<textarea id="(npc_state_delta_edit_[a-z_]+)"([^>]*)>([^<]*)<\/textarea>/g)) {
        const maxlength = attr(match[2], 'maxlength');
        controls.set(match[1], { tag: 'textarea', value: decodeEditorHtml(match[3]), checked: false, maxLength: maxlength === undefined ? null : Number(maxlength) });
    }
    for (const match of html.matchAll(/<select id="(npc_state_delta_edit_[a-z_]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
        const selected = (match[2].match(/<option value="([^"]*)" selected>/) || [])[1] ?? '';
        controls.set(match[1], { tag: 'select', value: decodeEditorHtml(selected), checked: false, maxLength: null });
    }
    if (controls.size < 20) throw new Error('the editor form was not found (' + controls.size + ' controls)');
    return { popup, html, controls };
}
// Saves an open editor form after applying the reader's changes ({ id: value } or { id: { checked } }).
async function saveEditorForm(form, changes = {}) {
    for (const [key, change] of Object.entries(changes)) {
        const id = key.startsWith('npc_state_delta_edit_') ? key : 'npc_state_delta_edit_' + key;
        const control = form.controls.get(id);
        if (!control) throw new Error('no editor control ' + id);
        if (change && typeof change === 'object') Object.assign(control, change);
        else control.value = String(change);
    }
    const previous = document.getElementById;
    document.getElementById = id => form.controls.get(id) || null;
    try {
        await form.popup.complete(1);
        await sleep(100);
    } finally {
        document.getElementById = previous || (() => null);
    }
}
async function editNpc(id, changes = {}) {
    const form = await openEditorForm(id);
    await saveEditorForm(form, changes);
    return form;
}
`;

export function runEditorHostScenario(name, scenario) {
    let source = fs.readFileSync(new URL('./runtime-smoke.mjs', import.meta.url), 'utf8');
    source = source.replace('const here = path.dirname(fileURLToPath(import.meta.url));', `const here = ${JSON.stringify(fileURLToPath(new URL('.', import.meta.url)))};`);
    const cut = source.indexOf(TRY_MARKER);
    if (cut < 0) throw new Error('Runtime smoke import marker changed');
    const script = `${source.slice(0, cut)}
${EDITOR_HELPERS}
globalThis.document.readyState = 'loading';
try {
    await import(pathToFileURL(path.join(extRoot, 'index.js')).href + \`?t=\${Date.now()}\`);
    await sleep(30);
    eventSource.emit('app_ready');
    eventSource.emit('extension_settings_loaded');
    await sleep(30);
    await (${scenario.toString()})();
    console.log('editor scenario ${name} passed');
} finally {
    for (const handle of pendingHostTimers) nativeClearTimeout(handle);
    pendingHostTimers.clear();
    delete globalThis.__npcMock;
    fs.rmSync(tempRoot, { recursive: true, force: true });
}
`;
    try {
        execFileSync(process.execPath, ['--import', new URL('./active-runtime-test-setup.mjs', import.meta.url).href, '--input-type=module'], {
            input: script, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
        });
    } catch (error) {
        const stderr = String(error.stderr || '');
        const detail = stderr.split('\n').filter(line => /Error|assert|expected|actual|\+|-/i.test(line)).slice(0, 40).join('\n');
        throw new Error(`editor scenario ${name} failed:\n${detail || stderr.slice(-4000)}`);
    }
}
