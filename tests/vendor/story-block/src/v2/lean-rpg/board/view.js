// The touch-first fight board: status chips (foe groups, party), a one-line log, the choosing member's Mana/Stamina strip and a grid of skill buttons.
// It reads the staged session and calls its pure rules; only metadata holds unsent choices.
// Text is placed in DOM nodes, never interpreted as markup.

import { button, h } from '../../view/widgets/dom.js';
import { zoomOf } from '../../view/scroll.js';
import { discardHeld, heldForSid } from '../../turn/held-board.js';
import { readFoes, readParty, stageTone } from '../view/party-data.js';
import { readSheet } from '../read.js';
import { planGear } from '../gear.js';
import { isStandard } from '../rules.js';
import { boardFlags } from './overrides.js';
import { resourceStrip, skillButton, statusChips, targetButton } from './view-chips.js';
import { boardChoices, foeChips, groupTarget, memberGroups as groupsOfMembers, memberOrderLine, memberTargetLine, partyChips, stagedLine, pendingAwards, pendingAwardsLine, standingMembers, targetLabel } from './view-data.js';
import { boardSession, discardBoard, openBoard, reconcileBoard, stageExchange } from './session.js';
import { equipmentForBoard, playBoard } from './engine.js';
import { labelAreaGroup, labelLine, settledNote } from './note.js';
import { areaLineGroups } from './order.js';
import { dropOf } from '../ambush.js';
import { AUTO_CAP, autoExchanges } from '../names.js';
import { autoNote, runAuto } from './auto-run.js';

// Send acts on the press itself: the board may redraw between press and release (a save, a head event), which would
// lose the click on a replaced button and make the reader press twice. Fires once; a keyboard click still works.
export const pressButton = (doc, text, cls, act) => {
    const node = h(doc, 'button', cls, text);
    node.setAttribute('type', 'button');
    let fired = false;
    const fire = event => { if (fired || node.disabled) return; fired = true; event.preventDefault(); act(); };
    node.addEventListener('pointerdown', event => { if (event.button === 0 || event.pointerType === 'touch') fire(event); });
    node.addEventListener('click', fire);
    return node;
};
// The note for a fight that starts from the last fight's exact bars.
const resumedLine = (members, carried) => {
    const packed = members.some(member => member?.pack);
    const total = Object.values(carried?.counts ?? {}).reduce((sum, n) => sum + (Number(n) || 0), 0) || members.length;
    const standing = members.filter(member => member?.standing !== false && Number(member?.value ?? member?.hurt) > 0).length;
    return `↺ These foes are as you left them${packed ? '' : `: ${standing} of ${total} standing`}, with their bars from the last fight.`;
};

export function createBoardView({ doc, headState, meta, save, store, rules, query, readerName, roleOf, levels, on = () => false, start = null, cap = () => AUTO_CAP.default } = {}) {
    let logOpen = false, notice = '', autoLine = '', chosen = [], targeting = null, confirm = false, busy = false, generation = 0, activeId = null, keyRoot = null, listening = false, lockedChoices = [];
    const releaseAfterResult = () => {
        const wait = () => setTimeout(() => {
            busy = false;
            for (const line of lockedChoices) line.disabled = false;
            lockedChoices = [];
        }, 400);
        const frame = doc.defaultView?.requestAnimationFrame?.bind(doc.defaultView);
        if (frame) frame(() => frame(wait)); else wait();
    };
    const persist = () => { try { save?.(); } catch { /* staging still works in this page */ } };
    const current = () => boardSession(meta());
    const reset = () => { logOpen = false; chosen = []; targeting = null; confirm = false; notice = ''; autoLine = ''; };
    const equipment = state => {
        const sheet = readSheet(state), gear = planGear(sheet, (name, args) => query?.(name, args), readerName());
        const weapons = {};
        for (const [key, entry] of Object.entries(gear?.who ?? {})) for (const owner of entry.own ?? []) {
            let item = null;
            try { item = query?.('inventory.gear', { owner })?.slots?.weapon; } catch { /* no equipment */ }
            if (item && !item.broken) { weapons[key] = item; break; }
        }
        return { gear, weapons };
    };
    const fresh = (session, state) => {
        if (session.exchanges.length) return;
        const { gear, weapons } = equipment(state);
        session.setup.flags = boardFlags(state);
        session.setup.weapons = weapons;
        if (gear) session.setup.gear = gear; else delete session.setup.gear;
    };
    const snapshot = state => {
        if (!on()) return null;
        reconcileBoard(meta(), id => (store?.receipts?.() ?? []).some(entry => entry?.receipt?.id === id));
        const index = store?.headIndex?.(), sid = store?.carrierSid?.(index);
        const held = heldForSid(meta(), sid, (store?.receipts?.() ?? []).filter(entry => entry.index === index).map(entry => entry.receipt));
        const heldBoard = held?.current?.prechecks?.find(step => step.type === 'rpg.resolve' && step.payload?.board)?.payload.board;
        const session = current() ?? (heldBoard ? { ...heldBoard, origin: heldBoard.id.split(':')[0] } : null);
        if (!session) return null;
        const matched = session.anchor === sid;
        if (!held && !matched && !session.exchanges.length) return null;
        if (session.id !== activeId) { activeId = session.id; reset(); }
        if (!held) fresh(session, state);
        const played = held ? { error: meta()?.rpgFightHeldDiscarded?.[sid]
            ? 'The fight was discarded. Regenerate the held reply.'
            : 'The fight reply is waiting. Restore the sheet or gear, or discard the fight (Fight tab, Discard fight) and regenerate the reply.' }
            : !matched ? { error: 'The fight no longer matches this reply. Restore the reply or discard the fight (Fight tab, Discard fight).' }
            : !isStandard(rules()) ? { error: 'The fight board needs Standard rules. Switch back to Standard or discard this fight.' }
            : playBoard(state, session.setup, session.exchanges);
        return { session, played, heldSid: held ? sid : null };
    };
    // Whether the Fight tab draws a board now (the gate of `snapshot`, with none of its writes): a held reply's fight, a staged exchange, or a board
    // open on the head reply. The Fight tab stays listed for it with no foe on the sheet, so "Fight tab, Discard fight" always has a place to go.
    const kept = () => {
        if (!on()) return false;
        const index = store?.headIndex?.(), sid = store?.carrierSid?.(index), session = current();
        if (heldForSid(meta(), sid, (store?.receipts?.() ?? []).filter(entry => entry.index === index).map(entry => entry.receipt))) return true;
        return Boolean(session) && (session.exchanges?.length > 0 || session.anchor === sid);
    };
    const open = ({ state = headState(), opening = null, result: approach = null } = {}) => {
        if (!on() || !isStandard(rules())) return false;
        const sid = store?.carrierSid?.(store.headIndex?.()), { gear, weapons } = equipment(state);
        const result = openBoard(meta(), state, { sid, rules: rules(), gear, weapons, records: store?.receipts?.() ?? [] });
        if (result.error) return false;
        if (opening) {
            result.session.setup.opening = structuredClone(opening);
            result.session.setup.approach = structuredClone(approach?.checks ?? []);
            result.session.setup.drop = dropOf(approach);
        }
        persist(); reset();
        activeId = result.session.id;   // (the first draw must not reset what Auto says)
        return true;
    };
    // Auto plays up to the cap's exchanges on the staged fight; every one is an ordinary staged exchange, and the reader may pick by hand after.
    const auto = () => {
        if (busy || !current()) return false;
        const ran = runAuto({ meta: meta(), state: headState(), rules: rules(), cap: autoExchanges(cap()) });
        if (ran.error && !ran.done) { notice = ran.error; return false; }
        chosen = []; targeting = null; confirm = false; notice = ran.error ?? '';
        autoLine = autoNote({ ...ran, waiting: Boolean(start?.waiting?.()) });
        persist();
        return true;
    };
    const offer = (root, redraw) => {
        if (!on() || !isStandard(rules())) return;
        const state = headState(), sheet = readSheet(state);
        if (!sheet.foes.some(foe => foe.filled && foe.hurt > 0)) return;
        const box = h(doc, 'div', 'rpg-board-offer ss-glass');
        box.appendChild(h(doc, 'p', '', 'Choose each exchange on the fight board, or keep telling the story.'));
        box.appendChild(button(doc, 'Fight on the board', 'ss-button ss-button-primary rpg-board-open', () => {
            if (!open()) { box.appendChild(h(doc, 'p', 'rpg-board-error', 'The fight could not be opened.')); return; }
            redraw();
        }));
        box.appendChild(button(doc, 'Auto-fight', 'ss-button rpg-board-open-auto', () => {
            if (!open()) { box.appendChild(h(doc, 'p', 'rpg-board-error', 'The fight could not be opened.')); return; }
            auto(); redraw();
        }));
        root.appendChild(box);
    };
    const render = (root, snapshot, redraw, handles, settings = {}) => {
        const { session, played, heldSid } = snapshot, thisGeneration = ++generation;
        const discard = () => { discardBoard(meta()); if (heldSid) discardHeld(meta(), heldSid); start?.discard?.(); persist(); reset(); redraw(); };
        const confirmDiscard = panel => {
            panel.appendChild(h(doc, 'p', '', 'Discard this fight and its unsent exchanges?'));
            const pair = h(doc, 'div', 'rpg-board-actions rpg-board-confirm-row');   // one row, 8px apart (never stacked)
            pair.appendChild(button(doc, 'Discard fight', 'ss-button rpg-board-confirm', discard));
            pair.appendChild(button(doc, 'Cancel', 'ss-button', () => { confirm = false; redraw(); }));
            panel.appendChild(pair);
        };
        if (notice) root.appendChild(h(doc, 'p', 'rpg-board-error', notice));
        if (!listening) { doc.addEventListener?.('keydown', keydown, true); listening = true; }
        keyRoot = root;
        root.classList.add('rpg-board-active');
        root.classList.toggle('rpg-board-finished', !played.error && played.result.stop !== 'open');
        if (played.error) {
            root.appendChild(h(doc, 'p', 'rpg-board-error', played.error));
            const panel = h(doc, 'div', 'rpg-board-controls');
            if (confirm) confirmDiscard(panel); else panel.appendChild(button(doc, 'Discard fight', 'ss-button rpg-board-discard', () => { confirm = true; redraw(); }));
            root.appendChild(panel);
            return;
        }
        const tools = h(doc, 'div', 'rpg-board-actions');   // Back / Auto / Discard in one row, under the skills
        const state = played.state, { ranks, playerRank } = levels(), party = readParty(state, { own: readerName(), roleOf, ranks, playerRank }).filter(character => character.left !== true), foes = readFoes(state, { roleOf, ranks });   // a member who left the party is not drawn
        const members = Array.isArray(played.result.members) ? played.result.members : null;
        root.classList.toggle('rpg-board-members', members !== null);
        const body = h(doc, 'div', 'rpg-board-body');   // status, log and controls: one column on a phone, two when the board is wide (board.css)
        root.appendChild(body);
        const status = h(doc, 'div', 'rpg-board-status');   // foe groups and the party as chips; sticky on a phone
        const cards = statusChips(doc, { party: partyChips(party), foes: members ? foeChips(members, foes)
            : foes.map(foe => ({ name: foe.name, level: foe.level, count: foe.count, value: foe.hurt, max: foe.max ?? 5, tone: foe.hurt ? stageTone(foe.hurt, foe.max ?? 5) : 'bad' })) });
        status.appendChild(cards);
        if (session.resumed && members) status.appendChild(h(doc, 'p', 'rpg-board-resumed', resumedLine(members, session.setup.carriedMembers)));
        body.appendChild(status);
        const ended = played.result.stop !== 'open', sending = ended && Boolean(start?.sending?.());
        const log = h(doc, 'details', 'rpg-board-log rpg-battle');   // one line; a tap opens the full log (open at the end of a fight)
        const logContent = h(doc, 'div', 'rpg-board-log-content');
        log.setAttribute('aria-live', 'polite');
        log.open = ended || logOpen;   // the reader's open log stays open across redraws during a fight
        log.addEventListener('toggle', () => { logOpen = log.open && !ended; });
        if (played.result.order.length) {
            const line = members ? memberOrderLine(played.result.order, members, foes) : `Order: ${played.result.order.map(item => item.name).join(' · ')}`;
            if (line) logContent.appendChild(h(doc, 'p', 'rpg-board-order', line));
        }
        const history = (store?.receipts?.() ?? []).map(entry => entry.receipt?.data?.v2?.result).filter(result => result?.board?.id === session.id);
        let lastRound = 0;
        for (const result of [...history, played.result]) {
            for (const line of result.opening ?? []) logContent.appendChild(h(doc, 'p', '', `Opening · ${labelLine(line)}`));
            for (const round of result.rounds ?? []) {
                lastRound = round.n;
                logContent.appendChild(h(doc, 'p', 'rpg-board-round', `Exchange ${round.n}`));
                for (const group of areaLineGroups(round.lines)) logContent.appendChild(h(doc, 'p', '', group[0].aoe ? labelAreaGroup(group) : labelLine(group[0])));
                for (const item of round.idle ?? []) if (item.why === 'no-resource') logContent.appendChild(h(doc, 'p', '', `${item.who} cannot heal: the skill's resource is Empty.`));
            }
        }
        if (!lastRound) logContent.appendChild(h(doc, 'p', '', 'Choose an action to begin.'));
        log.appendChild(h(doc, 'summary', '', lastRound ? `Exchange ${lastRound} · tap to read the full log` : 'Choose an action to begin.'));
        log.appendChild(logContent);
        body.appendChild(log);
        const panel = h(doc, 'div', 'rpg-board-controls');
        const gear = session.setup.gear ? equipmentForBoard(state, session.setup.gear) : {};
        const areaAll = session.setup.areaAll === 1;   // the newer area rule: one tap, every group alike. A fight staged before it keeps the main-group choice.
        const memberGroupList = members ? groupsOfMembers(members, foes, { aoe: session.setup.aoe === 1 }) : null;
        const data = boardChoices(state, { ...session.setup, ...gear }, chosen, memberGroupList);
        const standing = members ? standingMembers(members) : data.foes;
        const targetGroups = members ? groupsOfMembers(members, foes) : null;   // plain group names for single targets (the area list above names them as an area does)
        const nameAt = slot => standing.find(foe => foe.slot === slot)?.name ?? '';
        if (confirm) confirmDiscard(panel);
        else if (ended) {
            if (autoLine) panel.appendChild(h(doc, 'p', 'rpg-board-auto-note', autoLine));
            panel.appendChild(h(doc, 'h4', 'rpg-board-end', `Fight ${played.result.stop}`));
            panel.appendChild(h(doc, 'p', 'rpg-board-end-description', start?.waiting?.() ? 'Your waiting message carries the approach and this fight in one reply.' : 'Your next message carries this fight; the narrator tells it first.'));
            const awards = pendingAwards(state, session, played.result, settings);
            const xp = awards.xp.filter(item => item.amount > 0).map(item => `${item.who} +${item.amount} XP`).join(', ');
            const practice = awards.practice.map(item => `${item.who}: ${item.skill} +${item.amount}`).join(', ');
            panel.appendChild(h(doc, 'p', 'rpg-board-awards', `Pending XP: ${xp || 'none'}. Pending practice: ${practice || 'none'}.`));
            panel.appendChild(h(doc, 'p', 'rpg-board-awards-phone', pendingAwardsLine(awards)));
            if (sending) panel.appendChild(h(doc, 'p', 'rpg-board-sending', 'Sending… the narrator is writing the reply.'));
            else if (start?.waiting?.()) panel.appendChild(pressButton(doc, 'Send with this fight', 'ss-button ss-button-primary rpg-board-send', () => {
                start.send(); redraw();
            }));
        } else {
            if (autoLine) panel.appendChild(h(doc, 'p', 'rpg-board-auto-note', autoLine));
            const mode = targeting?.mode, mainTarget = mode === 'main' && session.setup.aoe === 1;
            const steps = h(doc, 'div', 'rpg-board-step-row');
            steps.appendChild(h(doc, 'p', 'rpg-board-prompt', mainTarget ? `${data.actor?.who ?? 'Party'}: ${targeting.action.skill} (area)` : targeting ? (mode === 'group' || mode === 'main' ? 'Choose a group' : 'Choose a target') : `${data.actor?.who ?? 'Party'}: choose an action`));
            if (data.actors.length > 1) steps.appendChild(h(doc, 'small', 'rpg-board-step', `${Math.min(chosen.length + 1, data.actors.length)} of ${data.actors.length}`));
            panel.appendChild(steps);
            for (const action of chosen) panel.appendChild(h(doc, 'p', 'rpg-board-staged', stagedLine(action, action.target === undefined ? '' : nameAt(action.target) || String(action.target))));
            if (mainTarget) panel.appendChild(h(doc, 'p', 'rpg-board-area-note', 'Hits every enemy group. The group you pick takes the full effect, and the others take one Health block less.'));
            if (!targeting && data.resources) panel.appendChild(resourceStrip(doc, data.resources));
            if (!targeting && data.defence) panel.appendChild(h(doc, 'p', 'rpg-board-defence', `Defence: ${data.defence}`));   // only a named defence skill, on one line
            const list = h(doc, 'div', 'rpg-board-choices');
            const memberBar = member => ({ value: Number(member?.value ?? member?.hurt) || 0, max: Number(member?.size) || 1 });
            const options = !targeting ? data.choices
                : mode === 'main' ? memberGroupList.map((group, at) => ({ label: session.setup.aoe === 1 ? `Main target: ${group.label}` : `${at + 1}. ${group.label}`, group: group.group, literal: true }))
                    : mode === 'group' ? targetGroups.map((group, at) => ({ ...groupTarget(group, at), picked: group, literal: true }))
                        : mode === 'members' ? targeting.picked.members.map((member, at) => ({ label: memberTargetLine(member, at + 1), target: member.slot, ...memberBar(member), tone: stageTone(memberBar(member).value, memberBar(member).max), literal: true }))
                            : standing.map(foe => ({ label: targetLabel(foe), target: foe.slot }));
            const take = item => {
                if (busy || thisGeneration !== generation || item.reason) return;
                notice = '';
                if (targeting) {
                    if (mode === 'main') chosen.push({ ...targeting.action, group: item.group });
                    else if (mode === 'group') {
                        if (item.picked.members.length > 1) { targeting = { mode: 'members', action: targeting.action, picked: item.picked }; redraw(); return; }   // a group of several opens its members
                        chosen.push({ ...targeting.action, target: item.picked.members[0].slot });
                    } else chosen.push({ ...targeting.action, target: item.target });
                    targeting = null;
                }
                else if (item.action.kind === 'flee') chosen = [item.action];
                else if (item.action.support) chosen.push(item.action);
                else if (item.action.area && members && !areaAll) {
                    if (memberGroupList.length > 1) targeting = { mode: 'main', action: item.action };
                    else chosen.push({ ...item.action, ...(memberGroupList[0] ? { group: memberGroupList[0].group } : {}) });
                }
                else if (item.action.area) chosen.push({ ...item.action });   // one tap: every group in reach alike
                else if (members && targetGroups.length > 1) targeting = { mode: 'group', action: item.action };
                else if (members && targetGroups[0]?.members.length > 1) targeting = { mode: 'members', action: item.action, picked: targetGroups[0] };
                else if (!members && standing.length > 1) targeting = { mode: 'foe', action: item.action };
                else chosen.push({ ...item.action, target: standing[0]?.slot });
                let rolled = false;
                if (!targeting && (chosen[0]?.kind === 'flee' || chosen.length === data.actors.length)) {
                    const result = stageExchange(meta(), headState(), chosen);
                    reset();
                    if (result.error) notice = result.error;
                    else { persist(); busy = true; rolled = true; }
                }
                redraw();
                if (rolled) releaseAfterResult();
            };
            // Auto sits in the one row under the choices, between Back and Discard.
            const autoNode = targeting ? null : pressButton(doc, autoLine ? 'Auto again' : 'Auto', 'ss-button ss-button-primary rpg-board-auto', () => { if (!busy && auto()) redraw(); });
            if (autoNode) autoNode.disabled = busy;
            options.forEach((item, at) => {
                const line = item.view ? skillButton(doc, { ...item.view, blocked: item.reason }) : item.max !== undefined ? targetButton(doc, item) : h(doc, 'button', '', item.literal ? item.label : `${at + 1}  ${item.label}`);
                line.setAttribute('type', 'button');
                line.classList.add('rpg-board-choice');
                if (item.reason) line.title = item.reason; else if (item.view?.about) line.title = item.view.about;
                line.addEventListener('click', () => take(item));
                line.disabled = Boolean(item.reason) || busy;
                if (busy && !item.reason) lockedChoices.push(line);
                line.setAttribute('data-choice', String(at + 1)); list.appendChild(line);
            });
            panel.appendChild(list);
            if (!targeting && autoLine && session.exchanges.length && start?.waiting?.() && !start.sending?.())
                panel.appendChild(pressButton(doc, 'Send with this fight', 'ss-button ss-button-primary rpg-board-send', () => { start.send(); redraw(); }));
            if (targeting || chosen.length) tools.appendChild(button(doc, 'Back', 'ss-button rpg-board-back', () => { if (targeting) targeting = null; else chosen.pop(); redraw(); }));
            if (autoNode) tools.appendChild(autoNode);
        }
        if (ended) panel.classList.add('rpg-board-ended');
        if (!sending) {
            tools.appendChild(button(doc, 'Discard fight', 'ss-button rpg-board-discard', () => { confirm = true; redraw(); }));
            panel.appendChild(tools);
        }
        const details = h(doc, 'details', 'rpg-board-note');
        details.appendChild(h(doc, 'summary', '', 'What the narrator will be told'));
        details.appendChild(h(doc, 'p', '', settledNote(played.result, session.setup)));
        panel.appendChild(details);
        body.appendChild(panel);
        // Nothing inside the board scrolls; the page does. Keep the controls clear of the floating bar on a phone after choices or targeting change their height.
        const phone = doc.defaultView?.matchMedia?.('(max-width: 759.98px)');
        if (!ended && phone?.matches) {
            const scroller = root.closest?.('.story-suite-sheet-body, .ss-gameview-body');
            const frame = scroller?.closest?.('.story-suite-sheet, .ss-gameview');
            const bar = frame?.querySelector?.('.story-suite-sheet-bar, .ss-gameview-nav');
            const bodyBox = scroller?.getBoundingClientRect?.(), barBox = bar?.getBoundingClientRect?.(), panelBox = panel.getBoundingClientRect?.();
            const statusBox = status.getBoundingClientRect?.();
            if (bodyBox?.height && panelBox?.height) {
                const limit = Math.min(bodyBox.bottom, barBox?.height ? barBox.top : bodyBox.bottom) - 8, zoom = zoomOf(scroller);
                // The sticky status stays clear of the controls: never scroll the panel's top under it, and keep the controls' scroll margin at its height.
                const pinned = statusBox?.height ? bodyBox.top + statusBox.height + 4 : bodyBox.top;
                panel.style.scrollMarginTop = `${Math.round((statusBox?.height ?? 0) / zoom) + 4}px`;
                if (panelBox.bottom > limit) scroller.scrollTop += Math.max(0, Math.min(panelBox.bottom - limit, panelBox.top - pinned)) / zoom;
            }
        }
    };
    const keydown = event => {
        if (!keyRoot || event.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
        if (event.key === 'Escape' && targeting) { event.preventDefault?.(); event.stopImmediatePropagation?.(); event.stopPropagation?.(); keyRoot.querySelector('.rpg-board-back')?.click(); return; }
        if (/^[1-9]$/u.test(event.key)) { const node = keyRoot.querySelector(`[data-choice="${event.key}"]`); if (node && !node.disabled) { event.preventDefault?.(); node.click(); } }
    };
    return { open, auto, kept, snapshot, offer, render, clear() { keyRoot = null; generation += 1; }, destroy() { keyRoot = null; doc.removeEventListener?.('keydown', keydown, true); listening = false; } };
}
