// The game view's header (UI stage 5a): the `ss.hero` block at the top of every screen of the game view, read from the
// head state. The lead is the party's own character (`party.pc`; without a party module, the reader's persona
// name), its HP, MP and SP pools, the level under the Terms' word and its conditions. The scene is `scene.place`,
// `scene.weather` and the story time (`director.time`, Story Director; formatted by the host's `fmt.time`), and, while
// `story-block.you` is on, the persona's rank, what they wear and how they are (`scene.you`, with the pencil's command). Every
// read goes through `query(name, args)` and falls back to nothing: a missing module shows no bar, not an error.
//
// The portrait is the first safe picture of: the persona's avatar (`/thumbnail?type=persona&file=…`), the character
// card's avatar (`/thumbnail?type=avatar&file=…`), a picture a module answers for the lead (`npc.portrait`, Delta's
// query, asked with `{ name }`), else '' (the hero draws the initial). Nothing here runs a command.
//
// The reader's SillyTavern is read through `readHeroContext()` (getContext(): name1, characters and characterId; the
// current persona's file from the context when it has one, else from the page: personaFileOnPage). Tests pass their own
// context and document.

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

// The persona thumbnail a user message or the persona list shows: `/thumbnail?type=persona&file=…` (SillyTavern's getThumbnailUrl).
const personaFileOfSrc = src => {
    try {
        const url = new URL(textOf(src), 'http://local.invalid');
        return url.pathname === '/thumbnail' && url.searchParams.get('type') === 'persona' ? textOf(url.searchParams.get('file')) : '';
    } catch { return ''; }
};

/**
 * The current persona's avatar file from the page, '' when none is found. SillyTavern 1.19's getContext() does not carry it
 * (`user_avatar` is personas.js's own state): the persona list marks the current persona's row `selected` (its
 * `data-avatar-id` is the file), and the newest user message shows the persona's picture unless it was given another one.
 */
export function personaFileOnPage(doc = globalThis.document) {
    try {
        const row = doc?.querySelector?.('#user_avatar_block .avatar-container.selected');
        const listed = textOf(row?.getAttribute?.('data-avatar-id') ?? row?.getAttribute?.('imgfile') ?? '');
        if (listed) return listed;
        const pictures = [...(doc?.querySelectorAll?.('.mes[is_user="true"] .avatar img') ?? [])];
        for (let i = pictures.length - 1; i >= 0; i -= 1) {
            const file = personaFileOfSrc(pictures[i]?.getAttribute?.('src') ?? '');
            if (file) return file;
        }
    } catch { /* no page here (a test, or SillyTavern not drawn yet): none */ }
    return '';
}

/**
 * What the reader's SillyTavern says about the persona and the open character: names and avatar files, '' for none.
 * The persona's file is the first of: the context's `user_avatar` (or SillyTavern's global),
 * the current persona on the page (personaFileOnPage), and the settings' default persona (power user's `default_persona`).
 */
export function readHeroContext(context = globalThis.SillyTavern?.getContext?.() ?? null, doc = globalThis.document) {
    let card = null;
    try {
        const id = context?.characterId;
        card = id != null && Array.isArray(context?.characters) ? context.characters[id] ?? null : null;
    } catch { card = null; }
    const fromContext = textOf(context?.user_avatar ?? context?.userAvatar ?? globalThis.user_avatar);
    return {
        personaName: textOf(context?.name1),
        personaFile: fromContext || personaFileOnPage(doc) || textOf(context?.powerUserSettings?.default_persona),
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

// A condition's icon, from the icon set (view/icons/set.js). The set has no flame, so burning is a warning, as is any kind not listed.
const CONDITION_ICONS = Object.freeze({ bleeding: 'ph-drop', poison: 'ph-skull', poisoned: 'ph-skull', stunned: 'ph-lightning', dazed: 'ph-lightning', slowed: 'ph-clock' });
export const conditionIcon = kind => CONDITION_ICONS[String(kind ?? '').trim().toLowerCase()] ?? 'ph-warning';

// A condition's name for the badge: its kind with the first letter up ("bleeding" → "Bleeding").
const conditionLabel = kind => {
    const words = String(kind ?? '').replace(/[_-]+/g, ' ').trim();
    return words ? (words.charAt(0).toUpperCase() + words.slice(1)).slice(0, TEXT_MAX) : '';
};

// A number from an entry's field, or null when it is missing or not one.
const numberOf = value => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));

/**
 * What a condition entry says of its time left and the unit it is in: `minutes` (or `until`, a story minute, against `minutesNow`),
 * `left` in the unit it names, or `rounds`. `{ left: null, unit: 'turns' }` when none is given: the badge then shows no count.
 */
export function conditionLeft(entry, minutesNow = null) {
    const minutes = numberOf(entry?.minutes);
    if (minutes !== null) return { left: minutes, unit: 'minutes' };
    const until = numberOf(entry?.until);
    if (until !== null && minutesNow !== null) return { left: Math.max(0, until - minutesNow), unit: 'minutes' };
    const left = numberOf(entry?.left);
    if (left !== null) return { left, unit: ['turns', 'rounds', 'minutes'].includes(entry?.unit) ? entry.unit : 'turns' };
    const rounds = numberOf(entry?.rounds);
    if (rounds !== null) return { left: rounds, unit: 'rounds' };
    return { left: null, unit: 'turns' };
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
    // `scene.you` answers null while the feature is off (or with no Story Block): no rows then, not empty ones.
    const you = safeQuery(query, 'scene.you', {});
    const time = safeQuery(query, 'director.time', {});
    // The trip Story Director keeps (`atlas.trip`, 2.5): its one-line `row`; null with no trip, with the feature off or with an older Story Director.
    const trip = safeQuery(query, 'atlas.trip', {});
    const travel = textOf(trip?.row).slice(0, 200);
    const minutes = count(time?.minutes);
    const bars = [];
    for (const [kind, label] of [['hp', 'HP'], ['mp', 'MP'], ['sp', 'SP']]) {
        const pool = lead?.[kind];
        const max = count(pool?.max);
        if (max == null || max <= 0) continue;
        bars.push({ kind, label, value: count(pool.cur) ?? 0, max, text: `${count(pool.cur) ?? 0} / ${max}` });
    }
    // A condition is named by its kind (or its name); its icon and its time left come from the kind and the entry's own fields.
    const kindOf = entry => (typeof entry?.kind === 'string' && entry.kind ? entry.kind : typeof entry?.name === 'string' ? entry.name : '');
    const statuses = (Array.isArray(lead?.conditions) ? lead.conditions : [])
        .filter(entry => entry && typeof entry === 'object' && kindOf(entry))
        .slice(0, 12)
        .map(entry => ({ id: kindOf(entry), label: conditionLabel(kindOf(entry)), icon: conditionIcon(kindOf(entry)), tone: 'bad', kind: kindOf(entry), ...conditionLeft(entry, minutes) }));
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
        ...(you && typeof you === 'object' ? { you: { ...(textOf(you.rankLabel) ? { rank: textOf(you.rank).slice(0, 120), rankLabel: textOf(you.rankLabel).slice(0, 30) } : {}), wearing: textOf(you.wearing).slice(0, 120), condition: textOf(you.condition).slice(0, 120), command: 'scene.you' } } : {}),
        ...(travel ? { travel } : {}),
    };
}
