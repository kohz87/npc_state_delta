// The RPG's lines in "Changed this reply" (mockup 12-auto-lines): "Rolled for you: 3 exchanges" from the reply's recorded
// rolls, and the automatic rises, "Wessel reached Lv 15 (+1 point to spend)" and "Iron Breath: Adept → Expert", worked out from the
// state before the reply and the reply's own (the level and rank rules raise them; the display names come from the
// fields' `names`). They come in the shape `replyCardLines` gives (ui-host.js adds them to the card's `moduleLines`).
// Pure: no DOM.

import { CHECK_STEP, FIGHT, FORMULA, PRACTICE_STEP, RESOLVE, RANK_NAMES, STATS, USES } from '../index.js';
import { STANDARD, normalizeRules } from '../rules.js';
import { RPG_STRINGS, fill } from '../strings.js';
import { rpgBlocks, readParty, skillsOf } from './party-data.js';

const C = RPG_STRINGS.changes;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = value => (Array.isArray(value) ? value : []);
const words = value => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 40) : '');
const line = fields => ({ module: 'story-block', icon: 'fa-circle-info', text: '', summary: '', flag: '', note: '', kind: 'line', tone: 'info', check: null, ...fields });

/**
 * What the reply's `rpg.resolve` receipt says it rolled: `{ exchanges, pairs }` ("Wessel vs Sluice Rat A") or null.
 * The rolls piece's summary is `result.summary = { exchanges, acts: [{ kind, who, target, … }] }` (`exchanges` = rounds told); a record
 * without it is counted by its rounds.
 */
export function exchangesOf(record, problems = []) {
    const skipped = new Set(list(problems).flatMap(problem => list(problem?.receipts)));
    for (const receipt of list(record?.receipts)) {
        if (receipt?.type !== RESOLVE || skipped.has(receipt.id)) continue;
        const result = receipt.data?.v2?.result;
        if (!isRecord(result)) continue;
        const summary = isRecord(result.summary) ? result.summary : result;
        const rounds = list(result.rounds);
        const exchanges = Number.isSafeInteger(summary.exchanges) ? summary.exchanges : rounds.length;
        if (!(exchanges > 0)) continue;
        const acts = list(summary.acts);
        const pairs = [];
        for (const act of acts) {
            if (!isRecord(act) || act.kind !== 'act') continue;
            const who = words(act.who), target = words(act.target);
            const pair = who && target ? `${who} vs ${target}` : '';
            if (pair && !pairs.includes(pair)) pairs.push(pair);
        }
        return { exchanges, pairs };
    }
    return null;
}

/**
 * The numbers the reply's own roll was made with (`result.rules`, recorded with it), else null when the reply has no roll. A roll
 * recorded before the numbers were kept was made with Standard's. A display for that reply uses these, never today's settings.
 */
export function rulesOfReply(record, problems = []) {
    const skipped = new Set(list(problems).flatMap(problem => list(problem?.receipts)));
    for (const receipt of list(record?.receipts)) {
        if (receipt?.type !== RESOLVE || skipped.has(receipt.id)) continue;
        const result = receipt.data?.v2?.result;
        if (isRecord(result)) return result.rules === undefined ? STANDARD : normalizeRules(result.rules);
    }
    return null;
}

/**
 * Companions who joined or left on this reply (a `+ party` or `- party` line, or the reader's Add to party), from the reply's own receipts
 * (`data.join`, join.js): a swipe or a delete takes the receipt and so the line away, and a block the replay skipped is not told.
 */
export function partyLines(record, problems = []) {
    const skipped = new Set(list(problems).flatMap(problem => list(problem?.receipts)));
    const out = [];
    for (const receipt of list(record?.receipts)) {
        const join = receipt?.data?.join;
        if (!isRecord(join) || skipped.has(receipt.id)) continue;
        const who = words(join.name);
        if (!who) continue;
        // (the signature skills the join seeded, as its receipt recorded them: one tile each, shown from the receipt and never worked out from the pack)
        const seeded = list(receipt.data?.sigSkills).filter(skill => isRecord(skill) && words(skill.name));
        const skillTiles = () => seeded.map(skill => line({ icon: 'fa-book-open', tone: 'good', text: words(skill.name),
            flag: fill(C.skillSignature, { rank: RANK_NAMES[skill.rank] ?? RANK_NAMES[0] }),
            note: fill(C.skillStatUses, { stat: STATS.includes(skill.stat) ? skill.stat.toUpperCase() : '', uses: USES.includes(skill.uses) ? skill.uses.charAt(0).toUpperCase() + skill.uses.slice(1) : '' }) }));
        const summary = (plain, many) => (seeded.length ? fill(seeded.length === 1 ? C.joinedSkillOne : many, { who, n: seeded.length }) : plain);
        if (join.op === 'added') out.push(line({ icon: 'fa-user-plus', tone: 'good', text: fill(C.joined, { who }), summary: summary(fill(C.joinedSummary, { who }), C.joinedSkillsSummary), note: C.joinedNote }), ...skillTiles());
        else if (join.op === 'back') out.push(line({ icon: 'fa-user-plus', tone: 'good', text: fill(C.returned, { who }), summary: summary(fill(C.joinedSummary, { who }), C.returnedSkillsSummary) }), ...skillTiles());
        else if (join.op === 'left') out.push(line({ icon: 'fa-user-minus', tone: 'info', text: fill(C.left, { who }), summary: fill(C.leftSummary, { who }), note: C.leftNote }));
    }
    return out;
}

/**
 * The XP code gave for a fight this reply won (fight.js), one line each: "Astra +12 XP (fight won)", from the step's own receipt
 * (`data.v2.result.fight`): a swipe or a delete takes the receipt and so the line away, and a step the replay skipped is not told.
 */
export function fightLines(record, problems = []) {
    const skipped = new Set(list(problems).flatMap(problem => list(problem?.receipts)));
    const out = [];
    for (const receipt of list(record?.receipts)) {
        if (receipt?.type !== FIGHT || skipped.has(receipt.id)) continue;
        for (const award of list(receipt.data?.v2?.result?.fight?.awards)) {
            const who = words(award?.who);
            if (!who || !Number.isSafeInteger(award.xp) || award.xp <= 0) continue;
            out.push(line({ icon: 'fa-trophy', tone: 'good', text: fill(C.fightXp, { who, xp: award.xp }), summary: fill(C.fightXpSummary, { who, xp: award.xp }), note: C.fightXpNote }));
        }
    }
    return out;
}

/**
 * The practice code gave for the skills this reply's rolls used (practice.js), one line each: "Astra's Shadow Cut +6 practice (rolled)", from the
 * step's own receipt (`data.v2.result.practice.skills`; a story check's `rpg.check` step carries its practice the same way): a swipe or a delete takes the
 * receipt and so the line away, and a step the replay skipped is not told.
 */
export function practiceLines(record, problems = []) {
    const skipped = new Set(list(problems).flatMap(problem => list(problem?.receipts)));
    const out = [];
    for (const receipt of list(record?.receipts)) {
        if ((receipt?.type !== PRACTICE_STEP && receipt?.type !== CHECK_STEP) || skipped.has(receipt.id)) continue;
        for (const entry of list(receipt.data?.v2?.result?.practice?.skills)) {
            const who = words(entry?.who), skill = words(entry?.skill);
            if (!who || !skill || !Number.isSafeInteger(entry.amount) || entry.amount <= 0) continue;
            out.push(line({ icon: 'fa-dumbbell', tone: 'good', text: fill(C.practice, { who, skill, amount: entry.amount }), summary: fill(C.practiceSummary, { who, skill, amount: entry.amount }), note: C.practiceNote }));
        }
    }
    return out;
}

/**
 * The RPG's lines for one reply. `state` is the reply's state, `before` the one before it (null for the first reply: no
 * rises are told then), `record` the reply's record, `problems` the replay problems of that reply. `rules`: the numbers in force
 * now, used only for a reply that has no roll of its own (its roll's recorded numbers win).
 */
export function rpgReplyLines({ state, before = null, record = null, problems = [], roleOf, rules = null } = {}) {
    const out = [];
    rules = rulesOfReply(record, problems) ?? rules;
    const rolled = exchangesOf(record, problems);
    if (rolled) {
        const note = [rolled.pairs.slice(0, 2).join(' · '), C.rolledNote].filter(Boolean).join(' · ');
        out.push(line({ icon: 'fa-dice-d20', tone: 'info', text: fill(rolled.exchanges === 1 ? C.rolledOne : C.rolled, { n: rolled.exchanges }),
            summary: fill(rolled.exchanges === 1 ? C.rolledSummaryOne : C.rolledSummary, { n: rolled.exchanges }), note }));
    }
    out.push(...partyLines(record, problems));
    out.push(...fightLines(record, problems));
    out.push(...practiceLines(record, problems));
    if (!before) return out;
    const then = new Map(readParty(before, { roleOf }).map(character => [`${character.module}|${character.subject}`, character]));
    for (const character of readParty(state, { roleOf })) {
        const old = then.get(`${character.module}|${character.subject}`);
        if (!old) continue;
        const levelled = character.levelled === true && old.levelled === true;
        if (levelled) {
            if (!(character.level > old.level)) continue;
            // A point to spend comes with every third level (the Character template's level-up rule): said when the points went up.
            const gained = character.points - old.points;
            const plural = gained > 1 ? 'Many' : '';
            out.push(line({ icon: 'fa-arrow-up', tone: 'good', text: fill(gained > 0 ? C[`levelUpPoints${plural}`] : C.levelUp, { who: character.name, to: character.level, n: gained }),
                summary: fill(gained > 0 ? C[`levelSummaryPoints${plural}`] : C.levelSummary, { who: character.name, to: character.level, n: gained }),
                // (told only when the XP rule made the rise: the XP fell with it; a level typed by hand leaves the XP as it was)
                note: character.xp < old.xp ? fill(C.levelNote, { xp: character.xp }) : '' }));
            continue;
        }
        // A block of the earlier rules: its Soul Class rose; what that adds to every roll is classWeight x the rise.
        if (!(character.soul > old.soul)) continue;
        const bonus = (rules?.classWeight ?? FORMULA.classWeight) * (character.soul - old.soul);
        // A character made from 2.9.1 on gets 3 points to spend with each rise (the template's class-up rule): said when the points went up.
        const gained = character.points - old.points;
        const base = character.xp === 0 ? fill(bonus > 0 ? C.classNote : C.levelNote, { xp: character.xp, bonus }) : (bonus > 0 ? fill(C.classNoteShort, { bonus }) : '');
        out.push(line({ icon: 'fa-arrow-up', tone: 'good', text: fill(C.classUp, { who: character.name, label: character.soulLabel, from: old.soulName, to: character.soulName }),
            summary: fill(gained > 0 ? C.classSummaryPoints : C.classSummary, { label: character.soulLabel, to: character.soulName, n: gained }),
            note: gained > 0 ? [base, fill(C.classPoints, { n: gained })].filter(Boolean).join(' · ') : base }));
    }
    const skillsThen = new Map(rpgBlocks(before, { roleOf }).filter(block => block.role === 'skills').map(block => [`${block.module}|${block.subject}`, block]));
    const skillBlocks = rpgBlocks(state, { roleOf }).filter(block => block.role === 'skills');
    for (const block of skillBlocks) {
        const old = skillsThen.get(`${block.module}|${block.subject}`);
        if (!old) continue;
        const was = new Map(skillsOf(old).map(skill => [skill.slot, skill]));
        const who = words(block.fields.who);
        for (const skill of skillsOf(block)) {
            const earlier = was.get(skill.slot);
            if (!earlier || earlier.name !== skill.name || !(skill.rank > earlier.rank)) continue;
            out.push(line({ icon: 'fa-arrow-up', tone: 'good', text: fill(C.rankUp, { skill: skill.name, from: earlier.rankName, to: skill.rankName }),
                summary: fill(C.rankSummary, { skill: skill.name, to: skill.rankName }),
                note: who && skillBlocks.length > 1 ? fill(C.rankNoteWho, { who }) : C.rankNote }));
        }
    }
    return out;
}
