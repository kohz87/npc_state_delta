/* NPC State Delta sidecar identity and names: this module instance's writer id, the FNV-1a path token,
   the deterministic data/recovery file names and recovery-generation counter. Moved out of storage.js
   as a factory so separately imported storage instances keep separate tab identities. Never imports
   storage.js. */
export function createStorageIdentity() {
    let recoveryGeneration = Date.now() * 1024;

    function nextRecoveryGeneration() {
        recoveryGeneration = Math.max(recoveryGeneration + 1, Date.now() * 1024);
        return recoveryGeneration;
    }

    const writerId = (() => {
        try { return globalThis.crypto?.randomUUID?.() || `npc-state-delta-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; }
        catch { return `npc-state-delta-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; }
    })();

    function fnv1a(text) {
        let hash = 0x811c9dc5;
        const input = String(text ?? '');
        for (let i = 0; i < input.length; i += 1) {
            hash ^= input.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        return hash.toString(36);
    }

    // This page session's writer identity, as stamped on every sidecar it writes.
    function currentWriterId() {
        return writerId;
    }

    function makeNpcStateDataFileName(chatKey) {
        const key = String(chatKey || 'chat');
        return `npc-state-delta-${fnv1a(key)}${fnv1a(`npc-state-delta\0${[...key].reverse().join('')}`)}.json`;
    }

    function makeNpcStateRecoveryFileName(chatKey, generation = nextRecoveryGeneration()) {
        const key = String(chatKey || 'chat');
        const stamp = Math.max(0, Number(generation) || Date.now()).toString(36);
        const writerText = String(writerId || 'writer');
        const writerToken = `${fnv1a(writerText)}${fnv1a([...writerText].reverse().join(''))}`;
        return `npc-state-delta-recovery-${fnv1a(key)}${fnv1a(`npc-state-delta-recovery\0${[...key].reverse().join('')}`)}-${stamp}-${writerToken}.json`;
    }

    return { currentWriterId, fnv1a, makeNpcStateDataFileName, makeNpcStateRecoveryFileName };
}
