/* NPC State Delta fantasy-calendar settings adapter over the canonical Delta settings object. */
import { extension_settings, getContext } from '../../../extensions.js';
import {
    getActiveCalendarConfig,
    monthDefinitionsText,
    normalizeCalendarConfig,
    parseMonthDefinitions,
    setActiveCalendarConfig,
} from './calendar.js';

const EXTENSION_NAME = 'npc_state_delta';
const ROOT_ID = 'npc_state_delta_calendar_settings';
const SETTINGS_ID = 'npc_state_delta_settings';
let observer = null;

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function settingsObject({ create = false } = {}) {
    const current = extension_settings[EXTENSION_NAME];
    if (current && typeof current === 'object') return current;
    if (!create) return null;
    extension_settings[EXTENSION_NAME] = {};
    return extension_settings[EXTENSION_NAME];
}

function persistedCalendar() {
    const raw = settingsObject()?.calendarConfig;
    const normalized = normalizeCalendarConfig(raw, { requireCurrentDate: false });
    return normalized.valid ? normalized.config : null;
}

function activatePersistedCalendar() {
    return setActiveCalendarConfig(persistedCalendar());
}

function persistHostSettings() {
    const ctx = getContext();
    if (typeof ctx?.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
}

function settingRow(id, label, control, hint = '') {
    return `<label class="npc-state-delta-setting-row" for="${id}"><span><b>${label}</b>${hint ? `<small>${hint}</small>` : ''}</span>${control}</label>`;
}

function savedDraft() {
    const raw = settingsObject()?.calendarConfig;
    if (!raw || typeof raw !== 'object') return { era: '', currentYear: '', currentMonth: '', currentDay: '', monthsText: '' };
    const normalized = normalizeCalendarConfig(raw, { requireCurrentDate: false });
    const months = normalized.config.months;
    return {
        era: String(raw.era ?? normalized.config.era ?? '').trim(),
        currentYear: raw.currentYear ?? raw.current_year ?? raw.year ?? '',
        currentMonth: String(raw.currentMonth ?? raw.current_month ?? raw.month ?? normalized.config.currentMonth ?? '').trim(),
        currentDay: raw.currentDay ?? raw.current_day ?? raw.day ?? '',
        monthsText: monthDefinitionsText(months),
    };
}

function shellHtml() {
    const draft = savedDraft();
    return `<div id="${ROOT_ID}" class="npc-state-delta-calendar-settings">
        <div class="npc-state-delta-calendar-heading"><b>Fantasy calendar & birthdays</b><small>Ordered Month:days definitions are required. Era and the manual campaign clock are optional. Structured World State dates override the manual clock for matching scans.</small></div>
        ${settingRow('npc_state_delta_calendar_era', 'Era / year prefix', `<input id="npc_state_delta_calendar_era" class="text_pole" maxlength="40" placeholder="Optional, e.g. CR" value="${escapeHtml(draft.era)}">`, 'Optional display/calendar label. Example: era CR + year 821 displays as CR821.')}
        ${settingRow('npc_state_delta_calendar_months', 'Months', `<textarea id="npc_state_delta_calendar_months" class="text_pole" rows="6" spellcheck="false" placeholder="Redleaf:30&#10;Sunwane:31&#10;Frostwane:30">${escapeHtml(draft.monthsText)}</textarea>`, 'Required. One Month name:days row per month; row order is calendar order.')}
        ${settingRow('npc_state_delta_calendar_year', 'Manual current year', `<input id="npc_state_delta_calendar_year" class="text_pole npc-state-delta-number" type="number" step="1" value="${escapeHtml(draft.currentYear)}">`, 'Optional fallback clock. Leave year, month, and day all blank if World State supplies the date or if you only need month/day birthdays.')}
        ${settingRow('npc_state_delta_calendar_current_month', 'Manual current month', '<select id="npc_state_delta_calendar_current_month" class="text_pole"></select>', 'Optional fallback clock. If any manual current-date field is set, all three are required.')}
        ${settingRow('npc_state_delta_calendar_current_day', 'Manual current day', `<input id="npc_state_delta_calendar_current_day" class="text_pole npc-state-delta-number" type="number" min="1" step="1" value="${escapeHtml(draft.currentDay)}">`, 'Optional fallback clock. Validated against the selected month length.')}
        <div class="npc-state-delta-calendar-actions">
            <button type="button" id="npc_state_delta_save_calendar" class="menu_button">Save calendar</button>
            <button type="button" id="npc_state_delta_reset_calendar" class="menu_button">Use numeric fallback</button>
            <small id="npc_state_delta_calendar_status" aria-live="polite"></small>
        </div>
    </div>`;
}

function status(root, message, error = false) {
    const target = root?.querySelector?.('#npc_state_delta_calendar_status');
    if (!target) return;
    target.textContent = message;
    target.dataset.error = error ? '1' : '0';
}

function updateMonthOptions(root, preferred = undefined) {
    const textarea = root.querySelector('#npc_state_delta_calendar_months');
    const select = root.querySelector('#npc_state_delta_calendar_current_month');
    const dayInput = root.querySelector('#npc_state_delta_calendar_current_day');
    if (!textarea || !select || !dayInput) return;
    const parsed = parseMonthDefinitions(textarea.value);
    const existing = preferred !== undefined ? preferred : select.value;
    select.replaceChildren();
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '(No manual current month)';
    select.appendChild(blank);
    for (const month of parsed.months) {
        const option = document.createElement('option');
        option.value = month.name;
        option.textContent = `${month.name} (${month.days} days)`;
        select.appendChild(option);
    }
    const match = parsed.months.find(month => month.name.toLocaleLowerCase() === String(existing || '').toLocaleLowerCase());
    select.value = match?.name || '';
    select.disabled = !parsed.months.length;
    const selected = parsed.months.find(month => month.name === select.value);
    if (selected) dayInput.max = String(selected.days);
    else dayInput.removeAttribute('max');
    if (parsed.errors.length) status(root, parsed.errors[0], true);
    else if (parsed.months.length) status(root, `${parsed.months.length} month${parsed.months.length === 1 ? '' : 's'} parsed. Manual current date may remain blank.`, false);
    else status(root, 'Enter at least one Month:days row.', true);
}

function draftFromUi(root) {
    return {
        era: root.querySelector('#npc_state_delta_calendar_era')?.value ?? '',
        currentYear: root.querySelector('#npc_state_delta_calendar_year')?.value ?? '',
        currentMonth: root.querySelector('#npc_state_delta_calendar_current_month')?.value ?? '',
        currentDay: root.querySelector('#npc_state_delta_calendar_current_day')?.value ?? '',
        monthsText: root.querySelector('#npc_state_delta_calendar_months')?.value ?? '',
    };
}

function saveCalendar(root) {
    const validation = normalizeCalendarConfig(draftFromUi(root), { requireCurrentDate: false });
    if (!validation.valid) {
        status(root, validation.errors[0] || 'Calendar settings are incomplete.', true);
        return false;
    }
    const settings = settingsObject({ create: true });
    settings.calendarConfig = {
        era: validation.config.era,
        currentYear: validation.config.currentYear,
        currentMonth: validation.config.currentMonth,
        currentDay: validation.config.currentDay,
        months: validation.config.months.map(month => ({ ...month })),
    };
    setActiveCalendarConfig(settings.calendarConfig);
    persistHostSettings();
    status(root, validation.currentDateValid
        ? 'Calendar applied; settings save queued with a manual fallback current date. Structured World State dates take priority when present.'
        : 'Calendar applied; settings save queued. Birthdays use named months; no birth year or age progression is invented without a grounded current date.', false);
    return true;
}

function resetCalendar(root) {
    const settings = settingsObject({ create: true });
    delete settings.calendarConfig;
    setActiveCalendarConfig(null);
    persistHostSettings();
    const era = root.querySelector('#npc_state_delta_calendar_era');
    const year = root.querySelector('#npc_state_delta_calendar_year');
    const months = root.querySelector('#npc_state_delta_calendar_months');
    const day = root.querySelector('#npc_state_delta_calendar_current_day');
    if (era) era.value = '';
    if (year) year.value = '';
    if (months) months.value = '';
    if (day) day.value = '';
    updateMonthOptions(root, '');
    status(root, 'Custom calendar cleared locally; settings save queued. Numeric birthday compatibility mode is active.', false);
}

function bind(root) {
    const draft = savedDraft();
    updateMonthOptions(root, draft.currentMonth);
    root.querySelector('#npc_state_delta_calendar_months')?.addEventListener('input', () => updateMonthOptions(root));
    root.querySelector('#npc_state_delta_calendar_current_month')?.addEventListener('change', () => updateMonthOptions(root));
    root.querySelector('#npc_state_delta_save_calendar')?.addEventListener('click', () => saveCalendar(root));
    root.querySelector('#npc_state_delta_reset_calendar')?.addEventListener('click', () => resetCalendar(root));
}

function injectStyles() {
    if (!document?.head || document.getElementById(`${ROOT_ID}_style`)) return;
    const style = document.createElement('style');
    style.id = `${ROOT_ID}_style`;
    style.textContent = `
        #${ROOT_ID} { display: contents; }
        #${ROOT_ID} .npc-state-delta-calendar-heading { grid-column: 1 / -1; display:flex; flex-direction:column; gap:3px; margin-top:8px; padding-top:10px; border-top:1px solid rgba(127,127,127,.28); }
        #${ROOT_ID} .npc-state-delta-calendar-heading small { opacity:.72; font-size:.82em; }
        #${ROOT_ID} textarea { min-height:7.5em; resize:vertical; }
        #${ROOT_ID} .npc-state-delta-calendar-actions { grid-column:1 / -1; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
        #${ROOT_ID} #npc_state_delta_calendar_status { opacity:.78; }
        #${ROOT_ID} #npc_state_delta_calendar_status[data-error="1"] { font-weight:600; }
        @media (max-width: 700px) { #${ROOT_ID} .npc-state-delta-calendar-actions > button { min-height:44px; } }
    `;
    document.head.appendChild(style);
}

export function mountCalendarSettings() {
    if (typeof document === 'undefined') return false;
    if (document.getElementById(ROOT_ID)) return true;
    const grid = document.querySelector(`#${SETTINGS_ID} .npc-state-delta-settings-grid`);
    if (!grid) return false;
    injectStyles();
    const wrapper = document.createElement('div');
    wrapper.innerHTML = shellHtml();
    const root = wrapper.firstElementChild;
    grid.appendChild(root);
    bind(root);
    return true;
}

function observeForSettings() {
    if (typeof document === 'undefined' || observer) return;
    if (mountCalendarSettings()) return;
    if (typeof MutationObserver !== 'function' || !document.documentElement) return;
    observer = new MutationObserver(() => {
        if (!mountCalendarSettings()) return;
        observer.disconnect();
        observer = null;
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
}

activatePersistedCalendar();
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observeForSettings, { once: true });
    else observeForSettings();
}

export function calendarSettingsSnapshot() {
    return getActiveCalendarConfig();
}
