// Recognises only explicit attacks on a standing, already known foe.
// Uncertain wording remains on the normal planner path instead of holding the reader's message.
const ATTACK = /\b(?:attack(?:s|ed|ing)?|strik(?:e|es|ing)|struck|stab(?:s|bed|bing)?|slash(?:es|ed|ing)?|swing(?:s|ing)?|swung|hit(?:s|ting)?|punch(?:es|ed|ing)?|kick(?:s|ed|ing)?|shoot(?:s|ing)?|shot|fight(?:s|ing)?|fought|battl(?:e|es|ing)|ambush(?:es|ed|ing)?|kill(?:s|ed|ing)?|slay(?:s|ing)?|grappl(?:e|es|ing)|tackl(?:e|es|ing)|lunge(?:s|d)?|thrust(?:s|ing)?|cut(?:s|ting)?|slic(?:e|es|ing)|cleav(?:e|es|ing)|hack(?:s|ed|ing)?|fire(?:s|d|ing)?|engag(?:e|es|ed|ing)|assault(?:s|ed|ing)?|charg(?:e|es|ed|ing)|pounc(?:e|es|ed|ing)|jump(?:s|ed|ing)?|leap(?:s|ed|ing)?|leapt|fall(?:s|ing)?\s+upon|fell\s+upon)\b/iu;
const OFFENSIVE_SKILL = /\b(?:attack|strik\w*|cut|slash\w*|stab\w*|damage|wound\w*|hit|shoot\w*|blast\w*|ambush\w*|weapon|blade|sword|combat)\b/iu;
const UNCERTAIN = /\b(?:not|never|no|avoid|avoidance|instead|if|unless|whether|would|could|might|maybe|consider|discuss|ask|tell|say|says|said|warn|threaten|talk|speak|don't|dont|won't|wont|cannot|can't|cant)\b/iu;
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
    return tokens.some((word, at) => ['at', 'against', 'toward', 'towards', 'on', 'upon'].includes(word) && namesAt(at + 1));
}

export function knownFoeAction(text, sheet) {
    const foes = (sheet?.foes ?? []).filter(foe => foe.filled && foe.hurt > 0);
    if (!foes.length) return false;
    const skills = (sheet?.characters ?? []).flatMap(actor => actor.skills ?? []).filter(skill => OFFENSIVE_SKILL.test(`${skill.name ?? ''} ${skill.about ?? ''}`));
    const clauses = String(text ?? '').replace(/[“"][^”"]*[”"]/gu, ' ').split(/[.!?;\n]|\b(?:and|then|but)\b/iu);
    return clauses.some(clause => {
        if (UNCERTAIN.test(clause)) return false;
        let action = null;
        for (const skill of skills) {
            const name = String(skill.name ?? '').trim();
            if (name.length < 3) continue;
            const match = new RegExp(`\\b(?:use|using|cast|perform)\\s+(?:my\\s+)?${escape(name)}\\s+(?:on|at|against)\\b`, 'iu').exec(clause);
            if (match) { action = match; break; }
        }
        action ??= ATTACK.exec(clause);
        if (!action) return false;
        const before = clause.slice(0, action.index).trim();
        if (before && !/(?:^|\b(?:as|when|while|once)\s+)(?:i|we)(?:\s+(?:will|try to|attempt to))?$/iu.test(before)) return false;
        return foeTarget(clause.slice(action.index + action[0].length), foes);
    });
}
