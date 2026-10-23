// The standard widgets' base stylesheet, added once per document by the first widget drawn.
//
// Every rule sits inside :where(), so it has no specificity: a screen's scoped CSS (§13.3) or theme
// overrides any of it. Colours and sizes are custom properties (--ss-w-*) that default to the screen's
// --ss-accent and SillyTavern's own theme colours.

export const widgetCss = `
:where(.ss-w) {
  --ss-w-fg: var(--ss-text, var(--SmartThemeBodyColor, #dcdcd2));
  --ss-w-muted: var(--ss-muted, color-mix(in srgb, var(--ss-w-fg) 60%, transparent));
  --ss-w-bg: var(--ss-glass-strong, color-mix(in srgb, var(--SmartThemeBlurTintColor, #171717) 85%, transparent));
  --ss-w-raised: var(--ss-tile, color-mix(in srgb, var(--ss-w-fg) 8%, transparent));
  --ss-w-border: var(--ss-border, var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.2)));
  --ss-w-accent: var(--ss-accent, var(--SmartThemeQuoteColor, #7c5cff));
  --ss-w-good: #4caf6e;
  --ss-w-warn: #d9a33a;
  --ss-w-bad: #d0504a;
  --ss-w-info: #4a90d0;
  --ss-w-tone: var(--ss-w-fg);
  --ss-w-radius: 6px;
  --ss-w-gap: 0.4em;
  color: var(--ss-w-fg);
  box-sizing: border-box;
  max-width: 100%;
  min-width: 0;
}
:where(.ss-w *, .ss-w *::before, .ss-w *::after) { box-sizing: border-box; }
:where(.ss-w [hidden]) { display: none !important; }
:where(.ss-w-tone-neutral) { --ss-w-tone: var(--ss-w-fg); }
:where(.ss-w-tone-accent) { --ss-w-tone: var(--ss-w-accent); }
:where(.ss-w-tone-good) { --ss-w-tone: var(--ss-w-good); }
:where(.ss-w-tone-warn) { --ss-w-tone: var(--ss-w-warn); }
:where(.ss-w-tone-bad) { --ss-w-tone: var(--ss-w-bad); }
:where(.ss-w-tone-info) { --ss-w-tone: var(--ss-w-info); }
:where(.ss-w-sr) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; margin: -1px; padding: 0; border: 0; }
:where(.ss-w-empty-note) { margin: 0.4em 0; color: var(--ss-w-muted); font-style: italic; }
:where(.ss-w-icon-img) { width: 1.2em; height: 1.2em; object-fit: contain; vertical-align: middle; }
:where(.ss-w button) { font: inherit; color: inherit; cursor: pointer; }
:where(.ss-w button:disabled, .ss-w [aria-disabled="true"]) { cursor: not-allowed; opacity: 0.5; }
:where(.ss-w :focus-visible) { outline: 2px solid var(--ss-w-accent); outline-offset: 2px; }

/* meter */
:where(.ss-w-meter) { display: flex; flex-direction: column; gap: 0.2em; }
:where(.ss-w-meter-head) { display: flex; align-items: baseline; gap: var(--ss-w-gap); font-size: 0.9em; }
:where(.ss-w-meter-label) { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
:where(.ss-w-meter-value) { margin-left: auto; font-variant-numeric: tabular-nums; color: var(--ss-w-muted); }
:where(.ss-w-meter-track) { position: relative; height: var(--ss-w-meter-height, 0.6em); border-radius: 999px; background: var(--ss-w-raised); overflow: hidden; }
:where(.ss-w-meter-fill) { position: absolute; inset: 0 auto 0 0; width: calc(var(--ss-w-ratio, 0) * 100%); background: var(--ss-w-tone); border-radius: inherit; transition: width 0.25s ease; }
:where(.ss-w-meter-cells) { display: none; }
:where(.ss-w-segmented .ss-w-meter-track) { background: none; overflow: visible; }
:where(.ss-w-segmented .ss-w-meter-fill) { display: none; }
:where(.ss-w-segmented .ss-w-meter-cells) { display: grid; grid-template-columns: repeat(var(--ss-w-segments, 1), 1fr); gap: 2px; height: 100%; }
:where(.ss-w-meter-cell) { border-radius: 2px; background: var(--ss-w-raised); }
:where(.ss-w-meter-cell.ss-w-on) { background: var(--ss-w-tone); }
:where(.ss-w-meter-cell.ss-w-part) { background: color-mix(in srgb, var(--ss-w-tone) 45%, transparent); }
:where(.ss-w-meter-stage) { font-size: 0.85em; color: var(--ss-w-tone); white-space: nowrap; }
:where(.ss-w-meter-delta) { font-size: 0.85em; font-variant-numeric: tabular-nums; white-space: nowrap; }
:where(.ss-w-meter-delta.ss-w-up) { color: var(--ss-w-good); }
:where(.ss-w-meter-delta.ss-w-down) { color: var(--ss-w-bad); }
:where(.ss-w-meter-band) { position: absolute; top: 0; bottom: 0; background: color-mix(in srgb, var(--ss-w-bad) 22%, transparent); pointer-events: none; }
:where(.ss-w-meter-band.ss-w-lo) { left: 0; width: calc(var(--ss-w-warn-lo, 0) * 100%); }
:where(.ss-w-meter-band.ss-w-hi) { left: calc(var(--ss-w-warn-hi, 1) * 100%); right: 0; }
:where(.ss-w-meter-band.ss-w-in) { background: color-mix(in srgb, var(--ss-w-bad) 40%, transparent); }
:where(.ss-w-critical .ss-w-meter-fill) { background: var(--ss-w-bad); }
:where(.ss-w-critical .ss-w-meter-value) { color: var(--ss-w-bad); font-weight: bold; }
:where(.ss-w-meter-above) { position: absolute; top: 0; bottom: 0; right: 0; left: calc(var(--ss-w-ceiling, 1) * 100%); background: repeating-linear-gradient(135deg, transparent 0 3px, color-mix(in srgb, var(--ss-w-fg) 18%, transparent) 3px 5px); pointer-events: none; }
:where(.ss-w-meter-ceiling) { position: absolute; top: 0; bottom: 0; left: calc(var(--ss-w-ceiling, 1) * 100%); width: 2px; margin-left: -1px; background: var(--ss-w-fg); border-radius: 1px; }
:where(.ss-w-meter-ticks) { position: absolute; inset: 0; pointer-events: none; }
:where(.ss-w-meter-tick) { position: absolute; top: 0; bottom: 0; left: calc(var(--ss-w-at, 0) * 100%); width: 1px; margin-left: -0.5px; background: color-mix(in srgb, var(--ss-w-fg) 55%, transparent); pointer-events: auto; }
:where(.ss-w-meter-tick.ss-w-on) { background: var(--ss-w-fg); }

/* radar */
:where(.ss-w-radar) { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 0.2em; --ss-w-tone: var(--ss-w-accent); }
:where(.ss-w-radar-svg) { width: 100%; max-width: var(--ss-w-radar-size, 22em); height: auto; overflow: visible; }
:where(.ss-w-radar-caption) { font-weight: 600; }
:where(.ss-w-radar-ring) { fill: none; stroke: var(--ss-w-border); stroke-width: 1; }
:where(.ss-w-radar-spoke) { stroke: var(--ss-w-border); stroke-width: 1; }
:where(.ss-w-radar-area) { fill: color-mix(in srgb, var(--ss-w-tone) 35%, transparent); stroke: var(--ss-w-tone); stroke-width: 2; }
:where(.ss-w-radar-before) { fill: none; stroke: var(--ss-w-muted); stroke-width: 1.5; stroke-dasharray: 4 3; }
:where(.ss-w-radar-dot) { fill: var(--ss-w-tone); }
:where(.ss-w-radar-dot.ss-w-up) { fill: var(--ss-w-good); }
:where(.ss-w-radar-dot.ss-w-down) { fill: var(--ss-w-bad); }
:where(.ss-w-radar-label) { fill: var(--ss-w-fg); font-size: calc(var(--ss-w-radar-label, 11) * 1px); }
:where(.ss-w-radar-value) { fill: var(--ss-w-muted); }

/* map: a glass panel over the page, on the look's tokens (Map.dc.html): the stage, the place pins and their name chips,
   the layer pills and the zoom buttons as glass controls, the legend and the minimap as glass cards. The widget's own
   --ss-w-* names fall back to the look's, so an older screen theme still works. Every control has its rest, hover,
   focus-visible and active states; the map never disables a control (zoom clamps at its limits). */
/* the map's glass: the look's glass unless a screen sets --ss-w-map-bg (the stage and the minimap take it) */
:where(.ss-w-map) { --ss-w-map-bg: var(--ss-glass, var(--ss-w-bg)); display: flex; flex-direction: column; gap: var(--ss-w-gap); }
:where(.ss-w-map-bar) { display: flex; flex-wrap: wrap; gap: 8px; justify-content: space-between; align-items: center; }
:where(.ss-w-map-layers, .ss-w-map-zoom) { display: flex; flex-wrap: wrap; gap: 6px; }
:where(.ss-w-map-btn, .ss-w-map-layer) { min-width: 40px; min-height: 40px; max-width: 100%; overflow-wrap: anywhere; box-sizing: border-box; padding: 0 12px; border: 1px solid var(--ss-w-border); border-radius: var(--ss-radius-pill, 999px); background: var(--ss-w-bg); cursor: pointer; transition: border-color var(--ss-motion, 0.2s) ease, background-color var(--ss-motion, 0.2s) ease; }
/* SillyTavern's own "button { font-family; font-size; color }" rule (specificity 0,0,1) would beat the :where() rules, so the type of
   a control and of a selectable place (a button) is set at class level: the look's text colour, whatever SillyTavern's button colour is. */
.ss-w-map-btn, .ss-w-map-layer { font: inherit; font-weight: 600; line-height: 1; color: var(--ss-w-fg); }
:where(.ss-w-map-zoom .ss-w-map-btn) { width: 40px; padding: 0; border-radius: 10px; }
.ss-w-map-zoom .ss-w-map-btn { font-size: 1.2em; }
button.ss-w-map-node { font: inherit; font-size: 0.85em; color: var(--ss-w-fg); }
:where(.ss-w-map-btn:hover, .ss-w-map-layer:hover, .ss-w-map-btn:focus-visible, .ss-w-map-layer:focus-visible, .ss-w-map-btn:active, .ss-w-map-layer:active) { border-color: var(--ss-w-accent); background: linear-gradient(color-mix(in srgb, var(--ss-w-accent) 16%, transparent), color-mix(in srgb, var(--ss-w-accent) 16%, transparent)), var(--ss-w-bg); }
:where(.ss-w-map-btn:focus-visible, .ss-w-map-layer:focus-visible, .ss-w-map-node:focus-visible, .ss-w-map-stage:focus-visible) { outline: 2px solid var(--ss-w-accent); outline-offset: 2px; }
:where(.ss-w-map-layer.ss-w-active) { border-color: var(--ss-w-accent); background: linear-gradient(color-mix(in srgb, var(--ss-w-accent) 16%, transparent), color-mix(in srgb, var(--ss-w-accent) 16%, transparent)), var(--ss-w-bg); }
:where(.ss-w-map-body) { display: flex; flex-wrap: wrap; gap: var(--ss-w-gap); align-items: flex-start; }
:where(.ss-w-map-stage) { position: relative; flex: 1 1 18em; min-width: 0; aspect-ratio: var(--ss-w-map-aspect, 4 / 3); overflow: hidden; border: 1px solid var(--ss-w-border); border-radius: var(--ss-radius-xl, var(--ss-w-radius)); background: var(--ss-w-map-bg); -webkit-backdrop-filter: var(--ss-blur, none); backdrop-filter: var(--ss-blur, none); box-shadow: var(--ss-shadow, none); touch-action: none; user-select: none; cursor: grab; }
:where(.ss-w-map-stage.ss-w-dragging) { cursor: grabbing; }
:where(.ss-w-map-svg) { position: absolute; inset: 0; width: 100%; height: 100%; }
:where(.ss-w-map-edge) { stroke: var(--ss-w-map-route, var(--ss-w-muted)); stroke-width: 2; }
:where(.ss-w-map-edge.ss-w-unknown) { stroke-dasharray: 4 4; opacity: 0.6; }
:where(.ss-w-map-nodes) { position: absolute; inset: 0; pointer-events: none; }
:where(.ss-w-map-node) { position: absolute; left: calc(var(--ss-w-x, 50) * 1%); top: calc(var(--ss-w-y, 50) * 1%); transform: translate(-50%, -50%); display: flex; flex-direction: column; align-items: center; gap: 0.5em; padding: 0; border: 0; background: none; color: var(--ss-w-fg); pointer-events: auto; font-size: 0.85em; }
:where(.ss-w-map-node .ss-w-map-dot, .ss-w-map-node .ss-w-map-icon) { display: grid; place-items: center; width: 2.1em; height: 2.1em; border-radius: 50%; border: 2px solid var(--ss-w-border); background: var(--ss-w-bg); color: var(--ss-w-fg); box-shadow: var(--ss-shadow, none); }
:where(.ss-w-map-node.ss-w-selectable:hover .ss-w-map-dot, .ss-w-map-node.ss-w-selectable:hover .ss-w-map-icon, .ss-w-map-node.ss-w-selectable:active .ss-w-map-dot, .ss-w-map-node.ss-w-selectable:active .ss-w-map-icon) { border-color: var(--ss-w-accent); }
:where(.ss-w-map-node:focus-visible) { outline-offset: 4px; border-radius: 50%; }
:where(.ss-w-map-name) { max-width: 10em; padding: 2px 8px; border-radius: 6px; background: var(--ss-w-bg); background: rgb(from var(--ss-w-bg) r g b / 1); color: var(--ss-w-fg); font-size: 0.95em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
:where(.ss-w-map-node.ss-w-current .ss-w-map-dot, .ss-w-map-node.ss-w-current .ss-w-map-icon) { border-color: var(--ss-w-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ss-w-accent) 40%, transparent); }
:where(.ss-w-map-node.ss-w-unknown) { color: var(--ss-w-muted); }
:where(.ss-w-map-side) { display: flex; flex-direction: column; gap: var(--ss-w-gap); flex: 0 1 11em; min-width: 8em; }
:where(.ss-w-map-mini) { width: 100%; aspect-ratio: 4 / 3; border: 1px solid var(--ss-w-border); border-radius: var(--ss-radius-l, var(--ss-w-radius)); background: var(--ss-w-map-bg); cursor: pointer; }
:where(.ss-w-map-mini-edge) { stroke: var(--ss-w-muted); stroke-width: 1; }
:where(.ss-w-map-mini-node) { fill: var(--ss-w-fg); }
:where(.ss-w-map-mini-node.ss-w-current) { fill: var(--ss-w-accent); }
:where(.ss-w-map-viewport) { fill: color-mix(in srgb, var(--ss-w-accent) 15%, transparent); stroke: var(--ss-w-accent); stroke-width: 1.5; }
:where(.ss-w-map-legend-title) { margin: 0 0 4px; color: var(--ss-w-fg); font-size: 0.8em; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
:where(.ss-w-map-legend-list) { font-size: 0.9em; }
:where(.ss-w-map-legend-item) { min-width: 0; }
:where(.ss-w-map-legend-text) { min-width: 0; overflow-wrap: anywhere; }
:where(.ss-w-map-legend-sample) { display: inline-grid; place-items: center; flex: none; width: 1.6em; height: 1.6em; }
:where(.ss-w-map-edge-sample) { height: 0; border-top: 2px solid var(--ss-w-map-route, var(--ss-w-muted)); }
:where(.ss-w-map-here-sample) { border-radius: 50%; border: 2px solid var(--ss-w-accent); }

/* skill tree */
:where(.ss-w-skill-tree) { display: flex; flex-direction: column; }
:where(.ss-w-tree-title) { margin: 0 0 0.3em; font-size: 0.9em; color: var(--ss-w-muted); text-align: center; }
:where(.ss-w-tree-skills) { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(var(--ss-w-count, 1), minmax(0, 1fr)); gap: var(--ss-w-gap); }
:where(.ss-w-tree-cell) { display: flex; justify-content: center; min-width: 0; }
:where(.ss-w-tree-skill) { position: relative; display: flex; flex-direction: column; align-items: center; gap: 0.2em; width: 100%; max-width: 7em; padding: 0.4em 0.3em; border: 1px solid var(--ss-w-border); border-radius: var(--ss-w-radius); background: var(--ss-w-raised); text-align: center; }
:where(.ss-w-tree-skill[data-state="active"]) { border-color: var(--ss-w-accent); }
:where(.ss-w-tree-skill[data-state="locked"]) { opacity: 0.5; }
:where(.ss-w-tree-icon) { font-size: 1.4em; min-height: 1em; }
:where(.ss-w-tree-name) { font-size: 0.8em; overflow-wrap: anywhere; }
:where(.ss-w-tree-level) { position: absolute; top: -0.5em; right: -0.4em; min-width: 1.5em; padding: 0 0.3em; border-radius: 999px; background: var(--ss-w-accent); color: var(--ss-w-bg); font-size: 0.75em; font-variant-numeric: tabular-nums; }
:where(.ss-w-tree-check) { position: absolute; top: -0.5em; left: -0.4em; color: var(--ss-w-good); }
:where(.ss-w-tree-lock) { position: absolute; bottom: 0.1em; right: 0.2em; font-size: 0.7em; color: var(--ss-w-muted); }
:where(.ss-w-tree-links) { display: block; width: 100%; height: 1.4em; }
:where(.ss-w-tree-link) { stroke: var(--ss-w-border); stroke-width: 2; }
:where(.ss-w-tree-link[data-state="learned"]) { stroke: var(--ss-w-accent); }
:where(.ss-w-tree-link[data-state="locked"]) { stroke-dasharray: 3 3; }

/* portrait */
:where(.ss-w-portrait) { margin: 0; display: inline-flex; flex-direction: column; align-items: center; gap: 0.2em; --ss-w-portrait-size: 4em; }
:where(.ss-w-size-sm) { --ss-w-portrait-size: 2.5em; }
:where(.ss-w-size-lg) { --ss-w-portrait-size: 6em; }
:where(.ss-w-size-xl) { --ss-w-portrait-size: 9em; }
:where(.ss-w-portrait-frame) { position: relative; display: grid; place-items: center; width: var(--ss-w-portrait-size); height: var(--ss-w-portrait-size); overflow: hidden; border: 2px solid var(--ss-w-tone); background: var(--ss-w-raised); }
:where(.ss-w-portrait-img) { width: 100%; height: 100%; object-fit: cover; }
:where(.ss-w-portrait-initials) { font-weight: 600; font-size: calc(var(--ss-w-portrait-size) * 0.38); }
:where(.ss-w-frame-circle .ss-w-portrait-frame) { border-radius: 50%; }
:where(.ss-w-frame-rounded .ss-w-portrait-frame) { border-radius: 20%; }
:where(.ss-w-frame-hex .ss-w-portrait-frame) { border: 0; clip-path: polygon(25% 3%, 75% 3%, 100% 50%, 75% 97%, 25% 97%, 0 50%); }
:where(.ss-w-frame-diamond .ss-w-portrait-frame) { border: 0; clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%); }
:where(.ss-w-frame-none .ss-w-portrait-frame) { border: 0; background: none; }
:where(.ss-w-portrait-caption) { font-size: 0.85em; text-align: center; }

/* badge */
:where(.ss-w-badge) { position: relative; display: inline-flex; align-items: center; gap: 0.25em; padding: 0.15em 0.4em; border: 1px solid color-mix(in srgb, var(--ss-w-tone) 60%, transparent); border-radius: var(--ss-w-radius); background: color-mix(in srgb, var(--ss-w-tone) 15%, transparent); color: var(--ss-w-fg); font-size: 0.9em; line-height: 1.2; }
:where(.ss-w-badge-icon) { color: var(--ss-w-tone); }
:where(.ss-w-badge-count) { min-width: 1.3em; padding: 0 0.3em; border-radius: 999px; background: var(--ss-w-tone); color: var(--ss-w-bg); font-size: 0.8em; text-align: center; font-variant-numeric: tabular-nums; }

/* timeline */
:where(.ss-w-tl-list) { list-style: none; margin: 0; padding: 0 0 0 1.2em; border-left: 2px solid var(--ss-w-border); display: flex; flex-direction: column; gap: 0.6em; }
:where(.ss-w-tl-event) { position: relative; }
:where(.ss-w-tl-dot) { position: absolute; left: -1.75em; top: 0.15em; display: grid; place-items: center; width: 1em; height: 1em; border-radius: 50%; background: var(--ss-w-bg); border: 2px solid var(--ss-w-border); font-size: 0.9em; }
:where(.ss-w-tl-event.ss-w-current .ss-w-tl-dot) { border-color: var(--ss-w-accent); background: var(--ss-w-accent); }
:where(.ss-w-tl-event.ss-w-future) { opacity: 0.6; }
:where(.ss-w-tl-body) { display: flex; flex-direction: column; gap: 0.1em; min-width: 0; }
:where(.ss-w-tl-time) { font-size: 0.8em; color: var(--ss-w-muted); }
:where(.ss-w-tl-title) { font-weight: 600; }
:where(.ss-w-tl-text) { margin: 0; overflow-wrap: anywhere; }
:where(.ss-w-tl-now) { align-self: flex-start; padding: 0 0.4em; border-radius: 999px; background: var(--ss-w-accent); color: var(--ss-w-bg); font-size: 0.75em; }

/* stepper */
:where(.ss-w-stepper) { display: inline-flex; flex-direction: column; gap: 0.2em; }
:where(.ss-w-stepper-row) { display: inline-flex; align-items: stretch; }
:where(.ss-w-stepper-btn) { min-width: 2.2em; border: 1px solid var(--ss-w-border); background: var(--ss-w-raised); }
:where(.ss-w-stepper-dec) { border-radius: var(--ss-w-radius) 0 0 var(--ss-w-radius); }
:where(.ss-w-stepper-inc) { border-radius: 0 var(--ss-w-radius) var(--ss-w-radius) 0; }
:where(.ss-w-stepper-input) { width: 4em; min-width: 0; text-align: center; border: 1px solid var(--ss-w-border); border-left: 0; border-right: 0; background: var(--ss-w-bg); color: var(--ss-w-fg); font: inherit; font-variant-numeric: tabular-nums; -moz-appearance: textfield; }
:where(.ss-w-stepper-budget) { font-size: 0.8em; color: var(--ss-w-muted); }
:where(.ss-w-stepper.ss-w-spent .ss-w-stepper-budget) { color: var(--ss-w-warn); }
`;
