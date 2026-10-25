// The active-history filter for Story Block's own readers of earlier messages (docs/v2/HISTORY.md). `faded()` is the coordinator's
// rule (the faded intervals of the returns on the line of history); nothing else decides it. A reader that takes earlier messages' text
// from the chat (the chatter queries, a module's view, the late safety-net lines) asks for its reader here by name, and the host reports
// `retainedChatRestore` only while every name has been asked for.
//
// A generation request is not read here. SillyTavern builds it, and leaves out every hidden message (`is_system`); a restore hides the
// messages it faded (coordinator.js `syncHidden`), so they are not in any prompt SillyTavern builds, whatever regexes run over it.

/** Story Block's readers of earlier messages. Adding one means asking for it by name, so the capability cannot claim more than is wired. */
export const ACTIVE_READERS = Object.freeze([
    'prompt.chatter',     // the Inner chatter tail line (domains chatterBack)
    'query.chatter.head', // the newest reply's Inner chatter (query chatter.head)
    'query.scene.chatter', // the thoughts under the people present (query scene.chatter, the Scene screen)
    'view.lastUser',      // the reader's last message a module's view shows (sdk makeView)
    'assist.late',        // the previous reply's late safety-net lines (turn.js lateLines)
]);

/**
 * createActiveHistory({ messages(), faded() }) → { wired(), reader(name) }.
 * `messages()`: the chat; `faded()`: the Set of indexes of its faded messages. `reader(name)` → { messages(list), faded() } and counts
 * `name` as wired.
 */
export function createActiveHistory({ faded }) {
    const wired = new Set();
    return Object.freeze({
        wired: () => ACTIVE_READERS.every(name => wired.has(name)),
        reader(name) {
            if (!ACTIVE_READERS.includes(name)) throw new Error(`"${name}" is not one of Story Block's readers of earlier messages.`);
            wired.add(name);
            return Object.freeze({
                /** `list` (the chat) without its faded messages. */
                messages: list => {
                    const out = faded();
                    return out.size ? list.filter((_, at) => !out.has(at)) : list;
                },
                /** The indexes of the chat's faded messages. */
                faded: () => faded(),
            });
        },
    });
}
