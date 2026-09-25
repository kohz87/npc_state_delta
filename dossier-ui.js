/* NPC State Delta dossier surface: bounded presentation of canonical state. */
import { normalizeAppearanceModel, resolveNpcAppearance } from './appearance.js';
import { formatBirthDate } from './birthday.js';

const ROOT_ID = 'npc_state_delta_dossier_root';
const STYLE_ID = 'npc_state_delta_dossier_stage1_styles';
const SETTINGS_ID = 'npc_state_delta_settings';
const OBSERVER_RETRY_MS = 750;
const OBSERVER_RETRY_LIMIT = 80;

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function plain(value, fallback = '') {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text || fallback;
}

function stringList(value, limit = 12) {
    return (Array.isArray(value) ? value : [])
        .map(item => plain(item))
        .filter(Boolean)
        .slice(0, limit);
}

function relationshipValue(value) {
    return Math.max(-100, Math.min(100, Math.round(Number(value) || 0)));
}

function portraitSource(npc = {}, portraitAssets = {}) {
    const direct = npc?.portrait && typeof npc.portrait === 'object' ? npc.portrait : {};
    const asset = portraitAssets?.[npc?.id] && typeof portraitAssets[npc.id] === 'object' ? portraitAssets[npc.id] : {};
    return plain(direct.dataUrl || direct.url || direct.src || asset.dataUrl || asset.url || asset.src);
}

export function dossierLifeBucket(npc = {}) {
    const reason = plain(npc?.archiveReason).toLocaleLowerCase();
    const lifeState = plain(npc?.lifeState).toLocaleLowerCase();
    if (reason === 'deceased' || lifeState === 'dead' || lifeState === 'deceased') return 'dead';
    if (npc?.archived === true) return 'archived';
    return 'active';
}

export function dossierStatusLabel(npc = {}) {
    const bucket = dossierLifeBucket(npc);
    if (bucket === 'dead') return 'Deceased';
    if (bucket === 'archived') return plain(npc?.archiveReason).toLocaleLowerCase() === 'stale' ? 'Archived · stale' : 'Archived';
    if (npc?.present === true) return 'In chat';
    if (npc?.worldActive === true) return 'Active off-screen';
    return 'Off-screen';
}

export function dossierIndexProjection(npc = {}, portraitAssets = {}) {
    return {
        id: plain(npc?.id),
        name: plain(npc?.name, 'Unnamed NPC'),
        aliases: stringList(npc?.aliases, 12),
        role: plain(npc?.role),
        species: plain(npc?.species),
        gender: plain(npc?.gender),
        homeBase: plain(npc?.homeBase),
        apparentAge: plain(npc?.apparentAge),
        location: plain(npc?.location),
        status: plain(npc?.status),
        present: npc?.present === true,
        worldActive: npc?.worldActive === true,
        archived: npc?.archived === true,
        archiveReason: plain(npc?.archiveReason),
        lifeState: plain(npc?.lifeState, 'unknown'),
        bucket: dossierLifeBucket(npc),
        statusLabel: dossierStatusLabel(npc),
        portrait: portraitSource(npc, portraitAssets),
        updatedAt: Number(npc?.updatedAt) || 0,
    };
}

export function dossierDetailProjection(npc = {}, portraitAssets = {}) {
    const rel = npc?.relationship && typeof npc.relationship === 'object' ? npc.relationship : {};
    return {
        ...dossierIndexProjection(npc, portraitAssets),
        age: plain(npc?.age),
        appearance: resolveNpcAppearance(npc),
        appearanceModel: normalizeAppearanceModel(npc, { locked: Array.isArray(npc?.manualProfileFields) && npc.manualProfileFields.includes('appearance') }),
        birthday: formatBirthDate(npc?.birthDate),
        birthdaySource: plain(npc?.birthDateSource),
        personality: plain(npc?.personality),
        behaviorProfile: stringList(npc?.behaviorProfile, 10),
        speech: plain(npc?.speech),
        mannerisms: stringList(npc?.mannerisms, 10),
        background: plain(npc?.background),
        memories: stringList(npc?.memories, 8),
        keyRelationships: stringList(npc?.keyRelationships, 12),
        relationshipSummary: plain(npc?.relationshipSummary),
        relationship: {
            trust: relationshipValue(rel.trust),
            affection: relationshipValue(rel.affection),
            desire: relationshipValue(rel.desire),
            tension: relationshipValue(rel.tension),
        },
        mood: plain(npc?.mood),
        goal: plain(npc?.goal),
        lifeStateCertainty: plain(npc?.lifeStateCertainty),
        lifeStateReason: plain(npc?.lifeStateReason),
    };
}

export function sortDossierIndex(rows = []) {
    const bucketRank = { active: 0, archived: 1, dead: 2 };
    return [...(Array.isArray(rows) ? rows : [])].sort((a, b) => (
        Number(Boolean(b?.present)) - Number(Boolean(a?.present))
        || Number(Boolean(b?.worldActive)) - Number(Boolean(a?.worldActive))
        || (bucketRank[a?.bucket] ?? 9) - (bucketRank[b?.bucket] ?? 9)
        || String(a?.name || '').localeCompare(String(b?.name || ''))
    ));
}

export function filterDossierIndex(rows = [], { query = '', filter = 'all' } = {}) {
    const needle = plain(query).toLocaleLowerCase();
    const mode = ['all', 'active', 'archived', 'dead'].includes(filter) ? filter : 'all';
    return sortDossierIndex(rows).filter(row => {
        if (mode !== 'all' && row?.bucket !== mode) return false;
        if (!needle) return true;
        return [
            row?.name,
            row?.role,
            row?.species,
            row?.gender,
            row?.apparentAge,
            row?.homeBase,
            row?.location,
            row?.status,
            row?.statusLabel,
            ...(Array.isArray(row?.aliases) ? row.aliases : []),
        ].some(value => String(value || '').toLocaleLowerCase().includes(needle));
    });
}

export function chooseDossierSelection(currentId, visibleRows = [], allRows = []) {
    const current = plain(currentId);
    const visible = Array.isArray(visibleRows) ? visibleRows : [];
    const all = Array.isArray(allRows) ? allRows : [];
    if (current && visible.some(row => row?.id === current)) return current;
    if (visible[0]?.id) return visible[0].id;
    if (current && all.some(row => row?.id === current)) return current;
    return all[0]?.id || '';
}

export function projectDossierState(state = {}, status = {}) {
    const portraitAssets = state?.portraitAssets && typeof state.portraitAssets === 'object' ? state.portraitAssets : {};
    const records = Array.isArray(state?.npcs) ? state.npcs : [];
    const details = records.map(npc => dossierDetailProjection(npc, portraitAssets)).filter(npc => npc.id);
    return {
        chatKey: plain(status?.chatKey, 'no-chat'),
        hydrationStatus: plain(status?.hydrationStatus, 'ready'),
        hydrationError: plain(status?.hydrationError),
        turn: Number.isFinite(Number(state?.turn)) ? Number(state.turn) : 0,
        npcs: details,
        index: sortDossierIndex(details.map(npc => ({
            id: npc.id,
            name: npc.name,
            aliases: npc.aliases,
            role: npc.role,
            species: npc.species,
            gender: npc.gender,
            apparentAge: npc.apparentAge,
            homeBase: npc.homeBase,
            location: npc.location,
            status: npc.status,
            present: npc.present,
            worldActive: npc.worldActive,
            archived: npc.archived,
            archiveReason: npc.archiveReason,
            lifeState: npc.lifeState,
            bucket: npc.bucket,
            statusLabel: npc.statusLabel,
            portrait: npc.portrait,
            updatedAt: npc.updatedAt,
        }))),
    };
}

function listHtml(items, empty = 'None established yet.') {
    const rows = Array.isArray(items) ? items.filter(Boolean) : [];
    if (!rows.length) return `<p class="delta-muted">${escapeHtml(empty)}</p>`;
    return `<ul class="delta-list">${rows.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function proseHtml(value, empty = 'Unknown') {
    const text = plain(value);
    return `<p${text ? '' : ' class="delta-muted"'}>${escapeHtml(text || empty)}</p>`;
}

function portraitHtml(npc, className, { alt = true } = {}) {
    const src = plain(npc?.portrait);
    if (src) return `<img class="${className}" src="${escapeHtml(src)}" alt="${alt ? `${escapeHtml(npc?.name || 'NPC')} portrait` : ''}" loading="lazy" decoding="async">`;
    const initial = escapeHtml(String(npc?.name || '?').trim().charAt(0).toUpperCase() || '?');
    return `<div class="${className} delta-portrait-placeholder" aria-hidden="true"><span>${initial}</span></div>`;
}

function identityLine(npc) {
    return [
        npc?.species,
        npc?.gender,
        npc?.role,
        npc?.age ? `Age ${npc.age}` : '',
        npc?.apparentAge ? `Looks ${npc.apparentAge}` : '',
    ].filter(Boolean).join(' · ') || 'Identity details not established';
}

function currentCard(label, value, fallback = 'Unknown') {
    return `<div class="delta-current-card"><b>${escapeHtml(label)}</b><span>${escapeHtml(plain(value, fallback))}</span></div>`;
}

function birthdayCard(npc) {
    const source = npc.birthdaySource === 'generated' ? 'Deterministic fallback'
        : npc.birthdaySource === 'established' ? 'Story established' : '';
    return `<div class="delta-current-card delta-continuity-birthday-card"><b>Birthday</b><span>${escapeHtml(npc.birthday || 'Unknown')}</span>${source ? `<small class="delta-continuity-source">${escapeHtml(source)}</small>` : ''}</div>`;
}

export function appearanceFormsHtml(npc) {
    const model = npc.appearanceModel;
    const compatibilityCurrent = !model.currentForm && !model.currentFormUnknown && !model.appearanceForms.length && model.appearance
        && model.appearance !== model.overallAppearance
        ? `<div class="delta-appearance-form-row"><b>Current presentation<span class="delta-appearance-current-badge">Current</span></b>${proseHtml(model.appearance)}</div>`
        : '';
    const current = model.currentFormUnknown ? 'Unclassified / unknown'
        : model.currentForm || (compatibilityCurrent ? 'Current presentation' : 'No selected form');
    const unclassified = model.currentFormUnknown && model.unclassifiedAppearance
        ? `<div class="delta-appearance-form-row"><b>Current unclassified presentation<span class="delta-appearance-current-badge">Current</span></b>${proseHtml(model.unclassifiedAppearance)}</div>`
        : '';
    const rows = model.appearanceForms.map(form => `<div class="delta-appearance-form-row"><b>${escapeHtml(form.name)}${form.name === model.currentForm ? '<span class="delta-appearance-current-badge">Current</span>' : ''}</b>${proseHtml(form.appearance)}</div>`).join('');
    const empty = !unclassified && !compatibilityCurrent && !rows ? '<p class="delta-muted">No named forms established.</p>' : '';
    return `<details class="delta-appearance-form-summary" data-delta-key="appearance" open><summary><b>Appearance forms</b><small>Current: ${escapeHtml(current)}</small></summary><div class="delta-appearance-form-list">${model.overallAppearance ? `<div class="delta-appearance-form-row"><b>Shared across forms</b>${proseHtml(model.overallAppearance)}</div>` : ''}${unclassified}${compatibilityCurrent}${rows}${empty}</div></details>`;
}

// Cache only rendered section markup on its DOM node, never canonical state/history.
// Unchanged sections retain their nodes, selection, focus and open disclosure controls.
function reconcileDocumentSections(parent, markup, reset = false) {
    const template = document.createElement('template');
    template.innerHTML = markup;
    const children = [...template.content.children];
    children.forEach((candidate, index) => {
        const previous = parent.children[index];
        const signature = candidate.outerHTML;
        if (!reset && previous?.__deltaSectionMarkup === signature) return;
        candidate.__deltaSectionMarkup = signature;
        if (!reset && previous) {
            for (const detail of previous.querySelectorAll('details[data-delta-key]')) {
                const next = candidate.querySelector(`details[data-delta-key="${CSS.escape(detail.dataset.deltaKey)}"]`);
                if (next) next.open = detail.open;
            }
        }
        if (previous) previous.replaceWith(candidate);
        else parent.appendChild(candidate);
    });
    while (parent.children.length > children.length) parent.lastElementChild.remove();
}

function relationshipAxis(label, value, axis) {
    const score = relationshipValue(value);
    const position = Math.max(0, Math.min(100, (score + 100) / 2));
    return `<div class="delta-rel-axis delta-rel-${escapeHtml(axis)}">
        <div class="delta-rel-label"><span>${escapeHtml(label)}</span><b>${score > 0 ? '+' : ''}${score}</b></div>
        <div class="delta-rel-track" aria-label="${escapeHtml(label)} ${score}"><span class="delta-rel-zero"></span><i style="left:${position}%"></i></div>
    </div>`;
}

function countsFor(rows) {
    const counts = { all: 0, active: 0, archived: 0, dead: 0 };
    for (const row of Array.isArray(rows) ? rows : []) {
        counts.all += 1;
        if (counts[row?.bucket] !== undefined) counts[row.bucket] += 1;
    }
    return counts;
}

function visibleElement(element) {
    return Boolean(element && element.isConnected && element.getClientRects?.().length);
}

class DeltaDossierUi {
    constructor(api) {
        this.api = api;
        this.root = null;
        this.panelOpen = false;
        this.query = '';
        this.filter = 'all';
        this.selectedNpcId = '';
        this.projection = null;
        this.lastChatKey = '';
        this.lastRailSignature = '';
        this.lastDetailSignature = '';
        this.lastHeroSignature = '';
        this.dirtyWhileClosed = true;
        this.refreshQueued = false;
        this.legacyObserver = null;
        this.observerRetryTimer = null;
        this.observerAttempts = 0;
        this.boundEscape = event => this.onDocumentKeydown(event);
        this.boundFocus = () => { if (this.panelOpen) this.scheduleRefresh(); };
    }

    mount() {
        if (typeof document === 'undefined' || this.root?.isConnected) return this;
        this.injectStyles();
        let root = document.getElementById(ROOT_ID);
        if (!root) {
            root = document.createElement('div');
            root.id = ROOT_ID;
            root.innerHTML = this.shellHtml();
            document.body.appendChild(root);
        }
        this.root = root;
        this.bindEvents();
        this.attachLegacyObserver();
        this.startObserverRetry();
        return this;
    }

    destroy() {
        this.legacyObserver?.disconnect?.();
        this.legacyObserver = null;
        if (this.observerRetryTimer) clearInterval(this.observerRetryTimer);
        this.observerRetryTimer = null;
        document.removeEventListener?.('keydown', this.boundEscape);
        window.removeEventListener?.('focus', this.boundFocus);
        this.root?.remove?.();
        this.root = null;
    }

    shellHtml() {
        return `
            <button type="button" class="delta-launcher" aria-haspopup="dialog" aria-expanded="false" title="Open NPC dossiers">
                <span class="delta-launcher-mark" aria-hidden="true">D</span><span>Dossiers</span>
            </button>
            <section class="delta-panel" role="dialog" aria-modal="true" aria-label="NPC State Delta dossiers" hidden>
                <header class="delta-topbar">
                    <div class="delta-brand"><span class="delta-kicker">NPC DOSSIER</span><strong>NPC State Delta</strong><span class="delta-chat-state"></span></div>
                    <div class="delta-top-actions">
                        <button type="button" class="delta-btn delta-open-settings">Settings</button>
                        <button type="button" class="delta-btn delta-close" aria-label="Close NPC dossiers">Close</button>
                    </div>
                </header>
                <div class="delta-notice" hidden></div>
                <div class="delta-panel-body">
                    <div class="delta-empty" hidden></div>
                    <div class="delta-library" hidden>
                        <div class="delta-stage">
                            <div class="delta-spread">
                                <aside class="delta-hero"></aside>
                                <main class="delta-document" tabindex="-1"></main>
                            </div>
                        </div>
                        <section class="delta-cast" aria-label="NPC cast">
                            <div class="delta-cast-tools">
                                <label class="delta-search-label"><span class="sr-only">Search NPC dossiers</span><input type="search" class="delta-search" placeholder="Search cast, role, species, gender, location…" autocomplete="off"></label>
                                <div class="delta-filters" role="group" aria-label="Dossier filters">
                                    ${['all', 'active', 'archived', 'dead'].map(key => `<button type="button" class="delta-filter${key === 'all' ? ' active' : ''}" data-filter="${key}" aria-pressed="${key === 'all'}">${key.charAt(0).toUpperCase() + key.slice(1)} <span data-count="${key}">0</span></button>`).join('')}
                                </div>
                            </div>
                            <div class="delta-cast-list" role="listbox" aria-label="NPC dossiers"></div>
                        </section>
                    </div>
                </div>
            </section>`;
    }

    bindEvents() {
        this.root.addEventListener('click', event => {
            const launcher = event.target.closest('.delta-launcher');
            if (launcher) return void this.open();
            if (event.target.closest('.delta-close')) return void this.close();
            if (event.target.closest('.delta-open-settings')) return void this.openSettings();
            const filter = event.target.closest('.delta-filter')?.dataset?.filter;
            if (filter) {
                this.filter = filter;
                this.renderFromProjection({ forceRail: true, forceDetail: true });
                return;
            }
            const cast = event.target.closest('.delta-cast-card');
            if (cast?.dataset?.npcId) {
                this.selectedNpcId = cast.dataset.npcId;
                this.renderFromProjection({ forceRail: true, forceDetail: true });
                return;
            }
            const edit = event.target.closest('.delta-edit');
            if (edit) this.openEditor(edit.dataset.npcId || this.selectedNpcId);
        });
        this.root.querySelector('.delta-search')?.addEventListener('input', event => {
            this.query = event.currentTarget.value || '';
            this.renderFromProjection({ forceRail: true, forceDetail: true });
        });
        document.addEventListener('keydown', this.boundEscape);
        window.addEventListener('focus', this.boundFocus);
    }

    injectStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = STYLES;
        document.head.appendChild(style);
    }

    startObserverRetry() {
        if (this.legacyObserver || this.observerRetryTimer) return;
        this.observerRetryTimer = setInterval(() => {
            this.observerAttempts += 1;
            if (this.attachLegacyObserver() || this.observerAttempts >= OBSERVER_RETRY_LIMIT) {
                clearInterval(this.observerRetryTimer);
                this.observerRetryTimer = null;
            }
        }, OBSERVER_RETRY_MS);
    }

    attachLegacyObserver() {
        if (typeof MutationObserver === 'undefined' || this.legacyObserver) return Boolean(this.legacyObserver);
        const target = document.getElementById(SETTINGS_ID);
        if (!target) return false;
        this.legacyObserver = new MutationObserver(() => {
            if (this.panelOpen) this.scheduleRefresh();
            else this.dirtyWhileClosed = true;
        });
        this.legacyObserver.observe(target, { subtree: true, childList: true, characterData: true, attributes: true });
        return true;
    }

    scheduleRefresh() {
        if (this.refreshQueued) return;
        this.refreshQueued = true;
        queueMicrotask(() => {
            this.refreshQueued = false;
            void this.refresh();
        });
    }

    onDocumentKeydown(event) {
        if (!this.panelOpen || event.key !== 'Escape' || event.defaultPrevented
            || document.getElementById('npc_state_delta_tools_overlay')) return;
        const uiStatus = this.safeUiStatus();
        if (uiStatus?.editorMounted || uiStatus?.portraitGeneratorOpen) return;
        event.preventDefault();
        this.close();
    }

    async open() {
        if (!this.root) return;
        this.panelOpen = true;
        this.root.querySelector('.delta-panel').hidden = false;
        this.root.querySelector('.delta-launcher')?.setAttribute('aria-expanded', 'true');
        try { await this.api?.ensureFresh?.({ reason: 'dossier-ui-open' }); }
        catch (error) { console.warn('[NPC State Delta] dossier view freshness check failed safely.', error); }
        await this.refresh({ force: true });
        this.root.querySelector('.delta-search')?.focus?.({ preventScroll: true });
    }

    close({ restoreFocus = true } = {}) {
        if (!this.root) return;
        this.panelOpen = false;
        this.root.querySelector('.delta-panel').hidden = true;
        this.root.querySelector('.delta-launcher')?.setAttribute('aria-expanded', 'false');
        if (restoreFocus) this.root.querySelector('.delta-launcher')?.focus?.({ preventScroll: true });
    }

    safeUiStatus() {
        try { return typeof this.api?.uiStatus === 'function' ? this.api.uiStatus() : {}; }
        catch (error) { return { chatKey: 'no-chat', hydrationStatus: 'error', hydrationError: error?.message || String(error) }; }
    }

    async refresh({ force = false } = {}) {
        if (!this.root || (!this.panelOpen && !force)) {
            this.dirtyWhileClosed = true;
            return;
        }
        const status = this.safeUiStatus();
        const chatKey = plain(status?.chatKey, 'no-chat');
        const chatChanged = chatKey !== this.lastChatKey;
        if (chatChanged) {
            this.lastChatKey = chatKey;
            this.selectedNpcId = '';
            this.query = '';
            this.filter = 'all';
            const search = this.root.querySelector('.delta-search');
            if (search) search.value = '';
            this.lastRailSignature = '';
            this.lastDetailSignature = '';
            this.lastHeroSignature = '';
        }

        if (chatKey === 'no-chat') {
            this.projection = projectDossierState({}, status);
            this.dirtyWhileClosed = false;
            this.renderFromProjection({ forceRail: true, forceDetail: true });
            return;
        }
        if (status?.hydrationStatus && status.hydrationStatus !== 'ready') {
            this.projection = projectDossierState({}, status);
            this.dirtyWhileClosed = false;
            this.renderFromProjection({ forceRail: true, forceDetail: true });
            return;
        }
        try {
            const state = typeof this.api?.getDossierState === 'function' ? this.api.getDossierState() : this.api?.getState?.() || { npcs: [] };
            this.projection = projectDossierState(state, status);
            this.dirtyWhileClosed = false;
            this.renderFromProjection({ forceRail: force || chatChanged, forceDetail: force || chatChanged });
        } catch (error) {
            this.projection = projectDossierState({}, { ...status, hydrationStatus: 'error', hydrationError: error?.message || String(error) });
            this.renderFromProjection({ forceRail: true, forceDetail: true });
        }
    }

    renderFromProjection({ forceRail = false, forceDetail = false } = {}) {
        if (!this.root || !this.projection) return;
        const panel = this.root.querySelector('.delta-panel');
        const empty = this.root.querySelector('.delta-empty');
        const library = this.root.querySelector('.delta-library');
        const notice = this.root.querySelector('.delta-notice');
        const chatState = this.root.querySelector('.delta-chat-state');
        const projection = this.projection;
        const hasChat = projection.chatKey && projection.chatKey !== 'no-chat';

        const turnLabel = hasChat ? `Turn ${projection.turn}` : 'No chat';
        if (chatState.textContent !== turnLabel) chatState.textContent = turnLabel;
        notice.hidden = true;
        if (notice.textContent) notice.textContent = '';

        if (!hasChat) {
            empty.hidden = false;
            library.hidden = true;
            empty.innerHTML = `<div class="delta-empty-mark" aria-hidden="true">D</div><h2>Open a chat to view its cast</h2><p>Dossiers belong to the active conversation. Settings remain available without a chat.</p><button type="button" class="delta-btn delta-primary delta-open-settings">Open settings</button>`;
            return;
        }
        if (projection.hydrationStatus !== 'ready') {
            empty.hidden = false;
            library.hidden = true;
            const detail = projection.hydrationError ? `<p class="delta-error-copy">${escapeHtml(projection.hydrationError)}</p>` : '<p>The dossier state is still loading.</p>';
            empty.innerHTML = `<div class="delta-empty-mark" aria-hidden="true">…</div><h2>${projection.hydrationStatus === 'error' ? 'Dossier state unavailable' : 'Loading dossiers'}</h2>${detail}<button type="button" class="delta-btn delta-primary delta-open-settings">Open settings</button>`;
            return;
        }

        empty.hidden = true;
        library.hidden = false;
        const filtered = filterDossierIndex(projection.index, { query: this.query, filter: this.filter });
        this.selectedNpcId = chooseDossierSelection(this.selectedNpcId, filtered, projection.index);
        this.renderFilters(projection.index);
        this.renderRail(filtered, { force: forceRail });
        this.renderDetail(filtered, { force: forceDetail });
        panel?.setAttribute('data-has-results', filtered.length ? 'true' : 'false');
        this.root.dispatchEvent?.(new CustomEvent('npc-state-delta:dossier-rendered', { bubbles: true }));
    }

    renderFilters(rows) {
        const counts = countsFor(rows);
        for (const button of this.root.querySelectorAll('.delta-filter')) {
            const key = button.dataset.filter;
            const active = key === this.filter;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
            const count = button.querySelector('[data-count]');
            const countLabel = String(counts[key] || 0);
            if (count && count.textContent !== countLabel) count.textContent = countLabel;
        }
    }

    renderRail(filtered, { force = false } = {}) {
        const list = this.root.querySelector('.delta-cast-list');
        const signature = JSON.stringify(filtered.map(row => [row.id, row.name, row.statusLabel, row.role, row.species, row.gender, row.portrait, row.id === this.selectedNpcId]));
        if (!force && signature === this.lastRailSignature) return;
        this.lastRailSignature = signature;
        const scrollLeft = list.scrollLeft;
        const focusedId = document.activeElement?.closest?.('.delta-cast-card')?.dataset?.npcId || '';
        if (!filtered.length) {
            list.innerHTML = `<div class="delta-no-results"><b>No dossiers match this view.</b><span>Change the search or filter to bring the cast back.</span></div>`;
            return;
        }
        list.innerHTML = filtered.map(npc => {
            const meta = [npc.species, npc.gender, npc.role].filter(Boolean).join(' · ') || 'Details pending';
            const selected = npc.id === this.selectedNpcId;
            return `<button type="button" class="delta-cast-card${selected ? ' selected' : ''}" role="option" aria-selected="${selected}" data-npc-id="${escapeHtml(npc.id)}">
                ${portraitHtml(npc, 'delta-cast-portrait', { alt: false })}
                <span class="delta-cast-copy"><b>${escapeHtml(npc.name)}</b><small>${escapeHtml(meta)}</small><em class="delta-status delta-status-${escapeHtml(npc.bucket)}">${escapeHtml(npc.statusLabel)}</em></span>
            </button>`;
        }).join('');
        list.scrollLeft = scrollLeft;
        if (focusedId) list.querySelector(`.delta-cast-card[data-npc-id="${CSS.escape(focusedId)}"]`)?.focus?.({ preventScroll: true });
    }

    renderDetail(filtered, { force = false } = {}) {
        const hero = this.root.querySelector('.delta-hero');
        const documentPane = this.root.querySelector('.delta-document');
        const selected = this.projection.npcs.find(npc => npc.id === this.selectedNpcId) || null;
        const selectedVisible = filtered.some(row => row.id === this.selectedNpcId);
        const subtitle = selected ? identityLine(selected) : '';
        const signature = selectedVisible && selected
            ? JSON.stringify({ ...selected, portrait: undefined, updatedAt: undefined }) : `empty:${this.filter}:${this.query}`;
        const heroSignature = selectedVisible && selected
            ? JSON.stringify([selected.id, selected.name, subtitle, selected.bucket, selected.statusLabel, selected.portrait]) : signature;
        const documentChanged = force || signature !== this.lastDetailSignature;
        const heroChanged = force || heroSignature !== this.lastHeroSignature;
        if (!documentChanged && !heroChanged) return;
        this.lastDetailSignature = signature;
        this.lastHeroSignature = heroSignature;
        const documentScroll = documentPane.scrollTop;

        if (!selected || !selectedVisible) {
            hero.innerHTML = `<div class="delta-hero-empty"><span aria-hidden="true">⌕</span><b>No dossier selected</b></div>`;
            documentPane.innerHTML = `<div class="delta-document-empty"><h2>No matching dossier</h2><p>Try a different cast filter or search term.</p></div>`;
            return;
        }

        if (heroChanged) hero.innerHTML = `
            <div class="delta-hero-media">${portraitHtml(selected, 'delta-hero-portrait')}
                <div class="delta-hero-caption">
                    <span class="delta-status delta-status-${escapeHtml(selected.bucket)}">${escapeHtml(selected.statusLabel)}</span>
                    <h2>${escapeHtml(selected.name)}</h2>
                    <p>${escapeHtml(subtitle)}</p>
                </div>
            </div>
            <div class="delta-hero-actions"><button type="button" class="delta-btn delta-primary delta-edit" data-npc-id="${escapeHtml(selected.id)}">Edit dossier</button></div>`;

        if (documentChanged) reconcileDocumentSections(documentPane, `
            <div class="delta-document-head">
                <div><span class="delta-kicker">CURRENT DOSSIER</span><h2>${escapeHtml(selected.name)}</h2><p class="delta-muted">${escapeHtml(subtitle)}</p></div>
                <button type="button" class="delta-btn delta-edit" data-npc-id="${escapeHtml(selected.id)}">Edit</button>
            </div>
            <section class="delta-section">
                <h3>Identity continuity</h3>
                <div class="delta-current-grid">
                    ${birthdayCard(selected)}
                    ${currentCard('Home Base / Usual Location', selected.homeBase)}
                </div>
            </section>
            <section class="delta-section">
                <h3>Current</h3>
                <div class="delta-current-grid">
                    ${currentCard('Mood', selected.mood)}
                    ${currentCard('Location', selected.location)}
                    ${currentCard('Goal', selected.goal)}
                    ${currentCard('Condition / Activity', selected.status, selected.bucket === 'dead' ? 'Deceased' : 'Stable / unknown')}
                </div>
            </section>
            <section class="delta-section">
                <h3>Profile</h3>
                <div class="delta-prose-grid">
                    <div><h4>Personality</h4>${proseHtml(selected.personality)}</div>
                    <div><h4>Speech</h4>${proseHtml(selected.speech)}</div>
                    <div class="delta-wide"><h4>Behavioral Levers</h4>${listHtml(selected.behaviorProfile, 'No behavioral levers established yet.')}</div>
                    <div class="delta-wide"><h4>Appearance</h4>${appearanceFormsHtml(selected)}</div>
                    <div class="delta-wide"><h4>Mannerisms</h4>${listHtml(selected.mannerisms)}</div>
                </div>
            </section>
            <section class="delta-section">
                <h3>Relationship with player</h3>
                <div class="delta-rel-grid">
                    ${relationshipAxis('Trust', selected.relationship.trust, 'trust')}
                    ${relationshipAxis('Affection', selected.relationship.affection, 'affection')}
                    ${relationshipAxis('Desire', selected.relationship.desire, 'desire')}
                    ${relationshipAxis('Tension', selected.relationship.tension, 'tension')}
                </div>
                <div class="delta-summary"><h4>Player Dynamic</h4>${proseHtml(selected.relationshipSummary, 'No player-specific dynamic established yet.')}</div>
            </section>
            <section class="delta-section delta-two-column">
                <div><h3>Important bonds</h3>${listHtml(selected.keyRelationships, 'No key relationships established yet.')}</div>
                <div><h3>Important memories</h3>${listHtml(selected.memories, 'No important memories established yet.')}</div>
            </section>
            <section class="delta-section">
                <h3>Background / History</h3>${proseHtml(selected.background, 'No background established yet.')}
            </section>`, documentPane.dataset.npcId !== selected.id);
        documentPane.dataset.npcId = selected.id;
        documentPane.scrollTop = documentScroll;
    }

    async openEditor(npcId) {
        const id = plain(npcId);
        if (!id || typeof this.api?.openEditor !== 'function') {
            globalThis.toastr?.warning?.('NPC State Delta: dossier editor is unavailable.');
            return;
        }
        try {
            const opened = await this.api.openEditor(id);
            if (opened === false) globalThis.toastr?.warning?.('NPC State Delta: dossier editor could not open this NPC.');
        } catch (error) {
            console.error('[NPC State Delta] Stage 1 editor bridge failed', error);
            globalThis.toastr?.error?.(`NPC State Delta editor failed: ${error?.message || error}`);
        }
    }

    openSettings() {
        const settings = document.getElementById(SETTINGS_ID);
        if (!settings) {
            globalThis.toastr?.info?.('NPC State Delta settings are still mounting.');
            return;
        }
        this.close({ restoreFocus: false });
        for (let node = settings.parentElement; node; node = node.parentElement) {
            if (node.tagName === 'DETAILS') node.open = true;
        }
        const menuSelectors = [
            '#extensionsMenuButton',
            '#extensions_menu_button',
            '#extensionsMenu .drawer-toggle',
            '[data-target="extensions_settings"]',
        ];
        if (!visibleElement(settings)) {
            for (const selector of menuSelectors) {
                const trigger = document.querySelector(selector);
                if (trigger && !trigger.disabled) { trigger.click?.(); break; }
            }
        }
        settings.classList.add('npc-state-delta-stage1-settings-target');
        setTimeout(() => {
            settings.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
            setTimeout(() => settings.classList.remove('npc-state-delta-stage1-settings-target'), 1800);
        }, 0);
    }
}

export function mountNpcStateDeltaDossierUi(api = globalThis.NPCStateDelta) {
    if (typeof document === 'undefined' || !api) return null;
    const existing = document.getElementById(ROOT_ID);
    if (existing?.__npcStateDeltaStage1Ui) return existing.__npcStateDeltaStage1Ui;
    const controller = new DeltaDossierUi(api).mount();
    if (controller?.root) controller.root.__npcStateDeltaStage1Ui = controller;
    return controller;
}

function startBrowserUi(attempt = 0) {
    if (typeof document === 'undefined') return;
    const api = globalThis.NPCStateDelta;
    if (api) {
        mountNpcStateDeltaDossierUi(api);
        return;
    }
    if (attempt < 40) setTimeout(() => startBrowserUi(attempt + 1), 100);
    else console.error('[NPC State Delta] Stage 1 dossier UI could not find the runtime API.');
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => startBrowserUi(), { once: true });
    else queueMicrotask(() => startBrowserUi());
}

const STYLES = `
#${ROOT_ID} {
  --delta-bg: var(--SmartThemeBlurTintColor, #18191d);
  --delta-text: var(--SmartThemeBodyColor, #f0eee9);
  --delta-muted: color-mix(in srgb, var(--delta-text) 66%, transparent);
  --delta-surface: rgba(255,255,255,.055);
  --delta-surface-strong: rgba(255,255,255,.085);
  --delta-line: rgba(218,193,148,.24);
  --delta-line-strong: rgba(218,193,148,.52);
  --delta-accent: #d8bc78;
  --delta-accent-soft: #f0ddb0;
  --delta-good: #9ed5b6;
  --delta-warn: #e9c98d;
  --delta-danger: #efaaaa;
  position: relative;
  z-index: 10000;
  color: var(--delta-text);
  font: 400 14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
}
#${ROOT_ID} *, #${ROOT_ID} *::before, #${ROOT_ID} *::after { box-sizing: border-box; text-shadow: none; }
#${ROOT_ID} [hidden] { display: none !important; }
#${ROOT_ID} button, #${ROOT_ID} input { font: inherit; }
#${ROOT_ID} button { color: inherit; }
#${ROOT_ID} :is(button,input):focus-visible { outline: 2px solid var(--delta-accent); outline-offset: 2px; }
#${ROOT_ID} .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
#${ROOT_ID} .delta-launcher {
  position: fixed; right: 18px; bottom: 74px; z-index: 2147483000;
  display: inline-flex; align-items: center; gap: 8px; min-height: 42px; padding: 8px 13px 8px 9px;
  border: 1px solid rgba(138,163,200,.78); border-radius: 12px; color: #eef5ff;
  background: #263a55; box-shadow: 0 5px 20px rgba(0,0,0,.38); cursor: pointer;
}
#${ROOT_ID} .delta-launcher:hover { background: #304866; }
#${ROOT_ID} .delta-launcher-mark { display:grid; place-items:center; width:25px; height:25px; border-radius:8px; border:1px solid #a9bdd9; font:700 13px/1 Georgia,serif; }
#${ROOT_ID} .delta-panel {
  position: fixed; z-index: 2147483500; left:50%; top:50%; transform:translate(-50%,-50%);
  width:min(1320px,97vw); height:min(940px,96dvh); overflow:hidden;
  display:flex; flex-direction:column; border:1px solid var(--delta-line); border-radius:15px;
  color:var(--delta-text); background:var(--delta-bg);
  box-shadow:0 0 0 100vmax rgba(0,0,0,.72),0 20px 70px rgba(0,0,0,.55);
}
#${ROOT_ID} .delta-topbar { flex:0 0 auto; min-height:56px; display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 12px 8px 16px; border-bottom:1px solid var(--delta-line); background:color-mix(in srgb,var(--delta-bg) 94%,black 6%); }
#${ROOT_ID} .delta-brand, #${ROOT_ID} .delta-top-actions { display:flex; align-items:center; gap:10px; min-width:0; }
#${ROOT_ID} .delta-brand strong { font-size:1.03rem; white-space:nowrap; }
#${ROOT_ID} .delta-kicker { font-size:.67rem; line-height:1.2; letter-spacing:.14em; text-transform:uppercase; color:var(--delta-accent); opacity:.82; }
#${ROOT_ID} .delta-chat-state { display:inline-flex; padding:4px 9px; border:1px solid rgba(255,255,255,.1); border-radius:999px; color:var(--delta-muted); background:rgba(0,0,0,.16); font-size:.74rem; }
#${ROOT_ID} .delta-btn, #${ROOT_ID} .delta-filter {
  appearance:none; min-height:35px; padding:6px 11px; border:1px solid var(--delta-line); border-radius:8px;
  color:var(--delta-text); background:rgba(255,255,255,.055); box-shadow:none; cursor:pointer;
}
#${ROOT_ID} .delta-btn:hover, #${ROOT_ID} .delta-filter:hover { background:rgba(216,188,120,.12); border-color:var(--delta-line-strong); }
#${ROOT_ID} .delta-primary { color:#201a0f; background:var(--delta-accent); border-color:var(--delta-accent); font-weight:700; }
#${ROOT_ID} .delta-primary:hover { color:#151109; background:var(--delta-accent-soft); border-color:var(--delta-accent-soft); }
#${ROOT_ID} .delta-notice { flex:0 0 auto; padding:8px 14px; border-bottom:1px solid var(--delta-line); background:rgba(115,86,35,.26); }
#${ROOT_ID} .delta-panel-body { flex:1 1 auto; min-height:0; overflow:hidden; }
#${ROOT_ID} .delta-library { height:100%; min-height:0; display:grid; grid-template-rows:minmax(0,1fr) 158px; overflow:hidden; }
#${ROOT_ID} .delta-stage, #${ROOT_ID} .delta-spread { min-height:0; overflow:hidden; }
#${ROOT_ID} .delta-spread { height:100%; display:grid; grid-template-columns:minmax(310px,36%) minmax(0,1fr); }
#${ROOT_ID} .delta-hero { min-width:0; min-height:0; display:grid; grid-template-rows:minmax(0,1fr) auto; overflow:hidden; border-right:1px solid rgba(218,193,148,.16); background:rgba(0,0,0,.24); }
#${ROOT_ID} .delta-hero-media { position:relative; min-height:0; overflow:hidden; background:rgba(0,0,0,.28); }
#${ROOT_ID} .delta-hero-portrait { position:absolute; inset:0; width:100%; height:100%; display:block; object-fit:cover; object-position:center 18%; }
#${ROOT_ID} .delta-portrait-placeholder { display:grid; place-items:center; background:radial-gradient(circle at 50% 30%,rgba(216,188,120,.17),rgba(0,0,0,.22)); color:var(--delta-accent); font-family:Georgia,"Times New Roman",serif; }
#${ROOT_ID} .delta-hero-portrait.delta-portrait-placeholder { position:absolute; inset:0; width:100%; height:100%; }
#${ROOT_ID} .delta-hero-portrait.delta-portrait-placeholder span { font-size:clamp(4rem,8vw,7rem); opacity:.68; }
#${ROOT_ID} .delta-hero-caption { position:absolute; z-index:2; left:0; right:0; bottom:0; padding:100px 24px 22px; background:linear-gradient(to bottom,rgba(5,6,8,0),rgba(5,6,8,.62) 43%,rgba(5,6,8,.94) 100%); color:#f4f1e9; }
#${ROOT_ID} .delta-hero-caption h2 { margin:6px 0 5px; color:#fff4d7; font:700 clamp(1.7rem,2.4vw,2.2rem)/1.12 Georgia,"Times New Roman",serif; }
#${ROOT_ID} .delta-hero-caption p { margin:0; max-width:40ch; color:rgba(244,241,233,.84); }
#${ROOT_ID} .delta-hero-actions { display:grid; padding:9px; border-top:1px solid rgba(218,193,148,.12); background:color-mix(in srgb,var(--delta-bg) 90%,black 10%); }
#${ROOT_ID} .delta-hero-empty { height:100%; min-height:250px; display:grid; place-items:center; align-content:center; gap:8px; color:var(--delta-muted); }
#${ROOT_ID} .delta-hero-empty span { font-size:3rem; color:var(--delta-accent); }
#${ROOT_ID} .delta-document { min-width:0; min-height:0; overflow:auto; padding:22px clamp(18px,2.2vw,30px) 34px; scrollbar-color:rgba(218,193,148,.35) transparent; }
#${ROOT_ID} .delta-document-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:15px; padding-bottom:12px; border-bottom:1px solid var(--delta-line); }
#${ROOT_ID} .delta-document-head h2 { margin:3px 0 4px; font:700 1.65rem/1.15 Georgia,"Times New Roman",serif; color:var(--delta-accent-soft); }
#${ROOT_ID} .delta-document-head p { margin:0; }
#${ROOT_ID} .delta-section { margin:0 0 14px; padding:14px 15px; border:1px solid rgba(218,193,148,.14); border-radius:10px; background:var(--delta-surface); }
#${ROOT_ID} .delta-section h3 { margin:0 0 11px; font-size:.92rem; letter-spacing:.08em; text-transform:uppercase; color:var(--delta-accent-soft); }
#${ROOT_ID} .delta-section h4 { margin:0 0 5px; font-size:.77rem; letter-spacing:.05em; text-transform:uppercase; color:var(--delta-muted); }
#${ROOT_ID} .delta-section p { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; }
#${ROOT_ID} .delta-muted { color:var(--delta-muted); }
#${ROOT_ID} .delta-current-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
#${ROOT_ID} .delta-current-card { min-width:0; padding:10px 11px; border:1px solid rgba(255,255,255,.075); border-radius:8px; background:rgba(0,0,0,.12); }
#${ROOT_ID} .delta-current-card b { display:block; margin-bottom:3px; font-size:.72rem; text-transform:uppercase; letter-spacing:.06em; color:var(--delta-muted); }
#${ROOT_ID} .delta-current-card span { display:block; overflow-wrap:anywhere; }
#${ROOT_ID} .delta-prose-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:13px 18px; }
#${ROOT_ID} .delta-prose-grid .delta-wide { grid-column:1/-1; }
#${ROOT_ID} .delta-list { margin:0; padding-left:20px; }
#${ROOT_ID} .delta-list li + li { margin-top:4px; }
#${ROOT_ID} .delta-two-column { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:18px; }
#${ROOT_ID} .delta-rel-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:9px 14px; }
#${ROOT_ID} .delta-rel-axis { min-width:0; }
#${ROOT_ID} .delta-rel-label { display:flex; justify-content:space-between; gap:8px; margin-bottom:4px; font-size:.78rem; }
#${ROOT_ID} .delta-rel-label b { color:var(--delta-accent-soft); }
#${ROOT_ID} .delta-rel-track { position:relative; height:8px; border-radius:999px; background:rgba(0,0,0,.34); border:1px solid rgba(255,255,255,.07); }
#${ROOT_ID} .delta-rel-zero { position:absolute; left:50%; top:-2px; bottom:-2px; width:1px; background:rgba(255,255,255,.32); }
#${ROOT_ID} .delta-rel-track i { position:absolute; top:50%; width:10px; height:10px; transform:translate(-50%,-50%); border-radius:50%; background:var(--delta-accent); box-shadow:0 0 0 2px rgba(0,0,0,.45); }
#${ROOT_ID} .delta-summary { margin-top:12px; padding-top:10px; border-top:1px solid rgba(218,193,148,.12); }
#${ROOT_ID} .delta-status { display:inline-flex; align-items:center; width:max-content; max-width:100%; padding:3px 7px; border:1px solid rgba(255,255,255,.13); border-radius:999px; font-size:.7rem; line-height:1.25; font-style:normal; white-space:nowrap; }
#${ROOT_ID} .delta-status-active { color:#caefd9; background:rgba(47,112,77,.26); border-color:rgba(113,190,145,.25); }
#${ROOT_ID} .delta-status-archived { color:#ead7aa; background:rgba(119,90,42,.25); border-color:rgba(205,170,109,.25); }
#${ROOT_ID} .delta-status-dead { color:#efb8b8; background:rgba(111,54,60,.28); border-color:rgba(207,118,126,.28); }
#${ROOT_ID} .delta-cast { min-height:0; overflow:hidden; display:grid; grid-template-rows:auto minmax(0,1fr); border-top:1px solid var(--delta-line); background:color-mix(in srgb,var(--delta-bg) 92%,black 8%); }
#${ROOT_ID} .delta-cast-tools { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:8px 10px 7px; border-bottom:1px solid rgba(218,193,148,.11); }
#${ROOT_ID} .delta-search-label { flex:1 1 360px; max-width:470px; }
#${ROOT_ID} .delta-search { width:100%; min-height:34px; margin:0; padding:6px 10px; color:var(--delta-text); background:rgba(0,0,0,.24); border:1px solid var(--delta-line); border-radius:8px; box-shadow:none; }
#${ROOT_ID} .delta-search::placeholder { color:var(--delta-muted); opacity:.75; }
#${ROOT_ID} .delta-filters { display:flex; flex-wrap:wrap; gap:5px; }
#${ROOT_ID} .delta-filter { min-height:30px; padding:4px 8px; color:var(--delta-muted); background:transparent; border-color:transparent; font-size:.75rem; }
#${ROOT_ID} .delta-filter.active { color:var(--delta-accent-soft); background:rgba(216,188,120,.09); border-color:var(--delta-line); }
#${ROOT_ID} .delta-filter span { opacity:.7; }
#${ROOT_ID} .delta-cast-list { min-width:0; min-height:0; overflow-x:auto; overflow-y:hidden; display:flex; gap:7px; padding:8px 10px 10px; scrollbar-color:rgba(218,193,148,.35) transparent; }
#${ROOT_ID} .delta-cast-card { appearance:none; flex:0 0 220px; min-width:0; display:grid; grid-template-columns:52px minmax(0,1fr); align-items:center; gap:9px; padding:7px; text-align:left; color:var(--delta-text); background:rgba(255,255,255,.035); border:1px solid rgba(255,255,255,.075); border-radius:10px; box-shadow:none; cursor:pointer; }
#${ROOT_ID} .delta-cast-card:hover { background:rgba(216,188,120,.08); border-color:var(--delta-line); }
#${ROOT_ID} .delta-cast-card.selected { background:rgba(216,188,120,.12); border-color:var(--delta-line-strong); }
#${ROOT_ID} .delta-cast-portrait { width:52px; height:62px; object-fit:cover; object-position:center 20%; border-radius:8px; border:1px solid rgba(255,255,255,.1); background:rgba(0,0,0,.22); }
#${ROOT_ID} .delta-cast-portrait.delta-portrait-placeholder span { font:700 1.55rem/1 Georgia,serif; }
#${ROOT_ID} .delta-cast-copy { min-width:0; display:grid; gap:2px; }
#${ROOT_ID} .delta-cast-copy b, #${ROOT_ID} .delta-cast-copy small { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#${ROOT_ID} .delta-cast-copy small { color:var(--delta-muted); font-size:.7rem; }
#${ROOT_ID} .delta-cast-copy .delta-status { margin-top:2px; }
#${ROOT_ID} .delta-no-results { flex:1 1 auto; min-width:260px; display:grid; place-items:center; align-content:center; gap:3px; color:var(--delta-muted); text-align:center; }
#${ROOT_ID} .delta-no-results b { color:var(--delta-text); }
#${ROOT_ID} .delta-empty, #${ROOT_ID} .delta-document-empty { height:100%; display:grid; place-items:center; align-content:center; gap:10px; padding:28px; text-align:center; color:var(--delta-muted); }
#${ROOT_ID} .delta-empty h2, #${ROOT_ID} .delta-document-empty h2 { margin:0; color:var(--delta-text); font:700 1.5rem/1.2 Georgia,"Times New Roman",serif; }
#${ROOT_ID} .delta-empty p, #${ROOT_ID} .delta-document-empty p { margin:0; max-width:54ch; }
#${ROOT_ID} .delta-empty-mark { display:grid; place-items:center; width:64px; height:64px; border:1px solid var(--delta-line-strong); border-radius:18px; color:var(--delta-accent); font:700 2rem/1 Georgia,serif; background:rgba(216,188,120,.07); }
#${ROOT_ID} .delta-error-copy { color:var(--delta-danger); }
#${SETTINGS_ID}.npc-state-delta-stage1-settings-target { outline:2px solid #d8bc78; outline-offset:4px; }
@media (max-width: 900px) {
  #${ROOT_ID} .delta-panel { width:100vw; height:100dvh; border-radius:0; border-left:0; border-right:0; }
  #${ROOT_ID} .delta-library { grid-template-rows:minmax(0,1fr) 172px; }
  #${ROOT_ID} .delta-spread { grid-template-columns:minmax(250px,38%) minmax(0,1fr); }
  #${ROOT_ID} .delta-cast-tools { align-items:stretch; flex-direction:column; }
  #${ROOT_ID} .delta-search-label { flex:0 0 auto; max-width:none; }
}
@media (max-width: 650px) {
  #${ROOT_ID} .delta-launcher { right:10px; bottom:66px; }
  #${ROOT_ID} .delta-brand .delta-kicker, #${ROOT_ID} .delta-chat-state { display:none; }
  #${ROOT_ID} .delta-topbar { padding-left:10px; }
  #${ROOT_ID} .delta-spread { display:block; overflow:auto; }
  #${ROOT_ID} .delta-hero { min-height:330px; border-right:0; border-bottom:1px solid rgba(218,193,148,.16); }
  #${ROOT_ID} .delta-document { overflow:visible; }
  #${ROOT_ID} .delta-current-grid, #${ROOT_ID} .delta-prose-grid, #${ROOT_ID} .delta-two-column, #${ROOT_ID} .delta-rel-grid { grid-template-columns:1fr; }
  #${ROOT_ID} .delta-prose-grid .delta-wide { grid-column:auto; }
  #${ROOT_ID} .delta-cast-card { flex-basis:190px; }
}
`;