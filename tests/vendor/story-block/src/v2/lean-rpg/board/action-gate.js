// Recognises only explicit attacks on a standing, already known foe.
// Uncertain wording goes on with the normal send (no planner now) instead of holding the reader's message.
export const ATTACK = /\b(?:attack(?:s|ed|ing)?|strik(?:e|es|ing)|struck|stab(?:s|bed|bing)?|slash(?:es|ed|ing)?|swing(?:s|ing)?|swung|hit(?:s|ting)?|punch(?:es|ed|ing)?|kick(?:s|ed|ing)?|shoot(?:s|ing)?|shot|fight(?:s|ing)?|fought|battl(?:e|es|ing)|ambush(?:es|ed|ing)?|kill(?:s|ed|ing)?|slay(?:s|ing)?|slit(?:s|ting)?|grappl(?:e|es|ing)|tackl(?:e|es|ing)|lunge(?:s|d)?|thrust(?:s|ing)?|cut(?:s|ting)?|slic(?:e|es|ing)|cleav(?:e|es|ing)|hack(?:s|ed|ing)?|fire(?:s|d|ing)?|engag(?:e|es|ed|ing)|assault(?:s|ed|ing)?|charg(?:e|es|ed|ing)|pounc(?:e|es|ed|ing)|jump(?:s|ed|ing)?|leap(?:s|ed|ing)?|leapt|fall(?:s|ing)?\s+upon|fell\s+upon)\b/iu;
const OFFENSIVE_SKILL = /\b(?:attack|strik\w*|cut|slash\w*|stab\w*|damage|wound\w*|hit|shoot\w*|blast\w*|ambush\w*|weapon|blade|sword|combat)\b/iu;
const UNCERTAIN = /\b(?:not|never|no|avoid|avoidance|instead|if|unless|whether|would|could|might|maybe|consider|discuss|ask|tell|say|says|said|warn|threaten|talk|speak|don't|dont|won't|wont|cannot|can't|cant)\b/iu;
// The reader as the subject just before an attack word: at clause start, after a comma or colon, or after as/when/while/once/then/so/and;
// up to two adverbs and will / try to / attempt to may sit between subject and verb. Also the reader's own weapon or body part ("my cane",
// "our bare fists"), a short prepositional lead-in with no comma ("Without a word I", "With the boar distracted I"), and a motion
// followed by a purpose ("I slip in from the shadows to"). A third party ("the boar", "my sister") is never the subject.
// The reader's weapons, in one place: a phrasal attack moves one of these, and only one of these counts as the reader's own "my ...".
export const WEAPON = new Set(['cane', 'ferrule', 'blade', 'sword', 'knife', 'dagger', 'spear', 'axe', 'hammer', 'mace', 'club', 'staff', 'cudgel', 'pick', 'stick', 'bow', 'weapon']);
const ADVERB = String.raw`(?:\s+(?:\w+ly|then|quickly|finally|just|also))`;
const OWN = String.raw`(?:my|our)(?:\s+[\p{L}-]+)?\s+(?:${[...WEAPON].join('|')})s?`;
const SUBJECT = String.raw`(?:i|we|${OWN})${ADVERB}{0,2}(?:\s+(?:will|try to|attempt to)${ADVERB}{0,2})?`;
const LEAD = String.raw`^(?:without|with|after|before|upon|during|under|behind|through|using|keeping|holding|drawing|seeing)\b[^,:;]*?\s(?:i|we)${ADVERB}{0,2}`;
const PURPOSE = String.raw`^(?:i|we)\s+(?:slip|creep|sneak|move|step|dash|run|rush|head|go|ride|walk|crawl|stalk|circle|duck|edge|spring)\w*\b[^,;:]*?\s(?:in order )?to`;
export const READER_SUBJECT = new RegExp(String.raw`(?:(?:^|[,:]\s*|\b(?:as|when|while|once|then|so|and)\s+)${SUBJECT}|${LEAD}|${PURPOSE})$`, 'iu');
// Phrasal attacks. kind 'into': the object moved is a WEAPON word and the words after the link name a creature, a body part or him/her
// (or the target is a creature noun whatever is moved); 'creature': the words after must name a creature; 'mid': the thing taken by
// surprise must be a creature; 'free': the verb alone. The mid words are never a vehicle, load or place. Idioms never count.
const LOAD = new Set(['cart', 'handcart', 'wagon', 'barrow', 'town', 'yard', 'cellar', 'meat', 'home', 'sack', 'crate', 'load', 'cargo']);
const CREATURE = new Set(['them', 'boar', 'sow', 'pig', 'beast', 'wolf', 'bear', 'rat', 'bandit', 'guard', 'thug', 'man', 'woman', 'creature', 'monster', 'foe', 'enemy', 'enemie', 'brute', 'goblin', 'orc', 'skeleton', 'zombie', 'spider', 'snake', 'dog', 'hound', 'stag', 'men', 'women', 'ogre', 'troll', 'thief', 'raider', 'cultist', 'soldier', 'knight', 'drake', 'wyrm', 'bat', 'ghoul', 'imp']);
const BODY = new Set(['him', 'her', 'skull', 'throat', 'eye', 'head', 'neck', 'leg', 'belly', 'flank', 'face', 'chest', 'rib', 'back', 'jaw', 'snout', 'shoulder', 'arm', 'hand', 'tusk', 'hide']);
const IDIOM = /^\s*(?:a|an|the|my|our|his|her)?\s*(?:deal|bargain|pose|match|balance|chord|rope|cards|cord|smile|joke|grin)s?\b/iu;
const PHRASAL = [
    [/\b(driv(?:e|es|ing)|drove|plung(?:e|es|ed|ing)|sink|sinks|sank|sinking|bur(?:y|ies|ied|ying))\b(.{0,40}?)\s(into)\s+(.*)$/iu, 'into'],
    [/\b(bring|brings|bringing|brought)\b(.{0,40}?)\s(down\s+(?:on|upon))\s+(.*)$/iu, 'into'],
    [/\b(go|goes|going|went)()\s(for)\s+(.*)$/iu, 'creature'],
    [/\b(rush|rushes|rushed|rushing)()\s(at)\s+(.*)$/iu, 'creature'],
    [/\b(hurl(?:s|ed|ing)?)\b(.{0,40}?)\s(at)\s+(.*)$/iu, 'creature'],
    [/\b(tak(?:e|es|ing)|took|cut(?:s|ting)?|strik(?:e|es|ing)|struck)()\s(down)\s+(.*)$/iu, 'creature'],
    [/\b(smash(?:es|ed|ing)?|bash(?:es|ed|ing)?|club(?:s|bed|bing)?|jab(?:s|bed|bing)?|crack(?:s|ed|ing)?)\b()()()(.*)$/iu, 'creature'],
    [/\b(lash(?:es|ed|ing)?\s+out)\b()()()/iu, 'free'],
    [/\b(tak(?:e|es|ing)|took)\b(.{0,30}?)\s(by\s+surprise)\b()/iu, 'mid'],
    [/\b(bludgeon(?:s|ed|ing)?|maul(?:s|ed|ing)?)\b()()()/iu, 'free'],
];
const wordsIn = text => (String(text).toLowerCase().match(/\p{L}+/gu) ?? []);
const base = word => word.replace(/s$/u, '');
const first = (text, set) => wordsIn(text).slice(0, 5).some(word => set.has(word) || set.has(base(word)));
const namesCreature = text => first(text, CREATURE);

/** Every attack in a clause as `{ index, length }` (the verb only), plain attack words and the phrasal shapes alike, in order; [] when none. */
export function findAttacks(clause) {
    const found = [];
    for (const bare of clause.matchAll(new RegExp(ATTACK.source, 'giu'))) {
        if (IDIOM.test(clause.slice(bare.index + bare[0].length))) continue;
        found.push({ index: bare.index, length: bare[0].length });
    }
    for (const [rule, kind] of PHRASAL) {
        const match = rule.exec(clause);
        if (!match || wordsIn(match[2]).some(word => LOAD.has(word))) continue;
        const after = match[5] ?? match[4];
        if (kind === 'creature' && !namesCreature(after)) continue;
        if (kind === 'mid' && !namesCreature(match[2])) continue;
        if (kind === 'into' && !namesCreature(after)
            && !(wordsIn(match[2]).some(word => WEAPON.has(word) || WEAPON.has(base(word))) && first(after, BODY))) continue;
        found.push({ index: match.index, length: match[1].length });
    }
    return found.sort((a, b) => a.index - b.index);
}
/** The first attack in a clause, or null. */
export const findAttack = clause => findAttacks(clause)[0] ?? null;
const OWN_END = new RegExp(String.raw`(?:^|\W)${OWN}${ADVERB}{0,2}$`, 'iu');
/** The reader's own weapon as the subject needs a creature (or a body part of one) after the verb, or an intransitive "lashes out". */
export function ownSubjectOk(before, clause, action) {
    if (!OWN_END.test(before)) return true;
    const rest = clause.slice(action.index);
    return /^lash/iu.test(rest) || namesCreature(rest.slice(action.length));
}
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const parts = text => String(text ?? '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

function foeTarget(phrase, foes) {
    const tokens = parts(phrase);
    const target = ['them', 'it', 'enemy', 'enemies', 'foe', 'foes', 'opponent', 'opponents'];
    for (const foe of foes) for (const part of parts(foe.name)) if (part.length >= 3) target.push(part);
    const matches = word => target.some(part => word === part || `${word}s` === part || `${part}s` === word);
    const namesAt = start => {
        let at = start;
        while (['a', 'an', 'the', 'this', 'that', 'these', 'those', 'some', 'all'].includes(tokens[at])) at += 1;
        return matches(tokens[at]);
    };
    if (namesAt(0)) return true;
    // A weapon may precede an explicit target: "swing my sword at the rats".
    return tokens.some((word, at) => ['at', 'against', 'toward', 'towards', 'on', 'upon', 'into', 'for'].includes(word) && namesAt(at + 1));
}

export function knownFoeAction(text, sheet) {
    const foes = (sheet?.foes ?? []).filter(foe => foe.filled && foe.hurt > 0);
    if (!foes.length) return false;
    const skills = (sheet?.characters ?? []).flatMap(actor => actor.skills ?? []).filter(skill => OFFENSIVE_SKILL.test(`${skill.name ?? ''} ${skill.about ?? ''}`));
    const clauses = String(text ?? '').replace(/[“"][^”"]*[”"]/gu, ' ').split(/[.!?;\n]|\b(?:and|then|but)\b/iu);
    return clauses.some(clause => {
        if (UNCERTAIN.test(clause)) return false;
        let actions = [];
        for (const skill of skills) {
            const name = String(skill.name ?? '').trim();
            if (name.length < 3) continue;
            const match = new RegExp(`\\b(?:use|using|cast|perform)\\s+(?:my\\s+)?${escape(name)}\\s+(?:on|at|against)\\b`, 'iu').exec(clause);
            if (match) { actions = [match]; break; }
        }
        if (!actions.length) actions = findAttacks(clause);
        // Every attack word is judged: "while the dogs are mauling him, I attack the dogs" is the reader attacking.
        return actions.some(action => {
            const before = clause.slice(0, action.index).trim();
            if (before && !READER_SUBJECT.test(before)) return false;
            if (before && !ownSubjectOk(before, clause, action)) return false;
            return foeTarget(clause.slice(action.index + (action.length ?? action[0].length)), foes);
        });
    });
}
