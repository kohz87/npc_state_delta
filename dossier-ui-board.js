/* NPC State Delta dossier surface: the Board screen (dial, name and status, tiles). Pure markup from boardModel and dialHtml; no DOM access and no listeners. The dial and the tiles carry data-delta-screen / data-delta-section for the screens module's delegated click handler. */
import { escapeHtml } from './src/util/html.js';
import { initialsOf, portraitHtml } from './dossier-ui-html.js';
import { dialHtml } from './dossier-ui-dial.js';
import { boardModel, gateWords, possessiveWord } from './dossier-ui-view-model.js';

// Tone keys → the --delta-* tokens the skins define. Anything else gets no tone, so a model value can never inject CSS.
const TONES = { good: 'var(--good, var(--delta-good))', bad: 'var(--bad, var(--delta-danger))', ten: 'var(--dsk-ten)', aff: 'var(--aff)', des: 'var(--des)', held: 'var(--held)' };
const esc = value => escapeHtml(String(value ?? ''));
const toneVar = key => TONES[key] || 'var(--delta-muted)';
const percent = value => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
const signed = value => `${value > 0 ? '+' : ''}${value}`;

// The Energy and Control bars of the Mood tile (the Board tile and the Right now section draw the same two bars).
export const moodBarList = mood => (mood?.max ? [{ label: 'Energy', value: mood.energy, max: mood.max }, { label: 'Control', value: mood.control, max: mood.max }] : null);
// Right now draws all three: Feeling too, spanning the full row.
export const moodBarList3 = mood => (mood?.max ? [{ label: 'Feeling', value: mood.feeling, max: mood.max }, ...moodBarList(mood)] : null);
export const barsHtml = bars => `<span class="delta-tile-bars">${bars.map(bar => `<span class="delta-tile-bar"><span>${esc(bar.label)}</span><i><b style="width:${percent((bar.value / (bar.max || 1)) * 100)}%"></b></i></span>`).join('')}</span>`;

// One tile. Fields (all optional except title): title, section, tone, wide, big, lines[], note, ring{value,text}.
// A tile without a section is not tappable.
export function boardTileHtml(tile = {}) {
    const head = `<span class="delta-tile-k" style="--c:${toneVar(tile.tone)}">${esc(tile.title)}${tile.section ? ' <span class="delta-tile-arrow">›</span>' : ''}</span>`;
    const raw = (Array.isArray(tile.lines) ? tile.lines.filter(Boolean) : []).map(String);
    // A lead (the toned bold start of the first line) joins that line with " · ", as the mockup's last-change tile reads;
    // any further line is the small muted one.
    const first = tile.lead ? [`<span><b class="delta-tile-lead" style="color:color-mix(in srgb, ${toneVar(tile.tone)} 72%, var(--delta-text))">${esc(tile.lead)}</b>${raw.length ? ` · ${esc(raw.shift())}` : ''}</span>`] : [];
    const lines = [...first, ...raw.map(line => `<span${tile.lead || tile.small ? ' class="delta-tile-small"' : ''}>${esc(line)}</span>`)];
    const body = [
        tile.big ? `<span class="delta-tile-big${tile.bigClass ? ` ${tile.bigClass}` : ''}">${esc(tile.big)}</span>` : '',
        tile.faces || '',
        tile.bars ? barsHtml(tile.bars) : '',
        tile.dots?.length ? `<span class="delta-tile-dots">${tile.dots.map(kind => `<i class="delta-dot-${/^(mem|lie|know)$/.test(kind) ? kind : 'mem'}"></i>`).join('')}</span>` : '',
        ...lines,
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
export function boardTiles(model = {}, { userName = 'you', facesHtml = '' } = {}) {
    const tiles = model.tiles || {};
    const last = tiles.lastChange || {};
    const moved = Array.isArray(last.moved) ? last.moved : [];
    const secrets = tiles.secrets || {};
    const now = tiles.rightNow || {};
    const ties = tiles.ties || {};
    const past = tiles.past || {};
    const next = String(secrets.next || '').replace(/^opens\s*/i, '');
    const sets = [
        {
            title: `${(last.title || 'With {{user}}').replace('{{user}}', userName)} · ${last.heading || 'Last change'}`,
            section: 'with',
            wide: true,
            // tension rising reads as bad, the other axes falling too (the same rule as the Recent changes list)
            tone: moved.some(item => (item.axis === 'tension' ? item.value > 0 : item.value < 0)) ? 'bad' : (moved.length ? 'good' : ''),
            lead: moved.length ? moved.map(item => `${item.label} ${signed(item.value)}`).join(' · ') : '',
            big: moved.length ? '' : (last.hasChange ? '' : 'No change yet'),
            lines: [gateWords(last.gate), last.reason],
        },
        {
            title: tiles.mood?.title || 'Mood', wide: !tiles.pull, tone: 'ten', big: tiles.mood?.text || 'Unknown', bigClass: 'delta-tile-mood',
            bars: moodBarList(tiles.mood),
        },
        tiles.pull ? { title: tiles.pull.title || 'Pull', big: tiles.pull.text, bigClass: 'delta-tile-mood', ring: { value: (tiles.pull.level / 4) * 100, text: '' }, note: tiles.pull.note } : null,
        {
            // The place joins the title when the body is what she is doing, as the mockup reads: RIGHT NOW · NORTHERN RIDGE.
            title: `${now.title || 'Right now'}${now.doing && now.place ? ` · ${now.place}` : ''}`,
            section: 'now',
            tone: 'ten',
            wide: true,
            lines: [now.summary || 'Nothing recorded yet'],
        },
        {
            title: ties.title || 'Ties',
            section: 'ties',
            tone: 'aff',
            faces: facesHtml,
            small: true,
            lines: [ties.count ? `${ties.count}${ties.lies ? ` · ${ties.lies} ${ties.lies === 1 ? 'lie' : 'lies'}` : ''} · ${(ties.names || []).join(', ')}` : 'None established yet'],
        },
        {
            title: `${past.title || 'Past'}${past.count ? ` · ${past.count}` : ''}`,
            section: 'past',
            tone: 'des',
            small: true,
            dots: past.dots,
            lines: [past.latest || 'Nothing remembered yet'],
        },
        {
            title: secrets.title || 'Secrets',
            section: 'secrets',
            tone: 'held',
            wide: true,
            ring: { value: secrets.total ? (secrets.open / secrets.total) * 100 : 0, text: `${secrets.open ?? 0}/${secrets.total ?? 0}` },
            note: [secrets.lastOpen ? `${secrets.lastOpen} opened` : '', next ? `the next opens ${next}` : (secrets.total ? (secrets.open === secrets.total ? 'all open' : '') : 'None yet')].filter(Boolean).join(' · '),
        },
    ];
    return sets.filter(Boolean);
}


// The faces of the Ties tile: up to three people ringed by the bond tone, with their portrait when they have a dossier of their own
// (`peers`: lower-cased name -> portrait). A person with no portrait shows the plain disc.
function tieFacesHtml(faces = [], { peers = null, refs = null } = {}) {
    if (!faces.length) return '';
    const ring = { good: 'var(--good)', bad: 'var(--bad)', gold: 'var(--held)' };
    return `<span class="delta-tile-faces">${faces.map(face => `<span class="delta-tile-face-ring" style="--r:${ring[face.tone] || 'var(--dial)'}" title="${esc(face.name)}">${peers?.get(String(face.name).toLowerCase()) ? portraitHtml({ name: face.name, portrait: peers.get(String(face.name).toLowerCase()) }, 'delta-tile-face', { alt: false, refs }) : `<span class="delta-tile-face delta-tile-initials">${esc(initialsOf(face.name))}</span>`}</span>`).join('')}</span>`;
}

// The Board screen for one NPC: the dial (portrait inside; a tap opens the profile), the name, identity
// and status, the pills (key person, mood), then the tiles. `refs` is the panel's createPortraitRefs()
// (refs.fill is the caller's job, after the markup is in the DOM).
export function boardHtml(npc = {}, { refs = null, userName = 'you', peers = null } = {}) {
    const model = boardModel(npc) || {};
    const name = model.name || 'Unnamed NPC';
    const pills = [
        model.isKey ? { text: '★ Key person', kind: 'key' } : null,
        model.tiles?.mood?.text ? { text: model.tiles.mood.text, kind: 'mood' } : null,
    ].filter(Boolean);
    // As written in the dossier, with the first letter of each part capitalised ("male · bargemaster" reads "Male · Bargemaster").
    const identity = [model.species, model.gender, model.role].filter(Boolean).map(part => `${[...part][0].toUpperCase()}${[...part].slice(1).join('')}`).join(' · ');
    const tiles = boardTiles(model, { userName, facesHtml: tieFacesHtml(model.tiles?.ties?.faces, { peers, refs }) }).map(boardTileHtml).join('');
    const profile = `<div class="delta-board-dial" role="button" tabindex="0" data-delta-screen="profile" aria-label="${esc(name)} profile">${dialHtml(npc, { refs })}</div>`;
    const nameBlock = `<div class="delta-board-name"><h3 class="delta-board-title">${esc(name)}</h3>`
        + (pills.length ? `<div class="delta-board-pills">${pills.map(pill => `<span class="delta-pill delta-pill-${pill.kind}">${esc(pill.text)}</span>`).join('')}</div>` : '')
        + `<p class="delta-muted">${esc([identity, `tap the portrait for ${possessiveWord(npc.gender, { lower: true })} profile`].filter(Boolean).join(' · '))}</p>`
        + (model.status ? `<p class="delta-board-status">${esc(model.status)}</p>` : '')
        + '</div>';
    // Desktop puts the dial and name in a pane of their own beside the tiles (the mockup's left pane); phone stacks them.
    return `<section class="delta-board" data-delta-board="${esc(model.id)}"><div class="delta-board-hero">${profile}${nameBlock}</div>`
        + `<div class="delta-board-tiles">${tiles}</div></section>`;
}
