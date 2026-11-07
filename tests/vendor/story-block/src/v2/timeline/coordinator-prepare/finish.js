// The timeline coordinator's participant-switch phase: after a restore is committed, each participant is asked to activate
// its prepared checkpoint and is acknowledged in the journal one at a time. coordinator-prepare.js re-exports no name from
// this file; it uses the returned function in the prepare half's public result.
import { fail } from '../util.js';

export function createFinish({ archive, block, callParticipant, complete, durable, participants, point }) {
    // The participants of a committed restore switch, one at a time, each acknowledged in the journal as it answers. Nothing is
    // switched before the commit is in the chat file (a participant that switched while the story could still be lost would be
    // split from it for good). A failure leaves the barrier up and the restore waiting on its participants (`participants-pending`);
    // a retry or a restart carries on. A save that fails is the caller's failure, never a success.
    return async function finish(entry) {
        const fresh = () => archive.get(entry.id);
        const hold = async (module, failure, { waiting = false } = {}) => {
            archive.patch(entry.id, { phase: 'participants-pending', why: failure.message });
            await durable();
            block.note(module, failure, { waiting });
            return { ok: true, return: entry.return, status: 'participants-pending' };
        };
        await durable();
        for (const module of Object.keys(fresh().participants).sort()) {
            let slot = fresh().participants[module];
            if (slot.ack) continue;
            const registered = participants.get(module);
            if (!registered || registered.schema !== slot.schema) return hold(module, fail('SNAPSHOT_UNAVAILABLE', `the participant ${module} is not registered at the schema the save holds (${slot.schema})`), { waiting: true });
            await point(`activate.participant:${module}:before`);
            // After a crash it may have switched already: its own status says so.
            let answer = null;
            const asked = await callParticipant(module, 'status', { return: entry.return });
            if (asked.ok && asked.status === 'active' && asked.hash === slot.hash && asked.checkpoint === slot.checkpoint) answer = asked;
            else if (asked.ok && asked.status === 'aborted') return hold(module, fail('CONFLICT', `the participant ${module} reports the restore aborted`), { waiting: true });
            else if (!asked.ok && asked.code === 'STALE') return hold(module, asked);
            if (!answer) {
                const done = await callParticipant(module, 'activate', { return: entry.return, prepared: slot.prepared });
                if (!done.ok) {
                    // A lost prepared operation may return NOT_FOUND after a restart; that does not mean the checkpoint is gone.
                    const missing = done.code === 'SNAPSHOT_UNAVAILABLE'
                        || (done.code === 'NOT_FOUND' && /\b(?:404|checkpoint)\b/i.test(done.message));
                    return hold(module, done, { waiting: !missing && !['FAILED', 'STALE'].includes(done.code) });
                }
                answer = done;
            }
            // Exactly the checkpoint that was saved and prepared, by its id and by its hash.
            if (answer.checkpoint !== slot.checkpoint || answer.hash !== slot.hash) return hold(module, fail('CONFLICT', `the participant ${module} switched to another checkpoint than the save holds`), { waiting: true });
            slot = { ...slot, ack: { checkpoint: answer.checkpoint, hash: answer.hash } };
            archive.patch(entry.id, { participants: { ...fresh().participants, [module]: slot }, phase: 'committed' });
            // The participant stands on the restore's checkpoint from now on, whatever becomes of the restore: what is selected is where
            // the participants are, so a head that does not hold the restore finds it off its checkpoint and switches it back.
            archive.remember(fresh().before);
            archive.select({ ...archive.selection(), [module]: { module, checkpoint: answer.checkpoint, hash: answer.hash, schema: slot.schema } });
            await durable();
            await point(`activate.participant:${module}:acked`);
        }
        archive.patch(entry.id, { phase: 'acked' });
        await durable();
        await point('activate.acked');
        return complete(entry);
    };
}
