// The battle log (display D, approved mockup): a dark monospace panel drawn inside the reply at the narrator's
// `[battle]` marker, from the reply's recorded rolls (A's `rpg.resolve` receipt, `data.v2.result`); when the reply has
// no marker the same panel is a card under the reply, above "Changed this reply". It has a one-line header that folds
// (the fold is the viewer's: localStorage, per chat and reply), the turn order, one short line per action with the
// coloured result word and "(26 vs 16)", the breakdown on tap, the consequence arrow ("→ Sluice Rat A Wounded", from
// the reply's word changes), a Status grid with aligned solid bars (coloured by stage, like the Party tab's) and a Foes line. A check shows as one line.
//
// Nothing the panel shows is stored in the chat text: it is read from the record and the state each time, so a swipe,
// a delete, a Re-read and a reload agree. Every node is built with createElement and textContent.
//
// The Standard formula's record (lean-rpg/standard.js) adds, all optional (a record without them draws exactly as before):
//   result.order       [{ id, name, total, die, bonus, agi, party, fresh }] the turn order rolled at the start of the fight, highest first
//   result.quickStart  [{ who, against }] a character 10 or more ahead of a foe: one opening action against it before the first round
//   result.opening     [Line] those opening actions
//   round.idle         [{ n, id, who, kind, why }] a foe group or character who does not act: why 'beaten' (before its turn), 'down' or 'no-target'
//   Line               { kind, type: physical|magic|defence|social|check, skill, pc: { who, die, type, stat, second, mainValue, secondValue, statBonus, style,
//                        classValue, classBonus, rank, luck, edge, total }, foe, outcome, decisive?, damage?: { name, blocks (+ hurt, − healed), from, to, size },
//                        area?, support? (kind 'check', `target` the one helped), opening? }; the breakdown on tap is built from these
//                        ("Physical: d20 17 + (AGI 10 + DEX 6/2)/2 = 6 + Expert 2 + Class II 4 = 29 · vs Weir-drake d20 9 + 3 + Class IV 12 = 24")
//   Line.breakdown     (or the roll's breakdown as one plain string, which then wins)
// A's result record (`data.v2.result` of the `rpg.resolve` receipt; see the header of lean-rpg/resolve.js), as `readResolve` reads it:
//   { v: 1, key, pace, stop, checks: [Line], rounds: [{ n, decisive, lines: [Line] }], refused: [{ who, text }], summary: { exchanges, acts, refused } }
//   Line = { kind: 'act' | 'foe' | 'check', outcome: 'success' | 'cost' | 'fail', skill: string | null, why?,
//            pc: { who, die, stat, statBonus, classValue, classBonus, rank, edge, total },
//            foe?: { slot, name, die, base, classValue, classBonus, total }, difficulty?, dc? }
// For a 'foe' line `pc` is the defender. The numbers read the party's total against the foe's total (or the DC).

import { RESOLVE } from '../index.js';
import { CLASS_NAMES, RANK_NAMES } from '../names.js';
import { readRecord } from '../../persist.js';
import { fold } from '../read.js';
import { soulReading, soulShortOf } from '../soul.js';
import { RPG_STRINGS, fill } from '../strings.js';
import { BARS, readFoes, readParty } from './party-data.js';

const B = RPG_STRINGS.battle;
// The result word of a foe's attack, by the recorded outcome (the party's): the colour stays the outcome's (fail red, cost amber, success green).
const FOE_WORDS = Object.freeze({ fail: B.foeHit, cost: B.foeGrazed, success: B.foeBlocked });
// A Standard line that was decisive: a party success is "Decisive"; a foe's decisive hit (the party's fail) or decisive block (its success) say so.
const DECISIVE_WORDS = Object.freeze({ success: B.decisive, 'foe-fail': B.foeDecisiveHit, 'foe-success': B.foeDecisiveBlock });
export const BATTLE_ROOT = 'rpg-battle';
export const BATTLE_ID = 'rpg/battle-log';
/** The narrator's marker: a line of its own. (turn.js strips the same line from the prompt history.) */
export const MARKER_LINE = /^[ \t]*\[battle\][ \t]*$/i;
const FOLD_KEY = 'story-block.rpg.battle.folded';
const RECENT_MESSAGES = 30;

// Why a character or group does not act in a round (Standard's `idle`): the words the log says (strings.js blocks.idle).
const IDLE = RPG_STRINGS.blocks.idle;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = value => (Array.isArray(value) ? value : []);
const words = (value, max = 80) => (typeof value === 'string' || typeof value === 'number' ? String(value).replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** 'success' | 'cost' | 'fail' | '' for an outcome. */
export const outcomeOf = raw => (raw === 'success' || raw === 'cost' || raw === 'fail' ? raw : '');

/** "d20 14 + STR 7 + Class II 4 + Adept 1 = 26" from a roll `{ d20, parts, total }`; '' when there is nothing to show. */
export function rollText(roll) {
    if (!isRecord(roll)) return '';
    const parts = list(roll.parts).filter(part => isRecord(part) && Number.isFinite(part.value) && part.value !== 0);
    const terms = parts.map(part => `${words(part.label, 24)} ${Math.abs(part.value)}`.trim());
    const body = [Number.isFinite(roll.d20) ? `d20 ${roll.d20}` : '', ...terms.map((term, at) => (Number.isFinite(roll.d20) || at ? `${parts[at].value < 0 ? '−' : '+'} ${term}` : term))].filter(Boolean).join(' ');
    const sum = Number.isFinite(roll.total) ? ` = ${roll.total}` : '';
    return body ? `${body}${sum}` : '';
}

// "Class II", or what the Character block calls it ("Level 3"): `soul` is its soulReading (null: the template's words).
const classText = (value, soul) => `${soul ? soulShortOf(soul.label, 'Class') : 'Class'} ${soul ? soul.word(value) : CLASS_NAMES[value - 1] ?? value}`;

// The party side of a Line: the die, the stat, the class, the skill's rank and the edge.
const pcRoll = (pc, skill, soul) => ({ d20: pc.die, total: pc.total, parts: [
    { label: words(pc.stat, 12).toUpperCase(), value: pc.statBonus }, { label: classText(pc.classValue, soul), value: pc.classBonus },
    { label: skill ? RANK_NAMES[pc.rank] ?? `Rank ${pc.rank}` : '', value: pc.rank }, { label: 'Edge', value: pc.edge }] });
const foeRoll = (foe, soul) => ({ d20: foe.die, total: foe.total, parts: [{ label: '', value: foe.base }, { label: classText(foe.classValue, soul), value: foe.classBonus }] });

// ---- the Standard formula's lines ----

const TYPE_WORDS = Object.freeze({ physical: 'Physical', magic: 'Magic', defence: 'Defence', social: 'Social', check: 'Check' });
const signed = value => `${value < 0 ? '−' : '+'} ${Math.abs(value)}`;

// "Physical: d20 17 + (AGI 10 + DEX 6/2)/2 = 6 + Expert 2 + Class II 4 + edge 1 = 29": the party side of a Standard line.
function pcStandard(raw, skill, soul) {
    const pc = raw.pc, stat = words(pc.stat, 12).toUpperCase(), second = words(pc.second, 12).toUpperCase();
    const head = `${TYPE_WORDS[raw.type] ?? 'Roll'}${words(pc.style, 12) ? `, ${words(pc.style, 12)}` : ''}`;
    const terms = [`${Number.isFinite(pc.die) ? `d20 ${pc.die} + ` : ''}(${stat} ${pc.mainValue} + ${second} ${pc.secondValue}/2)/2 = ${pc.statBonus}`];
    if (skill) terms.push(`+ ${RANK_NAMES[pc.rank] ?? `Rank ${pc.rank}`} ${pc.rank}`);
    if (pc.classBonus) terms.push(`+ ${classText(pc.classValue, soul)} ${pc.classBonus}`);
    if (Number.isFinite(pc.edge) && pc.edge !== 0) terms.push(`${signed(pc.edge).replace(' ', ' edge ')}${pc.window && pc.edge !== pc.situation ? ` (luck window ${pc.window.min}..${pc.window.max})` : ''}`);
    return `${head}: ${terms.join(' ')} = ${pc.total}`;
}

// What the told roll did to a bar: "Weir-drake loses 1 block (5 of 6)", "Wessel heals 2 blocks (6 of 6)".
function damageText(damage) {
    if (!isRecord(damage) || !Number.isFinite(damage.blocks) || damage.blocks === 0 || !Number.isFinite(damage.to) || !Number.isFinite(damage.size)) return '';
    const n = Math.abs(damage.blocks);
    return fill(damage.blocks > 0 ? B.loses : B.heals, { who: words(damage.name, 40), n, blocks: n === 1 ? B.blockOne : B.blockMany, to: damage.to, size: damage.size });
}

function breakdownStandard(raw, skill, soul, foeSide, against) {
    const theirs = foeSide ? `${words(foeSide.name, 40)} ${rollText(foeRoll(foeSide, soul))}`.trim() : Number.isFinite(against) ? `DC ${against}` : '';
    return [`${pcStandard(raw, skill, soul)}${theirs ? ` · vs ${theirs}` : ''}`, damageText(raw.damage), raw.decisive === true ? B.decisive : ''].filter(Boolean).join(' · ');
}

// One Line as the panel draws it: who acts, on whom, the acting side's total against the other's, and the roll behind it. A party
// act or check reads the party's total first; a foe's attack reads from the attacker's side, so the foe's total and roll come first.
function lineOf(raw, soulOf = () => null) {
    if (!isRecord(raw) || !isRecord(raw.pc) || !Number.isFinite(raw.pc.total)) return null;
    const outcome = outcomeOf(raw.outcome);
    const foeSide = isRecord(raw.foe) && Number.isFinite(raw.foe.total) ? raw.foe : null;
    const skill = words(raw.skill, 40), why = words(raw.why, 120), told = words(raw.breakdown, 400);
    // A foe's class is told in the words of the party member it is rolled against, so one line reads in one set of words.
    const soul = soulOf(words(raw.pc.who, 40));
    const mine = pcRoll(raw.pc, skill, soul);
    const against = raw.kind === 'check' ? (Number.isFinite(raw.dc) ? raw.dc : null) : foeSide?.total ?? null;
    const theirs = foeSide ? rollText(foeRoll(foeSide, soul)) : against !== null ? `DC ${against}` : '';
    const detail = (raw.kind === 'foe' ? [theirs, rollText(mine)] : [rollText(mine), theirs]).filter(Boolean).join(' vs ');
    // A Standard line (typed, with both stats of the pair recorded) tells its roll as the formula makes it; a Classic one is as it was.
    const standard = typeof raw.type === 'string' && Number.isFinite(raw.pc.mainValue) && Number.isFinite(raw.pc.secondValue);
    const breakdown = told || (standard ? breakdownStandard(raw, skill, soul, foeSide, against) : why ? `${detail} · ${why}` : detail);
    const base = { outcome, total: raw.pc.total, vs: against, skill, breakdown, arrows: [], ...(raw.decisive === true ? { decisive: true } : {}), ...(raw.area === true ? { area: true } : {}) };
    // A support action (a heal or a buff, a `check` line that names the one helped) reads like an act on that character.
    if (raw.kind === 'check' && raw.support === true && words(raw.target, 40)) return { ...base, who: words(raw.pc.who, 40), target: words(raw.target, 40), stat: words(raw.pc.stat, 12).toUpperCase(), foe: false, support: true, heals: isRecord(raw.damage) && raw.damage.blocks < 0 };
    if (raw.kind === 'foe') return { ...base, total: foeSide?.total ?? null, vs: raw.pc.total, who: words(foeSide?.name, 40), target: words(raw.pc.who, 40), skill: '', defence: skill, stat: words(raw.pc.stat, 12).toUpperCase(), foe: true };
    if (raw.kind === 'check') return { ...base, who: words(raw.pc.who, 40), target: '', stat: words(raw.pc.stat, 12).toUpperCase(), foe: false, what: skill || words(raw.pc.stat, 12).toUpperCase() };
    return { ...base, who: words(raw.pc.who, 40), target: words(foeSide?.name, 40), stat: words(raw.pc.stat, 12).toUpperCase(), foe: false };
}

/**
 * A's result record as the panel draws it: `{ rounds: [{ n, lines, skipped?: [{ who, why }] }], checks, order, orderEntries?, quickStart?, opening?, ended, refused }` or null when the
 * record holds nothing to show. A Line that is not whole is left out, never thrown on.
 */
export function readResolve(result, { soulOf = () => null } = {}) {
    if (!isRecord(result)) return null;
    const rounds = list(result.rounds).map((round, at) => {
        // Who does not act this round: Standard's `idle` entries (with why), or plain names (read as beaten before their turn).
        const skipped = list(round?.idle ?? round?.skipped).map(item => ({ who: words(isRecord(item) ? item.who ?? item.name : item, 40), why: IDLE[item?.why] ? item.why : 'beaten' })).filter(item => item.who);
        return { n: Number.isSafeInteger(round?.n) ? round.n : at + 1, lines: list(round?.lines).map(line => lineOf(line, soulOf)).filter(line => line?.who), ...(skipped.length ? { skipped } : {}) };
    }).filter(round => round.lines.length || round.skipped?.length);
    const opening = list(result.opening).map(line => lineOf(line, soulOf)).filter(line => line?.who);
    const checks = list(result.checks).map(line => lineOf(line, soulOf)).filter(line => line?.who);
    const refused = list(result.refused).filter(isRecord).map(item => ({ who: words(item.who, 40), why: words(item.text, 160) })).filter(item => item.why);
    if (!rounds.length && !checks.length) return null;
    // The order they act in: the names of the first round, each once.
    // The Standard formula records the order itself, with the totals rolled (result.order); else it is the names of the first round.
    const entries = list(result.order).filter(isRecord).map(item => ({ name: words(item.name, 40), total: Number.isFinite(item.total) ? item.total : null, party: item.party === true })).filter(item => item.name);
    const order = entries.length ? entries.map(item => item.name) : [...new Set(rounds[0]?.lines.map(line => line.who) ?? [])];
    const quickStart = list(result.quickStart).filter(isRecord).map(item => ({ who: words(item.who, 40), against: words(item.against, 40) })).filter(item => item.who && item.against);
    return { rounds, checks, refused, order, ...(entries.length ? { orderEntries: entries } : {}), ...(quickStart.length ? { quickStart } : {}), ...(opening.length ? { opening } : {}), ended: '' };
}

/** The recorded rolls of a reply's record: the result of its `rpg.resolve` receipt that the replay kept, or null. */
export function resolveOf(record, problems = [], options = {}) {
    const skipped = new Set(list(problems).flatMap(problem => list(problem?.receipts)));
    for (const receipt of list(record?.receipts)) {
        if (receipt?.type !== RESOLVE || skipped.has(receipt.id)) continue;
        const read = readResolve(receipt.data?.v2?.result, options);
        if (read) return read;
    }
    return null;
}

// What moved between the state before the reply and the reply's own: "Sluice Rat A Wounded", "Ren Tired".
function consequences(state, before, roleOf) {
    const out = [];
    const foesBefore = new Map(readFoes(before, { roleOf }).map(foe => [foe.name, foe]));
    for (const foe of readFoes(state, { roleOf })) {
        const was = foesBefore.get(foe.name);
        if (was && was.hurt !== foe.hurt) out.push({ name: foe.name, kind: 'health', text: `${foe.name} ${foe.word}` });
    }
    const was = new Map(readParty(before, { roleOf }).map(character => [`${character.module}|${character.subject}`, character]));
    for (const character of readParty(state, { roleOf })) {
        const old = was.get(`${character.module}|${character.subject}`);
        if (!old) continue;
        for (const key of BARS) if (old.bars[key].value !== character.bars[key].value) out.push({ name: character.name, kind: key, text: `${character.name} ${character.bars[key].word}` });
    }
    return out;
}

// The arrow goes on the last told action aimed at that name (a health change) or taken by it (mana, stamina), once. A change no
// told action explains is left to the Status block.
const same = (a, b) => a.normalize('NFKC').toLowerCase() === b.normalize('NFKC').toLowerCase();
function attach(model, changes) {
    const lines = [...(model.opening ?? []), ...model.rounds.flatMap(round => round.lines)];
    for (const change of changes) {
        const aimed = line => (change.kind === 'health' ? (line.target && same(line.target, change.name)) || (line.foe && same(line.who, change.name)) : same(line.who, change.name));
        lines.findLast(aimed)?.arrows.push(change.text);
    }
}

/**
 * The panel's content for a reply: the recorded rolls, the arrows, the Status rows and the Foes line.
 * `state` and `before` are the reply's state and the one before it (null for none).
 */
export function panelModel({ resolve, state, before = null, roleOf }) {
    const model = { ...resolve, rounds: resolve.rounds.map(round => ({ ...round, lines: round.lines.map(line => ({ ...line, arrows: [] })) })),
        ...(resolve.opening ? { opening: resolve.opening.map(line => ({ ...line, arrows: [] })) } : {}) };
    attach(model, consequences(state, before, roleOf));
    const names = new Set([...(model.opening ?? []), ...model.rounds.flatMap(round => round.lines)].flatMap(line => [line.who, line.target]));
    const party = readParty(state, { roleOf });
    const involved = party.filter(character => names.has(character.name));
    model.status = (involved.length ? involved : party).map(character => ({ name: character.name,
        rows: BARS.map(key => ({ key, ...character.bars[key], label: character.definition.state?.[key]?.label ?? RPG_STRINGS.bars[key] })) }));
    model.foes = model.rounds.length ? readFoes(state, { roleOf }).map(foe => ({ text: `${foe.count > 1 ? `${foe.name} ${fill(B.count, { n: foe.count })}` : foe.name}: ${foe.hurt === 0 ? B.down : foe.word}` })) : [];
    return model;
}

// ---- drawing --------------------------------------------------------------------------------------------------------

const el = (doc, tag, className = '', text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null && text !== '') node.textContent = String(text);
    return node;
};
const glyph = (doc, name) => {
    const node = el(doc, 'i', `fa-solid ${name}`);
    node.setAttribute('aria-hidden', 'true');
    return node;
};

/** The header's words: "Combat · Exchange 2", "Combat · Exchanges 1–3", or "Check" for a reply with only checks. */
export function headerText(model) {
    if (!model.rounds.length) return B.headerChecks;
    const first = model.rounds[0].n, last = model.rounds.at(-1).n;
    return first === last ? fill(B.header, { n: first }) : fill(B.headerMany, { from: first, to: last });
}

function lineNode(doc, line, { check = false } = {}) {
    const wrap = el(doc, 'div', 'rpg-act');
    const row = el(doc, 'button', 'rpg-act-line');
    row.setAttribute('type', 'button');
    const mark = el(doc, 'span', 'rpg-act-mark', line.breakdown ? '▸' : '');
    mark.setAttribute('aria-hidden', 'true');
    const text = el(doc, 'span', 'rpg-act-text');
    const outcome = line.outcome ? (line.decisive ? DECISIVE_WORDS[line.foe ? `foe-${line.outcome}` : line.outcome] ?? (line.foe ? FOE_WORDS[line.outcome] : B[line.outcome]) : line.foe ? FOE_WORDS[line.outcome] : B[line.outcome]) : '';
    if (check) text.append(fill(B.check, { who: line.who, what: line.what, total: line.total ?? '?', against: line.vs ?? '?', outcome }));
    else {
        // A heal or a help names the one helped ("Ren heals Wessel (Mend)"), never "attacks".
        if (line.support) {
            text.append(`${line.who} ${line.heals ? B.verbHeals : B.verbHelps} ${line.target}`);
            if (line.skill) { text.append(' ('); text.appendChild(el(doc, 'span', 'rpg-skill', line.skill)); text.append(')'); }
        } else {
            text.append(`${line.who} ${line.skill ? B.uses : B.attacks} `);
            if (line.skill) text.appendChild(el(doc, 'span', 'rpg-skill', line.skill));
            if (line.target) text.append(`${line.skill ? ` ${B.on} ` : ''}${line.target}${line.area ? ` (${B.area})` : ''}`);
        }
        // The skill a defender used ("Sluice Rat A attacks Astra (Iaijutsu) — Blocked"); a roll made before there were any has none.
        if (line.defence) {
            text.append(' (');
            text.appendChild(el(doc, 'span', 'rpg-skill', line.defence));
            text.append(')');
        }
        if (outcome) {
            text.append(' — ');
            text.appendChild(el(doc, 'span', `rpg-out rpg-out-${line.outcome}`, outcome));
        }
        if (line.total !== null && line.vs !== null) text.append(` (${fill(B.vs, { total: line.total, against: line.vs })})`);
        if (line.arrows.length) text.appendChild(el(doc, 'span', 'rpg-arrow', ` → ${line.arrows.join(', ')}`));
    }
    row.append(mark, text);
    wrap.appendChild(row);
    if (line.breakdown) {
        const why = el(doc, 'p', 'rpg-why', line.breakdown);
        why.hidden = true;
        row.setAttribute('aria-expanded', 'false');
        row.setAttribute('title', fill(B.details, { line: line.who }));
        row.addEventListener('click', () => {
            const open = why.hidden;
            why.hidden = !open;
            row.setAttribute('aria-expanded', String(open));
            mark.textContent = open ? '▾' : '▸';
        });
        wrap.appendChild(why);
    }
    return wrap;
}

/**
 * The panel node for `model` (panelModel). Options: `folded`, `onFold(folded)`, `variant` ('inline' in the message,
 * 'card' under the reply), `index` (the reply's message index, kept on the node).
 */
export function buildPanel(doc, model, { folded = false, onFold = () => {}, variant = 'inline', index = -1 } = {}) {
    const root = el(doc, 'div', `${BATTLE_ROOT} rpg-battle-${variant}`);
    // A root of Story Suite's look (view/theme.js): the tokens reach the panel inside a chat message.
    root.setAttribute('data-ss-screen', BATTLE_ID);
    root.setAttribute('data-variant', variant);
    root.setAttribute('data-ss-index', String(index));
    const head = el(doc, 'button', 'rpg-bl-head');
    head.setAttribute('type', 'button');
    const chevron = glyph(doc, 'fa-chevron-up');
    chevron.classList.add('rpg-bl-chevron');
    head.append(glyph(doc, model.rounds.length ? 'fa-shield-halved' : 'fa-dice-d20'), el(doc, 'b', 'rpg-bl-title', headerText(model)), chevron);
    const body = el(doc, 'div', 'rpg-bl-body');
    root.append(head, body);
    const setFold = on => {
        body.hidden = on;
        root.classList.toggle('rpg-bl-folded', on);
        head.setAttribute('aria-expanded', String(!on));
        head.setAttribute('title', on ? B.unfold : B.fold);
        chevron.className = `fa-solid ${on ? 'fa-chevron-down' : 'fa-chevron-up'} rpg-bl-chevron`;
    };
    setFold(folded);
    head.addEventListener('click', () => {
        const on = !body.hidden;
        setFold(on);
        onFold(on);
    });

    if (model.order.length) body.appendChild(el(doc, 'p', 'rpg-bl-order', `${B.turnOrder} ${(model.orderEntries ?? model.order.map(name => ({ name, total: null }))).map(item => (item.total === null ? item.name : `${item.name} ${item.total}`)).join(' > ')}`));
    for (const item of model.quickStart ?? []) body.appendChild(el(doc, 'p', 'rpg-bl-note rpg-bl-quick', fill(RPG_STRINGS.blocks.quickStartLine, item)));
    for (const check of model.checks) body.appendChild(lineNode(doc, check, { check: true }));
    if (model.opening?.length) {
        const box = el(doc, 'div', 'rpg-bl-round rpg-bl-opening');
        box.appendChild(el(doc, 'p', 'rpg-bl-round-title', B.opening));
        for (const line of model.opening) box.appendChild(lineNode(doc, line));
        body.appendChild(box);
    }
    for (const round of model.rounds) {
        const box = el(doc, 'div', 'rpg-bl-round');
        box.appendChild(el(doc, 'p', 'rpg-bl-round-title', fill(B.round, { n: round.n })));
        for (const line of round.lines) box.appendChild(lineNode(doc, line));
        for (const item of round.skipped ?? []) box.appendChild(el(doc, 'p', 'rpg-bl-note rpg-bl-skip', fill(IDLE[item.why], { who: item.who })));
        body.appendChild(box);
    }
    for (const item of model.refused) body.appendChild(el(doc, 'p', 'rpg-bl-note', fill(B.refused, { why: item.why })));
    if (model.ended) body.appendChild(el(doc, 'p', 'rpg-bl-ended', fill(B.ended, { how: model.ended })));
    if (model.rounds.length && model.status.length) {
        const status = el(doc, 'div', 'rpg-bl-status');
        status.appendChild(el(doc, 'p', 'rpg-bl-status-title', B.status));
        for (const who of model.status) {
            const row = el(doc, 'div', 'rpg-bl-who');
            row.setAttribute('data-who', who.name);
            row.appendChild(el(doc, 'b', 'rpg-bl-name', who.name));
            const cells = el(doc, 'div', 'rpg-bl-stats');
            row.appendChild(cells);
            for (const bar of who.rows) {
                const cell = el(doc, 'span', `rpg-bl-stat rpg-bl-${bar.key} rpg-bl-tone-${bar.tone ?? 'neutral'}`);
                const track = el(doc, 'span', 'rpg-bl-track');
                track.setAttribute('aria-hidden', 'true');
                track.style.setProperty('--rpg-fill', String(bar.max > 0 ? Math.round((bar.value / bar.max) * 1000) / 1000 : 0));
                track.appendChild(el(doc, 'span', 'rpg-bl-fill'));
                cell.append(el(doc, 'span', 'rpg-bl-label', bar.label), track, el(doc, 'span', 'rpg-bl-word', bar.word));
                cells.appendChild(cell);
            }
            status.appendChild(row);
        }
        if (model.foes.length) {
            const row = el(doc, 'div', 'rpg-bl-who rpg-bl-foes');
            row.append(el(doc, 'b', 'rpg-bl-name', B.foes), el(doc, 'span', 'rpg-bl-foe-list', model.foes.map(foe => foe.text).join(' · ')));
            status.appendChild(row);
        }
        body.appendChild(status);
    }
    return root;
}

// ---- finding the marker in a drawn message ---------------------------------------------------------------------------

const nodesOf = node => Array.from(node?.childNodes ?? []);
const SKIP = new Set(['PRE', 'CODE', 'SCRIPT', 'STYLE']);

/** The text nodes under `root` that hold a marker line (outside code and the panels themselves), in order. */
export function markerNodes(root) {
    const out = [];
    const walk = node => {
        for (const child of nodesOf(node)) {
            if (child.nodeType === 3) {
                if (String(child.data ?? child.textContent ?? '').split(/\r?\n/).some(line => MARKER_LINE.test(line))) out.push(child);
            } else if (child.nodeType === 1 && !SKIP.has(child.tagName) && !String(child.className ?? '').split(/\s+/).includes(BATTLE_ROOT)) walk(child);
        }
    };
    walk(root);
    return out;
}

// The marker text a panel took out of the story (placeAtMarker), kept on the panel itself.
const CONSUMED = Symbol('consumed marker');

/**
 * Takes a panel out of the message. An inline panel that stood in the place of a marker line leaves that line behind, so the place
 * is kept for the next time (switching the RPG off and on again draws the panel where the narrator wrote it).
 */
export function releasePanel(doc, panel) {
    const marker = panel?.[CONSUMED];
    const parent = panel?.parentNode;
    if (marker && parent) {
        const line = doc.createElement('p');
        line.textContent = marker;
        parent.insertBefore(line, panel);
    }
    panel?.remove?.();
}

const blank = node => (node.nodeType === 3 ? !String(node.data ?? node.textContent ?? '').trim() : node.tagName === 'BR');
const textOf = node => String(node.data ?? node.textContent ?? '');

/**
 * Takes the first marker line out of its paragraph and puts `panel` there: a paragraph that held other lines is split
 * in two around the panel, one that held only the marker is replaced. Returns true when a marker was found. Any other
 * marker line is taken out of the text.
 */
export function placeAtMarker(doc, root, panel) {
    const found = markerNodes(root);
    if (!found.length) return false;
    const [first, ...extra] = found;
    for (const node of extra) node.data = textOf(node).split(/\r?\n/).filter(line => !MARKER_LINE.test(line)).join('\n');
    const lines = textOf(first).split(/\r?\n/), at = lines.findIndex(line => MARKER_LINE.test(line));
    // The marker line is kept on the panel, so taking the panel away can put it back (releasePanel).
    panel[CONSUMED] = lines[at].trim();
    const parent = first.parentNode, siblings = nodesOf(parent), spot = siblings.indexOf(first);
    const before = siblings.slice(0, spot), after = siblings.slice(spot + 1);
    const tail = lines.slice(at + 1).join('\n'), tailNode = tail.trim() ? doc.createTextNode(tail) : null;
    first.data = lines.slice(0, at).join('\n');
    if (blank(first)) first.remove(); else before.push(first);
    // A line break right next to the marker belongs to it.
    while (before.length && blank(before.at(-1))) { const node = before.pop(); if (node !== first) node.remove(); }
    while (after.length && blank(after[0])) after.shift().remove();
    if (tailNode) after.unshift(tailNode);
    const hasBefore = before.some(node => !blank(node)), hasAfter = after.some(node => !blank(node));
    if (parent.tagName === 'P' && parent.parentNode) {
        const container = parent.parentNode, next = nodesOf(container)[nodesOf(container).indexOf(parent) + 1] ?? null;
        container.insertBefore(panel, next);
        if (hasAfter) {
            const rest = doc.createElement('p');
            for (const node of after) rest.appendChild(node);
            container.insertBefore(rest, nodesOf(container)[nodesOf(container).indexOf(panel) + 1] ?? null);
        }
        if (!hasBefore) parent.remove();
        return true;
    }
    const reference = after.find(node => node.parentNode === parent) ?? null;
    if (tailNode && tailNode.parentNode !== parent) parent.insertBefore(tailNode, reference);
    parent.insertBefore(panel, tailNode && tailNode.parentNode === parent ? tailNode : reference);
    return true;
}

// ---- following the chat ---------------------------------------------------------------------------------------------

const storage = doc => {
    try { return doc?.defaultView?.localStorage ?? globalThis.localStorage ?? null; } catch { return null; }
};

/** The viewer's fold per chat and reply (localStorage; this page only when it is not there). */
export function createFoldStore(doc) {
    const memory = new Set();
    const read = () => {
        try { return JSON.parse(storage(doc)?.getItem(FOLD_KEY) ?? '{}') ?? {}; } catch { return {}; }
    };
    return {
        has: key => (key in read() ? read()[key] === true : memory.has(key)),
        set(key, on) {
            if (on) memory.add(key); else memory.delete(key);
            const all = read();
            if (on) all[key] = true; else delete all[key];
            try { storage(doc)?.setItem(FOLD_KEY, JSON.stringify(all)); } catch { /* the choice lasts this page only */ }
        },
    };
}

/**
 * createBattleLog({ ctx, doc, store, events, featureOn, roleOf, messageElement? })
 * → { refresh(index, element?), refreshAll({ recent }), modelAt(index), latest(), destroy() }.
 * Draws, redraws or removes the panel of every drawn reply that has recorded rolls; `featureOn()` false removes them all.
 */
export function createBattleLog({ ctx, doc = globalThis.document, store, events = null, featureOn = () => true, roleOf, messageElement = null } = {}) {
    const chat = () => (Array.isArray(ctx?.chat) ? ctx.chat : []);
    const elementOf = messageElement ?? (index => doc.querySelector(`.mes[mesid="${index}"]`));
    const folds = createFoldStore(doc);
    const chatKey = () => String(ctx?.getCurrentChatId?.() ?? ctx?.chatId ?? '');
    const problems = () => { try { return store?.problems?.() ?? []; } catch { return []; } };
    const stateAt = index => { try { return store.at(index); } catch { return null; } };
    const beforeOf = index => {
        for (let at = index - 1; at >= 0; at -= 1) if (chat()[at] && !chat()[at].is_user && readRecord(chat()[at])) return stateAt(at);
        return null;
    };

    /** What reply `index` shows: { key, model } or null (no recorded rolls, a message of the reader's, the feature off). */
    function modelAt(index) {
        const message = chat()[index];
        if (!featureOn() || !message || message.is_user || message.is_system) return null;
        const record = readRecord(message);
        if (!record) return null;
        // What each party member calls the Soul Class comes from the reply's own state, read once and only when a line is drawn.
        let souls = null;
        const soulOf = who => {
            souls ??= new Map((stateAt(index) ? readParty(stateAt(index), { roleOf }) : []).map(character => [fold(character.name), soulReading(character.definition.state?.soul)]));
            return souls.get(fold(who)) ?? null;
        };
        const resolve = resolveOf(record, problems().filter(problem => problem?.index === index), { soulOf });
        const state = resolve ? stateAt(index) : null;
        if (!state) return null;
        return { key: `${chatKey()}|${record.sid ?? index}`, model: panelModel({ resolve, state, before: beforeOf(index), roleOf }) };
    }

    /** The latest reply with recorded rolls, searching the whole chat from the newest back: { index, key, model } or null. */
    function latest() {
        for (let index = chat().length - 1; index >= 0; index -= 1) {
            const shown = modelAt(index);
            if (shown) return { index, ...shown };
        }
        return null;
    }

    const panelsIn = message => Array.from(message.querySelectorAll(`.${BATTLE_ROOT}`));
    function placeCard(message, node) {
        const text = message.querySelector('.mes_text');
        const parent = text?.parentNode ?? message.querySelector('.mes_block') ?? message;
        const cards = nodesOf(parent).find(child => child.nodeType === 1 && String(child.className ?? '').split(/\s+/).includes('ss-cards'));
        if (node.parentNode === parent && (cards ? node.nextElementSibling === cards : true)) return;
        parent.insertBefore(node, cards ?? null);
    }

    function refresh(index, element = null) {
        const message = element ?? elementOf(index);
        if (!message) return null;
        const old = panelsIn(message);
        const shown = modelAt(index);
        if (!shown) {
            for (const node of old) releasePanel(doc, node);
            return null;
        }
        const text = message.querySelector('.mes_text');
        const marked = text ? markerNodes(text).length > 0 : false;
        const inline = old.find(node => node.getAttribute('data-variant') === 'inline');
        const variant = marked || inline ? 'inline' : 'card';
        const sign = JSON.stringify([shown.key, variant, shown.model, folds.has(shown.key)]);
        const kept = old.find(node => node.getAttribute('data-variant') === variant);
        if (!marked && kept && kept.getAttribute('data-ss-sign') === sign) {
            for (const node of old) if (node !== kept) node.remove();
            if (variant === 'card') placeCard(message, kept);
            return kept;
        }
        const node = buildPanel(doc, shown.model, { folded: folds.has(shown.key), variant, index, onFold: on => folds.set(shown.key, on) });
        node.setAttribute('data-ss-sign', sign);
        if (marked) {
            for (const item of old) item.remove();
            placeAtMarker(doc, text, node);
        } else if (variant === 'inline' && kept) {
            kept.parentNode.insertBefore(node, kept);
            if (kept[CONSUMED]) node[CONSUMED] = kept[CONSUMED];
            for (const item of old) item.remove();
        } else {
            for (const item of old) item.remove();
            placeCard(message, node);
        }
        return node;
    }

    function refreshAll({ recent = false } = {}) {
        const drawn = Array.from(doc.querySelectorAll('.mes[mesid]'));
        for (const message of recent ? drawn.slice(Math.max(0, drawn.length - RECENT_MESSAGES)) : drawn) {
            const index = Number(message.getAttribute('mesid'));
            if (Number.isInteger(index)) refresh(index, messageElement ? null : message);
        }
    }

    const offs = [];
    const source = ctx?.eventSource;
    const types = ctx?.eventTypes ?? ctx?.event_types ?? {};
    if (typeof source?.on === 'function') {
        const all = () => refreshAll({ recent: true });
        const forget = () => refreshAll();
        const wire = [
            [types.CHARACTER_MESSAGE_RENDERED, all], [types.USER_MESSAGE_RENDERED, all], [types.MESSAGE_SWIPED, all],
            [types.MESSAGE_EDITED, all], [types.MESSAGE_UPDATED, all], [types.MESSAGE_SENT, all],
            [types.MESSAGE_DELETED, forget], [types.CHAT_CHANGED, forget], [types.MORE_MESSAGES_LOADED, forget],
        ].filter(([type]) => type);
        for (const [type, fn] of wire) source.on(type, fn);
        offs.push(() => { for (const [type, fn] of wire) (source.removeListener ?? source.off)?.call(source, type, fn); });
    }
    if (typeof events?.on === 'function') {
        for (const name of ['turn', 'head', 'feature']) {
            const off = events.on(name, () => refreshAll({ recent: name !== 'feature' }));
            if (typeof off === 'function') offs.push(off);
        }
    }

    return {
        refresh, refreshAll, modelAt, latest,
        destroy() {
            offs.splice(0).forEach(off => off());
            for (const node of doc.querySelectorAll(`.${BATTLE_ROOT}`)) releasePanel(doc, node);
        },
    };
}
