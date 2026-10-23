// Versions: which Story Suite modules are installed, which Story Block each says it needs, and what is
// out of step, each with one plain sentence on how to fix it. The Story Suite overlay shows it as its
// Versions fold (host-ui.js).
//
//   compatReport({ hostVersion, modules, refusals, warnings? }) → { host, rows, outOfStep }
//   renderCompat(el, report, { doc? })                          the fold's body
//
// A row is `{ id, name, version, requires, state, note, fix }`, state one of
//   ok         registered, and its `requires.storyBlock` holds for this Story Block;
//   unstated   registered, says nothing about which Story Block it needs (fine; noted only);
//   newer      registered, but parts of its definition are ones this Story Block does not know (a module
//              made for a newer Story Block): those parts are ignored;
//   refused    not registered: it needs another Story Block, or clashes with a module already here;
//   twice      a second copy of a module that is registered was refused.
// `outOfStep` counts newer, refused and twice. Pure except renderCompat (textContent only: names and
// versions come from other extensions).

import { definitionWarnings } from './registry.js';
import { satisfies } from './packs/version.js';
import { cutAt } from '../text.js';

const STATES = Object.freeze({ ok: 'In step', unstated: 'In step', newer: 'Newer than this Story Block', refused: 'Not loaded', twice: 'Installed twice' });
const OUT = new Set(['newer', 'refused', 'twice']);

const text = value => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
// What other extensions give is shown cut (B-rxui-12): a name, a version, a range, a refusal's words.
const CUT = Object.freeze({ name: 60, version: 40, range: 60, note: 400 });
const clip = (value, max) => {
    const line = text(value);
    return line.length > max ? `${cutAt(line, max - 1)}…` : line;
};

/**
 * `modules`: the registered definitions (registry.modules()); `refusals`: registry.refusals();
 * `warnings(def)` → plain sentences about fields this Story Block does not know (default
 * definitionWarnings). Story Block itself comes first.
 */
export function compatReport({ hostVersion = '', modules = [], refusals = [], warnings = definitionWarnings } = {}) {
    const host = text(hostVersion);
    const rows = [];
    const registered = new Set();
    for (const def of modules) {
        if (!def || typeof def.id !== 'string') continue;
        registered.add(def.id);
        const name = clip(def.name, CUT.name) || clip(def.id, CUT.name);
        const version = clip(def.version, CUT.version);
        const requires = clip(def.requires?.storyBlock, CUT.range);
        const row = { id: clip(def.id, CUT.name), name, version, requires, state: 'ok', note: '', fix: '' };
        if (def.id === 'story-block') {
            row.note = host ? `This Story Block is ${host}.` : '';
            rows.unshift(row);
            continue;
        }
        let unknown = [];
        try { unknown = warnings(def) ?? []; } catch { unknown = []; }
        if (unknown.length) {
            row.state = 'newer';
            row.note = clip(`${unknown.length} ${unknown.length === 1 ? 'part' : 'parts'} of it this Story Block does not know: ${unknown.map(line => text(line).replace(/; it is ignored$/, '')).join('; ')}.`, CUT.note);
            row.fix = `${name} was made for a newer Story Block: update Story Block to use all of it (until then those parts are left out).`;
        } else if (!requires) {
            row.state = 'unstated';
            row.note = 'It does not say which Story Block it needs.';
        } else if (host && !satisfies(host, requires)) {
            // Registered on a host that does not meet it (a registry built without the check).
            row.state = 'refused';
            row.fix = `${name} needs Story Block ${requires}; this is ${host}. Update Story Block.`;
        } else {
            row.note = `Needs Story Block ${requires}: this one fits.`;
        }
        rows.push(row);
    }
    for (const item of refusals) {
        if (!item || typeof item.id !== 'string') continue;
        const name = clip(item.name, CUT.name) || clip(item.id, CUT.name);
        const row = { id: clip(item.id, CUT.name), name, version: clip(item.version, CUT.version), requires: clip(item.requires, CUT.range), state: 'refused', note: clip(item.message, CUT.note), fix: '' };
        if (registered.has(item.id)) {
            row.state = 'twice';
            row.fix = `Two copies of ${name} are installed; remove the older one in SillyTavern's Extensions panel and reload.`;
        } else if (item.forVersion) {
            row.fix = `Update Story Block to use ${name}${host ? ` (this is ${host}${row.requires ? `; it needs ${row.requires}` : ''})` : ''}, or install the ${name} version made for this one.`;
        } else {
            row.fix = `${name} could not be loaded beside the modules here: update ${name} and the module it clashes with to versions made for each other.`;
        }
        rows.push(row);
    }
    return { host, rows, outOfStep: rows.filter(row => OUT.has(row.state)).length };
}

/** "needs ≥2.0.0-beta.1": a `>=` range is said with ≥, any other range as it is written. */
const needsText = requires => (requires ? `needs ${requires.replace(/^>=\s*/, '≥')}` : 'needs: not said');

/**
 * The Versions card's body: one line per module, each said once ("RPG Battle 2.0.0-beta.1 · needs ≥2.0.0-beta.1 · In step"); what a
 * module that is out of step makes of it (its note and the fix) goes under its line, and nothing is repeated for one that fits.
 */
export function renderCompat(el, report, { doc = el?.ownerDocument ?? globalThis.document } = {}) {
    const make = (tag, className, value) => {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (value) node.textContent = value;
        return node;
    };
    el.replaceChildren();
    el.appendChild(make('p', 'story-suite-muted', report.outOfStep
        ? `${report.outOfStep} ${report.outOfStep === 1 ? 'module is' : 'modules are'} out of step with this Story Block${report.host ? ` (${report.host})` : ''}.`
        : `Every module here fits this Story Block${report.host ? ` (${report.host})` : ''}.`));
    const list = make('ul', 'story-suite-compat');
    for (const row of report.rows) {
        const item = make('li', `story-suite-compat-row story-suite-compat-${row.state}`);
        item.dataset.module = row.id;
        item.dataset.state = row.state;
        const head = make('div', 'story-suite-compat-head');
        head.appendChild(make('b', 'story-suite-compat-name', row.name));
        head.appendChild(make('span', 'story-suite-compat-version', row.version || 'no version'));
        // Story Block itself needs nothing; every other row says which Story Block it needs.
        if (row.id !== 'story-block') head.appendChild(make('span', 'story-suite-muted story-suite-compat-requires', needsText(row.requires)));
        head.appendChild(make('span', 'story-suite-compat-state', STATES[row.state] ?? row.state));
        item.appendChild(head);
        // A module that fits says nothing more; one that does not says why and what to do.
        if (row.state !== 'ok' && row.state !== 'unstated') {
            if (row.note) item.appendChild(make('small', 'story-suite-muted story-suite-compat-note', row.note));
            if (row.fix) item.appendChild(make('p', 'story-suite-compat-fix', row.fix));
        }
        list.appendChild(item);
    }
    el.appendChild(list);
    return report;
}
