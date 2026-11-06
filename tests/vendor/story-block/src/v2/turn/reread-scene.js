// A text-free trace of scene captures around Re-read: the stored and newly read place/present receipts,
// their sources and effects, and whether presence changed. This helps tell a capture-order problem from
// a display refresh without putting names or reply text in the console.

const sceneReceipts = receipts => (receipts ?? []).filter(receipt => receipt?.type === 'capture.place' || receipt?.type === 'capture.present');
const source = receipt => (receipt.assist === 'late' || receipt.assist === 'now' ? receipt.assist : 'reply');
const present = state => JSON.stringify(state?.domains?.scene?.present ?? null);

function describe(receipt) {
    const data = receipt.data ?? {};
    if (receipt.type === 'capture.place') return `${source(receipt)}:place(moved=${typeof data.moved === 'boolean' ? data.moved : '?'})`;
    const count = key => (Array.isArray(data[key]) ? data[key].length : '?');
    const missing = Array.isArray(data.missing) ? data.missing.length : (Array.isArray(data.added) && Array.isArray(data.removed) ? 0 : '?');
    return `${source(receipt)}:present(+${count('added')},-${count('removed')},missing=${missing})`;
}

/** Keep the receipt and state before Re-read; no chat text is written to the console. */
export function sceneBeforeReread(store, index, record) {
    return { receipts: sceneReceipts(record?.receipts), reply: present(store.at(index)), head: present(store.head()) };
}

/** Tell what changed and the order of the relevant receipts; never let a diagnostic interrupt a Re-read. */
export function logSceneReread(store, index, before, receipts, lateCount) {
    try {
        const after = sceneReceipts(receipts);
        const replyChanged = before.reply !== present(store.at(index));
        const headChanged = before.head !== present(store.head());
        if (!before.receipts.length && !after.length && !replyChanged && !headChanged) return;
        const comparable = [...before.receipts, ...after].every(receipt => typeof receipt.line === 'string');
        const key = receipt => [receipt.type, source(receipt), receipt.line];
        const sameLines = comparable ? JSON.stringify(before.receipts.map(key)) === JSON.stringify(after.map(key)) : 'unknown';
        console.info(`[Story Suite] Re-read scene diagnostic for reply ${index}: reply presence changed=${replyChanged}; head presence changed=${headChanged}; same scene lines=${sameLines}; previous late candidates=${lateCount}; stored order=[${before.receipts.map(describe).join(', ')}]; Re-read order=[${after.map(describe).join(', ')}].`);
    } catch { /* A diagnostic must never affect a successful Re-read. */ }
}
