// The look Story Block's own screens share (SPEC §13.3, MODULES §F18): SillyTavern's theme colours
// (`--SmartTheme…`), with plain fallbacks for a page that has none. Every screen's `css` starts with
// BASE_CSS; the scoper puts the screen root in front of every selector, and `:root` means that root.
//
// The screens are on the glass look (UI stage 5a): their colours are the look's tokens (`--ss-*`, view/theme.js) where a
// token exists, so Glass, Solid and Follow SillyTavern all reach them; the older SillyTavern colours stay as the fallback.
// A panel is a glass card, a heading is the section label (`ss-section-label`, view/glass.css: the label and a hairline).
//
// Tokens a pack or card can override through a screen's `theme` (custom properties on the root):
//   --ss-accent                        highlights (default: SillyTavern's quote colour)
//   --sb-common … --sb-legendary       rarity colours
//   --sb-good, --sb-bad                gains and losses

/** Rarity colours, set as the screens' `theme` so they can be restyled without touching the CSS. */
export const RARITY_THEME = Object.freeze({
    '--sb-common': 'var(--SmartThemeBodyColor, #dcdcd2)',
    '--sb-uncommon': '#5cb85c',
    '--sb-rare': '#4a90e2',
    '--sb-epic': '#a66bff',
    '--sb-legendary': '#f0a030',
});

export const BASE_CSS = `
:root {
  --sb-fg: var(--ss-text, var(--SmartThemeBodyColor, #dcdcd2));
  --sb-em: var(--ss-muted, var(--SmartThemeEmColor, #a0a0a0));
  --sb-accent: var(--ss-accent, var(--SmartThemeQuoteColor, #e18a24));
  --sb-surface: var(--ss-glass-strong, var(--SmartThemeBlurTintColor, rgba(23, 23, 23, 0.6)));
  --sb-raised: var(--ss-tile, color-mix(in srgb, var(--sb-fg) 6%, transparent));
  --sb-border: var(--ss-border, var(--SmartThemeBorderColor, rgba(127, 127, 127, 0.35)));
  --sb-good: #5cb85c;
  --sb-bad: #d9534f;
  --sb-radius: 8px;
  --sb-gap: 8px;
  color: var(--sb-fg);
  line-height: 1.4;
}
.muted { color: var(--sb-em); }
.panel { background: var(--ss-glass, var(--sb-raised)); -webkit-backdrop-filter: var(--ss-blur, none); backdrop-filter: var(--ss-blur, none);
         box-shadow: var(--ss-shadow, none); border: 1px solid var(--sb-border); border-radius: var(--ss-radius-l, var(--sb-radius));
         padding: 14px 16px; }
.panel > h4, .group > h4 { margin: 0 0 8px; }
.btn { display: inline-flex; gap: 4px; align-items: center; padding: 2px 8px; border-radius: 6px; cursor: pointer;
       font: inherit; font-size: 0.85em; color: var(--sb-fg); background: var(--sb-surface);
       border: 1px solid var(--sb-border); }
.btn:hover, .btn:focus-visible { border-color: var(--sb-accent); }
.btn.danger:hover, .btn.danger:focus-visible { border-color: var(--sb-bad); color: var(--sb-bad); }
.btn.ss-busy { opacity: 0.6; cursor: progress; }
.chip { display: inline-flex; gap: 4px; align-items: center; padding: 0 6px; border-radius: 9px; font-size: 0.8em;
        background: var(--sb-raised); border: 1px solid var(--sb-border); }
ul { list-style: none; margin: 0; padding: 0; }
`;
