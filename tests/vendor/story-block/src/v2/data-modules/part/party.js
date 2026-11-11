// The data modules' companions (extracted from data-modules/part.js): joining, leaving and
// returning, their signature skills and gear, and the Ask card's reader action.
import { dmObject, dmRoom } from '../schema.js';
import { validateDataModules } from '../check.js';
import { copy, refuse, atPath } from '../interpreter.js';
import { activeDefinition, inputsOf, instanceOf } from '../adapters.js';
import { fill } from '../../strings.js';
import { fold } from '../../lean-rpg/read.js';
import { SKILL_SLOTS_MAX, UTILITY_SLOTS, skillFieldSlots, isTypedSkills, skillTypeOf, signatureAt } from '../../skill-slots.js';
import { castGearOf, gearLine } from '../../packs/cast-gear.js';
import { castSkillsOf } from '../../packs/cast-skills.js';
import { gearOn } from '../../domains/inventory.js';
import { actorIdOf } from '../../lean-rpg/roster.js';
import { placeOf } from '../../domains/gear.js';
import { CLASS_NAMES, PARTY_ACTIVE } from '../../lean-rpg/names.js';
import { packLevelsOf } from '../../lean-rpg/levels.js';
import { E, B, J, rpg, partyWitness, partyLimit, stateOf, draftOf, instancePath, blockCount, activeCount, hashOf, newInstance } from './shared.js';
import { skillCapacity, skillRow } from './skills.js';

export function createParty(deps) {
    const { packs, restore, settings, isReader, guard, finish } = deps;
    function skillsBlockOf(state, who) {
        const domain = state?.domains?.dataModules;
        for (const module of Object.keys(domain?.active ?? {})) {
            const definition = activeDefinition(state, module), fields = instanceOf(state, module)?.fields;
            if (definition?.role === 'skills' && fields && typeof fields.who === 'string' && fold(fields.who) === fold(who)) return { module, definition, fields };
        }
        return null;
    }
    // The Skills block of `name` in the state a Re-read's reply stands in (ctx.standing), or null.
    const standingBlock = (ctx, name) => (ctx.standing ? skillsBlockOf({ domains: { dataModules: ctx.standing.domains?.dataModules } }, name) : null);
    // The signature skills a Skills block's definition was made with: the slots marked in `sig.default`, as the defaults of their fields have them.
    function defaultSeeds(state) {
        const bits = Number.isSafeInteger(state?.sig?.default) ? state.sig.default : 0, rows = [];
        for (let n = 1; n <= skillFieldSlots(state); n += 1) {
            const name = state?.[`skill${n}`]?.default;
            if (signatureAt(bits, n) && typeof name === 'string' && name) rows.push(skillRow(Object.fromEntries(['skill', 'about', 'stat', 'uses', 'rank', 'type'].map(key => [`${key}${n}`, state[`${key}${n}`]?.default])), n));
        }
        return rows;
    }
    // The skills the pack gives `name` now, the ones the person does not hold by name already (what a first read of a join, a return or an offer plans).
    function packSeeds(ctx, name) {
        const held = skillsBlockOf(stateOf(ctx), name);
        const have = new Set(Array.from({ length: skillFieldSlots(held?.fields) }, (_, i) => fold(held?.fields?.[`skill${i + 1}`] ?? '')).filter(Boolean));
        let found = null;
        try { found = castSkillsOf(packs?.packs?.() ?? [], name); } catch { found = null; }
        return (found?.skills ?? []).filter(skill => !have.has(fold(skill.name)));
    }
    // The skills to seed for `name` on this join (`mode` 'join') or return ('back'): [{ name, about, stat, uses, rank }], the ones the person does not hold by name already.
    // A Re-read plans what its reply seeded, never what the pack says now: a join reads it from the definition defaults of the Skills block the reply pinned (the bits
    // of `sig.default`, which the reader's pencil never touches); a return, which wrote the skills into the fields, reads the marked slots of the reply as it stood. A block
    // without the mark was made before the signature skills (2.22) and seeded nothing.
    function castSeeds(ctx, name, mode = 'join') {
        if (!ctx.standing) return packSeeds(ctx, name);
        const held = skillsBlockOf(stateOf(ctx), name);
        const have = new Set(Array.from({ length: skillFieldSlots(held?.fields) }, (_, i) => fold(held?.fields?.[`skill${i + 1}`] ?? '')).filter(Boolean));
        const after = standingBlock(ctx, name);
        if (!after || !Object.hasOwn(after.definition.state ?? {}, 'sig')) return [];
        if (mode === 'join') return defaultSeeds(after.definition.state).filter(skill => !have.has(fold(skill.name)));
        // A return plans the rows its receipt recorded before the reader's pencil changed them. When a utility skill did not fit, the receipt also keeps the
        // attempted rows in order, so Re-read can reproduce both the placed skills and the warning. Older receipts fall back to their placed rows or marked slots.
        const recorded = (ctx.standingReceipts ?? []).filter(receipt => receipt?.data?.join?.op === 'back' && fold(receipt.data.join.name ?? '') === fold(name)).flatMap(receipt => (Array.isArray(receipt.data.sigSkillsPlanned) ? receipt.data.sigSkillsPlanned : Array.isArray(receipt.data.sigSkills) ? receipt.data.sigSkills : []))
            .filter(row => dmObject(row) && typeof row.name === 'string' && row.name);
        if (recorded.length) return recorded.filter(row => !have.has(fold(row.name))).map(row => ({ name: row.name, about: typeof row.about === 'string' ? row.about : '', stat: row.stat, uses: row.uses ?? 'stamina', rank: Number.isSafeInteger(row.rank) ? row.rank : 0, ...(row.type === 'utility' ? { type: 'utility' } : {}) }));
        const rows = [];
        for (let n = 1; n <= skillFieldSlots(after.fields); n += 1) if (typeof after.fields[`skill${n}`] === 'string' && after.fields[`skill${n}`] && signatureAt(after.fields.sig, n) && !have.has(fold(after.fields[`skill${n}`]))) rows.push(skillRow(after.fields, n));
        return rows;
    }
    // The tiles of the join's receipt and its summary words.
    const seededData = seeds => seeds.map(skill => ({ name: skill.name, about: skill.about, stat: skill.stat, uses: skill.uses, rank: skill.rank, ...(skill.type === 'utility' ? { type: 'utility' } : {}) }));
    // Coming back: the seeds go into the free slots of the Skills block the person already has.
    function reseed(ctx, answer, name) {
        const prefix = stateOf(ctx), block = skillsBlockOf(prefix, name);
        if (!block) return answer;
        const seeds = castSeeds(ctx, name, 'back');
        if (!seeds.length) return answer;
        // A block made before the signature mark (or the extra slots) is extended first, so the skills can be marked (growSkills).
        let definition = block.definition;
        if (!Object.hasOwn(definition.state ?? {}, 'sig') || skillCapacity(definition) < SKILL_SLOTS_MAX) definition = deps.growSkills(ctx, prefix, draftOf(ctx), block.module) ?? definition;
        const fields = atPath(draftOf(ctx), instancePath(block.module, 'chat')).fields, typed = isTypedSkills(fields);
        const capacity = typed ? skillFieldSlots(fields) : skillCapacity(definition), marks = Object.hasOwn(definition.state ?? {}, 'sig');
        const placed = [];
        let skippedUtility = false;
        for (const skill of seeds) {
            const slots = Array.from({ length: capacity }, (_, i) => i + 1);
            // (a utility skill takes one of the three utility slots and a combat one one of the eight; a block with no types reads every skill as combat; a full pool skips the skill, said in Problems)
            const kind = typed && skill.type === 'utility' ? 'utility' : 'combat';
            const held = slots.filter(n => fields[`skill${n}`] && skillTypeOf(fields, n) === kind).length;
            const slot = typed && held >= (kind === 'utility' ? UTILITY_SLOTS : SKILL_SLOTS_MAX) ? null : slots.find(n => !fields[`skill${n}`]);
            if (!slot) {
                if (skill.type === 'utility') skippedUtility = true;
                answer.problem = [answer.problem, `${name}'s ${skill.name} has no free ${kind === 'utility' ? 'utility ' : ''}skill slot.`].filter(Boolean).join(' ');
                continue;
            }
            Object.assign(fields, { [`skill${slot}`]: skill.name, [`about${slot}`]: skill.about, [`stat${slot}`]: skill.stat, [`uses${slot}`]: skill.uses, [`rank${slot}`]: skill.rank, [`practice${slot}`]: 0 });
            if (typed) fields[`type${slot}`] = kind;
            if (marks) fields.sig = (Number.isSafeInteger(fields.sig) ? fields.sig : 0) + 2 ** (slot - 1);
            placed.push(skill);
        }
        if (placed.length) {
            answer.data.sigSkills = seededData(placed);
            answer.summary = `${answer.summary} ${fill(J.skillsSeeded, { n: placed.length })}`;
        }
        if (skippedUtility) answer.data.sigSkillsPlanned = seededData(seeds);
        return answer;
    }
    // The party actor of the Character block `module` (`party.actors`: the one whose ID is the block's, which a rename never changes), else, when a module of
    // another make answers the roster, the one of that name; 'party' when nothing answers or no one is so. The joiner's own block is in the roster at once
    // (the draft is what the query reads), so a join finds their actor in the same receipt.
    function gearOwnerOf(ctx, name, module = null) {
        try {
            const actors = (v => (Array.isArray(v) ? v : []))(ctx.query('party.actors'));
            const own = module ? actors.find(entry => typeof entry?.id === 'string' && entry.id === actorIdOf(module)) : null;
            const actor = own ?? actors.find(entry => typeof entry?.id === 'string' && fold(entry.name) === fold(name));
            if (actor) return actor.id;
        } catch { /* no roster */ }
        return 'party';
    }
    // A cast member's signature gear (cast.js `gear`, GEAR.md): with `story-block.gear` on, the joining person's pack items are added to the
    // inventory owned by them (the party's actor of that name; with none, nothing is given) and put on, through the inventory's own commands, so
    // the items are part of the join's one receipt. A command that fails inside another fails the whole receipt (the join with it), so everything that
    // could be refused is checked first here, never tried: each piece is looked up by its definition ID (a story item of the same name never gets in
    // the way), what they already own is not added again, a slot that is taken is left as it is (the piece is carried, not worn), and a piece that
    // cannot be found goes to the Problems list. The pieces are BOUND to the member (`bound: true`: GEAR.md "Signature gear"). Coming back, what left with them
    // (inventory.stow, in `leave`) was restored before this (restoreKept), once, and counts as owned. Gear off, or no gear: nothing here runs and the answer is untouched.
    // What a member left with (inventory.kept) comes back whenever they return, whatever the gear switch or the pack say now: found by their actor,
    // else by the block it was set aside for (a member renamed while away). → { owner, pieces } or null.
    function restoreKept(ctx, person) {
        let kept = null;
        try { kept = ctx.read('inventory')?.kept; } catch { kept = null; }
        if (!kept || typeof kept !== 'object') return null;
        const named = gearOwnerOf(ctx, person.name, person.module);
        const owner = Array.isArray(kept[named]) ? named : Object.keys(kept).find(id => Array.isArray(kept[id]) && kept[id].some(entry => entry?.by === person.module));
        if (!owner) return null;
        const back = ctx.call('inventory.restore', { owner });
        const pieces = Array.isArray(back?.data?.pieces) ? back.data.pieces : [];
        return pieces.length ? { owner, pieces } : null;
    }
    function giveGear(ctx, answer, name, module = null, back = null) {
        if (!gearOn(ctx)) return answer;
        let found = null;
        try { found = castGearOf(packs?.packs?.() ?? [], name); } catch { found = null; }
        if (!found?.items.length) return answer;
        const owner = back?.owner ?? gearOwnerOf(ctx, name, module);
        // No actor of their own (nothing answers `party.actors`): the shared bag's worn gear is the reader's Character's, so nothing is given at all; it stays with them.
        if (owner === 'party') {
            answer.problem = [answer.problem, `${found.name}'s gear stays with ${found.name} (no party roster).`].filter(Boolean).join(' ');
            return answer;
        }
        const inventory = ctx.read('inventory');
        const stacks = Object.values(inventory?.stacks ?? {}).filter(stack => stack.owner === owner);
        const taken = new Set(stacks.map(stack => stack.equipped).filter(Boolean));
        const held = new Set(stacks.map(stack => stack.def));
        // Their bound pieces that left with them come back first (once, in the condition they left in, worn where they were when the slot is free),
        // so they are what they "still own" below; the read above is the state before this action, so what came back is added by hand.
        const added = [], notes = [];
        for (const piece of back?.pieces ?? []) {
            held.add(piece.def);
            if (piece.equipped) taken.add(piece.equipped);
            added.push(piece.name);
        }
        let packed = [];
        try { packed = ctx.query('packs.itemDefs', { ids: found.items.map(item => item.id) }); } catch { packed = []; }
        for (const item of found.items) {
            if (held.has(item.id)) continue;
            // (the def by its ID: the chat's own when it already has it, else the pack's, which the grant defines)
            const def = inventory?.defs?.[item.id] ? item.id : (Array.isArray(packed) ? packed : []).find(entry => entry?.id === item.id);
            if (!def) { notes.push(`${found.name}'s ${item.name} could not be found in the pack, so it was not given.`); continue; }
            const places = item.slot === 'accessory' ? ['accessory-1', 'accessory-2'] : [placeOf(item.slot)];
            const place = places.find(key => !taken.has(key));
            const given = ctx.call('inventory.grant', { def, qty: 1, owner, bound: true });
            const stack = given?.data?.stacks?.[0];
            if (!stack) { added.push(item.name); continue; }
            if (place) {
                const worn = ctx.call('item.equip', { stack, owner, slot: place });
                taken.add(worn?.data?.place ?? place);
            } else notes.push(`${found.name}'s ${item.name} is carried, not worn: the ${item.slot} slot is taken.`);
            added.push(item.name);
        }
        if (notes.length) answer.problem = [answer.problem, ...notes].filter(Boolean).join(' ');
        if (!added.length) return answer;
        answer.summary = `${answer.summary} ${gearLine(found.items.filter(item => added.includes(item.name)))}.`;
        answer.data.gear = { owner, items: added };
        return answer;
    }
    // A reply captured with the `partyRoom` mark records the party it relied on (replayInputs `party`); an older one does not.
    const marked = partyWitness;
    function makeParty(ctx, request, soul, call, { added = false, bench = '', four = false } = {}) {
        if (restore()?.state === 'pending') refuse('RESTORE_PENDING', '', E.restorePending);
        const prefix = stateOf(ctx), domain = prefix.domains.dataModules;
        // (the formula and numbers in force: the reader's settings, else what the story's pack asks for, as the rolls read them)
        let pack = null;
        const rpgRecords = (packs?.packs?.() ?? []).flatMap(entry => entry?.content?.rpg ?? []);
        try { pack = rpg().packRulesOf(rpgRecords); } catch { pack = null; }
        const rules = rpg().rulesFromSettings(settings(), pack);
        // (a companion starts under the story's level cap: the pack's ranks record names one, else the reader's setting, else 99)
        // (a Re-read of a join made before the signature skills: the block that reply made had five slots and no mark, so it is built that way and seeds nothing)
        const earlier = standingBlock(ctx, request.name), legacy = Boolean(earlier) && !Object.hasOwn(earlier.definition.state ?? {}, 'sig');
        // (and one made before the skill types has eight slots and no `type` field: built that way again; a first read of a join makes the typed block)
        const typed = !earlier || Object.hasOwn(earlier.definition.state ?? {}, 'type1');
        const seeds = legacy ? [] : castSeeds(ctx, request.name, 'join');
        // Re-reading an existing join uses its own pinned character, even if the prefix had no characters at all.
        const prior = (ctx.standingReceipts ?? []).find(receipt => receipt?.data?.join?.op === 'added' && fold(receipt.data.join.name) === fold(request.name));
        const scale = rpg().joinScale(prefix, ctx.standing, prior?.data?.v2?.result?.module);
        const made = rpg().joinDefinitions({ ...request, skills: seeds }, { used: Object.keys(domain?.active ?? {}), soul, rules, cap: rpg().levelCapFor(settings(), packLevelsOf(rpgRecords)?.levelCap), legacy, typed, scale });
        // The story's first character also brings the Combat rules and Foes blocks it lacks, as far as they fit (nothing is refused for them).
        const first = rpg().partyOf(prefix).length === 0, plan = first ? rpg().extrasPlan(prefix) : { add: [], skipped: [] };
        const extras = rpg().extraDefinitions(plan.add, { used: [...Object.keys(domain?.active ?? {}), made.character.slug, made.skills.slug] });
        const catalog = Object.keys(domain?.active ?? {}).map(id => activeDefinition(prefix, id)).filter(Boolean);
        const checked = validateDataModules([made.character, made.skills, ...extras], { packId: 'chat', capabilities: ['data-modules-v1', 'story-director'], definitions: catalog });
        if (!checked.ok) refuse(checked.errors[0].code, checked.errors[0].path, checked.errors[0].message);
        const room = dmRoom(ctx);
        if (blockCount(domain) + 2 > room.definitions) refuse('DM_BUDGET', '', fill(B.blockLimit, { max: room.definitions }));
        if (activeCount(domain) + 2 > room.pins) refuse('DM_BUDGET', '', B.limit);
        const generation = Math.max(ctx.rev, 1), draft = draftOf(ctx);
        const pins = checked.definitions.map(definition => ({ definition, hash: hashOf(definition), pin: { definition, packId: 'chat', packVersion: '0', packHash: null, interpreter: 1 } }));
        for (const { definition, hash, pin } of pins) {
            draft.pins[hash] = copy(pin);
            draft.active[definition.id] = { hash, generation, subjects: ['chat'] };
            draft.instances[definition.id] = { chat: newInstance(definition, inputsOf(prefix, definition)) };
        }
        const [head, ...rest] = pins;
        const recorded = guard(ctx, prefix, { kind: 'dm.join', module: head.definition.id, hash: head.hash, generation, imports: [], party: four ? PARTY_ACTIVE : marked(ctx), bench,
            decision: { subjects: ['chat'], inputs: {}, previous: null, base: Boolean(domain && Object.keys(domain.active ?? {}).length),
                more: rest.map(entry => ({ module: entry.definition.id, hash: entry.hash, generation, pin: entry.pin })) }, pin: head.pin, bound: true });
        const left = plan.skipped.length ? ` ${fill(J.noExtras, { list: plan.skipped.map(item => rpg().extraName(item.role)).join(', ') })}` : '';
        const answer = finish(ctx, prefix, draft, recorded, { pin: true, result: { module: head.definition.id, skills: rest[0].definition.id },
            summary: `${fill(J.joined, { name: request.name })}${left}` });
        answer.data.join = { op: 'added', name: request.name };
        const placed = defaultSeeds(made.skills.state);
        if (placed.length) {
            answer.data.sigSkills = seededData(placed);
            answer.summary = `${answer.summary} ${fill(J.skillsSeeded, { n: placed.length })}`;
        }
        return giveGear(ctx, answer, request.name, head.definition.id);
    }
    function party(ctx, line, call = {}) {
        if (ctx.cause !== 'story' || ctx.caller !== null) refuse('REFUSED', '', J.storyOnly);
        const prefix = stateOf(ctx);
        const read = rpg().readJoin(line, rpg().soulNaming(prefix));
        call.label = 'Party';
        if (read.error) refuse('DM_LABEL', '', read.error);
        if (read.op === '-') {
            const person = rpg().partyOf(prefix).find(entry => fold(entry.name) === fold(read.name));
            if (!person || person.left) refuse('DM_SCHEMA', '', fill(J.nothing, { name: read.name }));
            // The player's own character (the one named like the persona) never leaves: companions only.
            if (isReader(person.name)) refuse('REFUSED', '', fill(J.isYou, { name: person.name }));
            return leave(ctx, person, true, call);
        }
        const limit = partyLimit(marked(ctx)), check = rpg().checkJoin(prefix, read, dmRoom(ctx), limit);
        // A full party (4 active) is not refused: the line is kept in this reply's own receipt as an offer, and the card asks who to bench.
        if (!check.ok && check.full && limit === PARTY_ACTIVE) return fullOffer(read, check);
        if (!check.ok) refuse('REFUSED', '', check.why);
        if (check.returning) return leave(ctx, check.returning, false, call);
        if (rpg().joinMode(settings()) === 'ask') {
            // Ask: nothing is made. The line is kept in this reply's own receipt, and the card under the reply (rpg.joins) is read from it.
            // (the pack as it is when the line is read, also on a Re-read: an offer changes nothing in the story's state, so there is no block to read it from)
            const seeds = packSeeds(ctx, read.name);
            const offer = { op: 'offer', name: read.name, about: read.about, soul: read.soul, best: read.best, ...(limit === PARTY_ACTIVE ? { four: true } : {}), ...(seeds.length ? { skills: seeds } : {}) };
            return { summary: fill(J.offerNote, { name: read.name }), narrate: false, data: { join: offer } };
        }
        return makeParty(ctx, read, check.soul, call);
    }
    // With gear on, the pieces bound to them leave with them, in this receipt (they come back once when they return: giveGear).
    function stow(ctx, answer, owner, module) {
        if (owner === 'party') return;
        const away = ctx.call('inventory.stow', { owner, module });
        const items = Array.isArray(away?.data?.items) ? away.data.items : [];
        if (items.length) {
            answer.summary = `${answer.summary} ${fill(J.gearLeaves, { items: items.join(', ') })}`;
            answer.data.gear = { owner, away: items };
        }
    }
    // Left (or back): the Character block's `left` field, one guarded `dm.set`. A sheet made before the field existed cannot be marked.
    function leave(ctx, person, left, call, { bench = '', four = false } = {}) {
        const definition = activeDefinition(stateOf(ctx), person.module);
        if (!person.canLeave || !definition) refuse('DM_SCHEMA', '', fill(J.noLeave, { name: person.name }));
        // (their actor is found before the field changes: a member who left is no longer on the roster)
        const owner = left && gearOn(ctx) ? gearOwnerOf(ctx, person.name, person.module) : 'party';
        const answer = deps.setField(ctx, { module: person.module, field: 'left', value: left }, call, { story: !bench, party: !left && (four ? PARTY_ACTIVE : marked(ctx)), bench });
        answer.summary = fill(left ? J.left : J.returned, { name: person.name });
        answer.data.join = { op: left ? 'left' : 'back', name: person.name };
        stow(ctx, answer, owner, person.module);
        if (left) return answer;
        reseed(ctx, answer, person.name);
        const back = restoreKept(ctx, person);
        const out = giveGear(ctx, answer, person.name, person.module, back);
        // (giveGear stops early when gear is off or the cast no longer knows them: what came back is still said)
        if (back && !out.data.gear) {
            const names = back.pieces.map(piece => piece.name);
            out.summary = `${out.summary} ${gearLine(names.map(name => ({ name })))}.`;
            out.data.gear = { owner: back.owner, items: names };
        }
        return out;
    }
    // "Add to party" on the Ask card: the reader's own go-ahead, so it is made like the automatic one, for the head reply.
    function addParty(ctx, payload, call = {}) {
        if (ctx.cause !== 'ui' || ctx.caller !== null) refuse('REFUSED', '', J.cardOnly);
        const soul = payload?.soul === undefined ? 1 : payload.soul;
        const request = rpg().readJoin({ op: '+', name: payload?.name, labels: { about: payload?.about, class: Number.isSafeInteger(soul) ? CLASS_NAMES[soul - 1] ?? 'X' : 'X', best: payload?.best ?? '' } }, rpg().soulNaming(stateOf(ctx)));
        call.label = 'Party';
        if (request.error) refuse('DM_LABEL', '', request.error);
        // (the reader's own action keeps the limit of 4; an offer made on a reply with the `partyFour` mark meets a full party as a bench card, any other card is refused)
        const four = payload?.four === true, check = rpg().checkJoin(stateOf(ctx), request, undefined, PARTY_ACTIVE);
        // The accepted card meets a full party: not refused, the request is kept as an offer in this receipt and the card asks who to bench.
        if (!check.ok && check.full && four) return fullOffer(request, check);
        if (!check.ok) refuse('REFUSED', '', check.why);
        if (check.returning) refuse('REFUSED', '', fill(J.taken, { name: request.name }));
        return makeParty(ctx, request, check.soul, call, { four });
    }
    // A join or return that met a full party (4 active): the request, kept in the reply's own receipt (the card under the reply, rpg.joins, reads it).
    function fullOffer(request, check) {
        const offer = { op: 'offer', name: request.name, about: request.about ?? '', soul: request.soul ?? 1, best: request.best ?? '', full: true, four: true, ...(check.back ? { back: true } : {}) };
        return { summary: fill(J.benchAsked, { name: request.name, max: PARTY_ACTIVE }), narrate: false, data: { join: offer } };
    }
    // A full party's card, a member picked: they step out (marked left, bound gear stowed, as `- party` does) and the newcomer joins or returns, as one reader action.
    // One guard covers it (the join's or the return's, with the member who steps out in its witness): the newcomer is made first, against the party as it was.
    function benchParty(ctx, payload, call = {}) {
        if (ctx.cause !== 'ui' || ctx.caller !== null) refuse('REFUSED', '', J.cardOnly);
        const prefix = stateOf(ctx), soul = payload?.soul === undefined ? 1 : payload.soul;
        const request = rpg().readJoin({ op: '+', name: payload?.name, labels: { about: payload?.about, class: Number.isSafeInteger(soul) ? CLASS_NAMES[soul - 1] ?? 'X' : 'X', best: payload?.best ?? '' } }, rpg().soulNaming(prefix));
        call.label = 'Party';
        if (request.error) refuse('DM_LABEL', '', request.error);
        const named = fold(typeof payload?.bench === 'string' ? payload.bench : '');
        const person = rpg().benchable(prefix, isReader).find(entry => fold(entry.name) === named);
        if (!person) refuse('REFUSED', '', J.benchWhom);
        if (rpg().partyOf(prefix).filter(entry => !entry.left).length < PARTY_ACTIVE) refuse('REFUSED', '', J.benchRoom);
        const check = rpg().checkJoin(prefix, request, undefined, Infinity);
        if (!check.ok) refuse('REFUSED', '', check.why);
        const out = check.returning ? leave(ctx, check.returning, false, call, { bench: person.module, four: true }) : makeParty(ctx, request, check.soul, call, { bench: person.module, four: true });
        // (the member's own Left field, in this same receipt; with gear on, what is bound to them goes with them)
        const owner = gearOn(ctx) ? gearOwnerOf(ctx, person.name, person.module) : 'party';
        atPath(draftOf(ctx), instancePath(person.module, 'chat')).fields.left = true;
        out.summary = `${fill(J.benchNote, { left: person.name, name: request.name })} ${out.summary}`;
        out.data.join = { ...out.data.join, benched: person.name };
        delete out.data.edit;   // (a return by hand marks its receipt as an edit; this one is the card's)
        stow(ctx, out, owner, person.module);
        return out;
    }
    return { skillsBlockOf, standingBlock, defaultSeeds, seededData, makeParty, party, leave, addParty, benchParty, restoreKept, giveGear };
}
