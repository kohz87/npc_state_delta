// The slot card (Party -> Inventory, only while Gear in fights is on): a character's eight places and what is worn in each, in two columns
// (Head, Body, Cloak, Feet; Weapon, Off-hand, Accessory 1, Accessory 2), every tile the same size. A tile shows the place, the piece's name in its rarity
// colour and its stat bonus ("+2 DEX"); a thin line along its bottom is the condition (yellow Worn, orange Torn, red Broken; none when Good).
// A worn tile has Unequip (the piece goes back to the bag; a cast member's signature piece keeps its lock and has none); an empty tile has "Equip from bag",
// which lists the bag pieces that fit that place (item.equip for this member; a piece they or a companion carry is handed over with it).
// No carry and no list of carried things here: those are the Inventory tab's. Every node is built with createElement and textContent.

import { h, iconNode } from '../../view/widgets/dom.js';
import { RPG_STRINGS, fill } from '../strings.js';

const G = RPG_STRINGS.gear;
const P = RPG_STRINGS.party;

/** The places in drawing order: the left column, then the right one (the card lays them out in two columns of four). */
export const SLOT_ORDER = Object.freeze(['head', 'body', 'cloak', 'feet', 'weapon', 'off-hand', 'accessory-1', 'accessory-2']);

const ICONS = Object.freeze({
    head: 'fa-helmet-safety', body: 'fa-shirt', cloak: 'fa-cloud', feet: 'fa-shoe-prints',
    weapon: 'fa-khanda', 'off-hand': 'fa-shield-halved', 'accessory-1': 'fa-ring', 'accessory-2': 'fa-gem',
});

/** The record the Party tab keeps for an open slot card (outside the DOM: the page draws a screen again on every change of the story). */
export const newGearSession = character => ({ module: character.module, subject: character.subject });

/**
 * Draws `character`'s slot card into `parent`. `view` is the answer of `gear.view` for them ({ slots }); `onBack()` closes the card.
 * → { el, destroy() }
 */
export function renderGearCard(parent, { character, view, onBack = () => {}, api = null, onChanged = () => {}, doc = parent.ownerDocument ?? globalThis.document } = {}) {
    const root = h(doc, 'section', 'rpg-sheet rpg-gear ss-glass');
    root.setAttribute('aria-label', fill(G.title, { name: character.name }));
    parent.appendChild(root);
    const head = h(doc, 'div', 'rpg-sheet-head');
    head.appendChild(h(doc, 'h3', 'rpg-sheet-name', fill(G.title, { name: character.name })));
    head.appendChild(h(doc, 'span', 'ss-pill rpg-level-pill', character.levelText));
    root.appendChild(head);
    const slots = h(doc, 'div', 'rpg-slots');
    const problem = h(doc, 'p', 'rpg-gear-error');
    problem.setAttribute('role', 'alert');
    const baseOf = key => String(key).replace(/-\d+$/, '');
    // One command from a tile; a refusal shows its sentence under the tiles, success redraws the card.
    const run = async (button, type, payload) => {
        if (typeof api?.command !== 'function') return;
        button.disabled = true;
        let result;
        try { result = await api.command(type, payload); } catch (failure) { result = { ok: false, message: String(failure?.message ?? failure) }; }
        button.disabled = false;
        if (result?.ok) onChanged(); else problem.textContent = String(result?.message ?? '') || G.failed;
    };
    const act = (body, text, label, fn) => {
        const button = h(doc, 'button', 'ss-button rpg-slot-act', text);
        button.setAttribute('type', 'button');
        button.setAttribute('aria-label', label);
        button.addEventListener('click', fn);
        body.appendChild(button);
        return button;
    };
    for (const place of SLOT_ORDER) {
        const piece = view?.slots?.[place] ?? null;
        const tile = h(doc, 'div', `rpg-slot${piece ? ` r-${piece.rarity}${piece.word === 'good' ? '' : ` w-${piece.word}`}` : ' rpg-slot-empty'}`);
        tile.setAttribute('data-slot', place);
        const icon = h(doc, 'i', `fa-solid ${ICONS[place]} rpg-slot-icon`);
        icon.setAttribute('aria-hidden', 'true');
        const body = h(doc, 'span', 'rpg-slot-body');
        if (piece) {
            body.appendChild(h(doc, 'span', 'rpg-slot-place', G.slots[place]));
            body.appendChild(h(doc, 'span', 'rpg-slot-name', piece.name));
            if (piece.bonus) body.appendChild(h(doc, 'span', 'rpg-slot-bonus', piece.bonus));
            if (api && !piece.bound) { const off = act(body, G.unequip, fill(G.unequipLabel, { name: piece.name }), () => run(off, 'inventory.unequip', { stack: piece.stack })); }
            const who = typeof piece.bound?.who === 'string' && piece.bound.who ? piece.bound.who : '';
            tile.setAttribute('title', `${piece.name}: ${G.words[piece.word] ?? piece.word}${piece.broken ? ` — ${G.noBonus}` : ''}${who ? ` · ${fill(G.boundTile, { name: who })}` : ''}`);
            tile.appendChild(icon);
            tile.appendChild(body);
            tile.appendChild(h(doc, 'span', 'rpg-slot-cond'));
            // A cast member's signature piece: the lock in the tile's top-right corner.
            if (who) {
                const lock = iconNode(doc, 'ph-lock-simple:fill', 'rpg-slot-lock');
                if (lock) { lock.setAttribute('aria-label', fill(G.boundTile, { name: who })); lock.removeAttribute('aria-hidden'); lock.setAttribute('role', 'img'); tile.classList.add('bound'); tile.appendChild(lock); }
            }
        } else {
            body.appendChild(h(doc, 'span', 'rpg-slot-place', `${G.slots[place]} — ${G.empty}`));
            tile.appendChild(icon);
            tile.appendChild(body);
            const fits = (view?.bag ?? []).filter(entry => baseOf(entry.fits) === baseOf(place));
            if (api && view?.owner) {
                const list = h(doc, 'span', 'rpg-slot-bag');
                list.hidden = true;
                const open = act(body, G.equipFrom, `${G.equipFrom}: ${G.slots[place]}`, () => { list.hidden = !list.hidden; open.setAttribute('aria-expanded', String(!list.hidden)); });
                open.setAttribute('aria-expanded', 'false');
                if (!fits.length) list.appendChild(h(doc, 'span', 'rpg-slot-bonus', G.bagNone));
                for (const entry of fits) {
                    const pick = h(doc, 'button', `ss-button rpg-slot-pick r-${entry.rarity}`, entry.bonus ? `${entry.name} · ${entry.bonus}` : entry.name);
                    pick.setAttribute('type', 'button');
                    pick.setAttribute('aria-label', fill(G.equipLabel, { name: entry.name }));
                    pick.addEventListener('click', () => run(pick, 'item.equip', { stack: entry.stack, owner: view.owner, slot: place, transfer: true }));
                    list.appendChild(pick);
                }
                body.appendChild(list);
            }
        }
        slots.appendChild(tile);
    }
    root.append(slots, problem);
    const foot = h(doc, 'div', 'rpg-actions');
    const back = h(doc, 'button', 'ss-button ss-button-primary rpg-gear-back', G.back);
    back.setAttribute('type', 'button');
    back.addEventListener('click', () => onBack());
    foot.append(back, h(doc, 'p', 'rpg-sheet-note', G.note));
    root.appendChild(foot);
    return { el: root, destroy() { root.remove(); } };
}
