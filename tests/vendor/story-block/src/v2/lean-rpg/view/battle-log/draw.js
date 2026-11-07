// Draws the battle log panel and the no-rolls note with createElement and textContent only: header, turn order,
// checks, ambush, opening and rounds, breakdown on tap, status bars, foes and the no-rolls wording.

import { RPG_STRINGS, fill } from '../../strings.js';
import { B, FOE_WORDS, DECISIVE_WORDS, BATTLE_ROOT, BATTLE_ID, IDLE } from './constants.js';

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
            if (line.skill && line.gear && !line.foe) text.append(` (${line.gear})`);
            if (line.target) text.append(`${line.skill ? ` ${B.on} ` : ''}${line.target}${line.area ? ` (${B.area})` : ''}`);
            if (!line.skill && line.gear && !line.foe) text.append(` (${line.gear})`);
        }
        // The skill a defender used ("Sluice Rat A attacks Astra (Iaijutsu) — Blocked"); a roll made before there were any has none.
        if (line.defence) {
            text.append(' (');
            text.appendChild(el(doc, 'span', 'rpg-skill', line.defence));
            text.append(line.gear ? `, ${line.gear})` : ')');
        } else if (line.gear && line.foe) text.append(` (${line.gear})`);
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

    if (model.order.length) body.appendChild(el(doc, 'p', 'rpg-bl-order', `${B.turnOrder} ${(model.orderEntries ?? model.order.map(name => ({ name, total: null }))).map(item => { const name = item.level ? fill(RPG_STRINGS.blocks.orderNameLevel, item) : item.name; return item.total === null ? name : `${name} ${item.total}`; }).join(' > ')}`));
    // A lead from a worked ambush is told by the ambush line below; this line is the turn-order lead only.
    for (const item of model.ambush?.success ? [] : model.quickStart ?? []) body.appendChild(el(doc, 'p', 'rpg-bl-note rpg-bl-quick', fill(RPG_STRINGS.blocks.quickStartLine, item)));
    for (const check of model.checks) body.appendChild(lineNode(doc, check, { check: true }));
    if (model.ambush && (model.rounds.length || model.ambush.drop)) {
        const a = model.ambush, which = a.success ? (a.drop ? 'ambushDrop' : 'ambushWon') : a.half ? 'ambushHalf' : 'ambushLost';
        body.appendChild(el(doc, 'p', `rpg-bl-note rpg-bl-ambush rpg-bl-ambush-${a.success ? 'won' : 'lost'}`, fill(RPG_STRINGS.blocks[which], a)));
    }
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
        for (const text of round.wear ?? []) box.appendChild(el(doc, 'p', 'rpg-bl-note rpg-bl-wear', text));
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

/**
 * The note for a reply whose live fight got no rolls (noroll.js; approved mockup rpg-no-rolls.html): "No rolls this reply:" and the reason. It stands where the
 * battle log would have stood (the same slot, so placeAtMarker / placeCard take it), and is drawn from the reply's own receipt like the log is.
 */
export function noteText(note) {
    const reason = RPG_STRINGS.noRolls[note?.reason] ?? RPG_STRINGS.noRolls.failed;
    return fill(reason, { s: note?.limit ?? '' });
}
export function buildNote(doc, note, { variant = 'inline', index = -1 } = {}) {
    const root = el(doc, 'div', `${BATTLE_ROOT} rpg-norolls rpg-battle-${variant}`);
    root.setAttribute('data-ss-screen', BATTLE_ID);
    root.setAttribute('data-variant', variant);
    root.setAttribute('data-ss-index', String(index));
    root.setAttribute('role', 'note');
    const text = el(doc, 'span', 'rpg-norolls-text');
    text.append(el(doc, 'b', '', RPG_STRINGS.noRolls.lead), doc.createTextNode(` ${noteText(note)}`));
    root.append(el(doc, 'span', 'rpg-norolls-dot'), text);
    return root;
}
