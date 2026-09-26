import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(here, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'npc-state-delta-runtime-'));
const extRoot = path.join(tempRoot, 'public', 'scripts', 'extensions', 'third-party', 'npc_state_delta');
fs.mkdirSync(extRoot, { recursive: true });
for (const name of ['index.js', 'core.js', 'core-mechanics.js', 'bundle.js', 'branch.js', 'branch-core.js', 'social.js', 'storage.js', 'identity.js', 'hardening-core.js']) {
    fs.copyFileSync(path.join(sourceRoot, name), path.join(extRoot, name));
}
fs.writeFileSync(path.join(tempRoot, 'package.json'), JSON.stringify({ type: 'module' }));

const mockState = {
    extensionSettings: {},
    prompts: [],
    listeners: new Map(),
    quietResponder: null,
    rawCalls: [],
    quietCalls: [],
    files: new Map(),
    messageDomReady: true,
    popupCalls: [],
    swipeState: 'none',
    slashCalls: [],
    uploadCalls: 0,
    uploadBarrier: null,
    readBarrier: null,
    hostChatsByAvatar: new Map(),
    saveSettingsCalls: 0,
};

fs.writeFileSync(path.join(tempRoot, 'public', 'scripts', 'extensions.js'), `
export const extension_settings = globalThis.__npcMock.extensionSettings;
export function getContext() { return globalThis.__npcMock.context; }
`);
fs.writeFileSync(path.join(tempRoot, 'public', 'script.js'), `
export const extension_prompt_types = { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
export const extension_prompt_roles = { SYSTEM: 0, USER: 1, ASSISTANT: 2 };
export function getRequestHeaders() { return { 'Content-Type': 'application/json', 'X-CSRF-Token': 'mock' }; }
export async function saveSettings() { globalThis.__npcMock.saveSettingsCalls += 1; }
`);

const POPUP_TYPE = { TEXT: 1, DISPLAY: 4 };
const POPUP_RESULT = { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null };
class MockPopup {
    constructor(content, type, inputValue = '', options = {}) {
        this.content = content;
        this.type = type;
        this.inputValue = inputValue;
        this.options = options;
        this.result = undefined;
        const classes = new Set();
        this.dlg = {
            open: false,
            isConnected: false,
            classList: { add: (...names) => names.forEach(name => classes.add(name)), contains: name => classes.has(name) },
        };
        mockState.popupCalls.push(this);
    }
    async show() {
        this.dlg.open = true;
        this.dlg.isConnected = true;
        document.body.appendChild?.(this.dlg);
        this.options.onOpen?.(this);
        this._promise = new Promise(resolve => { this._resolve = resolve; });
        return this._promise;
    }
    async complete(result) {
        this.result = result;
        if (this.options.onClosing) {
            const allowed = await this.options.onClosing(this);
            if (allowed === false) return undefined;
        }
        this.dlg.open = false;
        this.dlg.isConnected = false;
        await this.options.onClose?.(this);
        this._resolve?.(result);
        return result;
    }
    async completeCancelled() { return this.complete(POPUP_RESULT.CANCELLED); }
}

const eventSource = {
    on(name, fn) {
        const list = mockState.listeners.get(name) || [];
        list.push(fn);
        mockState.listeners.set(name, list);
    },
    emit(name, ...args) {
        for (const fn of mockState.listeners.get(name) || []) fn(...args);
    },
};

mockState.context = {
    chatId: 'smoke-chat',
    getCurrentChatId: () => 'smoke-chat',
    chat: [],
    characters: [{ name: 'Megumin', avatar: 'megumin.png' }],
    characterId: 0,
    groupId: null,
    name1: 'Kazuma',
    name2: 'Megumin',
    saveSettingsDebounced: () => {},
    setExtensionPrompt: (...args) => mockState.prompts.push(args),
    eventSource,
    eventTypes: {
        APP_READY: 'app_ready',
        EXTENSION_SETTINGS_LOADED: 'extension_settings_loaded',
        MESSAGE_SENT: 'message_sent',
        MESSAGE_RECEIVED: 'message_received',
        MESSAGE_EDITED: 'message_edited',
        MESSAGE_SWIPED: 'message_swiped',
        MESSAGE_DELETED: 'message_deleted',
        MESSAGE_SWIPE_DELETED: 'message_swipe_deleted',
        CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
        MESSAGE_UPDATED: 'message_updated',
        MORE_MESSAGES_LOADED: 'more_messages_loaded',
        CHAT_LOADED: 'chat_loaded',
        CHAT_CHANGED: 'chat_changed',
        CHAT_DELETED: 'chat_deleted',
        GROUP_CHAT_DELETED: 'group_chat_deleted',
        CHAT_RENAMED: 'chat_renamed',
    },
    generateRaw: async (...args) => { mockState.rawCalls.push(args); return mockState.quietResponder ? mockState.quietResponder(...args) : '{"npcs":[]}'; },
    generateQuietPrompt: async (...args) => { mockState.quietCalls.push(args); return '{"npcs":[]}'; },
    executeSlashCommandsWithOptions: async (...args) => { mockState.slashCalls.push(args); return { pipe: '/user/images/npc-state-delta-generated.png' }; },
    Popup: MockPopup,
    POPUP_TYPE,
    POPUP_RESULT,
    swipe: { state: () => mockState.swipeState },
};
globalThis.__npcMock = mockState;
globalThis.window = globalThis;

globalThis.fetch = async (url, options = {}) => {
    if (url === '/api/characters/chats') {
        const body = JSON.parse(options.body || '{}');
        if (!mockState.hostChatsByAvatar.has(body.avatar_url)) return { ok: false, status: 404, json: async () => ({}) };
        const chats = mockState.hostChatsByAvatar.get(body.avatar_url) || [];
        return { ok: true, status: 200, json: async () => Object.fromEntries(chats.map((item, index) => [String(index), item])) };
    }
    if (url === '/api/files/upload') {
        mockState.uploadCalls += 1;
        const barrier = mockState.uploadBarrier;
        if (barrier) {
            mockState.uploadBarrier = null;
            barrier.entered?.();
            await barrier.promise;
        }
        const body = JSON.parse(options.body || '{}');
        const filePath = `/user/files/${body.name}`;
        mockState.files.set(filePath, Buffer.from(body.data, 'base64').toString('utf8'));
        return { ok: true, status: 200, json: async () => ({ path: filePath }), text: async () => '' };
    }
    if (url === '/api/files/delete') {
        const body = JSON.parse(options.body || '{}');
        const existed = mockState.files.delete(body.path);
        return { ok: existed, status: existed ? 200 : 404, text: async () => '' };
    }
    if (mockState.files.has(url)) {
        const barrier = mockState.readBarrier;
        if (barrier) {
            mockState.readBarrier = null;
            barrier.entered?.();
            await barrier.promise;
        }
        return { ok: true, status: 200, text: async () => mockState.files.get(url) };
    }
    return { ok: false, status: 404, text: async () => '' };
};

globalThis.toastr = { warning() {}, error() {}, success() {}, info() {} };
globalThis.URL = globalThis.URL || { createObjectURL: () => 'blob:mock', revokeObjectURL() {} };

const inlineAnchors = [];
const messageElements = new Map();
const meguminBlocks = new Map();
const documentListeners = new Map();
const mutationObservers = [];

function nodeHasClass(node, name) {
    return String(node?.className || '').split(/\s+/).filter(Boolean).includes(name);
}

function mockSelectorMatches(node, selector) {
    return String(selector || '').split(',').map(part => part.trim()).some(part => {
        if (!part.startsWith('.')) return false;
        return nodeHasClass(node, part.slice(1));
    });
}

function makeMockDomNode(tag = 'div') {
    const listeners = new Map();
    const node = {
        tagName: String(tag).toUpperCase(), className: '', dataset: {}, innerHTML: '', style: {}, id: '', title: '', type: '',
        children: [], parentNode: null, isConnected: true,
        classList: {
            contains(name) { return nodeHasClass(node, name); },
            add(...names) {
                const set = new Set(String(node.className || '').split(/\s+/).filter(Boolean));
                names.forEach(name => set.add(name)); node.className = [...set].join(' ');
            },
            remove(...names) {
                const remove = new Set(names);
                node.className = String(node.className || '').split(/\s+/).filter(name => name && !remove.has(name)).join(' ');
            },
            toggle(name, force) {
                const has = nodeHasClass(node, name);
                const next = force === undefined ? !has : Boolean(force);
                if (next) this.add(name); else this.remove(name);
                return next;
            },
        },
        addEventListener(name, fn) {
            const list = listeners.get(name) || []; list.push(fn); listeners.set(name, list);
        },
        click() {
            const event = {
                target: node,
                defaultPrevented: false,
                stopPropagation() {},
                preventDefault() { event.defaultPrevented = true; },
            };
            for (const fn of listeners.get('click') || []) fn(event);
        },
        appendChild(child) {
            if (!child) return child;
            if (child.parentNode && child.parentNode !== node) child.remove?.();
            child.parentNode = node;
            if (!node.children.includes(child)) node.children.push(child);
            return child;
        },
        before(child) {
            const parent = node.parentNode;
            if (!parent?.children || !child) return;
            child.remove?.();
            const i = parent.children.indexOf(node);
            child.parentNode = parent;
            parent.children.splice(i < 0 ? parent.children.length : i, 0, child);
        },
        remove() {
            if (node.parentNode?.children) {
                const i = node.parentNode.children.indexOf(node);
                if (i >= 0) node.parentNode.children.splice(i, 1);
            }
            node.parentNode = null;
            node.isConnected = false;
            if (editorOverlay === node) editorOverlay = null;
            const index = inlineAnchors.indexOf(node); if (index >= 0) inlineAnchors.splice(index, 1);
        },
        querySelector(selector) { return node.querySelectorAll(selector)[0] || null; },
        querySelectorAll(selector) {
            const found = [];
            const walk = parent => {
                for (const child of parent.children || []) {
                    if (mockSelectorMatches(child, selector)) found.push(child);
                    walk(child);
                }
            };
            walk(node);
            return found;
        },
        closest(selector) {
            let cur = node;
            while (cur) {
                if (mockSelectorMatches(cur, selector)) return cur;
                cur = cur.parentNode;
            }
            return null;
        },
    };
    return node;
}

function createMockMeguminBlock() {
    const card = makeMockDomNode('div'); card.className = 'meg-blocks';
    const tabs = makeMockDomNode('div'); tabs.className = 'meg-blocks-tabs';
    const nativeTab = makeMockDomNode('button'); nativeTab.className = 'meg-blocks-tab active'; nativeTab.dataset.key = 'world'; nativeTab.dataset.blockId = 'world';
    const collapse = makeMockDomNode('button'); collapse.className = 'meg-blocks-collapse';
    const panel = makeMockDomNode('div'); panel.className = 'meg-blocks-panel';
    const nativePane = makeMockDomNode('div'); nativePane.className = 'meg-block-body'; nativePane.dataset.key = 'world'; nativePane.style.display = '';
    tabs.appendChild(nativeTab); tabs.appendChild(collapse); panel.appendChild(nativePane); card.appendChild(tabs); card.appendChild(panel);

    // Mirror Megumin's private selected-key closure closely enough to catch foreign-tab
    // integrations that only change DOM state. With no CYOA/resting tab, clicking the
    // active native tab closes the card and clicking it from null opens it.
    let current = 'world';
    const select = key => {
        current = key;
        nativeTab.classList.toggle('active', key === 'world');
        nativePane.style.display = key === 'world' ? '' : 'none';
        card.classList.toggle('meg-blocks-shut', key === null);
    };
    nativeTab.addEventListener('click', () => select(current === 'world' ? null : 'world'));
    collapse.addEventListener('click', () => select(null));

    return { card, tabs, panel, nativeTab, nativePane, collapse, current: () => current };
}
const chatRoot = {
    closest() { return null; },
    querySelectorAll(selector) { return globalThis.document?.querySelectorAll?.(selector) || []; },
};
class MockMutationObserver {
    constructor(callback) { this.callback = callback; this.target = null; mutationObservers.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.target = null; }
    trigger(mutations = [{ type: 'childList', target: chatRoot }]) { this.callback(mutations); }
}
globalThis.MutationObserver = MockMutationObserver;
let editorOverlay = null;
function getMessageElement(id) {
    if (!messageElements.has(id)) {
        const text = { insertAdjacentElement(_where, node) { if (!inlineAnchors.includes(node)) inlineAnchors.push(node); } };
        messageElements.set(id, {
            querySelector(selector) {
                if (selector === '.mes_text') return text;
                if (selector === '.meg-blocks') return meguminBlocks.get(id)?.card || null;
                return null;
            },
            appendChild(node) { if (!inlineAnchors.includes(node)) inlineAnchors.push(node); },
        });
    }
    return messageElements.get(id);
}
function emitDocumentEvent(name, event) {
    for (const fn of documentListeners.get(name) || []) fn(event);
}
globalThis.document = {
    body: { appendChild(node) { if (node?.id === 'npc_state_delta_editor_overlay') editorOverlay = node; if (node) node.isConnected = true; }, contains(node) { return Boolean(node?.isConnected); } },
    addEventListener(name, fn) {
        const list = documentListeners.get(name) || [];
        list.push(fn);
        documentListeners.set(name, list);
    },
    querySelector(selector) {
        if (selector === '#npc_state_delta_editor_overlay') return editorOverlay;
        if (selector === '#chat') return chatRoot;
        const match = String(selector).match(/\.mes\[(?:data-)?mesid=\"(\d+)\"\]/);
        return match && mockState.messageDomReady ? getMessageElement(Number(match[1])) : null;
    },
    querySelectorAll(selector) {
        if (selector === '.npc-state-delta-inline-anchor') return [...inlineAnchors];
        if (selector === '#chat .mes') return mockState.messageDomReady ? [...messageElements.values()] : [];
        if (String(selector).includes('npc-state-delta-megumin')) {
            return [...meguminBlocks.values()].flatMap(item => item.card.querySelectorAll(selector));
        }
        return [];
    },
    createElement(tag) { return makeMockDomNode(tag); },
    dispatchEvent(event) { emitDocumentEvent(event.type, event); return true; },
};

let mounted = false;
const uiHandlers = new Map();
const makeQuery = (selector) => {
    const isHost = selector === '#extensions_settings2';
    const isLegacyHost = selector === '#extensions_settings' || selector === '#extensionsMenu';
    const isPanel = selector === '#npc_state_delta_settings';
    const exists = selector === document || isHost || (mounted && !isLegacyHost) || (isPanel && mounted);
    const q = {
        length: exists ? 1 : 0,
        append(html) { if (String(html).includes('id="npc_state_delta_settings"')) mounted = true; return q; },
        off() { return q; },
        on(event, target, handler) {
            if (selector === document && typeof target === 'string' && typeof handler === 'function') uiHandlers.set(`${event}|${target}`, handler);
            return q;
        },
        prop() { return q; }, val() { return q; },
        html() { return q; }, toggleClass() { return q; }, text() { return q; }, attr() { return q; }, data() { return undefined; },
    };
    return q;
};
globalThis.$ = (selector) => {
    if (typeof selector === 'function') { queueMicrotask(() => selector()); return makeQuery(document); }
    return makeQuery(selector);
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function manualAddNpc(name) {
    const previous = globalThis.prompt;
    globalThis.prompt = () => name;
    try {
        const add = uiHandlers.get('click.npcStateDelta|#npc_state_delta_add_manual');
        assert.equal(typeof add, 'function', 'manual Add must be connected to the production settings handler');
        await add();
    } finally { globalThis.prompt = previous; }
}


try {
    await import(pathToFileURL(path.join(extRoot, 'index.js')).href + `?t=${Date.now()}`);
    await sleep(30);
    assert.equal(mounted, true, 'settings panel should mount');
    assert.equal(globalThis.NPCStateDelta?.version, JSON.parse(fs.readFileSync(path.join(sourceRoot, 'manifest.json'), 'utf8')).version);
    assert.ok(mockState.extensionSettings.npc_state_delta, 'settings namespace should initialize');
    assert.equal(mockState.extensionSettings.npc_state_delta.admissionMode, 'conservative');
    assert.equal(mockState.extensionSettings.npc_state_delta.chats, undefined, 'live NPC database should not be stored in extension_settings');
    assert.equal((mockState.listeners.get('message_sent') || []).length, 1);
    eventSource.emit('app_ready');
    eventSource.emit('extension_settings_loaded');
    await sleep(20);
    assert.equal((mockState.listeners.get('message_sent') || []).length, 1, 'lifecycle retries must not duplicate listeners');
    mockState.extensionSettings.npc_state_delta.relationshipBaseline = { trust: 0, affection: -12, desire: 0, tension: -7 };
    mockState.extensionSettings.npc_state_delta.relationshipCaps = { ordinary: 2, meaningful: 3, major: 9, extreme: 18 };
    mockState.extensionSettings.npc_state_delta.relationshipCriteria = 'Runtime custom relationship rubric.';
    mockState.extensionSettings.npc_state_delta.relationshipImpactCriteria = 'Runtime custom impact rubric.';
    mockState.extensionSettings.npc_state_delta.memoryCriteria = 'Runtime custom memory rubric.';
    mockState.extensionSettings.npc_state_delta.behaviorCriteria = 'Runtime custom behavior rubric.';

    // Removed text commands are inert. The retained settings Add creates an off-screen dossier.
    mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: '(OOC: NPC State Delta: add Yunyun)' });
    eventSource.emit('message_sent', 0);
    await sleep(20);
    assert.equal(globalThis.NPCStateDelta.processOoc, undefined, 'removed command API must not remain callable');
    assert.deepEqual(globalThis.NPCStateDelta.getState().npcs, [], 'OOC add must not mutate dossiers');
    assert.deepEqual(globalThis.NPCStateDelta.getState().pendingBackfills, [], 'OOC add must not enqueue a scan');
    assert.equal(mockState.rawCalls.length, 0, 'user text must not create model requests');
    await manualAddNpc('Yunyun');
    assert.deepEqual(globalThis.NPCStateDelta.getState().npcs.map(n => n.name), ['Yunyun']);
    assert.equal(inlineAnchors.length, 0, 'manual Add should not bypass presence gating');
    await globalThis.NPCStateDelta.flush();
    const pointer = globalThis.NPCStateDelta.dataFile();
    assert.ok(pointer?.path, 'chat state should be persisted to an extension-owned JSON sidecar file');
    assert.ok(mockState.files.has(pointer.path));
    const persistedAfterAdd = JSON.parse(mockState.files.get(pointer.path));
    assert.equal(persistedAfterAdd.state.npcs[0].name, 'Yunyun');
    assert.deepEqual(Object.keys(persistedAfterAdd.state.npcs[0].relationship).sort(), ['affection', 'desire', 'tension', 'trust']);
    assert.deepEqual(persistedAfterAdd.state.npcs[0].relationship, { trust: 0, affection: -12, desire: 0, tension: -7 }, 'manual Add should support a configured bipolar baseline');

    // Scanner admits proper/dossier-worthy NPCs and only renders the one actually present in the latest scene.
    mockState.quietResponder = async (args = {}) => {
        if (args.jsonSchema) return '{"npcs":[]}';
        return JSON.stringify({ npcs: [
            { name: 'Yunyun', present: true, role: 'adventurer', species: 'Crimson Demon', age: '18', appearance: 'Young woman with long dark brown hair, crimson eyes, a slim build, and a black-and-red adventurer outfit.', personality: 'proud but earnest', speech: 'formal when nervous', relationshipSummary: 'She is cautiously warming to Kazuma and beginning to trust him.', relationshipImpact: 'meaningful', relationshipDelta: { trust: 3, affection: 2, desire: 0, tension: 0 }, relationshipEvidence: { trust: 'Yunyun explicitly says she trusts Kazuma more.', affection: 'Yunyun explicitly says she is fond of Kazuma.', desire: '', tension: '' }, relationshipChangeReason: 'Yunyun tells Kazuma she trusts him more and is fond of him.', mannerisms: ['boasts when embarrassed'] },
            { name: 'Wiz', present: false, worldActive: true, role: 'shopkeeper', location: 'Wiz\'s shop', relationshipImpact: 'ordinary', relationshipDelta: { tension: -4 } },
        ] });
    };
    mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: 'Yunyun, a young woman with long dark brown hair and crimson eyes, waves awkwardly. She remains proud but earnest, shows dry humor with trusted companions, consistently uses proper titles with elders, and stays formal when nervous. Yunyun tells Kazuma she trusts him more, is fond of him, and feels attracted but tense. Wiz remains back at her shop.', swipe_id: 0 });
    eventSource.emit('message_received', 1);
    await sleep(320);
    let state = globalThis.NPCStateDelta.getState();
    assert.deepEqual(state.npcs.map(n => n.name).sort(), ['Wiz', 'Yunyun']);
    assert.equal(state.npcs.find(n => n.name === 'Yunyun').present, true);
    assert.ok(mockState.rawCalls.length >= 1, 'scanner should use generateRaw');
    assert.equal(mockState.quietCalls.length, 0, 'scanner must not use generateQuietPrompt or inherit chat context');
    const rawScanArgs = [...mockState.rawCalls].reverse().map(call => call?.[0] || {}).find(args => /isolated dossier scanner/i.test(String(args.systemPrompt || ''))) || {};
    assert.match(String(rawScanArgs.systemPrompt || ''), /isolated dossier scanner/i);
    assert.match(String(rawScanArgs.prompt || ''), /private NPC dossier scanner/i);
    assert.match(String(rawScanArgs.prompt || ''), /CONSERVATIVE:/i);
    assert.match(String(rawScanArgs.prompt || ''), /Runtime custom memory rubric/i, 'automatic scanner should receive the player memory criteria');
    assert.equal(rawScanArgs.responseLength, 1800);
    const scanMetrics = globalThis.NPCStateDelta.scanMetrics();
    assert.equal(scanMetrics.promptChars, String(rawScanArgs.prompt || '').length, 'scan telemetry should expose the actual compact prompt size');
    assert.ok(Number.isFinite(scanMetrics.durationMs) && scanMetrics.durationMs >= 0, 'scan telemetry should expose duration');
    assert.equal(scanMetrics.retried, false);
    assert.equal(scanMetrics.relationshipPass, false, 'a complete primary relationship decision should not pay for a second model call');
    assert.equal(scanMetrics.relationshipTargets, 0);
    const relationshipCallsAfterCompletePrimary = mockState.rawCalls.map(call => call?.[0] || {}).filter(args => /isolated relationship evaluator/i.test(String(args.systemPrompt || '')));
    assert.equal(relationshipCallsAfterCompletePrimary.length, 0, 'focused relationship generation is reserved for incomplete primary decisions');
    assert.equal(rawScanArgs.instructOverride, true);
    assert.equal(rawScanArgs.trimNames, false);
    assert.equal('jsonSchema' in rawScanArgs, false, 'raw scanner must not depend on provider structured-output schemas');
    assert.equal('quietPrompt' in rawScanArgs, false);
    const rawBackfillArgs = [...mockState.rawCalls].reverse().map(call => call?.[0] || {}).find(args => /backfill scanner/i.test(String(args.systemPrompt || ''))) || {};
    assert.match(String(rawBackfillArgs.prompt || ''), /targeted dossier backfill extractor/i);
    assert.match(String(rawBackfillArgs.prompt || ''), /Runtime custom memory rubric/i, 'targeted backfill should use the same memory criteria');
    assert.equal('jsonSchema' in rawBackfillArgs, false, 'backfill must not depend on provider structured-output schemas');
    assert.equal(rawBackfillArgs.responseLength, 3200);
    assert.equal(globalThis.NPCStateDelta.getState().pendingBackfills.length, 0, 'retained continuity backfill should be consumed after the next assistant reply');
    assert.equal(state.npcs.find(n => n.name === 'Yunyun').age, '18');
    assert.equal(state.npcs.find(n => n.name === 'Yunyun').species, 'Crimson Demon');
    assert.match(state.npcs.find(n => n.name === 'Yunyun').appearance, /crimson eyes/);
    assert.equal('thoughts' in state.npcs.find(n => n.name === 'Yunyun'), false);
    assert.equal(state.npcs.find(n => n.name === 'Wiz').present, false);
    assert.equal(state.npcs.find(n => n.name === 'Wiz').worldActive, true, 'World State-style off-screen activity should be tracked separately from presence');
    assert.equal(state.npcs.find(n => n.name === 'Yunyun').relationship.trust, 3, 'meaningful delta should respect configured cap of 3 from neutral zero');
    assert.equal(state.npcs.find(n => n.name === 'Yunyun').lastRelationshipChange.delta.trust, 3);
    assert.equal(state.npcs.find(n => n.name === 'Wiz').relationship.tension, -7, 'ungrounded non-zero Wiz delta must be rejected instead of accumulating silent relationship drift');
    const portraitPrompts = globalThis.NPCStateDelta.portraitPrompts('Yunyun');
    assert.match(portraitPrompts.positive, /fantasy anime character illustration/i, 'portrait builder should apply the configured global theme');
    assert.match(portraitPrompts.positive, /Crimson Demon/);
    assert.match(portraitPrompts.positive, /crimson eyes/);
    assert.doesNotMatch(portraitPrompts.positive, /proud but earnest/i, 'nonvisual Personality prose should not be dumped into portrait prompts');
    const generatedUrl = await globalThis.NPCStateDelta.generatePortraitUrl('Yunyun');
    assert.equal(generatedUrl, '/user/images/npc-state-delta-generated.png');
    assert.equal(mockState.slashCalls.length, 1, 'one portrait request should execute exactly one native ST slash command');
    const portraitCommand = String(mockState.slashCalls[0][0] || '');
    assert.match(portraitCommand, /^\/imagine\s/);
    assert.match(portraitCommand, /\bquiet=true\b/);
    assert.match(portraitCommand, /\bextend=false\b/, 'Delta portrait handoff must not let ST auto-extend/rewrite the grounded prompt');
    assert.match(portraitCommand, /\bedit=false\b/, 'Delta portrait handoff must not invoke ST prompt refinement');
    assert.match(portraitCommand, /\bgallery=false\b/);
    assert.match(portraitCommand, /negative="[^"]+/);
    assert.match(portraitCommand, /Crimson Demon/);
    assert.equal(mockState.context.chat.length, 2, 'quiet native portrait generation must not add a chat message in the runtime harness');
    assert.equal(inlineAnchors.length, 1, 'only the latest present-cast roster should mount');
    assert.match(inlineAnchors[0].innerHTML, /npc-state-delta-present-grid/);
    assert.match(inlineAnchors[0].innerHTML, /npc-state-delta-present-card/);
    assert.match(inlineAnchors[0].innerHTML, /Yunyun/);
    assert.doesNotMatch(inlineAnchors[0].innerHTML, />Wiz</);
    assert.match(inlineAnchors[0].innerHTML, /npc-state-delta-present-card-overlay/);
    assert.match(inlineAnchors[0].innerHTML, /<small>adventurer(?: · [^<]+)?<\/small>/i);
    assert.doesNotMatch(inlineAnchors[0].innerHTML, /T \+3 · A -9|npc-state-delta-present-card-relation/, 'gallery cards should keep relationship metrics in the launcher dossier');
    assert.doesNotMatch(inlineAnchors[0].innerHTML, /Desire|Mannerisms|Species \/ Race|Copy portrait prompts|Current thoughts|Thought basis/, 'portrait grid should stay compact; detailed fields belong in the launcher dossier');
    // Present-cast cards hand off to the launcher dossier (dossier-ui listens for this request).
    const presentYunyunId = state.npcs.find(n => n.name === 'Yunyun').id;
    const dossierRequests = [];
    document.addEventListener('npc-state-delta:open-dossier', event => { dossierRequests.push(event.detail.npcId); event.detail.handled = true; });
    assert.equal(globalThis.NPCStateDelta.openDossier('Yunyun'), true, 'present NPCs open the launcher dossier from the live dossier state');
    const presentCardTarget = { dataset: { npcId: presentYunyunId, messageId: '1' } };
    emitDocumentEvent('click', { type: 'click', target: { closest: selector => (selector.includes('npc-state-delta-present-card') ? presentCardTarget : null) }, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
    assert.deepEqual(dossierRequests, [presentYunyunId, presentYunyunId], 'API and card clicks request the same launcher dossier page');
    assert.equal(globalThis.NPCStateDelta.uiStatus().presentCastDisplay, 'full', 'Full cards remain the default in-chat display');
    assert.equal(globalThis.NPCStateDelta.openPortraitGenerator('Yunyun'), true, 'portrait generator API still opens directly');
    assert.equal(globalThis.NPCStateDelta.uiStatus().portraitGeneratorOpen, true);
    emitDocumentEvent('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
    assert.equal(globalThis.NPCStateDelta.uiStatus().portraitGeneratorOpen, false, 'Escape closes the portrait-generator layer');
    // Compact renders a one-line strip; Off removes the block and stops chat observation.
    mockState.extensionSettings.npc_state_delta.presentCastDisplay = 'compact';
    globalThis.NPCStateDelta.renderInline();
    assert.equal(inlineAnchors.length, 1);
    assert.match(inlineAnchors[0].innerHTML, /npc-state-delta-present-strip/);
    assert.match(inlineAnchors[0].innerHTML, /class="npc-state-delta-present-chip" data-npc-id="[^"]+"[^>]*aria-label="Open Yunyun dossier"/);
    assert.doesNotMatch(inlineAnchors[0].innerHTML, /npc-state-delta-present-grid/);
    mockState.extensionSettings.npc_state_delta.presentCastDisplay = 'off';
    globalThis.NPCStateDelta.render();
    globalThis.NPCStateDelta.renderInline();
    assert.equal(inlineAnchors.length, 0, 'Off removes the in-chat block');
    assert.equal(globalThis.NPCStateDelta.uiStatus().inlineObserver, false, 'Off stops observing host message redraws');
    assert.ok((globalThis.NPCStateDelta.getState().inlineCards || []).length > 0, 'inlineCards history is still retained while display is Off');
    mockState.extensionSettings.npc_state_delta.presentCastDisplay = 'full';
    globalThis.NPCStateDelta.render();
    globalThis.NPCStateDelta.renderInline();
    assert.equal(inlineAnchors.length, 1, 'switching back to Full remounts the block');
    assert.match(inlineAnchors[0].innerHTML, /npc-state-delta-present-grid/);

    // v0.2.23: portrait settings are an explicit transaction. A custom draft must not rely on
    // saveSettingsDebounced; Save calls the host persistence API and retains every parameter.
    const originalPortraitSettings = globalThis.NPCStateDelta.portraitSettings();
    const hostSavesBeforePortrait = mockState.saveSettingsCalls;
    assert.equal(await globalThis.NPCStateDelta.savePortraitSettings({
        portraitGenerationEnabled: true,
        portraitThemePreset: 'custom',
        portraitStylePositive: 'custom violet key visual, luminous eyes',
        portraitStyleNegative: 'watermark, text, malformed hands',
        portraitComposition: 'solo waist-up portrait, centered',
        portraitPromptFormat: 'tags',
        portraitUseMood: false,
        portraitUseLocation: true,
        portraitSaveToGallery: true,
    }), true);
    assert.equal(mockState.saveSettingsCalls, hostSavesBeforePortrait + 1, 'portrait Save must call the immediate host settings persistence API exactly once');
    const savedPortraitSettings = globalThis.NPCStateDelta.portraitSettings();
    assert.equal(savedPortraitSettings.portraitThemePreset, 'custom');
    assert.match(savedPortraitSettings.portraitStylePositive, /custom violet key visual/);
    assert.match(savedPortraitSettings.portraitStyleNegative, /malformed hands/);
    assert.equal(savedPortraitSettings.portraitComposition, 'solo waist-up portrait, centered');
    assert.equal(savedPortraitSettings.portraitPromptFormat, 'tags');
    assert.equal(savedPortraitSettings.portraitUseMood, false);
    assert.equal(savedPortraitSettings.portraitUseLocation, true);
    assert.equal(savedPortraitSettings.portraitSaveToGallery, true);
    assert.deepEqual(mockState.extensionSettings.npc_state_delta.portraitStylePositive, savedPortraitSettings.portraitStylePositive);
    assert.equal(savedPortraitSettings.portraitCustomPresets.length, 1);
    assert.equal(savedPortraitSettings.portraitCustomPresets[0].name, 'Custom 1');
    assert.match(savedPortraitSettings.portraitCustomPresets[0].positive, /custom violet key visual/);

    const firstCustom = savedPortraitSettings.portraitCustomPresets[0];
    const secondCustom = {
        id: 'custom-runtime-ink',
        name: 'Runtime Ink',
        positive: 'runtime inked fantasy portrait, sharp expressive eyes',
        negative: 'runtime blur, watermark',
        composition: 'runtime chest-up portrait',
        promptFormat: 'natural',
        useMood: true,
        useLocation: false,
    };
    assert.equal(await globalThis.NPCStateDelta.savePortraitSettings({
        ...savedPortraitSettings,
        portraitThemePreset: 'custom',
        portraitCustomPresetId: secondCustom.id,
        portraitCustomPresets: [firstCustom, secondCustom],
        portraitStylePositive: secondCustom.positive,
        portraitStyleNegative: secondCustom.negative,
        portraitComposition: secondCustom.composition,
        portraitPromptFormat: secondCustom.promptFormat,
        portraitUseMood: secondCustom.useMood,
        portraitUseLocation: secondCustom.useLocation,
        portraitSaveToGallery: false,
    }), true);
    const libraryPortraitSettings = globalThis.NPCStateDelta.portraitSettings();
    assert.equal(libraryPortraitSettings.portraitCustomPresets.length, 2);
    assert.equal(libraryPortraitSettings.portraitCustomPresetId, secondCustom.id);
    assert.equal(libraryPortraitSettings.portraitCustomPresets[1].name, 'Runtime Ink');
    assert.equal(libraryPortraitSettings.portraitComposition, secondCustom.composition);
    assert.equal(libraryPortraitSettings.portraitPromptFormat, secondCustom.promptFormat);
    const libraryPrompt = globalThis.NPCStateDelta.portraitPrompts('Yunyun');
    assert.match(libraryPrompt.positive, /runtime inked fantasy portrait/i, 'active named custom preset should feed the live portrait prompt builder');
    assert.doesNotMatch(libraryPrompt.negative, /malformed hands/i, 'switching named presets must not leak the prior custom negative prompt');

    await globalThis.NPCStateDelta.savePortraitSettings(originalPortraitSettings);

    const yunyunProfileId = state.npcs.find(n => n.name === 'Yunyun').id;
    const wizProfileId = state.npcs.find(n => n.name === 'Wiz').id;
    mockState.quietResponder = async () => JSON.stringify({
        npcs: [
            { id: yunyunProfileId, present: true, worldActive: false, relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 } },
            { id: wizProfileId, present: false, worldActive: true, location: "Wiz's shop", relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 } },
        ],
        profileUpdates: [{
            id: yunyunProfileId,
            evidence: { personality: ['Shows dry humor with trusted companions.'], speech: ['Consistently uses proper titles with elders.'] },
            personalityState: 'refine',
            personality: 'proud but earnest; dryly humorous with trusted companions.',
            speechState: 'refine',
            speech: 'formal when nervous; consistently uses proper titles with elders.',
        }],
    });
    await globalThis.NPCStateDelta.scan();
    await sleep(80);
    state = globalThis.NPCStateDelta.getState();
    assert.match(state.npcs.find(n => n.name === 'Yunyun').personality, /dryly humorous/i, 'top-level profileUpdates should refine Personality through the live scan path');
    assert.match(state.npcs.find(n => n.name === 'Yunyun').speech, /proper titles/i, 'top-level profileUpdates should refine Speech through the live scan path');
    const profileMetrics = globalThis.NPCStateDelta.scanMetrics();
    assert.equal(profileMetrics.profileUpdates, 1);
    assert.equal(profileMetrics.profileApplied, 1);

    const meguminBlock = createMockMeguminBlock();
    meguminBlocks.set(1, meguminBlock);
    eventSource.emit('character_message_rendered', 1);
    await sleep(80);
    assert.equal(inlineAnchors.some(anchor => anchor.dataset.npcStateDeltaMessageId === '1'), false, 'Megumin-integrated message must not keep a duplicate standalone dossier anchor');
    const integratedTab = meguminBlock.card.querySelector('.npc-state-delta-megumin-tab');
    const integratedPane = meguminBlock.card.querySelector('.npc-state-delta-megumin-pane');
    assert.ok(integratedTab, 'NPC State Delta tab should be inserted into Megumin master block');
    assert.ok(integratedPane, 'NPC State Delta pane should be inserted into Megumin master block');
    assert.match(integratedPane.innerHTML, /Yunyun/);
    assert.equal(globalThis.NPCStateDelta.uiStatus().integratedMeguminBlocks, 1);
    integratedTab.click();
    assert.equal(integratedPane.style.display, '', 'clicking NPC State Delta tab should show its pane');
    assert.equal(meguminBlock.panel.style.display, '', 'clicking NPC State Delta tab should explicitly reopen the shared Megumin panel');
    assert.equal(meguminBlock.nativePane.style.display, 'none', 'clicking NPC State Delta tab should hide native Megumin panes');
    assert.equal(meguminBlock.current(), null, 'opening NPC State Delta should synchronize Megumin private selection to null');
    assert.equal(integratedPane.dataset.key, integratedTab.dataset.key, 'foreign Megumin integrations should be able to restore NPC State Delta by the same tab/pane key');

    integratedTab.click();
    assert.equal(meguminBlock.card.classList.contains('meg-blocks-shut'), true, 'clicking the active NPC State Delta tab again should collapse the master card like a native tab');
    assert.equal(integratedPane.style.display, 'none', 'collapsing NPC State Delta should hide its pane');
    assert.equal(integratedTab.classList.contains('active'), false, 'collapsing NPC State Delta should clear its active tab state');
    meguminBlock.nativeTab.click();
    assert.equal(meguminBlock.card.classList.contains('meg-blocks-shut'), false, 'a native Megumin tab should reopen in one click after NPC State Delta collapses');
    assert.equal(meguminBlock.nativePane.style.display, '', 'native Megumin pane should reopen in that same click');

    integratedTab.click();
    assert.equal(integratedPane.style.display, '', 'NPC State Delta should reopen from a native Megumin pane');
    assert.equal(meguminBlock.current(), null, 'reopening NPC State Delta should reset the native selected-key closure again');
    meguminBlock.nativeTab.click();
    assert.equal(meguminBlock.card.classList.contains('meg-blocks-shut'), false, 'switching directly from NPC State Delta to the prior native tab must open it, not close it');
    assert.equal(meguminBlock.nativePane.style.display, '', 'switching from NPC State Delta should show the native pane on the first click');
    assert.equal(integratedPane.style.display, 'none', 'switching to a native Megumin tab should dismiss the NPC State Delta pane');

    integratedTab.click();
    const openedSnapshotHtml = integratedPane.innerHTML.replace('<details ', '<details open ');
    integratedPane.innerHTML = openedSnapshotHtml;
    globalThis.NPCStateDelta.renderInline();
    assert.equal(integratedPane.innerHTML, openedSnapshotHtml, 'repair renders must not replace unchanged pane HTML and collapse an opened NPC dossier');
    meguminBlock.nativeTab.click();
    assert.equal(integratedPane.style.display, 'none', 'choosing a native Megumin tab should dismiss the NPC State Delta pane');
    meguminBlocks.delete(1);
    eventSource.emit('message_updated', 1);
    await sleep(90);
    assert.equal(inlineAnchors.some(anchor => anchor.dataset.npcStateDeltaMessageId === '1'), true, 'standalone dossier should return when no compatible Megumin card is present');

    const yunyunBeforeRepair = state.npcs.find(n => n.name === 'Yunyun');
    const wizBeforeRepair = state.npcs.find(n => n.name === 'Wiz');
    const trustBeforeRepair = yunyunBeforeRepair.relationship.trust;
    mockState.context.chat[1].mes += ' Kazuma deliberately reveals Yunyun\'s private confidence to the guild, a severe betrayal that shatters Yunyun\'s confidence in him.';
    mockState.quietResponder = async (args = {}) => {
        const systemPrompt = String(args.systemPrompt || '');
        if (/isolated relationship evaluator/i.test(systemPrompt)) {
            return JSON.stringify({ npcs: [
                { id: yunyunBeforeRepair.id, relationshipImpact: 'major', relationshipDelta: { trust: -99, affection: -99, desire: 0, tension: 99 }, relationshipEvidence: { trust: 'Kazuma exposed Yunyun\'s private confidence, betraying her trust.', affection: 'The betrayal deeply hurt Yunyun and damaged her warmth toward Kazuma.', desire: '', tension: 'The public betrayal created severe unresolved conflict and tension.' }, relationshipSummary: 'She feels deeply betrayed by Kazuma and no longer trusts him, while their former warmth now leaves her hurt and conflicted.', relationshipChangeReason: 'Kazuma reveals Yunyun\'s private confidence to the guild, a severe betrayal that shatters her confidence in him.' },
                { id: wizBeforeRepair.id, relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 }, relationshipSummary: wizBeforeRepair.relationshipSummary || '', relationshipChangeReason: '' },
            ] });
        }
        return JSON.stringify({ npcs: [
            { id: yunyunBeforeRepair.id, present: true, worldActive: false, mood: 'shaken', relationshipSummary: 'She still regards Kazuma as a cautiously trusted companion.' },
            { id: wizBeforeRepair.id, present: false, worldActive: true, location: 'Wiz\'s shop' },
        ] });
    };
    await globalThis.NPCStateDelta.scan();
    await sleep(80);
    state = globalThis.NPCStateDelta.getState();
    const repairedYunyun = state.npcs.find(n => n.name === 'Yunyun');
    assert.equal(repairedYunyun.relationship.trust, trustBeforeRepair - 9, 'focused major delta should apply the configured major cap even when primary scanner omitted relationshipDelta');
    assert.equal(repairedYunyun.lastRelationshipChange.impact, 'major');
    assert.equal(repairedYunyun.lastRelationshipChange.delta.trust, -9);
    assert.match(repairedYunyun.lastRelationshipChange.reason, /severe betrayal/i);
    assert.match(repairedYunyun.relationshipSummary, /deeply betrayed/i, 'focused major relationship evaluation must update the dossier Relationship prose field');
    assert.doesNotMatch(repairedYunyun.relationshipSummary, /cautiously trusted companion/i, 'stale primary-scanner relationshipSummary must not override the focused semantic decision');
    const betrayalSummary = repairedYunyun.relationshipSummary;
    const repairMetrics = globalThis.NPCStateDelta.scanMetrics();
    assert.equal(repairMetrics.relationshipPass, true);
    assert.equal(repairMetrics.relationshipTargets, 2);

    mockState.quietResponder = async (args = {}) => {
        const systemPrompt = String(args.systemPrompt || '');
        if (/isolated relationship evaluator/i.test(systemPrompt)) {
            return JSON.stringify({ npcs: [
                { id: yunyunBeforeRepair.id, relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 }, relationshipSummary: betrayalSummary, relationshipChangeReason: '' },
            ] });
        }
        return JSON.stringify({ npcs: [
            { id: yunyunBeforeRepair.id, present: true, worldActive: false, mood: 'quiet', relationshipSummary: 'A stylistic primary-scanner rewrite that should not replace the focused decision.' },
        ] });
    };
    await globalThis.NPCStateDelta.scan();
    await sleep(80);
    state = globalThis.NPCStateDelta.getState();
    assert.equal(state.npcs.find(n => n.name === 'Yunyun').relationshipSummary, betrayalSummary, 'routine focused evaluation should preserve an accurate relationship summary exactly');

    const beforeFallbackSummary = state.npcs.find(n => n.name === 'Yunyun').relationshipSummary;
    mockState.context.chat[1].mes += ' Immediately after the betrayal, Kazuma risks his life to save Yunyun, forcing her to profoundly reassess him.';
    mockState.quietResponder = async (args = {}) => {
        const systemPrompt = String(args.systemPrompt || '');
        if (/isolated relationship evaluator/i.test(systemPrompt)) {
            return JSON.stringify({ npcs: [
                { id: yunyunBeforeRepair.id, relationshipImpact: 'extreme', relationshipDelta: { trust: 18, affection: 0, desire: 0, tension: 0 }, relationshipEvidence: { trust: 'Kazuma risked his life to save Yunyun, forcing her to reassess whether she can trust him.', affection: '', desire: '', tension: '' }, relationshipChangeReason: 'Kazuma risked his life to save Yunyun immediately after the betrayal, forcing a profound reassessment.' },
            ] });
        }
        return JSON.stringify({ npcs: [
            { id: yunyunBeforeRepair.id, present: true, worldActive: false, relationshipSummary: beforeFallbackSummary },
        ] });
    };
    await globalThis.NPCStateDelta.scan();
    await sleep(80);
    state = globalThis.NPCStateDelta.getState();
    const fallbackYunyun = state.npcs.find(n => n.name === 'Yunyun');
    assert.notEqual(fallbackYunyun.relationshipSummary, beforeFallbackSummary, 'major/extreme missing-summary output must not leave stale Relationship prose untouched');
    assert.match(fallbackYunyun.relationshipSummary, /risked his life to save Yunyun/i);

    const yunyunForEditor = state.npcs.find(n => n.name === 'Yunyun');
    const fakeRosterButton = {
        dataset: { npcId: yunyunForEditor.id },
        matches(selector) { return String(selector).includes('.npc-state-delta-roster-edit'); },
        closest(selector) { return this.matches(selector) ? this : null; },
    };
    emitDocumentEvent('pointerup', {
        type: 'pointerup',
        target: fakeRosterButton,
        composedPath: () => [fakeRosterButton],
        preventDefault() {},
        stopImmediatePropagation() {},
        stopPropagation() {},
    });
    await sleep(30);
    assert.equal(globalThis.NPCStateDelta.uiStatus().editorMounted, true, 'pointerup roster edit should mount the dossier editor');
    assert.equal(globalThis.NPCStateDelta.uiStatus().editorMode, 'sillytavern-popup');
    assert.equal(mockState.popupCalls.at(-1)?.options?.large, true);
    assert.equal(mockState.popupCalls.at(-1)?.options?.allowVerticalScrolling, true);
    const livePrompt = [...mockState.prompts].reverse().find(args => String(args?.[1] || '').includes('NPC STATE DELTA DOSSIER'))?.[1] || '';
    assert.match(livePrompt, /Runtime custom behavior rubric/);
    assert.match(livePrompt, /species\/race: Crimson Demon/);
    assert.match(livePrompt, /age: 18/);
    assert.doesNotMatch(livePrompt, /current thoughts/i);
    assert.match(livePrompt, /personality: proud but earnest/);
    assert.match(livePrompt, /established speech: formal when nervous/);
    assert.match(livePrompt, /PLAYER RELATIONSHIP \(secondary modifier\):/);
    assert.match(livePrompt, /Yunyun/);
    assert.doesNotMatch(livePrompt, /- Wiz:/, 'off-screen NPC must not be injected into generation');

    mockState.quietResponder = async () => JSON.stringify({ npcs: [
        { name: 'Yunyun', present: false, location: 'Axel guild' },
        { name: 'Wiz', present: true, mood: 'concerned', location: 'Wiz\'s shop' },
    ] });
    mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: 'At Wiz\'s shop, Wiz looks up from the counter.', swipe_id: 0 });
    eventSource.emit('message_received', 2);
    await sleep(320);
    state = globalThis.NPCStateDelta.getState();
    assert.equal(state.npcs.find(n => n.name === 'Yunyun').present, false);
    assert.equal(state.npcs.find(n => n.name === 'Wiz').present, true);
    assert.equal(inlineAnchors.length, 1, 'only the latest scene should keep a visible present-cast roster');
    assert.equal(inlineAnchors[0].dataset.npcStateDeltaMessageId, '2');
    assert.match(inlineAnchors[0].innerHTML, /Wiz/);
    assert.doesNotMatch(inlineAnchors[0].innerHTML, /Yunyun/);

    mockState.context.chat.length = 2;
    eventSource.emit('message_deleted', 2);
    await sleep(320);
    state = globalThis.NPCStateDelta.getState();
    assert.equal(state.npcs.find(n => n.name === 'Yunyun').present, true);
    assert.equal(state.npcs.find(n => n.name === 'Yunyun').age, '18');
    assert.equal(state.npcs.find(n => n.name === 'Yunyun').species, 'Crimson Demon');
    assert.match(state.npcs.find(n => n.name === 'Yunyun').appearance, /crimson eyes/);
    assert.equal('thoughts' in state.npcs.find(n => n.name === 'Yunyun'), false);
    assert.equal(state.npcs.find(n => n.name === 'Wiz').present, false);
    assert.equal(state.inlineCards.some(entry => entry.messageId === 2), false, 'linear delete must discard the deleted continuation instead of retaining it as a sibling branch');
    const deleteReconcile = globalThis.NPCStateDelta.uiStatus().branchReconciliations.at(-1);
    assert.equal(deleteReconcile?.operation, 'delete');
    assert.equal(deleteReconcile?.linearHistoryPruned, true);
    assert.equal(deleteReconcile?.restoredFromRoot, false, 'ordinary delete must never fall back to the branch root');
    assert.equal(inlineAnchors.length, 1, 'rollback should remount one live present-cast roster');
    assert.equal(inlineAnchors[0].dataset.npcStateDeltaMessageId, '1');
    assert.match(inlineAnchors[0].innerHTML, /Yunyun/);

    const wizIdForDelete = state.npcs.find(n => n.name === 'Wiz').id;
    assert.equal(await globalThis.NPCStateDelta.deleteNpc(wizIdForDelete), true);
    state = globalThis.NPCStateDelta.getState();
    assert.equal(state.npcs.some(n => n.name === 'Wiz'), false);
    assert.ok(state.userDismissedGroups.some(group => group.ids?.includes(wizIdForDelete)), 'settings delete should suppress immediate scanner rediscovery by stable ID');
    assert.ok(!state.dismissed.includes('wiz'), 'modern ID tombstones must not globally suppress future same-name NPCs');

    const yunyunId = state.npcs.find(n => n.name === 'Yunyun').id;
    assert.equal(await globalThis.NPCStateDelta.archive(yunyunId), true);
    state = globalThis.NPCStateDelta.getState();
    assert.equal(state.npcs.find(n => n.name === 'Yunyun').archived, true);
    assert.equal(state.npcs.find(n => n.name === 'Yunyun').present, false);
    const promptAfterArchive = [...mockState.prompts].reverse().find(args => args?.[0] === 'npc_state_delta_live_dossier')?.[1] || '';
    assert.doesNotMatch(promptAfterArchive, /- Yunyun:/);
    assert.equal(await globalThis.NPCStateDelta.restore(yunyunId), true);
    state = globalThis.NPCStateDelta.getState();
    assert.equal(state.npcs.find(n => n.name === 'Yunyun').archived, false);

    let resolveStateStale;
    mockState.quietResponder = () => new Promise(resolve => { resolveStateStale = resolve; });
    const stateStaleScan = globalThis.NPCStateDelta.scan();
    await sleep(15);
    assert.equal(await globalThis.NPCStateDelta.archive(yunyunId), true);
    resolveStateStale(JSON.stringify({ npcs: [{ id: yunyunId, name: 'Yunyun', present: true, mood: 'STALE MODEL MOOD' }] }));
    await stateStaleScan;
    state = globalThis.NPCStateDelta.getState();
    assert.equal(state.npcs.find(n => n.id === yunyunId).archived, true, 'manual dossier mutation must win over an older in-flight scan');
    assert.notEqual(state.npcs.find(n => n.id === yunyunId).mood, 'STALE MODEL MOOD');
    assert.equal(await globalThis.NPCStateDelta.restore(yunyunId), true);

    let resolveQuiet;
    mockState.quietResponder = () => new Promise(resolve => { resolveQuiet = resolve; });
    const staleScan = globalThis.NPCStateDelta.scan();
    await sleep(15);
    mockState.context.chat[1] = { is_user: false, is_system: false, name: 'Megumin', mes: 'A different branch entirely.', swipe_id: 1 };
    resolveQuiet('{"npcs":[{"name":"Luna","present":true}]}');
    await staleScan;
    assert.equal(globalThis.NPCStateDelta.getState().npcs.some(n => n.name === 'Luna'), false);

    mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: '(OOC: NPC State Delta: remove Yunyun)' });
    const beforeRemovedCommand = globalThis.NPCStateDelta.getState();
    const callsBeforeRemovedCommand = mockState.rawCalls.length;
    eventSource.emit('message_sent', 2);
    await sleep(30);
    assert.deepEqual(globalThis.NPCStateDelta.getState().npcs, beforeRemovedCommand.npcs, 'OOC remove cannot change dossiers or relationship history');
    assert.deepEqual(globalThis.NPCStateDelta.getState().dismissed, beforeRemovedCommand.dismissed, 'OOC remove cannot suppress rediscovery');
    assert.equal(mockState.rawCalls.length, callsBeforeRemovedCommand);
    assert.equal(await globalThis.NPCStateDelta.deleteNpc(yunyunId), true);
    assert.equal(globalThis.NPCStateDelta.getState().npcs.some(n => n.name === 'Yunyun'), false);
    assert.equal(globalThis.NPCStateDelta.getState().inlineCards.some(entry => entry.cards.some(card => card.name === 'Yunyun')), false);
    await globalThis.NPCStateDelta.flush();

    mockState.context.chat.push({
        is_user: false, is_system: false, name: 'Megumin', swipe_id: 0,
        mes: 'The two receptionists stack the forms. <details><summary>📌 <b>World State</b></summary><b>Myla (Senior Receptionist):</b> Working the Bluewatch guild desk, calm and methodical.<br><b>Toris (Receptionist):</b> Sorting contract ledgers beside her, tired but attentive.</details><details><summary>💭 <b>NPC Inner Chatter</b></summary>Myla: I need to finish the audit before noon.<br>Toris: I still have three ledgers to finish.</details>',
    });
    const backfillStoryId = mockState.context.chat.length - 1;
    mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'I ask the two receptionists about their work.' });
    eventSource.emit('message_sent', mockState.context.chat.length - 1);
    await sleep(20);
    await manualAddNpc('Myla');
    await manualAddNpc('Toris');
    mockState.quietResponder = async (args = {}) => {
        if (args.jsonSchema) return '{"npcs":[]}';
        const prompt = String(args.prompt || '');
        if (/targeted dossier backfill extractor/i.test(prompt) && /Requested NPC: Myla/i.test(prompt)) {
            assert.match(prompt, /World State:\s*Myla/i, 'Myla backfill prompt must preserve World State evidence');
            assert.match(prompt, /NPC Inner Chatter:.*Myla/i, 'Myla backfill prompt must preserve Inner Chatter evidence');
            return JSON.stringify({ npcs: [{
                name: 'Myla', role: 'Senior Receptionist', identityKind: 'proper_name', dossierSignal: 'incidental',
                location: 'Bluewatch guild desk', mood: 'calm and methodical', background: 'Works the Bluewatch guild desk.', present: true,
                relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 },
            }] });
        }
        if (/targeted dossier backfill extractor/i.test(prompt) && /Requested NPC: Toris/i.test(prompt)) {
            assert.match(prompt, /World State:.*Toris/i, 'Toris backfill prompt must preserve World State evidence');
            assert.match(prompt, /NPC Inner Chatter:.*Toris/i, 'Toris backfill prompt must preserve Inner Chatter evidence');
            return JSON.stringify({ npcs: [{
                name: 'Toris Vale', aliases: ['Toris'], role: 'Guild Receptionist', identityKind: 'proper_name', dossierSignal: 'incidental',
                location: 'Bluewatch guild desk', mood: 'tired but attentive', background: 'Works the Bluewatch guild desk.', present: true,
                relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 },
            }] });
        }
        return '{"npcs":[]}';
    };
    await globalThis.NPCStateDelta.scanDossier('Myla');
    await globalThis.NPCStateDelta.scanDossier('Toris');
    state = globalThis.NPCStateDelta.getState();
    const myla = state.npcs.find(n => n.name === 'Myla');
    const toris = state.npcs.find(n => n.name === 'Toris Vale');
    assert.ok(myla, 'first manual target should backfill');
    assert.ok(toris, 'second manual target should backfill');
    assert.equal(myla.role, 'Senior Receptionist');
    assert.equal(toris.role, 'Guild Receptionist');
    assert.equal(state.pendingBackfills.length, 0);
    const backfillInline = state.inlineCards.find(entry => entry.messageId === backfillStoryId);
    assert.ok(backfillInline, 'present manually backfilled NPCs should create an inline snapshot under the latest assistant scene');
    assert.deepEqual(backfillInline.cards.map(card => card.name).sort(), ['Myla', 'Toris Vale']);
    const latestBackfillCalls = mockState.rawCalls.filter(call => /targeted dossier backfill extractor/i.test(String(call?.[0]?.prompt || '')));
    assert.ok(latestBackfillCalls.length >= 2);
    assert.ok(latestBackfillCalls.every(call => !('jsonSchema' in (call?.[0] || {}))), 'real backfill calls should omit structured-output schemas');

    mockState.context.chat.push({
        is_user: false, is_system: false, name: 'Megumin', swipe_id: 0,
        mes: 'Neris, the guild records clerk, closes a ledger. <details><summary>📌 <b>World State</b></summary><b>Neris (Records Clerk):</b> At the Bluewatch guild archive desk, organizing contract files.</details>',
    });
    const truncStoryId = mockState.context.chat.length - 1;
    mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'I approach Neris at the archive desk.' });
    eventSource.emit('message_sent', mockState.context.chat.length - 1);
    await sleep(20);
    await manualAddNpc('Neris');
    let nerisBackfillAttempt = 0;
    mockState.quietResponder = async (args = {}) => {
        const prompt = String(args.prompt || '');
        if (/targeted dossier backfill extractor/i.test(prompt) && /Requested NPC: Neris/i.test(prompt)) {
            nerisBackfillAttempt += 1;
            if (nerisBackfillAttempt === 1) {
                return '{"npcs":[{"name":"Neris","role":"Records Clerk","appearance":"Young woman with dark';
            }
            assert.match(prompt, /CRITICAL COMPACT JSON RETRY/i, 'retry must explicitly request compact complete JSON');
            assert.equal(args.responseLength, 5200, 'truncation retry should receive a larger output ceiling');
            return JSON.stringify({ npcs: [{
                name: 'Neris', role: 'Records Clerk', identityKind: 'proper_name', dossierSignal: 'incidental',
                location: 'Bluewatch guild archive desk', appearance: 'Young woman working among the contract ledgers.',
                relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 },
            }] });
        }
        return '{"npcs":[]}';
    };
    const callsBeforeTruncationRetry = mockState.rawCalls.length;
    await globalThis.NPCStateDelta.scanDossier('Neris');
    state = globalThis.NPCStateDelta.getState();
    const neris = state.npcs.find(n => n.name === 'Neris');
    assert.ok(neris, 'truncated first backfill response should recover on retry');
    assert.equal(neris.role, 'Records Clerk');
    assert.equal(nerisBackfillAttempt, 2, 'backfill should retry exactly once after truncation');
    const retryCalls = mockState.rawCalls.slice(callsBeforeTruncationRetry).map(call => call?.[0] || {});
    assert.equal(retryCalls.length, 2, 'truncated backfill should use exactly two raw calls');
    assert.equal(retryCalls[0].responseLength, 3200);
    assert.equal(retryCalls[1].responseLength, 5200);

    let autoRetryAttempt = 0;
    mockState.quietResponder = async (args = {}) => {
        const prompt = String(args.prompt || '');
        if (/private NPC dossier scanner/i.test(prompt) && /Liora/i.test(prompt)) {
            autoRetryAttempt += 1;
            if (autoRetryAttempt === 1) return '{"npcs":[{"name":"Liora","identityKind":"proper_name","role":"Courier","appearance":"Red-haired';
            assert.match(prompt, /CRITICAL COMPACT JSON RETRY/i);
            assert.equal(args.responseLength, 5200);
            return JSON.stringify({ npcs: [{
                name: 'Liora', identityKind: 'proper_name', dossierSignal: 'incidental', role: 'Courier', present: true,
                appearance: 'Red-haired human courier in a rain-dark cloak.', relationshipImpact: 'none',
                relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 },
            }] });
        }
        return '{"npcs":[]}';
    };
    mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'I ask Liora the courier whether the northern road is open.' });
    mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', swipe_id: 0, mes: 'Liora shakes rain from her red hair and answers that the northern road is open.' });
    const autoRetryMessageId = mockState.context.chat.length - 1;
    await globalThis.NPCStateDelta.scan();
    state = globalThis.NPCStateDelta.getState();
    assert.ok(state.npcs.some(n => n.name === 'Liora'), 'Conservative scan should admit proper-name NPC after truncation retry');
    const lioraInline = state.inlineCards.find(entry => entry.messageId === autoRetryMessageId);
    assert.ok(lioraInline?.cards.some(card => card.name === 'Liora'), 'if merged state marks Liora present, the same scan must record her inline card');
    assert.equal(autoRetryAttempt, 2, 'automatic/manual scanner path should retry exactly once after truncation');

    const savedMiraFullScan = mockState.extensionSettings.npc_state_delta.fullScanEveryTurn;
    const savedMiraBaseline = structuredClone(mockState.extensionSettings.npc_state_delta.relationshipBaseline);
    mockState.extensionSettings.npc_state_delta.relationshipBaseline = { trust: 0, affection: 0, desire: 0, tension: 0 };
    mockState.extensionSettings.npc_state_delta.fullScanEveryTurn = true;
    mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', swipe_id: 0, mes: 'Earlier, Mira returned Kazuma\'s dropped purse untouched after finding it on the guild floor.' });
    mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'I invite Mira to share a bowl of stew with me and thank her for staying.' });
    mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', swipe_id: 0, mes: 'Mira accepts and stays to eat with Kazuma, lingering through an easy conversation before the bowls are cleared.' });
    const miraMessageId = mockState.context.chat.length - 1;
    let miraFullScanCalls = 0;
    let miraRelationshipCalls = 0;
    let miraBackfillCalls = 0;
    mockState.quietResponder = async (args = {}) => {
        const prompt = String(args.prompt || '');
        if (/private NPC dossier scanner/i.test(prompt) && /Mira/i.test(prompt)) {
            miraFullScanCalls += 1;
            return JSON.stringify({ npcs: [{
                name: 'Mira', identityKind: 'proper_name', dossierSignal: 'meaningful', present: true, role: 'Guild porter',
                relationshipImpact: 'major', relationshipDelta: { trust: 5, affection: 0, desire: 0, tension: 0 },
                relationshipEvidence: { trust: 'Earlier she returned his purse untouched.', affection: '', desire: '', tension: '' },
                relationshipChangeReason: 'Earlier Mira returned Kazuma\'s dropped purse untouched.',
            }] });
        }
        if (/focused relationship evaluator/i.test(prompt) && /Mira/i.test(prompt)) {
            miraRelationshipCalls += 1;
            assert.match(prompt, /Mira accepts and stays to eat with Kazuma/i, 'focused evaluator must receive the current exchange');
            const id = globalThis.NPCStateDelta.getState().npcs.find(n => n.name === 'Mira')?.id;
            return JSON.stringify({ npcs: [{
                id, name: 'Mira', relationshipImpact: 'ordinary',
                relationshipDelta: { trust: 0, affection: 1, desire: 0, tension: 0 },
                relationshipEvidence: { trust: '', affection: 'Mira accepts and stays to eat with Kazuma.', desire: '', tension: '' },
                relationshipSummary: 'Mira is beginning to enjoy Kazuma\'s company.',
                relationshipChangeReason: 'Mira accepts and stays to eat with Kazuma.',
            }] });
        }
        if (/targeted dossier backfill extractor/i.test(prompt) && /Requested NPC: Mira/i.test(prompt)) {
            miraBackfillCalls += 1;
            return JSON.stringify({ npcs: [{
                name: 'Mira', identityKind: 'proper_name', dossierSignal: 'meaningful', role: 'Guild porter',
                personality: 'Patient, observant, and quietly considerate.',
                speech: 'Brief, practical sentences with dry warmth.',
                background: 'Works around the guild floor handling loads and errands.',
                memories: [
                    'Returned Kazuma\'s dropped purse untouched.',
                    'Shared stew with Kazuma after he invited her to stay.',
                    'Helped sort a jammed delivery cart at the guild entrance.',
                    'Warned Kazuma that the north stair was slick after rain.',
                    'Remembered Kazuma\'s preferred table near the hearth.',
                ],
                memoryRetention: [
                    'Returned Kazuma\'s dropped purse untouched.',
                    'Shared stew with Kazuma after he invited her to stay.',
                    'Helped sort a jammed delivery cart at the guild entrance.',
                    'Warned Kazuma that the north stair was slick after rain.',
                    'Remembered Kazuma\'s preferred table near the hearth.',
                ],
                relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 },
            }] });
        }
        return '{"npcs":[]}';
    };
    eventSource.emit('message_received', miraMessageId);
    await sleep(320);
    state = globalThis.NPCStateDelta.getState();
    const mira = state.npcs.find(n => n.name === 'Mira');
    assert.ok(mira, 'automatic full-window scan should admit Mira');
    assert.equal(miraFullScanCalls, 1);
    assert.equal(miraRelationshipCalls, 1, 'new full-window NPC should get one current-exchange relationship pass');
    assert.equal(miraBackfillCalls, 1, 'new automatic dossier should get one targeted history backfill');
    assert.equal(mira.relationship.trust, 0, 'rolling-history trust must not replay into the new record');
    assert.equal(mira.relationship.affection, 1, 'fresh mundane low-band companionship should move affection');
    assert.equal(mira.memories.length, 5, 'automatic enrichment should curate the full retained memory set');
    assert.match(mira.personality, /Patient/i);
    assert.match(mira.speech, /dry warmth/i, 'targeted history enrichment should seed a blank durable voice without requiring adjective echo');
    assert.equal(mira.present, true, 'automatic historical enrichment must not erase the live presence established by the full scan');
    assert.equal(mira.seenCount, 1, 'automatic historical enrichment must not count as a second sighting in the same turn');
    assert.equal(state.pendingBackfills.some(item => item.npcId === mira.id), false);
    mockState.extensionSettings.npc_state_delta.relationshipBaseline = savedMiraBaseline;
    mockState.extensionSettings.npc_state_delta.fullScanEveryTurn = savedMiraFullScan;

    const savedCastFullScan = mockState.extensionSettings.npc_state_delta.fullScanEveryTurn;
    const savedCastDepth = mockState.extensionSettings.npc_state_delta.scanDepth;
    mockState.extensionSettings.npc_state_delta.fullScanEveryTurn = true;
    mockState.extensionSettings.npc_state_delta.scanDepth = 2;
    const miraBeforeCast = structuredClone(globalThis.NPCStateDelta.getState().npcs.find(n => n.name === 'Mira'));
    mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'I help Mira gather her scattered spell notes, then head across town to the apothecary.' });
    mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', swipe_id: 0, mes: 'Mira accepts the recovered notes with visible relief and thanks Kazuma for taking the time to help. Later, at the apothecary, a new clerk named Neri introduces herself and points out the herb shelves.' });
    const castSweepMessageId = mockState.context.chat.length - 1;
    let castBroadCalls = 0;
    let castRelationshipCalls = 0;
    let miraContinuityCalls = 0;
    let neriBackfillCalls = 0;
    mockState.quietResponder = async (args = {}) => {
        const prompt = String(args.prompt || '');
        if (/private NPC dossier scanner/i.test(prompt) && /Neri/i.test(prompt)) {
            castBroadCalls += 1;
            return JSON.stringify({ npcs: [{
                name: 'Neri', identityKind: 'proper_name', dossierSignal: 'meaningful', role: 'Apothecary clerk', present: true,
                relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 },
            }] });
        }
        if (/focused relationship evaluator/i.test(prompt)) {
            castRelationshipCalls += 1;
            const live = globalThis.NPCStateDelta.getState();
            const rows = [];
            for (const npc of live.npcs) {
                if (!prompt.includes(npc.name)) continue;
                const isMira = npc.name === 'Mira';
                rows.push({
                    id: npc.id, name: npc.name, relationshipImpact: isMira ? 'ordinary' : 'none',
                    relationshipDelta: { trust: isMira ? 1 : 0, affection: 0, desire: 0, tension: 0 },
                    relationshipEvidence: { trust: isMira ? 'Kazuma helped Mira gather her scattered spell notes.' : '', affection: '', desire: '', tension: '' },
                    relationshipChangeReason: isMira ? 'Kazuma helped Mira gather her scattered spell notes.' : '',
                    relationshipSummary: isMira ? 'Mira has another small reason to rely on Kazuma.' : '',
                });
            }
            return JSON.stringify({ npcs: rows });
        }
        if (/targeted dossier backfill extractor/i.test(prompt) && /Requested NPC: Mira/i.test(prompt)) {
            miraContinuityCalls += 1;
            const id = globalThis.NPCStateDelta.getState().npcs.find(n => n.name === 'Mira')?.id;
            return JSON.stringify({ npcs: [{
                id, name: 'Mira', memories: ['Kazuma helped recover her scattered spell notes before leaving for the apothecary.'],
                memoryRetention: ['Kazuma helped recover her scattered spell notes before leaving for the apothecary.'],
                relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 },
            }] });
        }
        if (/targeted dossier backfill extractor/i.test(prompt) && /^Requested NPC: Neri$/im.test(prompt)) {
            neriBackfillCalls += 1;
            const id = globalThis.NPCStateDelta.getState().npcs.find(n => n.name === 'Neri')?.id;
            return JSON.stringify({ npcs: [{
                id, name: 'Neri', role: 'Apothecary clerk', personality: 'Attentive and practical.', speech: 'Short professional explanations.',
                memories: ['First met Kazuma while showing him the apothecary herb shelves.'],
                memoryRetention: ['First met Kazuma while showing him the apothecary herb shelves.'],
                relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 },
            }] });
        }
        return '{"npcs":[]}';
    };
    eventSource.emit('message_received', castSweepMessageId);
    await sleep(520);
    state = globalThis.NPCStateDelta.getState();
    const miraAfterCast = state.npcs.find(n => n.name === 'Mira');
    const neri = state.npcs.find(n => n.name === 'Neri');
    assert.ok(neri, 'new ending-scene NPC should be admitted');
    assert.equal(castBroadCalls, 1, 'one full-window broad scan should discover the newcomer');
    assert.ok(castRelationshipCalls >= 1, 'current-exchange relationship reconciliation should run even though the broad scanner omitted Mira');
    assert.equal(miraAfterCast.relationship.trust, miraBeforeCast.relationship.trust + 1, 'Mira should gain the current-exchange trust point despite appearing before the scene transition');
    assert.ok(miraAfterCast.memories.some(item => /scattered spell notes/i.test(item)), 'omitted current participant should receive targeted important-memory repair');
    assert.equal(miraContinuityCalls, 1, 'cast sweep/participant repair should reconcile Mira exactly once');
    assert.equal(neriBackfillCalls, 1, 'new NPC should receive one targeted deep reconciliation');
    assert.equal(state.pendingBackfills.some(item => item.npcId === miraAfterCast.id || item.npcId === neri.id), false, 'successful cast reconciliation should drain the current Mira/Neri requests without deleting unrelated retry backlog');
    mockState.extensionSettings.npc_state_delta.fullScanEveryTurn = savedCastFullScan;
    mockState.extensionSettings.npc_state_delta.scanDepth = savedCastDepth;

    let malformedRetryAttempt = 0;
    mockState.quietResponder = async (args = {}) => {
        const prompt = String(args.prompt || '');
        if (/private NPC dossier scanner/i.test(prompt) && /Mave/i.test(prompt)) {
            malformedRetryAttempt += 1;
            if (malformedRetryAttempt === 1) return '{"npcs":[{"name":"Mave","identityKind":"proper_name","present":tru}]}';
            assert.match(prompt, /CRITICAL COMPACT JSON RETRY/i);
            assert.match(prompt, /previous response was not valid JSON/i);
            assert.equal(args.responseLength, 5200);
            return JSON.stringify({ npcs: [{
                name: 'Mave', identityKind: 'proper_name', dossierSignal: 'incidental', role: 'Stable Runner', present: true,
                relationshipImpact: 'none', relationshipDelta: {},
            }] });
        }
        return '{"npcs":[]}';
    };
    mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'I ask Mave whether the horses are ready.' });
    mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', swipe_id: 0, mes: 'Mave nods and checks the stable door.' });
    await globalThis.NPCStateDelta.scan();
    state = globalThis.NPCStateDelta.getState();
    assert.ok(state.npcs.some(n => n.name === 'Mave'), 'generic malformed JSON should recover through one correction retry');
    assert.equal(malformedRetryAttempt, 2, 'generic malformed scanner JSON should retry exactly once');

    mockState.quietResponder = async () => JSON.stringify({ npcs: [{
        name: 'Liora', id: globalThis.NPCStateDelta.getState().npcs.find(n => n.name === 'Liora')?.id, present: true, role: 'Courier',
        identityKind: 'proper_name', dossierSignal: 'incidental', relationshipImpact: 'none',
        relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 },
    }] });
    mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'I nod to Liora again.' });
    mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', swipe_id: 0, mes: 'Liora waits beside the door.' });
    const lateDomMessageId = mockState.context.chat.length - 1;
    mockState.messageDomReady = false;
    await globalThis.NPCStateDelta.scan();
    state = globalThis.NPCStateDelta.getState();
    assert.ok(state.inlineCards.find(entry => entry.messageId === lateDomMessageId)?.cards.some(card => card.name === 'Liora'), 'scan should record card state even if DOM is late');
    assert.equal(inlineAnchors.some(anchor => anchor.dataset.npcStateDeltaMessageId === String(lateDomMessageId)), false, 'card cannot mount before host message DOM exists');
    mockState.messageDomReady = true;
    eventSource.emit('character_message_rendered', lateDomMessageId);
    await sleep(120);
    assert.equal(inlineAnchors.some(anchor => anchor.dataset.npcStateDeltaMessageId === String(lateDomMessageId)), true, 'render lifecycle event should mount delayed inline card');

    const redrawnAnchor = inlineAnchors.find(anchor => anchor.dataset.npcStateDeltaMessageId === String(lateDomMessageId));
    redrawnAnchor?.remove?.();
    assert.equal(inlineAnchors.some(anchor => anchor.dataset.npcStateDeltaMessageId === String(lateDomMessageId)), false, 'simulated host redraw should remove the card anchor');
    assert.ok(mutationObservers.some(observer => observer.target === chatRoot), 'inline MutationObserver should be attached to #chat');
    mutationObservers.find(observer => observer.target === chatRoot)?.trigger();
    await sleep(100);
    assert.equal(inlineAnchors.some(anchor => anchor.dataset.npcStateDeltaMessageId === String(lateDomMessageId)), true, 'chat mutation should self-heal a removed inline card');

    globalThis.NPCStateDelta.renderInline();
    globalThis.NPCStateDelta.renderInline();
    assert.equal(inlineAnchors.filter(anchor => anchor.dataset.npcStateDeltaMessageId === String(lateDomMessageId)).length, 1, 'inline reconciliation should never duplicate an existing card anchor');

    const rawCallsBeforeSwipe = mockState.rawCalls.length;
    const broadScansBeforeSwipe = mockState.rawCalls.filter(call => /isolated dossier scanner/i.test(String(call?.[0]?.systemPrompt || ''))).length;
    mockState.quietResponder = async () => '{"npcs":[]}';
    mockState.context.chat[lateDomMessageId] = {
        is_user: false, is_system: false, name: 'Megumin', swipe_id: 1,
        mes: 'On the alternate swipe, Liora steps away from the door and says nothing.',
    };
    mockState.swipeState = 'swiping';
    eventSource.emit('message_swiped', lateDomMessageId);
    await sleep(180);
    assert.equal(mockState.rawCalls.length, rawCallsBeforeSwipe, 'MESSAGE_SWIPED must never start dossier generation while host swipeState=swiping');
    assert.equal(globalThis.NPCStateDelta.uiStatus().swipeSettlementPending, true, 'swipe should be held for settled reconciliation');

    eventSource.emit('message_received', lateDomMessageId);
    await sleep(180);
    assert.equal(mockState.rawCalls.length, rawCallsBeforeSwipe, 'MESSAGE_RECEIVED during a swipe must not start dossier generation');

    mockState.swipeState = 'none';
    await sleep(420);
    const broadScansAfterSwipe = mockState.rawCalls.filter(call => /isolated dossier scanner/i.test(String(call?.[0]?.systemPrompt || ''))).length;
    assert.equal(broadScansAfterSwipe, broadScansBeforeSwipe + 1, 'settled replacement should receive exactly one deferred dossier scan even when that scan also needs focused relationship evaluation');
    assert.equal(globalThis.NPCStateDelta.uiStatus().swipeSettlementPending, false, 'settlement queue should clear after host swipe becomes idle');

    mockState.context.chat.push({
        is_user: false, is_system: false, name: 'Megumin', swipe_id: 0,
        mes: `<Blocks>\n<New_NPC name="Luna">\n**Name:** Luna | **Age:** 24\n**Role:** Guild archivist\n**Where to Find Them:** Bluewatch archive\n**Voice:** Clipped, formal, and precise.\n**Inner Circle:**\n* Mara — younger sister | fiercely protective\n* Dain — old rival | grudging respect\n**Read on the PC:** Wary but curious.\n</New_NPC>\n</Blocks>`,
    });
    const lunaDossierMessageId = mockState.context.chat.length - 1;
    mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'I read the archivist dossier.' });
    const lunaAddMessageId = mockState.context.chat.length - 1;
    eventSource.emit('message_sent', lunaAddMessageId);
    await sleep(20);
    await manualAddNpc('Luna');
    assert.ok(globalThis.NPCStateDelta.getState().npcs.some(n => n.name === 'Luna'));
    mockState.quietResponder = async (args = {}) => {
        const prompt = String(args.prompt || '');
        if (/explicit DOSSIER IMPORT/i.test(prompt) && /Requested NPC: Luna/i.test(prompt)) {
            assert.match(prompt, /<New_NPC name="Luna">/);
            assert.match(prompt, /Mara — younger sister/);
            assert.match(prompt, /Where to Find Them.*NOT current Location/i);
            assert.match(prompt, /Never invent numeric Trust\/Affection\/Desire\/Tension/i);
            return JSON.stringify({ npcs: [{
                name: 'Luna', age: '24', role: 'Guild archivist', speech: 'Clipped, formal, and precise.',
                keyRelationships: ['Mara — younger sister | fiercely protective', 'Dain — old rival | grudging respect'],
                relationshipSummary: 'Wary but curious about Kazuma.',
                relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 },
            }] });
        }
        return '{"npcs":[]}';
    };
    const relationshipBeforeLunaImport = { ...globalThis.NPCStateDelta.getState().npcs.find(n => n.name === 'Luna').relationship };
    const importedLuna = await globalThis.NPCStateDelta.scanDossier('Luna');
    assert.equal(importedLuna, true, 'per-NPC scanDossier should import matching Megumin dossier blocks');
    state = globalThis.NPCStateDelta.getState();
    const luna = state.npcs.find(n => n.name === 'Luna');
    assert.equal(luna.age, '24');
    assert.equal(luna.speech, 'Clipped, formal, and precise.');
    assert.deepEqual(luna.keyRelationships, ['Mara — younger sister | fiercely protective', 'Dain — old rival | grudging respect']);
    assert.equal(luna.location, '', 'Where to Find Them must not be misused as live Location');
    assert.deepEqual(luna.relationship, relationshipBeforeLunaImport, 'dossier import must not manufacture numeric player relationship changes');
    const dossierImportCalls = mockState.rawCalls.map(call => call?.[0] || {}).filter(args => /structured dossier importer/i.test(String(args.systemPrompt || '')));
    assert.ok(dossierImportCalls.length >= 1);
    assert.equal(dossierImportCalls.at(-1).responseLength, 3200);
    assert.equal('jsonSchema' in dossierImportCalls.at(-1), false);

    mockState.quietResponder = async () => '{"npcs":[]}';
    mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'Who is Tessa to Luna?' });
    mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', swipe_id: 0, mes: "Tessa is Luna's cousin. They grew up in neighboring households. Luna is reserved, shows dry humor with trusted colleagues, and consistently uses careful honorifics while speaking in a clipped, formal, precise manner." });
    await globalThis.NPCStateDelta.scan();
    state = globalThis.NPCStateDelta.getState();
    const lunaAfterExplicitTie = state.npcs.find(n => n.name === 'Luna');
    assert.ok(lunaAfterExplicitTie.keyRelationships.some(entry => /Tessa — cousin/i.test(entry)), 'explicit relationship statement must survive even when scanner JSON omits the NPC entirely');

    const lunaBeforeRefresh = structuredClone(globalThis.NPCStateDelta.getState().npcs.find(n => n.name === 'Luna'));
    mockState.quietResponder = async (args = {}) => {
        const prompt = String(args.prompt || '');
        if (/TARGETED REFRESH FROM CHAT/i.test(prompt) && /Target NPC: Luna/i.test(prompt)) {
            assert.match(prompt, /currentRelationship is READ-ONLY/i);
            assert.match(prompt, /Presence\/recency are owned by the live scanner/i);
            assert.match(prompt, /recent-story window/i);
            return JSON.stringify({
                npcs: [{
                    id: lunaBeforeRefresh.id, name: 'Luna', role: 'Senior guild archivist',
                    mood: 'Quietly focused', location: 'Bluewatch archive',
                    relationshipSummary: 'Wary but increasingly comfortable around Kazuma.',
                    relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 },
                    present: true, worldActive: true,
                }],
                profileUpdates: [{
                    id: lunaBeforeRefresh.id,
                    evidence: { speech: ['consistently uses careful honorifics'], personality: ['shows dry humor with trusted colleagues'] },
                    personalityState: 'refine', personality: 'Reserved; shows dry humor with trusted colleagues.',
                    speechState: 'refine', speech: 'Clipped, formal, and precise; consistently uses careful honorifics.',
                }],
                keyRelationshipEdges: [],
            });
        }
        return '{"npcs":[]}';
    };
    const refreshedLuna = await globalThis.NPCStateDelta.refreshFromChat('Luna');
    assert.equal(refreshedLuna, true, 'per-NPC Refresh from Chat should complete');
    state = globalThis.NPCStateDelta.getState();
    const lunaAfterRefresh = state.npcs.find(n => n.name === 'Luna');
    assert.match(lunaAfterRefresh.personality, /dry humor/i);
    assert.match(lunaAfterRefresh.speech, /honorifics/i);
    assert.equal(lunaAfterRefresh.role, 'Senior guild archivist');
    assert.equal(lunaAfterRefresh.mood, 'Quietly focused');
    assert.equal(lunaAfterRefresh.location, 'Bluewatch archive');
    assert.deepEqual(lunaAfterRefresh.relationship, lunaBeforeRefresh.relationship, 'history refresh must never replay numeric relationship deltas');
    assert.equal(lunaAfterRefresh.present, lunaBeforeRefresh.present, 'history refresh must preserve live presence');
    assert.equal(lunaAfterRefresh.worldActive, lunaBeforeRefresh.worldActive, 'history refresh must preserve current off-screen activity');
    assert.equal(lunaAfterRefresh.seenCount, lunaBeforeRefresh.seenCount, 'history refresh must not increment seen count');
    assert.equal(lunaAfterRefresh.lastSeenTurn, lunaBeforeRefresh.lastSeenTurn, 'history refresh must not rewrite recency');
    assert.equal(globalThis.NPCStateDelta.scanMetrics()?.label, 'targeted-refresh');

    mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'I close the archive register.' });
    const lunaRemoveMessageId = mockState.context.chat.length - 1;
    eventSource.emit('message_sent', lunaRemoveMessageId);
    await sleep(20);
    await globalThis.NPCStateDelta.deleteNpc(lunaAfterRefresh.id);
    assert.equal(globalThis.NPCStateDelta.getState().npcs.some(n => n.name === 'Luna'), false, 'test cleanup should remove imported Luna');
    assert.equal(globalThis.NPCStateDelta.getState().pendingBackfills.some(item => item.label === 'Luna'), false, 'manual removal should also clear queued backfill');

    mockState.extensionSettings.npc_state_delta.fullScanEveryTurn = true;
    mockState.extensionSettings.npc_state_delta.scanEvery = 20;
    mockState.extensionSettings.npc_state_delta.scanDepth = 4;
    const fullScanTarget = globalThis.NPCStateDelta.getState().npcs.find(n => !n.archived);
    assert.ok(fullScanTarget, 'runtime should retain at least one active dossier for full-scan validation');
    const relationshipBeforeFullScan = structuredClone(fullScanTarget.relationship);
    mockState.quietResponder = async (args = {}) => {
        if (/relationship evaluator/i.test(String(args.systemPrompt || ''))) {
            return JSON.stringify({ npcs: [{
                id: fullScanTarget.id,
                relationshipImpact: 'none',
                relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 },
                relationshipSummary: fullScanTarget.relationshipSummary || '',
                relationshipChangeReason: '',
            }] });
        }
        return JSON.stringify({ npcs: [{
            id: fullScanTarget.id, name: fullScanTarget.name, present: true,
            relationshipImpact: 'extreme', relationshipDelta: { trust: 25, affection: 25, desire: 25, tension: -25 },
            relationshipChangeReason: 'OLD WINDOW EVENT THAT MUST NOT REPLAY',
        }], profileUpdates: [], keyRelationshipEdges: [] });
    };
    mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'FULL-HISTORY-MARKER: The tracked NPC consistently uses ceremonial honorifics.' });
    mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: `${fullScanTarget.name} answers quietly.`, swipe_id: 0 });
    const firstFullScanMessageId = mockState.context.chat.length - 1;
    eventSource.emit('message_received', firstFullScanMessageId);
    await sleep(220);
    const callsAfterFirstFullScan = mockState.rawCalls.length;
    mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'What happens next?' });
    mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: `${fullScanTarget.name} waits beside the doorway.`, swipe_id: 0 });
    const secondFullScanMessageId = mockState.context.chat.length - 1;
    eventSource.emit('message_received', secondFullScanMessageId);
    await sleep(220);
    assert.ok(mockState.rawCalls.length > callsAfterFirstFullScan, 'full scan every turn should override a Scan every 20 cadence');
    const fullScanArgs = [...mockState.rawCalls].reverse().map(call => call?.[0] || {}).find(args => /automatic full dossier scan/i.test(String(args?.label || '')) || (/isolated dossier scanner/i.test(String(args.systemPrompt || '')) && /FULL-WINDOW RECONCILIATION/.test(String(args.prompt || '')))) || {};
    assert.equal(fullScanArgs.responseLength, 3200, 'full auto scan should receive the larger response budget');
    assert.match(String(fullScanArgs.prompt || ''), /FULL-HISTORY-MARKER/, 'full auto scan should retain earlier messages inside the configured history window');
    assert.match(String(fullScanArgs.prompt || ''), /CURRENT exchange \(authoritative for presence\/live state and numeric relationship deltas\)/);
    assert.match(String(fullScanArgs.prompt || ''), /Kazuma: What happens next\?[\s\S]*waits beside the doorway\./);
    assert.equal(globalThis.NPCStateDelta.scanMetrics()?.label, 'automatic-full');
    assert.deepEqual(globalThis.NPCStateDelta.getState().npcs.find(n => n.id === fullScanTarget.id).relationship, relationshipBeforeFullScan, 'full-window scans must not replay numeric relationship deltas from older history');
    assert.equal(globalThis.NPCStateDelta.scanMetrics()?.relationshipPass, true, 'full-window existing-NPC relationship scoring should be revalidated against only the current exchange');

    // Stages 5-7: exercise the production focused/Refresh/backfill paths, not facade-only calls.
    const savedReviewSettings = Object.fromEntries(['autoScan', 'autoArchiveDeaths', 'fullScanEveryTurn', 'relationshipBaseline']
        .map(key => [key, structuredClone(mockState.extensionSettings.npc_state_delta[key])]));
    Object.assign(mockState.extensionSettings.npc_state_delta, {
        autoScan: false, autoArchiveDeaths: false, fullScanEveryTurn: false,
        relationshipBaseline: { trust: 0, affection: 0, desire: 0, tension: 0 },
    });
    await manualAddNpc('Sentinel');
    const sentinelId = globalThis.NPCStateDelta.getState().npcs.find(npc => npc.name === 'Sentinel').id;
    mockState.context.chat.push({ is_user: true, name: 'Kazuma', mes: 'I introduce myself to Sentinel.' });
    mockState.context.chat.push({ is_user: false, name: 'Megumin', mes: 'Sentinel regards Kazuma as a new acquaintance.', swipe_id: 0 });
    const reviewZero = { trust: 0, affection: 0, desire: 0, tension: 0 };
    const reviewEvidence = { trust: '', affection: '', desire: '', tension: '' };
    mockState.quietResponder = async args => JSON.stringify({ npcs: [{
        id: sentinelId, name: 'Sentinel', present: true,
        ...(/relationship evaluator/i.test(args.systemPrompt) ? {
            relationshipDelta: reviewZero, relationshipEvidence: reviewEvidence,
            relationshipImpact: 'none', relationshipChangeReason: '',
            relationshipSummary: 'She regards Kazuma as a new acquaintance.',
        } : {}),
    }] });
    assert.equal(await globalThis.NPCStateDelta.scan(), true);
    let sentinel = globalThis.NPCStateDelta.getState().npcs.find(npc => npc.id === sentinelId);
    assert.deepEqual(sentinel.relationship, reviewZero);
    assert.equal(sentinel.relationshipSummary, 'She regards Kazuma as a new acquaintance.', 'focused zero decision may initialize an empty description just like the primary merge');
    assert.equal(sentinel.relationshipEventHistory.length, 0, 'description initialization does not invent a scoring event');
    assert.equal(sentinel.present, true);
    const sentinelBeforeDeath = structuredClone(sentinel);

    mockState.context.chat.push({ is_user: true, name: 'Kazuma', mes: 'I call the healer.' });
    mockState.context.chat.push({ is_user: false, name: 'Megumin', mes: 'The healer explicitly confirms Sentinel is dead.', swipe_id: 0 });
    mockState.quietResponder = async () => JSON.stringify({ npcs: [{
        id: sentinelId, name: 'Sentinel', lifeState: 'deceased', lifeStateCertainty: 'explicit',
        lifeStateReason: 'The healer explicitly confirms Sentinel is dead.', present: true, worldActive: true,
    }] });
    assert.equal(await globalThis.NPCStateDelta.refreshFromChat(sentinelId), true);
    let reviewState = globalThis.NPCStateDelta.getState();
    sentinel = reviewState.npcs.find(npc => npc.id === sentinelId);
    assert.equal(sentinel.archived, false, 'terminal safety cannot depend on the archive setting');
    assert.equal(sentinel.lifeState, 'deceased');
    assert.equal(sentinel.present, false);
    assert.equal(sentinel.worldActive, false);
    const deathCheckpoint = reviewState.checkpoints.at(-1);
    const checkpointSentinel = deathCheckpoint?.snapshot?.npcs?.find(npc => npc.id === sentinelId);
    assert.ok(checkpointSentinel, 'Refresh records a canonical source checkpoint');
    assert.equal(checkpointSentinel.present, false, 'checkpoint cannot capture restored pre-death presence');

    mockState.context.chat.push({ is_user: true, name: 'Kazuma', mes: 'I remember Sentinel.' });
    mockState.context.chat.push({ is_user: false, name: 'Megumin', mes: 'Sentinel supposedly returns and thanks Kazuma for a rescue.', swipe_id: 0 });
    const invalidRevival = { id: sentinelId, name: 'Sentinel', lifeState: 'alive', lifeStateCertainty: 'explicit',
        present: true, worldActive: true, relationshipSummary: 'She relies on Kazuma completely.',
        relationshipImpact: 'major', relationshipDelta: { ...reviewZero, trust: 5 },
        relationshipEvidence: { ...reviewEvidence, trust: 'Kazuma rescued Sentinel.' },
        relationshipChangeReason: 'Kazuma rescued Sentinel.',
    };
    const callsBeforeDeadScan = mockState.rawCalls.length;
    mockState.quietResponder = async () => JSON.stringify({ npcs: [invalidRevival] });
    assert.equal(await globalThis.NPCStateDelta.scan(), true);
    const deadScanCalls = mockState.rawCalls.slice(callsBeforeDeadScan).map(call => call[0]);
    assert.equal(deadScanCalls.some(args => /relationship evaluator/i.test(args.systemPrompt)), false, 'terminal target must not spend a focused relationship request');
    assert.equal(await globalThis.NPCStateDelta.refreshFromChat(sentinelId), true);
    assert.equal(await globalThis.NPCStateDelta.scanDossier(sentinelId), true, 'manual fallback backfill remains available for retained historical details');
    await globalThis.NPCStateDelta.flush();
    const terminalSaved = JSON.parse(mockState.files.get(globalThis.NPCStateDelta.dataFile().path)).state;
    const retainedSentinel = terminalSaved.npcs.find(npc => npc.id === sentinelId);
    for (const field of ['relationship', 'relationshipProgress', 'relationshipMilestones', 'relationshipEventHistory', 'relationshipSummary']) {
        assert.deepEqual(retainedSentinel[field], sentinelBeforeDeath[field], `automatic post-death ${field} must not advance`);
    }
    assert.equal(retainedSentinel.lifeState, 'deceased');
    assert.equal(retainedSentinel.present, false);
    assert.equal(retainedSentinel.worldActive, false);
    assert.equal(await globalThis.NPCStateDelta.restore(sentinelId), true, 'explicit manual correction remains usable');
    sentinel = globalThis.NPCStateDelta.getState().npcs.find(npc => npc.id === sentinelId);
    assert.equal(sentinel.lifeState, 'alive');
    assert.equal(sentinel.present, false);
    assert.ok(sentinel.deathCorrection);
    await globalThis.NPCStateDelta.deleteNpc(sentinelId);
    await globalThis.NPCStateDelta.flush();
    Object.assign(mockState.extensionSettings.npc_state_delta, savedReviewSettings);

    const persistenceTarget = globalThis.NPCStateDelta.getState().npcs.find(n => !n.archived);
    assert.ok(persistenceTarget, 'runtime should retain an NPC for persistence race validation');
    let releaseUpload;
    let markUploadEntered;
    const uploadEntered = new Promise(resolve => { markUploadEntered = resolve; });
    mockState.uploadBarrier = {
        entered: markUploadEntered,
        promise: new Promise(resolve => { releaseUpload = resolve; }),
    };
    const uploadsBeforeRace = mockState.uploadCalls;
    await globalThis.NPCStateDelta.archive(persistenceTarget.id);
    await uploadEntered;
    const racingFlush = globalThis.NPCStateDelta.flush();
    await globalThis.NPCStateDelta.restore(persistenceTarget.id);
    releaseUpload();
    await racingFlush;
    await globalThis.NPCStateDelta.flush();
    assert.ok(mockState.uploadCalls >= uploadsBeforeRace + 2, 'an in-flight critical mutation should produce a follow-up sidecar write');
    const racePointer = globalThis.NPCStateDelta.dataFile();
    const persistedAfterRace = JSON.parse(mockState.files.get(racePointer.path));
    assert.equal(persistedAfterRace.state.npcs.find(n => n.id === persistenceTarget.id).archived, false, 'latest in-memory state must win the write race');

    let releaseDeleteUpload;
    let markDeleteUploadEntered;
    const deleteUploadEntered = new Promise(resolve => { markDeleteUploadEntered = resolve; });
    mockState.uploadBarrier = {
        entered: markDeleteUploadEntered,
        promise: new Promise(resolve => { releaseDeleteUpload = resolve; }),
    };
    await globalThis.NPCStateDelta.archive(persistenceTarget.id);
    const pendingDeleteWrite = globalThis.NPCStateDelta.flush();
    await deleteUploadEntered;
    const deletedPointer = globalThis.NPCStateDelta.dataFile();
    mockState.hostChatsByAvatar.set('megumin.png', []);
    eventSource.emit('chat_deleted', 'smoke-chat');
    releaseDeleteUpload();
    await pendingDeleteWrite;
    await sleep(100);
    assert.equal(mockState.extensionSettings.npc_state_delta.dataFiles['chat:megumin.png:smoke-chat'], undefined);
    assert.equal(mockState.files.has(deletedPointer.path), false);

    mockState.context.groupId = 'party-1';
    mockState.context.chatId = 'group-chat-1';
    mockState.context.getCurrentChatId = () => 'group-chat-1';
    mockState.context.chat = [{ is_user: false, is_system: false, name: 'Megumin', mes: 'Group opening.' }, { is_user: true, is_system: false, name: 'Kazuma', mes: 'We enter together.' }];
    eventSource.emit('chat_changed');
    await sleep(80);
    assert.equal(globalThis.NPCStateDelta.uiStatus().chatKey, 'group:party-1:group-chat-1', 'group identity must include both group owner and active group chat id');

    mockState.context.groupId = null;
    mockState.context.characters = [{ name: 'Megumin', avatar: 'megumin.png' }, { name: 'Yunyun', avatar: 'yunyun.png' }];
    mockState.context.characterId = 0;
    mockState.context.chatId = 'shared-save';
    mockState.context.getCurrentChatId = () => 'shared-save';
    mockState.context.chat = [{ is_user: false, is_system: false, name: 'Megumin', mes: 'Same opening.' }, { is_user: true, is_system: false, name: 'Kazuma', mes: 'Same reply.' }];
    eventSource.emit('chat_changed');
    await sleep(80);
    const ownerAKey = globalThis.NPCStateDelta.uiStatus().chatKey;
    mockState.context.characterId = 1;
    eventSource.emit('chat_changed');
    await sleep(80);
    const ownerBKey = globalThis.NPCStateDelta.uiStatus().chatKey;
    assert.equal(ownerAKey, 'chat:megumin.png:shared-save');
    assert.equal(ownerBKey, 'chat:yunyun.png:shared-save');
    assert.notEqual(ownerAKey, ownerBKey);

    mockState.extensionSettings.npc_state_delta.dataFiles[ownerAKey] ||= { path: '/unused-owner-a' };
    mockState.extensionSettings.npc_state_delta.dataFiles[ownerBKey] ||= { path: '/unused-owner-b' };
    mockState.hostChatsByAvatar.set('megumin.png', []);
    mockState.hostChatsByAvatar.set('yunyun.png', [{ file_name: 'shared-save.jsonl' }]);
    const resolvedDeletedOwner = await globalThis.__NPCStateDeltaLifecycle.resolveDeletedKey('shared-save', 'chat', '');
    assert.equal(resolvedDeletedOwner, ownerAKey, 'host ownership should resolve exactly one removed same-filename owner');
    mockState.hostChatsByAvatar.set('megumin.png', [{ file_name: 'shared-save.jsonl' }]);
    const unresolvedWhenBothOwn = await globalThis.__NPCStateDeltaLifecycle.resolveDeletedKey('shared-save', 'chat', '');
    assert.equal(unresolvedWhenBothOwn, '', 'destructive lookup must fail closed when both owners still claim the filename');
    delete mockState.extensionSettings.npc_state_delta.dataFiles[ownerAKey];
    delete mockState.extensionSettings.npc_state_delta.dataFiles[ownerBKey];
    await sleep(120);

    console.log('Runtime smoke: file persistence, branch safety, OOC removal, chat cleanup, group ownership, and same-filename character isolation passed.');
} finally {
    delete globalThis.__npcMock;
    fs.rmSync(tempRoot, { recursive: true, force: true });
}
