/* NPC State Delta dossier header: the ⋯ menu (Edit, Refresh, More: Scan dossier, Portrait, Diagnostics,
 * Archive / Restore / Correct death record). The Dossier / Map tabs and Close stay as they are (relationship-map.js adds the tabs).
 * Pure markup builders: no DOM access and no state. The classes and data-npc-id hooks are the ones
 * today's handlers already use (delegated clicks in dossier-experience.js, runtime-settings-bind.js and
 * the jQuery refresh/scan/archive handlers), so those handlers keep working unchanged.
 */
import { escapeHtml } from './src/util/html.js';

const text = value => String(value ?? '').trim();

// Lifecycle item inside More: deceased is terminal, archived restores, otherwise archive.
export function dossierLifecycleActionHtml(npcId, { archived = false, deceased = false } = {}) {
    const id = escapeHtml(text(npcId));
    if (deceased) return `<button type="button" class="delta-btn npc-state-delta-restore-npc" data-npc-id="${id}">Correct death record</button>`;
    if (archived) return `<button type="button" class="delta-btn npc-state-delta-restore-npc" data-npc-id="${id}">Restore active</button>`;
    return `<button type="button" class="delta-btn npc-state-delta-archive-npc" data-npc-id="${id}">Archive dossier</button>`;
}

// The ⋯ menu for one NPC: Edit and Refresh, then More (Scan, Portrait, Diagnostics, lifecycle).
// Returns '' without an NPC id, because every item acts on one dossier.
export function dossierMenuHtml(npcId, { archived = false, deceased = false, diagnosticsVisible = false } = {}) {
    const id = text(npcId);
    if (!id) return '';
    const attr = escapeHtml(id);
    return `<details class="delta-header-menu">
        <summary class="delta-btn delta-header-menu-toggle ss-tap-pill" aria-label="Dossier actions" title="Dossier actions">⋯</summary>
        <div class="delta-header-menu-list">
            <button type="button" class="delta-btn delta-primary delta-edit" data-npc-id="${attr}">Edit</button>
            <button type="button" class="delta-btn npc-state-delta-refresh-chat" data-npc-id="${attr}">Refresh</button>
            <details class="delta-dossier-more">
                <summary class="delta-btn">More</summary>
                <div class="delta-dossier-more-menu">
                    <button type="button" class="delta-btn npc-state-delta-scan-dossier" data-npc-id="${attr}">Scan dossier</button>
                    <button type="button" class="delta-btn delta-experience-portrait" data-npc-id="${attr}">Portrait</button>
                    <button type="button" class="delta-btn delta-experience-diagnostics" data-npc-id="${attr}">${diagnosticsVisible ? 'Hide diagnostics' : 'Show diagnostics'}</button>
                    ${dossierLifecycleActionHtml(id, { archived, deceased })}
                </div>
            </details>
        </div>
    </details>`;
}
