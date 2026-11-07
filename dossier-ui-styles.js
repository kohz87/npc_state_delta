/* NPC State Delta dossier surface: the panel's scoped stylesheet. */
import { ROOT_ID, SETTINGS_ID } from './dossier-ui-constants.js';

export const STYLES = `
#${ROOT_ID} {
  /* UI 4c: the panel takes Story Block's glass tokens inside its .ss-cards root (the panel carries that class); outside
     Story Block, or in Solid and Follow SillyTavern where a token is unset, each keeps Delta's own value (the fallback). */
  --delta-bg: var(--ss-sheet-bg, var(--SmartThemeBlurTintColor, #18191d));
  /* the same tint with its alpha dropped: the opaque floor under the panel and the section bar (the chat must not read through them) */
  --delta-floor: var(--ss-sheet-floor, #18191d);
  --delta-text: var(--ss-text, var(--SmartThemeBodyColor, #f0eee9));
  --delta-muted: var(--ss-text, color-mix(in srgb, var(--delta-text) 66%, transparent));
  --delta-surface: var(--ss-glass, rgba(255,255,255,.055));
  --delta-surface-strong: var(--ss-glass-strong, rgba(255,255,255,.085));
  --delta-line: var(--ss-border, rgba(218,193,148,.24));
  --delta-line-strong: rgba(218,193,148,.52);
  --delta-accent: var(--ss-accent, #d8bc78);
  --delta-accent-soft: var(--ss-text, #f0ddb0);
  --delta-good: #9ed5b6;
  --delta-warn: #e9c98d;
  --delta-danger: #efaaaa;
  position: relative;
  z-index: 10000;
  color: var(--delta-text);
  font: 400 14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
}
#${ROOT_ID} *, #${ROOT_ID} *::before, #${ROOT_ID} *::after { box-sizing: border-box; text-shadow: none; }
#${ROOT_ID} [hidden] { display: none !important; }
#${ROOT_ID} button, #${ROOT_ID} input { font: inherit; }
#${ROOT_ID} button { color: inherit; }
#${ROOT_ID} :is(button,input):focus-visible { outline: 2px solid var(--delta-accent); outline-offset: 2px; }
#${ROOT_ID} .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
#${ROOT_ID} .delta-launcher {
  position: fixed; right: 18px; bottom: 74px; z-index: 2147483000;
  display: inline-flex; align-items: center; gap: 8px; min-height: 42px; padding: 8px 13px 8px 9px;
  border: 1px solid rgba(138,163,200,.78); border-radius: 12px; color: #eef5ff;
  background: #263a55; box-shadow: 0 5px 20px rgba(0,0,0,.38); cursor: pointer;
}
#${ROOT_ID} .delta-launcher:hover { background: #304866; }
#${ROOT_ID} .delta-panel:focus { outline: none; }
#${ROOT_ID} .delta-launcher-mark { display:grid; place-items:center; width:25px; height:25px; border-radius:8px; border:1px solid #a9bdd9; font:700 13px/1 Georgia,serif; }
#${ROOT_ID} .delta-panel {
  position: fixed; z-index: 2147483500; left:50%; top:50%; transform:translate(-50%,-50%);
  width:min(1320px,97vw); height:min(940px,96dvh); overflow:hidden;
  display:flex; flex-direction:column; border:1px solid var(--delta-line); border-radius:var(--ss-radius-xl, 15px);
  color:var(--delta-text); background-color:var(--delta-floor); background-image:linear-gradient(var(--delta-bg),var(--delta-bg)); backdrop-filter:var(--ss-blur, none); -webkit-backdrop-filter:var(--ss-blur, none);
  box-shadow:0 0 0 100vmax rgba(0,0,0,.72),0 20px 70px rgba(0,0,0,.55);
}
#${ROOT_ID} .delta-topbar { flex:0 0 auto; min-height:56px; display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 12px 8px 16px; border-bottom:1px solid var(--delta-line); background:color-mix(in srgb,var(--delta-bg) 94%,black 6%); }
#${ROOT_ID} .delta-brand, #${ROOT_ID} .delta-top-actions { display:flex; align-items:center; gap:10px; min-width:0; }
#${ROOT_ID} .delta-brand strong { font-size:1.03rem; white-space:nowrap; }
#${ROOT_ID} .delta-kicker { font-size:.67rem; line-height:1.2; letter-spacing:.14em; text-transform:uppercase; color:var(--delta-accent); opacity:.82; }
#${ROOT_ID} .delta-chat-state { display:inline-flex; padding:4px 9px; border:1px solid rgba(255,255,255,.1); border-radius:999px; color:var(--delta-muted); background:rgba(0,0,0,.16); font-size:.74rem; }
#${ROOT_ID} .delta-btn, #${ROOT_ID} .delta-filter {
  appearance:none; min-height:35px; padding:6px 11px; border:1px solid var(--delta-line); border-radius:8px;
  color:var(--delta-text); background:rgba(255,255,255,.055); box-shadow:none; cursor:pointer;
}
#${ROOT_ID} .delta-btn:hover, #${ROOT_ID} .delta-filter:hover { background:rgba(216,188,120,.12); border-color:var(--delta-line-strong); }
#${ROOT_ID} .delta-primary { color:#201a0f; background:var(--delta-accent); border-color:var(--delta-accent); font-weight:700; }
#${ROOT_ID} .delta-primary:hover { color:#151109; background:var(--delta-accent-soft); border-color:var(--delta-accent-soft); }
#${ROOT_ID} .delta-notice { flex:0 0 auto; padding:8px 14px; border-bottom:1px solid var(--delta-line); background:rgba(115,86,35,.26); }
#${ROOT_ID} .delta-panel-body { flex:1 1 auto; min-height:0; overflow:hidden; }
#${ROOT_ID} .delta-library { height:100%; min-height:0; display:grid; grid-template-rows:minmax(0,1fr) 158px; overflow:hidden; }
#${ROOT_ID} .delta-stage, #${ROOT_ID} .delta-spread { min-height:0; overflow:hidden; }
#${ROOT_ID} .delta-spread { height:100%; display:grid; grid-template-columns:minmax(310px,36%) minmax(0,1fr); }
#${ROOT_ID} .delta-hero { min-width:0; min-height:0; display:grid; grid-template-rows:minmax(0,1fr) auto; overflow:hidden; border-right:1px solid rgba(218,193,148,.16); background:rgba(0,0,0,.24); }
#${ROOT_ID} .delta-hero-media { position:relative; min-height:0; overflow:hidden; background:rgba(0,0,0,.28); }
#${ROOT_ID} .delta-hero-portrait { position:absolute; inset:0; width:100%; height:100%; display:block; object-fit:cover; object-position:center 18%; }
#${ROOT_ID} .delta-portrait-placeholder { display:grid; place-items:center; background:radial-gradient(circle at 50% 30%,rgba(216,188,120,.17),rgba(0,0,0,.22)); color:var(--delta-accent); font-family:Georgia,"Times New Roman",serif; }
#${ROOT_ID} .delta-hero-portrait.delta-portrait-placeholder { position:absolute; inset:0; width:100%; height:100%; }
#${ROOT_ID} .delta-hero-portrait.delta-portrait-placeholder span { font-size:clamp(4rem,8vw,7rem); opacity:.68; }
#${ROOT_ID} .delta-hero-caption { position:absolute; z-index:2; left:0; right:0; bottom:0; padding:100px 24px 22px; background:linear-gradient(to bottom,rgba(5,6,8,0),rgba(5,6,8,.62) 43%,rgba(5,6,8,.94) 100%); color:#f4f1e9; }
#${ROOT_ID} .delta-hero-caption h2 { margin:6px 0 5px; color:#fff4d7; font:700 clamp(1.7rem,2.4vw,2.2rem)/1.12 Georgia,"Times New Roman",serif; }
#${ROOT_ID} .delta-hero-caption p { margin:0; max-width:40ch; color:rgba(244,241,233,.84); }
#${ROOT_ID} .delta-hero-actions { display:grid; padding:9px; border-top:1px solid rgba(218,193,148,.12); background:color-mix(in srgb,var(--delta-bg) 90%,black 10%); }
#${ROOT_ID} .delta-hero-empty { height:100%; min-height:250px; display:grid; place-items:center; align-content:center; gap:8px; color:var(--delta-muted); }
#${ROOT_ID} .delta-hero-empty span { font-size:3rem; color:var(--delta-accent); }
#${ROOT_ID} .delta-document { min-width:0; min-height:0; overflow:auto; padding:22px clamp(18px,2.2vw,30px) 34px; scrollbar-color:rgba(218,193,148,.35) transparent; }
#${ROOT_ID} .delta-document-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:15px; padding-bottom:12px; border-bottom:1px solid var(--delta-line); }
#${ROOT_ID} .delta-document-head h2 { margin:3px 0 4px; font:700 1.65rem/1.15 Georgia,"Times New Roman",serif; color:var(--delta-accent-soft); }
#${ROOT_ID} .delta-document-head p { margin:0; }
#${ROOT_ID} .delta-section { margin:0 0 14px; padding:14px 15px; border:1px solid var(--ss-border, rgba(218,193,148,.14)); border-radius:var(--ss-radius-l, 10px); background:var(--delta-surface); }
#${ROOT_ID} .delta-panel.ss-cards { margin:0; gap:0; }
#${ROOT_ID} .delta-panel.ss-cards {
  /* UI 4c: the aliases are read where the tokens exist: inside the panel's ss-cards root (the root above is outside it). */
  --delta-bg: var(--ss-sheet-bg, var(--SmartThemeBlurTintColor, #18191d));
  /* the same tint with its alpha dropped: the opaque floor under the panel and the section bar (the chat must not read through them) */
  --delta-floor: var(--ss-sheet-floor, #18191d);
  --delta-text: var(--ss-text, var(--SmartThemeBodyColor, #f0eee9));
  --delta-muted: var(--ss-text, color-mix(in srgb, var(--delta-text) 66%, transparent));
  --delta-surface: var(--ss-glass, rgba(255,255,255,.055));
  --delta-surface-strong: var(--ss-glass-strong, rgba(255,255,255,.085));
  --delta-line: var(--ss-border, rgba(218,193,148,.24));
  --delta-line-strong: rgba(218,193,148,.52);
  --delta-accent: var(--ss-accent, #d8bc78);
  --delta-accent-soft: var(--ss-text, #f0ddb0);
}
#${ROOT_ID} .delta-section h3 { margin:0 0 11px; font-size:.92rem; letter-spacing:.08em; text-transform:uppercase; color:var(--delta-accent-soft); }
#${ROOT_ID} .delta-section h4 { margin:0 0 5px; font-size:.77rem; letter-spacing:.05em; text-transform:uppercase; color:var(--delta-muted); }
#${ROOT_ID} .delta-section p { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; }
#${ROOT_ID} .delta-muted { color:var(--delta-muted); }
#${ROOT_ID} .delta-current-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
#${ROOT_ID} .delta-current-card { min-width:0; padding:10px 11px; border:1px solid rgba(255,255,255,.075); border-radius:8px; background:rgba(0,0,0,.12); }
#${ROOT_ID} .delta-current-card b { display:block; margin-bottom:3px; font-size:.72rem; text-transform:uppercase; letter-spacing:.06em; color:var(--delta-muted); }
#${ROOT_ID} .delta-current-card span { display:block; overflow-wrap:anywhere; }
#${ROOT_ID} .delta-prose-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:13px 18px; }
#${ROOT_ID} .delta-prose-grid .delta-wide { grid-column:1/-1; }
#${ROOT_ID} .delta-list { margin:0; padding-left:20px; }
#${ROOT_ID} .delta-list li + li { margin-top:4px; }
#${ROOT_ID} .delta-two-column { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:18px; }
#${ROOT_ID} .delta-rel-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:9px 14px; }
#${ROOT_ID} .delta-rel-axis { min-width:0; }
#${ROOT_ID} .delta-rel-label { display:flex; justify-content:space-between; gap:8px; margin-bottom:4px; font-size:.78rem; }
#${ROOT_ID} .delta-rel-label b { color:var(--delta-accent-soft); }
#${ROOT_ID} .delta-rel-step { margin-left:6px; font-size:.72rem; font-weight:700; }
#${ROOT_ID} .delta-rel-step-good { color:#9fd8b4; }
#${ROOT_ID} .delta-rel-step-bad { color:#eba3a3; }
#${ROOT_ID} .delta-rel-track { position:relative; height:8px; border-radius:999px; background:rgba(0,0,0,.34); border:1px solid rgba(255,255,255,.07); }
#${ROOT_ID} .delta-v2-meters { margin-top:9px; }
#${ROOT_ID} .delta-rel-ceiling { position:absolute; top:-3px; bottom:-3px; width:2px; background:rgba(235,163,163,.8); }
/* (p.class, so the 6px beats the rule giving .delta-section p no margin: it never applied, and "Next:" sat flush under the meters) */
#${ROOT_ID} .delta-section p.delta-v2-rank, #${ROOT_ID} .delta-section p.delta-v2-next, #${ROOT_ID} .delta-section p.delta-v2-milestones, #${ROOT_ID} .delta-section p.delta-v2-note { margin:6px 0 0; font-size:.8rem; }
#${ROOT_ID} .delta-rel-zero { position:absolute; left:50%; top:-2px; bottom:-2px; width:1px; background:rgba(255,255,255,.32); }
#${ROOT_ID} .delta-rel-track i { position:absolute; top:50%; width:10px; height:10px; transform:translate(-50%,-50%); border-radius:50%; background:var(--delta-accent); box-shadow:0 0 0 2px rgba(0,0,0,.45); }
#${ROOT_ID} .delta-summary { margin-top:12px; padding-top:10px; border-top:1px solid rgba(218,193,148,.12); }
#${ROOT_ID} .delta-status { display:inline-flex; align-items:center; width:max-content; max-width:100%; padding:3px 7px; border:1px solid rgba(255,255,255,.13); border-radius:999px; font-size:.7rem; line-height:1.25; font-style:normal; white-space:nowrap; }
#${ROOT_ID} .delta-status-active { color:#caefd9; background:rgba(47,112,77,.26); border-color:rgba(113,190,145,.25); }
#${ROOT_ID} .delta-status-archived { color:#ead7aa; background:rgba(119,90,42,.25); border-color:rgba(205,170,109,.25); }
#${ROOT_ID} .delta-key-badge { display:inline-block; margin-left:8px; padding:1px 9px; border:1px solid rgba(245,200,75,.5); border-radius:999px; background:rgba(245,200,75,.18); color:#f5c84b; font-size:.72rem; font-weight:600; line-height:1.4; vertical-align:middle; white-space:nowrap; }
#${ROOT_ID} .delta-cast-badge { display:inline-block; margin-left:8px; font-family:var(--ss-font, system-ui, sans-serif); padding:1px 9px; border:1px solid rgba(160,130,255,.5); border-radius:999px; background:rgba(160,130,255,.18); color:#c9b8ff; font-size:.72rem; font-weight:600; line-height:1.4; vertical-align:middle; white-space:nowrap; }
#${ROOT_ID} .delta-cast-from { display:grid; gap:6px; margin:10px 0; padding:12px 14px; border:1px solid rgba(160,130,255,.35); border-radius:12px; background:rgba(160,130,255,.08); font-size:.86rem; line-height:1.5; }
#${ROOT_ID} .delta-cast-pin { justify-self:start; border-color:rgba(160,130,255,.6); }
#${ROOT_ID} .delta-cast-pin-note { font-size:.78rem; }
#${ROOT_ID} .delta-cast-from h5 { margin:0; font-size:.68rem; letter-spacing:.08em; text-transform:uppercase; opacity:.8; }
#${ROOT_ID} .delta-key-star { color:#f5c84b; font-size:.85em; }
#${ROOT_ID} .delta-secrets h3 .delta-secrets-count { margin-left:6px; color:var(--delta-muted); font-size:.74rem; font-weight:400; letter-spacing:0; text-transform:none; }
#${ROOT_ID} .delta-secret { display:grid; gap:4px; padding:10px 0; border-top:1px solid rgba(218,193,148,.12); }
#${ROOT_ID} .delta-secret p { margin:0; font-size:.86rem; line-height:1.5; }
#${ROOT_ID} .delta-secret-head { display:flex; flex-wrap:wrap; align-items:center; gap:10px; }
#${ROOT_ID} .delta-secret-pill { display:inline-flex; padding:1px 9px; border:1px solid rgba(216,188,120,.45); border-radius:999px; background:rgba(216,188,120,.12); color:var(--delta-accent-soft); font-size:.72rem; }
#${ROOT_ID} .delta-secret-bar { display:block; height:12px; border-radius:6px; background:repeating-linear-gradient(90deg,rgba(255,255,255,.14) 0 10px,rgba(255,255,255,.08) 10px 14px); }
#${ROOT_ID} .delta-secret-when { color:var(--delta-muted); font-size:.76rem; }
#${ROOT_ID} .delta-secrets-note { margin:6px 0 0; font-size:.76rem; }
#${ROOT_ID} .delta-away { margin:10px 0; padding:12px 14px; border:1px solid rgba(120,170,255,.35); border-radius:12px; background:rgba(120,170,255,.08); font-size:.82rem; line-height:1.5; }
#${ROOT_ID} .delta-away h5 { margin:0 0 6px; font-size:.7rem; letter-spacing:.08em; text-transform:uppercase; opacity:.85; }
#${ROOT_ID} .delta-away p { margin:0 0 6px; }
#${ROOT_ID} .delta-away ol { margin:0 0 6px; padding-left:18px; display:grid; gap:3px; }
#${ROOT_ID} .delta-away .delta-away-note { margin:6px 0 0; font-size:.76rem; }
#${ROOT_ID} .delta-status-dead { color:#efb8b8; background:rgba(111,54,60,.28); border-color:rgba(207,118,126,.28); }
#${ROOT_ID} .delta-cast { min-height:0; overflow:hidden; display:grid; grid-template-rows:auto minmax(0,1fr); border-top:1px solid var(--delta-line); background:color-mix(in srgb,var(--delta-bg) 92%,black 8%); }
#${ROOT_ID} .delta-cast-tools { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:8px 10px 7px; border-bottom:1px solid rgba(218,193,148,.11); }
#${ROOT_ID} .delta-search-label { flex:1 1 360px; max-width:470px; }
#${ROOT_ID} .delta-search { width:100%; min-height:34px; margin:0; padding:6px 10px; color:var(--delta-text); background:rgba(0,0,0,.24); border:1px solid var(--delta-line); border-radius:8px; box-shadow:none; }
#${ROOT_ID} .delta-search::placeholder { color:var(--delta-muted); opacity:.75; }
#${ROOT_ID} .delta-filters { display:flex; flex-wrap:wrap; gap:5px; }
#${ROOT_ID} .delta-filter { min-height:30px; padding:4px 8px; color:var(--delta-muted); background:transparent; border-color:transparent; font-size:.75rem; }
#${ROOT_ID} .delta-filter.active { color:var(--delta-accent-soft); background:rgba(216,188,120,.09); border-color:var(--delta-line); }
#${ROOT_ID} .delta-filter span { opacity:.7; }
#${ROOT_ID} .delta-cast-list { min-width:0; min-height:0; overflow-x:auto; overflow-y:hidden; display:flex; gap:7px; padding:8px 10px 10px; scrollbar-color:rgba(218,193,148,.35) transparent; }
#${ROOT_ID} .delta-cast-card { appearance:none; flex:0 0 220px; min-width:0; display:grid; grid-template-columns:52px minmax(0,1fr); align-items:center; gap:9px; padding:7px; text-align:left; color:var(--delta-text); background:rgba(255,255,255,.035); border:1px solid rgba(255,255,255,.075); border-radius:10px; box-shadow:none; cursor:pointer; }
#${ROOT_ID} .delta-cast-card:hover { background:rgba(216,188,120,.08); border-color:var(--delta-line); }
#${ROOT_ID} .delta-cast-card.selected { background:rgba(216,188,120,.12); border-color:var(--delta-line-strong); }
#${ROOT_ID} .delta-cast-portrait { width:52px; height:62px; object-fit:cover; object-position:center 20%; border-radius:8px; border:1px solid rgba(255,255,255,.1); background:rgba(0,0,0,.22); }
#${ROOT_ID} .delta-cast-portrait.delta-portrait-placeholder span { font:700 1.55rem/1 Georgia,serif; }
#${ROOT_ID} .delta-cast-copy { min-width:0; display:grid; gap:2px; }
#${ROOT_ID} .delta-cast-copy b, #${ROOT_ID} .delta-cast-copy small { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#${ROOT_ID} .delta-cast-copy small { color:var(--delta-muted); font-size:.7rem; }
#${ROOT_ID} .delta-cast-copy .delta-status { margin-top:2px; }
#${ROOT_ID} .delta-no-results { flex:1 1 auto; min-width:260px; display:grid; place-items:center; align-content:center; gap:3px; color:var(--delta-muted); text-align:center; }
#${ROOT_ID} .delta-no-results b { color:var(--delta-text); }
#${ROOT_ID} .delta-empty, #${ROOT_ID} .delta-document-empty { height:100%; display:grid; place-items:center; align-content:center; gap:10px; padding:28px; text-align:center; color:var(--delta-muted); }
#${ROOT_ID} .delta-empty h2, #${ROOT_ID} .delta-document-empty h2 { margin:0; color:var(--delta-text); font:700 1.5rem/1.2 Georgia,"Times New Roman",serif; }
#${ROOT_ID} .delta-empty p, #${ROOT_ID} .delta-document-empty p { margin:0; max-width:54ch; }
#${ROOT_ID} .delta-empty-mark { display:grid; place-items:center; width:64px; height:64px; border:1px solid var(--delta-line-strong); border-radius:18px; color:var(--delta-accent); font:700 2rem/1 Georgia,serif; background:rgba(216,188,120,.07); }
#${ROOT_ID} .delta-error-copy { color:var(--delta-danger); }
#${ROOT_ID} .delta-section-nav { position:sticky; top:-22px; z-index:3; display:flex; gap:6px; overflow-x:auto; margin:-26px 0 12px; padding:30px 0 8px; background-color:var(--delta-floor); background-image:linear-gradient(var(--delta-bg),var(--delta-bg)); scrollbar-width:none; }
#${ROOT_ID} .delta-section-nav::-webkit-scrollbar { display:none; }
/* The bar reaches up over the panel's padding (its negative margin), which is right as the first child but pulled it over the cast box that now comes before it: after the box the bar starts where the box ends (its 10px margin cancels the -10px; the 30px padding is the gap, and stays the cover once the bar is stuck). */
#${ROOT_ID} .delta-cast-from + .delta-section-nav { margin-top:-10px; }
#${ROOT_ID} .delta-section .delta-rel-grid + p { margin-top:12px; }
#${ROOT_ID} .delta-section-jump { appearance:none; flex:0 0 auto; min-height:30px; padding:4px 10px; border:1px solid rgba(218,193,148,.18); border-radius:999px; color:var(--delta-muted); background:rgba(255,255,255,.03); font-size:.74rem; cursor:pointer; }
#${ROOT_ID} .delta-section-jump:hover { color:var(--delta-accent-soft); border-color:var(--delta-line-strong); background:rgba(216,188,120,.09); }
#${ROOT_ID} [data-delta-section] { scroll-margin-top:52px; }
#${ROOT_ID} .delta-player-card { border-color:rgba(218,193,148,.26); background:linear-gradient(180deg,rgba(216,188,120,.07),var(--delta-surface) 60%); }
#${ROOT_ID} .delta-rel-last { margin-top:12px; padding-top:11px; border-top:1px solid rgba(218,193,148,.12); }
#${ROOT_ID} .delta-rel-last-head { display:flex; flex-wrap:wrap; align-items:baseline; gap:8px; margin-bottom:7px; }
#${ROOT_ID} .delta-rel-last-head h4 { margin:0; }
#${ROOT_ID} .delta-rel-last-head small { color:var(--delta-muted); font-size:.72rem; }
#${ROOT_ID} .delta-rel-impact { display:inline-flex; padding:1px 7px; border:1px solid rgba(255,255,255,.14); border-radius:999px; font-size:.68rem; letter-spacing:.04em; text-transform:uppercase; color:var(--delta-muted); }
#${ROOT_ID} .delta-rel-impact-meaningful { color:#d7e6ff; border-color:rgba(138,163,200,.4); }
#${ROOT_ID} .delta-rel-impact-major, #${ROOT_ID} .delta-rel-impact-extreme { color:#ffe2a8; border-color:rgba(216,188,120,.5); }
#${ROOT_ID} .delta-rel-deltas { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:7px; }
#${ROOT_ID} .delta-rel-delta { display:inline-flex; padding:2px 8px; border-radius:6px; font-size:.8rem; font-weight:700; background:rgba(0,0,0,.2); border:1px solid rgba(255,255,255,.08); }
#${ROOT_ID} .delta-rel-delta-up { color:#bfe8cf; border-color:rgba(113,190,145,.3); }
#${ROOT_ID} .delta-rel-delta-down { color:#f1bcbc; border-color:rgba(207,118,126,.32); }
#${ROOT_ID} .delta-rel-delta-progress { color:var(--delta-muted); font-weight:400; }
#${ROOT_ID} .delta-rel-history { margin-top:12px; padding-top:10px; border-top:1px solid rgba(218,193,148,.12); }
#${ROOT_ID} .delta-rel-history li .delta-rel-impact { margin-right:4px; }
#${ROOT_ID} .delta-change-line { margin:6px 0 0 !important; font-size:.78rem; color:var(--delta-muted); }
#${ROOT_ID} .delta-changed-dot, #${ROOT_ID} .delta-changed-mark { color:#9fd8b5; }
#${ROOT_ID} .delta-legacy-turn { cursor:help; }
#${ROOT_ID} .delta-changed-mark { margin-left:4px; font-style:normal; font-size:.66rem; letter-spacing:.02em; text-transform:none; font-weight:600; }
#${ROOT_ID} .delta-current-card.delta-changed { border-color:rgba(113,190,145,.32); }
#${ROOT_ID} .delta-portrait-stale { position:absolute; z-index:3; top:12px; left:12px; max-width:calc(100% - 70px); padding:4px 9px; border:1px solid rgba(216,188,120,.55); border-radius:999px; color:#ffe2a8; background:rgba(5,6,8,.62); backdrop-filter:blur(3px); font-size:.72rem; }
#${ROOT_ID} .delta-appearance-form-with-portrait { display:grid; grid-template-columns:64px minmax(0,1fr); gap:10px; align-items:start; }
#${ROOT_ID} .delta-form-portrait-thumb { width:64px; height:82px; border-radius:8px; object-fit:cover; object-position:center 18%; border:1px solid rgba(255,255,255,.12); background:rgba(0,0,0,.25); }
#${ROOT_ID} .delta-form-portrait-empty { display:grid; place-items:center; color:var(--delta-muted); font-size:1.4rem; border-style:dashed; }
#${ROOT_ID} .delta-form-portrait-button { margin-top:7px; min-height:28px; padding:3px 9px; font-size:.74rem; }
#${ROOT_ID} .delta-portrait-expand { position:absolute; z-index:3; top:10px; right:10px; display:grid; place-items:center; width:34px; height:34px; padding:0; border:1px solid rgba(255,255,255,.22); border-radius:9px; color:#fff4d7; background:rgba(5,6,8,.52); backdrop-filter:blur(3px); font-size:1.05rem; cursor:pointer; opacity:.78; }
#${ROOT_ID} .delta-portrait-expand:hover { opacity:1; background:rgba(5,6,8,.72); }
#${ROOT_ID} .delta-hero-media img.delta-hero-portrait { cursor:zoom-in; }
#${ROOT_ID} .delta-lightbox { position:absolute; inset:0; z-index:40; display:grid; grid-template-rows:minmax(0,1fr); place-items:center; padding:18px 18px 64px; background:rgba(3,4,6,.93); cursor:zoom-out; }
#${ROOT_ID} .delta-lightbox img { min-height:0; max-width:100%; max-height:100%; object-fit:contain; border-radius:8px; box-shadow:0 18px 60px rgba(0,0,0,.6); cursor:default; }
#${ROOT_ID} .delta-lightbox-close { position:absolute; left:50%; bottom:16px; transform:translateX(-50%); }
#${SETTINGS_ID}.npc-state-delta-stage1-settings-target { outline:2px solid #d8bc78; outline-offset:4px; }
@supports (color: rgb(from red r g b)) {
  #${ROOT_ID} .delta-panel { --delta-floor: var(--ss-sheet-floor, rgb(from var(--delta-bg) r g b / 1)); }
}
@media (max-width: 900px) {
  #${ROOT_ID} .delta-panel { width:calc(100vw / var(--ss-zoomed, 1)); height:calc(100dvh / var(--ss-zoomed, 1)); border-radius:0; border-left:0; border-right:0; }
  #${ROOT_ID} .delta-library { grid-template-rows:minmax(0,1fr) 172px; }
  #${ROOT_ID} .delta-spread { grid-template-columns:minmax(250px,38%) minmax(0,1fr); }
  #${ROOT_ID} .delta-cast-tools { align-items:stretch; flex-direction:column; }
  #${ROOT_ID} .delta-search-label { flex:0 0 auto; max-width:none; }
}
@media (max-width: 650px) {
  #${ROOT_ID} .delta-launcher { right:10px; bottom:66px; }
  #${ROOT_ID} .delta-brand .delta-kicker, #${ROOT_ID} .delta-chat-state { display:none; }
  #${ROOT_ID} .delta-topbar { padding-left:10px; }
  #${ROOT_ID} .delta-spread { display:block; overflow:auto; }
  #${ROOT_ID} .delta-hero { min-height:max(330px,min(62dvh,540px)); border-right:0; border-bottom:1px solid rgba(218,193,148,.16); }
  #${ROOT_ID} .delta-document { overflow:visible; }
  #${ROOT_ID} .delta-section-nav { top:0; margin-top:-4px; padding-top:8px; }
  #${ROOT_ID} .delta-cast-from + .delta-section-nav { margin-top:-4px; }
  #${ROOT_ID} .delta-current-grid, #${ROOT_ID} .delta-prose-grid, #${ROOT_ID} .delta-two-column, #${ROOT_ID} .delta-rel-grid { grid-template-columns:1fr; }
  #${ROOT_ID} .delta-prose-grid .delta-wide { grid-column:auto; }
  #${ROOT_ID} .delta-cast-card { flex-basis:190px; }
}
`;
