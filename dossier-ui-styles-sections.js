/* NPC State Delta dossier surface: scoped CSS for the header menu, the section screens (Right now, With {{user}},
   Ties, Past), the profile screen and the desktop pane layout. Colours and surfaces read the --delta-* tokens only,
   so a skin (dossier-ui-styles-board.js, set on [data-skin] of the panel root) and the Story Suite theme both reach
   this sheet. Desktop is one pane (library, board) or two (section beside dial + board; profile beside portrait).
   The one-column / two-pane switch is the panel's own width (dossier-ui-screens.js TWO_PANE_MIN, the @container dsr lines here). Class names are the contract
   with the section and profile renderers: see the report, section "Class contract". Secrets keep their existing
   rules in dossier-ui-styles.js. */

import { ROOT_ID } from './dossier-ui-constants.js';
import { TWO_PANE_MIN, THREE_PANE_MIN } from './dossier-ui-screens.js';

export const SECTIONS_STYLES = `
#${ROOT_ID} .delta-header-slot { display:inline-flex; align-items:center; }
#${ROOT_ID} .delta-top-actions > .delta-map-switch { order:1; }
#${ROOT_ID} .delta-top-actions > .delta-header-slot { order:2; }
#${ROOT_ID} .delta-top-actions > .delta-close { order:3; }
#${ROOT_ID} .delta-profile-portrait .delta-portrait-stale { top:52px; }
/* header menu: the ⋯ <details> opens a list over the panel; the Edit / Refresh / More buttons keep their own classes */
#${ROOT_ID} .delta-header-menu { position:relative; display:inline-block; }
#${ROOT_ID} .delta-header-menu > summary, #${ROOT_ID} .delta-dossier-more > summary { list-style:none; cursor:pointer; }
/* the dots glyph sits in the middle of its button, not at the top */
#${ROOT_ID} .delta-header-menu > summary.delta-btn { display:inline-flex; align-items:center; justify-content:center; min-width:35px; line-height:1; padding-top:0; padding-bottom:0; }
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
#${ROOT_ID} .delta-section-head { display:grid; grid-template-columns:40px minmax(0,1fr) 40px; align-items:center; gap:8px; padding:10px 12px; border-bottom:1px solid var(--delta-line); }
#${ROOT_ID} .delta-section-arrow { box-sizing:border-box; width:40px; height:40px; min-width:0 !important; min-height:0 !important; display:grid; place-items:center; padding:0; border:1px solid var(--delta-line); border-radius:10px; background:transparent; color:var(--delta-text); font-size:20px; line-height:1; cursor:pointer; }
#${ROOT_ID} .delta-section-arrow:disabled { opacity:.3; cursor:default; }
#${ROOT_ID} .delta-section-title { min-width:0; text-align:center; }
#${ROOT_ID} .delta-section-title b { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:clamp(14px,.4cqw + 12px,18px); color:var(--delta-accent-soft); }
#${ROOT_ID} .delta-section-title > span { display:block; font-size:var(--dt-pill); color:var(--delta-muted); }
#${ROOT_ID} .delta-section-dots { display:flex; justify-content:center; gap:4px; margin-top:3px; }
#${ROOT_ID} .delta-section-dot { width:6px; height:6px; min-height:0; padding:0; border:0; border-radius:3px; background:var(--delta-line); cursor:pointer; transition:width .18s ease, background-color .18s ease; }
#${ROOT_ID} .delta-section-dot.on { width:16px; background:var(--delta-accent); }
#${ROOT_ID} .delta-section-body { display:grid; gap:10px; min-width:0; padding:12px 14px 18px; }
#${ROOT_ID} .delta-sheet { display:grid; gap:10px; min-width:0; }
#${ROOT_ID} .delta-sheet h4 { margin:0; }
#${ROOT_ID} .delta-sheet-prose { margin:0; line-height:1.55; overflow-wrap:anywhere; }
#${ROOT_ID} .delta-kv { display:grid; grid-template-columns:82px minmax(0,1fr); gap:5px 12px; margin:0; }
#${ROOT_ID} .delta-kv dt { font-size:var(--dt-meta); color:var(--delta-muted); }
#${ROOT_ID} .delta-kv dd { min-width:0; margin:0; overflow-wrap:anywhere; }
#${ROOT_ID} .delta-kv dd > .delta-tile-bars { margin-top:6px; }

/* With {{user}}: the four meters grow from the centre; the recent changes follow the last-change card */
#${ROOT_ID} .delta-sheet-meters { display:grid; gap:6px; }
#${ROOT_ID} .delta-sheet-meter { display:grid; grid-template-columns:78px minmax(0,1fr) 38px; align-items:center; gap:8px; font-size:var(--dt-meta); }
#${ROOT_ID} .delta-sheet-meter > span { color:var(--delta-muted); }
#${ROOT_ID} .delta-sheet-meter > strong { text-align:right; font-variant-numeric:tabular-nums; }
#${ROOT_ID} .delta-sheet-track { position:relative; height:8px; border-radius:4px; background:var(--dial); }
#${ROOT_ID} .delta-sheet-track::before { content:""; position:absolute; left:50%; top:-1px; bottom:-1px; width:1px; background:var(--tick); }
#${ROOT_ID} .delta-sheet-track b { position:absolute; top:0; bottom:0; border-radius:4px; background:var(--delta-accent); }
#${ROOT_ID} .delta-sheet-trust .delta-sheet-track b { background:var(--trust, #8fb4d9); }
#${ROOT_ID} .delta-sheet-affection .delta-sheet-track b { background:var(--aff, #d99aaa); }
#${ROOT_ID} .delta-sheet-desire .delta-sheet-track b { background:var(--des, #b7a3cf); }
#${ROOT_ID} .delta-sheet-tension .delta-sheet-track b { background:var(--dsk-ten, #d9a273); }

/* pills (board): the key and mood kinds take the gold and warm tones */
#${ROOT_ID} .delta-pill-key { color:var(--delta-warn); }

/* Ties: one row per bond; the relation word takes the bond tone (data-tone) */
#${ROOT_ID} .delta-bond { --c:var(--delta-muted); display:grid; grid-template-columns:minmax(0,1fr) auto; gap:2px 10px; padding:8px 0; border-top:1px solid var(--delta-line); }
#${ROOT_ID} .delta-bond:first-child { border-top:0; padding-top:0; }
#${ROOT_ID} .delta-bond[data-tone="good"] { --c:var(--good, var(--delta-good)); }
#${ROOT_ID} .delta-bond[data-tone="bad"] { --c:var(--bad, var(--delta-danger)); }
#${ROOT_ID} .delta-bond[data-tone="gold"] { --c:var(--held, var(--delta-warn)); }
#${ROOT_ID} .delta-bond > b { min-width:0; overflow-wrap:anywhere; }
#${ROOT_ID} .delta-bond-word { grid-column:2; grid-row:1; font-size:var(--dt-meta); font-weight:700; color:var(--c); text-align:right; }
#${ROOT_ID} .delta-bond > p { grid-column:1 / -1; margin:0; font-size:var(--dt-body); color:var(--delta-muted); overflow-wrap:anywhere; }

/* Past: the memories, one per row */
#${ROOT_ID} .delta-past { display:grid; gap:8px; margin:0; padding:0; list-style:none; }
#${ROOT_ID} .delta-past li { padding-top:8px; border-top:1px solid var(--delta-line); overflow-wrap:anywhere; }
#${ROOT_ID} .delta-past li:first-child { border-top:0; padding-top:0; }

/* profile: portrait beside the sheet on desktop; the portrait fills the top on phone */
#${ROOT_ID} .delta-profile { --pk:clamp(62px,7.5cqw,92px); display:grid; gap:14px; min-height:0; padding:12px 14px 16px; align-items:start; }
#${ROOT_ID} .delta-profile-portrait { position:relative; overflow:hidden; aspect-ratio:4 / 5; max-height:72dvh; border-radius:14px; background:var(--delta-surface); }
#${ROOT_ID} .delta-profile-image { display:block; width:100%; height:100%; object-fit:cover; object-position:50% 10%; }
#${ROOT_ID} .delta-profile-back { position:absolute; z-index:2; top:10px; left:10px; min-height:40px; padding:4px 14px; border:1px solid var(--delta-line); border-radius:999px; background:color-mix(in srgb, var(--delta-floor) 80%, transparent); color:var(--delta-text); font-size:var(--dt-pill); font-weight:700; cursor:pointer; }
#${ROOT_ID} .delta-profile-caption { position:absolute; left:0; right:0; bottom:0; display:grid; gap:2px; padding:24px 12px 10px; background:linear-gradient(transparent, rgba(0,0,0,.6)); color:#fff; }
#${ROOT_ID} .delta-profile-caption b { font-size:clamp(16px,.6cqw + 12px,20px); }
#${ROOT_ID} .delta-profile-caption span { font-size:var(--dt-meta); opacity:.85; }
#${ROOT_ID} .delta-profile-sheet { display:grid; gap:12px; min-width:0; }
#${ROOT_ID} .delta-profile-head h2 { margin:0; font-size:clamp(17px,.8cqw + 11px,22px); color:var(--delta-accent-soft); }
#${ROOT_ID} .delta-profile-line { margin:2px 0 0; font-size:var(--dt-meta); color:var(--delta-muted); }
#${ROOT_ID} .delta-profile-cols { display:grid; gap:12px 22px; min-width:0; align-items:start; }
#${ROOT_ID} .delta-profile-kv { grid-template-columns:var(--pk) minmax(0,1fr); }
#${ROOT_ID} .delta-profile-forms { margin-top:6px; font-size:var(--dt-meta); }
#${ROOT_ID} .delta-profile-forms > summary { cursor:pointer; color:var(--delta-muted); }
#${ROOT_ID} .delta-profile-col { display:grid; gap:12px; min-width:0; align-content:start; }
#${ROOT_ID} .delta-profile-block { display:grid; gap:6px; min-width:0; padding-top:10px; border-top:1px solid var(--delta-line); }
#${ROOT_ID} .delta-profile-block h3 { margin:0; font-size:var(--dt-meta); letter-spacing:.08em; text-transform:uppercase; color:var(--delta-accent-soft); }
#${ROOT_ID} .delta-profile-block h4 { margin:4px 0 0; font-size:var(--dt-meta); color:var(--delta-muted); }
#${ROOT_ID} .delta-profile-block p { margin:0; overflow-wrap:anywhere; }

@container dsr (min-width: ${TWO_PANE_MIN}px) {
  #${ROOT_ID} .delta-panes[data-layout="desktop"][data-screen="section"] { grid-template-columns:minmax(0,1fr) clamp(300px,44%,420px); }
  #${ROOT_ID} .delta-panes[data-layout="desktop"][data-screen="section"] > [data-pane="section"] { border-left:1px solid var(--delta-line); }
  /* the portrait runs full-bleed to the pane edges (no inset, no rounding), the sheet takes the rest */
  #${ROOT_ID} .delta-profile { grid-template-columns:minmax(0,.8fr) minmax(0,1.2fr); gap:0; padding:0; align-items:stretch; }
  #${ROOT_ID} .delta-profile-portrait { border-radius:0; }
  /* the portrait stays whole beside a long sheet: the sheet scrolls inside its own column */
  #${ROOT_ID} .delta-panes[data-layout="desktop"][data-screen="profile"] .delta-profile { height:100%; overflow:hidden; }
  #${ROOT_ID} .delta-panes[data-layout="desktop"][data-screen="profile"] .delta-profile-sheet { min-height:0; max-height:100%; overflow:auto; overscroll-behavior:contain; }
  #${ROOT_ID} .delta-profile-sheet { align-content:start; padding:clamp(14px,2.2cqw,26px); }
  #${ROOT_ID} .delta-profile-cols { grid-template-columns:repeat(2,minmax(0,1fr)); }
  #${ROOT_ID} .delta-profile-portrait { position:sticky; top:0; max-height:none; height:100%; aspect-ratio:auto; }
}
@container dsr (max-width: ${TWO_PANE_MIN - 0.02}px) {
  #${ROOT_ID} .delta-brand { flex:1 1 auto; }
  #${ROOT_ID} .delta-brand strong { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:var(--dt-body); }
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
/* the dots keep their size where a host's touch rule gives every button a 44-50px minimum (it made them big squares in SillyTavern) */
#${ROOT_ID} .delta-section-dot { box-sizing:border-box; min-width:0 !important; min-height:0 !important; width:6px !important; height:6px !important; flex:none; }
#${ROOT_ID} .delta-section-dot.on { width:16px !important; }
#${ROOT_ID} .delta-sheet h4 { font-size:var(--dt-kick); letter-spacing:.12em; text-transform:uppercase; color:var(--c, var(--delta-accent-soft)); }
#${ROOT_ID} .delta-sheet-track { height:5px; border-radius:3px; }
#${ROOT_ID} .delta-sheet-track b { border-radius:3px; }
#${ROOT_ID} .delta-sheet-meter { grid-template-columns:clamp(62px,7cqw,92px) minmax(0,1fr) 38px; font-size:var(--dt-body); }
#${ROOT_ID} .delta-sheet-meter > span { color:var(--delta-text); }
#${ROOT_ID} .delta-secret-bar { height:12px; border-radius:3px; background:#0b0a0c; background-image:none; }
/* Ties: the relation word leads the name, the dynamic sits under */
#${ROOT_ID} .delta-bond { grid-template-columns:auto minmax(0,1fr); align-items:baseline; gap:2px 8px; }
#${ROOT_ID} .delta-bond-word { display:inline; grid-column:1; grid-row:1; padding:0; border:0; border-radius:0; text-align:left; font-size:var(--dt-kick); letter-spacing:.06em; text-transform:uppercase; }
#${ROOT_ID} .delta-bond > b { grid-column:2; grid-row:1; font-size:clamp(14px,.5cqw + 12px,17px); }
#${ROOT_ID} .delta-bond > p { color:var(--delta-text); }
@container dsr (max-width: ${TWO_PANE_MIN - 0.02}px) { #${ROOT_ID} .delta-section-screen::before { content:""; display:block; width:36px; height:4px; margin:8px auto 0; border-radius:2px; background:var(--dial); } }

/* Right now: the three bars run the full row; headings and the Pull badge as the mockup draws them */
#${ROOT_ID} .delta-now { gap:clamp(8px,1.1cqw,13px); }
#${ROOT_ID} .delta-now .delta-kv { grid-template-columns:clamp(60px,7cqw,92px) minmax(0,1fr); gap:clamp(5px,.7cqw,9px) clamp(10px,1.2cqw,16px); }
#${ROOT_ID} .delta-now .delta-kv dd b { font-weight:700; }
#${ROOT_ID} .delta-now-bars .delta-tile-bars { gap:clamp(6px,.8cqw,10px); }
#${ROOT_ID} .delta-now-bars .delta-tile-bar { grid-template-columns:clamp(54px,7cqw,84px) minmax(0,1fr); font-size:var(--dt-meta); }
#${ROOT_ID} .delta-now-bars .delta-tile-bar i { height:clamp(5px,.5cqw,7px); }
#${ROOT_ID} .delta-now-moved { margin:0; font-size:var(--dt-body); }
#${ROOT_ID} .delta-panel .delta-section-body p.delta-secrets-intro.delta-muted { margin:0 0 8px; font-size:var(--dt-meta); line-height:1.5; }
#${ROOT_ID} .delta-now-updated { margin:0; font-size:var(--dt-meta); }
#${ROOT_ID} .delta-new-badge { display:inline-block; padding:0 .45em; border-radius:4px; font-size:var(--dt-kick); font-weight:700; letter-spacing:.04em; text-transform:uppercase; color:var(--good, var(--delta-good)); background:color-mix(in srgb, var(--good, var(--delta-good)) 18%, transparent); }

/* With {{user}}: the Recent changes list, a date and reply column, the coloured change and its "via" line */
#${ROOT_ID} .delta-sheet-recent .delta-list { margin:0; padding:0; list-style:none; display:grid; gap:0; }
#${ROOT_ID} .delta-chg { display:grid; grid-template-columns:clamp(66px,9cqw,104px) minmax(0,1fr); gap:clamp(8px,1.2cqw,16px); padding:clamp(8px,1cqw,12px) 0; border-top:1px solid var(--delta-line); }
#${ROOT_ID} .delta-chg:first-child { border-top:1px solid var(--delta-line); }
#${ROOT_ID} .delta-chg-when { font-size:var(--dt-meta); color:var(--delta-muted); }
#${ROOT_ID} .delta-chg-when small { font-size:var(--dt-kick); }
#${ROOT_ID} .delta-chg > div { min-width:0; display:grid; gap:2px; align-content:start; overflow-wrap:anywhere; }
#${ROOT_ID} .delta-chg-d[data-good="yes"] { color:var(--good, var(--delta-good)); }
#${ROOT_ID} .delta-chg-d[data-good="no"] { color:var(--bad, var(--delta-danger)); }
#${ROOT_ID} .delta-chg-d[data-good="muted"] { color:var(--delta-text); }
#${ROOT_ID} .delta-chg-via { font-size:var(--dt-meta); color:var(--delta-muted); }

/* profile as the mockup draws it: flat label/value rows, small coloured headings */
#${ROOT_ID} .delta-profile-block { border-top:0; padding-top:0; }
#${ROOT_ID} .delta-profile-block h3 { font-size:var(--dt-kick); letter-spacing:.12em; color:var(--trust, var(--delta-accent-soft)); }
#${ROOT_ID} .delta-profile .delta-current-grid { grid-template-columns:minmax(0,1fr); gap:5px; }
#${ROOT_ID} .delta-profile .delta-current-card { display:grid; grid-template-columns:var(--pk) minmax(0,1fr); gap:5px 12px; padding:0; border:0; background:none; }
#${ROOT_ID} .delta-profile .delta-current-card b { margin:0; font-size:var(--dt-meta); font-weight:400; letter-spacing:0; text-transform:none; }
#${ROOT_ID} .delta-profile-head { display:flex; flex-wrap:wrap; align-items:baseline; gap:2px 8px; }
#${ROOT_ID} .delta-profile-head .delta-profile-title { margin:0; padding:0; border:0; text-align:inherit; text-transform:none; letter-spacing:0; font-size:clamp(22px,2.4cqw + 14px,32px); line-height:1.05; }
#${ROOT_ID} .delta-profile-line { margin:0; }
#${ROOT_ID} .delta-profile-desktop .delta-profile-head .delta-profile-title { font-size:clamp(17px,.8cqw + 11px,22px); }

/* the Fantasy look frames the profile portrait; Neutral and Modern keep it plain */
#${ROOT_ID}[data-skin="fantasy"] .delta-profile-portrait { border-radius:4px; box-shadow:0 0 0 1px var(--delta-line), 0 0 0 4px var(--delta-floor), 0 0 0 5px var(--delta-line); }

/* phase 2: lies told / knows about others, the Past timeline, tastes, drives, the look lock, the gate wording */
#${ROOT_ID} .delta-notes-block h4 { margin:10px 0 2px; font-size:var(--dt-kick); letter-spacing:.12em; text-transform:uppercase; color:var(--held, var(--delta-warn)); }
#${ROOT_ID} .delta-notes-block[data-notes="knows"] h4 { color:var(--trust, var(--delta-accent-soft)); }
#${ROOT_ID} .delta-note-row { display:grid; gap:2px; margin:6px 0; }
#${ROOT_ID} .delta-note-row > span { font-size:var(--dt-meta); color:var(--delta-muted); }
#${ROOT_ID} .delta-timeline { position:relative; }
#${ROOT_ID} .delta-timeline li, #${ROOT_ID} .delta-timeline li:first-child { position:relative; padding:0 0 4px 22px; border-top:0; }
#${ROOT_ID} .delta-timeline li > i { position:absolute; left:0; top:.45em; }
#${ROOT_ID} .delta-timeline::before { content:""; position:absolute; left:4px; top:8px; bottom:8px; width:1px; background:var(--delta-line); }
#${ROOT_ID} .delta-tastes { display:grid; gap:6px; margin:0; padding:0; list-style:none; }
#${ROOT_ID} .delta-tastes li { display:grid; grid-template-columns:22px minmax(0,1fr); column-gap:6px; }
#${ROOT_ID} .delta-tastes li > .delta-muted { grid-column:2; font-size:var(--dt-meta); }
#${ROOT_ID} .delta-taste-sign { color:var(--trust, var(--delta-accent-soft)); }
#${ROOT_ID} .delta-drive { display:grid; grid-template-columns:clamp(70px,8cqw,104px) minmax(0,1fr); align-items:center; gap:8px; font-size:var(--dt-meta); color:var(--delta-muted); }
#${ROOT_ID} .delta-drive i { height:5px; border-radius:3px; background:var(--dial); overflow:hidden; }
#${ROOT_ID} .delta-drive b { display:block; height:100%; background:var(--trust, var(--delta-accent)); }
#${ROOT_ID} .delta-rel-gate { margin:0; color:var(--delta-danger); font-size:var(--dt-meta); }
#${ROOT_ID} .delta-profile .delta-continuity-source { display:block; margin-top:2px; font-size:var(--dt-kick); color:var(--delta-muted); }

/* profile alignment: one label column (--pk) for every block, headings flush with their rows (no host indent), dt and dd on one baseline */
#${ROOT_ID} .delta-profile-block h3 { margin:0; padding:0; text-indent:0; text-align:left; }
#${ROOT_ID} .delta-profile-block > :is(p, dl, ul, div) { margin:0; padding:0; text-indent:0; text-align:left; }
#${ROOT_ID} .delta-profile .delta-kv { gap:5px 12px; align-items:baseline; }
#${ROOT_ID} .delta-profile .delta-kv dt, #${ROOT_ID} .delta-profile .delta-current-card b { min-width:0; margin:0; padding:0; overflow-wrap:anywhere; line-height:1.45; }
#${ROOT_ID} .delta-profile .delta-kv dd, #${ROOT_ID} .delta-profile .delta-current-card span { margin:0; padding:0; line-height:1.45; }
#${ROOT_ID} .delta-profile .delta-current-card { align-items:baseline; }

/* no portrait: the initials fill the pane as the picture would, in the suite font, centred; the Back pill floats over the corner, never over them */
#${ROOT_ID} .delta-profile-image.delta-portrait-placeholder { display:grid; place-items:center; width:100%; height:100%; min-height:0; overflow:hidden; background:radial-gradient(circle at 50% 38%, color-mix(in srgb, var(--delta-accent) 20%, transparent), color-mix(in srgb, var(--delta-floor) 70%, #000)); color:var(--delta-muted); font-family:var(--ss-font, system-ui, -apple-system, "Segoe UI", sans-serif); font-weight:700; font-size:clamp(64px,min(22cqw, 24dvh),180px); line-height:1; letter-spacing:.04em; padding:56px 8px 72px; }
#${ROOT_ID} .delta-profile-image.delta-portrait-placeholder > span { display:block; max-width:100%; text-align:center; }
@container dsr (max-width: ${TWO_PANE_MIN - 0.02}px) { #${ROOT_ID} .delta-profile-image.delta-portrait-placeholder { font-size:clamp(64px,min(34cqw, 24dvh),180px); } }

/* the four meters under the name: whole items that wrap, the dot after each but the last */
#${ROOT_ID} .delta-profile-meters { display:flex; flex-wrap:wrap; gap:0 .5em; }
#${ROOT_ID} .delta-profile-meters > i { font-style:normal; white-space:nowrap; }
#${ROOT_ID} .delta-profile-meters > i:not(:last-child)::after { content:" ·"; }

/* ‹ Dossier: the way back from a section (and the profile) to the board; on a section it is hidden only where the board's tiles are beside it */
/* (THREE_PANE_MIN, see dossier-ui-styles-board.js); from TWO_PANE_MIN the tiles are hidden, so the pill stays. Decided by the container, never device width */
#${ROOT_ID} .delta-section-back { justify-self:start; display:inline-flex; align-items:center; min-height:40px; margin:10px 12px 0; padding:4px 14px; border:1px solid var(--delta-line); border-radius:999px; background:transparent; color:var(--delta-text); font-size:var(--dt-pill); font-weight:700; cursor:pointer; }
#${ROOT_ID} .delta-section-back:hover { background:color-mix(in srgb, var(--delta-accent) 12%, transparent); }
#${ROOT_ID} .delta-section-head { margin-top:2px; }
@container dsr (min-width: ${THREE_PANE_MIN}px) { #${ROOT_ID} .delta-section-back { display:none; } }
`;
