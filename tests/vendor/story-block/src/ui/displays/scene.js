// Scene display: a World State text block drawn as a scene board.
//
// Chips for when, where and the weather; a card per person (yours first), with mood,
// outfit and position; what happens off-screen; open threads, seeds and timers; and
// where the arc and the scene stand. The text stays the state: parseScene reads it on
// every render, and when it does not look like a World State the plain display draws
// it instead, so nothing the model wrote is ever lost to the board.
//
// Secrets are something the reader's character does not know. They stay behind a
// "Reveal secret" button, are not in the DOM until revealed, and never show in the
// change marks. Off-screen is the same kind of thing, the world behind the scenes, so
// by default it shows only how many entries there are until revealed. The block text
// is untouched either way: other extensions (NPC State Delta) still read all of it.

import { button, changeDot, el, emptyText, renderChanges, renderEmpty, renderFrame, stop } from '../dom.js';
import { render as renderPlain } from './plain.js';
import { ARC_PHASES, SCENE_PHASES, diffScene, parseScene, pcName, phaseStep } from '../../scene.js';
import { countWords as words, oneLine } from '../../text.js';

// Fields drawn first, in this order; anything else the model wrote follows as written.
const FIELD_ORDER = ['Outfit', 'Position', 'Agenda', 'Visible Condition', 'Carrying'];
const MOOD_PILL_MAX = 24;

const CHIPS = [
    { key: 'time', label: 'Time', icon: 'fa-clock' },
    { key: 'location', label: 'Location', icon: 'fa-location-dot' },
    { key: 'weather', label: 'Weather', icon: 'fa-cloud-sun' },
];

const LISTS = [
    { key: 'world', label: 'World', icon: 'fa-earth-americas' },
    { key: 'threads', label: 'Threads', icon: 'fa-fire' },
    { key: 'seeds', label: 'Seeds', icon: 'fa-seedling' },
    { key: 'timers', label: 'Timers', icon: 'fa-hourglass-half' },
];

// Models (and custom layouts) often pack several facts into one line with pipes:
// `now Court | then: argues with magistrates | on: Haywane 12, 05:45 pm`. Drawn as written
// that is a wall of text, so the board splits it into short labelled rows. The text itself
// (the state, and what the change marks compare) is left exactly as written.
const FACT_LABEL = /^([\p{L}][\p{L}\p{N} '’/-]{0,23}?)\s*:\s+(\S.*)$/u;
const LEAD_LABEL = /^(.*\S)\s+[—–-]\s+(\p{L}{1,12})\s*:?$/u;
const COORDS = /^\[?\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*\]?$/;
const LONG_ITEM = 48;
const KEYED_ITEM = /^(.{1,60}?)\s+[—–]\s+(\S.*)$/;


/** `a | label: b | c` -> [{ label, value }]; the first fact takes `lead` when it has no label. */
export function splitFacts(text, lead = '') {
    const facts = String(text ?? '').split(/\s*\|\s*/).map(part => part.trim()).filter(Boolean).map(part => {
        const match = FACT_LABEL.exec(part);
        return match && words(match[1]) <= 3 ? { label: match[1].trim(), value: match[2].trim() } : { label: '', value: part };
    });
    if (lead && facts.length && !facts[0].label) facts[0] = { label: lead, value: facts[0].value };
    return facts;
}

/** `Senior Listener Geva — now` -> name and the one-word label its line opens with. */
export function nameAndLead(name) {
    const match = LEAD_LABEL.exec(String(name ?? '').trim());
    return match ? { name: match[1].trim(), lead: match[2] } : { name: String(name ?? '').trim(), lead: '' };
}

function renderFacts(facts) {
    const list = el('dl', 'story-block-scene-facts');
    for (const fact of facts) {
        if (fact.label) list.append(el('dt', '', fact.label), el('dd', '', fact.value));
        else list.appendChild(el('dd', 'is-plain', fact.value));
    }
    return list;
}

// Chip text: pipes read as middle dots, and map coordinates (`[59.0, 110.0]`) are dimmed.
function chipText(value) {
    const node = el('span', 'story-block-scene-chip-text');
    String(value).split(/\s*\|\s*/).map(part => part.trim()).filter(Boolean).forEach((part, index) => {
        if (index) node.appendChild(document.createTextNode(' · '));
        node.appendChild(COORDS.test(part) ? el('span', 'story-block-scene-coords', part) : document.createTextNode(part));
    });
    return node;
}

// Revealed secrets per card, keyed by the secret's text so a new secret starts hidden
// again. Survives re-renders (a refresh lands on every chat event) but not reloads.
const revealed = new Map();
let nextId = 0;
// The off-screen reveal, in the same memory as the secrets. It is not keyed by the text:
// agendas move every reply, and a fold that closed on each one would be no use.
const OFFSCREEN_KEY = '\u0000offscreen';

const changeKey = label => oneLine(label).toLowerCase();
const isSecretChange = change => /·\s*secrets?\s*$/i.test(String(change?.label ?? '')) || /^secrets?$/i.test(String(change?.label ?? '').trim());

function revealedFor(uiKey) {
    const key = String(uiKey ?? 'default');
    if (!revealed.has(key)) revealed.set(key, new Set());
    return revealed.get(key);
}

function srOnly(text) {
    return el('span', 'story-block-scene-sr', text);
}

function icon(name) {
    const glyph = el('i', `fa-solid ${name}`);
    glyph.setAttribute('aria-hidden', 'true');
    return glyph;
}

// The first clause of the mood, for a pill that is read at a glance; the full line
// still shows as a row when the pill had to shorten it.
function moodPill(mood) {
    const full = String(mood ?? '').trim();
    let short = full.split(/\s+[—–-]\s+|\s*[;,.(]\s*/)[0].trim() || full;
    if (short.length > MOOD_PILL_MAX) short = `${short.slice(0, MOOD_PILL_MAX - 1).trim()}…`;
    return { short, complete: short === full };
}

function renderChips(scene, changeFor) {
    const list = el('ul', 'story-block-scene-chips');
    list.setAttribute('aria-label', 'Scene');
    for (const chip of CHIPS) {
        const value = scene[chip.key];
        if (!value) continue;
        const change = changeFor(chip.label);
        const item = el('li', `story-block-scene-chip is-${chip.key}`);
        item.append(icon(chip.icon), srOnly(`${chip.label}: `));
        item.appendChild(chipText(value));
        if (change) item.appendChild(changeDot(change));
        list.appendChild(item);
    }
    for (const extra of scene.extras ?? []) {
        const item = el('li', 'story-block-scene-chip is-extra');
        item.append(el('span', 'story-block-scene-chip-label', `${extra.label}:`), el('span', 'story-block-scene-chip-text', extra.value));
        list.appendChild(item);
    }
    return list.children.length ? list : null;
}

function renderSecret(name, secret, memory) {
    const id = `story-block-scene-secret-${++nextId}`;
    const memoryKey = `${changeKey(name)}\n${secret}`;
    const wrap = el('div', 'story-block-scene-secret');
    const toggle = button('story-block-scene-reveal');
    toggle.setAttribute('aria-controls', id);
    const body = el('div', 'story-block-scene-secret-text');
    body.id = id;

    const draw = open => {
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        toggle.replaceChildren(icon(open ? 'fa-eye-slash' : 'fa-eye'), el('span', '', open ? 'Hide secret' : 'Reveal secret'));
        wrap.classList.toggle('is-open', open);
        // Not merely hidden with CSS: an unrevealed secret is not in the page at all,
        // so it cannot be read by selecting, copying or a screen reader skimming.
        body.textContent = open ? secret : '';
        if (open) body.removeAttribute('hidden');
        else body.setAttribute('hidden', '');
    };
    toggle.addEventListener('click', stop(() => {
        const open = !memory.has(memoryKey);
        if (open) memory.add(memoryKey);
        else memory.delete(memoryKey);
        draw(open);
    }));
    draw(memory.has(memoryKey));
    wrap.append(toggle, body);
    return wrap;
}

function renderPerson(entry, { isPc, changeFor, memory }) {
    const name = isPc ? pcName(entry) : entry.name;
    const joined = isPc ? null : changeFor(entry.name);
    const card = el('div', `story-block-scene-person${isPc ? ' is-pc' : ''}`);
    card.setAttribute('role', 'listitem');

    const head = el('div', 'story-block-scene-person-head');
    const initial = (name.match(/\p{L}|\p{N}/u) ?? ['?'])[0].toUpperCase();
    const avatar = el('span', 'story-block-scene-avatar', initial);
    avatar.setAttribute('aria-hidden', 'true');
    const names = el('div', 'story-block-scene-names');
    names.appendChild(el('span', 'story-block-scene-name', name));
    if (isPc && entry.name) names.appendChild(el('span', 'story-block-scene-tag is-you', 'you'));
    if (entry.role) names.appendChild(el('span', 'story-block-scene-tag', entry.role));
    if (joined && joined.type === 'added') {
        const fresh = el('span', 'story-block-scene-tag is-new', 'new');
        fresh.title = 'Joined since the previous state';
        names.appendChild(fresh);
    }
    head.append(avatar, names);

    const fields = entry.fields ?? {};
    const mood = fields.Mood ? moodPill(fields.Mood) : null;
    const moodChange = changeFor(`${name} · Mood`);
    if (mood) {
        const pill = el('span', 'story-block-scene-mood', mood.short);
        pill.title = `Mood: ${fields.Mood}`;
        head.appendChild(pill);
        if (moodChange) head.appendChild(changeDot(moodChange));
    }
    card.appendChild(head);

    const labels = [
        ...FIELD_ORDER.filter(label => fields[label]),
        ...Object.keys(fields).filter(label => !FIELD_ORDER.includes(label) && label !== 'Secret' && label !== 'Mood'),
    ];
    // The mood row only when the pill had to shorten it.
    if (mood && !mood.complete) labels.splice(Math.min(2, labels.length), 0, 'Mood');

    const rows = el('div', 'story-block-scene-rows');
    for (const label of labels) {
        const change = changeFor(`${name} · ${label}`);
        const slug = changeKey(label).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'field';
        const row = el('div', `story-block-scene-row is-${slug}${change ? ' is-changed' : ''}`);
        const key = el('span', 'story-block-scene-k', label);
        if (change) key.appendChild(changeDot(change));
        const facts = splitFacts(fields[label]);
        row.append(key, facts.length > 1 ? renderFacts(facts) : el('span', 'story-block-scene-v', fields[label]));
        rows.appendChild(row);
    }
    if (rows.children.length) card.appendChild(rows);
    if (fields.Secret) card.appendChild(renderSecret(name, fields.Secret, memory));
    return card;
}

function renderOffscreenList(entries) {
    const list = el('ul', 'story-block-scene-off');
    for (const entry of entries) {
        const item = el('li', 'story-block-scene-off-item');
        const { name, lead } = nameAndLead(entry.name);
        const facts = splitFacts(entry.text, lead);
        if (name) item.appendChild(el('div', 'story-block-scene-off-name', name));
        if (facts.length > 1 || (lead && facts.length)) item.appendChild(renderFacts(facts));
        else if (entry.text) item.appendChild(el('div', 'story-block-scene-off-text', entry.text));
        list.appendChild(item);
    }
    return list;
}

function renderOffscreen(entries, { hidden = false, memory = null } = {}) {
    const section = el('section', 'story-block-scene-section is-offscreen');
    const head = el('div', 'story-block-scene-sub');
    head.append(icon('fa-satellite-dish'), el('span', '', 'Off-screen'));
    section.appendChild(head);
    if (!hidden || !memory) {
        section.appendChild(renderOffscreenList(entries));
        return section;
    }

    const id = `story-block-scene-off-${++nextId}`;
    const count = el('span', 'story-block-scene-off-count');
    const toggle = button('story-block-scene-reveal');
    toggle.setAttribute('aria-controls', id);
    const holder = el('div', 'story-block-scene-off-body');
    holder.id = id;
    const draw = open => {
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        toggle.replaceChildren(icon(open ? 'fa-eye-slash' : 'fa-eye'), el('span', '', open ? 'Hide' : 'Reveal'));
        section.classList.toggle('is-locked', !open);
        count.textContent = open ? '' : `${entries.length} behind the scenes`;
        // As with secrets: hidden entries are not in the page at all.
        holder.replaceChildren(...(open ? [renderOffscreenList(entries)] : []));
    };
    toggle.addEventListener('click', stop(() => {
        const open = !memory.has(OFFSCREEN_KEY);
        if (open) memory.add(OFFSCREEN_KEY);
        else memory.delete(OFFSCREEN_KEY);
        draw(open);
    }));
    head.append(count, toggle);
    section.appendChild(holder);
    draw(memory.has(OFFSCREEN_KEY));
    return section;
}

function renderLists(scene, changeFor) {
    const groups = LISTS.filter(group => scene[group.key]?.length);
    if (!groups.length) return null;
    const section = el('section', 'story-block-scene-section is-open-threads');
    for (const group of groups) {
        const head = el('div', 'story-block-scene-sub');
        head.append(icon(group.icon), el('span', '', group.label));
        section.appendChild(head);
        // Short items read as pills; a group with a long or many-part item is drawn as rows,
        // all of it, so one group never mixes the two looks.
        const texts = scene[group.key];
        const rows = texts.some(text => text.length > LONG_ITEM || /\|/.test(text));
        const list = el('ul', `story-block-scene-items is-${group.key}${rows ? ' is-rows' : ''}`);
        list.setAttribute('aria-label', group.label);
        for (const text of texts) {
            // Only threads are diffed; seeds and timers tick every reply and would be noise.
            const change = group.key === 'threads' ? changeFor(text) : null;
            const item = el('li', 'story-block-scene-item');
            let [first, ...rest] = splitFacts(text);
            // `Key — what it is | then: …`: the key is the heading, what it is the first row.
            const keyed = !first.label ? KEYED_ITEM.exec(first.value) : null;
            if (keyed && words(keyed[1]) <= 8) {
                rest = [{ label: '', value: keyed[2].trim() }, ...rest];
                first = { label: '', value: keyed[1].trim() };
            }
            if (rows && rest.length) {
                const head = el('div', 'story-block-scene-item-head', first.label ? `${first.label}: ${first.value}` : first.value);
                if (change) head.appendChild(changeDot(change));
                item.append(head, renderFacts(rest));
            } else {
                item.textContent = text;
                if (change) item.appendChild(changeDot(change));
            }
            list.appendChild(item);
        }
        section.appendChild(list);
    }
    return section;
}

function renderPhase(kind, value, changeFor) {
    const label = kind === 'arc' ? 'Arc Phase' : 'Scene Phase';
    const ladder = kind === 'arc' ? ARC_PHASES : SCENE_PHASES;
    const change = changeFor(label);
    const node = el('div', `story-block-scene-phase is-${kind}`);
    const head = el('div', 'story-block-scene-phase-head');
    head.append(el('span', 'story-block-scene-sub', kind === 'arc' ? 'Arc' : 'Scene'), el('span', 'story-block-scene-phase-name', value));
    if (change) head.appendChild(changeDot(change));
    node.appendChild(head);
    const at = phaseStep(kind, value);
    // A phase the ladder does not have is shown as written, without guessing a position.
    if (at >= 0) {
        const rail = el('ol', 'story-block-scene-rail');
        rail.setAttribute('aria-label', `${kind === 'arc' ? 'Arc' : 'Scene'}: ${ladder[at]}, step ${at + 1} of ${ladder.length}`);
        ladder.forEach((step, index) => {
            const item = el('li', `story-block-scene-step${index < at ? ' is-done' : ''}${index === at ? ' is-current' : ''}`);
            item.title = step;
            if (index === at) item.setAttribute('aria-current', 'step');
            item.appendChild(el('span', 'story-block-scene-step-name', step));
            rail.appendChild(item);
        });
        node.appendChild(rail);
    }
    return node;
}

// One line per change, worded for what changed: a field ("Astra · Mood: calm → wary"),
// a person ("Old Brenn joined", "Brenn left") or a thread ("New thread: …").
function sceneChangeWording(scene, before) {
    const people = new Set([...(scene.people ?? []), ...(before?.people ?? [])].map(entry => changeKey(entry.name)));
    const threads = new Set([...(scene.threads ?? []), ...(before?.threads ?? [])].map(changeKey));
    return change => {
        const label = String(change.label ?? '').trim();
        // `Place | Region` reads as on the board, with a middle dot.
        const tidy = value => String(value ?? '').trim().replace(/\s*\|\s*/g, ' · ');
        const from = tidy(change.from);
        const to = tidy(change.to);
        const key = changeKey(label);
        if (people.has(key)) return change.type === 'added' ? `${label} joined` : change.type === 'removed' ? `${label} left` : `${label} changed`;
        if (threads.has(key)) return change.type === 'added' ? `New thread: ${label}` : change.type === 'removed' ? `Thread closed: ${label}` : `Thread: ${label}`;
        if (change.type === 'added') return `${label}: ${to}`;
        if (change.type === 'removed') return `${label}: no longer written`;
        return `${label}: ${from || '—'} → ${to || '—'}`;
    };
}

export function render(pane, {
    def,
    state,
    previousState = null,
    changes = null,
    changesFromEarlierReply = false,
    error = null,
    truncated = false,
    onEdit = null,
    uiKey = null,
    hideOffscreen = false,
} = {}) {
    const text = typeof state?.text === 'string' ? state.text.replace(/\r\n?/g, '\n').trim() : '';
    const scene = text ? parseScene(text, { layout: def?.layout }) : null;
    // Not text, or text that is not a World State: the plain display draws every word.
    if ((state && typeof state.text !== 'string') || (text && !scene)) {
        pane.classList.remove('story-block-display-scene');
        renderPlain(pane, { def, state, error, truncated, onEdit });
        return;
    }
    pane.classList.remove('story-block-display-plain');

    const present = scene ? (scene.pc ? 1 : 0) + scene.people.length : 0;
    renderFrame(pane, {
        def, error, truncated, onEdit,
        display: 'scene',
        summary: present ? `${present} present` : '',
    });
    if (!scene) {
        renderEmpty(pane, emptyText(def, state));
        return;
    }

    const rawChanges = Array.isArray(changes)
        ? changes
        : (typeof previousState?.text === 'string' ? diffScene(previousState.text, text, { layout: def?.layout }) : []);
    // Defensive: whatever produced the changes, a secret never shows in a mark.
    const changeList = rawChanges.filter(change => change && !isSecretChange(change));
    const byLabel = new Map();
    for (const change of changeList) {
        if (change.type !== 'removed' || !byLabel.has(changeKey(change.label))) byLabel.set(changeKey(change.label), change);
    }
    const changeFor = label => {
        const change = byLabel.get(changeKey(label));
        return change && change.type !== 'removed' ? change : null;
    };

    const body = el('div', 'story-block-display-body story-block-scene');

    // Every change, worded once, folded away; the board itself only carries dots.
    const before = typeof previousState?.text === 'string' ? parseScene(previousState.text, { layout: def?.layout }) : null;
    renderChanges(body, changeList, { describe: sceneChangeWording(scene, before), fromEarlierReply: changesFromEarlierReply });

    const chips = renderChips(scene, changeFor);
    if (chips) body.appendChild(chips);

    const memory = revealedFor(uiKey ?? def?.id);
    const everyone = [
        ...(scene.pc ? [{ entry: scene.pc, isPc: true }] : []),
        ...scene.people.map(entry => ({ entry, isPc: false })),
    ];
    if (everyone.length) {
        const people = el('div', 'story-block-scene-people');
        people.setAttribute('role', 'list');
        people.setAttribute('aria-label', 'Present');
        everyone.forEach(({ entry, isPc }) => people.appendChild(renderPerson(entry, { isPc, changeFor, memory })));
        body.appendChild(people);
    }

    if (scene.offscreen.length) body.appendChild(renderOffscreen(scene.offscreen, { hidden: hideOffscreen, memory }));
    const lists = renderLists(scene, changeFor);
    if (lists) body.appendChild(lists);

    if (scene.arc || scene.phase) {
        const phases = el('div', 'story-block-scene-phases');
        if (scene.arc) phases.appendChild(renderPhase('arc', scene.arc, changeFor));
        if (scene.phase) phases.appendChild(renderPhase('phase', scene.phase, changeFor));
        body.appendChild(phases);
    }

    pane.appendChild(body);
}
