// The meter-presets block shown in Delta's settings fold: preset catalog buttons, their Use/Stop-using state and the one
// setting write path. It keeps the original button construction and ordering.

import { FEATURE_PRESETS } from '../../npc-meters.js';
import { presetIds } from '../../npc-meters-presets.js';

export function createPresetsPart(session, deps) {
    const { catalog, doc, MODULE_ID, part, storedSettings, warn } = deps;

    // ---- the meter presets (settings section) ----

    // A block of buttons above Delta's panel: each preset with its description and Use / Stop using.
    // It writes only the `presets` setting (no schema row shows it, so no stale row can overwrite it).
    function presetsBlock(api) {
        if (typeof doc?.createElement !== 'function') return null;
        const root = doc.createElement('div');
        root.className = 'npc-state-delta-v2-presets';
        const read = () => {
            try { return presetIds((api?.values?.() ?? storedSettings())?.presets); } catch { return []; }
        };
        const write = ids => {
            try {
                if (typeof api?.set === 'function') api.set('presets', ids);
                else session.sdkRef?.settings?.set?.(MODULE_ID, 'presets', ids);
            } catch (error) { warn('Story Suite v2 preset setting failed', error); }
        };
        const draw = () => {
            root.replaceChildren();
            const head = doc.createElement('b');
            // Hidden by style.css inside Delta's own "Meter presets" fold, whose title says it.
            head.className = 'npc-state-delta-v2-presets-head';
            head.textContent = 'Meter presets';
            root.appendChild(head);
            if (!part.featureOn(FEATURE_PRESETS)) {
                const off = doc.createElement('small');
                off.textContent = ' Turned off in Features.';
                root.appendChild(off);
                return;
            }
            const help = doc.createElement('small');
            help.textContent = ' One click adds a set of meters, a stage ladder for the NPCs you give it in the dossier editor, and their limits.';
            root.appendChild(help);
            const used = read();
            for (const preset of catalog()) {
                const row = doc.createElement('div');
                row.className = 'npc-state-delta-v2-preset';
                row.dataset.preset = preset.id;
                const name = doc.createElement('span');
                name.className = 'npc-state-delta-v2-preset-name';
                name.textContent = preset.name;
                const about = doc.createElement('small');
                about.textContent = preset.describe;
                const on = used.includes(preset.id);
                const button = doc.createElement('button');
                button.type = 'button';
                button.className = 'menu_button npc-state-delta-v2-preset-toggle';
                button.textContent = on ? 'Stop using' : 'Use';
                button.setAttribute?.('aria-pressed', on ? 'true' : 'false');
                button.addEventListener?.('click', () => {
                    const now = read();
                    write(now.includes(preset.id) ? now.filter(id => id !== preset.id) : [...now, preset.id]);
                    draw();
                });
                for (const node of [name, about, button]) row.appendChild(node);
                root.appendChild(row);
            }
        };
        try {
            draw();
        } catch (error) {
            warn('Story Suite v2 meter presets could not be shown', error);
            return null;
        }
        return root;
    }

    return { presetsBlock };
}
