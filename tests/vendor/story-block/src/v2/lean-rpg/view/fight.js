// The Fight tab (approved mockup, section 5): the Foes block's own tab while the feature is on. It shows only while any foe slot
// is filled. A header "Fight · <place>" with the note about automatic rolls and two pills ("Exchange N" from the latest rolls,
// "N foes · M down"), the turn order row (Standard: rolled at the start of the fight, drawn from the latest rolls' record), a card per foe (name, Class pill, five-cell health bar, greyed when Down; a tap on the bar or its pencil edits
// the foe's health, a choice of the stage words saved through `dm.set`, as on the Party card; names are edited in Settings → Blocks), a card per
// character with the three stage bars, and "Last exchange": the latest reply's battle-log panel with a button that scrolls the chat to
// that reply and closes the game view. Wide screen a grid, phone a stack.
// Every node is built with createElement and textContent.

import { h, shell } from '../../view/widgets/dom.js';
import { editable } from '../../view/widgets/editable.js';
import { meter } from '../../view/widgets/meter.js';
import { CLASS_NAMES } from '../names.js';
import { RPG_STRINGS, fill } from '../strings.js';
import { buildPanel } from './battle-log.js';
import { drawStageBars } from './bars.js';
import { barOptions, foesOf, readParty, rpgBlocks, soulName, stageMax, stageTone } from './party-data.js';

const F = RPG_STRINGS.fight;
export const FIGHT_WIDGET = 'rpg.fight';
/** The id ends in `fight`, so the navigation puts the tab at Fight's place (screens.js DEFAULT_ORDER). */
export const FIGHT_SCREEN_ID = 'story-block/fight';

/** The foes of every Foes block, filled slots only: `foesOf`'s records with where each one is kept (for the pencil), its health bar and the words of its stages. */
export function readFight(state, { roleOf } = {}) {
    return rpgBlocks(state, { roleOf }).filter(block => block.role === 'foes').flatMap(block => foesOf(block).map(foe => {
        const schema = block.definition.state?.[`hurt${foe.slot}`], max = foe.blocks ? foe.max : stageMax('health', schema);
        return { ...foe, module: block.module, subject: block.subject, max, tone: stageTone(Math.min(foe.hurt, max), max), down: foe.hurt <= 0,
            className: soulName(block.definition.state?.[`class${foe.slot}`], foe.class) || CLASS_NAMES[foe.class - 1] || String(foe.class),
            stages: barOptions('health', schema, { max, blocks: foe.blocks }), locked: schema?.edit === false };
    }));
}

/** Whether any foe slot is filled (the Fight tab shows only then). */
export const hasFoes = (state, options) => rpgBlocks(state, options).some(block => block.role === 'foes' && foesOf(block).length > 0);

/** The Fight screen: a tab and a game-view screen, on only while a foe slot is filled. `roleOf` as for the readers. */
export function createFightScreen({ roleOf } = {}) {
    return Object.freeze({
        id: FIGHT_SCREEN_ID, title: F.title, icon: 'fa-skull', mounts: Object.freeze(['screen', 'tab']),
        template: `<ss-widget name="${FIGHT_WIDGET}"></ss-widget>`,
        active: state => ({ on: hasFoes(state, { roleOf }) }),
        activeNote: 'Shown only while a foe is in the Foes block.',
    });
}

const placeOf = state => {
    const name = state?.domains?.scene?.place?.name;
    return typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
};

/**
 * The Fight widget. `deps`: `headState()`, `readerName()`, `roleOf(definition)`, `battleLog` (createBattleLog's handle: `latest()` is the
 * latest reply with recorded rolls, `{ index, model }`, or null), `closeView()` (closes the game view), `showReply(index)` (scrolls the
 * chat to that reply; default: SillyTavern's `.mes[mesid]` element scrolls into view).
 */
export function createFightWidget({ headState = () => null, readerName = () => '', roleOf, battleLog = null, closeView = () => {}, showReply = null } = {}) {
    return {
        props: {}, primary: null, validate: () => [],
        render: (el, _props, api) => shell(el, 'section', 'rpg-fight', ({ doc, root }) => {
            let handles = [], alive = true;
            const clear = () => {
                for (const handle of handles) handle.destroy?.();
                handles = [];
                root.replaceChildren();
            };
            const scroll = showReply ?? (index => doc.querySelector(`.mes[mesid="${index}"]`)?.scrollIntoView?.({ block: 'start' }));
            const latest = () => { try { return battleLog?.latest?.() ?? null; } catch { return null; } };

            function foeCard(parent, foe) {
                const node = h(doc, 'article', `rpg-foe ss-glass${foe.down ? ' rpg-down' : ''}`);
                node.setAttribute('data-foe', foe.name);
                parent.appendChild(node);
                const top = h(doc, 'div', 'rpg-foe-top');
                top.appendChild(h(doc, 'p', 'rpg-name', foe.count > 1 ? `${foe.name} ${fill(RPG_STRINGS.battle.count, { n: foe.count })}` : foe.name));
                const side = h(doc, 'span', 'rpg-foe-side');
                side.appendChild(h(doc, 'span', 'ss-pill', fill(F.class, { name: foe.className })));
                top.appendChild(side);
                node.appendChild(top);
                // The health bar is the edit: a tap on it (or its pencil) opens the choice of stage words for this slot's `hurtN`.
                const bar = h(doc, 'div', 'rpg-foe-bar rpg-bar'), slot = h(doc, 'div', 'rpg-bar-meter'), edit = h(doc, 'div', 'rpg-bar-edit');
                bar.setAttribute('data-foe-health', String(foe.slot));
                bar.append(slot, edit);
                node.appendChild(bar);
                handles.push(meter.render(slot, { label: F.health, value: Math.min(foe.hurt, foe.max), max: foe.max, tone: foe.tone, text: foe.blocks ? foe.text : foe.down ? F.down : foe.word, segments: foe.max, icon: 'fa-heart' }, {}));
                if (typeof api?.command !== 'function' || foe.locked) return;
                handles.push(editable.render(edit, { value: Math.min(foe.hurt, foe.max), kind: 'choice', options: foe.stages, label: fill(F.editHealth, { name: foe.name }), displayValue: false,
                    command: 'dm.set', payload: { module: foe.module, field: `hurt${foe.slot}`, ...(foe.subject ? { who: foe.subject } : {}) } }, { command: api.command }));
                edit.querySelector('.ss-w-editable-pencil')?.setAttribute('title', fill(F.editHealth, { name: foe.name }));
            }

            function draw() {
                if (!alive) return;
                clear();
                const state = headState(), foes = readFight(state, { roleOf }), party = readParty(state, { own: readerName(), roleOf });
                const shown = latest(), place = placeOf(state);
                const head = h(doc, 'div', 'rpg-head');
                const title = h(doc, 'div', 'rpg-fight-title');
                title.appendChild(h(doc, 'h3', '', place ? fill(F.titleAt, { place }) : F.title));
                title.appendChild(h(doc, 'p', 'rpg-fight-note', foes.some(foe => foe.blocks) ? RPG_STRINGS.blocks.foeNote : F.note));
                const pills = h(doc, 'div', 'rpg-pills');
                const rounds = shown?.model?.rounds ?? [];
                if (rounds.length) pills.appendChild(h(doc, 'span', 'ss-pill rpg-exchange', fill(F.exchange, { n: rounds.at(-1).n })));
                const total = foes.reduce((sum, foe) => sum + foe.count, 0), down = foes.reduce((sum, foe) => sum + (foe.down ? foe.count : 0), 0);
                pills.appendChild(h(doc, 'span', 'ss-pill rpg-foe-count', fill(total === 1 ? F.foesOne : F.foes, { n: total, down })));
                head.append(title, pills);
                root.appendChild(head);

                // The turn order rolled at the start of this fight (the Standard formula records it with the rolls): "1 Wessel 21 · 2 Weir-drake 18 …".
                // A record without one (Classic, or no roll yet) draws nothing here.
                const order = shown?.model?.orderEntries ?? [];
                if (order.length) {
                    const row = h(doc, 'div', 'rpg-order');
                    row.appendChild(h(doc, 'b', 'rpg-order-head', RPG_STRINGS.blocks.orderHead));
                    order.forEach((item, at) => {
                        const pill = h(doc, 'span', `ss-pill rpg-order-pill${item.party ? ' rpg-order-party' : ''}`, fill(RPG_STRINGS.blocks.orderEntry, { n: at + 1, name: item.name }));
                        if (item.total !== null) pill.appendChild(h(doc, 'b', '', String(item.total)));
                        row.appendChild(pill);
                    });
                    row.appendChild(h(doc, 'span', 'rpg-order-note', RPG_STRINGS.blocks.orderNote));
                    root.appendChild(row);
                }
                for (const item of shown?.model?.quickStart ?? []) root.appendChild(h(doc, 'p', 'rpg-quick-start', fill(RPG_STRINGS.blocks.quickStart, item)));
                if (foes.length) {
                    root.appendChild(h(doc, 'h4', 'rpg-fight-h', F.foesHead));
                    const grid = h(doc, 'div', 'rpg-foes');
                    root.appendChild(grid);
                    for (const foe of foes) foeCard(grid, foe);
                }
                if (party.length) {
                    root.appendChild(h(doc, 'h4', 'rpg-fight-h', F.partyHead));
                    const grid = h(doc, 'div', 'rpg-fight-party');
                    root.appendChild(grid);
                    for (const character of party) {
                        const card = h(doc, 'article', `rpg-pc ss-glass${character.alive ? '' : ' rpg-fallen'}`);
                        card.setAttribute('data-character', character.name);
                        card.appendChild(h(doc, 'p', 'rpg-name', character.name));
                        drawStageBars(doc, card, character, { api: null, handles });
                        grid.appendChild(card);
                    }
                }
                if (shown?.model) {
                    const row = h(doc, 'div', 'rpg-fight-lasthead');
                    row.appendChild(h(doc, 'h4', 'rpg-fight-h', F.lastHead));
                    const go = h(doc, 'button', 'ss-button rpg-see', F.seeIt);
                    go.setAttribute('type', 'button');
                    go.addEventListener('click', () => { try { closeView(); } finally { scroll(shown.index); } });
                    row.appendChild(go);
                    root.appendChild(row);
                    const last = h(doc, 'div', 'rpg-fight-last');
                    last.appendChild(buildPanel(doc, shown.model, { folded: false, variant: 'inline', index: shown.index }));
                    root.appendChild(last);
                }
            }

            draw();
            return {
                update() { draw(); },
                destroy() { alive = false; clear(); },
            };
        }),
    };
}
