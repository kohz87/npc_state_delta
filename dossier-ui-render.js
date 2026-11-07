/* NPC State Delta dossier surface: cast rail and selected-dossier rendering. */
import { escapeHtml } from './src/util/html.js';
import { castFromHtml, chooseDossierSelection, filterDossierIndex, keyAwayHtml } from './dossier-ui-catalog.js';
import { appearanceFormsHtml, birthdayCard, changeSummaryHtml, changedMark, countsFor, currentCard, identityLine, listHtml, portraitHtml, portraitMark, proseHtml, reconcileDocumentSections, sectionNavHtml } from './dossier-ui-html.js';
import { v2MetersHtml, v2SecretsHtml } from './dossier-ui-meters.js';
import { RELATIONSHIP_AXES, replyHeaderLabel } from './dossier-ui-model.js';
import { DossierUiPanel } from './dossier-ui-panel.js';
import { lastRelationshipChangeHtml, relationshipAxis, relationshipHistoryHtml } from './dossier-ui-relationship.js';

export class DossierUiRender extends DossierUiPanel {
    renderFromProjection({ forceRail = false, forceDetail = false } = {}) {
        if (!this.root || !this.projection) return;
        const panel = this.root.querySelector('.delta-panel');
        const empty = this.root.querySelector('.delta-empty');
        const library = this.root.querySelector('.delta-library');
        const notice = this.root.querySelector('.delta-notice');
        const chatState = this.root.querySelector('.delta-chat-state');
        const projection = this.projection;
        const hasChat = projection.chatKey && projection.chatKey !== 'no-chat';

        const replyLabel = replyHeaderLabel(projection);
        if (chatState.textContent !== replyLabel) chatState.textContent = replyLabel;
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
        const filtered = filterDossierIndex(projection.index, { query: this.query, filter: this.filter, keepId: this.selectedNpcId });
        const selectable = projection.index.filter(row => row.bucket !== 'dead' || row.id === this.selectedNpcId);
        this.selectedNpcId = chooseDossierSelection(this.selectedNpcId, filtered, selectable);
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
        const refs = this.portraitRefs;
        const signature = JSON.stringify(filtered.map(row => [row.id, row.name, row.statusLabel, row.role, row.species, row.gender, portraitMark(row.portrait, refs), row.id === this.selectedNpcId, row.key === true]));
        if (!force && signature === this.lastRailSignature) return;
        this.lastRailSignature = signature;
        const scrollLeft = list.scrollLeft;
        const focusedId = document.activeElement?.closest?.('.delta-cast-card')?.dataset?.npcId || '';
        if (!filtered.length) {
            const deadHidden = !this.query && this.projection?.index?.some(row => row.bucket === 'dead');
            const hint = deadHidden ? 'The dead are hidden from the list; search by name to find them.' : 'Change the search or filter to bring the cast back.';
            list.innerHTML = `<div class="delta-no-results"><b>No dossiers match this view.</b><span>${hint}</span></div>`;
            return;
        }
        list.innerHTML = filtered.map((npc, index) => {
            const meta = [npc.species, npc.gender, npc.role].filter(Boolean).join(' · ') || 'Details pending';
            const selected = npc.id === this.selectedNpcId;
            const firstDead = npc.bucket === 'dead' && index > 0 && filtered[index - 1]?.bucket !== 'dead';
            return `<button type="button" class="delta-cast-card${selected ? ' selected' : ''}${firstDead ? ' delta-cast-first-dead' : ''}" role="option" aria-selected="${selected}" data-npc-id="${escapeHtml(npc.id)}" data-bucket="${escapeHtml(npc.bucket)}" data-has-portrait="${npc.portrait ? 'true' : 'false'}">
                ${portraitHtml(npc, 'delta-cast-portrait', { alt: false, refs })}
                <span class="delta-cast-copy"><b>${escapeHtml(npc.name)}${npc.key ? ' <span class="delta-key-star" title="Key person" aria-label="Key person">★</span>' : ''}</b><small>${escapeHtml(meta)}</small><em class="delta-status delta-status-${escapeHtml(npc.bucket)}">${escapeHtml(npc.statusLabel)}</em></span>
            </button>`;
        }).join('');
        refs.fill(list);
        list.scrollLeft = scrollLeft;
        if (focusedId) list.querySelector(`.delta-cast-card[data-npc-id="${CSS.escape(focusedId)}"]`)?.focus?.({ preventScroll: true });
    }

    renderDetail(filtered, { force = false } = {}) {
        const hero = this.root.querySelector('.delta-hero');
        const documentPane = this.root.querySelector('.delta-document');
        const selected = this.projection.npcs.find(npc => npc.id === this.selectedNpcId) || null;
        const selectedVisible = filtered.some(row => row.id === this.selectedNpcId);
        const subtitle = selected ? identityLine(selected) : '';
        const refs = this.portraitRefs;
        const heroPortrait = selected ? portraitMark(selected.portrait, refs) : '';
        const formPortraits = selected ? Object.fromEntries(Object.entries(selected.formPortraits || {}).map(([name, src]) => [name, portraitMark(src, refs)])) : {};
        const signature = selectedVisible && selected
            ? JSON.stringify({ ...selected, portrait: undefined, formPortraits, updatedAt: undefined, reply: this.projection.reply }) : `empty:${this.filter}:${this.query}`;
        const heroSignature = selectedVisible && selected
            ? JSON.stringify([selected.id, selected.name, subtitle, selected.bucket, selected.statusLabel, heroPortrait, selected.portraitAppearanceChanged, selected.appearanceModel.currentForm, Boolean(selected.key), selected.cast?.badge ?? '']) : signature;
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

        if (heroChanged) this.root.querySelector('.delta-lightbox')?.remove();
        if (heroChanged) hero.innerHTML = `
            <div class="delta-hero-media">${portraitHtml(selected, 'delta-hero-portrait', { refs })}
                ${selected.portraitAppearanceChanged ? `<span class="delta-portrait-stale" title="The dossier appearance changed after this portrait was attached. Generate or upload a new portrait to match.">${escapeHtml(selected.portraitForm && selected.portraitForm !== selected.appearanceModel.currentForm ? `Portrait shows the ${selected.portraitForm} form` : 'Appearance changed since portrait')}</span>` : ''}
                ${selected.portrait ? `<button type="button" class="delta-portrait-expand" data-npc-id="${escapeHtml(selected.id)}" aria-label="View ${escapeHtml(selected.name)} portrait full size" title="View full size">⤢</button>` : ''}
                <div class="delta-hero-caption">
                    <span class="delta-status delta-status-${escapeHtml(selected.bucket)}">${escapeHtml(selected.statusLabel)}</span>
                    <h2>${escapeHtml(selected.name)}${selected.key ? ' <span class="delta-key-badge">★ Key person</span>' : ''}${selected.cast ? ` <span class="delta-cast-badge">${escapeHtml(selected.cast.badge)}</span>` : ''}</h2>
                    <p>${escapeHtml(subtitle)}</p>
                </div>
            </div>
            <div class="delta-hero-actions"><button type="button" class="delta-btn delta-primary delta-edit" data-npc-id="${escapeHtml(selected.id)}">Edit dossier</button></div>`;
        if (heroChanged) refs.fill(hero);

        if (documentChanged) reconcileDocumentSections(documentPane, `
            <div class="delta-document-head">
                <div><span class="delta-kicker">CURRENT DOSSIER</span><h2>${escapeHtml(selected.name)}${selected.key ? ' <span class="delta-key-badge">★ Key person</span>' : ''}${selected.cast ? ` <span class="delta-cast-badge">${escapeHtml(selected.cast.badge)}</span>` : ''}</h2><p class="delta-muted">${escapeHtml(subtitle)}</p>${changeSummaryHtml(selected, this.projection)}</div>
                <button type="button" class="delta-btn delta-edit" data-npc-id="${escapeHtml(selected.id)}">Edit</button>
            </div>
            ${selected.key ? keyAwayHtml(selected.key) : ''}
            ${selected.cast ? castFromHtml(selected.cast, selected.id) : ''}
            ${sectionNavHtml(Boolean(selected.v2Meters?.secrets?.length))}
            <section class="delta-section delta-player-card" data-delta-section="player">
                <h3>Player relationship${changedMark(selected, 'relationship')}</h3>
                <div class="delta-rel-grid">
                    ${RELATIONSHIP_AXES.map(([axis, label]) => relationshipAxis(label, selected.relationship[axis], axis, selected.lastRelationshipChange, this.projection?.reply)).join('')}
                </div>
                ${v2MetersHtml(selected.v2Meters)}
                ${lastRelationshipChangeHtml(selected.lastRelationshipChange)}
            </section>
            <section class="delta-section" data-delta-section="identity">
                <h3>Identity continuity</h3>
                <div class="delta-current-grid">
                    ${birthdayCard(selected)}
                    ${currentCard('Home Base / Usual Location', selected.homeBase, 'Unknown', changedMark(selected, 'homeBase'))}
                    ${selected.aliases.length ? currentCard('Also known as', selected.aliases.join(' · '), '') : ''}
                    ${selected.customFields.map(([name, value]) => currentCard(name, value, '')).join('')}
                </div>
            </section>
            <section class="delta-section" data-delta-section="current">
                <h3>Current</h3>
                <div class="delta-current-grid">
                    ${currentCard('Mood', selected.mood, 'Unknown', changedMark(selected, 'mood'))}
                    ${currentCard('Location', selected.location, 'Unknown', changedMark(selected, 'location'))}
                    ${currentCard('Goal', selected.goal, 'Unknown', changedMark(selected, 'goal'))}
                    ${currentCard('Condition / Activity', selected.status, selected.bucket === 'dead' ? 'Deceased' : 'Stable / unknown', changedMark(selected, 'status'))}
                </div>
            </section>
            <section class="delta-section" data-delta-section="profile">
                <h3>Profile</h3>
                <div class="delta-prose-grid">
                    <div><h4>Personality${changedMark(selected, 'personality')}</h4>${proseHtml(selected.personality)}</div>
                    <div><h4>Speech${changedMark(selected, 'speech')}</h4>${proseHtml(selected.speech)}</div>
                    <div class="delta-wide"><h4>Behavioral Levers${changedMark(selected, 'behaviorProfile')}</h4>${listHtml(selected.behaviorProfile, 'No behavioral levers established yet.')}</div>
                    <div class="delta-wide"><h4>Appearance${changedMark(selected, 'appearance')}</h4>${appearanceFormsHtml(selected, { portraitRefs: refs })}</div>
                    <div class="delta-wide"><h4>Mannerisms${changedMark(selected, 'mannerisms')}</h4>${listHtml(selected.mannerisms)}</div>
                </div>
            </section>
            <section class="delta-section" data-delta-section="dynamic">
                <h3>Player Dynamic${changedMark(selected, 'relationshipSummary')}</h3>
                ${proseHtml(selected.relationshipSummary, 'No player-specific dynamic established yet.')}
                ${relationshipHistoryHtml(selected.recentRelationshipChanges, selected.lastRelationshipChange)}
            </section>
            <section class="delta-section delta-two-column" data-delta-section="bonds">
                <div><h3>Important bonds${changedMark(selected, 'keyRelationships')}</h3>${listHtml(selected.keyRelationships, 'No key relationships established yet.')}</div>
                <div><h3>Important memories${changedMark(selected, 'memories')}</h3>${listHtml(selected.memories, 'No important memories established yet.')}</div>
            </section>
            <section class="delta-section" data-delta-section="history">
                <h3>Background / History${changedMark(selected, 'background')}</h3>${proseHtml(selected.background, 'No background established yet.')}
            </section>
            ${v2SecretsHtml(selected.v2Meters)}`, documentPane.dataset.npcId !== selected.id);
        if (documentChanged) refs.fill(documentPane);
        documentPane.dataset.npcId = selected.id;
        documentPane.scrollTop = documentScroll;
    }
}
