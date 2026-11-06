// Selects the opening foe groups for a board fight's single win award.
// It reads the current reply's recorded board result, including fights split across replies.
// A still-open, lost or fled board fight never pays a win award.

export function boardWin(receipts) {
    const result = (Array.isArray(receipts) ? receipts : []).findLast(receipt => receipt?.type === 'rpg.resolve' && receipt.data?.v2?.result?.board)?.data?.v2?.result;
    if (!result) return null;
    return { won: result.stop === 'won', groups: Array.isArray(result.board.groups) ? result.board.groups : [] };
}
