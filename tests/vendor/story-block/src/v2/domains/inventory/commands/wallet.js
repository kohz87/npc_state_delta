// The inventory domain's wallet commands: the reader's purse correction and the story's or a module's payouts,
// with the wording the narrator is told after an edit. commands.js re-exports these names at their old path.
import { WALLET_KEY, formatAmount } from '../../money.js';
import { fill } from '../../../strings.js';
import { E, receiverArg, ownerArg, count, textArg, currencyIn, pay, receive } from '../stacks.js';
import { isCount } from '../state.js';
import { receiveStory } from '../story.js';
import { byReader } from '../edit.js';

// What the narrator is told after an edit's line under [Happened] (a receipt's `data.told`, added by prompt.js; the reader's
// card does not show it). A starting purse or kit (a saved character's, from the wizard: `starting: true`) and the reader's own
// corrections are the state as it stands, so the narrator must not read them as money or things that moved in the story.
export const TOLD = Object.freeze({
    startPurse: 'Starting purse, set before the story began: not money paid or received in the story.',
    startKit: 'Starting kit, set before the story began: not found, bought or used in the story.',
    editPurse: 'The reader\'s own correction: the purse is this now, not money paid or received in the story.',
    editKit: 'The reader\'s own correction: the party has this now, not found, bought or used in the story.',
});

/** The wallet commands, inserted into the inventory command table at their original position. */
export function createWalletCommands(env, byModule) {
    return {
        'wallet.set'(ctx, payload = {}) {
            byReader(ctx);
            const owner = receiverArg(ctx, payload.owner);
            if (!isCount(payload.amount, 0)) ctx.fail('INVALID', E.purseAmount);
            const inv = ctx.draft('inventory');
            const wallet = (inv.wallets[owner] ??= {});
            const from = wallet[WALLET_KEY] ?? 0;
            wallet[WALLET_KEY] = payload.amount;
            return { summary: fill(E.purseSet, { amount: formatAmount(payload.amount, currencyIn(ctx)) }),
                data: { edit: true, from, to: payload.amount, told: payload.starting === true ? TOLD.startPurse : TOLD.editPurse }, narrate: true };
        },

        // { owner, amount, note? }, amount in whole units of the one currency. Like inventory.grant, not
        // from a button on its own: the story, the host, or another module's command through ctx.call
        // (a shop's trade.buy pays; a reward's quest.finish receives).
        'wallet.pay'(ctx, payload = {}) {
            byModule(ctx, 'Money cannot be paid from a button on its own; it is paid by the story or by another module\'s action.');
            return pay(ctx, env, {
                owner: ownerArg(ctx, payload.owner),
                amount: count(ctx, payload.amount, undefined, 'amount'),
                note: textArg(ctx, payload.note, 120, 'note'),
            });
        },

        // `story: true` (a module's call): money the story alone vouched for (a quest reward the story
        // wrote). It is paid in full (there is no per-reply limit) and counted for the reply: during a
        // capture the reply being read; outside one (a click after the reply, RX-E-2) the reply the click is
        // stored on, the head carrier (ctx.reply), so `inventory.storyBudget` can tell a reply's coin lines
        // from the payouts after it. Without the flag, a module's payout is not counted.
        'wallet.receive'(ctx, payload = {}) {
            byModule(ctx, 'Money cannot be handed out from a button; it comes from the story or from another module\'s action.');
            if (payload.story !== undefined && typeof payload.story !== 'boolean') ctx.fail('INVALID', 'story must be true or false.');
            const args = {
                owner: receiverArg(ctx, payload.owner),
                amount: count(ctx, payload.amount, undefined, 'amount'),
                note: textArg(ctx, payload.note, 120, 'note'),
            };
            return payload.story === true && ctx.caller ? receiveStory(ctx, env, args, true) : receive(ctx, env, args);
        },
    };
}
