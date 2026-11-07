// Queries and views for the public sdk: run a registered query with its tools, mount the same over a
// state, build the view modules read, and find modules whose domains the head state still lacks.

import { headReply } from '../commands.js';
import { entriesWithCue } from '../lean-rpg/cue.js';

/**
 * Runs a registered query on `state`; the answer is a plain copy. Throws for an unknown query.
 * A query is called (state, args, tools) with tools.query(name, args) over the same state,
 * tools.receipts() → [{ index, receipt }], the stored receipts in chat order (`receipts` option),
 * tools.pendingProofs() → [{ proof }], a Re-read's planned proof (`pendingProofs` option, story.evidence), and
 * tools.reply ({ index, sid } or null, the `reply` option): the reply the state is the head of, as a
 * command's ctx.reply (commands.js).
 */
// A roll's receipt keeps no cue text (stage 51: it is rebuilt from the record); a reader of the receipts (Story Director's chronicle) is given the text in
// `summary`, computed here and not stored, so the day facts of a roll are still there.
export const withCue = entriesWithCue;

export function runQuery(registry, state, name, args, { receipts = () => [], reply = null, pendingProofs = null } = {}) {
    const query = registry.query(name);
    if (!query) throw new Error(`Story Suite: no module answers the query "${name}".`);
    const tools = Object.freeze({
        reply,
        query: (other, otherArgs) => runQuery(registry, state, other, otherArgs, { receipts, reply, pendingProofs }),
        receipts: () => withCue(receipts() ?? []),
        // The proof a Re-read has planned but not stored (evidence.js), for story.evidence; none otherwise.
        ...(typeof pendingProofs === 'function' ? { pendingProofs } : {}),
    });
    const answer = query(state, args === undefined ? undefined : structuredClone(args), tools);
    return answer === undefined ? undefined : structuredClone(answer);
}

/**
 * The mounts' query (src/v2/view/mounts/common.js): `(name, args, state)` → runQuery over that
 * state, so a card asks against its own reply's state and the registry's queries still get
 * (state, args, tools). A query that throws is the mount's to report (resolveData gives null).
 */
export const mountQuery = (registry, receipts = () => []) => (name, args, state) => runQuery(registry, state, name, args, { receipts });

/**
 * What modules read (§6): { state (frozen head), query(name, args), settings(id), feature(id), chat:
 * { length, lastUser, readers (how many messages are the reader's) } }. `chat`: SillyTavern's chat array (or nothing). `feature(id)`: whether the
 * reader has that feature on (MODULES §F100); false for an id no module declares. `state` and `reply`
 * (optional): another state than the head and the reply it stands for (`tools.reply`), for a Re-read's
 * afterCapture hook, which reads the reply's state after its new story lines (turn.js).
 */
export function makeView({ store, registry, settings, chat = [], active = null, state = store.head(), reply = headReply(store), pendingProofs = null }) {
    const messages = Array.isArray(chat) ? chat : [];
    // (`active`: the timeline's reader of earlier messages, so a faded message of the reader's is not the last one a module sees)
    const seen = active ? active.messages(messages) : messages;
    const lastUser = [...seen].reverse().find(message => message?.is_user);
    return Object.freeze({
        state,
        query: (name, args) => runQuery(registry, state, name, args, { receipts: () => store.receipts?.() ?? [], reply, pendingProofs }),
        settings,
        feature: id => featureOn(registry, id),
        chat: Object.freeze({ length: messages.length, lastUser: String(lastUser?.mes ?? ''), readers: seen.filter(message => message?.is_user).length }),
        // The state before the reply this view stands for (the one its lines start from), or null: asked by a step that compares the reply with it (the RPG's fight XP).
        before: () => { try { return Number.isInteger(reply?.index) ? store.before?.(reply.index) ?? null : null; } catch { return null; } },
    });
}

/** Whether feature `id` is on (registry.featureOn); false for an unknown id or a registry without features. */
export const featureOn = (registry, id) => typeof registry?.featureOn === 'function' && registry.featureOn(id) === true;

/**
 * The registered modules whose domains the head state lacks (enabled after the chat began, or a
 * newer version with a domain more): [{ def, missing: [domain names] }], in module-id order. A module
 * held back (dormant, or the restore barrier is up; registry.held) is left out: it is set up when it is ready.
 */
export function missingModules(registry, state) {
    const domains = state?.domains ?? {};
    return registry.modules()
        .filter(def => registry.held?.(def.id) !== true)
        .map(def => ({ def, missing: Object.keys(def.domains ?? {}).filter(name => !def.domains[name].deferred && !Object.hasOwn(domains, name)) }))
        .filter(entry => entry.missing.length);
}
