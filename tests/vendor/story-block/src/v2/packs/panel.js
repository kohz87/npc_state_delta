// The Packs section of the Story Suite settings: the installed list (on/off, remove) and
// the two ways in, a pack.json file and the open character's lorebook.
//
// Every pack-written string (names, authors, problems) goes in through textContent.
// The panel only renders and calls `packs` (installed.js); it holds no rules of its own.

import { button, el, plural } from '../../ui/dom.js';
import { LIMITS } from './limits.js';

const COUNT_WORDS = { items: 'item', creatures: 'creature', shops: 'shop', recipes: 'recipe', events: 'event', quests: 'quest', races: 'race', talents: 'talent', skills: 'skill', presets: 'ready-made character', places: 'place', routes: 'route', terms: 'term set', ranks: 'rank', crafts: 'craft', meterPresets: 'meter preset' };

/** One line of what a pack holds: "3 items, 1 shop, start state". */
export function countsLine(counts, hasStart) {
    const parts = Object.entries(COUNT_WORDS).filter(([kind]) => counts[kind]).map(([kind, word]) => plural(counts[kind], word));
    if (hasStart) parts.push('start state');
    return parts.join(', ') || 'no content';
}

const errorLines = errors => errors.slice(0, 5).map(error => error.message);

/**
 * Renders into `root`. `options`:
 * `packs` (installed.js), `readLorebook()` → `{ character, entries, problem }` (st-adapter.js),
 * `notify(text)` optional, `doc` the document to build in.
 * Returns `{ refresh() }`.
 */
export function renderPacksPanel(root, { packs, readLorebook, notify = () => {}, doc = globalThis.document } = {}) {
    const make = (tag, className = '', text = '') => el(tag, className, text, doc);
    const status = { text: '', errors: [] };
    const removing = new Set();

    const say = (text, errors = []) => {
        status.text = text;
        status.errors = errors;
        notify(text);
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
        const { found, results } = await packs.importLorebook(read.entries);
        if (!found) return say(`No lorebook entry of ${read.character || 'this character'} is tagged [storysuite:pack].`);
        const good = results.filter(result => result.ok);
        const bad = results.filter(result => !result.ok);
        const text = [
            good.length ? `Read ${plural(good.length, 'pack')} from the lorebook: ${good.map(result => result.name).join(', ')}.` : '',
            bad.length ? `${bad.length} ${bad.length === 1 ? 'entry was' : 'entries were'} not imported.` : '',
        ].filter(Boolean).join(' ');
        say(text, bad.flatMap(result => errorLines(result.errors).map(line => `${result.title || result.origin}: ${line}`)));
    }

    function row(pack) {
        const item = make('div', 'ss-packs-row');
        item.dataset.packId = pack.id;
        const toggle = make('input', 'ss-packs-enabled');
        toggle.type = 'checkbox';
        toggle.checked = pack.enabled;
        toggle.disabled = Boolean(pack.problem);
        toggle.title = pack.enabled ? 'Switch this pack off' : 'Switch this pack on';
        toggle.addEventListener('change', async () => {
            await packs.setEnabled(pack.id, toggle.checked);
            render();
        });
        const label = make('label', 'checkbox_label ss-packs-label');
        label.append(toggle, make('span', 'ss-packs-name', `${pack.name} ${pack.version}`.trim()));
        const facts = [countsLine(pack.counts, pack.hasStart), pack.author ? `by ${pack.author}` : '', pack.source === 'lorebook' ? 'from a lorebook' : pack.origin].filter(Boolean).join(' · ');
        const remove = button('menu_button ss-packs-remove', { text: removing.has(pack.id) ? 'Remove? Click again' : 'Remove', title: `Remove ${pack.name}`, icon: 'fa-trash-can' });
        remove.addEventListener('click', async () => {
            if (!removing.has(pack.id)) {
                removing.add(pack.id);
                return render();
            }
            removing.delete(pack.id);
            await packs.remove(pack.id);
            say(`Removed ${pack.name}.`);
        });
        item.append(label, make('small', 'ss-packs-facts', facts));
        if (pack.description) item.append(make('small', 'ss-packs-description', pack.description));
        if (pack.problem) item.append(make('small', 'ss-packs-problem', `Not usable: ${pack.problem}`));
        else if (pack.missing.length) item.append(make('small', 'ss-packs-problem', `Needs ${pack.missing.join(', ')}; its content is offered but those parts will not use it.`));
        item.append(remove);
        return item;
    }

    function render() {
        const file = make('input', 'ss-packs-file');
        file.type = 'file';
        file.accept = '.json,application/json';
        file.style.display = 'none';
        file.addEventListener('change', () => importFile(file.files?.[0]));
        const pick = button('menu_button ss-packs-import', { text: 'Import pack file', title: 'Install a pack.json file', icon: 'fa-file-import' });
        pick.addEventListener('click', () => file.click());
        const lore = button('menu_button ss-packs-lorebook', { text: 'Read from character lorebook', title: 'Install packs from the open character\'s lorebook entries tagged [storysuite:pack]', icon: 'fa-book' });
        lore.addEventListener('click', () => importLorebook());
        const actions = make('div', 'ss-packs-actions');
        actions.append(pick, lore, file);

        const list = make('div', 'ss-packs-list');
        const installed = packs.list();
        if (!installed.length) list.append(make('small', 'ss-packs-empty', 'No packs installed.'));
        for (const pack of installed) list.append(row(pack));

        const message = make('div', 'ss-packs-message', status.text);
        const errors = make('ul', 'ss-packs-errors');
        for (const line of status.errors) errors.append(make('li', '', line));

        root.replaceChildren(
            make('small', 'ss-packs-hint', 'Packs add items, creatures, shops, recipes, events and a start state. They are data only: nothing in a pack runs as code.'),
            actions,
            message,
            errors,
            list,
        );
    }

    render();
    return { refresh: render, importFile, importLorebook };
}
