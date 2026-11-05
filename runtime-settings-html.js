/* NPC State Delta settings panel markup (role: settings-panel-html). buildSettingsHtml, the hints and open-group memory,
   and the controls' sync from the stored settings. Built by index.js once per module instance with the shared runtime
   state and the controller functions it calls. Bodies are moved from index.js without change. */

import { getContext } from '../../../extensions.js';
import { scannerProfileOptions } from './scanner-routing.js';
import { NPC_STATE_VERSION, PORTRAIT_STYLE_PROMPT_LIMIT, PORTRAIT_COMPOSITION_PROMPT_LIMIT } from './core.js';
import { SUITE_AREAS } from './suite-handshake.js';
import { escapeHtml } from './src/util/html.js';
import { PORTRAIT_THEME_PRESETS, getSettings } from './runtime-settings.js';

export function createSettingsHtmlPart(rt, deps) {
    const { applyLauncherFlag, effectivePresentCastChoice, portraitSettingsSnapshot, syncSuiteControls, UI_ID, updatePortraitSettingsSaveUi, writePortraitSettingsDraftToUi } = deps;

    function settingRow(id, label, control, hint = '') {
        return `<label class="npc-state-delta-setting-row story-suite-row" for="${id}"><span><b>${label}</b>${hint ? `<small>${hint}</small>` : ''}</span>${control}</label>`;
    }

    function numberControl(id, min, max, unit = '', { step = '', prefix = '' } = {}) {
        return `<span class="delta-setting-number story-suite-number">${prefix}<input id="${id}" type="number" min="${min}" max="${max}"${step ? ` step="${step}"` : ''} class="text_pole npc-state-delta-number">${unit ? `<small>${unit}</small>` : ''}</span>`;
    }

    function settingsGroup(key, title, hint, body, { hidden = false } = {}) {
        return `<details class="delta-settings-group story-suite-fold" data-delta-settings-group="${key}"${hidden ? ' hidden' : ''}><summary><b>${title}</b>${hint ? `<small>${hint}</small>` : ''}</summary><div class="delta-settings-group-body story-suite-fold-body">${body}</div></details>`;
    }

    const SUITE_AREA_LABELS = Object.freeze({
        npc: 'NPCs',
        calendar: 'Calendar',
        scene: 'Scene (live mood, outfit)',
        stats: 'Game stats',
    });

    function settingsSlot(name) {
        return `<div class="delta-settings-slot" data-delta-settings-slot="${name}"></div>`;
    }

    // The Extensions-tab panel is built once here in its final grouped shape. Optional owners
    // (full cast, scanner output, calendar) mount their own controls into the named slots.
    function buildSettingsHtml() {
        const scanning = [
            settingRow('npc_state_delta_scanner_connection_profile', 'Scanner connection profile', '<select id="npc_state_delta_scanner_connection_profile" class="text_pole"></select>', 'Routes every NPC scan, Refresh, focused pass and retry. Default keeps the current roleplay route; an unavailable profile never falls back silently.<span id="npc_state_delta_scanner_profile_none" class="npc-state-delta-scanner-profile-none" hidden> There is no connection profile yet: make one in SillyTavern\'s Connection Manager and it is listed here.</span>'),
            settingRow('npc_state_delta_full_scan_every_turn', 'Full scan every turn', '<input id="npc_state_delta_full_scan_every_turn" type="checkbox">', 'With Auto scan, reconcile the whole scan context after every reply instead of only the latest exchange. Overrides Scan every; relationship deltas still come only from the newest exchange.'),
            settingRow('npc_state_delta_narration_capture', 'One-pass narration capture (experimental)', '<input id="npc_state_delta_narration_capture" type="checkbox">', 'With Auto scan, the roleplay model ends each reply with a hidden NPC update block that replaces the separate scan request. Adds about 2,000-3,000 tokens to every roleplay prompt plus the block to each reply; a missing or broken block falls back to the normal scan. Not used with Full scan every turn.'),
            settingRow('npc_state_delta_narration_capture_compact', 'Compact one-pass instruction', '<input id="npc_state_delta_narration_capture_compact" type="checkbox">', 'With one-pass capture, the same rules in fewer words: about 1,500 tokens instead of 2,000 on every asked-for reply. Every field, gate and cap is kept, but check the blocks your model writes before relying on it; off sends the full rules.'),
            settingRow('npc_state_delta_narration_capture_catch_up', 'One-pass catch-up', numberControl('npc_state_delta_narration_capture_catch_up', 0, 50, 'replies'), 'With one-pass capture, every this many captured replies the two NPCs most in them get a quiet Refresh (one scanner request each) for mannerisms, levers and memories. 0 turns it off.'),
            settingsSlot('full-cast'),
            settingRow('npc_state_delta_scan_every', 'Scan every', numberControl('npc_state_delta_scan_every', 1, 20, 'replies'), 'Safety scan cadence when Full scan every turn is off. A reply that names someone new, a tracked person or an NPC State line scans at once; a quiet reply waits for this many replies, and the scan then reads every reply since the last one.'),
            settingRow('npc_state_delta_admission_mode', 'NPC admission', '<select id="npc_state_delta_admission_mode" class="text_pole"><option value="conservative">Conservative</option><option value="balanced">Balanced</option><option value="manual_only">Manual only</option></select>', 'Conservative: proper names immediately, role labels after recurrence. Balanced: also direct or persistent role NPCs. Manual only: every dossier needs Add NPC.'),
        ].join('');
        const roster = `
        <h4 class="delta-settings-subhead story-suite-subhead">In-chat display</h4>
        ${settingRow('npc_state_delta_present_cast_display', 'Present NPCs in chat', '<select id="npc_state_delta_present_cast_display" class="text_pole"><option value="full">Full cards</option><option value="compact">Compact strip</option><option value="storyblock">Only in Story Block</option><option value="off">Off</option></select>', 'Shown under the latest reply (or as a Megumin tab). With Story Block installed, Present NPCs and Dossiers tabs also appear in its sidebar, and until you pick a choice here the chat shows them only there; Only in Story Block keeps the chat clear (full cards without Story Block). Tapping an NPC opens its dossier. Off adds nothing to the chat; presence tracking and injection are unaffected.')}
        <div class="npc-state-delta-v2-hosted-hide">${settingRow('npc_state_delta_launcher_with_story_block', 'Floating button with Story Block', '<input id="npc_state_delta_launcher_with_story_block" type="checkbox">', 'Story Block\'s sidebar has the Present NPCs and Dossiers tabs, so the floating npc state button hides while it is there. Turn on to keep the button as well.')}</div>
        <div class="npc-state-delta-v2-hosted-only">${settingRow('npc_state_delta_launcher_with_story_block_v2', 'Show NSD\'s own launcher with Story Block v2', '<input id="npc_state_delta_launcher_with_story_block_v2" type="checkbox">', 'Story Block v2 has Delta\'s Cast tab and its overlay, so the floating npc state button hides while it is there. Turn on to keep the button as well.')}</div>
        <h4 class="delta-settings-subhead story-suite-subhead">Generation injection</h4>
        ${settingRow('npc_state_delta_inject', 'Inject present NPC state', '<input id="npc_state_delta_inject" type="checkbox">', 'Only active NPCs present in the latest scanned scene are injected into generation.')}
        ${settingsSlot('relationship-map')}
        <h4 class="delta-settings-subhead story-suite-subhead">Custom fields</h4>
        ${settingRow('npc_state_delta_custom_fields', 'Custom fields', '<input id="npc_state_delta_custom_fields" class="text_pole" maxlength="260" placeholder="Level, Class, Faction">', 'Up to 6 names, comma-separated, tracked on every dossier. The scanner fills a value only when the story states it, keeps it until it is explicitly changed, and it is sent with present NPCs. Leave empty to turn off.')}
        <small id="npc_state_delta_custom_fields_stats_warning" class="npc-state-delta-suite-warning story-suite-notice" role="status" hidden></small>
        <h4 class="delta-settings-subhead story-suite-subhead">Roster lifecycle</h4>
        ${settingRow('npc_state_delta_max', 'Maximum active NPCs', numberControl('npc_state_delta_max', 1, 100), 'Archived dossiers do not use an active slot.')}
        ${settingRow('npc_state_delta_archive_deaths', 'Archive confirmed deaths', '<input id="npc_state_delta_archive_deaths" type="checkbox">', 'Explicit current-timeline deaths archive instead of deleting. Ambiguous death language is ignored.')}
        ${settingRow('npc_state_delta_reactivate_archived', 'Reactivate on clear return', '<input id="npc_state_delta_reactivate_archived" type="checkbox">', 'Manual archives return when the NPC clearly reappears. Death archives need an explicit living return.')}
        <div class="npc-state-delta-v2-hosted-only">${settingRow('npc_state_delta_layered_secrets', 'Hidden notes for new people', '<input id="npc_state_delta_layered_secrets" type="checkbox">', 'When a scan builds a new dossier it also writes 2 to 5 layered hidden notes (light to deep; each opens at a rising meter value or on a story event), fitted to the background and fixed once written. The story is told them while the person is present, never to reveal; you see only that a note is hidden until it opens. Off: new people get none (existing notes stay).')}</div>
        <h4 class="delta-settings-subhead story-suite-subhead">Stale cleanup</h4>
        ${settingRow('npc_state_delta_auto_prune_stale', 'Auto-manage stale NPCs', '<input id="npc_state_delta_auto_prune_stale" type="checkbox">', 'Long-absent NPCs auto-archive, then stale auto-archives are deleted later. Manual, death and protected records are kept; deleted names can be rediscovered.')}
        ${settingRow('npc_state_delta_stale_archive_after', 'Auto-archive after', numberControl('npc_state_delta_stale_archive_after', 10, 999, 'replies'), 'Default 30. Replies since the NPC was last present or active off-screen.')}
        ${settingRow('npc_state_delta_stale_delete_after', 'Auto-delete after', numberControl('npc_state_delta_stale_delete_after', 11, 1000, 'replies'), 'Default 50. Applies only to stale auto-archives.')}`;
        // (1.2.15) Settings most readers never touch, folded together so the everyday ones stay short.
        // UI only: every key, default and control id is the same as before.
        const advanced = [
            settingRow('npc_state_delta_scan_depth', 'Scan context', numberControl('npc_state_delta_scan_depth', 2, 30, 'messages'), 'History window for full, manual and Refresh scans. Quick automatic scans read every reply since the last scan (up to 30 messages at a time; the oldest first when more are waiting).'),
            settingsSlot('scanner-output'),
            settingRow('npc_state_delta_inject_limit', 'NPCs in the dossier', numberControl('npc_state_delta_inject_limit', 1, 12, 'NPCs'), 'At most this many present NPCs go into the live dossier each reply, the most relevant first (default 3).'),
            settingRow('npc_state_delta_inject_budget', 'Injection budget', numberControl('npc_state_delta_inject_budget', 512, 6000, 'tokens', { step: 100, prefix: '<small>~</small>' }), 'Upper limit; only what the present NPCs need is used. The default 4000 lets detailed dossiers reach the roleplay model in full. When it runs short, lower-priority fields, then lower-ranked NPCs, are trimmed first.'),
            settingRow('npc_state_delta_mid_delete_rewind', 'Rewind dossiers on middle deletion', '<input id="npc_state_delta_mid_delete_rewind" type="checkbox">', 'Off (default): deleting a message from the middle undoes only what that message changed and keeps later changes. On: every dossier rewinds to how it was just before the deleted message, discarding what later messages changed (no model requests).'),
            settingRow('npc_state_delta_branch_rescan', 'Rescan changed branches', '<input id="npc_state_delta_branch_rescan" type="checkbox">', 'Re-evaluate the surviving branch after a swipe, edit or middle-message deletion.'),
        ].join('');
        const suite = `
        <p class="npc-state-delta-muted">With Story Block or Story Director installed, each area has one source of truth so the model is not told the same thing twice. Automatic lets the specialist lead (Story Block the scene and game stats, Story Director the calendar; Delta the NPCs). Alone, every choice behaves like Automatic.</p>
        ${SUITE_AREAS.map(area => settingRow(`npc_state_delta_source_${area}`, SUITE_AREA_LABELS[area], `<select id="npc_state_delta_source_${area}" class="text_pole" data-delta-source-area="${area}"><option value="auto">Automatic</option><option value="mine">This extension</option><option value="theirs">The other one</option></select>`, `<span data-delta-source-status="${area}"></span>`)).join('')}`;
        const portrait = `
        <p class="npc-state-delta-muted">Builds positive and negative prompts from the dossier for the native SillyTavern Image Generation handoff. The configured image backend (including ComfyUI) stays host-owned.</p>
        ${settingRow('npc_state_delta_portrait_generation_enabled', 'Enable Generate Portrait', '<input id="npc_state_delta_portrait_generation_enabled" type="checkbox">', 'Enables Generate Portrait in the dossier Portrait tool. Fails safely without changing the dossier if Image Generation is unavailable.')}
        <label class="npc-state-delta-rubric-label" for="npc_state_delta_portrait_theme_preset"><b>Theme preset</b><small>Built-ins are fixed starting points. Custom Library uses one of your saved presets.</small></label>
        <select id="npc_state_delta_portrait_theme_preset" class="text_pole">${Object.entries(PORTRAIT_THEME_PRESETS).map(([key, item]) => `<option value="${key}">${escapeHtml(item.label)}</option>`).join('')}</select>
        <div class="npc-state-delta-custom-preset-library">
          <label class="npc-state-delta-rubric-label" for="npc_state_delta_portrait_custom_preset"><b>Custom preset</b><small id="npc_state_delta_portrait_custom_preset_count"></small></label>
          <select id="npc_state_delta_portrait_custom_preset" class="text_pole"></select>
          <div class="npc-state-delta-custom-preset-actions">
            <div id="npc_state_delta_portrait_custom_add" class="menu_button"><i class="fa-solid fa-plus"></i> Add</div>
            <div id="npc_state_delta_portrait_custom_duplicate" class="menu_button"><i class="fa-solid fa-copy"></i> Duplicate</div>
            <div id="npc_state_delta_portrait_custom_rename" class="menu_button"><i class="fa-solid fa-pen"></i> Rename</div>
            <div id="npc_state_delta_portrait_custom_delete" class="menu_button redWarningBG"><i class="fa-solid fa-trash"></i> Delete</div>
          </div>
          <small class="npc-state-delta-muted">Each custom preset stores positive, negative, composition, prompt format, mood and location. Gallery saving stays global.</small>
        </div>
        <label class="npc-state-delta-rubric-label" for="npc_state_delta_portrait_style_positive"><b>Positive style / theme</b><small>House style keywords, e.g. anime key visual, painterly fantasy or model-specific tags.</small></label>
        <textarea id="npc_state_delta_portrait_style_positive" class="text_pole npc-state-delta-rubric-textarea" rows="3" maxlength="${PORTRAIT_STYLE_PROMPT_LIMIT}"></textarea>
        <label class="npc-state-delta-rubric-label" for="npc_state_delta_portrait_style_negative"><b>Negative prompt</b><small>Quality, anatomy, composition or style exclusions for every portrait.</small></label>
        <textarea id="npc_state_delta_portrait_style_negative" class="text_pole npc-state-delta-rubric-textarea" rows="3" maxlength="${PORTRAIT_STYLE_PROMPT_LIMIT}"></textarea>
        <label class="npc-state-delta-rubric-label" for="npc_state_delta_portrait_composition"><b>Portrait composition</b><small>Framing, kept separate from appearance so dossiers never need rewriting.</small></label>
        <textarea id="npc_state_delta_portrait_composition" class="text_pole npc-state-delta-rubric-textarea" rows="2" maxlength="${PORTRAIT_COMPOSITION_PROMPT_LIMIT}"></textarea>
        ${settingRow('npc_state_delta_portrait_prompt_format', 'Prompt format', '<select id="npc_state_delta_portrait_prompt_format" class="text_pole"><option value="hybrid">Structured hybrid</option><option value="tags">Comma tags</option><option value="natural">Natural language</option></select>', 'Hybrid groups dossier facts with theme tags; Tags suits SD/anime checkpoints; Natural suits natural-language models (Flux, Krea, SD3-class).')}
        ${settingRow('npc_state_delta_portrait_use_mood', 'Use current mood', '<input id="npc_state_delta_portrait_use_mood" type="checkbox">', 'Adds current mood as expression. Personality and Background never enter the image prompt.')}
        ${settingRow('npc_state_delta_portrait_use_location', 'Use current location', '<input id="npc_state_delta_portrait_use_location" type="checkbox">', 'Off by default so portraits stay character-focused.')}
        ${settingRow('npc_state_delta_portrait_save_gallery', 'Also save to ST character gallery', '<input id="npc_state_delta_portrait_save_gallery" type="checkbox">', 'Off by default. Only the result you choose becomes the dossier portrait either way.')}
        <div class="npc-state-delta-actions npc-state-delta-tuning-actions">
          <div id="npc_state_delta_reset_portrait_theme" class="menu_button"><i class="fa-solid fa-rotate-left"></i> Reset Fantasy Anime style</div>
          <div id="npc_state_delta_save_portrait_settings" class="menu_button"><i class="fa-solid fa-floppy-disk"></i> Save prompt settings</div>
          <small id="npc_state_delta_portrait_settings_status" class="npc-state-delta-muted">Saved</small>
        </div>`;
        const rules = `
        <section class="delta-settings-subsection npc-state-delta-relationship-rules">
          <h4>Relationship scoring</h4>
          <p class="npc-state-delta-muted">The scanner proposes deltas; code applies them and clamps each stat to its impact-tier cap. Stats run from -100 to +100 around neutral 0. Starting values affect new NPCs only.</p>
          <div class="npc-state-delta-tuning-grid">
            <div class="npc-state-delta-tuning-group"><b>New NPC starting values</b>
              <label>Trust <input id="npc_state_delta_base_trust" type="number" min="-100" max="100" class="text_pole npc-state-delta-number"></label>
              <label>Affection <input id="npc_state_delta_base_affection" type="number" min="-100" max="100" class="text_pole npc-state-delta-number"></label>
              <label>Desire <input id="npc_state_delta_base_desire" type="number" min="-100" max="100" class="text_pole npc-state-delta-number"></label>
              <label>Tension <input id="npc_state_delta_base_tension" type="number" min="-100" max="100" class="text_pole npc-state-delta-number"></label>
            </div>
            <div class="npc-state-delta-tuning-group"><b>Maximum ± change per scan</b>
              <label>Ordinary <input id="npc_state_delta_cap_ordinary" type="number" min="0" max="25" class="text_pole npc-state-delta-number"></label>
              <label>Meaningful <input id="npc_state_delta_cap_meaningful" type="number" min="0" max="35" class="text_pole npc-state-delta-number"></label>
              <label>Major <input id="npc_state_delta_cap_major" type="number" min="0" max="50" class="text_pole npc-state-delta-number"></label>
              <label>Extreme <input id="npc_state_delta_cap_extreme" type="number" min="0" max="100" class="text_pole npc-state-delta-number"></label>
            </div>
          </div>
          <label class="npc-state-delta-rubric-label" for="npc_state_delta_relationship_criteria"><b>Relationship stat criteria</b><small>Sent to the private dossier scanner. Adjust the definitions and evidence rules for your RP.</small></label>
          <textarea id="npc_state_delta_relationship_criteria" class="text_pole npc-state-delta-rubric-textarea" rows="7"></textarea>
          <label class="npc-state-delta-rubric-label" for="npc_state_delta_impact_criteria"><b>Impact-tier criteria</b><small>What counts as ordinary, meaningful, major or extreme. Code caps apply even if the model proposes more.</small></label>
          <textarea id="npc_state_delta_impact_criteria" class="text_pole npc-state-delta-rubric-textarea" rows="6"></textarea>
          <div class="npc-state-delta-actions npc-state-delta-tuning-actions"><div id="npc_state_delta_reset_relationship_rules" class="menu_button"><i class="fa-solid fa-rotate-left"></i> Reset relationship rules</div></div>
        </section>
        <section class="delta-settings-subsection npc-state-delta-memory-rules">
          <h4>Important memories</h4>
          <p class="npc-state-delta-muted">Decides which established events become persistent Important memories during scans and backfills. Existing memories are shown to the scanner to avoid duplicates.</p>
          <label class="npc-state-delta-rubric-label" for="npc_state_delta_memory_criteria"><b>Important memory criteria</b><small>Keep routine dialogue, transient feelings and moment-to-moment Inner Chatter out unless you intend otherwise.</small></label>
          <textarea id="npc_state_delta_memory_criteria" class="text_pole npc-state-delta-rubric-textarea" rows="7"></textarea>
          <div class="npc-state-delta-actions npc-state-delta-tuning-actions"><div id="npc_state_delta_reset_memory_rules" class="menu_button"><i class="fa-solid fa-rotate-left"></i> Reset memory criteria</div></div>
        </section>
        <section class="delta-settings-subsection npc-state-delta-behavior-rules">
          <h4>Behavior expression</h4>
          <p class="npc-state-delta-muted">Injected only with present NPCs. Personality, Behavioral profile, Speech and Mannerisms stay authoritative; relationship stats only tint player-specific expression and never imply obedience or a romance archetype.</p>
          <label class="npc-state-delta-rubric-label" for="npc_state_delta_behavior_criteria"><b>Relationship-to-behavior rubric</b><small>Edit if your RP uses different behavioral assumptions.</small></label>
          <textarea id="npc_state_delta_behavior_criteria" class="text_pole npc-state-delta-rubric-textarea" rows="8"></textarea>
          <div class="npc-state-delta-actions npc-state-delta-tuning-actions"><div id="npc_state_delta_reset_behavior_rules" class="menu_button"><i class="fa-solid fa-rotate-left"></i> Reset behavior rubric</div></div>
        </section>`;
        const maintenance = `
        <div class="npc-state-delta-actions delta-settings-maintenance-actions">
          <button type="button" class="menu_button" data-delta-settings-backup><i class="fa-solid fa-file-export"></i> Backup / Export</button>
          <button type="button" class="menu_button" data-delta-settings-restore><i class="fa-solid fa-file-import"></i> Restore / Import</button>
          <button type="button" class="menu_button" data-delta-settings-diagnostics><i class="fa-solid fa-stethoscope"></i> Diagnostics</button>
        </div>
        <details class="delta-settings-current-roster">
          <summary><b>Current chat roster</b><small>Edit, scan, archive or remove individual records</small></summary>
          <div id="npc_state_delta_roster_summary" class="npc-state-delta-roster-summary"></div>
        </details>
        <div class="delta-settings-danger story-suite-danger">
          <span><b>Clear chat dossier</b><small>Removes every NPC record for this chat only.</small></span>
          <div id="npc_state_delta_clear_chat" class="menu_button redWarningBG"><i class="fa-solid fa-trash"></i> Clear</div>
        </div>`;
        // One closed fold for what a reader rarely needs; each part keeps its own fold inside, so its key, its slot and its
        // open state stay as they were. The first line says whether the calendar here matters (syncExpertNote).
        const expert = `<p class="npc-state-delta-muted delta-expert-note" data-delta-expert-note></p>
        ${settingsGroup('suite', 'Source of truth', 'Sharing with other story extensions', suite)}
        ${settingsGroup('calendar', 'Calendar & birthdays', 'Fantasy months and optional campaign clock', settingsSlot('calendar'))}
        ${settingsGroup('rules', 'Scanner rules', 'Advanced relationship, memory and behavior rubrics', rules)}
        ${settingsGroup('sent', "What's sent", 'The text your next reply gets, and its size', `<div class="delta-whats-sent" data-delta-whats-sent><small class="delta-whats-sent-empty">Open this to see it.</small></div><div class="npc-state-delta-actions"><div id="npc_state_delta_sent_refresh" class="menu_button"><i class="fa-solid fa-rotate"></i> Refresh</div></div>`)}
        ${settingsGroup('advanced', 'Advanced', 'Scan context, output and injection limits, branch handling', advanced)}`;
        return `
    <div id="${UI_ID}" class="extension_container npc-state-delta-extension">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>NPC State Delta <span class="npc-state-delta-version">v${NPC_STATE_VERSION}</span></b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content npc-state-delta-drawer story-suite-panel">
          <div id="npc_state_delta_suite_manage" class="npc-state-delta-suite-manage story-suite-manage" data-story-suite-link hidden>
            <button type="button" class="menu_button" data-delta-open-suite><i class="fa-solid fa-layer-group"></i> Manage all in Story Suite</button>
          </div>
          <div class="delta-settings-quickbar story-suite-quickbar">
            <div class="delta-settings-quick-toggles">
              ${settingRow('npc_state_delta_enabled', 'Enable NPC State Delta', '<input id="npc_state_delta_enabled" type="checkbox">')}
              ${settingRow('npc_state_delta_auto', 'Auto scan', '<input id="npc_state_delta_auto" type="checkbox">', 'Runs after assistant replies.')}
            </div>
            <div class="npc-state-delta-actions delta-settings-quick-actions story-suite-actions">
              <button type="button" class="menu_button" data-delta-settings-open-dossiers><i class="fa-solid fa-address-book"></i> Open dossiers</button>
              <div id="npc_state_delta_scan_now" class="menu_button"><i class="fa-solid fa-wand-magic-sparkles"></i> Scan dossier now</div>
              ${settingsSlot('full-cast-action')}
              <div id="npc_state_delta_add_manual" class="menu_button"><i class="fa-solid fa-user-plus"></i> Add NPC</div>
            </div>
          </div>
          <div class="delta-settings-experience story-suite-folds">
            ${settingsGroup('scanning', 'Scanning', 'Connection, cadence and admission', scanning)}
            ${settingsGroup('roster', 'Roster & continuity', 'Injection, lifecycle and stale cleanup', roster)}
            ${settingsGroup('presets', 'Meter presets', 'One-click meter sets (Companion, Rival, Mentor)', settingsSlot('meter-presets'), { hidden: true })}
            ${settingsGroup('portrait', 'Portrait generation', 'Image Generation prompts and style', portrait)}
            ${settingsGroup('maintenance', 'Data & maintenance', 'Backup, diagnostics and this chat', maintenance)}
            ${settingsGroup('expert', 'Expert', "Source of truth, calendar, scanner rules, what's sent, advanced", expert)}
          </div>
        </div>
      </div>
    </div>`;
    }

    const SETTINGS_OPEN_GROUPS_KEY = 'npc_state_delta_settings_open_groups';
    const DEFAULT_OPEN_SETTINGS_GROUPS = ['scanning'];

    function readOpenSettingsGroups() {
        try {
            const raw = globalThis.localStorage?.getItem?.(SETTINGS_OPEN_GROUPS_KEY);
            const parsed = raw ? JSON.parse(raw) : null;
            return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : DEFAULT_OPEN_SETTINGS_GROUPS;
        } catch {
            return DEFAULT_OPEN_SETTINGS_GROUPS;
        }
    }

    // (1.2.14) A long setting hint reads as its first sentence; "more" shows the rest in place. The
    // rows come from several modules (some fill their slots later), so hints are compacted when a
    // group opens. Presentation only: every setting, its key and its text stay as they are.
    const HINT_COMPACT_CHARS = 110;
    function compactSettingHints(root) {
        for (const small of root?.querySelectorAll?.('.npc-state-delta-setting-row > span:first-child > small:not([data-delta-hint])') || []) {
            small.dataset.deltaHint = '1';
            if (small.children?.length) continue;
            const text = String(small.textContent || '').trim();
            const split = text.length > HINT_COMPACT_CHARS ? text.match(/^(.{20,160}?[.!?])\s+(\S[\s\S]*)$/) : null;
            if (!split) continue;
            const rest = document.createElement('span');
            rest.className = 'delta-hint-rest';
            rest.textContent = ` ${split[2]}`;
            const more = document.createElement('span');
            more.className = 'delta-hint-more';
            more.setAttribute('role', 'button');
            more.setAttribute('tabindex', '0');
            more.textContent = 'more';
            small.title = text;
            small.replaceChildren(document.createTextNode(split[1]), rest, document.createTextNode(' '), more);
        }
    }

    function toggleSettingHint(event) {
        const more = event.target?.closest?.('.delta-hint-more');
        if (!more) return;
        if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
        // Inside the row's label: keep the click from toggling the setting.
        event.preventDefault();
        event.stopPropagation();
        const small = more.parentElement;
        const open = !small.classList.contains('is-open');
        small.classList.toggle('is-open', open);
        more.textContent = open ? 'less' : 'more';
    }

    // Remember which settings groups the player keeps open; presentation only, never canonical state.
    function bindSettingsGroupMemory(root) {
        const groups = [...(root?.querySelectorAll?.('[data-delta-settings-group]') || [])];
        const open = new Set(readOpenSettingsGroups());
        for (const group of groups) group.open = open.has(group.dataset.deltaSettingsGroup);
        for (const group of groups) if (group.open) setTimeout(() => compactSettingHints(group), 0);
        root?.addEventListener?.('click', toggleSettingHint, true);
        root?.addEventListener?.('keydown', toggleSettingHint, true);
        root?.addEventListener?.('toggle', event => {
            if (!event.target?.matches?.('[data-delta-settings-group]')) return;
            if (event.target.open) compactSettingHints(event.target);
            if (event.target.open && event.target.matches('[data-delta-settings-group="expert"]')) syncExpertNote(event.target);
            const next = groups.filter(group => group.open).map(group => group.dataset.deltaSettingsGroup);
            try { globalThis.localStorage?.setItem?.(SETTINGS_OPEN_GROUPS_KEY, JSON.stringify(next)); } catch { /* optional */ }
        }, true);
    }

    function syncScannerProfileControl() {
        const control = $('#npc_state_delta_scanner_connection_profile');
        if (!control.length) return;
        const selected = getSettings().scannerConnectionProfile;
        const html = scannerProfileOptions(getContext(), selected)
            .map(option => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.name)}</option>`).join('');
        if (control.html() !== html) control.html(html);
        control.val(selected);
        // No profile to pick (only the current connection, or a missing one): say so under the list.
        const usable = scannerProfileOptions(getContext(), '').length > 1;
        $('#npc_state_delta_scanner_profile_none').prop('hidden', usable);
    }

    // The Expert fold's first line: whether the calendar in Delta's settings matters. It says the Story Director sentence only
    // while that is true (Story Director's calendar answers and the reader has not kept the calendar here).
    const EXPERT_NOTES = Object.freeze({
        'story-director': 'Rarely needed. With Story Director installed its calendar is used, so the calendar here only matters on its own.',
        own: "Rarely needed. You keep the calendar here (Source of truth), so Story Director's calendar is not used.",
        none: 'Rarely needed. No Story Director calendar is linked, so the calendar here is the one in use.',
    });
    function syncExpertNote(root = globalThis.document) {
        const note = root?.querySelector?.('[data-delta-expert-note]');
        if (!note) return;
        let link = 'none';
        try { link = rt.storySuiteV2?.calendarLink?.() ?? 'none'; } catch { link = 'none'; }
        const text = EXPERT_NOTES[link] ?? EXPERT_NOTES.none;
        if (note.textContent !== text) note.textContent = text;
    }

    function syncSettingsControls() {
        syncExpertNote();
        const s = getSettings();
        $('#npc_state_delta_enabled').prop('checked', !!s.enabled);
        $('#npc_state_delta_auto').prop('checked', !!s.autoScan);
        syncScannerProfileControl();
        $('#npc_state_delta_full_scan_every_turn').prop('checked', !!s.fullScanEveryTurn);
        $('#npc_state_delta_narration_capture').prop('checked', !!s.narrationCapture);
        $('#npc_state_delta_narration_capture_compact').prop('checked', !!s.narrationCaptureCompact);
        $('#npc_state_delta_scan_every').val(s.scanEvery);
        $('#npc_state_delta_scan_depth').val(s.scanDepth);
        $('#npc_state_delta_narration_capture_catch_up').val(s.narrationCaptureCatchUp);
        $('#npc_state_delta_admission_mode').val(s.admissionMode);
        $('#npc_state_delta_max').val(s.maxNpcs);
        $('#npc_state_delta_auto_prune_stale').prop('checked', s.autoPruneStale !== false);
        $('#npc_state_delta_stale_archive_after').val(s.staleArchiveAfter);
        $('#npc_state_delta_stale_delete_after').val(s.staleDeleteAfter);
        $('#npc_state_delta_inject').prop('checked', !!s.inject);
        $('#npc_state_delta_inject_budget').val(s.injectBudgetTokens);
        $('#npc_state_delta_inject_limit').val(s.injectLimit);
        $('#npc_state_delta_custom_fields').val((s.customFieldNames || []).join(', '));
        syncSuiteControls();
        $('#npc_state_delta_archive_deaths').prop('checked', s.autoArchiveDeaths !== false);
        $('#npc_state_delta_reactivate_archived').prop('checked', s.autoReactivateArchived !== false);
        $('#npc_state_delta_layered_secrets').prop('checked', s.layeredSecrets !== false);
        $('#npc_state_delta_branch_rescan').prop('checked', s.branchRescan !== false);
        $('#npc_state_delta_mid_delete_rewind').prop('checked', s.midDeleteRewind === true);
        $('#npc_state_delta_present_cast_display').val(effectivePresentCastChoice());
        $('#npc_state_delta_launcher_with_story_block').prop('checked', s.launcherWithStoryBlock === true);
        $('#npc_state_delta_launcher_with_story_block_v2').prop('checked', s.launcherWithStoryBlockV2 === true);
        applyLauncherFlag();
        if (!rt.portraitSettingsDirty) writePortraitSettingsDraftToUi(portraitSettingsSnapshot(s));
        updatePortraitSettingsSaveUi();
        $('#npc_state_delta_base_trust').val(s.relationshipBaseline.trust);
        $('#npc_state_delta_base_affection').val(s.relationshipBaseline.affection);
        $('#npc_state_delta_base_desire').val(s.relationshipBaseline.desire);
        $('#npc_state_delta_base_tension').val(s.relationshipBaseline.tension);
        $('#npc_state_delta_cap_ordinary').val(s.relationshipCaps.ordinary);
        $('#npc_state_delta_cap_meaningful').val(s.relationshipCaps.meaningful);
        $('#npc_state_delta_cap_major').val(s.relationshipCaps.major);
        $('#npc_state_delta_cap_extreme').val(s.relationshipCaps.extreme);
        $('#npc_state_delta_relationship_criteria').val(s.relationshipCriteria);
        $('#npc_state_delta_impact_criteria').val(s.relationshipImpactCriteria);
        $('#npc_state_delta_memory_criteria').val(s.memoryCriteria);
        $('#npc_state_delta_behavior_criteria').val(s.behaviorCriteria);
    }

    return { buildSettingsHtml, bindSettingsGroupMemory, syncScannerProfileControl, syncSettingsControls };
}
