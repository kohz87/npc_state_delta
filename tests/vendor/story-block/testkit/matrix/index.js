// The combination matrix (docs/v2/MATRIX.md): the shared runner for the module combinations of
// docs/v2/contract/RB_CONTRACT.md §2. Vendored with the rest of testkit/ (npm run sync-testkit).

export { CASES, NOT_EXPRESSIBLE, ROWS } from './rows.js';
export { FOLDERS, MODULES, ORDER, discoverRoots, loadModules } from './modules.js';
export { runMatrix } from './run.js';
export { describeTestkit, formatDetails, formatTable, summaryLine } from './report.js';
export { MATRIX_VERSION } from './version.js';
