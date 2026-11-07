// Story Suite v2: the `card` mount (SPEC §13.4). An inline card under each carrier message that gets
// cards (`hasCard`: the host leaves out the greeting and replies with no v2 record), drawn from **that
// reply's** state (`stateAt(index)`, never the head) and the paths its ops changed, so a template's
// `changed(path)` can show "only what changed".
//
// * Under a reply there is ONE card, "This reply", that holds every card screen the reader has on (Story Block's
//   "Changed this reply", any other module's). Cards are off until the reader turns them on,
//   per screen (`screens.setCards`); an off screen is simply not a section, and with one on the card is still "This reply".
//   The card starts collapsed: a header with the title and one line, each section's summary joined with " · " (the screens
//   in `deps.first` lead, the rest keep their order; the full line is the summary's title). Open, each section is its body
//   under a small heading (the screen's own title). The bodies are
//   drawn the first time the card is opened, all together.
// * Only messages on screen are drawn when IntersectionObserver exists; without it every carrier is.
// * Long chats (docs/v2/PERFORMANCE.md): SillyTavern keeps every message drawn in a session on the page, so
//   a pass over all of them on every change grew with the session. A change to the story (`committed`)
//   redraws the head carrier's cards alone (no earlier reply's state changes then); `head` (a rebuild)
//   goes over the last RECENT carriers and those on screen; a chat opened, more messages loaded or a delete
//   go over every drawn message once (to watch them), finding them with one query, not one per message.
//   With no card screen turned on nothing is looked up at all, and any box left over is removed.
// * SillyTavern scrolls the chat to a new reply as it lands and the card is drawn just after, under it, so the card could sit below the
//   fold. When a draw or a growth (a card opened) changes the card box of the newest message and the reader was at the bottom of
//   the chat before it, the chat is taken to the bottom again (view/scroll.js keepAtBottom); a reader who had scrolled up is not moved.
// * Drawn cards are cached per (screen, index, swipe, rev, screens version): swiping back or scrolling
//   back reuses the card instead of drawing it again. An edit drops that message's cards; a delete or a
//   chat change drops them all (message indexes move).
//
// deps (see common.js) plus:
//   carriers        () → indexes of the carrier messages (required)
//   hasCard         (index) → whether that carrier gets cards (default: every carrier does)
//   messageElement  (index) → SillyTavern's `.mes[mesid=index]` element (default: a document query)
//   swipeAt         (index) → the message's swipe_id (default 0)
//   summary         (screen, { index, state, changes, before }) → the host's part of the header's line for a card that has no summary of its own
//                   (optional; Story Block's changes card). A card screen's own `summary` (a template read in the card's scope, like
//                   its body) wins; a card with neither adds nothing to the line.
//   first           ids of the card screens that lead the sections, in order (optional; Story Block's changes card)
//   opsAt           (index) → the carrier's own ops (optional; cards get them as `replyOps`)
//   IntersectionObserver  the class to use (default globalThis.IntersectionObserver; null turns it off)
//   eventSource, eventTypes   SillyTavern's, to follow swipes, edits, deletes and renders (optional)
//   replyCards      (index) → the reply cards a module put under that message, drawn after the changes card (optional; reply-cards.js)
//   cacheLimit      how many drawn cards to keep (default 200)
//   recent          how many of the last carriers a `head` pass goes over besides those on screen (default RECENT)
//
// → { mount(el, screenId, { index }) → handle, attachAll({ recent }), refresh(index, { force }), refreshAll({ force }),
//     toggle(index, open?), onSwipe(index), onEdit(index), onDelete(), onChatChanged(),
//     cacheSize(), destroy() }

import { createCardMount } from './card/mount.js';

export { RECENT, changeSummary } from './card/summary.js';
export { createCardMount };
