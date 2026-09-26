/* NPC State Delta v1.0.62 bootstrap. */
import { prepareNpcStateHardening } from './hardening.js';

await prepareNpcStateHardening();
await import('./scanner-routing.js');
await import('./calendar-settings.js');
await import('./index.js');
try {
    await import('./destructive-settlement.js');
} catch (error) {
    console.error('[NPC State Delta] destructive history settlement failed to load', error);
}
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
    await import('./dossier-tools.js');
} catch (error) {
    console.error('[NPC State Delta] supporting tools UI failed to load', error);
}
try {
    await import('./launcher-ui.js');
} catch (error) {
    console.error('[NPC State Delta] dossier launcher failed to load', error);
}
try {
    await import('./dossier-experience.js');
} catch (error) {
    console.error('[NPC State Delta] consolidated dossier experience failed to load', error);
}
try {
    await import('./continuity-ui.js');
} catch (error) {
    console.error('[NPC State Delta] continuity UI failed to load', error);
}
try {
    await import('./scanner-output-ui.js');
} catch (error) {
    console.error('[NPC State Delta] scanner output/UI refinement failed to load', error);
}
