// Export a character (mockup: Export on a Party card): Story Block's own dialog, opened by the Export button next to Spend points and Skills.
// It saves `<name>.character.json` (charfile.js) with what the reader leaves on:
//   Character  always: Soul Class, unspent points, the seven stats and up to five skills (name, what it does, stat, Stamina or Mana, rank)
//   Inventory  a checkbox, on: the things that character carries, as the Inventory tab shows them for that owner (the party's bag for a You,
//              plus the party actor of the same name when a party module lists one; a companion's own actor only)
//   Money      a checkbox, on, and only on the reader's own card: the purse as its value in the currency's smallest unit
// Not saved: the name, who they are, XP, Health, Mana and Stamina, skill practice, anything about the story. The window reads the story
// again every time it is drawn, so it shows what is true now. Every node is built with createElement and textContent.

import { h, shell } from '../../view/widgets/dom.js';
import { saveTextFile } from '../../view/download.js';
import { DEFAULT_CURRENCY } from '../../domains/money.js';
import { FILE_LIMITS, buildCharacterFile, fileNameOf, fileText, itemLine, itemsForFile, moneyText, skillLine, thingsWord } from '../charfile.js';
import { CREATION, STATS, USES } from '../names.js';
import { fold } from '../read.js';
import { RPG_STRINGS, fill } from '../strings.js';
import { readParty } from './party-data.js';
import { statsLine } from './wizard-data.js';

const X = RPG_STRINGS.exp;
const P = RPG_STRINGS.party;
export const EXPORT_SCREEN_ID = 'story-block/export-character';
export const EXPORT_WIDGET = 'rpg.export';

// How many things the dialog lists before "and N more".
const LISTED = 8;

const safe = (fn, fallback) => { try { return fn() ?? fallback; } catch { return fallback; } };
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const oneLine = (value, max) => [...String(value ?? '').replace(/\s+/g, ' ').trim()].slice(0, max).join('').trim();

/** The Export dialog's screen: one body, drawn by the export widget. */
export function createExportScreen() {
    return Object.freeze({
        id: EXPORT_SCREEN_ID, title: X.title, icon: 'fa-file-export', mounts: Object.freeze(['dialog']),
        template: `<ss-widget name="${EXPORT_WIDGET}"></ss-widget>`,
    });
}

/**
 * What a card's character gives a saved file, from the party record `character` (party-data.js): { soul, points, stats, skills } in the file's shape
 * (every value inside the file's limits, whatever the block held).
 */
export function characterOfCard(character) {
    const stats = Object.fromEntries(STATS.map(key => {
        const found = character.stats.find(stat => stat.key === key);
        return [key, clamp(Number.isSafeInteger(found?.value) ? found.value : CREATION.start, ...FILE_LIMITS.stat)];
    }));
    const skills = character.skills.slice(0, 5).map(skill => ({
        name: oneLine(skill.name, CREATION.skillName), about: oneLine(skill.about, CREATION.skillAbout),
        ...(STATS.includes(skill.stat) ? { stat: skill.stat } : {}), uses: USES.includes(skill.uses) ? skill.uses : USES[0],
        rank: clamp(Number.isSafeInteger(skill.rank) ? skill.rank : 0, 0, FILE_LIMITS.rank),
    }));
    return { soul: clamp(character.soul, ...FILE_LIMITS.soul), points: clamp(character.points, 0, FILE_LIMITS.points), stats, skills };
}

/**
 * The export dialog. `deps`: `headState()`, `readerName()`, `roleOf(definition)`, `openDialog(id, { draft, onClose })` (the host's dialog mount;
 * without it there is nothing to open). → { screen, widget, open(character), session(), destroy() }; `character` is a party record (module, subject, name).
 */
export function createExporter({ headState = () => null, readerName = () => '', roleOf, openDialog = null } = {}) {
    let session = null;

    function open(character) {
        if (typeof openDialog !== 'function' || !character || session?.handle?.isOpen?.()) return null;
        const own = { module: character.module, subject: character.subject, name: character.name, inventory: true, money: true, handle: null, message: '' };
        session = own;
        const handle = openDialog(EXPORT_SCREEN_ID, { draft: {}, onClose: () => { if (session === own) session = null; } });
        if (!handle) { if (session === own) session = null; return null; }
        own.handle = handle;
        // The window's title names the character ("Export Wessel").
        try {
            const heading = fill(X.heading, { name: character.name });
            const title = handle.root?.querySelector?.('.ss-dialog-title');
            if (title) title.textContent = heading;
            handle.root?.setAttribute?.('aria-label', heading);
        } catch { /* the generic title stays */ }
        return handle;
    }

    const widget = {
        props: {}, primary: null, validate: () => [],
        render: (el, _props, api) => shell(el, 'section', 'rpg-export', ({ doc: d, root }) => {
            const run = session;
            let alive = true;
            const body = h(d, 'div', 'rpg-exp-body');
            root.appendChild(body);

            const query = (name, args, fallback) => safe(() => api?.query?.(name, args), fallback);
            // The record for the character the window was opened on, read again from the story now (null when they are gone).
            const find = () => {
                const party = safe(() => readParty(headState(), { own: String(readerName() ?? '').replace(/\s+/g, ' ').trim(), roleOf }), []);
                return party.find(character => character.module === run?.module && character.subject === run?.subject) ?? null;
            };
            // Who holds what this character carries: a You has the party's bag, and every character has the party actor of their name.
            const ownersOf = character => {
                const actors = query('party.actors', {}, []);
                const named = (Array.isArray(actors) ? actors : []).filter(actor => typeof actor?.id === 'string' && fold(actor.name) === fold(character.name)).map(actor => actor.id);
                return [...new Set([...(character.own ? ['party'] : []), ...named])];
            };
            const whatIs = character => {
                const rows = ownersOf(character).flatMap(owner => { const list = query('inventory.items', { owner }, []); return Array.isArray(list) ? list : []; });
                const purse = character.own ? query('inventory.wallet', { owner: 'party' }, {})?.coin : null;
                return { items: itemsForFile(rows), money: Number.isSafeInteger(purse) && purse > 0 ? Math.min(purse, FILE_LIMITS.money) : 0, currency: query('inventory.currency', {}, null) ?? DEFAULT_CURRENCY };
            };
            const close = () => { try { run?.handle?.close?.(); } catch { /* already closed */ } };

            function draw() {
                if (!alive) return;
                body.replaceChildren();
                const character = run ? find() : null;
                if (!character) {
                    body.appendChild(h(d, 'p', 'rpg-exp-note', X.gone));
                    const gone = h(d, 'div', 'rpg-actions');
                    const done = h(d, 'button', 'ss-button', X.cancel);
                    done.setAttribute('type', 'button');
                    done.addEventListener('click', close);
                    gone.appendChild(done);
                    body.appendChild(gone);
                    return;
                }
                const card = characterOfCard(character), carried = whatIs(character);
                const wantItems = run.inventory && carried.items.length > 0, wantMoney = run.money && carried.money > 0;
                body.appendChild(h(d, 'p', 'rpg-exp-note', X.note));

                const option = (key, title, lines, { checked, disabled = false, help = '' }) => {
                    const box = h(d, 'label', 'rpg-exp-opt');
                    box.setAttribute('data-option', key);
                    const input = h(d, 'input', 'rpg-exp-check');
                    input.setAttribute('type', 'checkbox');
                    input.checked = checked;
                    if (disabled) input.disabled = true;
                    input.setAttribute('aria-label', title);
                    const text = h(d, 'small', 'rpg-exp-lines');
                    for (const line of lines) text.appendChild(h(d, 'span', '', line));
                    if (help) text.appendChild(h(d, 'span', 'rpg-exp-help', help));
                    box.append(input, h(d, 'b', '', title), text);
                    body.appendChild(box);
                    return input;
                };

                // Character: always.
                const points = card.points === 0 ? X.noPoints : fill(card.points === 1 ? P.pointsOne : P.points, { n: card.points });
                const soulName = character.soulName;
                option('character', X.character, [
                    fill(X.soulLine, { label: character.soulLabel, soul: soulName, points }),
                    statsLine({ stats: card.stats }),
                    card.skills.length ? fill(X.skillsLine, { list: card.skills.map(skillLine).join(' · ') }) : X.noSkills,
                ], { checked: true, disabled: true });

                // Inventory: the things carried.
                const shown = carried.items.slice(0, LISTED).map(itemLine);
                if (carried.items.length > LISTED) shown.push(fill(X.more, { n: carried.items.length - LISTED }));
                const inventory = option('inventory', carried.items.length ? fill(X.inventory, { things: thingsWord(carried.items.length) }) : X.inventoryNone,
                    carried.items.length ? [shown.join(' · ')] : [], { checked: wantItems, disabled: carried.items.length === 0, help: carried.items.length ? X.inventoryHelp : '' });
                inventory.addEventListener('change', () => { run.inventory = Boolean(inventory.checked); draw(); });

                // Money: only on the reader's own card.
                if (character.own) {
                    const money = option('money', carried.money > 0 ? fill(X.money, { amount: moneyText(carried.money, carried.currency) }) : X.moneyNone,
                        [], { checked: wantMoney, disabled: carried.money === 0, help: carried.money > 0 ? X.moneyHelp : '' });
                    money.addEventListener('change', () => { run.money = Boolean(money.checked); draw(); });
                }
                body.appendChild(h(d, 'p', 'rpg-exp-note rpg-exp-notsaved', X.notSaved));

                const actions = h(d, 'div', 'rpg-actions rpg-exp-actions');
                const cancel = h(d, 'button', 'ss-button rpg-exp-cancel', X.cancel);
                cancel.setAttribute('type', 'button');
                cancel.addEventListener('click', close);
                const name = fileNameOf(character.name);
                const save = h(d, 'button', 'ss-button ss-button-primary rpg-exp-save');
                save.setAttribute('type', 'button');
                const icon = h(d, 'i', 'fa-solid fa-download');
                icon.setAttribute('aria-hidden', 'true');
                save.append(icon, h(d, 'span', '', X.save), h(d, 'span', 'rpg-exp-file', name));
                save.addEventListener('click', () => {
                    // Read the story again at the moment of saving, so the file is what is true then.
                    const now = find();
                    if (!now) { draw(); return; }
                    const again = whatIs(now);
                    const file = buildCharacterFile({ ...characterOfCard(now), items: run.inventory && again.items.length ? again.items : null, money: now.own && run.money && again.money > 0 ? again.money : null });
                    try {
                        saveTextFile(d, fileText(file), fileNameOf(now.name), 'application/json;charset=utf-8');
                    } catch {
                        status.textContent = X.failed;
                        return;
                    }
                    close();
                });
                const status = h(d, 'p', 'rpg-wiz-status', run.message);
                status.setAttribute('role', 'status');
                actions.append(status, cancel, save);
                body.appendChild(actions);
            }

            draw();
            return { update() { draw(); }, destroy() { alive = false; body.replaceChildren(); } };
        }),
    };

    return { screen: createExportScreen(), widget, open, session: () => session, destroy() { try { session?.handle?.close?.(); } catch { /* already closed */ } session = null; } };
}
