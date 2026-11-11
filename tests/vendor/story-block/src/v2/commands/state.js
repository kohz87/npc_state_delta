// Story Suite v2: the command bus's view of a transaction's state (drafts, frozen reads, the current state, queries),
// the Source and cursor a block starts from, and the proof a command gives. commands.js keeps createCommandBus and
// re-exports its public names; it passes the store, the query lookup and the block-origin helper in.

import { clone, deepFreeze, frozenCopy } from '../ops.js';
import { blockIdOf } from '../replay.js';
import { submitProof } from '../evidence.js';
import { entriesWithCue } from '../lean-rpg/cue.js';
import { isRecord } from './shared.js';

export function createStateTools({ store, findQuery, fail, originOf }) {
    function draftOf(tx, domain) {
        if (!tx.drafts.has(domain)) {
            const slice = tx.head.domains?.[domain];
            tx.drafts.set(domain, slice === undefined ? {} : clone(slice));
        }
        return tx.drafts.get(domain);
    }

    function metaOf(tx) {
        if (!tx.meta) tx.meta = clone(tx.head.meta ?? {});
        if (!isRecord(tx.meta.claims)) tx.meta.claims = {};
        return tx.meta;
    }

    // Reads hand out frozen values without copying the state: the head is deep-frozen (transact), and a
    // drafted domain is read as frozenCopy gives it, the head's own branches wherever the draft has not
    // changed them (B-b1r2-4: a copy of the whole slice per read made each line cost the state's size).
    function readOf(tx, domain) {
        if (tx.drafts.has(domain)) return frozenCopy(tx.drafts.get(domain), tx.head.domains?.[domain]);
        if (!isRecord(tx.head.domains) || !Object.hasOwn(tx.head.domains, domain)) return null;
        return tx.head.domains[domain];
    }

    // The state as this transaction has it so far, frozen: the head with every draft (and claim) laid
    // over it; the head itself while nothing is drafted.
    function currentState(tx) {
        if (!tx.drafts.size && !tx.meta && isRecord(tx.head.domains)) return tx.head;
        const domains = { ...(tx.head.domains ?? {}) };
        for (const [name, draft] of tx.drafts) domains[name] = frozenCopy(draft, tx.head.domains?.[name]);
        const meta = tx.meta ? frozenCopy(tx.meta, tx.head.meta) : tx.head.meta;
        return Object.freeze({ ...tx.head, meta, domains: Object.freeze(domains) });
    }

    // A query's third argument (MODULES §F3): other queries over the same transaction state, and the
    // stored receipts in chat order.
    function queryTools(tx, state = currentState(tx)) {
        const tools = Object.freeze({
            reply: tx.reply,
            hasQuery: name => Boolean(findQuery(name)),
            query(name, args) {
                const fn = findQuery(name);
                if (!fn) fail('NOT_FOUND', `There is no query called "${name}".`);
                return frozenCopy(fn(state, deepFreeze(clone(args)), tools));
            },
            receipts: () => entriesWithCue(tx.receiptsBefore ?? store.receipts?.() ?? []),
            // The proof this root has given so far (not stored yet), for story.evidence (evidence.js).
            pendingProofs: () => [...(tx.planned ?? []), ...(tx.proofs?.list ?? [])].map(proof => ({ proof, block: null })),
        });
        return tools;
    }

    // The Source this transaction's block will carry: its reply's canonical pair and ordinal (store.sourceAt).
    function sourceOf(tx) {
        if (tx.source === undefined) {
            let found = null;
            if (Number.isInteger(tx.reply?.index) && typeof store.sourceAt === 'function') {
                try { found = store.sourceAt(tx.reply.index, { pending: tx.pending, ordinal: tx.ordinal }); } catch { found = null; }
            }
            tx.source = found ? Object.freeze(found) : null;
        }
        return tx.source;
    }

    // The Cursor this transaction's block starts at (ctx.cursor): who the block is (the reply's canonical pair and the id named by its operation and its
    // occurrence, which is the one the host stamps: replay.js blockIdOf) and where it sits now (the changes before it on the reply, the rev before it).
    // A block the reply holds already (a step planned again: its ordinal) is told by the id it has.
    function cursorOf(tx) {
        if (tx.cursor === undefined) {
            let found = null;
            const source = sourceOf(tx);
            if (source && Number.isInteger(tx.reply?.index)) {
                try {
                    originOf(tx);
                    const held = Number.isInteger(tx.ordinal) ? store.blockAt?.(tx.reply.index, tx.ordinal) ?? null : null;
                    const block = tx.reusing ? tx.reusing.id : held ? held.block : tx.operation ? blockIdOf({ sid: source.sid, swipeKey: source.swipeKey, key: tx.operation, rank: tx.rank }) : null;
                    const op = Number.isInteger(tx.opsBefore) ? tx.opsBefore : held ? held.op : store.opsAt(tx.reply.index).length;
                    if (block) found = { sid: source.sid, swipeKey: source.swipeKey, block, op, rev: Math.max(0, tx.rev - 1) };
                } catch { found = null; }
            }
            tx.cursor = found ? Object.freeze(found) : null;
        }
        if (!tx.cursor) fail('FAILED', 'There is no reply yet to hold a block, so it has no cursor.');
        return tx.cursor;
    }

    function giveProof(tx, moduleId, spec) {
        const made = submitProof(spec, {
            who: moduleId, cause: tx.cause, chat: tx.chat, source: sourceOf(tx), origin: originOf(tx), state: () => currentState(tx),
            stored: () => store.proofs?.() ?? [], taken: () => store.proofs?.({ all: true }) ?? [], planned: tx.planned, root: tx.proofs, fail, replacing: tx.replacing,
        });
        if (made.created) {
            const meta = metaOf(tx);
            if (!isRecord(meta.proofs)) meta.proofs = {};
            meta.proofs[made.proof.id] = made.pin;
        }
        return Object.freeze({ id: made.proof.id, payloadHash: made.proof.payloadHash });
    }

    return { draftOf, metaOf, readOf, currentState, queryTools, sourceOf, cursorOf, giveProof };
}
