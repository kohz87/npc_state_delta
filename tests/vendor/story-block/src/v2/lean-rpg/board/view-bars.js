// The board's Health strips: the text a member or foe bar shows (the stage word and the number, "Hurt · 5/10") and the props of its meter
// (one smooth strip, red, dulled in steps as it empties, view/widgets/dom.js barStep and lean-rpg/view/bars.css). Drawing only: the bar's size
// and value are read from the fight as they are, whatever the size. Pure: no DOM.

/** "Hurt · 5/10": the word, then the blocks left over the bar's size (the word alone when the bar has no size). */
export const barText = (word, value, max) => (max > 0 ? `${word} · ${value}/${max}` : String(word ?? ''));

/** The meter props of a member's or foe's Health strip: `{ label, value, max, tone, text, bar, icon? }`. */
export function healthStrip({ value, max, tone, word, icon }) {
    return { label: 'Health', value, max, tone, text: barText(word, value, max), bar: 'health', ...(icon ? { icon } : {}) };
}
