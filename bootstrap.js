/* NPC State Delta v0.1.0 bootstrap. */
import { prepareNpcStateHardening } from './hardening.js';

await prepareNpcStateHardening();
await import('./index.js');
try {
    await import('./full-cast.js');
} catch (error) {
    console.error('[NPC State Delta] optional full-cast scanner failed to load', error);
}
try {
    await import('./dossier-ui.js');
} catch (error) {
    console.error('[NPC State Delta] dossier UI failed to load', error);
}
try {
    await import('./launcher-ui.js');
} catch (error) {
    console.error('[NPC State Delta] dossier launcher failed to load', error);
}
