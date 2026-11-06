// The New character wizard (mockup section 4): Story Block's own dialog (`width: 'wide'`) with four steps, Who · Stats · Skills ·
// Review, and a summary row of the character so far on top of each. It is opened from the Party tab ("+ New character", and
// "Create your character" when there is none, and the Home card and the first-send dialog, start.js). `open(prefill, { onEnd })` opens it with a
// companion's name, about, Soul Class and best stat filled in (the card under a reply that asks to add someone, join.js), and `onEnd(created)`
// hears whether Create made the character or the dialog was closed without.
//   Who     the name and who they are (the persona's name and description by default, for You), You or A companion (one You to a story)
//   Stats   the Spend points view's steppers and radar, under the creation budget (names.js CREATION)
//   Skills  skill sets (built in, and a pack's `content.rpg.skillSets`) and up to five rows: name, what it does, Stat, Uses,
//           Starts at (Novice; Adept for at most one skill). Rank and practice are never typed.
//   Review  everything; Create makes the Character block and the Skills block with ONE `dm.define` each, the wizard's values
//           written as the new definitions' field defaults (wizard-data.js buildDefinitions): no `dm.set`, so a skill's rank stays a
//           field only play can move, and the reply's budget is spent twice. If the second define fails the first block is removed
//           again: nothing is left half made. When the chat has no Combat rules block and/or no Foes block, Create also defines the missing
//           ones from the stock templates (one more define each, after the character, so one swipe takes everything back); if they do not
//           fit (the block limit, the reply's actions) or one is refused, the character stays and the dialog says which block was not added.
//   Import  the Who step starts with "Start from a saved character … Import file…" (charfile.js): a good file fills the stats, the unspent points,
//           the Soul Class and the skills with their ranks (the Stats and Skills steps show them and keep the usual rules; the ranks stay the
//           file's), and never the name, You or a companion, or who they are. Undo import puts back what was there. Create then also adds, as more
//           changes of the same reply, the things the file had (`inventory.add`, one for each, to the character's owner) and its money
//           (`wallet.set`, the purse plus the file's); whatever cannot be added is named in the window and the character is still made.
// The draft lives here, in the wizard's session (the dialog's own draft is not used); each step is a widget of this file drawing from
// it, so Back and Next keep what was typed. Every node is built with createElement and textContent.

import { DM_LIMITS } from '../../data-modules/schema.js';
import { h, shell } from '../../view/widgets/dom.js';
import { radar } from '../../view/widgets/radar.js';
import { stepper } from '../../view/widgets/stepper.js';
import { refusalText } from '../../strings.js';
import { DEFAULT_CURRENCY } from '../../domains/money.js';
import { FILE_LIMITS, moneyText, parseCharacterFile, skillLine, thingsWord } from '../charfile.js';
import { LEVEL, CREATION, RANK_NAMES, STATS, USES } from '../names.js';
import { fold } from '../read.js';
import { RPG_STRINGS, fill } from '../strings.js';
import { readParty } from './party-data.js';
import { joinDraft } from '../join.js';
import { growthOf } from '../blocks.js';
import { growthText } from './party-data.js';
import { rankOf as bandRank } from '../levels.js';
import { WIZARD_STEPS, actionsFree, blockNames, buildDefinitions, draftCreation, draftSlots, extraDefinitions, extraName, extrasPlan, hasRoom, mayStartAdept, newDraft, pointsLeft, problemsOf, rankOf, readDraft, setLine, skillSetsOf,
    START_RANKS, startStats, statBounds, statsLine, withImport, withoutImport, withSet, withSkill, withSkillPatch, withoutSkill } from './wizard-data.js';
import { createWhoStep } from './wizard/who.js';
import { createStatsStep } from './wizard/stats.js';
import { createSkillsStep } from './wizard/skills.js';
import { createReviewStep } from './wizard/review.js';

const W = RPG_STRINGS.wizard;
// The word the stat notes use for the level.
const LEVEL_WORD = 'Level';
export const WIZARD_SCREEN_ID = 'story-block/new-character';
export const WIZARD_WIDGET = 'rpg.wizard';

const cap = word => (word ? `${word.charAt(0).toUpperCase()}${word.slice(1)}` : '');

/** The wizard's dialog: four steps, each one the wizard widget drawing that step. */
export function createWizardScreen() {
    const template = step => `<ss-widget name="${WIZARD_WIDGET}" data-props='{"step":"${step}"}'></ss-widget>`;
    return Object.freeze({
        id: WIZARD_SCREEN_ID, title: W.title, icon: 'fa-user-plus', mounts: Object.freeze(['dialog']), width: 'wide',
        template: template(WIZARD_STEPS[0]),
        steps: Object.freeze(WIZARD_STEPS.map(id => Object.freeze({ id, title: W.steps[id], template: template(id) }))),
    });
}

// What the story has now that the wizard needs: the persona's name, the characters' names, whether one is already you, room for two blocks.
function worldOf(state, persona, roleOf, replyKey = '') {
    const party = readParty(state, { own: persona, roleOf });
    const free = actionsFree(state, replyKey);
    return { persona, names: party.map(character => character.name), hasYou: party.some(character => character.own), room: hasRoom(state), free, extras: extrasPlan(state, { roleOf, free }),
        used: Object.keys(state?.domains?.dataModules?.active ?? {}) };
}

const safe = (fn, fallback) => { try { return fn() ?? fallback; } catch { return fallback; } };

/**
 * The wizard. `deps`: `headState()` (the head state or null), `readerName()` (the persona's name), `roleOf(definition)`, `openDialog(id,
 * { draft, onClose })` (the host's dialog mount; without it there is no way to open), `replyKey()` (the head reply's key in the blocks' per-reply
 * count, `${sid}/${swipeKey}`: Create asks the reply for three block actions before it starts), `readerAbout()` (the active persona's description,
 * which a You starts with as Who they are). → { screen, widget, open(prefill?, { onEnd }?), session(), destroy() }.
 * `open()` opens the dialog on a fresh draft; the session is dropped when the dialog closes. `prefill` is { name, about, soul, best }: a companion
 * the story brought in (join.js joinDraft); `onEnd(created)` is told once when the dialog closes, `created` true when Create made the character.
 */
export function createWizard({ headState = () => null, readerName = () => '', readerAbout = () => '', roleOf, openDialog = null, replyKey = () => '', rules = () => null, packNote = () => '', levels = () => ({}), levelCap = () => null } = {}) {
    let session = null;
    const world = () => worldOf(headState(), String(readerName() ?? '').replace(/\s+/g, ' ').trim(), roleOf, safe(replyKey, ''));
    // The persona's description as Who they are starts: one line, the first 240 characters (whole characters), '' when there is none.
    const personaAbout = () => [...String(safe(readerAbout, '') ?? '').replace(/\s+/g, ' ').trim()].slice(0, CREATION.about).join('');
    const fresh = (prefill = null) => {
        const now = world(), about = personaAbout();
        // (`rules`: the numbers in force now; a Standard chat starts every stat low and has more to spend, joins use formula.js companionStats.)
        const numbers = safe(rules, null);
        const draft = prefill ? joinDraft(prefill, numbers) : { ...newDraft({ persona: now.persona, hasYou: now.hasYou, rules: numbers }) };
        // Only a You starts with the persona's description, and only into an empty box: a companion starts empty.
        if (!prefill && draft.kind === 'you' && about) draft.about = about;
        return { draft, handle: null, busy: false, message: '', created: false, finished: '', about: prefill ? '' : about, onEnd: null, imported: null, importError: '', pendingSet: null };
    };
    const current = () => { session ??= fresh(); return session; };

    function open(prefill = null, { onEnd = null } = {}) {
        if (typeof openDialog !== 'function' || session?.handle?.isOpen?.()) return null;
        const own = fresh(prefill && typeof prefill === 'object' ? prefill : null);
        own.onEnd = typeof onEnd === 'function' ? onEnd : null;
        session = own;
        const handle = openDialog(WIZARD_SCREEN_ID, { draft: {}, onClose: () => {
            if (session === own) session = null;
            const end = own.onEnd;
            own.onEnd = null;
            try { end?.(own.created); } catch { /* the caller's follow-up never breaks closing */ }
        } });
        if (!handle) { if (session === own) session = null; return null; }
        own.handle = handle;
        return handle;
    }

    const widget = {
        props: {}, primary: null, validate: () => [],
        render: (el, props, api) => shell(el, 'section', 'rpg-wizard', ({ doc, root }) => {
            const step = WIZARD_STEPS.includes(props?.step) ? props.step : WIZARD_STEPS[0];
            let alive = true;
            const summary = h(doc, 'section', 'rpg-wiz-sum'), body = h(doc, 'div', `rpg-wiz-body rpg-wiz-${step}`);
            summary.setAttribute('aria-label', W.summaryLabel);
            root.append(summary, body);

            const draft = () => current().draft;
            const put = next => { current().draft = next; };
            const snap = () => readDraft(draft());
            const kindWord = kind => (kind === 'you' ? W.you : W.companion);
            const button = (parent, text, cls, fn) => {
                const node = h(doc, 'button', cls, text);
                node.setAttribute('type', 'button');
                node.addEventListener('click', fn);
                parent.appendChild(node);
                return node;
            };
            // A labelled control; `after` nodes (a hint, a count) go under it inside the label.
            const field = (parent, label, node, ...after) => {
                const wrap = h(doc, 'label', 'rpg-wiz-field');
                wrap.appendChild(h(doc, 'span', 'rpg-wiz-field-label', label));
                wrap.appendChild(node);
                for (const extra of after) wrap.appendChild(extra);
                parent.appendChild(wrap);
                return node;
            };
            const input = (value, max, label) => {
                const node = h(doc, 'input', 'rpg-wiz-input');
                node.setAttribute('type', 'text');
                node.setAttribute('maxlength', String(max));
                if (label) node.setAttribute('aria-label', label);
                node.value = value;
                return node;
            };
            const select = (options, value, label) => {
                const node = h(doc, 'select', 'rpg-wiz-input');
                if (label) node.setAttribute('aria-label', label);
                for (const option of options) {
                    const item = h(doc, 'option', '', option.label);
                    item.setAttribute('value', String(option.value));
                    if (option.disabled) item.setAttribute('disabled', 'disabled');
                    if (String(option.value) === String(value)) item.setAttribute('selected', 'selected');
                    node.appendChild(item);
                }
                node.value = String(value);
                return node;
            };

            // ---- the summary row: who, stats and skills so far, and the pill ----
            function drawSummary() {
                if (!alive) return;
                const now = snap();
                summary.replaceChildren();
                const who = h(doc, 'div', 'rpg-wiz-who');
                who.appendChild(h(doc, 'span', 'rpg-wiz-ava', [...now.name][0]?.toUpperCase() ?? '?'));
                const k = h(doc, 'div', 'rpg-wiz-k');
                k.appendChild(h(doc, 'span', 'rpg-wiz-name', now.name || W.title));
                k.appendChild(h(doc, 'small', 'rpg-wiz-sub', `${kindWord(now.kind)} · ${fill(W.soulFrom, { level: now.level ?? 1 })}`));
                who.appendChild(k);
                summary.appendChild(who);
                const part = (label, text) => {
                    const node = h(doc, 'div', 'rpg-wiz-k');
                    node.appendChild(h(doc, 'small', '', label));
                    node.appendChild(h(doc, 'span', '', text));
                    summary.appendChild(node);
                };
                part(W.statsHead, statsLine(now));
                part(W.skillsHead, now.skills.filter(skill => skill.name).map(skill => (Number.isSafeInteger(skill.rank) ? skillLine({ name: skill.name, rank: skill.rank }) : skill.name)).join(', ') || W.noSkills);
                const left = pointsLeft(now), count = now.skills.length;
                const pill = h(doc, 'span', 'ss-pill rpg-wiz-push', step === 'who' || step === 'stats' ? fill(W.pointsLeft, { n: left })
                    : fill(count === 1 ? W.skillCountOne : W.skillCount, { n: count, max: draftSlots(now) }));
                pill.setAttribute('role', 'status');
                summary.appendChild(pill);
            }

            const whoStep = createWhoStep({ api, safe, DEFAULT_CURRENCY, current, draft, put, snap, world, h, doc, W, fill, thingsWord,
                FILE_LIMITS, RPG_STRINGS, parseCharacterFile, sameRun: run => alive && session === run, redraw, withImport, withoutImport,
                moneyText, button, body, field, input, CREATION, drawSummary, LEVEL, levelCap, bandRank, levels, fold });
            const statsStep = createStatsStep({ snap, pointsLeft, STATS, draftCreation, growthText, growthOf, RPG_STRINGS, fill, W, drawSummary, h,
                doc, stepper, put, draft, radar, button, redraw, startStats, statBounds, LEVEL_WORD, safe, packNote, body });
            const skillsStep = createSkillsStep({ snap, skillSetsOf, safe, api, current, draft, h, doc, W, fill, draftSlots, draftCreation, button, put, drawSummary,
                redraw, body, withSet, setLine, input, CREATION, select, STATS, USES, RANK_NAMES, START_RANKS, mayStartAdept, withSkillPatch, withoutSkill, withSkill });
            const reviewStep = createReviewStep({ DM_LIMITS, W, fill, current, snap, world, problemsOf, blockNames, kindWord, h, doc, body, RANK_NAMES,
                rankOf, pointsLeft, statsLine, extraName, button, safe, api, refusalText, ownerFor: whoStep.ownerFor, importedAdds: whoStep.importedAdds,
                thingsPhrase: whoStep.thingsPhrase, moneyText, currency: whoStep.currency, buildDefinitions, levelCap, headState, extraDefinitions,
                draftCreation, isAlive: () => alive, redraw });
            const clear = () => { statsStep.clear(); body.replaceChildren(); };

            function redraw() {
                if (!alive) return;
                drawSummary();
                clear();
                if (step === 'who') whoStep.drawWho();
                else if (step === 'stats') statsStep.drawStats();
                else if (step === 'skills') skillsStep.drawSkills();
                else reviewStep.drawReview();
            }

            drawSummary();
            redraw();
            return {
                update() {},
                destroy() { alive = false; clear(); },
            };
        }),
    };

    return { screen: createWizardScreen(), widget, open, session: () => session, destroy() { try { session?.handle?.close?.(); } catch { /* already closed */ } session = null; } };
}
