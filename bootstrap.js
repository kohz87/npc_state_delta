/* NPC State Delta v0.2.21 - lifecycle and durability hardening wrapper */
import { prepareNpcStateHardening } from './hardening.js';

await prepareNpcStateHardening();
await import('./index.js');
try {
    await import('./enhancements.js');
} catch (error) {
    console.error('[NPC State Delta] optional full-cast/library enhancements failed to load', error);
}
try {
    await import('./dossier-ui.js');
} catch (error) {
    console.error('[NPC State Delta] Stage 1 dossier UI failed to load', error);
}
