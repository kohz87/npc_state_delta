// The Party tab: one card per Character block (you first, then block order), side by side on a wide screen and
// stacked on a phone. Each card has the name and role line, Soul Class, the XP bar, the three stage bars, the seven
// stats in a row and the skills from that character's Skills block. A character with points to spend shows
// "N points to spend" and a Spend points button; any other shows Stats. Both open the Spend points sheet (distribute.js)
// over the cards; Skills opens the character's Skills view (skills.js) the same way. A fallen character (`alive` false) is greyed
// and says "Fallen"; a companion who left the party (`left`, a `- party` line) is greyed too and says "Left". The header's "+ New character" (and "Create your character" when there is none) opens the New character
// wizard (wizard.js). The tab shows while the feature is on, with or without a Character block.
// Every node is built with createElement and textContent.

import { shell, h } from '../../view/widgets/dom.js';
import { meter } from '../../view/widgets/meter.js';
import { RPG_STRINGS, fill } from '../strings.js';
import { drawStageBars } from './bars.js';
import { newSession, renderDistribute } from './distribute.js';
import { readParty } from './party-data.js';
import { newSkillsSession, renderSkills } from './skills.js';

const P = RPG_STRINGS.party;
export const PARTY_WIDGET = 'rpg.party';
/** The id ends in `party`, so the navigation puts the tab right after Home (screens.js DEFAULT_ORDER). */
export const PARTY_SCREEN_ID = 'story-block/party';

/** The Party screen: a tab and a game-view screen. It is on while the feature is (the screen is only added then), so a story with no character yet can make one. */
export function createPartyScreen() {
    return Object.freeze({
        id: PARTY_SCREEN_ID, title: P.title, icon: 'fa-users', mounts: Object.freeze(['screen', 'tab']),
        template: `<ss-widget name="${PARTY_WIDGET}"></ss-widget>`,
    });
}

const sameCharacter = (a, b) => a.module === b.module && a.subject === b.subject;

/**
 * The Party widget. `deps`: `headState()` (the head state or null), `readerName()` (the reader's persona name),
 * `roleOf(definition)` (default: the definition's `role`), `openWizard()` (opens the New character dialog; without it there is no button).
 * The page draws a screen again from nothing on every change of the story, so what must outlive that, the open sheet and
 * its draft, is kept here, outside the widget (as Settings → Blocks keeps its editor): `shared.open` is the Spend points sheet's
 * session and `shared.skills` the Skills view's; at most one of them is open.
 */
export function createPartyWidget({ headState = () => null, readerName = () => '', roleOf, openWizard = null, rules = undefined } = {}) {
    const shared = { open: null, skills: null };
    const live = new Set();
    const tell = () => { for (const redraw of [...live]) redraw(); };
    return {
        props: {}, primary: null, validate: () => [],
        /** The sheet that is open (for tests and the page): the session, or null. */
        get open() { return shared.open; },
        render: (el, _props, api) => shell(el, 'section', 'rpg-party', ({ doc, root }) => {
            let handles = [], sheet = null, alive = true;
            const main = h(doc, 'div', 'rpg-main'), host = h(doc, 'div', 'rpg-sheet-host');
            root.append(main, host);

            const read = () => readParty(headState(), { own: readerName(), roleOf });
            const clear = () => {
                for (const handle of handles) handle.destroy?.();
                handles = [];
                main.replaceChildren();
                sheet?.destroy();
                sheet = null;
            };
            const button = (parent, text, cls, fn) => {
                const node = h(doc, 'button', cls, text);
                node.setAttribute('type', 'button');
                node.addEventListener('click', fn);
                parent.appendChild(node);
                return node;
            };

            // A sheet opened, closed or ended in any instance is drawn in every one that is on a page.
            const openSheet = character => { shared.open = newSession(character); shared.skills = null; tell(); };
            const closeSheet = () => { shared.open = null; tell(); };
            const ended = ({ ok }) => { if (ok) shared.open = null; tell(); };
            const openSkills = character => { shared.skills = newSkillsSession(character); shared.open = null; tell(); };
            const closeSkills = () => { shared.skills = null; tell(); };
            const newCharacter = () => { try { openWizard?.(); } catch { /* the dialog may not open here */ } };

            function card(parent, character) {
                const node = h(doc, 'article', `rpg-card ss-glass${character.alive && !character.left ? '' : ' rpg-fallen'}${character.left ? ' rpg-left' : ''}`);
                node.setAttribute('aria-label', character.name);
                node.setAttribute('data-character', character.name);
                parent.appendChild(node);
                const top = h(doc, 'div', 'rpg-top'), who = h(doc, 'div', 'rpg-who');
                who.appendChild(h(doc, 'p', 'rpg-name', character.name));
                who.appendChild(h(doc, 'span', 'rpg-sub', character.own ? P.own : P.companion));
                const pills = h(doc, 'div', 'rpg-pills');
                if (character.left) pills.appendChild(h(doc, 'span', 'ss-pill rpg-fallen-pill rpg-left-pill', P.left));
                else if (!character.alive) pills.appendChild(h(doc, 'span', 'ss-pill rpg-fallen-pill', P.fallen));
                pills.appendChild(h(doc, 'span', 'ss-pill', fill(P.soul, { label: character.soulLabel, name: character.soulName })));
                if (character.points > 0) pills.appendChild(h(doc, 'span', 'ss-pill rpg-points', fill(character.points === 1 ? P.pointsOne : P.points, { n: character.points })));
                top.append(who, pills);
                node.appendChild(top);
                const xp = h(doc, 'div', 'rpg-xp');
                node.appendChild(xp);
                handles.push(meter.render(xp, { label: P.xp, value: character.xp, max: 100, tone: 'accent', text: fill(P.xpText, { xp: character.xp }), icon: 'fa-star' }, {}));
                drawStageBars(doc, node, character, { api, handles });
                const stats = h(doc, 'div', 'rpg-stats');
                for (const stat of character.stats) {
                    const cell = h(doc, 'span', 'rpg-stat');
                    cell.setAttribute('data-stat', stat.key);
                    cell.append(stat.label, h(doc, 'b', '', String(stat.value)));
                    stats.appendChild(cell);
                }
                node.appendChild(stats);
                if (character.skillsBlock) node.appendChild(h(doc, 'div', 'rpg-skills', character.skills.length ? character.skills.map(skill => `${skill.name} (${skill.rankName})`).join(' · ') : P.noSkills));
                const actions = h(doc, 'div', 'rpg-card-actions');
                const spend = character.points > 0;
                button(actions, spend ? P.spend : P.stats, `ss-button${spend ? ' ss-button-primary' : ''} rpg-open`, () => openSheet(character));
                if (character.skillsBlock) button(actions, P.skills, 'ss-button rpg-skills-open', () => openSkills(character));
                node.appendChild(actions);
            }

            function draw() {
                if (!alive) return;
                clear();
                const party = read();
                const open = shared.open ? party.find(character => sameCharacter(character, shared.open)) : null;
                if (shared.open && !open) shared.open = null;
                const looking = shared.skills ? party.find(character => sameCharacter(character, shared.skills) && character.skillsBlock) : null;
                if (shared.skills && !looking) shared.skills = null;
                main.hidden = Boolean(open || looking);
                if (open) sheet = renderDistribute(host, { character: open, session: shared.open, api, doc, onClose: closeSheet, onDone: ended });
                else if (looking) sheet = renderSkills(host, { character: looking, session: shared.skills, api, doc, onBack: closeSkills, onSaved: tell, ...(rules ? { rules } : {}) });
                const head = h(doc, 'div', 'rpg-head');
                head.appendChild(h(doc, 'h3', '', P.title));
                const count = h(doc, 'div', 'rpg-pills');
                count.appendChild(h(doc, 'span', 'ss-pill', party.length === 1 ? P.countOne : fill(P.count, { n: party.length })));
                if (party.length && openWizard) button(count, P.newCharacter, 'ss-button rpg-new', newCharacter);
                head.appendChild(count);
                main.appendChild(head);
                if (!party.length) {
                    main.appendChild(h(doc, 'p', 'rpg-empty', P.empty));
                    if (openWizard) button(main, P.createFirst, 'ss-button ss-button-primary rpg-create', newCharacter);
                    return;
                }
                const grid = h(doc, 'div', 'rpg-cards');
                main.appendChild(grid);
                for (const character of party) card(grid, character);
            }

            live.add(draw);
            draw();
            return {
                update() { draw(); },
                destroy() { alive = false; live.delete(draw); clear(); },
            };
        }),
    };
}
