// Small stand-ins for the store (SB-state) and the command bus (SB-commands) with the
// docs/v2/SPEC.md §12 interfaces, for Story Block's own unit tests of the parts around them
// (turn, sdk). They are deliberately simple: whole-domain replace ops, no checkpoints after the
// greeting, no claims rules beyond "once". Modules test against the real runtime (host.js).

const clone = value => (value === undefined ? undefined : structuredClone(value));

function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const item of Object.values(value)) deepFreeze(item);
    }
    return value;
}

const unescape = segment => segment.replace(/~1/g, '/').replace(/~0/g, '~');

/** Applies JSON Patch add/replace/remove ops to a copy of `state`. */
export function applyOps(state, ops) {
    const out = clone(state);
    for (const { op, path, value } of ops) {
        const parts = path.split('/').slice(1).map(unescape);
        const key = parts.pop();
        let target = out;
        for (const part of parts) target = target[part];
        if (op === 'remove') {
            if (Array.isArray(target)) target.splice(Number(key), 1);
            else delete target[key];
        } else if (Array.isArray(target) && op === 'add') target.splice(key === '-' ? target.length : Number(key), 0, clone(value));
        else target[key] = clone(value);
    }
    return out;
}

const isCarrier = message => Boolean(message) && !message.is_user;

/** createStore's interface over `chat()`; state in message.extra.storySuite like the real one. */
export function createFakeStore({ chat, save = async () => {} }) {
    let dirty = false;
    const counts = { rebuilds: 0, saves: 0 };
    const carriers = () => chat().map((message, index) => (isCarrier(message) ? index : -1)).filter(index => index >= 0);
    function data(index) {
        const message = chat()[index];
        if (!message.extra || typeof message.extra !== 'object') message.extra = {};
        if (!message.extra.storySuite) message.extra.storySuite = { v: 2, ops: [], receipts: [], narrated: [] };
        return message.extra.storySuite;
    }
    function sync(index) {
        const message = chat()[index];
        if (message.swipe_info?.[message.swipe_id ?? 0]) message.swipe_info[message.swipe_id ?? 0].extra = clone(message.extra);
    }
    function at(index) {
        let state = null;
        for (const i of carriers()) {
            if (i > index) break;
            const stored = chat()[i].extra?.storySuite;
            if (!stored) continue;
            if (stored.checkpoint) state = clone(stored.checkpoint);
            if (state) state = applyOps(state, stored.ops ?? []);
        }
        return deepFreeze(state);
    }
    const headIndex = () => carriers().at(-1) ?? -1;
    return {
        counts,
        head: () => at(headIndex()),
        at,
        headIndex,
        receipts: () => carriers().flatMap(i => (chat()[i].extra?.storySuite?.receipts ?? []).map(receipt => ({ index: i, receipt: clone(receipt) }))),
        opsAt: index => clone(chat()[index]?.extra?.storySuite?.ops ?? []),
        changesAt: index => [...new Set((chat()[index]?.extra?.storySuite?.ops ?? []).map(op => op.path))],
        ensureInitial(initial) {
            const first = carriers()[0];
            if (first === undefined || carriers().some(i => chat()[i].extra?.storySuite?.checkpoint)) return;
            data(first).checkpoint = clone(initial);
            sync(first);
            dirty = true;
        },
        append({ ops, receipt }) {
            const index = headIndex();
            const stored = data(index);
            stored.ops.push(...clone(ops));
            stored.receipts.push(clone(receipt));
            sync(index);
            dirty = true;
        },
        replaceStory(index, { ops, receipts }) {
            const stored = data(index);
            stored.receipts = [...stored.receipts.filter(receipt => receipt.cause !== 'story'), ...clone(receipts)];
            stored.ops = [...stored.ops, ...clone(ops)];
            sync(index);
            dirty = true;
        },
        setNarrated(index, ids) {
            data(index).narrated = [...ids];
            sync(index);
            dirty = true;
        },
        untold() {
            const told = new Set(carriers().flatMap(i => chat()[i].extra?.storySuite?.narrated ?? []));
            return carriers().flatMap(i => chat()[i].extra?.storySuite?.receipts ?? [])
                .filter(receipt => receipt.narrate && !told.has(receipt.id)).map(clone);
        },
        rebuild() { counts.rebuilds += 1; },
        scheduleSave() { dirty = true; },
        async flush() {
            if (!dirty) return;
            await save();
            counts.saves += 1;
            dirty = false;
        },
        dirty: () => dirty,
    };
}

class CommandError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

/**
 * createCommandBus's interface (run takes { cause, seed, state, capture } as the real one); receipts
 * get ids rc_00000001, rc_00000002, …
 */
export function createFakeBus({ store, registry, settings = () => ({}) }) {
    let counter = 0;
    let tokens = 0;
    const previews = new Map();

    function run(type, payload, { cause = 'story', seed = 0, state = null, capture = null, carrier = null, chat = null } = {}) {
        const handler = capture?.apply ?? registry.command(type);
        if (!handler) return { ok: false, code: 'UNKNOWN_COMMAND', message: `Nothing handles "${type}".` };
        const owner = capture?.moduleId ?? registry.commandOwner(type);
        const head = state ?? store.head() ?? { v: 2, meta: { rev: 0, claims: {} }, domains: {} };
        const drafts = {};
        const claims = { ...head.meta.claims };
        let claimed = false;
        const receiptId = `rc_${String(counter + 1).padStart(8, '0')}`;
        let ids = 0;
        const ctx = {
            receiptId,
            cause,
            module: owner,
            caller: null,
            rev: head.meta.rev + 1,
            carrier: carrier ? { ...carrier, key: `${carrier.index}:${carrier.swipe ?? 0}` } : null,
            chat: chat ? { lastUser: String(chat.lastUser ?? ''), reply: String(chat.reply ?? '') } : null,
            id: prefix => `${prefix}_${String(counter + 1).padStart(4, '0')}${String(ids += 1).padStart(4, '0')}`,
            read: domain => deepFreeze(clone(drafts[domain] ?? head.domains[domain])),
            draft(domain) {
                if (registry.domainOwner(domain) !== owner) throw new CommandError('NOT_OWNER', `"${owner}" cannot change "${domain}".`);
                if (!drafts[domain]) drafts[domain] = clone(head.domains[domain] ?? {});
                return drafts[domain];
            },
            claim(key) {
                if (claims[key]) return false;
                claims[key] = true;
                claimed = true;
                return true;
            },
            call() { throw new CommandError('FAILED', 'Sub-commands are not in the fake bus.'); },
            fail(code, message) { throw new CommandError(code, message); },
            settings: id => settings(id ?? owner),
            rng: () => 0.5,
            time: () => null,
            // A count set rather than moved (SPEC §2.2): the fake bus stores whole domains, so nothing to mark.
            absolute() {},
            ifThere() {},
            unique() {},
        };
        let out;
        try { out = handler(ctx, clone(payload)); } catch (error) {
            return { ok: false, code: error.code ?? 'FAILED', message: error.message };
        }
        for (const domain of Object.keys(drafts)) {
            const errors = registry.validator(domain)?.(drafts[domain], head) ?? [];
            if (errors.length) return { ok: false, code: 'INVALID', message: errors.join(' ') };
        }
        counter += 1;
        const rev = head.meta.rev + 1;
        const ops = [
            ...Object.keys(drafts).sort().map(domain => ({ op: Object.hasOwn(head.domains, domain) ? 'replace' : 'add', path: `/domains/${domain}`, value: drafts[domain] })),
            ...(claimed ? [{ op: 'replace', path: '/meta/claims', value: claims }] : []),
            { op: 'replace', path: '/meta/rev', value: rev },
        ];
        const summary = typeof out?.summary === 'string' ? out.summary : '';
        const receipt = { id: receiptId, type, module: owner, cause, seed, summary, narrate: out?.narrate ?? Boolean(summary), data: out?.data ?? {}, rev };
        return { ok: true, ops, receipt, state: deepFreeze(applyOps(head, ops)) };
    }

    function command(type, payload, { cause = 'ui' } = {}) {
        const result = run(type, payload, { cause });
        if (!result.ok) return result;
        store.append({ ops: result.ops, receipt: result.receipt });
        store.scheduleSave();
        return { ok: true, receipt: result.receipt };
    }

    return {
        run,
        command,
        preview(type, payload) {
            const result = run(type, payload, { cause: 'ui' });
            if (!result.ok) return result;
            counter -= 1;
            const token = `tk_${tokens += 1}`;
            previews.set(token, { type, payload, rev: store.head()?.meta.rev });
            return { ok: true, receipt: result.receipt, token };
        },
        commit(token) {
            const preview = previews.get(token);
            previews.delete(token);
            if (!preview) return { ok: false, code: 'STALE', message: 'That preview is gone.' };
            if (store.head()?.meta.rev !== preview.rev) return { ok: false, code: 'STALE', message: 'The story changed since the preview.' };
            return command(preview.type, preview.payload);
        },
    };
}
