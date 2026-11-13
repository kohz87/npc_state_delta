// Narrative lineage: message fingerprints, lineage keys and hidden-message key repair. A pure part of branch.js
// (same owner, moved without change); branch.js re-exports every public name it exported before. Never imports branch.js.

export let provenanceHint = Object.freeze({ mainChat: '', ownerScope: '', currentKey: '' });

export function setBranchProvenanceHint({ mainChat = '', ownerScope = '', currentKey = '' } = {}) {
    provenanceHint = Object.freeze({
        mainChat: String(mainChat || '').replace(/\.jsonl$/i, '').trim(),
        ownerScope: String(ownerScope || '').trim(),
        currentKey: String(currentKey || '').trim(),
    });
}

function fnv1a32(text, seed = 0x811c9dc5) {
    let hash = seed >>> 0;
    const input = String(text ?? '');
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
}

export function branchHash(text) {
    const input = String(text ?? '');
    return `${fnv1a32(input, 0x811c9dc5)}.${fnv1a32(input, 0x9e3779b9)}`;
}

function messageFingerprint(message = {}, system = false) {
    return branchHash(JSON.stringify({
        user: Boolean(message.is_user),
        system,
        text: String(message.mes || ''),
    }));
}

export function fingerprintMessage(message = {}) {
    noteMessageText(message);
    // Destructive lineage is narrative-content based. SillyTavern send dates, generation IDs,
    // swipe indexes, and speaker labels are mutable host metadata and never define durable state.
    // So is the system flag: hiding a message (MemoryBooks and similar extensions set is_system on
    // summarised messages) does not change what was said, and a lineage that followed the flag
    // invalidated every later checkpoint key whenever a message was hidden or unhidden. The flag is
    // therefore fixed in the hash, which keeps the value earlier versions stored for ordinary messages.
    return messageFingerprint(message, false);
}

// The value earlier versions stored for a message whose system flag was set (hidden or system).
export function legacySystemFingerprint(message = {}) {
    return messageFingerprint(message, true);
}

// Story Suite's own hidden blocks in a reply: the STORY_SUITE_V2 comment and Story Block's <Changes> family
// (Changes, Changes-assist, Changes-assist-next, -story, -cut, -echo). Taken out, what is left is the story text
// and any other extension's block (the hosted npc_state_delta one-pass block included).
const STORY_SUITE_COMMENT = /<!--\s*STORY_SUITE_V2\b[\s\S]*?-->/gi;
const STORY_SUITE_CHANGES = /<(Changes(?:-[a-z]+)*)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
export function stripStorySuiteBlocks(text) {
    return String(text ?? '').replace(STORY_SUITE_COMMENT, '').replace(STORY_SUITE_CHANGES, '').replace(/\s+$/, '');
}
// What is left of a reply once Story Suite's blocks are out, compared without line-ending style or trailing-space differences.
function storyTextOf(text) {
    return stripStorySuiteBlocks(text).replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '');
}
// The texts each message object has said, newest last. fingerprintMessage notes the text every time a lineage is computed (it runs at every
// receipt, load and event), so when a reply is edited in place its earlier texts are still known when the edit is reconciled. Several saves (or a
// block rewritten by its owner right after a save) can pass before the reconcile runs, so more than the last one is kept.
const seenText = new WeakMap();
const SEEN_TEXT_LIMIT = 8;
function noteMessageText(message) {
    if (!message || typeof message !== 'object') return;
    const mes = String(message.mes ?? '');
    const seen = seenText.get(message);
    if (!seen) seenText.set(message, { mes, past: [] });
    else if (seen.mes !== mes) { seen.past.push(seen.mes); if (seen.past.length > SEEN_TEXT_LIMIT) seen.past.shift(); seen.mes = mes; }
}

// True when the live chat differs from the stored lineage only in Story Suite's own hidden blocks: same length, at least one reply
// differs, and each differing reply has an earlier text (the one the stored lineage hashed) that is the same without them, line endings and
// trailing spaces aside. A reply whose earlier text is not known (a replaced message object, a first sight) is not proven, so it counts as a real edit.
export function onlyStorySuiteBlocksChanged(stored, chat) {
    const messages = Array.isArray(chat) ? chat : [];
    if (!Array.isArray(stored) || stored.length !== messages.length) return false;
    let changed = false;
    for (let i = 0; i < stored.length; i += 1) {
        const message = messages[i];
        if (stored[i] === fingerprintMessage(message)) continue;
        const past = seenText.get(message)?.past || [];
        const was = past.findLast(text => stored[i] === messageFingerprint({ is_user: message?.is_user, mes: text }, false));
        if (was == null || storyTextOf(was) !== storyTextOf(message?.mes)) return false;
        changed = true;
    }
    return changed;
}

// (EDITKEEP3) A real edit moved a reply to a new key and its block is no longer in its text (NSD removed it on receipt): the capture NSD kept for that
// same reply (same position, key before the edit, same parents) is applied again. `oldKeys`/`newKeys` are the lineage keys before and after the edit.
// Any other reply (a different parent, a swipe, another position) gets nothing.
export function priorCaptureFor(journal, messageId, oldKeys, newKeys) {
    if (!Array.isArray(journal) || !Number.isInteger(messageId) || messageId < 0 || !oldKeys?.[messageId] || !newKeys?.[messageId]) return null;
    if (messageId > 0 && oldKeys[messageId - 1] !== newKeys[messageId - 1]) return null;
    const entry = journal.find(item => item?.parsed && item.messageId === messageId && item.key === oldKeys[messageId]);
    return entry ? { parsed: structuredClone(entry.parsed), raw: '', watch: structuredClone(entry.watch || []), fills: structuredClone(entry.fills || {}), ...(entry.refreshes ? { refreshes: structuredClone(entry.refreshes) } : {}) } : null;
}
// Rewrites every stored lineage key from one lineage to another, in every persisted structure that
// carries one, so checkpoints, the rollback journal and inline cards keep matching the chat.
export function remapLineageKeys(state, fromLineage, toLineage) {
    const fromKeys = lineageCheckpointKeys(fromLineage);
    const toKeys = lineageCheckpointKeys(toLineage);
    const map = new Map();
    fromKeys.forEach((key, index) => { if (toKeys[index]) map.set(key, toKeys[index]); });
    const remap = value => (map.has(value) ? map.get(value) : value);
    for (const item of Array.isArray(state.checkpoints) ? state.checkpoints : []) {
        item.lineageKey = remap(item.lineageKey);
        item.parentLineageKey = remap(item.parentLineageKey);
        if (Number.isInteger(item.messageId) && toLineage[item.messageId] && map.has(fromKeys[item.messageId])) item.fingerprint = toLineage[item.messageId];
    }
    for (const entry of Array.isArray(state.rollbackJournal) ? state.rollbackJournal : []) {
        entry.lineageKey = remap(entry.lineageKey);
        entry.parentLineageKey = remap(entry.parentLineageKey);
    }
    if (state.rollbackHead && typeof state.rollbackHead === 'object') state.rollbackHead.lineageKey = remap(state.rollbackHead.lineageKey);
    // Reply-owned capture inputs (the one-pass block a reply carried) follow their reply to its new key.
    for (const entry of Array.isArray(state.captureJournal) ? state.captureJournal : []) if (entry) entry.key = remap(entry.key);
    for (const card of Array.isArray(state.inlineCards) ? state.inlineCards : []) {
        card.lineageKey = remap(card.lineageKey);
        if (Number.isInteger(card.messageId) && toLineage[card.messageId] && map.has(fromKeys[card.messageId])) card.fingerprint = toLineage[card.messageId];
    }
    state.lineage = toLineage;
    return state;
}

// State saved while a message was hidden (or that is system) recorded that message under the old,
// flag-sensitive hash. When the stored lineage differs from the chat only in such messages, adopt
// the flag-independent hash and rewrite the stored keys once; real content differences are left for
// ordinary reconciliation.
export function migrateLegacyLineage(state, chat) {
    const previous = Array.isArray(state?.lineage) ? state.lineage : [];
    const messages = Array.isArray(chat) ? chat : [];
    if (!previous.length || !messages.length) return false;
    const rebased = previous.slice();
    let changed = false;
    const limit = Math.min(previous.length, messages.length);
    for (let i = 0; i < limit; i += 1) {
        if (previous[i] === fingerprintMessage(messages[i])) continue;
        if (previous[i] === legacySystemFingerprint(messages[i])) {
            rebased[i] = fingerprintMessage(messages[i]);
            changed = true;
        }
    }
    if (changed) remapLineageKeys(state, previous, rebased);
    return repairHiddenEraKeys(state, messages) || changed;
}

const eraRepairSignatures = new WeakMap();
const ERA_REPAIR_CUT_LIMIT = 400;

// Memory extensions hide messages progressively, so history saved by earlier versions holds keys
// from several "eras", each chained through the old flag-sensitive hash of the messages hidden
// by then. Older hides come first, so an era is a prefix of the currently hidden messages: try
// each prefix as the set that carried the old hash, and rewrite any stored key that matches.
function repairHiddenEraKeys(state, messages) {
    const hidden = [];
    messages.forEach((message, index) => { if (message?.is_system) hidden.push(index); });
    if (!hidden.length) return false;
    const target = messages.map(fingerprintMessage);
    const targetKeys = lineageCheckpointKeys(target);
    const holders = [];
    const add = (holder, field, messageId) => {
        const key = holder?.[field];
        if (key && Number.isInteger(messageId) && messageId >= 0 && messageId < targetKeys.length && key !== targetKeys[messageId]) holders.push({ holder, field, messageId, key });
    };
    for (const item of Array.isArray(state.checkpoints) ? state.checkpoints : []) {
        add(item, 'lineageKey', item.messageId);
        add(item, 'parentLineageKey', item.messageId - 1);
    }
    for (const entry of Array.isArray(state.rollbackJournal) ? state.rollbackJournal : []) {
        add(entry, 'lineageKey', entry.messageId);
        add(entry, 'parentLineageKey', entry.messageId - 1);
    }
    if (state.rollbackHead && typeof state.rollbackHead === 'object') add(state.rollbackHead, 'lineageKey', state.rollbackHead.messageId);
    for (const card of Array.isArray(state.inlineCards) ? state.inlineCards : []) add(card, 'lineageKey', card.messageId);
    if (!holders.length) return false;
    const signature = `${messages.length}:${hidden.length}:${hidden[0]}:${hidden.at(-1)}:${holders.length}`;
    if (eraRepairSignatures.get(state) === signature) return false;
    eraRepairSignatures.set(state, signature);

    const wanted = new Set(holders.map(item => `${item.messageId}:${item.key}`));
    const maxId = Math.max(...holders.map(item => item.messageId));
    const legacy = new Map();
    const legacyAt = index => {
        if (!legacy.has(index)) legacy.set(index, legacySystemFingerprint(messages[index]));
        return legacy.get(index);
    };
    const step = Math.max(1, Math.ceil((hidden.length + 1) / ERA_REPAIR_CUT_LIMIT));
    const cuts = [];
    for (let cut = 0; cut <= hidden.length; cut += step) cuts.push(cut);
    if (cuts.at(-1) !== hidden.length) cuts.push(hidden.length);
    const found = new Map();
    for (const cut of cuts) {
        const legacySet = new Set(hidden.slice(0, cut));
        let parent = 'root';
        for (let index = 0; index <= maxId; index += 1) {
            parent = branchHash(`${parent}|${index}|${legacySet.has(index) ? legacyAt(index) : target[index]}`);
            const id = `${index}:${parent}`;
            if (wanted.has(id) && !found.has(id)) found.set(id, targetKeys[index]);
        }
    }
    let repaired = false;
    for (const item of holders) {
        const replacement = found.get(`${item.messageId}:${item.key}`);
        if (replacement) { item.holder[item.field] = replacement; repaired = true; }
    }
    return repaired;
}

export function chatLineage(chat = []) {
    return (Array.isArray(chat) ? chat : []).map(fingerprintMessage);
}

export function lineageCheckpointKeys(lineage = []) {
    const source = Array.isArray(lineage) ? lineage : [];
    const keys = [];
    let parent = 'root';
    for (let i = 0; i < source.length; i += 1) {
        parent = branchHash(`${parent}|${i}|${source[i]}`);
        keys.push(parent);
    }
    return keys;
}

export function lineageCheckpointKey(lineage = [], messageId = -1) {
    if (!Number.isInteger(messageId) || messageId < 0) return '';
    return lineageCheckpointKeys(lineage)[messageId] || '';
}
