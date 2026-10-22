// The layout stylesheet: one fixed string the host puts in a <style> once. A layout
// never brings its own CSS; it can only set the `--ss-l-*` tokens below on its root.
// Defaults follow SillyTavern's theme colours.
//
// Responsive by default: a layout root is a size container, so grids fall back to one
// column when the place it is mounted in (a narrow sidebar, a phone) is under 480px.

export const LAYOUT_STYLE_ID = 'ss-l-styles';

export const LAYOUT_CSS = `
.ss-l-root {
  --ss-l-accent-d: var(--ss-l-accent, var(--SmartThemeQuoteColor, #e1a95f));
  --ss-l-fg-d: var(--ss-l-fg, var(--SmartThemeBodyColor, inherit));
  --ss-l-border-d: var(--ss-l-border, var(--SmartThemeBorderColor, rgba(128, 128, 128, 0.35)));
  --ss-l-gap-d: var(--ss-l-gap, 8px);
  --ss-l-pad-d: var(--ss-l-pad, 8px);
  --ss-l-radius-d: var(--ss-l-radius, 6px);
  container-type: inline-size;
  color: var(--ss-l-fg-d);
  background: var(--ss-l-bg, transparent);
  font-family: var(--ss-l-font, inherit);
  display: flex; flex-direction: column; gap: var(--ss-l-gap-d);
  min-width: 0;
}
.ss-l-root *, .ss-l-root *::before, .ss-l-root *::after { box-sizing: border-box; }
.ss-l-box {
  background: var(--ss-l-surface, rgba(128, 128, 128, 0.08));
  border: 1px solid var(--ss-l-border-d); border-radius: var(--ss-l-radius-d);
  padding: var(--ss-l-pad-d); display: flex; flex-direction: column; gap: var(--ss-l-gap-d); min-width: 0;
}
.ss-l-box-title { font-weight: 600; color: var(--ss-l-accent-d); }
.ss-l-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--ss-l-gap-d); min-width: 0; }
.ss-l-col { display: flex; flex-direction: column; gap: var(--ss-l-gap-d); min-width: 0; }
.ss-l-grid { display: grid; gap: var(--ss-l-gap-d); grid-template-columns: repeat(var(--ss-l-cols, 2), minmax(0, 1fr)); }
.ss-l-when { display: contents; }
.ss-l-text { overflow-wrap: anywhere; }
.ss-l-text-title { font-size: 1.15em; font-weight: 600; }
.ss-l-text-label, .ss-l-label { opacity: 0.75; font-size: 0.9em; }
.ss-l-text-muted { color: var(--ss-l-muted, inherit); opacity: 0.7; font-size: 0.9em; }
.ss-l-text .ss-l-label, .ss-l-badge .ss-l-label { margin-right: 0.4em; }
.ss-l-meter { display: flex; flex-direction: column; gap: 2px; min-width: 6em; }
.ss-l-meter-head { display: flex; justify-content: space-between; gap: var(--ss-l-gap-d); font-size: 0.9em; }
.ss-l-meter-bar { height: 6px; border-radius: 3px; overflow: hidden; background: var(--ss-l-meter-bg, rgba(128, 128, 128, 0.25)); }
.ss-l-meter-fill { height: 100%; background: var(--ss-l-meter, var(--ss-l-accent-d)); }
.ss-l-meter.ss-l-tone-good .ss-l-meter-fill { background: var(--ss-l-good, #4caf50); }
.ss-l-meter.ss-l-tone-warn .ss-l-meter-fill { background: var(--ss-l-warn, #e0a030); }
.ss-l-meter.ss-l-tone-bad .ss-l-meter-fill { background: var(--ss-l-bad, #d9534f); }
.ss-l-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.ss-l-item { min-width: 0; }
.ss-l-empty, .ss-l-more { opacity: 0.7; font-style: italic; }
.ss-l-image { max-width: 100%; height: auto; border-radius: var(--ss-l-radius-d); object-fit: cover; }
.ss-l-image-small { width: 48px; height: 48px; }
.ss-l-image-medium { max-width: 160px; }
.ss-l-image-large { width: 100%; }
.ss-l-badge {
  display: inline-flex; align-items: center; padding: 0 0.5em; border-radius: 999px; font-size: 0.85em;
  border: 1px solid var(--ss-l-border-d); white-space: nowrap;
}
.ss-l-badge.ss-l-tone-accent { color: var(--ss-l-accent-d); border-color: currentColor; }
.ss-l-badge.ss-l-tone-good { color: var(--ss-l-good, #4caf50); border-color: currentColor; }
.ss-l-badge.ss-l-tone-warn { color: var(--ss-l-warn, #e0a030); border-color: currentColor; }
.ss-l-badge.ss-l-tone-bad { color: var(--ss-l-bad, #d9534f); border-color: currentColor; }
.ss-l-tone-uncommon { color: #4caf50; }
.ss-l-tone-rare { color: #4a90d9; }
.ss-l-tone-epic { color: #a066d3; }
.ss-l-tone-legendary { color: #e0a030; }
.ss-l-action { display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.ss-l-button {
  cursor: pointer; padding: 2px 10px; border-radius: var(--ss-l-radius-d); font: inherit;
  color: inherit; background: transparent; border: 1px solid var(--ss-l-border-d);
}
.ss-l-button:hover:not(:disabled) { border-color: var(--ss-l-accent-d); color: var(--ss-l-accent-d); }
.ss-l-button:disabled { opacity: 0.5; cursor: default; }
.ss-l-button .fa-solid { margin-right: 0.35em; }
.ss-l-status:empty { display: none; }
.ss-l-status { font-size: 0.85em; color: var(--ss-l-bad, #d9534f); }
.ss-l-tabbar { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid var(--ss-l-border-d); margin-bottom: var(--ss-l-gap-d); }
.ss-l-tab { cursor: pointer; padding: 2px 10px; font: inherit; color: inherit; background: transparent; border: 0; border-bottom: 2px solid transparent; }
.ss-l-tab-active { border-bottom-color: var(--ss-l-accent-d); color: var(--ss-l-accent-d); }
.ss-l-widget { min-width: 0; }
.ss-l-invalid { border: 1px dashed var(--ss-l-bad, #d9534f); padding: 8px; border-radius: 6px; }
.ss-l-invalid-title { margin: 0 0 4px; font-weight: 600; }
.ss-l-invalid-list { margin: 0; padding-left: 1.2em; font-size: 0.9em; }
@container (max-width: 480px) {
  .ss-l-grid { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 480px) {
  .ss-l-grid { grid-template-columns: minmax(0, 1fr); }
}
`;

/** Put the stylesheet in `doc` once (a no-op where there is no <head>, as in tests). */
export function ensureLayoutStyles(doc = globalThis.document) {
    if (!doc?.head || typeof doc.getElementById !== 'function') return false;
    if (doc.getElementById(LAYOUT_STYLE_ID)) return true;
    const style = doc.createElement('style');
    style.id = LAYOUT_STYLE_ID;
    style.textContent = LAYOUT_CSS;
    doc.head.appendChild(style);
    return true;
}
