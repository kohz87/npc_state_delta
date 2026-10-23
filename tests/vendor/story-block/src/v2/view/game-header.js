// The game view's header (UI stage 5a): the `ss.hero` block at the top of every screen of the game view, read from the
// head state. The lead is the party's own character (`party.pc`, RPG Battle; with no RPG Battle, the reader's persona
// name), its HP, MP and SP pools, the level under the Terms' word and its conditions. The scene is `scene.place`,
// `scene.weather` and the story time (`director.time`, Story Director; formatted by the host's `fmt.time`). Every
// read goes through `query(name, args)` and falls back to nothing: a missing module shows no bar, not an error.
//
// The portrait is the first safe picture of: the persona's avatar (`/thumbnail?type=persona&file=…`), the character
// card's avatar (`/thumbnail?type=avatar&file=…`), a picture a module answers for the lead (`npc.portrait`, Delta's
// query, asked with `{ name }`), else '' (the hero draws the initial). Nothing here runs a command.
//
// The reader's SillyTavern is read through `readHeroContext()` (getContext(): name1, user_avatar, characters and
// characterId, the same fields RPG Battle's persona reader uses); tests pass their own context.

const TEXT_MAX = 120;

const textOf = value => (typeof value === 'string' ? value.trim() : '');
const count = value => (Number.isFinite(Number(value)) ? Number(value) : null);

/** A SillyTavern avatar file as the path it is served on ('' for none). */
export function personaAvatarUrl(file) {
    const name = textOf(file);
    return name ? `/thumbnail?type=persona&file=${encodeURIComponent(name)}` : '';
}

export function cardAvatarUrl(file) {
    const name = textOf(file);
    return name ? `/thumbnail?type=avatar&file=${encodeURIComponent(name)}` : '';
}

/** What the reader's SillyTavern says about the persona and the open character: names and avatar files, '' for none. */
export function readHeroContext(context = globalThis.SillyTavern?.getContext?.() ?? null) {
    let card = null;
    try {
        const id = context?.characterId;
        card = id != null && Array.isArray(context?.characters) ? context.characters[id] ?? null : null;
    } catch { card = null; }
    return {
        personaName: textOf(context?.name1),
        // the persona's avatar file: the context's, else SillyTavern's global (as RPG Battle's persona reader reads it), else the
        // default persona of the settings (power user's `default_persona`: the file a new chat uses)
        personaFile: textOf(context?.user_avatar ?? context?.userAvatar ?? globalThis.user_avatar ?? context?.powerUserSettings?.default_persona),
        cardName: textOf(card?.name),
        cardFile: textOf(card?.avatar),
    };
}

/** A module's picture answer: a string, or `{ url }` / `{ src }` (what a query may answer); '' for none. */
export function pictureOf(answer) {
    if (typeof answer === 'string') return textOf(answer);
    if (answer && typeof answer === 'object') return textOf(answer.url ?? answer.src ?? '');
    return '';
}

/**
 * The pictures for the lead in the order to try them: the persona avatar, the card avatar, the module's picture (`npcPicture`,
 * already a string: see pictureOf). Empty ones are left out; the hero tries them in turn and draws the initial past the last.
 */
export function portraitCandidates({ personaFile = '', cardFile = '', npcPicture = '' } = {}) {
    return [personaAvatarUrl(personaFile), cardAvatarUrl(cardFile), textOf(npcPicture)].filter(Boolean);
}

/** The first of portraitCandidates: '' when there is none. */
export function portraitOf(args = {}) {
    return portraitCandidates(args)[0] ?? '';
}

function safeQuery(query, name, args) {
    if (typeof query !== 'function') return null;
    try {
        return query(name, args) ?? null;
    } catch {
        return null;
    }
}

/**
 * The props of `ss.hero` for the game view's header, or null when there is no state to show (no chat).
 * `query(name, args)` reads the head state; `context` is readHeroContext()'s answer; `formatTime(minutes)` is the host's fmt.time.
 */
export function gameHeroProps({ state = null, query = null, context = {}, formatTime = null } = {}) {
    if (!state) return null;
    const pc = safeQuery(query, 'party.pc', {});
    const lead = pc && typeof pc === 'object' ? pc : null;
    const terms = safeQuery(query, 'party.terms', {});
    const levelWord = textOf(terms?.levelName) || 'Lv';
    const level = lead ? count(lead.level) : null;
    const name = textOf(lead?.name) || textOf(context.personaName) || textOf(context.cardName);
    const npc = name ? pictureOf(safeQuery(query, 'npc.portrait', { name })) : '';
    const place = safeQuery(query, 'scene.place', {});
    const weather = safeQuery(query, 'scene.weather', {});
    const time = safeQuery(query, 'director.time', {});
    const minutes = count(time?.minutes);
    const bars = [];
    for (const [kind, label] of [['hp', 'HP'], ['mp', 'MP'], ['sp', 'SP']]) {
        const pool = lead?.[kind];
        const max = count(pool?.max);
        if (max == null || max <= 0) continue;
        bars.push({ kind, label, value: count(pool.cur) ?? 0, max, text: `${count(pool.cur) ?? 0} / ${max}` });
    }
    const statuses = (Array.isArray(lead?.conditions) ? lead.conditions : [])
        .filter(entry => entry && typeof entry.kind === 'string' && entry.kind)
        .slice(0, 12)
        .map(entry => ({ id: entry.kind, label: entry.kind, tone: 'bad', kind: entry.kind }));
    const when = minutes != null && typeof formatTime === 'function' ? textOf(formatTime(minutes)) : '';
    return {
        name: name.slice(0, 60),
        portrait: portraitOf({ personaFile: context.personaFile, cardFile: context.cardFile, npcPicture: npc }),
        portraits: portraitCandidates({ personaFile: context.personaFile, cardFile: context.cardFile, npcPicture: npc }),
        className: textOf(lead?.className ?? lead?.class).slice(0, 40),
        level: level != null ? `${levelWord} ${level}`.slice(0, TEXT_MAX) : '',
        title: textOf(lead?.role).slice(0, 40),
        bars,
        place: textOf(place?.name).slice(0, 40),
        time: when.slice(0, 40),
        weather: textOf(weather?.text).slice(0, 40),
        statuses,
    };
}
