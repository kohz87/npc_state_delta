// Source text of the runtime controller together with the parts split out of index.js, for tests that pin source text.
// Each part's text is placed in index.js right where its code used to stand (before the marker line named here), so that
// assertions which look from one function to a later one (a span, an order, "nothing after it matches") still see the
// code in its old order. The text of every file is unchanged. A part that moves or a marker that goes missing fails loudly;
// add an entry when more code moves out of index.js.
import fs from 'node:fs';

const root = new URL('../../', import.meta.url);

export const RUNTIME_SOURCE_PARTS = [
    { file: 'runtime-settings.js', before: 'const { getChatKey,' },
    { file: 'runtime-chat-keys.js', before: 'const { getChatKey,' },
    { file: 'runtime-scan-helpers.js', before: 'const { getChatKey,' },
    { file: 'runtime-hydration.js', before: 'const { freshChatState,' },
    { file: 'runtime-persist.js', before: 'const { queueStateFileWrite,' },
    { file: 'runtime-branch.js', before: 'const { commitBranchCheckpoint,' },
    { file: 'runtime-scan-ops.js', before: 'const { recordScanDiagnostics,' },
    { file: 'runtime-reconcile.js', before: 'const { queueSettledSwipeReconcile,' },
    { file: 'runtime-lifecycle.js', before: 'const { retryCurrentChatHydration,' },
    { file: 'runtime-targeted-scope.js', before: 'const { prepareCanonicalScanBase,' },
    { file: 'runtime-targeted.js', before: 'const { prepareCanonicalScanBase,' },
    { file: 'runtime-targeted-refresh.js', before: 'const { prepareCanonicalScanBase,' },
    { file: 'runtime-targeted-backfill.js', before: 'const { prepareCanonicalScanBase,' },
    { file: 'runtime-scan.js', before: 'const { scanNowInner,' },
    { file: 'runtime-settings-html.js', before: 'function eventTargetClosest(' },
    { file: 'runtime-hosted.js', before: 'const { storyBlockV2Hosted' },
    { file: 'runtime-injection.js', before: 'const { liveInjectionText,' },
    { file: 'runtime-narration.js', before: 'const { narrationCaptureStats,' },
    { file: 'runtime-inline-cards.js', before: 'const { recordInlineCardsInState' },
    { file: 'runtime-editor.js', before: 'const { editorIsMounted' },
    { file: 'runtime-cast-sync.js', before: 'const { castPortraitDue' },
    { file: 'runtime-mutations.js', before: 'const { updateNpcAppearance' },
    { file: 'runtime-portrait.js', before: 'const { handlePortraitGeneratorEscape' },
    { file: 'runtime-suite.js', before: 'const { SUITE_API' },
    { file: 'runtime-portrait-settings.js', before: 'const { savePortraitSettingsDraft' },
    { file: 'runtime-settings-bind.js', before: 'const { bindUi,' },
];

const read = file => fs.readFileSync(new URL(file, root), 'utf8');

export function runtimeSource() {
    let source = read('index.js');
    for (const { file, before } of RUNTIME_SOURCE_PARTS) {
        const at = source.search(new RegExp(`^${before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm'));
        if (at < 0) throw new Error(`runtime-source: marker "${before}" not found in index.js for ${file}`);
        source = `${source.slice(0, at)}${read(file)}\n${source.slice(at)}`;
    }
    return source;
}
