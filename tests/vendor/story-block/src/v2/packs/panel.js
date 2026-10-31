// The Packs section of the Story Suite settings: the installed list (on/off, remove) and
// the two ways in, a pack.json file and the open character's lorebook.
//
// Every pack-written string (names, authors, problems) goes in through textContent.
// The panel only renders and calls `packs` (installed.js); it holds no rules of its own.

import { button, el, plural } from '../../ui/dom.js';
import { LIMITS } from './limits.js';

const COUNT_WORDS = { items: 'item', creatures: 'creature', shops: 'shop', recipes: 'recipe', events: 'event', quests: 'quest', races: 'race', talents: 'talent', skills: 'skill', presets: 'ready-made character', places: 'place', routes: 'route', terms: 'term set', ranks: 'rank', crafts: 'craft', meterPresets: 'meter preset', markets: 'market', rpg: 'skill set', rules: 'rules set' };

/** One line of what a pack holds: "3 items, 1 shop, start state". */
export function countsLine(counts, hasStart) {
    const parts = Object.entries(COUNT_WORDS).filter(([kind]) => counts[kind]).map(([kind, word]) => plural(counts[kind], word));
    if (hasStart) parts.push('start state');
    return parts.join(', ') || 'no content';
}

/** Everything a pack adds, in words: its content lists, a start state, then its coins, calendar, weather tables, screens… */
export const addsLine = pack => [countsLine(pack.counts, pack.hasStart), ...(pack.extras ?? [])].filter(part => part !== 'no content' || !(pack.extras ?? []).length).join(', ');

const errorLines = errors => errors.slice(0, 5).map(error => error.message);

/**
 * Renders into `root`. `options`:
 * `packs` (installed.js), `readLorebook()` → `{ character, entries, problem }` (st-adapter.js),
 * `notify(text)` optional, `doc` the document to build in; `lore`: `{ read() → places, count() }`, the
 * lorebook's market lines (packs/index.js refreshLore), read again with the lorebook's packs.
 * Returns `{ refresh() }`.
 */
export function renderPacksPanel(root, { packs, readLorebook, notify = () => {}, doc = globalThis.document, lore = null } = {}) {
    const make = (tag, className = '', text = '') => el(tag, className, text, doc);
    const status = { text: '', errors: [] };
    let confirming = '';
    let focusAfter = null;

    const say = (text, errors = []) => {
        status.text = text;
        status.errors = errors;
        notify(text);
        focusAfter ??= () => root.querySelector('.ss-packs-import');
        render();
    };

    async function importFile(file) {
        if (!file) return;
        if (file.size > LIMITS.packBytes) return say(`${file.name} was not imported.`, [`The pack is larger than ${Math.round(LIMITS.packBytes / 1024)} KB.`]);
        let text;
        try {
            text = await file.text();
        } catch {
            return say(`${file.name} could not be read.`);
        }
        const result = await packs.install(text, { source: 'file', origin: file.name });
        if (!result.ok) return say(`${file.name} was not imported.`, errorLines(result.errors));
        say(result.action === 'unchanged' ? `${result.name} is already installed.` : `${result.action === 'updated' ? 'Updated' : 'Installed'} ${result.name}.`);
    }

    async function importLorebook() {
        const read = await readLorebook();
        if (read.problem) return say(read.problem);
        // The places' `market:` lines (PACKS.md "Markets") are read again at the same time.
        let places = null;
        try { places = typeof lore?.read === 'function' ? await lore.read() : null; } catch { places = null; }
        const marketText = Number.isInteger(places) && places > 0 ? ` ${plural(places, 'place')} with a market line.` : '';
        const { found, results } = await packs.importLorebook(read.entries);
        if (!found) return say(`No lorebook entry of ${read.character || 'this character'} is tagged [storysuite:pack].${marketText}`);
        const good = results.filter(result => result.ok);
        const bad = results.filter(result => !result.ok);
        const text = [
            good.length ? `Read ${plural(good.length, 'pack')} from the lorebook: ${good.map(result => result.name).join(', ')}.` : '',
            bad.length ? `${bad.length} ${bad.length === 1 ? 'entry was' : 'entries were'} not imported.` : '',
            marketText.trim(),
        ].filter(Boolean).join(' ');
        say(text, bad.flatMap(result => errorLines(result.errors).map(line => `${result.title || result.origin}: ${line}`)));
    }

    const rowOf = id => [...root.querySelectorAll('.ss-packs-row')].find(node => node.dataset.packId === id);

    // A row is an ss.listcard row (name and version, what it adds, who made it and where it came from) with its on/off switch and
    // Remove. Remove asks first: the row says what goes and offers Remove and Cancel, the focus on Cancel.
    function row(pack) {
        const item = make('li', 'ss-listcard-row ss-packs-row');
        item.dataset.packId = pack.id;
        const body = make('div', 'ss-listcard-item ss-packs-item');
        const main = make('span', 'ss-listcard-main');
        main.append(make('span', 'ss-listcard-title ss-packs-name', `${pack.name} ${pack.version}`.trim()));
        // Which module it is for: a small labelled tag under the name (kind.js), plain text.
        main.append(make('span', 'ss-packs-tag', pack.tag || 'Pack'));
        const facts = [addsLine(pack), pack.author ? `by ${pack.author}` : '', pack.source === 'lorebook' ? 'from a lorebook' : pack.origin].filter(Boolean).join(' · ');
        main.append(make('span', 'ss-listcard-sub ss-packs-facts', facts));
        if (pack.description) main.append(make('span', 'ss-listcard-sub ss-packs-description', pack.description));
        if (pack.problem) main.append(make('span', 'ss-listcard-sub ss-packs-problem', `Not usable: ${pack.problem}`));
        else if (pack.missing.length) main.append(make('span', 'ss-listcard-sub ss-packs-problem', `Needs ${pack.missing.join(', ')}; its content is offered but those parts will not use it.`));
        const toggle = make('button', `ss-switch ss-packs-enabled${pack.enabled ? ' ss-switch-on' : ''}`);
        toggle.type = 'button';
        toggle.setAttribute('role', 'switch');
        toggle.setAttribute('aria-checked', String(pack.enabled));
        toggle.setAttribute('aria-label', `${pack.name}: on`);
        toggle.append(make('span', 'ss-switch-knob'));
        toggle.disabled = Boolean(pack.problem);
        toggle.title = pack.enabled ? 'Switch this pack off' : 'Switch this pack on';
        toggle.addEventListener('click', async () => {
            if (toggle.disabled) return;
            focusAfter = () => rowOf(pack.id)?.querySelector('.ss-packs-enabled');
            await packs.setEnabled(pack.id, !pack.enabled);
            render();
        });
        const remove = button('ss-button ss-button-quiet ss-packs-remove', { text: 'Remove', title: `Remove ${pack.name}`, icon: 'fa-trash-can' });
        remove.addEventListener('click', () => {
            confirming = pack.id;
            focusAfter = () => root.querySelector('.ss-packs-confirm-no');
            render();
        });
        body.append(main, toggle, remove);
        item.append(body);
        if (confirming === pack.id) item.append(confirm(pack));
        return item;
    }

    function confirm(pack) {
        const box = make('div', 'ss-packs-confirm');
        box.setAttribute('role', 'group');
        box.setAttribute('aria-label', `Remove ${pack.name}?`);
        box.append(make('p', 'ss-packs-confirm-text', `Remove ${pack.name}? Its content leaves the game. Stories already told keep what they used from it.`));
        const yes = button('ss-button ss-button-danger ss-packs-confirm-yes', { text: 'Remove', title: `Remove ${pack.name} now`, icon: 'fa-trash-can' });
        const no = button('ss-button ss-packs-confirm-no', { text: 'Cancel', title: `Keep ${pack.name}` });
        yes.addEventListener('click', async () => {
            confirming = '';
            focusAfter = () => root.querySelector('.ss-packs-import');
            await packs.remove(pack.id);
            say(`Removed ${pack.name}.`);
        });
        const cancel = () => {
            confirming = '';
            focusAfter = () => rowOf(pack.id)?.querySelector('.ss-packs-remove');
            render();
        };
        no.addEventListener('click', cancel);
        // Escape here cancels the question, not the window around it.
        box.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            event.preventDefault?.();
            event.stopPropagation?.();
            cancel();
        });
        const actions = make('div', 'ss-packs-confirm-actions');
        actions.append(yes, no);
        box.append(actions);
        return box;
    }

    function render() {
        const file = make('input', 'ss-packs-file');
        file.type = 'file';
        file.accept = '.json,application/json';
        file.style.display = 'none';
        file.addEventListener('change', () => importFile(file.files?.[0]));
        const pick = button('ss-button ss-button-primary ss-packs-import', { text: 'Import pack file', title: 'Install a pack.json file', icon: 'fa-file-import' });
        pick.addEventListener('click', () => file.click());
        const lore = button('ss-button ss-packs-lorebook', { text: 'Read from character lorebook', title: 'Install packs from the open character\'s lorebook entries tagged [storysuite:pack]', icon: 'fa-book' });
        lore.addEventListener('click', () => importLorebook());
        const actions = make('div', 'ss-packs-actions');
        actions.append(pick, lore, file);

        const list = make('ul', 'ss-listcard-rows ss-packs-list');
        const installed = packs.list();
        if (!installed.length) list.append(make('li', 'ss-packs-empty ss-listcard-empty', 'No packs installed.'));
        for (const pack of installed) list.append(row(pack));

        const message = make('div', 'ss-packs-message', status.text);
        message.setAttribute('role', 'status');
        const errors = make('ul', 'ss-packs-errors');
        for (const line of status.errors) errors.append(make('li', '', line));

        root.replaceChildren(
            make('p', 'ss-packs-hint ss-card-help', 'Packs add items, creatures, shops, recipes, events and a start state. They are data only: nothing in a pack runs as code.'),
            actions,
            message,
            errors,
            list,
        );
        if (focusAfter) {
            const find = focusAfter;
            focusAfter = null;
            find()?.focus?.();
        }
    }

    render();
    return { refresh: render, importFile, importLorebook };
}
