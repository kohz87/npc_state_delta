// Story Block v2: the small notes under a reply, and the reply's refused change lines (MODULES §F40, §F41).
// ui-host.js creates one per page.
//
// * **No change lines** (§F40): a reply Story Block read (it has a v2 record for the shown swipe) whose text
//   holds no <Changes> block, while the after-reply extractor is off, gets a quiet one-line warning under
//   its text. Nothing is wrong when nothing changed; the warning says that nothing was kept, so a reply that
//   told of a rope picked up without listing it is noticed.
// * **Edited**: a reply edited in this session keeps the changes it had (SPEC §4.2); its note says so.
// * **Re-read** on either note runs the host's Re-read for that reply (`reread(index)`, which replaces the
//   reply's `story` receipts with a fresh capture of its <Changes> block, store.replaceStory). Only when
//   the host offers one: without it the missing-lines note shows alone and edits get no note.
// * **Refused lines** (§F41): what the turn reported for a reply (its `turn` event's problems, or the
//   turn's problems list for that index) as `[{ line, reason }]`, per reply and swipe, for the changes card.
//
// The greeting, the reader's messages, system messages and replies from before v2 never get a note. Every
// text is set with textContent; the texts are in strings.js.

import { extractBlock } from './capture.js';
import { isCarrier, readRecord, swipeOf } from './persist.js';
import { STRINGS, fill } from './strings.js';

const N = STRINGS.notes;
const NOTE = 'story-suite-reply-note';

/** The reason part of a turn problem about a change line (its message without the line itself). */
export function problemReason(item) {
    const message = String(item?.message ?? '');
    const line = typeof item?.line === 'string' ? item.line : null;
    if (line) {
        const prefix = `"${line}" was not used: `;
        if (message.startsWith(prefix)) return message.slice(prefix.length);
    }
    if (item?.code === 'UNKNOWN_KIND') {
        const kind = /^No module keeps "([^"]*)"/.exec(message)?.[1];
        if (kind !== undefined) return fill(STRINGS.card.unknownKind, { kind });
    }
    return line && message.includes(`"${line}"`) ? '' : message;
}

/**
 * The change lines of reply `index` the code did not apply, from turn problems
 * (`{ index, line?, code, message, quiet? }`): [{ line, reason }] in the order reported. A problem without a
 * line (a block that could not be read) is listed by its message; a quiet one (FEATURE_OFF) is not listed.
 */
export function refusedFrom(problems, index) {
    const out = [];
    for (const item of Array.isArray(problems) ? problems : []) {
        // A quiet problem (a line of a feature the reader turned off) is not a refusal.
        if (!item || item.index !== index || item.quiet === true) continue;
        if (typeof item.line === 'string' && item.line) out.push({ line: item.line, reason: problemReason(item) });
        else if (item.code === 'UNREADABLE' && item.message) out.push({ line: String(item.message), reason: '' });
    }
    return out;
}

/** The first carrier's index (the greeting), or -1. */
const firstCarrier = chat => (Array.isArray(chat) ? chat.findIndex(isCarrier) : -1);

/**
 * createReplyNotes({ ctx, doc?, extractorOn?() → bool, extractorFailed?(index, swipe) → bool, reread?(index) → Promise<{ ok, problems?, message? }>,
 * turn? (for problems()), events? (the runtime's: 'turn', 'head'), messageElement?(index), onChanged?(index) })
 * → { refresh(index), refreshAll(), refusedAt(index), noteKind(index), markEdited(index), onTurn(turn),
 *     reread(index), forget(), destroy() }
 */
export function createReplyNotes({
    ctx, doc = globalThis.document, extractorOn = () => false, extractorFailed = () => false, reread = null, turn = null, events = null,
    messageElement = null, onChanged = () => {},
} = {}) {
    const chat = () => (Array.isArray(ctx?.chat) ? ctx.chat : []);
    const elementOf = messageElement ?? (index => doc.querySelector(`.mes[mesid="${index}"]`));
    const canReread = typeof reread === 'function';
    const edited = new Set();      // `${index}|${swipe}` edited since the chat was opened
    const refused = new Map();     // `${index}|${swipe}` → [{ line, reason }]
    const busy = new Map();        // index → true while a Re-read runs
    const failed = new Map();      // `${index}|${swipe}` → message of the last failed Re-read
    const keyOf = index => `${index}|${swipeOf(chat()[index])}`;

    /** 'missing' | 'edited' | null: which note reply `index` gets now. */
    function noteKind(index) {
        const message = chat()[index];
        if (!isCarrier(message) || message.is_system || index === firstCarrier(chat())) return null;
        if (!readRecord(message)) return null;
        let extractor = false;
        try { extractor = extractorOn() === true; } catch { extractor = false; }
        // C2-ext: the extractor's call failed (an error, a time-out) on this reply: nobody read it.
        if (extractor) {
            try { extractor = extractorFailed(index, swipeOf(message)) !== true; } catch { /* still on */ }
        }
        if (!extractor && extractBlock(String(message.mes ?? '')) === null) return 'missing';
        if (canReread && edited.has(keyOf(index))) return 'edited';
        return null;
    }

    function build(kind) {
        const note = doc.createElement('div');
        note.className = NOTE;
        note.setAttribute('role', 'note');
        const icon = doc.createElement('i');
        icon.className = `fa-solid ${kind === 'missing' ? 'fa-triangle-exclamation' : 'fa-pen'}`;
        icon.setAttribute('aria-hidden', 'true');
        const text = doc.createElement('span');
        text.className = `${NOTE}-text`;
        note.append(icon, text);
        if (canReread) {
            const button = doc.createElement('button');
            button.type = 'button';
            button.setAttribute('type', 'button');
            button.className = `${NOTE}-reread`;
            button.setAttribute('title', N.rereadTitle);
            button.addEventListener('click', event => {
                event?.stopPropagation?.();
                const index = Number(note.getAttribute('data-ss-index'));
                if (Number.isInteger(index)) runReread(index);
            });
            note.appendChild(button);
        }
        const error = doc.createElement('span');
        error.className = `${NOTE}-error`;
        error.setAttribute('role', 'alert');
        error.hidden = true;
        note.appendChild(error);
        return note;
    }

    function place(message, note) {
        const text = message.querySelector('.mes_text');
        const parent = text?.parentNode ?? message.querySelector('.mes_block') ?? message;
        const after = text ? text.nextElementSibling : null;
        if (note.parentNode === parent && (text ? note === after : true)) return;
        parent.insertBefore(note, after);
    }

    /** Draws, updates or removes the note under reply `index` (when SillyTavern has drawn it). */
    function refresh(index) {
        const message = elementOf(index);
        if (!message) return null;
        let note = message.querySelector(`.${NOTE}`);
        const kind = noteKind(index);
        if (!kind) {
            note?.remove();
            return null;
        }
        if (!note || note.getAttribute('data-kind') !== kind) {
            note?.remove();
            note = build(kind);
        }
        note.setAttribute('data-kind', kind);
        note.setAttribute('data-ss-index', String(index));
        note.querySelector(`.${NOTE}-text`).textContent = kind === 'missing' ? N.missing : N.edited;
        note.setAttribute('title', kind === 'missing' ? N.missingTitle : '');
        const button = note.querySelector(`.${NOTE}-reread`);
        if (button) {
            const running = busy.has(index);
            button.textContent = running ? N.rereading : N.reread;
            button.disabled = running;
            if (running) button.setAttribute('aria-busy', 'true');
            else button.removeAttribute('aria-busy');
        }
        const error = note.querySelector(`.${NOTE}-error`);
        const why = failed.get(keyOf(index));
        error.textContent = why ? fill(N.rereadFailed, { message: why }) : '';
        error.hidden = !why;
        place(message, note);
        return note;
    }

    /** Every reply SillyTavern has drawn. */
    function refreshAll() {
        for (const message of doc.querySelectorAll('.mes[mesid]')) {
            const index = Number(message.getAttribute('mesid'));
            if (Number.isInteger(index)) refresh(index);
        }
    }

    async function runReread(index) {
        if (!canReread || busy.has(index)) return null;
        const key = keyOf(index);
        busy.set(index, true);
        failed.delete(key);
        refresh(index);
        let result;
        try {
            result = await reread(index);
        } catch (error) {
            result = { ok: false, message: error?.message ?? String(error) };
        }
        busy.delete(index);
        if (result?.ok) {
            edited.delete(key);
            if (Array.isArray(result.problems)) refused.set(key, refusedFrom(result.problems.map(item => ({ index, ...item })), index));
        } else {
            failed.set(key, result?.message ?? N.unknownError);
        }
        refresh(index);
        try { onChanged(index); } catch { /* the card redraw is a courtesy */ }
        return result;
    }

    /** A turn the runtime finished (its 'turn' event): the reply's refused lines, then its note. */
    function onTurn(done) {
        const index = Number(done?.index);
        if (!Number.isInteger(index)) return;
        const key = keyOf(index);
        const problems = Array.isArray(done.problems) ? done.problems : (turn?.problems?.() ?? []);
        const lines = refusedFrom(problems, index);
        // Late lines (the extractor's) add to what the reply already had; anything else starts afresh.
        refused.set(key, done.type === 'late' ? [...(refused.get(key) ?? []), ...lines] : lines);
        failed.delete(key);
        refresh(index);
    }

    /** The refused change lines of reply `index`, on its shown swipe: [{ line, reason }]. */
    function refusedAt(index) {
        return (refused.get(keyOf(index)) ?? []).map(item => ({ ...item }));
    }

    function markEdited(index) {
        const at = Number(index);
        if (!Number.isInteger(at) || !readRecord(chat()[at])) return;
        edited.add(keyOf(at));
        refresh(at);
    }

    /** Message indexes moved (a delete) or the chat changed: nothing kept by index still holds. */
    function forget() {
        edited.clear();
        refused.clear();
        failed.clear();
        busy.clear();
    }

    // ---- following SillyTavern and the runtime ----------------------------------------------
    const offs = [];
    const indexOf = value => Number(typeof value === 'object' && value !== null ? value.messageId ?? value.index : value);
    const source = ctx?.eventSource;
    const types = ctx?.eventTypes ?? ctx?.event_types ?? {};
    if (typeof source?.on === 'function') {
        const wire = [
            [types.CHARACTER_MESSAGE_RENDERED, value => refresh(indexOf(value))],
            [types.MESSAGE_SWIPED, value => refresh(indexOf(value))],
            [types.MESSAGE_EDITED, value => markEdited(indexOf(value))],
            [types.MESSAGE_UPDATED, value => refresh(indexOf(value))],
            [types.MESSAGE_DELETED, () => { forget(); refreshAll(); }],
            [types.CHAT_CHANGED, () => { forget(); refreshAll(); }],
            [types.MORE_MESSAGES_LOADED, () => refreshAll()],
        ].filter(([type]) => type);
        for (const [type, fn] of wire) source.on(type, fn);
        offs.push(() => {
            for (const [type, fn] of wire) (source.removeListener ?? source.off)?.call(source, type, fn);
        });
    }
    if (typeof events?.on === 'function') {
        for (const off of [events.on('turn', onTurn), events.on('head', () => refreshAll())]) if (typeof off === 'function') offs.push(off);
    }

    return {
        refresh,
        refreshAll,
        refusedAt,
        noteKind,
        markEdited,
        onTurn,
        reread: runReread,
        canReread: () => canReread,
        forget,
        destroy() {
            offs.splice(0).forEach(off => off());
            forget();
            for (const note of doc.querySelectorAll(`.${NOTE}`)) note.remove();
        },
    };
}
