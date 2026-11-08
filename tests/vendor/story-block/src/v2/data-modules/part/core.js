// The data-module part's shared lifecycle helpers (extracted from data-modules/part.js):
// installed offers, dependency checks, reader actions, replay guards, action receipts and refusals.
import { DM_LIMITS as L } from '../schema.js';
import { dataModuleHash, dataModulesPackHash } from '../check.js';
import { copy, bytes, refuse, DataModuleError } from '../interpreter.js';
import { activeDefinition, publicView } from '../adapters.js';
import { hashJson } from '../../replay.js';
import { fold } from '../../lean-rpg/read.js';
import { B, draftOf, pairKey } from './shared.js';
import { replayInputs } from './views.js';
import { settleReserve } from './timing.js';

export function createCore({ packs, state: head = () => null, lifecycle = () => null, restore = () => ({ state: 'idle' }), settings = () => ({}), persona = () => '', boardOn = () => false } = {}) {
    // The runtime's late-bound readers may not exist yet while the definition registers: read as "no state" until they do.
    const state = () => { try { return head(); } catch { return null; } };
    // Whether a name is the reader's own (the persona's): the Party tab shows that character as You.
    const isReader = name => {
        let who = '';
        try { who = String(persona() ?? '').replace(/\s+/g, ' ').trim(); } catch { who = ''; }
        return Boolean(who) && fold(name) === fold(who);
    };
    function offers() {
        const where = new Map();
        try { for (const entry of packs?.list?.() ?? []) where.set(entry.id, entry.source === 'lorebook' ? 'a lorebook' : String(entry.origin ?? '')); } catch { /* no list: no origin */ }
        return (packs?.packs?.() ?? []).flatMap(pack => (pack.content.dataModules ?? []).map(definition => ({ module: definition.id,
            definition: copy(definition), hash: dataModuleHash(definition), packId: pack.id, packVersion: pack.version,
            packHash: dataModulesPackHash(pack), interpreter: 1, origin: where.get(pack.id) ?? '' })));
    }
    function dependency(definition, prefix) {
        if (restore()?.state === 'pending') refuse('RESTORE_PENDING', '', 'A restore is pending.');
        for (const entry of Object.values(definition.imports)) {
            if (['director.time', 'checks.policy'].includes(entry.query) || definition.scope === 'character') {
                const life = lifecycle('story-director');
                if (!life || life.status !== 'ready') refuse('DEPENDENCY_UNAVAILABLE', entry.query, life?.reason ?? 'Story Director is not available.');
            }
            if (entry.query === 'dataModules.public' && !publicView(prefix, entry.args)) refuse('DEPENDENCY_UNAVAILABLE', entry.query, 'The imported module/export/subject is not active.');
        }
        if (definition.scope === 'character' && lifecycle('story-director')?.status !== 'ready') refuse('DEPENDENCY_UNAVAILABLE', 'who', 'Story Director is not available.');
    }
    function reader(ctx) {
        if (ctx.cause !== 'ui' || ctx.caller !== null) refuse('REFUSED', '', 'Only a direct reader action in Setup may pin, attach or migrate.');
        if (restore()?.state === 'pending') refuse('RESTORE_PENDING', '', 'A restore is pending.');
    }
    function guard(ctx, prefix, { kind, module, hash, generation, subject = 'chat', reads = [], imports = [], actor = false, decision = {}, pin = null, bound = false, localOnly = false, clock = false }) {
        const predicate = { kind, module, hash, generation, subject };
        const adapters = pin?.definition.imports ?? activeDefinition(prefix, module)?.imports ?? {};
        const available = localOnly ? [] : Object.keys(adapters).filter(alias => adapters[alias].query === 'dataModules.public');
        const selector = { module, subject, reads, imports, actor, ...(clock ? { clock: true } : {}), ...(available.length ? { available } : {}),
            ...(pin ? { adapters, subjects: decision.subjects ?? [] } : {}) };
        const source = copy(ctx.source);
        if (!source) refuse('DM_SCHEMA', '', 'A reply must hold this data module action.');
        const witness = replayInputs(prefix, selector);
        const recorded = { source, selector, decision, ...(pin ? { pin } : {}) };
        ctx.replayGuard({ owner: 'story-block', version: 2, epoch: ctx.epoch, rulesHash: localOnly ? null : prefix.domains.rules?.rulesHash ?? null,
            predicate, inputHash: hashJson({ source, witness, predicate, decision }), ...(bound ? { replyBound: true } : {}) }, recorded);
        return recorded;
    }
    function finish(ctx, prefix, draft, data, { pin = false, visits = 0, summary, notes = [], replan = false, result = null, xpFrom = null, practiceFrom = null, listsFrom = null } = {}) {
        const key = pairKey(ctx.source), standing = ctx.standing?.domains?.dataModules?.perReply?.[key];
        const actions = { ...(draft.perReply[key]?.actions ?? {}) };
        // `xpFrom` (the RPG's fight XP, lean-rpg/fight.js): what a character's xp, soul and points were before the first story line of this reply that wrote
        // XP, by block. The first line's is kept; later actions of the reply carry it on.
        const rises = { ...(xpFrom ?? {}), ...(draft.perReply[key]?.xpFrom ?? {}) };
        // `practiceFrom`: the practice and rank of a skill slot before the first story line of this reply that practised it, by block and slot (the RPG's practice by
        // code puts them back, lean-rpg/practice.js). The first line's is kept.
        const slots = {};
        for (const module of new Set([...Object.keys(practiceFrom ?? {}), ...Object.keys(draft.perReply[key]?.practiceFrom ?? {})])) slots[module] = { ...(practiceFrom?.[module] ?? {}), ...(draft.perReply[key]?.practiceFrom?.[module] ?? {}) };
        for (const [id, action] of Object.entries(standing?.actions ?? {})) if (action.click) actions[id] ??= action;
        actions[ctx.cursor().block] = { visits, click: ctx.cause === 'ui' && !pin };
        // `listsFrom`: where each entry of a List of entries stood when this reply began, by block, subject and field ({ size, at: [original index or null] }), so that
        // a number in `at` always means the entry as the story saw it, whatever the reply's earlier lines dropped.
        const lists = listsFrom ?? draft.perReply[key]?.lists;
        const next = { roots: Object.keys(actions).length, visits: Object.values(actions).reduce((n, action) => n + action.visits, 0), actions, ...(Object.keys(rises).length ? { xpFrom: rises } : {}), ...(Object.keys(slots).length ? { practiceFrom: slots } : {}),
            ...(lists && Object.keys(lists).length ? { lists } : {}) };
        if (next.roots > L.replyRoots || next.visits > L.replyVisits) refuse('DM_BUDGET', '', 'Data module reply budget exhausted.');
        // The story's lines leave room for the steps that settle the reply (what each block with reply-end functions can really cost): without it a full
        // reply would take its last action and the settling that decides a death would be refused.
        if (ctx.cause === 'story') {
            const kept = settleReserve(prefix);
            if (next.roots > L.replyRoots - kept.roots || next.visits > L.replyVisits - kept.visits) refuse('DM_BUDGET', '', B.replyFull);
        }
        // Scratch from earlier replies is pruned only by a successful data root.
        draft.perReply = { [key]: next };
        // (The bus counts the patch's ops and the span's bytes for every data root; this is the data's own share, and the pins.)
        if (pin && (Object.keys(draft.pins).length > L.pins || bytes(draft.pins) > L.pinsBytes)) refuse('DM_BUDGET', '', 'Retained pin budget exhausted.');
        if (bytes(data) + bytes(result) > (pin ? L.pinBytes : L.actionBytes)) refuse('DM_BUDGET', '', 'Data module action storage budget exhausted.');
        return { summary, narrate: false, data: { v2: { result: result ?? {} } }, ...(notes.length ? { problem: notes.join(' ') } : {}), ...(replan ? { replan: true } : {}) };
    }
    // A refusal reaches the reader as one plain sentence naming the module: "Reputation: faction must be guild, watch or compact;
    // nothing applied." (bounded; shown escaped by the card). `call.label` is the module's name once the pin is known.
    const wrap = fn => (ctx, payload = {}) => {
        const call = { label: null };
        try { return fn(ctx, payload, call); }
        catch (error) {
            if (!(error instanceof DataModuleError)) throw error;
            const label = String(call.label ?? payload.module ?? payload.name ?? 'Data module');
            const reason = String(error.message).replace(/[.\s]+$/, '');
            return ctx.fail(error.code, `${label}: ${reason}; nothing applied.`.slice(0, 280));
        }
    };
    return { packs, lifecycle, restore, settings, boardOn, state, isReader, offers, dependency, reader, guard, finish, wrap };
}
