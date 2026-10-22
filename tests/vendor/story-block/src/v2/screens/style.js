// The look Story Block's own screens share (SPEC §13.3, MODULES §F18): SillyTavern's theme colours
// (`--SmartTheme…`), with plain fallbacks for a page that has none. Every screen's `css` starts with
// BASE_CSS; the scoper puts the screen root in front of every selector, and `:root` means that root.
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
  --sb-fg: var(--SmartThemeBodyColor, #dcdcd2);
  --sb-em: var(--SmartThemeEmColor, #a0a0a0);
  --sb-accent: var(--ss-accent, var(--SmartThemeQuoteColor, #e18a24));
  --sb-surface: var(--SmartThemeBlurTintColor, rgba(23, 23, 23, 0.6));
  --sb-raised: color-mix(in srgb, var(--sb-fg) 6%, transparent);
  --sb-border: var(--SmartThemeBorderColor, rgba(127, 127, 127, 0.35));
  --sb-good: #5cb85c;
  --sb-bad: #d9534f;
  --sb-radius: 8px;
  --sb-gap: 8px;
  color: var(--sb-fg);
  line-height: 1.4;
}
.muted { color: var(--sb-em); }
.panel { background: var(--sb-raised); border: 1px solid var(--sb-border); border-radius: var(--sb-radius);
         padding: var(--sb-gap) calc(var(--sb-gap) * 1.5); }
.panel > h4, .group > h4 { display: flex; gap: 6px; align-items: center; margin: 0 0 6px; font-size: 0.85em;
         text-transform: uppercase; letter-spacing: 0.04em; color: var(--sb-em); }
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
