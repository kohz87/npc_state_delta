/* NPC State Delta dossier experience styles: the extension-wide dossier, editor, and settings CSS. */
const STYLE_ID = 'npc_state_delta_dossier_experience_styles';

export function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
/* Settings stays in SillyTavern's Extensions tab. Extension-wide tools live there too. */
#npc_state_delta_dossier_root .delta-open-settings,
#npc_state_delta_dossier_root .delta-tools-data,
#npc_state_delta_dossier_root .delta-tools-diagnostics-button{display:none!important}

/* Floating launcher: keep the 48px drag/touch target, but present it as a circular FAB. */
#npc_state_delta_dossier_launcher{border-radius:50%!important}
#npc_state_delta_dossier_launcher .delta-launcher-mark{border-radius:50%!important}

/* Cast carousel: the portrait is the card; metadata floats over a bottom gradient. */
#npc_state_delta_dossier_root .delta-library{grid-template-rows:minmax(0,1fr) 188px!important}
#npc_state_delta_dossier_root .delta-cast{grid-template-rows:auto minmax(0,1fr)!important}
#npc_state_delta_dossier_root .delta-cast-tools{display:grid!important;grid-template-columns:auto minmax(220px,1fr) auto;align-items:center;gap:10px;padding:7px 10px!important}
#npc_state_delta_dossier_root .delta-library-heading{font:inherit;font-size:.68rem;letter-spacing:.12em;color:var(--delta-muted);white-space:nowrap;justify-self:start;padding:4px 2px;border:0;background:none;text-align:left;cursor:pointer}
#npc_state_delta_dossier_root .delta-library-heading:hover{color:var(--delta-accent)}
#npc_state_delta_dossier_root .delta-library-collapsed .delta-library-heading{grid-column:1/-1!important;justify-self:stretch!important}
@media(pointer:coarse){#npc_state_delta_dossier_root .delta-library-heading{min-height:40px}}
#npc_state_delta_dossier_root .delta-library.delta-library-collapsed{grid-template-rows:minmax(0,1fr) auto!important}
#npc_state_delta_dossier_root .delta-library-collapsed .delta-cast{grid-template-rows:auto!important}
#npc_state_delta_dossier_root .delta-library-collapsed .delta-search-label,#npc_state_delta_dossier_root .delta-library-collapsed .delta-filters,#npc_state_delta_dossier_root .delta-library-collapsed .delta-cast-rail-wrap{display:none!important}
#npc_state_delta_dossier_root .delta-search-label{max-width:none!important;min-width:0!important}
#npc_state_delta_dossier_root .delta-filters{justify-self:end;flex-wrap:nowrap!important}
#npc_state_delta_dossier_root .delta-cast-rail-wrap{position:relative;display:grid;grid-template-columns:30px minmax(0,1fr) 30px;align-items:stretch;min-height:0;overflow:hidden;padding:7px 6px 9px;gap:4px}
#npc_state_delta_dossier_root .delta-cast-list{display:flex!important;gap:8px!important;overflow-x:auto!important;overflow-y:hidden!important;min-width:0!important;min-height:0!important;padding:0 2px!important;scrollbar-width:none!important;scroll-snap-type:x proximity;overscroll-behavior-x:contain}
#npc_state_delta_dossier_root .delta-cast-list::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}
#npc_state_delta_dossier_root .delta-cast-card{position:relative!important;isolation:isolate;flex:0 0 118px!important;width:118px!important;min-width:118px!important;height:132px!important;display:block!important;padding:0!important;overflow:hidden!important;text-align:left!important;border-radius:10px!important;scroll-snap-align:start;background:rgba(0,0,0,.28)!important}
#npc_state_delta_dossier_root .delta-cast-card.selected{box-shadow:inset 0 0 0 1px var(--delta-accent),0 0 0 1px var(--delta-accent)!important}
#npc_state_delta_dossier_root .delta-cast-portrait{position:absolute!important;z-index:0;inset:0!important;display:block!important;width:100%!important;height:100%!important;min-width:0!important;max-width:none!important;border:0!important;border-radius:0!important;object-fit:cover!important;object-position:center 18%!important}
#npc_state_delta_dossier_root .delta-cast-portrait.delta-portrait-placeholder{display:grid!important;place-items:center!important;background:radial-gradient(circle at 50% 24%,rgba(216,188,120,.16),rgba(0,0,0,.48))!important}
#npc_state_delta_dossier_root .delta-cast-portrait.delta-portrait-placeholder span{font-size:2.4rem!important;opacity:.8}
#npc_state_delta_dossier_root .delta-cast-copy{position:absolute!important;z-index:2;left:0;right:0;bottom:0;display:grid!important;align-content:end!important;gap:1px!important;min-width:0!important;padding:28px 7px 7px!important;color:#f6f1e7!important;background:linear-gradient(to bottom,transparent,rgba(5,6,8,.76) 44%,rgba(5,6,8,.96) 100%)}
#npc_state_delta_dossier_root .delta-cast-copy b{font-size:.76rem!important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#fff7e3!important;text-shadow:0 1px 2px rgba(0,0,0,.9)}
#npc_state_delta_dossier_root .delta-cast-copy small{font-size:.61rem!important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:rgba(255,255,255,.72)!important}
#npc_state_delta_dossier_root .delta-cast-copy .delta-status{font-size:.57rem!important;padding:1px 4px!important;margin-top:2px;max-width:100%;overflow:hidden;text-overflow:ellipsis;background:rgba(15,20,20,.74)!important;backdrop-filter:blur(3px)}
/* Living cast leads the rail; the dead follow as compact, dimmed tiles after a divider. */
#npc_state_delta_dossier_root .delta-cast-card[data-bucket="dead"]{flex-basis:78px!important;width:78px!important;min-width:78px!important;opacity:.62}
#npc_state_delta_dossier_root .delta-cast-card[data-bucket="dead"]:hover,#npc_state_delta_dossier_root .delta-cast-card[data-bucket="dead"].selected{opacity:1}
#npc_state_delta_dossier_root .delta-cast-card[data-bucket="dead"] .delta-cast-portrait{filter:grayscale(.8)}
#npc_state_delta_dossier_root .delta-cast-card[data-bucket="dead"] .delta-cast-portrait.delta-portrait-placeholder span{font-size:1.6rem!important}
#npc_state_delta_dossier_root .delta-cast-card[data-bucket="dead"] .delta-cast-copy small{display:none!important}
#npc_state_delta_dossier_root .delta-cast-card.delta-cast-first-dead{margin-left:14px!important;box-shadow:-9px 0 0 -8px rgba(218,193,148,.45)}
#npc_state_delta_dossier_root .delta-rail-arrow{appearance:none;border:0;background:transparent;color:var(--delta-muted);font-size:1.9rem;line-height:1;cursor:pointer;border-radius:7px;padding:0}
#npc_state_delta_dossier_root .delta-rail-arrow:hover{color:var(--delta-accent-soft);background:rgba(255,255,255,.05)}

#npc_state_delta_dossier_root .delta-hero-actions{display:block!important;padding:9px!important}
#npc_state_delta_dossier_root .delta-dossier-actions-primary{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:8px;align-items:stretch}
#npc_state_delta_dossier_root .delta-dossier-more{position:relative;min-width:116px}
#npc_state_delta_dossier_root .delta-dossier-more>summary{list-style:none;display:grid;place-items:center;height:100%;cursor:pointer;user-select:none}
#npc_state_delta_dossier_root .delta-dossier-more>summary::-webkit-details-marker{display:none}
#npc_state_delta_dossier_root .delta-dossier-more-menu{position:absolute;right:0;bottom:calc(100% + 7px);z-index:30;width:210px;display:grid;gap:6px;padding:8px;border:1px solid var(--delta-line);border-radius:10px;background:color-mix(in srgb,var(--delta-bg) 96%,black 4%);box-shadow:0 12px 34px rgba(0,0,0,.46)}
#npc_state_delta_dossier_root .delta-dossier-more-menu .delta-btn{text-align:left;width:100%}
#npc_state_delta_dossier_root .delta-npc-diagnostics{margin:0 9px 9px;padding:9px;border:1px solid var(--delta-line);border-radius:9px;background:rgba(0,0,0,.16);max-height:330px;overflow:auto}
#npc_state_delta_dossier_root .delta-npc-diagnostics>header{display:flex;justify-content:space-between;gap:8px;align-items:baseline;margin-bottom:7px;color:var(--delta-accent-soft)}
#npc_state_delta_dossier_root .delta-npc-diagnostics>header small{color:var(--delta-muted)}
#npc_state_delta_dossier_root .delta-npc-diagnostics details{border-top:1px solid rgba(255,255,255,.07);padding:5px 0}
#npc_state_delta_dossier_root .delta-npc-diagnostics summary{cursor:pointer;font-size:.76rem}
#npc_state_delta_dossier_root .delta-npc-diagnostics pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.68rem;max-height:220px;overflow:auto;margin:5px 0 0;padding:7px;background:rgba(0,0,0,.2);border-radius:6px}

/* One editor viewport, one scrollbar. SillyTavern keeps Save/Cancel outside this body. */
.npc-state-delta-editor-popup{--delta-editor-height:min(940px,96dvh);width:min(1320px,97vw)!important;max-width:none!important;height:var(--delta-editor-height)!important;max-height:96dvh!important;margin:auto!important;overflow:hidden!important}
.npc-state-delta-editor-popup .popup-content{display:flex!important;flex-direction:column!important;min-height:0!important;max-height:none!important;overflow:hidden!important}
.npc-state-delta-editor-popup #npc_state_delta_editor_content{flex:1 1 auto!important;min-height:0!important;max-height:calc(var(--delta-editor-height) - 112px)!important;overflow-y:auto!important;overflow-x:hidden!important;overscroll-behavior:contain;padding-right:8px;scrollbar-gutter:stable}
.npc-state-delta-editor-popup .npc-state-delta-editor-portrait-overrides{display:none!important}
.npc-state-delta-editor-popup .npc-state-delta-editor-head{position:sticky;top:0;z-index:4;margin:-1px -1px 12px;padding:10px 2px 9px;background:color-mix(in srgb,var(--SmartThemeBlurTintColor,#18191d) 96%,black 4%);border-bottom:1px solid rgba(218,193,148,.14)}
.npc-state-delta-editor-popup .delta-editor-section{margin:12px 0;padding:13px;border:1px solid rgba(218,193,148,.16);border-radius:10px;background:rgba(255,255,255,.025)}
.npc-state-delta-editor-popup .delta-editor-section>h4{margin:0 0 11px;color:#e3c985;font-size:.84rem;letter-spacing:.08em;text-transform:uppercase}
.npc-state-delta-editor-popup .delta-editor-section-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 12px}
.npc-state-delta-editor-popup .delta-editor-section-grid>label{display:grid;gap:5px;margin:0;min-width:0}
.npc-state-delta-editor-popup .delta-editor-section-grid>.delta-editor-wide{grid-column:1/-1}
.npc-state-delta-editor-popup .delta-editor-section-grid textarea{resize:vertical;max-width:100%}
.npc-state-delta-editor-popup .npc-state-delta-editor-stats{grid-column:1/-1;margin:2px 0 0}
.npc-state-delta-editor-popup .delta-editor-advanced{margin:12px 0;border:1px solid rgba(218,193,148,.19);border-radius:10px;overflow:hidden}
.npc-state-delta-editor-popup .delta-editor-advanced>summary{display:flex;align-items:baseline;gap:9px;padding:11px 13px;cursor:pointer;color:#e3c985;background:rgba(216,188,120,.045)}
.npc-state-delta-editor-popup .delta-editor-advanced>summary small{color:var(--SmartThemeBodyColor,#ddd);opacity:.55;font-weight:400}
.npc-state-delta-editor-popup .delta-editor-advanced-body{display:grid;gap:10px;padding:12px 13px}
.npc-state-delta-editor-popup .delta-editor-life-control{display:grid;grid-template-columns:minmax(180px,1fr) auto;gap:8px 10px;align-items:end;margin:0;padding:11px;border:1px solid rgba(218,193,148,.14);border-radius:9px;background:rgba(255,255,255,.035)}
.npc-state-delta-editor-popup .delta-editor-life-control label{display:grid;gap:5px;margin:0}
.npc-state-delta-editor-popup .delta-editor-life-control small{grid-column:1/-1;opacity:.72}
.npc-state-delta-editor-popup .delta-editor-life-control>.menu_button{width:auto;white-space:nowrap;margin:0}

/* Extension settings: same visual grammar, grouped by task instead of one long wall. */

@media(max-width:900px){
  #npc_state_delta_dossier_root .delta-library{grid-template-rows:minmax(0,1fr) 198px!important}
  #npc_state_delta_dossier_root .delta-cast-tools{grid-template-columns:1fr auto!important}
  #npc_state_delta_dossier_root .delta-library-heading{grid-column:1/-1}
  #npc_state_delta_dossier_root .delta-search-label{grid-column:1/2}
  #npc_state_delta_dossier_root .delta-filters{grid-column:2/3}
  .npc-state-delta-editor-popup .delta-editor-section-grid{grid-template-columns:1fr}
  .npc-state-delta-editor-popup .delta-editor-section-grid>.delta-editor-wide{grid-column:1}
}
@media(max-width:650px){
  #npc_state_delta_dossier_root .delta-library{grid-template-rows:minmax(0,1fr) 226px!important}
  #npc_state_delta_dossier_root .delta-cast-tools{grid-template-columns:1fr!important;gap:6px!important}
  #npc_state_delta_dossier_root .delta-search-label,#npc_state_delta_dossier_root .delta-filters{grid-column:1!important;justify-self:stretch!important}
  #npc_state_delta_dossier_root .delta-library-heading{grid-column:1!important;justify-self:stretch!important;min-height:36px}
  #npc_state_delta_dossier_root .delta-filters{overflow-x:auto}
  #npc_state_delta_dossier_root .delta-cast-card{flex-basis:106px!important;width:106px!important;min-width:106px!important;height:126px!important}
  #npc_state_delta_dossier_root .delta-cast-card[data-bucket="dead"]{flex-basis:70px!important;width:70px!important;min-width:70px!important}
  #npc_state_delta_dossier_root .delta-dossier-actions-primary{grid-template-columns:1fr 1fr auto}
  #npc_state_delta_dossier_root .delta-dossier-more{min-width:92px}
  .npc-state-delta-editor-popup{--delta-editor-height:100dvh;width:100vw!important;height:100dvh!important;max-width:none!important;max-height:none!important;border-radius:0!important}
  .npc-state-delta-editor-popup #npc_state_delta_editor_content{max-height:calc(100dvh - 96px)!important;padding-right:4px}
  .npc-state-delta-editor-popup .delta-editor-life-control{grid-template-columns:1fr}
  .npc-state-delta-editor-popup .delta-editor-life-control small{grid-column:1}
}
`;
    document.head.appendChild(style);
}
