// Draws the fight-board settings: the shared feature switch, Auto-fight's cap slider and the pre-check's switch (Settings → RPG → Fight board).
// The feature store is the single source of truth for the switch; the cap is the `rpgAutoCap` setting, 1 to 8 or "Until the end".
import { h } from '../../view/widgets/dom.js';
import { switchField } from '../../view/form/fields.js';
import { AUTO_CAP } from '../names.js';

/** The slider's words for a stop: "3 exchanges", "1 exchange" or "Until the end". */
export const capWords = value => (value >= AUTO_CAP.end ? 'Until the end' : `${value} exchange${value === 1 ? '' : 's'}`);

/**
 * The cap slider card. `cap` is `{ value, set(n) }` (value held to 1..9 by the caller); `set` runs once the slider is let go.
 * The chosen value shows above the slider, which has 1 to 8 and "Until the end" as its last stop.
 */
export function capSetting(doc, cap) {
    const box = h(doc, 'div', 'rpg-board-setting rpg-board-cap');
    box.setAttribute('data-card', 'auto-cap');
    box.appendChild(h(doc, 'b', '', 'Auto-fight: most exchanges per reply'));
    const row = h(doc, 'div', 'rpg-board-cap-row');
    const shown = h(doc, 'b', 'rpg-board-cap-value', capWords(cap.value));
    row.append(shown, h(doc, 'span', 'rpg-set-help', '1 – 8, or until the end'));
    const track = h(doc, 'div', 'ss-slider rpg-board-cap-slider');
    const input = h(doc, 'input', 'ss-slider-input rpg-board-cap-input');
    input.type = 'range';
    input.min = String(AUTO_CAP.min);
    input.max = String(AUTO_CAP.max);
    input.step = '1';
    input.value = String(cap.value);
    input.setAttribute('aria-label', 'Most exchanges per reply');
    // The shared slider paints its filled part from --ss-fill (0..1), like the form engine's slider.
    const fill = () => input.style.setProperty('--ss-fill', String((Number(input.value) - AUTO_CAP.min) / (AUTO_CAP.max - AUTO_CAP.min)));
    fill();
    input.addEventListener('input', () => { shown.textContent = capWords(Number(input.value)); fill(); });
    input.addEventListener('change', () => cap.set(Math.min(AUTO_CAP.max, Math.max(AUTO_CAP.min, Math.round(Number(input.value))))));
    const ends = h(doc, 'div', 'rpg-board-cap-ends');
    for (const word of ['1', '8', 'Until the end']) ends.appendChild(h(doc, 'span', '', word));
    track.appendChild(input);
    box.append(row, track, ends, h(doc, 'p', 'rpg-set-help', 'Auto also stops when a hero takes 2 or more Health blocks in one exchange.'));
    return box;
}

/** The pre-check's switch card (on unless set to false): `precheck` is `{ value, set(on) }`; the words are the approved mockup's. */
export function precheckSetting(doc, precheck) {
    const row = h(doc, 'div', 'rpg-board-setting');
    row.setAttribute('data-card', 'precheck');
    const copy = h(doc, 'div', 'rpg-board-setting-copy');
    copy.appendChild(h(doc, 'b', '', 'Set up a fight from my attack'));
    copy.appendChild(h(doc, 'p', 'rpg-set-help', 'When you type an attack and no foe is standing, a short call on your Assist profile finds the foes, so you fight on the board before the reply. Off: the narrator sets up the foes and the board opens after its reply.'));
    const field = switchField({ doc, ariaLabel: 'Set up a fight from my attack', value: precheck.value, onChange: value => precheck.set(value) });
    row.append(copy, field.el);
    return row;
}

export function boardSetting(doc, feature, changed, cap = null, precheck = null) {
    const row = h(doc, 'div', 'rpg-board-setting');
    row.setAttribute('data-card', 'board');
    const copy = h(doc, 'div', 'rpg-board-setting-copy');
    copy.appendChild(h(doc, 'b', '', 'Fight board'));
    copy.appendChild(h(doc, 'p', 'rpg-set-help', 'Play fights exchange by exchange on the board; one reply tells the whole fight. Standard rules only.'));
    const field = switchField({ doc, ariaLabel: 'Fight board', value: feature.on(), onChange: value => { feature.set(value); changed(); } });
    row.append(copy, field.el);
    if (!cap) return row;
    const both = h(doc, 'div', 'rpg-board-settings');
    both.append(row, capSetting(doc, cap));
    if (precheck) both.appendChild(precheckSetting(doc, precheck));
    return both;
}
