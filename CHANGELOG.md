# NPC State Delta changes

## Unreleased

## 1.0.94 - 4 October 2026

Fixes from an external deep audit of 1.0.93 (fifteen reproduced findings):

- Keep the verified copies of an interrupted character rename when its retry hits a read error (a 1.0.93 regression), so a later retry can still finish it.
- Never save unsaved local work over a dossier file that another session retired, whether through Save/flush or a character rename; the work is kept for recovery only.
- Regenerate, swipe and continue now check the server for a newer dossier before building the prompt, like an ordinary send (an unchanged file costs a short 304 request).
- Scan dossier's structured import changes only its target, including profile and bond updates.
- Scan dossier and Refresh reject a profile row or bond whose id and name point at different people.
- Detach keeps its exact backup of the broken file registered even if the server's reply is lost, and a retry does not replace it with an empty marker.
- Deleting a middle message also removes unnamed relatives (for example twin daughters) that only that message added.
- Deleting an NPC's introduction no longer removes them when a later message gave them a bond that is hidden behind the five shown bonds.
- An import that skips a duplicate dossier no longer gives that dossier's bonds and relatives to another NPC.
- A bond stored in both directions no longer takes a second slot at the 240-bond limit.
- Importing with swapped ids keeps both NPCs' unnamed relatives.
- Numeric dates count Dec 31 to Jan 1 and Feb 28 to Mar 1 (common year) as one day; stored days are converted.
- An unchanged Speech row no longer stops Personality development from the same scan.
- A scan after a skipped birthday keeps the apparent-age offset.
- A portrait generated before an apparent-age change is rejected, and the dossier marks such a portrait as outdated.

## 1.0.93 - 3 October 2026

Fixes from an external deep audit of 1.0.92 (twenty-three reproduced findings):

- Check the server again before generating after you send a message (a 1.0.92 regression): a newer dossier from another device is adopted first, and a chat missing part of it is marked stale. The 1.0.92 "unchanged file returns 304" saving stays, so the check is a short request rather than a full download.
- Keep a chat whose dossier file was retired by another session blocked on retry until the chat is reopened, instead of reviving the retired dossier.
- Stop Refresh, Scan dossier and backfill applying a row that belongs to another NPC through a shared id, a name prefix ("Mira" vs "Mira Vale") or a role that mentions the target.
- Discard a Refresh result when the chat is edited while it is doing its final server check.
- Let an interrupted rename of a character you are not using finish on retry.
- Make "Detach broken sidecar" produce a fresh dossier that can be saved, keeping an exact copy of the broken file.
- Undo a deleted middle message's own changes (mood, memories) on an NPC who died independently later; the death and its relationship record stay.
- Stop a saved portrait seed or prompt keeping an NPC whose only introduction was deleted.
- Speech: accept "Mira, who speaks warmly …" again (a 1.0.91 regression) and reject "neither … nor", "denies …", "her mother speaks …" and "if she spoke …".
- Birthdays: reject birth facts about someone else ("Noela was born …, according to Mira"), denials, questions and forgeries; roll a yearless age only on the NPC's own, current birthday (not "tomorrow", "five years earlier" or someone else's).
- Presence: a denied or future return ("does not return", "will return tomorrow") no longer counts as arriving, and another person's absence no longer removes a present NPC.
- Refresh no longer saves a relationship summary that the safety check rejected.
- Scan dossier's backfill changes only its target, including profile and bond updates.
- Naming "Lady Mira Valen" no longer also brings Mira Deep into the prompt.
- "Not angry, but believes she must repay him" no longer escapes the low-score check.
- Importing with swapped ids keeps hidden bonds and no longer invents friendships.
- A 61st manual sibling-bond removal now holds (the limit is now 240, keeping the newest).
- A portrait preview generated before an appearance change is rejected instead of being saved as current.
- Escape during a portrait-seed Save, and Cancel during Refresh's automatic editor save, now stop the save.
- Full Cast scans an unscanned first greeting at message 0.

## 1.0.92 - 1 October 2026

- Cut network load on slow remote/mobile connections. Dossier checks (several per turn) now revalidate with the server instead of forcing a full download each time, so an unchanged dossier file comes back as "304 Not Modified" with no body; a changed file is still fetched in full. Sending a message no longer waits for a server read before generation starts when the chat's dossier is already loaded; the scan after the reply still checks the server copy before writing.

## 1.0.91 - 30 September 2026

Fixes from an external deep audit of 1.0.87 (eighteen reproduced findings):

- Keep a dossier recoverable when the server's reply to retiring the old file is lost or unreadable during a character rename or deletion; only an explicit rejection now counts as "not retired".
- Keep and register the recovery copy when a chat deletion cannot confirm its retirement, instead of deleting it.
- Keep a chat that is behind a newer dossier from another session blocked after you send a message in it; only reopening the chat (or the chat catching up) clears it, and the send no longer overwrites the dossier's history.
- Stop Refresh, Scan dossier and backfill applying a returned row that names a different NPC (for example another character's death) to the requested dossier.
- Stop a gradual "evolve" from flipping an NPC's moral identity (kind to cruel) on its label alone; reworded, non-moral development still applies as before.
- Stop Speech taking in another person's voice ("Noela speaks warmly") or a negated trait ("does not speak warmly"); ordinary attributed dialogue still counts.
- Require an affirmative statement of the NPC's own birth for a birthday correction (not a contract date or someone else's birth), and accept one split across two sentences.
- Age an NPC on a yearless birthday only when today is affirmatively their own birthday (not a denial, question, past birthday or someone else's).
- Stop another person's absence, or an absence the story then resolves, from keeping an arriving NPC off-screen.
- Keep a manually removed sibling bond removed across an unrelated import or rollback.
- Treat in-law ties as their own relationships: a father-in-law no longer creates child bonds or fake siblings.
- Keep a manually saved portrait seed (including 0) when the latest message is deleted.
- Include a separately named "Mira" in the roleplay injection when "Lady Mira Valen" is also named.
- Stop a later mention of "Tomas Hale" keeping a deleted "Tomas Reed" who shares the alias "Tomas".
- Accept a refused obligation ("does not feel she must repay him") in the player dynamic at low scores.
- Abandon a Save that was cancelled while it was still checking the server.
- Stop an export from downloading a different chat when you switch chats while it is starting.
- Report full cast scan failures truthfully instead of claiming success.

## 1.0.90 - 30 September 2026

- Stop opening the dossier from raising the phone/tablet keyboard. Opening the panel now focuses the panel itself instead of the search box; search is focused only when you tap it.

## 1.0.89 - 30 September 2026

- Open the dossier library collapsed. It now starts collapsed every time the dossier panel opens; tap the "DOSSIER LIBRARY" bar to expand it, and it collapses again when the panel closes. The collapsed bar spans the full width with a 40px touch target on touch screens, including tablets. The choice is no longer stored in the browser.

## 1.0.88 - 30 September 2026

- Make the dossier library collapsible. Tap the "DOSSIER LIBRARY" heading to hide the search, filters and cast rail so the open dossier gets the space (about 200px more on a phone); tap it again to bring them back. The choice is remembered in this browser only.

## 1.0.87 - 30 September 2026

- Fix Scan, Scan dossier, Refresh and backfill being refused after a page reload with "this chat has not loaded the newest messages another session added". Opening a chat reads it from the server, so the opened history is current: if the saved dossier history is longer, those messages were deleted, and the chat-open reconciliation now rolls the dossier back to the chat instead of marking it stale. A dossier adopted from another session mid-session still blocks scans until the chat is reopened, and reopening now clears that mark. Previously every page reload counted as "another session", so the mark could stay until the next new message.

## 1.0.86 - 30 September 2026

Fixes from an external deep audit of 1.0.84 (twelve reproduced findings):

- Keep a renamed or deleted character's dossier recoverable when retiring the old file is uncertain. If the retirement upload was sent but its verification read failed, rename and deletion now keep the new and recovery copies and register the recovery instead of deleting every copy they made.
- Keep a chat that is behind a newer adopted dossier from rolling it back. The "local chat is an older prefix of the dossier" state is now its own per-chat mark, set on adoption and cleared only when the local chat catches up or diverges. A local metadata save (such as a portrait seed) no longer removes it, and while it holds, scans are refused with a notice and checkpoints do not truncate the dossier's lineage.
- Stop a message hide during delete settlement from rolling back too far. Settlement now fingerprints messages without the hidden flag, like branch lineage, and a delete/edit event index can no longer move recovery before the first message whose content changed.
- Reject a stale appearance draft. Apply appearance in an editor opened before a newer server copy was adopted is refused, like the editor's main Save.
- Stop a read that started before a chat was deleted from bringing it back. A freshness read that completes after a deletion, rename or retirement no longer restores the pointer, clears the tombstone or reinstalls the dossier.
- Require birthday evidence about the NPC for every date part. A scanned birth date is applied only when one sentence naming that NPC (or continuing it with a pronoun) states the month and day, or says it is their birthday on today's date, and states a new year when one is supplied, none of it negated. Unrelated people's births, a name inside another word, a date without the year, and "CR801, not CR790" no longer change age.
- Only an NPC's own birthday rolls over a yearless birthday. Another NPC's birthday narration on the same date no longer ages them.
- Do not repair an explicitly absent NPC into presence. A missed-participant repair restores presence only when the NPC's own sentences in the current exchange do not place them elsewhere ("is not here", "remains at her distant home").
- Stop a shared alias from injecting unrelated NPCs. An alias another dossier also carries names nobody on its own, and a label found only inside another dossier's longer name belongs to that dossier.
- Keep a manually removed sibling bond removed. Removing an inferred sibling pair records the shared parents it was inferred from; inference does not recreate the pair until that parent evidence changes.
- Match later references to a deleted-block NPC by whole name or alias. "Wayfarer" now keeps the NPC it names, and "dangerous" no longer keeps a ghost called Dan.
- Report Archive, Restore and Delete only once the server has them. They still apply immediately, but success is announced after the durable write; a failed write shows a warning that the change is applied locally and pending.

## 1.0.85 - 30 September 2026

- Stop NPCs treating the player as uniquely important at low relationship scores ("it must be him", "I must do this for him" at trust 15). The score was not the cause: below 30 its injected wording is neutral. The fixation came from text fields. A relationship summary with obligation, fixation or role claims ("her chosen partner, protector and provider", "must repay him", "only he can", "will follow him anywhere", "devotedly") now needs an unlocked +50 trust or affection milestone, like the existing depth claims; otherwise it is not stored and the neutral score-based wording is injected instead. Stance words in the mood ("devoted", "adoring", "obedient", "infatuated"…) are left out of the roleplay injection while trust and affection are both below 50; the dossier keeps the scanner's text. When an injected NPC has low trust and affection, the injection header adds one line: the player is not uniquely important, with no obligation, fixation or "only them" thinking. Scanner, Refresh, backfill and relationship-pass requests are unchanged; the Stage 9 injection fixture grows by that 100-character line.

## 1.0.84 - 30 September 2026

Fixes from an external 1.0.83 bug audit (nine reproduced findings):

- Stop deleting a middle message from undoing facts set by earlier retained messages. Reverting the deleted block's own changes now requires the exact state just before it (journal or a checkpoint at the preceding message); an older checkpoint no longer stands in for it, and without the exact boundary the dossiers are left as they are.
- Remove an NPC that was introduced and killed only in the deleted block. The exact before-state proves it did not exist earlier, so its recorded death no longer keeps a dead ghost; it stays when a later message changed it or another dossier started naming it afterwards.
- Stop a shared title or first name from injecting unrelated NPCs. "I ask Lady Mira" no longer selects Lady Noela and Lady Vera: a first name alone counts only when no other dossier shares it, and titles (Lady, Captain, Master…) never count on their own.
- Do not treat an unreadable sidecar as a missing one. When a chat has no remembered data-file pointer and its data file exists but cannot be read (server error, authentication, malformed content), hydration now retries and then blocks with an error instead of starting an empty dossier as ready. Only a confirmed missing file starts fresh.
- Report editor saves only once they reach the server. The dossier editor now waits for the write; if it fails, the editor stays open with the draft, the edit remains applied in this browser, and a warning replaces the premature "saved" notice.
- Let the repair of a participant the broad scan missed restore their presence. The broad scan's omission set them absent and the repair forced that back even when it returned present=true; a missed-participant repair (queued only for someone taking part in the current exchange) now keeps a grounded present=true, while other repairs still keep the live presence.
- Require story support for scanned birthday changes. A scanned birth date is applied only when the scanned text names the NPC and states that month and day or speaks of a birthday or birth; an ungrounded model "correction" no longer rewrites an NPC's age. Manual edits and generated dates are unchanged.
- Do not let a stale chat roll back a newer dossier from another session. After adopting a dossier written by another session, a local chat that is only a shorter prefix of it (with no delete event) is treated as not yet loaded rather than as a deletion, so nothing is rolled back or written; the deferral is recorded in the rollback diagnostics. Explicit delete events are unchanged.
- Always report a same-revision overwrite. When a later check shows another session replaced the revision this session saved, the local copy was already preserved for recovery; the warning is now shown even from background checks. Preventing the race itself needs server-side compare-and-swap, which SillyTavern's file upload does not offer.

## 1.0.83 - 30 September 2026

- Stop a wrong parent entry from forcing "sibling" back onto Important Bonds. Two NPCs listed as children of one parent were always inferred to be siblings, so when Greta wrongly listed her brother Marek as a parent, "Greta — sibling" kept returning on Talia (Marek's daughter) after every edit. The shared-parent inference now skips, and removes its earlier inferred link for, any pair where either dossier or a non-inferred edge names a different blood tie. A manual bond edit also corrects the other NPC's entry when that entry only mirrored the old relation (editing Greta's "Marek — parent" to "brother" turns Marek's "Greta — child" into "Greta — sibling"); a locked dossier, or a new relation with no inverse, is left alone.

## 1.0.82 - 30 September 2026

- Fix a 1.0.81 regression in Important Bonds: two conflicting blood ties ("Greta — niece / sibling") were settled by keeping the later word, which picked the wrong one and, depending on NPC list order, overwrote the other NPC's correct entry ("Talia — niece" became "sibling"). Such an entry is now settled by what the other NPC's own dossier says (Greta's "Talia — niece" makes Greta the aunt), and without that statement it is left as it is and not mirrored. When deciding which of two dossiers holds a mirrored copy, the side with extra parts ("Niece / sibling" against a plain "niece") is the copy. A blood tie mirrored from the other side no longer overrides an NPC's own entry, so a wrong entry cannot spread.

## 1.0.81 - 30 September 2026

- Stop Important Bonds copying one NPC's words onto the other. Each bond is mirrored onto the counterpart's dossier, and for symmetric ties (cousin, friend, rival) the mirror copied the whole phrase, so a bond describing Talia on Hanna's dossier ("Talia — disinherited half-elf cousin") appeared on Talia's as "Hanna — disinherited half-elf cousin". Relations Delta cannot invert ("servant", "employer") were copied unchanged. A mirrored symmetric bond now keeps only the words both sides share (childhood, best, second, sworn, estranged…), and a relation with no known inverse is not mirrored. Stored copies are repaired on the next social reconciliation: when both dossiers hold the same non-mutual text for each other, a species word decides which NPC the text describes, otherwise the side that established the graph edge keeps it; the other side gets the proper inverse, and the persisted edge is corrected too.
- Keep the later of two conflicting blood ties instead of joining them. "Niece / sibling" for the same person became one bond; two different kinship relations that are not each other's inverse now resolve to the newer one, both when merging and in stored text. Other combinations ("cousin / business partner") still join.
- Say which way a bond reads. Routine, full-window and retry scanner prompts define `aToB` as b's role to a; Refresh, backfill and import show the entry format as "Name — their role to this NPC | durable dynamic". Delta-owned request characters grow by 8 (scanner, full-window, retry, import), 10 (backfill) and 32 (Refresh); the focused relationship pass, request counts, response allowances, routing and roleplay injection are unchanged, and the Stage 9 fixture was updated from a recorded before/after comparison.

## 1.0.80 - 30 September 2026

- Repair history saved across several progressive hides. Memory extensions hide messages a few at a time, so state saved by earlier versions holds checkpoint and rollback-journal keys from several eras, each chained through the old flag-sensitive hash of whichever messages were hidden by then. The 1.0.79 migration only rewrote the keys matching the latest stored lineage, leaving the older eras unreachable: a deletion that needed history from before the latest hide still failed closed and kept every dossier. Migration now also tries each prefix of the currently hidden messages (older messages are hidden first) as the set that carried the old hash and rewrites any stored checkpoint, journal, journal-head and inline-card key that matches, once per chat state.
- Add rollback diagnostics to the exported diagnostics file: the last 20 branch reconciliations of the session (operation, relation, action, divergence, whether it failed closed, reverted/removed counts) without chat identity or story text, the branch history counts, and the chat's message count, hidden/system message count, stored-lineage divergence and turn. Reconciliation records live in memory for the session; export soon after the rollback.

## 1.0.79 - 30 September 2026

- Stop hiding messages from breaking rollback. SillyTavern marks a hidden message `is_system`, and memory extensions such as MemoryBooks hide summarised messages as the chat grows. The branch lineage hashed that flag, so hiding (or unhiding) any earlier message changed its hash and, because checkpoint and rollback-journal keys chain through every earlier message, changed the key of every later message too. A later deletion of the last messages then looked like a divergence at the hidden message instead of a tail truncation, the journal and checkpoints no longer matched, and Delta failed closed and kept everything (a 13-message deletion did not revert). The flag is now fixed in the hash, which keeps the value earlier versions stored for ordinary messages. State saved while messages were hidden is migrated once (`migrateLegacyLineage`): where the stored lineage differs from the chat only in the old flag-sensitive hash, the hash is adopted and every stored checkpoint, journal, journal-head and inline-card key is rewritten to match; real content changes are left to normal reconciliation. Checkpoints saved before an earlier hide can still be unreachable in chats already affected, but new history and rollbacks work.

## 1.0.78 - 30 September 2026

- Undo what a message deleted from the middle of the chat changed. Deleting a message with two or more later assistant replies keeps the dossiers (the later scans cannot be replayed), so everything that message had changed stayed: the Trust/Affection/Desire/Tension change and Last relationship change card, mood, appearance, memories, a newly met NPC. Reconciliation now compares the live state with the state just before the deleted block and just after its last scan (both from the rollback journal, else retained checkpoints, so it reaches as far back as ordinary rollback). Each field the block changed and nothing later touched returns to its earlier value; related fields (relationship values/progress/milestones/history/last change, the appearance fields, age/birthday, life state, Personality or Speech with its development ledger) revert together or not at all; list fields (memories, mannerisms, levers, bonds, aliases, pending evidence) drop the items the block added while keeping later ones; an NPC who first appeared in the block and was not otherwise used later is removed with its bonds, graph edges, candidate and pending backfill; social-graph edges the block added or changed are undone; protected (locked) fields are never touched, and a confirmed death stays unless the deleted block itself caused it. It needs no extra requests and no recorded deltas, so it works for existing chats. It applies only to one contiguous deleted block, and only where nothing later changed the same field; tail deletions, swipes and regenerations are unchanged.
- Add **Rewind dossiers on middle deletion** (Roster & continuity, off by default). When on, deleting a message from the middle of the chat rewinds every dossier, relationship state and social graph to the exact state just before it (the same exact journal/checkpoint boundary a tail deletion uses), discarding whatever the later messages changed, including NPCs they introduced. It makes no model requests and does not rescan. If that boundary is unreachable it falls back to the default: keep the dossiers and undo only the deleted message's own changes. Swipes, edits and tail deletions are unaffected.
- Say so when a middle deletion keeps the dossiers. A notice names the NPCs whose changes from the deleted message were reverted or removed, or, when nothing could be reverted, says the dossiers were kept as they are and can be edited by hand. Branch reconciliation diagnostics record `revertedNpcCount` and `removedNpcCount`.
- Scanner prompts, request counts and persisted formats are unchanged.

## 1.0.77 - 29 September 2026

- Measure Personality and Speech development in story time. When the scanned message's World State block carries a date in the configured calendar (for example Megumin Suite's World State; a message without one inherits the nearest earlier dated message), each development observation records its story day. A trend started by one grounded observation and confirmed by a second at least 7 story days later now meets the gradual gate (two observations instead of three), however few messages lay between; two observations on nearby story days still need a third, however many messages passed. Chats without dates keep the previous fallback (Personality: 20+ messages or 10+ turns apart). Targeted Refresh dates each tagged `[mN]` observation from its own message.
- Break a development trend on contrary evidence. A later observation of the opposite tendency (for example "timid" after "confident", or the same claim negated) removes the pending trend, so it has to start again instead of being confirmed across the reversal.
- Measure trait staleness in story days. Stable-field changes record the story day (`fieldChangeDays`, only when the chat is dated), and Refresh names Personality, Speech or Behavioral Levers unchanged for 30+ story days; undated chats keep the 30-turn rule, and the circumstance-change rule is unchanged. Cross-chat imports drop the source chat's story-day stamps with its other chronology.
- Scanner prompts, request counts and persisted formats are unchanged (the new ledger `days` and dossier `fieldChangeDays` fields are optional and absent in undated chats); the Stage 9 baseline is unchanged.

## 1.0.76 - 29 September 2026

- Re-check stable traits when an NPC's circumstances change, not only after 30 turns. NPCs first met at a low point (an abused servant) got Personality and levers such as "deeply submissive under constant mistreatment" and "Disposition: docile - endures … orders in submissive silence" from that first scene; when the story moved them on quickly (servant to inn owner within 20 turns) those traits kept telling the roleplay model to obey, while the 30-turn stale check had not yet started. Refresh now also names Personality, Speech or Behavioral Levers written before the NPC's background or home base last changed (a trait with no recorded change dates from the dossier's creation), with the same "check each clause, rewrite what belongs to an ended situation, keep the rest" instruction. The rewrite still passes the ordinary evidence gates, and protected fields are never named.
- Ask for Behavioral Lever evidence in lever form. Scans recorded behaviour evidence as free text ("Pragmatically trades lodging for larder goods"), which carries no lever category, so it could never count as a second sighting of any lever. The scanner and Refresh prompts now ask for evidence items in the same `Label: level - effect` form as the levers.
- Request budget: the routine scan request is 8 characters smaller (a redundant "Secondary to identity." was dropped from the relationship rule; identity-first behaviour is still stated in the firewall rule and the roleplay injection) and the Refresh request is 21 characters larger, plus the stale-trait line only when it applies. Request counts, retries, output allowances and routing are unchanged; the Stage 9 baseline was regenerated. Persisted formats are unchanged.

## 1.0.75 - 29 September 2026

- Stop a lone "deceased" line appearing in Important Bonds. The dossier editor shows one bond per line but split saved lines on semicolons too, and a dead counterpart's bond is written "…; deceased", so saving the editor (even for an unrelated field) split "deceased" off into its own bond, which was then kept because one-word bond text was preserved. Editor lists (bonds, memories, mannerisms, Behavioral Levers) now split only on line breaks, and a bare life-state word ("deceased", "dead", "late") is dropped wherever bonds are normalised, including protected bonds, so existing orphan lines disappear on the next load or scan.
- Name the relation that fits a known gender. A bond derived without gender ("Vena — aunt / uncle", "Elena — niece / nephew") now reads "aunt"/"niece" or "uncle"/"nephew" once the counterpart's gender is on their dossier; without a known gender the neutral form stays.

## 1.0.74 - 28 September 2026

- Stop Important Bonds repeating their description ("Clara — cousin | endures her harsh scolding… | endures her harsh scolding…"). Scanners sometimes fold the bond dynamic into the relation (`aToB: "cousin | endures…"`) while also returning it as the dynamic. The social graph kept the pipe inside the relation, and every reconciliation merged the stored "cousin" into the longer "cousin | endures…" relation and then appended the dynamic again. Edge normalisation and scanner-edge parsing now split anything after a pipe out of the relation into the dynamic, and bond formatting does the same, so existing affected graphs are repaired on load without losing the description.
- Keep a specific relation when it meets its own gender-neutral inverse. A stored "Vena — aunt" merged with the inverse derived from the other dossier ("aunt / uncle") and widened to "aunt / uncle" (and "niece" to "niece / nephew"); the specific relation now wins.

## 1.0.73 - 28 September 2026

- Record Speech evidence as a style, not a bare quote. Scans stored quoted lines ("The ground gives more than it takes.") as Speech evidence. Every quote is unique and shares no words with a description like "speaks in formal aphorisms", so even three scenes of the same voice could never support a Speech change. The scanner and Refresh prompts now ask for the named style with an optional quote (`formal aphorisms: "…"`), and a label followed only by a quote keeps the label as part of the evidence (`formal aphorisms ("…")`), so repeated scenes accumulate under one concept and ground the new description. Bare quotes still cannot ground a Speech change.
- Keep pending Behavioral Lever evidence per category. Lever evidence shared four slots across all categories, so varied behaviour rotated a first Honesty sighting out before the second arrived and the lever never swung. Each category now keeps its two newest observations (four uncategorised, twelve in all). Scanner prompts still carry only the newest four, so request size is unchanged. A `[mN]` source tag no longer hides an evidence item's category, so a tagged first sighting is recognised as the same category as the next one.
- Let Personality change after two observations when they are far apart. A slow change seen in two scenes at least 20 messages (or 10 scan turns) apart now meets the gradual gate; closer together it still needs three. Candidate grounding, identity/morality safety and the explicit/batch paths are unchanged, and Speech and Mannerisms thresholds are unchanged.
- Re-check long-unchanged traits at Refresh. When Personality, Speech or Behavioral Levers have not changed for 30+ turns, Refresh names them and asks for each clause to be checked against the window: a clause tied to an ended situation, a former role or a dead person is rewritten from current evidence (levers keep their label with a new level/effect); anything still true is kept. Locked fields are never named. The rewrite still passes the ordinary evidence gates.
- Request budget: the routine scan request is 5 characters smaller (the Speech clause was reworded and two overlapping "refine returns the full field" clauses were merged), and the Refresh request is 63 characters larger (the Speech clause), plus the stale-trait line only when a trait is 30+ turns old. Request counts, retries, output allowances and routing are unchanged; the Stage 9 baseline was regenerated. Persisted formats are unchanged.

## 1.0.72 - 28 September 2026

- Send an off-screen NPC's dossier when your message calls her in. Presence came only from scanning AI replies, so if Linnea was absent in message 4 and your message 5 called her over, reply 6 was written without her dossier (her appearance, voice and levers) and could contradict it; she was only included from reply 8. Now, when you send a message, or regenerate/swipe a reply whose scan has not yet run, any off-screen NPC with a dossier whose name, alias or distinctive first name appears in that player message is added to that generation's injection, marked `(named by player)` with a one-line note that she is not yet confirmed on-screen. It is a local name match with no extra model requests. It does not change who is present: the scan of the reply still decides that, and once that reply is scanned she is included or dropped as usual. Archived and confirmed-dead NPCs are never called in. The Diagnostics **Roleplay injection** section lists them as "Named in your latest message". An NPC the model brings in without being named in your message still gets her dossier from the following reply on.
- Scanner prompts, request counts and persisted formats are unchanged; the injection is byte-identical when no off-screen NPC is named.

## 1.0.71 - 28 September 2026

- Show what the roleplay model receives. **Diagnostics** now opens with a **Roleplay injection** section: whether the dossier block is being sent, which NPCs it contains, its size against the budget, where it is placed (in chat as a system message, N messages from the end) and the exact text. When nothing is sent it says why: this chat's dossiers are not loaded yet, the extension or **Inject present NPC state** is off, or no NPC is marked present in the latest scanned scene. Previously an empty injection was silent, so a missing dossier could only be found by capturing the provider request. The preview is runtime-only and is not included in the exported diagnostic bundle. `NPCStateDelta.injectionPreview()` returns the same information.

## 1.0.70 - 28 September 2026

- Keep physical features in the roleplay injection when the budget is tight. The current appearance was optional continuity added whole or not at all, so with several present NPCs or a lowered **Injection budget** it silently disappeared and the roleplay model invented anatomy (a dossier's "generous bust" narrated as "small chest"). If the whole current appearance does not fit, an NPC without a selected form now gets its **enduring physical features** (`ENDURING PHYSICAL FEATURES (authoritative anatomy): ...`), and failing that a clause-bounded cut; every present NPC gets its compact anatomy before any NPC's full outfit is added. Essential identity/agency still come first.
- Stop cutting injected Behavioral Levers to fragments. The injection kept each lever's first three words, so "Independence/Agency: high - refuses help she has not asked for" reached the roleplay model as "high - refuses". Levers now keep the category (first part of a combined label) and as much of the effect as their share of the identity room allows, cut at a word boundary; the lever text is sized to the room the identity section really gives it; and when room is short every category still appears as "Category: level".
- Make a larger **Injection budget** actually carry more. The budget was a ceiling, but each NPC's identity, agency, current-state and relationship sections had fixed caps (620/300/180/160 characters), so a detailed dossier was cut ("…" in personality, speech and mannerisms; levers reduced to "Category: level"; only three bonds) at any budget, and a 6000-token budget sent exactly what 1800 did. The section caps now grow with the budget (up to 2200/900/400/320 characters) and all five bonds are sent once the agency section has room; the default 1800 budget keeps the previous caps, so default cost is unchanged. Only what the present NPCs need is sent: three fully detailed dossiers arrive whole at 4000 tokens using about 2200. Background is now sent as the lowest-priority optional field. The setting's hint explains it is a ceiling.
- Raise the default **Injection budget** from 1800 to 4000 tokens. Only what the present NPCs need is sent, so a quiet scene costs about the same; three detailed dossiers arrive whole using about 2200 tokens. An install still on the old 1800 default moves to 4000 once (`injectBudgetDefaultUpgraded`); any other value, and a later deliberate 1800, is kept. Section caps still scale from the 1800-token base.
- Request sizes are unchanged; the roleplay injection for the synthetic Stage 9 fixture changes from 2210 to 2209 characters, and the Stage 9 baseline was regenerated.

## 1.0.69 - 27 September 2026

- Capture enduring physical features in automatic and first-creation scans. The scanner, Refresh, backfill and import prompts defined Appearance as one field ("hair/body, outfit/gear, condition"), so height, build, hair, eyes and ears were stored with the clothes in the current-outfit slot and **Physical features (enduring)** stayed empty. Prompts now ask for `overallAppearance` = enduring body (height/build/hair/eyes/ears/skin/marks) and `appearance` = current outfit/gear/condition, and backfill/import return shapes include the physical field.
- Seed empty physical features from the whole scene or from the NPC's own stored appearance. 1.0.68 scoped appearance grounding to sentences naming the NPC, so an NPC introduced as "she" or "the half-elf woman" could not get physical features at all; and existing NPCs could not move traits out of their outfit slot unless the scene re-described the body. Filling an empty Physical features slot now accepts support from the scene or from the NPC's stored appearance; changing established physical features stays grounded in story text about the NPC.
- Stop the current outfit repeating physical features. Once Physical features change, pieces of the current presentation whose words are all already in Physical features are removed; pieces that add detail, or carry negated or changeable wording ("hair wet from the rain"), are kept. The resolved appearance no longer joins the two parts as "ears.; threadbare".
- Request sizes (characters, synthetic fixtures): scanner 8474→8536, full-window 8602→8664, targeted Refresh 10207→10225 (common prefix 9341→9386), backfill 7953→7960, import 5877→5918, compact retry 9298→9360; the roleplay injection is 1 character shorter from the join fix. Focused-relationship, request counts, output allowances and options are unchanged; the Stage 9 baseline was regenerated.

## 1.0.68 - 27 September 2026

- Close the evidence leak between NPCs. When narration was supplied but none of it was about the NPC being updated, the shared durable-profile check treated the empty NPC-scoped text as "no narration" and accepted the claim, so another NPC's scene could refine this NPC's Personality, Speech, Appearance or Behavioral Levers. Such narration now supports nothing; only a caller with no narration at all (structured import/API) keeps direct refinement, and evidence quotes attributed to the NPC still count. Paths that did not scope the story to the NPC now do: Behavioral Profile refine from the scan's NPC row, first-profile lever seeding on both update paths, and the appearance model (overall appearance and named forms) in ordinary scans, which now reads the NPC's own sentences plus the 1.0.62 presentation follow-up sentences. Targeted Refresh and backfill keep their whole window for appearance. Prompts, request counts and persisted formats are unchanged.
- Rewrite the README for players: a short introduction, install and first steps, a settings map, plain-language explanations of how dossiers, levers, relationships, appearance, rollback and backups work, and a troubleshooting table. The per-release history now lives only in the changelog; developer commands and governing documents move to a closing section.

## 1.0.67 - 27 September 2026

- Let automatic scans swing a Behavioral Lever. The automatic-scan prompt listed `evolve` only for Personality, Speech and Mannerisms, so ordinary play almost never proposed a lever change (Refresh already allowed it); it now names Behavioral Profile too. A lever still cannot flip from one scene: the first sighting is kept as pending evidence, and an `evolve` with a reason is accepted when the behaviour is seen again in a later scan, or at once for an explicit event or time skip as before. Refine still only sharpens a lever and cannot reverse it, and the kind/cruel and agency safety checks are unchanged.
- Count a second sighting of lever behaviour even when it is worded like the first. Pending evidence counted as a new observation only when it was less than 0.56 similar to earlier evidence yet at least 0.48 similar to be related, so two scenes of the same behaviour described in similar words were treated as one and the swing never became ready. For Behavioral Levers only, evidence now counts as a duplicate when it is a near-copy (0.85 similar or more), such as a re-scan of the same message; Personality, Speech and Mannerisms keep the existing rule.
- The automatic-scan prompt drops its opening sentence ("NEW dossier-worthy NPCs get a grounded first-pass profile"), which rule 3 already states more strongly ("Dossier-worthy NEW: populate every grounded field now"). Request sizes (characters, synthetic fixtures): scanner 8517→8474, full-window 8645→8602, compact retry 9341→9298. Refresh, backfill, import, focused-relationship, request counts, output allowances, options and the roleplay injection are unchanged; the Stage 9 baseline was regenerated.

## 1.0.66 - 27 September 2026

- Behavioral Levers now need a recognised category. A lever is "Category: level - effect", and the category must be one of Disposition, Care/Warmth, Expressiveness, Independence/Agency, Conflict/Assertiveness, Threat Sensitivity, Analytical Style, Social Presentation, Cruelty/Mercy, Loyalty, Drive/Ambition or Honesty/Candor, or a close synonym ("Warmth", "Composure", "Trust", "Candor", and so on). Before, any label, or any sentence containing words such as "usually", "when" or "prefers", counted as a lever, so routines such as "Household: strictly enforces curfews" or "Opens the shop when the bell rings" got through. One category map in `core-mechanics.js` now serves the lever check, refine matching, ordering and the identity/morality safety gates; "Care/Warmth" and other combined labels now resolve to their category, and Loyalty, Drive and Honesty are new categories. Existing dossiers and manual edits are not filtered: entries outside the categories are listed for restatement at the next Refresh (as 1.0.65 does for habits), and an entry the model copies back unchanged is kept rather than retired. Entries rejected at intake still count in the agency/morality safety check, so an unrecognised label cannot hide a reversal, and a proposal that lost entries at intake keeps the established levers it omitted.
- Stop "rather than" and "instead of" from rejecting whole Behavioral Profile updates. For levers only, change-over-time wording ("no longer", "used to", "became", "has grown") still marks an attempted evolution, but a stated preference ("helps through actions rather than words") no longer does. Personality and Speech keep the stricter check.
- Prompts list the exact categories. Refresh, backfill and import name all twelve; the automatic scan names them in one compact line and states the home-base rule once instead of twice. Request sizes (characters, synthetic fixtures): scanner 8504→8517, full-window 8632→8645, targeted Refresh 10181→10207 (common prefix 9341→9367), backfill 7927→7953, import 5851→5877, compact retry 9328→9341. Focused-relationship, request counts, output allowances, options and the roleplay injection are unchanged; the Stage 9 baseline was regenerated.

## 1.0.65 - 26 September 2026

- Make Refresh clean up stored habit entries in the Behavioral Profile. After 1.0.64 a Refresh still left them when the model omitted the field, which it usually did because it saw nothing new to add. When the stored list holds entries that are not levers and the field is unlocked, the Refresh request now names those entries after the dossier and asks for a full `refine` lever list. The line is target-specific and placed after the shared prefix, so other NPCs' requests and the common prefix are unchanged; for such an NPC the Refresh request grows by the named entries plus about 150 characters (the synthetic Stage 9 fixture, which stores "Keeps firm boundaries.", went 9968 to 10181; common prefix unchanged at 9341). A lever that restates a stored entry is grounded by that entry, so the replacement is accepted even when the scene that established the habit is outside the Refresh window; unrelated new levers still need story support. Diagnostics now record a Behavioral Profile row when stored non-lever entries survive because the model omitted the field (`not-provided`) or proposed only non-lever entries (`non-lever-only`).
- Let scans and Refresh add new Behavioral Levers to an NPC that already has some. Seeding an empty list judged each proposed lever on its own and accepted one supported by the story, the evidence quotes or the NPC's accepted Personality. Once one lever existed, a `refine` adding a new lever category needed near word-for-word overlap between the abstract lever and the story, and one miss rejected the whole list, so the field rarely changed after the first scan. A new lever category now uses the same per-entry check as seeding (story text is still limited to sentences about the target NPC), and an unsupported addition is dropped on its own. When an addition is dropped, established levers the proposal omitted are kept rather than retired; stored non-lever entries still retire. Replacing an existing lever, and the identity/morality and evolution-wording checks, still reject the whole proposal as before. Prompts are unchanged.

## 1.0.64 - 26 September 2026

- Let a Behavioral Profile refine replace stored habit entries with new levers. When a scan or Refresh proposed a lever whose label the dossier did not already have (for example "Threat Sensitivity: high - slow to trust strangers"), the grounding check required the label words themselves to appear in the story. They never do, so the whole proposal was rejected and every stored entry, habits included, stayed. Refine grounding now checks the claim after the label, as first-profile grounding already did. The claim must still be supported by the story or evidence, one ungrounded entry still rejects the whole proposal, and entries omitted from an accepted refine are retired as before. Prompts are unchanged.

## 1.0.63 - 26 September 2026

- Keep Behavioral Levers to levers. A lever describes how an NPC generally responds or decides ("Label: level - effect", or tendency phrasing such as "slow to trust strangers"). Scans could fill the field with routines and habits ("Keeps a quiet household and strictly enforces advance payment and dusk curfews."), which then crowded out real levers. Scanned, refreshed, backfilled and imported Behavioral Profile entries must now be lever-shaped (`isBehaviorLever`); entries that are not are dropped from the Behavioral Profile proposal and kept as pending Mannerisms evidence instead. A proposal made only of habits no longer replaces the existing levers. Existing dossiers and manual edits are not rewritten or filtered.
- Tighten and shorten the scanner prompts. Refresh, backfill and import now use one lever definition that says routines, duties, house rules and habits are not levers and that habits belong in Mannerisms; the scanner says the same in its durable-profile rule. Duplicated instructions were removed without dropping any rule: scanner and refresh no longer repeat the flat Appearance sentence that their own rules already state, refresh/backfill/import drop the one-line Stage 4 summary that the full Appearance and death rules follow, and the death rule keeps its model-facing part (explicit death is terminal; later output cannot revive, restore presence or world activity) without the text about player correction and rollback, which the model cannot act on. Request sizes (characters, synthetic fixtures): scanner 8853→8504, full-window 8981→8632, targeted Refresh 10402→9968 (common prefix 9775→9341), backfill 8119→7927, import 6059→5851, compact retry 9677→9328, minimal one-NPC scan 7218→7235 (+17 for the lever wording). The focused-relationship prompt, request counts, output allowances, options, retry budgets and the roleplay injection are unchanged; the Stage 9 prompt baseline was regenerated for the new prompt text.

## 1.0.62 - 26 September 2026

- Capture outfit changes in automatic scans. A routine scan grounds an Appearance change only in story text scoped to the NPC, which keeps sentences that name the NPC and pronoun-led follow-ups. Outfit changes are usually narrated in the next sentence ("A moment later she returns in a white sundress"), and the `npcs` row carries no evidence quote, so those changes were dropped until a targeted Refresh (which reads the whole window) picked them up. An Appearance change in either the `npcs` row or `profileUpdates` may now also be grounded by up to two story sentences that directly follow a sentence naming only that NPC, stopping at any sentence that names another NPC. Ungrounded changes and changes narrated for another NPC are still rejected. The shared Personality/Speech evidence scoping and all scanner prompts are unchanged.

## 1.0.61 - 26 September 2026

- Fix outfit changes still erasing physical appearance. The scanner reports a clothing change as a full `appearanceState: "change"` presentation, and the core merge applied it before the appearance model's 1.0.56 trait protection ran, so hair, eyes, build and scars were already gone when that protection compared old and new text. Omitted physical traits are now carried forward from the pre-scan record at that hand-off, named-form and shared-appearance updates get the same protection, a trait inside a mixed clause ("long silver hair tied back with a ribbon") survives, and a passing changeable mention ("her hair is wet") no longer counts as re-describing the trait. An explicit re-description (dyed, cut) still replaces it. Scanner prompts are unchanged.
- Restore the appearance controls in Edit dossier. Since the editor's Scan/Refresh row was removed, nothing in the editor carried the NPC id, so the Appearance section, the Life state control and the sectioned editor layout never mounted. The editor content now carries the id itself, and Gender sits inside Identity & profile.
- Split appearance into **Physical features (enduring)** and **Current outfit & presentation** in the editor and dossier. Physical features use the existing shared-appearance slot, which scans change only when the story explicitly changes them; the outfit field edits the NPC's own current appearance. For an NPC without a named form the resolved appearance (dossier, portrait prompts, roleplay injection) is now physical features plus current outfit, with exact restated pieces not repeated. Applying the editor on an NPC without named forms no longer blanks its current appearance.

## 1.0.60 - 26 September 2026

- One dossier page. Tapping an NPC in the in-chat Present NPCs block now opens the launcher dossier on that NPC instead of a separate quick-viewer page, so the chat and the launcher show the same dossier with the same form portraits, change markers and actions. The quick viewer, its duplicate Edit/Refresh/portrait buttons and its styles are removed; the public `openViewer`/`closeViewer` API becomes `openDossier(nameOrId)`, and `uiStatus()` reports `presentCastDisplay` instead of the viewer fields. Opening from a card no longer focuses the search box, so phones do not raise the keyboard over the portrait.
- Add a "Present NPCs in chat" setting (Roster & continuity): Full cards (default, unchanged), Compact strip (a one-line row of small portraits and names) or Off (nothing is added to the chat, and the chat watcher and repair timer stop). Presence tracking, generation injection and the recorded inline history are unaffected by the setting.
- Rename the block's Megumin dossier-block tab from "NPC State Delta" to "Present NPCs".

## 1.0.59 - 26 September 2026

- Fix squeezed settings-panel buttons in SillyTavern. The host `.menu_button` rule is `width: min-content`, so the quick-bar actions (Open dossiers, Scan dossier now, Full scan current cast, Add NPC) and the calendar buttons wrapped one word per line inside wide cells. Grid buttons in the panel now fill their cell, and inline buttons size to their label.

## 1.0.58 - 26 September 2026

- Consolidate the Extensions-tab settings panel. `index.js` now builds the final grouped panel once instead of emitting a flat list that four other modules then moved around at runtime; full cast, scanner output limit and calendar controls mount into named slots, and all panel styling lives in `style.css` (the injected settings CSS in `dossier-experience.js`, `scanner-output-ui.js` and `calendar-settings.js` and the relocation code in `continuity-ui.js` are removed). Nine groups become an always-visible quick bar (Enable, Auto scan, Open dossiers, Scan dossier now, Full scan current cast, Add NPC) plus six groups: Scanning, Roster & continuity, Calendar & birthdays, Portrait generation, Scanner rules and Data & maintenance, with Clear chat dossier separated as a danger action. Hints are shorter, number fields keep their units beside the input, the custom-preset and relationship-tuning controls use compact grids, breakpoints follow the panel width rather than the viewport, and the open/closed state of each group is remembered per browser. Setting IDs, stored settings, handlers, scanner prompts and rubric defaults are unchanged.

## 1.0.57 - 26 September 2026

- Add per-form portraits. Each named appearance form can hold its own image beside the main portrait: the Appearance section shows a thumbnail and an Add/Change portrait button per form, and the Portrait tool gains a "Portrait for" target (Main portrait or a form) that its Upload, Generate prompts from dossier, Use as Portrait and Remove actions apply to. The dossier and library show the current form's own image when it has one and fall back to the main portrait otherwise; the "changed since portrait" badge compares against the image being shown. Form images are user-owned assets in `formPortraitAssets`, bounded to one per form (at most 8 per NPC), stored in the sidecar but never copied into checkpoints or the rollback journal, kept by the same retention rule as main portraits, removed with their dossier, carried by native bundles as an additive manifest section (older bundles decode unchanged) and remapped to the accepted target on import. Chat inline cards and the quick viewer still show the main portrait.
- Show what the latest update changed. Every scan, Refresh, backfill and dossier import stamps each changed dossier field (mood, location, goal, condition, home base, age, life state, profile fields, appearance, relationship, Player Dynamic, background, bonds, memories, birthday) with the turn it changed. The dossier header reads "Updated this turn · N fields changed: …" and those fields carry a "• T71" marker. The markers are bounded presentation metadata on the canonical record: they roll back with it, never enter scanner prompts or RP injection, and foreign-chat imports never carry source-turn markers.
- Flag portraits that no longer match. Attaching or generating a portrait records a fingerprint of the resolved appearance and the current form; when the dossier appearance later moves on, the portrait shows "Appearance changed since portrait" (or "Portrait shows the <form> form" after a form switch). Portraits attached before this release never show a guessed badge.
- Dossier layout keeps the portrait as the focal element and surfaces the player relationship: a Player relationship card now leads the dossier with the four axis bars plus the last relationship change (impact, signed per-axis deltas, turn and the recorded reason), and Player Dynamic lists earlier changes instead of repeating the bars. Section jump tabs stay pinned at the top of the dossier, the hero portrait opens a full-size view (expand button or click, Escape/Close to dismiss), phones give the portrait up to about 60% of the screen height, and deceased cast members follow the living as compact dimmed tiles after a divider. Presentation only: no canonical state, persistence, scanner or prompt change.

## 1.0.56 - 26 September 2026

- Keep enduring physical appearance traits through outfit/presentation updates. When an accepted current-appearance update omits hair, eyes, skin, build, height, facial features, scars, tattoos or anatomy (ears, horns, tail, wings, fur, scales and similar), those traits carry forward from the previous presentation; a trait changes only when the incoming presentation itself describes it (a "hood hides her hair" style mention does not count). Clothing, gear and transient condition still follow the full-current-presentation replacement rule, admission/grounding gates are unchanged, and named forms keep their own traits without duplicating Shared appearance.
- Capture narrated birthdays returned in a `profileUpdates` row. The scanner is told to put grounded durable facts there, but birthdays were read only from the `npcs` delta, so an existing NPC's narrated birthday was dropped and the generated fallback stayed. Both channels are now accepted (the `npcs` delta wins when both carry one) under the same establish/correct gate.
- When a scanner reply contains no JSON object at all (a provider/host message or model refusal such as "The prompt ..."), the failure toast and console warning now show a bounded 200-character excerpt of what was returned and name the usual causes (provider block/refusal, context overflow, or a profile not using a chat model that follows JSON instructions), instead of only a ten-character JSON parse error. The existing single JSON retry, request counts, prompt bytes and diagnostics retention are unchanged.

## 1.0.55 - 25 September 2026

- Fix a cross-session data-loss path in the 1.0.54 server-authority model: a session that hydrated a chat before another session created its sidecar had no pointer, skipped freshness checks and wrote revision 1 blindly over the other session's canonical file. Unpointered guarded writes and freshness checks now probe the deterministic sidecar path; a live file is adopted (dirty local work is preserved as recovery-only) and a write without a revision token is refused. Replacing a retired tombstone for a reused chat name remains allowed.
- Fix a false cross-session conflict after a lost acknowledgement: when an upload became durable but its response or post-upload verification failed, the retry saw its own revision and moved newer local work into recovery-only state. Guarded writes now stamp each upload with a revision/writer/timestamp nonce and adopt exactly that durable revision on retry; any other writer, revision or payload still conflicts.
- Fix the dossier editor refusing its main Save ("opened on an older server revision") after the editor's own Appearance-form, Life-state or portrait commits advanced the durable revision. The guard now follows a working-copy adoption epoch that changes only when a loaded/server copy replaces the working copy, so another session's installed revision is still refused.
- Correct DEVELOPMENT.md after the 1.0.53 migration removal: `npm test` runs three programs and no longer references the removed migration smoke.
- Add storage and synthetic-runtime regressions for unpointered adoption, retired-tombstone replacement, lost-acknowledgement adoption versus a genuinely competing writer, and in-editor commits versus another session's revision. Persisted storage/bundle/branch formats, settings schema v30, model-facing prompt bytes, request topology, relationship scoring and RP injection are unchanged.

## 1.0.54 - 25 September 2026

- Make the SillyTavern server-side NPC State sidecar the sole durable authority across desktop, mobile, tabs, and browser sessions that use the same backend. Hydrated browser state is an ephemeral working copy rather than proof of freshness.
- Add event/boundary-driven freshness checks for chat load/change, app resume, dossier-open, manual mutation, scanner/provider, portrait, import/export, and destructive lifecycle paths without background polling.
- Rehydrate clean stale caches directly from the newest server sidecar. When local work is dirty, preserve it as recovery-only state and activate the newer server copy instead of overwriting, silently merging, or discarding the local work.
- Strengthen `NPC_STATE_WRITE_CONFLICT` with revision + writer-token checks and post-upload ownership verification, including same-revision writer forks that plain revision numbers cannot distinguish.
- Bind scanner/provider and portrait completions to the durable revision they started from, and reject stale completion after another session advances the canonical sidecar. Manual editor saves also refuse stale snapshots while leaving the draft available for review.
- Keep durability retries, recovery files, branch reconciliation, rename/delete/retire protections, prompt injection, and bounded diagnostics intact. Separate SillyTavern servers remain independent; no localStorage/IndexedDB/cloud/P2P/device-specific dossier store becomes canonical.
- Add multi-session regressions for same-revision no-op checks, multi-revision handoff, chat re-entry, stale provider rejection, writer forks, recovery-only conflicts, browser-resume boundaries, and no-polling behavior. Persisted storage/bundle/branch formats remain unchanged.

## 1.0.53 - 24 September 2026

- Consolidate active legacy unqualified-sidecar ownership migration onto one hardened transaction owner. Migration now requires the full stored-lineage proof, refuses an already-resident canonical destination, verifies canonical and recovery writes, persists the ownership mapping synchronously, and only then physically deletes the retired predecessor.
- Remove the competing weaker four-message-prefix migration path and duplicate `CHAT_CHANGED` migration listener, eliminating both ambiguous legacy claims and two-writer migration races.
- Harden alias-linked dossier deduplication so the canonical proper-name record retains established Gender/Home Base, manual Name and stable-profile locks remain authoritative, and an Appearance lock preserves the complete Stage 4 form/current/shared presentation state.
- Harden matched native-bundle imports so target-side manual locks survive imported replacements while portable source locks and unlocked current-state fields still reconcile; stable-id collisions and rejected imports cannot misattach social-graph edges.
- Correct profile diagnostics: structured/form-only Appearance updates report their resolved applied presentation, Mannerism/Behavioral Profile diagnostics use their own field parser/limits, and unknown numeric provenance remains null without erasing a real message id 0.
- Expand regression coverage for strong migration ownership, locked alias dedupe, matched-import lock preservation, structured Appearance diagnostics, and diagnostic provenance. Settings schema remains v30; scanner/model-facing prompt bytes, request topology, relationship scoring, and RP injection are unchanged.


## 1.0.51 - 24 September 2026

- Deep-pass harden Custom Preset Library Add/Duplicate/Rename/Delete with immediate SillyTavern host settings persistence, rollback on save failure, and success feedback only after durable save.
- Preserve pending portrait edits across Rename/Delete management flows; Add/Duplicate preserve unsaved global generation/gallery toggles while materializing the new custom preset.
- Reject duplicate custom preset names after Unicode/whitespace normalization and generate collision-safe duplicate suggestions.
- After deleting a preset, select the adjacent surviving preset instead of always jumping to the first entry.
- Add exact legacy-Custom migration coverage and synthetic-runtime coverage for multiple named presets feeding the live portrait prompt builder.
- Refresh portrait-generator copy to refer to the selected theme/preset rather than the old single global theme. Settings schema remains v30; scanner/model-facing prompt bytes are unchanged.


## 1.0.50 - 24 September 2026

- Replace the single portrait Custom slot with a persistent named Custom Preset Library, bounded to 24 entries.
- Migrate the exact legacy Custom positive/negative/composition/format/mood/location values into `Custom 1` on settings schema v30.
- Add Add, Duplicate, Rename, Delete, and selector controls; the last custom preset cannot be deleted.
- Store positive style, negative prompt, composition, prompt format, mood inclusion, and location inclusion per custom preset; keep portrait-generation enablement and SillyTavern gallery saving global.
- Preserve per-NPC temporary portrait prompt drafts and built-in theme presets. Dirty preset switching asks before discarding unsaved edits.
- No scanner/provider prompt, relationship, dossier-state, request-topology, or RP-injection changes.


## 1.0.49 - 24 September 2026

- Render scanner-compatible flat current Appearance as a read-only dossier `Current presentation` fallback when no named/unclassified current presentation exists, instead of hiding valid captured detail behind an empty forms panel.
- Keep form identity unchanged while displaying the fallback, preserving species-aware portrait behavior and existing named/unclassified form semantics.
- Add regressions for existing scalar-only records, future flat scanner Appearance updates on form-less NPCs, and portrait species preservation.
- No model-facing prompt bytes or request topology change from 1.0.48.


## 1.0.48 - 24 September 2026

- Require existing NPCs with explicit new/corrected/current visual evidence to emit `appearance` and `evidence.appearance` in the same `profileUpdates` row, even when other durable profile fields are returned.
- Add a dedicated Appearance diagnostic row that distinguishes `not-provided`, `candidate-missing`, `locked`, `unchanged`, `unchanged-or-gated`, and applied outcomes.
- Make Appearance diagnostics search both ordinary `npcs` and `profileUpdates` channels so a profile row cannot hide an Appearance update carried by the ordinary delta.
- Preserve Appearance as immediate current-visible continuity rather than adding it to the Personality/Speech three-observation development ledger.
- Record the reviewed model-facing footprint versus 1.0.47: routine scanner/full-window +2 characters and scanner-shaped retry captures +2; targeted Refresh, backfill, dossier import, focused relationship, and RP injection remain unchanged.


## 1.0.47 - 24 September 2026

- Fix Appearance extraction so grounded current visual presentation includes directly described hair/body traits, current outfit/gear, and relevant visible condition instead of being suppressed by the durable-identity firewall.
- Treat explicit visual reveal/correction wording, such as an obscured hair color being shown to be different, as a source-grounded Appearance refinement that can replace the mistaken prior impression without requiring high lexical overlap.
- Allow grounded `appearanceState:"change"` updates for clothing/current-presentation changes without routing them through Personality/Speech development-scale readiness; existing evidence grounding, form ownership, locks, and unsupported-rewrite rejection remain in force.
- Add regressions for corrective hair-color narration, changed clothing/boots, scanner prompt guidance, and bounded roster overhead. Record the reviewed model-facing footprint versus 1.0.46: routine scanner/full-window +102 characters, targeted Refresh +221, backfill +71, dossier import +34, and scanner-shaped retry captures +102; focused relationship and RP injection remain unchanged.

## 1.0.46 - 23 September 2026

- Add canonical NPC gender as optional stable identity metadata with only `male`, `female`, or blank for unknown/not yet established. Scanner, Refresh, backfill, and structured dossier import may establish it only from explicit wording or an unambiguous gendered identity/reference; names, occupations, clothing, body type, species, and generated portraits cannot infer it.
- Preserve established gender by default and require explicit correction state/reason before an automatic scan can flip it. Carry the field through candidates, rollback/native bundle state, manual editing, search, and roleplay injection without changing persisted format versions.
- Show identity as `Species · Gender · Role · Age/Looks` and add gender to the cast rail. Portrait prompts now place gender immediately after species and before apparent age/appearance/role so image generation no longer receives an under-specified subject when gender is known.
- Add end-to-end regressions and advance synchronized application/package/display metadata to 1.0.46.
- Record the intentional model-facing footprint: routine scanner/full-window +59 characters, targeted Refresh +188, backfill +161, dossier import +149, and scanner-shaped retry captures +59; focused relationship and RP injection remain unchanged, as do request counts, response allowances, route options, and reasoning ownership.

## 1.0.45 - 22 September 2026

- Restyle the Portrait seed control as a compact dark-theme panel so the browser-default white number input no longer breaks the Portrait dialog's visual hierarchy.
- When the seed field is blank, choose a fresh safe-integer generation seed inside Delta before calling SillyTavern Image Generation, display that exact generation seed beside the preview, and offer **Save as NPC seed** for one-click reuse. Existing saved seeds remain fixed and continue to pass through `/imagine seed=<n>`.
- Keep generated seed provenance preview-scoped and outside scanner/roleplay state until explicitly saved; add focused UI/seed regressions and advance synchronized application/package/display metadata to 1.0.45 with persisted format versions unchanged.

## 1.0.44 - 22 September 2026

- Add an optional persisted per-NPC Portrait seed in the maintained Portrait tool. Blank keeps SillyTavern default/random behavior; a saved non-negative safe integer is passed through the native `/imagine seed=<n>` argument, including ComfyUI workflows that consume `%seed%`.
- Keep seed state outside roleplay/scanner prompts and preserve host ownership of checkpoint, workflow, sampler, resolution and other image settings; fixed seeds improve repeatability but do not guarantee identity if those inputs change.
- Stabilize the Data & maintenance action order as `Scan dossier now` → `Full scan current cast` → `Clear chat dossier`, add seed/order regressions, and advance synchronized application/package/display metadata to 1.0.44 with persisted format versions unchanged.

## 1.0.43 - 22 September 2026

- Fix the remaining full-cast settings race by re-homing an already-rendered `Full scan current cast` button into Data & maintenance after cohesive settings normalization, instead of only choosing the correct container at first creation.
- Listen to the existing `npc-state-delta:settings-mounted` lifecycle event and add a regression covering the re-home path.
- Advance synchronized application/package/display metadata to 1.0.43 with persisted format versions unchanged.

## 1.0.42 - 22 September 2026

- Move the settings-level manual `Full scan current cast` action into Data & maintenance beside `Scan dossier now`, instead of mounting it as a standalone row outside the section.
- Keep automatic full-cast configuration under Scanning and the delegated Diagnostics shortcut intact; add focused ownership regression coverage.
- Advance synchronized application/package/display metadata to 1.0.42 with persisted format versions unchanged.

## 1.0.41 - 22 September 2026

- Restore the manual `Full scan current cast` follow-up action to the Diagnostics modal. Diagnostics emits a small internal request event; `full-cast.js` remains the only owner of full-cast scan execution.
- Preserve the existing automatic full-cast toggle under Scanning and `Scan dossier now` under Data & maintenance, and add focused regression coverage for the diagnostics/full-cast bridge.
- Advance synchronized application/package/display metadata to 1.0.41 with persisted format versions unchanged.

## 1.0.40 - 22 September 2026

- Restore the manual `Scan dossier now` action to Data & maintenance for follow-up/recovery use, while keeping the optional `Full scan current cast` action in Scanning and Portrait generation free of unrelated controls.
- Add focused settings-group ownership regression coverage and advance synchronized application/package/display metadata to 1.0.40 with persisted format versions unchanged.

## 1.0.39 - 22 September 2026

- Make Comma tags genuinely tag-oriented: omit appearance prose fragments already represented by extracted visual anchors while retaining unparsed appearance fragments, and add `loose hair` / `hair ribbons` coverage for common hair-state wording.
- Fix optional `Full scan current cast` UI ownership so it mounts into the Scanning action group instead of the first generic settings action container, preventing it from appearing under Portrait generation.
- Add focused regressions for pure tag output, retained unparsed fragments and full-cast Scanning ownership; advance synchronized application/package/display metadata to 1.0.39 with persisted format versions unchanged.

## 1.0.38 - 22 September 2026

- Strengthen Comma tags portrait prompts by promoting explicit visual anchors from accepted appearance prose into standalone subject-first tags before the prose fallback. Hair color/form, eye color, pointed/human ears and bounded direct body/build traits are extracted conservatively without replacing the accepted appearance source.
- Preserve explicit multicolor hair as one combined standalone anchor when the dossier states it that way, and keep contradiction negatives evidence-bound so an explicitly present color component is never negated.
- Add regression coverage for the live auburn half-elf clerk prompt and golden-blue multicolor hair, then advance synchronized application/package/display metadata to 1.0.38 with persisted format versions unchanged.

## 1.0.37 - 22 September 2026

- Clean up Settings action grouping: move Scan dossier now into Scanning, Add NPC into Roster & cleanup, and Clear chat dossier into Data & maintenance so unrelated controls no longer appear visually attached to Portrait generation.
- Advance synchronized application/package/display metadata to 1.0.37 while leaving persisted format versions unchanged.

## 1.0.36 - 22 September 2026

- Make portrait prompt assembly deterministic and subject-first: accepted identity/current appearance lead role, clothing, mood, location and composition, with global positive style last; strip tag-format metadata labels, deduplicate repeated strong-boundary clauses, and derive only explicit safe contradiction negatives for stated hair colors or explicit absent anatomy.
- Add native portrait generation to the maintained Portrait tool through SillyTavern Image Generation. The edited dossier-derived positive/negative prompts are handed to the existing host `/imagine` bridge, so ComfyUI/A1111/other configured backends remain owned by SillyTavern rather than Delta. Re-expose the existing generation enable and gallery controls in the cohesive settings surface. Force `extend=false edit=false` for Delta portrait requests so SillyTavern cannot LLM-rewrite grounded appearance traits before backend generation; host-global Prompt Prefix / Negative Prompt and backend settings still apply.
- Keep generated images preview-only until explicit **Use as Portrait**. Closing/switching chats or superseding an in-flight action invalidates late results; accepted previews reuse the canonical portrait validation/compression/persistence path and retain the existing 16 MB input boundary.
- Retire the obsolete dossier `importance` field and generic per-NPC `manual` boolean. Historical values are accepted as input only long enough to normalize them away; current story salience, scoped profile locks, and typed manual provenance remain authoritative.
- Add durable Home Base / Usual Location as ongoing-life geography distinct from live Location. An established Home Base is keep-by-default and requires a grounded explicit update/reason to relocate.
- Consolidate appearance ownership: the flat `appearance` scalar remains a compatibility/resolved projection for historical records and scanner interoperability, while new manual editing and dossier presentation use Shared Appearance, named forms, Current Form, and unclassified current presentation without a duplicate flat editor/display.
- Clarify dossier presentation labels to Behavioral Levers, Player Dynamic, Condition / Activity, and Hide present-NPC card; group Birthday and Home Base with identity continuity.
- Keep Important Memories as the bounded five-event episodic continuity channel and preserve relationship event history / last relationship change unchanged.
- Advance synchronized application/package/display metadata to 1.0.36 while keeping persisted storage, bundle, branch, rollback-journal and diagnostic schema versions unchanged. Deterministic Stage 9 measurement retains the reviewed Home Base prompt delta: routine/full-window +193 characters, targeted Refresh +272, backfill +315, dossier import +218; focused relationship and RP injection are unchanged, as are request counts and response allowances.

## 1.0.35 - 19 September 2026

- Recover a narrowly safe Behavioral Profile refinement when the provider returns a changed full candidate but leaves `behaviorProfileState` at `keep`: every established rule must still be present verbatim, only additive target-general rules may be admitted, every new rule must be grounded by that field's evidence, and existing agency/morality conflict guards remain authoritative.
- Preserve rejected/unsupported Behavioral Profile evidence for later scans rather than treating `keep` as replacement authority. Diagnostics label accepted recovery as `applied-recovered-refine`.
- Clarify routine scanner and targeted Refresh prompts that one story observation may independently support multiple durable fields, so a scene can emit both Speech evidence and Behavioral Profile evidence when cadence/wording and a target-general behavioral strategy are both grounded.
- Record the intentional prompt-budget change: routine/full-window requests are +30 Delta-owned characters, targeted Refresh is +120, request counts/output allowances/routes are unchanged, and reviewed Stage 9 hashes are updated accordingly.
- Advance synchronized application/package/display metadata to 1.0.35; persisted storage, bundle, branch, rollback-journal and diagnostic schema versions remain unchanged.

## 1.0.34 - 18 September 2026

- Fix automatic per-NPC backfill storms resurfacing after update/reload because pre-1.0.34 unscoped `pendingBackfills` could remain persisted and were drained after later assistant receipts even when no new scan was due.
- Version and reason-scope automatic backfill work as `missed-participant` or `new-admission`; discard legacy/unversioned pending backfill entries during hydration instead of replaying obsolete cast-wide work.
- Revalidate automatic missed-participant retries against the exact owning exchange before dispatch. Manual Scan dossier/history repair remains explicitly available and is not subject to automatic-queue provenance rules.
- Bound omitted-established-participant automatic continuity repair to at most one target per broad scan. If multiple apparent omissions are detected, suppress that per-NPC fallback rather than allowing an implicit Full Cast fan-out; newly admitted dossiers retain their own targeted enrichment.
- Advance synchronized application/package/display metadata to 1.0.34; scanner prompt bytes and persisted dossier/bundle/branch/rollback-journal/diagnostic schema versions remain unchanged.

## 1.0.33 - 18 September 2026

- Fix portrait prompts being silently truncated at several independent layers: 2,400-character global style settings, 1,800-character builder/override limits, 800/1,200-character composition limits, and final 6,000-positive / 4,000-negative assembly caps.
- Raise global positive/negative style and per-NPC portrait override safety limits to 12,000 characters and composition to 6,000 characters, with the same limits used by settings persistence, dossier normalization, portable native settings, and UI inputs.
- Remove the redundant final assembled-prompt truncation so all bounded prompt components reach the portrait editor, clipboard workflow, and native `/imagine` handoff intact; provider/backend limits remain owned by SillyTavern Image Generation.
- Add regressions proving positive prompts beyond 6,000 characters, negative prompts beyond 4,000 characters, long per-NPC overrides, and portable prompt settings preserve their tail content.
- Advance synchronized application/package/display metadata to 1.0.33; persisted storage, bundle, branch, rollback-journal and diagnostic schema versions remain unchanged.

## 1.0.32 - 18 September 2026

- Fix automatic established-NPC continuity repair treating names inside World State, NPC Inner Chatter, roster/status blocks, and other structured evidence listings as narrative participation.
- Keep structured evidence fully available to the broad scanner and targeted backfill prompts, but require real narrative participation before an omitted established dossier can be auto-backfilled.
- Add regression coverage for raw `<World_State>` blocks, World State `<details>` blocks, and mixed narrative-plus-structured exchanges; retain targeted new-dossier enrichment and explicit current-participant repair.
- Advance synchronized application/package/display metadata to 1.0.32; persisted storage, bundle, branch, rollback-journal and diagnostic schema versions remain unchanged.

## 1.0.31 - 18 September 2026

- Narrow automatic new-NPC enrichment to the newly created/promoted dossiers instead of treating admission as a cast-wide deep-reconciliation checkpoint. Established NPCs are no longer individually backfilled merely because another NPC was admitted.
- Preserve silent targeted continuity repair for established NPCs that the broad current-exchange scan actually omitted, plus manual Refresh/Scan and the separately opt-in current-cast workflow.
- Remove the retired `deepSweep` queue flag and add regression/contract coverage so new admission cannot reintroduce per-NPC fan-out across the established cast.
- Advance synchronized application/package/display metadata to 1.0.31; persisted storage, bundle, branch, rollback-journal and diagnostic schema versions remain unchanged.

## 1.0.30 - 16 September 2026

- Fix destructive message rollback when SillyTavern emits `MESSAGE_DELETED` or `MESSAGE_EDITED` before its in-memory chat lineage has finished changing. Delta now keeps the destructive event pending until the host exposes the committed narrative mutation instead of consuming the event against the stale latest lineage.
- Derive the rollback boundary from the observed post-mutation narrative lineage before invoking the existing branch reconciler. Tail/middle deletion and edit therefore reach the established exact journal/checkpoint recovery path without relying on fixed 70/110 ms delays or callback message-index timing.
- Preserve fail-closed recovery semantics: if the host never exposes a matching destructive lineage mutation within the bounded settlement window, keep canonical dossier state rather than rolling back against stale or ambiguous chat data. Chat switches cancel pending settlement.
- Add runtime regression coverage for the real event order: deletion event first, unchanged host chat for 120 ms, then host truncation. The test proves no premature rollback before mutation and exact state restoration afterward; focused settlement tests cover both host event orders, edits, rapid destructive events, timeouts and chat switches.
- Keep the 1.0.29 dossier-evolution fixes, 1.0.27 prompt arrangement, request counts, response allowances, provider routing, relationship scoring, and persisted storage/bundle/diagnostic/rollback/branch schemas unchanged.

## 1.0.29 - 16 September 2026

- Close the six remaining dossier-evolution defects found after the 1.0.28 review while preserving the existing scanner/Refresh request architecture and prompt bytes.
- Route accepted flat Appearance updates through the same durable grounding/admission protections as the canonical mechanics owner, so a rejected unsupported candidate cannot be revived by facade reconciliation while valid form selection remains supported.
- Make durable refinement grounding claim-complete and target-NPC-specific: unsupported clauses cannot piggyback on a supported clause, and another NPC's evidence cannot authorize the target through shared wording or stripped labels.
- Make evidence coverage directional and clause-polarity aware, so a shorter accepted summary cannot erase a longer novel observation and unrelated negation cannot poison or falsely satisfy a separate predicate. Copied Personality/Speech candidates keep unresolved evidence until it is genuinely represented.
- Require explicit per-member proof before already-resolved Important Bonds inherit collective semantics such as twins; preserve edge direction repair, partial/ambiguous groups, unrelated bonds and idempotent graph projection.
- Preserve Shared appearance grammar when removing duplicated prefixes, including visibility, copular and negation predicates such as `are not visible`, rather than emitting detached fragments.
- Add regression coverage for the repaired appearance, refinement-scoping, evidence-directionality, polarity, collective-bond and Shared-prefix cases. Persisted storage, bundle, diagnostics, rollback, branch schemas, relationship scoring and provider request budgets remain unchanged.
- Advance synchronized application/package/display metadata and current-version assertions to 1.0.29; retain all 1.0.28 review/provenance material as historical evidence.

## 1.0.28 - 16 September 2026

- Harden durable `refine` so preserving established wording no longer authorizes unsupported new Personality, Speech, Appearance, or Behavioral Profile meaning. Newly introduced claims must be grounded in supplied story/evidence; directly supported clarification still applies immediately without forcing gradual-development thresholds, and morality/agency protections remain authoritative.
- Reconcile accepted flat current Appearance output into the canonical selected presentation before display resolution, preventing an unchanged named form from restoring stale clothing/anatomy. Preserve named-form isolation, unnamed-current handling, Shared traits, locks, and simultaneous form-selection safety.
- Deduplicate repeated Shared appearance clauses across ordinary punctuation/whitespace boundaries with exact semantic phrase matching rather than loose keyword overlap, preserving negation and genuinely distinct form detail across dossier, portrait, scanner-context, and roleplay projections.
- Consolidate fully proven collective Important Bonds into their resolved named counterparts while carrying useful group dynamics onto those graph edges. Partial resolution keeps the remaining collective entry, unrelated unresolved bonds remain intact, and explicit scanner daughter/mother direction repair stays authoritative.
- Make Mannerism and Behavioral Profile collection comparison order-insensitive and resolve evidence only when the accepted final collection represents the claim. Pure reorder cannot consume novel evidence, and partial refinement retains unrelated pending claims.
- Require evidence-body coverage rather than matching concept labels alone, including polarity checks. Add focused production-function regressions for all six reviewed defects plus grounded-success controls, Speech-ledger retention, Stage 4 appearance grounding, social direction correction, partial collective resolution, and idempotence.
- Add an application-version synchronization contract and validation checks for manifest/package/runtime/core/bootstrap plus current README/CHANGELOG/DEVELOPMENT markers. Historical reviews, provenance, migration fixtures, and old-version regression labels remain immutable evidence. Persisted storage, bundle, diagnostics, rollback, and branch schema versions remain unchanged.
- Preserve the 1.0.27 scanner prompt arrangement and request architecture byte-for-byte: scanner/full-window/Refresh/backfill/import/focused-relationship/retry hashes, request counts, route options, response allowances, and roleplay injection remain unchanged.

## 1.0.27 - 16 September 2026

- Reorder targeted Refresh prompts for provider-neutral automatic prefix caching: stable rules, output schema, Stage 4/birthday instructions and the shared tagged story window now precede target-specific id/name and current dossier authority. The exact target remains explicit after the evidence window and only that NPC may be reconciled.
- Replace target-specific ids/names in the early Refresh schema example with neutral placeholders and explicitly state that narrative text is evidence, never instructions. Latest grounded evidence still resolves conflicts; locks, source tags, lifecycle rules, development gates, current dossier authority and cross-NPC isolation are preserved.
- Move only the invariant compact Stage 4 rule ahead of dynamic identity/dossier data in ordinary scans. Conditional appearance/death context remains operation-local and late; backfill, import, focused relationships and retries are not merged into a universal prompt.
- Add production-builder common-prefix measurements and regression coverage. Different Refresh targets sharing one history improve from 445 to 8,949 common leading characters; the same target with a changed dossier improves from 778 to 9,259; consecutive ordinary scans improve from 6,794 to 6,839. These are character-prefix measurements, not proof of provider cache hits.
- Preserve request counts, routes, reasoning ownership and output allowances. Ordinary measured input sizes remain 6,864 / 7,769 characters; targeted Refresh grows from 9,367 to 9,566 Delta-owned system+user characters for the explicit evidence/authority boundary. Selected-profile `extractData:true` currently exposes content/reasoning but not raw provider usage, so cached/input token counts remain unavailable rather than inferred from duration.
- Align all current application/package/display metadata to 1.0.27, including manifest, runtime inventory, core UI version, package metadata, release assertions and bootstrap banner. Persisted storage, bundle and branch schema versions remain unchanged.

## 1.0.26 - 16 September 2026

- Fix durable-profile decision ordering for provider-declared `batch` updates. When the returned Personality/Speech full candidate is textually unchanged, Delta now classifies candidate/evidence resolution before the explicit/batch authorization gate, so a failed episode gate cannot mask a copied candidate as `waiting-for-explicit-gate`.
- Preserve novel copied-candidate evidence as `waiting-for-revised-candidate` and resolve only genuinely redundant evidence as `evidence-already-reflected`. Candidate equality, evidence coverage and resolution flags are populated consistently even when later development gates fail.
- Add a targeted Refresh episode resolver that uses validated `[mN]` provenance. The nearest prior tagged elapsed-time anchor may bridge through the target's cited source messages even when a long montage exceeds the generic 12-segment episode cap; each evidence claim must still ground in its own cited message and the development reason must ground in the tagged episode.
- Keep ordinary/multi-NPC scanning on the existing strict bounded episode path. The targeted source-tag bridge does not enlarge the generic episode window, does not let another NPC's evidence authorize the target, and makes no extra model request.
- Add regressions for the live Sora copied-candidate gate-order shape, redundant-evidence resolution, and a targeted `[m202]` to `[m204]` development episode containing more than twenty intervening sentence segments. No scanner/Refresh prompt text, output allowance, persistence schema, native bundle, branch lineage or relationship formula changes are introduced.

## 1.0.25 - 16 September 2026

- Fix the copied-candidate false resolution exposed by live Sora diagnostics. An unchanged Personality/Speech candidate can no longer consume a ready batch/aggregate evidence epoch merely because the provider labelled it `refine`/`batch`; Delta now proves that every bounded evidence claim is already represented by the accepted current field before reporting `evidence-already-reflected`.
- When an unchanged candidate still omits supported development, preserve its Personality/Speech ledger and profile evidence and report `waiting-for-revised-candidate`. Mannerism/Behavioral Profile refinement likewise retains novel field evidence when the returned full list is unchanged, instead of discarding that evidence during refinement cleanup.
- Tighten the scanner/Refresh provider contract without another request: `refine`/`evolve` must return a changed full candidate when durable development is genuinely new, while evidence that only reinforces the current profile should be omitted/kept. Batch chronology does not force cosmetic wording churn.
- Advance compact diagnostic export to version 3 with `evidenceAlreadyRepresented`, keeping `candidateAlreadyRepresented` separate from evidence coverage so copied stale candidates are directly distinguishable from genuinely redundant evidence.
- Add live-shape regressions for copied Sora Personality/Speech batch candidates, collection evidence retention, genuinely redundant evidence, and the provider consistency rule. The reviewed Stage 9 scanner fixture is one character smaller than 1.0.24 and targeted Refresh is 17 characters smaller; request counts, output allowances and roleplay injection are unchanged. No persistence schema, native bundle, branch lineage or relationship formula changes are introduced.



## 1.0.24 - 16 September 2026

- Fix the remaining time-compressed `refine` gap exposed by live Sora diagnostics. Refresh/routine prompts now require `developmentReason` when a refine/evolve/change relies on elapsed sustained development, while the backend can deterministically recover an effective reason from field-specific evidence when the provider still omits it.
- Keep that recovery candidate-specific. Mannerisms and Behavioral Profile must ground each newly proposed entry from their own evidence before inferred-batch semantics can authorize it; unrelated evidence in the same field or shared episode cannot license a different new habit/rule.
- Resolve fragmented aggregate Personality/Speech evidence that is already represented by the accepted current candidate. Only the aggregate-fallback case is consumed/reset; ordinary concept-ledger readiness keeps the existing `waiting-for-candidate` behavior until a materially changed candidate arrives.
- Expand profile diagnostics with candidate-changed/already-represented state, provider/effective reason source, resolved-evidence state, and candidate/reason grounding. Secondary Mannerism/Behavior diagnostics use the same effective-reason and candidate-specific checks as application.
- Reduce birthday diagnostic noise by omitting unrelated NPCs that merely share a transcript containing birthday language. Relevant rows now include previous/current birth date, birth-year source, calendar age, reference date, age/birth-date state and supplied-date flags for easier chronology debugging.
- Add regressions for the reported Sora missing-reason Mannerism case, unrelated-evidence rejection, aggregate already-reflected cleanup, Refresh contract wording and birthday diagnostic filtering/details. No extra model request, storage-schema bump, native-bundle change, branch-lineage change or relationship-formula change is introduced.

## 1.0.23 - 16 September 2026

- Replace sentence-pair-only time-skip grounding with a bounded development episode. Natural elapsed spans may now carry a contiguous montage across later sentences/paragraphs, while a later explicit elapsed anchor, present-scene transition, segment cap or character cap ends the episode. Bare time passage remains non-destructive.
- Make shared elapsed chronology NPC-aware. Each evaluated NPC must ground its own development from name/alias ownership, bounded source-tagged evidence and at most one conservative pronoun continuation; another NPC's evidence cannot authorize the target. Targeted Refresh remains one-NPC and normal multi-NPC scans may independently evolve several NPCs inside the same episode.
- Complete ordinary gradual Personality/Speech development with an aggregate field-level fallback. Three independent provenance-bearing observations across the existing minimum span may collectively ground the changed candidate even when the provider uses different concept labels; concept buckets remain separate, replayed sources do not count twice and unrelated observations remain blocked.
- Extend deterministic inferred time-compressed development to the existing Mannerism and Behavioral Profile gates as well as Personality/Speech, without moving Appearance, relationships or current-state fields onto that lifecycle.
- Add always-on bounded operation diagnostics outside canonical dossier/story state. Per-NPC dossier Show/Hide is presentation-only; Data & Maintenance Diagnostics can display, clear and export a versioned compact JSON bundle containing bounded profile/birthday gate decisions while excluding full story text, prompts, credentials and provider payloads.
- Add birthday/aging decision receipts for deterministic advance/hold, including same-day idempotence and the first-establishment guard, without changing v1.0.22 calendar mechanics. Add generalized multi-NPC, cross-NPC isolation, episode-boundary, aggregate-gradual, Mannerism/Behavior, diagnostic privacy/export and birthday-diagnostic regressions. No extra model request, prompt change, storage-schema bump, native-bundle change or branch-lineage change is introduced.

## 1.0.22 - 15 September 2026

- Fix deterministic birthday rollover for an existing dossier when the grounded calendar reaches its stored birthday. Full-year calendar arithmetic now advances chronological age and a compact numeric apparent-age estimate by the same confirmed delta, while manual age/apparent-age locks, provider-explicit chronological corrections, terminal death and provider-explicit apparent-age evolution remain authoritative.
- Recover existing yearless month/day birthdays on their exact narrated birthday or nameday once: advance the accepted chronological age, reanchor the derived birth year, and make repeated same-day scans idempotent. Do not assume a rollover when the birthday is first established in that same scan. Recognize `nameday` / `name day` as birthday evidence for the existing conditional scanner rule.
- Advance Personality/Speech development ledgers to internal version 2 with up to four bounded evidence samples per concept. Three independent observations and the existing provenance span remain required, while candidate grounding can aggregate support across retained samples instead of depending only on `latestEvidence`.
- Prevent replayed source messages from manufacturing historical sample support; v1 ledgers seed one sample from their old `latestEvidence`, cross-chat import clears pending samples with chronology, and accepted evolution still resets the ledger epoch.
- Add regressions for Ryu-style age `13` / apparent `~12` to `14` / `~13` nameday rollover, same-day idempotence, manual/explicit apparent-age authority, new-birthday ambiguity, nameday prompt activation, accumulated Speech and Personality gradual grounding, bounded sample retention, replay protection and cross-chat scrubbing. No extra model request, relationship change, persistence schema, bundle format, or branch-lineage change is introduced.

## 1.0.21 - 15 September 2026

- Fix the live time-skip false negative where Gemini correctly returned `developmentScale: "batch"` and `speechState: "evolve"`, but deterministic validation still rejected natural elapsed phrasing such as `in two months`, `over the past month`, `the past seventy days`, `for two months`, or `one season under ...` as `waiting-for-explicit-gate`.
- Generalize elapsed-duration parsing across day/week/month/year/decade/season units, larger spelled-out quantities, past/previous/last windows, qualified spans and contextual residence/training spans. Keep age statements and bare passage non-authoritative.
- Strengthen batch grounding so the elapsed-time clause or an explicit temporal continuation must carry sustained-development evidence and sufficiently ground the supplied development reason. Weak generic transitions such as unrelated weather `changed` cannot lend their duration to a later one-off behavior.
- Add scoped deterministic development aliases for conservative paraphrases such as schooling/study and training/practice without changing global durable-profile similarity or adding any model request. Verify the same grounded time-compressed Refresh can carry safe Personality, Mannerisms and Behavioral Profile refinements alongside Speech under their existing field gates.
- Add production `mergeScanResult` reproduction of the reported Ryu payload shape plus unit guards for months, years, seasons, past-day spans, comma-separated `in two months` phrasing, age statements, unrelated elapsed events and semantic development wording. Scanner prompt bytes, request counts/retries, output allowances, relationship mechanics, persistence schemas, branch lineage and native bundle format remain unchanged.

## 1.0.20 - 15 September 2026

- Make time-compressed durable development deterministic instead of depending on the provider to emit the exact `batch` + `evolve` combination. When a Personality or Speech candidate is returned as `gradual`/`refine` or `gradual`/`keep`, Delta may infer the existing batch path only when the supplied story context itself proves an elapsed span, sustained development during that span, and a grounded development reason.
- Generalize elapsed-span recognition to named seasons and seasonal ranges such as spring through summer, plus ordinary day/week/month/year/season spans expressed with `during`, `throughout`, or `across`. Expand sustained-development cues around learning, practice, training, study, apprenticeship, progression and mastery without treating bare time passage as development.
- Require an inferred/declared batch recovery candidate to be materially changed and grounded against the supplied field evidence and development context before replacement. Manual locks, Personality morality safety, existing provider-authorized explicit/batch evolution, gradual three-observation ledgers, rollback ownership and native transfer remain authoritative. No extra model request is added and scanner prompts remain byte-stable.
- Add regressions from the reported seasonal Speech transition, prove that seasonal passage alone cannot bypass gradual evidence, and verify the same grounded elapsed-development recovery for Personality so the behavior is field-general rather than character- or Speech-specific.

## 1.0.19 - 15 September 2026

- Replace the Speech-only exact-label development gate with bounded deterministic Personality/Speech ledgers. Unlabeled evidence and conservative semantic concept variants can accumulate without depending on Gemini to repeat one exact label spelling; three independent related observations across the existing minimum provenance span remain required for gradual promotion.
- Make targeted Refresh source-aware inside its configured recent-story window. Refresh lines carry raw `[mN]` message IDs, Gemini may return up to four tagged gradual Personality/Speech observations, and Delta counts a tag only when that raw message actually belonged to the supplied window. Multiple qualifying messages inside one Refresh can therefore contribute independently without pretending they all occurred on the Refresh boundary.
- Let deterministic gradual readiness own the final lifecycle decision: once a ledger is ready, a changed full current Personality/Speech candidate may be promoted even when the provider labels it `refine`/`keep`, but only when the new concepts are grounded in the accumulated evidence. Delta never invents replacement prose when the provider copies the stale current summary; diagnostics report `waiting-for-candidate` instead.
- Preserve accepted v1.0.6 model-authorized `evolve` behavior, explicit/batch gates, manual locks, full-summary safety, rollback and native-bundle cloning. Cross-chat native transfer now rebases pending Personality chronology alongside Speech and cannot carry source-chat message/turn evidence into the target.
- Expose `profileUpdates`, `profileApplied`, `profileEvidenceAdded` and bounded per-field development outcomes in Compact Diagnostics. Add regression coverage for the reported Ryu stale-Speech shape, unlabeled evidence, semantic label variants, multi-message Refresh accumulation, forged source tags and cross-chat Personality/Speech rebasing.
- Deliberately clarify only the targeted Refresh prompt so it asks for tagged independent gradual observations and the best full current candidate instead of blindly copying a stale summary. The measured Refresh request grows by 322 characters; scanner/full-window/backfill/import/relationship/retry request counts, output allowances and roleplay injection remain unchanged. Persisted schemas, branch lineage, numerical relationship scoring and native bundle version remain unchanged.

## 1.0.18 - 15 September 2026

- Make Important Bonds / Key Relationships boundary-safe end to end. Canonical stored bonds now use one 360-character budget and social dynamics use 260 characters, with subject/relation/dynamic parsed before limiting instead of raw slicing a preformatted line.
- Compact dynamics by whole deduplicated fragments. If another fragment will not fit, drop that whole fragment; if a single unavoidable fragment itself exceeds the available space, shorten it at a sentence, clause, or word boundary and mark word-boundary truncation with an ellipsis. Never persist a severed word or dangling `|`, `/`, or `;`.
- Route scanner-edge normalization, hidden social-graph storage, graph projection, ordinary dossier merging, legacy normalization, and manually locked bonds through the same canonical representation so repeated reconciliation cannot progressively shorten a bond. Preserve the existing smaller scanner/injection projections, request counts, prompt bytes and output allowances.
- Add regressions for the reported `telepathic bon` / `authority she resp` failure shape, canonical storage beyond the former 220-character ceiling, over-budget fragment dropping, graph projection and manual-lock idempotence. Persisted schemas, bundle format, branch recovery, relationship scoring and model routing remain unchanged.

## 1.0.17 - 15 September 2026

- Rebase foreign-import activity chronology at the canonical bundle merge boundary. New foreign dossiers begin their inactivity clock at the target chat's current turn, while matching target dossiers preserve their existing target-owned `lastSeenTurn` / `lastWorldActiveTurn`; low or high source-chat counters can therefore neither trigger immediate stale deletion nor grant excessive retention. Prepared/UI imports retain their original source-chat identity until the canonical importer applies this rebasing, without inventing source-message provenance.
- Make missing/`keep` Personality, Speech and Appearance recovery satisfy the same field-specific safety gates as explicit refinement in addition to preserving all established durable concepts. Morality reversals and Speech evolution language such as `no longer` cannot pass merely because old words remain lexically present; legitimate additive keep recovery and explicit accepted full-current `refine` remain supported.
- Preserve mixed protected Behavioral Profile directions instead of collapsing them to neutral. Full-profile refinement now rejects agency or morality reversals atomically across renamed categories, including the bounded `not independent` negation case, while ordinary cooperation with authority is not treated as obedience by itself.
- Clear stale inferred status when a social edge gains explicit/manual authority, keep duplicate/reversed-edge normalization consistent with that promotion, and rank capacity by canonical confidence. At the 240-edge limit, weaker/equal arrivals cannot evict equal- or higher-authority established bonds.
- Promote the deep-scan reproductions into tracked regression coverage, including direct and prepared foreign imports, low/high source clocks, matching/new dossiers, both ordinary and `profileUpdates` profile paths, mixed/negated Behavioral Profile cases, explicit/manual social promotion, mirrored projections, repeated normalization and later capacity pressure. Scanner prompts, request/retry/output budgets, routing, numerical relationship scoring, persisted schemas, branch recovery and native bundle format remain unchanged.

## 1.0.16 - 15 September 2026

- Keep the 1.0.15 full-current `refine` contract explicit: missing/`keep` lifecycle markers use non-destructive compatibility recovery that may add grounded detail but preserves omitted established Personality, Speech or Appearance clauses instead of treating omission as deletion authority.
- Apply the same keep-vs-refine distinction to form-independent overall appearance and named appearance forms. Explicit accepted `refine` still replaces that exact current slot and retires omitted superseded visual clauses.
- Make Behavioral Profile refinement atomic across protected identity directions, not only matching category labels. Agency/autonomy versus obedience/compliance and kindness versus cruelty reversals cannot bypass refinement safety by renaming the category.
- Rebase pending Speech-development chronology on cross-chat native import: preserve accepted Speech/epoch/baseline text, clear source-chat message/turn provenance and pending concepts, and keep same-chat ownership unchanged.
- Make social-graph capacity authority-aware. New edges may evict only strictly weaker continuity and can never displace equal- or higher-confidence explicit/manual relationships merely because the 240-edge cap is full.
- Add focused regressions for ordinary/profile-update unmarked summaries, keep-state appearance forms, renamed Behavioral Profile reversals, cross-chat Speech provenance and full-cap social graphs. Scanner prompts/request budgets, numerical relationship scoring, persistence/storage formats, branch recovery and native bundle schema remain unchanged.

## 1.0.15 - 15 September 2026

- Make accepted durable-profile `refine` results authoritative full CURRENT summaries instead of additive history. Personality, Speech and flat/current Appearance now retire omitted superseded clauses after the existing safety gates accept the incoming full field.
- Treat Mannerisms and Behavioral Profile `refine` payloads as full current bounded lists: omitted old habits/rules retire instead of accumulating forever. Unsafe Behavioral Profile refinements reject atomically and preserve the established profile.
- Apply the same current-summary rule inside named appearance forms and form-independent overall appearance while preserving unrelated named forms. Updating Human Form no longer carries an older Human Form outfit forward into the new presentation.
- Keep evidence/history in `profileEvidence`, memories and their existing histories rather than copying history back into current dossier summaries. Existing evolution/development gates, manual locks and identity/morality firewalls remain authoritative.
- Add regressions for the reported blue-gold-hair school-outfit -> flax-smock/vest/skirt stacking case plus Personality, Speech, Mannerisms, Behavioral Profile and named-form replacement. Scanner prompts/request budgets, relationship scoring, persistence formats, branch recovery and bundle schema remain unchanged.

## 1.0.14 - 15 September 2026

- Make Important Bond normalization idempotent when older data already contains repeated structural pipes or spaced slash fragments. Canonical dynamics split legacy `;`, extra `|`, and spaced ` / ` separators, discard tiny truncation debris, deduplicate semantically repeated fragments, and render one structural `|` only.
- Deduplicate repeated relation fragments such as `Host / Caretaker / Host / Caretaker` without collapsing legitimate distinct relation labels.
- Make manual Important Bond deletion authoritative over the shared social edge: remove the hidden pair and the counterpart's mirrored structured bond in the same transaction so reconciliation cannot immediately recreate the deleted entry from the reverse dossier.
- Recover counterpart identity from the structured subject prefix even when the rest of an old bond is malformed/truncated, so corrupted entries can still be deleted cleanly.
- Add the reported Mistress Hilde corruption as a repeated-reconciliation regression plus delete -> reconcile -> still-deleted coverage. Scanner prompts, request budgets, relationship scoring, persistence formats, branch recovery and bundle schema remain unchanged.

## 1.0.13 - 15 September 2026

- Make destructive linear recovery exact-boundary only. Delete/edit may restore the requested surviving parent from the rollback journal or an exact checkpoint, but an older checkpoint can never substitute for a missing parent and generic root fallback is forbidden.
- Extend journal recovery to near-tail replacement divergence, so an edited/regenerated latest assistant can reconstruct its exact parent even after that full checkpoint was pruned; keep the rollback head owned by the restored parent until the replacement is rescanned.
- Fail closed for deep edits with multiple retained assistant descendants instead of rewinding and discarding later accepted continuity. Preserve the current canonical dossiers, rebase unsafe recovery ownership, and rescan without replacing the retained suffix.
- Preserve swipe semantics: an exact known sibling restores without another scan; an unseen sibling may restore only its exact parent/root anchor and must then be scanned. No arbitrary ancestor checkpoint is accepted.
- Expand bounded reconciliation diagnostics with requested recovery boundary, affected assistant count, journal/checkpoint availability, rejected older checkpoint/distance, retained-descendant blocking, and rescan requirement. Add the observed 123-message regression where edit divergence 99 previously restored message 3 and collapsed 26 NPCs to one.
- Keep the 8 MB / 2 MB full-checkpoint limits, 256-message journal horizon, scanner prompts/request budgets, relationship scoring, storage schema and native bundle format unchanged.

## 1.0.12 - 14 September 2026

- Run a one-time legacy branch-history compaction on existing sidecars after lineage is proven safe. Retain the current active lineage plus SillyTavern-retained swipe alternatives, and remove unreachable pre-1.0.11 sibling checkpoints, inline-card branch residue and rollback-journal chains that are no longer owned by the live head or a retained checkpoint.
- Defer compaction while a destructive lineage divergence is unresolved, then retry after reconciliation, so cleanup never races delete/edit/swipe recovery. Persist a versioned compaction marker and bounded before/after accounting so each sidecar is compacted at most once per compaction version.
- Harden v4-to-v5 branch migration by mapping legacy checkpoint keys only when they match the active host branch or a swipe SillyTavern still retains, preventing old delete/regenerate siblings from collapsing onto the current v5 key while preserving provable swipe alternatives.
- Raise the aggregate full-checkpoint budget from 2 MB to 8 MB and the single full-checkpoint ceiling from 750 KB to 2 MB. The separate 256-raw-message rollback-journal contract and 12 MB diagnostic target are unchanged.
- Expand Compact Diagnostics with current narrative snapshot size, largest checkpoint size, aggregate/max checkpoint limits and the most recent compaction summary. Scanner prompts, request counts/retries/output allowances, relationship scoring, sidecar format and bundle format remain unchanged.

## 1.0.11 - 14 September 2026

- Treat ordinary message deletion/regeneration and edits as linear history replacement: restore the surviving parent boundary, discard descendant recovery artifacts, and do not retain deleted generations as sibling branches. Preserve sibling checkpoints only for explicit SillyTavern swipe events.
- Advance destructive branch lineage to v5 using narrative role/content only. Mutable host `send_date`, generation ids and swipe indexes can no longer manufacture a destructive divergence; v4 sidecars and explicit v4 parent branches retain guarded compatibility during upgrade.
- Fail closed when a divergence has no proven recovery target: keep the accepted canonical dossier and rebase ownership instead of walking backward to an older checkpoint or branch root. First-message explicit swipes retain their intentional root-anchor behavior.
- Add bounded branch-reconciliation diagnostics with operation/relation/action, recovery source, fail-closed state, NPC counts, checkpoint bytes and rollback-journal pressure, without retaining story text.
- Self-clean malformed Important Bonds: reject sentence-like orphan prose, normalize inverse owner/counterpart relation collisions, deduplicate near-identical dynamics, align incoming social-edge direction to established bonds, and preserve manually locked relationships.
- Add stress coverage for scattered delete/regenerate cycles across 20 live messages under full-checkpoint byte pressure, explicit swipe siblings, v4-to-v5 migration/ancestry, passive unexplained divergence and edit replacement. Scanner prompts, request counts, output allowances and relationship scoring remain unchanged.

## 1.0.10 - 14 September 2026

- Retain the newest accepted unsaved state across transient-to-permanent persistence failure, cache eviction and rehydration until a successful durable flush; preserve cancellation, retirement, ownership and revision guards.
- Keep referenced journal versions immutable during same-message consolidation, including net-zero revisits, and retain required predecessors for branch checkpoints and sibling chains.
- Checkpoint deterministic assistant receipt changes at their own message boundary before scanning, so failed/skipped/busy scans cannot move turn ownership to a later user message.
- Protect explicitly confirmed-dead dossiers from stale archive/deletion even when automatic death archiving is disabled; preserve ordinary living 30/50-turn cleanup.
- Add production-function and synthetic-host regressions, clarify the governing contract, and preserve scanner prompts/budgets, scoring, the 256 raw-message horizon, Speech behavior and persisted formats.

## 1.0.9 - 14 September 2026

- Preserve undurable persistence ownership through bounded chat-cache eviction and rehydration. A snapshot recovered after a permanent sidecar rejection now remains locally pending until a later successful flush instead of being incorrectly promoted to durable.
- Add a production-runtime regression for permanent HTTP 413 rejection -> cache eviction through eight other chats -> same-session rehydration -> pending durability -> successful later flush.
- Preserve all 1.0.8 recovery behavior, scanner prompts, request/retry/output budgets, relationship formulas, bundle schema, sidecar format version and branch-lineage version.

## 1.0.8 - 14 September 2026

- Separate recovery lineage classification from strict asynchronous equality checks. A persisted lineage that is an exact prefix of the live SillyTavern chat is now a non-destructive forward extension and cannot restore an older checkpoint/root dossier.
- Change the active journal contract to a contiguous 256 raw-message horizon from a trustworthy baseline, including unchanged user/system boundaries. Add normal alternating-chat regressions for exact 100-message deletion, repeated 50+50 deletion, the 256-message boundary, and failed-scan deletion across a preceding user turn.
- Coalesce repeated canonical checkpoints owned by the same message and replace whole-social-graph journal copies with changed edge/slot undo records while preserving a reader for v1.0.7 full-graph entries. Stress coverage with 40 NPCs/240 edges keeps journal growth bounded by changed data rather than graph size.
- Preserve the newest locally dirty state after a permanent durable-write rejection in the persistence owner, so bounded chat-cache eviction and later same-session hydration cannot silently replace it with an older sidecar; successful later persistence or explicit cancellation clears that recovery shadow.
- Complete stale-removal cleanup by purging owned structured relationship references and delaying portrait-asset garbage collection until checkpoints/journal history can no longer restore the removed NPC.
- Compact active sidecar JSON and build base64 input from chunks instead of repeated giant-string concatenation. Persisted data-file format version, bundle schema and branch-lineage version remain unchanged.
- Preserve scanner prompts, request/retry/output budgets, connection-profile routing, numerical relationship formulas, Speech-development semantics and RP injection. No additional model request or background worker is introduced.

## 1.0.7 - 13 September 2026

- Add a bounded reversible rollback journal beside the existing byte-bounded full branch checkpoints. Journal entries store compact canonical-state undo deltas plus exact lineage/sequence ownership, not transcript text or portrait binaries.
- Make large tail deletion independent of whether the exact surviving full checkpoint remains inside the 2 MB snapshot budget. The active journal can walk backward deterministically through recent mutations and marks the restore exact without another scanner/model request.
- Cover structural rollback as well as scalar fields: NPCs first introduced only in deleted history disappear, downstream social edges/key-relationship references, candidates and pending backfills are cleaned up, while surviving NPC memories, relationship state, appearance/lifecycle and Speech-development evidence return to their earlier values.
- Preserve existing user-owned metadata overlay rules during rollback. A manual portrait/profile override on a surviving NPC remains, but user metadata cannot resurrect an NPC whose narrative existence was rolled away.
- If a scanner fails before its normal checkpoint, immediate tail deletion restores from the prior journal head and the next assistant parent-anchor settles the surviving uncheckpointed turn before advancing. Keep full checkpoints for swipe/sibling/recovery safety and record each checkpoint's journal sequence for branch rebasing.
- Bound the journal to 1,024 recent mutation entries with a contiguous active-history priority and a 12 MB soft budget while retaining at least 384 active entries. Add regressions for an exact 100-message tail deletion after the full-checkpoint target is pruned, plus two successive 50-message deletion batches. Scanner prompts, request counts/retries, relationship formulas, bundle schema and branch-lineage version are unchanged.
- Existing pre-1.0.7 histories establish their journal baseline when loaded; the new journal cannot reconstruct full snapshots that an older build had already discarded before upgrade.

## 1.0.6 - 13 September 2026

- Add a bounded deterministic Speech development ledger inside each canonical NPC record, tracking up to four pending speech concepts with recent turn/source-message provenance rather than retaining transcript history.
- Let three independent observations of the same stable speech concept across a minimum turn span authorize gradual Speech evolution, while replay of the same source message cannot advance the counter and unrelated concepts cannot combine.
- Preserve existing grounded `explicit` and `batch` Speech evolution. When a full Speech replacement is accepted, clear old speech profile evidence and begin a new speech epoch so pre-change observations cannot resurrect obsolete habits.
- Keep a bare time skip non-destructive: without grounded speech development, current Speech and pending evidence remain unchanged. A manual/unlocked Speech baseline change also clears stale pending concepts before later scans.
- Preserve manual Speech locks, native bundle/checkpoint ownership, scanner prompt bytes, request/retry counts, output allowances, numerical relationship formulas and persisted format versions. Add regressions for replay rejection, concept isolation, gradual thresholding, batch reset, bare-time-skip preservation, manual baseline reset and bundle round-trip.

## 1.0.5 - 13 September 2026

- Make manual Key Relationships / Important Bond edits authoritative over the edited NPC's hidden social-graph direction instead of enriching a stale graph edge and projecting old prose back into the dossier.
- Preserve a compatible reverse-side relationship/dynamic for the counterpart while replacing the manually edited owner-side relation and dynamic exactly.
- Normalize `Name — relation; dynamic` into the canonical `Name — relation | dynamic` shape when the relation prefix is a recognized social relation.
- Remove an unstructured orphan line when its full text is already contained in a structured bond entry, preventing duplicated dynamic-only lines from surviving canonicalization.
- Add focused regressions for the demonstrated Ryu/Sora duplicate-line case, same-counterpart manual rewrite, and reverse-side preservation. Scanner prompts, request counts, relationship scoring formulas, persistence formats and bundle schemas are unchanged.

## 1.0.4 - 13 September 2026

- Give direct per-NPC Refresh the same Stage 4 appearance-form output contract already used by the accepted appearance model, including `overallAppearance`, `appearanceForms`, `currentForm` and `currentFormState`.
- Carry the selected NPC's established appearance-form context into Refresh reconciliation and explicitly treat natural anatomical transitions as current-presentation/form evidence even when narration never says `form` or `transform`.
- Preserve alternate anatomy when Refresh observes a visibly different presentation without a stable form name by routing it through the existing unclassified-current presentation instead of overwriting the prior form.
- Keep Refresh strictly one-NPC and one-request: no extra scanner call, completeness pass, relationship scoring change, retry-budget change, persistence owner, or bundle-schema change.
- Add focused regressions for the demonstrated horn/wing/tail disappearance path and preservation of the prior chimeric presentation.

## 1.0.3 - 13 September 2026

- Make Stage 4 appearance-form fields part of the detailed routine scanner return contract instead of relying only on an appended side instruction.
- Recognize grounded implicit anatomical transformations such as horns, wings, tails, plumage, scales, talons or ears visibly dissolving, retracting, appearing, growing or otherwise changing even when narration never says `form` or `transform`.
- Preserve established alternate forms and route visibly different but unnamed presentations through the existing unclassified-current-form path instead of overwriting unrelated anatomy or inventing a stable form name.
- Keep ordinary scans compact: the expanded form schema is added only when existing form/lifecycle state or an explicit/implicit transformation signal requires detailed Stage 4 handling.
- Prevent large audit-only source history from blocking native backup. Full audit history is attempted first; if it exceeds the existing 2 MB manifest or 32 MB total envelope budget, Delta writes a compact truncation summary and, only if necessary, omits audit history while preserving canonical dossiers, portraits and portable settings.
- Add focused regressions for natural-language anatomical transitions and oversized-history native export without changing relationship formulas, scanner request counts, retries, persistence ownership or bundle schema version.

## 1.0.2 - 12 September 2026

- Add a Birthday field to Edit Dossier so generated or story-established dates can be corrected manually without editing extension JSON.
- Validate manual birthday changes against the active calendar and route accepted corrections through the canonical birthday continuity engine without an extra model request; manual corrections clear story-message provenance.
- Keep scanner prompt semantics, automatic scan routing, request counts, retry budgets and relationship behavior unchanged.

## 1.0.1 - 12 September 2026

- Require a grounded apparent-age result for new dossier-worthy NPCs whenever the scan has an explicit visual-age cue, while preserving chronological age as a separate field.
- Recover a missing apparent age deterministically from grounded appearance wording such as `young`, `middle-aged`, `elderly`, `24-year-old`, or `early thirties`; never infer it from species or lifespan.
- Keep the routine scanner prompt at the same character count and preserve request counts, output allowances, reasoning ownership, injection size, and all non-age scanner semantics.

## 1.0.0 - 12 September 2026

- Consolidate portrait upload/removal into scoped canonical operations; remove the duplicate supporting-tools portrait manager and superseded controls module, including whole-state completion polling.
- Correct locked appearance-form switching and explicitly empty unknown presentation without overwriting alternate anatomy, colors or unrelated dossier fields.
- Apply appearance edits directly through the canonical owner, retaining editor/chat ownership and distinguishing local changes from durable saves.
- Preserve birthday/aging integration after UI-noise stripping, correct mixed structured-date ordering and leap-year birthday comparison, and retain manual age and terminal-death protections.
- Validate native dossier shapes before import and remove source-message ownership when the target chat is unproven, including birthday and death-correction provenance.
- Replace repeated UI history copies with selected-record/lightweight projection reads and owner notifications; simplify history audit copying.
- Keep diagnostic records bounded and free of exception payloads; report actual current-chat pending writes instead of a placeholder metric.
- Surface permanent persistence rejection without endless retries while retaining dirty data, transient retry behavior, writer locking and later recovery.
- Keep retained host-image generation preview-only until explicit application; reject canceled, superseded and stale decode/generation results, and leave newer dialogs untouched.
- Apply manual life-state changes through the canonical owner without closing the editor, replaying a bundle, or overwriting newer input.
- Preserve unchanged dossier sections, disclosure state, focus and scroll during portrait and live-state refreshes; fix clipped cast cards, capped editor footers, hidden fields and top-dialog Escape handling.
- Validate the complete native envelope in the public importer as well as the UI, bound nesting and unsafe object metadata, and report actual added/updated/skipped counts.
- Prepare coherent Delta 1.0.0 application metadata and the existing deterministic installable ZIP without changing storage, bundle or branch schemas.
- Remove three uncalled internal evidence/display helpers, a shadowed source-era version export and a no-op editor branch after tracing runtime/test callers.
- Preserve the working scanner prompt and all measured request bytes, output allowances, reasoning ownership and automatic request counts.

## Stage 8 supporting tools - 12 September 2026

- Add the primary dossier Portrait workflow with device upload/replacement, removal, editable/copyable positive/negative prompts, explicit dossier rebuild, host Image Generation preview, and explicit preview application through the retained portrait upload/compression path.
- Bind asynchronous portrait work to chat/NPC/session/action ownership; reject stale generation, preserve the prior portrait on cancellation/failed decoding/generation, and report local mutation separately from durable flush success.
- Extend the existing versioned Delta native bundle with declared portable portrait settings and source-history audit metadata while retaining `bundle.js` as the canonical codec/import merge. Cross-chat import clears source message ownership and keeps target lineage/checkpoints as the safe baseline; no Alpha/Beta/legacy converter is added.
- Add compact diagnostics for actual dispatcher aggregates/routes/failures, latest retry/focused-pass state, labelled prompt estimates, relationship signed fractions/gate audit, and bounded Stage 8 persistence/workflow events without credentials or full private prompts/responses.
- Add safe-area/dynamic-viewport responsive dialogs with touch targets and bounded scrolling, and refresh only affected dossier/cast projections through the existing Stage 1 controller.
- Add focused synthetic Stage 8 regressions and `docs/stage8-supporting-tools.md`; exact-candidate CI is the deterministic acceptance gate because the continuation environment cannot resolve GitHub for a conventional local checkout. Real SillyTavern/file-picker/Image Generation/desktop-tablet-mobile visual acceptance remains unrun.

## Stages 5-7 relationship, evidence and recovery review - 12 September 2026

- Preserve the pinned numerical scorer, including signed diminishing returns, fractions, gates, configured-cap minima and tied-axis rejection. Add a hash-verified upstream result oracle covering 41,070 cases and end-to-end repeat/persistence/rollback tests.
- Block focused relationship evaluation/application for confirmed-dead NPCs even when death archiving is disabled. Let a valid zero focused decision initialize an empty relationship description without inventing an event or rewriting an established description.
- Move resolved appearance into the existing optional injection budget after essential identity and agency; remove duplicate relevance selection and post-assembly slicing from the Stage 4 adapter.
- Remove the OOC text-command parser, stripper, dispatcher/API, edit hooks, command-only prompt mode/help/bookkeeping and obsolete parser tests. Retain production manual controls, structured add/remove helpers, ordinary backfills and lineage maintenance.
- Protect terminal state after Refresh/backfill live-field restoration and before checkpoint creation. Enable explicit manual erroneous-death correction for unarchived dead records and clarify the editor/confirmation label.
- Retain storage, locks, revisions, dirty retries, owner isolation, tombstones, recovery readers and branch algorithms. No cross-generation import/export change or real database operation.
- Verification: 495 unit tests plus compatibility/runtime/migration smoke checks, validation, prompt measurements, packaging and diff check passed locally. Exact-commit CI remains the publication gate; live browser/provider checks are unrun. See `docs/stages5-7-review.md`.

## Stage 4 appearance and terminal lifecycle - 12 September 2026

- Add bounded named appearance forms and current-form selection while preserving earlier flat appearance as a safe `Base` compatibility form.
- Add one resolved-current-appearance path for dossier presentation, portrait prompts and roleplay injection, including protection against cross-form anatomy leakage and unidentified transformations.
- Extend scanner/Refresh/backfill/import prompts and profile locks to understand form-independent overall appearance, named forms and current form without erasing omitted forms; normalize the resolved current view back into canonical `appearance` so the existing dossier stays consistent without a second editor/state authority.
- Make explicit confirmed death terminal to automatic scanner, Refresh, retained backfill and structured-source updates; dead NPCs cannot regain presence/world activity from narrative resurrection.
- Preserve manual/stale reactivation for living dossiers, retained dead history/relationships/portraits, explicit player correction for erroneous death, and owned-history rollback.
- Add Stage 4 regression coverage for flat upgrade, form switching/refinement, clothing-only changes, locks, unknown forms, portrait/injection agreement, terminal death, explicit correction and automatic-writer presence guards.
- Review/fix pass hardens alias consolidation, bundle-import terminal death, unidentified-form anatomy isolation, current-form portrait anatomy, and budgeted roleplay appearance injection without changing relationship formulas.
- Final Stage 4 review fixes unnamed-form normalization so form-independent appearance is never duplicated across repeated loads; the retained editor's manually locked Appearance field edits the selected current form rather than creating a second authority.
- Treat deliberate manual Restore of a confirmed-dead dossier as explicit erroneous-death correction, retain correction provenance, and keep the corrected NPC off-screen until story evidence establishes presence again; automatic narrative/structured writers still cannot revive it.
- Full deterministic verification after the final review: 488 unit tests plus compatibility/runtime/migration smoke checks, validation, prompt measurement, package verification, and diff check; real SillyTavern/provider acceptance remains separate.

## Stage 3 scanner routing - 12 September 2026

- Add one selectable scanner connection-profile setting and shared request-scoped dispatcher for retained NPC model requests.
- Keep the empty/default route on the existing host generation path; explicit profile failures are surfaced without silent fallback and do not redirect roleplay or portrait generation.
- Cover automatic/manual scans, Refresh, focused relationships, retries, structured import and retained backfills, including timeout/cancellation and stale-result rejection.
- Restore the omitted `scan-context.js` runtime dependency after the initial Stage 3 merge and add it to the canonical runtime inventory; the post-hotfix main CI passed.
- Follow-up review moves redundant automatic backfill suppression ahead of the shared dispatcher and removes the inherited `full-cast.js` `generateRaw` monkey-patch, preserving identical default/selected-profile routing and manual repair access. Validation now rejects runtime bypasses of `scanner-routing.js`.

## Stage 2 active-runtime normalization - 11 September 2026

- Classify every implementation module executed by Delta as active Delta code regardless of source ancestry.
- Add `runtime-modules.json` as the canonical machine-readable inventory for every shipped top-level JavaScript module and its semantic role.
- Normalize the active mechanics and branch primitive paths to `core-mechanics.js` and `branch-core.js`; remove the old source-version-labelled runtime paths.
- Make validation require an exact one-to-one match between the active inventory and root runtime JavaScript, and reject legacy/version-labelled active paths or dependencies.
- Build packages from the same active inventory instead of a root wildcard so undeclared residue cannot silently enter a release archive.
- Drive CI syntax and release-consistency checks from the same inventory, and rename source-version-labelled safety test filenames to their current responsibilities.
- Keep historical source names/versions only in Git history, `docs/history/`, provenance records, and historical-shape fixture data where the old identifier itself is evidence. Required historical-shape readers remain active Delta compatibility logic inside current owners, not a separate runtime layer.
- Preserve scanner behavior, relationship formulas, persistence/recovery semantics, lifecycle policy, and roleplay injection while performing this structural normalization.

## Stage 2 consolidation / Delta v0.1.0 - 11 September 2026

- Establish `0.1.0` as NPC State Delta's own application-version baseline in the manifest, core facade and package metadata. Persisted bundle, branch, and data schema versions remain independent.
- Replace the broad `enhancements.js` layer with a dedicated `full-cast.js` owner that preserves the opt-in full-cast scan and redundant-backfill guard.
- Remove the superseded secondary Dossier Library overlay now that Stage 1 owns the dossier/cast presentation surface.
- Update bootstrap, validation, package naming and focused tests around the consolidated owner boundaries.
- Keep scanner semantics, persistence/recovery, relationship mechanics, evidence/injection behavior and later-stage contracts unchanged.

## Stage 1 tablet cast rail fix - 11 September 2026

- Keep the cast search field and lifecycle filters on one row for tablet widths so they do not consume most of the fixed cast rail height.
- Reserve enough vertical space for complete dossier cards on tablet and phone layouts instead of clipping the portrait/status row at the bottom edge.
- Add a small minimum bottom inset in touch layouts even when the browser reports no safe-area inset, while retaining horizontal cast scrolling.
- Keep the change presentation-only; scanner, state, persistence, relationship mechanics, and later stages are unchanged.

## Stage 1 compact launcher and mobile viewport fix - 11 September 2026

- Restyle the floating launcher as a 48px rounded-square stacked `npc` / `state` wordmark inspired by the supplied icon, keeping the full button as the touch/drag target and avoiding a large raster asset.
- Keep the compact launcher on desktop, tablet, and mobile; retain drag-and-persist positioning and the safe-area-aware side-midpoint default on narrower screens.
- On tablet/mobile widths, remove the centered `top: 50%` dossier transform and pin the dossier to the top-left of the dynamic viewport so the header cannot be shifted off-screen.
- Make the dossier top bar sticky and the Close control at least 44x44px on touch layouts, with safe-area padding for notches and browser chrome.
- Keep the change presentation-only: scanner, state, persistence, relationship mechanics, and later stages are untouched.

## Stage 1 mobile and overlay fixes - 11 September 2026

- Promote the movable dossier launcher to a top-level floating control so SillyTavern mobile/tablet stacking and nested extension layout cannot bury it.
- Use a compact 48px launcher icon at the right-side midpoint on phone/tablet widths, away from the bottom composer, while retaining drag-and-persist positioning.
- Replace the visual-only overlay shadow with a real clickable backdrop so clicking outside the dossier closes it.
- Remove the duplicate Edit button from the dossier document header while retaining the primary Edit dossier action beside the portrait.
- Keep NPC State Delta settings exclusively under SillyTavern Extensions.

## Stage 1 launcher refinement - 11 September 2026

- Make the side dossier launcher draggable with mouse, pen, or touch while preserving normal click-to-open behavior.
- Persist only the launcher's UI coordinates locally and clamp restored positions inside the current viewport after resize/orientation changes.
- Remove launcher-panel Settings access; NPC State Delta settings remain under SillyTavern's Extensions settings surface.
- Remove the Stage 1 root stacking context that could trap the fixed launcher below SillyTavern mobile chrome.
- Force mobile launcher visibility and add safe-area-aware default right/bottom offsets for notched/home-indicator devices.

## Stage 1 dossier UI - 11 September 2026

- Add a persistent side launcher that opens a centered portrait-led dossier surface without changing the canonical Delta scanner, persistence, or relationship behavior.
- Adapt the useful donor presentation ideas into Delta-local code: selected portrait hero, readable dossier document, searchable horizontal cast rail, and active/archived/dead filters.
- Project canonical Delta NPC state into bounded UI records so relationship/event histories and branch snapshots are not rendered or retained by the view layer.
- Route editing through the existing `NPCStateDelta.openEditor` owner and keep settings owned by the existing Delta Extensions settings surface rather than creating duplicate mutation/settings paths.
- Preserve search state, selection, cast/document scroll, focused cast selection, and external editor drafts while canonical state notifications refresh the open view.
- Add focused Stage 1 tests for lifecycle filtering, search, selection retention, projection boundaries, no-chat behavior, editor/settings ownership, and bootstrap reachability.

Real-browser visual/performance QA remains a host acceptance check; deterministic HTML/model tests are not treated as visual evidence.

## Source seed - 11 September 2026

- Seed the exact source snapshot from `kohz87/npc_state` at `a12b2937b5c1305e3e3017218a626478a5bedcdc`.
- Apply Delta identity isolation to runtime/CSS and inherited tests while initially preserving source algorithms and version markers for reproducible comparison.
- Preserve the existing GPL license and record all source paths/blob hashes.
- Add the core contract, agent instructions, nine-stage workplan and verification/package tooling.
- Move upstream markdown into historical reference documentation.

No work stages 1-9 were implemented in the original seed. Upstream release history is retained in `docs/history/`.
