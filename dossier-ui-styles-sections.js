/* NPC State Delta dossier surface: scoped CSS for the header menu, the section screens (Right now, With {{user}},
   Ties, Past), the profile screen and the desktop pane layout. Colours and surfaces read the --delta-* tokens only,
   so a skin (dossier-ui-styles-board.js, set on [data-skin] of the panel root) and the Story Suite theme both reach
   this sheet. Desktop is one pane (library, board) or two (section beside dial + board; profile beside portrait).
   The phone breakpoint is the shared 650px query (dossier-ui-screens.js PHONE_QUERY). Class names are the contract
   with the section and profile renderers: see the report, section "Class contract". Secrets keep their existing
   rules in dossier-ui-styles.js. */

import { ROOT_ID } from './dossier-ui-constants.js';

export const SECTIONS_STYLES = `
#${ROOT_ID} .delta-header-slot { display:inline-flex; align-items:center; }
#${ROOT_ID} .delta-top-actions > .delta-map-switch { order:1; }
#${ROOT_ID} .delta-top-actions > .delta-header-slot { order:2; }
#${ROOT_ID} .delta-top-actions > .delta-close { order:3; }
#${ROOT_ID} .delta-profile-portrait .delta-portrait-stale { top:52px; }
/* header menu: the ⋯ <details> opens a list over the panel; the Edit / Refresh / More buttons keep their own classes */
#${ROOT_ID} .delta-header-menu { position:relative; display:inline-block; }
#${ROOT_ID} .delta-header-menu > summary, #${ROOT_ID} .delta-dossier-more > summary { list-style:none; cursor:pointer; }
#${ROOT_ID} .delta-header-menu > summary::-webkit-details-marker, #${ROOT_ID} .delta-dossier-more > summary::-webkit-details-marker { display:none; }
#${ROOT_ID} .delta-header-menu-list { position:absolute; right:0; top:calc(100% + 6px); z-index:4; display:grid; gap:4px; min-width:200px; padding:6px; border:1px solid var(--delta-line); border-radius:12px; background:var(--delta-floor); box-shadow:0 10px 30px rgba(0,0,0,.45); }
#${ROOT_ID} .delta-header-menu-list > .delta-btn, #${ROOT_ID} .delta-dossier-more-menu > .delta-btn { width:100%; min-height:38px; justify-content:flex-start; text-align:left; }
#${ROOT_ID} .delta-dossier-more { display:grid; gap:4px; }
#${ROOT_ID} .delta-dossier-more-menu { display:grid; gap:4px; padding-left:8px; }

/* pane layout: one column unless the screen shows two panes side by side */
#${ROOT_ID} .delta-panes { display:grid; grid-template-columns:minmax(0,1fr); align-content:start; gap:0; min-height:0; height:100%; }
#${ROOT_ID} .delta-panes > [data-pane] { min-width:0; min-height:0; }
#${ROOT_ID} .delta-pane-body { min-height:0; overflow:auto; overscroll-behavior:contain; touch-action:pan-y; }

/* section screen: the title bar with arrows, "N of 5" and the dots (the sections.js classes) */
#${ROOT_ID} .delta-section-screen { display:grid; align-content:start; min-width:0; }
#${ROOT_ID} .delta-section-head { display:grid; grid-template-columns:34px minmax(0,1fr) 34px; align-items:center; gap:8px; padding:10px 12px; border-bottom:1px solid var(--delta-line); }
#${ROOT_ID} .delta-section-arrow { width:34px; height:34px; min-height:34px; display:grid; place-items:center; padding:0; border:1px solid var(--delta-line); border-radius:10px; background:transparent; color:var(--delta-text); font-size:20px; line-height:1; cursor:pointer; }
#${ROOT_ID} .delta-section-arrow:disabled { opacity:.3; cursor:default; }
#${ROOT_ID} .delta-section-title { min-width:0; text-align:center; }
#${ROOT_ID} .delta-section-title b { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:15px; color:var(--delta-accent-soft); }
#${ROOT_ID} .delta-section-title > span { display:block; font-size:11px; color:var(--delta-muted); }
#${ROOT_ID} .delta-section-dots { display:flex; justify-content:center; gap:4px; margin-top:3px; }
#${ROOT_ID} .delta-section-dot { width:6px; height:6px; min-height:0; padding:0; border:0; border-radius:3px; background:var(--delta-line); cursor:pointer; transition:width .18s ease, background-color .18s ease; }
#${ROOT_ID} .delta-section-dot.on { width:16px; background:var(--delta-accent); }
#${ROOT_ID} .delta-section-body { display:grid; gap:10px; min-width:0; padding:12px 14px 18px; }
#${ROOT_ID} .delta-sheet { display:grid; gap:10px; min-width:0; }
#${ROOT_ID} .delta-sheet h4 { margin:0; }
#${ROOT_ID} .delta-sheet-prose { margin:0; line-height:1.55; overflow-wrap:anywhere; }
#${ROOT_ID} .delta-kv { display:grid; grid-template-columns:82px minmax(0,1fr); gap:5px 12px; margin:0; }
#${ROOT_ID} .delta-kv dt { font-size:11.5px; color:var(--delta-muted); }
#${ROOT_ID} .delta-kv dd { min-width:0; margin:0; overflow-wrap:anywhere; }

/* With {{user}}: the four meters grow from the centre; the recent changes follow the last-change card */
#${ROOT_ID} .delta-sheet-meters { display:grid; gap:6px; }
#${ROOT_ID} .delta-sheet-meter { display:grid; grid-template-columns:78px minmax(0,1fr) 38px; align-items:center; gap:8px; font-size:12px; }
#${ROOT_ID} .delta-sheet-meter > span { color:var(--delta-muted); }
#${ROOT_ID} .delta-sheet-meter > strong { text-align:right; font-variant-numeric:tabular-nums; }
#${ROOT_ID} .delta-sheet-track { position:relative; height:8px; border-radius:4px; background:var(--dial); }
#${ROOT_ID} .delta-sheet-track::before { content:""; position:absolute; left:50%; top:-1px; bottom:-1px; width:1px; background:var(--tick); }
#${ROOT_ID} .delta-sheet-track b { position:absolute; top:0; bottom:0; border-radius:4px; background:var(--delta-accent); }
#${ROOT_ID} .delta-sheet-trust .delta-sheet-track b { background:#8fb4d9; }
#${ROOT_ID} .delta-sheet-affection .delta-sheet-track b { background:#d99aaa; }
#${ROOT_ID} .delta-sheet-desire .delta-sheet-track b { background:#b7a3cf; }
#${ROOT_ID} .delta-sheet-tension .delta-sheet-track b { background:var(--dsk-ten, #d9a273); }
#${ROOT_ID} .delta-sheet-recent .delta-list { margin:4px 0 0; padding:0; list-style:none; display:grid; gap:6px; }
#${ROOT_ID} .delta-sheet-recent li { display:flex; flex-wrap:wrap; gap:4px 8px; padding-top:6px; border-top:1px solid var(--delta-line); font-size:12.5px; overflow-wrap:anywhere; }
#${ROOT_ID} .delta-sheet-when { font-size:11px; color:var(--delta-muted); }
#${ROOT_ID} .delta-sheet-impact { font-size:10.5px; font-weight:700; text-transform:uppercase; color:var(--delta-accent); }

/* pills (board): the key and mood kinds take the gold and warm tones */
#${ROOT_ID} .delta-pill-key { color:var(--delta-warn); }

/* Ties: one row per bond; the relation word takes the bond tone (data-tone) */
#${ROOT_ID} .delta-bond { --c:var(--delta-muted); display:grid; grid-template-columns:minmax(0,1fr) auto; gap:2px 10px; padding:8px 0; border-top:1px solid var(--delta-line); }
#${ROOT_ID} .delta-bond:first-child { border-top:0; padding-top:0; }
#${ROOT_ID} .delta-bond[data-tone="good"] { --c:var(--good, var(--delta-good)); }
#${ROOT_ID} .delta-bond[data-tone="bad"] { --c:var(--bad, var(--delta-danger)); }
#${ROOT_ID} .delta-bond[data-tone="gold"] { --c:var(--held, var(--delta-warn)); }
#${ROOT_ID} .delta-bond > b { min-width:0; overflow-wrap:anywhere; }
#${ROOT_ID} .delta-bond-word { grid-column:2; grid-row:1; font-size:12px; font-weight:700; color:var(--c); text-align:right; }
#${ROOT_ID} .delta-bond > p { grid-column:1 / -1; margin:0; font-size:12.5px; color:var(--delta-muted); overflow-wrap:anywhere; }

/* Past: the memories, one per row */
#${ROOT_ID} .delta-past { display:grid; gap:8px; margin:0; padding:0; list-style:none; }
#${ROOT_ID} .delta-past li { padding-top:8px; border-top:1px solid var(--delta-line); overflow-wrap:anywhere; }
#${ROOT_ID} .delta-past li:first-child { border-top:0; padding-top:0; }

/* profile: portrait beside the sheet on desktop; the portrait fills the top on phone */
#${ROOT_ID} .delta-profile { display:grid; gap:14px; min-height:0; padding:12px 14px 16px; align-items:start; }
#${ROOT_ID} .delta-profile-portrait { position:relative; overflow:hidden; aspect-ratio:4 / 5; max-height:72dvh; border-radius:14px; background:var(--delta-surface); }
#${ROOT_ID} .delta-profile-image { display:block; width:100%; height:100%; object-fit:cover; object-position:50% 10%; }
#${ROOT_ID} .delta-profile-back { position:absolute; top:10px; left:10px; min-height:34px; padding:4px 10px; border:1px solid var(--delta-line); border-radius:999px; background:color-mix(in srgb, var(--delta-floor) 80%, transparent); color:var(--delta-text); font-size:12px; font-weight:700; cursor:pointer; }
#${ROOT_ID} .delta-profile-caption { position:absolute; left:0; right:0; bottom:0; display:grid; gap:2px; padding:24px 12px 10px; background:linear-gradient(transparent, rgba(0,0,0,.6)); color:#fff; }
#${ROOT_ID} .delta-profile-caption b { font-size:17px; }
#${ROOT_ID} .delta-profile-caption span { font-size:12px; opacity:.85; }
#${ROOT_ID} .delta-profile-sheet { display:grid; gap:12px; min-width:0; }
#${ROOT_ID} .delta-profile-head h2 { margin:0; font-size:20px; color:var(--delta-accent-soft); }
#${ROOT_ID} .delta-profile-line { margin:2px 0 0; font-size:12.5px; color:var(--delta-muted); }
#${ROOT_ID} .delta-profile-cols { display:grid; gap:12px 22px; min-width:0; }
#${ROOT_ID} .delta-profile-col { display:grid; gap:12px; min-width:0; align-content:start; }
#${ROOT_ID} .delta-profile-block { display:grid; gap:6px; min-width:0; padding-top:10px; border-top:1px solid var(--delta-line); }
#${ROOT_ID} .delta-profile-block h3 { margin:0; font-size:12px; letter-spacing:.08em; text-transform:uppercase; color:var(--delta-accent-soft); }
#${ROOT_ID} .delta-profile-block h4 { margin:4px 0 0; font-size:12px; color:var(--delta-muted); }
#${ROOT_ID} .delta-profile-block p { margin:0; overflow-wrap:anywhere; }

@media (min-width: 651px) {
  #${ROOT_ID} .delta-panes[data-layout="desktop"][data-screen="section"] { grid-template-columns:minmax(0,1fr) 380px; }
  #${ROOT_ID} .delta-panes[data-layout="desktop"][data-screen="section"] > [data-pane="section"] { border-left:1px solid var(--delta-line); }
  #${ROOT_ID} .delta-profile { grid-template-columns:minmax(0,.8fr) minmax(0,1.2fr); }
  #${ROOT_ID} .delta-profile-cols { grid-template-columns:repeat(2,minmax(0,1fr)); }
  #${ROOT_ID} .delta-profile-portrait { position:sticky; top:0; max-height:none; height:100%; aspect-ratio:auto; }
}
@media (max-width: 650px) {
  #${ROOT_ID} .delta-brand { flex:1 1 auto; }
  #${ROOT_ID} .delta-brand strong { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; }
  #${ROOT_ID} .delta-top-actions { flex:0 0 auto; gap:6px; }
  #${ROOT_ID} .delta-top-actions .delta-btn { padding-left:10px; padding-right:10px; }
  #${ROOT_ID} .delta-header-menu-list { position:fixed; top:58px; right:8px; max-width:calc(100vw - 16px); }
  #${ROOT_ID} .delta-profile { grid-template-columns:minmax(0,1fr); gap:10px; padding:0 0 16px; }
  #${ROOT_ID} .delta-profile-portrait { aspect-ratio:auto; height:min(56dvh, 420px); border-radius:0; }
  #${ROOT_ID} .delta-profile-sheet { padding:0 14px; }
  #${ROOT_ID} .delta-profile-cols { grid-template-columns:minmax(0,1fr); }
}
@media (prefers-reduced-motion: reduce) {
  #${ROOT_ID} .delta-section-dot { transition:none; }
}

/* each section has its own accent, shared by its title, dots and small headings */
#${ROOT_ID} .delta-section-screen { --c:var(--delta-accent); }
#${ROOT_ID} .delta-section-screen[data-delta-section="now"] { --c:var(--dsk-ten, #d9a273); }
#${ROOT_ID} .delta-section-screen[data-delta-section="with"] { --c:var(--bad); }
#${ROOT_ID} .delta-section-screen[data-delta-section="ties"] { --c:var(--aff, #d99aaa); }
#${ROOT_ID} .delta-section-screen[data-delta-section="past"] { --c:var(--des, #b7a3cf); }
#${ROOT_ID} .delta-section-screen[data-delta-section="secrets"] { --c:var(--held); }
#${ROOT_ID} .delta-section-title b { color:var(--c); }
#${ROOT_ID} .delta-section-dot.on { background:var(--c); }
#${ROOT_ID} .delta-sheet h4 { font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:var(--c, var(--delta-accent-soft)); }
#${ROOT_ID} .delta-sheet-track { height:5px; border-radius:3px; }
#${ROOT_ID} .delta-sheet-track b { border-radius:3px; }
#${ROOT_ID} .delta-sheet-meter { grid-template-columns:70px minmax(0,1fr) 34px; font-size:13px; }
#${ROOT_ID} .delta-sheet-meter > span { color:var(--delta-text); }
#${ROOT_ID} .delta-sheet-recent li { display:grid; grid-template-columns:78px minmax(0,1fr); gap:2px 10px; }
#${ROOT_ID} .delta-sheet-recent li > .delta-sheet-impact { grid-column:2; grid-row:1; color:var(--c); }
#${ROOT_ID} .delta-sheet-recent li > .delta-sheet-when { grid-column:1; grid-row:1 / span 2; }
#${ROOT_ID} .delta-sheet-recent li > span:last-child { grid-column:2; color:var(--delta-muted); }
#${ROOT_ID} .delta-secret-bar { height:12px; border-radius:3px; background:#0b0a0c; background-image:none; }
/* Ties: the relation word leads the name, the dynamic sits under */
#${ROOT_ID} .delta-bond { grid-template-columns:auto minmax(0,1fr); align-items:baseline; gap:2px 8px; }
#${ROOT_ID} .delta-bond-word { grid-column:1; grid-row:1; text-align:left; font-size:11px; letter-spacing:.06em; text-transform:uppercase; }
#${ROOT_ID} .delta-bond > b { grid-column:2; grid-row:1; font-size:15px; }
#${ROOT_ID} .delta-bond > p { color:var(--delta-text); }
@media (max-width: 650px) { #${ROOT_ID} .delta-section-screen::before { content:""; display:block; width:36px; height:4px; margin:8px auto 0; border-radius:2px; background:var(--dial); } }

/* profile as the mockup draws it: flat label/value rows, small coloured headings */
#${ROOT_ID} .delta-profile-block { border-top:0; padding-top:0; }
#${ROOT_ID} .delta-profile-block h3 { font-size:11px; letter-spacing:.12em; color:var(--trust, var(--delta-accent-soft)); }
#${ROOT_ID} .delta-profile .delta-current-grid { grid-template-columns:minmax(0,1fr); gap:5px; }
#${ROOT_ID} .delta-profile .delta-current-card { display:grid; grid-template-columns:82px minmax(0,1fr); gap:12px; padding:0; border:0; background:none; }
#${ROOT_ID} .delta-profile .delta-current-card b { margin:0; font-size:11.5px; font-weight:400; letter-spacing:0; text-transform:none; }
#${ROOT_ID} .delta-profile-head { display:flex; flex-wrap:wrap; align-items:baseline; gap:2px 8px; }
#${ROOT_ID} .delta-profile-head h2 { font-size:30px; line-height:1.05; }
#${ROOT_ID} .delta-profile-line { margin:0; }
#${ROOT_ID} .delta-profile-desktop .delta-profile-head h2 { font-size:18px; }

/* the Fantasy look frames the profile portrait; Neutral and Modern keep it plain */
#${ROOT_ID}[data-skin="fantasy"] .delta-profile-portrait { border-radius:4px; box-shadow:0 0 0 1px var(--delta-line), 0 0 0 4px var(--delta-floor), 0 0 0 5px var(--delta-line); }
`;
