// Source text of the dossier UI facade together with every part split out of it, for tests that pin source text.
// A part that is missing fails loudly; keep this list in step when more code moves out of dossier-ui.js.
import fs from 'node:fs';

const root = new URL('../../', import.meta.url);

export const DOSSIER_UI_SOURCE_PARTS = [
    'dossier-ui-constants.js',
    'dossier-ui-model.js',
    'dossier-ui-catalog.js',
    'dossier-ui-html.js',
    'dossier-ui-relationship.js',
    'dossier-ui-meters.js',
    'dossier-ui-panel.js',
    'dossier-ui-controller.js',
    'dossier-ui-render.js',
    'dossier-ui-mount.js',
    'dossier-ui-styles.js',
];

const read = file => fs.readFileSync(new URL(file, root), 'utf8');

export function dossierUiSource() {
    return ['dossier-ui.js', ...DOSSIER_UI_SOURCE_PARTS].map(read).join('\n');
}
