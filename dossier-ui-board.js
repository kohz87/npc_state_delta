/* NPC State Delta dossier surface: the Board screen (dial, name and status, tiles). Pure markup from boardModel and dialHtml; no DOM access and no listeners. The dial and the tiles carry data-delta-screen / data-delta-section for the screens module's delegated click handler. */
import { escapeHtml } from './src/util/html.js';
import { dialHtml } from './dossier-ui-dial.js';
import { boardModel } from './dossier-ui-view-model.js';

// Tone keys → the --delta-* tokens the skins define. Anything else gets no tone, so a model value can never inject CSS.
const TONES = { good: 'var(--delta-good)', bad: 'var(--delta-danger)' };
const esc = value => escapeHtml(String(value ?? ''));
const toneVar = key => TONES[key] || 'var(--delta-muted)';
const percent = value => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
const signed = value => `${value > 0 ? '+' : ''}${value}`;

// One tile. Fields (all optional except title): title, section, tone, wide, big, lines[], note, ring{value,text}.
// A tile without a section is not tappable.
export function boardTileHtml(tile = {}) {
    const head = `<span class="delta-tile-k" style="--c:${toneVar(tile.tone)}">${esc(tile.title)}${tile.section ? ' <span class="delta-tile-arrow">›</span>' : ''}</span>`;
    const body = [
        tile.big ? `<span class="delta-tile-big">${esc(tile.big)}</span>` : '',
        ...(Array.isArray(tile.lines) ? tile.lines.filter(Boolean).map(line => `<span>${esc(line)}</span>`) : []),
        tile.ring ? `<span class="delta-tile-row"><span class="delta-tile-ring" style="--v:${percent(tile.ring.value)}"><span>${esc(tile.ring.text)}</span></span>${tile.note ? `<span class="delta-muted">${esc(tile.note)}</span>` : ''}</span>` : (tile.note ? `<span class="delta-muted">${esc(tile.note)}</span>` : ''),
    ].join('');
    const classes = `delta-tile${tile.wide ? ' delta-tile-wide' : ''}`;
    if (tile.section) {
        return `<button type="button" class="${classes}" data-delta-screen="section" data-delta-section="${esc(tile.section)}">${head}${body}</button>`;
    }
    return `<div class="${classes}">${head}${body}</div>`;
}

// The tiles, in mockup order, from the boardModel tiles object. Pull is null until phase-2 data exists: no tile.
// `userName` replaces the literal "{{user}}" in the With {{user}} title.
export function boardTiles(model = {}, { userName = 'you' } = {}) {
    const tiles = model.tiles || {};
    const last = tiles.lastChange || {};
    const moved = Array.isArray(last.moved) ? last.moved : [];
    const secrets = tiles.secrets || {};
    const sets = [
        {
            title: `${(last.title || 'With {{user}}').replace('{{user}}', userName)} · ${last.heading || 'Last change'}`,
            section: 'with',
            wide: true,
            tone: moved.some(item => item.value < 0) ? 'bad' : (moved.length ? 'good' : ''),
            big: moved.length ? moved.map(item => `${item.label} ${signed(item.value)}`).join(' · ') : (last.hasChange ? '' : 'No change yet'),
            lines: [last.reason, last.when],
        },
        { title: tiles.mood?.title || 'Mood', wide: !tiles.pull, big: tiles.mood?.text || 'Unknown' },
        tiles.pull ? { title: tiles.pull.title || 'Pull', big: tiles.pull.text } : null,
        {
            title: tiles.rightNow?.title || 'Right now',
            section: 'now',
            wide: true,
            lines: [tiles.rightNow?.summary || 'Nothing recorded yet'],
        },
        {
            title: tiles.ties?.title || 'Ties',
            section: 'ties',
            big: String(tiles.ties?.count ?? 0),
            lines: [Array.isArray(tiles.ties?.names) && tiles.ties.names.length ? tiles.ties.names.join(', ') : 'None established yet'],
        },
        {
            title: tiles.past?.title || 'Past',
            section: 'past',
            big: String(tiles.past?.count ?? 0),
            lines: [tiles.past?.latest || 'Nothing remembered yet'],
        },
        {
            title: secrets.title || 'Secrets',
            section: 'secrets',
            wide: true,
            ring: { value: secrets.total ? (secrets.open / secrets.total) * 100 : 0, text: `${secrets.open ?? 0}/${secrets.total ?? 0}` },
            note: secrets.next ? `Next opens ${secrets.next}` : (secrets.total ? 'All open' : 'None yet'),
        },
    ];
    return sets.filter(Boolean);
}

// The Board screen for one NPC: the dial (portrait inside; a tap opens the profile), the name, identity
// and status, the pills (key person, mood), then the tiles. `refs` is the panel's createPortraitRefs()
// (refs.fill is the caller's job, after the markup is in the DOM).
export function boardHtml(npc = {}, { refs = null, userName = 'you' } = {}) {
    const model = boardModel(npc) || {};
    const name = model.name || 'Unnamed NPC';
    const pills = [
        model.isKey ? { text: '★ Key person', kind: 'key' } : null,
        model.tiles?.mood?.text ? { text: model.tiles.mood.text, kind: 'mood' } : null,
    ].filter(Boolean);
    const identity = [model.species, model.gender, model.role].filter(Boolean).join(' · ');
    const tiles = boardTiles(model, { userName }).map(boardTileHtml).join('');
    return `<section class="delta-board" data-delta-board="${esc(model.id)}">`
        + `<div class="delta-board-dial" role="button" tabindex="0" data-delta-screen="profile" aria-label="${esc(name)} profile">${dialHtml(npc, { refs })}</div>`
        + `<div class="delta-board-name"><h3>${esc(name)}</h3>`
        + (pills.length ? `<div class="delta-board-pills">${pills.map(pill => `<span class="delta-pill delta-pill-${pill.kind}">${esc(pill.text)}</span>`).join('')}</div>` : '')
        + (identity ? `<p class="delta-muted">${esc(identity)}</p>` : '')
        + (model.status ? `<p class="delta-board-status">${esc(model.status)}</p>` : '')
        + '</div>'
        + `<div class="delta-board-tiles">${tiles}</div>`
        + '</section>';
}
