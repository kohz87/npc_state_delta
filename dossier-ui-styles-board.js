/* NPC State Delta dossier surface: CSS-in-JS for the library faces, the Board's dial, the board and its tiles, plus the Neutral / Fantasy / Modern skin tokens set on the panel root's data-skin attribute. Scoped to the panel root and layered on the --delta-* vars from dossier-ui-styles.js. */
import { ROOT_ID } from './dossier-ui-constants.js';
import { PANE_HERO_MIN, PANE_HERO_SLIM_MIN, THREE_PANE_MIN, TWO_PANE_MIN } from './dossier-ui-screens.js';

const PANEL = `#${ROOT_ID}`;

export const BOARD_STYLES = `
/* Skin tokens. Neutral (the default, and any unknown value) keeps the panel's own --delta-* vars, so light and dark SillyTavern themes both read.
   Fantasy and Modern are fixed looks: they set the --delta-* palette too, so the whole panel follows the look. */
/* (also on the ss-cards panel inside the root: the mixes read --delta-floor / --delta-text where the host's light or dark tokens exist, not the root's fallbacks) */
${PANEL}:not([data-skin]), ${PANEL}[data-skin="neutral"], ${PANEL}:not([data-skin]) .delta-panel.ss-cards, ${PANEL}[data-skin="neutral"] .delta-panel.ss-cards {
  --good: #9cc49a; --bad: #d98a83; --held: #d4b56e;
  --dial: color-mix(in srgb, var(--delta-text) 22%, var(--delta-floor));
  --tick: color-mix(in srgb, var(--delta-text) 32%, var(--delta-floor));
  --dsk-ten: #d9a273; --aff: #d99aaa; --des: #b7a3cf; --trust: #8fb4d9;
  --dsk-tile: color-mix(in srgb, var(--delta-floor) 95%, var(--delta-text) 5%);
  --dsk-tile-bg: var(--dsk-tile);
  --dsk-tile-shadow: none; --dsk-tile-radius: 12px; --dsk-face-radius: 50%; --dsk-glow: none;
}
${PANEL}, ${PANEL} .delta-panel.ss-cards { --face-flat: color-mix(in srgb, var(--delta-text) 16%, var(--delta-floor)); }
${PANEL}[data-skin="fantasy"], ${PANEL}[data-skin="fantasy"] .delta-panel.ss-cards {
  --delta-bg: #18130d; --delta-floor: #18130d; --delta-text: #efe5cf; --delta-muted: #b3a37f; --delta-warn: #e0bf63;
  --delta-surface: #221b12; --delta-surface-strong: #2a2116; --delta-line: #5a4a2c; --delta-line-strong: #9a7c42;
  --delta-accent: #d9b56a; --delta-accent-soft: #e8d6a6; --delta-good: #8fbf7f; --delta-danger: #d07f6f;
  --good: #8fbf7f; --bad: #d07f6f; --held: #e0bf63; --dial: #6a5530; --tick: #9a7c42; --dsk-ten: #d9945a; --aff: #d78a9b; --des: #a98fc9; --trust: #7fa9cf;
  --dsk-tile: #221b12; --dsk-tile-bg: linear-gradient(180deg, #2a2116, #221b12);
  --dsk-tile-shadow: inset 0 0 0 3px #221b12, inset 0 0 0 4px rgba(90,74,44,.7);
  --dsk-tile-radius: 4px; --dsk-face-radius: 50% / 46%;
  --dsk-glow: 0 0 0 1px #9a7c42, 0 0 0 4px #18130d, 0 0 0 5px #6a5530;
}
${PANEL}[data-skin="modern"], ${PANEL}[data-skin="modern"] .delta-panel.ss-cards {
  --delta-bg: #101116; --delta-floor: #101116; --delta-text: #ecebef; --delta-muted: #9b9fae; --delta-warn: #e8c46a;
  --delta-surface: #15161c; --delta-surface-strong: #1b1c24; --delta-line: #2c2f3d; --delta-line-strong: #3d4152;
  --delta-accent: #8b7cf6; --delta-accent-soft: #c9c3ff; --delta-good: #5fcf8c; --delta-danger: #ef7a7a;
  --good: #5fcf8c; --bad: #ef7a7a; --held: #e8c46a; --dial: #22252f; --tick: #2f3240; --dsk-ten: #ff9f5a; --aff: #f28cb1; --des: #c58cff; --trust: #6fb3ff;
  --dsk-tile: #15161c; --dsk-tile-bg: var(--dsk-tile);
  --dsk-tile-shadow: none; --dsk-tile-radius: 12px; --dsk-face-radius: 50%;
  --dsk-glow: 0 0 40px rgba(255,159,90,.35);
}

/* Library: faces ringed by tone (the face sets --rc inline), search above, key people first. */
${PANEL} .delta-library-search { display:flex; align-items:center; gap:8px; margin:12px 12px 0; min-height:36px; padding:0 10px; border:1px solid var(--delta-line); border-radius:10px; color:var(--delta-muted); font-size:var(--dt-body); }
${PANEL} .delta-library-search input { flex:1 1 auto; min-width:0; min-height:30px !important; padding:0; border:0; background:transparent; color:var(--delta-text); outline:none; }
${PANEL} .delta-library-faces { display:grid; grid-template-columns:repeat(auto-fill,minmax(clamp(150px,17cqw,260px),1fr)); gap:clamp(8px,1.4cqw,16px); padding:clamp(10px,1.8cqw,18px); }
${PANEL} .delta-library-face { --rc:var(--dial); display:grid; justify-items:center; align-content:start; gap:4px; width:100%; min-width:0; padding:14px 8px 12px; border:1px solid var(--delta-line); border-radius:14px; background:var(--dsk-tile); color:var(--delta-text); font:inherit; text-align:center; cursor:pointer; content-visibility:auto; contain-intrinsic-size:auto 150px; }
${PANEL} .delta-library-face:focus, ${PANEL} .delta-library-face:focus-visible { content-visibility:visible; }
${PANEL} .delta-library-face.selected { outline:2px solid var(--delta-accent); outline-offset:-1px; }
${PANEL} .delta-library-av { display:block; width:clamp(70px,6.5cqw,92px); height:clamp(70px,6.5cqw,92px); margin-bottom:10px; overflow:hidden; border-radius:var(--dsk-face-radius); box-shadow:0 0 0 2px var(--dsk-tile), 0 0 0 3.5px var(--rc); }
${PANEL} .delta-library-portrait { display:block; width:100%; height:100%; object-fit:cover; object-position:50% 4%; }
${PANEL} .delta-library-portrait.delta-portrait-placeholder { display:grid; place-items:center; background:var(--face-flat); color:var(--delta-muted); font:700 clamp(15px,2.2cqw,26px)/1 var(--ss-font, system-ui, -apple-system, "Segoe UI", sans-serif); letter-spacing:.04em; }
${PANEL} .delta-tile-face.delta-portrait-placeholder { background:var(--face-flat); font-size:0; }
${PANEL} .delta-library-face > b { max-width:100%; color:var(--delta-accent-soft); overflow-wrap:anywhere; }
${PANEL} .delta-library-meta { max-width:100%; font-size:var(--dt-meta); color:color-mix(in srgb, var(--delta-accent) 32%, var(--delta-muted)); overflow-wrap:anywhere; }

/* Dial: the portrait <img> sits centred under the SVG ring. The SVG fills the box; its arcs take their colour from the attributes, the tracks and ticks from the skin. */
${PANEL} .dossier-dial { position:relative; width:min(clamp(210px,74cqw,440px),100%); aspect-ratio:1; margin:0 auto; }
${PANEL} .dossier-dial-portrait { position:absolute; top:50%; left:50%; width:66.6%; aspect-ratio:1; transform:translate(-50%,-50%); overflow:hidden; border-radius:var(--dsk-face-radius); box-shadow:var(--dsk-glow); }
${PANEL} .dossier-dial-img, ${PANEL} .dossier-dial-portrait .delta-portrait-placeholder { display:block; width:100%; height:100%; object-fit:cover; object-position:50% 4%; }
/* head and shoulders: the picture is shown at 150% from the top, as in the mockup */
${PANEL} .dossier-dial-img, ${PANEL} .delta-library-portrait:not(.delta-portrait-placeholder), ${PANEL} .delta-tile-face:not(.delta-portrait-placeholder) { transform:scale(1.5); transform-origin:50% 4%; }
${PANEL} .dossier-dial-portrait::after { content:"Profile ›"; position:absolute; left:50%; bottom:10px; transform:translateX(-50%); padding:1px 9px; border-radius:999px; background:rgba(0,0,0,.55); color:#fff; font-size:var(--dt-pill); font-weight:700; white-space:nowrap; }
/* no portrait: small initials in the suite font, centred in the disc (the Profile pill sits at its foot, clear of them) */
${PANEL} .dossier-dial-portrait .delta-portrait-placeholder { display:grid; place-items:center; padding-bottom:30px; font:700 clamp(13px,4cqw,24px)/1 var(--ss-font, system-ui, -apple-system, "Segoe UI", sans-serif); letter-spacing:.04em; color:var(--delta-muted); background:var(--face-flat); }
${PANEL} .dossier-dial-svg { position:absolute; inset:0; width:100%; height:100%; overflow:visible; }
${PANEL} .dossier-dial-svg path:not(.dial-arc), ${PANEL} .dossier-dial-svg circle { stroke:var(--dial); }
${PANEL} .dossier-dial-svg g { stroke:var(--tick); }
${PANEL} .dial-value { font-family:inherit; font-size:9.6px; font-weight:700; }
${PANEL} .dial-key { font-family:inherit; font-size:7.2px; font-weight:700; letter-spacing:.1em; fill:var(--delta-muted); }

/* Board: the dial, then the name and identity, the pills, the status, then the tiles (two columns on phone and desktop). */
${PANEL} .delta-board { display:grid; color:var(--delta-text); }
${PANEL} .delta-board-hero { display:grid; align-content:start; min-width:0; }
${PANEL} .delta-board-dial { display:grid; min-width:0; padding:clamp(10px,2.4cqw,20px) 12px 6px; border-radius:12px; cursor:pointer; }
${PANEL} .delta-board-name { padding:0 14px 6px; text-align:center; min-width:0; }
/* the name has its own class and explicit resets: a host theme's heading rules (a coloured bar at the left, an indent, a left alignment) cannot restyle it */
${PANEL} .delta-board-name .delta-board-title { display:block; margin:0 !important; padding:0 !important; border:0 !important; border-left:0 !important; border-radius:0; background:none !important; box-shadow:none !important; text-align:center !important; text-transform:none; letter-spacing:0; text-indent:0; font-family:inherit; font-size:clamp(28px,2.4cqw + 15px,34px); line-height:1.05; font-weight:700; color:var(--delta-accent-soft); overflow-wrap:anywhere; }
${PANEL} .delta-board-name p { margin:4px 0 0; font-size:var(--dt-meta); }
${PANEL} .delta-board-pills { display:flex; flex-wrap:wrap; justify-content:center; gap:6px; margin-top:6px; }
${PANEL} .delta-pill { padding:1px 9px; border:1px solid var(--delta-line); border-radius:999px; font-size:var(--dt-pill); font-weight:700; color:var(--delta-text); white-space:nowrap; }
${PANEL} .delta-pill-key { color:color-mix(in srgb, var(--held) 72%, var(--delta-text)); border-color:color-mix(in srgb, var(--held) 50%, transparent); }
${PANEL} .delta-pill-mood { color:color-mix(in srgb, var(--dsk-ten) 72%, var(--delta-text)); border-color:color-mix(in srgb, var(--dsk-ten) 50%, transparent); }
${PANEL} .delta-board-status { margin:4px 0 0; font-size:var(--dt-meta); color:var(--delta-muted); }
${PANEL} .delta-board-tiles { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:clamp(6px,1cqw,10px); padding:10px clamp(10px,2cqw,14px) 14px; }

/* Tiles: the tile sets --c (its tone) on the title; a tile with a section is a button. */
${PANEL} .delta-tile { --c:var(--delta-muted); display:grid; align-content:start; gap:4px; min-width:0; padding:9px 10px; border:1px solid var(--delta-line); border-radius:var(--dsk-tile-radius); background:var(--dsk-tile-bg); box-shadow:var(--dsk-tile-shadow); color:var(--delta-text); font:inherit; font-size:var(--dt-body); text-align:left; overflow-wrap:anywhere; }
${PANEL} button.delta-tile { cursor:pointer; }
${PANEL} .delta-tile-wide { grid-column:span 2; }
${PANEL} .delta-tile-k { display:flex; align-items:center; justify-content:space-between; gap:6px; font-size:var(--dt-kick); font-weight:700; letter-spacing:.12em; text-transform:uppercase; color:color-mix(in srgb, var(--c) 72%, var(--delta-text)); }
${PANEL} .delta-tile-arrow { font-size:var(--dt-pill); letter-spacing:0; color:var(--delta-muted); }
${PANEL} .delta-tile-mood::first-letter { text-transform:uppercase; }
${PANEL} .delta-tile-lead { font-weight:700; }
${PANEL} .delta-tile-small { font-size:var(--dt-meta); color:var(--delta-muted); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
${PANEL} .delta-tile-faces { display:flex; }
${PANEL} .delta-tile-face-ring { --fr:clamp(22px,1.6cqw + 12px,34px); width:var(--fr); height:var(--fr); margin-left:calc(var(--fr) / -4); overflow:hidden; border:2px solid var(--dsk-tile); border-radius:50%; box-shadow:0 0 0 1.5px var(--r); background:var(--face-flat); }
${PANEL} .delta-tile-face-ring:first-child { margin-left:0; }
${PANEL} .delta-tile-face { display:block; width:100%; height:100%; object-fit:cover; object-position:50% 4%; }
${PANEL} .delta-tile-big { font-size:clamp(17px,.5cqw + 13px,22px); font-weight:700; line-height:1.15; color:var(--delta-accent-soft); overflow-wrap:anywhere; }
${PANEL} .delta-tile-row { display:flex; align-items:center; gap:8px; }
${PANEL} .delta-tile-ring { --v:0; position:relative; display:grid; place-items:center; flex:none; width:clamp(34px,3.4cqw + 20px,52px); height:clamp(34px,3.4cqw + 20px,52px); border-radius:50%; background:conic-gradient(var(--c) calc(var(--v) * 1%), var(--dial) 0); }
${PANEL} .delta-tile-ring::after { content:""; position:absolute; inset:5px; border-radius:50%; background:var(--dsk-tile); }
${PANEL} .delta-tile-ring > span { position:relative; z-index:1; font-size:var(--dt-kick); font-weight:700; }

/* mood bars, pull ring, ties initials and past dots (phase 2 data) */
${PANEL} .delta-tile-bars { display:grid; gap:5px; }
${PANEL} .delta-tile-bar { display:grid; grid-template-columns:clamp(48px,5.6cqw,68px) minmax(0,1fr); align-items:center; gap:8px; font-size:var(--dt-meta); color:var(--delta-muted); }
${PANEL} .delta-tile-bar i { height:5px; border-radius:3px; background:var(--dial); overflow:hidden; }
${PANEL} .delta-tile-bar b { display:block; height:100%; border-radius:3px; background:var(--dsk-ten, var(--delta-accent)); }
${PANEL} .delta-tile-ring { --c:var(--held, var(--delta-warn)); }
${PANEL} .delta-tile-faces .delta-tile-face.delta-tile-initials { display:grid; place-items:center; font-size:clamp(7px,.2cqw + 6px,9px); line-height:1; letter-spacing:-.04em; overflow:hidden; font-weight:700; background:var(--face-flat); color:var(--delta-text); transform:none; }
${PANEL} .delta-tile-dots { display:flex; align-items:center; justify-content:space-between; gap:0; margin:2px 0; position:relative; }
${PANEL} .delta-tile-dots::before { content:""; position:absolute; left:4px; right:4px; top:50%; height:1px; background:var(--delta-line); }
${PANEL} .delta-tile-dots i, ${PANEL} .delta-timeline i { flex:none; position:relative; width:9px; height:9px; border-radius:50%; background:var(--des, #b7a3cf); }
${PANEL} .delta-tile-dots:has(> i:only-child)::before { display:none; }
${PANEL} .delta-tile-dots i.delta-dot-lie, ${PANEL} .delta-timeline i.delta-dot-lie { background:var(--held, #d9b85c); }
${PANEL} .delta-tile-dots i.delta-dot-know { background:var(--trust, #8fb4d9); }

/* the library bar under every other screen */
${PANEL} .delta-library-foot[data-static] { cursor:default; }
${PANEL} .delta-library-foot { display:block; width:100%; padding:8px 12px; border:0; border-top:1px solid var(--delta-line); background:var(--delta-floor); color:var(--delta-muted); font:inherit; font-size:var(--dt-pill); font-weight:700; letter-spacing:.12em; text-align:left; text-transform:uppercase; cursor:pointer; }

/* Two panes (the dial and name beside the tiles) when both fit: from the width the dial pane (250) and the tiles (2 x 150 and gaps) need. */
@container dsr (min-width: ${TWO_PANE_MIN}px) {
  ${PANEL} .delta-board { grid-template-columns:clamp(${PANE_HERO_MIN}px,32%,460px) minmax(0,1fr); align-items:stretch; height:100%; }
  ${PANEL} .delta-panes[data-screen="section"] .delta-board { grid-template-columns:clamp(${PANE_HERO_SLIM_MIN}px,40%,300px) minmax(0,1fr); }
  ${PANEL} .delta-board-hero { border-right:1px solid var(--delta-line); padding-bottom:14px; overflow:hidden; align-content:center; }
  /* a taller panel (the host's full screen) spreads the tiles over its height; a content-sized one keeps them as they are */
  ${PANEL} .delta-board-tiles { align-content:stretch; grid-auto-rows:minmax(min-content,1fr); padding:12px; }
  ${PANEL} .delta-library-search { max-width:380px; margin:16px 16px 0; }
}
/* A section open beside the board: with no room for three panes the board pane is the dial and name alone, the section takes the rest. */
@container dsr (min-width: ${TWO_PANE_MIN}px) and (max-width: ${THREE_PANE_MIN - 0.02}px) {
  ${PANEL} .delta-panes[data-screen="section"] .delta-board { grid-template-columns:minmax(0,1fr); }
  ${PANEL} .delta-panes[data-screen="section"] .delta-board-tiles { display:none; }
  ${PANEL} .delta-board-hero { border-right:0; }
}
`;
