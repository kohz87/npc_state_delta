// Story Suite's one look (the UI stage): glass panels over SillyTavern's background, one set of design
// tokens for every Story Suite root, light or dark, in the soft font Nunito. This file is the theme bridge:
//
// * the tokens: `--ss-glass`, `--ss-glass-strong`, `--ss-tile`, `--ss-border`, `--ss-shadow`, `--ss-text`,
//   `--ss-muted`, `--ss-track`, `--ss-accent`, `--ss-accent-soft`, `--ss-pill`, `--ss-badge`, the bar
//   colours (`--ss-hp`, `--ss-mp`, `--ss-sp`, `--ss-exp`), tones and rarities, `--ss-radius-*`,
//   `--ss-space-*`, `--ss-font`, `--ss-blur` and `--ss-motion`. view/glass.css draws the building blocks
//   (glass card, tile, bar, status badge, pill, section label) from them; a screen's own `theme` (SPEC
//   §13.3) still sets any of them on its root, and wins.
// * light or dark: worked out from SillyTavern's own theme: the body text against the blur tint (light
//   text on a darker tint is a dark theme). The glass takes a share of the tint's colour, so a theme's hue
//   shows through, but never its opacity: the glass's alpha is the reader's Glass strength (30–90%, 50% is the
//   concept's: about half see-through), so the page behind always shows. SillyTavern sets its theme variables on <html>'s style; a change there is read again.
// * the reader's "Panel style" (Settings → Story Suite): Glass (the default), Solid (no blur, an opaque
//   tint: for slow devices or a busy background) or SillyTavern (SillyTavern's own colours and blur, as
//   before the UI stage). A system asking for less transparency gets Solid instead of Glass; one asking
//   for less motion gets no transitions.
// * the reader's "Font": Nunito (the default) or the theme's own font. Nunito ships with the extension
//   (assets/fonts/nunito, SIL OFL; view/fonts.css), so it is the same offline and while SillyTavern's "Forbid
//   external media" is on; nothing is fetched. If it cannot load, the system's own UI font.
//
// Everything is written into one <style data-ss-theme> in the page's head, every rule under
// :where(<Story Suite roots>) (the same roots as controls.css), so SillyTavern's own UI is never touched:
// no class, attribute or style is set on any of SillyTavern's elements. The class `ss-scheme-light` or
// `ss-scheme-dark` inside a root forces one scheme there (the UI sample shows both side by side).

/**
 * The Story Suite roots (as in controls.css): every token and building block is scoped under them. The last three are
 * the furniture in the chat: the bar above the message box, the Choices under a reply, the notes under a reply. They are
 * roots so the same tokens reach them (Glass, Solid and Follow SillyTavern alike).
 */
export const THEME_ROOTS = Object.freeze(['.story-suite-overlay', '.story-suite-sheet', '.ss-gameview', '.ss-dialog', '.ss-cards', '.ss-card', '.ss-hud', '[data-ss-screen]', '.story-suite-bar', '.story-suite-extras', '.story-suite-reply-note']);
export const ROOT_SELECTOR = `:where(${THEME_ROOTS.join(', ')})`;

/** The reader's choices (host settings `panelStyle` and `font`). */
export const PANEL_STYLES = Object.freeze(['glass', 'solid', 'sillytavern']);
export const FONTS = Object.freeze(['nunito', 'theme']);
export const SCHEMES = Object.freeze(['dark', 'light']);
export const DEFAULT_PANEL = 'glass';
export const DEFAULT_FONT = 'nunito';

export const FONT_STACKS = Object.freeze({
    nunito: '\'Nunito\', system-ui, -apple-system, \'Segoe UI\', Roboto, sans-serif',
    theme: 'var(--mainFontFamily, inherit)',
});

// The accent of the approved concept, and the parts of the look that are the same in every scheme.
export const ACCENT = '#7b6cf0';
const SHARED = Object.freeze({
    '--ss-radius-s': '10px',
    '--ss-radius-m': '14px',
    '--ss-radius-l': '18px',
    '--ss-radius-xl': '22px',
    '--ss-radius-xxl': '26px',
    '--ss-radius-button': '12px',
    '--ss-radius-pill': '999px',
    '--ss-space-1': '4px',
    '--ss-space-2': '8px',
    '--ss-space-3': '12px',
    '--ss-space-4': '16px',
    '--ss-space-5': '24px',
    '--ss-hp': '#e5484d',
    '--ss-mp': '#4fa3ff',
    '--ss-sp': '#e8b04b',
    '--ss-exp': 'var(--ss-accent)',
    '--ss-tick': '#2fbf71',
    '--ss-bad': '#ff6b6b',
    '--ss-warn': '#e8b04b',
    '--ss-info': '#4fa3ff',
    '--ss-uncommon': '#2fbf71',
    '--ss-rare': '#4fa3ff',
    '--ss-epic': '#b07cff',
    '--ss-legendary': '#e8b04b',
    '--ss-on-ring': '#10131a',
    '--ss-knob': '#ffffff',
    '--ss-motion': '0.2s',
});

// The concept's two palettes (uiconcept Main/Settings: the `t` token blocks). `base` is the colour of the
// glass (its alpha comes from the reader's Glass strength, glassAlphas); `solid` is the opaque base for the
// Solid panel style.
export const PALETTES = Object.freeze({
    dark: Object.freeze({
        base: [30, 33, 50], solid: '#1e2132',
        tile: 'rgba(255, 255, 255, 0.09)', border: 'rgba(255, 255, 255, 0.16)', rule: 'rgba(255, 255, 255, 0.22)', shadow: '0 10px 30px rgba(0, 0, 0, 0.35)',
        text: '#f1f2f8', muted: '#b6bacb', track: 'rgba(255, 255, 255, 0.14)',
        pill: 'rgba(255, 255, 255, 0.14)', pillText: '#f1f2f8', badge: '#f1f2f8', badgeText: '#141720',
        field: 'rgba(0, 0, 0, 0.22)', overlay: 'rgba(24, 27, 42, 0.72)', scrim: 'rgba(8, 10, 20, 0.6)', off: 'rgba(255, 255, 255, 0.22)', accentSoft: 'rgba(123, 108, 240, 0.24)',
        good: '#72dea4', chatter: '#d2cbff',
        // the accent as TEXT on the glass (the bar's current label, a tile's icon): >= 4.5:1 on the dark glass (the accent itself is ~4:1)
        accentText: '#a99dff',
    }),
    light: Object.freeze({
        base: [255, 255, 255], solid: '#f6f5fb',
        tile: 'rgba(255, 255, 255, 0.72)', border: 'rgba(255, 255, 255, 0.9)', rule: 'rgba(35, 37, 58, 0.22)', shadow: '0 10px 30px rgba(70, 60, 130, 0.14)',
        text: '#23253a', muted: '#5b5e74', track: 'rgba(35, 37, 58, 0.1)',
        pill: '#2c2f46', pillText: '#ffffff', badge: '#2c2f46', badgeText: '#ffffff',
        field: 'rgba(255, 255, 255, 0.85)', overlay: 'rgba(255, 255, 255, 0.78)', scrim: 'rgba(35, 37, 58, 0.38)', off: 'rgba(35, 37, 58, 0.22)', accentSoft: 'rgba(123, 108, 240, 0.16)',
        good: '#1d7c4a', chatter: '#5544c4',
        // the accent as text on the light glass: >= 4.5:1
        accentText: '#5a48d6',
    }),
});

// How much of SillyTavern's blur tint goes into the glass's COLOUR (the rest is the concept's own base). Only
// the tint's colour is used: the glass keeps its own alpha (Glass strength), whatever the tint's opacity is.
export const TINT_SHARE = 30;
const TINT = 'var(--SmartThemeBlurTintColor, rgba(23, 23, 23, 1))';
const mixTint = base => `color-mix(in srgb, ${TINT} ${TINT_SHARE}%, ${base})`;

// What the legacy surfaces paint under Glass: the dense glass, its blur and no extra layers (the game view's opaque fallback).
// The shape of the glass for the frames that were opaque (the HUD strip, the dialog mount): their radius, edge and shadow.
// Set for Glass only, so Solid and Follow SillyTavern keep those frames' own shape (the frames read each with a fallback).
const SHEET_TOKENS = Object.freeze([
    ['--ss-sheet-bg', 'var(--ss-glass-strong)'], ['--ss-sheet-blur', 'var(--ss-blur)'], ['--ss-sheet-layers', 'none'],
    // the same tint with its alpha dropped: the floor under the translucent sheet, so the story behind cannot be read through it
    // on a phone with blur off (mounts.css stacks the tint over this floor). Relative colours; without them the floor is unset.
    ['--ss-sheet-floor', 'rgb(from var(--ss-glass-strong) r g b / 1)'],
    // the phone game view's floor and its three layers of the tint, Glass only (mounts.css, the phone rule); unset for the other styles
    ['--ss-gameview-phone-floor', 'var(--ss-sheet-floor)'],
    ['--ss-gameview-phone-layers', 'linear-gradient(var(--ss-sheet-bg), var(--ss-sheet-bg)), linear-gradient(var(--ss-sheet-bg), var(--ss-sheet-bg)), linear-gradient(var(--ss-sheet-bg), var(--ss-sheet-bg))'],
    ['--ss-sheet-radius', 'var(--ss-radius-l)'], ['--ss-sheet-radius-top', 'var(--ss-radius-l) var(--ss-radius-l) 0 0'],
    ['--ss-sheet-edge', '1px solid var(--ss-border)'], ['--ss-sheet-shadow', 'var(--ss-shadow)'],
    // the HUD strip on a phone: the Glass tint three times over (the same compounding as the full-screen window), Glass only
    ['--ss-sheet-hud-layers', 'linear-gradient(var(--ss-sheet-bg), var(--ss-sheet-bg)), linear-gradient(var(--ss-sheet-bg), var(--ss-sheet-bg)), linear-gradient(var(--ss-sheet-bg), var(--ss-sheet-bg))'],
]);
const SHEET_RESET = Object.freeze(SHEET_TOKENS.map(([name]) => [name, 'initial']));

/** The reader's Glass strength (host setting `glassStrength`, a percentage): its range and default. */
export const GLASS_MIN = 30;
export const GLASS_MAX = 90;
export const DEFAULT_GLASS = 50;
const clampStrength = value => {
    const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
    if (value === '' || value === null || value === undefined || !Number.isFinite(n)) return DEFAULT_GLASS;
    return Math.min(GLASS_MAX, Math.max(GLASS_MIN, Math.round(n)));
};
/**
 * The glass's alpha for a Glass strength (30–90%): the concept's own at 50%: dark 0.50 / strong 0.66, light
 * 0.55 / 0.72; a higher strength is denser (at most 0.98), a lower one clearer.
 */
export function glassAlphas(scheme, strength = DEFAULT_GLASS) {
    const s = clampStrength(strength) / 100;
    const light = scheme === 'light';
    const round = n => Math.round(Math.min(0.98, n) * 100) / 100;
    return { glass: round(s + (light ? 0.05 : 0)), strong: round(s + (light ? 0.22 : 0.16)) };
}

// ---- colours ---------------------------------------------------------------------------------------

const NAMED = Object.freeze({ black: [0, 0, 0, 1], white: [255, 255, 255, 1], transparent: [0, 0, 0, 0] });
const clampByte = n => Math.min(255, Math.max(0, n));
const clampUnit = n => Math.min(1, Math.max(0, n));

/**
 * A CSS colour as { r, g, b, a } (0–255, alpha 0–1), or null when it is not one this reads: #rgb, #rgba,
 * #rrggbb, #rrggbbaa, rgb()/rgba() with commas or spaces (numbers or percentages, alpha after a comma or
 * a slash), black, white, transparent. Enough for SillyTavern's theme variables, which it writes as rgba().
 */
export function parseColor(value) {
    const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!text) return null;
    if (Object.hasOwn(NAMED, text)) {
        const [r, g, b, a] = NAMED[text];
        return { r, g, b, a };
    }
    const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text);
    if (hex) {
        let digits = hex[1];
        if (digits.length <= 4) digits = [...digits].map(d => d + d).join('');
        const byte = i => parseInt(digits.slice(i, i + 2), 16);
        return { r: byte(0), g: byte(2), b: byte(4), a: digits.length === 8 ? Math.round((byte(6) / 255) * 1000) / 1000 : 1 };
    }
    const fn = /^rgba?\(\s*([^)]*)\)$/.exec(text);
    if (!fn) return null;
    const [channels, alphaPart] = fn[1].includes('/') ? fn[1].split('/') : [fn[1], null];
    const parts = channels.split(/[\s,]+/).filter(Boolean);
    let alpha = alphaPart;
    if (alpha === null && parts.length === 4) alpha = parts.pop();
    if (parts.length !== 3) return null;
    const channel = part => {
        const m = /^(-?\d*\.?\d+)(%?)$/.exec(part);
        if (!m) return null;
        return clampByte(m[2] ? (Number(m[1]) / 100) * 255 : Number(m[1]));
    };
    const [r, g, b] = parts.map(channel);
    if ([r, g, b].some(n => n === null || Number.isNaN(n))) return null;
    let a = 1;
    if (alpha !== null) {
        const m = /^\s*(-?\d*\.?\d+)(%?)\s*$/.exec(alpha);
        if (!m) return null;
        a = clampUnit(m[2] ? Number(m[1]) / 100 : Number(m[1]));
    }
    return { r, g, b, a };
}

/** WCAG relative luminance of a colour (0 black … 1 white), alpha ignored. */
export function luminance(color) {
    const lin = c => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(color.r) + 0.7152 * lin(color.g) + 0.0722 * lin(color.b);
}

/**
 * Light or dark, from SillyTavern's theme: 'dark' when the body text is lighter than the blur tint (light
 * text on a dark panel), 'light' when it is darker. A tint that is mostly see-through (alpha below 0.35)
 * says little about what is behind it, so then the text decides alone (light text: dark). With nothing
 * readable, 'dark' (SillyTavern's default theme is dark).
 */
export function decideScheme({ body = '', tint = '' } = {}) {
    const text = parseColor(body);
    const panel = parseColor(tint);
    if (text && panel && panel.a >= 0.35) return luminance(text) >= luminance(panel) ? 'dark' : 'light';
    if (text) return luminance(text) >= 0.4 ? 'dark' : 'light';
    if (panel) return luminance(panel) < 0.4 ? 'dark' : 'light';
    return 'dark';
}

/** The reader's choices as this file uses them (anything unknown → the default). */
export function themeChoice(settings = {}) {
    const panel = PANEL_STYLES.includes(settings?.panelStyle) ? settings.panelStyle : DEFAULT_PANEL;
    const font = FONTS.includes(settings?.font) ? settings.font : DEFAULT_FONT;
    return { panel, font, strength: clampStrength(settings?.glassStrength) };
}

// ---- tokens ----------------------------------------------------------------------------------------

/**
 * The colour tokens for one scheme and panel style: [[name, value]] in a fixed order. `opaque` (Solid,
 * where relative colours work) makes the glass fully opaque; without them Solid's glass is the opaque
 * base with a share of the tint, which is opaque whenever the tint is.
 */
export function schemeTokens(scheme, panel, { opaque = false, strength = DEFAULT_GLASS, tinted = false } = {}) {
    if (panel === 'sillytavern') {
        // SillyTavern's own colours and blur, light or dark as the theme is.
        return [
            ['--ss-glass', 'var(--SmartThemeBlurTintColor, rgba(23, 23, 23, 1))'],
            ['--ss-glass-strong', 'var(--SmartThemeBlurTintColor, rgba(23, 23, 23, 1))'],
            ['--ss-tile', 'color-mix(in srgb, var(--SmartThemeBodyColor, #dcdcd2) 8%, transparent)'],
            ['--ss-border', 'var(--SmartThemeBorderColor, rgba(0, 0, 0, 0.5))'],
            // the current tab's edge (UI 5b): SillyTavern's text colour, since its quote colour can be faint on a light track
            ['--ss-tab-edge', 'var(--SmartThemeBodyColor, #dcdcd2)'],
            // the section-label hairline: SillyTavern's text colour at 40% over its tint, so it reads against the card (>= 1.5:1)
            ['--ss-rule', 'color-mix(in srgb, var(--SmartThemeBodyColor, #dcdcd2) 40%, var(--SmartThemeBlurTintColor, rgba(23, 23, 23, 1)))'],
            ['--ss-shadow', '0 2px 8px var(--SmartThemeShadowColor, rgba(0, 0, 0, 0.5))'],
            ['--ss-text', 'var(--SmartThemeBodyColor, #dcdcd2)'],
            ['--ss-muted', 'var(--SmartThemeEmColor, #919191)'],
            ['--ss-track', 'color-mix(in srgb, var(--SmartThemeBodyColor, #dcdcd2) 14%, transparent)'],
            ['--ss-pill', 'color-mix(in srgb, var(--SmartThemeBodyColor, #dcdcd2) 14%, transparent)'],
            ['--ss-pill-text', 'var(--SmartThemeBodyColor, #dcdcd2)'],
            ['--ss-badge', 'var(--SmartThemeBodyColor, #dcdcd2)'],
            ['--ss-badge-text', 'var(--SmartThemeBlurTintColor, rgba(23, 23, 23, 1))'],
            ['--ss-field', 'color-mix(in srgb, var(--SmartThemeBodyColor, #dcdcd2) 8%, var(--SmartThemeBlurTintColor, #171717))'],
            ['--ss-overlay', 'var(--SmartThemeBlurTintColor, rgba(23, 23, 23, 1))'],
            ['--ss-scrim', 'rgba(0, 0, 0, 0.55)'],
            ['--ss-off', 'color-mix(in srgb, var(--SmartThemeBodyColor, #dcdcd2) 22%, transparent)'],
            ['--ss-accent', 'var(--SmartThemeQuoteColor, #e18a24)'],
            ['--ss-accent-soft', 'color-mix(in srgb, var(--SmartThemeQuoteColor, #e18a24) 20%, transparent)'],
            // the accent as text, following SillyTavern's own colours: its quote colour mixed with its text colour (40:60), so it reads
            // on a light theme too (the quote colour alone is ~2:1 there); on a dark theme it stays light
            ['--ss-accent-text', 'color-mix(in srgb, var(--SmartThemeQuoteColor, #e18a24) 40%, var(--SmartThemeBodyColor, #dcdcd2))'],
            ['--ss-good', '#4caf6e'],
            ['--ss-chatter', 'var(--SmartThemeEmColor, #919191)'],
            ['--ss-blur', 'blur(var(--SmartThemeBlurStrength, 0px))'],
        ];
    }
    const p = PALETTES[scheme] ?? PALETTES.dark;
    const solid = panel === 'solid';
    const opaqueOf = color => (opaque ? `rgb(from ${color} r g b / 1)` : color);
    const alpha = glassAlphas(scheme, strength);
    const [r, g, b] = p.base;
    // Glass: the concept's colour at the reader's alpha. With `tinted` (where relative colours work) SillyTavern's
    // tint colour is mixed in, its own alpha dropped: the alpha is always the Glass strength's.
    const tintColour = `rgb(from ${TINT} r g b / 1)`;
    const glassOf = a => (tinted ? `rgb(from color-mix(in srgb, ${tintColour} ${TINT_SHARE}%, rgb(${r} ${g} ${b})) r g b / ${a})` : `rgba(${r}, ${g}, ${b}, ${a})`);
    return [
        ['--ss-glass', solid ? opaqueOf(mixTint(p.solid)) : glassOf(alpha.glass)],
        ['--ss-glass-strong', solid ? opaqueOf(mixTint(p.solid)) : glassOf(alpha.strong)],
        ['--ss-tile', p.tile],
        ['--ss-border', p.border],
        ['--ss-rule', p.rule],
        ['--ss-shadow', p.shadow],
        ['--ss-text', p.text],
        ['--ss-muted', p.muted],
        ['--ss-track', p.track],
        ['--ss-pill', p.pill],
        ['--ss-pill-text', p.pillText],
        ['--ss-badge', p.badge],
        ['--ss-badge-text', p.badgeText],
        ['--ss-field', p.field],
        ['--ss-overlay', solid ? opaqueOf(p.overlay) : p.overlay],
        ['--ss-scrim', p.scrim],
        ['--ss-off', p.off],
        ['--ss-accent', ACCENT],
        ['--ss-accent-text', p.accentText],
        ['--ss-tab-edge', 'var(--ss-accent)'],
        ['--ss-accent-soft', p.accentSoft],
        ['--ss-good', p.good],
        ['--ss-chatter', p.chatter],
        ['--ss-blur', solid ? 'none' : 'blur(16px) saturate(1.2)'],
        // The legacy surfaces (`.story-suite-sheet`, `.ss-gameview`: host.css, mounts.css) paint these when they are set,
        // which they are for Glass only: the page shows through them. Solid and Follow SillyTavern leave them unset, so
        // those surfaces keep SillyTavern's tint exactly as before.
        ...(solid ? [] : SHEET_TOKENS),
    ];
}

/** Every token for a choice: the scheme's colours, then the shared sizes, colours and the font. */
export function themeTokens({ scheme = 'dark', panel = DEFAULT_PANEL, font = DEFAULT_FONT, strength = DEFAULT_GLASS } = {}) {
    return [
        ['--ss-scheme', panel === 'sillytavern' ? 'sillytavern' : scheme],
        ...schemeTokens(scheme, panel, { strength }),
        ...Object.entries(SHARED),
        ['--ss-font', FONT_STACKS[font] ?? FONT_STACKS.nunito],
    ];
}

const block = (selector, tokens, indent = '') => `${indent}${selector} {\n${tokens.map(([name, value]) => `${indent}    ${name}: ${value};`).join('\n')}\n${indent}}`;
const forced = scheme => `${ROOT_SELECTOR}:where(.ss-scheme-${scheme}), ${ROOT_SELECTOR} :where(.ss-scheme-${scheme})`;

/**
 * The theme sheet for `{ scheme, panel, font }`: the tokens on every Story Suite root, the two forced
 * schemes (classes `ss-scheme-light`, `ss-scheme-dark`), Solid's opaque glass where relative colours work, Solid in place of Glass
 * for a system that asks for less transparency, and no transitions for one that asks for less motion.
 */
export function themeCss({ scheme = 'dark', panel = DEFAULT_PANEL, font = DEFAULT_FONT, strength = DEFAULT_GLASS } = {}) {
    const choice = { scheme: SCHEMES.includes(scheme) ? scheme : 'dark', ...themeChoice({ panelStyle: panel, font, glassStrength: strength }) };
    const out = [`/* Story Suite theme (src/v2/view/theme.js): ${choice.panel}, ${choice.panel === 'sillytavern' ? 'as SillyTavern' : choice.scheme}, ${choice.font}${choice.panel === 'glass' ? `, glass ${choice.strength}%` : ''}. */`];
    out.push(block(ROOT_SELECTOR, themeTokens(choice)));
    if (choice.panel !== 'sillytavern') {
        for (const s of SCHEMES) out.push(block(forced(s), [['--ss-scheme', s], ...schemeTokens(s, choice.panel, choice)]));
    }
    // Glass takes SillyTavern's tint into its colour (never its alpha) where relative colours work.
    const glassOnly = tokens => tokens.filter(([name]) => /^--ss-glass/.test(name));
    if (choice.panel === 'glass') {
        const tinted = [
            block(ROOT_SELECTOR, glassOnly(schemeTokens(choice.scheme, 'glass', { strength: choice.strength, tinted: true })), '    '),
            ...SCHEMES.map(s => block(forced(s), glassOnly(schemeTokens(s, 'glass', { strength: choice.strength, tinted: true })), '    ')),
        ];
        out.push(`@supports (color: rgb(from red r g b)) {\n${tinted.join('\n')}\n}`);
    }
    // `reset`: the legacy surfaces go back to SillyTavern's tint (Glass under "reduce transparency" is Solid).
    const solidBlocks = (indent, opaque, reset = []) => [
        block(ROOT_SELECTOR, [...schemeTokens(choice.scheme, 'solid', { opaque }).filter(([name]) => /glass|overlay|blur/.test(name)), ...reset], indent),
        ...SCHEMES.map(s => block(forced(s), schemeTokens(s, 'solid', { opaque }).filter(([name]) => /glass|overlay|blur/.test(name)), indent)),
    ];
    if (choice.panel === 'solid') out.push(`@supports (color: rgb(from red r g b)) {\n${solidBlocks('    ', true).join('\n')}\n}`);
    if (choice.panel === 'glass') {
        out.push(`@media (prefers-reduced-transparency: reduce) {\n${solidBlocks('    ', false, SHEET_RESET).join('\n')}\n}`);
        out.push(`@media (prefers-reduced-transparency: reduce) {\n    @supports (color: rgb(from red r g b)) {\n${solidBlocks('        ', true, SHEET_RESET).join('\n')}\n    }\n}`);
    }
    out.push(`@media (prefers-reduced-motion: reduce) {\n${block(ROOT_SELECTOR, [['--ss-motion', '0s']], '    ')}\n}`);
    return `${out.join('\n')}\n`;
}

// ---- the bridge in the page ------------------------------------------------------------------------

/**
 * createThemeBridge({ doc, settings, readVar }) → { apply(), current(), destroy() }.
 * `settings()` → the host settings ({ panelStyle, glassStrength, font }); `readVar(name)` → a theme
 * variable's value (default: computed on <html>). apply() writes the theme sheet (only when it changed); a
 * change to <html>'s style (SillyTavern applying a theme) applies again.
 */
export function createThemeBridge({ doc = globalThis.document, settings = () => ({}), readVar = null } = {}) {
    const win = doc?.defaultView ?? globalThis;
    const read = readVar ?? (name => {
        try { return String(win.getComputedStyle?.(doc.documentElement)?.getPropertyValue?.(name) ?? '').trim(); } catch { return ''; }
    });
    let last = null;
    let style = null;
    function sheet() {
        if (style?.isConnected !== false && style) return style;
        style = doc.head?.querySelector?.('style[data-ss-theme]') ?? null;
        if (!style) {
            style = doc.createElement('style');
            style.setAttribute('data-ss-theme', '');
            doc.head?.appendChild(style);
        }
        return style;
    }
    function apply() {
        let values = {};
        try { values = settings() ?? {}; } catch { values = {}; }
        const { panel, font, strength } = themeChoice(values);
        const scheme = decideScheme({ body: read('--SmartThemeBodyColor'), tint: read('--SmartThemeBlurTintColor') });
        last = { scheme, panel, font, strength };
        const text = themeCss(last);
        const node = sheet();
        if (node.textContent !== text) node.textContent = text;
        return last;
    }
    let observer = null;
    if (typeof win.MutationObserver === 'function' && doc.documentElement) {
        observer = new win.MutationObserver(() => apply());
        observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
    }
    apply();
    return {
        apply,
        current: () => (last ? { ...last } : null),
        destroy() {
            observer?.disconnect();
            observer = null;
        },
    };
}
