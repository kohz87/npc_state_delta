// The dossier editor's v2 controls (src/storysuite-v2.js): the meters, milestones and hidden notes section of Delta's dossier editor,
// what it holds (readEditor), the dossier view's meters by dossier id, and the story events the scan watches for.
//
// A part of the adapter closure: createEditorPart(session, deps) gets the adapter's shared state (session) and the adapter's options,
// constants and the parts built before it (deps), and returns what the other parts and the adapter use. No SillyTavern import.

import {
    FEATURE_STAGES, limitsFromLines, limitsToLines, meterValue, MAX_SECRETS, normalizeSecrets, secretsFromLines, secretsToLines, wordKey,
} from '../npc-meters.js';
import { eventSummary } from '../npc-meters-pacing.js';
import { escapeHtml } from '../util/html.js';
import { tieRows, owedBy, foldTies, aliasCanon } from '../npc-notes-kinds.js';

// The scan's short list of story events to watch for: this many people, this many events each.
const EVENT_WATCH_NPCS = 6;
const EVENT_WATCH_EACH = 3;
// The widths (percent) the Secrets section draws its blank bars at, in turn.
const BAR_WIDTHS = Object.freeze([62, 48, 56, 70]);

export function createEditorPart(session, deps) {
    const {
        catalog, entryFor, headReply, part, setupOf, sliceEntries,
    } = deps;

    // ---- the dossier editor and the dossier view (hosted only) ----

    const EDITOR = Object.freeze({
        secrets: 'npc_state_delta_edit_secrets',
        track: 'npc_state_delta_edit_meter_track',
        limits: 'npc_state_delta_edit_meter_limits',
        milestones: 'npc_state_delta_edit_milestones',
        meter: id => `npc_state_delta_edit_meter_${id}`,
        secretState: id => `npc_state_delta_edit_secret_state_${id}`,
    });
    const milestoneLines = entry => Object.values(entry?.milestones ?? {}).join('\n');

    // Whether the dossier editor may show a note's title, text and event: it is the reader's (no `from`: a pack or a scan wrote the others), or it is opened (the player knows it).
    const editorShows = (note, opened) => !note.from || opened.has(note.id);

    /**
     * The editor's v2 controls for one dossier, as markup ('' without a host): the hidden notes (with
     * titles), the stage ladder track, the per-meter limits, the milestones and the custom meters'
     * values (the slice's). Every value is escaped.
     */
    function editorHtml(npc) {
        if (!session.hosted || !npc) return '';
        const settings = part.meterSettings();
        const entry = entryFor(sliceEntries(), npc);
        const setup = setupOf(npc);
        const box = (id, label, help, value, rows = 3) => `
      <label class="npc-state-delta-editor-wide">${label} <small>${help}</small><textarea id="${id}" class="text_pole" rows="${rows}">${escapeHtml(value)}</textarea></label>`;
        // A locked note the reader did not write (a pack's or a scan's: its `from`) is not shown: no title, no text, no
        // event words, only that it is hidden and when it opens, with its open/shut control. The text box holds the reader's
        // own notes and the notes that are opened. Saving keeps every hidden note exactly as it is (readEditor).
        const opened = new Set(entry?.unlocked ?? []);
        const notes = normalizeSecrets(npc.secrets);
        const shown = notes.filter(note => editorShows(note, opened));
        const rules = new Map(part.notes({ name: npc.name, unlocked: [...opened], meters: entry?.meters }).locked.map(note => [note.id, note.opens]));
        let html = box(EDITOR.secrets, 'Hidden notes', 'One per line: "meter threshold: [title] note" (e.g. "trust 60: [Her past] She is the duke\'s daughter."), "when the duke falls => [title] note" for a note that opens on a story event (up to 120 characters; Delta\'s scan watches for it while this NPC is present), or "trust 60 or when the duke falls => note" for whichever comes first. A meter rule opens at or above its threshold (at or below it for a negative one). The story is told every note while this NPC is present (locked ones as hidden, never to be revealed). This box holds the notes you wrote and the notes that are opened; any other note stays hidden from you until it opens, and is kept as it is when you save.', secretsToLines(shown));
        if (notes.length) {
            let hiddenCount = 0;
            const rows = notes.map(note => {
                const open = opened.has(note.id);
                const control = label => `<select id="${EDITOR.secretState(note.id)}" class="text_pole" data-delta-secret="${escapeHtml(note.id)}" aria-label="${escapeHtml(label)}"><option value="hidden"${open ? '' : ' selected'}>Hidden</option><option value="open"${open ? ' selected' : ''}>Opened</option></select>`;
                if (editorShows(note, opened)) return `<label>${escapeHtml(note.title || note.text.slice(0, 40))}${control(note.title || 'Note')}</label>`;
                hiddenCount += 1;
                const name = `Hidden note ${hiddenCount}`;
                const opens = rules.get(note.id) ?? 'Opens with the story';
                return `<div class="npc-state-delta-v2-editor-hidden"><span>${escapeHtml(`${name} · ${opens[0].toLocaleLowerCase()}${opens.slice(1)}`)}</span>${control(name)}</div>`;
            });
            html += `
      <div class="npc-state-delta-editor-wide npc-state-delta-v2-editor-notes"><p class="npc-state-delta-muted">Open or shut a note by hand. A shut note stays shut until you open it.</p>${rows.join('')}</div>`;
        }
        const tracks = [...new Set(Object.keys(settings.ladder).filter(Boolean))];
        const presetName = id => catalog().find(preset => preset.id === id)?.name ?? id;
        if (part.featureOn(FEATURE_STAGES) && (tracks.length || setup.track)) {
            const options = [['', 'Everyone\'s ladder'], ...[...new Set([...tracks, ...(setup.track ? [setup.track] : [])])].map(id => [id, presetName(id)])];
            html += `
      <label class="npc-state-delta-editor-wide">Meter preset <small>Which stage ladder and limits this NPC follows.</small><select id="${EDITOR.track}" class="text_pole">${options.map(([id, label]) => `<option value="${escapeHtml(id)}"${id === setup.track ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></label>`;
        }
        html += box(EDITOR.limits, 'Meter limits', 'One meter per line: "affection: ceiling 40" or "trust: floor -20, ceiling 60". Story lines and scans never raise a meter past its ceiling or lower it past its floor; a change back from one always lands. Leave empty to use the preset\'s.', limitsToLines(setup.limits), 2);
        if (part.featureOn(FEATURE_STAGES)) html += box(EDITOR.milestones, 'Milestones', 'Story turning points, one per line (the story adds them with "+ milestone Name — what happened"). A stage on the ladder may need one.', milestoneLines(entry), 2);
        const custom = part.defs().filter(def => !def.builtIn);
        if (custom.length) {
            html += `
      <div class="npc-state-delta-editor-wide npc-state-delta-v2-editor-meters">${custom.map(def => `<label>${escapeHtml(def.label)}<input id="${EDITOR.meter(def.id)}" class="text_pole" type="number" min="${def.min}" max="${def.max}" value="${entry ? meterValue({ meters: entry.meters }, def) : def.start}" data-delta-meter="${escapeHtml(def.id)}"></label>`).join('')}</div>`;
        }
        return html;
    }

    /**
     * What the editor's v2 controls hold for dossier `current` (read(id) → a control's value, or
     * undefined when the control is not there): { secrets?, noteStates?: { open, close }, meterSetup?, milestones?: { add, remove },
     * meters?: { id: n } (changed custom values), problems: [sentences] }. Only what the reader changed.
     */
    function readEditor(read, current) {
        const out = { problems: [] };
        if (!session.hosted || typeof read !== 'function') return out;
        const value = id => {
            try { const got = read(id); return got === null || got === undefined ? undefined : String(got); } catch { return undefined; }
        };
        const secrets = value(EDITOR.secrets);
        if (secrets !== undefined) {
            // The box held only the notes the reader may see (editorHtml); every other note is kept exactly as it was.
            const entry = entryFor(sliceEntries(), current);
            const was = new Set(entry?.unlocked ?? []);
            const before = normalizeSecrets(current?.secrets);
            const kept = new Set(before.filter(note => !editorShows(note, was)).map(note => note.id));
            const parsed = secretsFromLines(secrets, before.filter(note => editorShows(note, was)));
            const written = new Map(parsed.secrets.map(note => [note.id, note]));
            const known = new Set(before.map(note => note.id));
            // The notes as stored (not as cleaned), by id, so a note that stays is exactly the one that was.
            const stored = new Map();
            for (const raw of Array.isArray(current?.secrets) ? current.secrets : []) {
                const id = normalizeSecrets([raw])[0]?.id;
                if (id && !stored.has(id)) stored.set(id, raw);
            }
            const list = [];
            for (const note of before) {
                if (kept.has(note.id) || written.has(note.id)) list.push(stored.get(note.id) ?? note);
            }
            // New or changed lines are the reader's own notes (no `from`); a line left as it was is the note it was.
            const fresh = parsed.secrets.filter(note => !known.has(note.id));
            const room = Math.max(0, MAX_SECRETS - list.length);
            list.push(...fresh.slice(0, room));
            out.secrets = list;
            const problems = [...parsed.problems, ...fresh.slice(room).map(note => (note.title ? `[${note.title}] ` : '') + note.text)];
            if (problems.length) out.problems.push(`these hidden notes were not kept (write "meter number: note" or "when the event => note"; up to ${MAX_SECRETS} in all): ${problems.join(' / ')}`);
            // A note whose state select the reader moved (open or shut by hand), among the notes now kept.
            const open = [];
            const close = [];
            for (const note of list) {
                const state = value(EDITOR.secretState(note.id));
                if (state === 'open' && !was.has(note.id)) open.push(note.id);
                if (state === 'hidden' && was.has(note.id)) close.push(note.id);
            }
            if (open.length || close.length) out.noteStates = { open, close };
        }
        const track = value(EDITOR.track);
        const limitsText = value(EDITOR.limits);
        if (track !== undefined || limitsText !== undefined) {
            const was = setupOf(current);
            const parsed = limitsText === undefined ? { limits: was.limits, problems: [] } : limitsFromLines(limitsText);
            if (parsed.problems.length) out.problems.push(`these meter limits were not kept (write "meter: ceiling N, floor N"): ${parsed.problems.join(' / ')}`);
            const next = { track: track === undefined ? was.track : track.trim().slice(0, 80), limits: parsed.limits };
            if (JSON.stringify(next) !== JSON.stringify(was)) out.meterSetup = next.track || Object.keys(next.limits).length ? next : null;
        }
        const entry = entryFor(sliceEntries(), current);
        const milestones = value(EDITOR.milestones);
        if (milestones !== undefined) {
            const had = entry?.milestones ?? {};
            const wanted = new Map(milestones.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => [wordKey(line), line]).filter(([key]) => key));
            const add = [...wanted].filter(([key]) => !Object.hasOwn(had, key)).map(([, line]) => line);
            const remove = Object.keys(had).filter(key => !wanted.has(key));
            if (add.length || remove.length) out.milestones = { add, remove };
        }
        const meters = {};
        for (const def of part.defs().filter(item => !item.builtIn)) {
            const raw = value(EDITOR.meter(def.id));
            if (raw === undefined || raw.trim() === '') continue;
            const number = Math.round(Number(raw));
            const was = entry ? meterValue({ meters: entry.meters }, def) : def.start;
            if (Number.isFinite(number) && number !== was) meters[def.id] = number;
        }
        if (Object.keys(meters).length) out.meters = meters;
        return out;
    }

    // A dossier's Secrets section, in the order the notes were written (light to deep): [{ state: 'open', title, text,
    // pill } | { state: 'hidden', opens, width }]. An opened note shows title, what opened it and its text; a hidden one
    // only that it is hidden and when it opens (never its title, text or event wording). [] without notes.
    function secretsViewOf(npc, entry) {
        const rules = normalizeSecrets(npc?.secrets);
        if (!rules.length) return [];
        const notes = part.notes({ name: npc.name, unlocked: entry?.unlocked ?? [], meters: entry?.meters });
        const opened = new Map(notes.opened.map(note => [note.id, note]));
        const locked = new Map(notes.locked.map(note => [note.id, note]));
        const out = [];
        let hiddenCount = 0;
        for (const rule of rules) {
            if (opened.has(rule.id)) out.push({ state: 'open', title: rule.title || 'A hidden note', text: rule.text, pill: opened.get(rule.id).text });
            else if (locked.has(rule.id)) {
                // The bar's length only varies the look: a fixed set of widths in turn, never anything from the note itself.
                out.push({ state: 'hidden', opens: locked.get(rule.id).opens, width: BAR_WIDTHS[hiddenCount % BAR_WIDTHS.length] });
                hiddenCount += 1;
            }
        }
        return out;
    }

    // The meters' own net change on the four built-in axes over the entry's latest reply window (window start → now), or null
    // (no window, no reply number, no net movement). Read time only; nothing is stored.
    const BUILT_IN_AXES = ['trust', 'affection', 'desire', 'tension'];
    // A window whose reply is past the head names a reply that is no longer there (an earlier message was deleted after it was
    // recorded, and `turn.at` is not re-numbered on replay): the card is not shown rather than naming the wrong reply (#295).
    function ownChangeOf(slice, head = null) {
        if (!slice?.window || !Number.isInteger(slice.reply) || slice.reply < 0) return null;
        if (Number.isInteger(head) && slice.reply > head) return null;
        const delta = {};
        for (const axis of BUILT_IN_AXES) {
            const from = slice.window.from?.[axis];
            const now = slice.meters?.[axis];
            delta[axis] = Number.isInteger(from) && Number.isInteger(now) ? now - from : 0;
        }
        const moved = BUILT_IN_AXES.filter(axis => delta[axis] !== 0);
        // This reply's event (tier, held, asked, date), when the slice kept one for the window's own reply.
        const event = eventSummary(slice.event);
        if (!moved.length && !(event?.held && Object.keys(event.ask).length)) return null;
        return { message: slice.reply, delta, ...(event ? { event } : {}) };
    }

    /**
     * Each dossier's v2 meters for Delta's dossier view, by dossier id ({} without a host): { bars:
     * [{ id, label, value, min, max, text, tone, builtIn, ceiling?, delta? }], rank, next, milestones:
     * [names], secrets: [see secretsViewOf] }. A hidden note is its rule only, never its title or text.
     * `relChange` ({ message, delta, event? }) is the meters' own net change of the latest reply window, when it moved an axis or the day's allowance held it;
     * `event` ({ tier, held, note, ask, date }) is that reply's event.
     */
    function dossierMeters(npcs) {
        if (!session.hosted || !Array.isArray(npcs) || typeof session.sdkRef?.query !== 'function') return {};
        let cast;
        const head = headReply?.();
        try {
            cast = session.sdkRef.query('npc.cast', Number.isInteger(head) ? { headReply: head } : {});
        } catch {
            return {};
        }
        cast = Array.isArray(cast) ? cast : [];
        const byKey = Object.fromEntries(cast.map(entry => [entry.key, entry]));
        const entries = sliceEntries() ?? [];
        const builtIn = new Set(part.defs().filter(def => def.builtIn).map(def => def.id));
        const out = {};
        // Ties are kept by the other person's entry key; the map and the Ties rows read them by dossier id and by bond.
        const idByKey = {};
        for (const npc of npcs) {
            const found = npc?.id ? part.identify(byKey, npc.name) : null;
            if (found && Object.hasOwn(byKey, found.key)) idByKey[found.key] = npc.id;
        }
        const canon = aliasCanon(npcs);
        const allTies = Object.fromEntries(cast.map(item => [item.key, item.notes?.ties ? foldTies(item.notes.ties, canon) : null]));
        for (const npc of npcs) {
            if (!npc?.id) continue;
            const who = part.identify(byKey, npc.name);
            const entry = who && Object.hasOwn(byKey, who.key) ? byKey[who.key] : null;
            const slice = entry ? entries.find(item => item.key === entry.key) : null;
            // Someone with notes but no meters yet still has a Secrets section (every note hidden).
            const secrets = secretsViewOf(npc, slice);
            if (!entry && !secrets.length) continue;
            const net = ownChangeOf(slice, head);
            out[npc.id] = {
                ...(net ? { relChange: net } : {}),
                ...(slice?.recent ? { recent: slice.recent } : {}),
                bars: (entry?.bars ?? []).map(bar => ({ ...bar, builtIn: builtIn.has(bar.id) })),
                rank: entry?.rank ?? '',
                next: entry?.next ?? '',
                // Mood and pull (feature mood-pull): only a person who has them (npc.cast's `mood` and `pull`).
                ...(entry?.mood ? { mood: entry.mood } : {}),
                ...(entry?.pull ? { pull: entry.pull } : {}),
                // Dossier notes ON (npc.cast's `notesOn`): the Profile shows its Tastes and Drives placeholders only then.
                ...(entry?.notesOn === true ? { notesOn: true } : {}),
                // Dossier notes (feature notes): the rows, the Ties rows for this person's bonds and the tags by dossier id (the map's lines).
                ...(entry?.notes ? { notes: { ...entry.notes, ties: tieRows(foldTies(entry.notes.ties, canon), npc.keyRelationships, owedBy(entry.key, allTies)) }, ties: Object.fromEntries(Object.entries(foldTies(entry.notes.ties, canon)).map(([key, tags]) => [idByKey[key] ?? key, tags])) } : {}),
                milestones: Object.values(slice?.milestones ?? {}),
                secrets,
            };
        }
        return out;
    }

    /**
     * The story events to watch for in this scan: for each present dossier (of `npcs`, Delta's records), its notes that open
     * on an event and are still locked and not shut by hand. Short on purpose (6 people, 3 events each):
     * [{ key: 's1', id: dossier id, name, note: noteId, event }]. [] without a host or without such notes.
     */
    function eventWatch(npcs) {
        if (!session.hosted || !Array.isArray(npcs)) return [];
        const entries = sliceEntries() ?? [];
        const out = [];
        let people = 0;
        for (const npc of npcs) {
            if (people >= EVENT_WATCH_NPCS) break;
            if (!npc?.id || !npc.present || npc.archived) continue;
            const slice = entryFor(entries, npc);
            const done = new Set([...(slice?.unlocked ?? []), ...(slice?.held ?? [])]);
            const events = normalizeSecrets(npc.secrets).filter(note => note.when && !done.has(note.id)).slice(0, EVENT_WATCH_EACH);
            if (!events.length) continue;
            people += 1;
            for (const note of events) out.push({ key: `s${out.length + 1}`, id: npc.id, name: npc.name, note: note.id, event: note.when });
        }
        return out;
    }

    return {
        editorHtml, readEditor, dossierMeters, eventWatch,
    };
}
